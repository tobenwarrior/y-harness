/** Optional Nous namespace resolution and cancellation of device-status polling. */
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { createModelsOperations } from '../src/client/operations.ts'
import type { ModelsOperations } from '../src/client/operations.ts'

class Remote extends Service {
  constructor(ctx: Context) { super(ctx, 'remote') }
}
const contexts: Context[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function operationsWith(namespace?: object): Promise<ModelsOperations> {
  const ctx = new Context(); contexts.push(ctx); new Remote(ctx)
  if (namespace !== undefined) await ctx.plugin({ apply: (provider) => { provider.provide('remote.nous', namespace) } }).await()
  let operations: ModelsOperations | undefined
  await ctx.plugin({ inject: ['remote'], apply: (plugin) => { operations = createModelsOperations(plugin) } }).await()
  if (operations === undefined) throw new Error('Operations did not mount')
  return operations
}

it('keeps the Models page usable without the optional Nous namespace', async () => {
  expect((await operationsWith()).nous).toBeUndefined()
})

it('forwards explicit consent and returns only display-safe device instructions', async () => {
  const verification = { url: 'https://portal.nousresearch.com/device', code: 'ABCD', expiresAt: 1_000 }
  const start = vi.fn(async (_consent: boolean) => ({ ok: true as const, value: verification }))
  const operations = await operationsWith({ start })
  await expect(operations.nous?.start(true)).resolves.toEqual(verification)
  expect(start).toHaveBeenCalledWith(true)
})

it('polls the native connection until its durable sign-in has settled', async () => {
  vi.useFakeTimers()
  const getState = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: { configured: true, connected: false, busy: true } })
    .mockResolvedValueOnce({ ok: true, value: { configured: true, connected: true, busy: false } })
  const operations = await operationsWith({ getState })
  const done = operations.nous?.finish(new AbortController().signal)
  await vi.advanceTimersByTimeAsync(1_000)
  await expect(done).resolves.toEqual({ configured: true, connected: true, busy: false })
  expect(getState).toHaveBeenCalledTimes(2)
})

it('stops polling when the card leaves without issuing later remote reads', async () => {
  vi.useFakeTimers()
  const getState = vi.fn(async () => ({ ok: true as const, value: { configured: true, connected: false, busy: true } }))
  const operations = await operationsWith({ getState })
  const controller = new AbortController()
  const done = operations.nous?.finish(controller.signal)
  const rejection = expect(done).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(0)
  controller.abort()
  await rejection
  await vi.advanceTimersByTimeAsync(5_000)
  expect(getState).toHaveBeenCalledOnce()
})

it('unwraps a refusal from the Nous namespace', async () => {
  const operations = await operationsWith({ models: async () => ({ ok: false, error: { message: 'Sign in again.' } }) })
  await expect(operations.nous?.models()).rejects.toThrow('Sign in again.')
})
