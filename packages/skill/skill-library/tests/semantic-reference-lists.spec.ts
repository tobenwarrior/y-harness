import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { SkillLibrary } from '../src/library.ts'
import { SkillLearning, type SkillLearningStore } from '../src/learning.ts'
import { maintenanceGenerator, maintenanceValidator, mechanicalMaintenanceValid,
  reduceInstructionRedundancy } from '../src/semantic-maintenance.ts'
import type { SkillLibraryRecord } from '../src/record.ts'
import type { SkillLearningEvidence, SkillLearningOptIn, SkillLearningPolicy, SkillLearningProposal,
  SkillLearningProposalId, SkillLibraryId } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const before = '# References\n- [Guide](reference.txt)\n\n- [Other](other.txt)\n- [Guide](reference.txt)\n'
const after = '# References\n- [Guide](reference.txt)\n\n- [Other](other.txt)\n'

function proposal(source = before, result = after): SkillLearningProposal {
  return { id: brandString<SkillLearningProposalId>('p'), projectId: 'project',
    operation: 'compress', state: 'review', createdAt: '', generator: maintenanceGenerator.id,
    digest: 'complete-proposal-digest', evidenceIds: [], evidence: [], uncertainty: [], findings: [], appliedIds: [],
    changes: [{ kind: 'compress', id: brandString<SkillLibraryId>('skill'), name: 'example',
      description: 'Example', path: '/skill', expectedHash: 'source-hash', before: source, after: result,
      resources: [], resourceHash: 'resource-hash', constraints: [], references: ['reference.txt', 'other.txt'] }] }
}

function memory<K extends string, V>(): SkillLearningStore<K, V> {
  const rows = new Map<K, V>()
  return { get: id => rows.get(id), entries: () => rows.entries(),
    put: async (id, value) => { rows.set(id, structuredClone(value)) } }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-reference-list-')); roots.push(root)
  const project = join(root, 'project'); await mkdir(join(project, '.git'), { recursive: true })
  const library = new SkillLibrary({ provider: new FileSystemSkillProvider(new Context(), {
    invalidate() {}, signal: new AbortController().signal }, { dshHome: join(root, 'home'),
    agentsHome: join(root, 'agents'), watch: false }), store: memory<SkillLibraryId, SkillLibraryRecord>(),
  projects: () => [{ id: 'p', title: 'Project', path: project }], historyDirectory: join(root, 'history'),
  bodyBudgetBytes: 2000, retrievalLimit: 4, proposalLimit: 20 })
  const options = { library, evidence: memory<SkillLearningEvidence['id'], SkillLearningEvidence>(),
    proposals: memory<SkillLearningProposal['id'], SkillLearningProposal>(),
    policies: memory<SkillLearningPolicy['id'], SkillLearningPolicy>(), optIns: memory<SkillLibraryId, SkillLearningOptIn>(),
    bodyBudgetBytes: 2000, maxInputBytes: 20000, maxSources: 4, maxEvidence: 4, maxResourceFiles: 30,
    maxResourceBytes: 20000, maintenanceMaxOperations: 4, maintenanceIntervalMs: 600000,
    operationTimeoutMs: 10000, automaticProjectSkillLimit: 8, signal: new AbortController().signal }
  const learning = new SkillLearning(options)
  learning.registerGenerator(maintenanceGenerator); learning.registerValidator(maintenanceValidator)
  const policy = await learning.approvePolicy({ validatorId: maintenanceValidator.id, operations: ['compress'] })
  async function skill(name = 'references', body = before, adopted = true) {
    const directory = join(project, '.dsh/skills', name); await mkdir(directory, { recursive: true })
    const path = join(directory, 'SKILL.md')
    const header = `---\r\nname: ${name}\r\ndescription: Reference list\r\n---\r\n`
    await writeFile(path, header + body)
    await writeFile(join(directory, 'reference.txt'), 'Resource bytes must remain intact.\r\n')
    await writeFile(join(directory, 'other.txt'), 'Other resource.\n')
    const item = (await library.list({})).items.find(value => value.name === name)!
    if (adopted) {
      await library.adopt({ id: item.id, expectedHash: item.contentHash })
      await learning.setAutomatic({ id: item.id, expectedHash: item.contentHash, policyId: policy.id, enabled: true })
    }
    return { item, header, directory }
  }
  return { root, project, library, learning, options, policy, skill }
}

describe('complete standalone References lists', () => {
  it('retains first-reference order and blank separators while removing nonadjacent exact repeats', () => {
    expect(reduceInstructionRedundancy(before)).toBe(after)
    expect(reduceInstructionRedundancy(before.replaceAll('\n', '\r\n'))).toBe(after.replaceAll('\n', '\r\n'))
    expect(reduceInstructionRedundancy(before.trimEnd())).toBe(after.trimEnd())
    expect(mechanicalMaintenanceValid(proposal())).toBe(true)
  })
  it('retains a no-final-newline body when removal would strand a blank separator at EOF', () => {
    const source = '# References\n- [Guide](reference.txt)\n\n- [Guide](reference.txt)'
    expect(reduceInstructionRedundancy(source)).toBe(source)
    expect(reduceInstructionRedundancy(
      '# References\r\n- [Guide](reference.txt)\r\n\r\n- [Guide](reference.txt)')).toBe(
      '# References\r\n- [Guide](reference.txt)\r\n\r\n- [Guide](reference.txt)')
    expect(mechanicalMaintenanceValid(proposal(source, '# References\n- [Guide](reference.txt)\n'))).toBe(false)
  })
  it('does not normalize labels, targets, bullet markers or other unique reference bytes', () => {
    const source = '# References\n- [Guide](reference.txt)\n- [Other label](reference.txt)\n* [Guide](reference.txt)\n- [Guide](REFERENCE.txt)\n- [Guide](reference.txt)\n'
    expect(reduceInstructionRedundancy(source)).toBe(
      '# References\n- [Guide](reference.txt)\n- [Other label](reference.txt)\n* [Guide](reference.txt)\n- [Guide](REFERENCE.txt)\n')
  })
  it('keeps separate heading contexts and action multiplicity intact', () => {
    const source = before + '\n## Another context\n- [Guide](reference.txt)\n- [Guide](reference.txt)\n\n## References\n- [Guide](reference.txt)\n- [Other](other.txt)\n- [Guide](reference.txt)\n'
    expect(reduceInstructionRedundancy(source)).toBe(after
      + '\n## Another context\n- [Guide](reference.txt)\n- [Guide](reference.txt)\n\n## References\n- [Guide](reference.txt)\n- [Other](other.txt)\n')
  })
  it.each(['Explanation belongs to the previous reference.', '\nExplanation after a blank separator.',
    '  Attached explanation.', '  - Nested reference.', '- [ ] Task item.', '1. [Ordered](other.txt)',
    '- Run `check`.', '```md\n- [Guide](reference.txt)\n```', '~~~md\n- [Guide](reference.txt)\n~~~',
    '- [Guide][reference]', '<!-- Context -->'])('retains the complete list when it contains %s', (tail) => {
    const source = '# References\n- [Guide](reference.txt)\n- [Guide](reference.txt)\n- [Other](other.txt)\n' + tail + '\n'
    expect(reduceInstructionRedundancy(source)).toBe(source)
    expect(mechanicalMaintenanceValid(proposal(source, source.replace(
      '- [Guide](reference.txt)\n- [Guide](reference.txt)', '- [Guide](reference.txt)')))).toBe(false)
  })
  it('does not rewrite a References heading or links inside fenced code', () => {
    const source = '```md\n' + before + '```\n\n# REFERENCES\n- [Guide](reference.txt)\n- [Guide](reference.txt)\n'
    expect(reduceInstructionRedundancy(source)).toBe(source)
  })
  it('retains a list containing unmatched link-label brackets as uncertain text', () => {
    const source = '# References\n- [Outer [Guide](reference.txt)\n- [Outer [Guide](reference.txt)\n'
    expect(reduceInstructionRedundancy(source)).toBe(source)
    expect(mechanicalMaintenanceValid(proposal(source, '# References\n- [Outer [Guide](reference.txt)\n'))).toBe(false)
  })
  it('retains a References list hidden inside a multiline HTML comment', () => {
    const source = '<!--\n# References\n- [Guide](reference.txt)\n- [Guide](reference.txt)\n## Hidden context\n-->\n'
    expect(reduceInstructionRedundancy(source)).toBe(source)
    expect(mechanicalMaintenanceValid(proposal(source, source.replace(
      '- [Guide](reference.txt)\n- [Guide](reference.txt)', '- [Guide](reference.txt)')))).toBe(false)
  })
  it('independently rejects order, target and separator changes alongside permitted reduction', () => {
    expect(mechanicalMaintenanceValid(proposal(before, '# References\n- [Other](other.txt)\n\n- [Guide](reference.txt)\n'))).toBe(false)
    expect(mechanicalMaintenanceValid(proposal(before, after.replace('other.txt', 'different.txt')))).toBe(false)
    expect(mechanicalMaintenanceValid(proposal(before, after.replace('\n\n', '\n')))).toBe(false)
  })
  it('issues a complete-proposal receipt only for the exact independently checked result', async () => {
    const checked = await maintenanceValidator.validate(proposal(), new AbortController().signal)
    expect(checked.constraintsPreserved).toBe(true)
    expect(checked.receipt).toEqual({ scope: 'instruction-redundancy-v1', digest: 'complete-proposal-digest',
      evidenceIds: [], eventRefs: [], sourceHashes: ['source-hash'], resourceHashes: ['resource-hash'] })
    const refused = await maintenanceValidator.validate(proposal(before, after + 'New action.\n'), new AbortController().signal)
    expect(refused.constraintsPreserved).toBe(false); expect(refused.receipt).toBeUndefined()
    const controller = new AbortController(); controller.abort(new Error('cancelled'))
    await expect(maintenanceValidator.validate(proposal(), controller.signal)).rejects.toThrow('cancelled')
  })
})

describe('managed reference-list maintenance', () => {
  it('applies the exact independently checked list reduction and rolls back source and resource bytes', async () => {
    const f = await fixture(); const { item, header, directory } = await f.skill()
    const pending = await f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [item.id],
      evidenceIds: [], generatorId: maintenanceGenerator.id })
    expect(pending.changes).toHaveLength(1); expect(pending.changes[0]!.after).toBe(after)
    await f.learning.validate({ proposalId: pending.id, validatorId: maintenanceValidator.id })
    await f.learning.apply({ proposalId: pending.id, mode: 'automatic' })
    expect(await readFile(item.path, 'utf8')).toBe(header + after)
    expect(await readFile(join(directory, 'reference.txt'), 'utf8')).toBe('Resource bytes must remain intact.\r\n')
    expect(await readFile(join(directory, 'other.txt'), 'utf8')).toBe('Other resource.\n')
    const detail = await f.library.detail({ id: item.id })
    await f.library.rollback({ id: item.id, expectedHash: detail.item.contentHash, revisionId: detail.revisions[0]!.id })
    expect(await readFile(item.path, 'utf8')).toBe(header + before)
    expect((await f.library.detail({ id: item.id })).revisions).toHaveLength(2)
  })
  it('refuses an unadopted list and preserves a hand edit after independent validation', async () => {
    const f = await fixture(); const protectedSource = await f.skill('user-owned', before, false)
    await expect(f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [protectedSource.item.id],
      evidenceIds: [], generatorId: maintenanceGenerator.id })).rejects.toThrow(/adopt|protected/)
    expect(await readFile(protectedSource.item.path, 'utf8')).toBe(protectedSource.header + before)
    const { item, header } = await f.skill()
    const pending = await f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [item.id],
      evidenceIds: [], generatorId: maintenanceGenerator.id })
    expect(pending.changes).toHaveLength(1)
    await f.learning.validate({ proposalId: pending.id, validatorId: maintenanceValidator.id })
    const manual = header + before + '\nManual instruction stays.\n'; await writeFile(item.path, manual)
    await expect(f.learning.apply({ proposalId: pending.id, mode: 'automatic' })).rejects.toThrow(/protected|changed|snapshot/)
    expect(await readFile(item.path, 'utf8')).toBe(manual)
    expect((await f.library.detail({ id: item.id })).revisions).toHaveLength(0)
  })
  it('bounds list reduction to one operation and refuses admission after the inherited deadline', async () => {
    const f = await fixture(); const first = await f.skill('a-first'); const second = await f.skill('z-second')
    const limited = new SkillLearning({ ...f.options, maintenanceMaxOperations: 1 })
    limited.registerGenerator(maintenanceGenerator); limited.registerValidator(maintenanceValidator)
    expect(await limited.cleanup({ projectId: 'p', force: true })).toHaveLength(1)
    expect(await readFile(first.item.path, 'utf8')).toBe(first.header + after)
    expect(await readFile(second.item.path, 'utf8')).toBe(second.header + before)
    const pending = await limited.propose({ projectId: 'p', operation: 'compress', targetIds: [second.item.id],
      evidenceIds: [], generatorId: maintenanceGenerator.id })
    expect(pending.changes).toHaveLength(1)
    await limited.validate({ proposalId: pending.id, validatorId: maintenanceValidator.id })
    await expect(limited.apply({ proposalId: pending.id, mode: 'automatic' }, Date.now() - 1)).rejects.toThrow(/time budget/)
    expect(await readFile(second.item.path, 'utf8')).toBe(second.header + before)
    expect((await f.library.detail({ id: second.item.id })).revisions).toHaveLength(0)
  })
  it('refuses a cancelled owner before automatic list mutation', async () => {
    const f = await fixture(); const { item, header } = await f.skill()
    const pending = await f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [item.id],
      evidenceIds: [], generatorId: maintenanceGenerator.id })
    expect(pending.changes).toHaveLength(1)
    await f.learning.validate({ proposalId: pending.id, validatorId: maintenanceValidator.id })
    await f.learning.dispose()
    expect(() => f.learning.apply({ proposalId: pending.id, mode: 'automatic' })).toThrow(/disposed|abort/)
    expect(await readFile(item.path, 'utf8')).toBe(header + before)
    expect((await f.library.detail({ id: item.id })).revisions).toHaveLength(0)
  })
})
