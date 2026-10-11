/** Public rollback keeps historical semantics while admitting only bounded managed replacements. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { SkillLibrary, type SkillLibraryStore } from '../src/library.ts'
import { markdownWithinLimit, measureMarkdown } from '../src/markdown-size.ts'
import { readMarkdownSource } from '../src/markdown-generation.ts'
import type { SkillLibraryId, SkillLibraryItem, SkillLibraryRevision } from '../src/types.ts'
import type { SkillLibraryRecord } from '../src/record.ts'

const cleanup: { root: string; library: SkillLibrary }[] = []
afterEach(async () => {
  for (const fixture of cleanup.splice(0)) {
    await fixture.library.dispose()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
const oversized = '# Rollback\n\nA complete original introduction.\n\n## Setup\n\n'
  + 'Keep this full setup procedure and its exact whitespace.\n\n'.repeat(110)
  + '## Review\n\n' + 'Keep this full review procedure and its exact whitespace.\n\n'.repeat(110)
const raw = (name: string, content: string) => `---\nname: ${name}\ndescription: "Rollback cap"\n---\n${content}`

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-markdown-rollback-cap-')))
  const project = join(root, 'project'); await mkdir(join(project, '.git'), { recursive: true })
  const rows = new Map<SkillLibraryId, SkillLibraryRecord>()
  const store: SkillLibraryStore = { get: id => rows.get(id), entries: () => rows.entries(),
    put: async (id, row) => { rows.set(id, row) } }
  const provider = new FileSystemSkillProvider(new Context(), { invalidate() {},
    signal: new AbortController().signal }, { dshHome: join(root, 'home'),
    agentsHome: join(root, 'agents'), watch: false })
  const library = new SkillLibrary({ provider, store, historyDirectory: join(root, 'history'),
    projects: () => [{ id: 'p', title: 'Project', path: project }],
    bodyBudgetBytes: 1500, retrievalLimit: 3, proposalLimit: 20 })
  cleanup.push({ root, library })
  async function legacy(name: string, content: string, flat = false) {
    const directory = join(project, '.dsh', 'skills', ...(flat ? [] : [name]))
    await mkdir(directory, { recursive: true })
    const path = join(directory, flat ? `${name}.md` : 'SKILL.md')
    await writeFile(path, raw(name, content))
    const item = (await library.list({})).items.find(item => item.name === name)
    if (item === undefined) throw new Error('Owned legacy fixture is missing')
    await library.adopt({ id: item.id, expectedHash: item.contentHash })
    return item
  }
  async function revision(item: SkillLibraryItem): Promise<SkillLibraryRevision> {
    const first = (await library.detail({ id: item.id })).revisions[0]
    if (first === undefined) throw new Error('Fixture revision is missing')
    return first
  }
  async function files(directory: string): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) for (const [child, content] of await files(path)) result.set(`${entry.name}/${child}`, content)
      else result.set(entry.name, await readFile(path, 'utf8'))
    }
    return result
  }
  return { root, library, rows, legacy, revision, files }
}
function linkedTopic(entry: string, path: string): string {
  const target = /\]\((\.y-topics\/[^)]+)\)/.exec(entry)?.[1]?.split('#')[0]
  if (target === undefined) throw new Error('Fixture generated topic is missing')
  return join(dirname(path), target)
}

describe('managed historical rollback cap', () => {
  it('restores an oversized adopted original through a bounded root with exact selected semantics', async () => {
    const f = await fixture(); const item = await f.legacy('restore', oversized)
    const original = await readFile(item.path, 'utf8')
    expect(measureMarkdown(original).screenLines).toBeGreaterThan(200)
    const preview = await f.library.previewCleanup({ ids: [item.id] })
    await f.library.applyCleanup({ proposalId: preview.id })
    const firstRoot = await readFile(item.path, 'utf8')
    const detail = await f.library.detail({ id: item.id })
    await f.library.rollback({ id: item.id, expectedHash: detail.item.contentHash,
      revisionId: (await f.revision(item)).id })
    const restored = await readFile(item.path, 'utf8')
    expect(markdownWithinLimit(restored)).toBe(true)
    expect(restored).toBe(firstRoot)
    expect(await readMarkdownSource(item.path, restored)).toBe(original)
    expect((await f.library.learningSource(item.id)).content).toBe(oversized)
    const after = await f.library.detail({ id: item.id })
    expect(after.item.ownership).toBe('y-managed')
    expect(after.revisions).toHaveLength(2)
    expect(after.revisions[1]?.reason).toBe('rollback')
  })

  it('skips damaged current generation verification while restoring a different intact oversized original', async () => {
    const f = await fixture(); const item = await f.legacy('current-damage', oversized)
    const original = await readFile(item.path, 'utf8')
    const preview = await f.library.previewCleanup({ ids: [item.id] })
    await f.library.applyCleanup({ proposalId: preview.id })
    const split = await f.library.detail({ id: item.id })
    const updated = (await f.library.reviseLearning({ id: item.id, expectedHash: split.item.contentHash,
      content: oversized.replaceAll('setup procedure', 'other procedure') }, async () => {})).item
    const currentRoot = await readFile(item.path, 'utf8')
    const damaged = linkedTopic(currentRoot, item.path)
    await writeFile(damaged, 'Preserved damaged current topic.\n')
    await f.library.rollback({ id: item.id, expectedHash: updated.contentHash, revisionId: (await f.revision(item)).id })
    const restored = await readFile(item.path, 'utf8')
    expect(markdownWithinLimit(restored)).toBe(true)
    expect(await readMarkdownSource(item.path, restored)).toBe(original)
    expect(await readFile(damaged, 'utf8')).toBe('Preserved damaged current topic.\n')
    expect((await f.library.detail({ id: item.id })).revisions).toHaveLength(3)
  })

  it.each(['indivisible', 'flat'] as const)('refuses an oversized %s historical replacement without touching current bytes or history', async (kind) => {
    const f = await fixture()
    const content = kind === 'indivisible' ? '# Fence\n\n```ts\n' + 'literal\n'.repeat(201) + '```\n' : oversized
    const item = await f.legacy(kind, content, kind === 'flat')
    const updated = (await f.library.reviseLearning({ id: item.id, expectedHash: item.contentHash,
      content: 'Current short instructions.\n' }, async () => {})).item
    const before = await f.files(f.root)
    await expect(f.library.rollback({ id: item.id, expectedHash: updated.contentHash,
      revisionId: (await f.revision(item)).id })).rejects.toThrow(/200 screen lines|25 KiB|standalone|indivisible/i)
    expect(await f.files(f.root)).toEqual(before)
    expect((await f.library.detail({ id: item.id })).revisions).toHaveLength(1)
  })

  it('refuses an altered historical receipt while retaining current content and all recovery bytes', async () => {
    const f = await fixture(); const item = await f.legacy('old-receipt', oversized)
    const preview = await f.library.previewCleanup({ ids: [item.id] })
    await f.library.applyCleanup({ proposalId: preview.id })
    const split = await f.library.detail({ id: item.id })
    const generated = await readFile(item.path, 'utf8')
    const topic = linkedTopic(generated, item.path)
    const receipt = join(dirname(dirname(topic)), 'source', '0001.txt')
    const oldReceipt = await readFile(receipt, 'utf8')
    const updated = (await f.library.reviseLearning({ id: item.id, expectedHash: split.item.contentHash,
      content: 'Current short instructions.\n' }, async () => {})).item
    await writeFile(receipt, oldReceipt.replace('setup', 'setuq'))
    const detail = await f.library.detail({ id: item.id }); const historical = detail.revisions[1]
    if (historical === undefined) throw new Error('Generated historical revision is missing')
    const before = await f.files(f.root)
    await expect(f.library.rollback({ id: item.id, expectedHash: updated.contentHash,
      revisionId: historical.id })).rejects.toThrow(/generation|changed|hash/i)
    expect(await f.files(f.root)).toEqual(before)
    expect((await f.library.detail({ id: item.id })).revisions).toHaveLength(2)
  })

  it('verifies an altered oversized historical generated root before publishing any replacement children', async () => {
    const f = await fixture(); const item = await f.legacy('old-root', oversized)
    const preview = await f.library.previewCleanup({ ids: [item.id] })
    await f.library.applyCleanup({ proposalId: preview.id })
    const split = await f.library.detail({ id: item.id })
    const updated = (await f.library.reviseLearning({ id: item.id, expectedHash: split.item.contentHash,
      content: 'Current short instructions.\n' }, async () => {})).item
    const historical = f.rows.get(item.id)?.revisions[1]
    if (historical === undefined) throw new Error('Generated historical backup is missing')
    await writeFile(historical.backupPath, (await readFile(historical.backupPath, 'utf8'))
      + 'Altered historical paragraph.\n\n'.repeat(110))
    const before = await f.files(f.root)
    await expect(f.library.rollback({ id: item.id, expectedHash: updated.contentHash,
      revisionId: historical.id })).rejects.toThrow(/generated entry exceeds|file limits/i)
    expect(await f.files(f.root)).toEqual(before)
    expect((await f.library.detail({ id: item.id })).revisions).toHaveLength(2)
  })

  it('does not regenerate a damaged immutable generation for an oversized original', async () => {
    const f = await fixture(); const item = await f.legacy('immutable-damage', oversized)
    const preview = await f.library.previewCleanup({ ids: [item.id] })
    await f.library.applyCleanup({ proposalId: preview.id })
    const detail = await f.library.detail({ id: item.id })
    const topic = linkedTopic(await readFile(item.path, 'utf8'), item.path)
    await writeFile(topic, 'Preserved externally edited immutable topic.\n')
    const before = await f.files(f.root)
    await expect(f.library.rollback({ id: item.id, expectedHash: detail.item.contentHash,
      revisionId: (await f.revision(item)).id })).rejects.toThrow(/generation|changed|different/i)
    expect(await f.files(f.root)).toEqual(before)
    expect((await f.library.detail({ id: item.id })).revisions).toHaveLength(1)
  })
})
