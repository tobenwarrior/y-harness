/** Semantic revisions preserve real filesystem metadata or refuse before writing. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it, onTestFinished } from 'vitest'
import { SkillLibrary } from '../src/library.ts'
import type { SkillLibraryRecord } from '../src/record.ts'
import type { SkillLibraryId } from '../src/types.ts'

async function fixture(original: string) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-learning-framing-'))
  const ctx = new Context(); const project = join(root, 'project')
  const directory = join(project, '.dsh', 'skills', 'release')
  await mkdir(join(project, '.git'), { recursive: true }); await mkdir(directory, { recursive: true })
  const path = join(directory, 'SKILL.md'); await writeFile(path, original)
  const rows = new Map<SkillLibraryId, SkillLibraryRecord>()
  const provider = new FileSystemSkillProvider(ctx, { invalidate() {}, signal: new AbortController().signal }, {
    dshHome: join(root, 'home'), agentsHome: join(root, 'agents'), bundledSkillDir: join(root, 'bundled'), watch: false,
  })
  const library = new SkillLibrary({ provider, projects: () => [{ id: 'p', title: 'Fixture', path: project }],
    store: { get: id => rows.get(id), entries: () => rows.entries(), put: async (id, row) => { rows.set(id, row) } },
    historyDirectory: join(root, 'history'), bodyBudgetBytes: 1000, retrievalLimit: 3, proposalLimit: 3 })
  onTestFinished(async () => {
    await library.dispose(); await provider.dispose(); await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const item = (await library.list()).items[0]!
  expect(item).toMatchObject({ name: 'release', description: 'Release safely', ownership: 'protected' })
  await library.adopt({ id: item.id, expectedHash: item.contentHash })
  return { root, path, directory, library, rows, item }
}

it.each(['\n', '\r\n'])('keeps metadata discoverable when a %j source ends at its recognized delimiter', async (newline) => {
  const original = ['---', 'name: release', 'description: Release safely', 'disable-model-invocation: true', '---'].join(newline)
  const f = await fixture(original); const replacement = 'Retain approvals before release.\n'
  const revised = await f.library.reviseLearning({ id: f.item.id, expectedHash: f.item.contentHash,
    content: replacement }, async () => undefined)
  expect(await readFile(f.path, 'utf8')).toBe(original + newline + replacement)
  expect(revised.item).toMatchObject({ name: 'release', description: 'Release safely', ownership: 'y-managed',
    invocation: { modelInvocable: false, userInvocable: true } })
  expect((await f.library.learningSource(f.item.id)).content).toBe(replacement)
  const revisions = (await f.library.detail({ id: f.item.id })).revisions
  expect(revisions).toHaveLength(1); expect(revisions[0]?.reason).toBe('learning')
  const backup = f.rows.get(f.item.id)!.revisions[0]!.backupPath
  expect(await readFile(backup, 'utf8')).toBe(original)
  await f.library.rollback({ id: f.item.id, revisionId: revisions[0]!.id, expectedHash: revised.item.contentHash })
  expect(await readFile(f.path, 'utf8')).toBe(original)
  expect((await f.library.list()).items[0]).toMatchObject({ id: f.item.id, name: 'release', ownership: 'y-managed' })
})

it.each(['\n', '\r\n'])('refuses provider-admitted %j framing with a lone CR at EOF before source or journal writes', async (newline) => {
  const original = ['---', 'name: release', 'description: Release safely', '---'].join(newline) + '\r'
  const f = await fixture(original); const record = structuredClone(f.rows.get(f.item.id))
  const refused = f.library.reviseLearning({ id: f.item.id, expectedHash: f.item.contentHash, content: 'Replacement instructions.' }, async () => undefined)
  await expect(refused).rejects.toThrow()
  expect(await readFile(f.path, 'utf8')).toBe(original)
  expect(f.rows.get(f.item.id)).toEqual(record)
  expect(await readdir(f.directory)).toEqual(['SKILL.md'])
  expect(await readdir(f.root)).toEqual(['project'])
  expect((await f.library.detail({ id: f.item.id })).revisions).toEqual([])
  await expect(refused).rejects.toThrow('skill source framing is unsupported; source preserved')
})

it.each(['\n', '\r\n'])('retains an existing %j delimiter newline and all metadata during body replacement', async (newline) => {
  const header = ['---', 'name: release', 'description: Release safely', '---', ''].join(newline)
  const f = await fixture(header + 'Old instructions.'); const replacement = 'Reviewed instructions.'
  await f.library.reviseLearning({ id: f.item.id, expectedHash: f.item.contentHash, content: replacement }, async () => undefined)
  expect(await readFile(f.path, 'utf8')).toBe(header + replacement)
  expect((await f.library.learningSource(f.item.id)).content).toBe(replacement)
})

it.each(['---', '---\r'])('retains pinned-source refusal precedence for the admitted EOF delimiter %j', async (closing) => {
  const original = '---\nname: release\ndescription: Release safely\n' + closing
  const f = await fixture(original); await f.library.setPinned({ id: f.item.id, pinned: true })
  const record = structuredClone(f.rows.get(f.item.id))
  await expect(f.library.reviseLearning({ id: f.item.id, expectedHash: f.item.contentHash, content: 'Replacement.' }, async () => undefined))
    .rejects.toThrow('pinned skill is protected from revision')
  expect(await readFile(f.path, 'utf8')).toBe(original); expect(f.rows.get(f.item.id)).toEqual(record)
  expect(await readdir(f.root)).toEqual(['project'])
})

it('retains the admitted version guard before any recognized EOF source revision writes', async () => {
  const original = '---\nname: release\ndescription: Release safely\n---'; const f = await fixture(original)
  const record = structuredClone(f.rows.get(f.item.id))
  await expect(f.library.reviseLearning({ id: f.item.id, expectedHash: '0'.repeat(64), content: 'Replacement.' }, async () => undefined))
    .rejects.toThrow('skill source changed; refresh and preview again')
  expect(await readFile(f.path, 'utf8')).toBe(original); expect(f.rows.get(f.item.id)).toEqual(record)
  expect(await readdir(f.root)).toEqual(['project'])
})

it('keeps stale-version refusal ahead of pin refusal without changing the source', async () => {
  const original = '---\nname: release\ndescription: Release safely\n---'; const f = await fixture(original)
  await f.library.setPinned({ id: f.item.id, pinned: true }); const record = structuredClone(f.rows.get(f.item.id))
  await expect(f.library.reviseLearning({ id: f.item.id, expectedHash: '0'.repeat(64), content: 'Replacement.' }, async () => undefined))
    .rejects.toThrow('skill source changed; refresh and preview again')
  expect(await readFile(f.path, 'utf8')).toBe(original); expect(f.rows.get(f.item.id)).toEqual(record)
  expect(await readdir(f.root)).toEqual(['project'])
})

it('revalidates a pin published by an asynchronous inventory owner before the revision writes', async () => {
  const original = '---\nname: release\ndescription: Release safely\n---'; const f = await fixture(original)
  const pinned = { ...structuredClone(f.rows.get(f.item.id)!), pinned: true }
  const remove = f.library.registerNativeProvider({ name: 'fixture-pinning-observer', list: async () => {
    f.rows.set(f.item.id, pinned)
    return { status: { provider: 'fixture-pinning-observer', state: 'connected' }, entries: [] }
  } })
  onTestFinished(remove)
  await expect(f.library.reviseLearning({ id: f.item.id, expectedHash: f.item.contentHash, content: 'Replacement.' }, async () => undefined))
    .rejects.toThrow('pinned skill is protected from revision')
  expect(await readFile(f.path, 'utf8')).toBe(original); expect(f.rows.get(f.item.id)).toEqual(pinned)
  expect(await readdir(f.root)).toEqual(['project'])
})
