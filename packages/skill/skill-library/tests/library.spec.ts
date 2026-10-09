import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { SkillLibrary, type SkillLibraryStore } from '../src/library.ts'
import type { SkillLibraryId } from '../src/types.ts'
import type { SkillLibraryRecord } from '../src/record.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-library-')); roots.push(root)
  const project = join(root, 'project'); const home = join(root, 'home')
  await mkdir(join(project, '.git'), { recursive: true })
  const rows = new Map<SkillLibraryId, SkillLibraryRecord>()
  const store: SkillLibraryStore = { get: id => rows.get(id), entries: () => rows.entries(), put: async (id, row) => { rows.set(id, row) } }
  const ctx = new Context()
  const provider = new FileSystemSkillProvider(ctx, { invalidate() {}, signal: new AbortController().signal }, { dshHome: home, agentsHome: join(root, 'agents'), watch: false })
  const options = { provider, store, historyDirectory: join(home, 'skill-library-history'), projects: () => [{ id: 'p', title: 'Project', path: project }], bodyBudgetBytes: 1000, retrievalLimit: 3, proposalLimit: 20 }
  const library = new SkillLibrary(options)
  async function skill(scope: 'project' | 'shared', name: string, body = 'Do the work.') {
    const dir = join(scope === 'project' ? join(project, '.dsh/skills') : join(home, 'skills'), name)
    await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} deployment workflow\n---\n\n${body}\n`)
    return dir
  }
  return { root, home, project, rows, library, skill, options }
}

describe('file-backed skill library', () => {
  it('retains shared duplicates, project membership and unknown usage without loading bodies in results', async () => {
    const f = await fixture(); await f.skill('project', 'deploy'); await f.skill('shared', 'deploy')
    const inventory = await f.library.list({})
    expect(inventory.items).toHaveLength(2)
    expect(inventory.items.find(item => item.scope === 'project')).toMatchObject({ projectIds: ['p'], ownership: 'protected', shadowed: false, usage: { coverage: 'unknown', loadCount: 0 } })
    expect(inventory.items.find(item => item.scope === 'shared')).toMatchObject({ shadowed: true, automaticCleanup: false })
    expect(inventory.items.every(item => !('content' in item))).toBe(true)
  })
  it('requires deliberate adoption and a current hash before compression, preserving code and repeated paragraphs', async () => {
    const f = await fixture(); const dir = await f.skill('project', 'deploy', 'Step one.  \n\n\n\nRepeated.\n\nRepeated.\n\n```\nkeep  \n\n\n```')
    const item = (await f.library.list({})).items[0]!
    expect((await f.library.previewCleanup({ ids: [item.id] })).changes).toHaveLength(0)
    await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
    const proposal = await f.library.previewCleanup({ ids: [item.id] })
    expect(proposal.changes).toHaveLength(1)
    expect(proposal.changes[0]!.after).toContain('Repeated.\n\nRepeated.')
    expect(proposal.changes[0]!.after).toContain('```\nkeep  \n\n\n```')
    await writeFile(join(dir, 'SKILL.md'), 'external edit')
    await expect(f.library.applyCleanup({ proposalId: proposal.id })).rejects.toThrow(/changed/)
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toBe('external edit')
  })
  it('archives and restores an entire bundle without losing supporting resources', async () => {
    const f = await fixture(); const dir = await f.skill('project', 'deploy')
    await writeFile(join(dir, 'reference.txt'), 'precious reference')
    const item = (await f.library.list({})).items[0]!
    await f.library.archive({ id: item.id, expectedHash: item.contentHash })
    expect((await f.library.list({})).items[0]!.status).toBe('archived')
    await f.library.restore({ id: item.id })
    expect(await readFile(join(dir, 'reference.txt'), 'utf8')).toBe('precious reference')
    expect((await f.library.list({})).items[0]!.id).toBe(item.id)
  })
  it('keeps history and performs hash-checked rollback after managed cleanup', async () => {
    const f = await fixture(); const dir = await f.skill('project', 'deploy', 'Do work.  \n\n\n\nFinish.')
    const original = await readFile(join(dir, 'SKILL.md'), 'utf8')
    const item = (await f.library.list({})).items[0]!
    await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
    const preview = await f.library.previewCleanup({ ids: [item.id] }); await f.library.applyCleanup({ proposalId: preview.id })
    const detail = await f.library.detail({ id: item.id })
    expect(detail.revisions).toHaveLength(1)
    await f.library.rollback({ id: item.id, revisionId: detail.revisions[0]!.id, expectedHash: detail.item.contentHash })
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toBe(original)
  })
  it('protects symlinked files from adoption and archive', async () => {
    const f = await fixture(); const dir = await f.skill('project', 'deploy')
    const original = await readFile(join(dir, 'SKILL.md'), 'utf8')
    const outside = join(f.root, 'outside.md'); await writeFile(outside, original)
    await rm(join(dir, 'SKILL.md')); await symlink(outside, join(dir, 'SKILL.md'))
    const item = (await f.library.list({})).items[0]!
    expect(item.capabilities.adopt).toBe(false)
    await expect(f.library.archive({ id: item.id, expectedHash: item.contentHash })).rejects.toThrow(/protected/)
    expect(await readFile(outside, 'utf8')).toBe(original)
  })
  it('does not infer graph similarity and excludes irrelevant project metadata from bounded retrieval', async () => {
    const f = await fixture(); await f.skill('project', 'deploy', '[Reference](reference.txt)\n[Shared](../../../../home/skills/common/SKILL.md)')
    await f.skill('shared', 'common'); await f.skill('shared', 'unrelated')
    const inventory = await f.library.list({})
    const deploy = inventory.items.find(item => item.name === 'deploy')!
    expect(deploy.references.some(reference => reference.target.endsWith('reference.txt'))).toBe(true)
    expect(deploy.references.some(reference => reference.resolvedId !== undefined)).toBe(true)
    const result = await f.library.retrieve({ query: 'common', projectId: 'p', limit: 1 })
    expect(result).toHaveLength(1); expect(result[0]!.name).toBe('common')
  })
  it('preserves all blank lines inside longer fenced code blocks', async () => {
    const f = await fixture(); const code = '````markdown\n```\n\n\n\nkeep code\n````'
    await f.skill('project', 'fences', 'Before.\n\n\n\n' + code)
    const item = (await f.library.list({})).items[0]!
    await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
    expect((await f.library.previewCleanup({ ids: [item.id] })).changes[0]!.after).toContain(code)
  })
  it('records only uniquely matched current successful skill loads', async () => {
    const f = await fixture(); const dir = await f.skill('project', 'deploy')
    const value = { name: 'deploy', provider: 'filesystem', resourceBase: { kind: 'directory', path: dir }, content: 'Do the work.' }
    await f.library.observeToolResult('skill', true, value)
    await f.library.observeToolResult('skill', false, { ...value, content: 'stale instructions' })
    await f.library.observeToolResult('other', false, value)
    expect((await f.library.list({})).items[0]!.usage.coverage).toBe('unknown')
    await f.library.observeToolResult('skill', false, value)
    expect((await f.library.list({})).items[0]!.usage).toMatchObject({ coverage: 'recorded-loads', loadCount: 1 })
  })
  it('leaves automatic cleanup off after adoption and stops when the source changes by hand', async () => {
    const f = await fixture(); const dir = await f.skill('project', 'deploy', 'Work.\n\n\n\nDone.')
    const item = (await f.library.list({})).items[0]!
    await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
    expect((await f.library.cleanupOptedIn()).revised).toHaveLength(0)
    await f.library.setAutomaticCleanup({ id: item.id, expectedHash: item.contentHash, enabled: true })
    const text = await readFile(join(dir, 'SKILL.md'), 'utf8'); await writeFile(join(dir, 'SKILL.md'), text + '\nManual note.\n')
    expect((await f.library.list({})).items[0]!).toMatchObject({ ownership: 'protected', automaticCleanup: false })
    expect((await f.library.cleanupOptedIn()).revised).toHaveLength(0)
  })

  it('recovers revision metadata after source replacement without overwriting a later hand edit', async () => {
    const f = await fixture(); const dir = await f.skill('project', 'deploy', 'Before.\n\n\n\nDone.')
    const item = (await f.library.list({})).items[0]!
    await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
    const preview = await f.library.previewCleanup({ ids: [item.id] }); const change = preview.changes[0]!
    const backup = join(f.root, 'before.md'); await writeFile(backup, change.before)
    const { createHash } = await import('node:crypto')
    const afterHash = createHash('sha256').update(change.after).digest('hex')
    const state = f.rows.get(item.id)!
    const revisions = [...state.revisions, { id: 'revision-fixture', createdAt: new Date().toISOString(), reason: 'cleanup', beforeHash: item.contentHash, afterHash, beforeBytes: change.beforeBytes, afterBytes: change.afterBytes, backupPath: backup }]
    const pending = join(f.options.historyDirectory, 'pending-revisions'); await mkdir(pending, { recursive: true })
    await writeFile(join(pending, 'fixture.json'), JSON.stringify({ id: item.id, path: join(dir, 'SKILL.md'), expectedHash: item.contentHash, replacementHash: afterHash, record: { ...state, managedHash: afterHash, revisions } }))
    const later = change.after + '\nManual edit.\n'; await writeFile(join(dir, 'SKILL.md'), later)
    const restarted = new SkillLibrary(f.options)
    const detail = await restarted.detail({ id: item.id })
    expect(detail.revisions).toHaveLength(1)
    expect(detail.item.ownership).toBe('protected')
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toBe(later)
    expect((await restarted.list({})).providers.some(provider => provider.provider === 'skill-library-history' && provider.state === 'unavailable')).toBe(true)
  })

  it('archives a flat root SKILL.md without moving sibling skills', async () => {
    const f = await fixture(); const sibling = await f.skill('project', 'sibling')
    const path = join(f.project, '.dsh/skills/SKILL.md'); await writeFile(path, '---\nname: flat-root\ndescription: Flat instructions\n---\nKeep root file only.\n')
    const item = (await f.library.list({})).items.find(item => item.name === 'flat-root')!
    await f.library.archive({ id: item.id, expectedHash: item.contentHash })
    expect(await readFile(join(sibling, 'SKILL.md'), 'utf8')).toContain('name: sibling')
    await f.library.restore({ id: item.id })
    expect(await readFile(path, 'utf8')).toContain('Keep root file only.')
  })
  it('keeps recreated source identities separate from archives and refuses occupied restore', async () => {
    const f = await fixture(); const dir = await f.skill('project', 'deploy', 'Original body.')
    const old = (await f.library.list({})).items[0]!
    await f.library.archive({ id: old.id, expectedHash: old.contentHash })
    await f.skill('project', 'deploy', 'Replacement body.')
    const inventory = await f.library.list({}); expect(new Set(inventory.items.map(item => item.id)).size).toBe(2)
    const replacement = inventory.items.find(item => item.status === 'active')!
    expect((await f.library.detail({ id: old.id })).content).toBe('Original body.')
    expect((await f.library.detail({ id: replacement.id })).content).toBe('Replacement body.')
    await expect(f.library.restore({ id: old.id })).rejects.toThrow(/occupied/)
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toContain('Replacement body.')
  })
  it('resolves project precedence for retrieval while keeping shared candidates visible in the entire inventory', async () => {
    const f = await fixture(); await f.skill('project', 'deploy'); await f.skill('shared', 'deploy')
    const second = join(f.root, 'second'); await mkdir(join(second, '.git'), { recursive: true })
    f.options.projects = () => [{ id: 'p', title: 'Project', path: f.project }, { id: 'p2', title: 'Second', path: second }]
    expect((await f.library.list({})).items).toHaveLength(2)
    const selected = await f.library.retrieve({ projectId: 'p', query: 'deploy' })
    expect(selected).toHaveLength(1); expect(selected[0]!.scope).toBe('project')
    expect((await f.library.retrieve({ projectId: 'p2', query: 'deploy' }))[0]!.scope).toBe('shared')
  })
  it('does not turn code examples or ambiguous related names into graph edges', async () => {
    const f = await fixture(); const dir = await f.skill('project', 'deploy', '```md\n[Example](made-up.md)\n```\n[Real](reference.md)')
    const original = await readFile(join(dir, 'SKILL.md'), 'utf8'); await writeFile(join(dir, 'SKILL.md'), original.replace('---\n\n', 'metadata:\n  relatedSkills: [other]\n---\n\n'))
    await f.skill('project', 'other'); await f.skill('shared', 'other')
    const item = (await f.library.list({})).items.find(item => item.name === 'deploy')!
    expect(item.references.some(reference => reference.target.endsWith('made-up.md'))).toBe(false)
    expect(item.references.find(reference => reference.target === 'other')?.resolvedId).toBeUndefined()
  })
  it('preserves indented-code blank lines by declining automatic compression', async () => {
    const f = await fixture(); await f.skill('project', 'deploy', 'Text.\n\n\n\n        literal\n\n\n\n\t  code')
    const item = (await f.library.list({})).items[0]!
    await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
    expect((await f.library.previewCleanup({ ids: [item.id] })).changes).toHaveLength(0)
  })

  it('preserves both archived and recreated source files when management publication fails', async () => {
    const f = await fixture(); const dir = await f.skill('project', 'deploy', 'Original body.')
    const item = (await f.library.list({})).items[0]!
    const originalPut = f.options.store.put.bind(f.options.store)
    f.options.store.put = async () => { await f.skill('project', 'deploy', 'Concurrent replacement.'); throw new Error('storage failure') }
    await expect(f.library.archive({ id: item.id, expectedHash: item.contentHash })).rejects.toThrow('storage failure')
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toContain('Concurrent replacement.')
    f.options.store.put = originalPut
    const restarted = new SkillLibrary(f.options)
    const inventory = await restarted.list({})
    expect(inventory.items.find(item => item.status === 'archived')).toBeDefined()
    expect((await restarted.detail({ id: item.id })).content).toBe('Original body.')
  })
  it('reports malformed recovery documents without blocking unrelated skill inventory', async () => {
    const f = await fixture(); await f.skill('project', 'deploy')
    const directory = join(f.options.historyDirectory, 'pending-archives'); await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'broken.json'), '{')
    const inventory = await f.library.list({})
    expect(inventory.items).toHaveLength(1)
    expect(inventory.providers.some(provider => provider.provider === 'skill-library-history' && provider.state === 'unavailable')).toBe(true)
  })

  it('drains admitted mutations before disposal and rejects later source operations', async () => {
    const f = await fixture(); await f.skill('project', 'deploy')
    const item = (await f.library.list({})).items[0]!
    const entered = Promise.withResolvers<undefined>(); const release = Promise.withResolvers<undefined>()
    const put = f.options.store.put.bind(f.options.store)
    f.options.store.put = async (id, record) => { entered.resolve(undefined); await release.promise; await put(id, record) }
    const pending = f.library.setPinned({ id: item.id, pinned: true }); await entered.promise
    let disposed = false; const disposal = f.library.dispose().then(() => { disposed = true })
    await Promise.resolve(); expect(disposed).toBe(false)
    await expect(f.library.setPinned({ id: item.id, pinned: false })).rejects.toThrow(/closed/)
    release.resolve(undefined); await pending; await disposal
    expect(f.rows.get(item.id)?.pinned).toBe(true)
  })

})
