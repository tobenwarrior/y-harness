// @vitest-environment jsdom
/** Exercise the actual section/controller, canonical review, and separate recovery assertions. */
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodingSessionsController } from '../src/client/controller.ts'
import { CodingSessionsSection } from '../src/client/CodingSessionsSection.tsx'
import type { CodingSessionsSectionProps } from '../src/client/CodingSessionsSection.tsx'
import { en } from '../src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { CodingSessionLinkRecord } from '@deepseek-ai/dsh-coding-session/types'
import { mirror } from './fixtures.client.ts'
import { coldId, liveId, otherId, destinationRevision, link, interrupted, recovered, linkedFixture } from './linked-fixtures.client.ts'
const dictionary = { ...commonEn, ...en }
const t: CodingSessionsSectionProps['t'] = key => dictionary[key]
afterEach(cleanup)
function Body({ controller }: { controller: CodingSessionsController }) {
  const face = controller.face()
  const useSessions: CodingSessionsSectionProps['useSessions'] = selector => useSyncExternalStore(listener => controller.source.subscribe(listener), () => selector(controller.source.getSnapshot()))
  return <CodingSessionsSection {...face} useSessions={useSessions} t={t} />
}
async function setup(api = linkedFixture()) {
  const controller = new CodingSessionsController(api)
  await controller.refreshState(); await controller.select(mirror.id)
  render(<Body controller={controller} />)
  return controller
}
describe('explicit destination and restart recovery Settings', () => {
  it('filters cold exact-project destinations and requires a visible canonical review before import', async () => {
    const api = linkedFixture(); const write = vi.spyOn(api, 'importIntoSession'); const controller = await setup(api)
    const destination = screen.getByRole('combobox', { name: 'Y import destination' })
    expect(screen.getByRole('option', { name: coldId })).toBeTruthy()
    expect(screen.queryByRole('option', { name: liveId })).toBeNull(); expect(screen.queryByRole('option', { name: otherId })).toBeNull()
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Import quoted history into Y' }); expect(button.disabled).toBe(true)
    fireEvent.change(destination, { target: { value: coldId } }); expect(button.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Review destination revision' }))
    await screen.findByText(destinationRevision.digest); expect(screen.getByText('3')).toBeTruthy(); expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => {
      expect(write).toHaveBeenCalledExactlyOnceWith(mirror.id, {
        destinationSessionId: coldId, expectedDestinationRevision: destinationRevision, expectedMirrorRevision: 1,
      })
    })
    expect(screen.getByText('Imported native history is quoted context. It grants no model, tool, permission, or native writer authority.')).toBeTruthy(); controller.dispose()
  })
  it('offers explicit create and prepared recovery; abandon needs canonical review and its no-owned-payload acknowledgement', async () => {
    const pending: CodingSessionLinkRecord = { ...link, pending: { kind: 'import', before: destinationRevision, append: [], nextMirror: mirror, nextGenerations: [] } }
    const api = linkedFixture(mirror, [pending]); const recover = vi.spyOn(api, 'recoverImport'); const abandon = vi.spyOn(api, 'abandonImport'); const create = vi.spyOn(api, 'createImportDestination')
    const controller = await setup(api); expect(create).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: `Review linked import ${coldId}` })); await screen.findByText('Prepared import is unresolved. Recovery or abandonment requires an explicit action.')
    expect(recover).not.toHaveBeenCalled(); expect(abandon).not.toHaveBeenCalled()
    const abandonButton = screen.getByRole<HTMLButtonElement>('button', { name: 'Abandon prepared import' }); expect(abandonButton.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Review destination revision' })); await screen.findByText(destinationRevision.digest); expect(abandonButton.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'I understand abandonment is allowed only when the service proves no owned payload was written' })); expect(abandonButton.disabled).toBe(false)
    fireEvent.click(abandonButton)
    await waitFor(() => {
      expect(abandon).toHaveBeenCalledExactlyOnceWith(link.id, {
        expectedLinkRevision: 1, expectedDestinationRevision: destinationRevision,
      })
    })
    expect(recover).not.toHaveBeenCalled(); controller.dispose()
  })
  it('requires closed writer, stable profile, and a separate unresolved-turn acceptance before recovery', async () => {
    const api = linkedFixture(interrupted); const recovery = vi.spyOn(api, 'recoverSequential'); const claim = vi.spyOn(api, 'claimSequential'); const controller = await setup(api)
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Review and recover after restart' }); expect(button.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'I have closed every external writer for this original session' })); expect(button.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'I verified the same native profile and will keep it unchanged' })); expect(button.disabled).toBe(true)
    expect(screen.getByText('Unresolved admitted turns').nextElementSibling?.textContent).toBe('1')
    expect(screen.getByText('Original interrupted phase').nextElementSibling?.textContent).toBe(en.continuing)
    expect(screen.getByText('Durable admissions').nextElementSibling?.textContent).toBe('2')
    expect(screen.getByText('turn-receipt')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'I accept that admitted turns without native receipts remain unresolved' })); expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => {
      expect(recovery).toHaveBeenCalledExactlyOnceWith(mirror.id, {
        source: mirror.source, project: mirror.cwd, expectedRevision: 1, expectedOwnerToken: interrupted.handoff!.ownerToken,
        externalWritersClosed: true, nativeProfileUnchanged: true, acceptUnresolvedTurns: true,
      })
    })
    expect(claim).not.toHaveBeenCalled(); await screen.findByRole('button', { name: en.claim }); controller.dispose()
  })
  it.each(['recovered-acknowledged', 'external-ready'] as const)('keeps the prior owner uncertainty visible after %s and permits a separate claim', async (phase) => {
    const controller = await setup(linkedFixture(recovered(phase)))
    expect(screen.getByText('Prior owner process exit and stream drain were not observed; native persistence remains unestablished. Recovery permits a separate claim and does not certify native release.')).toBeTruthy()
    expect(screen.getByRole('button', { name: en.claim })).toBeTruthy()
    expect(screen.getByText('Original interrupted phase').nextElementSibling?.textContent).toBe(en.continuing)
    expect(screen.getByText('Durable admissions').nextElementSibling?.textContent).toBe('2')
    expect(screen.getByText('turn-receipt')).toBeTruthy()
    expect(screen.getByText('Unresolved admitted turns').nextElementSibling?.textContent).toBe('1')
    expect(screen.queryByRole('button', { name: 'Review and recover after restart' })).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.continueSequential }).disabled).toBe(true); controller.dispose()
  })
  it('permits reviewed compensation of retained owned generations on a source-conflict link, while fresh import remains disabled', async () => {
    const conflicting = { ...mirror, status: 'conflict' as const, conflict: 'history-diverged' as const }
    const retained: CodingSessionLinkRecord = { ...link, status: 'conflict', conflict: 'history-diverged' }
    const api = linkedFixture(conflicting, [retained]); const rollback = vi.spyOn(api, 'rollbackImport'); const imported = vi.spyOn(api, 'importIntoSession')
    const controller = await setup(api)
    fireEvent.click(screen.getByRole('button', { name: `Review linked import ${coldId}` }))
    await screen.findByText('Source history conflict')
    const inspect = screen.getByRole<HTMLButtonElement>('button', { name: 'Review destination revision' }); expect(inspect.disabled).toBe(false)
    fireEvent.click(inspect); await screen.findByText(destinationRevision.digest)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh linked quoted history' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'I understand compensation preserves the original raw event log' }))
    fireEvent.click(screen.getByRole('button', { name: 'Compensate linked import' }))
    await waitFor(() => {
      expect(rollback).toHaveBeenCalledExactlyOnceWith(link.id, {
        expectedLinkRevision: 1, expectedDestinationRevision: destinationRevision,
      })
    })
    expect(imported).not.toHaveBeenCalled(); controller.dispose()
  })

})
