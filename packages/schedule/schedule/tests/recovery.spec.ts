/** Registered Schedule startup reads real task files without hiding or rewriting failed records. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@yharness/cordis'
import type { DomainFacility } from '@yharness/storage-domain'
import { JsonStorageBackend } from '@yharness/storage-json'
import { SessionId } from '@yharness/session'
import { MessageId } from '@yharness/llm/brand'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import ScheduleService from '../src/index.ts'
import { scheduleDomain } from '../src/storage.ts'
import { createEveryScheduleRecord, ScheduleId } from '../src/domain.ts'
import { ScheduleRuntime } from '../src/runtime.ts'
import { agentFor, gatedScheduleBackend, harness } from './harness.ts'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const roots: string[] = []
const contexts: Context[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-16T00:00:00Z')) })
afterEach(async () => {
  const errors: unknown[] = []
  for (const ctx of contexts.splice(0)) {
    try { await ctx.fiber.dispose() } catch (error) { errors.push(error) }
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const root of roots.splice(0)) {
    try { await rm(root, { recursive: true, force: true }) } catch (error) { errors.push(error) }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Schedule recovery cleanup failed')
})
async function rootWith(tasks: Record<string, unknown>, bytes?: string) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-recovery-'))
  roots.push(root)
  const path = join(root, 'schedule.json')
  if (bytes !== undefined || Object.keys(tasks).length > 0) {
    await writeFile(path, bytes ?? encoded(tasks))
  }
  return { root, path }
}
function encoded(tasks: Record<string, unknown>, version = 1) {
  return `${JSON.stringify({ unit: { name: 'schedule', version }, global: null, tables: { tasks } }, null, 2)}\n`
}
const oldTask = {
  sessionId: 'original',
  record: {
    id: 'a-good', kind: 'after', title: 'Old due reminder', prompt: 'Old due reminder', afterSeconds: 60,
    scheduledAt: '2026-09-15T23:59:59.000Z',
  },
}
const repairedTask = {
  sessionId: 'original', status: 'inactive',
  record: {
    id: 'z-broken', kind: 'at', title: 'Retained receipt', prompt: 'Retained receipt',
    scheduledAt: '2026-09-15T20:00:00.000Z',
  },
  lastDelivery: {
    scheduledAt: '2026-09-15T20:00:00.000Z', deliveredAt: '2026-09-15T20:00:01.000Z', messageId: 'original-message',
  },
}

it('skips occurrences missed before startup and delivers the next regular occurrence once', async () => {
  const sessionId = SessionId('original')
  const id = ScheduleId('recurring')
  const pausedId = ScheduleId('paused')
  const next = '2026-09-16T00:00:30.000Z'
  const oldReceipt = {
    messageId: MessageId('previous-delivery'),
    scheduledAt: '2026-09-15T23:54:30.000Z',
    deliveredAt: '2026-09-15T23:54:31.000Z',
  }
  const record = {
    id, kind: 'every', title: 'Paper simulation', prompt: 'Run the paper simulation', everySeconds: 60,
    scheduledAt: '2026-09-15T23:55:30.000Z',
  }
  const recurring = { sessionId, record, status: 'active', lastDelivery: oldReceipt }
  const paused = { ...recurring, record: { ...record, id: pausedId }, status: 'paused' }
  const { root } = await rootWith({ recurring, paused })
  let agent: ReturnType<typeof agentFor> | undefined
  const test = await harness({
    config: { skipMissedRecurringOnStartup: true },
    backend: new JsonStorageBackend(root),
    onContext: ctx => contexts.push(ctx),
    beforeService: async (ctx) => {
      agent = agentFor(ctx)
      vi.spyOn(ctx.sessionController, 'resolveAgent').mockResolvedValue({ agent })
    },
  })
  expect(await test.service.catalog()).toEqual([
    { ...paused.record, sessionId, status: 'paused', lastDelivery: oldReceipt },
    { ...record, scheduledAt: next, sessionId, status: 'active', lastDelivery: oldReceipt },
  ])
  expect(test.resolve).not.toHaveBeenCalled()
  expect(await test.service.history({ sessionId, id, limit: 5 })).toMatchObject({ records: [oldReceipt] })

  await vi.advanceTimersByTimeAsync(29_999)
  expect(test.resolve).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await test.service.catalog()
  expect(test.resolve).toHaveBeenCalledExactlyOnceWith(sessionId)
  expect(agent?.followup).toHaveBeenCalledTimes(1)
  const history = await test.service.history({ sessionId, id, limit: 5 })
  if (!('records' in history)) throw new Error('Expected stored delivery receipts')
  const { records } = history
  expect(records.map(receipt => receipt.scheduledAt)).toEqual([next, oldReceipt.scheduledAt])
  await test.ctx.fiber.dispose()

  const reopened = await harness({ backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx) })
  expect(await reopened.service.catalog()).toContainEqual(expect.objectContaining({
    id, sessionId, status: 'active', scheduledAt: '2026-09-16T00:01:30.000Z',
  }))
  expect(await reopened.service.history({ sessionId, id, limit: 5 })).toMatchObject({ records })
  expect(reopened.resolve).not.toHaveBeenCalled()
})

it('still delivers the occurrence due at startup and the overdue one-shot', async () => {
  const sessionId = SessionId(oldTask.sessionId)
  const now = '2026-09-16T00:00:00.000Z'
  const recurring = {
    sessionId, record: {
      id: 'recurring', kind: 'every', title: 'Regular check', prompt: 'Run the regular check',
      scheduledAt: '2026-09-15T23:57:00.000Z', everySeconds: 60,
    },
  }
  const future = {
    ...recurring, record: { ...recurring.record, id: 'future', scheduledAt: '2026-09-16T00:00:30.000Z' },
  }
  const { root } = await rootWith({ 'a-good': oldTask, recurring, future })
  const test = await harness({
    config: { skipMissedRecurringOnStartup: true },
    backend: new JsonStorageBackend(root),
    onContext: ctx => contexts.push(ctx),
    beforeService: async (ctx) => {
      vi.spyOn(ctx.sessionController, 'resolveAgent').mockResolvedValue({ agent: agentFor(ctx) })
    },
  })
  await test.service.catalog()
  expect(test.resolve).toHaveBeenCalledTimes(2)
  expect(await test.service.history({ sessionId, id: ScheduleId('recurring'), limit: 5 })).toMatchObject({
    records: [expect.objectContaining({ scheduledAt: now })],
  })
  expect(await test.service.history({ sessionId, id: ScheduleId('a-good'), limit: 5 })).toMatchObject({
    records: [expect.objectContaining({ scheduledAt: oldTask.record.scheduledAt })],
  })
  expect(await test.service.history({ sessionId, id: ScheduleId('future'), limit: 5 })).toMatchObject({ records: [] })
})

it('ends an exhausted recurrence without creating a delivery receipt', async () => {
  vi.setSystemTime(new Date('9999-12-31T23:59:30.000Z'))
  const sessionId = SessionId(oldTask.sessionId)
  const id = ScheduleId('recurring')
  const { root } = await rootWith({
    recurring: { sessionId, record: {
      id, kind: 'every', title: 'Last check', prompt: 'Run the last check', everySeconds: 60,
      scheduledAt: '9999-12-31T23:59:00.000Z',
    } },
  })
  const test = await harness({
    config: { skipMissedRecurringOnStartup: true },
    backend: new JsonStorageBackend(root),
    onContext: ctx => contexts.push(ctx),
  })
  expect(await test.service.catalog()).toMatchObject([{ id, status: 'inactive', scheduledAt: '9999-12-31T23:59:00.000Z' }])
  expect(test.resolve).not.toHaveBeenCalled()
  expect(await test.service.history({ sessionId, id, limit: 5 })).toMatchObject({ records: [] })
})

it.each([
  ['{broken json', 'malformed-medium'],
  [encoded({ 'a-good': oldTask, 'z-broken': repairedTask }, 2), 'version-mismatch'],
  [encoded({ 'a-good': oldTask, 'z-broken': { invalid: true } }), 'invalid-record'],
])('rejects the complete task domain on invalid stored data and recovers after repair', async (broken, code) => {
  const { root, path } = await rootWith({}, broken)
  let observed: {
    ctx: Context
    facility: DomainFacility
    agent: ReturnType<typeof agentFor>
    resolveCalls: () => number
  } | undefined
  const changed = vi.fn()
  await expect(harness({
    backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx),
    beforeService: async (ctx, facility) => {
      const agent = agentFor(ctx)
      ctx.effect(() => ctx.agents.enter(agent, undefined))
      ctx.on('schedule/changed', changed)
      const resolve = vi.spyOn(ctx.sessionController, 'resolveAgent')
      observed = { ctx, facility, agent, resolveCalls: () => resolve.mock.calls.length }
    },
  }).then(() => 'Schedule activated')).rejects.toMatchObject({ code })
  if (observed === undefined) throw new Error('Schedule dependencies did not initialize')
  const { ctx, facility, agent } = observed
  expect(ctx.get('schedule')).toBeUndefined()
  expect(facility.get('schedule')).toBeUndefined()
  expect(ctx.tools.get('schedule_create', agent)).toBeUndefined()
  await vi.advanceTimersByTimeAsync(0)
  expect(observed.resolveCalls()).toBe(0)
  expect(changed).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  expect(await readFile(path, 'utf8')).toBe(broken)

  const repaired = encoded({ 'a-good': oldTask, 'z-broken': repairedTask })
  await writeFile(path, repaired)
  const restored = await facility.open(scheduleDomain)
  expect(restored.table('tasks').get(ScheduleId('a-good'))).toEqual({ ...oldTask, status: 'active' })
  expect(restored.table('tasks').get(ScheduleId('z-broken'))).toEqual(repairedTask)
  await restored.close()
  await ctx.plugin(ScheduleService)
  expect(await ctx.schedule.catalog()).toHaveLength(2)
  expect(await readFile(path, 'utf8')).toBe(repaired)
})

it('closes the domain and preserves an armed task when startup normalization cannot be written', async () => {
  const pool = new MemoryMediaPool()
  let rejectStartupWrite = false
  const backend = gatedScheduleBackend(pool, {
    putRecord: async (table) => {
      if (rejectStartupWrite && table === 'tasks') throw new Error('startup normalization write failed')
    },
  })
  const sessionId = SessionId('startup-write-failure')
  const id = ScheduleId('startup-write-failure')
  const record = {
    ...createEveryScheduleRecord(id, 'Run the recovery check', 60, Date.now() - 120_000, 'Recovery check'),
    scheduledAt: '2026-09-15T23:59:00.000Z',
  }
  const task = { sessionId, record, status: 'active' as const }
  let observed: { ctx: Context; facility: DomainFacility; resolveCalls: () => number } | undefined
  const startup = harness({
    pool, backend, config: { skipMissedRecurringOnStartup: true }, onContext: ctx => contexts.push(ctx),
    beforeService: async (ctx, facility) => {
      const domain = await facility.open(scheduleDomain)
      await domain.table('tasks').put(id, task)
      await domain.close()
      rejectStartupWrite = true
      const resolve = vi.spyOn(ctx.sessionController, 'resolveAgent')
      observed = { ctx, facility, resolveCalls: () => resolve.mock.calls.length }
    },
  })
  await expect(startup).rejects.toThrow('startup normalization write failed')
  if (observed === undefined) throw new Error('Schedule dependencies did not initialize')
  const { ctx, facility } = observed
  expect(ctx.get('schedule')).toBeUndefined()
  expect(facility.get('schedule')).toBeUndefined()
  expect(observed.resolveCalls()).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  expect(pool.media.get('schedule')?.tables.get('tasks')?.get(id)).toEqual(task)

  const reopened = await facility.open(scheduleDomain)
  expect(reopened.table('tasks').get(id)).toEqual(task)
  await reopened.close()
})

it.each([
  null, [], {}, { records: [], earlierRecordsUnavailable: 'true' },
  { records: [], earlierRecordsUnavailable: false, earlierRecordsPruned: 'true' },
  { records: [], earlierRecordsUnavailable: false, extra: true },
  { records: [repairedTask.lastDelivery], earlierRecordsUnavailable: undefined },
  { records: [{ ...repairedTask.lastDelivery, prompt: 42 }], earlierRecordsUnavailable: false },
  { records: [{ ...repairedTask.lastDelivery, extra: true }], earlierRecordsUnavailable: false },
  { records: [{ ...repairedTask.lastDelivery, messageId: ' padded ' }], earlierRecordsUnavailable: false },
  { records: [{ ...repairedTask.lastDelivery, deliveredAt: '2026-02-30T00:00:00.000Z' }], earlierRecordsUnavailable: false },
  { records: [repairedTask.lastDelivery, repairedTask.lastDelivery], earlierRecordsUnavailable: false },
  { records: [], earlierRecordsUnavailable: false },
  { records: [{ ...repairedTask.lastDelivery, messageId: 'different' }], earlierRecordsUnavailable: false },
  { records: [{ ...repairedTask.lastDelivery, scheduledAt: '2026-09-15T19:00:00.000Z' }], earlierRecordsUnavailable: false },
  { records: [{ ...repairedTask.lastDelivery, deliveredAt: '2026-09-15T19:00:00.000Z' }], earlierRecordsUnavailable: false },
])('rejects malformed or inconsistent saved history without rewriting task files %#', async (deliveryHistory) => {
  const bytes = encoded({ 'z-broken': { ...repairedTask, deliveryHistory } })
  const { root, path } = await rootWith({}, bytes)
  await expect(harness({ backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx) }))
    .rejects.toMatchObject({ code: 'invalid-record' })
  expect(await readFile(path, 'utf8')).toBe(bytes)
})

it.each([true, false])('reads legacy history with receipt=%s without rewriting stored files', async (hasReceipt) => {
  const legacy = hasReceipt ? repairedTask : { ...oldTask, status: 'inactive' }
  const taskId = ScheduleId(legacy.record.id)
  const bytes = encoded({ [taskId]: legacy })
  const { root, path } = await rootWith({}, bytes)
  const test = await harness({ backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx) })
  const changed = vi.fn()
  test.ctx.on('schedule/changed', changed)
  expect(await test.service.history({ sessionId: SessionId(legacy.sessionId), id: taskId, limit: 100 })).toEqual({
    id: taskId, records: hasReceipt ? [repairedTask.lastDelivery] : [], earlierRecordsUnavailable: true,
    earlierRecordsPruned: false, retention: { days: 30, records: 200 },
  })
  expect(changed).not.toHaveBeenCalled()
  expect(test.resolve).not.toHaveBeenCalled()
  expect(await readFile(path, 'utf8')).toBe(bytes)
  await test.ctx.fiber.dispose()
  expect(await readFile(path, 'utf8')).toBe(bytes)
})

it.each(['create', 'delete'] as const)('returns the durable %s result when an ancestor unloads before dispatch admission', async (operation) => {
  const future = { ...oldTask, record: { ...oldTask.record, scheduledAt: '2026-09-17T00:00:00.000Z' } }
  const { root, path } = await rootWith(operation === 'delete' ? { 'a-good': future } : {})
  const test = await harness({ backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx) })
  await vi.advanceTimersByTimeAsync(0)
  const admission = vi.spyOn(test.ctx.agents, 'withoutInitiator')
  const warning = vi.spyOn(test.ctx.logger, 'warn')
  const stop = vi.spyOn(ScheduleRuntime.prototype, 'dispose')
  let unloading: Promise<void> | undefined
  let cleanupHadStarted: boolean | undefined
  test.ctx.on('schedule/changed', () => {
    unloading = test.ctx.fiber.dispose()
    cleanupHadStarted = stop.mock.calls.length !== 0
  })
  const mutation = operation === 'create'
    ? test.service.create(SessionId('original'), {
      prompt: 'Accepted before unload', after_seconds: 60, title: 'Accepted before unload',
    })
    : test.service.delete({ sessionId: SessionId('original'), id: ScheduleId('a-good') })
  const outcome = await mutation.then(value => ({ value }), (error: unknown) => ({ error }))
  await unloading
  expect(cleanupHadStarted).toBe(false)
  const stored = JSON.parse(await readFile(path, 'utf8')) as {
    tables: { tasks: Record<string, unknown> }
  }
  if (operation === 'create') {
    const created = Object.values(stored.tables.tasks)
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      sessionId: 'original', status: 'active', record: { prompt: 'Accepted before unload', kind: 'after' },
    })
    expect(outcome).not.toHaveProperty('error')
    if (!('value' in outcome)) throw new Error('Accepted creation did not return its record')
    expect(created[0]).toEqual({ sessionId: 'original', record: outcome.value, status: 'active',
      deliveryHistory: { records: [], earlierRecordsUnavailable: false } })
  } else {
    expect(stored.tables.tasks).toEqual({})
    expect(outcome).toEqual({ value: { id: 'a-good', deleted: true } })
  }
  expect(admission).toHaveBeenCalledTimes(1)
  expect(admission.mock.results[0]).toMatchObject({ type: 'throw' })
  expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('agent initiator scope is disposed'))
  expect(test.resolve).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(86_400_000)
  expect(admission).toHaveBeenCalledTimes(1)
  expect(test.resolve).not.toHaveBeenCalled()
})

it('supports explicit initialization of a directly constructed service', async () => {
  const { root } = await rootWith({})
  const test = await harness({ direct: true, backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx) })
  expect(await test.service.catalog()).toEqual([])
  expect(test.resolve).not.toHaveBeenCalled()
})

it('logs startup dispatch admission failure without rejecting initialized storage', async () => {
  const { root } = await rootWith({})
  let facility: DomainFacility | undefined
  let admission: MockInstance<Context['agents']['withoutInitiator']> | undefined
  const test = await harness({
    backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx),
    beforeService: async (ctx, storage) => {
      facility = storage
      vi.spyOn(ctx.logger, 'warn')
      admission = vi.spyOn(ctx.agents, 'withoutInitiator').mockImplementationOnce(() => { throw new Error('startup dispatch failed') })
    },
  })
  expect(test.ctx.logger.warn).toHaveBeenCalledExactlyOnceWith('schedule: dispatch stopped: Error: startup dispatch failed')
  expect(await test.service.catalog()).toEqual([])
  expect(facility?.get('schedule')).toBeDefined()
  expect(vi.getTimerCount()).toBe(0)
  await test.service.create(SessionId('original'), {
    prompt: 'Explicit later wake', after_seconds: 60, title: 'Explicit later wake',
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(admission).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(1)
  await test.ctx.fiber.dispose()
  expect(facility?.get('schedule')).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not start dispatch when storage opens after its owner begins unloading', async () => {
  const { root } = await rootWith({ 'a-good': oldTask })
  const acquired = Promise.withResolvers<{
    ctx: Context
    facility: DomainFacility
    launches: () => number
    unload: () => Promise<void>
  }>()
  const release = Promise.withResolvers<undefined>()
  const startup = harness({
    backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx),
    beforeService: async (ctx, facility) => {
      const launch = vi.spyOn(ctx.agents, 'withoutInitiator')
      const install = vi.spyOn(ctx, 'plugin')
      const open = facility.open.bind(facility)
      vi.spyOn(facility, 'open').mockImplementationOnce(async (spec) => {
        const domain = await open(spec)
        acquired.resolve({
          ctx, facility, launches: () => launch.mock.calls.length,
          unload: async () => {
            const result = install.mock.results[0]
            if (result?.type !== 'return') throw new Error('Schedule registration did not return a plugin handle')
            await result.value.dispose()
          },
        })
        await release.promise
        return domain
      })
    },
  })
  let startupFailure = ''
  const settled = startup.then(() => undefined, (error: unknown) => { startupFailure = String(error) })
  try {
    const { ctx, facility, launches, unload } = await acquired.promise
    const disposed = unload()
    release.resolve(undefined)
    await disposed
    await settled
    expect(ctx.get('storageDomain') === facility).toBe(true)
    expect(launches()).toBe(0)
    expect(startupFailure).toContain('cannot create effect on inactive context')
    expect(facility.get('schedule')).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    const reopened = await facility.open(scheduleDomain)
    expect(reopened.table('tasks').get(ScheduleId('a-good'))).toEqual({ ...oldTask, status: 'active' })
    await reopened.close()
  } finally {
    release.resolve(undefined)
    await settled
  }
})

it('retains a hand-authored v1 daily alias, pinned target, and receipt without rewriting bytes', async () => {
  const daily = {
    sessionId: 'daily-session', status: 'active',
    record: {
      id: 'daily', kind: 'daily', title: 'Keep the committed target', prompt: 'Keep the committed target',
      time: '12:00:00.250', timeZone: 'US/Eastern', scheduledAt: '2026-12-01T13:30:00.125Z',
    },
    lastDelivery: {
      scheduledAt: '2026-09-15T16:00:00.250Z', deliveredAt: '2026-09-15T16:00:01.000Z', messageId: 'daily-message',
    },
  }
  const bytes = encoded({ daily })
  const { root, path } = await rootWith({}, bytes)
  const test = await harness({ backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx) })
  const expected = [{
    ...daily.record, sessionId: daily.sessionId, status: daily.status, lastDelivery: daily.lastDelivery,
  }]
  expect(await test.service.catalog()).toEqual(expected)
  expect(test.resolve).not.toHaveBeenCalled()
  expect(await readFile(path, 'utf8')).toBe(bytes)
  await test.ctx.fiber.dispose()
  const reopened = await harness({ backend: new JsonStorageBackend(root), onContext: ctx => contexts.push(ctx) })
  expect(await reopened.service.catalog()).toEqual(expected)
  expect(await readFile(path, 'utf8')).toBe(bytes)
})
