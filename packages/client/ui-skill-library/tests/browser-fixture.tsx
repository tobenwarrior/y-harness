/** Synthetic, in-memory browser fixture. It never contacts the Host or a native runtime. */
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { SkillLibraryId, SkillLibraryItem, SkillLibraryList } from '@deepseek-ai/dsh-skill-library/types'
import { SkillLibraryPage, type SkillLibraryPageProps } from '../src/client/SkillLibraryPage.tsx'
import { createNavigationStore } from '../src/client/navigation-store.ts'
import { createLearningState, type SkillLibraryState } from '../src/client/controller.ts'
import { evidence, learningProposal, learningStatus } from './learning-fixtures.ts'
import { en } from '../src/client/locales.ts'

const projectId = 'harness', memoryId = 'memory'
const names = ['Release workflow', 'Review changes', 'Diagnose a failing test', 'Client UI conventions', 'Document a package', 'Verify API changes', 'Manage worktrees', 'Read a session trace', 'Inspect storage', 'Validate migrations', 'Troubleshoot discovery', 'Check permission rules']
const skills = names.map((name, index): SkillLibraryItem => {
  const project = index < 8 ? projectId : memoryId
  return { id: `fixture:${index}` as SkillLibraryId, name, description: [
    'Check the evidence, review the patch, and publish a verified release.',
    'Review focused changes with concrete findings and source references.',
    'Find the cause before applying the smallest verified correction.',
  ][index % 3]!, provider: 'filesystem', source: 'project', path: `/workspace/${project}/.dsh/skills/${index}/SKILL.md`,
  scope: 'project', projectIds: [project], ownership: index % 3 === 0 ? 'y-managed' : 'protected',
  status: index === 10 ? 'archived' : 'active', shadowed: false, pinned: index === 5, automaticCleanup: false,
  invocation: { modelInvocable: true, userInvocable: true }, contentHash: `hash-${index}`, bodyBytes: 860 + index * 120,
  usage: index % 4 === 1 ? { coverage: 'unknown', loadCount: 0 } : { coverage: 'recorded-loads', loadCount: index * 3 + 2, lastLoadedAt: '2026-10-08T14:00:00Z' },
  references: index === 0 ? [{ target: 'Review changes', kind: 'skill', resolvedId: 'fixture:1' as SkillLibraryId }] : [],
  capabilities: { adopt: index % 3 !== 0, archive: index % 3 === 0, restore: index === 10, cleanup: index % 3 === 0, native: false } }
})
for (const [index, name] of ['Search documentation', 'Write concise updates', 'Plan a multi-step task', 'Check source claims', 'Read a code diff'].entries()) {
  skills.push({ ...skills[index]!, id: `shared:${index}` as SkillLibraryId, name, scope: 'shared', projectIds: [],
    source: index === 3 ? 'Codex' : 'user', path: `/skills/${name}/SKILL.md`, ownership: index === 3 ? 'vendor' : 'protected',
    contentHash: index === 3 ? '' : `shared-${index}`, bodyBytes: index === 3 ? 0 : 1260,
    usage: { coverage: 'unknown', loadCount: 0 }, references: index === 0 ? [{ target: 'Document a package', kind: 'skill', resolvedId: 'fixture:4' as SkillLibraryId }] : [],
    capabilities: { adopt: index !== 3, archive: false, restore: false, cleanup: false, native: index === 3 } })
}
const inventory: SkillLibraryList = { items: skills, projects: [
  { id: projectId, title: 'Y Harness', path: '/workspace/harness' }, { id: memoryId, title: 'Y Memory', path: '/workspace/memory' },
], providers: [{ provider: 'filesystem', state: 'connected' }, { provider: 'codex', state: 'connected' }], bodyBudgetBytes: 6000 }
const content = '# Release workflow\n\nUse after a focused change is ready to review.\n\n## Steps\n1. Inspect the patch and preserve unrelated local work.\n2. Run the checks that cover the changed behavior.\n3. Review the result and record any remaining limitations.\n\n## Constraints\nKeep permission rules intact. Stop if verification fails.\n'
const dictionary = { ...commonEn, ...en }
const t: SkillLibraryPageProps['t'] = (key, params) => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionary[key])

/** Render the production panel against synthetic metadata for isolated visual checks. */
function FixtureBody({ review = false }: { readonly review?: boolean }): ReactNode {
  const proposal = { ...learningProposal, projectId, evidence: [{ ...evidence, projectId }], changes: [{ ...learningProposal.changes[0]!, id: skills[0]!.id, expectedHash: skills[0]!.contentHash, path: skills[0]!.path, before: content, after: '# Release workflow\n\n1. Inspect the patch and preserve unrelated work.\n2. Run the focused regression check.\n3. Review the evidence before publishing.\n\nAsk before publishing.\n' }] }
  const [navigation] = useState(() => {
    const value = createNavigationStore().create()
    value.actions.setView(review ? 'review' : 'graph')
    value.actions.select(skills[0]!.id)
    if (review) value.actions.selectReview(proposal.id)
    return value
  })
  const [data] = useState(() => createSnapshotStore<SkillLibraryState>({ status: 'ready', inventory, readError: false,
    detail: { item: skills[0]!, content, revisions: [] }, detailId: skills[0]!.id, detailStatus: 'ready',
    busy: false, cleanupOpen: false, previewLoading: false, previewError: false, proposal: null, notice: null,
    learning: review ? { status: 'ready', error: false, reviews: [{ ...proposal, changeCount: 1, beforeBytes: content.length, afterBytes: proposal.changes[0]!.after.length }], detail: proposal, detailId: proposal.id, detailStatus: 'ready', evidence: proposal.evidence, providers: { ...learningStatus, availability: [{ projectId, state: 'available', reason: 'Synthetic route' }], evidence: proposal.evidence } } : createLearningState() }))
  const useLibrary: SkillLibraryPageProps['useLibrary'] = selector => useSyncExternalStore(
    listener => data.subscribe(listener), () => selector(data.getSnapshot()))
  const useStore: SkillLibraryPageProps['useStore'] = selector => useSyncExternalStore(
    listener => navigation.subscribe(listener), () => selector(navigation.getSnapshot()))
  const noop = (): void => {}
  return <SkillLibraryPage t={t} useLibrary={useLibrary} useStore={useStore} actions={navigation.actions}
    ensure={noop} refresh={noop} dismissNotice={noop} act={noop} preview={noop} closePreview={noop} applyPreview={noop} rollback={noop}
    refreshLearning={noop} loadReview={noop} proposeLearning={noop} validateReview={noop} approveReview={noop} rejectReview={noop}
    approvePolicy={noop} revokePolicy={noop} setLearningAutomatic={noop} cleanupSemantic={noop}
    loadDetail={(id) => { const item = skills.find(skill => skill.id === id); if (item !== undefined) data.set({ ...data.getSnapshot(), detailId: id, detailStatus: 'ready', detail: { item, content, revisions: [] } }) }} />
}

/** Render the original inventory/graph fixture for its existing screenshot milestone. */
export function SkillLibraryFixture(): ReactNode { return <FixtureBody /> }

/** Render the new review milestone against synthetic work and diffs only. */
export function SkillReviewFixture(): ReactNode { return <FixtureBody review /> }
