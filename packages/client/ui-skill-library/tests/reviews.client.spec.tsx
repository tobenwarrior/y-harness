// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { SkillLibraryId } from '@deepseek-ai/dsh-skill-library/types'
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
