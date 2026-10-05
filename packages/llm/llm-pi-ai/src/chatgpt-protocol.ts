/** Public-client Sign in with ChatGPT protocol. No network or listeners at import time. */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { OAuthCredential } from '@earendil-works/pi-ai'

const ISSUER = 'https://auth.openai.com'
const RESOURCE = 'https://api.openai.com/v1'
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'

/** Values bound to one loopback authorization, never written to logs. */
export interface ChatGPTAttempt {
  state: string
  nonce: string
  verifier: string
  hostId: string
  redirectUri: string
  clientId?: string
  subject?: string
}
/** One verified account registration. Tokens remain on the Host. */
export interface ChatGPTGrant extends OAuthCredential {
  clientId: string
  subject: string
  email: string
  idToken?: string
  scopes?: string
  earliestRefreshAt?: number
}

/** Build a public-client authorization request without a borrowed client ID. */
export function authorizationUrl(attempt: ChatGPTAttempt): string {
  const params = new URLSearchParams({
    client_id: attempt.clientId ?? 'dynamic_agent_client',
    ext_agent_host_id: attempt.hostId,
    response_type: 'code', redirect_uri: attempt.redirectUri,
    scope: SCOPE, resource: RESOURCE, state: attempt.state, nonce: attempt.nonce,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
  })
  if (attempt.clientId === undefined) params.set('agent_name_hint', 'DeepSeek Harness')
  // Retained ID tokens deliberately stay on the Host; the browser can choose
  // the account without putting an ID-token hint in a renderer-visible URL.
  return `${ISSUER}/api/accounts/authorize?${params.toString()}`
}

/** Validate the callback before using either the code or the issued client identity. */
export function validateCallback(params: URLSearchParams, attempt: ChatGPTAttempt): { code: string; clientId: string } {
  if (params.get('state') !== attempt.state) throw new Error('ChatGPT callback state did not match.')
  if (params.has('error')) throw new Error('ChatGPT sign-in was denied or cancelled. Try again when ready.')
  if (['state', 'code', 'client_id', 'error'].some(key => params.getAll(key).length > 1)) throw new Error('ChatGPT callback contains repeated parameters.')
  const clientId = params.get('client_id') ?? attempt.clientId
  if (!clientId || clientId === 'dynamic_agent_client' || (attempt.clientId !== undefined && attempt.clientId !== clientId)) {
    throw new Error('ChatGPT returned an invalid client registration. Start sign-in again.')
  }
  const code = params.get('code')
  if (!code) throw new Error('ChatGPT returned no authorization code. Start sign-in again.')
  return { code, clientId }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('ChatGPT returned an invalid response.')
  return value as Record<string, unknown>
}
function required(data: Record<string, unknown>, key: string): string {
  const value = data[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`ChatGPT response is missing ${key}.`)
  return value
}
async function requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(20_000) })
  if (!response.ok) {
    if (response.status === 401 || response.status === 403 || response.status === 400) throw new Error('ChatGPT authorization was refused; sign in again in Models settings.')
    if (response.status === 429) throw new Error('ChatGPT rate or usage limit reached. Review ChatGPT Settings → Usage and try later.')
    throw new Error(`ChatGPT request failed (HTTP ${response.status}). Try again later.`)
  }
  return object(await response.json())
}
function tokenFields(data: Record<string, unknown>): Pick<ChatGPTGrant, 'type' | 'access' | 'refresh' | 'expires' | 'scopes' | 'earliestRefreshAt'> {
  const scopes = required(data, 'scope')
  if (!scopes.split(' ').includes('chatgpt.tokens.use.direct')) throw new Error('ChatGPT plan use was not granted. Sign in and enable plan usage.')
  if (required(data, 'token_type').toLowerCase() !== 'bearer') throw new Error('ChatGPT returned an unsupported token type.')
  if (typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('ChatGPT returned an invalid token lifetime.')
  return {
    type: 'oauth', access: required(data, 'access_token'), refresh: required(data, 'refresh_token'),
    expires: Date.now() + data.expires_in * 1000, scopes,
    ...(typeof data.earliest_refresh_at === 'number' ? { earliestRefreshAt: data.earliest_refresh_at * 1000 }
      : typeof data.earliest_refresh_at === 'string' && Number.isFinite(Date.parse(data.earliest_refresh_at)) ? { earliestRefreshAt: Date.parse(data.earliest_refresh_at) } : {}),
  }
}
async function tokenRequest(body: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
  return requestJson(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...body, resource: RESOURCE }), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) })
}

/** Exchange a callback and validate OpenAI's signed identity before committing credentials. */
export async function exchangeGrant(params: URLSearchParams, attempt: ChatGPTAttempt, signal: AbortSignal): Promise<ChatGPTGrant> {
  const { code, clientId } = validateCallback(params, attempt)
  const data = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri }, signal)
  const fields = tokenFields(data)
  const discovery = await requestJson(`${ISSUER}/.well-known/openid-configuration`, { signal })
  const jwksUri = required(discovery, 'jwks_uri')
  if (discovery.issuer !== ISSUER || new URL(jwksUri).origin !== ISSUER) throw new Error('ChatGPT identity configuration could not be verified.')
  const idToken = required(data, 'id_token')
  let subject: string
  let email: string
  try {
    const { payload } = await jwtVerify(idToken, createRemoteJWKSet(new URL(jwksUri)), {
      issuer: ISSUER, audience: clientId, algorithms: ['RS256'], requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub', 'nonce'],
    })
    if (payload.nonce !== attempt.nonce || typeof payload.sub !== 'string' || (attempt.subject !== undefined && payload.sub !== attempt.subject)) throw new Error('identity')
    subject = payload.sub
    email = typeof payload.email === 'string' ? payload.email : subject
  } catch {
    throw new Error('ChatGPT account identity could not be verified. Existing accounts were kept; start sign-in again.')
  }
  return { ...fields, clientId, subject, email, idToken }
}

/** Rotate under the caller's credential-store lock; retain the already verified account identity. */
export async function refreshGrant(grant: ChatGPTGrant, signal: AbortSignal): Promise<ChatGPTGrant> {
  if (grant.earliestRefreshAt !== undefined && Date.now() < grant.earliestRefreshAt && Date.now() < grant.expires) return grant
  const data = await tokenRequest({ grant_type: 'refresh_token', client_id: grant.clientId, refresh_token: grant.refresh }, signal)
  return { ...grant, ...tokenFields(data) }
}

import type { ChatGPTModelView } from './chatgpt-types.ts'

/** Read the selected account's current picker catalog without making an inference request. */
export async function readModels(access: string): Promise<ChatGPTModelView[]> {
  const data = await requestJson(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${access}` } })
  if (!Array.isArray(data.models)) throw new Error('ChatGPT did not return an account model catalog.')
  const wireEfforts = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
  return data.models.flatMap((value: unknown) => {
    const model = object(value)
    if (model.visibility !== 'list' || typeof model.slug !== 'string' || typeof model.display_name !== 'string') return []
    const view: ChatGPTModelView = { id: model.slug, name: model.display_name }
    if (typeof model.context_window === 'number' && Number.isSafeInteger(model.context_window) && model.context_window > 0) view.contextWindow = model.context_window
    if (Array.isArray(model.supported_reasoning_levels)) {
      const efforts: NonNullable<ChatGPTModelView['reasoningEfforts']> = {}
      const unavailable: string[] = []
      for (const entry of model.supported_reasoning_levels) {
        const declared = object(entry)
        const wire = wireEfforts.find(effort => effort === declared.effort)
        if (wire !== undefined) efforts[wire] = wire
        else if (declared.effort === 'ultra') unavailable.push('ultra')
      }
      if (Object.keys(efforts).length > 0) view.reasoningEfforts = efforts
      if (unavailable.length > 0) view.unavailableReasoningEfforts = unavailable
      const defaultReasoning = wireEfforts.find(effort => effort === model.default_reasoning_level && efforts[effort] !== undefined)
      if (defaultReasoning !== undefined) view.defaultReasoning = defaultReasoning
    }
    if (Array.isArray(model.service_tiers)) view.serviceTiers = model.service_tiers.flatMap((entry: unknown) => {
      const tier = object(entry)
      return ['priority', 'fast', 'ultrafast'].some(id => tier.id === id) && typeof tier.id === 'string' && typeof tier.name === 'string'
        ? [{ id: tier.id, name: tier.name, description: typeof tier.description === 'string' ? tier.description : '' }] : []
    })
    return [view]
  })
}

/** User-initiated, IPv4-loopback-only listener; timeout/cancellation closes the listener. */
export async function startAuthorization(
  hostId: string,
  previous: ChatGPTGrant | undefined,
  signal: AbortSignal,
): Promise<{ url: string; completion: Promise<ChatGPTGrant> }> {
  signal.throwIfAborted()
  const random = (): string => randomBytes(32).toString('base64url')
  let resolveCallback!: (params: URLSearchParams) => void
  let rejectCallback!: (error: Error) => void
  const callback = new Promise<URLSearchParams>((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject })
  const attempt: ChatGPTAttempt = { state: random(), nonce: random(), verifier: random(), hostId, redirectUri: '',
    ...(previous === undefined ? {} : { clientId: previous.clientId, subject: previous.subject }) }
  let accepted = false
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Security-Policy', "default-src 'none'")
    if (req.method !== 'GET' || url.pathname !== '/auth/callback' || url.searchParams.get('state') !== attempt.state || accepted) {
      res.writeHead(400).end('Invalid or expired callback. Return to DeepSeek Harness.'); return
    }
    accepted = true
    res.end('Return to DeepSeek Harness to finish connecting ChatGPT.')
    resolveCallback(url.searchParams)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') { server.close(); throw new Error('ChatGPT callback listener could not start.') }
  attempt.redirectUri = `http://127.0.0.1:${address.port}/auth/callback`
  const abort = (): void =>{  rejectCallback(new Error('ChatGPT sign-in cancelled.')) }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const timer = setTimeout(() =>{  rejectCallback(new Error('ChatGPT sign-in expired. Start again.')) }, 5 * 60_000)
  const completion = (async () => {
    try { return await exchangeGrant(await callback, attempt, signal) }
    finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      const closed = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      server.closeAllConnections()
      await closed
    }
  })()
  return { url: authorizationUrl(attempt), completion }
}

/** Revoke a renewable session only on explicit disconnect; false means remote revocation was not confirmed. */
export async function revokeGrant(grant: ChatGPTGrant): Promise<boolean> {
  try {
    const discovery = await requestJson(`${ISSUER}/.well-known/openid-configuration`, {})
    const endpoint = required(discovery, 'revocation_endpoint')
    if (discovery.issuer !== ISSUER || new URL(endpoint).origin !== ISSUER) return false
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: grant.refresh, token_type_hint: 'refresh_token', client_id: grant.clientId }),
      })
      if (response.status === 200) return true
      if (response.status < 500) return false
      if (attempt === 0) await new Promise<void>(resolve => setTimeout(resolve, 500))
    }
  } catch {
    // Local disconnect still succeeds; the UI directs the user to ChatGPT settings.
    return false
  }
  return false
}
