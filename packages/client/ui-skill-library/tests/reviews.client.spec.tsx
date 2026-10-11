// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { SkillLibraryId, SkillLibraryItem, SkillLibraryList, SkillLearningProposal } from '@deepseek-ai/dsh-skill-library/types'
import { SkillReviews, type SkillReviewsProps } from '../src/client/SkillReviews.tsx'
import { en } from '../src/client/locales.ts'
import { evidence, learningProposal, learningStatus } from './learning-fixtures.ts'

afterEach(cleanup)
const dictionary = { ...commonEn, ...en }
const t: SkillReviewsProps['t'] = (key, params) => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionary[key])
function fixture(patch: Partial<SkillReviewsProps> = {}) {
  const callbacks = {
    loadReview: vi.fn(), validateReview: vi.fn(), approveReview: vi.fn(), rejectReview: vi.fn(), proposeLearning: vi.fn(),
    selectReview: vi.fn(), refreshLearning: vi.fn(), openSkill: vi.fn(),
  }
  render(<SkillReviews t={t} state={{ status: 'ready', error: false, reviews: [{ ...learningProposal, changeCount: 1, beforeBytes: 18, afterBytes: 49 }], detail: learningProposal, detailId: learningProposal.id, detailStatus: 'ready', evidence: [evidence], providers: learningStatus }} inventory={{ items: [{ id: learningProposal.changes[0]!.id!, name: 'Release workflow', description: '', provider: 'filesystem', source: 'project', path: '/work/project/.dsh/skills/release/SKILL.md', scope: 'project', projectIds: ['project'], ownership: 'y-managed', status: 'active', shadowed: false, pinned: false, automaticCleanup: false, invocation: { modelInvocable: true, userInvocable: true }, contentHash: 'hash', bodyBytes: 18, usage: { coverage: 'unknown', loadCount: 0 }, references: [], capabilities: { adopt: false, archive: true, restore: false, cleanup: true, native: false } }], projects: [{ id: 'project', title: 'Y Harness', path: '/work/project' }], providers: [], bodyBudgetBytes: 6000 }} selectedId={learningProposal.id} project="all" query="" busy={false} {...callbacks} {...patch} />)
  return callbacks
}

describe('learning review', () => {
  it('shows observations, uncertainty, resources and diff without claiming completed work is verified', () => {
    const callbacks = fixture()
    expect(screen.getAllByText(en.unverified).length).toBeGreaterThan(0)
    expect(screen.getByText(evidence.task)).toBeTruthy()
    expect(within(screen.getByRole('complementary', { name: en.review })).getByText(learningProposal.uncertainty[0]!)).toBeTruthy()
    expect(screen.getByText('scripts/release.sh')).toBeTruthy()
    expect(screen.getByText('Ask before publishing.')).toBeTruthy()
    expect(screen.getByText('Check the release.')).toBeTruthy()
    expect(screen.getByText('Run the focused regression check before releasing.')).toBeTruthy()
    expect(callbacks.approveReview).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.approveReview }))
    expect(callbacks.approveReview).toHaveBeenCalledWith(learningProposal.id)
    fireEvent.click(screen.getByRole('button', { name: en.rejectReview }))
    expect(callbacks.rejectReview).toHaveBeenCalledWith(learningProposal.id)
  })

  it('requires completed substantial evidence selection before requesting a suggestion', () => {
    const callbacks = fixture()
    fireEvent.click(screen.getByRole('button', { name: en.proposeLearning }))
    const dialog = screen.getByRole('dialog', { name: en.proposeTitle })
    const submit = within(dialog).getByRole('button', { name: en.generateProposal })
    expect(submit.hasAttribute('disabled')).toBe(true)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: evidence.task }))
    fireEvent.click(submit)
    expect(callbacks.proposeLearning).toHaveBeenCalledWith({ projectId: 'project', operation: 'learn', evidenceIds: [evidence.id], targetIds: [] })
    expect(callbacks.approveReview).not.toHaveBeenCalled()
  })
  it('can explicitly improve an existing managed skill from selected completed work', () => {
    const callbacks = fixture()
    fireEvent.click(screen.getByRole('button', { name: en.proposeLearning }))
    const dialog = screen.getByRole('dialog', { name: en.proposeTitle })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: evidence.task }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Release workflow' }))
    fireEvent.click(within(dialog).getByRole('button', { name: en.generateProposal }))
    expect(callbacks.proposeLearning).toHaveBeenCalledWith({ projectId: 'project', operation: 'learn', evidenceIds: [evidence.id], targetIds: [learningProposal.changes[0]!.id] })
    expect(callbacks.approveReview).not.toHaveBeenCalled()
  })

  it('does not allow a proposal to overwrite a protected or changed source', () => {
    const protectedSource = learningProposal.changes[0]!
    fixture({ inventory: { items: [], projects: [{ id: 'project', title: 'Y Harness', path: '/work/project' }], providers: [], bodyBudgetBytes: 6000 } })
    expect(protectedSource.expectedHash).toBe('hash')
    expect(screen.getByRole('button', { name: en.approveReview }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(en.reviewSourceBlocked)).toBeTruthy()
  })
  it('retains rejected proposals and their diff without offering application again', () => {
    fixture({ state: { status: 'ready', error: false, reviews: [], detail: { ...learningProposal, state: 'rejected' }, detailId: learningProposal.id, detailStatus: 'ready', evidence: [evidence], providers: learningStatus } })
    expect(screen.getByText(en.rejected)).toBeTruthy()
    expect(screen.getByText('Check the release.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.approveReview })).toBeNull()
    expect(screen.queryByRole('button', { name: en.rejectReview })).toBeNull()
  })
  it('opens an applied skill for source history only when requested', () => {
    const id = learningProposal.changes[0]!.id!
    const callbacks = fixture({ state: { status: 'ready', error: false, reviews: [], detail: { ...learningProposal, state: 'applied', appliedIds: [id] }, detailId: learningProposal.id, detailStatus: 'ready', evidence: [evidence], providers: learningStatus } })
    expect(callbacks.openSkill).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Release workflow' }))
    expect(callbacks.openSkill).toHaveBeenCalledWith(id)
    expect(screen.queryByRole('button', { name: en.approveReview })).toBeNull()
  })
  it('offers explicit recovery for an interrupted application with committed source changes', () => {
    const id = learningProposal.changes[0]!.id!
    const callbacks = fixture({ state: { status: 'ready', error: false, reviews: [], detail: { ...learningProposal, state: 'applying', appliedIds: [id], changes: [{ ...learningProposal.changes[0]!, expectedHash: 'old-version' }] }, detailId: learningProposal.id, detailStatus: 'ready', evidence: [evidence], providers: learningStatus } })
    const retry = screen.getByRole('button', { name: 'Resume application' })
    expect(retry.hasAttribute('disabled')).toBe(false)
    fireEvent.click(retry)
    expect(callbacks.approveReview).toHaveBeenCalledWith(learningProposal.id)
    expect(screen.getByRole('button', { name: 'Inspect Release workflow' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.validateReview })).toBeNull()
  })
  it('shows independent validation limits and never treats booleans as an automatic receipt', () => {
    fixture({ state: { status: 'ready', error: false, reviews: [], detail: { ...learningProposal, validation: { validatorId: 'untrusted-validator', checkedAt: '2026-10-09T02:00:00Z', digest: learningProposal.digest, trusted: false, independent: false, constraintsPreserved: true, resourcesPreserved: true, referenceImpactChecked: true, survivorEquivalent: true, findings: [] } }, detailId: learningProposal.id, detailStatus: 'ready', evidence: [evidence], providers: learningStatus } })
    expect(screen.getByText(en.validatorUntrusted)).toBeTruthy()
    expect(screen.getByText(en.notIndependent)).toBeTruthy()
    expect(screen.getByText(en.validationReceiptMissing)).toBeTruthy()
  })
  it('blocks applying a proposal whose source hash changed', () => {
    fixture({ state: { status: 'ready', error: false, reviews: [], detail: { ...learningProposal, changes: [{ ...learningProposal.changes[0]!, expectedHash: 'old-version' }] }, detailId: learningProposal.id, detailStatus: 'ready', evidence: [evidence], providers: learningStatus } })
    expect(screen.getByRole('button', { name: en.approveReview }).hasAttribute('disabled')).toBe(true)
  })
  it('shows the complete retained bundle beside an archive source deletion diff', () => {
    const archived = { ...learningProposal, operation: 'deduplicate' as const, changes: [{ ...learningProposal.changes[0]!, kind: 'archive' as const, before: 'Original workflow to archive.', after: '', survivorId: 'filesystem:/work/retained/SKILL.md' as SkillLibraryId, survivorHash: 'retained-body-hash', survivorResourceHash: 'retained-bundle-hash', survivorContent: 'Retained workflow with complete instructions.\nKeep the publishing approval constraint.', survivorResources: [{ path: 'scripts/retained.sh', hash: 'retained-script-hash', bytes: 321 }], survivorReferences: ['checks/retained-test.md'] }] }
    fixture({ state: { status: 'ready', error: false, reviews: [], detail: archived, detailId: archived.id, detailStatus: 'ready', evidence: [evidence], providers: learningStatus } })
    expect(screen.getByText('Original workflow to archive.')).toBeTruthy()
    expect(screen.getByText('scripts/release.sh')).toBeTruthy()
    const snapshot = screen.getByRole('region', { name: 'Retained skill snapshot' })
    expect(within(snapshot).getByText(/Retained workflow with complete instructions/)).toBeTruthy()
    expect(within(snapshot).getByText(/Keep the publishing approval constraint/)).toBeTruthy()
    expect(within(snapshot).getByText('filesystem:/work/retained/SKILL.md')).toBeTruthy()
    expect(within(snapshot).getByText('retained-body-hash')).toBeTruthy()
    expect(within(snapshot).getByText('retained-bundle-hash')).toBeTruthy()
    expect(within(snapshot).getByText('scripts/retained.sh')).toBeTruthy()
    expect(within(snapshot).getByText('retained-script-hash')).toBeTruthy()
    expect(within(snapshot).getByText('checks/retained-test.md')).toBeTruthy()
  })
})

const managed: SkillLibraryItem = { id: learningProposal.changes[0]!.id!, name: 'Release workflow', description: '', provider: 'filesystem', source: 'project', path: '/work/project/.dsh/skills/release/SKILL.md', scope: 'project', projectIds: ['project'], ownership: 'y-managed', status: 'active', shadowed: false, pinned: false, automaticCleanup: false, invocation: { modelInvocable: true, userInvocable: true }, contentHash: 'hash', bodyBytes: 18, usage: { coverage: 'unknown', loadCount: 0 }, references: [], capabilities: { adopt: false, archive: true, restore: false, cleanup: true, native: false } }
const list = (items: readonly SkillLibraryItem[] = [managed]): SkillLibraryList => ({ items, projects: [{ id: 'project', title: 'Y Harness', path: '/work/project' }], providers: [], bodyBudgetBytes: 6000 })
const reviewState = (detail: SkillLearningProposal | null = learningProposal): SkillReviewsProps['state'] => ({ status: 'ready', error: false, reviews: [{ ...learningProposal, changeCount: 1, beforeBytes: 18, afterBytes: 49 }], detail, detailId: detail?.id ?? null, detailStatus: detail === null ? 'idle' : 'ready', evidence: [evidence], providers: learningStatus })

describe('review queries and source eligibility', () => {
  it('loads only the selected review and retries failed metadata and proposal reads', () => {
    const callbacks = fixture({ state: { ...reviewState(null), error: true, detailId: learningProposal.id, detailStatus: 'error' } })
    fireEvent.click(screen.getByRole('button', { name: t('openProposal', { id: learningProposal.id }) }))
    expect(callbacks.selectReview).toHaveBeenCalledWith(learningProposal.id)
    expect(callbacks.loadReview).toHaveBeenCalledWith(learningProposal.id)
    const retries = screen.getAllByRole('button', { name: en.retry }); retries.forEach((button) => { fireEvent.click(button) })
    expect(callbacks.refreshLearning).toHaveBeenCalledOnce(); expect(callbacks.loadReview).toHaveBeenCalledTimes(2)
  })
  it('keeps independent list and selected-detail loading states visible', () => {
    fixture({ state: { ...reviewState(null), status: 'loading', detailStatus: 'loading' } })
    expect(screen.getAllByRole('status', { name: en.loading })).toHaveLength(2)
  })
  it('shows selection guidance when no proposal is selected', () => {
    fixture({ selectedId: null, state: reviewState(null), inventory: null })
    expect(screen.getByText(en.selectReviewHint)).toBeTruthy()
    expect(screen.getByRole('button', { name: t('openProposal', { id: learningProposal.id }) }).textContent).toContain('project')
  })
  it.each([{ project: 'elsewhere', query: '' }, { project: 'all', query: 'missing-generator' }])('filters unrelated review metadata for %j', (selection) => {
    fixture({ ...selection, state: reviewState(null) }); expect(screen.getByText(en.noReviews)).toBeTruthy()
  })
  it('separates pending and durable history through the status menu', () => {
    const past = { ...learningProposal, id: 'proposal:past' as typeof learningProposal.id, state: 'applied' as const, uncertainty: [] }
    fixture({ selectedId: null, state: { ...reviewState(null), reviews: [
      { ...learningProposal, changeCount: 1, beforeBytes: 18, afterBytes: 49 }, { ...past, changeCount: 1,
        beforeBytes: 18, afterBytes: 49 },
    ] } })
    fireEvent.click(screen.getByRole('button', { name: en.status })); fireEvent.click(screen.getByRole('menuitem', { name: en.reviewPending }))
    expect(screen.queryByRole('button', { name: t('openProposal', { id: past.id }) })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.status })); fireEvent.click(screen.getByRole('menuitem', { name: en.history }))
    expect(screen.queryByRole('button', { name: t('openProposal', { id: learningProposal.id }) })).toBeNull()
    expect(screen.getByRole('button', { name: t('openProposal', { id: past.id }) })).toBeTruthy()
  })
  it('reports unavailable generators and does not offer generation without completed evidence', () => {
    fixture({ state: { ...reviewState(null), providers: { ...learningStatus, generators: [] } } })
    expect(screen.getByText(en.generatorUnavailable)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.proposeLearning }).hasAttribute('disabled')).toBe(true)
  })
  it.each([
    { ownership: 'protected' as const }, { pinned: true }, { shadowed: true }, { status: 'archived' as const },
    { contentHash: 'changed' }, { capabilities: { ...managed.capabilities, native: true } },
  ])('refuses review application for protected current source metadata %j', (patch) => {
    const callbacks = fixture({ inventory: list([{ ...managed, ...patch }]) })
    const apply = screen.getByRole('button', { name: en.approveReview })
    expect(apply.hasAttribute('disabled')).toBe(true); fireEvent.click(apply); expect(callbacks.approveReview).not.toHaveBeenCalled()
    expect(screen.getByText(en.reviewSourceBlocked)).toBeTruthy()
  })
  it.each([null, list([])])('refuses source updates without a current inventory', (inventory) => {
    fixture({ inventory }); expect(screen.getByRole('button', { name: en.approveReview }).hasAttribute('disabled')).toBe(true)
  })
  it('allows a new skill only in a currently registered project', () => {
    const proposal = { ...learningProposal, changes: [{ ...learningProposal.changes[0]!, kind: 'create' as const }] }
    fixture({ state: reviewState(proposal) }); expect(screen.getByRole('button', { name: en.approveReview }).hasAttribute('disabled')).toBe(false)
    cleanup(); fixture({ state: reviewState({ ...proposal, projectId: 'missing' }) })
    expect(screen.getByRole('button', { name: en.approveReview }).hasAttribute('disabled')).toBe(true)
  })
  it('refuses an empty suggestion and retains a blocked suggestion for rejection', () => {
    fixture({ state: reviewState({ ...learningProposal, changes: [] }) })
    expect(screen.getByRole('button', { name: en.approveReview }).hasAttribute('disabled')).toBe(true)
    cleanup(); const callbacks = fixture({ state: reviewState({ ...learningProposal, state: 'blocked', findings: ['Source check failed'], uncertainty: [] }) })
    expect(screen.getByText('Source check failed')).toBeTruthy(); fireEvent.click(screen.getByRole('button', { name: en.rejectReview }))
    expect(callbacks.rejectReview).toHaveBeenCalledWith(learningProposal.id)
  })
  it.each([undefined, { status: 'archived' as const }, { contentHash: 'changed' }])('refuses archive application without the exact active survivor %j', (patch) => {
    const survivorId = 'survivor' as SkillLibraryId
    const proposal = { ...learningProposal, operation: 'deduplicate' as const, changes: [{ ...learningProposal.changes[0]!, kind: 'archive' as const, survivorId, survivorHash: 'survivor-hash' }] }
    const survivor = { ...managed, id: survivorId, contentHash: 'survivor-hash', ...patch }
    fixture({ state: reviewState(proposal), inventory: list(patch === undefined ? [managed] : [managed, survivor]) })
    expect(screen.getByRole('button', { name: en.approveReview }).hasAttribute('disabled')).toBe(true)
    expect(screen.getAllByText(en.survivorSnapshotUnavailable).length).toBeGreaterThan(0)
  })
  it('allows archive application with the observed survivor and shows an empty retained bundle', () => {
    const survivorId = 'survivor' as SkillLibraryId
    const proposal = { ...learningProposal, changes: [{ ...learningProposal.changes[0]!, kind: 'archive' as const, survivorId, survivorHash: 'survivor-hash', survivorContent: 'Retained instructions', survivorResources: [], survivorReferences: [] }] }
    fixture({ state: reviewState(proposal), inventory: list([managed, { ...managed, id: survivorId, contentHash: 'survivor-hash' }]) })
    expect(screen.getByRole('button', { name: en.approveReview }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByText(en.noResources)).toBeTruthy(); expect(screen.getByText(en.noReferences)).toBeTruthy()
  })
  it('renders each observed check result and independent receipt while exposing a digest mismatch', () => {
    const proposal = { ...learningProposal, state: 'validated' as const, uncertainty: [], evidence: [{ ...evidence, completed: false, checks: [
      { kind: 'test' as const, summary: 'Focused tests passed', eventRef: 'event:passed', result: 'passed' as const }, { kind: 'test' as const, summary: 'Lint failed', eventRef: 'event:failed', result: 'failed' as const }, { kind: 'constraint' as const, summary: 'Source unconfirmed', eventRef: 'event:unknown', result: 'unknown' as const },
    ] }], validation: { validatorId: 'validator', checkedAt: '2026-10-09T02:00:00Z', digest: 'stale-digest', trusted: true, independent: true, constraintsPreserved: false, resourcesPreserved: false, referenceImpactChecked: false, survivorEquivalent: false, findings: ['Independent source mismatch'], receipt: { scope: 'full-proposal' as const, digest: 'receipt-digest', sourceHashes: ['source-hash'], resourceHashes: ['resource-hash'], evidenceIds: [evidence.id], eventRefs: ['event:receipt'] } } }
    const callbacks = fixture({ state: { ...reviewState(proposal), providers: { ...learningStatus, validators: [{ id: 'validator', trusted: true }] } } })
    expect(screen.getByText(en.taskIncomplete)).toBeTruthy(); expect(screen.getByText(en.validationDigestMismatch)).toBeTruthy()
    for (const text of ['Focused tests passed', 'Lint failed', 'Source unconfirmed', 'Independent source mismatch', 'receipt-digest', 'event:receipt']) expect(screen.getByText(text)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.validateReview })); expect(callbacks.validateReview).toHaveBeenCalledWith(learningProposal.id)
  })
  it('uses retained applied identities when source metadata is no longer present', () => {
    const applied = 'removed-source' as SkillLibraryId
    const callbacks = fixture({ inventory: null, state: reviewState({ ...learningProposal, state: 'applied', appliedIds: [applied] }) })
    fireEvent.click(screen.getByRole('button', { name: t('openSkill', { name: applied }) })); expect(callbacks.openSkill).toHaveBeenCalledWith(applied)
  })
})

describe('deliberate proposal generation', () => {
  it('requires a selected target for compression and clears selections on operation changes', () => {
    const callbacks = fixture(); fireEvent.click(screen.getByRole('button', { name: en.proposeLearning }))
    const dialog = screen.getByRole('dialog', { name: en.proposeTitle }); const submit = within(dialog).getByRole('button', { name: en.generateProposal })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: evidence.task })); fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Release workflow' }))
    fireEvent.click(within(dialog).getByRole('button', { name: en.proposalOperation })); fireEvent.click(screen.getByRole('menuitem', { name: en.compress }))
    expect(submit.hasAttribute('disabled')).toBe(true)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Release workflow' })); fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Release workflow' }))
    expect(submit.hasAttribute('disabled')).toBe(true)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Release workflow' })); fireEvent.click(submit)
    expect(callbacks.proposeLearning).toHaveBeenCalledWith({ projectId: 'project', operation: 'compress', evidenceIds: [evidence.id], targetIds: [managed.id] })
  })
  it('requires two deduplication candidates and labels protected candidates as survivor only', () => {
    const protectedId = 'protected' as SkillLibraryId
    const callbacks = fixture({ inventory: list([managed, { ...managed, id: protectedId, name: 'Protected survivor', ownership: 'protected', pinned: true }]) })
    fireEvent.click(screen.getByRole('button', { name: en.proposeLearning })); const dialog = screen.getByRole('dialog', { name: en.proposeTitle })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: evidence.task }))
    fireEvent.click(within(dialog).getByRole('button', { name: en.proposalOperation })); fireEvent.click(screen.getByRole('menuitem', { name: en.deduplicate }))
    expect(within(dialog).getByText(en.survivorOnly)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Release workflow' }))
    const submit = within(dialog).getByRole('button', { name: en.generateProposal }); expect(submit.hasAttribute('disabled')).toBe(true)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Protected survivor' })); fireEvent.click(submit)
    expect(callbacks.proposeLearning).toHaveBeenCalledWith({ projectId: 'project', operation: 'deduplicate', evidenceIds: [evidence.id], targetIds: [managed.id, protectedId] })
  })
  it('clears evidence on project changes and forgets selections when cancelled and reopened', () => {
    const callbacks = fixture({ project: 'project', inventory: { ...list(), projects: [...list().projects, { id: 'other', title: 'Other', path: '/other' }] } })
    fireEvent.click(screen.getByRole('button', { name: en.proposeLearning })); let dialog = screen.getByRole('dialog', { name: en.proposeTitle })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: evidence.task })); fireEvent.click(within(dialog).getByRole('checkbox', { name: evidence.task }))
    expect(within(dialog).getByRole('button', { name: en.generateProposal }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: evidence.task }))
    fireEvent.click(within(dialog).getByRole('button', { name: en.project })); fireEvent.click(screen.getByRole('menuitem', { name: 'Other' }))
    expect(within(dialog).getByText(en.noEvidence)).toBeTruthy(); expect(within(dialog).getByRole('button', { name: en.generateProposal }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: en.cancel })); expect(callbacks.proposeLearning).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.proposeLearning })); dialog = screen.getByRole('dialog', { name: en.proposeTitle })
    expect(within(dialog).getByRole<HTMLInputElement>('checkbox', { name: evidence.task }).checked).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: en.close })); expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('shows unavailable route refusal without sending a generation request', () => {
    const callbacks = fixture({ state: { ...reviewState(), providers: { ...learningStatus, availability: [{ projectId: 'project', state: 'unavailable', reason: 'No route' }] } } })
    fireEvent.click(screen.getByRole('button', { name: en.proposeLearning })); const dialog = screen.getByRole('dialog', { name: en.proposeTitle })
    expect(within(dialog).getByText(en.learningUnavailable)).toBeTruthy(); fireEvent.click(within(dialog).getByRole('checkbox', { name: evidence.task }))
    const submit = within(dialog).getByRole('button', { name: en.generateProposal }); expect(submit.hasAttribute('disabled')).toBe(true)
    fireEvent.click(submit); expect(callbacks.proposeLearning).not.toHaveBeenCalled()
  })
})

it('closes a review filter menu with Escape without changing the visible results', () => {
  fixture({ state: reviewState(null) }); fireEvent.click(screen.getByRole('button', { name: en.status }))
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(screen.getByRole('button', { name: t('openProposal', { id: learningProposal.id }) })).toBeTruthy()
})
it('shows a proposal dialog refusal when no current project or validator metadata is available', () => {
  const callbacks = fixture({ inventory: null, state: { ...reviewState(), providers: null } })
  expect(screen.getByRole('button', { name: en.validateReview }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: en.proposeLearning }).hasAttribute('disabled')).toBe(true)
  expect(callbacks.proposeLearning).not.toHaveBeenCalled()
  cleanup(); const noProject = fixture({ inventory: { ...list(), projects: [] } })
  fireEvent.click(screen.getByRole('button', { name: en.proposeLearning }))
  const dialog = screen.getByRole('dialog', { name: en.proposeTitle })
  expect(within(dialog).getByText(en.noEvidence)).toBeTruthy()
  expect(within(dialog).getByRole('button', { name: en.generateProposal }).hasAttribute('disabled')).toBe(true)
  expect(noProject.proposeLearning).not.toHaveBeenCalled()
})
it('labels checked completed work separately and shows unknown retained source hashes', () => {
  const checked = { ...evidence, checks: [{ kind: 'test' as const, result: 'passed' as const, summary: 'Recorded check', eventRef: 'event:check' }] }
  fixture({ state: { ...reviewState({ ...learningProposal, changes: [{ ...learningProposal.changes[0]!, kind: 'archive', survivorId: 'retained' as SkillLibraryId }] }), evidence: [checked] } })
  const snapshot = screen.getByRole('region', { name: en.survivorSnapshot })
  expect(within(snapshot).getAllByText(en.checkUnknown)).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: en.proposeLearning }))
  expect(within(screen.getByRole('dialog', { name: en.proposeTitle })).getByText(t('checksRecorded', { count: 1 }))).toBeTruthy()
})
it('expands the entire review diff before an explicit application', () => {
  const before = Array.from({ length: 80 }, (_, i) => `Old instruction ${i}`).join('\n')
  const after = Array.from({ length: 80 }, (_, i) => `New instruction ${i}`).join('\n')
  const callbacks = fixture({ state: reviewState({ ...learningProposal, changes: [{ ...learningProposal.changes[0]!, before, after }] }) })
  fireEvent.click(screen.getByRole('button', { name: /Expand.*lines/i }))
  expect(screen.getByText(/New instruction 79/)).toBeTruthy()
  expect(callbacks.approveReview).not.toHaveBeenCalled()
})
