// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { SkillLibraryId, SkillLibraryItem, SkillCleanupProposalId, SkillRevisionId } from '@deepseek-ai/dsh-skill-library/types'
import { SkillLibraryPage, type SkillLibraryPageProps } from '../src/client/SkillLibraryPage.tsx'
import { en } from '../src/client/locales.ts'
import { createNavigationStore } from '../src/client/navigation-store.ts'
import { learningProposal, learningStatus, evidence } from './learning-fixtures.ts'
import { createLearningState, type SkillLibraryState } from '../src/client/controller.ts'

afterEach(cleanup)
const id = 'release' as SkillLibraryId
const item: SkillLibraryItem = { id, name: 'Release workflow',
  description: 'Ship verified releases', provider: 'filesystem', source: 'project',
  path: '/work/project/.dsh/skills/release/SKILL.md', scope: 'project', projectIds: ['project'],
  ownership: 'protected', status: 'active', shadowed: false, pinned: false, automaticCleanup: false,
  invocation: { modelInvocable: true, userInvocable: true }, contentHash: 'hash', bodyBytes: 560,
  usage: { coverage: 'unknown', loadCount: 0 }, references: [], capabilities: { adopt: true,
    archive: false, restore: false, cleanup: false, native: false } }
const dictionary = { ...commonEn, ...en }
const t: SkillLibraryPageProps['t'] = (key, params) => Object.entries(params ?? {}).reduce(
  (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionary[key])

function fixture(patch: Partial<SkillLibraryState> = {}) {
  const data = createSnapshotStore<SkillLibraryState>({ status: 'ready', inventory: { items: [item,
    { ...item, id: 'filesystem:/skills/review/SKILL.md' as SkillLibraryId, name: 'Review workflow',
      scope: 'shared', projectIds: [], ownership: 'vendor' }], projects: [{ id: 'project',
    title: 'Y Harness', path: '/work/project' }], providers: [], bodyBudgetBytes: 6000 },
  readError: false, detail: null, detailId: null, detailStatus: 'idle', busy: false,
  cleanupOpen: false, previewLoading: false, previewError: false, proposal: null, notice: null,
  learning: createLearningState(), ...patch })
  const navigation = createNavigationStore().create()
  const callbacks = {
    ensure: vi.fn(), refresh: vi.fn(), loadDetail: vi.fn(), act: vi.fn(), preview: vi.fn(), closePreview: vi.fn(),
    applyPreview: vi.fn(), rollback: vi.fn(), dismissNotice: vi.fn(), refreshLearning: vi.fn(), loadReview: vi.fn(),
    proposeLearning: vi.fn(), validateReview: vi.fn(), approveReview: vi.fn(), rejectReview: vi.fn(
    ), approvePolicy: vi.fn(), revokePolicy: vi.fn(),
    setLearningAutomatic: vi.fn(), cleanupSemantic: vi.fn(),
  }
  render(<SkillLibraryPage {...callbacks} useLibrary={bindSnapshotSelector(data)} useStore={bindSnapshotSelector(navigation)}
    actions={navigation.actions} t={t} />)
  return { data, navigation, ...callbacks }
}

describe('skill library panel', () => {
  it('offers historical restore with the current source and retained revision', () => {
    const revisionId = 'revision:learning' as SkillRevisionId
    const managed = { ...item, ownership: 'y-managed' as const, contentHash: 'reduced-hash',
      capabilities: { ...item.capabilities, adopt: false, archive: true, cleanup: true } }
    const state = fixture({ inventory: { items: [managed], projects: [], providers: [], bodyBudgetBytes: 6000 },
      detailId: id, detailStatus: 'ready', detail: { item: managed, content: 'Reduced instructions', revisions: [{
        id: revisionId, createdAt: '2026-10-09T01:00:00Z', reason: 'learning',
        beforeHash: 'original-hash', afterHash: 'reduced-hash', beforeBytes: 120, afterBytes: 90,
      }] } })
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Release workflow' }))
    expect(screen.getByText('Learning maintenance')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Restore content from before this revision' }))
    expect(state.rollback).toHaveBeenCalledWith(managed, revisionId)
  })

  it('approves project learning from an empty library after explicit project selection', () => {
    const state = fixture({ inventory: { items: [], projects: [{ id: 'project', title: 'Y Harness',
      path: '/work/project' }], providers: [], bodyBudgetBytes: 6000 }, learning: {
      ...createLearningState(), status: 'ready', providers: { availability: [], generators: [
        'native-observation'], validators: [{ id: 'native-observation-validator', trusted: true }],
      policies: [], optIns: [], evidence: [] },
    } })
    fireEvent.click(screen.getByRole('button', { name: 'Project learning' }))
    const dialog = screen.getByRole('dialog', { name: 'Project learning' })
    const approve = within(dialog).getByRole('button', { name: 'Approve project learning' })
    expect(approve.hasAttribute('disabled')).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Learning project' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Y Harness' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Allow new skills from native work' }))
    expect(state.approvePolicy).not.toHaveBeenCalled()
    fireEvent.click(approve)
    expect(state.approvePolicy).toHaveBeenCalledWith({ validatorId: 'native-observation-validator',
      generatorId: 'native-observation', projectId: 'project', operations: ['create', 'update'] })
    expect(state.act).not.toHaveBeenCalled()
    expect(state.loadDetail).not.toHaveBeenCalled()
  })

  it('confirms reversible deletion and keeps archived restore easy to find', () => {
    const managed = { ...item, ownership: 'y-managed' as const,
      capabilities: { ...item.capabilities, adopt: false, archive: true, cleanup: true } }
    const archived = { ...managed, id: 'retired' as SkillLibraryId, name: 'Retired workflow', status: 'archived' as const,
      capabilities: { ...managed.capabilities, archive: false, cleanup: false, restore: true } }
    const state = fixture({ inventory: { items: [managed, archived], projects: [], providers: [], bodyBudgetBytes: 6000 },
      detail: { item: managed, content: 'Instructions', revisions: [] }, detailId: id, detailStatus: 'ready' })
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Release workflow' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = screen.getByRole('dialog', { name: 'Delete skill' })
    expect(within(dialog).getByText(/retain its full bundle/)).toBeTruthy()
    expect(state.act).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(state.act).toHaveBeenCalledWith('archive', managed)
    fireEvent.click(screen.getByRole('button', { name: 'Deleted skills' }))
    expect(state.navigation.getSnapshot().status).toBe('archived')
    expect(screen.queryByRole('button', { name: 'Inspect Release workflow' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Retired workflow' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(state.act).toHaveBeenLastCalledWith('restore', archived)
  })

  it('keeps Delete disabled when a managed skill is pinned', () => {
    const pinned = { ...item, pinned: true, ownership: 'y-managed' as const,
      capabilities: { ...item.capabilities, adopt: false, archive: true, cleanup: true } }
    const state = fixture({ inventory: { items: [pinned], projects: [], providers: [], bodyBudgetBytes: 6000 } })
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Release workflow' }))
    const button = screen.getByRole('button', { name: 'Delete' })
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.click(button)
    expect(screen.queryByRole('dialog', { name: 'Delete skill' })).toBeNull()
    expect(state.act).not.toHaveBeenCalled()
  })

  it('reserves the macOS shell control band within the compact header', () => {
    const stylesheet = readFileSync('packages/client/ui-skill-library/src/client/SkillLibraryPage.module.css', 'utf8')
    const darwinHeader = stylesheet.match(/:global\(\[data-platform='darwin'\]\) \.header \{([^}]+)\}/)?.[1]
    expect(darwinHeader).toContain('var(--dsh-frame-top-clearance, 0px)')
    expect(darwinHeader).toContain('padding-inline-start: calc(14px + var(--dsh-frame-leading-clearance, 0px))')
  })

  it('resolves shared locale vocabulary through the composed translation seat', () => {
    expect(t('none')).toBe(commonEn.none)
  })
  it('navigates to Review without loading every suggestion or skill body', () => {
    const state = fixture()
    fireEvent.click(screen.getByRole('tab', { name: en.review }))
    expect(state.navigation.getSnapshot().view).toBe('review')
    expect(screen.getByRole('tabpanel')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: en.searchReviews })).toBeTruthy()
    expect(state.loadDetail).not.toHaveBeenCalled()
    expect(state.loadReview).not.toHaveBeenCalled()
  })
  it('groups project and shared skills and treats missing usage as unknown', () => {
    const fixtureState = fixture()
    expect(screen.getByRole('heading', { name: 'Y Harness' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: en.shared })).toBeTruthy()
    expect(screen.getAllByText(en.unknown)).toHaveLength(2)
    expect(screen.queryByText(/unused/i)).toBeNull()
    expect(fixtureState.loadDetail).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Release workflow' }))
    expect(fixtureState.loadDetail).toHaveBeenCalledWith(id)
  })

  it('collapses file folders without reading or changing the selected skill', () => {
    const state = fixture()
    const heading = screen.getByRole('heading', { name: 'Y Harness' })
    const folder = heading.closest('details')
    const summary = heading.closest('summary')
    expect(folder?.open).toBe(true)
    expect(summary).not.toBeNull()
    if (summary === null) throw new Error('Folder summary is missing')
    fireEvent.click(summary)
    expect(folder?.open).toBe(false)
    expect(state.loadDetail).not.toHaveBeenCalled()
    fireEvent.click(summary)
    expect(screen.getByRole('button', { name: 'Inspect Release workflow' })).toBeTruthy()
  })

  it('retains one project and shared explorer across document and graph modes', () => {
    const state = fixture()
    const explorer = screen.getByRole('complementary', { name: 'Skill explorer' })
    expect(within(explorer).getByRole('heading', { name: 'Y Harness' })).toBeTruthy()
    expect(within(explorer).getByRole('heading', { name: en.shared })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: en.graph }))
    expect(screen.getAllByRole('complementary', { name: 'Skill explorer' })).toHaveLength(1)
    expect(within(screen.getByRole('complementary', { name: 'Skill explorer' })).getByRole('heading', { name: en.shared })).toBeTruthy()
    expect(screen.getByRole('application', { name: en.graphLabel })).toBeTruthy()
    expect(state.loadDetail).not.toHaveBeenCalled()
  })

  it('can hide and restore the explorer without resetting filters or reading instructions', () => {
    const state = fixture()
    fireEvent.change(screen.getByRole('textbox', { name: en.search }), { target: { value: 'Review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Hide explorer' }))
    expect(screen.queryByRole('complementary', { name: 'Skill explorer' })).toBeNull()
    expect(state.navigation.getSnapshot().query).toBe('Review')
    fireEvent.click(screen.getByRole('tab', { name: en.graph }))
    expect(screen.queryByRole('complementary', { name: 'Skill explorer' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show explorer' }))
    expect(within(screen.getByRole('complementary', { name: 'Skill explorer' })).getByRole('button',
      { name: 'Inspect Review workflow' })).toBeTruthy()
    expect(state.loadDetail).not.toHaveBeenCalled()
  })

  it('collapses and restores the graph inspector while retaining selection and loaded instructions', () => {
    const state = fixture({ detail: { item, content: 'Run the focused check.', revisions: [] }, detailId: id, detailStatus: 'ready' })
    fireEvent.click(screen.getByRole('tab', { name: en.graph }))
    const node = screen.getByRole('button', { name: 'Open skill Release workflow' })
    fireEvent.click(node)
    expect(screen.getByRole('complementary', { name: en.details })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Hide inspector' }))
    expect(screen.queryByRole('complementary', { name: en.details })).toBeNull()
    expect(state.navigation.getSnapshot().selectedId).toBe(id)
    expect(node.getAttribute('aria-pressed')).toBe('true')
    const restore = screen.getByRole('button', { name: 'Show inspector' })
    expect(document.activeElement).toBe(restore)
    fireEvent.click(restore)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Hide inspector' }))
    expect(screen.getByText('Run the focused check.')).toBeTruthy()
    expect(state.loadDetail).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Hide inspector' }))
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Skill explorer' })).getByRole(
      'button', { name: 'Inspect Release workflow' }))
    expect(screen.getByRole('complementary', { name: en.details })).toBeTruthy()
  })

  it('offers keyboard graph zoom and exposes selected skill state', () => {
    const state = fixture()
    fireEvent.click(screen.getByRole('tab', { name: en.graph }))
    const graph = screen.getByRole('application', { name: en.graphLabel })
    const layer = graph.querySelector('g')
    const before = layer?.getAttribute('transform')
    fireEvent.keyDown(graph, { key: '+' })
    expect(layer?.getAttribute('transform')).not.toBe(before)
    fireEvent.keyDown(graph, { key: '-' })
    const node = screen.getByRole('button', { name: 'Open skill Release workflow' })
    fireEvent.click(node)
    expect(node.getAttribute('aria-pressed')).toBe('true')
    expect(state.loadDetail).toHaveBeenCalledWith(id)
  })

  it('labels the document read-only and keeps semantic maintenance extension status explicit', () => {
    fixture({ detail: { item, content: '## Steps\nRun validation.', revisions: [] }, detailId: id, detailStatus: 'ready' })
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Release workflow' }))
    expect(screen.getByText(en.readOnly)).toBeTruthy()
    expect(screen.getByText(/## Steps\s+Run validation\./)).toBeTruthy()
    expect(screen.getByText(en.semanticExtensionStatus)).toBeTruthy()
    expect(screen.getByText(en.sourceVersion)).toBeTruthy()
  })

  it('searches metadata and filters projects while retaining shared skills', () => {
    fixture()
    fireEvent.change(screen.getByRole('textbox', { name: en.search }), { target: { value: 'Review' } })
    expect(screen.queryByRole('button', { name: 'Inspect Release workflow' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Inspect Review workflow' })).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: en.search }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: en.project }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Y Harness' }))
    expect(screen.getByRole('button', { name: 'Inspect Review workflow' })).toBeTruthy()
  })

  it('requires deliberate adoption and does not offer source maintenance for protected items', () => {
    const state = fixture({ detail: { item, content: '## Steps\nRun validation.', revisions: [] }, detailId: id, detailStatus: 'ready' })
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Release workflow' }))
    expect(screen.queryByRole('button', { name: en.archive })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.adopt }))
    const dialog = screen.getByRole('dialog', { name: en.adoptTitle })
    expect(state.act).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: en.adopt }))
    expect(state.act).toHaveBeenCalledWith('adopt', item)
  })

  it('shows actual graph nodes and opens selected skill details', () => {
    const state = fixture()
    fireEvent.click(screen.getByRole('tab', { name: en.graph }))
    expect(screen.getByRole('application', { name: en.graphLabel })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open skill Release workflow' }))
    expect(state.navigation.getSnapshot().selectedId).toBe(id)
    expect(state.loadDetail).toHaveBeenCalledWith(id)
    fireEvent.click(screen.getByRole('button', { name: en.zoomIn }))
    fireEvent.click(screen.getByRole('button', { name: en.fit }))
  })

  it('keeps graph edges out of pointer targeting and opens nodes through their complete hit area', () => {
    const state = fixture()
    fireEvent.click(screen.getByRole('tab', { name: en.graph }))
    fireEvent.click(screen.getByRole('button', { name: 'Filter project Y Harness' }))
    fireEvent.click(screen.getByRole('button', { name: en.fit }))
    const graph = screen.getByRole('application', { name: en.graphLabel })
    const edges = Array.from(graph.querySelectorAll('line'))
    expect(edges.length).toBeGreaterThan(0)
    expect(edges.every(edge => edge.getAttribute('pointer-events') === 'none')).toBe(true)
    const node = screen.getByRole('button', { name: 'Open skill Release workflow' })
    const hit = Array.from(graph.querySelectorAll('[data-graph-hit]'))
      .find(candidate => candidate.getAttribute('data-graph-hit-for') === node.getAttribute('data-graph-id'))
    expect(hit).toBeDefined()
    if (hit !== undefined) fireEvent.click(hit)
    expect(state.loadDetail).toHaveBeenCalledWith(id)
  })

  it('keeps archived skills from an unregistered project visible in the graph', () => {
    const archived = { ...item, id: 'archived' as SkillLibraryId, name: 'Retired release',
      projectIds: ['old-project'], status: 'archived' as const }
    fixture({ inventory: { items: [archived], projects: [], providers: [], bodyBudgetBytes: 6000 } })
    fireEvent.click(screen.getByRole('tab', { name: en.graph }))
    expect(screen.getByRole('button', { name: 'Open skill Retired release' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Filter project old-project' })).toBeTruthy()
  })

  it('keeps unavailable sources visible in the compact status area across modes', () => {
    fixture({ inventory: { items: [item], projects: [{ id: 'project', title: 'Y Harness',
      path: '/work/project' }], providers: [{ provider: 'codex', state: 'disconnected' }], bodyBudgetBytes: 6000 } })
    const warning = screen.getByText(en.sourceUnavailable)
    fireEvent.click(warning)
    expect(screen.getByText(en.providerUnavailable)).toBeTruthy()
    expect(screen.getByText('codex · Disconnected')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: en.graph }))
    expect(screen.getByText(en.sourceUnavailable)).toBeTruthy()
  })

  it('shows native metadata as unknown instead of an empty skill body', () => {
    const native = { ...item, bodyBytes: 0, contentHash: '', ownership: 'vendor' as const,
      capabilities: { adopt: false, archive: false, restore: false, cleanup: false, native: true } }
    const state = fixture({ inventory: { items: [native], projects: [], providers: [{
      provider: 'codex', state: 'disconnected' }], bodyBudgetBytes: 6000 },
    detailId: id, detailStatus: 'ready', detail: { item: native, content: '', revisions: [] } })
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Release workflow' }))
    expect(screen.getByText(en.unknownSize)).toBeTruthy()
    expect(screen.getByText(en.instructionsUnavailable)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.adopt })).toBeNull()
    expect(state.act).not.toHaveBeenCalled()
  })

  it('confirms deleting a shared managed skill and exposes restore for archived items', () => {
    const managed = { ...item, scope: 'shared' as const, projectIds: [], ownership: 'y-managed' as const,
      capabilities: { ...item.capabilities, adopt: false, archive: true, cleanup: true } }
    const state = fixture({ inventory: { items: [managed], projects: [], providers: [], bodyBudgetBytes: 6000 },
      detail: { item: managed, content: 'Instructions', revisions: [] }, detailId: id, detailStatus: 'ready' })
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Release workflow' }))
    fireEvent.click(screen.getByRole('button', { name: en.deleteSkill }))
    const dialog = screen.getByRole('dialog', { name: en.deleteTitle })
    expect(within(dialog).getByText(en.deleteDescription)).toBeTruthy()
    expect(state.act).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: en.deleteSkill }))
    expect(state.act).toHaveBeenCalledWith('archive', managed)
    const archived = { ...managed, status: 'archived' as const, capabilities: { ...managed.capabilities, archive: false, restore: true } }
    act(() => { state.data.set({ ...state.data.getSnapshot(), inventory: { items: [archived],
      projects: [], providers: [], bodyBudgetBytes: 6000 }, detail: { item: archived,
      content: 'Instructions', revisions: [] } }) })
    fireEvent.click(screen.getByRole('button', { name: en.restore }))
    expect(state.act).toHaveBeenLastCalledWith('restore', archived)
  })

  it('shows a reviewed diff before an explicit cleanup application', () => {
    const state = fixture({ cleanupOpen: true, proposal: { id: 'preview' as SkillCleanupProposalId,
      createdAt: '2026-10-09T00:00:00Z', skipped: [], changes: [{ id, name: item.name,
        expectedHash: 'hash', before: 'Old instructions', after: 'Short instructions', beforeBytes: 30,
        afterBytes: 20, overBudget: false }] } })
    const dialog = screen.getByRole('dialog', { name: en.cleanupTitle })
    expect(within(dialog).getByText('Old instructions')).toBeTruthy()
    expect(within(dialog).getByText('Short instructions')).toBeTruthy()
    expect(state.applyPreview).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: en.apply }))
    expect(state.applyPreview).toHaveBeenCalledOnce()
  })
})

describe('skill library recovery and deliberate gestures', () => {
  it.each(['loading', 'error'] as const)('renders an initial %s inventory without loading source bodies', (status) => {
    const f = fixture({ status, inventory: null, readError: status === 'error' })
    expect(f.loadDetail).not.toHaveBeenCalled()
    if (status === 'loading') expect(screen.getByRole('status', { name: en.loading })).toBeTruthy()
    else { expect(screen.getByText(en.loadError)).toBeTruthy(); fireEvent.click(screen.getByRole('button', { name: en.retry })); expect(f.refresh).toHaveBeenCalledOnce() }
  })
  it('refreshes metadata deliberately and distinguishes an empty library from a filtered result', () => {
    const f = fixture({ inventory: { items: [], projects: [], providers: [], bodyBudgetBytes: 1000 } })
    expect(screen.getAllByText(en.empty).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: en.refresh })); expect(f.refresh).toHaveBeenCalledOnce()
    act(() => { f.data.set({ ...f.data.getSnapshot(), inventory: { items: [item], projects: [], providers: [], bodyBudgetBytes: 1000 } }) })
    fireEvent.change(screen.getByRole('textbox', { name: en.search }), { target: { value: 'unrelated' } })
    expect(screen.getByText(en.noResults)).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: en.graph })); expect(screen.getAllByText(en.noResults)).toHaveLength(2)
    fireEvent.change(screen.getByRole('textbox', { name: en.search }), { target: { value: '' } })
    act(() => { f.data.set({ ...f.data.getSnapshot(), inventory: { items: [], projects: [], providers: [], bodyBudgetBytes: 1000 } }) })
    expect(screen.getAllByText(en.empty)).toHaveLength(2)
  })
  it('filters status, shared scope and unregistered projects using inventory metadata', () => {
    const outsider = { ...item, id: 'outside' as SkillLibraryId, name: 'Other project skill', projectIds: ['elsewhere'], status: 'disabled' as const }
    const f = fixture({ inventory: { items: [item, outsider, { ...item, id: 'shared' as SkillLibraryId, name: 'Shared skill', scope: 'shared', projectIds: [] }], projects: [], providers: [], bodyBudgetBytes: 1000 } })
    fireEvent.click(screen.getByRole('button', { name: en.project })); fireEvent.click(screen.getByRole('menuitem', { name: en.shared }))
    expect(screen.queryByRole('button', { name: 'Inspect Release workflow' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Inspect Shared skill' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.project })); fireEvent.click(screen.getByRole('menuitem', { name: 'elsewhere' }))
    expect(screen.queryByRole('button', { name: 'Inspect Release workflow' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.status })); fireEvent.click(screen.getByRole('menuitem', { name: en.disabled }))
    expect(screen.getByRole('button', { name: 'Inspect Other project skill' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Inspect Shared skill' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.deletedSkills })); fireEvent.click(screen.getByRole('button', { name: en.deletedSkills }))
    expect(f.navigation.getSnapshot().status).toBe('all')
  })
  it('loads detail on demand, offers retry after body failure, and closes a library selection', () => {
    const f = fixture({ detailId: id, detailStatus: 'loading' })
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Release workflow' }))
    expect(screen.getByRole('status', { name: en.loading })).toBeTruthy()
    act(() => { f.data.set({ ...f.data.getSnapshot(), detailStatus: 'error' }) })
    expect(screen.getByText(en.detailError)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.retry })); expect(f.loadDetail).toHaveBeenCalledTimes(2)
    fireEvent.click(within(screen.getByRole('complementary', { name: en.details })).getByRole('button', { name: en.close }))
    expect(f.navigation.getSnapshot().selectedId).toBeNull()
    expect(screen.queryByRole('complementary', { name: en.details })).toBeNull()
  })
  it('keeps pin and automatic cleanup bound to the loaded source and shows observed usage limits', () => {
    const managed = { ...item, ownership: 'y-managed' as const, pinned: true, automaticCleanup: true, shadowed: true, invocation: { modelInvocable: false, userInvocable: false }, bodyBytes: 9000, usage: { coverage: 'recorded-loads' as const, loadCount: 3, lastLoadedAt: '2026-10-09T00:00:00Z' }, capabilities: { ...item.capabilities, adopt: false, cleanup: true, archive: true } }
    const f = fixture({ detailId: id, detailStatus: 'ready', detail: { item: managed, content: 'Observed body', revisions: [] } })
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Release workflow' }))
    const detail = within(screen.getByRole('complementary', { name: en.details }))
    expect(detail.getByText(en.shadowed)).toBeTruthy(); expect(detail.getByText(en.overBudget)).toBeTruthy()
    expect(detail.getAllByText(en.blocked)).toHaveLength(2); expect(detail.getByText(en.usageRecorded)).toBeTruthy()
    fireEvent.click(detail.getByRole('button', { name: en.unpin })); expect(f.act).toHaveBeenCalledWith('unpin', managed)
    act(() => { f.data.set({ ...f.data.getSnapshot(), detail: { item: { ...managed, pinned: false }, content: 'Observed body', revisions: [] } }) })
    fireEvent.click(detail.getByRole('switch', { name: en.automatic })); expect(f.act).toHaveBeenLastCalledWith('automaticOff', { ...managed, pinned: false })
    act(() => { f.data.set({ ...f.data.getSnapshot(), detail: { item: { ...managed, pinned: false, automaticCleanup: false }, content: 'Observed body', revisions: [] } }) })
    fireEvent.click(detail.getByRole('switch', { name: en.automatic })); expect(f.act).toHaveBeenLastCalledWith('automaticOn', { ...managed, pinned: false, automaticCleanup: false })
    fireEvent.click(detail.getByRole('button', { name: en.whitespaceCleanupSelected })); expect(f.preview).toHaveBeenCalledWith([id])
  })
  it('follows a currently resolved reference while retaining unresolved and missing references', () => {
    const relatedId = 'related' as SkillLibraryId
    const related = { ...item, id: relatedId, name: 'Related source' }
    const source = { ...item, references: [{ target: 'Read related source', kind: 'skill' as const, resolvedId: relatedId }, { target: 'Unavailable reference', kind: 'skill' as const }, { target: 'Removed reference', kind: 'skill' as const, resolvedId: 'missing' as SkillLibraryId }] }
    const f = fixture({ inventory: { items: [source, related], projects: [], providers: [], bodyBudgetBytes: 1000 }, detailId: id, detailStatus: 'ready', detail: { item: source, content: 'Body', revisions: [] } })
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Release workflow' }))
    expect(screen.getByText('Unavailable reference')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Removed reference' })); expect(f.loadDetail).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Read related source' })); expect(f.navigation.getSnapshot().selectedId).toBe(relatedId)
    expect(f.loadDetail).toHaveBeenLastCalledWith(relatedId)
  })
  it('cancels adoption and deletion without issuing a source action', () => {
    const f = fixture(); fireEvent.click(screen.getByRole('button', { name: 'Inspect Release workflow' }))
    fireEvent.click(screen.getByRole('button', { name: en.adopt }))
    let dialog = screen.getByRole('dialog', { name: en.adoptTitle }); fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))
    expect(f.act).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.adopt })); dialog = screen.getByRole('dialog', { name: en.adoptTitle })
    fireEvent.click(within(dialog).getByRole('button', { name: en.close })); expect(f.act).not.toHaveBeenCalled()
  })
  it('renders cleanup history reasons and only restores the selected revision', () => {
    const revisions = (['cleanup', 'rollback'] as const).map(reason => ({ id: `revision:${reason}` as SkillRevisionId, createdAt: '2026-10-09T00:00:00Z', reason, beforeHash: 'before', afterHash: 'hash', beforeBytes: 90, afterBytes: 60 }))
    const f = fixture({ detailId: id, detailStatus: 'ready', detail: { item, content: 'Body', revisions } })
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Release workflow' }))
    expect(screen.getByText(en.revisionCleanup)).toBeTruthy(); expect(screen.getByText(en.revisionRollback)).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: en.rollback })[0]!); expect(f.rollback).toHaveBeenCalledWith(item, revisions[0]!.id)
  })
  it.each([{ previewLoading: true }, { previewError: true }, { proposal: { id: 'preview' as SkillCleanupProposalId, createdAt: '', changes: [], skipped: [{ id, reason: 'Protected' }] } }])('refuses unreviewed or empty cleanup and permits dismissal %j', (patch) => {
    const f = fixture({ cleanupOpen: true, ...patch }); const dialog = screen.getByRole('dialog', { name: en.cleanupTitle })
    expect(within(dialog).getByRole('button', { name: en.apply }).hasAttribute('disabled')).toBe(true)
    if (patch.previewLoading) expect(within(dialog).getByRole('status', { name: en.loading })).toBeTruthy()
    if (patch.previewError) expect(within(dialog).getByText(en.loadError)).toBeTruthy()
    if (patch.proposal) expect(within(dialog).getByText(en.cleanupEmpty)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en.cancel })); expect(f.closePreview).toHaveBeenCalledOnce(); expect(f.applyPreview).not.toHaveBeenCalled()
  })
  it('reviews an over-budget cleanup diff and keeps Cancel unavailable while applying', () => {
    const f = fixture({ cleanupOpen: true, proposal: { id: 'preview' as SkillCleanupProposalId, createdAt: '', skipped: [{ id, reason: 'Protected' }], changes: [{ id, name: item.name, expectedHash: 'hash', before: 'Old', after: 'New', beforeBytes: 30, afterBytes: 20, overBudget: true }] } })
    const dialog = screen.getByRole('dialog', { name: en.cleanupTitle }); expect(within(dialog).getByText(en.overBudget)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en.close })); expect(f.closePreview).toHaveBeenCalledOnce()
    act(() => { f.data.set({ ...f.data.getSnapshot(), busy: true }) })
    fireEvent.click(within(dialog).getByRole('button', { name: en.cancel })); expect(f.closePreview).toHaveBeenCalledOnce()
    expect(within(dialog).getByRole('button', { name: en.apply }).hasAttribute('disabled')).toBe(true)
  })
  it('opens retained source history from Review and updates only its navigation selection', () => {
    const proposal = { ...learningProposal, state: 'applied' as const, appliedIds: [id] }
    const f = fixture({ learning: { ...createLearningState(), status: 'ready', detail: proposal, detailId: proposal.id, detailStatus: 'ready', evidence: [evidence], providers: learningStatus } })
    fireEvent.click(screen.getByRole('tab', { name: en.review }))
    expect(f.navigation.getSnapshot().selectedReviewId).toBe(proposal.id)
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Release workflow' }))
    expect(f.navigation.getSnapshot()).toMatchObject({ view: 'library', selectedId: id, selectedReviewId: proposal.id })
    expect(f.loadDetail).toHaveBeenCalledWith(id)
  })
})

it('pins an observed unpinned skill and requests a library-wide preview separately', () => {
  const f = fixture(); fireEvent.click(screen.getByRole('button', { name: 'Inspect Release workflow' }))
  fireEvent.click(screen.getByRole('button', { name: en.pin })); expect(f.act).toHaveBeenCalledWith('pin', item)
  fireEvent.click(screen.getByRole('button', { name: en.cleanup })); expect(f.preview).toHaveBeenCalledWith()
  fireEvent.click(screen.getByRole('button', { name: en.project })); fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull(); expect(f.navigation.getSnapshot().project).toBe('all')
})
it('expands long cleanup instructions without applying the reviewed proposal', () => {
  const before = Array.from({ length: 80 }, (_, i) => `Old cleanup instruction ${i}`).join('\n')
  const after = Array.from({ length: 80 }, (_, i) => `New cleanup instruction ${i}`).join('\n')
  const f = fixture({ cleanupOpen: true, proposal: { id: 'preview' as SkillCleanupProposalId, createdAt: '', skipped: [], changes: [{ id, name: item.name, expectedHash: 'hash', before, after, beforeBytes: 1000, afterBytes: 900, overBudget: false }] } })
  fireEvent.click(screen.getByRole('button', { name: /Expand.*lines/i }))
  expect(screen.getByText(/New cleanup instruction 79/)).toBeTruthy(); expect(f.applyPreview).not.toHaveBeenCalled()
})
