// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReasoningEffortId, ServiceTierId } from '@yharness/llm'
import { bindSnapshotSelector } from '@yharness/client-test-runtime'
import { createSnapshotStore } from '@yharness/client-store'
import type { GlobalStandardProps } from '@yharness/client-ui-slots'
import { en as commonEn } from '@yharness/client-locale/src/locales/en.ts'
import { DecisionSettings, DecisionToast, type DecisionSettingsProps } from '../src/client/DecisionSettings.tsx'
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
const baseState = (): DecisionState => ({ phase: 'ready', status: { configuration: { enabled: false, revision: 0 }, models: [
  { provider: 'codex', model: '', name: 'Codex', available: false, reason: 'native-tools' },
  { provider: 'api', model: 'small', name: 'Small', available: true, reason: 'response-only' },
], maxInputBytes: 16000, maxInputTokens: 16000, maxOutputTokens: 512, timeoutMs: 10000, maxCalls: 1 }, projects: [{ id: 'p', title: 'Project', path: '/project' }], controls: {}, controlsKey: JSON.stringify(['api', 'small']), capabilityEpoch: 0, busy: false, error: false, preview: null, notice: null })
const renderState = (state: DecisionState) => {
  const source = createSnapshotStore<DecisionState>(state)
  const callbacks = {
    ensureDecision: vi.fn(), refreshDecision: vi.fn(), loadDecisionControls: vi.fn(),
    saveDecision: vi.fn(), previewDecision: vi.fn(), dismissDecisionNotice: vi.fn(),
  }
  render(<DecisionSettings {...standard} {...callbacks} useDecision={bindSnapshotSelector(source)} t={t} />)
  return { source, ...callbacks }
}
const fixture = () => {
  const result = renderState(baseState())
  fireEvent.click(screen.getByText(en.decisionAdvanced))
  return result
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
    fireEvent.click(screen.getByText(en.decisionAdvanced))
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
  it('shows loading and error states while retaining the advanced disclosure', () => {
    renderState({ ...baseState(), phase: 'loading', status: null })
    expect(screen.getByRole('status', { name: en.loading })).toBeTruthy()
    cleanup()
    const f = renderState({ ...baseState(), error: true })
    fireEvent.click(screen.getByText(en.decisionAdvanced))
    expect(screen.getByRole('alert').textContent).toBe(en.decisionError)
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    expect(f.refreshDecision).toHaveBeenCalledOnce()
  })
  it('renders response-only controls and saves the selected effort and service tier', () => {
    const effort = ReasoningEffortId('high')
    const tier = ServiceTierId('priority')
    const original = baseState()
    const state: DecisionState = {
      ...original,
      status: { ...original.status!, configuration: { enabled: true, revision: 2, route: {
        provider: 'api', model: 'small', reasoningEffort: effort, serviceTier: tier,
      } } },
      controls: {
        reasoning: { efforts: [{ id: effort, name: 'High' }] },
        serviceTiers: { tiers: [{ id: tier, name: 'Priority' }] },
      },
    }
    const f = renderState(state)
    fireEvent.click(screen.getByText(en.decisionAdvanced))
    expect(screen.getByRole('combobox', { name: en.decisionEffort })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: en.decisionTier })).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: en.decisionEffort }), { target: { value: effort } })
    fireEvent.change(screen.getByRole('combobox', { name: en.decisionTier }), { target: { value: tier } })
    fireEvent.click(screen.getByRole('button', { name: en.decisionSave }))
    expect(f.saveDecision).toHaveBeenCalledWith(true, { provider: 'api', model: 'small', reasoningEffort: effort, serviceTier: tier })
  })
  it('keeps save disabled until a model capability route is complete', () => {
    const state = baseState()
    const f = renderState({ ...state, controls: null, controlsKey: '' })
    fireEvent.click(screen.getByText(en.decisionAdvanced))
    const save = screen.getByRole('button', { name: en.decisionSave }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    expect(f.saveDecision).toHaveBeenCalledWith(false, undefined)
    fireEvent.click(screen.getByRole('switch', { name: en.decisionEnable }))
    expect(save.disabled).toBe(true)
  })
  it('renders unavailable model reasons and both preview result states', () => {
    const original = baseState()
    const state: DecisionState = {
      ...original,
      status: { ...original.status!, models: [...original.status!.models, {
        provider: 'other', model: 'unknown', name: 'Unknown', available: false, reason: 'undeclared',
      }] },
    }
    const f = renderState(state)
    fireEvent.click(screen.getByText(en.decisionAdvanced))
    expect(screen.getByRole('option', { name: /Unknown.*Unavailable/ })).toBeTruthy()
    act(() => { f.source.set({ ...f.source.getSnapshot(), preview: [] }) })
    expect(screen.getByText(en.noResults)).toBeTruthy()
    act(() => { f.source.set({ ...f.source.getSnapshot(), preview: [{ id: 'a', name: 'A result' }] }) })
    expect(screen.getByText('A result')).toBeTruthy()
  })
  it('renders and dismisses saved and failed notices', () => {
    const source = createSnapshotStore<DecisionState>(baseState())
    const dismiss = vi.fn()
    render(<DecisionToast useDecision={bindSnapshotSelector(source)} dismissDecisionNotice={dismiss} t={t} />)
    expect(screen.queryByRole('alert')).toBeNull()
    act(() => { source.set({ ...source.getSnapshot(), notice: 'saved' }) })
    expect(screen.getByRole('alert').textContent).toContain(en.decisionSaved)
    cleanup()
    render(<DecisionToast useDecision={bindSnapshotSelector(source)} dismissDecisionNotice={dismiss} t={t} />)
    act(() => { source.set({ ...source.getSnapshot(), notice: 'error' }) })
    expect(screen.getByRole('alert').textContent).toContain(en.decisionError)
  })
})
