/** Display-safe native callbacks and cancellation races at the Remote join. */
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
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})
async function mount(nous: object, codexBackend?: object): Promise<ModelsOperations> {
  const ctx = new Context(); contexts.push(ctx); new Remote(ctx)
  await ctx.plugin({ apply: (provider) => {
    provider.provide('remote.nous', nous)
    if (codexBackend !== undefined) provider.provide('remote.codexBackend', codexBackend)
  } }).await()
  let result: ModelsOperations | undefined
  await ctx.plugin({ inject: ['remote'], apply: (plugin) => { result = createModelsOperations(plugin) } }).await()
  if (result === undefined) throw new Error('Models operations did not mount')
  return result
}
const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value })

it('returns Nous state and lets the account owner cancel and disconnect explicitly', async () => {
  let state = { configured: true, connected: true, busy: true }
  const operations = await mount({
    getState: async () => ok(state),
    cancel: async () => { state = { ...state, busy: false }; return ok(undefined) },
    disconnect: async () => { state = { ...state, connected: false }; return ok(undefined) },
  })
  expect(await operations.nous?.getState()).toEqual(state)
  await operations.nous?.cancel()
  expect(await operations.nous?.getState()).toEqual({ configured: true, connected: true, busy: false })
  await operations.nous?.disconnect()
  expect(await operations.nous?.getState()).toEqual({ configured: true, connected: false, busy: false })
})

it('routes native account state, catalog and explicit processing choices without rewriting them', async () => {
  let state = { connected: false, enabled: false, busy: false, running: 0, tiers: {} }
  const model = { id: 'gpt-6.1-sol', name: 'Sol', description: '', efforts: [{ id: 'ultra', description: '' }], defaultEffort: 'ultra', serviceTiers: [], inputModalities: ['text'] }
  const configured: Array<[boolean, string | undefined, string | undefined]> = []
  const consents: boolean[] = []
  const operations = await mount({}, {
    getState: async () => ok(state), models: async () => ok([model]),
    refresh: async () => { state = { ...state, connected: true }; return ok(state) },
    publish: async () => { state = { ...state, enabled: true }; return ok(state) },
    start: async (consent: boolean) => { consents.push(consent); state = { ...state, busy: true }; return ok({ verificationUrl: 'https://example.test/device', userCode: 'LOCAL-CODE' }) },
    cancel: async () => { state = { ...state, busy: false }; return ok(undefined) },
    configure: async (enabled: boolean, id: string | undefined, tier: string | undefined) => {
      configured.push([enabled, id, tier]); state = { ...state, enabled }; return ok(state)
    },
    disconnect: async () => { state = { ...state, connected: false, enabled: false }; return ok(state) },
  })
  const native = operations.codexBackend
  if (native === undefined) throw new Error('Native callbacks missing')
  expect(await native.getState()).toEqual(state)
  expect(await native.models()).toEqual([model])
  expect((await native.refresh()).connected).toBe(true)
  expect((await native.publish()).enabled).toBe(true)
  expect(await native.start(true)).toEqual({ verificationUrl: 'https://example.test/device', userCode: 'LOCAL-CODE' })
  expect((await native.getState()).busy).toBe(true)
  await native.cancel()
  expect((await native.getState()).busy).toBe(false)
  expect((await native.configure(false, 'gpt-6.1-sol', 'default')).enabled).toBe(false)
  expect(configured).toEqual([[false, 'gpt-6.1-sol', 'default']])
  expect(consents).toEqual([true])
  expect(await native.disconnect()).toMatchObject({ connected: false, enabled: false })
})

it('settles cancellation that arrives while the polling wait registers its listener', async () => {
  vi.useFakeTimers()
  let reads = 0
  const operations = await mount({ getState: async () => { reads += 1; return ok({ configured: true, connected: false, busy: true }) } })
  const controller = new AbortController()
  const listen = controller.signal.addEventListener.bind(controller.signal)
  vi.spyOn(controller.signal, 'addEventListener').mockImplementation((...args) => {
    controller.abort('Card closed')
    listen(...args)
  })
  await expect(operations.nous?.finish(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(5_000)
  expect(reads).toBe(1)
  expect(vi.getTimerCount()).toBe(0)
})
