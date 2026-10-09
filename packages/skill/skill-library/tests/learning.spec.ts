import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { SkillLibrary } from '../src/library.ts'
import { SkillLearning, type SkillLearningStore } from '../src/learning.ts'
import type { SkillLibraryRecord } from '../src/record.ts'
import type { SkillLibraryId, SkillLearningGenerator, SkillLearningEvidence, SkillLearningProposal, SkillLearningPolicy, SkillLearningOptIn } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
function memory<K extends string, V>(): SkillLearningStore<K, V> {
  const rows = new Map<K, V>()
  return {
    get: id => rows.get(id),
    entries: () => rows.entries(),
    put: async (id, value) => { rows.set(id, structuredClone(value)) },
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-learning-')); roots.push(root)
  const project = join(root, 'project'); await mkdir(join(project, '.git'), { recursive: true })
  const projects = [{ id: 'p', title: 'Project', path: project }]
  const library = new SkillLibrary({ provider: new FileSystemSkillProvider(new Context(), { invalidate() {}, signal: new AbortController().signal }, { dshHome: join(root, 'home'), agentsHome: join(root, 'agents'), watch: false }), store: memory<SkillLibraryId, SkillLibraryRecord>(), projects: () => projects, historyDirectory: join(root, 'history'), bodyBudgetBytes: 2000, retrievalLimit: 4, proposalLimit: 20 })
  const options = { library, evidence: memory<SkillLearningEvidence['id'], SkillLearningEvidence>(), proposals: memory<SkillLearningProposal['id'], SkillLearningProposal>(), policies: memory<SkillLearningPolicy['id'], SkillLearningPolicy>(), optIns: memory<SkillLibraryId, SkillLearningOptIn>(), bodyBudgetBytes: 2000, maxInputBytes: 20000, maxSources: 4, maxEvidence: 4, maxResourceFiles: 30, maxResourceBytes: 20000, signal: new AbortController().signal }
  const learning = new SkillLearning(options)
  const evidence = await learning.recordEvidence({ projectId: 'p', sessionId: 's', task: 'Deploy and verify the application', completed: true, substantial: true, eventRefs: ['s:10', 's:20'], observations: ['Repeated deployment steps and a verification command were observed.'], checks: [] })
  async function skill(name = 'deploy', content = 'You MUST request deployment approval.\n\nTake the lengthy preparation steps and finish the deployment process.\n\n[Checklist](reference.txt)') {
    const dir = join(project, '.dsh/skills', name); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Deploy application\n---\n${content}\n`); await writeFile(join(dir, 'reference.txt'), 'Keep resource exactly.')
    return (await library.list({})).items.find(item => item.name === name)!
  }
  const generator = (id: SkillLibraryId, content: string): SkillLearningGenerator => ({ id: 'mock-generator', generate: async () => ({ drafts: [{ kind: 'compress', id, name: 'deploy', description: 'Deploy application', content }], uncertainty: ['Semantic equivalence needs review.'] }) })
  return { root, project, projects, library, learning, options, evidence, skill, generator }
}

describe('evidence-backed skill proposals', () => {
  it('does not turn completion into verification or allow trivial task evidence', async () => {
    const f = await fixture(); const item = await f.skill(); await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
    f.learning.registerGenerator(f.generator(item.id, 'You MUST request deployment approval.\n\nDeploy.\n\n[Checklist](reference.txt)'))
    const trivial = await f.learning.recordEvidence({ ...f.evidence, eventRefs: ['s:22'], substantial: false, checks: [] })
    await expect(f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [item.id], evidenceIds: [trivial.id] })).rejects.toThrow(/substantial/)
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [item.id], evidenceIds: [f.evidence.id] })
    expect(proposal.uncertainty.join(' ')).toMatch(/unverified/i)
    expect(proposal.evidence[0]!.checks).toHaveLength(0)
  })
  it('protects existing manual files even when a generator selects them', async () => {
    const f = await fixture(); const item = await f.skill()
    f.learning.registerGenerator(f.generator(item.id, 'Short instructions.'))
    await expect(f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [item.id], evidenceIds: [f.evidence.id] })).rejects.toThrow(/adopt|protected/)
    expect((await f.library.detail({ id: item.id })).content).toContain('lengthy preparation')
  })
  it('stores complete semantic diffs durably and applies a reviewed rewrite with rollback', async () => {
    const f = await fixture(); const item = await f.skill(); await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
    const after = 'You MUST request deployment approval.\n\nPrepare and deploy the application.\n\n[Checklist](reference.txt)'
    f.learning.registerGenerator(f.generator(item.id, after))
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [item.id], evidenceIds: [f.evidence.id] })
    const restarted = new SkillLearning(f.options)
    expect((await restarted.detail({ proposalId: proposal.id })).changes[0]!.after).toBe(after)
    expect(restarted.list({})[0]!.afterBytes).toBeLessThan(restarted.list({})[0]!.beforeBytes)
    await restarted.apply({ proposalId: proposal.id, mode: 'reviewed' })
    const detail = await f.library.detail({ id: item.id }); expect(detail.content).toBe(after); expect(detail.revisions[0]!.reason).toBe('learning')
    await f.library.rollback({ id: item.id, expectedHash: detail.item.contentHash, revisionId: detail.revisions[0]!.id })
    expect((await f.library.detail({ id: item.id })).content).toBe(proposal.changes[0]!.before)
  })
  it('rejects dropped permission constraints and resources independently of validators', async () => {
    const f = await fixture(); const item = await f.skill(); await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
    f.learning.registerGenerator(f.generator(item.id, 'Deploy application.'))
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [item.id], evidenceIds: [f.evidence.id] })
    await expect(f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })).rejects.toThrow(/constraint|reference/)
    const dispose = f.learning.registerGenerator({ id: 'unused', generate: async () => ({ drafts: [], uncertainty: [] }) }); dispose()
    await writeFile(join(f.project, '.dsh/skills/deploy/reference.txt'), 'External resource edit')
    await expect(f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })).rejects.toThrow(/resource|constraint/)
  })
  it('checks update-before-create metadata and chooses project-local creation paths', async () => {
    const f = await fixture(); await f.skill()
    f.learning.registerGenerator({ id: 'create', generate: async () => ({ drafts: [{ kind: 'create', name: 'deploy', description: 'Deploy application', content: 'Deploy.' }], uncertainty: [] }) })
    await expect(f.learning.propose({ projectId: 'p', operation: 'learn', evidenceIds: [f.evidence.id] })).rejects.toThrow(/existing|update/)
    const fresh = await fixture(); fresh.learning.registerGenerator({ id: 'create', generate: async () => ({ drafts: [{ kind: 'create', name: 'verify-release', description: 'Verify a completed release', content: 'Check the release tests and resources.' }], uncertainty: [] }) })
    const proposal = await fresh.learning.propose({ projectId: 'p', operation: 'learn', evidenceIds: [fresh.evidence.id] })
    expect(proposal.changes[0]!.path).toBe(join(fresh.project, '.dsh/skills/verify-release/SKILL.md'))
    await fresh.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })
    const created = (await fresh.library.list({})).items[0]!; expect(created.ownership).toBe('y-managed'); expect(created.automaticCleanup).toBe(false)
    expect(await readFile(created.path, 'utf8')).toContain('name: verify-release')
  })
  it('requires separate policy, per-file consent, verified evidence and independent trusted validation for automation', async () => {
    const f = await fixture(); const item = await f.skill()
    await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
    await f.library.setAutomaticCleanup({ id: item.id, expectedHash: item.contentHash, enabled: true })
    f.learning.registerGenerator(f.generator(item.id, 'You MUST request deployment approval.\n\nDeploy.\n\n[Checklist](reference.txt)'))
    f.learning.registerValidator({ id: 'independent', trusted: true, validate: async proposal => ({ constraintsPreserved: true, resourcesPreserved: true, referenceImpactChecked: true, survivorEquivalent: false, findings: ['Reviewed constraints independently.'], receipt: { scope: 'full-proposal', digest: proposal.digest, evidenceIds: proposal.evidenceIds, eventRefs: ['s:20'], sourceHashes: proposal.changes.flatMap(change => [change.expectedHash, ...(change.survivorHash === undefined ? [] : [change.survivorHash])]).filter(Boolean), resourceHashes: proposal.changes.flatMap(change => [change.resourceHash, ...(change.survivorResourceHash === undefined ? [] : [change.survivorResourceHash])]) } }) })
    const evidence = await f.learning.recordEvidence({ ...f.evidence, eventRefs: ['s:10', 's:20', 's:21'], checks: [{ kind: 'test', result: 'passed', eventRef: 's:20', summary: 'Explicit verification evidence.', issuer: 'test-runner', scope: 'task-verification', inputHash: item.contentHash, outputHash: 'observed-test-result-hash' }] })
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [item.id], evidenceIds: [evidence.id] }); await f.learning.validate({ proposalId: proposal.id })
    await expect(f.learning.apply({ proposalId: proposal.id, mode: 'automatic' })).rejects.toThrow(/policy|opt/)
    const policy = await f.learning.approvePolicy({ validatorId: 'independent', operations: ['compress'] })
    await f.learning.setAutomatic({ id: item.id, expectedHash: item.contentHash, policyId: policy.id, enabled: true })
    await f.learning.apply({ proposalId: proposal.id, mode: 'automatic' })
    expect((await f.learning.detail({ proposalId: proposal.id })).state).toBe('applied')
  })
  it('rejects stale source hashes and preserves bundle files on semantic archive', async () => {
    const f = await fixture(); const item = await f.skill(); const survivor = await f.skill('survivor'); await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
    f.learning.registerGenerator({ id: 'archive', generate: async () => ({ drafts: [{ kind: 'archive', id: item.id, name: item.name, description: item.description, content: '', survivorId: survivor.id }], uncertainty: ['Equivalent behavior needs review.'] }) })
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'deduplicate', targetIds: [item.id, survivor.id], evidenceIds: [f.evidence.id] })
    await expect(f.learning.apply({ proposalId: proposal.id, mode: 'automatic' })).rejects.toThrow(/review|policy|validation/)
    await f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })
    expect((await f.library.detail({ id: item.id })).item.status).toBe('archived')
    await f.library.restore({ id: item.id }); expect(await readFile(join(f.project, '.dsh/skills/deploy/reference.txt'), 'utf8')).toBe('Keep resource exactly.')
  })
  it('rejects an archive survivor that drops an explicit related skill', async () => {
    const f = await fixture(); const original = await f.skill(); const survivor = await f.skill('survivor'); await f.skill('policy', 'Review policy.')
    await writeFile(original.path, (await readFile(original.path, 'utf8')).replace('description: Deploy application\n', 'description: Deploy application\nmetadata:\n  relatedSkills: [policy]\n'))
    const source = (await f.library.list({})).items.find(item => item.id === original.id)!
    expect(source.references.some(reference => reference.kind === 'skill' && reference.target === 'policy')).toBe(true)
    await f.library.adopt({ id: source.id, expectedHash: source.contentHash })
    f.learning.registerGenerator({ id: 'archive', generate: async () => ({ drafts: [{ kind: 'archive', id: source.id, name: source.name, description: source.description, content: '', survivorId: survivor.id }], uncertainty: [] }) })
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'deduplicate', targetIds: [source.id, survivor.id], evidenceIds: [f.evidence.id] })
    await expect(f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })).rejects.toThrow(/references/)
    expect((await f.library.detail({ id: source.id })).item.status).toBe('active')
  })
  it('rejects identical relative links that resolve outside the survivor bundle to different files', async () => {
    const f = await fixture(); const source = await f.skill('deploy', '[Policy](../../POLICY.md)')
    const shared = join(f.root, 'home/skills/survivor'); await mkdir(shared, { recursive: true })
    await writeFile(join(shared, 'SKILL.md'), '---\nname: survivor\ndescription: Deploy application\n---\n[Policy](../../POLICY.md)\n')
    await writeFile(join(shared, 'reference.txt'), 'Keep resource exactly.')
    await writeFile(join(f.project, '.dsh/POLICY.md'), 'Project policy.')
    await writeFile(join(f.root, 'home/POLICY.md'), 'Different shared policy.')
    const survivor = (await f.library.list({})).items.find(item => item.name === 'survivor')!
    await f.library.adopt({ id: source.id, expectedHash: source.contentHash })
    f.learning.registerGenerator({ id: 'archive', generate: async () => ({ drafts: [{ kind: 'archive', id: source.id, name: source.name, description: source.description, content: '', survivorId: survivor.id }], uncertainty: [] }) })
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'deduplicate', targetIds: [source.id, survivor.id], evidenceIds: [f.evidence.id] })
    await expect(f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })).rejects.toThrow(/references/)
    expect((await f.library.detail({ id: source.id })).item.status).toBe('active')
  })
  it('rejects archive cycles and unique workflow loss without independent equivalence', async () => {
    const f = await fixture(); const a = await f.skill('first', 'Unique first workflow.'); const b = await f.skill('second', 'Different second workflow.')
    await f.library.adopt({ id: a.id, expectedHash: a.contentHash }); await f.library.adopt({ id: b.id, expectedHash: b.contentHash })
    const stop = f.learning.registerGenerator({ id: 'cycles', generate: async () => ({ drafts: [{ kind: 'archive', id: a.id, name: a.name, description: a.description, content: '', survivorId: b.id }, { kind: 'archive', id: b.id, name: b.name, description: b.description, content: '', survivorId: a.id }], uncertainty: [] }) })
    await expect(f.learning.propose({ projectId: 'p', operation: 'deduplicate', targetIds: [a.id, b.id], evidenceIds: [f.evidence.id] })).rejects.toThrow(/remain active/); stop()
    f.learning.registerGenerator({ id: 'semantic', generate: async () => ({ drafts: [{ kind: 'archive', id: a.id, name: a.name, description: a.description, content: '', survivorId: b.id }], uncertainty: ['Semantic equivalence unknown.'] }) })
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'deduplicate', targetIds: [a.id, b.id], evidenceIds: [f.evidence.id] })
    expect(proposal.changes[0]!.survivorContent).toBe('Different second workflow.')
    await expect(f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })).rejects.toThrow(/equivalence/)
    f.learning.registerValidator({ id: 'review-check', trusted: false, validate: async () => ({ constraintsPreserved: true, resourcesPreserved: true, referenceImpactChecked: true, survivorEquivalent: false, findings: ['Distinct workflow remains.'] }) })
    expect((await f.learning.validate({ proposalId: proposal.id })).validation?.survivorEquivalent).toBe(false)
  })
  it('preserves longer and unclosed literal fences during reviewed semantic compression', async () => {
    for (const block of ['```sh\necho release\n````', '````markdown\n```\n\n\n\necho release\n````', '~~~sh\necho release']) {
      const f = await fixture(); const item = await f.skill('deploy', 'Lengthy explanation about completing the entire workflow.\n\n' + block); await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
      f.learning.registerGenerator(f.generator(item.id, 'Deploy.'))
      const proposal = await f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [item.id], evidenceIds: [f.evidence.id] })
      await expect(f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })).rejects.toThrow(/literal code/)
    }
  })
  it('rejects cross-project incoming references and narrower archive survivors', async () => {
    const f = await fixture(); const shared = join(f.root, 'home/skills/shared-old'); await mkdir(shared, { recursive: true }); await writeFile(join(shared, 'SKILL.md'), '---\nname: shared-old\ndescription: Shared deployment workflow\n---\nSame workflow.\n')
    const source = (await f.library.list({})).items.find(item => item.name === 'shared-old')!; const local = await f.skill('local', 'Same workflow.'); await f.library.adopt({ id: source.id, expectedHash: source.contentHash })
    let survivor = local
    f.learning.registerGenerator({ id: 'scope', generate: async () => ({ drafts: [{ kind: 'archive', id: source.id, name: source.name, description: source.description, content: '', survivorId: survivor.id }], uncertainty: [] }) })
    const narrow = await f.learning.propose({ projectId: 'p', operation: 'deduplicate', targetIds: [source.id, local.id], evidenceIds: [f.evidence.id] })
    await expect(f.learning.apply({ proposalId: narrow.id, mode: 'reviewed' })).rejects.toThrow(/scope|resource/)
    const broad = join(f.root, 'home/skills/shared-new'); await mkdir(broad, { recursive: true }); await writeFile(join(broad, 'SKILL.md'), '---\nname: shared-new\ndescription: Shared deployment workflow\n---\nSame workflow.\n')
    survivor = (await f.library.list({})).items.find(item => item.name === 'shared-new')!
    const secondProject = join(f.root, 'second'); await mkdir(join(secondProject, '.git'), { recursive: true }); f.projects.push({ id: 'other', title: 'Other', path: secondProject }); const consumer = join(secondProject, '.dsh/skills/consumer'); await mkdir(consumer, { recursive: true }); await writeFile(join(consumer, 'SKILL.md'), '---\nname: consumer\ndescription: Consume shared workflow\n---\n[Shared](' + source.path + ')\n')
    const referenced = await f.learning.propose({ projectId: 'p', operation: 'deduplicate', targetIds: [source.id, survivor.id], evidenceIds: [f.evidence.id] })
    await expect(f.learning.apply({ proposalId: referenced.id, mode: 'reviewed' })).rejects.toThrow(/incoming references/)
  })
  it('retains rejected history and refuses to resurrect it after queued validation', async () => {
    const f = await fixture(); const item = await f.skill(); await f.library.adopt({ id: item.id, expectedHash: item.contentHash }); f.learning.registerGenerator(f.generator(item.id, 'You MUST request deployment approval.\n\nDeploy.\n\n[Checklist](reference.txt)'))
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [item.id], evidenceIds: [f.evidence.id] })
    let finish: (() => void) | undefined; const wait = new Promise<void>((resolve) => { finish = resolve })
    f.learning.registerValidator({ id: 'slow', trusted: false, validate: async () => { await wait; return { constraintsPreserved: true, resourcesPreserved: true, referenceImpactChecked: true, survivorEquivalent: false, findings: [] } } })
    const validation = f.learning.validate({ proposalId: proposal.id })
    const rejection = f.learning.reject({ proposalId: proposal.id }); finish!(); await validation; await rejection
    expect((await f.learning.detail({ proposalId: proposal.id })).state).toBe('rejected'); await expect(f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })).rejects.toThrow(/rejected/)
  })
  it('reconciles a source commit when proposal publication was interrupted', async () => {
    const f = await fixture(); const item = await f.skill(); await f.library.adopt({ id: item.id, expectedHash: item.contentHash }); f.learning.registerGenerator(f.generator(item.id, 'You MUST request deployment approval.\n\nDeploy.\n\n[Checklist](reference.txt)'))
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [item.id], evidenceIds: [f.evidence.id] })
    const original = f.options.proposals.put.bind(f.options.proposals); let fail = true
    f.options.proposals.put = async (id, value) => { if (fail && value.state === 'applying' && value.appliedIds.length > 0) { fail = false; throw new Error('interrupted metadata publication') }; await original(id, value) }
    await expect(f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })).rejects.toThrow(/interrupted/)
    const restarted = new SkillLearning(f.options); expect((await restarted.apply({ proposalId: proposal.id, mode: 'reviewed' })).state).toBe('applied')
    expect((await f.library.detail({ id: item.id })).revisions).toHaveLength(1)
  })
  it('keeps neutral completion evidence immutable and rejects failed, unknown or unscoped automation checks', async () => {
    const f = await fixture(); expect((await f.learning.recordEvidence({ ...f.evidence, observations: ['Attempt to replace history.'] })).id).toBe(f.evidence.id)
    expect(f.learning.listEvidence({})[0]!.observations).not.toContain('Attempt to replace history.')
    const item = await f.skill(); await f.library.adopt({ id: item.id, expectedHash: item.contentHash }); f.learning.registerGenerator(f.generator(item.id, 'You MUST request deployment approval.\n\nDeploy.\n\n[Checklist](reference.txt)'))
    f.learning.registerValidator({ id: 'checks', trusted: true, validate: async proposal => ({ constraintsPreserved: true, resourcesPreserved: true, referenceImpactChecked: true, survivorEquivalent: false, findings: [], receipt: { scope: 'full-proposal', digest: proposal.digest, evidenceIds: proposal.evidenceIds, eventRefs: ['s:20'], sourceHashes: [item.contentHash], resourceHashes: proposal.changes.map(change => change.resourceHash) } }) })
    const policy = await f.learning.approvePolicy({ validatorId: 'checks', operations: ['compress'] }); await f.learning.setAutomatic({ id: item.id, expectedHash: item.contentHash, policyId: policy.id, enabled: true })
    for (const result of ['failed', 'unknown', 'passed'] as const) {
      const evidence = await f.learning.recordEvidence({ ...f.evidence, eventRefs: ['s:20', result], checks: [{ kind: 'test', eventRef: 's:20', summary: 'Neutral or unscoped result', result }] })
      const proposal = await f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [item.id], evidenceIds: [evidence.id] }); await f.learning.validate({ proposalId: proposal.id })
      await expect(f.learning.apply({ proposalId: proposal.id, mode: 'automatic' })).rejects.toThrow(/receipts|checks/)
    }
    await f.library.setPinned({ id: item.id, pinned: true }); expect((await f.learning.setAutomatic({ id: item.id, expectedHash: 'stale', policyId: policy.id, enabled: false })).enabled).toBe(false)
  })

  it('preserves a later manual source edit and rejects model-owned destination or trust fields', async () => {
    const f = await fixture(); const item = await f.skill(); await f.library.adopt({ id: item.id, expectedHash: item.contentHash }); const stop = f.learning.registerGenerator(f.generator(item.id, 'You MUST request deployment approval.\n\nDeploy.\n\n[Checklist](reference.txt)'))
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [item.id], evidenceIds: [f.evidence.id] }); const manual = (await readFile(item.path, 'utf8')) + '\nManual policy clarification.\n'; await writeFile(item.path, manual)
    await expect(f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })).rejects.toThrow(/changed|protected/); expect(await readFile(item.path, 'utf8')).toBe(manual); stop()
    f.learning.registerGenerator({ id: 'extra-fields', generate: async () => ({ drafts: [{ kind: 'create', name: 'new-workflow', description: 'New workflow', content: 'Review the workflow.', path: '/outside/SKILL.md', trusted: true }], uncertainty: [] }) })
    await expect(f.learning.propose({ projectId: 'p', operation: 'learn', targetIds: [], evidenceIds: [f.evidence.id] })).rejects.toThrow(/Unrecognized/)
  })
  it('rechecks resources after another source operation was queued', async () => {
    const f = await fixture(); const item = await f.skill(); await f.library.adopt({ id: item.id, expectedHash: item.contentHash }); f.learning.registerGenerator(f.generator(item.id, 'You MUST request deployment approval.\n\nDeploy.\n\n[Checklist](reference.txt)'))
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [item.id], evidenceIds: [f.evidence.id] })
    await writeFile(join(f.project, '.dsh/skills/deploy/reference.txt'), 'A new resource version.')
    await expect(f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })).rejects.toThrow(/resource changed/)
    expect((await f.library.detail({ id: item.id })).revisions).toHaveLength(0)
  })

})
