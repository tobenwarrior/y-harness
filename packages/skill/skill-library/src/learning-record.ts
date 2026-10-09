/** JSON validation for durable evidence, full proposals and separate semantic policies. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type {
  SkillLibraryId,
  SkillLearningEvidence,
  SkillLearningEvidenceId,
  SkillLearningProposal,
  SkillLearningProposalId,
  SkillLearningPolicy,
  SkillLearningPolicyId,
  SkillLearningOptIn,
} from './types.ts'

const skillId = z.string().transform(value => brandString<SkillLibraryId>(value))
const evidenceId = z.string().transform(value => brandString<SkillLearningEvidenceId>(value))
const proposalId = z.string().transform(value => brandString<SkillLearningProposalId>(value))
const policyId = z.string().transform(value => brandString<SkillLearningPolicyId>(value))
const check = z.object({
  kind: z.enum(['test', 'constraint', 'resource', 'user-confirmation']),
  result: z.enum(['passed', 'failed', 'unknown']),
  eventRef: z.string().min(1),
  summary: z.string().min(1),
  issuer: z.string().min(1).optional(),
  scope: z.literal('task-verification').optional(),
  inputHash: z.string().min(1).optional(),
  outputHash: z.string().min(1).optional(),
})
/** Immutable evidence parser used before persistence. */
export const learningEvidenceSchema = z.object({
  id: evidenceId,
  createdAt: z.string(),
  projectId: z.string().min(1),
  sessionId: z.string().min(1),
  task: z.string().min(1),
  completed: z.boolean(),
  substantial: z.boolean(),
  eventRefs: z.array(z.string().min(1)).min(1),
  observations: z.array(z.string().min(1)),
  checks: z.array(check),
})
/** Parsed generator output cannot carry verification, destination paths or source hashes. */
export const learningDraftSchema = z.object({
  drafts: z.array(z.object({
    kind: z.enum(['create', 'update', 'compress', 'archive']),
    id: skillId.optional(),
    name: z.string().min(1),
    description: z.string().min(1),
    content: z.string(),
    survivorId: skillId.optional(),
  }).strict()).min(1),
  uncertainty: z.array(z.string()),
}).strict()
const resource = z.object({ path: z.string(), hash: z.string(), bytes: z.number().int().nonnegative() })
const receipt = z.object({
  scope: z.literal('full-proposal'),
  digest: z.string(),
  evidenceIds: z.array(evidenceId),
  eventRefs: z.array(z.string()),
  sourceHashes: z.array(z.string()),
  resourceHashes: z.array(z.string()),
})
/** Independent provider output parser; trust is assigned only by host registration. */
export const learningValidationSchema = z.object({
  constraintsPreserved: z.boolean(),
  resourcesPreserved: z.boolean(),
  referenceImpactChecked: z.boolean(),
  survivorEquivalent: z.boolean(),
  findings: z.array(z.string()),
  receipt: receipt.optional(),
})
const validation = learningValidationSchema.extend({
  validatorId: z.string(),
  checkedAt: z.string(),
  digest: z.string(),
  trusted: z.boolean(),
  independent: z.boolean(),
})
const change = z.object({
  kind: z.enum(['create', 'update', 'compress', 'archive']),
  id: skillId.optional(),
  name: z.string(),
  description: z.string(),
  path: z.string(),
  expectedHash: z.string(),
  before: z.string(),
  after: z.string(),
  resourceHash: z.string(),
  resources: z.array(resource),
  constraints: z.array(z.string()),
  references: z.array(z.string()),
  survivorId: skillId.optional(),
  survivorHash: z.string().optional(),
  survivorResourceHash: z.string().optional(),
  survivorContent: z.string().optional(),
  survivorResources: z.array(resource).optional(),
  survivorReferences: z.array(z.string()).optional(),
})
const proposal = z.object({
  id: proposalId,
  projectId: z.string(),
  operation: z.enum(['learn', 'compress', 'deduplicate']),
  state: z.enum(['review', 'validated', 'applying', 'applied', 'blocked', 'rejected']),
  createdAt: z.string(),
  generator: z.string(),
  digest: z.string(),
  changes: z.array(change),
  evidenceIds: z.array(evidenceId),
  evidence: z.array(learningEvidenceSchema),
  uncertainty: z.array(z.string()),
  findings: z.array(z.string()),
  validation: validation.optional(),
  appliedIds: z.array(skillId),
})
const policy = z.object({
  id: policyId,
  approvedAt: z.string(),
  validatorId: z.string(),
  operations: z.array(z.enum(['update', 'compress', 'archive'])),
})
const optIn = z.object({ id: skillId, contentHash: z.string(), policyId, enabled: z.boolean() })
/** Durable proposals retain their complete source diffs and task observations. */
export const skillLearningDomain = defineDomain({
  name: 'skill_learning',
  version: 1,
  tables: {
    evidence: domainTable<SkillLearningEvidenceId, SkillLearningEvidence>(learningEvidenceSchema),
    proposals: domainTable<SkillLearningProposalId, SkillLearningProposal>(proposal),
    policies: domainTable<SkillLearningPolicyId, SkillLearningPolicy>(policy),
    opt_ins: domainTable<SkillLibraryId, SkillLearningOptIn>(optIn),
  },
})
