/** Filesystem evidence for complete managed Markdown bundle creation outside discovery. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { publishMarkdownCreation } from '../src/markdown-creation.ts'
import { readMarkdownSource } from '../src/markdown-generation.ts'
import { MARKDOWN_BYTE_CAP, MARKDOWN_SCREEN_CAP } from '../src/markdown-size.ts'
import { planMarkdownSplit } from '../src/markdown-split.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})
const raw = '# Created skill\n\nComplete source.\n'
async function fixture() {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'dsh-markdown-creation-'))
  roots.push(root)
  const dsh = join(root, '.dsh')
  const discovery = join(dsh, 'skills')
  await fs.mkdir(discovery, { recursive: true, mode: 0o700 })
  const entry = join(discovery, 'created-skill', 'SKILL.md')
  return { root, dsh, discovery, entry, store: join(dsh, '.y-markdown-create') }
}
async function stageAt(f: Awaited<ReturnType<typeof fixture>>) {
  const names = (await fs.readdir(f.store)).filter(name => !name.startsWith('.'))
  expect(names).toHaveLength(1)
  return join(f.store, names[0]!)
}
async function retained(f: Awaited<ReturnType<typeof fixture>>, text = raw) {
  await expect(publishMarkdownCreation(f.entry, text, undefined, async () => {
    throw new Error('Fixture journal failed')
  })).rejects.toThrow('journal failed')
  return stageAt(f)
}
async function publisherAt(f: Awaited<ReturnType<typeof fixture>>) {
  const name = (await fs.readdir(f.store)).find(name => name.startsWith('.publisher-'))
  if (!name) throw new Error('Fixture has no publisher reservation')
  return join(f.store, name)
}
async function seedPublisher(f: Awaited<ReturnType<typeof fixture>>, pid: number, owner = randomUUID(), text?: string) {
  await fs.mkdir(f.store, { mode: 0o700 })
  const path = join(f.store, `.publisher-${pid}-${owner}-${randomUUID()}.json`)
  const bytes = text ?? `${JSON.stringify({ version: 1, pid, owner })}\n`
  await fs.writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
  return { path, bytes }
}
function split() {
  const original = '# Long skill\n\nIntroduction.\n\n## Topic\n\n' + 'Complete topic paragraph.\n\n'.repeat(110)
  const plan = planMarkdownSplit(original, 'SKILL.md')
  if (plan.kind !== 'split') throw new Error('Fixture source did not split')
  return { original, raw: plan.after, generation: { id: plan.generation, files: plan.files } }
}

describe('managed Markdown creation', () => {
  it('publishes complete private bytes only after the journal callback observes an absent final bundle', async () => {
    const f = await fixture()
    const callback = vi.fn(async () => {
      expect(await fs.readdir(f.discovery)).toEqual([])
      const stage = await stageAt(f)
      expect(await fs.readFile(join(stage, 'bundle/SKILL.md'), 'utf8')).toBe(raw)
    })
    await publishMarkdownCreation(f.entry, raw, undefined, callback)
    expect(callback).toHaveBeenCalledOnce()
    expect(await fs.readFile(f.entry, 'utf8')).toBe(raw)
    expect(await fs.readdir(f.discovery)).toEqual(['created-skill'])
    expect(await fs.readdir(f.store)).toEqual([])
    if (process.platform !== 'win32') {
      expect((await fs.stat(dirname(f.entry))).mode & 0o777).toBe(0o700)
      expect((await fs.stat(f.entry)).mode & 0o777).toBe(0o600)
    }
    await expect(publishMarkdownCreation(f.entry, raw, undefined, callback)).rejects.toThrow('destination already exists')
    expect(callback).toHaveBeenCalledOnce()
  })

  it('keeps generated links and exact source reconstruction valid across the complete bundle rename', async () => {
    const f = await fixture()
    const plan = split()
    await publishMarkdownCreation(f.entry, plan.raw, plan.generation, async () => {
      const stage = await stageAt(f)
      expect(await readMarkdownSource(join(stage, 'bundle/SKILL.md'), plan.raw)).toBe(plan.original)
      expect(await fs.readdir(f.discovery)).toEqual([])
    })
    expect(await fs.readFile(f.entry, 'utf8')).toBe(plan.raw)
    expect(await readMarkdownSource(f.entry, plan.raw)).toBe(plan.original)
    for (const file of plan.generation.files) {
      expect(await fs.readFile(join(dirname(f.entry), '.y-topics', plan.generation.id, file.path), 'utf8')).toBe(file.content)
    }
    expect(await fs.readdir(f.store)).toEqual([])
  })

  it('retains complete children after a root write fails and retries the same stage', async () => {
    const f = await fixture()
    const plan = split()
    const write = fs.writeFile.bind(fs)
    const failure = vi.spyOn(fs, 'writeFile').mockImplementation(async (path, data, options) => {
      if (typeof path === 'string' && basename(path) === 'SKILL.md' && basename(dirname(path)) === 'bundle') {
        throw new Error('Fixture root write failed')
      }
      return write(path, data, options)
    })
    const callback = vi.fn(async () => {})
    try {
      await expect(publishMarkdownCreation(f.entry, plan.raw, plan.generation, callback)).rejects.toThrow('root write failed')
    } finally { failure.mockRestore() }
    expect(callback).not.toHaveBeenCalled()
    expect(await fs.readdir(f.discovery)).toEqual([])
    const stage = await stageAt(f)
    for (const file of plan.generation.files) {
      expect(await fs.readFile(join(stage, 'bundle/.y-topics', plan.generation.id, file.path), 'utf8')).toBe(file.content)
    }
    await publishMarkdownCreation(f.entry, plan.raw, plan.generation, callback)
    expect(await readMarkdownSource(f.entry, plan.raw)).toBe(plan.original)
    expect(await fs.readdir(f.store)).toEqual([])
  })

  it('recovers only an exact byte prefix left by a partial root write', async () => {
    const f = await fixture()
    const write = fs.writeFile.bind(fs)
    const failure = vi.spyOn(fs, 'writeFile').mockImplementation(async (path, data, options) => {
      if (typeof path === 'string' && basename(path) === 'SKILL.md' && basename(dirname(path)) === 'bundle') {
        await write(path, Buffer.from(raw).subarray(0, 12), options)
        throw new Error('Fixture partial root write failed')
      }
      return write(path, data, options)
    })
    try {
      await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow('partial root write failed')
    } finally { failure.mockRestore() }
    const stage = await stageAt(f)
    expect(await fs.readFile(join(stage, 'bundle/SKILL.md'), 'utf8')).toBe(raw.slice(0, 12))
    await publishMarkdownCreation(f.entry, raw, undefined, async () => {})
    expect(await fs.readFile(f.entry, 'utf8')).toBe(raw)
    expect(await fs.readdir(f.store)).toEqual([])
  })

  it.each(['absent', 'prefix'])('recovers %s creation metadata only before any bundle resources exist', async (kind) => {
    const f = await fixture()
    const write = fs.writeFile.bind(fs)
    const failure = vi.spyOn(fs, 'writeFile').mockImplementation(async (path, data, options) => {
      if (typeof path === 'string' && basename(path) === '.creation.json') {
        if (typeof data !== 'string' && !(data instanceof Uint8Array)) throw new Error('Fixture metadata must contain text bytes')
        const bytes = typeof data === 'string' ? Buffer.from(data) : data
        if (kind === 'prefix') await write(path, bytes.subarray(0, 25), options)
        throw new Error('Fixture metadata write failed')
      }
      return write(path, data, options)
    })
    try {
      await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow('metadata write failed')
    } finally { failure.mockRestore() }
    const stage = await stageAt(f)
    expect(await fs.readdir(stage)).toEqual(kind === 'prefix' ? ['.creation.json'] : [])
    await publishMarkdownCreation(f.entry, raw, undefined, async () => {})
    expect(await fs.readFile(f.entry, 'utf8')).toBe(raw)
    expect(await fs.readdir(f.store)).toEqual([])
  })

  it('refuses foreign resources beside interrupted metadata without completing the metadata', async () => {
    const f = await fixture()
    const stage = await retained(f)
    const metadataPath = join(stage, '.creation.json')
    const metadata = await fs.readFile(metadataPath)
    await fs.writeFile(metadataPath, metadata.subarray(0, 25))
    await fs.writeFile(join(stage, 'user.txt'), 'User bytes', { mode: 0o600 })
    await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow('unexpected creation stage resource')
    expect(await fs.readFile(metadataPath)).toEqual(metadata.subarray(0, 25))
    expect(await fs.readFile(join(stage, 'user.txt'), 'utf8')).toBe('User bytes')
    expect(await fs.readdir(f.discovery)).toEqual([])
  })

  it('refuses an overlapping same-process publisher while the admitted callback is pending', async () => {
    const f = await fixture()
    let entered!: () => void
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { entered = resolve })
    const proceed = new Promise<void>((resolve) => { release = resolve })
    const first = publishMarkdownCreation(f.entry, raw, undefined, async () => {
      entered()
      await proceed
    })
    try {
      await waiting
      await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow('another publisher')
      expect(await fs.readdir(f.discovery)).toEqual([])
    } finally {
      release()
      await first
    }
    expect(await fs.readFile(f.entry, 'utf8')).toBe(raw)
    expect(await fs.readdir(f.store)).toEqual([])
  })

  it('recovers an exact stopped publisher reservation without reusing its path', async () => {
    const f = await fixture()
    await retained(f)
    const owner = randomUUID()
    const stopped = join(f.store, `.publisher-2147483647-${owner}-${randomUUID()}.json`)
    const reservation = `${JSON.stringify({ version: 1, pid: 2147483647, owner })}\n`
    await fs.writeFile(stopped, reservation.slice(0, 12), { flag: 'wx', mode: 0o600 })
    await publishMarkdownCreation(f.entry, raw, undefined, async () => {})
    expect(await fs.readFile(f.entry, 'utf8')).toBe(raw)
    expect(await fs.readdir(f.store)).toEqual([])
  })

  it('retains the exact complete stage on callback and rename failure, then reuses its bytes', async () => {
    const f = await fixture()
    const stage = await retained(f)
    const source = join(stage, 'bundle/SKILL.md')
    const before = await fs.stat(source)
    const rename = fs.rename.bind(fs)
    const failure = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (from === join(stage, 'bundle')) throw new Error('Fixture bundle rename failed')
      return rename(from, to)
    })
    try {
      await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow('bundle rename failed')
    } finally { failure.mockRestore() }
    expect(await stageAt(f)).toBe(stage)
    expect(await fs.readdir(f.discovery)).toEqual([])
    await publishMarkdownCreation(f.entry, raw, undefined, async () => {})
    const after = await fs.stat(f.entry)
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs])
  })

  it.each(['root', 'metadata', 'extra-file', 'extra-directory', 'child', 'child-manifest'])('refuses changed %s resources without deleting them', async (kind) => {
    const f = await fixture()
    const plan = split()
    await expect(publishMarkdownCreation(f.entry, plan.raw, plan.generation, async () => {
      throw new Error('Fixture journal failed')
    })).rejects.toThrow('journal failed')
    const stage = await stageAt(f)
    const path = kind === 'root' ? join(stage, 'bundle/SKILL.md')
      : kind === 'metadata' ? join(stage, '.creation.json')
        : kind === 'child' ? join(stage, 'bundle/.y-topics', plan.generation.id, plan.generation.files[0]!.path)
          : kind === 'child-manifest' ? join(stage, 'bundle/.y-topics', plan.generation.id, '.manifest.json')
            : join(stage, kind)
    if (kind === 'extra-directory') await fs.mkdir(path, { mode: 0o700 })
    else await fs.writeFile(path, 'User bytes', { mode: 0o600 })
    const callback = vi.fn(async () => {})
    await expect(publishMarkdownCreation(f.entry, plan.raw, plan.generation, callback)).rejects.toThrow()
    expect(callback).not.toHaveBeenCalled()
    expect(await stageAt(f)).toBe(stage)
    expect(await fs.readdir(f.discovery)).toEqual([])
    if (kind === 'extra-directory') expect((await fs.stat(path)).isDirectory()).toBe(true)
    else expect(await fs.readFile(path, 'utf8')).toBe('User bytes')
  })

  it('refuses a different generation plan for the same destination and root bytes', async () => {
    const f = await fixture()
    const id = createHash('sha256').update('children').digest('hex')
    await expect(publishMarkdownCreation(f.entry, raw, { id, files: [{ path: 'topic.md', content: 'Topic\n' }] }, async () => {
      throw new Error('Fixture journal failed')
    })).rejects.toThrow('journal failed')
    const stage = await stageAt(f)
    await expect(publishMarkdownCreation(f.entry, raw, { id, files: [{ path: 'topic.md', content: 'Changed\n' }] }, async () => {})).rejects.toThrow('stored bytes differ')
    expect(await fs.readFile(join(stage, 'bundle/.y-topics', id, 'topic.md'), 'utf8')).toBe('Topic\n')
  })

  it('refuses an external final collision created by the journal callback', async () => {
    const f = await fixture()
    await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {
      await fs.mkdir(dirname(f.entry), { mode: 0o700 })
      await fs.writeFile(f.entry, 'External skill\n', { flag: 'wx', mode: 0o600 })
    })).rejects.toThrow('destination already exists')
    expect(await fs.readFile(f.entry, 'utf8')).toBe('External skill\n')
    expect(await fs.readFile(join(await stageAt(f), 'bundle/SKILL.md'), 'utf8')).toBe(raw)
  })

  it('rechecks staged bytes after the callback before publishing', async () => {
    const f = await fixture()
    await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {
      await fs.writeFile(join(await stageAt(f), 'bundle/SKILL.md'), 'User bytes', { mode: 0o600 })
    })).rejects.toThrow('stored bytes differ')
    expect(await fs.readdir(f.discovery)).toEqual([])
    expect(await fs.readFile(join(await stageAt(f), 'bundle/SKILL.md'), 'utf8')).toBe('User bytes')
  })

  it.skipIf(process.platform === 'win32')('refuses stage and destination symlinks without changing their targets', async () => {
    const f = await fixture()
    const target = join(f.root, 'external')
    await fs.mkdir(target, { mode: 0o700 })
    await fs.writeFile(join(target, 'SKILL.md'), 'External bytes\n', { mode: 0o600 })
    await fs.symlink(target, dirname(f.entry))
    await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow('destination already exists')
    await fs.unlink(dirname(f.entry))
    const stage = await retained(f)
    await fs.unlink(join(stage, 'bundle/SKILL.md'))
    await fs.symlink(join(target, 'SKILL.md'), join(stage, 'bundle/SKILL.md'))
    await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow('refusing links')
    expect(await fs.readFile(join(target, 'SKILL.md'), 'utf8')).toBe('External bytes\n')
    expect(await fs.readdir(f.discovery)).toEqual([])
  })

  it('caps the complete root before acquiring any stage and admits exact byte and line limits', async () => {
    const f = await fixture()
    const tooManyLines = 'x\n'.repeat(MARKDOWN_SCREEN_CAP + 1)
    const tooManyBytes = '界'.repeat(Math.floor(MARKDOWN_BYTE_CAP / 3)) + 'aa'
    for (const text of [tooManyLines, tooManyBytes]) {
      await expect(publishMarkdownCreation(f.entry, text, undefined, async () => {})).rejects.toThrow('complete root Markdown exceeds')
      expect(await fs.readdir(f.dsh)).toEqual(['skills'])
    }
    const exactBytes = '界'.repeat(Math.floor(MARKDOWN_BYTE_CAP / 3)) + 'a'
    expect(Buffer.byteLength(exactBytes)).toBe(MARKDOWN_BYTE_CAP)
    await publishMarkdownCreation(f.entry, exactBytes, undefined, async () => {})
    expect(await fs.readFile(f.entry, 'utf8')).toBe(exactBytes)
    const other = join(f.discovery, 'line-cap', 'SKILL.md')
    await publishMarkdownCreation(other, 'x\n'.repeat(MARKDOWN_SCREEN_CAP), undefined, async () => {})
    expect(await fs.readFile(other, 'utf8')).toBe('x\n'.repeat(MARKDOWN_SCREEN_CAP))
  })

  it('retains at most eight stages per managed parent while allowing an exact retry at the bound', async () => {
    const f = await fixture()
    const stages = []
    for (let index = 0; index < 8; index++) {
      const entry = join(f.discovery, `skill-${index}`, 'SKILL.md')
      await expect(publishMarkdownCreation(entry, raw, undefined, async () => {
        throw new Error('Fixture journal failed')
      })).rejects.toThrow('journal failed')
      stages.push(entry)
    }
    expect(await fs.readdir(f.store)).toHaveLength(8)
    await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow('eight creation stages')
    expect(await fs.readdir(f.discovery)).toEqual([])
    await publishMarkdownCreation(stages[0]!, raw, undefined, async () => {})
    expect(await fs.readdir(f.store)).toHaveLength(7)
    expect(await fs.readFile(stages[0]!, 'utf8')).toBe(raw)
  })

  it.each(['invalid-id', 'too-many-files', 'metadata-size', 'duplicate-paths'])('refuses a %s generation plan before publishing any source', async (kind) => {
    const f = await fixture()
    const id = 'a'.repeat(64)
    const files = kind === 'too-many-files' ? Array.from({ length: 65 }, (_, index) => ({ path: `${index}.md`, content: '' }))
      : kind === 'metadata-size' ? Array.from({ length: 64 }, (_, index) => ({ path: `${index}-${'x'.repeat(2200)}.md`, content: '' }))
        : [{ path: 'topic.md', content: '' }, { path: 'topic.md', content: '' }]
    await expect(publishMarkdownCreation(f.entry, raw, { id: kind === 'invalid-id' ? 'invalid' : id, files }, async () => {})).rejects.toThrow()
    expect(await fs.readdir(f.discovery)).toEqual([])
  })

  it.each(['stat', 'directory', 'publisher-open'])('propagates a %s filesystem admission failure and releases its process reservation', async (kind) => {
    const f = await fixture()
    const fault = Object.assign(new Error('Fixture admission denied'), { code: 'EACCES' })
    const stat = fs.lstat.bind(fs)
    const mkdir = fs.mkdir.bind(fs)
    const open = fs.open.bind(fs)
    if (kind === 'stat') vi.spyOn(fs, 'lstat').mockImplementation(async (path) => {
      if (path === dirname(f.entry)) throw fault
      return stat(path)
    })
    if (kind === 'directory') vi.spyOn(fs, 'mkdir').mockImplementation(async (path, options) => {
      if (path === f.store) throw fault
      return mkdir(path, options)
    })
    if (kind === 'publisher-open') vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (typeof path === 'string' && basename(path).startsWith('.publisher-')) throw fault
      return open(path, flags, mode)
    })
    try {
      await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow('admission denied')
      expect(await fs.readdir(f.discovery)).toEqual([])
    } finally { vi.restoreAllMocks() }
    await publishMarkdownCreation(f.entry, raw, undefined, async () => {})
    expect(await fs.readFile(f.entry, 'utf8')).toBe(raw)
  })

  it('cleans only its exact partial publisher record after a reservation write fails', async () => {
    const f = await fixture()
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await open(path, flags, mode)
      if (typeof path === 'string' && basename(path).startsWith('.publisher-')) {
        const write = handle.writeFile.bind(handle)
        vi.spyOn(handle, 'writeFile').mockImplementation(async (data) => {
          if (typeof data !== 'string' && !(data instanceof Uint8Array)) throw new Error('Fixture publisher metadata must contain text bytes')
          const bytes = typeof data === 'string' ? Buffer.from(data) : data
          await write(bytes.subarray(0, 12))
          throw new Error('Fixture publisher write failed')
        })
      }
      return handle
    })
    try {
      await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow('publisher write failed')
      expect(await fs.readdir(f.store)).toEqual([])
    } finally { vi.restoreAllMocks() }
    await publishMarkdownCreation(f.entry, raw, undefined, async () => {})
    expect(await fs.readFile(f.entry, 'utf8')).toBe(raw)
  })

  it.each(['foreign-file', 'invalid-pid', 'changed-record', 'live-publisher', 'signal-error'])('preserves a %s publisher-store resource and refuses acquisition', async (kind) => {
    const f = await fixture()
    const record = kind === 'foreign-file'
      ? await seedPublisher(f, 2147483647)
      : await seedPublisher(f, kind === 'invalid-pid' ? 2147483648 : kind === 'live-publisher' ? process.pid : 2147483647,
        randomUUID(), kind === 'changed-record' ? 'User bytes' : undefined)
    if (kind === 'foreign-file') await fs.rename(record.path, join(f.store, 'user.txt'))
    if (kind === 'signal-error') vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Fixture process check denied'), { code: 'EPERM' })
    })
    try {
      await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow()
      const path = kind === 'foreign-file' ? join(f.store, 'user.txt') : record.path
      expect(await fs.readFile(path, 'utf8')).toBe(record.bytes)
      expect(await fs.readdir(f.store)).toHaveLength(1)
      expect(await fs.readdir(f.discovery)).toEqual([])
    } finally { vi.restoreAllMocks() }
  })

  it('recovers an unchanged reservation left by an earlier operation in this process', async () => {
    const f = await fixture()
    let stoppedPath = ''
    await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {
      const current = await publisherAt(f)
      const bytes = await fs.readFile(current, 'utf8')
      const value = JSON.parse(bytes) as { pid: number; owner: string }
      stoppedPath = join(f.store, `.publisher-${value.pid}-${value.owner}-${randomUUID()}.json`)
      await fs.writeFile(stoppedPath, bytes, { flag: 'wx', mode: 0o600 })
      throw new Error('Fixture stopped before commit')
    })).rejects.toThrow('stopped before commit')
    expect(await fs.readFile(stoppedPath, 'utf8')).toContain(`"pid":${process.pid}`)
    await publishMarkdownCreation(f.entry, raw, undefined, async () => {})
    expect(await fs.readdir(f.store)).toEqual([])
    expect(await fs.readFile(f.entry, 'utf8')).toBe(raw)
  })

  it('reports both admission and reservation cleanup failures and preserves the reservation for a retry', async () => {
    const f = await fixture()
    await fs.mkdir(f.store, { mode: 0o700 })
    const foreign = join(f.store, 'user.txt')
    await fs.writeFile(foreign, 'User bytes', { mode: 0o600 })
    const unlink = fs.unlink.bind(fs)
    const cleanup = vi.spyOn(fs, 'unlink').mockImplementation(async (path) => {
      if (typeof path === 'string' && basename(path).startsWith('.publisher-')) throw new Error('Fixture reservation cleanup failed')
      return unlink(path)
    })
    try {
      const error: unknown = await publishMarkdownCreation(f.entry, raw, undefined, async () => {}).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(AggregateError)
      if (!(error instanceof AggregateError)) throw new Error('Fixture must report both publication errors')
      expect(error.message).toBe('Markdown publisher acquisition and cleanup failed')
      expect(error.errors).toHaveLength(2)
      expect(error.errors[0]).toHaveProperty('message', expect.stringContaining('unexpected resource'))
      expect(error.errors[1]).toHaveProperty('message', 'Fixture reservation cleanup failed')
      expect(await fs.readFile(foreign, 'utf8')).toBe('User bytes')
    } finally { cleanup.mockRestore() }
    await fs.unlink(foreign)
    await publishMarkdownCreation(f.entry, raw, undefined, async () => {})
    expect(await fs.readFile(f.entry, 'utf8')).toBe(raw)
  })

  it.each(['callback-failed', 'committed'])('reports reservation cleanup failure after the operation is %s', async (kind) => {
    const f = await fixture()
    const unlink = fs.unlink.bind(fs)
    const cleanup = vi.spyOn(fs, 'unlink').mockImplementation(async (path) => {
      if (typeof path === 'string' && basename(path).startsWith('.publisher-')) throw new Error('Fixture reservation cleanup failed')
      return unlink(path)
    })
    try {
      const operation = publishMarkdownCreation(f.entry, raw, undefined, async () => {
        if (kind === 'callback-failed') throw new Error('Fixture callback failed')
      })
      if (kind === 'callback-failed') await expect(operation).rejects.toMatchObject({
        message: 'Markdown creation and publisher cleanup failed',
        errors: [expect.objectContaining({ message: 'Fixture callback failed' }), expect.objectContaining({ message: 'Fixture reservation cleanup failed' })],
      })
      else await expect(operation).rejects.toThrow('reservation cleanup failed')
      if (kind === 'committed') expect(await fs.readFile(f.entry, 'utf8')).toBe(raw)
      else expect(await fs.readdir(f.discovery)).toEqual([])
    } finally { cleanup.mockRestore() }
    if (kind === 'callback-failed') {
      await publishMarkdownCreation(f.entry, raw, undefined, async () => {})
      expect(await fs.readFile(f.entry, 'utf8')).toBe(raw)
    }
  })

  it('refuses changed publisher bytes before commit and preserves them during cleanup', async () => {
    const f = await fixture()
    let path = ''
    const error: unknown = await publishMarkdownCreation(f.entry, raw, undefined, async () => {
      path = await publisherAt(f)
      await fs.writeFile(path, 'User bytes', { mode: 0o600 })
    }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(AggregateError)
    if (!(error instanceof AggregateError)) throw new Error('Fixture must report both publication errors')
    expect(error.message).toBe('Markdown creation and publisher cleanup failed')
    expect(error.errors).toHaveLength(2)
    expect(error.errors[0]).toHaveProperty('message', expect.stringContaining('stored bytes differ'))
    expect(error.errors[1]).toHaveProperty('message', expect.stringContaining('publisher reservation was changed'))
    expect(await fs.readFile(path, 'utf8')).toBe('User bytes')
    expect(await fs.readdir(f.discovery)).toEqual([])
  })

  it.each(['absent-metadata', 'missing-child', 'foreign-bundle', 'oversized-root'])('refuses a %s retained stage without publishing it', async (kind) => {
    const f = await fixture()
    const plan = kind === 'missing-child' ? split() : { raw, generation: undefined }
    await expect(publishMarkdownCreation(f.entry, plan.raw, plan.generation, async () => {
      throw new Error('Fixture stopped before commit')
    })).rejects.toThrow('stopped before commit')
    const stage = await stageAt(f)
    if (kind === 'absent-metadata') await fs.unlink(join(stage, '.creation.json'))
    if (kind === 'missing-child') {
      if (!plan.generation) throw new Error('Fixture needs children')
      await fs.unlink(join(stage, 'bundle/.y-topics', plan.generation.id, plan.generation.files[0]!.path))
    }
    if (kind === 'foreign-bundle') await fs.writeFile(join(stage, 'bundle/user.md'), 'User bytes', { mode: 0o600 })
    if (kind === 'oversized-root') await fs.writeFile(join(stage, 'bundle/SKILL.md'), raw + 'User bytes', { mode: 0o600 })
    await expect(publishMarkdownCreation(f.entry, plan.raw, plan.generation, async () => {})).rejects.toThrow()
    expect(await fs.readdir(f.discovery)).toEqual([])
    expect(await fs.readdir(f.store)).toHaveLength(1)
  })

  it.each([false, true])('refuses foreign bundle resources before retrying a missing root with generation=%s', async (withGeneration) => {
    const f = await fixture()
    const plan = withGeneration ? split() : { raw, generation: undefined }
    await expect(publishMarkdownCreation(f.entry, plan.raw, plan.generation, async () => {
      throw new Error('Fixture stopped before commit')
    })).rejects.toThrow('stopped before commit')
    const stage = await stageAt(f)
    await fs.unlink(join(stage, 'bundle/SKILL.md'))
    await fs.writeFile(join(stage, 'bundle/user.md'), 'User bytes', { mode: 0o600 })
    await expect(publishMarkdownCreation(f.entry, plan.raw, plan.generation, async () => {})).rejects.toThrow('unexpected staged resource')
    expect(await fs.readFile(join(stage, 'bundle/user.md'), 'utf8')).toBe('User bytes')
    expect(await fs.readdir(f.discovery)).toEqual([])
  })

  it.skipIf(process.getuid === undefined)('refuses a stage whose filesystem owner changed', async () => {
    const f = await fixture()
    const stage = await retained(f)
    const stat = fs.lstat.bind(fs)
    vi.spyOn(fs, 'lstat').mockImplementation(async (path) => {
      const info = await stat(path)
      if (path === stage) info.uid += 1
      return info
    })
    try {
      await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow('wrong file owner')
      expect(await fs.readdir(f.discovery)).toEqual([])
    } finally { vi.restoreAllMocks() }
    expect(await fs.readFile(join(stage, 'bundle/SKILL.md'), 'utf8')).toBe(raw)
  })

  it.skipIf(process.platform === 'win32')('refuses broadened stage permissions and hard-linked metadata', async () => {
    const f = await fixture()
    const stage = await retained(f)
    await fs.chmod(stage, 0o755)
    await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow('permissions must be owner-only')
    await fs.chmod(stage, 0o700)
    const metadata = join(stage, '.creation.json')
    const linked = join(f.root, 'user-metadata.json')
    const before = await fs.readFile(metadata)
    await fs.link(metadata, linked)
    await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow('refusing linked files')
    expect(await fs.readFile(linked)).toEqual(before)
    expect(await fs.readFile(metadata)).toEqual(before)
    expect(await fs.readdir(f.discovery)).toEqual([])
  })

  it('refuses metadata replaced between its path check and file open', async () => {
    const f = await fixture()
    const stage = await retained(f)
    const metadata = join(stage, '.creation.json')
    const before = await fs.readFile(metadata)
    const open = fs.open.bind(fs)
    let replaced = false
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (path === metadata && !replaced) {
        replaced = true
        await fs.rename(metadata, join(stage, 'original-metadata.json'))
        await fs.writeFile(metadata, before, { flag: 'wx', mode: 0o600 })
      }
      return open(path, flags, mode)
    })
    try {
      await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow('file changed during verification')
      expect(await fs.readdir(f.discovery)).toEqual([])
    } finally { vi.restoreAllMocks() }
    expect(await fs.readFile(metadata)).toEqual(before)
    expect(await fs.readFile(join(stage, 'original-metadata.json'))).toEqual(before)
  })

  it('bounds reads when a verified file grows by two MiB before the descriptor read', async () => {
    const f = await fixture()
    const stage = await retained(f)
    const metadata = join(stage, '.creation.json')
    const before = await fs.readFile(metadata)
    const growth = Buffer.alloc(2 * 1024 * 1024, 'u')
    const sizes: number[] = []
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await open(path, flags, mode)
      if (path === metadata) {
        const read = handle.read.bind(handle)
        vi.spyOn(handle, 'read').mockImplementation(async (options) => {
          sizes.push(options?.buffer?.byteLength ?? 0)
          await fs.appendFile(metadata, growth)
          return read(options)
        })
      }
      return handle
    })
    try {
      await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow('stored file exceeds its byte limit')
      expect(await fs.readdir(f.discovery)).toEqual([])
    } finally { vi.restoreAllMocks() }
    expect(sizes).toEqual([before.length + 1])
    expect((await fs.stat(metadata)).size).toBe(before.length + growth.length)
  })

  it.each(['inode', 'canonical-path'])('refuses a publication parent changed by %s during the callback', async (kind) => {
    const f = await fixture()
    const moved = join(f.dsh, 'previous-skills')
    await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {
      await fs.rename(f.discovery, moved)
      await fs.mkdir(f.discovery, { mode: 0o700 })
      if (kind === 'canonical-path') {
        const realpath = fs.realpath.bind(fs)
        vi.spyOn(fs, 'realpath').mockImplementation(async path => path === f.discovery ? moved : realpath(path))
      }
    })).rejects.toThrow(kind === 'inode' ? 'parent directory changed' : 'canonical publication parent changed')
    expect(await fs.readdir(f.discovery)).toEqual([])
    expect(await fs.readdir(moved)).toEqual([])
    expect(await fs.readFile(join(await stageAt(f), 'bundle/SKILL.md'), 'utf8')).toBe(raw)
  })

  it('preserves a foreign bundle appearing in the stage after the complete bundle committed', async () => {
    const f = await fixture()
    const rename = fs.rename.bind(fs)
    let stage = ''
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to)
      if (to === dirname(f.entry)) {
        stage = dirname(String(from))
        await fs.mkdir(join(stage, 'bundle'), { mode: 0o700 })
        await fs.writeFile(join(stage, 'bundle/user.txt'), 'User bytes', { mode: 0o600 })
      }
    })
    try {
      await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow('unexpected resource after publication')
      expect(await fs.readFile(f.entry, 'utf8')).toBe(raw)
      expect(await fs.readFile(join(stage, 'bundle/user.txt'), 'utf8')).toBe('User bytes')
    } finally { vi.restoreAllMocks() }
  })

  it('refuses a foreign resource added after publisher admission and preserves its bytes', async () => {
    const f = await fixture()
    const opendir = fs.opendir.bind(fs)
    let storeReads = 0
    const foreign = join(f.store, 'user.txt')
    vi.spyOn(fs, 'opendir').mockImplementation(async (path, options) => {
      if (path === f.store && ++storeReads === 2) await fs.writeFile(foreign, 'User bytes', { flag: 'wx', mode: 0o600 })
      return opendir(path, options)
    })
    try {
      await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow('unexpected resource in the creation store')
      expect(await fs.readFile(foreign, 'utf8')).toBe('User bytes')
      expect(await fs.readdir(f.discovery)).toEqual([])
    } finally { vi.restoreAllMocks() }
  })

  it.skipIf(process.platform === 'win32')('keeps link and ownership checks when O_NOFOLLOW is unavailable', async () => {
    const f = await fixture()
    const stage = await retained(f)
    const external = join(f.root, 'external.md')
    await fs.writeFile(external, raw, { mode: 0o600 })
    vi.resetModules()
    vi.doMock('node:fs', () => ({ constants: { ...constants, O_NOFOLLOW: undefined } }))
    try {
      const fallback = await import('../src/markdown-creation.ts')
      await fs.unlink(join(stage, 'bundle/SKILL.md'))
      await fs.symlink(external, join(stage, 'bundle/SKILL.md'))
      await expect(fallback.publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow('refusing links')
      expect(await fs.readFile(external, 'utf8')).toBe(raw)
      expect(await fs.readdir(f.discovery)).toEqual([])
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  })

  it('refuses a thousand retained stage names before inspecting their directories', async () => {
    const f = await fixture()
    await fs.mkdir(f.store, { mode: 0o700 })
    const names = Array.from({ length: 1000 }, (_, index) => createHash('sha256').update(`external-${index}`).digest('hex'))
    await Promise.all(names.map(name => fs.mkdir(join(f.store, name), { mode: 0o700 })))
    const stat = fs.lstat.bind(fs)
    let inspected = 0
    vi.spyOn(fs, 'lstat').mockImplementation(async (path) => {
      if (typeof path === 'string' && dirname(path) === f.store && /^[0-9a-f]{64}$/.test(basename(path))) inspected++
      return stat(path)
    })
    try {
      await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow('eight creation stages')
      expect(inspected).toBe(0)
      expect((await fs.readdir(f.store)).sort()).toEqual([...names].sort())
      expect(await fs.readdir(f.discovery)).toEqual([])
    } finally { vi.restoreAllMocks() }
  })

  it('refuses a thousand publisher names before reading or pruning their records', async () => {
    const f = await fixture()
    await fs.mkdir(f.store, { mode: 0o700 })
    const owner = randomUUID()
    const names = Array.from({ length: 1000 }, () => `.publisher-2147483647-${owner}-${randomUUID()}.json`)
    await Promise.all(names.map(name => fs.writeFile(join(f.store, name), 'User bytes', { flag: 'wx', mode: 0o600 })))
    const stat = fs.lstat.bind(fs)
    const existing = new Set(names)
    let inspected = 0
    vi.spyOn(fs, 'lstat').mockImplementation(async (path) => {
      if (typeof path === 'string' && dirname(path) === f.store && existing.has(basename(path))) inspected++
      return stat(path)
    })
    try {
      await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow('eight outstanding publisher')
      expect(inspected).toBe(0)
      expect((await fs.readdir(f.store)).sort()).toEqual([...names].sort())
      expect(await fs.readFile(join(f.store, names[0]!), 'utf8')).toBe('User bytes')
      expect(await fs.readdir(f.discovery)).toEqual([])
    } finally { vi.restoreAllMocks() }
  })

  it('refuses an oversized publisher identifier before opening its bytes', async () => {
    const f = await fixture()
    await fs.mkdir(f.store, { mode: 0o700 })
    const foreign = join(f.store, `.publisher-${'9'.repeat(140)}-${randomUUID()}-${randomUUID()}.json`)
    await fs.writeFile(foreign, 'User bytes', { flag: 'wx', mode: 0o600 })
    const open = fs.open.bind(fs)
    let opened = 0
    vi.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (path === foreign) opened++
      return open(path, flags, mode)
    })
    try {
      await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow('unexpected resource in the creation store')
      expect(opened).toBe(0)
      expect(await fs.readFile(foreign, 'utf8')).toBe('User bytes')
      expect(await fs.readdir(f.discovery)).toEqual([])
    } finally { vi.restoreAllMocks() }
  })

  it.each(['stage', 'bundle'])('refuses a thousand foreign %s resources without inspecting their files', async (kind) => {
    const f = await fixture()
    const stage = await retained(f)
    const directory = kind === 'stage' ? stage : join(stage, 'bundle')
    const names = Array.from({ length: 1000 }, (_, index) => `user-${index}.txt`)
    await Promise.all(names.map(name => fs.writeFile(join(directory, name), 'User bytes', { flag: 'wx', mode: 0o600 })))
    const stat = fs.lstat.bind(fs)
    let inspected = 0
    vi.spyOn(fs, 'lstat').mockImplementation(async (path) => {
      if (typeof path === 'string' && dirname(path) === directory && basename(path).startsWith('user-')) inspected++
      return stat(path)
    })
    try {
      await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow('unexpected')
      expect(inspected).toBe(0)
      expect((await fs.readdir(directory)).filter(name => name.startsWith('user-')).sort()).toEqual([...names].sort())
      expect(await fs.readFile(join(directory, names[0]!), 'utf8')).toBe('User bytes')
      expect(await fs.readFile(join(stage, 'bundle/SKILL.md'), 'utf8')).toBe(raw)
      expect(await fs.readdir(f.discovery)).toEqual([])
    } finally { vi.restoreAllMocks() }
  })

  it('refuses a complete bundle moved out of its stage during the journal callback', async () => {
    const f = await fixture()
    const moved = join(f.root, 'moved-bundle')
    await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {
      const stage = await stageAt(f)
      await fs.rename(join(stage, 'bundle'), moved)
    })).rejects.toThrow('unexpected or missing creation stage resource')
    expect(await fs.readFile(join(moved, 'SKILL.md'), 'utf8')).toBe(raw)
    expect(await fs.readdir(f.discovery)).toEqual([])
  })

  it('refuses partial creation metadata beside an already complete bundle', async () => {
    const f = await fixture()
    const stage = await retained(f)
    const path = join(stage, '.creation.json')
    const bytes = await fs.readFile(path)
    await fs.writeFile(path, bytes.subarray(0, 25))
    await expect(publishMarkdownCreation(f.entry, raw, undefined, async () => {})).rejects.toThrow('stored bytes differ')
    expect(await fs.readFile(path)).toEqual(bytes.subarray(0, 25))
    expect(await fs.readFile(join(stage, 'bundle/SKILL.md'), 'utf8')).toBe(raw)
    expect(await fs.readdir(f.discovery)).toEqual([])
  })
})
