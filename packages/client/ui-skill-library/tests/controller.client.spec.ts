import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SkillLibraryId, SkillLibraryItem, SkillLibraryList, SkillCleanupProposalId, SkillRevisionId } from '@deepseek-ai/dsh-skill-library/types'
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
  cleanupSemantic: async () => ({ ok: true, value: [] }),
  revokeLearningPolicy: async request => ({ ok: true, value: { id: request.policyId, approvedAt: '2026-10-09T00:00:00Z', validatorId: 'validator', operations: ['compress'], enabled: false } }),
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
  it('revokes the selected learning policy through the host and refreshes consent controls', async () => {
    const revokeLearningPolicy = vi.fn<SkillLibraryApi['revokeLearningPolicy']>(async request => ({ ok: true, value: {
      id: request.policyId, approvedAt: '2026-10-09T00:00:00Z', validatorId: 'validator', operations: ['compress'], enabled: false,
    } }))
    const controller = new SkillLibraryController(api({ revokeLearningPolicy }))
    const policyId = 'policy' as import('@deepseek-ai/dsh-skill-library/types').SkillLearningPolicyId
    await controller.revokePolicy(policyId)
    expect(revokeLearningPolicy).toHaveBeenCalledWith({ policyId })
    expect(controller.source.getSnapshot().learning.providers).toEqual(learningStatus)
    expect(controller.source.getSnapshot().notice?.kind).toBe('changed')
    controller.dispose()
  })

  it('runs semantic cleanup through the host and refreshes retained history', async () => {
    let applied = false
    const revised = { ...item, contentHash: 'reduced-hash', bodyBytes: 48 }
    const revision = { id: 'revision:cleanup' as SkillRevisionId, createdAt: '2026-10-09T01:00:00Z', reason: 'learning' as const,
      beforeHash: 'hash', afterHash: 'reduced-hash', beforeBytes: 99, afterBytes: 48 }
    const cleanupSemantic = vi.fn<SkillLibraryApi['cleanupSemantic']>(async () => {
      applied = true
      return { ok: true, value: [{ ...learningProposal, state: 'applied' }] }
    })
    const controller = new SkillLibraryController(api({ cleanupSemantic,
      list: async () => ({ ok: true, value: { ...inventory, items: [applied ? revised : item] } }),
      detail: async () => ({ ok: true, value: { item: applied ? revised : item,
        content: applied ? 'Keep the focused check.' : 'Keep the focused check.\nKeep the focused check.', revisions: applied ? [revision] : [] } }),
    }))
    await controller.loadDetail(id)
    const request = { projectId: 'project', ids: [id], force: true }
    await controller.cleanupSemantic(request)
    expect(cleanupSemantic).toHaveBeenCalledWith(request)
    expect(controller.source.getSnapshot().inventory?.items[0]?.contentHash).toBe('reduced-hash')
    expect(controller.source.getSnapshot().detail?.content).toBe('Keep the focused check.')
    expect(controller.source.getSnapshot().detail?.revisions).toEqual([revision])
    expect(controller.source.getSnapshot().notice?.kind).toBe('semanticCleanupFinished')
    expect(controller.source.getSnapshot().busy).toBe(false)
    controller.dispose()
  })

  it('retains skill inventory and reports a failed semantic cleanup', async () => {
    const controller = new SkillLibraryController(api({ cleanupSemantic: async () => { throw new Error('Source changed') } }))
    await controller.refresh()
    await controller.cleanupSemantic({ projectId: 'project', ids: [id], force: false })
    expect(controller.source.getSnapshot().inventory).toEqual(inventory)
    expect(controller.source.getSnapshot().notice?.kind).toBe('actionError')
    expect(controller.source.getSnapshot().busy).toBe(false)
    controller.dispose()
  })

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

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Value>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('skill library controller operation lifetimes', () => {
  it.each([
    ['pin', 'setPinned', { id, pinned: true }],
    ['unpin', 'setPinned', { id, pinned: false }],
    ['adopt', 'adopt', { id, expectedHash: 'hash' }],
    ['archive', 'archive', { id, expectedHash: 'hash' }],
    ['restore', 'restore', { id }],
    ['automaticOn', 'setAutomaticCleanup', { id, expectedHash: 'hash', enabled: true }],
    ['automaticOff', 'setAutomaticCleanup', { id, expectedHash: 'hash', enabled: false }],
  ] as const)('refreshes the selected source after %s settles', async (action, method, request) => {
    const next = { ...item, contentHash: 'next-hash' }
    let changed = false
    const host = api({ list: async () => ({ ok: true, value: { ...inventory, items: [changed ? next : item] } }),
      detail: async () => ({ ok: true, value: { item: changed ? next : item, content: changed ? 'Next instructions' : 'Instructions', revisions: [] } }),
    })
    const selected = vi.spyOn(host, method).mockImplementation(async () => {
      changed = true
      return { ok: true as const, value: { item: next } }
    })
    const controller = new SkillLibraryController(host)
    await controller.loadDetail(id)
    await controller.act(action, item)
    expect(selected).toHaveBeenCalledWith(request)
    expect(controller.source.getSnapshot().detail?.content).toBe('Next instructions')
    expect(controller.source.getSnapshot().inventory?.items[0]?.contentHash).toBe('next-hash')
    expect(controller.source.getSnapshot().notice?.kind).toBe(action === 'restore' ? 'restored' : 'changed')
    controller.dispose()
  })

  it('serializes an explicit force reload after an existing inventory read', async () => {
    const first = deferred<Awaited<ReturnType<SkillLibraryApi['list']>>>()
    const list = vi.fn<SkillLibraryApi['list']>().mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ ok: true, value: { ...inventory, bodyBudgetBytes: 42 } })
    const controller = new SkillLibraryController(api({ list }))
    const reading = controller.refresh(); const joining = controller.refresh(); const forced = controller.refresh(true)
    expect(controller.source.getSnapshot().status).toBe('loading')
    expect(list).toHaveBeenCalledTimes(1)
    first.resolve({ ok: true, value: inventory }); await Promise.all([reading, joining, forced])
    expect(list.mock.calls).toEqual([[{}], [{ forceReload: true }]])
    expect(controller.source.getSnapshot().inventory?.bodyBudgetBytes).toBe(42)
    controller.dispose()
    const snapshot = controller.source.getSnapshot(); await controller.refresh(true); await controller.refreshLearning()
    expect(controller.source.getSnapshot()).toBe(snapshot)
  })

  it('exposes an initial inventory refusal and recovers on a deliberate retry', async () => {
    const list = vi.fn<SkillLibraryApi['list']>().mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'Offline', {}) })
      .mockResolvedValue({ ok: true, value: inventory })
    const controller = new SkillLibraryController(api({ list }))
    await controller.refresh(); expect(controller.source.getSnapshot()).toMatchObject({ status: 'error', inventory: null, readError: true })
    await controller.refresh(); expect(controller.source.getSnapshot()).toMatchObject({ status: 'ready', inventory, readError: false })
    controller.dispose()
  })

  it('joins review metadata reads and retains the previous snapshot after refusal', async () => {
    const reading = deferred<Awaited<ReturnType<SkillLibraryApi['listProposals']>>>()
    const listProposals = vi.fn<SkillLibraryApi['listProposals']>().mockImplementationOnce(() => reading.promise)
      .mockRejectedValue(new Error('Offline'))
    const controller = new SkillLibraryController(api({ listProposals }))
    const first = controller.refreshLearning(); const join = controller.refreshLearning()
    expect(controller.source.getSnapshot().learning.status).toBe('loading'); expect(listProposals).toHaveBeenCalledTimes(1)
    reading.resolve({ ok: true, value: [{ ...learningProposal, changeCount: 1, beforeBytes: 18, afterBytes: 49 }] })
    await Promise.all([first, join]); const previous = controller.source.getSnapshot().learning
    await controller.refreshLearning()
    expect(controller.source.getSnapshot().learning).toMatchObject({ status: 'ready', error: true, reviews: previous.reviews, evidence: previous.evidence })
    controller.dispose()
    const failing = new SkillLibraryController(api({ learningStatus: async () => { throw new Error('Offline') } }))
    await failing.refreshLearning(); expect(failing.source.getSnapshot().learning).toMatchObject({ status: 'error', error: true })
    failing.dispose()
  })

  it('shows current detail errors while ignoring failures from an earlier selection', async () => {
    const old = deferred<Awaited<ReturnType<SkillLibraryApi['detail']>>>()
    const oldReview = deferred<Awaited<ReturnType<SkillLibraryApi['detailProposal']>>>()
    const secondId = 'second' as SkillLibraryId
    const secondReview = 'proposal:second' as typeof learningProposal.id
    const controller = new SkillLibraryController(api({
      detail: async request => request.id === id ? old.promise : { ok: true, value: { item: { ...item, id: secondId }, content: 'New selection', revisions: [] } },
      detailProposal: async request => request.proposalId === learningProposal.id ? oldReview.promise : { ok: true,
        value: { ...learningProposal, id: secondReview } },
    }))
    const pending = controller.loadDetail(id); const pendingReview = controller.loadReview(learningProposal.id)
    await controller.loadDetail(secondId); await controller.loadReview(secondReview)
    old.reject(new Error('Old source unavailable')); oldReview.reject(new Error('Old proposal unavailable'))
    await Promise.all([pending, pendingReview])
    expect(controller.source.getSnapshot().detail?.content).toBe('New selection')
    expect(controller.source.getSnapshot().learning.detail?.id).toBe(secondReview)
    controller.dispose()
    const failed = new SkillLibraryController(api({ detail: async () => { throw new Error('Missing source') }, detailProposal: async () => { throw new Error('Missing proposal') } }))
    await failed.loadDetail(id); await failed.loadReview(learningProposal.id)
    expect(failed.source.getSnapshot().detailStatus).toBe('error'); expect(failed.source.getSnapshot().learning.detailStatus).toBe('error')
    failed.dispose()
  })

  it('discards late preview success and failure after cancel without editing sources', async () => {
    const first = deferred<Awaited<ReturnType<SkillLibraryApi['previewCleanup']>>>()
    const second = deferred<Awaited<ReturnType<SkillLibraryApi['previewCleanup']>>>()
    const applyCleanup = vi.fn<SkillLibraryApi['applyCleanup']>()
    const controller = new SkillLibraryController(api({ previewCleanup: vi.fn<SkillLibraryApi['previewCleanup']>().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise), applyCleanup }))
    const pending = controller.preview(); controller.closePreview()
    first.resolve({ ok: true, value: { id: 'stale' as SkillCleanupProposalId, createdAt: '', changes: [], skipped: [] } }); await pending
    const failing = controller.preview([id]); controller.closePreview(); second.reject(new Error('Cancelled source read')); await failing
    await controller.applyPreview()
    expect(controller.source.getSnapshot()).toMatchObject({ cleanupOpen: false, proposal: null, previewLoading: false,
      previewError: false })
    expect(applyCleanup).not.toHaveBeenCalled(); controller.dispose()
  })

  it('retains an open reviewed preview during application and suppresses repeated actions', async () => {
    const applying = deferred<Awaited<ReturnType<SkillLibraryApi['applyCleanup']>>>()
    const applyCleanup = vi.fn<SkillLibraryApi['applyCleanup']>(() => applying.promise)
    const archive = vi.fn<SkillLibraryApi['archive']>()
    const previewCleanup = vi.fn<SkillLibraryApi['previewCleanup']>(async () => ({ ok: true, value: { id: 'preview' as SkillCleanupProposalId, createdAt: '', changes: [], skipped: [] } }))
    const controller = new SkillLibraryController(api({ applyCleanup, archive, previewCleanup }))
    await controller.preview(); const pending = controller.applyPreview()
    controller.closePreview(); await controller.preview([id]); await controller.applyPreview(); await controller.act('archive', item)
    expect(controller.source.getSnapshot()).toMatchObject({ busy: true, cleanupOpen: true })
    expect(applyCleanup).toHaveBeenCalledTimes(1); expect(previewCleanup).toHaveBeenCalledTimes(1); expect(archive).not.toHaveBeenCalled()
    applying.resolve({ ok: true, value: { revised: [id] } }); await pending
    expect(controller.source.getSnapshot()).toMatchObject({ busy: false, cleanupOpen: false, proposal: null, notice: { kind: 'cleanupApplied' } })
    controller.dispose()
  })

  it('reports current preview failures and keeps the source unchanged', async () => {
    const controller = new SkillLibraryController(api({ previewCleanup: async () => { throw new Error('Changed') } }))
    await controller.preview([id])
    expect(controller.source.getSnapshot()).toMatchObject({ cleanupOpen: true, previewLoading: false, previewError: true, proposal: null })
    controller.dispose()
  })

  it('waits for outstanding reads before publishing a successful operation notice', async () => {
    const reading = deferred<Awaited<ReturnType<SkillLibraryApi['list']>>>()
    const learning = deferred<Awaited<ReturnType<SkillLibraryApi['listProposals']>>>()
    const host = api({ list: vi.fn<SkillLibraryApi['list']>().mockImplementationOnce(() => reading.promise).mockResolvedValue({ ok: true, value: inventory }),
      listProposals: vi.fn<SkillLibraryApi['listProposals']>().mockImplementationOnce(() => learning.promise).mockResolvedValue({ ok: true, value: [] }) })
    const controller = new SkillLibraryController(host)
    const refresh = controller.refresh(); const refreshLearning = controller.refreshLearning(); const change = controller.act('pin', item)
    await new Promise<undefined>((resolve) => { setImmediate(() => { resolve(undefined) }) })
    expect(controller.source.getSnapshot().notice).toBeNull()
    reading.resolve({ ok: true, value: inventory }); await refresh
    await vi.waitFor(() => { expect(host.list).toHaveBeenCalledTimes(2) })
    await new Promise<undefined>((resolve) => { setImmediate(() => { resolve(undefined) }) })
    expect(controller.source.getSnapshot().notice).toBeNull()
    learning.resolve({ ok: true, value: [] }); await Promise.all([refreshLearning, change])
    expect(controller.source.getSnapshot().notice?.kind).toBe('changed'); controller.dispose()
  })

  it('binds every visible command to the controller and retains hash-bound rollback', async () => {
    const controller = new SkillLibraryController(api()); const face = controller.face()
    face.ensure(); await vi.waitFor(() => { expect(controller.source.getSnapshot().learning.status).toBe('ready') })
    face.refresh(); face.refreshLearning(); await vi.waitFor(() => { expect(controller.source.getSnapshot().readError).toBe(false) })
    face.loadDetail(id); await vi.waitFor(() => { expect(controller.source.getSnapshot().detailStatus).toBe('ready') })
    face.loadReview(learningProposal.id); await vi.waitFor(() => { expect(controller.source.getSnapshot().learning.detailStatus).toBe('ready') })
    face.act('pin', item); await vi.waitFor(() => { expect(controller.source.getSnapshot().notice?.seq).toBe(1) })
    face.preview([id]); await vi.waitFor(() => { expect(controller.source.getSnapshot().proposal).not.toBeNull() }); face.closePreview()
    expect(controller.source.getSnapshot().cleanupOpen).toBe(false)
    face.preview(); await vi.waitFor(() => { expect(controller.source.getSnapshot().proposal).not.toBeNull() }); face.applyPreview()
    await vi.waitFor(() => { expect(controller.source.getSnapshot().notice?.seq).toBe(2) })
    face.rollback(item, 'revision' as SkillRevisionId); await vi.waitFor(() => { expect(controller.source.getSnapshot().notice?.seq).toBe(3) })
    face.cleanupSemantic({ projectId: 'project', ids: [id], force: false }); await vi.waitFor(() => { expect(controller.source.getSnapshot().notice?.seq).toBe(4) })
    face.proposeLearning({ projectId: 'project', operation: 'learn', evidenceIds: [evidence.id] }); await vi.waitFor(() => { expect(controller.source.getSnapshot().notice?.seq).toBe(5) })
    face.validateReview(learningProposal.id); await vi.waitFor(() => { expect(controller.source.getSnapshot().notice?.seq).toBe(6) })
    face.approveReview(learningProposal.id); await vi.waitFor(() => { expect(controller.source.getSnapshot().notice?.seq).toBe(7) })
    face.rejectReview(learningProposal.id); await vi.waitFor(() => { expect(controller.source.getSnapshot().notice?.seq).toBe(8) })
    face.approvePolicy({ validatorId: 'validator', operations: ['compress'] }); await vi.waitFor(() => { expect(controller.source.getSnapshot().notice?.seq).toBe(9) })
    face.revokePolicy('policy' as import('@deepseek-ai/dsh-skill-library/types').SkillLearningPolicyId); await vi.waitFor(() => { expect(controller.source.getSnapshot().notice?.seq).toBe(10) })
    face.setLearningAutomatic(item, 'policy' as import('@deepseek-ai/dsh-skill-library/types').SkillLearningPolicyId, false); await vi.waitFor(() => { expect(controller.source.getSnapshot().notice?.seq).toBe(11) })
    face.dismissNotice(); expect(controller.source.getSnapshot().notice).toBeNull()
    controller.dispose(); const snapshot = controller.source.getSnapshot(); await controller.act('pin', item)
    expect(controller.source.getSnapshot()).toBe(snapshot)
  })

  it('does not publish a settled operation or detail after disposal', async () => {
    const pending = deferred<Awaited<ReturnType<SkillLibraryApi['setPinned']>>>()
    const controller = new SkillLibraryController(api({ setPinned: () => pending.promise }))
    const changing = controller.act('pin', item); controller.dispose(); const snapshot = controller.source.getSnapshot()
    pending.resolve({ ok: true, value: { item } }); await changing
    expect(controller.source.getSnapshot()).toBe(snapshot)
  })
})
