/** Browser-safe learning proposals and host provider types. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SkillLibraryId, SkillLibraryItem } from './types.ts'

/** Immutable task observation identity. */
export type SkillLearningEvidenceId = Branded<'SkillLearningEvidenceId'>
/** Durable reviewed change identity. */
export type SkillLearningProposalId = Branded<'SkillLearningProposalId'>
/** Explicit semantic automation policy identity. */
export type SkillLearningPolicyId = Branded<'SkillLearningPolicyId'>
/** A source check observed by the host, separate from task completion. */
export interface SkillLearningCheck {
  readonly kind: 'test' | 'constraint' | 'resource' | 'user-confirmation'
  readonly result: 'passed' | 'failed' | 'unknown'
  readonly eventRef: string
  readonly summary: string
  readonly issuer?: string | undefined
  readonly scope?: 'task-verification' | undefined
  readonly inputHash?: string | undefined
  readonly outputHash?: string | undefined
}
/** Host-only evidence capture input; generator outputs cannot populate this store. */
export interface SkillLearningObservation {
  readonly projectId: string
  readonly sessionId: string
  readonly task: string
  readonly completed: boolean
  readonly substantial: boolean
  readonly eventRefs: readonly string[]
  readonly observations: readonly string[]
  readonly checks: readonly SkillLearningCheck[]
}
/** Immutable recorded observations, without a semantic success claim. */
export interface SkillLearningEvidence extends SkillLearningObservation {
  readonly id: SkillLearningEvidenceId
  readonly createdAt: string
}
/** Whole-bundle resource identity; bodies are never rewritten by learning. */
export interface SkillLearningResource {
  readonly path: string
  readonly hash: string
  readonly bytes: number
}
/** Current instructions selected for a bounded proposal request. */
export interface SkillLearningSource {
  readonly item: SkillLibraryItem
  readonly content: string
  readonly resourceHash: string
  readonly resources: readonly SkillLearningResource[]
  readonly constraints: readonly string[]
  readonly references: readonly string[]
}
/** Proposed operation; create is always reviewed. */
export type SkillLearningChangeKind = 'create' | 'update' | 'compress' | 'archive'
/** Immutable full change presented to a reviewer and independent validator. */
export interface SkillLearningChange {
  readonly kind: SkillLearningChangeKind
  readonly id?: SkillLibraryId | undefined
  readonly name: string
  readonly description: string
  readonly path: string
  readonly expectedHash: string
  readonly before: string
  readonly after: string
  readonly resourceHash: string
  readonly resources: readonly SkillLearningResource[]
  readonly constraints: readonly string[]
  readonly references: readonly string[]
  readonly survivorId?: SkillLibraryId | undefined
  readonly survivorHash?: string | undefined
  readonly survivorResourceHash?: string | undefined
  readonly survivorContent?: string | undefined
  readonly survivorResources?: readonly SkillLearningResource[] | undefined
  readonly survivorReferences?: readonly string[] | undefined
}
/** Independent check receipt bound to the complete proposal and actual check events. */
export interface SkillLearningValidationReceipt {
  readonly scope: 'full-proposal'
  readonly digest: string
  readonly evidenceIds: readonly SkillLearningEvidenceId[]
  readonly eventRefs: readonly string[]
  readonly sourceHashes: readonly string[]
  readonly resourceHashes: readonly string[]
}
/** Independent validation tied to the exact immutable proposal digest. */
export interface SkillLearningValidation {
  readonly validatorId: string
  readonly checkedAt: string
  readonly digest: string
  readonly trusted: boolean
  readonly independent: boolean
  readonly constraintsPreserved: boolean
  readonly resourcesPreserved: boolean
  readonly referenceImpactChecked: boolean
  readonly survivorEquivalent: boolean
  readonly findings: readonly string[]
  readonly receipt?: SkillLearningValidationReceipt | undefined
}
/** Durable full proposal, including uncertainty and source evidence. */
export interface SkillLearningProposal {
  readonly id: SkillLearningProposalId
  readonly projectId: string
  readonly operation: 'learn' | 'compress' | 'deduplicate'
  readonly state: 'review' | 'validated' | 'applying' | 'applied' | 'blocked' | 'rejected'
  readonly createdAt: string
  readonly generator: string
  readonly digest: string
  readonly changes: readonly SkillLearningChange[]
  readonly evidenceIds: readonly SkillLearningEvidenceId[]
  readonly evidence: readonly SkillLearningEvidence[]
  readonly uncertainty: readonly string[]
  readonly findings: readonly string[]
  readonly validation?: SkillLearningValidation | undefined
  readonly appliedIds: readonly SkillLibraryId[]
}
/** Metadata-only proposal list row. */
export interface SkillLearningProposalSummary {
  readonly id: SkillLearningProposalId
  readonly projectId: string
  readonly operation: SkillLearningProposal['operation']
  readonly state: SkillLearningProposal['state']
  readonly createdAt: string
  readonly generator: string
  readonly changeCount: number
  readonly uncertainty: readonly string[]
  readonly findings: readonly string[]
  readonly beforeBytes: number
  readonly afterBytes: number
}
/** Explicitly approved semantic policy, separate from whitespace cleanup. */
export interface SkillLearningPolicy {
  readonly id: SkillLearningPolicyId
  readonly approvedAt: string
  readonly validatorId: string
  readonly operations: readonly ('update' | 'compress' | 'archive')[]
}
/** Per-file semantic consent; manual edits invalidate its hash. */
export interface SkillLearningOptIn {
  readonly id: SkillLibraryId
  readonly contentHash: string
  readonly policyId: SkillLearningPolicyId
  readonly enabled: boolean
}
/** Project route availability observed by the host adapter. */
export interface SkillLearningAvailability {
  readonly projectId: string
  readonly state: 'available' | 'unavailable'
  readonly reason: string
}
/** Learning providers and approved policy coverage. */
export interface SkillLearningStatus {
  readonly availability: readonly SkillLearningAvailability[]
  readonly generators: readonly string[]
  readonly validators: readonly {
    readonly id: string
    readonly trusted: boolean
  }[]
  readonly policies: readonly SkillLearningPolicy[]
  readonly optIns: readonly SkillLearningOptIn[]
  readonly evidence: readonly SkillLearningEvidence[]
}
/** Bounded proposal request using recorded task observations. */
export interface SkillLearningProposeRequest {
  readonly projectId: string
  readonly operation: SkillLearningProposal['operation']
  readonly targetIds?: readonly SkillLibraryId[]
  readonly evidenceIds: readonly SkillLearningEvidenceId[]
}
/** Optional project filter. */
export interface SkillLearningListRequest { readonly projectId?: string }
/** Selected durable proposal. */
export interface SkillLearningProposalRequest { readonly proposalId: SkillLearningProposalId }
/** Explicit review or separately approved automatic application. */
export interface SkillLearningApplyRequest extends SkillLearningProposalRequest { readonly mode: 'reviewed' | 'automatic' }
/** Policy approval does not enable any file. */
export interface SkillLearningPolicyRequest {
  readonly validatorId: string
  readonly operations: readonly ('update' | 'compress' | 'archive')[]
}
/** Explicit semantic opt-in tied to the unchanged current version. */
export interface SkillLearningAutomaticRequest {
  readonly id: SkillLibraryId
  readonly expectedHash: string
  readonly policyId: SkillLearningPolicyId
  readonly enabled: boolean
}
/** Generator input; completed tasks and checks remain distinct. */
export interface SkillLearningGenerateInput {
  readonly projectId: string
  readonly operation: SkillLearningProposal['operation']
  readonly evidence: readonly SkillLearningEvidence[]
  readonly catalog: readonly SkillLibraryItem[]
  readonly sources: readonly SkillLearningSource[]
  readonly bodyBudgetBytes: number
}
/** Model output parsed by the host; target paths and evidence authority are host-owned. */
export interface SkillLearningDraft {
  readonly kind: SkillLearningChangeKind
  readonly id?: SkillLibraryId | undefined
  readonly name: string
  readonly description: string
  readonly content: string
  readonly survivorId?: SkillLibraryId | undefined
}
/** A generator returns suggestions, never verified outcomes. */
export interface SkillLearningGenerator {
  readonly id: string
  /**
   * Suggest bounded body changes without verification authority.
   * @param input - immutable bounded source observations.
   * @param signal - host cancellation.
   * @returns uncertain body-only drafts.
   */
  generate(input: SkillLearningGenerateInput, signal: AbortSignal): Promise<{
    readonly drafts: readonly SkillLearningDraft[]
    readonly uncertainty: readonly string[]
  }>
}
/** Independent validator output; trust comes from host registration. */
export interface SkillLearningValidationResult {
  readonly constraintsPreserved: boolean
  readonly resourcesPreserved: boolean
  readonly referenceImpactChecked: boolean
  readonly survivorEquivalent: boolean
  readonly findings: readonly string[]
  readonly receipt?: SkillLearningValidationReceipt | undefined
}
/** Validation capability registered separately from generation. */
export interface SkillLearningValidator {
  readonly id: string
  readonly trusted: boolean
  /**
   * Check a complete suggestion with an independent provider.
   * @param proposal - immutable complete diff and evidence.
   * @param signal - host cancellation.
   * @returns independent checks without changing source files.
   */
  validate(proposal: SkillLearningProposal, signal: AbortSignal): Promise<SkillLearningValidationResult>
}
