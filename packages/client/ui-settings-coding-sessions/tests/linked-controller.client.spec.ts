/** Public-operation fixtures pin reviewed revisions and prohibit automatic repair/replay. */
import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { CodingSessionsController } from '../src/client/controller.ts'
import type { CodingSessionLinkRecord } from '@deepseek-ai/dsh-coding-session/types'
import { mirror, ok } from './fixtures.client.ts'
import { coldId, liveId, otherId, destinationRevision, link, summary, interrupted, linkedFixture } from './linked-fixtures.client.ts'
async function select(api = linkedFixture()) {
  const controller = new CodingSessionsController(api)
  await controller.refreshState(); await controller.select(mirror.id)
  return controller
}
const acknowledgement = {
  destinationSessionId: coldId, expectedDestinationRevision: destinationRevision, expectedMirrorRevision: mirror.revision,
}
describe('reviewed linked imports and explicit restart recovery', () => {
  it('accepts only a cold exact-project destination and forwards the inspected canonical revision before refreshing inventory', async () => {
    const api = linkedFixture(); const inspect = vi.spyOn(api, 'inspectImportDestination'); const write = vi.spyOn(api, 'importIntoSession'); const inventory = vi.spyOn(api, 'getState')
    const controller = await select(api)
    await controller.reviewImportDestination(liveId); await controller.reviewImportDestination(otherId)
    expect(inspect).not.toHaveBeenCalled(); expect(controller.source.getSnapshot().reviewedDestination).toBeNull()
    await controller.importIntoSession(mirror.id, acknowledgement); expect(write).not.toHaveBeenCalled()
    await controller.reviewImportDestination(coldId)
    expect(controller.source.getSnapshot().reviewedDestination).toMatchObject({
      destinationSessionId: coldId, revision: destinationRevision, mirrorId: mirror.id, mirrorRevision: 1,
    })
    const before = inventory.mock.calls.length
    await controller.importIntoSession(mirror.id, acknowledgement)
    expect(write).toHaveBeenCalledExactlyOnceWith(mirror.id, acknowledgement); expect(inventory.mock.calls.length).toBe(before + 1)
    expect(controller.source.getSnapshot()).toMatchObject({ selectedLink: link, reviewedDestination: null, busy: false })
    controller.dispose()
  })
  it('creates a cold destination only explicitly and reloads its inventory before making the returned revision reviewable', async () => {
    const api = linkedFixture(); const create = vi.spyOn(api, 'createImportDestination'); const inventory = vi.spyOn(api, 'getState')
    const controller = await select(api); expect(create).not.toHaveBeenCalled()
    const before = inventory.mock.calls.length; await controller.createImportDestination(mirror.id)
    expect(create).toHaveBeenCalledExactlyOnceWith(mirror.id); expect(inventory.mock.calls.length).toBe(before + 1)
    expect(controller.source.getSnapshot().reviewedDestination).toMatchObject({
      destinationSessionId: coldId, revision: destinationRevision,
    })
    controller.dispose()
  })
  it('requires the selected link revision for refresh and compensation, then invalidates the destination review', async () => {
    const api = linkedFixture(mirror, [link]); const write = vi.spyOn(api, 'importIntoSession'); const rollback = vi.spyOn(api, 'rollbackImport')
    const controller = await select(api); await controller.selectLink(link.id); await controller.reviewImportDestination(coldId)
    await controller.importIntoSession(mirror.id, acknowledgement); expect(write).not.toHaveBeenCalled()
    await controller.reviewImportDestination(coldId)
    await controller.importIntoSession(mirror.id, { ...acknowledgement, expectedLinkRevision: link.revision })
    expect(write).toHaveBeenCalledExactlyOnceWith(mirror.id, { ...acknowledgement, expectedLinkRevision: 1 })
    await controller.selectLink(link.id)
    await controller.rollbackImport(link.id, { expectedLinkRevision: 1, expectedDestinationRevision: destinationRevision })
    expect(rollback).not.toHaveBeenCalled()
    await controller.reviewImportDestination(coldId)
    await controller.rollbackImport(link.id, { expectedLinkRevision: 1, expectedDestinationRevision: destinationRevision })
    expect(rollback).toHaveBeenCalledExactlyOnceWith(link.id, { expectedLinkRevision: 1, expectedDestinationRevision: destinationRevision })
    expect(controller.source.getSnapshot()).toMatchObject({ selectedLink: { status: 'rolled-back' }, reviewedDestination: null }); controller.dispose()
  })
  it('retains prepared intent until explicit recover or reviewed abandon, with no automatic recovery on selection/reload', async () => {
    const pending: CodingSessionLinkRecord = { ...link, pending: { kind: 'import', before: destinationRevision, append: [], nextMirror: mirror, nextGenerations: [] } }
    const api = linkedFixture(mirror, [pending]); const recover = vi.spyOn(api, 'recoverImport'); const abandon = vi.spyOn(api, 'abandonImport')
    const controller = await select(api); await controller.selectLink(link.id); await controller.refreshState()
    expect(controller.source.getSnapshot().selectedLink?.pending).toBeDefined()
    expect(recover).not.toHaveBeenCalled(); expect(abandon).not.toHaveBeenCalled()
    await controller.abandonImport(link.id, { expectedLinkRevision: 1, expectedDestinationRevision: destinationRevision })
    expect(abandon).not.toHaveBeenCalled()
    await controller.reviewImportDestination(coldId)
    await controller.abandonImport(link.id, { expectedLinkRevision: 1, expectedDestinationRevision: destinationRevision })
    expect(abandon).toHaveBeenCalledExactlyOnceWith(link.id, { expectedLinkRevision: 1, expectedDestinationRevision: destinationRevision })
    await controller.selectLink(link.id); await controller.recoverImport(link.id)
    expect(recover).toHaveBeenCalledExactlyOnceWith(link.id); controller.dispose()
  })
  it('reloads failed prepared-write state and inventory without dropping readable mirror history or retrying the write', async () => {
    const api = linkedFixture(mirror, [link]); const write = vi.spyOn(api, 'importIntoSession').mockResolvedValue({ ok: false, error: new RemoteError('gateway/internal', 'Injected destination flush failure', {}) })
    const controller = await select(api); await controller.selectLink(link.id); await controller.reviewImportDestination(coldId)
    const prepared = { ...link, pending: { kind: 'import' as const, before: destinationRevision, append: [], nextMirror: mirror, nextGenerations: [] } }
    api.linkedDetail = () => ok(prepared); const inventory = vi.spyOn(api, 'getState'); const before = inventory.mock.calls.length
    await controller.importIntoSession(mirror.id, { ...acknowledgement, expectedLinkRevision: 1 })
    expect(write).toHaveBeenCalledTimes(1); expect(inventory.mock.calls.length).toBe(before + 1)
    expect(controller.source.getSnapshot()).toMatchObject({ selected: { events: mirror.events }, selectedLink: prepared, reviewedDestination: null, notice: { kind: 'failed' } }); controller.dispose()
  })
  it('discards a late canonical review after reconnect and clears reviews when the mirror changes', async () => {
    const api = linkedFixture(); let resolve!: (value: Awaited<ReturnType<NonNullable<typeof api.inspectImportDestination>>>) => void
    api.inspectImportDestination = () => new Promise((done) => { resolve = done })
    const controller = await select(api); const old = controller.reviewImportDestination(coldId); await Promise.resolve()
    controller.reconnect(); resolve({ ok: true, value: { destinationSessionId: coldId, revision: destinationRevision } }); await old
    expect(controller.source.getSnapshot().reviewedDestination).toBeNull(); controller.dispose()
  })
  it('forwards exact lost owner and unresolved-turn acknowledgement explicitly, then refreshes state without claiming or dispatching', async () => {
    const api = linkedFixture(interrupted); const recovery = vi.spyOn(api, 'recoverSequential'); const claim = vi.spyOn(api, 'claimSequential'); const continuation = vi.spyOn(api, 'continueSequential'); const inventory = vi.spyOn(api, 'getState')
    const controller = await select(api); const before = inventory.mock.calls.length
    const ack = {
      source: interrupted.source, project: interrupted.cwd!, expectedRevision: 1, expectedOwnerToken: interrupted.handoff!.ownerToken,
      externalWritersClosed: true, nativeProfileUnchanged: true, acceptUnresolvedTurns: true,
    }
    await controller.recoverSequential(mirror.id, ack)
    expect(recovery).toHaveBeenCalledExactlyOnceWith(mirror.id, ack); expect(inventory.mock.calls.length).toBe(before + 1)
    expect(controller.source.getSnapshot().selected?.handoff).toMatchObject({ phase: 'recovered-acknowledged', recoveryHistory: [{ oldProcessExit: 'not-observed', oldStreamsDrain: 'not-observed', nativePersistence: 'not-established' }] })
    expect(claim).not.toHaveBeenCalled(); expect(continuation).not.toHaveBeenCalled(); controller.dispose()
  })
  it.each(['cancel', 'reconnect', 'dispose'] as const)('never starts prepared recovery after %s invalidates its pending preflight', async (action) => {
    const pending: CodingSessionLinkRecord = { ...link, pending: { kind: 'import', before: destinationRevision, append: [], nextMirror: mirror, nextGenerations: [] } }
    const api = linkedFixture(mirror, [pending]); const recovery = vi.spyOn(api, 'recoverImport')
    const controller = await select(api); await controller.selectLink(link.id)
    let resolve!: (value: Awaited<ReturnType<NonNullable<typeof api.linkedDetail>>>) => void
    api.linkedDetail = () => new Promise((done) => { resolve = done })
    const operation = controller.recoverImport(link.id); await Promise.resolve()
    if (action === 'cancel') await controller.cancelPending()
    if (action === 'reconnect') controller.reconnect()
    if (action === 'dispose') controller.dispose()
    resolve({ ok: true, value: pending }); await operation
    expect(recovery).not.toHaveBeenCalled(); controller.dispose()
  })

  it('refetches changed prepared detail even when the link revision stays equal, without recovering automatically', async () => {
    const api = linkedFixture(mirror, [link]); const controller = await select(api); await controller.selectLink(link.id)
    const initial = await api.getState(); if (!initial.ok) throw new Error('Fixture inventory unavailable.')
    const prepared: CodingSessionLinkRecord = { ...link, pending: { kind: 'import', before: destinationRevision, append: [], nextMirror: mirror, nextGenerations: link.generations } }
    api.getState = () => ok({ ...initial.value, links: [summary(prepared)] }); api.linkedDetail = () => ok(prepared)
    const detail = vi.spyOn(api, 'linkedDetail'); const recovery = vi.spyOn(api, 'recoverImport')
    await controller.refreshState()
    expect(detail).toHaveBeenCalledExactlyOnceWith(link.id)
    expect(controller.source.getSnapshot().selectedLink).toEqual(prepared); expect(recovery).not.toHaveBeenCalled(); controller.dispose()
  })

})
