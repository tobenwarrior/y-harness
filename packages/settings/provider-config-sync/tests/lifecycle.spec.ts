import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { SettingsDescriptor } from '@deepseek-ai/dsh-settings'
import ProviderConfigSync from '../src/index.ts'

const backend = vi.hoisted(() => ({ watchers: [] as { emit(name: string, ...values: unknown[]): boolean }[] }))
vi.mock('chokidar', async () => {
  const { EventEmitter } = await import('node:events')
  class Watcher extends EventEmitter {
    async close() { this.removeAllListeners() }
  }
  return { watch: () => {
    const watcher = new Watcher()
    backend.watchers.push(watcher)
    return watcher
  } }
})

async function owner(user?: unknown) {
  const home = mkdtempSync(join(tmpdir(), 'provider-sync-lifecycle-'))
  const sharedPath = join(home, 'shared.json')
  const ctx = new Context()
  const descriptor = { ns: 'llm-pi-ai', schema: { type: 'fixture' }, revision: 0, user,
    value: {}, applies: 'live', autoGenerate: false } as SettingsDescriptor
  let describe = () => [descriptor]
  const settings: Pick<Context['settings'], 'describe' | 'mutate'> = { describe: () => describe(), mutate: async () => {} }
  ctx.provide('settings', settings as Context['settings'])
  ctx.provide('profileContext', { dir: home } as Context['profileContext'])
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  await ctx.plugin(ProviderConfigSync, { sharedPath })
  const service = ctx.providerConfigSync
  return { ctx, descriptor, service, sharedPath, setDescribe(value: () => SettingsDescriptor[]) { describe = value } }
}

it('accepts absent explicit settings, ignores unrelated namespaces, and returns detached status', async () => {
  const a = await owner()
  expect(await a.service.synchronize()).toMatchObject({ state: 'ready' })
  const before = readFileSync(a.sharedPath, 'utf8')
  a.ctx.emit('settings/document-updated', 'unrelated' as never, 1)
  const status = a.service.status(); status.conflicts.push('caller-only')
  expect(a.service.status().conflicts).toEqual([])
  expect(readFileSync(a.sharedPath, 'utf8')).toBe(before)
})

it.each([null, []])('reports invalid active settings without publishing configuration (%s)', async (invalid) => {
  const a = await owner(invalid)
  expect(await a.service.synchronize()).toMatchObject({ state: 'error' })
  expect(existsSync(a.sharedPath)).toBe(false)
})

it('reports a watcher failure without exposing its error payload and can retry', async () => {
  const a = await owner({ providers: {} }); await a.service.synchronize()
  const watcher = backend.watchers.at(-1)
  watcher?.emit('error', new Error('fabricated sensitive error excerpt'))
  expect(a.service.status()).toEqual({ state: 'error', conflicts: [] })
  expect(await a.service.synchronize()).toMatchObject({ state: 'ready' })
})

it('contains synchronous describe notifications and drains when disposal interrupts lock admission', async () => {
  const a = await owner({ providers: {} }); await a.service.synchronize()
  let sent = false
  a.setDescribe(() => {
    if (!sent) { sent = true; a.ctx.emit('settings/document-updated', 'llm-pi-ai' as never, 1) }
    return [a.descriptor]
  })
  expect(await a.service.synchronize()).toMatchObject({ state: 'ready' })
  let disposing: Promise<void> | undefined
  a.setDescribe(() => { disposing ??= a.ctx.fiber.dispose(); return [a.descriptor] })
  await a.service.synchronize(); await disposing
  const before = readFileSync(a.sharedPath, 'utf8')
  await a.service.synchronize()
  expect(readFileSync(a.sharedPath, 'utf8')).toBe(before)
  expect(a.ctx.get('providerConfigSync')).toBeUndefined()
})
