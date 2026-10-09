import { describe, expect, it, vi } from 'vitest'
import type { SkillLibraryId, SkillLibraryItem, SkillLibraryList, SkillCleanupProposalId } from '@deepseek-ai/dsh-skill-library/types'
import { SkillLibraryController, type SkillLibraryApi } from '../src/client/controller.ts'
import { learningProposal, learningStatus, evidence } from './learning-fixtures.ts'

const id = 'filesystem:/project/skills/release/SKILL.md' as SkillLibraryId
const item: SkillLibraryItem = { id, name: 'Release', description: 'Release a verified change', provider: 'filesystem', source: 'project', path: '/project/skills/release/SKILL.md', scope: 'project', projectIds: ['project'], ownership: 'y-managed', status: 'active', shadowed: false, pinned: false, automaticCleanup: false, invocation: { modelInvocable: true, userInvocable: true }, contentHash: 'hash', bodyBytes: 99, usage: { coverage: 'unknown', loadCount: 0 }, references: [], capabilities: { adopt: false, archive: true, restore: false, cleanup: true, native: false } }
const inventory: SkillLibraryList = { items: [item], projects: [{ id: 'project', title: 'Project', path: '/project' }], providers: [], bodyBudgetBytes: 5000 }
const api = (overrides: Partial<SkillLibraryApi> = {}): SkillLibraryApi => ({
  list: async () => ({ ok: true, value: inventory }),
  detail: async () => ({ ok: true, value: { item, content: 'Instructions', revisions: [] } }),
  setPinned: async request => ({ ok: true, value: { item: { ...item, pinned: request.pinned } } }),
  adopt: async () => ({ ok: true, value: { item } }),
  setAutomaticCleanup: async () => ({ ok: true, value: { item } }),
  archive: async () => ({ ok: true, value: { item } }),
  restore: async () => ({ ok: true, value: { item } }),
  previewCleanup: async () => ({ ok: true, value: { id: 'preview' as SkillCleanupProposalId, changes: [], skipped: [], createdAt: '2026-10-09T00:00:00Z' } }),
  applyCleanup: async () => ({ ok: true, value: { revised: [] } }),
  rollback: async () => ({ ok: true, value: { item } }),
  listProposals: async () => ({ ok: true, value: [{ ...learningProposal, changeCount: 1, beforeBytes: 18, afterBytes: 49 }] }),
  detailProposal: async () => ({ ok: true, value: learningProposal }),
  proposeLearning: async () => ({ ok: true, value: learningProposal }),
  validateProposal: async () => ({ ok: true, value: learningProposal }),
  applyProposal: async () => ({ ok: true, value: { ...learningProposal, state: 'applied' } }),
  rejectProposal: async () => ({ ok: true, value: { ...learningProposal, state: 'rejected' } }),
  listLearningEvidence: async () => ({ ok: true, value: [evidence] }),
  learningStatus: async () => ({ ok: true, value: learningStatus }),
  approveLearningPolicy: async () => ({ ok: true, value: {
    id: 'policy' as import('@deepseek-ai/dsh-skill-library/types').SkillLearningPolicyId,
    approvedAt: '2026-10-09T00:00:00Z', validatorId: 'validator', operations: ['compress'],
  } }),
  setAutomaticLearning: async request => ({ ok: true, value: {
    id: request.id, contentHash: request.expectedHash, policyId: request.policyId, enabled: request.enabled,
  } }),
  ...overrides,
})

describe('skill library controller', () => {
  it('loads review metadata without eager proposal bodies and never applies generated suggestions', async () => {
    const detailProposal = vi.fn<SkillLibraryApi['detailProposal']>(async () => ({ ok: true, value: learningProposal }))
    const applyProposal = vi.fn<SkillLibraryApi['applyProposal']>(async () => ({ ok: true, value: learningProposal }))
    const proposeLearning = vi.fn<SkillLibraryApi['proposeLearning']>(async () => ({ ok: true, value: learningProposal }))
    const controller = new SkillLibraryController(api({ detailProposal, applyProposal, proposeLearning }))
    await controller.refreshLearning()
    expect(controller.source.getSnapshot().learning.evidence).toEqual([evidence])
    expect(detailProposal).not.toHaveBeenCalled()
    await controller.proposeLearning({ projectId: 'project', operation: 'learn', evidenceIds: [evidence.id] })
    expect(proposeLearning).toHaveBeenCalledWith({ projectId: 'project', operation: 'learn', evidenceIds: [evidence.id] })
    expect(controller.source.getSnapshot().learning.detail?.id).toBe(learningProposal.id)
    expect(applyProposal).not.toHaveBeenCalled()
    await controller.approveReview(learningProposal.id)
    expect(applyProposal).toHaveBeenCalledWith({ proposalId: learningProposal.id, mode: 'reviewed' })
    controller.dispose()
  })

  it('keeps semantic policy approval separate from per-file consent and sends the current source hash', async () => {
    const setAutomaticLearning = vi.fn<SkillLibraryApi['setAutomaticLearning']>(async request => ({ ok: true, value: { id: request.id, contentHash: request.expectedHash, policyId: request.policyId, enabled: request.enabled } }))
    const controller = new SkillLibraryController(api({ setAutomaticLearning }))
    await controller.approvePolicy({ validatorId: 'validator', operations: ['compress'] })
    expect(setAutomaticLearning).not.toHaveBeenCalled()
    const policyId = 'policy' as import('@deepseek-ai/dsh-skill-library/types').SkillLearningPolicyId
    await controller.setLearningAutomatic(item, policyId, true)
    expect(setAutomaticLearning).toHaveBeenCalledWith({ id, expectedHash: 'hash', policyId, enabled: true })
    controller.dispose()
  })

  it('rejects a selected suggestion through the durable host API', async () => {
    const rejectProposal = vi.fn<SkillLibraryApi['rejectProposal']>(async () => ({ ok: true, value: { ...learningProposal, state: 'rejected' } }))
    const controller = new SkillLibraryController(api({ rejectProposal }))
    await controller.rejectReview(learningProposal.id)
    expect(rejectProposal).toHaveBeenCalledWith({ proposalId: learningProposal.id })
    controller.dispose()
  })
  it('ignores a late proposal body when a newer suggestion was selected', async () => {
    let resolveFirst!: (value: Awaited<ReturnType<SkillLibraryApi['detailProposal']>>) => void
    const first = new Promise<Awaited<ReturnType<SkillLibraryApi['detailProposal']>>>((resolve) => { resolveFirst = resolve })
    const newer = { ...learningProposal, id: 'proposal:newer' as import('@deepseek-ai/dsh-skill-library/types').SkillLearningProposalId, generator: 'newer-generator' }
    const controller = new SkillLibraryController(api({
      detailProposal: async request => request.proposalId === learningProposal.id ? first : { ok: true, value: newer },
    }))
    const pending = controller.loadReview(learningProposal.id)
    await controller.loadReview(newer.id)
    resolveFirst({ ok: true, value: learningProposal })
    await pending
    expect(controller.source.getSnapshot().learning.detail?.id).toBe(newer.id)
    controller.dispose()
  })
  it('does not switch selection back when an earlier review action finishes', async () => {
    let resolveApply!: (value: Awaited<ReturnType<SkillLibraryApi['applyProposal']>>) => void
    const applying = new Promise<Awaited<ReturnType<SkillLibraryApi['applyProposal']>>>((resolve) => { resolveApply = resolve })
    const newer = { ...learningProposal, id: 'proposal:newer' as import('@deepseek-ai/dsh-skill-library/types').SkillLearningProposalId }
    const controller = new SkillLibraryController(api({
      applyProposal: async () => applying, detailProposal: async () => ({ ok: true, value: newer }),
    }))
    const pending = controller.approveReview(learningProposal.id)
    await controller.loadReview(newer.id)
    resolveApply({ ok: true, value: { ...learningProposal, state: 'applied' } })
    await pending
    expect(controller.source.getSnapshot().learning.detail?.id).toBe(newer.id)
    controller.dispose()
  })
  it('retains visible inventory after a refresh fails', async () => {
    let fail = false
    const controller = new SkillLibraryController(api({ list: async () => { if (fail) throw new Error('Unavailable'); return { ok: true, value: inventory } } }))
    await controller.refresh()
    fail = true
    await controller.refresh()
    expect(controller.source.getSnapshot().inventory).toEqual(inventory)
    expect(controller.source.getSnapshot().readError).toBe(true)
    controller.dispose()
  })

  it('does not publish a skill body returned after selecting another skill', async () => {
    let resolveFirst!: (value: Awaited<ReturnType<SkillLibraryApi['detail']>>) => void
    const first = new Promise<Awaited<ReturnType<SkillLibraryApi['detail']>>>((resolve) => { resolveFirst = resolve })
    const secondId = 'second' as SkillLibraryId
    const second = { ...item, id: secondId, name: 'Review' }
    const controller = new SkillLibraryController(api({ detail: async request => request.id === id ? first : { ok: true, value: { item: second, content: 'Review instructions', revisions: [] } } }))
    const pending = controller.loadDetail(id)
    await controller.loadDetail(secondId)
    resolveFirst({ ok: true, value: { item, content: 'Old selection', revisions: [] } })
    await pending
    expect(controller.source.getSnapshot().detail?.content).toBe('Review instructions')
    controller.dispose()
  })

  it('previews cleanup without applying it, then applies only the reviewed proposal', async () => {
    const applyCleanup = vi.fn<SkillLibraryApi['applyCleanup']>(async () => ({ ok: true, value: { revised: [id] } }))
    const controller = new SkillLibraryController(api({ applyCleanup }))
    await controller.preview([id])
    expect(controller.source.getSnapshot().proposal?.id).toBe('preview')
    expect(applyCleanup).not.toHaveBeenCalled()
    await controller.applyPreview()
    expect(applyCleanup).toHaveBeenCalledWith({ proposalId: 'preview' })
    expect(controller.source.getSnapshot().cleanupOpen).toBe(false)
    expect(controller.source.getSnapshot().notice?.kind).toBe('cleanupApplied')
    controller.dispose()
  })
})
