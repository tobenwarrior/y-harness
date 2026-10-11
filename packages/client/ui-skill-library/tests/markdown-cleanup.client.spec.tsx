// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { SkillCleanupChange, SkillCleanupProposalId, SkillLibraryId } from '@deepseek-ai/dsh-skill-library/types'
import { SkillLibraryPage, type SkillLibraryPageProps } from '../src/client/SkillLibraryPage.tsx'
import { en, zh } from '../src/client/locales.ts'
import { createNavigationStore } from '../src/client/navigation-store.ts'
import { createLearningState, type SkillLibraryState } from '../src/client/controller.ts'

afterEach(cleanup)
const id = 'split-source' as SkillLibraryId
const generation = 'a'.repeat(64)
const files = [
  { path: 'topics/001-checks.md', content: '# Checks\n\nRun the focused check.\n' },
  { path: 'source/0000.txt', content: '# Workflow\n\nOriginal introduction.\n' },
  { path: 'source/0001.txt', content: '## Checks\n\nRun the focused check.\n' },
  { path: 'entry.txt', content: '# Workflow\n\n[Checks](topics/001-checks.md)\n' },
]
const rootChange: SkillCleanupChange = { id, name: 'Workflow', expectedHash: 'hash',
  before: '# Workflow\n\nOriginal introduction.\n\n## Checks\n\nRun the focused check.\n',
  after: '# Workflow\n\n[Checks](.y-topics/generation/topics/001-checks.md)\n',
  beforeBytes: 300, afterBytes: 100, overBudget: false,
}
const change: SkillCleanupChange = { ...rootChange, markdownGeneration: { id: generation, files } }
const locales = [
  { locale: 'en', dictionary: { ...commonEn, ...en }, copy: en },
  { locale: 'zh', dictionary: { ...commonZh, ...zh }, copy: zh },
] as const

function fixture(dictionary: typeof locales[number]['dictionary'], changes: readonly SkillCleanupChange[]) {
  const data = createSnapshotStore<SkillLibraryState>({ status: 'ready', inventory: {
    items: [], projects: [], providers: [], bodyBudgetBytes: 6000 }, readError: false,
  detail: null, detailId: null, detailStatus: 'idle', busy: false, cleanupOpen: true,
  previewLoading: false, previewError: false, proposal: { id: 'preview' as SkillCleanupProposalId,
    createdAt: '2026-10-11T00:00:00Z', changes, skipped: [] }, notice: null, learning: createLearningState() })
  const navigation = createNavigationStore().create()
  const t: SkillLibraryPageProps['t'] = (key, params) => Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionary[key])
  const callbacks = {
    ensure: vi.fn(), refresh: vi.fn(), loadDetail: vi.fn(), act: vi.fn(), preview: vi.fn(), closePreview: vi.fn(),
    applyPreview: vi.fn(), rollback: vi.fn(), dismissNotice: vi.fn(), refreshLearning: vi.fn(), loadReview: vi.fn(),
    proposeLearning: vi.fn(), validateReview: vi.fn(), approveReview: vi.fn(), rejectReview: vi.fn(),
    approvePolicy: vi.fn(), revokePolicy: vi.fn(), setLearningAutomatic: vi.fn(), cleanupSemantic: vi.fn(),
  }
  render(<SkillLibraryPage {...callbacks} useLibrary={bindSnapshotSelector(data)}
    useStore={bindSnapshotSelector(navigation)} actions={navigation.actions} t={t} />)
  return { ...callbacks, t }
}

describe.each(locales)('managed Markdown cleanup preview ($locale)', ({ dictionary, copy }) => {
  it('shows the root and every topic, source receipt and entry receipt before application', () => {
    const state = fixture(dictionary, [change])
    const dialog = screen.getByRole('dialog', { name: copy.cleanupTitle })
    expect(within(dialog).getByText(change.name, { selector: '[data-diff] *' })).toBeTruthy()
    for (const file of files) {
      expect(within(dialog).getByText(`.y-topics/${generation}/${file.path}`)).toBeTruthy()
      const marker = file.content.split('\n').find(line => line !== '')!
      expect(within(dialog).getAllByText(marker).length).toBeGreaterThan(0)
    }
    expect(state.applyPreview).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: copy.apply }))
    expect(state.applyPreview).toHaveBeenCalledOnce()
  })

  it('counts root reduction and all generated files without claiming storage savings for mixed changes', () => {
    const whitespace: SkillCleanupChange = { ...rootChange, id: 'whitespace' as SkillLibraryId,
      name: 'Other workflow', before: 'Before whitespace cleanup', after: 'After whitespace cleanup',
      beforeBytes: 50, afterBytes: 40 }
    const state = fixture(dictionary, [change, whitespace])
    const dialog = screen.getByRole('dialog', { name: copy.cleanupTitle })
    expect(within(dialog).getByText(state.t('cleanupSplitSummary', { count: 2, bytes: 210, files: 4 }))).toBeTruthy()
    expect(within(dialog).queryByText(state.t('cleanupSummary', { count: 2, bytes: 210 }))).toBeNull()
    expect(state.loadDetail).not.toHaveBeenCalled()
  })

  it('retains the whitespace-only summary without generated file diffs', () => {
    const state = fixture(dictionary, [rootChange])
    const dialog = screen.getByRole('dialog', { name: copy.cleanupTitle })
    expect(within(dialog).getByText(state.t('cleanupSummary', { count: 1, bytes: 200 }))).toBeTruthy()
    expect(within(dialog).queryByText(`.y-topics/${generation}/entry.txt`)).toBeNull()
  })

  it('keeps every generated filename visible and expands long child content independently', () => {
    const payload = Array.from({ length: 70 }, (_, index) => `Retained instruction ${index}`).join('\n')
    const children = Array.from({ length: 64 }, (_, index) => ({ path: `source/${String(index).padStart(4, '0')}.txt`,
      content: index === 0 ? payload : `Exact receipt ${index}\n` }))
    fixture(dictionary, [{ ...change, markdownGeneration: { id: generation, files: children } }])
    const dialog = screen.getByRole('dialog', { name: copy.cleanupTitle })
    const paths = within(dialog).getAllByText(text => text.startsWith(`.y-topics/${generation}/`))
      .map(element => element.textContent)
    expect(paths).toEqual(children.map(file => `.y-topics/${generation}/${file.path}`))
    expect(within(dialog).queryByText('Retained instruction 35')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: copy.expand.replace('{count}', '47') }))
    expect(within(dialog).getByText('Retained instruction 35')).toBeTruthy()
  })
})
