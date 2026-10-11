/** Semantic archive refusal preserves sources without traversing generated bodies. */
import fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { SkillLibrary } from '../src/library.ts'
import { SkillLearning, type SkillLearningStore } from '../src/learning.ts'
import { maintenanceGenerator, maintenanceValidator } from '../src/semantic-maintenance.ts'
import type { SkillLibraryRecord } from '../src/record.ts'
import type { SkillLibraryId, SkillLearningEvidence, SkillLearningProposal, SkillLearningPolicy,
  SkillLearningOptIn } from '../src/types.ts'

afterEach(() => { vi.restoreAllMocks() })
function memory<K extends string, V>(): SkillLearningStore<K, V> {
  const rows = new Map<K, V>()
  return { get: id => rows.get(id), entries: () => rows.entries(),
    put: async (id, value) => { rows.set(id, structuredClone(value)) } }
}
async function fixture(linkBeforePublication: boolean) {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'dsh-markdown-archive-safety-'))
  const ctx = new Context()
  const project = join(root, 'project'); await fs.mkdir(join(project, '.git'), { recursive: true })
  const store = memory<SkillLibraryId, SkillLibraryRecord>()
  const provider = new FileSystemSkillProvider(ctx, { invalidate() {}, signal: new AbortController().signal }, {
    dshHome: join(root, 'home'), agentsHome: join(root, 'agents'), watch: false,
  })
  const library = new SkillLibrary({ provider, store, projects: () => [{ id: 'p', title: 'Owned project', path: project }],
    historyDirectory: join(root, 'history'), bodyBudgetBytes: 20000, retrievalLimit: 4, proposalLimit: 20 })
  const learning = new SkillLearning({ library, evidence: memory<SkillLearningEvidence['id'], SkillLearningEvidence>(),
    proposals: memory<SkillLearningProposal['id'], SkillLearningProposal>(),
    policies: memory<SkillLearningPolicy['id'], SkillLearningPolicy>(),
    optIns: memory<SkillLibraryId, SkillLearningOptIn>(), bodyBudgetBytes: 20000,
    maxInputBytes: 200000, maxSources: 4, maxEvidence: 4, maxResourceFiles: 64, maxResourceBytes: 1000000,
    signal: new AbortController().signal, maintenanceMaxOperations: 4, operationTimeoutMs: 10000,
    automaticProjectSkillLimit: 8, maintenanceIntervalMs: 600000 })
  onTestFinished(async () => {
    try { await learning.dispose(); await library.dispose(); await ctx.fiber.dispose() }
    finally { await fs.rm(root, { recursive: true, force: true }) }
  })
  const create = async (name: string, content: string) => (await library.createLearning({ projectId: 'p',
    name, description: 'Owned fixture', content, expectedPath: join(project, '.dsh/skills', name, 'SKILL.md') }, async () => {})).item
  const survivor = await create('a-survivor', 'Keep the exact checked procedure.\n')
  const target = await create('z-target', 'Keep the exact checked procedure.\n')
  const newLink = '[Target](../z-target/SKILL.md)\n'
  const body = '# Incoming source\n\nShort introduction.\n\n## Procedure\n\n'
    + (linkBeforePublication ? newLink + '\n' : '') + 'Keep a complete source paragraph.\n\n'.repeat(120)
  const incoming = await create('incoming-source', body)
  const entryBefore = await fs.readFile(incoming.path, 'utf8')
  const generationLink = /\]\((\.y-topics\/[^)#]+)\)/.exec(entryBefore)?.[1]
  if (generationLink === undefined) throw new Error('The owned incoming source did not split')
  const topicPath = join(dirname(incoming.path), generationLink)
  const topicBefore = await fs.readFile(topicPath, 'utf8')
  const needle = 'Keep a complete source paragraph.\n\n'.repeat(10)
  if (!topicBefore.includes(needle)) throw new Error('The owned topic lacks the replacement paragraph')
  const replacement = newLink + '\n' + ' '.repeat(Buffer.byteLength(needle) - Buffer.byteLength(newLink + '\n'))
  const topicEdited = topicBefore.replace(needle, replacement)
  expect(Buffer.byteLength(topicEdited)).toBe(Buffer.byteLength(topicBefore))
  if (!linkBeforePublication) await fs.writeFile(topicPath, topicEdited)
  learning.registerGenerator(maintenanceGenerator); learning.registerValidator(maintenanceValidator)
  const policy = await learning.approvePolicy({ validatorId: maintenanceValidator.id, operations: ['archive'] })
  await learning.setAutomatic({ id: target.id, expectedHash: target.contentHash, policyId: policy.id, enabled: true })
  return { library, learning, store, survivor, target, incoming, entryBefore, topicPath, topicBefore, topicEdited, newLink }
}

describe('generated incoming reference cache and semantic archive', () => {
  it('refuses the same archive when the incoming link belongs to the unchanged canonical receipt', async () => {
    const f = await fixture(true)
    const inventory = await f.library.list({})
    expect(inventory.items.find(item => item.id === f.incoming.id)?.references.some(ref => ref.resolvedId === f.target.id)).toBe(true)
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'deduplicate',
      targetIds: [f.survivor.id, f.target.id], evidenceIds: [], generatorId: maintenanceGenerator.id })
    await expect(f.learning.validate({ proposalId: proposal.id, validatorId: maintenanceValidator.id }))
      .rejects.toThrow(/incoming references/)
    expect(await fs.readFile(f.target.path, 'utf8')).toContain('Keep the exact checked procedure.')

  })

  it('must also refuse semantic archive after a hand edit adds an incoming link to a generated topic', async () => {
    const f = await fixture(false)
    const selectedFailure = await f.library.learningSource(f.incoming.id).then(() => null,
      (error: unknown) => error instanceof Error ? error.message : String(error))
    expect(selectedFailure).toMatch(/changed|manifest|generation|hash/i)
    const opened = vi.spyOn(fs, 'open')
    const inventory = await f.library.list({})
    const generatedBodiesOpened = opened.mock.calls.filter(([path]) => String(path).includes('.y-topics')).length
    opened.mockRestore()
    const cachedIncomingReference = inventory.items.find(item => item.id === f.incoming.id)
      ?.references.some(ref => ref.resolvedId === f.target.id) ?? false
    const metadataWarning = inventory.providers.some(status => status.provider === 'skill-library-markdown' && status.state === 'unavailable')
    expect(cachedIncomingReference).toBe(false)
    expect(metadataWarning).toBe(false)
    expect(generatedBodiesOpened).toBe(0)
    const archiveCall = vi.spyOn(f.library, 'archiveLearning')
    const proposal = await f.learning.propose({ projectId: 'p', operation: 'deduplicate',
      targetIds: [f.survivor.id, f.target.id], evidenceIds: [], generatorId: maintenanceGenerator.id })
    expect(proposal.changes).toHaveLength(1)
    expect(proposal.changes[0]?.kind).toBe('archive')
    expect(proposal.changes[0]?.id).toBe(f.target.id)
    const checked = await f.learning.validate({ proposalId: proposal.id, validatorId: maintenanceValidator.id })
    expect(checked.validation?.referenceImpactChecked).toBe(true)
    let applyError: string | null = null
    const operationOpen = vi.spyOn(fs, 'open')
    await f.learning.apply({ proposalId: proposal.id, mode: 'automatic' }).catch((error: unknown) => {
      applyError = error instanceof Error ? error.message : String(error); return undefined
    })
    const targetState = (await f.library.detail({ id: f.target.id })).item.status
    const targetMissing = await fs.stat(f.target.path).then(() => false, () => true)
    const incomingRootUnchanged = await fs.readFile(f.incoming.path, 'utf8') === f.entryBefore
    const handEditedTopicPreserved = await fs.readFile(f.topicPath, 'utf8') === f.topicEdited
    expect(incomingRootUnchanged).toBe(true)
    expect(handEditedTopicPreserved).toBe(true)
    expect(archiveCall).toHaveBeenCalledOnce()
    expect(operationOpen.mock.calls.filter(([path]) => String(path).includes('.y-topics'))).toEqual([])
    expect(applyError).toMatch(/generated contributors/i)
    operationOpen.mockRestore()
    expect(targetState).not.toBe('archived')
    expect(targetMissing).toBe(false)
    await f.library.archive({ id: f.incoming.id, expectedHash: f.incoming.contentHash })
    const archived = f.store.get(f.incoming.id)?.archive
    if (archived === undefined) throw new Error('Explicit recovery archive did not retain its bundle')
    expect(await fs.readFile(join(archived.archivePath, f.topicPath.slice(dirname(f.incoming.path).length + 1)), 'utf8'))
      .toBe(f.topicEdited)
  })
})
