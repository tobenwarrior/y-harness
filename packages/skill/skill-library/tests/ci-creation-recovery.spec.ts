/** Failed filesystem publication preserves journal ownership and exact retry instructions. */
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SkillLibrary } from '../src/library.ts'
import type { SkillLibraryStore } from '../src/library.ts'
import type { SkillLibraryId } from '../src/types.ts'
import type { SkillLibraryRecord } from '../src/record.ts'

const publication = vi.hoisted(() => {
  const value: { destination: string; fail: boolean; denyJournal: boolean; afterStage?: () => void } = {
    destination: '', fail: false, denyJournal: false,
  }
  return value
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  const rename: typeof original.rename = async (from, to) => {
    if (publication.fail && to === publication.destination) {
      publication.fail = false
      throw new Error('Fixture complete bundle publication interrupted')
    }
    return original.rename(from, to)
  }
  const writeFile: typeof original.writeFile = async (path, data, options) => {
    if (publication.denyJournal && typeof path === 'string' && path.includes('/pending-creations/')) {
      throw Object.assign(new Error('Fixture journal write denied'), { code: 'EACCES' })
    }
    await original.writeFile(path, data, options)
    if (typeof path === 'string' && path.endsWith('/bundle/SKILL.md')) publication.afterStage?.()
  }
  return { ...original, rename, writeFile, default: { ...original, rename, writeFile } }
})

async function ownedLibrary() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ci-creation-'))
  const project = join(directory, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  const context = new Context()
  const provider = new FileSystemSkillProvider(context, { invalidate() {}, signal: new AbortController().signal },
    { dshHome: join(directory, 'home'), agentsHome: join(directory, 'agents'), watch: false })
  const records = new Map<SkillLibraryId, SkillLibraryRecord>()
  const store: SkillLibraryStore = { get: id => records.get(id), entries: () => records.entries(),
    put: async (id, row) => { records.set(id, row) } }
  const history = join(directory, 'history')
  let projectPath = project
  const library = new SkillLibrary({ provider, store, projects: () => [{ id: 'p', title: 'Fixture', path: projectPath }],
    historyDirectory: history, bodyBudgetBytes: 1500, retrievalLimit: 3, proposalLimit: 3 })
  onTestFinished(async () => {
    publication.fail = false; publication.denyJournal = false; publication.destination = ''; delete publication.afterStage
    await library.dispose(); await provider.dispose(); await context.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  const request = { projectId: 'p', name: 'release', description: 'Release instructions',
    content: 'Inspect the current release and independently check the outcome.',
    expectedPath: join(project, '.dsh', 'skills', 'release', 'SKILL.md') }
  return { directory, project, history, library, store, request, relocate: (path: string) => { projectPath = path } }
}

it.each(['unchanged', 'altered', 'linked', 'unwritable'] as const)(
  'keeps interrupted creation ownership when its retained journal is %s', async (control) => {
    const fixture = await ownedLibrary()
    publication.destination = join(fixture.project, '.dsh', 'skills', 'release'); publication.fail = true
    await expect(fixture.library.createLearning(fixture.request, async () => undefined))
      .rejects.toThrow('Fixture complete bundle publication interrupted')
    await expect(readFile(fixture.request.expectedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const pending = join(fixture.history, 'pending-creations')
    const names = await readdir(pending)
    expect(names).toHaveLength(1)
    const journal = join(pending, names[0] ?? '')
    const retained = await readFile(journal, 'utf8')
    if (control === 'altered') await writeFile(journal, 'Preserve this externally changed journal.')
    else if (control === 'linked') {
      const outside = join(fixture.directory, 'retained-user-record')
      await writeFile(outside, retained); await rm(journal); await symlink(outside, journal)
    } else if (control === 'unwritable') publication.denyJournal = true
    const retry = fixture.library.createLearning(fixture.request, async () => undefined)
    if (control === 'unchanged') {
      const result = await retry
      expect(result.item.ownership).toBe('y-managed')
      expect(await readFile(fixture.request.expectedPath, 'utf8')).toContain(fixture.request.content)
      expect(await readdir(pending)).toEqual([])
      expect((await fixture.library.detail({ id: result.item.id })).revisions).toEqual([])
    } else {
      await expect(retry).rejects.toThrow(control === 'unwritable' ? 'Fixture journal write denied' : 'skill creation journal changed')
      await expect(readFile(fixture.request.expectedPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(journal, 'utf8')).toBe(control === 'altered' ? 'Preserve this externally changed journal.' : retained)
    }
  },
)

it('refuses publication when project registration moves while the complete creation bundle is being staged', async () => {
  const fixture = await ownedLibrary()
  const relocated = join(fixture.directory, 'relocated')
  await mkdir(relocated)
  let completedStages = 0
  publication.afterStage = () => { completedStages++; fixture.relocate(relocated) }
  await expect(fixture.library.createLearning(fixture.request, async () => undefined))
    .rejects.toThrow('skill destination changed from the reviewed project path')
  expect(completedStages).toBe(1)
  await expect(readFile(fixture.request.expectedPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(relocated)).toEqual([])
  expect(await readdir(join(fixture.history, 'pending-creations'))).toEqual([])
})

it('retains supported local and web references without treating opaque URI schemes as files', async () => {
  const fixture = await ownedLibrary()
  const directory = join(fixture.project, '.dsh', 'skills', 'references')
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'SKILL.md')
  const original = '---\nname: references\ndescription: Reference handling\n---\n'
    + '[Topic](guide.md#review) [Web](https://example.invalid/guide) [Opaque](mailto:fixture@example.invalid) [Anchor](#local)\n'
  await writeFile(path, original)
  const item = (await fixture.library.list()).items.find(value => value.name === 'references')
  if (item === undefined) throw new Error('Fixture source was not discovered')
  expect(item.references).toEqual([
    { kind: 'file', target: join(directory, 'guide.md') },
    { kind: 'url', target: 'https://example.invalid/guide' },
  ])
  expect(await readFile(path, 'utf8')).toBe(original)
})

it('rechecks durable pin ownership before publishing a reviewed topic generation', async () => {
  const fixture = await ownedLibrary()
  const directory = join(fixture.project, '.dsh', 'skills', 'large')
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'SKILL.md')
  const original = '---\nname: large\ndescription: Complete reviewed procedure\n---\n'
    + '# Procedure\n\n## Setup\n\n' + 'Retain each complete setup instruction.\n\n'.repeat(110)
    + '## Review\n\n' + 'Retain each complete review instruction.\n\n'.repeat(110)
  await writeFile(path, original)
  const item = (await fixture.library.list()).items.find(value => value.name === 'large')
  if (item === undefined) throw new Error('Fixture source was not discovered')
  await fixture.library.adopt({ id: item.id, expectedHash: item.contentHash })
  const preview = await fixture.library.previewCleanup({ ids: [item.id] })
  expect(preview.changes[0]?.markdownGeneration?.files.length).toBeGreaterThan(0)
  let publishedPin = false
  const unregister = fixture.library.registerNativeProvider({ name: 'fixture-independent-owner', list: async () => {
    if (!publishedPin) {
      const current = fixture.store.get(item.id)
      if (current === undefined) throw new Error('Fixture management record was not adopted')
      await fixture.store.put(item.id, { ...current, pinned: true }); publishedPin = true
    }
    return { status: { provider: 'fixture-independent-owner', state: 'connected' }, entries: [] }
  } })
  onTestFinished(unregister)
  await expect(fixture.library.applyCleanup({ proposalId: preview.id })).rejects.toThrow(/protected|pinned/)
  expect(publishedPin).toBe(true)
  expect(await readFile(path, 'utf8')).toBe(original)
  expect(await readdir(directory)).toEqual(['SKILL.md'])
  expect((await fixture.library.detail({ id: item.id })).revisions).toEqual([])
})
