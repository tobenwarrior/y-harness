// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { DecisionSettings, type DecisionSettingsProps } from '../src/client/DecisionSettings.tsx'
import { DecisionController, type DecisionApi, type DecisionState } from '../src/client/decision-controller.ts'
import { en } from '../src/client/locales.ts'
afterEach(cleanup)
const dictionary = { ...commonEn, ...en }
const t: DecisionSettingsProps['t'] = (key, params) => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionary[key])
const unused = (): never => { throw new Error('DecisionSettings does not consume global slot hooks') }
const standard: GlobalStandardProps = {
  usePanelInfo: unused, useSessions: unused, useSessionStatus: unused,
  useSessionRetainInfo: unused, useResource: unused, useWorkspaces: unused,
}
const fixture = () => {
  const source = createSnapshotStore<DecisionState>({ phase: 'ready', status: { configuration: { enabled: false, revision: 0 }, models: [
    { provider: 'codex', model: '', name: 'Codex', available: false, reason: 'native-tools' },
    { provider: 'api', model: 'small', name: 'Small', available: true, reason: 'response-only' },
  ], maxInputBytes: 16000, maxInputTokens: 16000, maxOutputTokens: 512, timeoutMs: 10000, maxCalls: 1 }, projects: [{ id: 'p', title: 'Project', path: '/project' }], controls: {}, controlsKey: JSON.stringify(['api', 'small']), capabilityEpoch: 0, busy: false, error: false, preview: null, notice: null })
  const callbacks = {
    ensureDecision: vi.fn(), refreshDecision: vi.fn(), loadDecisionControls: vi.fn(),
    saveDecision: vi.fn(), previewDecision: vi.fn(), dismissDecisionNotice: vi.fn(),
  }
  render(<DecisionSettings {...standard} {...callbacks} useDecision={bindSnapshotSelector(source)} t={t} />)
  return { source, ...callbacks }
}
describe('Decision Models footer', () => {
  it('refetches changed capabilities after refresh with the same route and revision', async () => {
    let effort = ReasoningEffortId('low')
    const decisionCapabilities = vi.fn<DecisionApi['decisionCapabilities']>(async () => ({ ok: true, value: { reasoning: { efforts: [{ id: effort, name: effort }] } } }))
    const configureDecision = vi.fn<DecisionApi['configureDecision']>(); const retrieve = vi.fn<DecisionApi['retrieve']>()
    const controller = new DecisionController({ decisionCapabilities, configureDecision, retrieve,
      decisionStatus: async () => ({ ok: true, value: { configuration: { enabled: true, revision: 1, route: { provider: 'api', model: 'small', reasoningEffort: ReasoningEffortId('low') } }, models: [{ provider: 'api', model: 'small', name: 'Small', available: true, reason: 'response-only' }], maxInputBytes: 16000, maxInputTokens: 16000, maxOutputTokens: 512, timeoutMs: 10000, maxCalls: 1 } }),
      list: async () => ({ ok: true, value: { items: [], projects: [], providers: [], bodyBudgetBytes: 1000 } }),
    })
    await controller.refresh(); const { hooks: _hooks, ...face } = controller.face()
    render(<DecisionSettings {...standard} {...face} useDecision={bindSnapshotSelector(controller.source)} t={t} />)
    try {
      await waitFor(() => { expect(screen.getByRole('option', { name: 'low' })).toBeTruthy() })
      effort = ReasoningEffortId('high')
      await act(async () => { await controller.refresh() })
      await waitFor(() => { expect(screen.getByRole('option', { name: 'high' })).toBeTruthy() })
      expect(screen.queryByRole('option', { name: 'low' })).toBeNull()
      expect(decisionCapabilities).toHaveBeenCalledTimes(2)
      expect(controller.source.getSnapshot().status?.configuration.revision).toBe(1)
      expect(configureDecision).not.toHaveBeenCalled(); expect(retrieve).not.toHaveBeenCalled()
    } finally { controller.dispose() }
  })
  it('renders native refusal and saves a separate available API route only after opt-in', () => {
    const f = fixture(); expect(screen.getByText(en.decisionNativeHint)).toBeTruthy()
    expect(screen.getByRole<HTMLOptionElement>('option', { name: /Codex/ }).disabled).toBe(true)
    expect(f.previewDecision).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('combobox', { name: en.decisionModel }), { target: { value: JSON.stringify(['api', 'small']) } })
    fireEvent.click(screen.getByRole('switch', { name: en.decisionEnable }))
    fireEvent.click(screen.getByRole('button', { name: en.decisionSave }))
    expect(f.saveDecision).toHaveBeenCalledWith(true, { provider: 'api', model: 'small' })
  })
  it('requires a project and query for an explicit preview', () => {
    const f = fixture(); const preview = screen.getByRole('button', { name: en.decisionPreview }) as HTMLButtonElement
    expect(preview.disabled).toBe(true)
    fireEvent.change(screen.getByRole('combobox', { name: en.decisionProject }), { target: { value: 'p' } })
    fireEvent.change(screen.getByRole('textbox', { name: en.decisionQuery }), { target: { value: 'release' } })
    fireEvent.click(preview); expect(f.previewDecision).toHaveBeenCalledWith('p', 'release')
  })
})
