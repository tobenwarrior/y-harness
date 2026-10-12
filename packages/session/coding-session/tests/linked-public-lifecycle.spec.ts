/** Public import/recovery refusals preserve complete destination and journal histories. */
import { describe, expect, it, onTestFinished } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { CodingSessionMirror, CodingSessionLinkId } from '../src/types.ts'
import { linkedFixture, linkedMirror } from './linked-admission-fixture.ts'

describe('linked import public lifecycle admission', () => {
  it('uses the cold destination fallback and refuses a changed identity in either inspection path', async () => {
    const f = linkedFixture(); onTestFinished(() => f.manager.close())
    const expected = await f.manager.inspectDestination(f.id)
    delete f.options.inspectDestination
    expect(await f.manager.inspectDestination(f.id)).toEqual(expected)
    f.options.inspectDestination = async () => ({ id: f.other, events: f.slot().events })
    await expect(f.manager.inspectDestination(f.id)).rejects.toThrow('identity changed')
    delete f.options.inspectDestination; const withDestination = f.options.withDestination.bind(f.options)
    f.options.withDestination = (id, use, recovery) => withDestination(id, (destination) => {
      destination.session = Session.create(f.other, undefined, { ...destination.session.header, id: f.other })
      return use(destination)
    }, recovery)
    await expect(f.manager.inspectDestination(f.id)).rejects.toThrow('identity changed')
  })
  it('returns detached metadata and detached retained conflict attribution', async () => {
    const f = linkedFixture(); onTestFinished(() => f.manager.close())
    const first = await f.manager.importMirror(linkedMirror(), await f.acknowledgement())
    const summaries = f.manager.state()
    expect(summaries).toEqual([expect.objectContaining({ generationCount: 1, importedEventCount: 1, prepared: false })])
    expect(JSON.stringify(summaries)).not.toContain('Synthetic public history')
    summaries[0]!.source.nativeSessionId = brandString<CodingSessionMirror['source']['nativeSessionId']>('detached')
    const divergent = { ...linkedMirror(2), status: 'conflict' as const, conflict: 'history-diverged' as const }
    const conflict = await f.manager.importMirror(divergent, await f.acknowledgement(2, first.revision))
    expect(f.manager.state()[0]).toMatchObject({ source: linkedMirror().source, status: 'conflict', conflict: 'history-diverged' })
    await expect(f.manager.importMirror(linkedMirror(3), await f.acknowledgement(3, conflict.revision))).rejects.toThrow('has a conflict')
  })
  it('refuses absent journals and stale native/link revisions without writing history', async () => {
    const f = linkedFixture(); onTestFinished(() => f.manager.close())
    expect(() => f.manager.detail(brandString<CodingSessionLinkId>('missing'))).toThrow('not found')
    const before = f.slot().events
    await expect(f.manager.importMirror(linkedMirror(), await f.acknowledgement(2))).rejects.toThrow('native mirror changed')
    await expect(f.manager.importMirror(linkedMirror(), await f.acknowledgement(1, 1))).rejects.toThrow('linked history changed')
    expect(f.records.size).toBe(0); expect(f.slot().events).toEqual(before)
  })
  it.each(['unknown-project', 'relative-project', 'conflict'])('refuses %s native history before first import', async (mode) => {
    const f = linkedFixture(); onTestFinished(() => f.manager.close()); const before = f.slot().events
    const mirror = linkedMirror()
    if (mode === 'unknown-project') delete mirror.cwd
    else if (mode === 'relative-project') mirror.cwd = 'relative/project'
    else { mirror.status = 'conflict'; mirror.conflict = 'history-diverged' }
    await expect(f.manager.importMirror(mirror, await f.acknowledgement())).rejects.toThrow(mode === 'conflict' ? 'history conflict' : 'absolute project')
    expect(f.records.size).toBe(0); expect(f.slot().events).toEqual(before)
  })
  it('refuses a second destination for an active original source while allowing it after rollback', async () => {
    const f = linkedFixture(); onTestFinished(() => f.manager.close())
    const first = await f.manager.importMirror(linkedMirror(), await f.acknowledgement()); const before = f.slot(f.other).events
    await expect(f.manager.importMirror(linkedMirror(), await f.acknowledgement(1, undefined, f.other))).rejects.toThrow('another Y destination')
    expect(f.slot(f.other).events).toEqual(before)
    const rolled = await f.manager.rollback(first.id, { expectedLinkRevision: first.revision,
      expectedDestinationRevision: (await f.manager.inspectDestination(f.id)).revision })
    expect(await f.manager.rollback(rolled.id, { expectedLinkRevision: rolled.revision,
      expectedDestinationRevision: (await f.manager.inspectDestination(f.id)).revision })).toEqual(rolled)
    const moved = await f.manager.importMirror(linkedMirror(), await f.acknowledgement(1, undefined, f.other))
    expect(moved.destinationSessionId).toBe(f.other)
  })
  it('keeps independent original sources linked to their distinct selected destinations', async () => {
    const f = linkedFixture(); onTestFinished(() => f.manager.close())
    const first = await f.manager.importMirror(linkedMirror(), await f.acknowledgement())
    const secondMirror = { ...linkedMirror(), id: brandString<CodingSessionMirror['id']>('independent-mirror'),
      source: { ...linkedMirror().source, nativeSessionId: brandString<CodingSessionMirror['source']['nativeSessionId']>('independent-original') } }
    const second = await f.manager.importMirror(secondMirror, await f.acknowledgement(1, undefined, f.other))
    expect(second.id).not.toBe(first.id); expect(second.destinationSessionId).toBe(f.other)
    expect(f.manager.detail(first.id)).toEqual(first); expect(f.manager.state()).toHaveLength(2)
  })
  it('bounds new and retained record inventories separately', async () => {
    const f = linkedFixture(true, { maxRecords: 0 }); onTestFinished(() => f.manager.close())
    await expect(f.manager.importMirror(linkedMirror(), await f.acknowledgement())).rejects.toThrow('record limit')
    f.options.maxRecords = 1; const first = await f.manager.importMirror(linkedMirror(), await f.acknowledgement())
    f.options.maxRecords = 0; expect(() => f.manager.detail(first.id)).not.toThrow()
    expect(() => f.manager.state()).toThrow('record limit')
  })
  it('refuses an older mirror, changed mirror identity and changed destination project before append', async () => {
    const f = linkedFixture(); onTestFinished(() => f.manager.close())
    const first = await f.manager.importMirror(linkedMirror(2), await f.acknowledgement(2)); const before = f.slot().events
    await expect(f.manager.importMirror(linkedMirror(1), await f.acknowledgement(1, first.revision))).rejects.toThrow('older')
    await expect(f.manager.importMirror({ ...linkedMirror(3), id: brandString<CodingSessionMirror['id']>('other-mirror') }, await f.acknowledgement(3, first.revision))).rejects.toThrow('mirror or destination project changed')
    f.slot().header = { ...f.slot().header, cwd: '/fixture/other-project' }
    await expect(f.manager.importMirror(linkedMirror(3), await f.acknowledgement(3, first.revision))).rejects.toThrow('identity, project or canonical log changed')
    expect(f.slot().events).toEqual(before)
  })
  it('updates native metadata without appending a second quoted generation', async () => {
    const f = linkedFixture(); onTestFinished(() => f.manager.close())
    const first = await f.manager.importMirror(linkedMirror(), await f.acknowledgement()); const before = f.slot().events
    const updated = await f.manager.importMirror({ ...linkedMirror(2), title: 'Updated native title' }, await f.acknowledgement(2, first.revision))
    expect(updated.revision).toBe(2); expect(updated.generations).toEqual(first.generations)
    expect(updated.mirror.title).toBe('Updated native title'); expect(f.slot().events).toEqual(before)
  })
  it('initializes the next local turn after an empty log-only reservation', async () => {
    const f = linkedFixture(false); onTestFinished(() => f.manager.close())
    const before = Session.create(f.id, f.slot().events, f.slot().header)
    before.append('turn/start', { turn: 1 }); before.append('step/start', { turn: 1, step: 1 })
    before.append('step/end', { turn: 1, step: 1 }); before.append('turn/end', { turn: 1, reason: { kind: 'blocked' } })
    f.slot().events = before.snapshotEvents(); const prefix = structuredClone(f.slot().events)
    const record = await f.manager.importMirror(linkedMirror(), await f.acknowledgement())
    const tail = f.slot().events.slice(prefix.length)
    expect(f.slot().events.slice(0, prefix.length)).toEqual(prefix)
    expect(tail.find(event => event.type === 'turn/start')).toMatchObject({ data: { turn: 2 } })
    expect(tail.find(event => event.type === 'turn/end')).toMatchObject({ data: { turn: 2, reason: { kind: 'blocked' } } })
    expect(record.generations).toHaveLength(1)
  })
  it.each(['event-bound', 'duplicate-native-identity', 'inconsistent-native-digest'])('refuses %s mirror admission before destination acquisition', async (mode) => {
    const f = linkedFixture(); onTestFinished(() => f.manager.close()); const mirror = linkedMirror(); const before = f.slot().events
    if (mode === 'event-bound') f.options.maxEvents = 0
    else if (mode === 'duplicate-native-identity') mirror.events.push({ ...mirror.events[0]! })
    else mirror.digest = 'Inconsistent canonical digest'
    await expect(f.manager.importMirror(mirror, await f.acknowledgement())).rejects.toThrow('inconsistent identities')
    expect(f.records.size).toBe(0); expect(f.slot().events).toEqual(before)
  })
  it('refuses a schema-admitted initializer whose next local turn disagrees with its retained empty surface', async () => {
    const f = linkedFixture(false); onTestFinished(() => f.manager.close()); f.flush('reject-before')
    await expect(f.manager.importMirror(linkedMirror(), await f.acknowledgement())).rejects.toThrow('Synthetic flush unavailable')
    const prepared = structuredClone([...f.records.values()][0]!)
    const pending = prepared.pending
    if (pending === undefined) throw new Error('Expected captured initializer')
    pending.append = pending.append.map((event) => {
      switch (event.type) {
        case 'turn/start': return { ...event, data: { ...event.data, turn: 2 } }
        case 'step/start': return { ...event, data: { ...event.data, turn: 2 } }
        case 'system/message': return { ...event, data: { ...event.data, turn: 2 } }
        case 'step/end': return { ...event, data: { ...event.data, turn: 2 } }
        case 'turn/end': return { ...event, data: { ...event.data, turn: 2 } }
        case 'session/end-seed': case 'user/message': case 'coding-session/import-initialization': return event
        default: return assertNever(event)
      }
    })
    f.persist(prepared); const before = structuredClone(f.slot().events); f.flush('publish')
    await expect(f.manager.recover(prepared.id)).rejects.toThrow('next local turn')
    expect(f.slot().events).toEqual(before); expect(f.manager.detail(prepared.id)).toEqual(prepared)
  })
  it.each(['owned', 'foreign-link', 'foreign-mirror', 'foreign-source'])('distinguishes a standalone %s initializer receipt during abandonment', async (mode) => {
    const f = linkedFixture(false); onTestFinished(() => f.manager.close()); f.flush('reject-before')
    await expect(f.manager.importMirror(linkedMirror(), await f.acknowledgement())).rejects.toThrow('Synthetic flush unavailable')
    const prepared = structuredClone([...f.records.values()][0]!)
    const initializer = prepared.pending?.append.find(event => event.type === 'coding-session/import-initialization')
    if (initializer?.type !== 'coding-session/import-initialization') throw new Error('Expected captured initializer receipt')
    const session = Session.create(f.id, f.slot().events, f.slot().header)
    session.append('coding-session/import-initialization', { ...initializer.data,
      linkId: mode === 'foreign-link' ? brandString<CodingSessionLinkId>('foreign-link') : initializer.data.linkId,
      mirrorId: mode === 'foreign-mirror' ? brandString<CodingSessionMirror['id']>('foreign-mirror') : initializer.data.mirrorId,
      source: mode === 'foreign-source' ? { ...initializer.data.source,
        nativeSessionId: brandString<CodingSessionMirror['source']['nativeSessionId']>('foreign-original') } : initializer.data.source,
    }, { ignorable: true })
    f.slot().events = session.snapshotEvents(); const before = structuredClone(f.slot().events)
    const acknowledgement = { expectedLinkRevision: prepared.revision,
      expectedDestinationRevision: (await f.manager.inspectDestination(f.id)).revision }
    if (mode === 'owned') {
      await expect(f.manager.abandonPrepared(prepared.id, acknowledgement)).rejects.toThrow('owned prepared payload was already appended')
      expect(f.manager.detail(prepared.id).pending).toBeDefined()
    } else expect((await f.manager.abandonPrepared(prepared.id, acknowledgement)).pending).toBeUndefined()
    expect(f.slot().events).toEqual(before)
  })
  it.each(['edited-prefix', 'truncated-prefix'])('refuses recovery over a %s without rewriting retained destination events', async (mode) => {
    const f = linkedFixture(); onTestFinished(() => f.manager.close()); f.flush('reject-before')
    await expect(f.manager.importMirror(linkedMirror(), await f.acknowledgement())).rejects.toThrow('Synthetic flush unavailable')
    const prepared = f.manager.state()[0]!
    f.slot().events = mode === 'edited-prefix' ? f.slot().events.map((event, index) => index === 0
      ? { ...event, time: event.time + 1 } : event) : []
    const before = structuredClone(f.slot().events); const receipt = JSON.stringify(f.records.get(prepared.id))
    f.flush('publish')
    await expect(f.manager.recover(prepared.id)).rejects.toThrow('prepared destination prefix changed')
    expect(f.slot().events).toEqual(before); expect(JSON.stringify(f.records.get(prepared.id))).toBe(receipt)
  })
  it('refuses rollback when an imported destination node is no longer present in the canonical log', async () => {
    const f = linkedFixture(); onTestFinished(() => f.manager.close())
    const first = await f.manager.importMirror(linkedMirror(), await f.acknowledgement())
    f.slot().events = f.slot().events.slice(0, first.generations[0]!.destinationSeq)
    const before = structuredClone(f.slot().events)
    await expect(f.manager.rollback(first.id, { expectedLinkRevision: first.revision,
      expectedDestinationRevision: (await f.manager.inspectDestination(f.id)).revision })).rejects.toThrow('owned imported node changed')
    expect(f.slot().events).toEqual(before); expect(f.manager.detail(first.id)).toEqual(first)
  })
  it('retains prepared writes when flush resolves without making append durable', async () => {
    const f = linkedFixture(); onTestFinished(() => f.manager.close()); const before = f.slot().events
    f.flush('omit'); await expect(f.manager.importMirror(linkedMirror(), await f.acknowledgement())).rejects.toThrow('did not become durable')
    const prepared = f.manager.state()[0]!
    expect(prepared.prepared).toBe(true); expect(f.slot().events).toEqual(before)
    await expect(f.manager.importMirror(linkedMirror(), await f.acknowledgement())).rejects.toThrow('prepared write')
    await expect(f.manager.rollback(prepared.id, { expectedLinkRevision: prepared.revision,
      expectedDestinationRevision: (await f.manager.inspectDestination(f.id)).revision })).rejects.toThrow('prepared write')
    await expect(f.manager.recover(prepared.id)).rejects.toThrow('did not become durable')
    f.flush('publish'); expect((await f.manager.recover(prepared.id)).pending).toBeUndefined()
  })
  it('returns committed recovery unchanged and refuses abandonment without a pending receipt', async () => {
    const f = linkedFixture(); onTestFinished(() => f.manager.close())
    const first = await f.manager.importMirror(linkedMirror(), await f.acknowledgement())
    expect(await f.manager.recover(first.id)).toEqual(first)
    await expect(f.manager.abandonPrepared(first.id, { expectedLinkRevision: first.revision,
      expectedDestinationRevision: (await f.manager.inspectDestination(f.id)).revision })).rejects.toThrow('no prepared write')
  })
  it('refuses new inspection, inventory and queued mutations after close', async () => {
    const f = linkedFixture(); await f.manager.close()
    await expect(f.manager.inspectDestination(f.id)).rejects.toThrow('closed')
    expect(() => f.manager.state()).toThrow('closed')
    await expect(f.manager.importMirror(linkedMirror(), { destinationSessionId: SessionId('unused'), expectedMirrorRevision: 1,
      expectedDestinationRevision: { eventCount: 0, digest: 'unused' } })).rejects.toThrow('closed')
  })
})
