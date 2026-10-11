/** Filesystem evidence for immutable, bounded Markdown generation publication. */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureMarkdownGeneration, hasMarkdownGenerationLinks, readMarkdownSource } from '../src/markdown-generation.ts'
import { MARKDOWN_BYTE_CAP, MARKDOWN_SCREEN_CAP } from '../src/markdown-size.ts'
import { planMarkdownSplit } from '../src/markdown-split.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

function spyOnRead(handle: Awaited<ReturnType<typeof fs.open>>) {
  return vi.spyOn(handle, 'read')
}

const sourceText = '# Original source\n\nUntouched source bytes.\n'
const generation = createHash('sha256').update(sourceText).digest('hex')
const children = [
  { path: 'overview.md', content: '# Overview\n\nRead the topic.\n' },
  { path: 'topics/deep/topic.md', content: '# Topic\n\n完整的内容。\n' },
]
async function fixture() {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'dsh-markdown-generation-'))
  roots.push(root)
  const entry = join(root, 'SKILL.md')
  await fs.writeFile(entry, sourceText, { flag: 'wx', mode: 0o600 })
  const store = join(root, '.y-topics')
  return { root, entry, store, published: join(store, generation) }
}
async function reservationPath(store: string) {
  return join(store, (await fs.readdir(store)).find(name => name.startsWith('.reservation-'))!)
}
function reservationName(value: { manifest: { generation: string }; pid: number; owner: string; stage: string }) {
  return `.reservation-${value.manifest.generation}.${value.pid}.${value.owner}.${value.stage.slice(7)}.json`
}
async function changeReservation(marker: string, update: { pid?: number; owner?: string }) {
  const value = JSON.parse(await fs.readFile(marker, 'utf8')) as { manifest: { generation: string }; pid: number; owner: string; stage: string }
  Object.assign(value, update)
  const changed = join(dirname(marker), reservationName(value))
  await fs.rename(marker, changed)
  await fs.writeFile(changed, `${JSON.stringify(value)}\n`)
  return changed
}
async function stoppedStage(f: Awaited<ReturnType<typeof fixture>>) {
  const rename = vi.spyOn(fs, 'rename').mockRejectedValue(new Error('Fixture interrupted before publication'))
  const unlink = vi.spyOn(fs, 'unlink').mockRejectedValue(new Error('Fixture stopped before cleanup'))
  try {
    await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('publication and owned-stage cleanup failed')
  } finally { rename.mockRestore(); unlink.mockRestore() }
  const marker = await reservationPath(f.store)
  const raw = await fs.readFile(marker, 'utf8')
  const stage = (await fs.readdir(f.store)).find(name => name.startsWith('.stage-'))!
  expect(await fs.readdir(f.store)).toHaveLength(2)
  return { marker, raw, stage: join(f.store, stage) }
}

const exactOriginal = '---\nname: Relative source\ndescription: Retain exact source\n---\n\n# Relative source\n\nRead [the guide](../../guide.md#install).\n\n## Procedure\n\n'
  + Array.from({ length: 101 }, (_, index) => `Step ${index} retains exact bytes.\n\n`).join('')
  + '```text\nKeep trailing bytes and relative links.\n```\n最后一行'
function splitPlan(original: string) {
  const plan = planMarkdownSplit(original, 'SKILL.md')
  expect(plan.kind).toBe('split')
  if (plan.kind !== 'split') throw new Error('Fixture must produce a deterministic split')
  return plan
}
function projectionFiles(original: string, raw: string) {
  const split = original.indexOf('# Procedure')
  const boundary = split < 0 ? 0 : split
  return [
    { path: 'topics/procedure.md', content: '# Procedure\n\nSee the guide.\n' },
    { path: 'source/0000.txt', content: original.slice(0, boundary) },
    { path: 'source/0001.txt', content: original.slice(boundary) },
    { path: 'entry.txt', content: raw },
  ]
}
async function sourceProjection(newEntry = false) {
  const f = await fixture()
  const plan = splitPlan(exactOriginal)
  const id = plan.generation
  const raw = plan.after
  if (newEntry) await fs.unlink(f.entry)
  await ensureMarkdownGeneration(f.entry, id, plan.files, { newEntry })
  await fs.writeFile(f.entry, raw, { flag: newEntry ? 'wx' : 'w', mode: 0o600 })
  return { ...f, id, raw, published: join(f.store, id) }
}

describe('immutable Markdown generations', () => {
  it('requires an existing entry unless the caller explicitly owns new bundle creation', async () => {
    const f = await fixture()
    await fs.unlink(f.entry)
    await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('source entry is missing')
    expect(await fs.readdir(f.root)).toEqual([])
    await ensureMarkdownGeneration(f.entry, generation, children, { newEntry: true })
    expect(await fs.readdir(f.root)).toEqual(['.y-topics'])
    expect(await fs.readdir(f.store)).toEqual([generation])
    for (const child of children) expect(await fs.readFile(join(f.published, child.path), 'utf8')).toBe(child.content)
  })

  it('refuses an existing source collision when publishing for new bundle creation', async () => {
    const f = await fixture()
    await expect(ensureMarkdownGeneration(f.entry, generation, children, { newEntry: true })).rejects.toThrow('new source entry already exists')
    expect(await fs.readFile(f.entry, 'utf8')).toBe(sourceText)
    expect(await fs.readdir(f.root)).toEqual(['SKILL.md'])
  })

  it('publishes nested complete files beside an untouched source and reuses their bytes', async () => {
    const f = await fixture()
    await ensureMarkdownGeneration(f.entry, generation, children)
    const before = await fs.stat(join(f.published, 'overview.md'))
    await ensureMarkdownGeneration(f.entry, generation, [...children].reverse())
    expect(await fs.readFile(f.entry, 'utf8')).toBe(sourceText)
    expect(await fs.readdir(f.store)).toEqual([generation])
    for (const child of children) expect(await fs.readFile(join(f.published, child.path), 'utf8')).toBe(child.content)
    const after = await fs.stat(join(f.published, 'overview.md'))
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs])
    if (process.platform !== 'win32') {
      for (const path of [f.store, f.published, join(f.published, 'topics'), join(f.published, 'topics/deep')]) {
        expect((await fs.stat(path)).mode & 0o777).toBe(0o700)
      }
      for (const path of [join(f.published, '.manifest.json'), ...children.map(child => join(f.published, child.path))]) {
        expect((await fs.stat(path)).mode & 0o777).toBe(0o600)
      }
    }
  })

  it('preserves deterministic reuse after the bundle directory is renamed or the source is revised', async () => {
    const f = await fixture()
    await ensureMarkdownGeneration(f.entry, generation, children)
    const moved = join(f.root, 'renamed-bundle')
    await fs.mkdir(moved, { mode: 0o700 })
    await fs.rename(f.entry, join(moved, 'SKILL.md'))
    await fs.rename(f.store, join(moved, '.y-topics'))
    await fs.writeFile(join(moved, 'SKILL.md'), '# Revised entry\n')
    await ensureMarkdownGeneration(join(moved, 'SKILL.md'), generation, children)
    expect(await fs.readFile(join(moved, 'SKILL.md'), 'utf8')).toBe('# Revised entry\n')
    expect(await fs.readdir(join(moved, '.y-topics'))).toEqual([generation])
  })

  it('retains eight generations and refuses growth while allowing an existing retry', async () => {
    const f = await fixture()
    const generations = Array.from({ length: 8 }, (_, index) => createHash('sha256').update(`source-${index}`).digest('hex'))
    for (const id of generations) await ensureMarkdownGeneration(f.entry, id, children)
    await ensureMarkdownGeneration(f.entry, generations[0]!, children)
    await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('eight generations')
    expect((await fs.readdir(f.store)).sort()).toEqual([...generations].sort())
    expect(await fs.readFile(f.entry, 'utf8')).toBe(sourceText)
  })

  it('accounts for the retention bound separately for each source basename', async () => {
    const f = await fixture()
    for (let index = 0; index < 8; index++) {
      await ensureMarkdownGeneration(f.entry, createHash('sha256').update(String(index)).digest('hex'), children)
    }
    const other = join(f.root, 'OTHER.md')
    await fs.writeFile(other, '# Other source\n', { mode: 0o600 })
    await ensureMarkdownGeneration(other, generation, children)
    await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('existing generation differs')
  })

  it('checks all 64 complete children and rejects excessive file, line, or byte totals before staging', async () => {
    const f = await fixture()
    const maximum = Array.from({ length: 64 }, (_, index) => ({ path: `${index}.md`, content: 'x\n'.repeat(MARKDOWN_SCREEN_CAP) }))
    await ensureMarkdownGeneration(f.entry, generation, maximum)
    expect(await fs.readdir(f.published)).toHaveLength(65)
    const invalid = [
      [...maximum, { path: 'extra.md', content: '' }],
      [{ path: 'lines.md', content: 'x\n'.repeat(MARKDOWN_SCREEN_CAP + 1) }],
      [{ path: 'bytes.md', content: '界'.repeat(Math.floor(MARKDOWN_BYTE_CAP / 3)) + 'aa' }],
    ]
    for (const files of invalid) {
      await expect(ensureMarkdownGeneration(f.entry, 'b'.repeat(64), files)).rejects.toThrow()
      expect(await fs.readdir(f.store)).toEqual([generation])
    }
    const exactBytes = '界'.repeat(Math.floor(MARKDOWN_BYTE_CAP / 3)) + 'a'
    expect(Buffer.byteLength(exactBytes)).toBe(MARKDOWN_BYTE_CAP)
    await ensureMarkdownGeneration(f.entry, 'c'.repeat(64), [{ path: 'exact.md', content: exactBytes }])
  })

  it.each([
    '../escape.md', '/absolute.md', 'nested/../../escape.md', 'nested\\escape.md', 'nested//topic.md',
    './topic.md', '.manifest.json', '.MANIFEST.JSON/nested.md', 'NUL.md', 'topic.md ',
    `${'nested/'.repeat(16)}topic.md`, `${'x'.repeat(1025)}.md`,
  ])('rejects unsafe or unbounded relative path %s without creating the store', async (path) => {
    const f = await fixture()
    await expect(ensureMarkdownGeneration(f.entry, generation, [{ path, content: '' }])).rejects.toThrow('invalid relative child path')
    expect(await fs.readdir(f.root)).toEqual(['SKILL.md'])
  })

  it.each([
    ['topic.md', 'topic.md'], ['Topic.md', 'topic.md'], ['topics', 'topics/topic.md'], ['Topics/a.md', 'topics/b.md'],
  ])('rejects colliding child paths %s and %s', async (first, second) => {
    const f = await fixture()
    await expect(ensureMarkdownGeneration(f.entry, generation, [first, second].map(path => ({ path, content: '' })))).rejects.toThrow()
    expect(await fs.readdir(f.root)).toEqual(['SKILL.md'])
  })

  it.each(['bad', 'A'.repeat(64), '../' + 'a'.repeat(64)])('refuses invalid generation identity %s', async (id) => {
    const f = await fixture()
    await expect(ensureMarkdownGeneration(f.entry, id, children)).rejects.toThrow('lowercase SHA256')
    expect(await fs.readdir(f.root)).toEqual(['SKILL.md'])
  })

  it('refuses changed bytes, changed manifests and a different deterministic plan', async () => {
    const f = await fixture()
    await ensureMarkdownGeneration(f.entry, generation, children)
    const path = join(f.published, 'overview.md')
    await fs.writeFile(path, children[0]!.content.replace('Overview', 'OVERVIEW'))
    await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('bytes or hash')
    expect(await fs.readFile(path, 'utf8')).toContain('OVERVIEW')
    await fs.writeFile(path, children[0]!.content)
    await expect(ensureMarkdownGeneration(f.entry, generation, [{ path: 'different.md', content: '' }])).rejects.toThrow('existing generation differs')
    const manifestPath = join(f.published, '.manifest.json')
    const manifest = await fs.readFile(manifestPath, 'utf8')
    await fs.writeFile(manifestPath, manifest.replace('"bytes":', '"edited":true,"bytes":'))
    await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('manifest was changed')
    expect(await fs.readFile(f.entry, 'utf8')).toBe(sourceText)
  })

  it.each(['missing', 'extra-file', 'extra-directory', 'empty-target'])('refuses %s resources without replacing user files', async (kind) => {
    const f = await fixture()
    if (kind === 'empty-target') {
      await fs.mkdir(f.store, { mode: 0o700 })
      await fs.mkdir(f.published, { mode: 0o700 })
    } else {
      await ensureMarkdownGeneration(f.entry, generation, children)
      if (kind === 'missing') await fs.unlink(join(f.published, 'overview.md'))
      if (kind === 'extra-file') await fs.writeFile(join(f.published, 'user.md'), 'User resource', { mode: 0o600 })
      if (kind === 'extra-directory') await fs.mkdir(join(f.published, 'user-directory'), { mode: 0o700 })
    }
    await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow()
    expect(await fs.readdir(f.store)).toEqual([generation])
    if (kind === 'empty-target') expect(await fs.readdir(f.published)).toEqual([])
    if (kind === 'extra-file') expect(await fs.readFile(join(f.published, 'user.md'), 'utf8')).toBe('User resource')
  })

  it('refuses an incomplete earlier generation before admitting a different one', async () => {
    const f = await fixture()
    await ensureMarkdownGeneration(f.entry, generation, children)
    await fs.unlink(join(f.published, 'overview.md'))
    await expect(ensureMarkdownGeneration(f.entry, 'a'.repeat(64), children)).rejects.toThrow('partially published')
    expect(await fs.readdir(f.store)).toEqual([generation])
  })

  it('cleans repeated write and publication failures without changing the source or accumulating stages', async () => {
    const f = await fixture()
    const write = fs.writeFile.bind(fs)
    const failure = vi.spyOn(fs, 'writeFile').mockImplementation(async (path, data, options) => {
      if (typeof path === 'string' && path.endsWith('topic.md')) throw new Error('Fixture failed child write')
      return write(path, data, options)
    })
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('failed child write')
        expect(await fs.readdir(f.store)).toEqual([])
      }
    } finally { failure.mockRestore() }
    const publication = vi.spyOn(fs, 'rename').mockRejectedValue(new Error('Fixture failed rename'))
    try {
      await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('failed rename')
      expect(await fs.readdir(f.store)).toEqual([])
    } finally { publication.mockRestore() }
    expect(await fs.readFile(f.entry, 'utf8')).toBe(sourceText)
    await ensureMarkdownGeneration(f.entry, generation, children)
  })

  it('recovers an unchanged interrupted stage and verifies completed generations on every retry', async () => {
    const f = await fixture()
    const orphan = await stoppedStage(f)
    await fs.writeFile(join(orphan.stage, 'overview.md'), children[0]!.content.slice(0, 5))
    await ensureMarkdownGeneration(f.entry, generation, children)
    await ensureMarkdownGeneration(f.entry, generation, children)
    expect(await fs.readdir(f.store)).toEqual([generation])
    expect(await fs.readFile(join(f.published, 'overview.md'), 'utf8')).toBe(children[0]!.content)
  })

  it('recovers a stopped process reservation with the exact expected manifest', async () => {
    const f = await fixture()
    const orphan = await stoppedStage(f)
    await changeReservation(orphan.marker, { pid: 2147483647, owner: randomUUID() })
    await ensureMarkdownGeneration(f.entry, generation, children)
    expect(await fs.readdir(f.store)).toEqual([generation])
  })

  it.each([
    ['reservation', 0], ['reservation', 10], ['manifest', 0], ['manifest', 10],
  ] as const)('cleans a %s write that creates only %s expected bytes before failing', async (kind, length) => {
    const f = await fixture()
    const write = fs.writeFile.bind(fs)
    const interrupted = vi.spyOn(fs, 'writeFile').mockImplementation(async (path, data, options) => {
      if (typeof path === 'string' && (kind === 'reservation' ? basename(path).startsWith('.reservation-') : basename(path) === '.manifest.json')) {
        if (typeof data !== 'string' && !(data instanceof Uint8Array)) throw new Error('Fixture metadata must contain text bytes')
        const bytes = typeof data === 'string' ? Buffer.from(data) : data
        await write(path, bytes.subarray(0, length), options)
        throw Object.assign(new Error('Fixture interrupted partial metadata write'), { code: 'ENOSPC' })
      }
      return write(path, data, options)
    })
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('partial metadata write')
        expect(await fs.readdir(f.store)).toEqual([])
      }
    } finally { interrupted.mockRestore() }
    await ensureMarkdownGeneration(f.entry, generation, children)
    expect(await fs.readdir(f.store)).toEqual([generation])
    expect(await fs.readFile(f.entry, 'utf8')).toBe(sourceText)
  })

  it.each([
    ['reservation', 0], ['reservation', 10], ['manifest', 0], ['manifest', 10],
  ] as const)('recovers a stopped publisher with a %s prefix of %s bytes', async (kind, length) => {
    const f = await fixture()
    const orphan = await stoppedStage(f)
    const marker = await changeReservation(orphan.marker, { pid: 2147483647, owner: randomUUID() })
    const target = kind === 'reservation' ? marker : join(orphan.stage, '.manifest.json')
    await fs.writeFile(target, (await fs.readFile(target)).subarray(0, length))
    await ensureMarkdownGeneration(f.entry, generation, children)
    expect(await fs.readdir(f.store)).toEqual([generation])
    for (const child of children) expect(await fs.readFile(join(f.published, child.path), 'utf8')).toBe(child.content)
  })

  it('preserves divergent metadata and refuses an encoded out-of-range process identity', async () => {
    const f = await fixture()
    const orphan = await stoppedStage(f)
    const marker = await changeReservation(orphan.marker, { pid: 2147483647, owner: randomUUID() })
    await fs.writeFile(marker, '{"user":true}\n')
    await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('interrupted stage differs')
    expect(await fs.readFile(marker, 'utf8')).toBe('{"user":true}\n')
    const invalid = marker.replace('.2147483647.', '.2147483648.')
    await fs.rename(marker, invalid)
    await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('invalid staging reservation name')
    expect(await fs.readFile(invalid, 'utf8')).toBe('{"user":true}\n')
  })

  it('refuses more than eight outstanding reservations before adding or deleting anything', async () => {
    const f = await fixture()
    await fs.mkdir(f.store, { mode: 0o700 })
    for (let index = 0; index < 9; index++) {
      const name = reservationName({ manifest: { generation }, pid: 2147483647, owner: randomUUID(), stage: `.stage-${randomUUID()}` })
      await fs.writeFile(join(f.store, name), '', { flag: 'wx', mode: 0o600 })
    }
    const before = (await fs.readdir(f.store)).sort()
    await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('eight outstanding')
    expect((await fs.readdir(f.store)).sort()).toEqual(before)
  })

  it('preserves edited or differently requested interrupted stages and keeps outstanding work bounded', async () => {
    const f = await fixture()
    const orphan = await stoppedStage(f)
    await expect(ensureMarkdownGeneration(f.entry, 'a'.repeat(64), children)).rejects.toThrow('interrupted stage differs')
    const edited = join(orphan.stage, 'overview.md')
    await fs.writeFile(edited, 'User edits')
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('bytes or hash')
      expect(await fs.readdir(f.store)).toHaveLength(2)
    }
    expect(await fs.readFile(edited, 'utf8')).toBe('User edits')
    expect(await fs.readFile(orphan.marker, 'utf8')).toBe(orphan.raw)
  })

  it('refuses unreserved stages instead of deleting unknown material', async () => {
    const f = await fixture()
    await fs.mkdir(f.store, { mode: 0o700 })
    const stage = `.stage-${randomUUID()}`
    await fs.mkdir(join(f.store, stage), { mode: 0o700 })
    await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('unexpected resource')
    expect(await fs.readdir(f.store)).toEqual([stage])
  })

  it('preserves an invalid staging reservation instead of claiming or deleting it', async () => {
    const f = await fixture()
    await fs.mkdir(f.store, { mode: 0o700 })
    const marker = join(f.store, '.reservation-invalid.json')
    await fs.writeFile(marker, '{}\n', { mode: 0o600 })
    await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('invalid staging reservation')
    expect(await fs.readFile(marker, 'utf8')).toBe('{}\n')
  })

  it('preserves partial stage resources when their manifest has been removed', async () => {
    const f = await fixture()
    const orphan = await stoppedStage(f)
    await fs.unlink(join(orphan.stage, '.manifest.json'))
    await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('resources without its manifest')
    expect(await fs.readFile(join(orphan.stage, 'overview.md'), 'utf8')).toBe(children[0]!.content)
    expect(await fs.readFile(orphan.marker, 'utf8')).toBe(orphan.raw)
  })

  it('preserves a stage whose canonical manifest was changed', async () => {
    const f = await fixture()
    const orphan = await stoppedStage(f)
    const path = join(orphan.stage, '.manifest.json')
    const manifest = JSON.parse(await fs.readFile(path, 'utf8')) as { source: string }
    manifest.source = 'OTHER.md'
    const edited = `${JSON.stringify(manifest)}\n`
    await fs.writeFile(path, edited)
    await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('manifest differs from expected')
    expect(await fs.readFile(path, 'utf8')).toBe(edited)
  })

  it('refuses a canonical manifest changed while its complete stage is being written', async () => {
    const f = await fixture()
    const write = fs.writeFile.bind(fs)
    const changed = vi.spyOn(fs, 'writeFile').mockImplementation(async (path, data, options) => {
      if (typeof path === 'string' && basename(path) === '.manifest.json') {
        if (typeof data !== 'string' && !(data instanceof Uint8Array)) throw new Error('Fixture metadata must contain text bytes')
        const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
        const value: unknown = JSON.parse(text)
        if (typeof value !== 'object' || value === null || !('source' in value) || typeof value.source !== 'string') {
          throw new Error('Fixture manifest must name its source')
        }
        value.source = 'OTHER.md'
        return write(path, `${JSON.stringify(value)}\n`, options)
      }
      return write(path, data, options)
    })
    try {
      const error = await ensureMarkdownGeneration(f.entry, generation, children).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors[0]).toHaveProperty('message', expect.stringContaining('manifest differs from expected'))
    } finally { changed.mockRestore() }
    expect(await fs.readdir(f.store)).not.toContain(generation)
    const stage = (await fs.readdir(f.store)).find(name => name.startsWith('.stage-'))!
    expect(await fs.readFile(join(f.store, stage, '.manifest.json'), 'utf8')).toContain('OTHER.md')
  })

  it('preserves an externally edited reservation after successful publication', async () => {
    const f = await fixture()
    const rename = fs.rename.bind(fs)
    const edited = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to)
      const marker = await reservationPath(f.store)
      const raw = await fs.readFile(marker, 'utf8')
      await fs.writeFile(marker, 'x' + raw.slice(1))
    })
    try { await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('staging reservation was changed') } finally { edited.mockRestore() }
    expect((await fs.readFile(await reservationPath(f.store), 'utf8')).startsWith('x')).toBe(true)
    expect(await fs.readFile(join(f.published, 'overview.md'), 'utf8')).toBe(children[0]!.content)
  })

  it('refuses recovery when another process ownership cannot be checked', async () => {
    const f = await fixture()
    const orphan = await stoppedStage(f)
    await changeReservation(orphan.marker, { owner: randomUUID() })
    const denied = Object.assign(new Error('Fixture process permission denied'), { code: 'EPERM' })
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw denied })
    try { await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('process permission denied') } finally { kill.mockRestore() }
    expect(await fs.readFile(join(orphan.stage, 'overview.md'), 'utf8')).toBe(children[0]!.content)
  })

  it('refuses a store with nine externally introduced complete generations without pruning them', async () => {
    const f = await fixture()
    const ids = Array.from({ length: 8 }, (_, index) => createHash('sha256').update(String(index)).digest('hex'))
    for (const id of ids) await ensureMarkdownGeneration(f.entry, id, children)
    const extra = join(f.store, generation)
    await fs.cp(join(f.store, ids[0]!), extra, { recursive: true })
    const marker = join(extra, '.manifest.json')
    const manifest = JSON.parse(await fs.readFile(marker, 'utf8')) as { generation: string }
    manifest.generation = generation
    await fs.writeFile(marker, `${JSON.stringify(manifest)}\n`)
    await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('more than eight')
    expect(await fs.readdir(f.store)).toHaveLength(9)
  })

  it.each(['source-read', 'store-create', 'reservation-create'])('surfaces %s permission failures without root mutations', async (location) => {
    const f = await fixture()
    const denied = Object.assign(new Error('Fixture permission denied'), { code: 'EACCES' })
    if (location === 'source-read') {
      const original = fs.lstat.bind(fs)
      vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
        if (path === f.entry) throw denied
        return original(path, options)
      })
    } else if (location === 'store-create') {
      vi.spyOn(fs, 'mkdir').mockRejectedValue(denied)
    } else {
      vi.spyOn(fs, 'writeFile').mockRejectedValue(denied)
    }
    await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('permission denied')
    expect(await fs.readFile(f.entry, 'utf8')).toBe(sourceText)
    vi.restoreAllMocks()
    if (location === 'reservation-create') expect(await fs.readdir(f.store)).toEqual([])
    else expect(await fs.readdir(f.root)).toEqual(['SKILL.md'])
  })

  it('reports cleanup failure after complete publication and recovers the leftover reservation', async () => {
    const f = await fixture()
    const unlink = vi.spyOn(fs, 'unlink').mockRejectedValue(new Error('Fixture failed reservation cleanup'))
    try {
      await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('failed reservation cleanup')
    } finally { unlink.mockRestore() }
    expect(await fs.readdir(f.store)).toHaveLength(2)
    expect(await fs.readdir(f.store)).toContain(generation)
    for (const child of children) expect(await fs.readFile(join(f.published, child.path), 'utf8')).toBe(child.content)
    await ensureMarkdownGeneration(f.entry, generation, children)
    expect(await fs.readdir(f.store)).toEqual([generation])
  })

  it('refuses a destination created after staging without replacing the empty user directory', async () => {
    const f = await fixture()
    const lstat = fs.lstat.bind(fs)
    let sourceChecks = 0
    const insert = vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
      const info = await lstat(path, options)
      if (path === f.entry && ++sourceChecks === 2) await fs.mkdir(f.published, { mode: 0o700 })
      return info
    })
    try { await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('publication destination already exists') } finally { insert.mockRestore() }
    expect(await fs.readdir(f.published)).toEqual([])
    expect(await fs.readdir(f.store)).toEqual([generation])
  })

  it('refuses store identity changes during publication', async () => {
    const f = await fixture()
    const lstat = fs.lstat.bind(fs)
    let checks = 0
    let changed = false
    const replace = vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
      const info = await lstat(path, options)
      if (path === f.store && ++checks === 2) { info.ino = info.ino === 0 ? 1 : 0; changed = true }
      return info
    })
    try { await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('store changed during publication') } finally { replace.mockRestore() }
    expect(changed).toBe(true)
    expect(await fs.readdir(f.store)).toEqual([])
    expect(await fs.readFile(f.entry, 'utf8')).toBe(sourceText)
  })

  it('publishes only complete directories and keeps a concurrent caller from removing an active stage', async () => {
    const f = await fixture()
    const rename = fs.rename.bind(fs)
    let release: () => void = () => { }
    let entered: () => void = () => { }
    const gate = new Promise<void>((resolve) => { release = resolve })
    const atRename = new Promise<void>((resolve) => { entered = resolve })
    const pause = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      entered()
      await gate
      return rename(from, to)
    })
    const pending = ensureMarkdownGeneration(f.entry, generation, children)
    try {
      await atRename
      const names = await fs.readdir(f.store)
      expect(names).not.toContain(generation)
      const stage = names.find(name => name.startsWith('.stage-'))!
      for (const child of children) expect(await fs.readFile(join(f.store, stage, child.path), 'utf8')).toBe(child.content)
      await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('another publisher')
      expect(await fs.readdir(f.store)).toEqual(names)
      expect(await fs.readFile(f.entry, 'utf8')).toBe(sourceText)
    } finally { release(); await pending; pause.mockRestore() }
    expect(await fs.readdir(f.store)).toEqual([generation])
  })

  it('detects a peer that reserved between the empty startup scan and its own reservation write', async () => {
    const f = await fixture()
    const write = fs.writeFile.bind(fs)
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    let enteredFirst!: () => void
    let enteredSecond!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
    const atFirst = new Promise<void>((resolve) => { enteredFirst = resolve })
    const atSecond = new Promise<void>((resolve) => { enteredSecond = resolve })
    let markers = 0
    const pause = vi.spyOn(fs, 'writeFile').mockImplementation(async (path, data, options) => {
      if (typeof path !== 'string' || !basename(path).startsWith('.reservation-')) return write(path, data, options)
      if (++markers === 1) { enteredFirst(); await firstGate; return write(path, data, options) }
      await write(path, data, options)
      enteredSecond()
      await secondGate
    })
    const first = ensureMarkdownGeneration(f.entry, generation, children)
    await atFirst
    const second = ensureMarkdownGeneration(f.entry, generation, children)
    try {
      await atSecond
      releaseFirst()
      await expect(first).rejects.toThrow('another publisher still owns a staging reservation')
      expect(await fs.readdir(f.store)).toHaveLength(1)
      releaseSecond()
      await second
    } finally { releaseFirst(); releaseSecond(); await Promise.allSettled([first, second]); pause.mockRestore() }
    expect(await fs.readdir(f.store)).toEqual([generation])
  })

  it('never unlinks a successor reservation when two callers recover the same stopped marker', async () => {
    const f = await fixture()
    const failedCleanup = vi.spyOn(fs, 'unlink').mockRejectedValue(new Error('Fixture retains completed reservation'))
    try { await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('retains completed reservation') } finally { failedCleanup.mockRestore() }
    const oldMarker = await reservationPath(f.store)
    const unlink = fs.unlink.bind(fs)
    const write = fs.writeFile.bind(fs)
    let releaseRecovery!: () => void
    let releaseSuccessor!: () => void
    let enteredRecovery!: () => void
    let enteredSuccessor!: () => void
    const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve })
    const successorGate = new Promise<void>((resolve) => { releaseSuccessor = resolve })
    const atRecovery = new Promise<void>((resolve) => { enteredRecovery = resolve })
    const atSuccessor = new Promise<void>((resolve) => { enteredSuccessor = resolve })
    let intercepted = false
    const pauseUnlink = vi.spyOn(fs, 'unlink').mockImplementation(async (path) => {
      if (path === oldMarker && !intercepted) { intercepted = true; enteredRecovery(); await recoveryGate }
      return unlink(path)
    })
    const pauseWrite = vi.spyOn(fs, 'writeFile').mockImplementation(async (path, data, options) => {
      await write(path, data, options)
      if (typeof path === 'string' && basename(path).startsWith('.reservation-')) { enteredSuccessor(); await successorGate }
    })
    const recovering = ensureMarkdownGeneration(f.entry, generation, children)
    await atRecovery
    const successor = ensureMarkdownGeneration(f.entry, generation, children)
    try {
      await atSuccessor
      const newMarker = await reservationPath(f.store)
      expect(newMarker).not.toBe(oldMarker)
      releaseRecovery()
      await expect(recovering).rejects.toThrow('ENOENT')
      expect(await fs.readFile(newMarker, 'utf8')).toContain(generation)
      releaseSuccessor()
      await successor
    } finally {
      releaseRecovery(); releaseSuccessor()
      await Promise.allSettled([recovering, successor])
      pauseUnlink.mockRestore(); pauseWrite.mockRestore()
    }
    expect(await fs.readdir(f.store)).toEqual([generation])
    expect(await fs.readFile(f.entry, 'utf8')).toBe(sourceText)
  })

  it.skipIf(process.platform === 'win32')('refuses symlink sources, store roots, metadata, and nested resources', async () => {
    for (const location of ['source', 'store', 'metadata', 'child', 'directory', 'reservation']) {
      const f = await fixture()
      const outside = join(f.root, 'outside')
      await fs.mkdir(outside, { mode: 0o700 })
      const outsideFile = join(outside, 'user.md')
      await fs.writeFile(outsideFile, 'User-owned target', { mode: 0o600 })
      if (location === 'source') {
        await fs.unlink(f.entry); await fs.symlink(outsideFile, f.entry)
      } else if (location === 'store') {
        await fs.symlink(outside, f.store)
      } else if (location === 'reservation') {
        const name = reservationName({ manifest: { generation }, pid: process.pid, owner: randomUUID(), stage: `.stage-${randomUUID()}` })
        await fs.mkdir(f.store, { mode: 0o700 }); await fs.symlink(outsideFile, join(f.store, name))
      } else {
        await ensureMarkdownGeneration(f.entry, generation, children)
        const target = location === 'metadata' ? join(f.published, '.manifest.json')
          : location === 'child' ? join(f.published, 'overview.md') : join(f.published, 'topics')
        await fs.rm(target, { recursive: true })
        await fs.symlink(location === 'directory' ? outside : outsideFile, target)
      }
      await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('refusing links')
      expect(await fs.readFile(outsideFile, 'utf8')).toBe('User-owned target')
    }
  })

  it.skipIf(process.platform === 'win32')('refuses non-private or differently owned managed endpoints', async () => {
    const f = await fixture()
    await ensureMarkdownGeneration(f.entry, generation, children)
    await fs.chmod(join(f.published, 'overview.md'), 0o644)
    await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('owner-only')
    await fs.chmod(join(f.published, 'overview.md'), 0o600)
    const lstat = fs.lstat.bind(fs)
    const owner = vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
      const info = await lstat(path, options)
      if (typeof path === 'string' && basename(path) === 'overview.md') info.uid = (process.getuid?.() ?? 0) + 1
      return info
    })
    try { await expect(ensureMarkdownGeneration(f.entry, generation, children)).rejects.toThrow('wrong file owner') } finally { owner.mockRestore() }
  })
})

describe('exact generated Markdown source projection', () => {
  it('restores original relative links, frontmatter, and terminal bytes without writes', async () => {
    const f = await sourceProjection()
    const write = vi.spyOn(fs, 'writeFile')
    const mkdir = vi.spyOn(fs, 'mkdir')
    const rename = vi.spyOn(fs, 'rename')
    const unlink = vi.spyOn(fs, 'unlink')
    expect(await readMarkdownSource(f.entry, f.raw)).toBe(exactOriginal)
    expect(await fs.readFile(f.entry, 'utf8')).toBe(f.raw)
    expect(write).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
    expect(rename).not.toHaveBeenCalled()
    expect(unlink).not.toHaveBeenCalled()
  })

  it('refuses store identity changes during read-only source verification', async () => {
    const f = await sourceProjection()
    const lstat = fs.lstat.bind(fs)
    let checks = 0
    const replace = vi.spyOn(fs, 'lstat').mockImplementation(async (path, options) => {
      const info = await lstat(path, options)
      if (path === f.store && ++checks === 2) info.ino++
      return info
    })
    try { await expect(readMarkdownSource(f.entry, f.raw)).rejects.toThrow('store changed during source verification') } finally { replace.mockRestore() }
    expect(await fs.readFile(f.entry, 'utf8')).toBe(f.raw)
  })

  it('refuses a stored file replaced between lstat and opening its read handle', async () => {
    const f = await sourceProjection()
    const target = join(f.published, 'entry.txt')
    const open = fs.open.bind(fs)
    let replaced = false
    const race = vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (path === target && !replaced) {
        replaced = true
        await fs.rename(target, join(f.root, 'original-entry.txt'))
        await fs.writeFile(target, f.raw, { mode: 0o600 })
      }
      return open(path, flags, mode)
    })
    try { await expect(readMarkdownSource(f.entry, f.raw)).rejects.toThrow('file changed during verification') } finally { race.mockRestore() }
    expect(await fs.readFile(target, 'utf8')).toBe(f.raw)
  })

  it('refuses a stored file that grows after its handle size was checked', async () => {
    const f = await sourceProjection()
    const target = join(f.published, 'entry.txt')
    const open = fs.open.bind(fs)
    const reads: ReturnType<typeof spyOnRead>[] = []
    const added = 'x'.repeat(2 * 1024 * 1024)
    const race = vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await open(path, flags, mode)
      if (path === target) {
        const stat = handle.stat.bind(handle)
        vi.spyOn(handle, 'stat').mockImplementation(async (options) => {
          const before = await stat(options)
          await fs.appendFile(target, added)
          return before
        })
        reads.push(spyOnRead(handle))
      }
      return handle
    })
    try { await expect(readMarkdownSource(f.entry, f.raw)).rejects.toThrow('byte limit') } finally { race.mockRestore() }
    expect(await fs.readFile(target, 'utf8')).toBe(f.raw + added)
    expect(reads[0]!.mock.calls).toHaveLength(1)
    expect(reads[0]!.mock.calls[0]).toEqual([expect.any(Buffer), 0, Buffer.byteLength(f.raw) + 1, null])
    expect(reads[0]!.mock.calls[0]![0]).toHaveProperty('length', Buffer.byteLength(f.raw) + 1)
    await expect(reads[0]!.mock.results[0]!.value).resolves.toHaveProperty('bytesRead', Buffer.byteLength(f.raw) + 1)
  })

  it('returns undefined for an ordinary entry without reading or creating generated resources', async () => {
    const f = await fixture()
    expect(await readMarkdownSource(f.entry, sourceText)).toBeUndefined()
    expect(await fs.readdir(f.root)).toEqual(['SKILL.md'])
  })

  it.each([
    '`[Example](.y-topics/not-a-generation/topics/a.md)`',
    '``[Example](.y-topics/not-a-generation/topics/a.md) ` literal``',
    '`multi-line\n[Example](.y-topics/not-a-generation/topics/a.md)`',
    '```markdown\n[Example](.y-topics/not-a-generation/topics/a.md)\n```\n',
    '~~~~markdown\n[Example](.y-topics/not-a-generation/topics/a.md)\n~~~~~\n',
    '    [Example](.y-topics/not-a-generation/topics/a.md)\n',
    '\t[Example](.y-topics/not-a-generation/topics/a.md)\n',
    '> ```markdown\n> [Example](.y-topics/not-a-generation/topics/a.md)\n> ```\n',
    '- ```markdown\n  [Example](.y-topics/not-a-generation/topics/a.md)\n  ```\n',
    String.raw`\[Example](.y-topics/not-a-generation/topics/a.md)`,
    String.raw`Text \](.y-topics/not-a-generation/topics/a.md)`,
    String.raw`[Example\](.y-topics/not-a-generation/topics/a.md)`,
    '](.y-topics/not-a-generation/topics/a.md)',
    '[unmatched bracket\n\n](.y-topics/not-a-generation/topics/a.md)',
    '---\nname: example\ndescription: "[Example](.y-topics/not-a-generation/topics/a.md)"\n---\n\nBody.\n',
    '---\r\nname: example\r\ndescription: "[Example](.y-topics/not-a-generation/topics/a.md)"\r\n---\r\n\r\nBody.\r\n',
    '---\n---',
    '[Absolute](/ordinary/.y-topics/not-a-generation/topics/a.md)',
    '[Remote](https://example.org/.y-topics/not-a-generation/topics/a.md)',
  ])('ignores literal generated-link teaching examples in code: %s', async (raw) => {
    const f = await fixture()
    expect(hasMarkdownGenerationLinks(raw)).toBe(false)
    expect(await readMarkdownSource(f.entry, raw)).toBeUndefined()
    expect(await fs.readdir(f.root)).toEqual(['SKILL.md'])
  })

  it.each([
    '```markdown\n[Example](.y-topics/fiction/topics/a.md)\n```\n[Actual](.y-topics/invalid/topics/a.md)',
    '`Unclosed code span\n\n[Actual](.y-topics/invalid/topics/a.md)',
    '\\`Escaped delimiter [Actual](.y-topics/invalid/topics/a.md)',
    String.raw`\\[Actual](.y-topics/invalid/topics/a.md)`,
    String.raw`[Nested [label\]]](.y-topics/invalid/topics/a.md)`,
    '---\nUnclosed frontmatter\n[Actual](.y-topics/invalid/topics/a.md)',
    '---\n---\n[Actual](.y-topics/invalid/topics/a.md)',
  ])('still rejects actual malformed generated claims outside literal code: %s', async (raw) => {
    const f = await fixture()
    expect(hasMarkdownGenerationLinks(raw)).toBe(true)
    await expect(readMarkdownSource(f.entry, raw)).rejects.toThrow('invalid SHA256')
  })

  it('identifies actual generated claims with no filesystem access or SHA validation', () => {
    const read = vi.spyOn(fs, 'lstat').mockRejectedValue(new Error('Inventory hints must not read the filesystem'))
    expect(hasMarkdownGenerationLinks('[Actual](.y-topics/not-a-hash/topics/topic.md)')).toBe(true)
    expect(hasMarkdownGenerationLinks('[Actual](./.y-topics/' + generation + '/topics/topic.md)')).toBe(true)
    expect(hasMarkdownGenerationLinks('[Actual](<.y-topics/' + generation + '/topics/topic.md>)')).toBe(true)
    expect(hasMarkdownGenerationLinks(String.raw`\[Example](.y-topics/not-a-hash/topics/topic.md)`)).toBe(false)
    expect(read).not.toHaveBeenCalled()
  })

  it.each([
    '[Guide](guide.md "[Example](.y-topics/not-a-hash/topics/topic.md)")',
    "[Guide](guide.md '[Example](.y-topics/not-a-hash/topics/topic.md)')",
    '[Guide](guide.md (literal [Example](.y-topics/not-a-hash/topics/topic.md)))',
    String.raw`[Guide](guide.md (literal [Example](.y-topics/not-a-hash/topics/topic.md\)))`,
    '[Guide](<guide.md> "[Example](.y-topics/not-a-hash/topics/topic.md)")',
    '[Guide](guide(with(nested)).md "[Example](.y-topics/not-a-hash/topics/topic.md)")',
    '[Guide](guide[Example](.y-topics/not-a-hash/topics/topic.md))',
    '[Guide](  guide.md  )',
    '[Guide](<guide.md>)',
    '[Reference label]',
  ])('ignores namespace examples in an ordinary link destination or title: %s', async (raw) => {
    expect(hasMarkdownGenerationLinks(raw)).toBe(false)
    expect(await readMarkdownSource('/never/selected/SKILL.md', raw)).toBeUndefined()
  })

  it.each([
    String.raw`[Guide](guide\).md "[Example](.y-topics/not-a-hash/topics/topic.md)")`,
    String.raw`[Guide](guide\(one\).md "[Example](.y-topics/not-a-hash/topics/topic.md)")`,
    String.raw`[Guide](guide\\name.md "[Example](.y-topics/not-a-hash/topics/topic.md)")`,
    String.raw`[Guide](<guide\>.md> "[Example](.y-topics/not-a-hash/topics/topic.md)")`,
    String.raw`[Guide](guide\name.md "[Example](.y-topics/not-a-hash/topics/topic.md)")`,
  ])('ignores namespace examples in titles after escaped destination punctuation: %s', async (raw) => {
    expect(hasMarkdownGenerationLinks(raw)).toBe(false)
    expect(await readMarkdownSource('/never/selected/SKILL.md', raw)).toBeUndefined()
  })

  it('still rejects a genuine generated claim following an escaped ordinary destination', async () => {
    const raw = String.raw`[Guide](guide\).md "[Example](.y-topics/not-a-hash/topics/topic.md)")`
      + '\n[Actual](.y-topics/invalid/topics/topic.md)'
    expect(hasMarkdownGenerationLinks(raw)).toBe(true)
    await expect(readMarkdownSource('/never/selected/SKILL.md', raw)).rejects.toThrow('invalid SHA256')
  })

  it.each([
    '[Unclosed angle](<unfinished\n[Actual](.y-topics/invalid/topics/a.md)',
    '[Unbalanced](unfinished(\n[Actual](.y-topics/invalid/topics/a.md)',
    '[Bad title](ordinary.md "unfinished\n[Actual](.y-topics/invalid/topics/a.md)',
    '[Plain unclosed](ordinary.md',
    '[Plain terminal escape](ordinary\\',
    '[Angle terminal escape](<ordinary\\',
  ])('keeps malformed ordinary destinations from hiding a subsequent real claim: %s', async (raw) => {
    const claimed = raw.includes('[Actual]')
    expect(hasMarkdownGenerationLinks(raw)).toBe(claimed)
    if (claimed) await expect(readMarkdownSource('/never/selected/SKILL.md', raw)).rejects.toThrow('invalid SHA256')
    else expect(await readMarkdownSource('/never/selected/SKILL.md', raw)).toBeUndefined()
  })

  it.each(['double', 'single', 'parenthesized'] as const)('round-trips a real split with a generated-looking example in a %s link title', async (kind) => {
    const f = await fixture()
    const example = '[Example](.y-topics/not-a-hash/topics/topic.md)'
    const title = kind === 'double' ? `"${example}"` : kind === 'single' ? `'${example}'` : `(literal ${example.slice(0, -1)}\\))`
    const original = '# Link titles\n\n[Guide](guide.md ' + title + ')\n\n## Steps\n\n'
      + Array.from({ length: 110 }, (_, index) => `Step ${index} retains complete source bytes.\n\n`).join('')
    expect(hasMarkdownGenerationLinks(original)).toBe(false)
    const plan = splitPlan(original)
    await ensureMarkdownGeneration(f.entry, plan.generation, plan.files)
    await fs.writeFile(f.entry, plan.after)
    expect(hasMarkdownGenerationLinks(plan.after)).toBe(true)
    expect(await readMarkdownSource(f.entry, plan.after)).toBe(original)
  })

  it.each([
    '<https://example.invalid/?q=[Example](.y-topics/not-a-hash/topics/topic.md)>',
    '<http://example.invalid/?q=[Example](.y-topics/not-a-hash/topics/topic.md)>',
    '<reader+[Example](.y-topics/not-a-hash/topics/topic.md)@example.invalid>',
  ])('round-trips a real split with a generated-looking example inside supported autolink %s', async (autolink) => {
    const f = await fixture()
    expect(hasMarkdownGenerationLinks(autolink)).toBe(false)
    expect(await readMarkdownSource('/never/selected/SKILL.md', autolink)).toBeUndefined()
    const original = '# Autolinks\n\n' + autolink + '\n\n## Steps\n\n'
      + Array.from({ length: 110 }, (_, index) => `Step ${index} retains complete source bytes.\n\n`).join('')
    const plan = splitPlan(original)
    await ensureMarkdownGeneration(f.entry, plan.generation, plan.files)
    await fs.writeFile(f.entry, plan.after)
    expect(hasMarkdownGenerationLinks(plan.after)).toBe(true)
    expect(await readMarkdownSource(f.entry, plan.after)).toBe(original)
  })

  it.each([
    '<https://example.invalid/?q=\n[Actual](.y-topics/not-a-hash/topics/topic.md)',
    '<https://example.invalid/ spaced [Actual](.y-topics/not-a-hash/topics/topic.md)>',
    '<reader@example.invalid [Actual](.y-topics/not-a-hash/topics/topic.md)>',
    String.raw`\<https://example.invalid/?q=[Actual](.y-topics/not-a-hash/topics/topic.md)>`,
  ])('does not let unsupported or literal autolink text hide actual generated claims: %s', async (raw) => {
    expect(hasMarkdownGenerationLinks(raw)).toBe(true)
    await expect(readMarkdownSource('/never/selected/SKILL.md', raw)).rejects.toThrow('invalid SHA256')
  })

  it('round-trips a real split with escaped introductory examples and generated-looking YAML metadata', async () => {
    const f = await fixture()
    const original = '---\nname: Escaped source\ndescription: "[Example](.y-topics/not-a-hash/topics/topic.md)"\n---\n\n# Escaped source\n\n'
      + String.raw`\[Example](.y-topics/not-a-hash/topics/topic.md)` + '\n\n## Steps\n\n'
      + Array.from({ length: 110 }, (_, index) => `Step ${index} preserves complete paragraph bytes.\n\n`).join('')
    expect(hasMarkdownGenerationLinks(original)).toBe(false)
    const plan = splitPlan(original)
    await ensureMarkdownGeneration(f.entry, plan.generation, plan.files)
    await fs.writeFile(f.entry, plan.after)
    expect(hasMarkdownGenerationLinks(plan.after)).toBe(true)
    expect(await readMarkdownSource(f.entry, plan.after)).toBe(original)
    expect(await fs.readFile(f.entry, 'utf8')).toBe(plan.after)
  })

  it('verifies real emitted links while preserving fenced and inline examples in the original introduction', async () => {
    const f = await fixture()
    const examples = '\n`[Inline](.y-topics/not-a-generation/topics/a.md)`\n\n'
      + '```markdown\n[Fenced](.y-topics/not-a-generation/topics/a.md)\n```\n\n'
    const original = exactOriginal.replace('## Procedure', examples + '## Procedure')
    const plan = splitPlan(original)
    await ensureMarkdownGeneration(f.entry, plan.generation, plan.files)
    await fs.writeFile(f.entry, plan.after)
    expect(await readMarkdownSource(f.entry, plan.after)).toBe(original)
  })

  it('reads a generation published before new entry creation and after the bundle is renamed', async () => {
    const f = await sourceProjection(true)
    expect(await readMarkdownSource(f.entry, f.raw)).toBe(exactOriginal)
    const moved = join(f.root, 'renamed')
    await fs.mkdir(moved, { mode: 0o700 })
    await fs.rename(f.entry, join(moved, 'SKILL.md'))
    await fs.rename(f.store, join(moved, '.y-topics'))
    expect(await readMarkdownSource(join(moved, 'SKILL.md'), f.raw)).toBe(exactOriginal)
  })

  it('rejects a root whose text differs from its exact stored entry copy', async () => {
    const f = await sourceProjection()
    const changed = f.raw.replace('# Relative source', '# Edited source')
    await fs.writeFile(f.entry, changed)
    await expect(readMarkdownSource(f.entry, changed)).rejects.toThrow('differs from stored entry.txt')
    expect(await fs.readFile(f.entry, 'utf8')).toBe(changed)
    await expect(readMarkdownSource(f.entry, f.raw + 'extra line\n'.repeat(MARKDOWN_SCREEN_CAP))).rejects.toThrow('generated entry exceeds')
  })

  it.each(['entry.txt', 'source/0000.txt', 'source/0001.txt', 'topics/001-procedure.md', '.manifest.json'])(
    'rejects changed stored %s without dropping children', async (path) => {
      const f = await sourceProjection()
      const absolute = join(f.published, path)
      const original = await fs.readFile(absolute, 'utf8')
      await fs.writeFile(absolute, original.replace(/[a-z]/, character => character.toUpperCase()))
      await expect(readMarkdownSource(f.entry, f.raw)).rejects.toThrow()
      expect(await fs.readFile(absolute, 'utf8')).not.toBe(original)
    },
  )

  it.each(['entry.txt', 'source/0001.txt', 'topics/001-procedure.md', '.manifest.json'])(
    'rejects missing stored %s', async (path) => {
      const f = await sourceProjection()
      await fs.unlink(join(f.published, path))
      await expect(readMarkdownSource(f.entry, f.raw)).rejects.toThrow()
    },
  )

  it.each(['hash', 'oversized', 'traversal', 'duplicate', 'order'])('rejects an invalid %s child manifest record', async (kind) => {
    const f = await sourceProjection()
    const path = join(f.published, '.manifest.json')
    const manifest = JSON.parse(await fs.readFile(path, 'utf8')) as { files: { path: string; bytes: number; hash: string }[] }
    if (kind === 'hash') manifest.files[0]!.hash = 'not-a-hash'
    if (kind === 'oversized') manifest.files[0]!.bytes = MARKDOWN_BYTE_CAP + 1
    if (kind === 'traversal') manifest.files[0]!.path = '../user.md'
    if (kind === 'duplicate') manifest.files.push({ ...manifest.files[0]! })
    if (kind === 'order') manifest.files.reverse()
    await fs.writeFile(path, `${JSON.stringify(manifest)}\n`)
    await expect(readMarkdownSource(f.entry, f.raw)).rejects.toThrow()
  })

  it.each(['missing-entry', 'missing-fragments'])('rejects a complete self-consistent generation with %s', async (kind) => {
    const f = await fixture()
    const plan = splitPlan(exactOriginal)
    const files = plan.files.filter(file => kind === 'missing-entry' ? file.path !== 'entry.txt' : !file.path.startsWith('source/'))
    await ensureMarkdownGeneration(f.entry, plan.generation, files)
    await fs.writeFile(f.entry, plan.after)
    await expect(readMarkdownSource(f.entry, plan.after)).rejects.toThrow(kind === 'missing-entry' ? 'entry.txt is missing' : 'must be contiguous')
  })

  it.each(['oversized', 'invalid-utf8', 'too-many-lines'])('rejects stored %s contents independently of manifest checksums', async (kind) => {
    const f = await sourceProjection()
    const target = 'topics/001-procedure.md'
    const bytes = kind === 'oversized' ? Buffer.alloc(MARKDOWN_BYTE_CAP + 1, 'x')
      : kind === 'invalid-utf8' ? Buffer.from([0x80]) : Buffer.from('x\n'.repeat(MARKDOWN_SCREEN_CAP + 1))
    await fs.writeFile(join(f.published, target), bytes)
    if (kind !== 'oversized') {
      const path = join(f.published, '.manifest.json')
      const manifest = JSON.parse(await fs.readFile(path, 'utf8')) as { files: { path: string; bytes: number; hash: string }[] }
      const record = manifest.files.find(file => file.path === target)!
      record.bytes = bytes.length
      record.hash = createHash('sha256').update(bytes).digest('hex')
      await fs.writeFile(path, `${JSON.stringify(manifest)}\n`)
    }
    await expect(readMarkdownSource(f.entry, f.raw)).rejects.toThrow(kind === 'oversized' ? 'byte limit' : 'Markdown exceeds')
  })

  it('refuses hardlinked metadata and mismatched generation identities', async () => {
    const f = await sourceProjection()
    const path = join(f.published, '.manifest.json')
    const link = join(f.root, 'linked-manifest.json')
    await fs.link(path, link)
    await expect(readMarkdownSource(f.entry, f.raw)).rejects.toThrow('linked metadata')
    await fs.unlink(link)
    const manifest = JSON.parse(await fs.readFile(path, 'utf8')) as { generation: string }
    manifest.generation = 'b'.repeat(64)
    await fs.writeFile(path, `${JSON.stringify(manifest)}\n`)
    await expect(readMarkdownSource(f.entry, f.raw)).rejects.toThrow('different entry or identity')
    await expect(ensureMarkdownGeneration(f.entry, f.id, splitPlan(exactOriginal).files)).rejects.toThrow('identity differs')
  })

  it('rejects missing and foreign candidate generations with actionable errors', async () => {
    const f = await fixture()
    const raw = `[Missing](.y-topics/${generation}/topics/procedure.md)\n`
    await expect(readMarkdownSource(f.entry, raw)).rejects.toThrow('generated resources are missing')
    await fs.mkdir(f.store, { mode: 0o700 })
    await expect(readMarkdownSource(f.entry, raw)).rejects.toThrow('linked generation is missing')
    const other = join(f.root, 'OTHER.md')
    await fs.writeFile(other, sourceText, { mode: 0o600 })
    await ensureMarkdownGeneration(other, generation, projectionFiles(sourceText, raw))
    await expect(readMarkdownSource(f.entry, raw)).rejects.toThrow('different entry or identity')
  })

  it('rejects invalid link identities and more than eight candidate generations before resource reads', async () => {
    const f = await fixture()
    await expect(readMarkdownSource(f.entry, '[Bad](.y-topics/not-a-hash/topics/a.md)')).rejects.toThrow('invalid SHA256')
    await expect(readMarkdownSource(f.entry, '[Bad](.y-topics/)')).rejects.toThrow('invalid SHA256')
    const raw = Array.from({ length: 9 }, (_, index) => `[${index}](.y-topics/${createHash('sha256').update(String(index)).digest('hex')}/topics/a.md)`).join('\n')
    await expect(readMarkdownSource(f.entry, raw)).rejects.toThrow('eight-generation read limit')
    expect(await fs.readdir(f.root)).toEqual(['SKILL.md'])
  })

  it('refuses a generated link whose child destination was removed', async () => {
    const f = await sourceProjection()
    const changed = f.raw.replace('/topics/001-procedure.md#procedure', '')
    await expect(readMarkdownSource(f.entry, changed)).rejects.toThrow('differs from stored entry.txt')
  })

  it('verifies eight candidate generations and selects the single matching exact entry copy', async () => {
    const f = await fixture()
    const originals = Array.from({ length: 8 }, (_, index) => `# Original ${index}\n`)
    const ids = originals.map(original => createHash('sha256').update(original).digest('hex'))
    const earlierIds = ids.slice(0, 7)
    const intro = earlierIds.map((id, index) => `[${index}](.y-topics/${id}/topics/procedure.md)`).join('\n') + '\n'
    const selectedOriginal = exactOriginal.replace('## Procedure', intro + '\n## Procedure')
    const selectedPlan = splitPlan(selectedOriginal)
    const raw = selectedPlan.after
    for (let index = 0; index < earlierIds.length; index++) {
      const storedEntry = `[Earlier](.y-topics/${earlierIds[index]!}/topics/procedure.md)\n`
      await ensureMarkdownGeneration(f.entry, ids[index]!, projectionFiles(originals[index]!, storedEntry))
    }
    await ensureMarkdownGeneration(f.entry, selectedPlan.generation, selectedPlan.files)
    await fs.writeFile(f.entry, raw)
    expect(await readMarkdownSource(f.entry, raw)).toBe(selectedOriginal)
  })

  it('rejects ambiguous exact entry copies across generations', async () => {
    const f = await fixture()
    const originals = ['# First original\n', '# Second original\n']
    const ids = originals.map(original => createHash('sha256').update(original).digest('hex'))
    const raw = ids.map(id => `[Procedure](.y-topics/${id}/topics/procedure.md)`).join('\n') + '\n'
    for (let index = 0; index < ids.length; index++) {
      await ensureMarkdownGeneration(f.entry, ids[index]!, projectionFiles(originals[index]!, raw))
    }
    await fs.writeFile(f.entry, raw)
    await expect(readMarkdownSource(f.entry, raw)).rejects.toThrow('matches multiple source generations')
  })

  it('rejects reordered, noncanonical, and hash-mismatched exact source fragments', async () => {
    for (const kind of ['gap', 'noncanonical', 'wrong-hash']) {
      const f = await fixture()
      const id = createHash('sha256').update(exactOriginal).digest('hex')
      const raw = `[Procedure](.y-topics/${id}/topics/procedure.md)\n`
      const files = splitPlan(exactOriginal).files.map(file => ({ ...file }))
      const source = files.find(file => file.path === 'source/0001.txt')!
      files.find(file => file.path === 'entry.txt')!.content = raw
      if (kind === 'gap') source.path = 'source/0100.txt'
      if (kind === 'noncanonical') source.path = 'source/topic.txt'
      if (kind === 'wrong-hash') source.content = source.content.replace('Step', 'Edit')
      await ensureMarkdownGeneration(f.entry, id, files)
      await fs.writeFile(f.entry, raw)
      await expect(readMarkdownSource(f.entry, raw)).rejects.toThrow(kind === 'wrong-hash' ? 'original source SHA256 differs' : 'must be contiguous')
    }
  })

  it.each(['topic', 'entry', 'extra'])('rejects %s edits even when the canonical manifest hashes are updated', async (kind) => {
    const f = await sourceProjection()
    const manifestPath = join(f.published, '.manifest.json')
    const value: unknown = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    if (typeof value !== 'object' || value === null || !('files' in value) || !Array.isArray(value.files)) {
      throw new Error('Fixture manifest must list files')
    }
    const files: unknown[] = value.files
    const manifest = { ...value, files: files.map((file) => {
      if (typeof file !== 'object' || file === null || !('path' in file) || typeof file.path !== 'string'
        || !('bytes' in file) || typeof file.bytes !== 'number' || !('hash' in file) || typeof file.hash !== 'string') {
        throw new Error('Fixture manifest file must name its exact bytes and hash')
      }
      return { path: file.path, bytes: file.bytes, hash: file.hash }
    }) }
    let raw = f.raw
    const path = kind === 'topic' ? 'topics/001-procedure.md' : kind === 'entry' ? 'entry.txt' : 'extra.txt'
    const absolute = join(f.published, path)
    const content = kind === 'extra' ? 'Forged extra file\n' : (await fs.readFile(absolute, 'utf8')).replace('Relative source', 'Forged source').replace('Step', 'Edit')
    await fs.writeFile(absolute, content, { mode: 0o600 })
    const record = { path, bytes: Buffer.byteLength(content), hash: createHash('sha256').update(content).digest('hex') }
    const old = manifest.files.find(file => file.path === path)
    if (old) { old.bytes = record.bytes; old.hash = record.hash }
    else {
      manifest.files.push(record)
      manifest.files.sort((left, right) => left.path < right.path ? -1 : 1)
    }
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
    if (kind === 'entry') { raw = content; await fs.writeFile(f.entry, raw) }
    await expect(readMarkdownSource(f.entry, raw)).rejects.toThrow('deterministic source split')
    expect(await fs.readFile(absolute, 'utf8')).toBe(content)
  })

  it.skipIf(process.platform === 'win32')('refuses symlink source fragments and generation ancestors during reads', async () => {
    for (const target of ['source', '.y-topics', 'fragment']) {
      const f = await sourceProjection()
      const outside = join(f.root, 'outside')
      await fs.mkdir(outside, { mode: 0o700 })
      const outsideFile = join(outside, 'user.txt')
      await fs.writeFile(outsideFile, 'Untouched user bytes', { mode: 0o600 })
      const path = target === '.y-topics' ? f.store : target === 'source' ? join(f.published, 'source') : join(f.published, 'source/0001.txt')
      await fs.rm(path, { recursive: true })
      await fs.symlink(target === 'fragment' ? outsideFile : outside, path)
      await expect(readMarkdownSource(f.entry, f.raw)).rejects.toThrow('refusing links')
      expect(await fs.readFile(outsideFile, 'utf8')).toBe('Untouched user bytes')
    }
  })
})
