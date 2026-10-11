import { afterEach, describe, expect, it, vi } from 'vitest'
import { completeNousDeviceAuthorization, NousProtocolError, readNousModels, startNousDeviceAuthorization, validateNousGrant } from '../src/nous-protocol.ts'

const portal = 'https://portal.nousresearch.com'
const inference = 'https://inference-api.nousresearch.com/v1'
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('Nous request failure classification', () => {
  it.each([
    [200, 'invalid_response', false], [400, 'request_failed', false],
    [401, 'invalid_grant', true], [403, 'invalid_grant', true],
  ])('sanitizes a non-JSON response with HTTP %s', async (status, code, reauthenticate) => {
    vi.stubGlobal('fetch', async () => new Response('private fixture response', { status }))
    const error = await readNousModels('fixture-access', inference, new AbortController().signal).catch((failure: unknown) => failure)
    expect(error).toMatchObject({ code, reauthenticate })
    expect(String(error)).not.toContain('private fixture response')
  })

  it.each([null, [], { error: 42 }, { error: 'private-unknown-code' }])('classifies unrecognized JSON errors as dead grants on HTTP 401: %j', async (body) => {
    vi.stubGlobal('fetch', async () => json(body, 401))
    await expect(readNousModels('fixture-access', inference, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_grant', reauthenticate: true })
  })

  it('preserves a classified transport failure without exposing arbitrary network text', async () => {
    vi.stubGlobal('fetch', async () => { throw new NousProtocolError('upstream_blocked', true) })
    await expect(readNousModels('fixture-access', inference, new AbortController().signal)).rejects.toMatchObject({ code: 'upstream_blocked', retryable: true })
    expect(new NousProtocolError('unrecognized-private-code').message).toBe('The Nous request failed. Try again later.')
  })

  it('does not return a catalog cancelled while its response body is pending', async () => {
    const abort = new AbortController()
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => {
      abort.abort(new Error('Private fixture reason'))
      return { data: [] }
    } }))
    await expect(readNousModels('fixture-access', inference, abort.signal)).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('classifies cancellation when body decoding rejects after abort', async () => {
    const abort = new AbortController()
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401, headers: new Headers(), json: async () => {
      abort.abort(new Error('Private fixture reason'))
      throw new Error('Private decoding diagnostic')
    } }))
    await expect(readNousModels('fixture-access', inference, abort.signal)).rejects.toMatchObject({ code: 'cancelled', reauthenticate: false })
  })

  it.each([false, true])('classifies a body timeout before accepting or parsing data; decode rejects=%s', async (reject) => {
    vi.useFakeTimers()
    const timeout = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => {
      timeout.abort(new DOMException('Private timeout', 'TimeoutError'))
      if (reject) throw new Error('Private decoding diagnostic')
      return { data: [] }
    } }))
    await expect(readNousModels('fixture-access', inference, new AbortController().signal)).rejects.toMatchObject({ code: 'request_timeout', retryable: true })
  })

  it('rejects malformed verification and inference URL syntax before trusting a host', async () => {
    vi.stubGlobal('fetch', async () => json({ device_code: 'fixture-device', user_code: 'FIXTURE', interval: 5, expires_in: 60, verification_uri: '://invalid' }))
    await expect(startNousDeviceAuthorization('fixture-client', new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_response' })
    await expect(readNousModels('fixture-access', 'https://[invalid/v1', new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_inference_url' })
  })

  it('accepts an explicit Bearer stored grant and an omitted initial token type', async () => {
    const grant = { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: 1800000000000,
      clientId: 'fixture-client', scope: 'inference:invoke', inferenceBaseURL: inference, tokenType: 'Bearer' }
    expect(validateNousGrant(grant)).not.toHaveProperty('tokenType')
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async () => json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 300 }))
    const result = completeNousDeviceAuthorization('fixture-client', {
      deviceCode: 'fixture-device', intervalSeconds: 1,
      verification: { url: `${portal}/device`, code: 'FIXTURE', expiresAt: Date.now() + 10000 },
    }, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(result).resolves.toMatchObject({ type: 'oauth', scope: 'inference:invoke', inferenceBaseURL: inference })
  })

  it('rejects an already expired device attempt without scheduling a poll', async () => {
    vi.useFakeTimers()
    let networkCalls = 0
    vi.stubGlobal('fetch', async () => { networkCalls++; return json({}) })
    await expect(completeNousDeviceAuthorization('fixture-client', {
      deviceCode: 'fixture-device', intervalSeconds: 1,
      verification: { url: `${portal}/device`, code: 'FIXTURE', expiresAt: Date.now() - 1 },
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'expired_token', reauthenticate: true })
    expect(networkCalls).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores unsupported catalog modalities and keeps the advertised off alias', async () => {
    vi.stubGlobal('fetch', async () => json({ data: [
      { id: 'off-model', name: '', supported_parameters: ['reasoning_effort'], reasoning: { supported_efforts: ['off'] } },
      { id: 'plain', architecture: { input_modalities: ['audio'] } },
    ] }))
    expect(await readNousModels('fixture-access', inference, new AbortController().signal)).toEqual([
      { id: 'off-model', name: 'off-model', reasoning: true, reasoningEfforts: { off: 'off' } },
      { id: 'plain', name: 'plain', reasoning: false },
    ])
  })
})
