import { chmod, lstat, link, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { VpsBotComputerSetting } from '../src/vps-bot-computer-setting.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    mkdir: vi.fn(actual.mkdir),
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
  }
})

const SESSION = 'bot-session-12345678-1234-4abc-8def-1234567890ab'
const OTHER_SESSION = 'bot-session-abcdefab-cdef-4abc-9abc-abcdefabcdef'

async function holdPolicySync(directory: string, sessionId: string) {
  const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const open = vi.mocked(fsPromises.open)
  const paused = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const temporaryPrefix = join(directory, `.${sessionId}.`)
  open.mockImplementation(async (path, flags, mode) => {
    const handle = await realFs.open(path, flags, mode)
    if (typeof path === 'string' && path.startsWith(temporaryPrefix)) {
      const sync = handle.sync.bind(handle)
      vi.spyOn(handle, 'sync').mockImplementationOnce(async () => {
        await sync()
        paused.resolve(undefined)
        await release.promise
      })
    }
    return handle
  })
  return { paused: paused.promise, release: () => { release.resolve(undefined) }, restore: () => { open.mockImplementation(realFs.open) } }
}

describe.skipIf(process.platform === 'win32')('VPS Bot Computer setting', () => {
  it('keeps the network and shared workspace choices independent across reloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-shared-setting-'))
    try {
      await new VpsBotComputerSetting(root, 'network').set(SESSION, true)
      await new VpsBotComputerSetting(root, 'shared-workspace').set(SESSION, false)
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).resolves.toBe(true)
      await expect(new VpsBotComputerSetting(root, 'shared-workspace').get(SESSION)).resolves.toBe(false)
      expect(await readFile(join(root, '.network-access', SESSION), 'utf8')).toBe('{"version":1,"enabled":true}\n')
      expect(await readFile(join(root, '.shared-workspace-access', SESSION), 'utf8')).toBe('{"version":1,"enabled":false}\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves construction side-effect free and treats a missing override as absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    try {
      const policy = new VpsBotComputerSetting(root, 'network')
      expect(await policy.get(SESSION)).toBeUndefined()
      await expect(lstat(join(root, '.network-access'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves a cold Computer root absent when reading its defaults', async () => {
    const base = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    const root = join(base, 'cold')
    try {
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).resolves.toBeUndefined()
      await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('rejects invalid roots and values before exposing a policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    try {
      expect(() => new VpsBotComputerSetting('', 'network')).toThrow('invalid')
      expect(() => new VpsBotComputerSetting('relative-root', 'network')).toThrow('invalid')
      expect(() => new VpsBotComputerSetting(`${root}\u0000unsafe`, 'network')).toThrow('invalid')
      const policy = new VpsBotComputerSetting(root, 'network')
      const rejected: unknown = Reflect.apply(policy.set.bind(policy), undefined, [SESSION, 'true'])
      await expect(rejected).rejects.toThrow('invalid')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a write when the owner root is missing', async () => {
    const base = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    const root = join(base, 'cold')
    try {
      await expect(new VpsBotComputerSetting(root, 'network').set(SESSION, true)).rejects.toThrow('invalid')
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('persists both decisions and reloads them through a fresh instance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    try {
      const policy = new VpsBotComputerSetting(root, 'network')
      await policy.set(SESSION, true)
      await policy.set(SESSION, true)
      await policy.set(OTHER_SESSION, false)
      const reloaded = new VpsBotComputerSetting(root, 'network')
      await expect(reloaded.get(SESSION)).resolves.toBe(true)
      await expect(reloaded.get(OTHER_SESSION)).resolves.toBe(false)
      await reloaded.set(SESSION, false)
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).resolves.toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serializes same-root operations and leaves one canonical file per session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    try {
      const policy = new VpsBotComputerSetting(root, 'network')
      await Promise.all([policy.set(SESSION, true), policy.set(SESSION, false), policy.get(SESSION)])
      await expect(policy.get(SESSION)).resolves.toBe(false)
      const directory = join(root, '.network-access')
      expect(await readdir(directory)).toEqual([SESSION])
      const file = await lstat(join(directory, SESSION))
      expect(file.isFile()).toBe(true)
      expect(file.isSymbolicLink()).toBe(false)
      expect(file.nlink).toBe(1)
      expect(file.mode & 0o7777).toBe(0o600)
      expect(await readFile(join(directory, SESSION), 'utf8')).toBe('{"version":1,"enabled":false}\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['queued', 'synced'] as const)('preserves the existing policy when cancellation reaches a %s write', async (stage) => {
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    const directory = join(root, '.network-access')
    const policy = new VpsBotComputerSetting(root, 'network')
    const controller = new AbortController()
    const reason = new Error('The Web configuration closed.')
    const set: (sessionId: string, enabled: boolean, signal?: AbortSignal) => Promise<void> = policy.set.bind(policy)
    let gate: Awaited<ReturnType<typeof holdPolicySync>> | undefined
    const pending: Promise<void>[] = []
    try {
      await policy.set(SESSION, false)
      const queued = stage === 'queued'
      gate = await holdPolicySync(directory, queued ? OTHER_SESSION : SESSION)
      const blocked = queued ? policy.set(OTHER_SESSION, true) : set(SESSION, true, controller.signal)
      pending.push(blocked)
      await Promise.race([gate.paused, blocked.then(() => { throw new Error('The write completed before syncing.') })])
      const opened = vi.mocked(fsPromises.open).mock.calls.length
      const cancelled = queued ? set(SESSION, true, controller.signal) : blocked
      if (queued) pending.push(cancelled)
      const outcome = Promise.allSettled([cancelled])
      controller.abort(reason)
      gate.release()
      const [result] = await outcome
      if (queued) await blocked

      const target = join(directory, SESSION)
      const stored = await readFile(target, 'utf8')
      const files = (await readdir(directory)).sort()
      const startedQueuedWrite = queued && vi.mocked(fsPromises.open).mock.calls.slice(opened).some(([path]) =>
        typeof path === 'string' && (path === target || path.startsWith(join(directory, `.${SESSION}.`))))
      expect({ result, stored, files, startedQueuedWrite }).toEqual({
        result: { status: 'rejected', reason },
        stored: '{"version":1,"enabled":false}\n',
        files: queued ? [SESSION, OTHER_SESSION] : [SESSION],
        startedQueuedWrite: false,
      })
    } finally {
      gate?.release()
      await Promise.allSettled(pending)
      gate?.restore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects malformed, extra-field, and duplicate-key policy values without exposing paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    const directory = join(root, '.network-access')
    try {
      await mkdir(directory, { mode: 0o700 })
      const target = join(directory, SESSION)
      for (const value of [
        '{"version":1,"enabled":"true"}\n',
        '{"version":1,"enabled":true,"extra":false}\n',
        '{"version":1,"enabled":true,"enabled":false}\n',
      ]) {
        await writeFile(target, value, { mode: 0o600 })
        await expect(new VpsBotComputerSetting(root, 'network').get(SESSION))
          .rejects.toThrow('VPS Bot computer setting is invalid')
        await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).rejects.not.toThrow(root)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a syntactically malformed policy record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    const directory = join(root, '.network-access')
    try {
      await mkdir(directory, { mode: 0o700 })
      await writeFile(join(directory, SESSION), '{', { mode: 0o600 })
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).rejects.toThrow('invalid')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects oversized and non-object policy records, while accepting canonical JSON without a newline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    const directory = join(root, '.network-access')
    const target = join(directory, SESSION)
    try {
      await mkdir(directory, { mode: 0o700 })
      await writeFile(target, '{"version":1,"enabled":true}', { mode: 0o600 })
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).resolves.toBe(true)
      await writeFile(target, 'null', { mode: 0o600 })
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).rejects.toThrow('invalid')
      await writeFile(target, 'x'.repeat(129), { mode: 0o600 })
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).rejects.toThrow('invalid')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects symlinked roots, directories, files, and hard-linked files', async () => {
    const base = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    const root = join(base, 'root')
    const outside = join(base, 'outside')
    try {
      await mkdir(root, { mode: 0o700 })
      await mkdir(outside, { mode: 0o700 })
      await writeFile(join(outside, SESSION), '{"version":1,"enabled":true}\n', { mode: 0o600 })
      await symlink(outside, join(root, '.network-access'))
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).rejects.toThrow('invalid')

      await rm(join(root, '.network-access'))
      await mkdir(join(root, '.network-access'), { mode: 0o700 })
      await symlink(join(outside, SESSION), join(root, '.network-access', SESSION))
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).rejects.toThrow('invalid')

      await rm(join(root, '.network-access', SESSION))
      await link(join(outside, SESSION), join(root, '.network-access', SESSION))
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).rejects.toThrow('invalid')

      await symlink(root, join(base, 'root-link'))
      await expect(new VpsBotComputerSetting(join(base, 'root-link'), 'network').get(SESSION)).rejects.toThrow('invalid')
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('rejects damaged directory and file permissions instead of repairing or granting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    const directory = join(root, '.network-access')
    try {
      await mkdir(directory, { mode: 0o755 })
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).rejects.toThrow('invalid')
      await chmod(directory, 0o700)
      await writeFile(join(directory, SESSION), '{"version":1,"enabled":true}\n', { mode: 0o644 })
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).rejects.toThrow('invalid')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an existing directory at the exact policy filename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    const directory = join(root, '.network-access')
    try {
      await mkdir(directory, { mode: 0o700 })
      await mkdir(join(directory, SESSION), { mode: 0o700 })
      await expect(new VpsBotComputerSetting(root, 'network').set(SESSION, true)).rejects.toThrow('invalid')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('handles directory creation races and rejects other creation failures', async () => {
    const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const mkdirMock = vi.mocked(fsPromises.mkdir)
    const lstatMock = vi.mocked(fsPromises.lstat)
    const base = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    const root = join(base, 'raced')
    try {
      await mkdir(root, { mode: 0o700 })
      lstatMock.mockImplementationOnce((path, options) => realFs.lstat(path, options))
      lstatMock.mockRejectedValueOnce(Object.assign(new Error('directory not found'), { code: 'ENOENT' }))
      mkdirMock.mockImplementationOnce(async (path, options) => {
        await realFs.mkdir(path, options)
        throw Object.assign(new Error('directory already exists'), { code: 'EEXIST' })
      })
      lstatMock.mockImplementationOnce((path, options) => realFs.lstat(path, options))
      await new VpsBotComputerSetting(root, 'network').set(SESSION, true)
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).resolves.toBe(true)

      const failedRoot = join(base, 'failed')
      await mkdir(failedRoot, { mode: 0o700 })
      mkdirMock.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
      await expect(new VpsBotComputerSetting(failedRoot, 'network').set(SESSION, true)).rejects.toThrow('invalid')
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('normalizes read failures and closes a handle even when close also fails', async () => {
    const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const openMock = vi.mocked(fsPromises.open)
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    const directory = join(root, '.network-access')
    const target = join(directory, SESSION)
    try {
      await mkdir(directory, { mode: 0o700 })
      await writeFile(target, '{"version":1,"enabled":true}\n', { mode: 0o600 })
      openMock.mockRejectedValueOnce(new Error('read denied'))
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).rejects.toThrow('invalid')

      const handle = await realFs.open(target, 'r')
      const originalClose = handle.close.bind(handle)
      vi.spyOn(handle, 'stat').mockRejectedValueOnce(new Error('stat failed'))
      vi.spyOn(handle, 'close').mockRejectedValueOnce(new Error('close failed'))
      openMock.mockResolvedValueOnce(handle)
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).rejects.toThrow('invalid')
      await originalClose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a policy whose bytes exceed the parser limit after a small stat', async () => {
    const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const openMock = vi.mocked(fsPromises.open)
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    const directory = join(root, '.network-access')
    const target = join(directory, SESSION)
    try {
      await mkdir(directory, { mode: 0o700 })
      await writeFile(target, 'x', { mode: 0o600 })
      openMock.mockImplementationOnce(async (path, flags, mode) => {
        const handle = await realFs.open(path, flags, mode)
        vi.spyOn(handle, 'readFile').mockResolvedValueOnce('x'.repeat(129))
        return handle
      })
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).rejects.toThrow('invalid')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects target replacement during publication and attempts temporary cleanup', async () => {
    const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const lstatMock = vi.mocked(fsPromises.lstat)
    const unlinkMock = vi.mocked(fsPromises.unlink)
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    const directory = join(root, '.network-access')
    try {
      await mkdir(directory, { mode: 0o700 })
      const directoryInfo = await realFs.lstat(directory)
      lstatMock.mockImplementationOnce((path, options) => realFs.lstat(path, options))
      lstatMock.mockImplementationOnce((path, options) => realFs.lstat(path, options))
      lstatMock.mockRejectedValueOnce(Object.assign(new Error('target absent'), { code: 'ENOENT' }))
      lstatMock.mockResolvedValueOnce(directoryInfo)
      await expect(new VpsBotComputerSetting(root, 'network').set(SESSION, true)).rejects.toThrow('invalid')

      lstatMock.mockImplementationOnce((path, options) => realFs.lstat(path, options))
      lstatMock.mockImplementationOnce((path, options) => realFs.lstat(path, options))
      lstatMock.mockRejectedValueOnce(Object.assign(new Error('target absent'), { code: 'ENOENT' }))
      lstatMock.mockRejectedValueOnce(Object.assign(new Error('target absent'), { code: 'ENOENT' }))
      lstatMock.mockResolvedValueOnce(directoryInfo)
      unlinkMock.mockRejectedValueOnce(Object.assign(new Error('temporary cleanup raced'), { code: 'ENOENT' }))
      await expect(new VpsBotComputerSetting(root, 'network').set(SESSION, true)).rejects.toThrow('invalid')

      lstatMock.mockImplementationOnce((path, options) => realFs.lstat(path, options))
      lstatMock.mockImplementationOnce((path, options) => realFs.lstat(path, options))
      lstatMock.mockRejectedValueOnce(Object.assign(new Error('target absent'), { code: 'ENOENT' }))
      lstatMock.mockRejectedValueOnce(Object.assign(new Error('target absent'), { code: 'ENOENT' }))
      lstatMock.mockResolvedValueOnce(directoryInfo)
      unlinkMock.mockRejectedValueOnce(Object.assign(new Error('temporary cleanup denied'), { code: 'EACCES' }))
      await expect(new VpsBotComputerSetting(root, 'network').set(SESSION, true)).rejects.toThrow('invalid')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('normalizes a failed temporary write and contains close failures', async () => {
    const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const openMock = vi.mocked(fsPromises.open)
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    const directory = join(root, '.network-access')
    let release: (() => Promise<void>) | undefined
    try {
      await mkdir(directory, { mode: 0o700 })
      openMock.mockImplementationOnce(async (path, flags, mode) => {
        const handle = await realFs.open(path, flags, mode)
        const originalClose = handle.close.bind(handle)
        release = originalClose
        vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(new Error('disk full'))
        vi.spyOn(handle, 'close').mockRejectedValueOnce(new Error('close failed'))
        return handle
      })
      await expect(new VpsBotComputerSetting(root, 'network').set(SESSION, true)).rejects.toThrow('invalid')
      await release?.()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('normalizes a temporary open failure before a handle is created', async () => {
    const openMock = vi.mocked(fsPromises.open)
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    try {
      await mkdir(join(root, '.network-access'), { mode: 0o700 })
      openMock.mockRejectedValueOnce(new Error('temporary open failed'))
      await expect(new VpsBotComputerSetting(root, 'network').set(SESSION, true)).rejects.toThrow('invalid')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a directory sync that returns unsafe metadata or fails to open', async () => {
    const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const openMock = vi.mocked(fsPromises.open)
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    const directory = join(root, '.network-access')
    let release: (() => Promise<void>) | undefined
    try {
      await mkdir(directory, { mode: 0o700 })
      openMock.mockImplementationOnce((path, flags, mode) => realFs.open(path, flags, mode))
      openMock.mockImplementationOnce(async (path, flags, mode) => {
        const handle = await realFs.open(path, flags, mode)
        const info = await realFs.lstat(directory)
        vi.spyOn(info, 'isDirectory').mockReturnValue(false)
        const originalClose = handle.close.bind(handle)
        release = originalClose
        vi.spyOn(handle, 'stat').mockResolvedValueOnce(info)
        vi.spyOn(handle, 'close').mockRejectedValueOnce(new Error('sync close failed'))
        return handle
      })
      await expect(new VpsBotComputerSetting(root, 'network').set(SESSION, true)).rejects.toThrow('invalid')
      await release?.()

      openMock.mockImplementationOnce((path, flags, mode) => realFs.open(path, flags, mode))
      openMock.mockRejectedValueOnce(new Error('sync open failed'))
      await expect(new VpsBotComputerSetting(root, 'network').set(OTHER_SESSION, true)).rejects.toThrow('invalid')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts a numeric stat mode represented as text and rejects malformed error codes', async () => {
    const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const lstatMock = vi.mocked(fsPromises.lstat)
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    const directory = join(root, '.network-access')
    const target = join(directory, SESSION)
    try {
      await mkdir(directory, { mode: 0o700 })
      await writeFile(target, '{"version":1,"enabled":true}\n', { mode: 0o600 })
      const info = await realFs.lstat(target)
      Object.defineProperty(info, 'mode', { value: String(info.mode) })
      lstatMock.mockImplementationOnce((path, options) => realFs.lstat(path, options))
      lstatMock.mockImplementationOnce((path, options) => realFs.lstat(path, options))
      lstatMock.mockResolvedValueOnce(info)
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).resolves.toBe(true)

      lstatMock.mockRejectedValueOnce({ code: 123 })
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).rejects.toThrow('invalid')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('normalizes a primitive filesystem failure without inspecting a code property', async () => {
    const lstatMock = vi.mocked(fsPromises.lstat)
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    try {
      await mkdir(join(root, '.network-access'), { mode: 0o700 })
      lstatMock.mockRejectedValueOnce('filesystem failed')
      await expect(new VpsBotComputerSetting(root, 'network').get(SESSION)).rejects.toThrow('invalid')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads without a no-follow flag on the Windows import path', async () => {
    const platform = process.platform
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    try {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      vi.resetModules()
      const { VpsBotComputerSetting: WindowsSetting } = await import('../src/vps-bot-computer-setting.ts')
      const policy = new WindowsSetting(root, 'network')
      await policy.set(SESSION, true)
      await expect(policy.get(SESSION)).resolves.toBe(true)
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      vi.resetModules()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects traversal-shaped session names before touching the filesystem', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-network-policy-'))
    try {
      const policy = new VpsBotComputerSetting(root, 'network')
      await expect(policy.get('../outside')).rejects.toThrow('invalid')
      await expect(policy.set('bot-session-12345678-1234-4abc-8def-1234567890ab/../outside', true))
        .rejects.toThrow('invalid')
      await expect(lstat(join(root, '.network-access'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
