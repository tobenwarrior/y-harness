import { describe, expect, it } from 'vitest'
import type {
  SkillLearningCleanupRequest, SkillLearningPolicy, SkillLearningPolicyId, SkillLearningPolicyRequest,
  SkillLibraryId, SkillLibraryItem,
} from '@deepseek-ai/dsh-skill-library/types'
import type { SkillLibraryFace } from '../src/client/controller.ts'
import { createPolicyActionHandlers, createProjectPolicyActionHandlers } from '../src/client/policy-actions.ts'

const id = 'skill:release' as SkillLibraryId
const policyId = 'policy:release' as SkillLearningPolicyId
const item: SkillLibraryItem = {
  id, name: 'Release', description: 'Release workflow', provider: 'filesystem', source: 'project',
  path: '/sample/.agents/skills/release/SKILL.md', scope: 'project', projectIds: ['project'],
  ownership: 'y-managed', status: 'active', shadowed: false, pinned: false, automaticCleanup: false,
  invocation: { modelInvocable: true, userInvocable: true }, contentHash: 'current-hash', bodyBytes: 100,
  usage: { coverage: 'unknown', loadCount: 0 }, references: [],
  capabilities: { adopt: false, archive: true, restore: false, cleanup: true, native: false },
}
const policy: SkillLearningPolicy = { id: policyId, approvedAt: '2026-10-09T00:00:00Z',
  validatorId: 'trusted-checker', operations: ['update', 'compress'] }
const project = { id: 'project', title: 'Sample project', path: '/sample/project' }

function fixture(patch: Partial<Parameters<typeof createPolicyActionHandlers>[0]> = {}) {
  const approvals: SkillLearningPolicyRequest[] = [], automatic: Parameters<SkillLibraryFace['setLearningAutomatic']>[] = []
  const cleanup: SkillLearningCleanupRequest[] = [], order: string[] = []
  const callbacks: Parameters<typeof createPolicyActionHandlers>[1] = {
    approvePolicy: (request) => { approvals.push(request); order.push('approve') },
    setLearningAutomatic: (...request) => { automatic.push(request) },
    cleanupSemantic: (request) => { cleanup.push(request) },
    closeApproval: () => { order.push('close') },
  }
  const snapshot: Parameters<typeof createPolicyActionHandlers>[0] = {
    item, busy: false, canApprove: true, validatorId: 'trusted-checker', allowed: ['update', 'compress'],
    optIn: { id, policyId, contentHash: item.contentHash, enabled: true }, canCleanup: true, selectedPolicy: policy, ...patch,
  }
  return { actions: createPolicyActionHandlers(snapshot, callbacks), callbacks, snapshot, approvals, automatic, cleanup, order }
}

function projectFixture(snapshot: Parameters<typeof createProjectPolicyActionHandlers>[0] = { canApprove: true, project }) {
  const approvals: SkillLearningPolicyRequest[] = [], consent: { projectId: string; allowed: boolean }[] = [], order: string[] = []
  const callbacks: Parameters<typeof createProjectPolicyActionHandlers>[1] = {
    approvePolicy: (request) => { approvals.push(request); order.push('approve') },
    setConsent: (value) => { consent.push(value) }, closeApproval: () => { order.push('close') },
  }
  return { actions: createProjectPolicyActionHandlers(snapshot, callbacks), approvals, consent, order }
}

describe('skill learning callback guards', () => {
  it('approves the selected maintenance operations before closing the dialog', () => {
    const state = fixture()
    state.actions.submit()
    expect(state.approvals).toEqual([{ validatorId: 'trusted-checker', operations: ['update', 'compress'] }])
    expect(state.order).toEqual(['approve', 'close'])
    expect(state.automatic).toEqual([])
  })

  it.each([
    { canApprove: false, validatorId: 'trusted-checker' },
    { canApprove: true, validatorId: null },
  ])('does not submit an unapproved or missing-validator draft: %j', (patch) => {
    const state = fixture(patch)
    state.actions.submit()
    expect(state.approvals).toEqual([])
    expect(state.order).toEqual([])
  })

  it('keeps the approval dialog open when its callback refuses the request', () => {
    const state = fixture()
    const actions = createPolicyActionHandlers(state.snapshot, { ...state.callbacks,
      approvePolicy: () => { throw new Error('Fixture approval refused') },
    })
    expect(() => { actions.submit() }).toThrow('Fixture approval refused')
    expect(state.order).toEqual([])
  })

  it('revokes only an enabled opt-in while the operation is available', () => {
    const state = fixture()
    state.actions.revoke()
    expect(state.automatic).toEqual([[item, policyId, false]])
    expect(state.approvals).toEqual([])
  })

  it.each([
    { busy: true }, { optIn: undefined }, { optIn: { id, policyId, contentHash: item.contentHash, enabled: false } },
  ])('refuses unavailable opt-in revocation: %j', (patch) => {
    const state = fixture(patch)
    state.actions.revoke()
    state.actions.setAutomatic(false)
    expect(state.automatic).toEqual([])
  })

  it('uses the selected approved policy for enablement and the stored opt-in for revocation', () => {
    const selected = { ...policy, id: 'policy:selected' as SkillLearningPolicyId }
    const state = fixture({ selectedPolicy: selected })
    state.actions.setAutomatic(true)
    state.actions.setAutomatic(false)
    expect(state.automatic).toEqual([[item, selected.id, true], [item, policyId, false]])
    expect(state.approvals).toEqual([])
  })

  it.each([{ busy: true }, { selectedPolicy: undefined }])('does not enable unavailable maintenance: %j', (patch) => {
    const state = fixture(patch)
    state.actions.setAutomatic(true)
    expect(state.automatic).toEqual([])
  })

  it('requests normal and forced cleanup with the observed first project', () => {
    const state = fixture({ item: { ...item, projectIds: ['project', 'other'] } })
    state.actions.runCleanup(false)
    state.actions.runCleanup(true)
    expect(state.cleanup).toEqual([
      { projectId: 'project', ids: [id], force: false }, { projectId: 'project', ids: [id], force: true },
    ])
  })

  it('preserves shared cleanup scope and refuses cleanup without authorization', () => {
    const shared = fixture({ item: { ...item, scope: 'shared', projectIds: [] } })
    shared.actions.runCleanup(true)
    expect(shared.cleanup).toEqual([{ ids: [id], force: true }])
    const unavailable = fixture({ canCleanup: false })
    unavailable.actions.runCleanup(false)
    unavailable.actions.runCleanup(true)
    expect(unavailable.cleanup).toEqual([])
  })

  it('keeps each callback bound to the predicate snapshot supplied by its render', () => {
    const ready = fixture()
    const pending = createPolicyActionHandlers({ ...ready.snapshot, busy: true, canApprove: false, canCleanup: false }, ready.callbacks)
    pending.submit(); pending.setAutomatic(true); pending.runCleanup(true)
    expect(ready.approvals).toEqual([])
    expect(ready.automatic).toEqual([])
    expect(ready.cleanup).toEqual([])
    ready.actions.submit()
    expect(ready.approvals).toEqual([{ validatorId: 'trusted-checker', operations: ['update', 'compress'] }])
  })

  it('approves native project creation before closing the project dialog', () => {
    const state = projectFixture()
    state.actions.approve()
    expect(state.approvals).toEqual([{ validatorId: 'native-observation-validator', generatorId: 'native-observation',
      projectId: 'project', operations: ['create', 'update'] }])
    expect(state.order).toEqual(['approve', 'close'])
  })

  it.each([project, undefined])('does not approve a project when its approval predicate is false: %j', (candidate) => {
    const state = projectFixture({ canApprove: false, project: candidate })
    state.actions.approve()
    expect(state.approvals).toEqual([])
    expect(state.order).toEqual([])
  })

  it('records both consent choices only for the currently observed project', () => {
    const state = projectFixture({ canApprove: false, project })
    state.actions.setAllowed(true); state.actions.setAllowed(false)
    expect(state.consent).toEqual([{ projectId: 'project', allowed: true }, { projectId: 'project', allowed: false }])
    const missing = projectFixture({ canApprove: false, project: undefined })
    missing.actions.setAllowed(true)
    expect(missing.consent).toEqual([])
    expect(state.approvals).toEqual([])
  })
})
