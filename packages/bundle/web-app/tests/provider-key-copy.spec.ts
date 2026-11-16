import { credentialKey, credentialRef } from '@yharness/credentials'
import type { CredentialProvider } from '@yharness/credentials'
import { describe, expect, it, vi } from 'vitest'
import { ProviderKeyTransfer, providerKeyImportRoute } from '../src/provider-key-copy.ts'

const CLOUD_REF = 'YH_SYNC_UNCONFIGURED_0123456789ABCDEF0123456789ABCDEF'
const MAC_REF = 'FIXTURE_PROVIDER_KEY'
const endpoint = 'https://example.com/v1'
const example = { api: 'openai-completions', baseURL: endpoint, models: [{ id: 'example' }] }
const secret = 'test-provider-fixture'
const adapter = 'llm-pi-ai'

function fixture(providers: Record<string, unknown> = {}) {
  const current = { revision: 4, value: { providers } }
  const credentials = {
    describe: vi.fn<CredentialProvider['describe']>().mockResolvedValue({ configured: false, writable: true }),
    describeRecord: vi.fn<CredentialProvider['describeRecord']>().mockResolvedValue({ configured: false, writable: true }),
    resolve: vi.fn<CredentialProvider['resolve']>().mockResolvedValue(undefined),
    readRecord: vi.fn<CredentialProvider['readRecord']>().mockResolvedValue(undefined),
    setIfAbsent: vi.fn<NonNullable<CredentialProvider['setIfAbsent']>>().mockResolvedValue(true),
  }
  return { current, credentials, transfer: new ProviderKeyTransfer(() => current, credentials) }
}

describe('copying a saved provider key between private workspaces', () => {
  it('matches the actual endpoints and reads the stored Mac key after the preview', async () => {
    const mac = fixture({ 'model-lab': { ...example, apiKeyEnv: MAC_REF } })
    mac.credentials.describe.mockResolvedValue({ configured: true, source: 'file', writable: true })
    mac.credentials.resolve.mockResolvedValue({ value: secret, source: 'file' })
    const cloud = fixture({ 'model-lab': { ...example, apiKeyEnv: CLOUD_REF } })
    const [route] = await mac.transfer.offer()
    const claim = await cloud.transfer.prepare(route!)
    expect(claim).toMatch(/^[a-f0-9]{64}$/u)
    expect(mac.credentials.resolve).not.toHaveBeenCalled()
    const key = await mac.transfer.readKey(route!)
    expect(mac.credentials.resolve).toHaveBeenCalledWith(credentialRef(MAC_REF))
    expect(await cloud.transfer.receive(route!, claim!, key!)).toBe(true)
    expect(cloud.credentials.setIfAbsent).toHaveBeenCalledWith(credentialRef(CLOUD_REF), secret)
  })

  it('checks the endpoint, current settings revision and destination credentials before saving', async () => {
    const mac = fixture({ 'model-lab': { ...example, apiKeyEnv: MAC_REF } })
    mac.credentials.describe.mockResolvedValue({ configured: true, source: 'file', writable: true })
    mac.credentials.resolve.mockResolvedValue({ value: secret, source: 'file' })
    const cloud = fixture({ 'model-lab': { ...example, apiKeyEnv: CLOUD_REF } })
    const [route] = await mac.transfer.offer()
    const claim = await cloud.transfer.prepare(route!)
    cloud.current.revision++
    expect(await cloud.transfer.receive(route!, claim!, secret)).toBe(false)
    cloud.current.value.providers['model-lab'] = { ...example, baseURL: 'https://example.org/v1', apiKeyEnv: CLOUD_REF }
    expect(await cloud.transfer.prepare(route!)).toBeUndefined()
    cloud.current.value.providers['model-lab'] = { ...example, apiKeyEnv: CLOUD_REF }
    cloud.credentials.describe.mockResolvedValue({ configured: true, source: 'file', writable: true })
    expect(await cloud.transfer.prepare(route!)).toBeUndefined()
    expect(cloud.credentials.setIfAbsent).not.toHaveBeenCalled()
  })

  it('requires a new approval if the Mac route was reassigned to another key', async () => {
    const mac = fixture({ 'model-lab': { ...example, apiKeyEnv: MAC_REF } })
    mac.credentials.describe.mockResolvedValue({ configured: true, source: 'file', writable: true })
    mac.credentials.resolve.mockResolvedValue({ value: secret, source: 'file' })
    const [offer] = await mac.transfer.offer()
    mac.current.value.providers['model-lab'] = { ...example, apiKeyEnv: 'FIXTURE_OTHER_KEY' }
    mac.current.revision++
    expect(await mac.transfer.readKey(offer!)).toBeUndefined()
    expect(mac.credentials.resolve).not.toHaveBeenCalled()
  })

  it('offers a simple stored API key but excludes sign-ins and inherited values', async () => {
    const mac = fixture({
      'model-lab': example,
      'account-login': example,
      'shell-config': { ...example, apiKeyEnv: MAC_REF },
    })
    mac.credentials.describe.mockResolvedValue({ configured: true, source: 'env', writable: false })
    mac.credentials.readRecord.mockImplementation(async record => record === credentialKey(adapter, 'model-lab')
      ? { kind: 'api-key', key: secret } : { kind: 'grant', payload: { token: 'fixture-token' } })
    const routes = await mac.transfer.offer()
    expect(routes.map(route => route.provider)).toEqual(['model-lab'])
    expect(await mac.transfer.readKey(routes[0]!)).toBe(secret)
  })

  it('does not expose a key from the Cloud endpoint and forbids requests to read one', async () => {
    const cloud = fixture({ 'model-lab': { ...example, apiKeyEnv: CLOUD_REF } })
    const route = providerKeyImportRoute(cloud.transfer)
    const reply = await route.fetch(new Request('http://127.0.0.1' + route.path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'read', provider: 'model-lab' }),
    }))
    expect(reply.status).toBe(400)
    expect(cloud.credentials.resolve).not.toHaveBeenCalled()
    expect(cloud.credentials.readRecord).not.toHaveBeenCalled()
  })
})
