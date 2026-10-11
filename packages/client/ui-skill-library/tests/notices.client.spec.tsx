// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { SkillLibraryToast } from '../src/client/SkillLibraryToast.tsx'
import { DecisionToast } from '../src/client/DecisionSettings.tsx'
import { createLearningState, type SkillLibraryState, type LibraryNotice } from '../src/client/controller.ts'
import type { DecisionState } from '../src/client/decision-controller.ts'
import { en } from '../src/client/locales.ts'

const dictionary = { ...commonEn, ...en }
const t: Parameters<typeof SkillLibraryToast>[0]['t'] = (key, params) => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionary[key])
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('operation notices outside the skill panel', () => {
  it.each(['changed', 'restored', 'cleanupApplied', 'semanticCleanupFinished', 'actionError'] as const)('reports %s and dismisses only after its display lifetime', (kind: LibraryNotice['kind']) => {
    vi.useFakeTimers()
    const source = createSnapshotStore<SkillLibraryState>({ status: 'idle', inventory: null, readError: false, detail: null, detailId: null, detailStatus: 'idle', busy: false, cleanupOpen: false, previewLoading: false, previewError: false, proposal: null, notice: null, learning: createLearningState() })
    const dismiss = () => { source.set({ ...source.getSnapshot(), notice: null }) }
    render(<SkillLibraryToast t={t} useLibrary={bindSnapshotSelector(source)} dismissNotice={dismiss} />)
    expect(screen.queryByRole('alert')).toBeNull()
    act(() => { source.set({ ...source.getSnapshot(), notice: { kind, seq: 1 } }) })
    expect(screen.getByRole('alert').textContent).toBe(en[kind])
    act(() => { vi.advanceTimersByTime(3999) }); expect(screen.getByRole('alert')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(1) }); expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['saved', 'error'] as const)('displays and expires a Decision %s outcome', (notice) => {
    vi.useFakeTimers()
    const source = createSnapshotStore<DecisionState>({ phase: 'idle', status: null, projects: [], controls: null, controlsKey: '', capabilityEpoch: 0, busy: false, error: false, preview: null, notice: null })
    render(<DecisionToast t={t} useDecision={bindSnapshotSelector(source)} dismissDecisionNotice={() => {
      source.set({ ...source.getSnapshot(), notice: null })
    }} />)
    expect(screen.queryByRole('alert')).toBeNull()
    act(() => { source.set({ ...source.getSnapshot(), notice }) })
    expect(screen.getByRole('alert').textContent).toBe(notice === 'saved' ? en.decisionSaved : en.decisionError)
    act(() => { vi.advanceTimersByTime(4000) }); expect(screen.queryByRole('alert')).toBeNull()
  })
})
