import type { SkillLearningEvidence, SkillLearningEvidenceId, SkillLearningProposal, SkillLearningProposalId, SkillLearningStatus, SkillLibraryId } from '@deepseek-ai/dsh-skill-library/types'

/** Completed work has observations without implied verification. */
export const evidence: SkillLearningEvidence = { id: 'evidence:task' as SkillLearningEvidenceId, projectId: 'project', sessionId: 'session:task', task: 'Resolve release regression', completed: true, substantial: true, eventRefs: ['event:completed'], observations: ['The release needs a focused test before publishing.'], checks: [], createdAt: '2026-10-09T00:00:00Z' }

/** An immutable, unverified body proposal for explicit review. */
export const learningProposal: SkillLearningProposal = { id: 'proposal:release' as SkillLearningProposalId, projectId: 'project', operation: 'learn', state: 'review', createdAt: '2026-10-09T01:00:00Z', generator: 'fixture-generator', digest: 'proposal-digest', changes: [{ kind: 'update', id: 'release' as SkillLibraryId, name: 'Release workflow', description: 'Ship verified releases', path: '/work/project/.dsh/skills/release/SKILL.md', expectedHash: 'hash', before: 'Check the release.', after: 'Run the focused regression check before releasing.', resourceHash: 'resources-hash', resources: [{ path: 'scripts/release.sh', hash: 'script-hash', bytes: 120 }], constraints: ['Ask before publishing.'], references: ['review/SKILL.md'] }], evidenceIds: [evidence.id], evidence: [evidence], uncertainty: ['No independent source check was recorded.'], findings: [], appliedIds: [] }

/** No validator is treated as trusted merely because it exists. */
export const learningStatus: SkillLearningStatus = { availability: [{ projectId: 'project', state: 'available', reason: 'fixture route' }], generators: ['fixture-generator'], validators: [], policies: [], optIns: [], evidence: [evidence] }
