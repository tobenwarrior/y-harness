import { describe, expect, it, vi } from 'vitest'
import { prepareCloudProviderCatalogCopy } from '../src/cloud-provider-catalog.ts'
import type { VaultCloudWorkspace } from '../src/cloud-vault.ts'

function settings(providers: Record<string, unknown>) {
  return { writable: true, namespaces: [{
    ns: 'llm-pi-ai', revision: 5, schema: { type: 'dict' }, user: { providers }, value: { providers },
  }] }
}

function bodyText(options: RequestInit): string {
  if (typeof options.body !== 'string') throw new Error('Expected a JSON request body')
  return options.body
}

function peer(port: number, providers: Record<string, unknown>, accepted = true) {
  const origin = `http://127.0.0.1:${port}`
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    expect(new URL(url).origin).toBe(origin)
    expect(options.redirect).toBe('error')
    expect(options.credentials).toBe('include')
    const data: unknown = JSON.parse(bodyText(options))
    if (typeof data !== 'object' || data === null || !('method' in data) || typeof data.method !== 'string'
      || !('rpcId' in data) || typeof data.rpcId !== 'string') throw new Error('Expected a settings request')
    expect(new URL(url).pathname).toBe('/api/' + data.method)
    const result = data.method === 'settings/describe'
      ? { ok: true, value: settings(providers) } : { ok: accepted, value: {} }
    return Response.json({ type: 'server-response', rpcId: data.rpcId, result })
  })
  return { origin, fetch }
}

describe('Mac-to-Cloud model catalog copy', () => {
  it('previews additions and retains Cloud settings until the owner applies', async () => {
    const mac = peer(12345, {
      'example-models': { baseURL: 'https://example.com/v1', apiKeyEnv: 'MAC_KEY', headers: { secret: 'fixture-private' } },
      'already-on-cloud': { displayName: 'Mac choice' },
    })
    const cloud = peer(12346, { 'already-on-cloud': { displayName: 'Cloud choice', apiKeyEnv: 'CLOUD_KEY' } })
    const copy = await prepareCloudProviderCatalogCopy(mac, cloud)
    expect(copy.additions).toBe(1)
    expect(copy.retained).toBe(1)
    expect(cloud.fetch).toHaveBeenCalledTimes(1)
    await copy.apply()
    expect(mac.fetch).toHaveBeenCalledTimes(1)
    const body = bodyText(cloud.fetch.mock.calls[1]![1])
    expect(body).not.toMatch(/MAC_KEY|CLOUD_KEY|fixture-private|already-on-cloud/u)
    const unconfiguredKey: unknown = expect.stringMatching(/^YH_SYNC_UNCONFIGURED_/u)
    expect(JSON.parse(body)).toMatchObject({
      method: 'settings/mutate', payload: { args: { ns: 'llm-pi-ai', expectedRevision: 5,
        ops: [{ op: 'set', path: ['providers', 'example-models'], value: {
          baseURL: 'https://example.com/v1', apiKeyEnv: unconfiguredKey,
        } }],
      } },
    })
  })

  it('keeps the preview revision and surfaces a Cloud conflict without retrying', async () => {
    const mac = peer(12345, { 'example-models': { baseURL: 'https://example.com/v1' } })
    const cloud = peer(12346, {}, false)
    const copy = await prepareCloudProviderCatalogCopy(mac, cloud)
    await expect(copy.apply()).rejects.toThrow('Provider settings are unavailable')
    expect(cloud.fetch).toHaveBeenCalledTimes(2)
  })

  it('never writes when there are no additions', async () => {
    const mac = peer(12345, {})
    const cloud = peer(12346, {})
    const copy = await prepareCloudProviderCatalogCopy(mac, cloud)
    await copy.apply()
    expect(cloud.fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects destinations outside the app loopback connection or pointing to the Mac', async () => {
    const mac = peer(12345, {})
    for (const origin of [mac.origin, 'https://example.com', 'http://localhost:8080', mac.origin + '/?token=fixture']) {
      const cloud: VaultCloudWorkspace = { origin, fetch: vi.fn() }
      await expect(prepareCloudProviderCatalogCopy(mac, cloud)).rejects.toThrow()
      expect(cloud.fetch).not.toHaveBeenCalled()
    }
  })
})
