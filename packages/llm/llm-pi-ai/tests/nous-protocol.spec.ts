import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  completeNousDeviceAuthorization, NousProtocolError, readNousModels,
  refreshNousGrant, startNousDeviceAuthorization, validateNousGrant,
} from '../src/nous-protocol.ts'
import type { NousDeviceAuthorization, NousGrant } from '../src/nous-protocol.ts'

const NOW = 1_800_000_000_000
const PORTAL = 'https://portal.nousresearch.com'
const PAID = 'https://inference-api.nousresearch.com/v1'
const WELCOME = 'https://welcome-api.nousresearch.com/v1'
const controller = (): AbortController => new AbortController()
const device = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  device_code: 'device-secret', user_code: 'ABCD-EFGH',
  verification_uri: `${PORTAL}/device`,
  verification_uri_complete: `${PORTAL}/device?user_code=ABCD-EFGH`,
  expires_in: 60, interval: 5, ...overrides,
})
const tokens = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  access_token: 'opaque-access', refresh_token: 'rotated-refresh', token_type: 'Bearer',
  expires_in: 300, scope: 'inference:invoke', inference_base_url: PAID, ...overrides,
})
const grant = (overrides: Partial<NousGrant> = {}): NousGrant => ({
  type: 'oauth', access: 'old-access', refresh: 'old-refresh', expires: NOW + 50_000,
  clientId: 'registered-client', scope: 'inference:invoke', inferenceBaseURL: PAID, ...overrides,
})
const attempt = (overrides: Partial<NousDeviceAuthorization> = {}): NousDeviceAuthorization => ({
  deviceCode: 'device-secret', intervalSeconds: 5,
  verification: { url: `${PORTAL}/device?user_code=ABCD-EFGH`, code: 'ABCD-EFGH', expiresAt: NOW + 60_000 },
  ...overrides,
})
const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } })
function resultOf<T>(promise: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  return promise.then(value => ({ value }), (error: unknown) => ({ error }))
}

describe('Nous OAuth protocol', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

  it('requests a device code with the explicit trimmed client and invoke scope', async () => {
    let request: { url: string; init: RequestInit } | undefined
    const abort = controller()
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      request = { url, init }
      return json(device())
    })
    expect(await startNousDeviceAuthorization(' registered-client ', abort.signal)).toEqual({
      deviceCode: 'device-secret', intervalSeconds: 5,
      verification: { url: `${PORTAL}/device?user_code=ABCD-EFGH`, code: 'ABCD-EFGH', expiresAt: NOW + 60_000 },
    })
    expect(request?.url).toBe(`${PORTAL}/api/oauth/device/code`)
    expect(request?.init.method).toBe('POST')
    expect(new URLSearchParams(request?.init.body as URLSearchParams).toString()).toBe('client_id=registered-client&scope=inference%3Ainvoke')
    expect(new Headers(request?.init.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded')
    expect(request?.init.redirect).toBe('error')
    expect(request?.init.signal).not.toBe(abort.signal)
    abort.abort('a private reason')
    expect(request?.init.signal?.aborted).toBe(true)
  })

  it.each(['', ' \t\n '])('rejects an empty supplied client before requesting authorization', async (clientId) => {
    const network = vi.fn()
    vi.stubGlobal('fetch', network)
    await expect(startNousDeviceAuthorization(clientId, controller().signal)).rejects.toMatchObject({ code: 'invalid_client_id' })
    expect(network).not.toHaveBeenCalled()
  })

  it.each([
    { verification_uri_complete: 'https://evil.example/device?user_code=ABCD' },
    { verification_uri_complete: 'http://portal.nousresearch.com/device' },
    { verification_uri_complete: 'https://user:pass@portal.nousresearch.com/device' },
    { verification_uri_complete: `${PORTAL}/device#secret` },
    { device_code: ' ' }, { user_code: '' }, { expires_in: 0 }, { expires_in: '60' }, { interval: 0 }, { interval: -1 },
  ])('rejects unsafe or malformed device responses: %j', async (fields) => {
    vi.stubGlobal('fetch', async () => json(device(fields)))
    await expect(startNousDeviceAuthorization('registered-client', controller().signal)).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('uses the portal verification URI when the complete URI is omitted', async () => {
    vi.stubGlobal('fetch', async () => json(device({ verification_uri_complete: undefined })))
    expect((await startNousDeviceAuthorization('registered-client', controller().signal)).verification.url).toBe(`${PORTAL}/device`)
  })

  it('honors pending intervals and increases slow_down pacing by five seconds', async () => {
    const times: number[] = []
    const requests: RequestInit[] = []
    const responses = [json({ error: 'authorization_pending' }, 400), json({ error: 'slow_down' }, 400), json(tokens())]
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      expect(url).toBe(`${PORTAL}/api/oauth/token`)
      times.push(Date.now()); requests.push(init)
      return responses.shift()!
    })
    const result = resultOf(completeNousDeviceAuthorization(' registered-client ', attempt(), controller().signal))
    await vi.advanceTimersByTimeAsync(4_999)
    expect(times).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(times).toEqual([NOW + 5_000])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(times).toEqual([NOW + 5_000, NOW + 10_000])
    await vi.advanceTimersByTimeAsync(9_999)
    expect(times).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toEqual({ value: {
      type: 'oauth', access: 'opaque-access', refresh: 'rotated-refresh', expires: NOW + 320_000,
      clientId: 'registered-client', scope: 'inference:invoke', inferenceBaseURL: PAID,
    } })
    expect(new URLSearchParams(requests[0]?.body as URLSearchParams).toString()).toBe('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&client_id=registered-client&device_code=device-secret')
    expect(requests.every(request => request.redirect === 'error')).toBe(true)
  })

  it('never polls sooner when the server supplies an interval above a local cap', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => { calls++; return json(tokens()) })
    const result = resultOf(completeNousDeviceAuthorization('registered-client', attempt({ intervalSeconds: 35 }), controller().signal))
    await vi.advanceTimersByTimeAsync(34_999)
    expect(calls).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect('value' in await result).toBe(true)
  })

  it('does not overflow native timers and poll early for a large server interval', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => { calls++; return json(tokens()) })
    const abort = controller()
    const result = resultOf(completeNousDeviceAuthorization('registered-client', attempt({
      intervalSeconds: 3_000_000,
      verification: { url: `${PORTAL}/device`, code: 'ABCD', expiresAt: NOW + 3_000_100_000 },
    }), abort.signal))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls).toBe(0)
    await vi.advanceTimersByTimeAsync(2_147_483_647)
    expect(calls).toBe(0)
    await vi.advanceTimersByTimeAsync(3_000_000_000 - 2_147_483_647 - 1_000)
    expect('value' in await result).toBe(true)
    expect(calls).toBe(1)
  })

  it('ends at the device deadline without an extra request', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => { calls++; return json({ error: 'authorization_pending' }, 400) })
    const result = resultOf(completeNousDeviceAuthorization('registered-client', attempt({
      verification: { url: `${PORTAL}/device`, code: 'ABCD', expiresAt: NOW + 12_000 },
    }), controller().signal))
    await vi.advanceTimersByTimeAsync(12_000)
    expect(calls).toBe(2)
    expect(await result).toMatchObject({ error: { code: 'expired_token', reauthenticate: true } })
  })

  it('cancels a pending wait immediately without exposing the abort reason', async () => {
    const network = vi.fn()
    vi.stubGlobal('fetch', network)
    const abort = controller()
    const result = resultOf(completeNousDeviceAuthorization('registered-client', attempt(), abort.signal))
    abort.abort('refresh-secret-in-reason')
    expect(await result).toMatchObject({ error: { code: 'cancelled' } })
    expect(String((await result as { error: unknown }).error)).not.toContain('refresh-secret')
    expect(network).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries a transient device-poll gateway failure until approval', async () => {
    const responses = [new Response('<html>secret-token</html>', { status: 503 }), json(tokens())]
    vi.stubGlobal('fetch', async () => responses.shift()!)
    const result = resultOf(completeNousDeviceAuthorization('registered-client', attempt(), controller().signal))
    await vi.advanceTimersByTimeAsync(10_000)
    expect('value' in await result).toBe(true)
  })

  it('ends an explicitly denied device attempt with a sanitized error', async () => {
    vi.stubGlobal('fetch', async () => json({ error: 'access_denied', error_description: 'device-secret access-secret' }, 400))
    const result = resultOf(completeNousDeviceAuthorization('registered-client', attempt(), controller().signal))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await result).toMatchObject({ error: { code: 'access_denied', retryable: false } })
    expect(String((await result as { error: unknown }).error)).not.toContain('secret')
  })

  it('refreshes with the dedicated header and returns opaque bearer rotation under the original identity', async () => {
    let request: RequestInit | undefined
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      expect(url).toBe(`${PORTAL}/api/oauth/token`)
      request = init
      return json(tokens({ client_id: 'different-server-metadata', inference_base_url: WELCOME }))
    })
    expect(await refreshNousGrant(grant(), controller().signal)).toEqual({
      type: 'oauth', access: 'opaque-access', refresh: 'rotated-refresh', expires: NOW + 300_000,
      clientId: 'registered-client', scope: 'inference:invoke', inferenceBaseURL: WELCOME,
    })
    expect(new Headers(request?.headers).get('x-nous-refresh-token')).toBe('old-refresh')
    expect(new Headers(request?.headers).has('Authorization')).toBe(false)
    expect(new URLSearchParams(request?.body as URLSearchParams).toString()).toBe('grant_type=refresh_token&client_id=registered-client')
    expect(request?.redirect).toBe('error')
  })

  it('retains previous scope, refresh token and route when omitted by a successful refresh', async () => {
    vi.stubGlobal('fetch', async () => json(tokens({ refresh_token: undefined, scope: undefined, inference_base_url: undefined })))
    expect(await refreshNousGrant(grant({ inferenceBaseURL: WELCOME, scope: 'inference:invoke billing:manage' }), controller().signal)).toMatchObject({
      refresh: 'old-refresh', scope: 'inference:invoke billing:manage', inferenceBaseURL: WELCOME,
    })
  })

  it.each([
    { scope: 'billing:manage' }, { scope: '' },
    { inference_base_url: 'https://evil.example/v1' }, { inference_base_url: 'not a URL' },
    { scope: { invalid: true } }, { inference_base_url: { invalid: true } },
    { token_type: 'MAC' }, { token_type: { invalid: true } },
  ])('returns the rotated pair before rejecting unusable refresh metadata: %j', async (metadata) => {
    vi.stubGlobal('fetch', async () => json(tokens(metadata)))
    const rotated = await refreshNousGrant(grant(), controller().signal)
    expect(rotated).toMatchObject({ access: 'opaque-access', refresh: 'rotated-refresh', expires: NOW + 300_000, clientId: 'registered-client' })
    expect(() => validateNousGrant(rotated)).toThrow(NousProtocolError)
    if (typeof metadata.scope === 'string') expect(rotated.scope).toBe(metadata.scope)
    if (typeof metadata.inference_base_url === 'string') expect(rotated.inferenceBaseURL).toBe(metadata.inference_base_url)
  })

  it.each([
    [408, {}], [429, {}], [500, {}], [503, {}], [403, { 'x-vercel-mitigated': 'deny' }],
  ])('keeps refresh failures retryable for HTTP %s and edge challenges', async (status, headers) => {
    vi.stubGlobal('fetch', async () => new Response('private refresh-secret', { status, headers: headers as Record<string, string> }))
    const result = await resultOf(refreshNousGrant(grant(), controller().signal))
    expect(result).toMatchObject({ error: { retryable: true, reauthenticate: false } })
    expect(String((result as { error: unknown }).error)).not.toContain('refresh-secret')
  })

  it.each(['invalid_grant', 'invalid_token', 'refresh_token_reused'])('marks explicit dead refresh grant %s for sign-in', async (code) => {
    vi.stubGlobal('fetch', async () => json({ error: code, error_description: 'private-token' }, 400))
    await expect(refreshNousGrant(grant(), controller().signal)).rejects.toMatchObject({ code, retryable: false, reauthenticate: true })
  })

  it('sanitizes an unrecognized OAuth error rather than reflecting arbitrary server text', async () => {
    vi.stubGlobal('fetch', async () => json({ error: 'token-embedded-in-code', error_description: 'refresh-secret' }, 400))
    const result = await resultOf(refreshNousGrant(grant(), controller().signal))
    expect(result).toMatchObject({ error: { code: 'request_failed' } })
    expect(String((result as { error: unknown }).error)).not.toMatch(/token-embedded|refresh-secret/)
  })

  it('sanitizes a failed network request', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('request headers contained old-refresh') })
    const result = await resultOf(refreshNousGrant(grant(), controller().signal))
    expect(result).toMatchObject({ error: { code: 'network_error', retryable: true, reauthenticate: false } })
    expect(String((result as { error: unknown }).error)).not.toContain('old-refresh')
  })

  it('cancels an active refresh request without reflecting its private reason', async () => {
    const abort = controller()
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const reason: unknown = signal.reason
          reject(reason instanceof Error ? reason : new Error('Request aborted'))
        }, { once: true })
      })
    })
    const result = resultOf(refreshNousGrant(grant(), abort.signal))
    abort.abort(new Error('old-refresh'))
    expect(await result).toMatchObject({ error: { code: 'cancelled', retryable: false, reauthenticate: false } })
    expect(String((await result as { error: unknown }).error)).not.toContain('old-refresh')
  })

  it('does not send an already cancelled request', async () => {
    const abort = controller()
    abort.abort('private-abort')
    const network = vi.fn()
    vi.stubGlobal('fetch', network)
    await expect(readNousModels('access', PAID, abort.signal)).rejects.toMatchObject({ code: 'cancelled' })
    expect(network).not.toHaveBeenCalled()
  })

  it('limits each request to twenty seconds', async () => {
    let requestSignal: AbortSignal | undefined
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const timeout = controller()
      setTimeout(() => { timeout.abort(new DOMException('Timed out', 'TimeoutError')) }, milliseconds)
      return timeout.signal
    })
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      requestSignal = init.signal as AbortSignal
      return await new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => {
          const reason: unknown = requestSignal?.reason
          reject(reason instanceof Error ? reason : new Error('Request aborted'))
        }, { once: true })
      })
    })
    const result = resultOf(refreshNousGrant(grant(), controller().signal))
    expect(requestSignal).toBeDefined()
    expect(requestSignal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(19_999)
    expect(requestSignal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(requestSignal?.aborted).toBe(true)
    expect(await result).toMatchObject({ error: { code: 'request_timeout', retryable: true } })
  })

  it('does not accept a response body received after the device expiry deadline', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const timeout = controller()
      setTimeout(() => { timeout.abort(new DOMException('Timed out', 'TimeoutError')) }, milliseconds)
      return timeout.signal
    })
    vi.stubGlobal('fetch', async () => ({
      ok: true, status: 200, headers: new Headers(),
      json: async () => await new Promise((resolve) => { setTimeout(() => { resolve(tokens()) }, 1_500) }),
    }))
    const result = resultOf(completeNousDeviceAuthorization('registered-client', attempt({
      verification: { url: `${PORTAL}/device`, code: 'ABCD', expiresAt: NOW + 6_000 },
    }), controller().signal))
    await vi.advanceTimersByTimeAsync(6_500)
    expect(await result).toMatchObject({ error: { code: 'expired_token' } })
  })

  it.each([
    { access_token: '' }, { refresh_token: '' }, { access_token: 'opaque-☃' }, { refresh_token: 'opaque-☃' }, { token_type: 'MAC' }, { expires_in: -1 },
    { expires_in: '300' }, { scope: 'billing:manage' }, { scope: '' },
  ])('rejects malformed initial token payloads: %j', async (fields) => {
    vi.stubGlobal('fetch', async () => json(tokens(fields)))
    const result = resultOf(completeNousDeviceAuthorization('registered-client', attempt(), controller().signal))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await result).toMatchObject({ error: { code: 'invalid_response' } })
  })

  it.each([
    'http://inference-api.nousresearch.com/v1', 'https://evil.example/v1',
    'https://inference-api.nousresearch.com.evil.example/v1',
    'https://user:pass@inference-api.nousresearch.com/v1',
    'https://inference-api.nousresearch.com:444/v1', 'https://inference-api.nousresearch.com/v1?token=secret',
    'https://inference-api.nousresearch.com/v1#secret', 'https://inference-api.nousresearch.com/v2',
    'https://inference-api.nousresearch.com/v1?', 'https://inference-api.nousresearch.com/v1#',
    'https://@inference-api.nousresearch.com/v1', 'https://inference-api.nousresearch.com/other/../v1',
  ])('rejects an untrusted inference route before a bearer can be sent: %s', async (baseURL) => {
    let calls = 0
    vi.stubGlobal('fetch', async () => { calls++; return json({ data: [] }) })
    await expect(readNousModels('access-secret', baseURL, controller().signal)).rejects.toMatchObject({ code: 'invalid_inference_url' })
    expect(calls).toBe(0)
    expect(() => validateNousGrant(grant({ inferenceBaseURL: baseURL }))).toThrow(NousProtocolError)
  })

  it('validates stored wire grants without accepting malformed fields', () => {
    expect(validateNousGrant(grant({ clientId: ' registered-client ', inferenceBaseURL: `${WELCOME}/` }))).toEqual(grant({ inferenceBaseURL: WELCOME }))
    for (const fields of [{ type: 'api_key' }, { access: ' ' }, { refresh: '' }, { expires: NaN }, { expires: 0 }, { clientId: '' }, { scope: '' }, { scope: 'billing:manage' }]) {
      expect(() => validateNousGrant({ ...grant(), ...fields })).toThrow(NousProtocolError)
    }
    expect(() => validateNousGrant(null)).toThrow(NousProtocolError)
    expect(() => validateNousGrant([])).toThrow(NousProtocolError)
  })

  it.each([{ access: 'opaque-☃' }, { refresh: 'opaque-☃' }, { expires: 0 }, { scope: 'billing:manage' }])('marks malformed stored grants for sign-in: %j', (fields) => {
    let failure: unknown
    try { validateNousGrant({ ...grant(), ...fields }) } catch (error) { failure = error }
    expect(failure).toMatchObject({ reauthenticate: true, retryable: false })
  })

  it('rejects a non-ASCII bearer before attempting a model request', async () => {
    const network = vi.fn()
    vi.stubGlobal('fetch', network)
    await expect(readNousModels('opaque-☃', PAID, controller().signal)).rejects.toMatchObject({ code: 'invalid_response' })
    expect(network).not.toHaveBeenCalled()
  })

  it.each([{ access_token: 'opaque-☃' }, { refresh_token: 'opaque-☃' }])('rejects malformed non-ASCII token rotation: %j', async (fields) => {
    vi.stubGlobal('fetch', async () => json(tokens(fields)))
    await expect(refreshNousGrant(grant(), controller().signal)).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('inherits only the requested scope when an initial token response omits scope', async () => {
    vi.stubGlobal('fetch', async () => json(tokens({ scope: undefined, inference_base_url: undefined })))
    const result = resultOf(completeNousDeviceAuthorization('registered-client', attempt(), controller().signal))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await result).toMatchObject({ value: { scope: 'inference:invoke', inferenceBaseURL: PAID } })
  })

  it('retains additional granted scope without requesting billing privilege', async () => {
    vi.stubGlobal('fetch', async () => json(tokens({ scope: 'inference:invoke billing:manage' })))
    expect((await refreshNousGrant(grant(), controller().signal)).scope).toBe('inference:invoke billing:manage')
  })

  it('never exposes a reasoning-off choice for a mandatory reasoning model', async () => {
    vi.stubGlobal('fetch', async () => json({ data: [{ id: 'mandatory', reasoning: { mandatory: true, supported_efforts: ['none', 'high'] } }] }))
    expect(await readNousModels('access', PAID, controller().signal)).toEqual([
      { id: 'mandatory', name: 'mandatory', reasoning: true, reasoningMandatory: true, reasoningEfforts: { high: 'high' } },
    ])
  })

  it('maps only catalog-declared model capabilities without invented reasoning efforts', async () => {
    let request: { url: string; init: RequestInit } | undefined
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      request = { url, init }
      return json({ data: [
        { id: 'reasoner', name: 'Reasoner', context_length: 200_000, top_provider: { max_completion_tokens: 32_000 },
          architecture: { input_modalities: ['text', 'image', 'audio'] },
          supported_parameters: ['reasoning', 'tools'], reasoning: { mandatory: true, supported_efforts: ['low', 'high', 'ultra'] } },
        { id: 'plain', name: 'Plain', supported_parameters: ['tools'], context_length: -1 },
        { id: 'reasoning-no-efforts', supported_parameters: ['reasoning'] },
        { id: 'optional-reasoner', reasoning: { mandatory: false, supported_efforts: ['none', 'minimal', 'medium', 'max'] } },
        { id: '', name: 'Invalid' }, null,
      ] })
    })
    expect(await readNousModels('access-secret', `${WELCOME}/`, controller().signal)).toEqual([
      { id: 'reasoner', name: 'Reasoner', contextWindow: 200_000, maxTokens: 32_000, inputModalities: ['text', 'image'],
        reasoning: true, reasoningMandatory: true, reasoningEfforts: { low: 'low', high: 'high' } },
      { id: 'plain', name: 'Plain', reasoning: false },
      { id: 'reasoning-no-efforts', name: 'reasoning-no-efforts', reasoning: true },
      { id: 'optional-reasoner', name: 'optional-reasoner', reasoning: true, reasoningMandatory: false,
        reasoningEfforts: { off: 'none', minimal: 'minimal', medium: 'medium', max: 'max' } },
    ])
    expect(request?.url).toBe(`${WELCOME}/models`)
    expect(new Headers(request?.init.headers).get('Authorization')).toBe('Bearer access-secret')
    expect(request?.init.redirect).toBe('error')
  })

  it('rejects a malformed model catalog instead of treating it as availability', async () => {
    vi.stubGlobal('fetch', async () => json({ models: ['fabricated'] }))
    await expect(readNousModels('access', PAID, controller().signal)).rejects.toMatchObject({ code: 'invalid_response' })
  })
})
