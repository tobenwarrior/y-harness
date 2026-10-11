import { afterEach, describe, expect, it, vi } from 'vitest'
import fs, { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { SkillLibrary, type SkillLibraryStore } from '../src/library.ts'
import { markdownWithinLimit, measureMarkdown } from '../src/markdown-size.ts'
import { readMarkdownSource } from '../src/markdown-generation.ts'
import type { SkillLibraryId } from '../src/types.ts'
import { skillLibraryRecord, type SkillLibraryRecord } from '../src/record.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const body = '# Skill\n\nShort introduction.\n\n## Deployment\n\n[Guide](guide.md)\n\n'
  + 'A complete deployment paragraph.\n\n'.repeat(120)
const raw = (name: string, content: string) => `---\nname: ${name}\ndescription: "Workflow"\n---\n${content}`

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-markdown-workflow-'))); roots.push(root)
  const project = join(root, 'project'); await mkdir(join(project, '.git'), { recursive: true })
  const rows = new Map<SkillLibraryId, SkillLibraryRecord>()
  const store: SkillLibraryStore = { get: id => rows.get(id), entries: () => rows.entries(),
    put: async (id, row) => { rows.set(id, row) } }
  const provider = new FileSystemSkillProvider(new Context(), { invalidate() {},
    signal: new AbortController().signal }, { dshHome: join(root, 'home'),
    agentsHome: join(root, 'agents'), watch: false })
  const options = { provider, store, historyDirectory: join(root, 'history'),
    projects: () => [{ id: 'p', title: 'Project', path: project }],
    bodyBudgetBytes: 1500, retrievalLimit: 3, proposalLimit: 20 }
  const library = new SkillLibrary(options)
  async function skill(name: string, content = body, flat = false) {
    const directory = join(project, '.dsh', 'skills', ...(flat ? [] : [name]))
    await mkdir(directory, { recursive: true })
    const path = join(directory, flat ? name + '.md' : 'SKILL.md')
    await writeFile(path, raw(name, content))
    return (await library.list({})).items.find(item => item.name === name)!
  }
  async function create(name: string, content = body) {
    return library.createLearning({ projectId: 'p', name, description: 'Workflow', content,
      expectedPath: join(project, '.dsh', 'skills', name, 'SKILL.md') }, async () => {})
  }
  return { root, project, rows, provider, options, library, skill, create }
}

describe('managed Markdown workflow', () => {
  it.each([199, 200])('keeps %i screen lines exact during creation', async (count) => {
    const f = await fixture(); const content = 'x\n'.repeat(count - 4)
    const created = (await f.create('bounded', content)).item
    const actual = await readFile(created.path, 'utf8')
    expect(actual).toBe(raw('bounded', content))
    expect(measureMarkdown(actual).screenLines).toBe(count)
    expect(await readdir(join(f.project, '.dsh/skills/bounded'))).toEqual(['SKILL.md'])
  })

  it('automatically splits at 201 lines and publishes a complete discoverable bundle', async () => {
    const f = await fixture(); const content = '# Skill\n\nIntro.\n\n' + 'Paragraph.\n\n'.repeat(96) + 'Last.'
    expect(measureMarkdown(raw('boundary', content)).screenLines).toBe(201)
    const created = (await f.create('boundary', content)).item
    const actual = await readFile(created.path, 'utf8')
    expect(markdownWithinLimit(actual)).toBe(true)
    expect(actual).toContain('.y-topics/')
    expect(await readMarkdownSource(created.path, actual)).toBe(raw('boundary', content))
    expect(created.ownership).toBe('y-managed')
    expect((await f.library.list({})).items).toHaveLength(1)
  })

  it('refuses an indivisible new block before occupying its destination', async () => {
    const f = await fixture(); const content = '# Skill\n\nIntro.\n\n```ts\n' + 'literal\n'.repeat(201) + '```\n'
    await expect(f.create('indivisible', content)).rejects.toThrow(/block|fence|indivisible/i)
    await expect(readFile(join(f.project, '.dsh/skills/indivisible/SKILL.md'))).rejects.toThrow(/ENOENT/)
    const created = await f.create('indivisible', 'A corrected short instruction.\n')
    expect(created.item.ownership).toBe('y-managed')
  })

  it('refuses occupied destinations and protects their original bytes', async () => {
    const f = await fixture(); const old = await f.skill('occupied', 'User-owned instructions.\n')
    const before = await readFile(old.path, 'utf8')
    await expect(f.create('occupied')).rejects.toThrow(/existing|occupied/i)
    expect(await readFile(old.path, 'utf8')).toBe(before)
  })

  it('keeps ordinary model loads short while selected semantics and references remain complete', async () => {
    const f = await fixture(); const created = (await f.create('progressive')).item
    const detail = await f.library.detail({ id: created.id })
    expect(detail.content).not.toContain('A complete deployment paragraph.')
    expect(detail.content).toContain('.y-topics/')
    const candidates = await f.provider.list({ cwd: f.project })
    const list = Array.isArray(candidates) ? candidates : candidates.candidates
    const definition = await f.provider.get(list.find(item => item.name === 'progressive')!, {})
    expect(definition?.content).toBe(detail.content.trim())
    const selected = await f.library.learningSource(created.id)
    expect(selected.content).toBe(body)
    expect(selected.raw).toBe(await readFile(created.path, 'utf8'))
    expect(selected.item.references.some(reference => reference.target === join(dirname(created.path), 'guide.md'))).toBe(true)
    const retrieved = await f.library.retrieve({ query: 'progressive', projectId: 'p' })
    expect(retrieved.every(item => !('content' in item))).toBe(true)
  })

  it('previews every child, repeats idempotently, and rolls back capped exact original instructions', async () => {
    const f = await fixture(); const item = await f.skill('cleanup')
    const original = await readFile(item.path, 'utf8')
    await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
    const preview = await f.library.previewCleanup({ ids: [item.id] })
    expect(preview.changes[0]?.markdownGeneration?.files.some(file => file.path === 'entry.txt')).toBe(true)
    expect(preview.changes[0]?.markdownGeneration?.files.some(file => file.path === 'source/0000.txt')).toBe(true)
    await f.library.applyCleanup({ proposalId: preview.id })
    const once = await readFile(item.path, 'utf8')
    expect((await f.library.previewCleanup({ ids: [item.id] })).changes).toHaveLength(0)
    expect(await readFile(item.path, 'utf8')).toBe(once)
    const detail = await f.library.detail({ id: item.id })
    await f.library.rollback({ id: item.id, expectedHash: detail.item.contentHash,
      revisionId: detail.revisions[0]!.id })
    const restored = await readFile(item.path, 'utf8')
    expect(markdownWithinLimit(restored)).toBe(true)
    expect(await readMarkdownSource(item.path, restored)).toBe(original)
    expect((await f.library.learningSource(item.id)).content).toBe(body)
    const again = await f.library.previewCleanup({ ids: [item.id] })
    await f.library.applyCleanup({ proposalId: again.id })
    expect(await readFile(item.path, 'utf8')).toBe(once)
  })

  it('enforces the cap on direct managed revisions while preserving frontmatter and semantic text', async () => {
    const f = await fixture(); const item = await f.skill('revise', 'Short source.\n')
    const header = (await readFile(item.path, 'utf8')).slice(0, -'Short source.\n'.length)
    await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
    const updated = (await f.library.reviseLearning({ id: item.id, expectedHash: item.contentHash,
      content: body }, async () => {})).item
    const actual = await readFile(updated.path, 'utf8')
    expect(actual.startsWith(header)).toBe(true)
    expect(markdownWithinLimit(actual)).toBe(true)
    expect((await f.library.learningSource(updated.id)).content).toBe(body)
  })

  it('skips pinned, unmanaged, explicitly exempt, and oversized flat sources', async () => {
    const f = await fixture(); const unmanaged = await f.skill('unmanaged')
    const pinned = await f.skill('pinned'); await f.library.adopt({ id: pinned.id, expectedHash: pinned.contentHash })
    await f.library.setPinned({ id: pinned.id, pinned: true })
    const exempt = await f.skill('exempt'); const before = await readFile(exempt.path, 'utf8')
    await writeFile(exempt.path, before.replace('---\n# Skill', 'split-exempt: true\n---\n# Skill'))
    const current = (await f.library.list({})).items.find(item => item.id === exempt.id)!
    await f.library.adopt({ id: current.id, expectedHash: current.contentHash })
    const flat = await f.skill('flat', body, true); await f.library.adopt({ id: flat.id, expectedHash: flat.contentHash })
    const preview = await f.library.previewCleanup({ ids: [unmanaged.id, pinned.id, exempt.id, flat.id] })
    expect(preview.changes).toHaveLength(0)
    expect(preview.skipped).toHaveLength(4)
    expect(preview.skipped.find(item => item.id === flat.id)?.reason).toMatch(/directory|flat/i)
    expect(await readFile(unmanaged.path, 'utf8')).toBe(raw('unmanaged', body))
  })

  it('detects edited topic receipts and keeps the inventory available for recovery', async () => {
    const f = await fixture(); const item = (await f.create('edited')).item
    const entry = await readFile(item.path, 'utf8')
    const linked = /\]\((\.y-topics\/[^)]+)\)/.exec(entry)![1]!
    const path = join(item.path, '..', linked.split('#')[0]!); await writeFile(path, 'User edit.\n')
    const inventory = await f.library.list({})
    expect(inventory.items.find(current => current.id === item.id)?.capabilities.cleanup).toBe(true)
    const preview = await f.library.previewCleanup({ ids: [item.id] })
    expect(preview.changes).toHaveLength(0)
    expect(preview.skipped[0]?.reason).toMatch(/changed|manifest|generation|hash/i)
    await expect(f.library.learningSource(item.id)).rejects.toThrow(/changed|manifest|generation|hash/i)
    expect(await readFile(path, 'utf8')).toBe('User edit.\n')
  })

  it('preflights every generation before changing any root in a cleanup batch', async () => {
    const f = await fixture(); const one = await f.skill('first'); const two = await f.skill('second')
    for (const item of [one, two]) await f.library.adopt({ id: item.id, expectedHash: item.contentHash })
    const preview = await f.library.previewCleanup({ ids: [one.id, two.id] })
    const second = preview.changes.find(change => change.id === two.id)!
    const generation = join(two.path, '..', '.y-topics', second.markdownGeneration!.id)
    await mkdir(generation, { recursive: true }); await writeFile(join(generation, 'foreign.txt'), 'User bytes.')
    await expect(f.library.applyCleanup({ proposalId: preview.id })).rejects.toThrow()
    expect(await readFile(one.path, 'utf8')).toBe(raw('first', body))
    expect(await readFile(two.path, 'utf8')).toBe(raw('second', body))
    expect(await readFile(join(generation, 'foreign.txt'), 'utf8')).toBe('User bytes.')
  })

  it('recovers a split creation after durable metadata storage interruption', async () => {
    const f = await fixture(); let failed = false
    const store: SkillLibraryStore = { ...f.options.store, put: async (id, row) => {
      if (!failed) { failed = true; throw new Error('Interrupted metadata write') }
      await f.options.store.put(id, row)
    } }
    const interrupted = new SkillLibrary({ ...f.options, store })
    const path = join(f.project, '.dsh/skills/recovered/SKILL.md')
    await expect(interrupted.createLearning({ projectId: 'p', name: 'recovered', description: 'Workflow',
      content: body, expectedPath: path }, async () => {})).rejects.toThrow(/Interrupted/)
    const capped = await readFile(path, 'utf8')
    expect(await readMarkdownSource(path, capped)).toBe(raw('recovered', body))
    const restarted = new SkillLibrary(f.options)
    expect((await restarted.list({})).items[0]?.ownership).toBe('y-managed')
    expect(await readdir(join(f.options.historyDirectory, 'pending-creations'))).toEqual([])
  })

  it('retains a complete generation during archive, restore, and an external directory rename', async () => {
    const f = await fixture(); const item = (await f.create('movable')).item
    const original = await readFile(item.path, 'utf8')
    await f.library.archive({ id: item.id, expectedHash: item.contentHash })
    await f.library.restore({ id: item.id })
    expect(await readFile(item.path, 'utf8')).toBe(original)
    expect((await f.library.learningSource(item.id)).content).toBe(body)
    const directory = join(item.path, '..'); const renamed = join(directory, '..', 'renamed')
    await rename(directory, renamed)
    const moved = (await f.library.list({})).items.find(current => current.name === 'movable')!
    expect(moved.ownership).toBe('protected')
    await f.library.adopt({ id: moved.id, expectedHash: moved.contentHash })
    expect((await f.library.learningSource(moved.id)).content).toBe(body)
    expect(await readFile(join(renamed, 'SKILL.md'), 'utf8')).toBe(original)
  })

  it('refuses rollback to an edited inactive generation and preserves the current root', async () => {
    const f = await fixture(); const item = (await f.create('history')).item
    const previous = await readFile(item.path, 'utf8')
    const updated = (await f.library.reviseLearning({ id: item.id, expectedHash: item.contentHash,
      content: body.replaceAll('deployment paragraph', 'deployment instruction') }, async () => {})).item
    const current = await readFile(item.path, 'utf8')
    const linked = /\]\((\.y-topics\/[^)]+)\)/.exec(previous)![1]!
    const path = join(item.path, '..', linked.split('#')[0]!); await writeFile(path, 'Edited historic topic.\n')
    const detail = await f.library.detail({ id: item.id })
    await expect(f.library.rollback({ id: item.id, expectedHash: updated.contentHash,
      revisionId: detail.revisions[0]!.id })).rejects.toThrow(/hash|changed|manifest/i)
    expect(await readFile(item.path, 'utf8')).toBe(current)
    expect(await readFile(path, 'utf8')).toBe('Edited historic topic.\n')
  })

  it('opens no generated bodies for inventory, retrieval, or detail across projects', async () => {
    const f = await fixture(); const one = (await f.create('one')).item
    const other = join(f.root, 'other'); await mkdir(join(other, '.git'), { recursive: true })
    const library = new SkillLibrary({ ...f.options, projects: () => [
      { id: 'p', title: 'Project', path: f.project }, { id: 'other', title: 'Other', path: other },
    ] })
    await library.createLearning({ projectId: 'other', name: 'two', description: 'Workflow', content: body,
      expectedPath: join(other, '.dsh/skills/two/SKILL.md') }, async () => {})
    const opened = vi.spyOn(fs, 'open')
    const inventory = await library.list({ projectId: 'p' })
    expect(inventory.items.map(item => item.name)).toEqual(['one'])
    await library.retrieve({ projectId: 'p', query: 'one' })
    await library.detail({ id: one.id })
    expect(opened.mock.calls.filter(([path]) => String(path).includes('.y-topics'))).toEqual([])
  })

  it('persists verified logical references through schema parsing and restart without loading bodies', async () => {
    const f = await fixture(); const item = (await f.create('durable')).item
    const record = skillLibraryRecord.parse(JSON.parse(JSON.stringify(f.rows.get(item.id))))
    expect(record.markdownReferences?.references.some(ref => ref.target === join(dirname(item.path), 'guide.md'))).toBe(true)
    f.rows.set(item.id, record)
    const restarted = new SkillLibrary(f.options); const opened = vi.spyOn(fs, 'open')
    const inventory = await restarted.list({})
    expect(inventory.items[0]?.references.some(ref => ref.target === join(dirname(item.path), 'guide.md'))).toBe(true)
    expect(opened.mock.calls.filter(([path]) => String(path).includes('.y-topics'))).toEqual([])
    opened.mockRestore()
    await restarted.reviseLearning({ id: item.id, expectedHash: item.contentHash,
      content: 'A short replacement.\n' }, async () => {})
    expect(f.rows.get(item.id)?.markdownReferences).toBeUndefined()
  })

  it('reports missing or stale logical-reference metadata until selected adoption verifies it', async () => {
    const f = await fixture(); const item = (await f.create('legacy')).item
    const record = f.rows.get(item.id)!
    f.rows.set(item.id, { ...record, markdownReferences: undefined })
    const restarted = new SkillLibrary(f.options)
    const missing = await restarted.list({})
    expect(missing.providers.some(provider => provider.state === 'unavailable')).toBe(true)
    expect(missing.items[0]?.references.some(ref => ref.target === join(dirname(item.path), 'guide.md'))).toBe(false)
    expect((await restarted.learningSource(item.id)).item.references.some(ref => ref.target === join(dirname(item.path), 'guide.md'))).toBe(true)
    expect(f.rows.get(item.id)?.markdownReferences).toBeUndefined()
    await restarted.adopt({ id: item.id, expectedHash: item.contentHash })
    expect((await restarted.list({})).items[0]?.references.some(ref => ref.target === join(dirname(item.path), 'guide.md'))).toBe(true)
    const verified = f.rows.get(item.id)!
    f.rows.set(item.id, { ...verified, markdownReferences: { ...verified.markdownReferences!, rootHash: '0'.repeat(64) } })
    expect((await restarted.list({})).providers.some(provider => provider.state === 'unavailable')).toBe(true)
    await restarted.adopt({ id: item.id, expectedHash: item.contentHash })
    expect(f.rows.get(item.id)?.markdownReferences?.rootHash).toBe(item.contentHash)
  })

  it('retains damaged resources for explicit archive recovery but blocks semantic writes', async () => {
    const f = await fixture(); const item = (await f.create('damaged')).item
    const entry = await readFile(item.path, 'utf8')
    const linked = /\]\((\.y-topics\/[^)]+)\)/.exec(entry)![1]!.split('#')[0]!
    const path = join(item.path, '..', linked); await writeFile(path, 'User recovery bytes.\n')
    await expect(f.library.adopt({ id: item.id, expectedHash: item.contentHash })).rejects.toThrow()
    await expect(f.library.setAutomaticCleanup({ id: item.id, expectedHash: item.contentHash, enabled: true })).rejects.toThrow()
    await expect(f.library.reviseLearning({ id: item.id, expectedHash: item.contentHash,
      content: 'Replacement.\n' }, async () => {})).rejects.toThrow()
    await f.library.setAutomaticCleanup({ id: item.id, expectedHash: item.contentHash, enabled: false })
    await f.library.setPinned({ id: item.id, pinned: true })
    await f.library.setPinned({ id: item.id, pinned: false })
    await f.library.archive({ id: item.id, expectedHash: item.contentHash })
    await f.library.restore({ id: item.id })
    expect(await readFile(path, 'utf8')).toBe('User recovery bytes.\n')
    expect(await readFile(item.path, 'utf8')).toBe(entry)
  })


  it('keeps canonical cross-skill file references in selected semantic sources after restart', async () => {
    const f = await fixture(); const target = (await f.create('target', 'Target instruction.\n')).item
    const content = body.replace('[Guide](guide.md)', '[Guide](../target/SKILL.md)')
    const source = (await f.create('source', content)).item
    for (const [id, row] of f.rows) f.rows.set(id, skillLibraryRecord.parse(JSON.parse(JSON.stringify(row))))
    const restarted = new SkillLibrary(f.options)
    const selected = await restarted.learningSource(source.id)
    const reference = selected.item.references.find(ref => ref.kind === 'file' && ref.target === target.path)
    expect(reference).toEqual({ kind: 'file', target: target.path })
    const inventory = await restarted.list({ projectId: 'p' })
    expect(inventory.items.find(item => item.id === source.id)?.references
      .some(ref => ref.kind === 'file' && ref.target === target.path && ref.resolvedId === target.id)).toBe(true)
    expect(selected.content).toBe(content)
  })

  it('repairs the root through verified rollback while preserving damaged current resources', async () => {
    const f = await fixture(); const item = (await f.create('repair', 'A short original.\n')).item
    const before = await readFile(item.path, 'utf8')
    const updated = (await f.library.reviseLearning({ id: item.id, expectedHash: item.contentHash,
      content: body }, async () => {})).item
    const entry = await readFile(updated.path, 'utf8')
    const linked = /\]\((\.y-topics\/[^)]+)\)/.exec(entry)![1]!.split('#')[0]!
    const path = join(item.path, '..', linked); await writeFile(path, 'Preserved damaged topic.\n')
    const detail = await f.library.detail({ id: item.id })
    await f.library.rollback({ id: item.id, expectedHash: updated.contentHash, revisionId: detail.revisions[0]!.id })
    expect(await readFile(item.path, 'utf8')).toBe(before)
    expect(await readFile(path, 'utf8')).toBe('Preserved damaged topic.\n')
  })


  it('refuses semantic archive when missing metadata cannot prove incoming reference absence', async () => {
    const f = await fixture(); const target = (await f.create('target', 'Target instruction.\n')).item
    const source = (await f.create('legacy-link', body.replace('[Guide](guide.md)', '[Guide](../target/SKILL.md)'))).item
    f.rows.set(source.id, { ...f.rows.get(source.id)!, markdownReferences: undefined })
    const restarted = new SkillLibrary(f.options); const verify = vi.fn(async () => {})
    const opened = vi.spyOn(fs, 'open')
    await expect(restarted.archiveLearning({ id: target.id, expectedHash: target.contentHash }, verify))
      .rejects.toThrow(/logical references|adoption/i)
    expect(verify).not.toHaveBeenCalled()
    expect(opened.mock.calls.filter(([path]) => String(path).includes('.y-topics'))).toEqual([])
    opened.mockRestore()
    expect(await readFile(target.path, 'utf8')).toBe(raw('target', 'Target instruction.\n'))
    await restarted.adopt({ id: source.id, expectedHash: source.contentHash })
    const inventory = await restarted.list({})
    expect(inventory.providers.some(provider => provider.provider === 'skill-library-markdown'
      && provider.state === 'unavailable')).toBe(false)
    expect(inventory.items.find(item => item.id === source.id)?.references.some(ref => ref.resolvedId === target.id)).toBe(true)
  })


  it.each([
    String.raw`\[Example](.y-topics/not-a-hash/topics/topic.md)`,
    String.raw`[Example\](.y-topics/not-a-hash/topics/topic.md)`,
    '`[Example](.y-topics/not-a-hash/topics/topic.md)`',
    'Bare example ](.y-topics/not-a-hash/topics/topic.md)',
    '<https://example.invalid/?q=[Example](.y-topics/not-a-hash/topics/topic.md)>',
    '[Guide](guide.md "[Example](.y-topics/not-a-hash/topics/topic.md)")',
    "[Guide](guide.md '[Example](.y-topics/not-a-hash/topics/topic.md)')",
    String.raw`[Guide](guide.md ([Example](.y-topics/not-a-hash/topics/topic.md\)))`,
  ])('keeps literal generated-link examples out of metadata admission: %s', async (content) => {
    const f = await fixture(); const item = (await f.create('example', content + '\n')).item
    const inventory = await f.library.list({})
    expect(inventory.providers.some(provider => provider.provider === 'skill-library-markdown')).toBe(false)
    expect((await f.library.learningSource(item.id)).content).toBe(content + '\n')
    const verify = vi.fn(async () => {})
    await f.library.archiveLearning({ id: item.id, expectedHash: item.contentHash }, verify)
    expect(verify).toHaveBeenCalledOnce()
  })


  it('refuses semantic archive with generated contributors without opening their bodies', async () => {
    const f = await fixture(); const target = (await f.create('target', 'Target instruction.\n')).item
    const source = (await f.create('contributor')).item
    const entry = await readFile(source.path, 'utf8')
    const linked = /\]\((\.y-topics\/[^)]+)\)/.exec(entry)![1]!.split('#')[0]!
    const path = join(source.path, '..', linked); const before = await readFile(path, 'utf8')
    const edited = before + '[New incoming link](../../../../target/SKILL.md)\n'
    await writeFile(path, edited)
    const verify = vi.fn(async () => {})
    const opened = vi.spyOn(fs, 'open')
    expect((await f.library.list({})).items.find(item => item.id === source.id)?.ownership).toBe('y-managed')
    expect(opened.mock.calls.filter(([path]) => String(path).includes('.y-topics'))).toEqual([])
    await expect(f.library.archiveLearning({ id: target.id, expectedHash: target.contentHash }, verify))
      .rejects.toThrow(/changed|hash|manifest|contributor|generation/i)
    expect(verify).not.toHaveBeenCalled()
    expect(opened.mock.calls.filter(([path]) => String(path).includes('.y-topics'))).toEqual([])
    opened.mockRestore()
    expect(await readFile(path, 'utf8')).toBe(edited)
    expect(await readFile(target.path, 'utf8')).toBe(raw('target', 'Target instruction.\n'))
    await writeFile(path, before)
    await expect(f.library.archiveLearning({ id: target.id, expectedHash: target.contentHash }, verify))
      .rejects.toThrow(/generated contributors/i)
    expect(verify).not.toHaveBeenCalled()
  })


  it('refuses semantic archive after metadata refresh without entering contributor verification', async () => {
    const f = await fixture(); const target = (await f.create('target', 'Target instruction.\n')).item
    await f.create('alpha-valid'); await f.create('zeta-valid')
    const verify = vi.fn(async () => {})
    const opened = vi.spyOn(fs, 'open')
    await Promise.all([f.library.list({}), f.library.list({})])
    await expect(f.library.archiveLearning({ id: target.id, expectedHash: target.contentHash }, verify))
      .rejects.toThrow(/generated contributors/i)
    expect(verify).not.toHaveBeenCalled()
    expect(opened.mock.calls.filter(([path]) => String(path).includes('.y-topics'))).toEqual([])
    opened.mockRestore()
    expect(await readFile(target.path, 'utf8')).toBe(raw('target', 'Target instruction.\n'))
  })

})
