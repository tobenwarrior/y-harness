/** Review, cancellation and transport failures retain history without replaying writes. */
import { describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { CodingSessionImportAcknowledgement, CodingSessionLinkRecord, CodingSessionMirror } from '@deepseek-ai/dsh-coding-session/types'
import { CodingSessionsController } from '../src/client/controller.ts'
import type { CodingSessionsApi } from '../src/client/controller.ts'
import { fixtureApi, mirror, ok } from './fixtures.client.ts'
import { coldId, destinationRevision, link, summary, interrupted, linkedFixture } from './linked-fixtures.client.ts'
const importAck = { destinationSessionId: coldId, expectedDestinationRevision: destinationRevision, expectedMirrorRevision: 1 }
const rollbackAck = { expectedLinkRevision: 1, expectedDestinationRevision: destinationRevision }
const recoveryAck = { source: interrupted.source, project: interrupted.cwd!, expectedRevision: 1,
  expectedOwnerToken: interrupted.handoff!.ownerToken, externalWritersClosed: true,
  nativeProfileUnchanged: true, acceptUnresolvedTurns: true }
const pending: CodingSessionLinkRecord = { ...link, pending: { kind: 'import', before: destinationRevision, append: [], nextMirror: mirror, nextGenerations: [] } }
function deferred<T>() { let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve } }
async function selected(api: CodingSessionsApi = linkedFixture()) {
  const controller = new CodingSessionsController(api)
  await controller.refreshState(); await controller.select(mirror.id)
  return controller
}
async function reviewed(api = linkedFixture(mirror, [link])) {
  const controller = await selected(api); await controller.selectLink(link.id); await controller.reviewImportDestination(coldId)
  return controller
}
function unavailable(): never { throw new Error('Injected transport failure') }
async function settle(controller: CodingSessionsController) {
  await vi.waitFor(() => { expect(controller.source.getSnapshot().busy).toBe(false) })
}
describe('coding-session state and review lifecycle', () => {
  it('appends only unseen sessions from the same source and resets the page when the source changes', async () => {
    const api = fixtureApi(); const cursors: Array<string | undefined> = []
    api.discover = (_profile, cursor) => { cursors.push(cursor)
      return ok({ items: [{ source: mirror.source, title: mirror.title, writerState: 'idle' }] }) }
    const controller = new CodingSessionsController(api)
    await controller.discover(mirror.source); await controller.discover(mirror.source, true)
    expect(cursors).toEqual([undefined, undefined]); expect(controller.source.getSnapshot().discovered).toHaveLength(1)
    api.discover = (_profile, cursor) => { cursors.push(cursor); return ok({ items: [], nextCursor: 'next' }) }
    await controller.discover(mirror.source); await controller.discover(mirror.source, true)
    const different = { ...mirror.source, profileId: brandString<typeof mirror.source.profileId>('second-profile') }
    await controller.discover(different, true)
    expect(cursors).toEqual([undefined, undefined, undefined, 'next', undefined])
    expect(controller.source.getSnapshot()).toMatchObject({ profile: different, discovered: [], cursor: 'next' })
    controller.dispose()
  })
  it('retains current ownership and discovery when inventory still supports the reviewed source', async () => {
    const api = fixtureApi(); const owned: CodingSessionMirror = { ...interrupted, sequentialReleaseAvailable: true }
    const { events, ...metadata } = owned
    api.detail = () => ok(owned)
    api.getState = () => ok({ sources: [{ provider: owned.source.provider, profileId: owned.source.profileId, connected: true, label: 'Fixture', capabilities: owned.capabilities }], mirrors: [{ ...metadata, eventCount: events.length }] })
    const controller = await selected(api); await controller.discover(mirror.source); await controller.refreshState()
    expect(controller.source.getSnapshot()).toMatchObject({ selected: { handoff: owned.handoff, sequentialToolMode: 'conversation', sequentialReleaseAvailable: true }, discovered: [{ source: mirror.source }] })
    controller.dispose()
  })
  it('drops a changed prepared link when its detail capability disappears', async () => {
    const api = linkedFixture(mirror, [link]); const controller = await reviewed(api)
    const state = await api.getState(); if (!state.ok) throw new Error('Fixture inventory unavailable')
    api.getState = () => ok({ ...state.value, links: [summary(pending)] }); delete api.linkedDetail
    await controller.refreshState()
    expect(controller.source.getSnapshot()).toMatchObject({
      selected: { events: mirror.events }, selectedLink: null, reviewedDestination: null,
    })
    controller.dispose()
  })
  it.each(['method', 'mirror', 'revision', 'owner'] as const)('refuses recovery after its reviewed %s changes', async (reason) => {
    const api = linkedFixture(interrupted); const recovery = vi.spyOn(api, 'recoverSequential'); const controller = await selected(api)
    const ack = { ...recoveryAck }
    let id = mirror.id
    if (reason === 'method') delete api.recoverSequential
    if (reason === 'mirror') id = brandString<typeof id>('unreviewed-mirror')
    if (reason === 'revision') ack.expectedRevision = 2
    if (reason === 'owner') ack.expectedOwnerToken = brandString<typeof ack.expectedOwnerToken>('different-owner')
    await controller.recoverSequential(id, ack)
    expect(recovery).not.toHaveBeenCalled()
    expect(controller.source.getSnapshot()).toMatchObject({ notice: { kind: 'failed' }, selected: { events: mirror.events } })
    controller.dispose()
  })
  it('reports an unacknowledged recovered owner as failure while retaining its returned history', async () => {
    const api = linkedFixture(interrupted); api.recoverSequential = () => ok(interrupted)
    const controller = await selected(api); await controller.recoverSequential(mirror.id, recoveryAck)
    expect(controller.source.getSnapshot()).toMatchObject({ selected: interrupted, notice: { kind: 'failed' }, busy: false })
    controller.dispose()
  })
  it.each(['none', 'project', 'conflict', 'capability'] as const)('refuses destination creation for a mirror missing %s review support', async (reason) => {
    const api = linkedFixture(); const create = vi.spyOn(api, 'createImportDestination')
    if (reason === 'project') { const { cwd: _cwd, ...withoutProject } = mirror; api.detail = () => ok(withoutProject) }
    if (reason === 'conflict') api.detail = () => ok({ ...mirror, status: 'conflict', conflict: 'history-diverged' })
    if (reason === 'capability') { const inventory = await api.getState()
      if (!inventory.ok) throw new Error('Fixture unavailable')
      api.getState = () => ok({ ...inventory.value, linkedImportsAvailable: false }) }
    const controller = new CodingSessionsController(api)
    await controller.refreshState()
    if (reason !== 'none') await controller.select(mirror.id)
    await controller.createImportDestination(mirror.id)
    expect(create).not.toHaveBeenCalled()
    expect(controller.source.getSnapshot()).toMatchObject({ reviewedDestination: null, notice: { kind: 'failed' }, busy: false })
    controller.dispose()
  })
  it.each(['create', 'inspect', 'link-detail'] as const)('reports the unavailable %s capability without dispatching a write', async (reason) => {
    const api = linkedFixture(); const controller = await selected(api)
    if (reason === 'create') { delete api.createImportDestination
      await controller.createImportDestination(mirror.id)
      expect(controller.source.getSnapshot().notice?.kind).toBe('failed') }
    if (reason === 'inspect') { delete api.inspectImportDestination
      await controller.reviewImportDestination(coldId)
      expect(controller.source.getSnapshot().queryError).toBe(true) }
    if (reason === 'link-detail') { delete api.linkedDetail
      await controller.selectLink(link.id)
      expect(controller.source.getSnapshot().queryError).toBe(true) }
    expect(controller.source.getSnapshot().selected?.events).toEqual(mirror.events); controller.dispose()
  })
  it('rejects a destination inspection that returns a different session', async () => {
    const api = linkedFixture()
    api.inspectImportDestination = () => ok({ destinationSessionId: brandString<typeof coldId>('wrong-destination'), revision: destinationRevision })
    const controller = await selected(api); await controller.reviewImportDestination(coldId)
    expect(controller.source.getSnapshot()).toMatchObject({ queryError: true, reviewedDestination: null }); controller.dispose()
  })
  it.each(['mirror-revision', 'destination-events', 'destination-digest', 'link-revision', 'method', 'pending', 'mapping'] as const)('refuses quoted writes when the %s review is stale', async (reason) => {
    const api = linkedFixture(mirror, [reason === 'pending' ? pending : link]); const write = vi.spyOn(api, 'importIntoSession')
    const controller = await reviewed(api)
    const ack: CodingSessionImportAcknowledgement = { ...importAck, expectedLinkRevision: 1 }
    if (reason === 'mirror-revision') ack.expectedMirrorRevision = 2
    if (reason === 'destination-events') ack.expectedDestinationRevision = { ...destinationRevision, eventCount: 4 }
    if (reason === 'destination-digest') ack.expectedDestinationRevision = { ...destinationRevision, digest: 'changed-digest' }
    if (reason === 'link-revision') ack.expectedLinkRevision = 2
    if (reason === 'method') delete api.importIntoSession
    if (reason === 'mapping') { await controller.select(mirror.id)
      await controller.reviewImportDestination(coldId)
      delete ack.expectedLinkRevision }
    await controller.importIntoSession(mirror.id, ack)
    expect(write).not.toHaveBeenCalled()
    expect(controller.source.getSnapshot()).toMatchObject({ notice: { kind: 'failed' }, reviewedDestination: null, selected: { events: mirror.events } })
    controller.dispose()
  })
  it.each(['rollback', 'abandon'] as const)('refuses %s when there is no reviewed link or its required method is absent', async (operation) => {
    const api = linkedFixture(mirror, [operation === 'abandon' ? pending : link]); const controller = await reviewed(api)
    const method = operation === 'rollback' ? 'rollbackImport' : 'abandonImport'; const write = vi.spyOn(api, method)
    await controller[method](link.id, { ...rollbackAck, expectedLinkRevision: 2 }); expect(write).not.toHaveBeenCalled()
    await controller.reviewImportDestination(coldId); if (operation === 'rollback') delete api.rollbackImport
    else delete api.abandonImport
    await controller[method](link.id, rollbackAck)
    expect(write).not.toHaveBeenCalled(); expect(controller.source.getSnapshot().notice?.kind).toBe('failed'); controller.dispose()
  })
  it.each(['rollback', 'abandon'] as const)('refuses %s for the opposite prepared state', async (operation) => {
    const api = linkedFixture(mirror, [operation === 'rollback' ? pending : link]); const controller = await reviewed(api)
    const method = operation === 'rollback' ? 'rollbackImport' : 'abandonImport'; const write = vi.spyOn(api, method)
    await controller[method](link.id, rollbackAck)
    expect(write).not.toHaveBeenCalled(); expect(controller.source.getSnapshot().notice?.kind).toBe('failed'); controller.dispose()
  })
  it.each(['absent', 'method', 'detail', 'revision', 'intent'] as const)('refuses prepared recovery when %s changes before admission', async (reason) => {
    const api = linkedFixture(mirror, [reason === 'absent' ? link : pending]); const controller = await reviewed(api)
    const write = vi.spyOn(api, 'recoverImport')
    if (reason === 'method') delete api.recoverImport
    if (reason === 'detail') delete api.linkedDetail
    if (reason === 'revision') api.linkedDetail = () => ok({ ...pending, revision: 2 })
    if (reason === 'intent') api.linkedDetail = () => ok({ ...pending, pending: { ...pending.pending!, before: { ...destinationRevision, digest: 'different-intent' } } })
    await controller.recoverImport(link.id)
    expect(write).not.toHaveBeenCalled(); expect(controller.source.getSnapshot().notice?.kind).toBe('failed'); controller.dispose()
  })
  it('keeps the last readable mirror and mapping when write reconciliation also loses transport', async () => {
    const api = linkedFixture(mirror, [link]); const controller = await reviewed(api)
    api.importIntoSession = unavailable; api.detail = unavailable; api.linkedDetail = unavailable; api.getState = unavailable
    await controller.importIntoSession(mirror.id, { ...importAck, expectedLinkRevision: 1 })
    expect(controller.source.getSnapshot()).toMatchObject({ selected: mirror, selectedLink: link, reviewedDestination: null, notice: { kind: 'failed' }, busy: false })
    controller.dispose()
  })
  it('publishes a successful quoted write with a query error when only its inventory reload fails', async () => {
    const api = linkedFixture()
    const controller = await selected(api)
    await controller.reviewImportDestination(coldId)
    api.getState = unavailable
    await controller.importIntoSession(mirror.id, importAck)
    expect(controller.source.getSnapshot()).toMatchObject({ selectedLink: link, notice: { kind: 'linked' }, queryError: true, reviewedDestination: null, busy: false })
    controller.dispose()
  })
  it('retains an imported mirror when its first inventory refresh fails', async () => {
    const api = fixtureApi(); api.getState = unavailable; const controller = new CodingSessionsController(api)
    await controller.importSession(mirror.source)
    expect(controller.source.getSnapshot()).toMatchObject({ selected: mirror, inventory: { sources: [], mirrors: [{ id: mirror.id, eventCount: 1 }] }, queryError: true, notice: { kind: 'imported' } })
    controller.dispose()
  })
  it('reports both an initial failed operation and a later failed detail without erasing history', async () => {
    const api = fixtureApi(); api.importSession = unavailable; const controller = new CodingSessionsController(api)
    await controller.importSession(mirror.source)
    expect(controller.source.getSnapshot()).toMatchObject({ selected: null, notice: { kind: 'failed' } })
    await controller.select(mirror.id); api.detail = unavailable; api.refreshMirror = unavailable
    await controller.refreshMirror(mirror.id)
    expect(controller.source.getSnapshot()).toMatchObject({ selected: mirror, notice: { seq: 2, kind: 'failed' }, busy: false })
    controller.dispose()
  })
  it('reports initial query errors and retains a previous inventory on later query errors', async () => {
    const api = fixtureApi(); api.getState = unavailable; const controller = new CodingSessionsController(api)
    await controller.refreshState()
    expect(controller.source.getSnapshot()).toMatchObject({ status: 'error', queryError: true, busy: false })
    api.getState = () => fixtureApi().getState()
    await controller.refreshState()
    api.detail = unavailable
    await controller.select(mirror.id)
    expect(controller.source.getSnapshot()).toMatchObject({ status: 'ready', queryError: true, busy: false, inventory: { mirrors: [{ id: mirror.id }] } })
    controller.dispose()
  })
})
describe('coding-session cancellation and bound actions', () => {
  it('drives source selection, continuation and review actions through the retained face', async () => {
    const api = linkedFixture(interrupted, [pending]); const controller = new CodingSessionsController(api); const face = controller.face()
    face.ensure(); await settle(controller); const inventory = controller.source.getSnapshot().inventory
    face.ensure(); expect(controller.source.getSnapshot().inventory).toBe(inventory)
    face.refreshState(); await settle(controller)
    face.discover(mirror.source); await settle(controller)
    face.importSession(mirror.source); await settle(controller); expect(controller.source.getSnapshot().notice?.kind).toBe('imported')
    face.select(mirror.id); await settle(controller)
    face.continueSession(mirror.id, 'fixture-only continuation', 1)
    await settle(controller)
    expect(controller.source.getSnapshot().notice?.kind).toBe('continued')
    face.claimSequential(mirror.id, { source: mirror.source, project: mirror.cwd!, expectedRevision: 1,
      executionSessionId: link.destinationSessionId, externalWritersClosed: true, nativeProfileUnchanged: true })
    await settle(controller)
    face.continueSequential(mirror.id, 'fixture-only sequential continuation', 1)
    await settle(controller)
    expect(controller.source.getSnapshot().notice?.kind).toBe('continued')
    face.releaseSequential(mirror.id); await settle(controller); expect(controller.source.getSnapshot().notice?.kind).toBe('released')
    face.select(mirror.id)
    await settle(controller)
    face.recoverSequential(mirror.id, recoveryAck)
    await settle(controller)
    expect(controller.source.getSnapshot().notice?.kind).toBe('recovered')
    face.select(mirror.id); await settle(controller); face.createImportDestination(mirror.id); await settle(controller)
    face.reviewImportDestination(coldId); await settle(controller); face.selectLink(link.id); await settle(controller)
    face.recoverImport(link.id); await settle(controller); expect(controller.source.getSnapshot().notice?.kind).toBe('importRecovered')
    face.selectLink(link.id); await settle(controller); face.reviewImportDestination(coldId); await settle(controller)
    face.abandonImport(link.id, rollbackAck)
    await settle(controller)
    expect(controller.source.getSnapshot().notice?.kind).toBe('importAbandoned')
    api.linkedDetail = () => ok(link)
    face.selectLink(link.id)
    await settle(controller)
    face.reviewImportDestination(coldId)
    await settle(controller)
    face.rollbackImport(link.id, rollbackAck)
    await settle(controller)
    expect(controller.source.getSnapshot().notice?.kind).toBe('compensated')
    face.select(mirror.id); await settle(controller); face.reviewImportDestination(coldId); await settle(controller)
    face.importIntoSession(mirror.id, importAck)
    await settle(controller)
    expect(controller.source.getSnapshot().notice?.kind).toBe('failed')
    face.refreshMirror(mirror.id); await settle(controller); expect(controller.source.getSnapshot().selected?.revision).toBe(2)
    face.cancelPending(); await settle(controller); expect(controller.source.getSnapshot().busy).toBe(false)
    face.dismissNotice(); expect(controller.source.getSnapshot().notice).toBeNull(); controller.dispose()
    face.dismissNotice(); await controller.cancelPending(); expect(controller.source.getSnapshot().notice).toBeNull()
  })
  it('blocks repeated actions while a write is admitted and drops its late result after disposal', async () => {
    const api = linkedFixture(); const controller = await selected(api); await controller.reviewImportDestination(coldId)
    const result = deferred<Awaited<ReturnType<NonNullable<CodingSessionsApi['importIntoSession']>>>>()
    const write = vi.spyOn(api, 'importIntoSession').mockReturnValue(result.promise)
    const operation = controller.importIntoSession(mirror.id, importAck)
    await controller.importIntoSession(mirror.id, importAck); await controller.refreshState(); await controller.importSession(mirror.source)
    expect(write).toHaveBeenCalledTimes(1); expect(controller.source.getSnapshot().busy).toBe(true)
    controller.dispose(); result.resolve({ ok: true, value: link }); await operation
    expect(controller.source.getSnapshot().selectedLink).toBeNull()
    await controller.importIntoSession(mirror.id, importAck); expect(write).toHaveBeenCalledTimes(1)
  })
  it('discards a late successful inventory after a write is cancelled', async () => {
    const api = linkedFixture(); const controller = await selected(api); await controller.reviewImportDestination(coldId)
    const result = deferred<Awaited<ReturnType<CodingSessionsApi['getState']>>>()
    const state = await api.getState(); let calls = 0
    api.getState = () => ++calls === 1 ? result.promise : Promise.resolve(state)
    const operation = controller.importIntoSession(mirror.id, importAck)
    await vi.waitFor(() =>{  expect(calls).toBe(1) }); await controller.cancelPending()
    result.resolve({ ok: true, value: { sources: [], mirrors: [] } }); await operation
    expect(controller.source.getSnapshot()).toMatchObject({ busy: false, inventory: { mirrors: [{ id: mirror.id }] } })
    controller.dispose()
  })
  it('discards a late failure and its reconciliation after cancellation', async () => {
    const api = linkedFixture(mirror, [link]); const controller = await reviewed(api)
    const result = deferred<Awaited<ReturnType<NonNullable<CodingSessionsApi['importIntoSession']>>>>()
    api.importIntoSession = () => result.promise
    const operation = controller.importIntoSession(mirror.id, { ...importAck, expectedLinkRevision: 1 })
    await controller.cancelPending()
    result.resolve({ ok: false, error: new RemoteError('gateway/internal', 'Late cancelled failure', {}) })
    await operation
    expect(controller.source.getSnapshot()).toMatchObject({ selected: mirror, selectedLink: link, busy: false, notice: null })
    controller.dispose()
  })
  it('does not publish failed write reconciliation if cancellation wins during the detail read', async () => {
    const api = linkedFixture(mirror, [link]); const controller = await reviewed(api)
    api.importIntoSession = unavailable
    const result = deferred<Awaited<ReturnType<CodingSessionsApi['detail']>>>(); let reads = 0
    api.detail = () => ++reads === 1 ? result.promise : ok(mirror)
    const operation = controller.importIntoSession(mirror.id, { ...importAck, expectedLinkRevision: 1 })
    await vi.waitFor(() =>{  expect(reads).toBe(1) })
    await controller.cancelPending()
    result.resolve({ ok: true, value: { ...mirror, revision: 99 } })
    await operation
    expect(controller.source.getSnapshot()).toMatchObject({ selected: { revision: 1 }, busy: false, notice: null }); controller.dispose()
  })
  it.each(['cancel', 'inventory', 'detail', 'link'] as const)('retains readable state when cancellation loses its %s response', async (failure) => {
    const api = linkedFixture(mirror, [link]); const controller = await reviewed(api)
    if (failure === 'cancel') api.cancelPending = unavailable
    if (failure === 'inventory') api.getState = unavailable
    if (failure === 'detail') api.detail = unavailable
    if (failure === 'link') { const state = await api.getState()
      if (!state.ok) throw new Error('Fixture unavailable')
      api.getState = () => ok({ ...state.value, links: [summary({ ...link, revision: 2 })] })
      api.linkedDetail = unavailable }
    await controller.cancelPending()
    expect(controller.source.getSnapshot()).toMatchObject({ selected: mirror, selectedLink: link, busy: false, queryError: true, notice: { kind: 'failed' }, reviewedDestination: null })
    controller.dispose()
  })
  it('retains a readable mapping if cancellation finds a changed link without a detail capability', async () => {
    const api = linkedFixture(mirror, [link])
    const controller = await reviewed(api)
    const state = await api.getState()
    if (!state.ok) throw new Error('Fixture unavailable')
    api.getState = () => ok({ ...state.value, links: [summary({ ...link, generations: [] })] }); delete api.linkedDetail
    await controller.cancelPending()
    expect(controller.source.getSnapshot()).toMatchObject({ selectedLink: link, queryError: true, notice: { kind: 'failed' } })
    controller.dispose()
  })
  it('finds the destination mapping committed during a cancelled first import', async () => {
    const api = linkedFixture(); const controller = await selected(api); await controller.reviewImportDestination(coldId)
    const state = await api.getState(); if (!state.ok) throw new Error('Fixture unavailable')
    api.getState = () => ok({ ...state.value, links: [summary(link)] }); await controller.cancelPending()
    expect(controller.source.getSnapshot()).toMatchObject({ selectedLink: link, queryError: false, reviewedDestination: null, busy: false })
    controller.dispose()
  })
  it('clears a removed mapping after a successful cancellation inventory', async () => {
    const api = linkedFixture(mirror, [link])
    const controller = await reviewed(api)
    const state = await api.getState()
    if (!state.ok) throw new Error('Fixture unavailable')
    api.getState = () => ok({ ...state.value, links: [] }); await controller.cancelPending()
    expect(controller.source.getSnapshot()).toMatchObject({ selectedLink: null, queryError: false }); controller.dispose()
  })
  it('returns to idle with a failed notice if cancellation cannot load the first inventory', async () => {
    const api = fixtureApi(); api.getState = unavailable; const controller = new CodingSessionsController(api)
    await controller.cancelPending()
    expect(controller.source.getSnapshot()).toMatchObject({ status: 'idle', inventory: null, queryError: true, busy: false, notice: { kind: 'failed' } })
    controller.dispose()
  })
  it.each(['cancel', 'inventory', 'detail', 'link'] as const)('discards cancellation state if disposed during its %s read', async (stage) => {
    const api = linkedFixture(mirror, [link]); const controller = await reviewed(api)
    const waiting = deferred<undefined>(); let started = false
    if (stage === 'cancel') api.cancelPending = () => { started = true
      return waiting.promise.then(() => ({ ok: true, value: undefined })) }
    if (stage === 'inventory') api.getState = () => { started = true
      return waiting.promise.then(() => ({ ok: true, value: { sources: [], mirrors: [] } })) }
    if (stage === 'detail') api.detail = () => { started = true; return waiting.promise.then(() => ({ ok: true, value: mirror })) }
    if (stage === 'link') { const state = await api.getState()
      if (!state.ok) throw new Error('Fixture unavailable')
      api.getState = () => ok({ ...state.value, links: [summary({ ...link, revision: 2 })] })
      api.linkedDetail = () => { started = true
        return waiting.promise.then(() => ({ ok: true, value: link })) } }
    const operation = controller.cancelPending()
    await vi.waitFor(() =>{  expect(started).toBe(true) })
    const before = controller.source.getSnapshot()
    controller.dispose()
    waiting.resolve(undefined); await operation
    expect(controller.source.getSnapshot()).toBe(before)
  })
  it.each(['operation', 'inventory', 'failure', 'detail'] as const)('ignores continuation completion after disposal during its %s', async (stage) => {
    const api = fixtureApi()
    const controller = await selected(api)
    const waiting = deferred<Awaited<ReturnType<CodingSessionsApi['detail']>>>()
    let started = false
    if (stage === 'operation') api.continueSession = () => { started = true; return waiting.promise }
    if (stage === 'inventory') api.getState = () => { started = true
      return waiting.promise.then(() => ({ ok: true, value: { sources: [], mirrors: [] } })) }
    if (stage === 'failure') api.continueSession = async () => { started = true; await waiting.promise; throw new Error('Late failure') }
    if (stage === 'detail') { api.continueSession = unavailable; api.detail = () => { started = true; return waiting.promise } }
    const operation = controller.continueSession(mirror.id, 'fixture-only continuation', 1)
    await vi.waitFor(() =>{  expect(started).toBe(true) })
    const before = controller.source.getSnapshot()
    controller.dispose()
    waiting.resolve({ ok: true, value: { ...mirror, revision: 99 } }); await operation
    expect(controller.source.getSnapshot()).toBe(before)
  })
})
describe('coding-session stale failed queries', () => {
  it('does not show a stale query failure after reconnect has loaded a fresh inventory', async () => {
    const api = fixtureApi(); const controller = await selected(api)
    const old = deferred<Awaited<ReturnType<CodingSessionsApi['detail']>>>()
    api.detail = () => old.promise
    const query = controller.select(mirror.id); controller.reconnect(); await settle(controller)
    old.resolve({ ok: false, error: new RemoteError('gateway/internal', 'Old connection failed', {}) }); await query
    expect(controller.source.getSnapshot()).toMatchObject({ status: 'ready', queryError: false, busy: false, selected: mirror })
    controller.dispose()
  })
})
