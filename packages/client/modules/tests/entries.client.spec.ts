// @vitest-environment jsdom
import { Context, FiberState } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as provideModules, createClientModuleSystem } from '../src/client/index.ts'
import type { ClientBundleRegistration, ClientModuleLoaderTarget, WebBootEntry, WebBootGraph } from '../src/client/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose()
    await ctx.fiber.await()
  }
  document.head.querySelectorAll('style').forEach((el) => { el.remove() })
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

const row = (id: string, rev = 'r0', extra: Partial<WebBootEntry> = {}): WebBootEntry => ({
  id, rev, url: `/plugins/??${id}/client.js&rev=${rev}`, ...extra,
})
const graph = (...entries: WebBootEntry[]): WebBootGraph => ({
  rev: JSON.stringify(entries), entries,
  batches: entries.length === 0 ? [] : [{ phase: 'application', url: '/batch', rev: 'batch', entries: entries.map(row => row.id) }],
})
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

async function bench(initial: WebBootGraph, factories: Record<string, ClientBundleRegistration['factory']>, start = true) {
  const ctx = new Context()
  contexts.push(ctx)
  const fetched: string[] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue', pendingQueue: [], load: () => {},
    create: options => createClientModuleSystem(target, { id: 'bootstrap', exports: { inject: ['loader'], apply: provideModules } }, options),
  }
  let arrival: (url: string) => Promise<void> = async () => {}
  const modules = target.create({
    boot: initial, staticModules: {},
    loadBundle: async (url) => {
      fetched.push(url)
      const ids = url === '/batch' ? initial.entries.map(row => row.id).filter(id => id !== 'bootstrap') : [url.split('??')[1]!.split('/client.js')[0]!]
      const registrations = ids.map(id => ({ id, factory: factories[id]! }))
      await arrival(url)
      for (const registration of registrations) target.load(registration)
    },
  })
  await ctx.plugin(Loader)
  ctx.loader.internal = modules as never
  if (start) await modules.entries.start(ctx.loader, modules.manifest)
  return { ctx, modules, fetched, target, arrival: (fn: typeof arrival) => { arrival = fn } }
}

/** A visible plugin whose style and listener are owned by its factory and fiber respectively. */
function visible(id: string, effects: { mounted: number; disposed: number; hits: number }, cleanup?: () => Promise<void>) {
  return () => {
    const style = document.createElement('style')
    style.dataset.plugin = id
    style.textContent = `[data-live="${id}"] { color: rgb(12, 34, 56); }`
    document.head.append(style)
    return { apply(ctx: Context) {
      ctx.effect(() => {
        effects.mounted++
        const el = document.createElement('div')
        el.dataset.live = id
        document.body.append(el)
        const listener = () => { effects.hits++ }
        window.addEventListener('live-test', listener)
        return async () => {
          window.removeEventListener('live-test', listener)
          el.remove()
          await cleanup?.()
          effects.disposed++
        }
      })
    } }
  }
}

describe('client manifest entries', () => {
  it('adds, drains removal and re-enables one instance with styles; unrelated entries survive', async () => {
    const effects = { mounted: 0, disposed: 0, hits: 0 }
    const cleanup = deferred()
    const b = await bench(graph(), { pet: visible('pet', effects, () => cleanup.promise) })
    b.target.load({ id: 'local', factory: () => ({ apply() {} }) })
    const localId = await b.ctx.loader.create({ name: 'local' })
    await b.modules.entries.sync(graph(row('pet')))
    expect(b.fetched).toEqual([row('pet').url])
    expect(document.querySelectorAll('[data-live=pet]')).toHaveLength(1)
    expect(document.querySelectorAll('style[data-plugin=pet]')).toHaveLength(1)
    window.dispatchEvent(new Event('live-test'))
    expect(effects.hits).toBe(1)
    const removing = b.modules.entries.sync(graph())
    await vi.waitFor(() => { expect(document.querySelector('[data-live=pet]')).toBeNull() })
    const readding = b.modules.entries.sync(graph(row('pet')))
    expect(effects.disposed).toBe(0)
    expect(effects.mounted).toBe(1)
    cleanup.resolve()
    await Promise.all([removing, readding])
    expect(effects).toEqual({ mounted: 2, disposed: 1, hits: 1 })
    expect(document.querySelectorAll('style[data-plugin=pet]')).toHaveLength(1)
    expect(b.ctx.loader.resolve(localId).fiber?.state).toBe(2)
    await b.modules.entries.sync(graph())
    window.dispatchEvent(new Event('live-test'))
    expect(effects).toEqual({ mounted: 2, disposed: 2, hits: 1 })
    expect(document.querySelectorAll('style[data-plugin=pet]')).toHaveLength(0)
    expect(b.modules.loadCache.has('pet')).toBe(false)
    expect(b.modules.entries.state.getSnapshot()).toEqual({ syncing: false, failures: [] })
  })

  it('does not mount an obsolete download and can load it again later', async () => {
    const effects = { mounted: 0, disposed: 0, hits: 0 }
    const b = await bench(graph(), { pet: visible('pet', effects) })
    const arrival = deferred()
    const started = deferred()
    b.arrival(async () => { started.resolve(); await arrival.promise })
    const enabling = b.modules.entries.sync(graph(row('pet')))
    await started.promise
    const disabling = b.modules.entries.sync(graph())
    arrival.resolve()
    await Promise.all([enabling, disabling])
    expect(effects.mounted).toBe(0)
    expect(b.modules.loadCache.has('pet')).toBe(false)
    await b.modules.entries.sync(graph(row('pet')))
    expect(effects.mounted).toBe(1)
    expect(b.fetched).toEqual([row('pet').url, row('pet').url])
  })

  it('registers dynamic dependencies first and retains one still required by an unmanaged entry', async () => {
    const materialized = vi.fn<(id: string) => void>()
    const b = await bench(graph(row('existing')), {
      existing: () => { materialized('existing'); return { apply() {} } },
      dependency: () => { materialized('dependency'); return { apply() {}, value: 42 } },
      consumer: (require) => {
        materialized('consumer')
        expect(require('dependency/client')).toHaveProperty('value', 42)
        return { apply() {} }
      },
    })
    await b.modules.entries.sync(graph(row('existing'), row('consumer', 'r0', { external: ['dependency/client'] }), row('dependency')))
    expect(b.fetched.slice(1)).toEqual([row('dependency').url, row('consumer').url])
    expect(materialized.mock.calls.map(([id]) => id)).toEqual(['existing', 'consumer', 'dependency'])
    b.target.load({ id: 'local', factory: require => ({ apply() {}, dep: require('dependency/client') }) })
    const localId = await b.ctx.loader.create({ name: 'local' })
    await b.modules.entries.sync(graph(row('existing')))
    expect(b.modules.loadCache.has('consumer')).toBe(false)
    expect(b.modules.loadCache.has('dependency')).toBe(true)
    b.ctx.loader.remove(localId)
    await b.modules.entries.retry()
    expect(b.modules.loadCache.has('dependency')).toBe(false)
    expect(materialized.mock.calls.filter(([id]) => id === 'existing')).toHaveLength(1)
  })

  it('diagnoses download and apply failures, retries an identical graph and leaves healthy plugins running', async () => {
    const effects = { mounted: 0, disposed: 0, hits: 0 }
    let broken = true
    const b = await bench(graph(row('healthy')), {
      healthy: visible('healthy', effects),
      bad: () => ({ apply() { if (broken) throw new Error('apply unavailable') } }),
    })
    b.arrival(async () => { throw new Error('download unavailable') })
    await b.modules.entries.sync(graph(row('healthy'), row('bad')))
    expect(b.modules.entries.state.getSnapshot().failures[0]?.message).toContain('download unavailable')
    b.arrival(async () => {})
    await b.modules.entries.retry()
    expect(b.modules.entries.state.getSnapshot().failures[0]?.message).toContain('apply unavailable')
    broken = false
    await b.modules.entries.retry()
    expect(b.modules.entries.state.getSnapshot().failures).toEqual([])
    expect(effects.mounted).toBe(1)
    expect(effects.disposed).toBe(0)
  })

  it('deduplicates rebuilt and graph revisions and retries after failed code arrival', async () => {
    const effects = { mounted: 0, disposed: 0, hits: 0 }
    const b = await bench(graph(row('pet')), { pet: visible('pet', effects) })
    await b.modules.entries.reload('pet', 'r1')
    await b.modules.entries.sync(graph(row('pet', 'r1')))
    expect(effects).toEqual({ mounted: 2, disposed: 1, hits: 0 })
    b.arrival(async () => { throw new Error('offline') })
    await expect(b.modules.entries.reload('pet', 'r2')).rejects.toThrow('offline')
    expect(effects.mounted).toBe(2)
    b.arrival(async () => {})
    await b.modules.entries.retry()
    expect(effects).toEqual({ mounted: 3, disposed: 2, hits: 0 })
    expect(document.querySelectorAll('style[data-plugin=pet]')).toHaveLength(1)
  })

  it('rejects malformed graphs before mutating active entries', async () => {
    const b = await bench(graph(row('a')), { a: () => ({ apply() {} }) })
    expect(() => b.modules.entries.sync({ rev: 'bad', entries: [{ id: 'a' }], batches: [] })).toThrow('string id/url/rev')
    expect([...b.ctx.loader.entries()].map(entry => entry.options.name)).toEqual(['a'])
    expect(() => b.modules.entries.start(b.ctx.loader, b.modules.manifest)).toThrow('already started')
  })
})


it('publishes stable local snapshots and contains a failing subscriber', async () => {
  const b = await bench(graph(), { a: () => ({ apply() {} }) })
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const listener = vi.fn()
  const removeBad = b.modules.entries.state.subscribe(() => { throw new Error('subscriber') })
  const remove = b.modules.entries.state.subscribe(listener)
  expect(b.modules.entries.state.getSnapshot()).toBe(b.modules.entries.state.getSnapshot())
  await b.modules.entries.sync(graph(row('a')))
  expect(listener).toHaveBeenCalledTimes(2)
  expect(error).toHaveBeenCalled()
  removeBad()
  remove()
  await b.modules.entries.retry()
  expect(listener).toHaveBeenCalledTimes(2)
})

it('ignores superseded queued snapshots and rebuilds of absent or unchanged entries', async () => {
  const b = await bench(graph(), { a: () => ({ apply() {} }) })
  const first = b.modules.entries.sync(graph(row('a')))
  const second = b.modules.entries.sync(graph())
  await Promise.all([first, second])
  expect(b.fetched).toEqual([])
  await b.modules.entries.reload('a', 'r1')
  await b.modules.entries.sync(graph(row('a')))
  await b.modules.entries.reload('a', 'r0')
  await b.ctx.fiber.dispose()
  await b.modules.entries.reload('a', 'r2')
  await b.modules.entries.sync(graph())
  expect(b.fetched).toHaveLength(1)
})

it('reports reconciliation before startup and missing service activation without losing later retries', async () => {
  const b = await bench(graph(), { pending: () => ({ inject: ['missing'], apply() {} }) }, false)
  await expect(b.modules.entries.sync(graph())).rejects.toThrow('have not started')
  await b.modules.entries.start(b.ctx.loader, b.modules.manifest)
  await b.modules.entries.sync(graph(row('pending')))
  expect(b.modules.entries.state.getSnapshot().failures[0]?.message).toContain('waiting for activation')
  b.ctx.provide('missing', {})
  await b.modules.entries.retry()
  expect(b.modules.entries.state.getSnapshot().failures).toEqual([])
})

it('retries a materialization failure with the same graph and cleans its partial styles', async () => {
  let broken = true
  const b = await bench(graph(), { a: () => {
    const style = document.createElement('style')
    style.dataset.plugin = 'a'
    document.head.append(style)
    if (broken) throw new Error('factory failed')
    return { apply() {} }
  } })
  await b.modules.entries.sync(graph(row('a')))
  expect(b.modules.entries.state.getSnapshot().failures[0]?.message).toContain('factory failed')
  expect(document.querySelectorAll('style[data-plugin=a]')).toHaveLength(0)
  await b.modules.entries.retry()
  expect(b.modules.entries.state.getSnapshot().failures[0]?.message).toContain('factory failed')
  await b.modules.entries.reload('a', 'r1').catch(() => {})
  expect(b.modules.entries.state.getSnapshot().failures[0]?.message).toContain('factory failed')
  broken = false
  await b.modules.entries.retry()
  expect(b.modules.entries.state.getSnapshot().failures).toEqual([])
  expect(document.querySelectorAll('style[data-plugin=a]')).toHaveLength(1)
})

it('does not finish a stale code replacement after download or asynchronous teardown', async () => {
  const effects = { mounted: 0, disposed: 0, hits: 0 }
  const cleanup = deferred()
  const b = await bench(graph(row('a')), { a: visible('a', effects, () => cleanup.promise) })
  const download = deferred()
  const started = deferred()
  b.arrival(async () => { started.resolve(); await download.promise })
  const rebuilding = b.modules.entries.reload('a', 'r1')
  await started.promise
  const snapshot = b.modules.entries.sync(graph(row('a')))
  download.resolve()
  await Promise.all([rebuilding, snapshot])
  expect(effects.mounted).toBe(1)
  const swapping = b.modules.entries.reload('a', 'r2')
  await vi.waitFor(() => { expect(document.querySelector('[data-live=a]')).toBeNull() })
  const disabling = b.modules.entries.sync(graph())
  cleanup.resolve()
  await Promise.all([swapping, disabling])
  expect(effects.mounted).toBe(1)
  expect(b.modules.loadCache.has('a')).toBe(false)
})

it('stops an obsolete multi-entry application after awaiting removal', async () => {
  const cleanup = deferred()
  const effects = { mounted: 0, disposed: 0, hits: 0 }
  let newMounts = 0
  const b = await bench(graph(row('a')), { a: visible('a', effects, () => cleanup.promise), b: () => ({ apply() { newMounts++ } }) })
  const first = b.modules.entries.sync(graph(row('b')))
  await vi.waitFor(() => { expect(document.querySelector('[data-live=a]')).toBeNull() })
  const latest = b.modules.entries.sync(graph())
  cleanup.resolve()
  await Promise.all([first, latest])
  expect(b.fetched).toEqual(['/batch', row('b').url])
  expect(newMounts).toBe(0)
})


it('keeps bootstrap ownership explicit and diagnoses removal without changing entries', async () => {
  const b = await bench(graph(row('bootstrap')), {})
  await expect(b.modules.entries.sync(graph())).rejects.toThrow('removing bootstrap module')
  expect([...b.ctx.loader.entries()].map(entry => entry.options.name)).toEqual(['bootstrap'])
  expect(b.modules.entries.state.getSnapshot().syncing).toBe(false)
  await b.modules.entries.sync(graph(row('bootstrap')))
  expect(b.modules.entries.state.getSnapshot().failures).toEqual([])
})

it('retains unrelated style tags while reporting a failed replacement', async () => {
  let broken = false
  const effects = { mounted: 0, disposed: 0, hits: 0 }
  const b = await bench(graph(row('a')), { a: () => {
    if (broken) throw new Error('changed factory failed')
    return visible('a', effects)()
  } })
  const unrelated = document.createElement('style')
  unrelated.dataset.plugin = 'unrelated'
  document.head.append(unrelated)
  broken = true
  await b.modules.entries.sync(graph(row('a', 'r1')))
  expect(b.modules.entries.state.getSnapshot().failures[0]?.message).toContain('changed factory failed')
  expect(unrelated.isConnected).toBe(true)
})


it('keeps unrelated page failures visible when a rebuilt download fails', async () => {
  const b = await bench(graph(row('a'), row('bad')), {
    a: () => ({ apply() {} }),
    bad: () => ({ apply() { throw new Error('bad apply') } }),
  })
  await b.modules.entries.retry()
  b.arrival(async () => { throw new Error('a download') })
  await expect(b.modules.entries.reload('a', 'r1')).rejects.toThrow('a download')
  expect(b.modules.entries.state.getSnapshot().failures.map(failure => failure.id)).toEqual(['bad', 'a'])
})

it('retains a rejected Loader entry for retry instead of creating an orphan sibling', async () => {
  let broken = true
  const b = await bench(graph(), { a: () => broken ? { default: 'invalid' } : { apply() {} } })
  await b.modules.entries.sync(graph(row('a')))
  const entry = [...b.ctx.loader.entries()][0]!
  expect(b.modules.entries.state.getSnapshot().failures[0]?.message).toContain('invalid plugin')
  expect([...b.ctx.loader.entries()]).toHaveLength(1)
  broken = false
  await b.modules.entries.retry()
  expect([...b.ctx.loader.entries()]).toEqual([entry])
  expect(entry.fiber?.state).toBe(2)
})

it('reports Loader import failures and recovers the same entry after the importer recovers', async () => {
  const b = await bench(graph(), { a: () => ({ apply() {} }) })
  let broken = true
  b.ctx.loader.internal = {
    version: 'client', import: async (id: string) => {
      if (broken) throw new Error('Loader import failed')
      return b.modules.import(id)
    },
  } as never
  await b.modules.entries.sync(graph(row('a')))
  expect(b.modules.entries.state.getSnapshot().failures[0]?.message).toContain('import failed')
  const entry = [...b.ctx.loader.entries()][0]!
  broken = false
  await b.modules.entries.retry()
  expect(entry.fiber?.state).toBe(2)
  broken = true
  await expect(b.modules.entries.reload('a', 'r1')).rejects.toThrow('import failed')
  expect(b.modules.entries.state.getSnapshot().failures[0]?.id).toBe('a')
})

it.each([false, true])('does not mount a materialized factory after a newer removal (rebuild: %s)', async (rebuild) => {
  let stop: Promise<void> | undefined
  let materializations = 0
  let mounted = 0
  const factories = { a: () => {
    materializations++
    if (materializations === (rebuild ? 2 : 1)) {
      queueMicrotask(() => { stop = b.modules.entries.sync(graph()) })
    }
    return { apply() { mounted++ } }
  } }
  const b = await bench(graph(), factories)
  if (rebuild) {
    // The first materialization remains live until the replacement reaches the import barrier.
    materializations = -1
    await b.modules.entries.sync(graph(row('a')))
    materializations = 1
    await b.modules.entries.reload('a', 'r1')
  } else {
    await b.modules.entries.sync(graph(row('a')))
  }
  await stop
  expect(mounted).toBe(rebuild ? 1 : 0)
  expect([...b.ctx.loader.entries()]).toHaveLength(0)
})

it('coalesces an overlapping graph snapshot with the same rebuilt artifact', async () => {
  const effects = { mounted: 0, disposed: 0, hits: 0 }
  const b = await bench(graph(row('a')), { a: visible('a', effects) })
  const download = deferred()
  const started = deferred()
  b.arrival(async () => { started.resolve(); await download.promise })
  const rebuilding = b.modules.entries.reload('a', 'r1')
  await started.promise
  const syncing = b.modules.entries.sync(graph(row('a', 'r1')))
  download.resolve()
  await Promise.all([rebuilding, syncing])
  expect(b.fetched).toEqual(['/batch', row('a', 'r1').url])
  expect(effects).toEqual({ mounted: 2, disposed: 1, hits: 0 })
})

it.each(['graph', 'rebuilt'])('replaces a failed factory before entry creation on a new %s revision', async (source) => {
  const effects = { mounted: 0, disposed: 0, hits: 0 }
  const factories: Record<string, ClientBundleRegistration['factory']> = { a: () => { throw new Error('broken r0 factory') } }
  const b = await bench(graph(), factories)
  await b.modules.entries.sync(graph(row('a')))
  expect([...b.ctx.loader.entries()]).toHaveLength(0)
  expect(b.modules.entries.state.getSnapshot().failures[0]?.message).toContain('broken r0 factory')
  factories.a = () => ({ ...visible('a', effects)(), revision: 'r1' })
  if (source === 'graph') await b.modules.entries.sync(graph(row('a', 'r1')))
  else await b.modules.entries.reload('a', 'r1')
  await b.modules.entries.retry()
  expect(b.fetched).toEqual([row('a').url, row('a', 'r1').url])
  expect(await b.modules.import('a')).toHaveProperty('revision', 'r1')
  expect(document.querySelectorAll('[data-live=a]')).toHaveLength(1)
  expect(effects.mounted).toBe(1)
  expect(b.modules.entries.state.getSnapshot().failures).toEqual([])
})

it('replaces a superseded arrival and its cached dependency before mounting the latest code', async () => {
  const dependency = row('dependency')
  const consumer = row('consumer', 'r0', { external: ['dependency/client'] })
  const factories: Record<string, ClientBundleRegistration['factory']> = {
    dependency: () => ({ apply() {}, revision: 'r0' }),
    consumer: require => ({ apply() {}, dependency: require('dependency/client'), revision: 'r0' }),
  }
  const b = await bench(graph(), factories)
  const started = deferred()
  const download = deferred()
  b.arrival(async (url) => { if (url === consumer.url) { started.resolve(); await download.promise } })
  const old = b.modules.entries.sync(graph(consumer, dependency))
  try {
    await started.promise
    factories.dependency = () => ({ apply() {}, revision: 'r1' })
    factories.consumer = require => ({ apply() {}, dependency: require('dependency/client'), revision: 'r1' })
    const latest = b.modules.entries.sync(graph(row('consumer', 'r1', { external: ['dependency/client'] }), row('dependency', 'r1')))
    download.resolve()
    await Promise.all([old, latest])
    expect(await b.modules.import('consumer')).toMatchObject({ revision: 'r1', dependency: { revision: 'r1' } })
    expect(b.fetched).toEqual([dependency.url, consumer.url, row('dependency', 'r1').url, row('consumer', 'r1').url])
    expect(b.modules.entries.state.getSnapshot().failures).toEqual([])
  } finally {
    download.resolve()
    await old
  }
})

it.each(['graph', 'rebuilt'])('preserves bootstrap and dependent fibers when a %s requests new bootstrap code', async (source) => {
  const effects = { mounted: 0, disposed: 0, hits: 0 }
  const b = await bench(graph(row('bootstrap'), row('consumer')), {
    consumer: () => ({ ...visible('consumer', effects)(), inject: ['modules'] }),
  })
  const fibers = [...b.ctx.loader.entries()].map(entry => entry.fiber)
  const exports = await b.modules.import('bootstrap')
  if (source === 'graph') await b.modules.entries.sync(graph(row('bootstrap', 'r1'), row('consumer')))
  else await expect(b.modules.entries.reload('bootstrap', 'r1')).rejects.toThrow('requires a page reload')
  for (let retry = 0; retry < 2; retry++) {
    await b.modules.entries.retry()
    expect(b.modules.entries.state.getSnapshot().failures).toEqual([
      { id: 'bootstrap', message: 'Error: client-modules: replacing bootstrap module bootstrap requires a page reload' },
    ])
  }
  expect([...b.ctx.loader.entries()].map(entry => entry.fiber)).toEqual(fibers)
  expect(await b.modules.import('bootstrap')).toBe(exports)
  expect(effects).toEqual({ mounted: 1, disposed: 0, hits: 0 })
  expect(b.fetched).toEqual(['/batch'])
})

it('discards a failed arrival target when an uncreated entry receives a newer graph', async () => {
  const b = await bench(graph(), { a: () => { throw new Error('r0 factory') } })
  await b.modules.entries.sync(graph(row('a')))
  b.arrival(async () => { throw new Error('offline r1') })
  await b.modules.entries.reload('a', 'r1')
  expect(b.modules.entries.state.getSnapshot().failures[0]?.message).toContain('offline r1')
  b.arrival(async () => {})
  await b.modules.entries.sync(graph(row('a', 'r2')))
  // A transport failure is retried once on the same URL before the reload is reported failed.
  expect(b.fetched).toEqual([row('a').url, row('a', 'r1').url, row('a', 'r1').url, row('a', 'r2').url])
})

it('uses the latest desired revision when a rebuild queues before entry creation', async () => {
  const b = await bench(graph(), { a: () => ({ apply() {} }) })
  const adding = b.modules.entries.sync(graph(row('a')))
  const rebuilding = b.modules.entries.reload('a', 'r1')
  const latest = b.modules.entries.sync(graph(row('a', 'r2')))
  await Promise.all([adding, rebuilding, latest])
  expect(b.fetched).toEqual([row('a', 'r2').url])
  expect([...b.ctx.loader.entries()]).toHaveLength(1)
})

it('cleans styles from a materialized factory superseded before its entry is created', async () => {
  const effects = { mounted: 0, disposed: 0, hits: 0 }
  let latest: Promise<void> | undefined
  const factories: Record<string, ClientBundleRegistration['factory']> = { a: () => {
    const old = visible('a', effects)()
    queueMicrotask(() => {
      factories.a = visible('a', effects)
      latest = b.modules.entries.sync(graph(row('a', 'r1')))
    })
    return old
  } }
  const b = await bench(graph(), factories)
  await b.modules.entries.sync(graph(row('a')))
  await latest
  expect(b.fetched).toEqual([row('a').url, row('a', 'r1').url])
  expect(effects).toEqual({ mounted: 1, disposed: 0, hits: 0 })
  expect(document.querySelectorAll('style[data-plugin=a]')).toHaveLength(1)
})

it.each(['graph', 'rebuilt'])('keeps the live page mounted through a failed %s prefetch', async (source) => {
  const effects = { mounted: 0, disposed: 0, hits: 0 }
  const b = await bench(graph(row('a')), { a: visible('a', effects) })
  const download = deferred()
  const started = deferred()
  const syncing: boolean[] = []
  b.modules.entries.state.subscribe(() => { syncing.push(b.modules.entries.state.getSnapshot().syncing) })
  b.arrival(async () => { started.resolve(); await download.promise; throw new Error('offline replacement') })
  const replacing = source === 'graph'
    ? b.modules.entries.sync(graph(row('a', 'r1')))
    : b.modules.entries.reload('a', 'r1').catch(() => {})
  try {
    await started.promise
    expect(b.modules.entries.state.getSnapshot().syncing).toBe(false)
    expect(document.querySelector('[data-live=a]')).not.toBeNull()
  } finally {
    download.resolve()
    await replacing
  }
  expect(syncing).not.toContain(true)
  expect(effects).toEqual({ mounted: 1, disposed: 0, hits: 0 })
  expect(b.modules.entries.state.getSnapshot().failures[0]?.message).toContain('offline replacement')
})

it('notifies the shell synchronously before replacement effect cleanup starts', async () => {
  const page = document.createElement('main')
  document.body.append(page)
  const cleanup: { syncing: boolean; pageMounted: boolean }[] = []
  const b = await bench(graph(row('a')), { a: () => ({ apply(ctx: Context) {
    ctx.effect(() => () => {
      cleanup.push({ syncing: b.modules.entries.state.getSnapshot().syncing, pageMounted: page.isConnected })
    })
  } }) })
  const download = deferred()
  const started = deferred()
  b.arrival(async () => { started.resolve(); await download.promise })
  b.modules.entries.state.subscribe(() => {
    if (b.modules.entries.state.getSnapshot().syncing) page.remove()
  })
  const replacing = b.modules.entries.reload('a', 'r1')
  try {
    await started.promise
    expect(page.isConnected).toBe(true)
  } finally {
    download.resolve()
    await replacing
  }
  expect(cleanup).toEqual([{ syncing: true, pageMounted: false }])
})

it('keeps syncing until dependent cleanup and reactivation both settle', async () => {
  const cleanup = deferred()
  const cleanupStarted = deferred()
  const activation = deferred()
  const activationStarted = deferred()
  let mounts = 0
  const b = await bench(graph(row('provider'), row('consumer')), {
    provider: () => ({ apply(ctx: Context) { ctx.provide('probe', {}) } }),
    consumer: () => ({ inject: ['probe'], async apply(ctx: Context) {
      mounts++
      ctx.effect(() => () => { cleanupStarted.resolve(); return cleanup.promise })
      if (mounts > 1) { activationStarted.resolve(); await activation.promise }
    } }),
  })
  let finished = false
  const replacing = b.modules.entries.reload('provider', 'r1').then(() => { finished = true })
  try {
    await cleanupStarted.promise
    expect(b.modules.entries.state.getSnapshot().syncing).toBe(true)
    expect(finished).toBe(false)
    cleanup.resolve()
    await activationStarted.promise
    await [...b.ctx.loader.entries()].find(entry => entry.options.name === 'provider')!.fiber!.await()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(b.modules.entries.state.getSnapshot().syncing).toBe(true)
    expect(finished).toBe(false)
  } finally {
    cleanup.resolve()
    activation.resolve()
    await replacing
  }
  expect(mounts).toBe(2)
  expect(b.modules.entries.state.getSnapshot()).toEqual({ syncing: false, failures: [] })
})

it('settles failed dependent activation cleanup before reporting the failure', async () => {
  const cleanup = deferred()
  const cleanupStarted = deferred()
  const applyFailed = deferred()
  let mounts = 0
  const b = await bench(graph(row('provider'), row('consumer')), {
    provider: () => ({ apply(ctx: Context) { ctx.provide('probe', {}) } }),
    consumer: () => ({ inject: ['probe'], apply(ctx: Context) {
      mounts++
      const activation = mounts
      ctx.effect(() => () => {
        if (activation > 1) { cleanupStarted.resolve(); return cleanup.promise }
      })
      if (activation > 1) { applyFailed.resolve(); throw new Error('dependent activation failed') }
    } }),
  })
  let finished = false
  const replacing = b.modules.entries.reload('provider', 'r1').then(() => { finished = true }, () => { finished = true })
  try {
    await cleanupStarted.promise
    await applyFailed.promise
    await [...b.ctx.loader.entries()].find(entry => entry.options.name === 'provider')!.fiber!.await()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(b.modules.entries.state.getSnapshot().syncing).toBe(true)
    expect(finished).toBe(false)
    expect(b.modules.entries.state.getSnapshot().failures).toEqual([])
  } finally {
    cleanup.resolve()
    await replacing
  }
  expect(b.modules.entries.state.getSnapshot().syncing).toBe(false)
  expect(b.modules.entries.state.getSnapshot().failures[0]).toMatchObject({ id: 'consumer' })
  expect(b.modules.entries.state.getSnapshot().failures[0]?.message).toContain('dependent activation failed')
})

it('holds suspension across a superseded replacement and queued graph removal', async () => {
  const cleanup = deferred()
  const cleanupStarted = deferred()
  const b = await bench(graph(row('a')), { a: () => ({ apply(ctx: Context) {
    ctx.effect(() => () => { cleanupStarted.resolve(); return cleanup.promise })
  } }) })
  const syncing: boolean[] = []
  b.modules.entries.state.subscribe(() => { syncing.push(b.modules.entries.state.getSnapshot().syncing) })
  const replacing = b.modules.entries.reload('a', 'r1')
  try {
    await cleanupStarted.promise
    const removing = b.modules.entries.sync(graph())
    cleanup.resolve()
    await Promise.all([replacing, removing])
  } finally {
    cleanup.resolve()
    await replacing
  }
  expect(syncing.filter((value, index) => index === 0 || value !== syncing[index - 1])).toEqual([true, false])
  expect([...b.ctx.loader.entries()]).toHaveLength(0)
})

it('does not suspend for unchanged targets or rejected bootstrap replacement', async () => {
  const b = await bench(graph(row('bootstrap'), row('a')), { a: () => ({ apply() {} }) })
  const fibers = [...b.ctx.loader.entries()].map(entry => entry.fiber)
  const syncing: boolean[] = []
  b.modules.entries.state.subscribe(() => { syncing.push(b.modules.entries.state.getSnapshot().syncing) })
  await b.modules.entries.sync(graph(row('bootstrap'), row('a')))
  await b.modules.entries.reload('a', 'r0')
  await expect(b.modules.entries.reload('bootstrap', 'r1')).rejects.toThrow('requires a page reload')
  expect(syncing).not.toContain(true)
  expect([...b.ctx.loader.entries()].map(entry => entry.fiber)).toEqual(fibers)
})

it('prefetches an entire replacement graph before removing its old entries', async () => {
  const effects = { mounted: 0, disposed: 0, hits: 0 }
  const b = await bench(graph(row('a')), { a: visible('a', effects), b: () => ({ apply() {} }) })
  const entry = [...b.ctx.loader.entries()][0]!
  const syncing: boolean[] = []
  b.modules.entries.state.subscribe(() => { syncing.push(b.modules.entries.state.getSnapshot().syncing) })
  b.arrival(async () => { throw new Error('new entry offline') })
  await b.modules.entries.sync(graph(row('b')))
  expect([...b.ctx.loader.entries()].map(candidate => candidate === entry)).toEqual([true])
  expect(effects).toEqual({ mounted: 1, disposed: 0, hits: 0 })
  expect(syncing).not.toContain(true)
  expect(b.modules.entries.state.getSnapshot().failures[0]?.message).toContain('new entry offline')
})

it('preflights bootstrap replacement before changing any peer entries', async () => {
  const b = await bench(graph(row('a'), row('bootstrap')), { a: () => ({ apply() {} }) })
  const fibers = [...b.ctx.loader.entries()].map(entry => entry.fiber)
  const syncing: boolean[] = []
  b.modules.entries.state.subscribe(() => { syncing.push(b.modules.entries.state.getSnapshot().syncing) })
  await b.modules.entries.sync(graph(row('a', 'r1'), row('bootstrap', 'r1')))
  expect([...b.ctx.loader.entries()].map((entry, index) => entry.fiber === fibers[index])).toEqual([true, true])
  expect(syncing).not.toContain(true)
  expect(b.modules.entries.state.getSnapshot().failures[0]?.id).toBe('bootstrap')
})

it('does not install a downloaded rebuild superseded by a newer rebuild', async () => {
  const effects = { mounted: 0, disposed: 0, hits: 0 }
  const b = await bench(graph(row('a')), { a: visible('a', effects) })
  const download = deferred()
  const started = deferred()
  b.arrival(async (url) => { if (url === row('a', 'r1').url) { started.resolve(); await download.promise } })
  const old = b.modules.entries.reload('a', 'r1')
  try {
    await started.promise
    const latest = b.modules.entries.reload('a', 'r2')
    download.resolve()
    await Promise.all([old, latest])
  } finally {
    download.resolve()
    await old
  }
  expect(effects).toEqual({ mounted: 2, disposed: 1, hits: 0 })
  expect(b.fetched).toEqual(['/batch', row('a', 'r1').url, row('a', 'r2').url])
})

it('applies overlapping rebuilds of different entries', async () => {
  const a = { mounted: 0, disposed: 0, hits: 0 }
  const b = { mounted: 0, disposed: 0, hits: 0 }
  const page = await bench(graph(row('a'), row('b')), { a: visible('a', a), b: visible('b', b) })
  await Promise.all([page.modules.entries.reload('a', 'r1'), page.modules.entries.reload('b', 'r1')])
  expect(a).toEqual({ mounted: 2, disposed: 1, hits: 0 })
  expect(b).toEqual({ mounted: 2, disposed: 1, hits: 0 })
  expect(page.modules.entries.state.getSnapshot()).toEqual({ syncing: false, failures: [] })
})

it('retains unrelated activation failures when graph prefetch fails', async () => {
  const b = await bench(graph(row('bad')), {
    bad: () => ({ apply() { throw new Error('existing activation failed') } }),
    a: () => ({ apply() {} }),
  })
  await b.modules.entries.retry()
  b.arrival(async () => { throw new Error('new entry offline') })
  await b.modules.entries.sync(graph(row('bad'), row('a')))
  expect(b.modules.entries.state.getSnapshot().failures.map(failure => failure.id).sort()).toEqual(['a', 'bad'])
})

it('retains the mounted page when a new factory fails before entry creation', async () => {
  const effects = { mounted: 0, disposed: 0, hits: 0 }
  const b = await bench(graph(row('healthy')), {
    healthy: visible('healthy', effects),
    a: () => { throw new Error('new factory failed') },
  })
  const syncing: boolean[] = []
  b.modules.entries.state.subscribe(() => { syncing.push(b.modules.entries.state.getSnapshot().syncing) })
  await b.modules.entries.sync(graph(row('healthy'), row('a')))
  expect(syncing).not.toContain(true)
  expect(document.querySelector('[data-live=healthy]')).not.toBeNull()
  expect(b.modules.entries.state.getSnapshot().failures[0]?.message).toContain('new factory failed')
})

it('clears a dependent activation failure after provider replacement recovers it', async () => {
  let broken = true
  const b = await bench(graph(row('provider'), row('consumer')), {
    provider: () => ({ apply(ctx: Context) { ctx.provide('probe', {}) } }),
    consumer: () => ({ inject: ['probe'], apply() { if (broken) throw new Error('consumer unavailable') } }),
  })
  await b.modules.entries.retry()
  expect(b.modules.entries.state.getSnapshot().failures[0]?.id).toBe('consumer')
  broken = false
  await b.modules.entries.reload('provider', 'r1')
  expect([...b.ctx.loader.entries()].every(entry => entry.fiber?.state === FiberState.ACTIVE)).toBe(true)
  expect(b.modules.entries.state.getSnapshot()).toEqual({ syncing: false, failures: [] })
})

it('applies current graph peers after another target fails and is superseded by a rebuild', async () => {
  const a = { mounted: 0, disposed: 0, hits: 0 }
  const b = { mounted: 0, disposed: 0, hits: 0 }
  const page = await bench(graph(row('a'), row('b')), { a: visible('a', a), b: visible('b', b) })
  const download = deferred()
  const started = deferred()
  page.arrival(async (url) => {
    if (url === row('a', 'r1').url) { started.resolve(); await download.promise; throw new Error('obsolete download failed') }
  })
  const updating = page.modules.entries.sync(graph(row('a', 'r1'), row('b', 'r1')))
  try {
    await started.promise
    const latest = page.modules.entries.reload('a', 'r2')
    download.resolve()
    await Promise.all([updating, latest])
  } finally {
    download.resolve()
    await updating
  }
  expect(a).toEqual({ mounted: 2, disposed: 1, hits: 0 })
  expect(b).toEqual({ mounted: 2, disposed: 1, hits: 0 })
  expect(page.modules.entries.state.getSnapshot()).toEqual({ syncing: false, failures: [] })
})

it('restores a previous revision requested during replacement teardown', async () => {
  const effects = { mounted: 0, disposed: 0, hits: 0 }
  const cleanup = deferred()
  const cleanupStarted = deferred()
  const b = await bench(graph(row('a')), { a: visible('a', effects, async () => {
    cleanupStarted.resolve()
    await cleanup.promise
  }) })
  const old = b.modules.entries.reload('a', 'r1')
  try {
    await cleanupStarted.promise
    const restored = b.modules.entries.reload('a', 'r0')
    cleanup.resolve()
    await Promise.all([old, restored])
  } finally {
    cleanup.resolve()
    await old
  }
  expect(effects).toEqual({ mounted: 2, disposed: 1, hits: 0 })
  expect([...b.ctx.loader.entries()].every(entry => entry.fiber?.state === FiberState.ACTIVE)).toBe(true)
  expect(b.modules.entries.state.getSnapshot()).toEqual({ syncing: false, failures: [] })
})

it.each(['replace', 'remove', 'retry'])('reports retiring fibers synchronously before %s mutates the Loader', async (operation) => {
  const events: string[] = []
  let applications = 0
  const b = await bench(graph(row('a')), { a: () => ({ apply(ctx: Context) {
    applications++
    events.push('apply')
    ctx.effect(() => () => { events.push('cleanup') })
    if (operation === 'retry' && applications === 1) throw new Error('first activation failed')
  } }) })
  const fiber = [...b.ctx.loader.entries()][0]?.fiber
  const retiring: (readonly Fiber[])[] = []
  const observations: { syncing: boolean; intact: boolean }[] = []
  events.length = 0
  b.modules.entries.beforeRetire((fibers) => {
    events.push('retire')
    retiring.push([...fibers])
    observations.push({ syncing: b.modules.entries.state.getSnapshot().syncing, intact: events.indexOf('cleanup') === -1 })
  })
  if (operation === 'replace') await b.modules.entries.reload('a', 'r1')
  else if (operation === 'remove') await b.modules.entries.sync(graph())
  else await b.modules.entries.retry()
  expect(retiring.map(fibers => fibers.map(candidate => candidate === fiber))).toEqual([[true]])
  expect(observations).toEqual([{ syncing: true, intact: true }])
  expect(events).toEqual(operation === 'replace' ? ['retire', 'cleanup', 'apply'] : operation === 'remove' ? ['retire', 'cleanup'] : ['retire', 'apply'])
})

it('creates entries without notifying retirement listeners', async () => {
  const b = await bench(graph(), { a: () => ({ apply() {} }) })
  const retired: (readonly Fiber[])[] = []
  b.modules.entries.beforeRetire((fibers) => { retired.push([...fibers]) })
  await b.modules.entries.sync(graph(row('a')))
  await b.modules.entries.reload('a', 'r0')
  expect(retired).toEqual([])
  expect([...b.ctx.loader.entries()].every(entry => entry.fiber?.state === FiberState.ACTIVE)).toBe(true)
})

it.each(['replace', 'remove', 'retry'])('aborts %s before teardown when a retirement listener throws, then unsubscribes', async (operation) => {
  let applications = 0
  let cleanups = 0
  const b = await bench(graph(row('a')), { a: () => ({ apply(ctx: Context) {
    applications++
    ctx.effect(() => () => { cleanups++ })
    if (operation === 'retry' && applications === 1) throw new Error('first activation failed')
  } }) })
  const entry = [...b.ctx.loader.entries()][0]
  const fiber = entry?.fiber
  const previousCleanups = cleanups
  const unsubscribe = b.modules.entries.beforeRetire(() => { throw new Error('retirement denied') })
  if (operation === 'replace') await expect(b.modules.entries.reload('a', 'r1')).rejects.toThrow('retirement denied')
  else if (operation === 'remove') await expect(b.modules.entries.sync(graph())).rejects.toThrow('retirement denied')
  else await b.modules.entries.retry()
  expect([...b.ctx.loader.entries()].map(candidate => candidate === entry)).toEqual([true])
  expect(entry?.fiber === fiber).toBe(true)
  expect(applications).toBe(1)
  expect(cleanups).toBe(previousCleanups)
  expect(b.modules.entries.state.getSnapshot().failures[0]?.message).toContain('retirement denied')
  unsubscribe()
  if (operation === 'replace') await b.modules.entries.reload('a', 'r1')
  else if (operation === 'remove') await b.modules.entries.sync(graph())
  else await b.modules.entries.retry()
  expect(applications).toBe(operation === 'remove' ? 1 : 2)
  expect(b.modules.entries.state.getSnapshot()).toEqual({ syncing: false, failures: [] })
})

it('reports every same-runtime fiber before replacement removes the shared registry callback', async () => {
  let cleanups = 0
  const plugin = { apply(ctx: Context) { ctx.effect(() => () => { cleanups++ }) } }
  const b = await bench(graph(row('a')), { a: () => plugin })
  const fiber = [...b.ctx.loader.entries()][0]?.fiber
  const extra = await b.ctx.plugin(plugin)
  const observations: { entry: boolean; extra: boolean; count: number; cleanups: number }[] = []
  b.modules.entries.beforeRetire((fibers) => {
    observations.push({
      entry: fibers.some(candidate => candidate === fiber), extra: fibers.includes(extra), count: fibers.length, cleanups,
    })
  })
  await b.modules.entries.reload('a', 'r1')
  expect(observations).toEqual([{ entry: true, extra: true, count: 2, cleanups: 0 }])
  expect(cleanups).toBe(2)
  expect(extra.state).toBe(4)
})
