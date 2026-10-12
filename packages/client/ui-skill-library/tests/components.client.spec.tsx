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
