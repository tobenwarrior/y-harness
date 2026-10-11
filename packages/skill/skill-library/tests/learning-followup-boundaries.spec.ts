/** Real inactive bundles and durable host seams; no native execution or model requests. */
import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-session/types'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { SkillLibrary } from '../src/library.ts'
import { SkillLearning, type SkillLearningOptions, type SkillLearningStore } from '../src/learning.ts'
import { maintenanceGenerator, maintenanceValidator } from '../src/semantic-maintenance.ts'
import { skillLearningDomain } from '../src/learning-record.ts'
import { nativeObservationGenerator, nativeObservationValidator } from '../src/native-observation.ts'
import type { SkillLibraryRecord } from '../src/record.ts'
import type { SkillCodexItemId, SkillCodexSessionId, SkillCodexTurnId, SkillLibraryId, SkillLearningChange,
  SkillLearningEvidence, SkillLearningGenerator, SkillLearningNativeEvidence, SkillLearningOptIn,
  SkillLearningPolicy, SkillLearningProposal, SkillNativeConnectionId } from '../src/types.ts'

const resourceRace = vi.hoisted(() => {
  const hooks: { beforeOpen?: (path: string) => Promise<void>; afterOpen?: (handle: FileHandle, path: string) => void } = {}
  return hooks
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    if (typeof args[0] === 'string') await resourceRace.beforeOpen?.(args[0])
    const handle = await fs.open(...args)
    if (typeof args[0] === 'string') resourceRace.afterOpen?.(handle, args[0])
    return handle
  } }
})

const roots: string[] = []
const owners: SkillLearning[] = []
afterEach(async () => {
  delete resourceRace.beforeOpen
  delete resourceRace.afterOpen
  vi.restoreAllMocks()
  for (const owner of owners.splice(0)) await owner.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
function memory<K extends string, V>(): SkillLearningStore<K, V> & { delete(id: K): void } {
  const rows = new Map<K, V>()
  return { get: id => rows.get(id), entries: () => rows.entries(),
    put: async (id, value) => { rows.set(id, structuredClone(value)) }, delete: (id) => { rows.delete(id) } }
}
function nativeFacts(): Extract<SkillLearningNativeEvidence, { provider: 'codex' }> {
  return { provider: 'codex', connectionId: brandString<SkillNativeConnectionId>('inactive-profile'),
    sessionId: brandString<SkillCodexSessionId>('inactive-session'), turnId: brandString<SkillCodexTurnId>('inactive-turn'),
    actions: [{ itemId: brandString<SkillCodexItemId>('read'), kind: 'read', name: 'read',
      outcome: 'reported-success', procedure: { kind: 'read', path: 'src/source.ts' },
      startedEventRef: 's:1', settledEventRef: 's:2' }, {
      itemId: brandString<SkillCodexItemId>('check'), kind: 'command', name: 'check',
      outcome: 'reported-success', procedure: { kind: 'check', command: 'pnpm run test' },
      startedEventRef: 's:3', settledEventRef: 's:4' }] }
}
async function fixture(overrides: Partial<Omit<SkillLearningOptions, 'library'>> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'learning-followup-')); roots.push(root)
  const project = join(root, 'project'); await mkdir(join(project, '.git'), { recursive: true })
  const projects = [{ id: 'p', title: 'Inactive project', path: project }]
  const library = new SkillLibrary({ provider: new FileSystemSkillProvider(new Context(), {
    invalidate() {}, signal: new AbortController().signal }, { dshHome: join(root, 'home'),
    agentsHome: join(root, 'agents'), watch: false }), store: memory<SkillLibraryId, SkillLibraryRecord>(),
  projects: () => projects, historyDirectory: join(root, 'history'), bodyBudgetBytes: 4000,
  retrievalLimit: 4, proposalLimit: 20 })
  const optIns = memory<SkillLibraryId, SkillLearningOptIn>()
  const options: SkillLearningOptions = { library, evidence: memory<SkillLearningEvidence['id'], SkillLearningEvidence>(),
    proposals: memory<SkillLearningProposal['id'], SkillLearningProposal>(), policies: memory<SkillLearningPolicy['id'], SkillLearningPolicy>(),
    optIns, bodyBudgetBytes: 4000, maxInputBytes: 30000,
    maxSources: 4, maxEvidence: 4, maxResourceFiles: 30, maxResourceBytes: 20000,
    maintenanceMaxOperations: 4, operationTimeoutMs: 10000, automaticProjectSkillLimit: 8,
    maintenanceIntervalMs: 600000, signal: new AbortController().signal, ...overrides }
  const learning = new SkillLearning(options); owners.push(learning)
  const evidence = await learning.recordEvidence({ projectId: 'p', sessionId: 's', task: 'Review release preparation',
    completed: true, substantial: true, eventRefs: ['s:10', 's:20'], observations: ['A procedure was observed.'], checks: [] })
  async function skill(name: string, content = '# References\n- [Guide](reference.txt)\n- [Guide](reference.txt)', description = `Procedure ${name}`) {
    const directory = join(project, '.dsh', 'skills', name); await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${content}\n`)
    await writeFile(join(directory, 'reference.txt'), 'Exact fixture resource.')
    const item = (await library.list({})).items.find(value => value.name === name)
    if (item === undefined) throw new Error('fixture skill unavailable')
    return item
  }
  async function nativeEvidence() {
    return learning.recordEvidence({ ...evidence, eventRefs: ['s:1', 's:2', 's:3', 's:4'], native: nativeFacts() })
  }
  async function consent(id: SkillLibraryId, operations: SkillLearningPolicy['operations'] = ['compress']) {
    const item = (await library.detail({ id })).item
    await library.adopt({ id, expectedHash: item.contentHash })
    if (!learning.status().validators.some(value => value.id === maintenanceValidator.id)) learning.registerValidator(maintenanceValidator)
    const policy = await learning.approvePolicy({ validatorId: maintenanceValidator.id, operations })
    const row = await learning.setAutomatic({ id, expectedHash: item.contentHash, policyId: policy.id, enabled: true })
    return { policy, row }
  }
  return { root, project, projects, library, learning, options, optIns, evidence, skill, nativeEvidence, consent }
}
function redigest(proposal: SkillLearningProposal, changes: readonly SkillLearningChange[]): SkillLearningProposal {
  const value = { ...proposal, changes }
  return { ...value, digest: createHash('sha256').update(JSON.stringify({ projectId: value.projectId,
    operation: value.operation, generator: value.generator, changes: value.changes,
    evidenceIds: value.evidenceIds, evidence: value.evidence })).digest('hex') }
}
const createGenerator: SkillLearningGenerator = { id: 'synthetic-create', generate: async () => ({
  drafts: [{ kind: 'create', name: 'release-check', description: 'Release verification sequence', content: 'Inspect the current release report.' }], uncertainty: [] }) }
async function creation(f: Awaited<ReturnType<typeof fixture>>) {
  f.learning.registerGenerator(createGenerator)
  return f.learning.propose({ projectId: 'p', operation: 'learn', targetIds: [], evidenceIds: [f.evidence.id] })
}

describe('learning durable and bundle followup boundaries', () => {
  it('publishes project availability through a detached status snapshot', async () => {
    const f = await fixture()
    f.learning.setAvailability('p', { state: 'unavailable', reason: 'Inactive route.' })
    const status = f.learning.status()
    expect(status.availability).toEqual([{ projectId: 'p', state: 'unavailable', reason: 'Inactive route.' }])
    f.learning.setAvailability('p', { state: 'available', reason: 'Scripted route.' })
    expect(status.availability[0]?.state).toBe('unavailable')
  })
  it.each(['missing', 'divergent'] as const)('refuses %s retained automatic evidence', async (control) => {
    const f = await fixture(); const evidence = await f.nativeEvidence()
    const supplied = control === 'missing' ? { ...evidence, id: brandString<SkillLearningEvidence['id']>('absent') }
      : { ...evidence, task: 'Caller replacement task' }
    await expect(f.learning.autoLearnEvidence(supplied)).rejects.toThrow(/unchanged retained evidence/)
    expect(f.learning.list({})).toEqual([])
    expect((await f.library.list({})).items).toEqual([])
  })
  it('retains procedure-free native facts without generating automatic instructions', async () => {
    const f = await fixture()
    const native = nativeFacts()
    const evidence = await f.learning.recordEvidence({ ...f.evidence, eventRefs: ['s:1', 's:2', 's:3', 's:4'],
      native: { ...native, actions: native.actions.map(({ procedure: _procedure, ...action }) => action) } })
    expect(await f.learning.autoLearnEvidence(evidence)).toBeUndefined()
    expect(f.learning.list({})).toEqual([])
  })
  it('normalizes a literal owner abort at direct maintenance admission', async () => {
    const controller = new AbortController(); const f = await fixture({ signal: controller.signal })
    controller.abort('external owner closed')
    await expect(f.learning.cleanup({ projectId: 'p' })).rejects.toThrow('skill learning is disposed')
    await expect(f.learning.autoLearnEvidence(f.evidence)).rejects.toThrow('skill learning is disposed')
  })
  it('refuses a changed durable proposal digest before any source creation', async () => {
    const f = await fixture(); const proposal = await creation(f)
    await f.options.proposals.put(proposal.id, { ...proposal, changes: proposal.changes.map(change => ({ ...change, after: 'Altered durable contents.' })) })
    await expect(f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })).rejects.toThrow('proposal digest changed')
    await expect(readFile(proposal.changes[0]!.path)).rejects.toThrow(/ENOENT/)
  })
  it('rechecks overlapping creation metadata after a separate file appears', async () => {
    const f = await fixture(); const proposal = await creation(f)
    const existing = await f.skill('verify-release', 'A separately authored procedure.', 'Release verification sequence')
    const before = await readFile(existing.path, 'utf8')
    await expect(f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })).rejects.toThrow(/existing skill requires update/)
    expect(await readFile(existing.path, 'utf8')).toBe(before)
    await expect(readFile(proposal.changes[0]!.path)).rejects.toThrow(/ENOENT/)
  })
  it('rejects native automatic project growth at its configured managed-file limit', async () => {
    const f = await fixture({ automaticProjectSkillLimit: 1 })
    f.learning.registerGenerator(nativeObservationGenerator); f.learning.registerValidator(nativeObservationValidator)
    const existing = await f.skill('existing-workflow', 'A distinct workflow.', 'Distinct existing instructions')
    await f.library.adopt({ id: existing.id, expectedHash: existing.contentHash })
    await f.learning.approvePolicy({ projectId: 'p', generatorId: nativeObservationGenerator.id,
      validatorId: nativeObservationValidator.id, operations: ['create'] })
    await expect(f.learning.autoLearnEvidence(await f.nativeEvidence())).rejects.toThrow(/project skill growth/)
    expect((await f.library.list({})).items).toHaveLength(1)
    expect(f.learning.status().optIns).toEqual([])
  })
  it.each(['before-id-publication', 'after-id-publication'] as const)('recovers an interrupted created file %s without duplicate writes', async (control) => {
    const f = await fixture(); const proposal = await creation(f)
    const put = f.options.proposals.put.bind(f.options.proposals); let fail = true
    vi.spyOn(f.options.proposals, 'put').mockImplementation(async (id, row) => {
      if (fail && row.state === 'applying' && row.appliedIds.length > 0) {
        fail = false
        if (control === 'after-id-publication') await put(id, row)
        throw new Error('interrupted durable publication')
      }
      await put(id, row)
    })
    await expect(f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })).rejects.toThrow(/interrupted durable publication/)
    const before = await readFile(proposal.changes[0]!.path, 'utf8')
    const restarted = new SkillLearning(f.options); owners.push(restarted)
    const applied = await restarted.apply({ proposalId: proposal.id, mode: 'reviewed' })
    expect(applied.state).toBe('applied'); expect(applied.appliedIds).toHaveLength(1)
    expect(await readFile(proposal.changes[0]!.path, 'utf8')).toBe(before)
    expect((await f.library.detail({ id: applied.appliedIds[0]! })).revisions).toEqual([])
  })
  it('recovers an applying create whose stored identity has no remaining file', async () => {
    const f = await fixture(); const proposal = await creation(f)
    await f.options.proposals.put(proposal.id, { ...proposal, state: 'applying', applicationMode: 'reviewed',
      appliedIds: [brandString<SkillLibraryId>('missing-prior-identity')] })
    const applied = await f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })
    expect(applied.state).toBe('applied'); expect(applied.appliedIds).toHaveLength(2)
    expect(await readFile(proposal.changes[0]!.path, 'utf8')).toContain('Inspect the current release report.')
  })
  it('protects a create recovery destination whose parent became a regular file', async () => {
    const f = await fixture(); const proposal = await creation(f)
    await mkdir(join(f.project, '.dsh'), { recursive: true }); await writeFile(join(f.project, '.dsh', 'skills'), 'Preserve this file.')
    await f.options.proposals.put(proposal.id, { ...proposal, state: 'applying', appliedIds: [brandString<SkillLibraryId>('previous')] })
    await expect(f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })).rejects.toThrow(/ENOTDIR/)
    expect(await readFile(join(f.project, '.dsh', 'skills'), 'utf8')).toBe('Preserve this file.')
  })
  it('preserves trailing indented code as an exact reviewed compression constraint', async () => {
    const f = await fixture(); const item = await f.skill('literal', 'Long narrative preparation.\n\n    echo preserved\n    pnpm test')
    await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
    f.learning.registerGenerator({ id: 'compress-script', generate: async () => ({ drafts: [{ kind: 'compress',
      id: item.id, name: item.name, description: item.description, content: 'Brief.\n\n    echo preserved\n    pnpm test' }], uncertainty: [] }) })
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [item.id], evidenceIds: [f.evidence.id] })
    expect(proposal.changes[0]?.constraints).toContain('    echo preserved\n    pnpm test')
    const applied = await f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })
    expect(applied.state).toBe('applied')
    expect((await f.library.learningSource(item.id)).content).toContain('    echo preserved\n    pnpm test')
  })
  it('refuses removal of a resource reference even when no permission constraint was removed', async () => {
    const f = await fixture(); const item = await f.skill('references', 'Lengthy descriptive preparation instructions.\n\n[Guide](reference.txt)')
    await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
    f.learning.registerGenerator({ id: 'omit-reference', generate: async () => ({ drafts: [{ kind: 'compress',
      id: item.id, name: item.name, description: item.description, content: 'Brief preparation.' }], uncertainty: [] }) })
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [item.id], evidenceIds: [f.evidence.id] })
    const before = await readFile(item.path, 'utf8')
    await expect(f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })).rejects.toThrow(/explicit resource reference was removed/)
    expect(await readFile(item.path, 'utf8')).toBe(before)
  })
  it.each(['entries', 'symlink'] as const)('rejects a protected bundle %s before provider admission', async (control) => {
    const f = await fixture({ maxResourceFiles: 2 }); const item = await f.skill('resources')
    await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
    if (control === 'entries') for (let index = 0; index < 9; index++) await mkdir(join(dirname(item.path), `empty-${index}`))
    else await symlink(join(dirname(item.path), 'reference.txt'), join(dirname(item.path), 'linked.txt'))
    const generate = vi.fn(maintenanceGenerator.generate.bind(maintenanceGenerator))
    f.learning.registerGenerator({ ...maintenanceGenerator, generate })
    await expect(f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [item.id],
      evidenceIds: [], generatorId: maintenanceGenerator.id })).rejects.toThrow(control === 'entries' ? /bundle entries exceed/ : /linked bundle resources/)
    expect(generate).not.toHaveBeenCalled(); expect(f.learning.list({})).toEqual([])
  })
  it('refuses a durable archive whose survivor identity was lost without writing either bundle', async () => {
    const f = await fixture(); const survivor = await f.skill('a-survivor'); const target = await f.skill('z-target')
    await f.library.adopt({ id: target.id, expectedHash: target.contentHash }); f.learning.registerGenerator(maintenanceGenerator)
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'deduplicate', targetIds: [survivor.id, target.id], evidenceIds: [], generatorId: maintenanceGenerator.id })
    await f.options.proposals.put(proposal.id, redigest(proposal, proposal.changes.map(({ survivorId: _survivorId, ...change }) => change)))
    const before = await readFile(target.path, 'utf8')
    await expect(f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })).rejects.toThrow(/archive survivor is missing/)
    expect(await readFile(target.path, 'utf8')).toBe(before)
  })
  it('refuses a changed survivor invocation before any archive write', async () => {
    const f = await fixture(); const survivor = await f.skill('a-survivor'); const target = await f.skill('z-target')
    await f.library.adopt({ id: target.id, expectedHash: target.contentHash }); f.learning.registerGenerator(maintenanceGenerator)
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'deduplicate', targetIds: [survivor.id, target.id], evidenceIds: [], generatorId: maintenanceGenerator.id })
    const raw = await readFile(survivor.path, 'utf8')
    await writeFile(survivor.path, raw.replace('---\n# References', 'user-invocable: false\n---\n# References'))
    await expect(f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })).rejects.toThrow(/survivor changed or is unavailable/)
    expect((await f.library.detail({ id: target.id })).item.status).toBe('active')
  })
  it('refuses an inherited deadline before calling its provider', async () => {
    const f = await fixture(); const generate = vi.fn(createGenerator.generate.bind(createGenerator))
    f.learning.registerGenerator({ ...createGenerator, generate })
    await expect(f.learning.propose({ projectId: 'p', operation: 'learn', targetIds: [],
      evidenceIds: [f.evidence.id] }, Date.now() - 1)).rejects.toThrow(/time budget/)
    expect(generate).not.toHaveBeenCalled(); expect(f.learning.list({})).toEqual([])
  })
  it('rejects a provider result when wall time passes the inherited deadline before its timer fires', async () => {
    const f = await fixture(); let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now)
    f.learning.registerGenerator({ ...createGenerator, generate: async (input, signal) => {
      const value = await createGenerator.generate(input, signal); now += 10001; return value
    } })
    await expect(f.learning.propose({ projectId: 'p', operation: 'learn', targetIds: [],
      evidenceIds: [f.evidence.id] })).rejects.toThrow(/time budget/)
    expect(f.learning.list({})).toEqual([]); expect((await f.library.list({})).items).toEqual([])
  })
  it('expires native policy execution after proposal publication without creating a source', async () => {
    const f = await fixture(); f.learning.registerGenerator(nativeObservationGenerator)
    f.learning.registerValidator(nativeObservationValidator)
    await f.learning.approvePolicy({ projectId: 'p', generatorId: nativeObservationGenerator.id,
      validatorId: nativeObservationValidator.id, operations: ['create'] })
    const evidence = await f.nativeEvidence(); let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now)
    const put = f.options.proposals.put.bind(f.options.proposals)
    vi.spyOn(f.options.proposals, 'put').mockImplementation(async (id, value) => { await put(id, value); now += 10001 })
    await expect(f.learning.autoLearnEvidence(evidence)).rejects.toThrow(/native automatic learning exceeded/)
    expect(f.learning.list({})).toHaveLength(1); expect(f.learning.list({ projectId: 'unrelated' })).toEqual([]); expect((await f.library.list({})).items).toEqual([])
  })
  it.each(['consent', 'project-policy'] as const)('rechecks later cleanup %s after an earlier bundle awaits', async (control) => {
    const f = await fixture(); f.learning.registerGenerator(maintenanceGenerator); f.learning.registerValidator(maintenanceValidator)
    const first = await f.skill('a-first'); const later = await f.skill('z-later')
    await f.consent(first.id); const laterConsent = await f.consent(later.id)
    const source = f.library.learningSource.bind(f.library); let changed = false
    vi.spyOn(f.library, 'learningSource').mockImplementation(async (id) => {
      const value = await source(id)
      if (!changed && id === first.id) {
        changed = true
        if (control === 'consent') await f.options.optIns.put(later.id, { ...laterConsent.row, enabled: false })
        else await f.options.policies.put(laterConsent.policy.id, { ...laterConsent.policy, projectId: 'removed-project' })
      }
      return value
    })
    const results = await f.learning.cleanup({ projectId: 'p', force: true })
    expect(results).toHaveLength(1); expect(results[0]?.changes[0]?.id).toBe(first.id)
    expect((await f.library.detail({ id: later.id })).revisions).toEqual([])
  })
  it('stops duplicate-survivor admission if consent is revoked while the source is inspected', async () => {
    const f = await fixture(); f.learning.registerGenerator(maintenanceGenerator); f.learning.registerValidator(maintenanceValidator)
    await f.skill('a-survivor'); const target = await f.skill('z-target'); const consent = await f.consent(target.id, ['archive'])
    const source = f.library.learningSource.bind(f.library); let changed = false
    vi.spyOn(f.library, 'learningSource').mockImplementation(async (id) => {
      const value = await source(id)
      if (!changed && id === target.id) { changed = true; await f.options.optIns.put(target.id, { ...consent.row, enabled: false }) }
      return value
    })
    expect(await f.learning.cleanup({ projectId: 'p', ids: [target.id], force: true })).toEqual([])
    expect(f.learning.list({})).toEqual([]); expect((await f.library.detail({ id: target.id })).item.status).toBe('active')
  })
  it('does not propose from a stale cleanup snapshot after another managed writer already reduced it', async () => {
    const f = await fixture(); f.learning.registerGenerator(maintenanceGenerator); f.learning.registerValidator(maintenanceValidator)
    const target = await f.skill('target'); await f.consent(target.id)
    const source = f.library.learningSource.bind(f.library); let changed = false
    vi.spyOn(f.library, 'learningSource').mockImplementation(async (id) => {
      const value = await source(id)
      if (!changed && id === target.id) { changed = true; await f.library.reviseLearning({ id,
        expectedHash: value.item.contentHash, content: '# References\n- [Guide](reference.txt)\n' }, async () => {}) }
      return value
    })
    expect(await f.learning.cleanup({ projectId: 'p', ids: [target.id], force: true })).toEqual([])
    expect(f.learning.list({})).toEqual([]); expect((await f.library.detail({ id: target.id })).revisions).toHaveLength(1)
  })
  it.each(['inventory', 'survivor', 'survivor-read', 'validation'] as const)('stops maintenance at its inherited %s deadline', async (phase) => {
    const f = await fixture(); f.learning.registerGenerator(maintenanceGenerator); f.learning.registerValidator(maintenanceValidator)
    const survivor = await f.skill('a-survivor', phase === 'survivor-read' ? 'Different procedure.' : '# References\n- [Guide](reference.txt)')
    const target = await f.skill('z-target'); await f.consent(target.id, phase.startsWith('survivor') ? ['archive'] : ['compress'])
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now)
    if (phase === 'inventory') {
      const list = f.library.list.bind(f.library); let once = true
      vi.spyOn(f.library, 'list').mockImplementation(async (request) => { const value = await list(request); if (once) { once = false; now += 10001 }; return value })
    } else if (phase === 'survivor') {
      const put = f.options.optIns.put.bind(f.options.optIns)
      vi.spyOn(f.options.optIns, 'put').mockImplementation(async (id, row) => { await put(id, row); if (row.lastMaintenanceSurvivorId !== undefined) now += 10001 })
    } else if (phase === 'survivor-read') {
      const source = f.library.learningSource.bind(f.library)
      vi.spyOn(f.library, 'learningSource').mockImplementation(async (id) => { const value = await source(id); if (id === survivor.id) now += 10001; return value })
    } else {
      const put = f.options.proposals.put.bind(f.options.proposals)
      vi.spyOn(f.options.proposals, 'put').mockImplementation(async (id, row) => { await put(id, row); if (row.state === 'validated') now += 10001 })
    }
    expect(await f.learning.cleanup({ projectId: 'p', ids: [target.id], force: true })).toEqual([])
    expect((await f.library.detail({ id: target.id })).revisions).toEqual([])
  })
  it('preserves a later manual edit and keeps automatic consent on the last authorized hash', async () => {
    const f = await fixture(); f.learning.registerGenerator(maintenanceGenerator); f.learning.registerValidator(maintenanceValidator)
    const target = await f.skill('target'); const consent = await f.consent(target.id)
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [target.id], evidenceIds: [], generatorId: maintenanceGenerator.id })
    await f.learning.validate({ proposalId: proposal.id, validatorId: maintenanceValidator.id })
    const revise = f.library.reviseLearning.bind(f.library)
    vi.spyOn(f.library, 'reviseLearning').mockImplementation(async (request, verify) => {
      const result = await revise(request, verify); await writeFile(target.path, '---\nname: target\ndescription: Procedure target\n---\nLater manual content.\n'); return result
    })
    expect((await f.learning.apply({ proposalId: proposal.id, mode: 'automatic' })).state).toBe('applied')
    expect(await readFile(target.path, 'utf8')).toContain('Later manual content.')
    expect(f.options.optIns.get(target.id)?.contentHash).toBe(consent.row.contentHash)
  })
  it('does not infer a created identity when a concurrent editor invalidated its metadata', async () => {
    const f = await fixture(); const proposal = await creation(f)
    const create = f.library.createLearning.bind(f.library)
    vi.spyOn(f.library, 'createLearning').mockImplementation(async (request, verify) => {
      const result = await create(request, verify); await writeFile(result.item.path, 'Unregistered manual replacement.'); return result
    })
    expect((await f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })).state).toBe('applied')
    expect(await readFile(proposal.changes[0]!.path, 'utf8')).toBe('Unregistered manual replacement.')
    expect(f.learning.status().optIns).toEqual([])
  })
  it.each(['inode', 'read-budget'] as const)('refuses a resource %s race between stat and open', async (control) => {
    const f = await fixture({ maxResourceBytes: 25 }); const item = await f.skill('resource-race')
    await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
    let changed = false
    resourceRace.beforeOpen = async (path) => {
      if (changed || path !== join(dirname(item.path), 'reference.txt')) return
      changed = true
      if (control === 'inode') { await rename(path, path + '.old'); await writeFile(path, 'Replacement inode.') }
      else await appendFile(path, 'Additional bytes beyond budget.')
    }
    f.learning.registerGenerator(maintenanceGenerator)
    await expect(f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [item.id],
      evidenceIds: [], generatorId: maintenanceGenerator.id })).rejects.toThrow(control === 'inode' ? /resource changed during inspection/ : /resources exceed/)
    expect(f.learning.list({})).toEqual([]); expect((await f.library.detail({ id: item.id })).revisions).toEqual([])
  })
  it('preserves Claude send identity on exact replay and rejects divergent action wire rows', async () => {
    const f = await fixture()
    const wire = { ...f.evidence, id: 'wire-claude', eventRefs: ['s:1', 's:2'], native: { provider: 'claude-code',
      connectionId: 'inactive-profile', sessionId: 'inactive-claude', sendId: 'inactive-send', actions: [{
        itemId: 'tool-use', kind: 'read', name: 'Read', outcome: 'reported-success',
        sourceMessageId: 'source-message', resultMessageId: 'result-message',
        startedEventRef: 's:1', settledEventRef: 's:2', procedure: { kind: 'read', path: 'src/fixture.ts' } }] } }
    const parsed = skillLearningDomain.tables.evidence.valueSchema.parse(wire)
    const first = await f.learning.recordEvidence(parsed)
    expect(await f.learning.recordEvidence(parsed)).toEqual(first)
    const divergent = skillLearningDomain.tables.evidence.valueSchema.parse({ ...wire,
      native: { ...wire.native, actions: wire.native.actions.map(action => ({ ...action, resultMessageId: 'different-result' })) } })
    await expect(f.learning.recordEvidence(divergent)).rejects.toThrow(/divergent native evidence replay/)
    expect(f.learning.listEvidence({ projectId: 'unrelated' })).toEqual([])
    expect(f.learning.list({ projectId: 'unrelated' })).toEqual([])
  })
  it('refuses a persisted rewrite with missing source identity at the first preflight', async () => {
    const f = await fixture(); const item = await f.skill('source'); await f.consent(item.id)
    f.learning.registerGenerator(maintenanceGenerator)
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [item.id], evidenceIds: [], generatorId: maintenanceGenerator.id })
    const wire = redigest(proposal, proposal.changes.map(({ id: _id, ...change }) => change))
    await f.options.proposals.put(proposal.id, skillLearningDomain.tables.proposals.valueSchema.parse(wire))
    await expect(f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })).rejects.toThrow(/^missing source identity$/)
    expect((await f.library.detail({ id: item.id })).revisions).toEqual([])
  })
  it('refuses a durable survivor snapshot whose retained reference list was lost', async () => {
    const f = await fixture(); const survivor = await f.skill('a-survivor'); const target = await f.skill('z-target')
    await f.consent(target.id, ['archive']); f.learning.registerGenerator(maintenanceGenerator)
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'deduplicate', targetIds: [survivor.id, target.id], evidenceIds: [], generatorId: maintenanceGenerator.id })
    const wire = redigest(proposal, proposal.changes.map(({ survivorReferences: _references, ...change }) => change))
    await f.options.proposals.put(proposal.id, skillLearningDomain.tables.proposals.valueSchema.parse(wire))
    await expect(f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })).rejects.toThrow(/survivor snapshot changed/)
    expect((await f.library.detail({ id: target.id })).item.status).toBe('active')
  })
  it('refuses semantic archive without a separately retained survivor-equivalence finding', async () => {
    const f = await fixture(); const survivor = await f.skill('a-survivor'); const target = await f.skill('z-target')
    await f.consent(target.id, ['archive']); f.learning.registerGenerator(maintenanceGenerator)
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'deduplicate', targetIds: [survivor.id, target.id], evidenceIds: [], generatorId: maintenanceGenerator.id })
    const validated = await f.learning.validate({ proposalId: proposal.id, validatorId: maintenanceValidator.id })
    if (validated.validation === undefined) throw new Error('fixture validation unavailable')
    await f.options.proposals.put(proposal.id, skillLearningDomain.tables.proposals.valueSchema.parse({ ...validated,
      validation: { ...validated.validation, survivorEquivalent: false } }))
    await expect(f.learning.apply({ proposalId: proposal.id, mode: 'automatic' })).rejects.toThrow(/reviewed survivor equivalence/)
    expect((await f.library.detail({ id: target.id })).item.status).toBe('active')
  })
  it('rejects a native-scoped receipt from a different host-registered validator', async () => {
    const f = await fixture(); const proposal = await creation(f)
    f.learning.registerValidator({ id: 'independent-synthetic', trusted: true, validate: async value => ({
      constraintsPreserved: true, resourcesPreserved: true, referenceImpactChecked: true, survivorEquivalent: true, findings: [],
      receipt: { scope: 'native-observation-v1', digest: value.digest, evidenceIds: value.evidenceIds,
        eventRefs: value.evidence[0]!.eventRefs, sourceHashes: [], resourceHashes: value.changes.map(change => change.resourceHash) } }) })
    await f.learning.validate({ proposalId: proposal.id, validatorId: 'independent-synthetic' })
    await expect(f.learning.apply({ proposalId: proposal.id, mode: 'automatic' })).rejects.toThrow(/dedicated independent validator/)
    await expect(readFile(proposal.changes[0]!.path)).rejects.toThrow(/ENOENT/)
  })
  it('preserves canonical related-file targets when projected identities are absent from learning sources', async () => {
    const f = await fixture(); const related = await f.skill('related', 'Read related instructions.')
    const survivor = await f.skill('a-survivor', '[Related](../related/SKILL.md)')
    const target = await f.skill('z-target', '[Related](../related/SKILL.md)'); await f.consent(target.id, ['archive'])
    f.learning.registerGenerator(maintenanceGenerator)
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'deduplicate', targetIds: [survivor.id, target.id], evidenceIds: [], generatorId: maintenanceGenerator.id })
    expect((await f.library.list({})).items.find(item => item.id === target.id)?.references[0]?.resolvedId).toBe(related.id)
    expect((await f.library.learningSource(target.id)).item.references[0]?.resolvedId).toBeUndefined()
    expect(proposal.changes[0]?.references).toContain(`file:${related.path}`)
    expect(proposal.changes[0]?.survivorReferences).toContain(`file:${related.path}`)
  })
  it('propagates a non-missing filesystem fault during interrupted rewrite reconciliation', async () => {
    const f = await fixture(); const item = await f.skill('recover'); await f.consent(item.id)
    f.learning.registerGenerator(maintenanceGenerator)
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [item.id], evidenceIds: [], generatorId: maintenanceGenerator.id })
    await f.options.proposals.put(proposal.id, { ...proposal, state: 'applying', applicationMode: 'reviewed' })
    await rm(dirname(item.path), { recursive: true }); await writeFile(dirname(item.path), 'Parent changed to file.')
    await expect(f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })).rejects.toThrow(/ENOTDIR/)
    expect(await readFile(dirname(item.path), 'utf8')).toBe('Parent changed to file.')
  })
  it('refuses a resource that changes after bytes were read and closes its actual handle', async () => {
    const f = await fixture(); const item = await f.skill('resource-mtime'); await f.consent(item.id)
    let closeCalls = 0
    resourceRace.afterOpen = (handle, path) => {
      if (path !== join(dirname(item.path), 'reference.txt')) return
      const stat = handle.stat.bind(handle); let calls = 0
      vi.spyOn(handle, 'stat').mockImplementation(async (...args: Parameters<typeof handle.stat>) => {
        if (++calls === 2) await appendFile(path, 'Concurrent append.')
        return stat(...args)
      })
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => { closeCalls++; await close() })
    }
    f.learning.registerGenerator(maintenanceGenerator)
    await expect(f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [item.id], evidenceIds: [],
      generatorId: maintenanceGenerator.id })).rejects.toThrow(/resource changed during inspection/)
    expect(closeCalls).toBe(1); expect(f.learning.list({})).toEqual([])
  })
  it('rejects parser-admitted generic creation receipts despite verified independent evidence', async () => {
    const f = await fixture(); f.learning.registerGenerator(createGenerator)
    const evidence = await f.learning.recordEvidence({ ...f.evidence, eventRefs: ['s:31'], checks: [{
      kind: 'test', result: 'passed', eventRef: 's:31', summary: 'Synthetic independent check', issuer: 'check-owner',
      scope: 'task-verification', inputHash: 'independent-input', outputHash: 'independent-output' }] })
    const original = await f.learning.propose({ projectId: 'p', operation: 'learn', targetIds: [], evidenceIds: [evidence.id] })
    const wire = redigest(original, original.changes.map(change => ({ ...change, expectedHash: 'independent-input' })))
    await f.options.proposals.put(original.id, skillLearningDomain.tables.proposals.valueSchema.parse(wire))
    f.learning.registerValidator({ id: 'full-semantic', trusted: true, validate: async proposal => ({
      constraintsPreserved: true, resourcesPreserved: true, referenceImpactChecked: true, survivorEquivalent: false, findings: [],
      receipt: { scope: 'full-proposal', digest: proposal.digest, evidenceIds: proposal.evidenceIds, eventRefs: ['s:31'],
        sourceHashes: ['independent-input'], resourceHashes: proposal.changes.map(change => change.resourceHash) } }) })
    await f.learning.validate({ proposalId: original.id, validatorId: 'full-semantic' })
    await expect(f.learning.apply({ proposalId: original.id, mode: 'automatic' })).rejects.toThrow(/new skills require explicit project policy and native observation validation/)
    await expect(readFile(original.changes[0]!.path)).rejects.toThrow(/ENOENT/)
  })
  it('does not publish new automatic consent if project policy is revoked after the managed create commits', async () => {
    const f = await fixture(); f.learning.registerGenerator(nativeObservationGenerator)
    f.learning.registerValidator(nativeObservationValidator)
    const policy = await f.learning.approvePolicy({ projectId: 'p', generatorId: nativeObservationGenerator.id,
      validatorId: nativeObservationValidator.id, operations: ['create'] })
    const evidence = await f.nativeEvidence(); const create = f.library.createLearning.bind(f.library)
    const otherOwner = new SkillLearning(f.options); owners.push(otherOwner)
    vi.spyOn(f.library, 'createLearning').mockImplementation(async (request, verify) => {
      const result = await create(request, verify); await otherOwner.revokePolicy({ policyId: policy.id }); return result
    })
    const applied = await f.learning.autoLearnEvidence(evidence)
    expect(applied?.state).toBe('applied'); expect((await f.library.list({})).items).toHaveLength(1)
    expect(f.learning.status().optIns).toEqual([]); expect(f.options.policies.get(policy.id)?.enabled).toBe(false)
  })
  it('keeps non-Latin task evidence without inventing an automatic metadata target', async () => {
    const f = await fixture(); const evidence = await f.learning.recordEvidence({ ...f.evidence, task: '验证流程', eventRefs: ['s:45'] })
    f.learning.registerGenerator(createGenerator)
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'learn', evidenceIds: [evidence.id] })
    expect(proposal.changes[0]?.kind).toBe('create'); expect(proposal.evidence[0]?.task).toBe('验证流程')
    expect(f.learning.list({ projectId: 'different' })).toEqual([])
  })
  it('excludes maintenance consent bound to another generator without changing the file', async () => {
    const f = await fixture(); const target = await f.skill('wrong-generator'); await f.consent(target.id)
    f.learning.registerGenerator(maintenanceGenerator)
    const policy = await f.learning.approvePolicy({ validatorId: maintenanceValidator.id, generatorId: 'different-generator', operations: ['compress'] })
    await f.learning.setAutomatic({ id: target.id, expectedHash: target.contentHash, policyId: policy.id, enabled: true })
    expect(await f.learning.cleanup({ force: true })).toEqual([])
    expect((await f.library.detail({ id: target.id })).revisions).toEqual([])
  })
  it('reconciles an applying archive before its source commit and performs exactly one retirement', async () => {
    const f = await fixture(); const survivor = await f.skill('a-survivor'); const target = await f.skill('z-target')
    await f.consent(target.id, ['archive']); f.learning.registerGenerator(maintenanceGenerator)
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'deduplicate', targetIds: [survivor.id, target.id], evidenceIds: [], generatorId: maintenanceGenerator.id })
    await f.options.proposals.put(proposal.id, { ...proposal, state: 'applying', applicationMode: 'reviewed' })
    const applied = await f.learning.apply({ proposalId: proposal.id, mode: 'reviewed' })
    expect(applied.appliedIds).toEqual([target.id]); expect((await f.library.detail({ id: target.id })).item.status).toBe('archived')
  })
  it('rejects direct operation admission after disposal with the retained Error reason', async () => {
    const f = await fixture(); await f.learning.dispose()
    await expect(f.learning.cleanup({})).rejects.toThrow('skill learning is disposed')
  })
  it('normalizes a literal abort received while a provider is admitted', async () => {
    const abort = new AbortController(); const f = await fixture({ signal: abort.signal })
    f.learning.registerGenerator({ ...createGenerator, generate: async (input, signal) => {
      const value = await createGenerator.generate(input, signal); abort.abort('literal provider interruption'); return value
    } })
    await expect(f.learning.propose({ projectId: 'p', operation: 'learn', targetIds: [],
      evidenceIds: [f.evidence.id] })).rejects.toThrow('learning provider aborted')
    expect(f.learning.list({})).toEqual([])
  })
  it('does not use a consent policy from another registered project in selected cleanup', async () => {
    const f = await fixture(); const target = await f.skill('cross-project'); await f.consent(target.id)
    const other = join(f.root, 'other-project'); await mkdir(join(other, '.git'), { recursive: true })
    f.projects.push({ id: 'other', title: 'Other inactive project', path: other })
    const policy = await f.learning.approvePolicy({ projectId: 'other', validatorId: maintenanceValidator.id, operations: ['compress'] })
    await f.learning.setAutomatic({ id: target.id, expectedHash: target.contentHash, policyId: policy.id, enabled: true })
    expect(await f.learning.cleanup({ projectId: 'p', force: true })).toEqual([])
    expect((await f.library.detail({ id: target.id })).revisions).toEqual([])
  })
  it('rechecks consent inside the queued maintenance timestamp writer', async () => {
    const f = await fixture(); const target = await f.skill('queued-consent'); const consent = await f.consent(target.id)
    f.learning.registerGenerator(maintenanceGenerator)
    let release = () => {}; let entered = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const admission = new Promise<void>((resolve) => { entered = resolve })
    const put = f.options.evidence.put.bind(f.options.evidence)
    vi.spyOn(f.options.evidence, 'put').mockImplementation(async (id, value) => { entered(); await gate; await put(id, value) })
    const pending = f.learning.recordEvidence({ ...f.evidence, eventRefs: ['s:90'] }); void pending.catch(() => undefined)
    const admitted: Promise<unknown>[] = [pending]
    try {
      await Promise.race([admission, pending.then(() => { throw new Error('Fixture evidence write settled before admission.') })])
      let inventoried = () => {}
      const inventoryReady = new Promise<void>((resolve) => { inventoried = resolve })
      const list = f.library.list.bind(f.library)
      vi.spyOn(f.library, 'list').mockImplementation(async (request) => { const value = await list(request); inventoried(); return value })
      const cleanup = f.learning.cleanup({ projectId: 'p', ids: [target.id], force: true }).catch((error: unknown) => String(error))
      admitted.push(cleanup)
      await Promise.race([inventoryReady, cleanup.then(() => { throw new Error('Fixture cleanup settled before inventory admission.') })]); await setImmediate()
      await f.options.optIns.put(target.id, { ...consent.row, enabled: false })
      release(); await pending
      expect(await cleanup).toMatch(/opt-in|policy/)
      expect(f.options.optIns.get(target.id)?.lastMaintenanceAt).toBeUndefined()
      expect((await f.library.detail({ id: target.id })).revisions).toEqual([])
    } finally {
      release(); await Promise.allSettled(admitted)
    }
  })
  it('omits retained archive metadata from the exact resource manifest', async () => {
    const f = await fixture({ maxResourceBytes: 25 }); const target = await f.skill('archive-metadata'); await f.consent(target.id)
    const archive = join(dirname(target.path), '.skill-library-archive'); await mkdir(archive)
    await writeFile(join(archive, 'retained.txt'), 'Archive-only metadata '.repeat(100))
    f.learning.registerGenerator(maintenanceGenerator)
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [target.id], evidenceIds: [], generatorId: maintenanceGenerator.id })
    expect(proposal.changes[0]?.resources.map(resource => resource.path)).toEqual(['reference.txt'])
    expect(JSON.stringify(proposal)).not.toContain('Archive-only metadata')
  })
  it('refuses a later cleanup source when its durable owner deletes consent during an earlier real source await', async () => {
    const f = await fixture(); const first = await f.skill('a-first'); const later = await f.skill('z-later')
    await f.consent(first.id); await f.consent(later.id); f.learning.registerGenerator(maintenanceGenerator)
    const before = await readFile(later.path, 'utf8'); const source = f.library.learningSource.bind(f.library)
    let deleted = false
    vi.spyOn(f.library, 'learningSource').mockImplementation(async (id) => {
      const value = await source(id)
      if (!deleted && id === first.id) { deleted = true; f.optIns.delete(later.id) }
      return value
    })
    const result = await f.learning.cleanup({ projectId: 'p', force: true })
    expect(result).toHaveLength(1); expect(result[0]?.changes[0]?.id).toBe(first.id)
    expect(f.options.optIns.get(later.id)).toBeUndefined()
    expect(await readFile(later.path, 'utf8')).toBe(before)
    expect((await f.library.detail({ id: later.id })).revisions).toEqual([])
    expect(f.learning.status().optIns.some(row => row.id === later.id)).toBe(false)
  })
  it('does not recreate update consent deleted by its durable owner after the managed commit', async () => {
    const f = await fixture(); const target = await f.skill('consent-removal'); await f.consent(target.id)
    f.learning.registerGenerator(maintenanceGenerator)
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'compress', targetIds: [target.id], evidenceIds: [], generatorId: maintenanceGenerator.id })
    await f.learning.validate({ proposalId: proposal.id, validatorId: maintenanceValidator.id })
    const revise = f.library.reviseLearning.bind(f.library)
    vi.spyOn(f.library, 'reviseLearning').mockImplementation(async (request, verify) => {
      const result = await revise(request, verify); f.optIns.delete(target.id); return result
    })
    expect((await f.learning.apply({ proposalId: proposal.id, mode: 'automatic' })).state).toBe('applied')
    expect((await f.library.detail({ id: target.id })).revisions).toHaveLength(1)
    expect(f.options.optIns.get(target.id)).toBeUndefined(); expect(f.learning.status().optIns).toEqual([])
  })
})
