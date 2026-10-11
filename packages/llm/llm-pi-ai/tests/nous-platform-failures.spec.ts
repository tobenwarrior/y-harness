import { afterEach, expect, it, vi } from 'vitest'
import { completeNousDeviceAuthorization } from '../src/nous-protocol.ts'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('does not retry a platform form-serialization failure or start HTTP polling', async () => {
  vi.useFakeTimers()
  const failure = new Error('Synthetic platform serializer failure')
  const OriginalURLSearchParams = URLSearchParams
  class UnavailableURLSearchParams extends OriginalURLSearchParams {
    constructor(...parameters: ConstructorParameters<typeof URLSearchParams>) {
      super(...parameters)
      throw failure
    }
  }
  const network = vi.fn<typeof fetch>()
  vi.stubGlobal('URLSearchParams', UnavailableURLSearchParams)
  vi.stubGlobal('fetch', network)
  const result = completeNousDeviceAuthorization('fixture-client', {
    deviceCode: 'fixture-device', intervalSeconds: 1,
    verification: { url: 'https://portal.nousresearch.com/device', code: 'FIXTURE', expiresAt: Date.now() + 10_000 },
  }, new AbortController().signal).catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(1000)
  expect(await result).toBe(failure)
  expect(network).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
