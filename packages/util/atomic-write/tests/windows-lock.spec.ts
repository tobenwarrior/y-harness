import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = {
  active: new Set<string>(),
  handles: new Map<number, string>(),
  nextHandle: 1,
  paths: [] as string[],
  lastError: 0,
}

const fakeKoffi = {
  alloc: (_type: string, _length: number) => ({}),
  load: () => ({
    func: (_convention: string, name: string) => {
      if (name === 'CreateFileW') {
        return (path: string) => {
          const canonical = resolve(path)
          const handle = state.nextHandle++
          state.handles.set(handle, canonical)
          state.paths.push(canonical)
          state.lastError = state.paths.filter(candidate => candidate === canonical).length === 1 ? 0 : 183
          return handle
        }
      }
      if (name === 'LockFileEx') {
        return (handle: number) => {
          const path = state.handles.get(handle)
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
          const path = state.handles.get(handle)
          if (path !== undefined) state.active.delete(path)
          return 1
        }
      }
      if (name === 'CloseHandle') {
        return (handle: number) => {
          state.handles.delete(handle)
          return 1
        }
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
  await Promise.all(scratchDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
  state.active.clear()
  state.handles.clear()
  state.nextHandle = 1
  state.paths.length = 0
  state.lastError = 0
})

async function waitForLock(lockPath: string): Promise<void> {
  for (;;) {
    try {
      await stat(lockPath)
      return
    } catch {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 5))
    }
  }
}

describe('Windows lock handle', () => {
  it('uses one native byte lock for path aliases', async () => {
    vi.doMock('koffi', () => ({ default: fakeKoffi }))
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.resetModules()
    const { withFileLock } = await import('../src/index.ts?windows-lock-alias') as typeof import('../src/index.ts')
    const dir = await mkdtemp(join(tmpdir(), 'dsh-atomic-write-win32-'))
    scratchDirs.push(dir)
    await mkdir(join(dir, 'alias'))
    const alias = join(dir, 'alias', '..', 'document')
    const canonical = join(dir, 'document')
    await writeFile(`${canonical}.lock`, '')
    let release = (): void => {}
    const holder = withFileLock(alias, () => new Promise<void>((resolveRelease) => { release = resolveRelease }))
    await waitForLock(`${alias}.lock`)

    const contender = withFileLock(canonical, async () => 'unexpected', { waitMs: 50 })
    await expect(contender).rejects.toThrow(/timed out waiting for the writer lock/)
    release()
    await holder
    await expect(withFileLock(canonical, async () => 'acquired', { waitMs: 0 })).resolves.toBe('acquired')
    expect(new Set(state.paths)).toEqual(new Set([resolve(`${canonical}.lock`)]))
    expect(await readFile(`${canonical}.lock`, 'utf8')).toContain('dsh-atomic-write-kernel-lock-v1')
  })

  it('fails closed on a symlink sidecar before opening its referent', async () => {
    vi.doMock('koffi', () => ({ default: fakeKoffi }))
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.resetModules()
    const { withFileLock } = await import('../src/index.ts?windows-lock-symlink') as typeof import('../src/index.ts')
    const dir = await mkdtemp(join(tmpdir(), 'dsh-atomic-write-win32-'))
    scratchDirs.push(dir)
    const victim = join(dir, 'victim')
    const lockPath = join(dir, 'document.lock')
    await writeFile(victim, 'protected')
    await symlink(victim, lockPath)

    await expect(withFileLock(join(dir, 'document'), async () => {}, { waitMs: 0 }))
      .rejects.toMatchObject({ code: 'ERR_ATOMIC_WRITE_LOCK_PROTOCOL' })
    expect(await readFile(victim, 'utf8')).toBe('protected')
    expect(state.paths).toEqual([])
  })
})
