/** Durable records retain exact native identity and auxiliary results without extra route authority. */
import { expect, it } from 'vitest'
import { decisionDomain } from '../src/decision-record.ts'
import { learningEvidenceSchema, skillLearningDomain } from '../src/learning-record.ts'

it('validates configured and unconfigured Decision settings and complete selected or abstained records', () => {
  const settings = decisionDomain.global.schema
  expect(settings.parse({ revision: 0, enabled: false })).toEqual({ revision: 0, enabled: false })
  const configured = { revision: 1, enabled: true, route: { provider: 'fixture', model: 'model', reasoningEffort: 'ultra', serviceTier: 'default' } }
  expect(settings.parse(configured)).toEqual(configured)
  const record = { id: 'request', createdAt: '2026-10-11', configurationRevision: 1, input: 'metadata', outcome: 'selected', output: 'response', selectedIds: ['one'] }
  expect(decisionDomain.tables.requests.valueSchema.parse(record)).toEqual(record)
  const abstained = { id: 'request', createdAt: '', configurationRevision: 0, input: '', outcome: 'abstained', reason: 'invalid-fields' }
  expect(decisionDomain.tables.requests.valueSchema.parse(abstained)).toEqual(abstained)
  expect(() => settings.parse({ ...configured, route: { ...configured.route, apiKey: 'forbidden' } })).toThrow()
  expect(() => decisionDomain.tables.requests.valueSchema.parse({ ...record, permission: 'allow' })).toThrow()
})

it('retains Claude message pairing and fresh sequential identities, while refusing incomplete pairing', () => {
  const observation = { id: 'evidence', createdAt: '', projectId: 'project', sessionId: 'mirror', task: 'Inspect files', completed: true, substantial: true, eventRefs: ['mirror:1', 'mirror:2'], observations: [], checks: [] }
  const action = { itemId: 'tool', kind: 'read', name: 'read', outcome: 'unknown', startedEventRef: 'mirror:1', settledEventRef: 'mirror:2', sourceMessageId: 'assistant-message', resultMessageId: 'user-message' }
  const native = { provider: 'claude-code', connectionId: 'profile', sessionId: 'native', sendId: 'send', actions: [action] }
  const sequentialTask = { taskId: '1d254d7c-b9f8-4c97-8e63-bf18cba5f4af', source: { provider: 'claude', profileId: 'profile', nativeSessionId: 'native', toolMode: 'conversation' }, nativeTurnId: 'send' }
  expect(learningEvidenceSchema.parse({ ...observation, native, sequentialTask })).toEqual({ ...observation, native, sequentialTask })
  const { resultMessageId: _resultMessageId, ...unpaired } = action
  expect(() => learningEvidenceSchema.parse({ ...observation, native: { ...native, actions: [unpaired] } })).toThrow()
  expect(() => learningEvidenceSchema.parse({ ...observation, sequentialTask: { ...sequentialTask, taskId: 'not-a-uuid' } })).toThrow()
  const codex = { provider: 'codex', connectionId: 'profile', sessionId: 'native', turnId: 'turn', actions: [action] }
  expect(learningEvidenceSchema.parse({ ...observation, native: codex }).native?.actions[0]).toEqual(action)
  const proposal = { id: 'proposal', projectId: 'project', operation: 'learn', state: 'review', createdAt: '', generator: 'fixture', digest: 'digest', changes: [], evidenceIds: ['evidence'], evidence: [observation], uncertainty: [], findings: [], appliedIds: [] }
  expect(skillLearningDomain.tables.proposals.valueSchema.parse(proposal)).toEqual(proposal)
  const policy = { id: 'policy', approvedAt: '', validatorId: 'validator', operations: ['update'] }
  expect(skillLearningDomain.tables.policies.valueSchema.parse(policy)).toEqual(policy)
  const consent = { id: 'skill', contentHash: 'hash', policyId: 'policy', enabled: false }
  expect(skillLearningDomain.tables.opt_ins.valueSchema.parse(consent)).toEqual(consent)
})
