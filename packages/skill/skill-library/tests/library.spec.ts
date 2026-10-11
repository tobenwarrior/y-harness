import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SkillLibrary, type SkillLibraryStore } from '../src/library.ts'
import type { NativeSkillLibraryEntry, NativeSkillLibraryProvider, SkillLibraryId, SkillRevisionId } from '../src/types.ts'
import type { RegistryInventory } from '../src/registry-inventory.ts'
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

  it('cleans only explicitly opted-in current unpinned managed files and is idempotent', async () => {
    const f = await fixture()
    const opted = await f.skill('project', 'opted', 'Work.  \n\n\n\nDone.')
    const pinned = await f.skill('project', 'pinned', 'Pinned.  \n\n\n\nDone.')
    const unconsented = await f.skill('project', 'unconsented', 'Unconsented.  \n\n\n\nDone.')
    const protectedDir = await f.skill('project', 'protected', 'Protected.  \n\n\n\nDone.')
    const items = (await f.library.list({})).items
    for (const name of ['opted', 'pinned', 'unconsented']) {
      const item = items.find(item => item.name === name)!
      await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
      if (name !== 'unconsented') await f.library.setAutomaticCleanup({ id: item.id, expectedHash: item.contentHash, enabled: true })
      if (name === 'pinned') await f.library.setPinned({ id: item.id, pinned: true })
    }
    const preserved = await Promise.all([pinned, unconsented, protectedDir].map(dir => readFile(join(dir, 'SKILL.md'), 'utf8')))
    const original = await readFile(join(opted, 'SKILL.md'), 'utf8')
    const result = await f.library.cleanupOptedIn()
    expect(result.revised).toEqual([items.find(item => item.name === 'opted')!.id])
    expect(await readFile(join(opted, 'SKILL.md'), 'utf8')).toBe(original.replace('Work.  \n\n\n\nDone.', 'Work.  \n\n\nDone.'))
    expect(await Promise.all([pinned, unconsented, protectedDir].map(dir => readFile(join(dir, 'SKILL.md'), 'utf8')))).toEqual(preserved)
    expect((await f.library.cleanupOptedIn()).revised).toEqual([])
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
    expect((await f.library.detail({ id: old.id })).content).toBe('\nOriginal body.\n')
    expect((await f.library.detail({ id: replacement.id })).content).toBe('\nReplacement body.\n')
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
    expect((await restarted.detail({ id: item.id })).content).toBe('\nOriginal body.\n')
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

it('preserves invalid and missing-source recovery images across all journal families', async () => {
  for (const family of ['archives', 'revisions', 'creations']) {
    const f = await fixture(); const dir = await f.skill('project', 'unrelated')
    const source = await readFile(join(dir, 'SKILL.md'), 'utf8')
    const pending = join(f.options.historyDirectory, `pending-${family}`); await mkdir(pending, { recursive: true })
    const record = { retainedArchives: [], pinned: false, automaticCleanup: false, usage: { coverage: 'unknown', loadCount: 0 }, revisions: [] }
    const valid = family === 'archives' ? { id: 'recovery', originalPath: join(f.root, 'missing'), archivePath: join(f.root, 'archive-missing'), operation: 'archive', record }
      : family === 'revisions' ? { id: 'recovery', path: join(f.root, 'missing'), expectedHash: 'before', replacementHash: 'after', record }
        : { id: 'recovery', path: join(f.root, 'missing'), expectedHash: 'before', record }
    const invalid: unknown[] = [null, 'text', [], {}, ...Object.keys(valid).filter(key => key !== 'record').map(key => ({ ...valid, [key]: 17 })), { ...valid, record: {} }]
    for (const [index, image] of invalid.entries()) await writeFile(join(pending, `invalid-${index}.json`), JSON.stringify(image))
    await writeFile(join(pending, 'malformed.json'), '{')
    await writeFile(join(pending, 'ignored.txt'), 'not a journal')
    await writeFile(join(pending, 'missing.json'), JSON.stringify(valid))
    const restarted = new SkillLibrary(f.options)
    const inventory = await restarted.list({})
    expect(inventory.items).toHaveLength(1)
    expect(inventory.providers).toContainEqual(expect.objectContaining({ provider: 'skill-library-history', state: 'unavailable' }))
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toBe(source)
    for (const [index] of invalid.entries()) expect(await readFile(join(pending, `invalid-${index}.json`), 'utf8')).toBe(JSON.stringify(invalid[index]))
    expect(await readFile(join(pending, 'missing.json'), 'utf8')).toBe(JSON.stringify(valid))
    await restarted.dispose()
  }
})
it.each(['unchanged', 'edited'] as const)('recovers a created source without rewriting its %s current bytes', async (mode) => {
  const f = await fixture(); const dir = await f.skill('project', 'created')
  const path = join(dir, 'SKILL.md'); const before = await readFile(path, 'utf8')
  const item = (await f.library.list({})).items[0]!
  const { createHash } = await import('node:crypto')
  const expectedHash = createHash('sha256').update(before).digest('hex')
  const record = { retainedArchives: [], pinned: false, automaticCleanup: false, usage: { coverage: 'unknown', loadCount: 0 }, revisions: [], managedHash: expectedHash }
  const pending = join(f.options.historyDirectory, 'pending-creations'); await mkdir(pending, { recursive: true })
  const journal = join(pending, 'created.json'); await writeFile(journal, JSON.stringify({ id: item.id, path, expectedHash, record }))
  const current = mode === 'edited' ? before + '\nManual change.\n' : before; await writeFile(path, current)
  const restarted = new SkillLibrary(f.options); const recovered = (await restarted.list({})).items[0]!
  expect(recovered.ownership).toBe(mode === 'edited' ? 'protected' : 'y-managed')
  expect(await readFile(path, 'utf8')).toBe(current)
  await expect(readFile(journal)).rejects.toThrow(/ENOENT/)
  expect(f.rows.get(item.id)?.managedHash).toBe(expectedHash)
  await restarted.dispose()
})

it('keeps native metadata protected, loads selected instructions lazily, and removes disposed registrations', async () => {
  const f = await fixture(); const requests: (boolean | undefined)[] = []; let details = 0
  const projectEntry: NativeSkillLibraryEntry = {
    path: 'skill://fixture-native/project', name: 'native-project', description: 'Native project instructions',
    source: 'fixture-native', projectIds: ['p'], enabled: true,
    references: [{ target: 'https://example.invalid/native-guide', kind: 'url' }],
  }
  const sharedEntry: NativeSkillLibraryEntry = {
    path: 'skill://fixture-native/shared', name: 'native-shared', description: 'Native shared instructions',
    source: 'fixture-native', projectIds: [], enabled: false, userInvocable: false,
  }
  const provider: NativeSkillLibraryProvider = {
    name: 'fixture-native',
    list: async (projects, request) => {
      expect(projects.map(project => project.id)).toEqual(['p']); requests.push(request?.forceReload)
      return { status: { provider: 'fixture-native', state: 'connected' }, entries: [projectEntry, projectEntry, sharedEntry] }
    },
    detail: async (path) => { expect(path).toBe(projectEntry.path); details++; return 'Selected native instructions' },
  }
  const remove = f.library.registerNativeProvider(provider)
  try {
    expect(() => f.library.registerNativeProvider(provider)).toThrow(/duplicate/)
    const inventory = await f.library.list({ forceReload: true }); expect(requests[0]).toBe(true)
    expect(inventory.items).toHaveLength(2); expect(details).toBe(0)
    const item = inventory.items.find(row => row.name === projectEntry.name)!
    expect(item).toMatchObject({ ownership: 'protected', scope: 'project', projectIds: ['p'],
      invocation: { modelInvocable: true, userInvocable: true },
      capabilities: { native: true, adopt: false, archive: false, cleanup: false } })
    expect(inventory.items.find(row => row.name === sharedEntry.name)).toMatchObject({ scope: 'shared', status: 'disabled', invocation: { modelInvocable: false, userInvocable: false }, references: [] })
    expect(inventory.items.every(row => !('content' in row))).toBe(true)
    expect((await f.library.detail({ id: item.id })).content).toBe('Selected native instructions'); expect(details).toBe(1)
    expect((await f.library.setPinned({ id: item.id, pinned: true })).item.pinned).toBe(true)
    await expect(f.library.adopt({ id: item.id, expectedHash: '' })).rejects.toThrow(/protected/)
    await expect(f.library.archive({ id: item.id, expectedHash: '' })).rejects.toThrow(/protected/)
    expect((await f.library.previewCleanup()).changes).toEqual([])
    expect(await f.library.retrieve({ query: 'native', explicitIds: [item.id] })).toEqual([])
    remove(); expect((await f.library.list()).items).toEqual([])
    const next = f.library.registerNativeProvider({ name: provider.name, list: async () => ({
      status: { provider: provider.name, state: 'connected' }, entries: [projectEntry],
    }) })
    try {
      remove(); expect((await f.library.list()).items).toHaveLength(1)
      expect((await f.library.detail({ id: item.id })).content).toBe('')
    } finally { next() }
    expect((await f.library.list()).items).toEqual([])
  } finally { remove(); await f.library.dispose() }
})

it('reports failed native observations while retaining unrelated filesystem inventory', async () => {
  const f = await fixture(); const dir = await f.skill('project', 'retained')
  const original = await readFile(join(dir, 'SKILL.md'), 'utf8')
  const remove = f.library.registerNativeProvider({ name: 'fixture-unavailable', list: async () => { throw new Error('Native metadata unavailable') } })
  try {
    const inventory = await f.library.list()
    expect(inventory.items.map(row => row.name)).toEqual(['retained'])
    expect(inventory.providers).toContainEqual({ provider: 'fixture-unavailable', state: 'unavailable', message: 'Error: Native metadata unavailable' })
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toBe(original)
  } finally { remove(); await f.library.dispose() }
})

it('keeps registry-only instructions protected and prefers the existing filesystem item for duplicate identities', async () => {
  const f = await fixture(); await f.skill('project', 'local')
  const [local] = (await f.library.list()).items; let loads = 0
  const locator = 'skill://registry/fixture/bundled'
  const registryInventory: RegistryInventory = {
    list: async () => ({ statuses: [{ provider: 'registry:fixture', state: 'connected' }], entries: [
      { provider: local!.provider, path: local!.path, name: 'duplicate', description: 'Duplicate registry metadata',
        source: 'project-dsh', projectIds: ['p'], enabled: true, modelInvocable: true, userInvocable: true, native: false },
      { provider: 'fixture-bundled', path: locator, name: 'bundled', description: 'Bundled instructions',
        source: 'bundled', projectIds: [], enabled: true, modelInvocable: true, userInvocable: false, native: false },
    ] }),
    detail: async (path, provider) => { expect([path, provider]).toEqual([locator, 'fixture-bundled']); loads++; return 'Selected registry instructions' },
  }
  const library = new SkillLibrary({ ...f.options, registryInventory })
  try {
    const inventory = await library.list(); expect(inventory.items).toHaveLength(2); expect(loads).toBe(0)
    expect(inventory.items.find(row => row.id === local!.id)?.name).toBe('local')
    const bundled = inventory.items.find(row => row.name === 'bundled')!
    expect(bundled).toMatchObject({ ownership: 'vendor', bodyBytes: 0, contentHash: '', capabilities: { native: false, adopt: false, archive: false } })
    expect((await library.detail({ id: bundled.id })).content).toBe('Selected registry instructions'); expect(loads).toBe(1)
    await expect(library.adopt({ id: bundled.id, expectedHash: '' })).rejects.toThrow(/protected/)
    await expect(library.archive({ id: bundled.id, expectedHash: '' })).rejects.toThrow(/protected/)
  } finally { await library.dispose(); await f.library.dispose() }
})

it('expires evicted and applied previews while preserving source bytes until a current preview is applied', async () => {
  const f = await fixture(); const dir = await f.skill('project', 'deploy', 'Work.\n\n\n\nDone.')
  const path = join(dir, 'SKILL.md'); const original = await readFile(path, 'utf8')
  const library = new SkillLibrary({ ...f.options, proposalLimit: 1 })
  try {
    const [item] = (await library.list()).items
    await library.adopt({ id: item!.id, expectedHash: item!.contentHash })
    const first = await library.previewCleanup(); const second = await library.previewCleanup()
    expect(second.changes).toHaveLength(1)
    await expect(library.applyCleanup({ proposalId: first.id })).rejects.toThrow(/expired/)
    expect(await readFile(path, 'utf8')).toBe(original)
    expect((await library.applyCleanup({ proposalId: second.id })).revised).toEqual([item!.id])
    expect(await readFile(path, 'utf8')).toBe('---\nname: deploy\ndescription: deploy deployment workflow\n---\n\nWork.\n\n\nDone.\n')
    await expect(library.applyCleanup({ proposalId: second.id })).rejects.toThrow(/expired/)
  } finally { await library.dispose(); await f.library.dispose() }
})

it('protects a newly pinned member of a cleanup preview before editing any selected source', async () => {
  const f = await fixture(); const first = await f.skill('project', 'alpha', 'Work.\n\n\n\nDone.')
  const second = await f.skill('project', 'beta', 'Work.\n\n\n\nDone.')
  const originals = await Promise.all([first, second].map(dir => readFile(join(dir, 'SKILL.md'), 'utf8')))
  try {
    const items = (await f.library.list()).items
    for (const item of items) await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
    const preview = await f.library.previewCleanup(); expect(preview.changes).toHaveLength(2)
    const beta = items.find(row => row.name === 'beta')!
    await f.library.setPinned({ id: beta.id, pinned: true })
    await expect(f.library.applyCleanup({ proposalId: preview.id })).rejects.toThrow(/protected/)
    await expect(f.library.archive({ id: beta.id, expectedHash: beta.contentHash })).rejects.toThrow(/pinned/)
    await expect(f.library.setAutomaticCleanup({ id: beta.id, expectedHash: beta.contentHash, enabled: true })).rejects.toThrow(/protected/)
    expect((await f.library.previewCleanup({ ids: [beta.id] })).changes).toEqual([])
    expect(await Promise.all([first, second].map(dir => readFile(join(dir, 'SKILL.md'), 'utf8')))).toEqual(originals)
  } finally { await f.library.dispose() }
})

it('refuses stale load hashes without recording usage for edited instructions', async () => {
  const f = await fixture(); const dir = await f.skill('project', 'deploy')
  try {
    const [item] = (await f.library.list()).items
    await writeFile(join(dir, 'SKILL.md'), '---\nname: deploy\ndescription: Updated workflow\n---\nChanged instructions.\n')
    await expect(f.library.recordLoad({ id: item!.id, contentHash: item!.contentHash })).rejects.toThrow(/version changed/)
    const [current] = (await f.library.list()).items
    expect(current?.usage).toMatchObject({ coverage: 'unknown', loadCount: 0 })
    await f.library.recordLoad({ id: current!.id, contentHash: current!.contentHash, loadedAt: '2026-10-11T00:00:00.000Z' })
    expect((await f.library.list()).items[0]?.usage).toEqual({ coverage: 'recorded-loads', loadCount: 1, lastLoadedAt: '2026-10-11T00:00:00.000Z' })
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toContain('Changed instructions.')
  } finally { await f.library.dispose() }
})

it('deduplicates URL and local references while ignoring anchors and unrelated schemes', async () => {
  const f = await fixture(); await f.skill('project', 'references', [
    '[Guide](https://example.invalid/guide#part)', '[Again](https://example.invalid/guide#part)',
    '[Local](reference.md#part)', '[Anchor](#section)', '[Mail](mailto:fixture@example.invalid)', '[Other](skill://fixture/ignored)',
  ].join('\n'))
  try {
    const [item] = (await f.library.list()).items
    expect(item!.references).toEqual([
      { target: 'https://example.invalid/guide#part', kind: 'url' },
      { target: join(dirname(item!.path), 'reference.md'), kind: 'file' },
    ])
  } finally { await f.library.dispose() }
})

it.each([{ budget: 1, reason: 'over budget: semantic review required' }, { budget: 1000, reason: 'already compact' }])('leaves compact instruction bytes unchanged under a $budget byte body budget', async ({ budget, reason }) => {
  const f = await fixture(); const dir = await f.skill('project', 'compact', 'Retain these exact instructions.')
  const path = join(dir, 'SKILL.md'); const original = await readFile(path, 'utf8')
  const library = new SkillLibrary({ ...f.options, bodyBudgetBytes: budget })
  try {
    const [item] = (await library.list()).items
    await library.adopt({ id: item!.id, expectedHash: item!.contentHash })
    const preview = await library.previewCleanup()
    expect(preview.changes).toEqual([]); expect(preview.skipped).toEqual([{ id: item!.id, reason }])
    expect((await library.applyCleanup({ proposalId: preview.id })).revised).toEqual([])
    expect(await readFile(path, 'utf8')).toBe(original)
  } finally { await library.dispose(); await f.library.dispose() }
})

it('refuses stale source and revision identities before changing current instruction bytes', async () => {
  const f = await fixture(); const dir = await f.skill('project', 'current')
  const original = await readFile(join(dir, 'SKILL.md'), 'utf8')
  try {
    const [item] = (await f.library.list()).items
    await expect(f.library.detail({ id: brandString<SkillLibraryId>('missing') })).rejects.toThrow(/no longer available/)
    await expect(f.library.restore({ id: item!.id })).rejects.toThrow(/not archived/)
    await expect(f.library.rollback({ id: item!.id, expectedHash: item!.contentHash, revisionId: brandString<SkillRevisionId>('missing') })).rejects.toThrow(/unknown skill revision/)
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toBe(original)
  } finally { await f.library.dispose() }
})
it.each(['before', 'after'] as const)('settles a revision journal at its %s replacement checkpoint', async (mode) => {
  const f = await fixture(); const dir = await f.skill('project', 'revised')
  const path = join(dir, 'SKILL.md'); const before = await readFile(path, 'utf8'); const after = before + '\nReplacement.\n'
  const item = (await f.library.list({})).items[0]!
  const { createHash } = await import('node:crypto'); const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  const record = { retainedArchives: [], pinned: true, automaticCleanup: false, usage: { coverage: 'unknown', loadCount: 0 }, revisions: [], managedHash: hash(after) }
  const pending = join(f.options.historyDirectory, 'pending-revisions'); await mkdir(pending, { recursive: true })
  const journal = join(pending, 'revised.json'); await writeFile(journal, JSON.stringify({ id: item.id, path, expectedHash: hash(before), replacementHash: hash(after), record }))
  await writeFile(path, mode === 'before' ? before : after)
  const restarted = new SkillLibrary(f.options); await restarted.list({})
  expect(f.rows.get(item.id)?.pinned).toBe(mode === 'after' ? true : undefined)
  expect(await readFile(path, 'utf8')).toBe(mode === 'before' ? before : after)
  await expect(readFile(journal)).rejects.toThrow(/ENOENT/); await restarted.dispose()
})
it.each(['archive-moved', 'archive-not-moved', 'restore-copied', 'restore-complete', 'restore-moved'] as const)('recovers archive ownership at %s while preserving both source locations', async (checkpoint) => {
  const f = await fixture(); const dir = await f.skill('project', 'retained')
  const item = (await f.library.list({})).items[0]!
  const originalPath = join(f.root, 'original'); const archivePath = join(f.root, 'archived')
  const original = checkpoint !== 'archive-moved'; const archived = checkpoint !== 'archive-not-moved' && checkpoint !== 'restore-moved'
  if (original) await writeFile(originalPath, 'original bytes')
  if (archived) await writeFile(archivePath, 'archive bytes')
  const record = { retainedArchives: [], pinned: true, automaticCleanup: false, usage: { coverage: 'unknown', loadCount: 0 }, revisions: [] }
  const pending = join(f.options.historyDirectory, 'pending-archives'); await mkdir(pending, { recursive: true })
  const journal = join(pending, 'archive.json'); const operation = checkpoint.startsWith('archive') ? 'archive' : 'restore'
  await writeFile(journal, JSON.stringify({ id: item.id, operation, originalPath, archivePath, record }))
  if (checkpoint === 'restore-complete') await writeFile(journal + '.complete', '')
  const restarted = new SkillLibrary(f.options); const inventory = await restarted.list({})
  const committed = ['archive-moved', 'restore-complete', 'restore-moved'].includes(checkpoint)
  expect(f.rows.get(item.id)?.pinned).toBe(committed ? true : undefined)
  if (original) expect(await readFile(originalPath, 'utf8')).toBe('original bytes')
  if (archived) expect(await readFile(archivePath, 'utf8')).toBe('archive bytes')
  expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toContain('name: retained')
  if (checkpoint === 'restore-copied') {
    expect(inventory.providers).toContainEqual(expect.objectContaining({ provider: 'skill-library-history', state: 'unavailable' }))
    expect(await readFile(journal, 'utf8')).toContain('restore')
  } else await expect(readFile(journal)).rejects.toThrow(/ENOENT/)
  await restarted.dispose()
})
