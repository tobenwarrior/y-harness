import { EventEmitter } from 'node:events'
import { credentialKey, credentialRef } from '@yharness/credentials'
import type { CredentialProvider } from '@yharness/credentials'
import { describe, expect, it, vi } from 'vitest'
import { ProviderKeyTransfer, mountProviderKeyCopy, providerKeyImportRoute } from '../src/provider-key-copy.ts'
import type { ProviderKeyRoute } from '@yharness/provider-config-sync'
import type { Context } from '@yharness/cordis'

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
  return {
    current,
    credentials,
    transfer: new ProviderKeyTransfer(
      () => ({ revision: current.revision, value: current.value }),
      credentials,
    ),
  }
}

function desktopFixture(connected: boolean) {
  const events = new EventEmitter<{ message: [unknown] }>()
  const ipc = {
    connected,
    platform: 'darwin' as const,
    send: vi.fn((_message: object, callback: () => void) => callback()),
    on: events.on.bind(events),
    off: events.off.bind(events),
  }
  let dispose: (() => void) | undefined
  const effect = vi.fn((factory: () => () => void) => {
    dispose = factory()
    return dispose
  })
  const scope = {
    settings: { describe: () => [] }, credentials: fixture().credentials,
    connection: { fetch: { register: vi.fn(() => () => {}) } }, effect,
  }
  const context = {
    get: () => ({ name: 'desktop' }), webServer: { host: '127.0.0.1' },
    inject: (_keys: readonly string[], callback: (value: never) => void) => {
      callback(scope as never)
    },
  } as never as Context
  return { context, events, ipc, effect, dispose: () => dispose?.() }
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

  it('handles absent settings, missing source values, and invalid provider routes', async () => {
    const emptyCredentials = fixture().credentials
    const absent = new ProviderKeyTransfer(() => undefined, emptyCredentials)
    const route: ProviderKeyRoute = { provider: 'model-lab', identity: '0'.repeat(64) }
    await expect(absent.offer()).resolves.toEqual([])
    await expect(absent.readKey({ ...route, sourceClaim: '0'.repeat(64) })).resolves.toBeUndefined()
    await expect(absent.prepare(route)).resolves.toBeUndefined()
    await expect(absent.receive(route, 'claim', 'key')).resolves.toBe(false)

    const invalid = fixture({
      malformed: null,
      nested: { providers: null },
      nous: example,
      chatgpt: example,
      'bad provider': example,
      unknown: {},
      noModels: { ...example, models: [] },
      malformedUrl: { ...example, baseURL: 'https://[::1' },
      insecureUrl: { ...example, baseURL: 'http://example.com/v1' },
    })
    await expect(invalid.transfer.offer()).resolves.toEqual([])

    const insecure = fixture({ 'insecure-url': { ...example, baseURL: 'http://example.com/v1' } })
    await expect(insecure.transfer.offer()).resolves.toEqual([])
    const throwing = fixture({ throwing: { ...example, baseURL: {} } })
    await expect(throwing.transfer.offer()).resolves.toEqual([])

    const noProviders = new ProviderKeyTransfer(() => ({ revision: 1, value: { providers: null } }), invalid.credentials)
    await expect(noProviders.offer()).resolves.toEqual([])

    const noKey = fixture({ 'model-lab': example })
    await expect(noKey.transfer.offer()).resolves.toEqual([])
    noKey.credentials.readRecord.mockResolvedValueOnce({ kind: 'api-key', key: '' })
    const [candidate] = await noKey.transfer.offer()
    expect(candidate).toBeUndefined()
  })

  it('rejects invalid source records and rechecks the source revision after reading', async () => {
    const h = fixture({ 'model-lab': { ...example, apiKeyEnv: MAC_REF } })
    h.credentials.describe.mockResolvedValue({ configured: true, source: 'file', writable: true })
    h.credentials.resolve.mockResolvedValue({ value: 'bad\nkey', source: 'file' })
    const [route] = await h.transfer.offer()
    expect(await h.transfer.readKey(route!)).toBeUndefined()

    h.credentials.resolve.mockResolvedValue({ value: secret, source: 'env' })
    expect(await h.transfer.readKey(route!)).toBeUndefined()

    h.credentials.resolve.mockResolvedValue({ value: secret, source: 'file' })
    h.current.revision++
    expect(await h.transfer.readKey(route!)).toBeUndefined()
    expect(h.credentials.resolve).toHaveBeenCalled()

    h.current.revision++
    h.credentials.resolve.mockImplementationOnce(async () => {
      h.current.revision++
      return { value: secret, source: 'file' }
    })
    const [stableRoute] = await h.transfer.offer()
    expect(await h.transfer.readKey(stableRoute!)).toBeUndefined()

    const inherited = fixture({ 'model-lab': example })
    inherited.credentials.readRecord.mockResolvedValue({ kind: 'api-key', key: secret, env: { FIXTURE_ENV: 'fixture' } })
    expect(await inherited.transfer.offer()).toEqual([])
    inherited.credentials.readRecord.mockResolvedValue({ kind: 'grant', payload: { token: 'fixture-token' } })
    expect(await inherited.transfer.offer()).toEqual([])
  })

  it('keeps destination claims bound to an empty, unreferenced Cloud route', async () => {
    const source = fixture({ 'model-lab': { ...example, apiKeyEnv: CLOUD_REF } })
    const mac = fixture({ 'model-lab': { ...example, apiKeyEnv: MAC_REF } })
    mac.credentials.describe.mockResolvedValue({ configured: true, source: 'file', writable: true })
    mac.credentials.readRecord.mockResolvedValue({ kind: 'api-key', key: secret })
    const [binding] = await mac.transfer.offer()
    expect(binding).toBeDefined()
    source.current.value.providers['model-lab'] = example
    expect(await source.transfer.prepare(binding!)).toBeUndefined()

    source.current.value.providers['model-lab'] = { ...example, apiKeyEnv: CLOUD_REF }
    const route = binding!
    expect(await source.transfer.prepare(route)).toMatch(/^[a-f0-9]{64}$/u)
    expect(await source.transfer.prepare({ ...route, identity: 'f'.repeat(64) })).toBeUndefined()
    source.current.value.providers['other'] = { ...example, apiKeyEnv: CLOUD_REF }
    expect(await source.transfer.prepare(route)).toBeUndefined()

    delete source.current.value.providers.other
    source.credentials.describe.mockResolvedValue({ configured: false, writable: false })
    expect(await source.transfer.prepare(route)).toBeUndefined()
    source.credentials.describe.mockResolvedValue({ configured: true, writable: true })
    expect(await source.transfer.prepare(route)).toBeUndefined()
    source.credentials.describe.mockResolvedValue({ configured: false, writable: true })
    source.credentials.describeRecord.mockResolvedValue({ configured: true, writable: true })
    expect(await source.transfer.prepare(route)).toBeUndefined()
    source.credentials.describeRecord.mockResolvedValue({ configured: false, writable: true })
    source.credentials.describe.mockImplementationOnce(async () => {
      source.current.revision++
      return { configured: false, writable: true }
    })
    expect(await source.transfer.prepare(route)).toBeUndefined()
  })

  it('handles the write-only import route status and transfer failures', async () => {
    const h = fixture({ 'model-lab': { ...example, apiKeyEnv: CLOUD_REF } })
    const route = providerKeyImportRoute(h.transfer)
    const validRoute: ProviderKeyRoute = { provider: 'model-lab', identity: 'a'.repeat(64) }
    const url = 'http://127.0.0.1' + route.path
    await expect(route.fetch(new Request(url))).resolves.toMatchObject({ status: 415 })
    await expect(route.fetch(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(64 * 1024 + 1) }))).resolves.toMatchObject({ status: 413 })
    await expect(route.fetch(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }))).resolves.toMatchObject({ status: 400 })
    await expect(route.fetch(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'other' }) }))).resolves.toMatchObject({ status: 400 })

    const prepare = vi.spyOn(h.transfer, 'prepare')
    prepare.mockResolvedValueOnce('b'.repeat(64))
    const prepared = await route.fetch(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'prepare', route: validRoute }) }))
    expect(prepared.status).toBe(200)
    expect(await prepared.json()).toEqual({ claim: 'b'.repeat(64) })
    prepare.mockResolvedValueOnce(undefined)
    const empty = await route.fetch(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'prepare', route: validRoute }) }))
    expect(await empty.json()).toEqual({ claim: null })

    const controller = new AbortController()
    controller.abort()
    const aborted = await route.fetch(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'receive', route: validRoute, claim: 'b'.repeat(64), key: secret }), signal: controller.signal }))
    expect(aborted.status).toBe(409)
    const receive = vi.spyOn(h.transfer, 'receive')
    receive.mockResolvedValueOnce(true)
    const received = await route.fetch(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'receive', route: validRoute, claim: 'b'.repeat(64), key: secret }) }))
    expect(await received.json()).toEqual({ copied: true })
    receive.mockRejectedValueOnce(new Error('fixture failure'))
    const failed = await route.fetch(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'receive', route: validRoute, claim: 'b'.repeat(64), key: secret }) }))
    expect(failed.status).toBe(503)
  })

  it('rejects a received key before consulting the destination', async () => {
    const h = fixture({ 'model-lab': { ...example, apiKeyEnv: CLOUD_REF } })
    const route: ProviderKeyRoute = { provider: 'model-lab', identity: 'a'.repeat(64) }
    expect(await h.transfer.receive(route, 'claim', '')).toBe(false)
    expect(h.credentials.describe).not.toHaveBeenCalled()
  })

  it('mounts only on loopback Web profiles and registers the Cloud route', async () => {
    const registered: unknown[] = []
    const register = vi.fn((route: unknown) => { registered.push(route); return () => {} })
    const effect = vi.fn((factory: () => () => void) => factory())
    const inject = vi.fn((_keys: readonly string[], callback: (scope: never) => void) => {
      callback({
        settings: { describe: () => [{ ns: 'other' }, { ns: 'llm-pi-ai', revision: 1, value: { providers: {} } }] }, credentials: fixture().credentials,
        connection: { fetch: { register } }, effect,
      } as never)
    })
    const context = {
      get: () => ({ name: 'web' }), webServer: { host: '127.0.0.1' }, inject,
    } as never as Context
    mountProviderKeyCopy(context)
    expect(inject).toHaveBeenCalledExactlyOnceWith(['settings', 'credentials', 'connection'], expect.any(Function))
    expect(register).toHaveBeenCalledOnce()
    expect(effect).toHaveBeenCalledOnce()
    const registeredRoute = registered[0] as { fetch(request: Request): Promise<Response> }
    await registeredRoute.fetch(new Request('http://127.0.0.1/api/provider-key-import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'prepare', route: { provider: 'model-lab', identity: 'a'.repeat(64) } }),
    }))

    const rejectedInject = vi.fn()
    const rejected = { get: () => ({ name: 'web' }), webServer: { host: '0.0.0.0' }, inject: rejectedInject } as never as Context
    mountProviderKeyCopy(rejected)
    expect(rejectedInject).not.toHaveBeenCalled()
    const nonProfile = { get: () => ({ name: 'headless' }), webServer: { host: '127.0.0.1' }, inject: rejectedInject } as never as Context
    mountProviderKeyCopy(nonProfile)
    expect(rejectedInject).not.toHaveBeenCalled()
  })

  it('serves the private Desktop channel and removes its listener on disposal', async () => {
    const desktop = desktopFixture(true)
    const { context, events, ipc } = desktop
    mountProviderKeyCopy(context, ipc)
    try {
      expect(events.listenerCount('message')).toBe(1)
      events.emit('message', {})
      events.emit('message', { type: 'provider-key-copy', requestId: 1.5, command: { action: 'offer' } })
      events.emit('message', { type: 'provider-key-copy', requestId: 1, command: { action: 'offer' } })
      events.emit('message', { type: 'provider-key-copy', requestId: 2, command: { action: 'read', offer: { provider: 'model-lab' } } })
      events.emit('message', { type: 'provider-key-copy', requestId: 3, command: { action: 'read', offer: { provider: 'model-lab', identity: 'a'.repeat(64), sourceClaim: 'b'.repeat(64) } } })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(ipc.send.mock.calls.map(([message]) => message)).toEqual(expect.arrayContaining([
        { type: 'provider-key-copy', requestId: 1, value: [] },
        { type: 'provider-key-copy', requestId: 2, error: 'Could not prepare the saved provider connection.' },
        { type: 'provider-key-copy', requestId: 3, value: null },
      ]))
      expect(ipc.send).toHaveBeenCalledTimes(3)

      ipc.connected = false
      events.emit('message', { type: 'provider-key-copy', requestId: 4, command: { action: 'offer' } })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(ipc.send).toHaveBeenCalledTimes(3)

      ipc.connected = true
      ipc.send.mockImplementationOnce(() => { throw new Error('fixture send failure') })
      events.emit('message', { type: 'provider-key-copy', requestId: 5, command: { action: 'invalid' } })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(ipc.send).toHaveBeenCalledTimes(4)
    } finally {
      desktop.dispose()
    }
    expect(events.listenerCount('message')).toBe(0)
  })

  it('leaves the Desktop listener idle while its channel is disconnected', () => {
    const { context, events, ipc, effect } = desktopFixture(false)
    mountProviderKeyCopy(context, ipc)
    expect(effect).not.toHaveBeenCalled()
    expect(events.listenerCount('message')).toBe(0)
  })
})
