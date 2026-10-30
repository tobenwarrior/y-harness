import { readFileSync } from 'node:fs'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { fixture } from './loader-fixture.ts'

const hooks = vi.hoisted(() => ({ afterWrite: undefined as ((path: string) => Promise<void>) | undefined }))
vi.mock('@yharness/atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@yharness/atomic-write')>()
  return { ...actual, writeFileAtomic: async (...args: Parameters<typeof actual.writeFileAtomic>) => {
    await actual.writeFileAtomic(...args)
    await hooks.afterWrite?.(args[0])
  } }
})
afterEach(() => { hooks.afterWrite = undefined })

it('rejects cancellation before commit after started work drains without changing the profile', async () => {
  const a = await fixture('before-commit', undefined, { example: { displayName: 'Original' } })
  const before = readFileSync(a.profile.patchPath, 'utf8')
  const controller = new AbortController()
  const entry = a.ctx.configEditor.entries().find(entry => entry.options.id === 'llm-pi-ai')
  await expect(a.ctx.configEditor.edit(entry as NonNullable<typeof entry>, () => {
    controller.abort(new Error('fixture before commit'))
    return { providers: { example: { displayName: 'Cancelled' } } }
  }, controller.signal)).rejects.toThrow('fixture before commit')
  expect(readFileSync(a.profile.patchPath, 'utf8')).toBe(before)
  expect(a.values()?.providers?.example).toMatchObject({ displayName: 'Original' })
})

it('completes an already committed write and reconciliation when cancellation arrives afterward', async () => {
  const a = await fixture('after-commit', undefined, { example: { displayName: 'Original' } })
  const committed = Promise.withResolvers<undefined>(); const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  hooks.afterWrite = async (path) => { if (path === a.profile.patchPath) { committed.resolve(undefined); await release.promise } }
  const controller = new AbortController()
  const entry = a.ctx.configEditor.entries().find(entry => entry.options.id === 'llm-pi-ai')
  const writing = a.ctx.configEditor.edit(entry as NonNullable<typeof entry>, () => ({ providers: { example: { displayName: 'Committed' } } }), controller.signal)
  let settled = false
  void writing.then(() => { settled = true }, () => { settled = true })
  await committed.promise
  controller.abort(new Error('fixture after commit'))
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(readFileSync(a.profile.patchPath, 'utf8')).toContain('Committed')
  release.resolve(undefined); await writing
  expect(a.values()?.providers?.example).toMatchObject({ displayName: 'Committed' })
})

it('refuses an already cancelled owner before starting a profile mutation', async () => {
  const a = await fixture('already-aborted', undefined, { example: {} })
  const controller = new AbortController(); controller.abort(new Error('already cancelled'))
  const before = readFileSync(a.profile.patchPath, 'utf8')
  const entry = a.ctx.configEditor.entries().find(entry => entry.options.id === 'llm-pi-ai')
  await expect(a.ctx.configEditor.edit(entry as NonNullable<typeof entry>, () => ({}), controller.signal)).rejects.toThrow('already cancelled')
  expect(readFileSync(a.profile.patchPath, 'utf8')).toBe(before)
})

it('settles cancellation arriving during listener registration and drains the queued editor without a write', async () => {
  const a = await fixture('registration-gap', undefined, { example: { displayName: 'Original' } }, false, true)
  const before = readFileSync(a.profile.patchPath, 'utf8')
  const entered = Promise.withResolvers<undefined>(); const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const held = a.ctx.hmr.runExclusive(async () => { entered.resolve(undefined); await release.promise })
  await entered.promise
  const controller = new AbortController()
  const add = controller.signal.addEventListener.bind(controller.signal)
  const registering = vi.spyOn(controller.signal, 'addEventListener').mockImplementation((...args) => {
    controller.abort(new Error('fixture registration cancellation'))
    add(...args)
  })
  const entry = a.ctx.configEditor.entries().find(entry => entry.options.id === 'llm-pi-ai')
  const change = vi.fn(() => ({ providers: { example: { displayName: 'Cancelled' } } }))
  try {
    await expect(a.ctx.configEditor.edit(entry as NonNullable<typeof entry>, change, controller.signal))
      .rejects.toThrow('fixture registration cancellation')
  } finally { registering.mockRestore(); release.resolve(undefined) }
  await held; await a.ctx.hmr.runExclusive(async () => {})
  expect(change).not.toHaveBeenCalled()
  expect(readFileSync(a.profile.patchPath, 'utf8')).toBe(before)
  expect(a.values()?.providers?.example).toMatchObject({ displayName: 'Original' })
})
