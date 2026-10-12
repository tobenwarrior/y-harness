import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { ProviderSyncEngine, type LocalNamespace } from '../src/engine.ts'

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'provider-sync-')); homes.push(home)
  const sharedPath = join(home, 'shared', 'providers.json')
  function client(name: string, initial: Record<string, unknown> = {}) {
    let local: LocalNamespace | undefined = { schema: { type: 'fixture', version: 1 }, revision: 0, providers: initial, inherited: {} }
    let writes = 0
    const engine = new ProviderSyncEngine({ sharedPath, receiptPath: join(home, `${name}.json`),
      read: () => local,
      mutate: async (ops, revision) => {
        if (local === undefined || local.revision !== revision) throw new Error('fixture stale revision')
        for (const op of ops) {
          const id = op.path[1] as string
          if (op.path.length === 2) {
            if (op.op === 'unset') Reflect.deleteProperty(local.providers, id)
            else local.providers[id] = structuredClone(op.value)
          } else {
            const profile = local.providers[id] as Record<string, unknown>
            if (op.op === 'unset') Reflect.deleteProperty(profile, op.path[2] as string)
            else profile[op.path[2] as string] = structuredClone(op.value)
          }
        }
        writes++; local.revision++
      },
    })
    return { engine, get local() { return local }, set local(value: LocalNamespace | undefined) { local = value },
      get writes() { return writes } }
  }
  return { client, sharedPath, home }
}

it('pairs ordinary catalogs with a target-owned missing credential reference and preserves existing access fields', async () => {
  const { client, sharedPath } = await fixture()
  const main = client('main', { example: { displayName: 'Example', models: [{ id: 'same', name: 'Same' }], apiKeyEnv: 'PRIVATE_MAIN_REF', headers: { Authorization: 'fabricated' } } })
  const test = client('test')
  await main.engine.synchronize(); await test.engine.synchronize()
  expect(test.local?.providers.example).toMatchObject({ displayName: 'Example' })
  expect(test.local?.providers.example).toHaveProperty('apiKeyEnv', expect.stringMatching(/^YH_SYNC_UNCONFIGURED_[A-F0-9]+$/))
  const shared = await readFile(sharedPath, 'utf8')
  expect(shared).not.toMatch(/PRIVATE_MAIN_REF|Authorization|fabricated|apiKeyEnv|headers/)
  ;(main.local?.providers.example as Record<string, unknown>).displayName = 'Renamed'
  await main.engine.synchronize(); await test.engine.synchronize()
  expect(test.local?.providers.example).toMatchObject({ displayName: 'Renamed' })
  expect(test.local?.providers.example).toHaveProperty('apiKeyEnv', expect.any(String))
  expect(main.local?.providers.example).toMatchObject({ apiKeyEnv: 'PRIVATE_MAIN_REF', headers: { Authorization: 'fabricated' } })
})

it('merges independent concurrent provider edits without losing either writer', async () => {
  const { client } = await fixture()
  const a = client('a', { first: { displayName: 'First' } }); const b = client('b', { second: { displayName: 'Second' } })
  await Promise.all([a.engine.synchronize(), b.engine.synchronize()]); await a.engine.synchronize(); await b.engine.synchronize()
  expect(Object.keys(a.local?.providers ?? {}).sort()).toEqual(['first', 'second'])
  expect(Object.keys(b.local?.providers ?? {}).sort()).toEqual(['first', 'second'])
})

it('retains both conflicting edits and lets explicit matching local repair resolve them', async () => {
  const { client } = await fixture(); const a = client('a', { example: { displayName: 'Initial' } }); const b = client('b')
  await a.engine.synchronize(); await b.engine.synchronize()
  ;(a.local?.providers.example as Record<string, unknown>).displayName = 'Main change'
  ;(b.local?.providers.example as Record<string, unknown>).displayName = 'Test change'
  await a.engine.synchronize()
  expect(await b.engine.synchronize()).toMatchObject({ state: 'conflict', conflicts: ['example'] })
  expect(b.local?.providers.example).toMatchObject({ displayName: 'Test change' })
  ;(b.local?.providers.example as Record<string, unknown>).displayName = 'Main change'
  expect(await b.engine.synchronize()).toMatchObject({ state: 'ready', conflicts: [] })
})

it('persists explicit deletion tombstones and does not resurrect stale profiles after restart', async () => {
  const { client, sharedPath } = await fixture(); const a = client('a', { example: { displayName: 'Initial' } }); const b = client('b')
  await a.engine.synchronize(); await b.engine.synchronize()
  // A locally authorized removal includes its local connection fields.
  delete a.local?.providers.example
  await a.engine.synchronize()
  const shared = JSON.parse(await readFile(sharedPath, 'utf8')) as { providers: Record<string, { value: unknown }> }
  expect(shared.providers.example?.value).toBeNull()
  // A target whose local connection fields would be discarded requires local confirmation.
  expect(await b.engine.synchronize()).toMatchObject({ state: 'conflict', conflicts: ['example'] })
  delete b.local?.providers.example
  expect(await b.engine.synchronize()).toMatchObject({ state: 'ready' })
  const restarted = client('b', {})
  expect(await restarted.engine.synchronize()).toMatchObject({ state: 'ready' })
  expect(restarted.local?.providers).toEqual({})
})

it('keeps same-route first-join disagreements and endpoint/auth changes for local resolution', async () => {
  const { client } = await fixture(); const a = client('a', { example: { baseURL: 'https://one.example.test/v1' } }); const b = client('b', { example: { baseURL: 'https://two.example.test/v1', apiKeyEnv: 'TEST_REF' } })
  await a.engine.synchronize()
  expect(await b.engine.synchronize()).toMatchObject({ state: 'conflict', conflicts: ['example'] })
  expect(b.local?.providers.example).toMatchObject({ baseURL: 'https://two.example.test/v1', apiKeyEnv: 'TEST_REF' })
})

it('blocks a remote endpoint change after pairing and retains model-local excluded fields', async () => {
  const { client } = await fixture(); const a = client('a', { example: { models: [{ id: 'one', name: 'One' }] } }); const b = client('b')
  await a.engine.synchronize(); await b.engine.synchronize()
  ;(a.local?.providers.example as Record<string, unknown>).baseURL = 'https://new.example.test/v1'
  await a.engine.synchronize()
  expect(await b.engine.synchronize()).toMatchObject({ state: 'conflict', conflicts: ['example'] })
  expect(b.local?.providers.example).not.toHaveProperty('baseURL')
})

it('does not replace a model list containing excluded local settings', async () => {
  const { client } = await fixture(); const a = client('a', { example: { models: [{ id: 'one', name: 'One' }] } }); const b = client('b')
  await a.engine.synchronize(); await b.engine.synchronize()
  const target = b.local?.providers.example as { models: Record<string, unknown>[] }
  if (target.models[0]) target.models[0].compat = { chatTemplateArgs: { token: 'fabricated-local' } }
  ;(a.local?.providers.example as Record<string, unknown>).models = [{ id: 'two', name: 'Two' }]
  await a.engine.synchronize()
  expect(await b.engine.synchronize()).toMatchObject({ state: 'conflict', conflicts: ['example'] })
  expect(target.models).toEqual([{ id: 'one', name: 'One', compat: { chatTemplateArgs: { token: 'fabricated-local' } } }])
})

it.each(['models', 'modelOverrides'])('keeps excluded nested %s settings when a tombstone arrives', async (field) => {
  const { client } = await fixture()
  const ordinary = field === 'models' ? [{ id: 'one', name: 'One' }] : { one: { name: 'One' } }
  const excluded = field === 'models' ? [{ id: 'one', name: 'One', compat: { token: 'fabricated-local' } }]
    : { one: { name: 'One', compat: { token: 'fabricated-local' } } }
  const a = client('a', { example: { [field]: ordinary } })
  const b = client('b', { example: { [field]: excluded } })
  await a.engine.synchronize(); await b.engine.synchronize()
  delete a.local?.providers.example; await a.engine.synchronize()
  expect(await b.engine.synchronize()).toMatchObject({ state: 'conflict', conflicts: ['example'] })
  expect(b.local?.providers.example).toEqual({ [field]: excluded })
})

it('does not treat inherited routes or absent shared keys as deletion', async () => {
  const { client, sharedPath } = await fixture(); const a = client('a', { example: { displayName: 'Initial' } }); const b = client('b')
  await a.engine.synchronize(); await b.engine.synchronize()
  if (b.local) b.local.inherited = { example: { displayName: 'Inherited' } }
  delete a.local?.providers.example; await a.engine.synchronize()
  expect(await b.engine.synchronize()).toMatchObject({ state: 'conflict', conflicts: ['example'] })
  const file = JSON.parse(await readFile(sharedPath, 'utf8')) as { providers: Record<string, unknown> }
  delete file.providers.example; await writeFile(sharedPath, JSON.stringify(file))
  await expect(b.engine.synchronize()).rejects.toThrow('Shared provider records were removed without tombstones')
})

it('replays a remote update safely from the persisted receipt after a restart', async () => {
  const { client } = await fixture(); const a = client('a', { example: { displayName: 'Initial' } }); const b = client('b')
  await a.engine.synchronize(); await b.engine.synchronize()
  const stale = structuredClone(b.local?.providers ?? {})
  ;(a.local?.providers.example as Record<string, unknown>).displayName = 'New'; await a.engine.synchronize()
  const restarted = client('b', stale)
  await restarted.engine.synchronize()
  expect(restarted.local?.providers.example).toMatchObject({ displayName: 'New' })
  const writes = restarted.writes
  await restarted.engine.synchronize(); await restarted.engine.synchronize()
  expect(restarted.writes).toBe(writes)
})

it('cannot import new OAuth-only Nous routes using an absent API key as protection', async () => {
  const { client } = await fixture(); const a = client('a', { nous: { models: [{ id: 'example' }] } }); const b = client('b')
  await a.engine.synchronize()
  expect(await b.engine.synchronize()).toMatchObject({ state: 'conflict', conflicts: ['nous'] })
  expect(b.local?.providers).toEqual({})
})

it('does not replace inherited provider configuration on first pairing', async () => {
  const { client } = await fixture(); const a = client('a', { example: { baseURL: 'https://shared.example.test/v1' } }); const b = client('b')
  if (b.local) b.local.inherited = { example: { baseURL: 'https://local.example.test/v1', headers: { Authorization: 'fabricated' }, defaultInput: ['text'] } }
  await a.engine.synchronize()
  expect(await b.engine.synchronize()).toMatchObject({ state: 'conflict', conflicts: ['example'] })
  expect(b.writes).toBe(0)
  expect(b.local?.providers).toEqual({})
})

it('refuses oversized valid catalogs before publishing or importing any fields', async () => {
  const { client, sharedPath } = await fixture(); const a = client('a', { example: { displayName: 'Small' } }); await a.engine.synchronize()
  const before = await readFile(sharedPath, 'utf8')
  ;(a.local?.providers.example as Record<string, unknown>).models = Array.from({ length: 4096 }, (_, i) => ({ id: `model-${i}`, name: 'N'.repeat(512) }))
  await expect(a.engine.synchronize()).rejects.toThrow('Provider synchronization file exceeds supported size')
  expect(await readFile(sharedPath, 'utf8')).toBe(before)
  expect(a.writes).toBe(0)
})

it('imports ordinary field removal and model overrides without touching target-local access', async () => {
  const { client } = await fixture(); const a = client('a', { example: { displayName: 'Original', modelOverrides: { model: { name: 'One' } } } }); const b = client('b')
  await a.engine.synchronize(); await b.engine.synchronize()
  delete (a.local?.providers.example as Record<string, unknown>).displayName
  ;(a.local?.providers.example as Record<string, unknown>).modelOverrides = { model: { name: 'Two' } }
  await a.engine.synchronize(); await b.engine.synchronize()
  expect(b.local?.providers.example).toMatchObject({ modelOverrides: { model: { name: 'Two' } } })
  expect(b.local?.providers.example).toHaveProperty('apiKeyEnv', expect.any(String))
  expect(b.local?.providers.example).not.toHaveProperty('displayName')
})

it('keeps excluded local override fields when a remote model override changes', async () => {
  const { client } = await fixture(); const a = client('a', { example: { modelOverrides: { model: { name: 'One' } } } }); const b = client('b')
  await a.engine.synchronize(); await b.engine.synchronize()
  ;(b.local?.providers.example as Record<string, unknown>).modelOverrides = { model: { name: 'One', compat: { token: 'fabricated' } } }
  ;(a.local?.providers.example as Record<string, unknown>).modelOverrides = { model: { name: 'Two' } }
  await a.engine.synchronize()
  expect(await b.engine.synchronize()).toMatchObject({ state: 'conflict', conflicts: ['example'] })
})

it('imports an ordinary-only deletion and retains its tombstone for an empty new participant', async () => {
  const { client } = await fixture(); const a = client('a', { example: { displayName: 'One' } }); const b = client('b', { example: { displayName: 'One' } })
  await a.engine.synchronize(); await b.engine.synchronize()
  delete a.local?.providers.example; await a.engine.synchronize(); await b.engine.synchronize()
  expect(b.local?.providers).toEqual({})
  const empty = client('empty')
  expect(await empty.engine.synchronize()).toMatchObject({ state: 'ready' })
  expect(empty.local?.providers).toEqual({})
})

it('rejects unsafe paths and identities before creating configuration documents', async () => {
  const { sharedPath, home, client } = await fixture()
  const capabilities = { read: () => undefined, mutate: async () => {} }
  expect(() => new ProviderSyncEngine({ ...capabilities, sharedPath: 'relative.json', receiptPath: join(home, 'receipt.json') })).toThrow('distinct absolute')
  expect(() => new ProviderSyncEngine({ ...capabilities, sharedPath, receiptPath: sharedPath })).toThrow('distinct absolute')
  const a = client('invalid', { 'invalid/route': {} })
  await expect(a.engine.synchronize()).rejects.toThrow('Unsupported local provider identity')
})

it('refuses removed shared files and schema-incompatible local receipts instead of recreating old data', async () => {
  const { client, sharedPath } = await fixture(); const a = client('a', { example: {} }); await a.engine.synchronize()
  if (a.local) a.local.schema = { type: 'different' }
  await expect(a.engine.synchronize()).rejects.toThrow('Provider configuration schemas do not match')
  if (a.local) a.local.schema = { type: 'fixture', version: 1 }
  await rm(sharedPath)
  await expect(a.engine.synchronize()).rejects.toThrow('Shared provider configuration is missing')
})

it('rejects unreadable hierarchy, non-file, oversized and non-owner-only synchronization documents', async () => {
  const { home, sharedPath, client } = await fixture(); const a = client('a', { example: {} }); await a.engine.synchronize()
  await rm(sharedPath); await mkdir(sharedPath)
  await expect(a.engine.synchronize()).rejects.toThrow('owner-only regular file')
  await rm(sharedPath, { recursive: true }); await writeFile(sharedPath, 'X'.repeat(1024 * 1024 + 1), { mode: 0o600 })
  await expect(a.engine.synchronize()).rejects.toThrow('owner-only regular file')
  if (process.platform !== 'win32') {
    await writeFile(sharedPath, '{}'); await chmod(sharedPath, 0o644)
    await expect(a.engine.synchronize()).rejects.toThrow('owner-only regular file')
  }
  await writeFile(join(home, 'notdir'), 'fixture')
  const bad = new ProviderSyncEngine({ sharedPath, receiptPath: join(home, 'notdir', 'receipt.json'), read: () => a.local, mutate: async () => {} })
  await expect(bad.synchronize()).rejects.toMatchObject({ code: 'ENOTDIR' })
})

it('takes the documented Windows permission-policy branch without changing the shared content', async () => {
  const { client } = await fixture(); const a = client('a', { example: {} }); await a.engine.synchronize()
  const original = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor
  try { Object.defineProperty(process, 'platform', { ...original, value: 'win32' }); expect(await a.engine.synchronize()).toMatchObject({ state: 'ready' }) }
  finally { Object.defineProperty(process, 'platform', original) }
})

it('does not advance a receipt after a rejected local revision or unconfirmed local apply', async () => {
  const { client, sharedPath, home } = await fixture(); const a = client('a', { example: { displayName: 'One' } }); await a.engine.synchronize()
  const local: LocalNamespace = { schema: { type: 'fixture', version: 1 }, revision: 1, providers: {}, inherited: {} }
  const receiptPath = join(home, 'rejected.json')
  const rejected = new ProviderSyncEngine({ sharedPath, receiptPath, read: () => local, mutate: async () => { throw new Error('fixture stale revision') } })
  await expect(rejected.synchronize()).rejects.toThrow('fixture stale revision')
  await expect(readFile(receiptPath)).rejects.toMatchObject({ code: 'ENOENT' })
  const unconfirmed = new ProviderSyncEngine({ sharedPath, receiptPath, read: () => local, mutate: async () => {} })
  expect(await unconfirmed.synchronize()).toMatchObject({ state: 'conflict', conflicts: ['example'] })
  local.providers = { example: { displayName: 'One' } }; await unconfirmed.synchronize()
  ;(a.local?.providers.example as Record<string, unknown>).displayName = 'Two'; await a.engine.synchronize()
  const receiptBefore = await readFile(receiptPath, 'utf8')
  expect(await unconfirmed.synchronize()).toMatchObject({ state: 'conflict', conflicts: ['example'] })
  expect(await readFile(receiptPath, 'utf8')).toBe(receiptBefore)
})

it('pauses when the active namespace disappears at lock admission or after local application', async () => {
  const { client, sharedPath, home } = await fixture(); const a = client('a', { example: {} }); await a.engine.synchronize()
  let local: LocalNamespace | undefined = { schema: { type: 'fixture', version: 1 }, revision: 0, providers: {}, inherited: {} }
  const admission = new ProviderSyncEngine({ sharedPath, receiptPath: join(home, 'admission.json'), read: vi.fn().mockImplementationOnce(() => local).mockImplementation(() => undefined), mutate: async () => {} })
  expect(await admission.synchronize()).toMatchObject({ state: 'pending' })
  const disappearing = new ProviderSyncEngine({ sharedPath, receiptPath: join(home, 'disappearing.json'), read: () => local, mutate: async () => { local = undefined } })
  expect(await disappearing.synchronize()).toMatchObject({ state: 'pending' })
})

it('leaves disabled namespaces pending and refuses schema/future/malformed documents without mutation', async () => {
  const { client, sharedPath } = await fixture(); const a = client('a', { example: {} }); await a.engine.synchronize()
  const b = client('b'); b.local = undefined
  expect(await b.engine.synchronize()).toMatchObject({ state: 'pending' }); expect(b.writes).toBe(0)
  const c = client('c'); if (c.local) c.local.schema = { type: 'new schema' }
  await expect(c.engine.synchronize()).rejects.toThrow('Provider configuration schemas do not match')
  expect(c.writes).toBe(0)
  await writeFile(sharedPath, '{"version":2}')
  await expect(a.engine.synchronize()).rejects.toThrow('Unsupported shared provider configuration')
  await writeFile(sharedPath, '{malformed')
  await expect(a.engine.synchronize()).rejects.toThrow('Unsupported shared provider configuration')
})
