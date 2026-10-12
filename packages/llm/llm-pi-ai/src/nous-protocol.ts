/**
 * Nous OAuth device flow and refresh, adapted from Hermes auth_device_flow.py
 * and auth_nous.py. Copyright (c) 2025 Nous Research. MIT license; see
 * ../NOUS-LICENSE.txt. No storage or network at import time.
 */
import type { OAuthCredential } from '@earendil-works/pi-ai'
import type { NousDeviceVerification, NousModelView } from './nous-types.ts'

const PORTAL = 'https://portal.nousresearch.com'
const TOKEN_URL = `${PORTAL}/api/oauth/token`
const INVOKE_SCOPE = 'inference:invoke'
const DEFAULT_INFERENCE_URL = 'https://inference-api.nousresearch.com/v1'
const INFERENCE_HOSTS = new Set(['inference-api.nousresearch.com', 'welcome-api.nousresearch.com'])
const REQUEST_TIMEOUT_MS = 20_000
const MAX_TIMER_MS = 2_147_483_647

/** One Host-owned renewable grant, bound to the deployment's client registration. */
export interface NousGrant extends OAuthCredential {
  clientId: string
  scope: string
  inferenceBaseURL: string
  /** Retained only for unusable refresh metadata, so rotation can precede auth validation. */
  tokenType?: string
}
/** Host-only polling token and browser instructions for one expiring device attempt. */
export interface NousDeviceAuthorization {
  deviceCode: string
  verification: NousDeviceVerification
  intervalSeconds: number
}

/** Safe, classified failure. Remote descriptions, tokens and network errors are never reflected. */
export class NousProtocolError extends Error {
  constructor(public code: string, public retryable = false, public reauthenticate = false) {
    const messages: Record<string, string> = {
      invalid_client_id: 'Nous sign-in requires a configured client registration.',
      invalid_response: 'Nous returned an invalid response. Try again.',
      invalid_grant_data: 'The stored Nous credential is invalid. Sign in again.',
      invalid_inference_url: 'The Nous inference address is not trusted.',
      cancelled: 'Nous sign-in was cancelled.',
      expired_token: 'Nous device authorization expired. Start sign-in again.',
      authorization_pending: 'Nous device authorization is awaiting approval.',
      slow_down: 'Nous requested slower authorization polling.',
      access_denied: 'Nous device authorization was denied. Start sign-in again when ready.',
      invalid_grant: 'The Nous session is no longer valid. Sign in again.',
      invalid_token: 'The Nous token is no longer valid. Sign in again.',
      refresh_token_reused: 'The Nous session was revoked after refresh-token reuse. Sign in again.',
      invalid_client: 'Nous refused the configured client registration.',
      unauthorized_client: 'Nous refused authorization for this client registration.',
      invalid_scope: 'Nous did not grant inference access. Start sign-in again.',
      insufficient_scope: 'The Nous session does not grant inference access. Sign in again.',
      upstream_blocked: 'The Nous portal temporarily challenged the request. Try again later.',
      temporarily_unavailable: 'Nous is temporarily unavailable. Try again later.',
      request_timeout: 'The Nous request timed out. Try again later.',
      network_error: 'Nous could not be reached. Try again later.',
      request_failed: 'The Nous request failed. Try again later.',
    }
    super(messages[code] ?? messages.request_failed)
    this.name = 'NousProtocolError'
  }
}

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new NousProtocolError('cancelled')
}
function checkTimedOut(signal: AbortSignal): void {
  if (signal.aborted) throw new NousProtocolError('request_timeout', true)
}
function object(value: unknown, code = 'invalid_response'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new NousProtocolError(code)
  return value as Record<string, unknown>
}
function text(value: unknown, code = 'invalid_response'): string {
  if (typeof value !== 'string' || value.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) throw new NousProtocolError(code)
  return value
}
function token(value: unknown, code = 'invalid_response'): string {
  const result = text(value, code)
  if (/[^\u0021-\u007e]/u.test(result)) throw new NousProtocolError(code)
  return result
}
function clientIdentity(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new NousProtocolError('invalid_client_id')
  return text(value.trim(), 'invalid_client_id')
}
function scope(value: unknown, code = 'invalid_response'): string {
  const scopes = text(value, code).trim().split(/\s+/u)
  if (!scopes.includes(INVOKE_SCOPE)) throw new NousProtocolError(code)
  return scopes.join(' ')
}
function positiveInteger(value: unknown, code = 'invalid_response'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new NousProtocolError(code)
  return value
}
function expiryFromLifetime(value: unknown): number {
  const expires = Date.now() + positiveInteger(value) * 1000
  return positiveInteger(expires)
}
function inferenceURL(value: unknown): string {
  const fail = (): never => { throw new NousProtocolError('invalid_inference_url') }
  if (typeof value !== 'string' || /[?#@\\\s]/u.test(value) || !/^[^:]+:\/\/[^/]+\/v1\/?$/u.test(value)) return fail()
  let parsed: URL
  try { parsed = new URL(value) } catch { return fail() }
  if (parsed.protocol !== 'https:' || !INFERENCE_HOSTS.has(parsed.hostname) || parsed.port !== ''
    || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== ''
    || !['/v1', '/v1/'].includes(parsed.pathname)) return fail()
  return `${parsed.origin}/v1`
}
function verificationURL(value: unknown): string {
  const url = text(value)
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new NousProtocolError('invalid_response') }
  if (parsed.origin !== PORTAL || parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
    throw new NousProtocolError('invalid_response')
  }
  return parsed.href
}

/**
 * Validate stored credentials before bearer derivation or refresh; failures require sign-in.
 * @param value - opaque credential payload read from the Host store.
 * @returns a validated grant with its canonical trusted inference address.
 */
export function validateNousGrant(value: unknown): NousGrant {
  try {
    const data = object(value, 'invalid_grant_data')
    if (data.type !== 'oauth' || data.tokenType !== undefined && text(data.tokenType, 'invalid_grant_data').toLowerCase() !== 'bearer') {
      throw new NousProtocolError('invalid_grant_data')
    }
    return {
      type: 'oauth', access: token(data.access, 'invalid_grant_data'), refresh: token(data.refresh, 'invalid_grant_data'),
      expires: positiveInteger(data.expires, 'invalid_grant_data'), clientId: clientIdentity(data.clientId),
      scope: scope(data.scope, 'invalid_grant_data'), inferenceBaseURL: inferenceURL(data.inferenceBaseURL),
    }
  } catch (error) {
    if (error instanceof NousProtocolError) error.reauthenticate = true
    throw error
  }
}

const SAFE_OAUTH_CODES = new Set([
  'authorization_pending', 'slow_down', 'access_denied', 'expired_token', 'invalid_grant', 'invalid_token',
  'refresh_token_reused', 'invalid_client', 'unauthorized_client', 'invalid_scope', 'insufficient_scope',
])
const DEAD_GRANT_CODES = new Set(['invalid_grant', 'invalid_token', 'refresh_token_reused', 'expired_token', 'invalid_scope', 'insufficient_scope'])

async function requestJson(url: string, init: RequestInit, signal: AbortSignal, deadline?: number): Promise<Record<string, unknown>> {
  checkCancelled(signal)
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT_MS,
    deadline === undefined ? REQUEST_TIMEOUT_MS : deadline - Date.now())))
  const requestSignal = AbortSignal.any([signal, timeout])
  let response: Response
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal: requestSignal })
    checkCancelled(signal)
    checkTimedOut(timeout)
  } catch (error) {
    checkCancelled(signal)
    checkTimedOut(timeout)
    if (error instanceof NousProtocolError) throw error
    throw new NousProtocolError('network_error', true)
  }
  if (!response.ok && (response.status === 408 || response.status === 429 || response.status >= 500)) {
    throw new NousProtocolError('temporarily_unavailable', true)
  }
  if (!response.ok && response.status === 403 && response.headers.get('x-vercel-mitigated')) {
    throw new NousProtocolError('upstream_blocked', true)
  }
  let data: unknown
  try { data = await response.json() } catch {
    checkCancelled(signal)
    checkTimedOut(timeout)
    if (response.status === 401 || response.status === 403) throw new NousProtocolError('invalid_grant', false, true)
    throw new NousProtocolError(response.ok ? 'invalid_response' : 'request_failed')
  }
  checkCancelled(signal)
  if (deadline !== undefined && Date.now() >= deadline) throw new NousProtocolError('expired_token', false, true)
  checkTimedOut(timeout)
  if (!response.ok) {
    const rawCode = typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>).error : undefined
    const code = typeof rawCode === 'string' && SAFE_OAUTH_CODES.has(rawCode) ? rawCode
      : response.status === 401 || response.status === 403 ? 'invalid_grant' : 'request_failed'
    throw new NousProtocolError(code, false, DEAD_GRANT_CODES.has(code))
  }
  return object(data)
}

function formRequest(body: Record<string, string>, extraHeaders: Record<string, string> = {}): RequestInit {
  return { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', ...extraHeaders }, body: new URLSearchParams(body) }
}
function tokenGrant(data: Record<string, unknown>, clientId: string, previous?: NousGrant): NousGrant {
  // OAuth permits omitted scope when it equals the requested/previous scope.
  // Nous bearer tokens are authorized by the server; this layer never inspects JWT identity.
  const tokenType = data.token_type === undefined ? 'bearer' : typeof data.token_type === 'string' ? data.token_type : ''
  const metadata = (value: unknown, fallback: string): string => value === undefined ? fallback : typeof value === 'string' ? value : ''
  const result: NousGrant = {
    type: 'oauth', access: token(data.access_token),
    refresh: token(data.refresh_token === undefined ? previous?.refresh : data.refresh_token),
    expires: expiryFromLifetime(data.expires_in), clientId,
    scope: metadata(data.scope, previous?.scope ?? INVOKE_SCOPE),
    inferenceBaseURL: metadata(data.inference_base_url, previous?.inferenceBaseURL ?? DEFAULT_INFERENCE_URL),
    ...(tokenType.toLowerCase() === 'bearer' ? {} : { tokenType }),
  }
  // A successful refresh may have spent a single-use token. Return its rotation
  // before secondary scope/route/type checks; request auth validates after commit.
  if (previous !== undefined) return result
  if (tokenType.toLowerCase() !== 'bearer') throw new NousProtocolError('invalid_response')
  return { ...result, scope: scope(result.scope), inferenceBaseURL: inferenceURL(result.inferenceBaseURL) }
}

/**
 * Start device authorization with the deployment's registration and inference invocation scope.
 * @param clientId - public client identity authorized for this deployment.
 * @param signal - cancels the device-code request.
 * @returns Host-owned device polling data and display-safe browser instructions.
 */
export async function startNousDeviceAuthorization(clientId: string, signal: AbortSignal): Promise<NousDeviceAuthorization> {
  const identity = clientIdentity(clientId)
  const data = await requestJson(`${PORTAL}/api/oauth/device/code`, formRequest({ client_id: identity, scope: INVOKE_SCOPE }), signal)
  // Validate both addresses even when only the complete one is shown.
  const fallback = verificationURL(data.verification_uri)
  const url = data.verification_uri_complete === undefined ? fallback : verificationURL(data.verification_uri_complete)
  return {
    deviceCode: token(data.device_code), intervalSeconds: positiveInteger(data.interval),
    verification: { url, code: text(data.user_code), expiresAt: expiryFromLifetime(data.expires_in) },
  }
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + milliseconds
  do {
    checkCancelled(signal)
    await new Promise<void>((resolve, reject) => {
      const finish = (): void => { signal.removeEventListener('abort', abort); resolve() }
      const timer = setTimeout(finish, Math.min(MAX_TIMER_MS, Math.max(0, deadline - Date.now())))
      const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new NousProtocolError('cancelled')) }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  } while (Date.now() < deadline)
  checkCancelled(signal)
}

/**
 * Poll within the server interval and device deadline; cancellation prevents grant delivery.
 * @param clientId - identity used to start this device attempt.
 * @param attempt - device polling data returned by startNousDeviceAuthorization.
 * @param signal - cancels polling and interval waits.
 * @returns the initial grant, validated before storage.
 */
export async function completeNousDeviceAuthorization(
  clientId: string, attempt: NousDeviceAuthorization, signal: AbortSignal,
): Promise<NousGrant> {
  const identity = clientIdentity(clientId)
  const deviceCode = token(attempt.deviceCode)
  const deadline = positiveInteger(attempt.verification.expiresAt)
  let interval = positiveInteger(attempt.intervalSeconds)
  for (;;) {
    checkCancelled(signal)
    if (Date.now() >= deadline) throw new NousProtocolError('expired_token', false, true)
    await wait(Math.min(interval * 1000, deadline - Date.now()), signal)
    if (Date.now() >= deadline) throw new NousProtocolError('expired_token', false, true)
    try {
      const data = await requestJson(TOKEN_URL, formRequest({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: identity, device_code: deviceCode }), signal, deadline)
      return tokenGrant(data, identity)
    } catch (error) {
      if (!(error instanceof NousProtocolError)) throw error
      if (error.code === 'slow_down') interval += 5
      else if (error.code !== 'authorization_pending' && !error.retryable) throw error
    }
  }
}

/**
 * Redeem refresh credentials; persist the returned rotation before validating request auth.
 * @param grant - validated credential read under the caller's store lock.
 * @param signal - cancels the refresh request.
 * @returns rotated tokens with secondary metadata to validate after durable persistence.
 */
export async function refreshNousGrant(grant: NousGrant, signal: AbortSignal): Promise<NousGrant> {
  const previous = validateNousGrant(grant)
  const data = await requestJson(TOKEN_URL, formRequest({ grant_type: 'refresh_token', client_id: previous.clientId }, { 'x-nous-refresh-token': previous.refresh }), signal)
  return tokenGrant(data, previous.clientId, previous)
}

function optionalPositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}
function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Read account-visible models from the trusted inference service using bearer authentication.
 * @param access - header-safe OAuth access token kept on the Host.
 * @param baseURL - validated inference address supplied by the grant.
 * @param signal - cancels the catalog request.
 * @returns display-safe models with only advertised capabilities.
 */
export async function readNousModels(access: string, baseURL: string, signal: AbortSignal): Promise<NousModelView[]> {
  const base = inferenceURL(baseURL)
  const bearer = token(access)
  const data = await requestJson(`${base}/models`, { headers: { Accept: 'application/json', Authorization: `Bearer ${bearer}` } }, signal)
  if (!Array.isArray(data.data)) throw new NousProtocolError('invalid_response')
  return data.data.flatMap((entry: unknown) => {
    const model = optionalObject(entry)
    if (model === undefined || typeof model.id !== 'string' || model.id.trim() === '') return []
    const reasoning = optionalObject(model.reasoning)
    const declaredEfforts = reasoning?.supported_efforts
    const parameters = Array.isArray(model.supported_parameters) ? model.supported_parameters : []
    const view: NousModelView = {
      id: model.id, name: typeof model.name === 'string' && model.name.trim() !== '' ? model.name : model.id,
      reasoning: parameters.includes('reasoning') || parameters.includes('reasoning_effort') || reasoning?.mandatory === true || Array.isArray(declaredEfforts) && declaredEfforts.length > 0,
    }
    const contextWindow = optionalPositive(model.context_length)
    if (contextWindow !== undefined) view.contextWindow = contextWindow
    const maxTokens = optionalPositive(optionalObject(model.top_provider)?.max_completion_tokens)
    if (maxTokens !== undefined) view.maxTokens = maxTokens
    const modalities = optionalObject(model.architecture)?.input_modalities
    if (Array.isArray(modalities)) {
      const input = [...new Set(modalities.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image'))]
      if (input.length > 0) view.inputModalities = input
    }
    if (typeof reasoning?.mandatory === 'boolean') view.reasoningMandatory = reasoning.mandatory
    if (Array.isArray(declaredEfforts)) {
      const efforts: NonNullable<NousModelView['reasoningEfforts']> = {}
      for (const effort of declaredEfforts as unknown[]) {
        if ((effort === 'off' || effort === 'none') && reasoning?.mandatory !== true) efforts.off = effort
        else if (effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max') efforts[effort] = effort
      }
      if (Object.keys(efforts).length > 0) view.reasoningEfforts = efforts
    }
    return [view]
  })
}
