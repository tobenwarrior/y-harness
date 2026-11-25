/** Host-only GitHub App device authorization and GitHub MCP token provider. */

import { Context, Service } from '@yharness/cordis'
import type { AuthorizationSession } from '@yharness/authorization'
import { credentialKey } from '@yharness/credentials'
import type { CredentialRecord } from '@yharness/credentials'
import Schema from '@yharness/schemastery'

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const DEVICE_VERIFICATION_URL = 'https://github.com/login/device'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
const REFRESH_GRANT_TYPE = 'refresh_token'
const REFRESH_INTERVAL_INCREASE_MS = 5_000
const HTTP_TIMEOUT_MS = 30_000
const MAX_SECONDS = 31_536_000

/** The credential record written by the GitHub App authorization flow. */
export const GITHUB_APP_CREDENTIAL_KEY = credentialKey('github-app-auth', 'default')

/** The only endpoint that may receive a token from {@link GitHubAppAuth.tokenFor}. */
export const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/'

/** The fixed GitHub page where a user enters a device-flow code. */
export const GITHUB_DEVICE_VERIFICATION_URL = DEVICE_VERIFICATION_URL

declare module '@yharness/cordis' {
  interface Context {
    /** Host-only GitHub App authorization and GitHub MCP token service. */
    githubAppAuth: GitHubAppAuth
  }

  interface Events {
    /** GitHub App sign-in, disconnect, or definitive grant invalidation completed. @mode emit */
    'github-app-auth/connection-changed'(): void
  }
}

/** Configuration for the Host-only GitHub App OAuth device flow. */
export interface Config {
  /** Public client ID of the GitHub App. */
  clientId: string
}

/** Validated GitHub App authorization configuration. */
export const Config: Schema<Config> = Schema.object({
  clientId: Schema.string().min(1).required(),
})

interface GitHubGrant {
  readonly version: 1
  readonly clientId: string
  readonly accessToken: string
  readonly accessTokenExpiresAt?: number
  readonly refreshToken?: string
  readonly refreshTokenExpiresAt?: number
}

interface InvalidatedGrant {
  readonly version: 1
  readonly invalidated: true
}

interface DeviceCode {
  readonly deviceCode: string
  readonly userCode: string
  readonly expiresAt: number
  readonly pollIntervalMs: number
}

/** Safe internal error used to distinguish a definitive grant rejection from a transient request failure. */
class GitHubAuthError extends Error {
  constructor(message: string, readonly definitive = false) {
    super(message)
    this.name = 'GitHubAuthError'
  }
}

/** Return true for a non-null object that can be inspected as JSON fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one nonempty string from a decoded JSON object. */
function nonemptyString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key]
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
}

/** Read a bounded positive integer seconds value and convert it to milliseconds. */
function secondsToMilliseconds(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_SECONDS
    ? value * 1_000
    : undefined
}

/** Read a positive safe-integer absolute expiry timestamp. */
function expiry(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Parse one stored GitHub grant without exposing its values in diagnostics. */
function parseGrant(record: CredentialRecord | undefined): GitHubGrant | undefined {
  if (record?.kind !== 'grant' || !isRecord(record.payload)) return undefined
  const { payload } = record
  if (payload.version !== 1) return undefined
  const clientId = nonemptyString(payload, 'clientId')
  if (clientId === undefined) return undefined
  const accessToken = nonemptyString(payload, 'accessToken')
  if (accessToken === undefined) return undefined
  const refreshToken = payload.refreshToken === undefined ? undefined : nonemptyString(payload, 'refreshToken')
  if (payload.refreshToken !== undefined && refreshToken === undefined) return undefined
  const accessTokenExpiresAt = payload.accessTokenExpiresAt === undefined ? undefined : expiry(payload.accessTokenExpiresAt)
  if (payload.accessTokenExpiresAt !== undefined && accessTokenExpiresAt === undefined) return undefined
  const refreshTokenExpiresAt = payload.refreshTokenExpiresAt === undefined ? undefined : expiry(payload.refreshTokenExpiresAt)
  if (payload.refreshTokenExpiresAt !== undefined && refreshTokenExpiresAt === undefined) return undefined
  return {
    version: 1,
    clientId,
    accessToken,
    ...accessTokenExpiresAt === undefined ? {} : { accessTokenExpiresAt },
    ...refreshToken === undefined ? {} : { refreshToken },
    ...refreshTokenExpiresAt === undefined ? {} : { refreshTokenExpiresAt },
  }
}

/** Recognize the secret-free tombstone written after a definitive grant failure. */
function isInvalidatedGrant(record: CredentialRecord | undefined): boolean {
  if (record?.kind !== 'grant' || !isRecord(record.payload)) return false
  return record.payload.version === 1 && record.payload.invalidated === true
}

/** Determine whether a stored grant has passed one of its optional expiries. */
function expired(at: number | undefined, now = Date.now()): boolean {
  return at !== undefined && at <= now
}

/** Convert an abort reason to an error safe to reject from the polling delay. */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('authorization cancelled')
}

/** Compare two records without relying on object identity across credential providers. */
function sameRecord(left: CredentialRecord | undefined, right: CredentialRecord | undefined): boolean {
  if (left === undefined || right === undefined || left.kind !== right.kind) return left === right
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Build a stored grant from an access-token response, retaining a prior refresh token when omitted. */
function grantFromResponse(body: Record<string, unknown>, clientId: string, previous?: GitHubGrant): GitHubGrant {
  const accessToken = nonemptyString(body, 'access_token')
  if (accessToken === undefined) throw new GitHubAuthError('GitHub did not return an access token')
  if (body.token_type !== 'bearer') throw new GitHubAuthError('GitHub returned an invalid token type')
  const accessTokenLifetime = body.expires_in === undefined ? undefined : secondsToMilliseconds(body.expires_in)
  if (body.expires_in !== undefined && accessTokenLifetime === undefined) {
    throw new GitHubAuthError('GitHub returned an invalid access-token expiry')
  }
  const refreshToken = body.refresh_token === undefined
    ? previous?.refreshToken
    : nonemptyString(body, 'refresh_token')
  if (body.refresh_token !== undefined && refreshToken === undefined) {
    throw new GitHubAuthError('GitHub returned an invalid refresh token')
  }
  const refreshTokenLifetime = body.refresh_token_expires_in === undefined
    ? undefined
    : secondsToMilliseconds(body.refresh_token_expires_in)
  if (body.refresh_token_expires_in !== undefined && refreshTokenLifetime === undefined) {
    throw new GitHubAuthError('GitHub returned an invalid refresh-token expiry')
  }
  const now = Date.now()
  return {
    version: 1,
    clientId,
    accessToken,
    ...accessTokenLifetime === undefined ? {} : { accessTokenExpiresAt: now + accessTokenLifetime },
    ...refreshToken === undefined ? {} : { refreshToken },
    ...refreshTokenLifetime === undefined
      ? previous?.refreshTokenExpiresAt === undefined ? {} : { refreshTokenExpiresAt: previous.refreshTokenExpiresAt }
      : { refreshTokenExpiresAt: now + refreshTokenLifetime },
  }
}

/** A bounded abort-aware delay used by the device polling loop. */
function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(abortError(signal))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    timer.unref()
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** POST a form to a fixed GitHub authorization endpoint with redirects refused. */
async function requestGithub(
  url: string,
  params: URLSearchParams,
  signal: AbortSignal,
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  let response: Response
  try {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    response = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: params,
      redirect: 'error',
      signal: requestSignal,
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new GitHubAuthError('GitHub authorization request failed')
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new GitHubAuthError('GitHub returned an invalid authorization response')
  }
  if (!isRecord(body)) throw new GitHubAuthError('GitHub returned an invalid authorization response')
  if (!response.ok && oauthError(body) === undefined) {
    throw new GitHubAuthError('GitHub rejected the authorization request', response.status === 400 || response.status === 401)
  }
  return body
}

/** Parse the device-code response while rejecting non-official verification destinations. */
function parseDeviceCode(body: Record<string, unknown>): DeviceCode {
  const deviceCode = nonemptyString(body, 'device_code')
  const userCode = nonemptyString(body, 'user_code')
  const verificationUri = nonemptyString(body, 'verification_uri')
  const expiresIn = secondsToMilliseconds(body.expires_in)
  const interval = body.interval === undefined
    ? 5
    : typeof body.interval === 'number' && Number.isSafeInteger(body.interval) && body.interval > 0 && body.interval <= MAX_SECONDS
      ? body.interval
      : undefined
  if (deviceCode === undefined || userCode === undefined || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode)
    || verificationUri !== DEVICE_VERIFICATION_URL
    || expiresIn === undefined || interval === undefined) {
    throw new GitHubAuthError('GitHub returned an invalid device authorization response')
  }
  return {
    deviceCode,
    userCode,
    expiresAt: Date.now() + expiresIn,
    pollIntervalMs: Math.max(1_000, interval * 1_000),
  }
}

/** Whether an OAuth error means the stored grant cannot be used again. */
function definitiveOAuthError(code: string | undefined): boolean {
  return code === 'bad_refresh_token'
    || code === 'invalid_grant'
    || code === 'incorrect_client_credentials'
    || code === 'expired_token'
    || code === 'access_denied'
    || code === 'device_flow_disabled'
    || code === 'bad_verification_code'
}

/** Extract an OAuth error from a successful JSON response without exposing its text. */
function oauthError(body: Record<string, unknown>): string | undefined {
  return typeof body.error === 'string' ? body.error : undefined
}

/** Convert an OAuth error response into a safe internal error. */
function throwOAuthError(body: Record<string, unknown>): void {
  const code = oauthError(body)
  if (code !== undefined) throw new GitHubAuthError('GitHub authorization was not completed', definitiveOAuthError(code))
}

/** Host-only GitHub App device authorization provider. */
export default class GitHubAppAuth extends Service {
  /** The Host service key. */
  static readonly serviceName = 'githubAppAuth'
  /** Services required for authorization and opaque grant storage. */
  static inject = ['credentials', 'authorization']
  /** Configuration schema consumed by the profile loader. */
  static Config = Config

  private readonly clientId: string
  private closed = false
  private activeAuthorization: Promise<void> | undefined
  private refreshTask: Promise<string | undefined> | undefined
  private refreshLifetime = new AbortController()
  private refreshGeneration = 0
  private disconnecting: Promise<void> | undefined

  /**
   * Construct the Host service and register its credential flow.
   * @param ctx - Host context carrying credentials and authorization.
   * @param config - public GitHub App client ID.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, GitHubAppAuth.serviceName)
    this.clientId = Config(config).clientId
    ctx.authorization.registerFlow({
      key: GITHUB_APP_CREDENTIAL_KEY,
      label: 'GitHub',
      methods: [{ id: 'device', label: 'Sign in with GitHub' }],
      run: session => this.runAuthorization(session),
    })
    ctx.effect(() => async () => {
      this.closed = true
      this.refreshGeneration++
      this.refreshLifetime.abort()
      ctx.authorization.cancel(GITHUB_APP_CREDENTIAL_KEY)
      const active = this.activeAuthorization
      if (active !== undefined) await active.catch(() => {})
      const refresh = this.refreshTask
      if (refresh !== undefined) await refresh
    }, 'github-app-auth: lifetime')
  }

  /**
   * Report whether a usable GitHub grant is stored without refreshing it.
   * @returns `connected` when access or refresh credentials remain usable.
   */
  async status(): Promise<'connected' | 'needs-auth'> {
    const record = await this.ctx.credentials.readRecord(GITHUB_APP_CREDENTIAL_KEY)
    const grant = parseGrant(record)
    if (grant !== undefined && grant.clientId === this.clientId
      && (!expired(grant.accessTokenExpiresAt) || (grant.refreshToken !== undefined && !expired(grant.refreshTokenExpiresAt)))) {
      return 'connected'
    }
    return 'needs-auth'
  }

  /**
   * Resolve a token only for the official GitHub MCP endpoint, refreshing an expired access token when possible.
   * @param endpoint - endpoint that will receive the bearer token.
   * @returns the access token for the exact GitHub MCP URL, or `undefined` when signed out or unavailable.
   */
  async tokenFor(endpoint: URL): Promise<string | undefined> {
    if (this.closed || endpoint.href !== GITHUB_MCP_URL || this.disconnecting !== undefined) return undefined
    const generation = this.refreshGeneration
    const record = await this.ctx.credentials.readRecord(GITHUB_APP_CREDENTIAL_KEY)
    if (record === undefined) return undefined
    const grant = parseGrant(record)
    if (!this.isCurrent(generation)) return undefined
    if (grant === undefined) {
      await this.invalidate(record)
      return undefined
    }
    if (grant.clientId !== this.clientId) return undefined
    if (!expired(grant.accessTokenExpiresAt)) {
      return grant.accessToken
    }
    if (grant.refreshToken === undefined || expired(grant.refreshTokenExpiresAt)) {
      await this.invalidate(record)
      return undefined
    }
    const token = await this.refreshGrant()
    if (!this.isCurrent(generation)) return undefined
    return token
  }

  /**
   * Cancel active authorization and refresh work, then remove the stored GitHub grant.
   * @returns after local removal and its connection event, if a grant existed.
   */
  async disconnect(): Promise<void> {
    if (this.closed) return
    if (this.disconnecting !== undefined) return this.disconnecting
    const task = Promise.resolve().then(() => this.disconnectInternal())
    this.disconnecting = task
    try {
      await task
    } finally {
      this.disconnecting = undefined
    }
  }

  /** Run one disconnect transaction while stale authorization and refresh work are quiesced. */
  private async disconnectInternal(): Promise<void> {
    this.refreshGeneration++
    const oldLifetime = this.refreshLifetime
    this.refreshLifetime = new AbortController()
    oldLifetime.abort()
    this.ctx.authorization.cancel(GITHUB_APP_CREDENTIAL_KEY)
    const active = this.activeAuthorization
    if (active !== undefined) await active.catch(() => {})
    const refresh = this.refreshTask
    if (refresh !== undefined) await refresh
    const record = await this.ctx.credentials.readRecord(GITHUB_APP_CREDENTIAL_KEY)
    if (record === undefined) return
    await this.ctx.credentials.deleteRecord(GITHUB_APP_CREDENTIAL_KEY)
    if (!this.closed) this.ctx.emit('github-app-auth/connection-changed')
  }

  /** Run the device flow and keep its promise visible to disconnect and disposal. */
  private async runAuthorization(session: AuthorizationSession): Promise<void> {
    if (this.closed || this.disconnecting !== undefined) throw new GitHubAuthError('GitHub authorization is unavailable')
    const run = this.authorize(session)
    this.activeAuthorization = run
    try {
      await run
    } finally {
      this.activeAuthorization = undefined
    }
  }

  /** Obtain, poll, and commit one GitHub App device grant. */
  private async authorize(session: AuthorizationSession): Promise<void> {
    const device = parseDeviceCode(await requestGithub(
      DEVICE_CODE_URL,
      new URLSearchParams({ client_id: this.clientId, scope: 'offline_access' }),
      session.signal,
    ))
    session.notify({
      message: 'Open GitHub to authorize Y Harness, then enter the code shown here.',
      url: DEVICE_VERIFICATION_URL,
      code: device.userCode,
    })
    let interval = device.pollIntervalMs
    while (true) {
      const remaining = device.expiresAt - Date.now()
      if (remaining <= 0) throw new GitHubAuthError('GitHub device authorization expired', true)
      await waitFor(Math.min(interval, remaining), session.signal)
      const requestRemaining = device.expiresAt - Date.now()
      if (requestRemaining <= 0) throw new GitHubAuthError('GitHub device authorization expired', true)
      const response = await requestGithub(
        ACCESS_TOKEN_URL,
        new URLSearchParams({
          client_id: this.clientId,
          device_code: device.deviceCode,
          grant_type: DEVICE_GRANT_TYPE,
        }),
        session.signal,
        Math.min(HTTP_TIMEOUT_MS, requestRemaining),
      )
      const error = oauthError(response)
      if (error === 'authorization_pending') continue
      if (error === 'slow_down') {
        interval += REFRESH_INTERVAL_INCREASE_MS
        continue
      }
      throwOAuthError(response)
      const grant = grantFromResponse(response, this.clientId)
      await session.commit({ kind: 'grant', payload: grant })
      if (this.isOpen() && !session.signal.aborted) this.ctx.emit('github-app-auth/connection-changed')
      return
    }
  }

  /** Refresh one expired grant through the credential provider's serialized update path. */
  private async refreshGrant(): Promise<string | undefined> {
    if (this.refreshTask !== undefined) return this.refreshTask
    const generation = this.refreshGeneration
    const signal = this.refreshLifetime.signal
    const task = this.refreshStoredGrant(generation, signal).finally(() => {
      this.refreshTask = undefined
    })
    this.refreshTask = task
    return task
  }

  /** Perform one serialized read-modify-write refresh while rejecting stale writers. */
  private async refreshStoredGrant(
    generation: number,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    let token: string | undefined
    let invalidated: true | undefined
    try {
      await this.ctx.credentials.modifyRecord(GITHUB_APP_CREDENTIAL_KEY, async (current) => {
        const currentGrant = parseGrant(current)
        if (currentGrant === undefined) return undefined
        if (currentGrant.clientId !== this.clientId) return undefined
        if (!expired(currentGrant.accessTokenExpiresAt)) {
          token = currentGrant.accessToken
          return undefined
        }
        if (!this.isRefreshCurrent(generation, signal) || currentGrant.refreshToken === undefined) return undefined
        try {
          const refreshed = await this.fetchRefresh(currentGrant.refreshToken, currentGrant, signal)
          if (!this.isRefreshCurrent(generation, signal)) return undefined
          token = refreshed.accessToken
          return { kind: 'grant', payload: refreshed }
        } catch (error) {
          if (!(error instanceof GitHubAuthError && error.definitive)) throw error
          if (!sameRecord(await this.ctx.credentials.readRecord(GITHUB_APP_CREDENTIAL_KEY), current)) return undefined
          invalidated = true
          const marker: InvalidatedGrant = { version: 1, invalidated: true }
          return { kind: 'grant', payload: marker }
        }
      })
      if (invalidated === true && this.isOpen()) this.ctx.emit('github-app-auth/connection-changed')
      return token
    } catch {
      return undefined
    }
  }

  /** Exchange one refresh token without writing until the caller's serialized mutation admits it. */
  private async fetchRefresh(refreshToken: string, previous: GitHubGrant, signal: AbortSignal): Promise<GitHubGrant> {
    const response = await requestGithub(
      ACCESS_TOKEN_URL,
      new URLSearchParams({ client_id: this.clientId, refresh_token: refreshToken, grant_type: REFRESH_GRANT_TYPE }),
      signal,
    )
    throwOAuthError(response)
    return grantFromResponse(response, this.clientId, previous)
  }

  /** Atomically replace only the invalidated record with a secret-free marker. */
  private async invalidate(expectedRecord: CredentialRecord): Promise<void> {
    const state = { invalidated: false }
    await this.ctx.credentials.modifyRecord(GITHUB_APP_CREDENTIAL_KEY, (current) => {
      if (!sameRecord(current, expectedRecord) || isInvalidatedGrant(current)) return Promise.resolve(undefined)
      state.invalidated = true
      const marker: InvalidatedGrant = { version: 1, invalidated: true }
      return Promise.resolve({ kind: 'grant', payload: marker })
    })
    if (state.invalidated && this.isOpen()) this.ctx.emit('github-app-auth/connection-changed')
  }

  /** Return whether a request still belongs to this live service generation. */
  private isCurrent(generation: number): boolean {
    return !this.closed && this.disconnecting === undefined && generation === this.refreshGeneration
  }

  /** Return whether this service has not been disposed. */
  private isOpen(): boolean {
    return !this.closed
  }

  /** Return whether refresh work still belongs to this generation and is not aborted. */
  private isRefreshCurrent(generation: number, signal: AbortSignal): boolean {
    return this.isCurrent(generation) && !signal.aborted
  }
}
