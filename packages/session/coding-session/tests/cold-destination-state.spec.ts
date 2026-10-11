/** Stored metadata and detached transaction faults exercise cold import admission without native writers. */
import { Context } from '@deepseek-ai/cordis'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { brandString } from '@deepseek-ai/dsh-brand'
import SessionStore, { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistence, { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandle, SessionAccess, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it, onTestFinished } from 'vitest'
import { CodingSessionColdDestinations } from '../src/cold-destinations.ts'
import { codingSessionDigest } from '../src/digest.ts'
import type { CodingSessionImportRecoveryIntent } from '../src/linked-import-types.ts'

class MemoryPersistence extends SessionPersistence {
  header!: SessionHeader
  events: readonly SessionEvent[] = []
  snapshots: readonly SessionPersistenceSnapshot[] = []
  metadata: SessionPersistenceSnapshot | undefined
  opened = 0
  closed = 0
  appended = 0
  afterOpen: (() => void) | undefined
  afterRead: (() => void) | undefined
  override async create(header: SessionHeader): Promise<SessionHandle> { this.header = header; return this.open(header.id, 'write') }
  override async open(id: SessionId, access: SessionAccess): Promise<SessionHandle> {
    this.opened++; this.afterOpen?.()
    let released = false
    const close = async () => { if (!released) { released = true; this.closed++ } }
    return { id, header: this.header, access, inheritedEventCount: SessionLogOffset(0),
      read: async () => { this.afterRead?.(); return { events: structuredClone(this.events), eventState: 'detached' } },
      append: async (events) => { this.appended++; this.events = [...this.events, ...structuredClone(events)] },
      flush: async () => {}, close, [Symbol.asyncDispose]: close }
  }
  override async flush(): Promise<void> {}
  override async stat(): Promise<SessionPersistenceSnapshot | undefined> { return this.metadata }
  override async list(): Promise<readonly SessionPersistenceSnapshot[]> { return this.snapshots }
}
async function fixture(change: Partial<{ maxEvents: number; maxBytes: number; maxRecords: number }> = {}) {
  const ctx = new Context(); await ctx.plugin(SessionStore)
  const persistence = new MemoryPersistence(ctx)
  const session = ctx.sessions.prepare(brandString<SessionId>('cold-state-destination'), { meta: { cwd: '/fixture/project' } })
  persistence.header = session.header
  const cold = new CodingSessionColdDestinations(ctx, { maxEvents: 100, maxBytes: 100000, maxRecords: 10, timeoutMs: 1000, ...change })
  onTestFinished(async () => { await cold.close(); await ctx.fiber.dispose() })
  const snapshot = (header: SessionHeader): SessionPersistenceSnapshot => ({ header, revision: SessionPersistenceRevision('fixture-revision') })
  return { ctx, persistence, cold, session, snapshot, id: session.id }
}

// Removing root-only filtering would expose stored child sessions as import destinations.
describe('cold destination metadata admission', () => {
  it('lists only absolute project roots and reports live roots without reading histories', async () => {
    const f = await fixture()
    const live = f.ctx.sessions.create(brandString<SessionId>('live-root'), { meta: { cwd: '/fixture/live' } })
    const { cwd: _cwd, ...unknownProject } = f.session.header
    f.persistence.snapshots = [f.snapshot({ ...f.session.header, origin: 'subagent' }), f.snapshot(unknownProject),
      f.snapshot({ ...f.session.header, cwd: 'relative-project' }), f.snapshot(f.session.header), f.snapshot(live.header)]
    expect(await f.cold.list()).toEqual([{ id: f.id, project: '/fixture/project', live: false }, { id: live.id, project: '/fixture/live', live: true }])
    expect(f.persistence.opened).toBe(0)
  })
  it('refuses an inventory exceeding the destination count budget', async () => {
    const f = await fixture({ maxRecords: 1 })
    f.persistence.snapshots = [f.snapshot(f.session.header), f.snapshot({ ...f.session.header, id: brandString<SessionId>('second-root') })]
    await expect(f.cold.list()).rejects.toThrow(/count limit/); expect(f.persistence.opened).toBe(0)
  })
  it('refuses complete inventory bytes before returning metadata', async () => {
    const f = await fixture({ maxBytes: 1 }); f.persistence.snapshots = [f.snapshot(f.session.header)]
    await expect(f.cold.list()).rejects.toThrow(/UTF-8 byte limit/)
  })
  it('refuses a relative project without creating a stored destination', async () => {
    const f = await fixture(); await expect(f.cold.create('relative-project')).rejects.toThrow(/absolute native project/)
    expect(f.persistence.opened).toBe(0)
  })
})

// Removing preflight or full-log limits would admit a stored log beyond the configured budget.
describe('cold destination stored history limits', () => {
  it.each([{ eventCount: 101 }, { eventCount: 1, sizeBytes: 100001 }, { sizeBytes: 100001 }])('refuses over-budget stored metadata %j before handle acquisition', async (metadata) => {
    const f = await fixture(); f.persistence.metadata = { ...f.snapshot(f.session.header), ...metadata }
    await expect(f.cold.inspect(f.id)).rejects.toThrow(/complete event or byte limit/); expect(f.persistence.opened).toBe(0)
  })
  it.each([{ eventCount: 0 }, { sizeBytes: 0 }, { eventCount: 0, sizeBytes: 0 }, {}])('admits metadata without a complete body estimate %j', async (metadata) => {
    const f = await fixture(); f.persistence.metadata = { ...f.snapshot(f.session.header), ...metadata }
    expect(await f.cold.inspect(f.id)).toEqual({ id: f.id, events: [] }); expect(f.persistence.closed).toBe(1)
  })
  it('refuses a full canonical log over its event limit and releases the read handle', async () => {
    const f = await fixture({ maxEvents: 1 }); f.session.append('turn/start', { turn: 1 }); f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    f.persistence.events = f.session.snapshotEvents()
    await expect(f.cold.inspect(f.id)).rejects.toThrow(/event limit/); expect(f.persistence.closed).toBe(1)
  })
  it.each(['read', 'write'] as const)('refuses child-session destinations for %s and closes ownership', async (access) => {
    const f = await fixture(); f.persistence.header = { ...f.session.header, origin: 'subagent' }
    const result = access === 'read' ? f.cold.inspect(f.id) : f.cold.withDestination(f.id, async () => 'unexpected')
    await expect(result).rejects.toThrow(/ordinary-Y root/); expect(f.persistence.closed).toBe(1)
  })
})

// Removing the exact single suffix reservation or either flush limit would persist unreviewed events.
describe('cold destination suffix transactions', () => {
  it('refuses a second admitted suffix without persisting either suffix', async () => {
    const f = await fixture()
    await expect(f.cold.withDestination(f.id, async (destination) => {
      await destination.appendRecorded([]); await destination.appendRecorded([])
    })).rejects.toThrow(/already admitted/)
    expect(f.persistence.events).toEqual([]); expect(f.persistence.closed).toBe(1)
  })
  it('refuses flush before the planned suffix is admitted', async () => {
    const f = await fixture()
    await expect(f.cold.withDestination(f.id, destination => destination.flush())).rejects.toThrow(/not admitted/)
    expect(f.persistence.appended).toBe(0); expect(f.persistence.closed).toBe(1)
  })
  it('refuses suffix event overflow before durable append', async () => {
    const f = await fixture({ maxEvents: 1 })
    f.session.append('turn/start', { turn: 1 }); f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect(f.cold.withDestination(f.id, async (destination) => {
      await destination.appendRecorded(f.session.snapshotEvents()); await destination.flush()
    })).rejects.toThrow(/event limit/)
    expect(f.persistence.events).toEqual([]); expect(f.persistence.closed).toBe(1)
  })
  it('detaches recorded events and refreshes its canonical prefix after flush', async () => {
    const f = await fixture(); f.session.append('turn/start', { turn: 1 }); f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const batch = [...f.session.snapshotEvents()]
    const result = await f.cold.withDestination(f.id, async (destination) => {
      await destination.appendRecorded(batch); batch.splice(0)
      await destination.flush(); expect(destination.persistedEvents.map(event => event.type)).toEqual(['turn/start', 'turn/end'])
      await destination.appendRecorded([]); await destination.flush(); return destination.persistedEvents.length
    })
    expect(result).toBe(2); expect(f.persistence.closed).toBe(1)
  })
})

// A pending initializer only authorizes its exact reviewed prefix; another interrupted log remains unavailable.
describe('cold destination interrupted prefix recovery', () => {
  it.each(['absent', 'short-before', 'wrong-digest', 'interrupted-before', 'long-suffix', 'edited-suffix', 'exact'] as const)('handles %s prepared recovery without silently repairing a different turn', async (kind) => {
    const f = await fixture(); const opening = f.session.append('turn/start', { turn: 1 }); f.persistence.events = [opening]
    const events = [opening]
    const recovery: CodingSessionImportRecoveryIntent = { before: { eventCount: 0, digest: codingSessionDigest([]) }, append: events }
    let intent: CodingSessionImportRecoveryIntent | undefined = recovery
    switch (kind) {
      case 'absent': intent = undefined; break
      case 'short-before': intent = { ...recovery, before: { eventCount: events.length + 1, digest: codingSessionDigest(events) } }; break
      case 'wrong-digest': intent = { ...recovery, before: { eventCount: 0, digest: 'wrong-digest' } }; break
      case 'interrupted-before': intent = { ...recovery, before: { eventCount: events.length, digest: codingSessionDigest(events) } }; break
      case 'long-suffix': intent = { ...recovery, append: [] }; break
      case 'edited-suffix': intent = { ...recovery, append: events.map(event => ({ ...event, time: event.time + 1 })) }; break
      case 'exact': break
      default: assertNever(kind)
    }
    const work = f.cold.withDestination(f.id, async destination => destination.persistedEvents.map(event => event.type), intent)
    if (kind === 'exact') expect(await work).toEqual(['turn/start'])
    else await expect(work).rejects.toThrow(/interrupted destination/)
    expect(f.persistence.events).toEqual(events); expect(f.persistence.closed).toBe(1)
  })
})

// Losing service identity or making the destination live must invalidate an admitted detached operation.
describe('cold destination lifetime ownership', () => {
  it('refuses a destination that becomes live after read', async () => {
    const f = await fixture(); f.persistence.afterRead = () => { f.ctx.sessions.create(f.id, { meta: { cwd: '/fixture/project' } }) }
    await expect(f.cold.inspect(f.id)).rejects.toThrow(/destination is live/); expect(f.persistence.closed).toBe(1)
  })
  it('refuses a destination made live while the write handle opens', async () => {
    const f = await fixture(); f.persistence.afterOpen = () => { f.ctx.sessions.create(f.id, { meta: { cwd: '/fixture/project' } }) }
    await expect(f.cold.withDestination(f.id, async () => 'unexpected')).rejects.toThrow(/destination is live/); expect(f.persistence.closed).toBe(1)
  })
  it('refuses a closed adapter even when the durable services remain present', async () => {
    const f = await fixture(); await f.cold.close(); expect(f.cold.available()).toBe(false)
    await expect(f.cold.inspect(f.id)).rejects.toThrow(/disposed/); expect(f.persistence.opened).toBe(0)
  })
})
