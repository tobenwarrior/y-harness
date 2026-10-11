/** Guarded learning callbacks retain the consent decisions from their owning render. */
import type {
  SkillLearningOptIn, SkillLearningPolicy, SkillLearningPolicyRequest, SkillLibraryItem, SkillLibraryProject,
} from '@deepseek-ai/dsh-skill-library/types'
import type { SkillLibraryFace } from './controller.ts'

interface PolicyActionSnapshot {
  readonly item: SkillLibraryItem
  readonly busy: boolean
  readonly canApprove: boolean
  readonly validatorId: string | null
  readonly allowed: SkillLearningPolicyRequest['operations']
  readonly optIn: SkillLearningOptIn | undefined
  readonly canCleanup: boolean
  readonly selectedPolicy: SkillLearningPolicy | undefined
}
type PolicyActionCallbacks = Pick<SkillLibraryFace, 'approvePolicy' | 'setLearningAutomatic' | 'cleanupSemantic'> & {
  readonly closeApproval: () => void
}
type ProjectActionSnapshot = { readonly canApprove: true; readonly project: SkillLibraryProject }
  | { readonly canApprove: false; readonly project: SkillLibraryProject | undefined }
type ProjectActionCallbacks = Pick<SkillLibraryFace, 'approvePolicy'> & {
  readonly closeApproval: () => void
  readonly setConsent: (selection: { readonly projectId: string; readonly allowed: boolean }) => void
}

/**
 * Retain per-file callback guards and request ordering from one render snapshot.
 * @param snapshot - observed skill, consent, and derived operation permissions.
 * @param callbacks - the owning controller commands and approval-dialog closer.
 * @returns guarded approval, revocation, cleanup, and enablement callbacks.
 */
export function createPolicyActionHandlers(snapshot: PolicyActionSnapshot, callbacks: PolicyActionCallbacks): {
  revoke: () => void
  submit: () => void
  runCleanup: (force: boolean) => void
  setAutomatic: (enabled: boolean) => void
} {
  const revoke = (): void => {
    if (!snapshot.busy && snapshot.optIn?.enabled === true) {
      callbacks.setLearningAutomatic(snapshot.item, snapshot.optIn.policyId, false)
    }
  }
  const submit = (): void => {
    if (!snapshot.canApprove || snapshot.validatorId === null) return
    callbacks.approvePolicy({ validatorId: snapshot.validatorId, operations: snapshot.allowed })
    callbacks.closeApproval()
  }
  const runCleanup = (force: boolean): void => {
    if (!snapshot.canCleanup) return
    const projectId = snapshot.item.projectIds[0]
    callbacks.cleanupSemantic({ ...projectId === undefined ? {} : { projectId }, ids: [snapshot.item.id], force })
  }
  const setAutomatic = (enabled: boolean): void => {
    if (!enabled) revoke()
    else if (!snapshot.busy && snapshot.selectedPolicy !== undefined) {
      callbacks.setLearningAutomatic(snapshot.item, snapshot.selectedPolicy.id, true)
    }
  }
  return { revoke, submit, runCleanup, setAutomatic }
}

/**
 * Retain project approval and consent guards from one render snapshot.
 * @param snapshot - the selected project and its derived approval permission.
 * @param callbacks - project-policy approval, dialog closure, and consent selection.
 * @returns separately guarded project approval and local consent callbacks.
 */
export function createProjectPolicyActionHandlers(snapshot: ProjectActionSnapshot, callbacks: ProjectActionCallbacks): {
  approve: () => void
  setAllowed: (allowed: boolean) => void
} {
  const approve = (): void => {
    if (!snapshot.canApprove) return
    callbacks.approvePolicy({ validatorId: 'native-observation-validator', generatorId: 'native-observation',
      projectId: snapshot.project.id, operations: ['create', 'update'] })
    callbacks.closeApproval()
  }
  const setAllowed = (allowed: boolean): void => {
    if (snapshot.project !== undefined) callbacks.setConsent({ projectId: snapshot.project.id, allowed })
  }
  return { approve, setAllowed }
}
