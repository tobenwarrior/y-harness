/** Instruction ownership, creation races and publication failures use only isolated source copies. */
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import type { SkillCandidate } from '@deepseek-ai/dsh-skill'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SkillLibrary, type SkillLibraryOptions } from '../src/library.ts'
import type { SkillLibraryRecord } from '../src/record.ts'
import type { SkillLibraryId, SkillLibraryProject } from '../src/types.ts'
import type { RegistryInventory } from '../src/registry-inventory.ts'

async function fixture(registryInventory?: RegistryInventory) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-library-followup-'))
  const ctx = new Context()
  const home = join(root, 'home'); const project = join(root, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  let projects: readonly SkillLibraryProject[] = [{ id: 'p', title: 'Fixture', path: project }]
  const rows = new Map<SkillLibraryId, SkillLibraryRecord>()
  const provider = new FileSystemSkillProvider(ctx, { invalidate() {}, signal: new AbortController().signal },
    { dshHome: home, agentsHome: join(root, 'agents'), bundledSkillDir: join(root, 'bundled'), watch: false })
  const options: SkillLibraryOptions = { provider, projects: () => projects,
    store: { get: id => rows.get(id), entries: () => rows.entries(), put: async (id, row) => { rows.set(id, row) } },
    historyDirectory: join(root, 'history'), bodyBudgetBytes: 1000, retrievalLimit: 3, proposalLimit: 3,
    ...registryInventory === undefined ? {} : { registryInventory } }
  const library = new SkillLibrary(options)
  onTestFinished(async () => {
    await library.dispose(); await provider.dispose(); await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const source = async (name: string, extra = '', scope: 'project' | 'shared' | 'bundled' = 'project') => {
    const directory = join(scope === 'project' ? join(project, '.dsh', 'skills') : scope === 'shared' ? join(home, 'skills') : join(root, 'bundled'), name)
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'SKILL.md')
    await writeFile(path, `---\nname: ${name}\ndescription: Release workflow\n${extra}---\n\nKeep the reviewed instructions.\n`)
    return path
  }
  return { root, home, project, provider, options, library, rows, source,
    setProjects: (value: readonly SkillLibraryProject[]) => { projects = value } }
}

it('keeps user-only instructions hidden until explicit selection and never ranks disabled or native metadata', async () => {
  const registry: RegistryInventory = { list: async () => ({ statuses: [], entries: [
    { provider: 'registry', path: 'fixture:registry-active', name: 'registry-active', description: 'Release', source: 'runtime', projectIds: ['p'], enabled: true, modelInvocable: true, userInvocable: true, native: false },
    { provider: 'registry', path: 'fixture:registry-disabled', name: 'registry-disabled', description: 'Release', source: 'runtime', projectIds: [], enabled: false, modelInvocable: false, userInvocable: false, native: false },
  ] }), detail: async () => 'Selected registry instructions.' }
  const f = await fixture(registry)
  await f.source('manual', 'disable-model-invocation: true\n')
  await f.source('disabled', 'disable-model-invocation: true\nuser-invocable: false\n')
  const dispose = f.library.registerNativeProvider({ name: 'native', list: async () => ({ status: { provider: 'native', state: 'connected' }, entries: [
    { path: 'fixture:native', name: 'native', description: 'Release', source: 'native', projectIds: [], enabled: true },
  ] }) })
  onTestFinished(dispose)
  const items = (await f.library.list()).items
  expect(items.find(item => item.name === 'disabled')?.status).toBe('disabled')
  expect(items.find(item => item.name === 'registry-disabled')).toMatchObject({ status: 'disabled', ownership: 'protected' })
  expect(items.find(item => item.name === 'registry-active')).toMatchObject({ scope: 'project', projectIds: ['p'] })
  expect((await f.library.retrieve({ projectId: 'p', query: 'Release' })).map(item => item.name)).toEqual(['registry-active'])
  const manual = items.find(item => item.name === 'manual')!
  expect((await f.library.retrieve({ projectId: 'p', query: '', explicitIds: [manual.id] })).map(item => item.name)).toEqual(['manual'])
  expect((await f.library.retrieve({ query: 'Release', explicitIds: [manual.id], limit: 1 })).map(item => item.name)).toEqual(['manual'])
})

it('retains shared discovery and precedence without registered projects and protects bundled sources', async () => {
  const f = await fixture(); f.setProjects([])
  await f.source('release', '', 'shared'); const bundled = await f.source('vendor', '', 'bundled')
  const items = (await f.library.list()).items
  expect(items.find(item => item.name === 'release')).toMatchObject({ scope: 'shared', projectIds: [], shadowed: false })
  expect(items.find(item => item.name === 'vendor')).toMatchObject({ ownership: 'vendor', capabilities: { adopt: false, archive: false } })
  expect((await f.library.retrieve({ query: 'release' })).map(item => item.name)).toEqual(['release', 'vendor'])
  expect(await readFile(bundled, 'utf8')).toContain('reviewed instructions')
})

it('ignores virtual candidates and opaque provider locators outside the admitted local filesystem boundary', async () => {
  const f = await fixture()
  const common = { name: 'opaque', description: 'Opaque source', provider: 'filesystem', source: 'runtime', rank: 1, invocation: { modelInvocable: true, userInvocable: true } }
  const candidates: SkillCandidate[] = [
    { ...common, locator: { token: 'virtual' } },
    ...[null, {}, { path: 'fixture', directory: 'fixture', bundlePath: 3 }].map(locator => ({ ...common, path: join(f.root, 'never-read.md'), locator })),
  ]
  const observation = vi.spyOn(f.provider, 'list').mockResolvedValue({ candidates, complete: false })
  onTestFinished(() => { observation.mockRestore() })
  expect((await f.library.list()).items).toEqual([])
  expect(await readdir(f.root)).toEqual(['project'])
})

it('refuses a stale admitted hash before adopting a source', async () => {
  const f = await fixture(); const path = await f.source('release')
  const item = (await f.library.list()).items[0]!
  const replacement = (await readFile(path, 'utf8')) + '\nA later edit.\n'; await writeFile(path, replacement)
  await expect(f.library.adopt({ id: item.id, expectedHash: item.contentHash })).rejects.toThrow('skill source changed')
  expect(await readFile(path, 'utf8')).toBe(replacement); expect(f.rows.size).toBe(0)
})

it('requires adoption and an unpinned managed source for semantic revision', async () => {
  const f = await fixture(); const path = await f.source('release'); const before = await readFile(path, 'utf8')
  const item = (await f.library.list()).items[0]!
  const request = { id: item.id, expectedHash: item.contentHash, content: 'Proposed instructions.' }
  await expect(f.library.reviseLearning(request, async () => undefined)).rejects.toThrow('adopt the current version')
  await f.library.adopt({ id: item.id, expectedHash: item.contentHash }); await f.library.setPinned({ id: item.id, pinned: true })
  await expect(f.library.reviseLearning(request, async () => undefined)).rejects.toThrow('pinned skill')
  expect(await readFile(path, 'utf8')).toBe(before); expect((await f.library.detail({ id: item.id })).revisions).toEqual([])
})

it.each(['unchanged', 'later-edit'] as const)('preserves source ownership when revision publication fails with %s bytes', async (mode) => {
  const f = await fixture(); const path = await f.source('release'); const before = await readFile(path, 'utf8')
  const item = (await f.library.list()).items[0]!
  await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
  const later = before + '\nLater human instructions.\n'
  const put = vi.spyOn(f.options.store, 'put').mockImplementationOnce(async () => {
    if (mode === 'later-edit') await writeFile(path, later)
    throw new Error('fixture durable publication rejected')
  })
  onTestFinished(() => { put.mockRestore() })
  await expect(f.library.reviseLearning({ id: item.id, expectedHash: item.contentHash, content: 'Replacement.' }, async () => undefined)).rejects.toThrow('fixture durable publication rejected')
  expect(await readFile(path, 'utf8')).toBe(mode === 'unchanged' ? before : later)
  const history = await readdir(join(f.options.historyDirectory, 'revisions', item.id))
  expect(history).toHaveLength(1); expect(await readFile(join(f.options.historyDirectory, 'revisions', item.id, history[0]!), 'utf8')).toBe(before)
  expect((await readdir(join(f.project, '.dsh', 'skills', 'release'))).some(name => name.endsWith('.tmp'))).toBe(false)
})

it.each(['missing-project', 'invalid-name', 'shared-duplicate', 'project-duplicate'] as const)('refuses unreviewable creation %s and retains existing instructions', async (mode) => {
  const f = await fixture()
  const existing = mode === 'shared-duplicate' || mode === 'project-duplicate' ? await f.source('release', '', mode === 'shared-duplicate' ? 'shared' : 'project') : undefined
  const before = existing === undefined ? undefined : await readFile(existing, 'utf8')
  const name = mode === 'invalid-name' ? 'Invalid_Name' : 'release'
  await expect(f.library.createLearning({ projectId: mode === 'missing-project' ? 'absent' : 'p', name,
    description: 'New release', content: 'New instructions.', expectedPath: join(f.project, '.dsh', 'skills', name, 'SKILL.md') }, async () => undefined)).rejects.toThrow(mode.endsWith('duplicate') ? 'existing skill must be updated' : 'invalid project or skill name')
  if (existing !== undefined) expect(await readFile(existing, 'utf8')).toBe(before)
  else expect((await readdir(f.project)).sort()).toEqual(['.git'])
})

it('refuses a project relocation between reviewed creation admission and final path revalidation', async () => {
  const f = await fixture(); const relocated = join(f.root, 'relocated'); await mkdir(relocated)
  let admitted = 0
  await expect(f.library.createLearning({ projectId: 'p', name: 'release', description: 'Release', content: 'New instructions.',
    expectedPath: join(f.project, '.dsh', 'skills', 'release', 'SKILL.md') }, async () => {
    if (++admitted === 2) f.setProjects([{ id: 'p', title: 'Relocated', path: relocated }])
  })).rejects.toThrow('skill destination changed')
  expect(admitted).toBe(2); expect(await readdir(relocated)).toEqual([])
  expect(await readdir(f.project)).toEqual(['.git'])
})

it('refuses creation through a linked instruction root without modifying its target', async () => {
  const f = await fixture(); const outside = join(f.root, 'outside'); await mkdir(outside)
  await symlink(outside, join(f.project, '.dsh'), 'junction')
  await expect(f.library.createLearning({ projectId: 'p', name: 'release', description: 'Release', content: 'New instructions.',
    expectedPath: join(f.project, '.dsh', 'skills', 'release', 'SKILL.md') }, async () => undefined)).rejects.toThrow('skill destination is protected')
  expect(await readdir(outside)).toEqual([])
})

it('preserves created instructions and their journal if the provider cannot discover the new copy', async () => {
  const f = await fixture()
  const observation = vi.spyOn(f.provider, 'list').mockResolvedValue([])
  onTestFinished(() => { observation.mockRestore() })
  const path = join(f.project, '.dsh', 'skills', 'release', 'SKILL.md')
  await expect(f.library.createLearning({ projectId: 'p', name: 'release', description: 'Release', content: 'New instructions.', expectedPath: path }, async () => undefined)).rejects.toThrow('created instructions were not discoverable; source preserved')
  expect(await readFile(path, 'utf8')).toContain('New instructions.')
  expect(await readdir(join(f.options.historyDirectory, 'pending-creations'))).toHaveLength(1)
  expect(f.rows.size).toBe(0)
})

it('preserves CRLF instruction framing when conservative cleanup creates a revision', async () => {
  const f = await fixture(); const path = await f.source('release')
  const original = '---\r\nname: release\r\ndescription: Release\r\n---\r\nWork.\r\n\r\n\r\n\r\nFinish.\r\n'; await writeFile(path, original)
  const item = (await f.library.list()).items[0]!
  await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
  const preview = await f.library.previewCleanup({ ids: [item.id] })
  expect(preview.changes[0]?.after).toBe(original.replace('\r\n\r\n\r\n\r\n', '\r\n\r\n\r\n'))
  await f.library.applyCleanup({ proposalId: preview.id })
  expect(await readFile(path, 'utf8')).toBe(preview.changes[0]?.after)
})

it.each(['archives', 'revisions', 'creations'] as const)('preserves invalid durable management state in the %s journal boundary', async (family) => {
  const f = await fixture(); const path = await f.source('unrelated'); const before = await readFile(path, 'utf8')
  const pending = join(f.options.historyDirectory, `pending-${family}`); await mkdir(pending, { recursive: true })
  const record = { pinned: 'invalid persisted flag' }
  const document = family === 'archives'
    ? { id: 'fixture-journal', operation: 'archive', originalPath: path, archivePath: join(f.root, 'archived'), record }
    : family === 'revisions'
      ? { id: 'fixture-journal', path, expectedHash: 'before', replacementHash: 'after', record }
      : { id: 'fixture-journal', path, expectedHash: 'before', record }
  const journal = join(pending, 'invalid-record.json'); const raw = JSON.stringify(document); await writeFile(journal, raw)
  const inventory = await f.library.list()
  expect(inventory.items).toHaveLength(1)
  const status = inventory.providers.find(value => value.provider === 'skill-library-history')
  expect(status?.state).toBe('unavailable'); expect(status?.message).toContain('Invalid recovery state preserved')
  expect(await readFile(journal, 'utf8')).toBe(raw); expect(await readFile(path, 'utf8')).toBe(before)
  expect(f.rows.size).toBe(0)
})

it('refuses an unreadable history path rather than treating its filesystem error as an absent journal', async () => {
  const f = await fixture(); const occupied = join(f.root, 'occupied'); await writeFile(occupied, 'Preserve this existing file.')
  const library = new SkillLibrary({ ...f.options, historyDirectory: join(occupied, 'history') })
  onTestFinished(async () => { await library.dispose() })
  await expect(library.list()).rejects.toMatchObject({ code: 'ENOTDIR' })
  expect(await readFile(occupied, 'utf8')).toBe('Preserve this existing file.')
})

it('reads only string skill references from untrusted parsed frontmatter metadata', async () => {
  const f = await fixture(); await f.source('target')
  await f.source('mixed', 'metadata:\n  relatedSkills: [target, 17, null]\n')
  const items = (await f.library.list()).items
  const target = items.find(item => item.name === 'target')!
  expect(items.find(item => item.name === 'mixed')?.references).toEqual([{ kind: 'skill', target: 'target', resolvedId: target.id }])
})

it('refuses cleanup when a concurrent public refresh clears its admitted local source before preview materialization', async () => {
  const f = await fixture(); const path = await f.source('release'); const before = await readFile(path, 'utf8')
  const item = (await f.library.list()).items[0]!; await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
  const previewObserved = Promise.withResolvers<undefined>(); const finishPreviewInventory = Promise.withResolvers<undefined>()
  const refreshObserved = Promise.withResolvers<undefined>(); const finishRefreshDiscovery = Promise.withResolvers<undefined>()
  const stopNative = f.library.registerNativeProvider({ name: 'fixture-preview-barrier', list: async () => {
    previewObserved.resolve(undefined); await finishPreviewInventory.promise
    return { status: { provider: 'fixture-preview-barrier', state: 'connected' }, entries: [] }
  } })
  onTestFinished(stopNative)
  const pending = f.library.previewCleanup({ ids: [item.id] }); void pending.catch(() => undefined)
  await previewObserved.promise
  const discover = f.provider.list.bind(f.provider)
  const held = vi.spyOn(f.provider, 'list').mockImplementation(async (options) => {
    refreshObserved.resolve(undefined); await finishRefreshDiscovery.promise; return discover(options)
  })
  onTestFinished(() => { finishRefreshDiscovery.resolve(undefined); finishPreviewInventory.resolve(undefined); held.mockRestore() })
  const refresh = f.library.list(); await refreshObserved.promise; finishPreviewInventory.resolve(undefined)
  await expect(pending).rejects.toThrow('skill source changed; refresh and preview again')
  finishRefreshDiscovery.resolve(undefined); await refresh
  expect(await readFile(path, 'utf8')).toBe(before)
  expect((await f.library.detail({ id: item.id })).revisions).toEqual([])
})

it('revalidates managed ownership after an asynchronous inventory owner publishes revocation', async () => {
  const f = await fixture(); const path = await f.source('release'); const before = await readFile(path, 'utf8')
  const item = (await f.library.list()).items[0]!; await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
  const revoked = structuredClone(f.rows.get(item.id)!); delete revoked.managedHash
  const stopNative = f.library.registerNativeProvider({ name: 'fixture-publication-barrier', list: async () => {
    await f.options.store.put(item.id, revoked)
    return { status: { provider: 'fixture-publication-barrier', state: 'connected' }, entries: [] }
  } })
  onTestFinished(stopNative)
  await expect(f.library.reviseLearning({ id: item.id, expectedHash: item.contentHash, content: 'Replacement instructions.' }, async () => undefined))
    .rejects.toThrow('skill is protected from cleanup')
  expect(await readFile(path, 'utf8')).toBe(before)
  expect((await f.library.detail({ id: item.id })).revisions).toEqual([])
  expect((await f.library.list()).items.find(value => value.id === item.id)?.ownership).toBe('protected')
})

it('preserves provider-admitted CR-terminated metadata framing during conservative cleanup and pinned revision refusal', async () => {
  const f = await fixture(); const path = await f.source('release')
  const before = '---\nname: release\ndescription: Release\n---\r'; await writeFile(path, before)
  const item = (await f.library.list()).items[0]!; expect(item.name).toBe('release')
  await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
  const preview = await f.library.previewCleanup({ ids: [item.id] })
  expect(preview.changes).toEqual([]); expect(preview.skipped).toEqual([{ id: item.id, reason: 'already compact' }])
  await f.library.setPinned({ id: item.id, pinned: true })
  await expect(f.library.reviseLearning({ id: item.id, expectedHash: item.contentHash, content: 'Replacement instructions.' }, async () => undefined))
    .rejects.toThrow('pinned skill is protected from revision')
  expect(await readFile(path, 'utf8')).toBe(before)
  expect((await f.library.detail({ id: item.id })).revisions).toEqual([])
})
