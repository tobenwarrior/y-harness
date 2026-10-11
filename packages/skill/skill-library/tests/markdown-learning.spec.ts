import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { SkillLibrary } from '../src/library.ts'
import { SkillLearning, type SkillLearningStore } from '../src/learning.ts'
import { nativeObservationGenerator, nativeObservationValidator } from '../src/native-observation.ts'
import type { SkillLibraryRecord } from '../src/record.ts'
import type { SkillLibraryId, SkillLearningEvidence, SkillLearningProposal, SkillLearningPolicy,
  SkillLearningOptIn, SkillLearningNativeEvidence, SkillNativeConnectionId, SkillCodexSessionId,
  SkillCodexTurnId, SkillCodexItemId } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
function memory<K extends string, V>(): SkillLearningStore<K, V> {
  const rows = new Map<K, V>()
  return { get: id => rows.get(id), entries: () => rows.entries(),
    put: async (id, value) => { rows.set(id, structuredClone(value)) } }
}
function native(turn: string, reverse = false): Extract<SkillLearningNativeEvidence, { provider: 'codex' }> {
  const actions: Extract<SkillLearningNativeEvidence, { provider: 'codex' }>['actions'][number][] = [
    { itemId: brandString<SkillCodexItemId>('read'), kind: 'read', name: 'read',
      procedure: { kind: 'read', path: 'src/source.ts' }, outcome: 'reported-success',
      startedEventRef: 's:1', settledEventRef: 's:2' },
    { itemId: brandString<SkillCodexItemId>('command'), kind: 'command', name: 'check',
      procedure: { kind: 'check', command: 'pnpm run test' }, outcome: 'reported-success',
      startedEventRef: 's:3', settledEventRef: 's:4' },
  ]
  return { provider: 'codex', connectionId: brandString<SkillNativeConnectionId>('profile'),
    sessionId: brandString<SkillCodexSessionId>('native-session'),
    turnId: brandString<SkillCodexTurnId>(turn), actions: reverse ? actions.reverse() : actions }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-markdown-learning-')); roots.push(root)
  const project = join(root, 'project'); await mkdir(join(project, '.git'), { recursive: true })
  const library = new SkillLibrary({ provider: new FileSystemSkillProvider(new Context(), {
    invalidate() {}, signal: new AbortController().signal }, { dshHome: join(root, 'home'),
    agentsHome: join(root, 'agents'), watch: false }), store: memory<SkillLibraryId, SkillLibraryRecord>(),
  projects: () => [{ id: 'p', title: 'Project', path: project }], historyDirectory: join(root, 'history'),
  bodyBudgetBytes: 20000, retrievalLimit: 4, proposalLimit: 20 })
  const options = { library, evidence: memory<SkillLearningEvidence['id'], SkillLearningEvidence>(),
    proposals: memory<SkillLearningProposal['id'], SkillLearningProposal>(),
    policies: memory<SkillLearningPolicy['id'], SkillLearningPolicy>(),
    optIns: memory<SkillLibraryId, SkillLearningOptIn>(), bodyBudgetBytes: 20000,
    maxInputBytes: 200000, maxSources: 4, maxEvidence: 4, maxResourceFiles: 600,
    maxResourceBytes: 1000000, signal: new AbortController().signal,
    maintenanceMaxOperations: 4, operationTimeoutMs: 10000,
    automaticProjectSkillLimit: 8, maintenanceIntervalMs: 600000 }
  const learning = new SkillLearning(options)
  learning.registerGenerator(nativeObservationGenerator); learning.registerValidator(nativeObservationValidator)
  const policy = await learning.approvePolicy({ projectId: 'p', generatorId: nativeObservationGenerator.id,
    validatorId: nativeObservationValidator.id, operations: ['create', 'update'] })
  async function evidence(turn: string, reverse = false) {
    return learning.recordEvidence({ projectId: 'p', sessionId: 's', task: 'Read and verify the project',
      completed: true, substantial: true, eventRefs: ['s:1', 's:2', 's:3', 's:4'],
      observations: ['Read the source and ran a distinct project check.'], checks: [], native: native(turn, reverse) })
  }
  await learning.autoLearnEvidence(await evidence('first'))
  const item = (await library.list({})).items[0]!
  const original = (await library.learningSource(item.id)).content
  const content = '# Workflow\n\nShort introduction.\n\n' + original + '\n\n## Recovery\n\n'
    + 'A complete recovery paragraph.\n\n'.repeat(120)
  const updated = (await library.reviseLearning({ id: item.id, expectedHash: item.contentHash, content }, async () => {})).item
  await learning.setAutomatic({ id: updated.id, expectedHash: updated.contentHash, policyId: policy.id, enabled: true })
  return { library, learning, options, evidence, item: updated, content }
}

describe('split source learning compatibility', () => {
  it('recognizes existing native instructions in topics without another model body load or revision', async () => {
    const f = await fixture(); const before = await readFile(f.item.path, 'utf8')
    expect(before).toContain('.y-topics/')
    expect(before).not.toContain('Native result delivery')
    expect(await f.learning.autoLearnEvidence(await f.evidence('same-sequence'))).toBeUndefined()
    expect(await readFile(f.item.path, 'utf8')).toBe(before)
    expect((await f.library.detail({ id: f.item.id })).revisions).toHaveLength(1)
  })

  it('settles automatic consent against complete logical text after another split update', async () => {
    const f = await fixture(); const proposal = await f.learning.autoLearnEvidence(await f.evidence('reverse', true))
    expect(proposal?.state).toBe('applied')
    const item = (await f.library.list({})).items.find(item => item.id === f.item.id)!
    expect(f.options.optIns.get(item.id)).toMatchObject({ enabled: true, contentHash: item.contentHash })
    expect((await f.library.learningSource(item.id)).content).toBe(proposal!.changes[0]!.after)
    expect((await f.library.detail({ id: item.id })).content).not.toContain('Native result delivery')
    expect(await f.learning.autoLearnEvidence(await f.evidence('reverse-again', true))).toBeUndefined()
    expect((await f.library.detail({ id: item.id })).revisions).toHaveLength(2)
  })

  it('reconciles a split source commit after interrupted proposal publication without applying twice', async () => {
    const f = await fixture(); const observed = await f.evidence('interrupted', true)
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'learn', targetIds: [f.item.id],
      evidenceIds: [observed.id], generatorId: nativeObservationGenerator.id })
    await f.learning.validate({ proposalId: proposal.id, validatorId: nativeObservationValidator.id })
    const put = f.options.proposals.put.bind(f.options.proposals); let fail = true
    f.options.proposals.put = async (id, value) => {
      if (fail && value.state === 'applying' && value.appliedIds.length > 0) {
        fail = false; throw new Error('Interrupted proposal publication')
      }
      await put(id, value)
    }
    await expect(f.learning.apply({ proposalId: proposal.id, mode: 'automatic' })).rejects.toThrow(/Interrupted/)
    const committed = await readFile(f.item.path, 'utf8')
    const restarted = new SkillLearning(f.options)
    restarted.registerGenerator(nativeObservationGenerator); restarted.registerValidator(nativeObservationValidator)
    expect((await restarted.apply({ proposalId: proposal.id, mode: 'automatic' })).state).toBe('applied')
    expect(await readFile(f.item.path, 'utf8')).toBe(committed)
    expect((await f.library.detail({ id: f.item.id })).revisions).toHaveLength(2)
    const current = (await f.library.list({})).items[0]!
    expect(f.options.optIns.get(current.id)?.contentHash).toBe(current.contentHash)
  })
})
