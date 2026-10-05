import { afterEach, expect, it, vi } from 'vitest'
import { authorizationUrl, validateCallback, refreshGrant, readModels } from '../src/chatgpt-protocol.ts'

const attempt = { state: 'state', nonce: 'nonce', verifier: 'verifier', hostId: 'urn:uuid:host', redirectUri: 'http://127.0.0.1:23456/auth/callback' }
afterEach(() => vi.unstubAllGlobals())
it('uses dynamic registration, PKCE and the actual application name', () => {
  const url = new URL(authorizationUrl(attempt))
  expect(url.origin + url.pathname).toBe('https://auth.openai.com/api/accounts/authorize')
  expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client')
  expect(url.searchParams.get('agent_name_hint')).toBe('DeepSeek Harness')
  expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  expect(url.searchParams.get('code_challenge')).not.toBe(attempt.verifier)
  expect(url.searchParams.get('redirect_uri')).toBe(attempt.redirectUri)
  expect(url.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct')
})
it('rejects incorrect state, denied consent, missing issued ID and mismatched returning client', () => {
  expect(() => validateCallback(new URLSearchParams('state=other&code=x&client_id=oaiapp_test'), attempt)).toThrow('state')
  expect(() => validateCallback(new URLSearchParams('state=state&error=access_denied'), attempt)).toThrow('denied')
  expect(() => validateCallback(new URLSearchParams('state=state&code=x'), attempt)).toThrow('client')
  expect(() => validateCallback(new URLSearchParams('state=state&code=x&client_id=oaiapp_other'), { ...attempt, clientId: 'oaiapp_saved' })).toThrow('client')
  expect(validateCallback(new URLSearchParams('state=state&code=x'), { ...attempt, clientId: 'oaiapp_saved' })).toEqual({ code: 'x', clientId: 'oaiapp_saved' })
})
it('rotates credentials with the issued client and omits scope and client secrets', async () => {
  let request: Request | undefined
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    request = new Request(url, init)
    return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' })
  })
  const grant = await refreshGrant({ type: 'oauth', access: 'old', refresh: 'refresh', expires: 0, clientId: 'oaiapp_test', subject: 'user', email: 'user@example.test' }, new AbortController().signal)
  expect(request?.url).toBe('https://auth.openai.com/api/accounts/oauth/token')
  const body = new URLSearchParams(await request!.text())
  expect(Object.fromEntries(body)).toEqual({ grant_type: 'refresh_token', client_id: 'oaiapp_test', refresh_token: 'refresh', resource: 'https://api.openai.com/v1' })
  expect(grant).toMatchObject({ access: 'new-access', refresh: 'new-refresh', subject: 'user' })
})
it('lists only account-visible models in server order and rejects authorization failures without echoing response bodies', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ models: [{ slug: 'allowed', display_name: 'Allowed', visibility: 'list' }, { slug: 'hidden', visibility: 'hidden' }] }))
  expect(await readModels('mock-token')).toEqual([{ id: 'allowed', name: 'Allowed' }])
  vi.stubGlobal('fetch', async () => new Response('secret-response', { status: 401 }))
  await expect(readModels('mock-token')).rejects.toThrow('sign in')
  await expect(readModels('mock-token')).rejects.not.toThrow('secret-response')
})

it('uses the documented revocation endpoint and never sends a client secret', async () => {
  const { revokeGrant } = await import('../src/chatgpt-protocol.ts')
  const seen: Request[] = []
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const request = new Request(url, init)
    seen.push(request)
    return request.url.endsWith('/.well-known/openid-configuration')
      ? Response.json({ issuer: 'https://auth.openai.com', revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' })
      : new Response(null, { status: 200 })
  })
  expect(await revokeGrant({ type: 'oauth', access: 'mock-access', refresh: 'mock-refresh', expires: 0, clientId: 'oaiapp_test', subject: 'mock-user', email: 'user@example.test' })).toBe(true)
  expect(seen[1]!.url).toBe('https://auth.openai.com/api/accounts/oauth/revoke')
  expect(Object.fromEntries(new URLSearchParams(await seen[1]!.text()))).toEqual({ token: 'mock-refresh', token_type_hint: 'refresh_token', client_id: 'oaiapp_test' })
})

it('binds only a temporary loopback callback and closes it when cancelled', async () => {
  const { startAuthorization } = await import('../src/chatgpt-protocol.ts')
  const controller = new AbortController()
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  const pending = await startAuthorization('urn:uuid:mock-host', undefined, controller.signal)
  const redirect = new URL(new URL(pending.url).searchParams.get('redirect_uri')!)
  expect(redirect.hostname).toBe('127.0.0.1')
  expect(redirect.pathname).toBe('/auth/callback')
  expect(fetchSpy).not.toHaveBeenCalled()
  controller.abort()
  await expect(pending.completion).rejects.toThrow('cancelled')
  fetchSpy.mockRestore()
  await expect(fetch(redirect)).rejects.toThrow()
})

it('preserves advertised wire efforts, context, Fast tiers and explains product-only Ultra', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ models: [{ slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', context_window: 272000,
    default_reasoning_level: 'low', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort, description: effort === 'ultra' ? 'Maximum reasoning with automatic task delegation' : effort })),
    service_tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }] }] }))
  expect(await readModels('mock-token')).toEqual([{ id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: 272000,
    reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' }, defaultReasoning: 'low',
    unavailableReasoningEfforts: ['ultra'], serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }] }])
})
