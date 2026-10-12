/** Client operations retain imported history across failures and invalidate old connection responses. */
import { describe, expect, it } from 'vitest'
import type { CodingSessionMirror } from '@deepseek-ai/dsh-coding-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { CodingSessionsController } from '../src/client/controller.ts'
import type { CodingSessionsApi } from '../src/client/controller.ts'
import { fixtureApi, mirror, ok } from './fixtures.client.ts'
const source = mirror.source
function fixture() { const api = fixtureApi(); return { api, controller: new CodingSessionsController(api) } }
describe('coding-session settings controller', () => {
  it('discovers source-labelled pages then makes imported history selectable and readable', async () => {
    const f = fixture(); await f.controller.refreshState(); await f.controller.discover(source); await f.controller.importSession(source)
    expect(f.controller.source.getSnapshot()).toMatchObject({ inventory: { mirrors: [{ id: mirror.id, source: mirror.source }] }, selected: mirror, cursor: 'page-two', discovered: [{ source }] })
    await f.controller.select(mirror.id); expect(f.controller.source.getSnapshot().selected?.events[0]?.text).toBe('Inspect parser'); f.controller.dispose()
  })
  it('keeps selected history on refresh failures and reports a transient failed outcome', async () => {
    const f = fixture(); await f.controller.select(mirror.id)
    f.api.refreshMirror = async () => ({ ok: false, error: new RemoteError('gateway/internal', 'Native unavailable', {}) })
    await f.controller.refreshMirror(mirror.id)
    expect(f.controller.source.getSnapshot()).toMatchObject({ selected: mirror, notice: { kind: 'failed' }, busy: false }); f.controller.dispose()
  })
  it('discards old connection responses after reconnect and disposal', async () => {
    const f = fixture(); let resolve!: (value: Awaited<ReturnType<CodingSessionsApi['detail']>>) => void
    f.api.detail = () => new Promise((done) => { resolve = done })
    const old = f.controller.select(mirror.id); await Promise.resolve()
    f.controller.reconnect(); resolve({ ok: true, value: mirror }); await old
    expect(f.controller.source.getSnapshot().selected).toBeNull()
    f.controller.dispose(); await f.controller.refreshState(); expect(f.controller.source.getSnapshot().selected).toBeNull()
  })
  it('updates selected source capabilities after reloading a disconnected inventory', async () => {
    const f = fixture(); const writable = { ...mirror, capabilities: { ...mirror.capabilities, continue: true, reason: 'exclusive-native-writer' as const } }
    f.api.detail = () => ok(writable); await f.controller.select(mirror.id)
    const { events, ...summary } = mirror
    const unavailable = { ...mirror.capabilities, discover: false, refresh: false, continue: false, reason: 'source-disconnected' as const }
    f.api.getState = () => ok({ sources: [], mirrors: [{ ...summary, eventCount: events.length, capabilities: unavailable }] })
    await f.controller.refreshState()
    expect(f.controller.source.getSnapshot().selected).toMatchObject({ events: mirror.events, capabilities: unavailable })
    f.controller.dispose()
  })
  it('clears stale native ownership fields when mode becomes unknown and the source is removed, retaining reviewed history', async () => {
    const f = fixture()
    const owned: CodingSessionMirror = { ...mirror, sequentialAvailable: true, sequentialReleaseAvailable: true, sequentialToolMode: 'project-tools',
      handoff: { id: mirror.id, source, project: '/fixture/project', expectedRevision: mirror.revision,
        executionSessionId: brandString<NonNullable<CodingSessionMirror['handoff']>['executionSessionId']>('root-a'),
        ownerToken: brandString<NonNullable<CodingSessionMirror['handoff']>['ownerToken']>('owner-a'),
        phase: 'y-owned', toolMode: 'project-tools', nativeProfileUnchanged: true, externalWritersClosed: true,
        dispatchedTurnCount: 0, nativeTurnIds: [] } }
    f.api.detail = () => ok(owned); await f.controller.select(mirror.id)
    const { events, ...summary } = mirror
    f.api.getState = () => ok({
      sources: [{ provider: source.provider, profileId: source.profileId,
        label: 'Fixture source', connected: true, capabilities: mirror.capabilities }],
      mirrors: [{ ...summary, eventCount: events.length, sequentialAvailable: true, sequentialReleaseAvailable: false }],
    })
    await f.controller.refreshState()
    const unknown = f.controller.source.getSnapshot().selected
    expect(unknown).toMatchObject({ events: mirror.events, sequentialAvailable: true, sequentialReleaseAvailable: false })
    expect(unknown).not.toHaveProperty('sequentialToolMode'); expect(unknown).not.toHaveProperty('handoff')
    const unavailable = { ...mirror.capabilities, discover: false, refresh: false, continue: false, reason: 'source-disconnected' as const }
    f.api.getState = () => ok({ sources: [], mirrors: [{ ...summary, eventCount: events.length, capabilities: unavailable }] })
    await f.controller.refreshState()
    const removed = f.controller.source.getSnapshot().selected
    expect(removed).toMatchObject({ source, revision: mirror.revision, events: mirror.events, capabilities: unavailable })
    for (const field of ['sequentialAvailable', 'sequentialReleaseAvailable', 'sequentialToolMode', 'handoff']) expect(removed).not.toHaveProperty(field)
    f.controller.dispose()
  })
  it('disables selected continuation when inventory advances beyond the reviewed transcript', async () => {
    const f = fixture(); const writable = { ...mirror, capabilities: { ...mirror.capabilities, continue: true, reason: 'exclusive-native-writer' as const } }
    f.api.detail = () => ok(writable); await f.controller.select(mirror.id)
    const { events, ...summary } = writable
    f.api.getState = () => ok({ sources: [], mirrors: [{ ...summary, eventCount: events.length + 1, revision: 2 }] })
    await f.controller.refreshState()
    expect(f.controller.source.getSnapshot().selected).toBeNull()
    f.controller.dispose()
  })
  it('clears a discovered page when its configured source becomes unavailable', async () => {
    const f = fixture(); await f.controller.refreshState(); await f.controller.discover(source)
    expect(f.controller.source.getSnapshot().discovered).toHaveLength(1)
    f.api.getState = () => ok({ sources: [], mirrors: [] })
    await f.controller.refreshState()
    expect(f.controller.source.getSnapshot()).toMatchObject({ profile: null, discovered: [], cursor: null })
    f.controller.dispose()
  })
  it('retains execution choices and refreshes blocked ownership after a failed release', async () => {
    const f = fixture()
    const claimed = { ...mirror, sequentialAvailable: true, sequentialReleaseAvailable: true, sequentialToolMode: 'conversation' as const,
      handoff: { id: mirror.id, source: mirror.source, project: '/fixture/project', executionSessionId: brandString<NonNullable<CodingSessionMirror['handoff']>['executionSessionId']>('root-a'), ownerToken: brandString<NonNullable<CodingSessionMirror['handoff']>['ownerToken']>('owner-a'),
        expectedRevision: mirror.revision, phase: 'y-owned' as const, toolMode: 'conversation' as const,
        nativeProfileUnchanged: true as const, externalWritersClosed: true as const, dispatchedTurnCount: 0, nativeTurnIds: [],
      } } satisfies CodingSessionMirror
    f.api.getState = () => ok({ sources: [], mirrors: [], executionSessions: [{ id: claimed.handoff.executionSessionId, project: '/fixture/project' }] })
    f.api.claimSequential = () => ok(claimed)
    f.api.releaseSequential = async () => ({ ok: false, error: new RemoteError('gateway/internal', 'Release unconfirmed', {}) })
    f.api.detail = () => ok({ ...claimed, handoff: { ...claimed.handoff, phase: 'blocked-uncertain' as const } })
    await f.controller.refreshState()
    await f.controller.claimSequential(mirror.id, { source, project: '/fixture/project', expectedRevision: mirror.revision,
      executionSessionId: brandString<NonNullable<CodingSessionMirror['handoff']>['executionSessionId']>('root-a'), externalWritersClosed: true, nativeProfileUnchanged: true })
    expect(f.controller.source.getSnapshot()).toMatchObject({ inventory: { executionSessions: [{ id: claimed.handoff.executionSessionId, project: '/fixture/project' }] }, selected: { handoff: { phase: 'y-owned' } }, notice: { kind: 'claimed' } })
    await f.controller.releaseSequential(mirror.id)
    expect(f.controller.source.getSnapshot()).toMatchObject({ selected: { events: mirror.events, handoff: { phase: 'blocked-uncertain' } }, notice: { kind: 'failed' }, busy: false })
    f.controller.dispose()
  })

})
