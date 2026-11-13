import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, toNamespacedPath } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = {
  active: new Set<string>(),
  handles: new Map<number, { readonly path: string; readonly fd: number }>(),
  fds: new Set<number>(),
  nextHandle: 1,
  paths: [] as string[],
  lastError: 0,
  nodeOpenCalls: 0,
  replaceAfterNodeOpen: false,
  replaceAfterNativeOpen: false,
  fakeFilePath: undefined as string | undefined,
}

const fakeKoffi = {
  alloc: (_type: string, _length: number) => ({}),
  load: () => ({
    func: (...args: [string, string, ...unknown[]]) => {
      const name = args[0] === '__stdcall' ? args[1] : args[0]
      if (name === 'CreateFileW') {
        return (path: string) => {
          const canonical = resolve(path)
          const handle = state.nextHandle++
          let isSymbolicLink = false
          try {
            isSymbolicLink = lstatSync(canonical).isSymbolicLink()
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          const fd = isSymbolicLink
            ? openSync(state.fakeFilePath ?? `${canonical}.fake-native-file`, fsConstants.O_RDWR | fsConstants.O_CREAT)
            : openSync(canonical, fsConstants.O_RDWR | fsConstants.O_CREAT)
          state.handles.set(handle, { path: canonical, fd })
          state.fds.add(fd)
          state.paths.push(canonical)
          state.lastError = state.paths.filter(candidate => candidate === canonical).length === 1 ? 0 : 183
          if (state.replaceAfterNativeOpen) {
            const replacement = `${canonical}.replacement`
            const victim = `${canonical}.victim`
            renameSync(canonical, replacement)
            writeFileSync(victim, 'protected')
            symlinkSync(victim, canonical)
          }
          return handle
        }
      }
      if (name === 'LockFileEx') {
        return (handle: number) => {
          const path = state.handles.get(handle)?.path
          if (path === undefined || state.active.has(path)) {
            state.lastError = 33
            return 0
          }
          state.active.add(path)
          return 1
        }
      }
      if (name === 'UnlockFileEx') {
        return (handle: number) => {
          const path = state.handles.get(handle)?.path
          if (path !== undefined) state.active.delete(path)
          return 1
        }
      }
      if (name === 'CloseHandle') {
        return (handle: number) => {
          const entry = state.handles.get(handle)
          if (entry !== undefined) {
            closeSync(entry.fd)
            state.fds.delete(entry.fd)
            state.handles.delete(handle)
          }
          return 1
        }
      }
      if (name === 'uv_open_osfhandle') {
        return (handle: number) => state.handles.get(handle)?.fd ?? -1
      }
      if (name === 'GetLastError') return () => state.lastError
      throw new Error(`unexpected Win32 binding ${name}`)
    },
  }),
}

const scratchDirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.doUnmock('koffi')
  vi.doUnmock('node:fs/promises')
  await Promise.all(scratchDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
  for (const fd of state.fds) {
    try {
      closeSync(fd)
    } catch {
      // The source closes transferred handles through the Node fd API.
    }
  }
  state.active.clear()
  state.handles.clear()
  state.fds.clear()
  state.nextHandle = 1
  state.paths.length = 0
  state.lastError = 0
  state.nodeOpenCalls = 0
  state.replaceAfterNodeOpen = false
  state.replaceAfterNativeOpen = false
  state.fakeFilePath = undefined
})

function fdIsClosed(fd: number): boolean {
  try {
    fstatSync(fd)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EBADF'
  }
}

async function waitForLock(): Promise<void> {
  for (;;) {
    if (state.active.size > 0) return
    await new Promise(resolveDelay => setTimeout(resolveDelay, 5))
  }
}

describe('Windows lock handle', () => {
  it('uses one native byte lock for path aliases', async () => {
    vi.doMock('koffi', () => ({ default: fakeKoffi }))
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.resetModules()
    const entryPath: string = '../src/index.ts?windows-lock-alias'
    const { withFileLock } = await import(/* @vite-ignore */ entryPath) as typeof import('../src/index.ts')
    const dir = await mkdtemp(join(tmpdir(), 'dsh-atomic-write-win32-'))
    scratchDirs.push(dir)
    await mkdir(join(dir, 'alias'))
    const alias = join(dir, 'alias', '..', 'document')
    const canonical = join(dir, 'document')
    await writeFile(`${canonical}.lock`, '')
    let release = (): void => {}
    const holder = withFileLock(alias, () => new Promise<void>((resolveRelease) => { release = resolveRelease }))
    await waitForLock()

    const contender = withFileLock(canonical, async () => 'unexpected', { waitMs: 50 })
    await expect(contender).rejects.toThrow(/timed out waiting for the writer lock/)
    release()
    await holder
    await expect(withFileLock(canonical, async () => 'acquired', { waitMs: 0 })).resolves.toBe('acquired')
    expect(new Set(state.paths)).toEqual(new Set([toNamespacedPath(resolve(`${canonical}.lock`))]))
    expect(await readFile(`${canonical}.lock`, 'utf8')).toContain('dsh-atomic-write-kernel-lock-v1')
    expect(Array.from(state.fds).every(fdIsClosed)).toBe(true)
  })

  it('fails closed on a symlink sidecar before opening its referent', async () => {
    vi.doMock('koffi', () => ({ default: fakeKoffi }))
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.resetModules()
    const entryPath: string = '../src/index.ts?windows-lock-symlink'
    const { withFileLock } = await import(/* @vite-ignore */ entryPath) as typeof import('../src/index.ts')
    const dir = await mkdtemp(join(tmpdir(), 'dsh-atomic-write-win32-'))
    scratchDirs.push(dir)
    const victim = join(dir, 'victim')
    const lockPath = join(dir, 'document.lock')
    await writeFile(victim, 'protected')
    await symlink(victim, lockPath)
    state.fakeFilePath = join(dir, 'native-scratch')

    await expect(withFileLock(join(dir, 'document'), async () => {}, { waitMs: 0 }))
      .rejects.toMatchObject({ code: 'ERR_ATOMIC_WRITE_LOCK_PROTOCOL' })
    expect(await readFile(victim, 'utf8')).toBe('protected')
    expect(state.paths).toEqual([])
    expect(Array.from(state.fds).every(fdIsClosed)).toBe(true)
  })

  it('rejects a directory sidecar before opening it natively', async () => {
    vi.doMock('koffi', () => ({ default: fakeKoffi }))
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.resetModules()
    const entryPath: string = '../src/index.ts?windows-lock-directory'
    const { withFileLock } = await import(/* @vite-ignore */ entryPath) as typeof import('../src/index.ts')
    const dir = await mkdtemp(join(tmpdir(), 'dsh-atomic-write-win32-'))
    scratchDirs.push(dir)
    const target = join(dir, 'document')
    const lockPath = `${target}.lock`
    await mkdir(lockPath)

    await expect(withFileLock(target, async () => {}, { waitMs: 0 }))
      .rejects.toMatchObject({ code: 'ERR_ATOMIC_WRITE_LOCK_PROTOCOL' })
    expect(state.paths).toEqual([])
  })

  it('does not use a pathname-open during a replacement race', async () => {
    vi.doMock('koffi', () => ({ default: fakeKoffi }))
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>()
      return {
        ...actual,
        open: async (...args: Parameters<typeof actual.open>) => {
          state.nodeOpenCalls += 1
          const file = await actual.open(...args)
          if (state.replaceAfterNodeOpen) {
            const path = String(args[0])
            const replacement = `${path}.replacement`
            const victim = `${path}.victim`
            renameSync(path, replacement)
            writeFileSync(victim, 'protected')
            symlinkSync(victim, path)
          }
          return file
        },
      }
    })
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.resetModules()
    const entryPath: string = '../src/index.ts?windows-lock-race'
    const { withFileLock } = await import(/* @vite-ignore */ entryPath) as typeof import('../src/index.ts')
    const dir = await mkdtemp(join(tmpdir(), 'dsh-atomic-write-win32-'))
    scratchDirs.push(dir)
    const target = join(dir, 'document')
    const lockPath = `${target}.lock`
    await writeFile(lockPath, '')
    state.replaceAfterNodeOpen = true

    await expect(withFileLock(target, async () => 'acquired', { waitMs: 0 })).resolves.toBe('acquired')
    expect(state.nodeOpenCalls).toBe(0)
    expect(await readFile(lockPath, 'utf8')).toContain('dsh-atomic-write-kernel-lock-v1')
    expect(Array.from(state.fds).every(fdIsClosed)).toBe(true)
  })

  it('rejects a pathname replacement after native open before marker access', async () => {
    vi.doMock('koffi', () => ({ default: fakeKoffi }))
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.resetModules()
    const entryPath: string = '../src/index.ts?windows-lock-native-race'
    const { withFileLock } = await import(/* @vite-ignore */ entryPath) as typeof import('../src/index.ts')
    const dir = await mkdtemp(join(tmpdir(), 'dsh-atomic-write-win32-'))
    scratchDirs.push(dir)
    const target = join(dir, 'document')
    const lockPath = `${target}.lock`
    const victim = `${lockPath}.victim`
    await writeFile(lockPath, '')
    state.replaceAfterNativeOpen = true

    await expect(withFileLock(target, async () => {}, { waitMs: 0 }))
      .rejects.toMatchObject({ code: 'ERR_ATOMIC_WRITE_LOCK_PROTOCOL' })
    expect(await readFile(victim, 'utf8')).toBe('protected')
    expect(Array.from(state.fds).every(fdIsClosed)).toBe(true)
  })
})
