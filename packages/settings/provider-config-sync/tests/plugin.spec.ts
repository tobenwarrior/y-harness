import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { fixture } from './loader-fixture.ts'

it('leaves unconfigured sharing effect-free and preserves a deliberately disabled adapter', async () => {
  const unconfigured = await fixture('unconfigured')
  expect(await unconfigured.ctx.providerConfigSync.synchronize()).toMatchObject({ state: 'unconfigured' })
  expect(readFileSync(unconfigured.profile.patchPath, 'utf8')).not.toContain('YH_SYNC_UNCONFIGURED')
  const shared = join(unconfigured.home, 'shared.json')
  const disabled = await fixture('disabled', shared, {}, true)
  expect(await disabled.ctx.providerConfigSync.synchronize()).toMatchObject({ state: 'pending' })
  expect(existsSync(shared)).toBe(false)
  expect(disabled.ctx.configEditor.entries().find(entry => entry.options.id === 'llm-pi-ai')?.options.disabled).toBe(true)
})

it('imports automatically after activation inside a real HMR configuration transaction', async () => {
  const a = await fixture('main-hmr', undefined, { example: { displayName: 'Initial' } })
  const shared = join(a.home, 'shared.json')
  const enable = async (ctx: typeof a.ctx) => {
    const entry = ctx.configEditor.entries().find(entry => entry.options.id === 'provider-config-sync')
    await ctx.configEditor.edit(entry as NonNullable<typeof entry>, () => ({ sharedPath: shared }))
  }
  await enable(a.ctx)
  await a.ctx.providerConfigSync.synchronize()
  const b = await fixture('test-hmr', undefined, {}, false, true)
  await enable(b.ctx)
  await vi.waitFor(() =>{  expect(b.values()?.providers?.example).toMatchObject({ displayName: 'Initial' }) })
  expect(b.ctx.providerConfigSync.status().state).toBe('ready')
})

it('cancels a queued configuration write without waiting on its enclosing HMR transaction', async () => {
  const a = await fixture('cancel-hmr', undefined, { example: { displayName: 'Original' } }, false, true)
  const entered = Promise.withResolvers<undefined>(); const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const held = a.ctx.hmr.runExclusive(async () => { entered.resolve(undefined); await release.promise })
  await entered.promise
  const abort = new AbortController()
  const entry = a.ctx.configEditor.entries().find(entry => entry.options.id === 'llm-pi-ai')
  const write = a.ctx.configEditor.edit(entry as NonNullable<typeof entry>, () => ({ providers: { example: { displayName: 'Cancelled' } } }), abort.signal)
  abort.abort(new Error('fixture cancelled'))
  try { await expect(write).rejects.toThrow('fixture cancelled') } finally { release.resolve(undefined) }
  await held; await a.ctx.hmr.runExclusive(async () => {})
  expect(a.values()?.providers?.example).toMatchObject({ displayName: 'Original' })
})

it('disposes a sync owner inside HMR while its imported write is queued, without a late mutation', async () => {
  const a = await fixture('main-dispose', undefined, { example: { displayName: 'Original' } })
  const shared = join(a.home, 'shared.json')
  const sourceEntry = a.ctx.configEditor.entries().find(entry => entry.options.id === 'provider-config-sync')
  await a.ctx.configEditor.edit(sourceEntry as NonNullable<typeof sourceEntry>, () => ({ sharedPath: shared }))
  await a.ctx.providerConfigSync.synchronize()
  const b = await fixture('test-dispose', shared, {}, false, true)
  await b.ctx.providerConfigSync.synchronize()
  const before = readFileSync(b.profile.patchPath, 'utf8')
  await b.ctx.hmr.runExclusive(async () => {
    await a.ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'example', 'displayName'], value: 'Queued' }])
    await a.ctx.providerConfigSync.synchronize()
    await vi.waitFor(() =>{  expect(existsSync(`${shared}.lock`)).toBe(true) })
    const entry = b.ctx.configEditor.entries().find(entry => entry.options.id === 'provider-config-sync')
    await entry?.fiber?.dispose()
  })
  await b.ctx.hmr.runExclusive(async () => {})
  expect(readFileSync(b.profile.patchPath, 'utf8')).toBe(before)
  expect(existsSync(`${shared}.lock`)).toBe(false)
  expect(b.ctx.get('providerConfigSync')).toBeUndefined()
})

it('keeps local profiles through hot disable and resumes missed ordinary changes after remount', async () => {
  const a = await fixture('main-remount', undefined, { example: { displayName: 'Original' } })
  const shared = join(a.home, 'shared.json')
  const configure = async (ctx: typeof a.ctx, config: Record<string, unknown>) => {
    const entry = ctx.configEditor.entries().find(entry => entry.options.id === 'provider-config-sync')
    await ctx.configEditor.edit(entry as NonNullable<typeof entry>, () => config)
  }
  await configure(a.ctx, { sharedPath: shared }); await a.ctx.providerConfigSync.synchronize()
  const b = await fixture('test-remount', shared, {}, false, true); await b.ctx.providerConfigSync.synchronize()
  await configure(b.ctx, {})
  expect(b.ctx.providerConfigSync.status().state).toBe('unconfigured')
  await a.ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'example', 'displayName'], value: 'During pause' }])
  await a.ctx.providerConfigSync.synchronize()
  expect(b.values()?.providers?.example).toMatchObject({ displayName: 'Original' })
  await configure(b.ctx, { sharedPath: shared })
  await vi.waitFor(() =>{  expect(b.values()?.providers?.example).toMatchObject({ displayName: 'During pause' }) })
  expect(b.ctx.providerConfigSync.status().state).toBe('ready')
})

it('cancels its own import when preflight reconciliation observes an externally disabled sync owner', async () => {
  const a = await fixture('external-disable-main', undefined, { example: { displayName: 'Original' } })
  const shared = join(a.home, 'shared.json')
  const entry = a.ctx.configEditor.entries().find(entry => entry.options.id === 'provider-config-sync')
  await a.ctx.configEditor.edit(entry as NonNullable<typeof entry>, () => ({ sharedPath: shared }))
  await a.ctx.providerConfigSync.synchronize()
  const b = await fixture('external-disable-test', shared, {}, false, true); await b.ctx.providerConfigSync.synchronize()
  let disabledPatch = ''
  await b.ctx.hmr.runExclusive(async () => {
    await a.ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'example', 'displayName'], value: 'Queued' }]); await a.ctx.providerConfigSync.synchronize()
    await vi.waitFor(() =>{  expect(existsSync(`${shared}.lock`)).toBe(true) })
    disabledPatch = readFileSync(b.profile.patchPath, 'utf8') + '\n- id: provider-config-sync\n  disabled: true\n'
    writeFileSync(b.profile.patchPath, disabledPatch)
  })
  await b.ctx.hmr.runExclusive(async () => {})
  expect(readFileSync(b.profile.patchPath, 'utf8')).toBe(disabledPatch)
  expect(b.values()?.providers?.example).toMatchObject({ displayName: 'Original' })
  expect(b.ctx.get('providerConfigSync')).toBeUndefined()
  expect(existsSync(`${shared}.lock`)).toBe(false)
})

it('reconciles real profile writes, follows remote changes, and stops synchronization on disposal', async () => {
  const a = await fixture('main', undefined, { example: { displayName: 'Initial', apiKeyEnv: 'FABRICATED_MAIN_REF', headers: { Authorization: 'fabricated' } } })
  const shared = join(a.home, 'shared.json')
  const entry = a.ctx.configEditor.entries().find(entry => entry.options.id === 'provider-config-sync')
  expect(entry).toBeDefined()
  await a.ctx.configEditor.edit(entry as NonNullable<typeof entry>, () => ({ sharedPath: shared }))
  // Ordinary (nonvolatile) sharing activation remounts the plugin through Loader.
  await vi.waitFor(async () => { expect((await a.ctx.providerConfigSync.synchronize()).state).toBe('ready') })
  const b = await fixture('test', shared)
  await b.ctx.providerConfigSync.synchronize()
  expect(b.values()?.providers?.example).toMatchObject({ displayName: 'Initial' })
  expect(b.values()?.providers?.example).toHaveProperty('apiKeyEnv', expect.stringMatching(/^YH_SYNC_UNCONFIGURED_/))
  expect(readFileSync(b.profile.patchPath, 'utf8')).not.toMatch(/FABRICATED_MAIN_REF|Authorization|fabricated/)
  await a.ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'example', 'displayName'], value: 'Updated' }])
  await vi.waitFor(() =>{  expect(b.values()?.providers?.example).toMatchObject({ displayName: 'Updated' }) })
  await b.ctx.fiber.dispose()
  const before = readFileSync(b.profile.patchPath, 'utf8')
  await a.ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'example', 'displayName'], value: 'After disposal' }])
  await a.ctx.providerConfigSync.synchronize()
  expect(readFileSync(b.profile.patchPath, 'utf8')).toBe(before)
})
