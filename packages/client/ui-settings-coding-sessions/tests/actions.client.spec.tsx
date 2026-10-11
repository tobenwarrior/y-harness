// @vitest-environment jsdom
/** Real section/controller actions use only synthetic Remote callbacks and retained fixture history. */
import { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CodingSessionMirror } from '@deepseek-ai/dsh-coding-session/types'
import { CodingSessionsController } from '../src/client/controller.ts'
import type { CodingSessionsApi } from '../src/client/controller.ts'
import { CodingSessionsSection } from '../src/client/CodingSessionsSection.tsx'
import type { CodingSessionsSectionProps } from '../src/client/CodingSessionsSection.tsx'
import type {} from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { fixtureApi, mirror, ok } from './fixtures.client.ts'
import { coldId, destinationRevision, interrupted, link, linkedFixture, recovered } from './linked-fixtures.client.ts'

const dictionary = { ...commonEn, ...en }
const t: CodingSessionsSectionProps['t'] = key => dictionary[key]
const controllers: CodingSessionsController[] = []
afterEach(() => { cleanup(); for (const controller of controllers.splice(0)) controller.dispose() })
function Body({ controller }: { controller: CodingSessionsController }) {
  const face = controller.face()
  const useSessions: CodingSessionsSectionProps['useSessions'] = selector => useSyncExternalStore(
    listener => controller.source.subscribe(listener), () => selector(controller.source.getSnapshot()),
  )
  return <CodingSessionsSection {...face} useSessions={useSessions} t={t} />
}
async function setup(api: CodingSessionsApi, selected = true) {
  const controller = new CodingSessionsController(api); controllers.push(controller)
  await controller.refreshState(); if (selected) await controller.select(mirror.id)
  render(<Body controller={controller} />)
  return controller
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

it('retries failed inventory reads and keeps disconnected originals readable without discovery or refresh', async () => {
  const api = fixtureApi(); const originalRead = api.getState.bind(api)
  const read = vi.spyOn(api, 'getState').mockRejectedValueOnce(new Error('Fixture transport unavailable'))
    .mockImplementation(originalRead)
  const controller = await setup(api, false)
  expect(screen.getByRole('alert').textContent).toContain(en.queryError)
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  await screen.findByText('Local Codex'); expect(read).toHaveBeenCalledTimes(2)
  api.getState = async () => {
    const result = await originalRead()
    if (!result.ok) return result
    return { ...result, value: { ...result.value, sources: result.value.sources.map(source => ({ ...source, connected: false })) } }
  }
  const disconnected = { ...mirror, capabilities: { ...mirror.capabilities, refresh: false, reason: 'source-disconnected' as const } }
  api.detail = () => ok(disconnected)
  fireEvent.click(screen.getByRole('button', { name: en.reload })); await screen.findByText(`Codex · ${en.disconnected}`)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.discover }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: /Parser repair/ }))
  await screen.findByText(en.sourceUnavailable)
  expect(screen.getByText('Inspect parser')).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.refresh }).disabled).toBe(true)
  expect(controller.source.getSnapshot().selected?.source).toEqual(mirror.source)
})

it('shows an empty native page then passes its opaque next cursor on an explicit load-more action', async () => {
  const api = fixtureApi(); const discover = vi.spyOn(api, 'discover')
    .mockImplementationOnce(() => ok({ items: [], nextCursor: 'opaque-second-page' }))
    .mockImplementationOnce(() => ok({ items: [{ source: mirror.source, title: mirror.title, writerState: 'active' }] }))
  await setup(api, false)
  fireEvent.click(screen.getByRole('button', { name: en.discover })); await screen.findByText(en.emptyDiscovery)
  fireEvent.click(screen.getByRole('button', { name: en.more })); await screen.findByRole('button', { name: en.import })
  expect(discover).toHaveBeenNthCalledWith(2, expect.objectContaining({ provider: 'codex', profileId: mirror.source.profileId }), 'opaque-second-page')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.import }).disabled).toBe(true)
  expect(screen.queryByRole('button', { name: en.more })).toBeNull()
})

it('creates a cold destination explicitly and displays its canonical revision without granting continuation', async () => {
  const api = linkedFixture(); const originalRead = api.getState.bind(api)
  let created = false
  api.getState = async () => {
    const result = await originalRead()
    if (!result.ok) return result
    return { ...result, value: { ...result.value, importDestinations: created ? result.value.importDestinations ?? [] : [] } }
  }
  const create = vi.spyOn(api, 'createImportDestination').mockImplementation(() => {
    created = true; return ok({ destinationSessionId: coldId, revision: destinationRevision })
  })
  await setup(api)
  expect(screen.getByText(en.noImportDestination)).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.reviewDestination }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: en.createImportDestination }))
  await screen.findByRole('option', { name: coldId })
  expect(create).toHaveBeenCalledExactlyOnceWith(mirror.id)
  fireEvent.click(screen.getByRole('button', { name: en.reviewDestination }))
  await screen.findByText(destinationRevision.digest)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.continue }).disabled).toBe(true)
})

it('refreshes a retained mapping only after review and sends the exact link revision', async () => {
  const api = linkedFixture(mirror, [link]); const write = vi.spyOn(api, 'importIntoSession')
  await setup(api)
  fireEvent.click(screen.getByRole('button', { name: `${en.reviewLink} ${coldId}` }))
  await screen.findByText(en.linkedActive)
  const button = screen.getByRole<HTMLButtonElement>('button', { name: en.refreshLinkedImport })
  expect(button.disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: en.reviewDestination })); await screen.findByText(destinationRevision.digest)
  fireEvent.click(button)
  await waitFor(() => { expect(write).toHaveBeenCalledExactlyOnceWith(mirror.id, {
    destinationSessionId: coldId, expectedDestinationRevision: destinationRevision,
    expectedMirrorRevision: mirror.revision, expectedLinkRevision: link.revision,
  }) })
})

it('recovers a reviewed prepared import explicitly and does not create or abandon a destination', async () => {
  const pending = { ...link, pending: { kind: 'import' as const, before: destinationRevision, append: [], nextMirror: mirror, nextGenerations: [] } }
  const api = linkedFixture(mirror, [pending]); const recover = vi.spyOn(api, 'recoverImport')
  const create = vi.spyOn(api, 'createImportDestination'); const abandon = vi.spyOn(api, 'abandonImport')
  await setup(api)
  fireEvent.click(screen.getByRole('button', { name: `${en.reviewLink} ${coldId}` })); await screen.findByText(en.preparedImport)
  fireEvent.click(screen.getByRole('button', { name: en.recoverImport }))
  await waitFor(() => { expect(recover).toHaveBeenCalledExactlyOnceWith(link.id) })
  await screen.findByRole('button', { name: en.refreshLinkedImport })
  expect(create).not.toHaveBeenCalled(); expect(abandon).not.toHaveBeenCalled()
})

it('requires nonblank text and the current revision for direct continuation and retains conflicting history', async () => {
  const continuable = { ...mirror, capabilities: { ...mirror.capabilities, continue: true, reason: 'exclusive-native-writer' as const } }
  const api = linkedFixture(continuable); const continueSession = vi.spyOn(api, 'continueSession')
    .mockImplementation(() => ok({ ...continuable, revision: 2 }))
  const controller = await setup(api)
  expect(screen.getByText(`Codex · ${en.continuable}`)).toBeTruthy()
  const button = screen.getByRole<HTMLButtonElement>('button', { name: en.continue })
  expect(button.disabled).toBe(true)
  fireEvent.change(screen.getByRole('textbox', { name: en.prompt }), { target: { value: '   ' } }); expect(button.disabled).toBe(true)
  fireEvent.change(screen.getByRole('textbox', { name: en.prompt }), { target: { value: 'Synthetic request only' } }); expect(button.disabled).toBe(false)
  fireEvent.click(button)
  await waitFor(() => { expect(continueSession).toHaveBeenCalledExactlyOnceWith(mirror.id, 'Synthetic request only', 1) })
  await waitFor(() => { expect(controller.source.getSnapshot().busy).toBe(false) })
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: en.prompt }).value).toBe('')
  await act(async () => {
    api.detail = () => ok({ ...continuable, status: 'conflict', conflict: 'history-diverged' })
    await controller.select(mirror.id)
  })
  fireEvent.change(screen.getByRole('textbox', { name: en.prompt }), { target: { value: 'Do not dispatch this' } })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.continue }).disabled).toBe(true)
  expect(continueSession).toHaveBeenCalledTimes(1)
})

it('admits one owned continuation for repeated clicks and cancels without publishing a late transcript', async () => {
  const owned = { ...interrupted, handoff: { ...interrupted.handoff!, phase: 'y-owned' as const } }
  const api = linkedFixture(owned); const pending = deferred<RemoteResult<CodingSessionMirror>>()
  const continuation = vi.spyOn(api, 'continueSequential').mockReturnValue(pending.promise)
  const cancel = vi.spyOn(api, 'cancelPending'); const release = vi.spyOn(api, 'releaseSequential')
  const controller = await setup(api)
  const button = screen.getByRole<HTMLButtonElement>('button', { name: en.continueSequential })
  expect(button.disabled).toBe(true)
  fireEvent.change(screen.getByRole('textbox', { name: en.prompt }), { target: { value: '   ' } }); expect(button.disabled).toBe(true)
  fireEvent.change(screen.getByRole('textbox', { name: en.prompt }), { target: { value: 'Synthetic owned turn' } })
  act(() => { button.click(); button.click() })
  expect(continuation).toHaveBeenCalledExactlyOnceWith(mirror.id, 'Synthetic owned turn', mirror.revision)
  expect(screen.getByRole('status', { name: commonEn.loading })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  await waitFor(() => { expect(controller.source.getSnapshot().busy).toBe(false) })
  expect(cancel).toHaveBeenCalledOnce(); expect(release).not.toHaveBeenCalled()
  await act(async () => { pending.resolve({ ok: true, value: { ...owned, revision: 99, title: 'Late turn must stay hidden' } }); await pending.promise })
  expect(screen.queryByText('Late turn must stay hidden')).toBeNull()
  expect(controller.source.getSnapshot().selected?.revision).toBe(mirror.revision)
})

it('allows an explicit retained-handle release while explaining uncertain ownership', async () => {
  const releasable = { ...interrupted, sequentialReleaseAvailable: true }
  const api = linkedFixture(releasable); const release = vi.spyOn(api, 'releaseSequential')
    .mockImplementation(() => ok(recovered('external-ready')))
  await setup(api)
  expect(screen.getByText(en.releaseUncertain)).toBeTruthy()
  expect(screen.queryByRole('button', { name: en.recoverSequential })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.release }))
  await waitFor(() => { expect(release).toHaveBeenCalledExactlyOnceWith(mirror.id) })
  await screen.findByRole('button', { name: en.claim })
  expect(screen.queryByRole('button', { name: en.release })).toBeNull()
})

it('reports empty native receipts before and after recovery without fabricating dispatch acknowledgement', async () => {
  const zeroAdmissions = { ...interrupted, handoff: { ...interrupted.handoff!, dispatchedTurnCount: 0, nativeTurnIds: [] } }
  const acknowledged = recovered()
  const api = linkedFixture(zeroAdmissions)
  api.recoverSequential = () => ok({ ...acknowledged, handoff: {
    ...acknowledged.handoff!, recoveryHistory: acknowledged.handoff!.recoveryHistory!.map(checkpoint => ({
      ...checkpoint, dispatchedTurnCount: 0, nativeTurnIds: [], unresolvedDispatchCount: 0,
    })),
  } })
  const recovery = vi.spyOn(api, 'recoverSequential')
  await setup(api)
  expect(screen.getByText(en.noNativeTurnReceipts)).toBeTruthy()
  expect(screen.queryByRole('checkbox', { name: en.acceptUnresolvedTurns })).toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: en.recoveryClosedWriter }))
  fireEvent.click(screen.getByRole('checkbox', { name: en.recoveryStableProfile }))
  fireEvent.click(screen.getByRole('button', { name: en.recoverSequential }))
  await screen.findByRole('button', { name: en.claim })
  expect(screen.getByText(en.noNativeTurnReceipts)).toBeTruthy()
  expect(recovery).toHaveBeenCalledWith(mirror.id, expect.objectContaining({ acceptUnresolvedTurns: false }))
})

it('discloses a missing source project and refuses claiming or destination creation', async () => {
  const { cwd: _project, ...withoutProject } = mirror
  const api = fixtureApi(); api.detail = () => ok(withoutProject)
  await setup(api)
  expect(screen.getByText(en.projectUnknown)).toBeTruthy()
  expect(screen.queryByRole('button', { name: en.createImportDestination })).toBeNull()
  expect(screen.queryByRole('button', { name: en.claim })).toBeNull()
})
