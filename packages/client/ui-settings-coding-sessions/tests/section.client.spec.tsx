// @vitest-environment jsdom
/** The real Settings component exposes source labels, imported text, refresh, and honest continuation state. */
import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodingSessionsController } from '../src/client/controller.ts'
import { CodingSessionsSection } from '../src/client/CodingSessionsSection.tsx'
import type { CodingSessionsSectionProps } from '../src/client/CodingSessionsSection.tsx'
import { en } from '../src/client/locales.ts'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CodingSessionExecutionSession, CodingSessionMirror } from '@deepseek-ai/dsh-coding-session/types'
import { fixtureApi, mirror } from './fixtures.client.ts'
const dictionary = { ...commonEn, ...en }
const t: CodingSessionsSectionProps['t'] = key => dictionary[key]
afterEach(cleanup)
function Body({ controller }: { controller: CodingSessionsController }) {
  const face = controller.face()
  const useSessions: CodingSessionsSectionProps['useSessions'] = selector => useSyncExternalStore(listener => controller.source.subscribe(listener), () => selector(controller.source.getSnapshot()))
  return <CodingSessionsSection {...face} useSessions={useSessions} t={t} />
}
describe('source-labelled coding-session Settings', () => {
  it('browses a native source and makes imported original-ID history visible and refreshable', async () => {
    const controller = new CodingSessionsController(fixtureApi()); render(<Body controller={controller} />)
    expect(screen.getByText('Browse explicitly configured Codex and Claude sources. Import a readable mirror, then refresh new source history.')).toBeTruthy()
    await screen.findByText('Local Codex'); fireEvent.click(screen.getByRole('button', { name: 'Browse sessions' }))
    await screen.findByRole('button', { name: 'Import' }); fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await screen.findByText('Inspect parser'); expect(screen.getByText('authorized-local-profile')).toBeTruthy()
    expect(screen.getAllByText('native-original').length).toBeGreaterThanOrEqual(2)
    const continuation = screen.getByRole<HTMLButtonElement>('button', { name: 'Continue original session' })
    expect(continuation.disabled).toBe(true); expect(screen.getByText(en.continuationUnavailable)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh source' })); await screen.findByText('Parser repaired in the native session')
    controller.dispose()
  })
  it('shows retained conflicting history without enabling a native write', async () => {
    const api = fixtureApi(); api.detail = () => Promise.resolve({ ok: true, value: { ...mirror, status: 'conflict', conflict: 'history-diverged' } })
    const controller = new CodingSessionsController(api); await controller.refreshState(); await controller.select(mirror.id)
    render(<Body controller={controller} />)
    expect(screen.getByText('Inspect parser')).toBeTruthy(); expect(screen.getByText(en.conflict)).toBeTruthy()
    expect((screen.getByRole<HTMLButtonElement>('button', { name: 'Continue original session' })).disabled).toBe(true)
    controller.dispose()
  })
  it('requires the selected execution root and both operational acknowledgements before claiming the original native session', async () => {
    const api = fixtureApi()
    const selected = { ...mirror, sequentialAvailable: true, sequentialToolMode: 'conversation' as const }
    const executionSessionId = brandString<CodingSessionExecutionSession['id']>('root-a')
    const { events, ...summary } = selected
    api.getState = () => Promise.resolve({ ok: true, value: { sources: [], mirrors: [{ ...summary, eventCount: events.length }], executionSessions: [{ id: executionSessionId, project: '/fixture/project' }] } })
    api.detail = () => Promise.resolve({ ok: true, value: selected })
    const claim = vi.spyOn(api, 'claimSequential')
    const controller = new CodingSessionsController(api); await controller.refreshState(); await controller.select(mirror.id)
    render(<Body controller={controller} />)
    expect(screen.getByText(en.conversationMode)).toBeTruthy()
    const button = screen.getByRole<HTMLButtonElement>('button', { name: en.claim })
    expect(button.disabled).toBe(true)
    fireEvent.change(screen.getByRole('combobox', { name: en.executionSession }), { target: { value: executionSessionId } })
    fireEvent.click(screen.getByRole('checkbox', { name: en.closedWriter })); expect(button.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: en.unchangedProfile })); expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(claim).toHaveBeenCalledWith(mirror.id, { source: mirror.source, project: '/fixture/project', expectedRevision: mirror.revision, executionSessionId, externalWritersClosed: true, nativeProfileUnchanged: true })
    controller.dispose()
  })
  it('keeps original history visible while uncertain ownership disables continuation and absent-handle release', async () => {
    const api = fixtureApi()
    api.detail = () => Promise.resolve({ ok: true, value: { ...mirror, sequentialAvailable: true, sequentialReleaseAvailable: false,
      handoff: { id: mirror.id, source: mirror.source, project: '/fixture/project', executionSessionId: brandString<NonNullable<CodingSessionMirror['handoff']>['executionSessionId']>('root-a'), ownerToken: brandString<NonNullable<CodingSessionMirror['handoff']>['ownerToken']>('owner-a'), expectedRevision: mirror.revision, phase: 'blocked-uncertain', toolMode: 'conversation', nativeProfileUnchanged: true, externalWritersClosed: true, dispatchedTurnCount: 1, nativeTurnIds: [] } } })
    const controller = new CodingSessionsController(api); await controller.refreshState(); await controller.select(mirror.id)
    render(<Body controller={controller} />)
    expect(screen.getByText('Inspect parser')).toBeTruthy(); expect(screen.getByText(en.restartUncertain)).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.continueSequential }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.release }).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: en.claim })).toBeNull()
    controller.dispose()
  })

  it.each([
    { mode: 'conversation' as const, label: en.conversationMode },
    { mode: 'project-files' as const, label: en.projectFilesMode },
    { mode: 'project-tools' as const, label: en.projectToolsMode },
    { mode: undefined, label: en.toolModeUnknown },
  ])('discloses the actual native tool mode $mode without granting another mode', async ({ mode, label }) => {
    const api = fixtureApi()
    api.detail = () => Promise.resolve({
      ok: true, value: { ...mirror, sequentialAvailable: true, ...(mode === undefined ? {} : { sequentialToolMode: mode }) },
    })
    const controller = new CodingSessionsController(api); await controller.refreshState(); await controller.select(mirror.id)
    render(<Body controller={controller} />)
    expect(screen.getByText(label)).toBeTruthy()
    for (const other of [en.conversationMode, en.projectFilesMode, en.projectToolsMode, en.toolModeUnknown]) {
      if (other !== label) expect(screen.queryByText(other)).toBeNull()
    }
    controller.dispose()
  })

})
