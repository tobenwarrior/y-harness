/** A retained divergence conflict is a successful Remote result, not an imported-history outcome. */
import { describe, expect, it, vi } from 'vitest'
import { CodingSessionsController } from '../src/client/controller.ts'
import type { CodingSessionLinkRecord } from '@deepseek-ai/dsh-coding-session/types'
import { mirror, ok } from './fixtures.client.ts'
import { coldId, destinationRevision, link, linkedFixture, summary } from './linked-fixtures.client.ts'

describe('linked-import outcome disclosure', () => {
  it('retains a returned source conflict and reports failure rather than claiming that quoted history was imported', async () => {
    const conflict: CodingSessionLinkRecord = { ...link, revision: 2, status: 'conflict', conflict: 'history-diverged' }
    const api = linkedFixture(mirror, [link])
    const write = vi.spyOn(api, 'importIntoSession').mockImplementation(() => ok(conflict))
    const controller = new CodingSessionsController(api)
    await controller.refreshState()
    await controller.select(mirror.id)
    await controller.selectLink(link.id)
    await controller.reviewImportDestination(coldId)
    await controller.importIntoSession(mirror.id, {
      destinationSessionId: coldId,
      expectedDestinationRevision: destinationRevision,
      expectedMirrorRevision: mirror.revision,
      expectedLinkRevision: link.revision,
    })
    expect(write).toHaveBeenCalledTimes(1)
    expect(controller.source.getSnapshot()).toMatchObject({
      selectedLink: conflict,
      selected: { events: mirror.events },
      reviewedDestination: null,
      busy: false,
      notice: { kind: 'failed' },
    })
    controller.dispose()
  })

  it.each(['prepared', 'committed'] as const)('reconciles the first %s linked write after cancellation settles without replaying or claiming success', async (disposition) => {
    const retained: CodingSessionLinkRecord = disposition === 'prepared'
      ? { ...link, pending: { kind: 'import', before: destinationRevision, append: [], nextMirror: mirror, nextGenerations: [] } }
      : link
    const api = linkedFixture()
    const initial = await api.getState()
    if (!initial.ok) throw new Error('Fixture inventory unavailable.')
    let settled = false
    api.getState = () => ok({ ...initial.value, links: settled ? [summary(retained)] : [] })
    let resolveWrite!: (value: Awaited<ReturnType<NonNullable<typeof api.importIntoSession>>>) => void
    const write = vi.spyOn(api, 'importIntoSession').mockImplementation(() => new Promise((done) => { resolveWrite = done }))
    let resolveCancellation!: (value: Awaited<ReturnType<typeof api.cancelPending>>) => void
    const cancellation = vi.spyOn(api, 'cancelPending').mockImplementation(() => new Promise((done) => { resolveCancellation = done }))
    const inventory = vi.spyOn(api, 'getState')
    const detail = vi.spyOn(api, 'linkedDetail').mockImplementation(() => ok(retained))
    const controller = new CodingSessionsController(api)
    await controller.refreshState()
    await controller.select(mirror.id)
    await controller.reviewImportDestination(coldId)
    const imported = controller.importIntoSession(mirror.id, {
      destinationSessionId: coldId,
      expectedDestinationRevision: destinationRevision,
      expectedMirrorRevision: mirror.revision,
    })
    expect(write).toHaveBeenCalledTimes(1)
    const readsBeforeCancel = inventory.mock.calls.length
    const cancelled = controller.cancelPending()
    expect(cancellation).toHaveBeenCalledTimes(1)
    // The public cancellation contract settles admitted writes before returning.
    // This synthetic endpoint models that ordering without exercising a Host or native writer.
    settled = true
    resolveWrite({ ok: true, value: retained })
    await imported
    resolveCancellation({ ok: true, value: undefined })
    await cancelled
    expect(write).toHaveBeenCalledTimes(1)
    expect(inventory.mock.calls.length).toBeGreaterThan(readsBeforeCancel)
    expect(detail).toHaveBeenCalledExactlyOnceWith(link.id)
    expect(controller.source.getSnapshot()).toMatchObject({
      selectedLink: retained,
      inventory: { links: [summary(retained)] },
      selected: { events: mirror.events },
      reviewedDestination: null,
      busy: false,
    })
    expect(controller.source.getSnapshot().notice?.kind).not.toBe('linked')
    controller.dispose()
  })
})
