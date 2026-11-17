import { describe, expect, it, vi } from 'vitest'
import { providerKeyImportRequest } from '@yharness/provider-config-sync'
import type { ProviderKeySourceRequest } from '@yharness/provider-config-sync'
import { prepareCloudProviderKeyCopy } from '../src/cloud-provider-keys.ts'

const available = { provider: 'sample-provider', identity: '1'.repeat(64) }
const occupied = { provider: 'occupied-provider', identity: '2'.repeat(64) }
const availableOffer = { ...available, sourceClaim: 'a'.repeat(64) }
const occupiedOffer = { ...occupied, sourceClaim: 'b'.repeat(64) }
const claim = '3'.repeat(64)
const key = 'provider-key-fixture'

function requestBody(options: RequestInit) {
  if (typeof options.body !== 'string') throw new Error('Expected a JSON request body')
  const value: unknown = JSON.parse(options.body)
  return providerKeyImportRequest.parse(value)
}

function fixture() {
  const source = vi.fn(async (request: ProviderKeySourceRequest): Promise<unknown> => request.action === 'offer' ? [availableOffer, occupiedOffer] : key)
  const origin = 'http://127.0.0.1:12346'
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    expect(new URL(url).origin).toBe(origin)
    expect(options.redirect).toBe('error')
    expect(options.credentials).toBe('include')
    const request = requestBody(options)
    return request.action === 'prepare'
      ? Response.json({ claim: request.route.provider === available.provider ? claim : null })
      : Response.json({ copied: request.claim === claim })
  })
  return { source, cloud: { origin, fetch } }
}

describe('native copy of saved provider keys', () => {
  it('previews only eligible providers, then reads and relays each approved key once', async () => {
    const { source, cloud } = fixture()
    const copy = await prepareCloudProviderKeyCopy(source, cloud)
    expect(copy.providers).toEqual([available.provider])
    expect(source.mock.calls).toEqual([[{ action: 'offer' }]])
    expect(JSON.stringify(cloud.fetch.mock.calls.map(([, options]) => requestBody(options)))).not.toContain(key)
    expect(await copy.apply()).toEqual({ copied: 1, skipped: 0 })
    expect(source.mock.calls).toEqual([[{ action: 'offer' }], [{ action: 'read', offer: availableOffer }]])
    expect(requestBody(cloud.fetch.mock.calls[2]![1])).toEqual({
      action: 'receive', route: available, claim, key,
    })
    await expect(copy.apply()).rejects.toThrow()
    expect(cloud.fetch).toHaveBeenCalledTimes(3)
  })

  it('does not ask the source for keys when Cloud does not support import', async () => {
    const { source, cloud } = fixture()
    cloud.fetch.mockResolvedValue(new Response(null, { status: 404 }))
    await expect(prepareCloudProviderKeyCopy(source, cloud)).rejects.toThrow()
    expect(source.mock.calls).toEqual([[{ action: 'offer' }]])
  })

  it('reports a revoked or changed source key as skipped', async () => {
    const { source, cloud } = fixture()
    const copy = await prepareCloudProviderKeyCopy(source, cloud)
    source.mockResolvedValue(null)
    expect(await copy.apply()).toEqual({ copied: 0, skipped: 1 })
    expect(cloud.fetch).toHaveBeenCalledTimes(2)
  })
})
