import { execFile, spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withFileLock, writeFileAtomic } from '../src/index.ts'

const state = vi.hoisted(() => ({
  markerWriteBytes: undefined as number | undefined,
  renameAttempts: 0,
  renameFailures: [] as string[],
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args)
      const bytes = state.markerWriteBytes
      if (bytes === undefined || !String(args[0]).endsWith('.lock')) return file
      const write = file.write.bind(file)
      file.write = (async (...writeArgs: Parameters<FileHandle['write']>) => {
        const result = await write(...writeArgs)
        return { ...result, bytesWritten: bytes }
      }) as FileHandle['write']
      return file
    }),
    rename: (async (...args: Parameters<typeof actual.rename>) => {
      state.renameAttempts += 1
      const code = state.renameFailures.shift()
      if (code !== undefined) {
        if (code === 'NO_CODE') throw new Error('injected rename failure without a code')
        throw Object.assign(new Error(`${code}: injected rename failure`), { code })
      }
      return actual.rename(...args)
    }),
  }
})

const scratchDirs: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  state.markerWriteBytes = undefined
  state.renameAttempts = 0
  state.renameFailures.length = 0
  await Promise.all(scratchDirs.splice(0).map(dir => rm(dir, {
    force: true,
    maxRetries: 10,
    recursive: true,
    retryDelay: 20,
  })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-atomic-write-'))
  scratchDirs.push(dir)
  return dir
}

const LOCK_PROTOCOL_MARKER = 'dsh-atomic-write-kernel-lock-v1\n'

/** Resolve once the stable lock file exists, so contention is measured against a held lock. */
async function waitForLock(lockPath: string): Promise<void> {
  for (;;) {
    try {
      await stat(lockPath)
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
}

describe('writeFileAtomic', () => {
  it('creates the file and its parents with exactly the stated mode', async () => {
    const dir = await scratch()
    const target = join(dir, 'nested', 'deep', 'doc.yaml')
    await writeFileAtomic(target, 'a: 1\n', { dirMode: 0o700, mode: 0o600 })
    expect(await readFile(target, 'utf8')).toBe('a: 1\n')
    if (process.platform !== 'win32') {
      expect((await stat(dirname(target))).mode & 0o777).toBe(0o700)
      expect((await stat(target)).mode & 0o777).toBe(0o600)
    }
  })

  it('replaces existing content and narrows a wider-permission file to the stated mode', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    await writeFile(target, 'old', { mode: 0o644 })
    await writeFileAtomic(target, 'new', { mode: 0o600 })
    expect(await readFile(target, 'utf8')).toBe('new')
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600)
  })

  it('replaces a symlinked target itself without writing through to the referent', async () => {
    const dir = await scratch()
    const victim = join(dir, 'victim')
    await writeFile(victim, 'victim-content')
    const target = join(dir, 'doc.yaml')
    await symlink(victim, target)
    await writeFileAtomic(target, 'replaced', { mode: 0o600 })
    expect((await lstat(target)).isSymbolicLink()).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('replaced')
    expect(await readFile(victim, 'utf8')).toBe('victim-content')
  })

  it('rejects a reserved lock sidecar before following a symlink referent', async () => {
    const dir = await scratch()
    const victim = join(dir, 'victim')
    const lockPath = join(dir, 'document.lock')
    await writeFile(victim, 'protected')
    await symlink(victim, lockPath)

    await expect(writeFileAtomic(lockPath, 'replacement', { mode: 0o600 }))
      .rejects.toMatchObject({ code: 'ERR_ATOMIC_WRITE_LOCK_PATH' })
    expect(await readFile(victim, 'utf8')).toBe('protected')
    expect((await lstat(lockPath)).isSymbolicLink()).toBe(true)
  })

  it('retries transient Windows rename interference and commits the replacement', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.useFakeTimers()
    const dir = await scratch()
    const target = join(dir, 'document')
    await writeFile(target, 'old')
    state.renameFailures.push('EACCES', 'EBUSY', 'EPERM')

    const replacement = writeFileAtomic(target, 'new', { mode: 0o600 })
    await vi.waitFor(() => { expect(state.renameAttempts).toBeGreaterThan(0) })
    await vi.runAllTimersAsync()
    await replacement

    expect(state.renameAttempts).toBe(4)
    expect(await readFile(target, 'utf8')).toBe('new')
    expect((await readdir(dir)).filter(entry => entry.includes('.tmp'))).toEqual([])
  })

  it('leaves no temp sibling after bounded Windows rename retries expire', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.useFakeTimers()
    const dir = await scratch()
    const target = join(dir, 'document')
    await writeFile(target, 'old')
    state.renameFailures.push(...Array.from({ length: 9 }, () => 'EPERM'))

    const replacement = writeFileAtomic(target, 'new', { mode: 0o600 })
    await vi.waitFor(() => { expect(state.renameAttempts).toBeGreaterThan(0) })
    await vi.runAllTimersAsync()
    await expect(replacement).rejects.toMatchObject({ code: 'EPERM' })

    expect(state.renameAttempts).toBe(9)
    expect(await readFile(target, 'utf8')).toBe('old')
    expect((await readdir(dir)).filter(entry => entry.includes('.tmp'))).toEqual([])
  })

  it('does not retry a Windows rename failure without a transient code', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const dir = await scratch()
    const target = join(dir, 'document')
    state.renameFailures.push('NO_CODE')

    await expect(writeFileAtomic(target, 'new', { mode: 0o600 })).rejects.toThrow(/without a code/)
    expect(state.renameAttempts).toBe(1)
    expect((await readdir(dir)).filter(entry => entry.includes('.tmp'))).toEqual([])
  })

  it('does not retry rename permission failures outside Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const dir = await scratch()
    const target = join(dir, 'document')
    state.renameFailures.push('EPERM')

    await expect(writeFileAtomic(target, 'new', { mode: 0o600 })).rejects.toMatchObject({ code: 'EPERM' })
    expect(state.renameAttempts).toBe(1)
  })
})

describe('withFileLock', () => {
  it('creates a stable kernel lock and leaves it after normal release', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')

    await expect(withFileLock(target, async () => 'acquired', { waitMs: 0 })).resolves.toBe('acquired')
    expect(await readFile(`${target}.lock`, 'utf8')).toBe(LOCK_PROTOCOL_MARKER)
  })

  it('fails closed when lock-marker writing is short', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    const operation = vi.fn(async () => {})
    state.markerWriteBytes = LOCK_PROTOCOL_MARKER.length - 1

    await expect(withFileLock(target, operation, { waitMs: 0 })).rejects.toMatchObject({ code: 'EIO' })
    expect(operation).not.toHaveBeenCalled()
  })

  it('serializes a second writer until the first kernel lock is released', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    let release = (): void => {}
    const holder = withFileLock(target, () => new Promise<void>((resolve) => { release = resolve }))
    await waitForLock(`${target}.lock`)

    const contender = withFileLock(target, async () => 'contender', { waitMs: 10_000 })
    await new Promise(resolve => setTimeout(resolve, 25))
    release()
    await holder
    await expect(contender).resolves.toBe('contender')
    expect(await readFile(`${target}.lock`, 'utf8')).toBe(LOCK_PROTOCOL_MARKER)
  })

  it('times out without running a contended operation', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    let release = (): void => {}
    const holder = withFileLock(target, () => new Promise<void>((resolve) => { release = resolve }))
    await waitForLock(`${target}.lock`)

    const operation = vi.fn(async () => {})
    await expect(withFileLock(target, operation, { waitMs: 50 })).rejects.toThrow(/timed out waiting for the writer lock/)
    expect(operation).not.toHaveBeenCalled()
    release()
    await holder
  })

  it('rejects an invalid parent hierarchy before running the operation', async () => {
    const dir = await scratch()
    const parent = join(dir, 'not-a-directory')
    await writeFile(parent, 'occupied')
    const operation = vi.fn(async () => {})

    await expect(withFileLock(join(parent, 'document'), operation, { waitMs: 0 }))
      .rejects.toThrow(/ENOENT|ENOTDIR|not a directory/i)
    expect(operation).not.toHaveBeenCalled()
  })

  it('fails closed on an incompatible legacy lock file', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    await writeFile(`${target}.lock`, `${String(process.pid)}\n`)

    await expect(withFileLock(target, async () => {}, { waitMs: 0 }))
      .rejects.toMatchObject({ code: 'ERR_ATOMIC_WRITE_LOCK_PROTOCOL' })
  })

  it('rejects public replacement of the lock sidecar while held', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    const lockPath = `${target}.lock`

    await expect(withFileLock(target, async () => {
      await writeFileAtomic(lockPath, 'replacement', { mode: 0o600 })
    }, { waitMs: 0 })).rejects.toMatchObject({ code: 'ERR_ATOMIC_WRITE_LOCK_PATH' })

    expect(await readFile(lockPath, 'utf8')).toBe(LOCK_PROTOCOL_MARKER)
  })

  it('rejects a symlink lock sidecar without touching its referent', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    const lockPath = `${target}.lock`
    const victim = join(dir, 'victim')
    await writeFile(victim, 'protected')
    await symlink(victim, lockPath)

    await expect(withFileLock(target, async () => {}, { waitMs: 0 }))
      .rejects.toMatchObject({ code: 'ERR_ATOMIC_WRITE_LOCK_PROTOCOL' })
    expect(await readFile(victim, 'utf8')).toBe('protected')
  })

  it('rejects a predecessor directory lock as an incompatible protocol', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    await mkdir(`${target}.lock`)

    await expect(withFileLock(target, async () => {}, { waitMs: 0 }))
      .rejects.toMatchObject({ code: 'ERR_ATOMIC_WRITE_LOCK_PROTOCOL' })
  })

  it('fails closed without blocking on a FIFO lock sidecar', async () => {
    if (process.platform === 'win32') return
    const dir = await scratch()
    const target = join(dir, 'document')
    const lockPath = `${target}.lock`
    await execFileAsync('mkfifo', [lockPath])
    const modulePath = new URL('../src/index.ts', import.meta.url).href
    const childSource = `
      import { withFileLock } from ${JSON.stringify(modulePath)}
      try {
        await withFileLock(${JSON.stringify(target)}, async () => {}, { waitMs: 0 })
        process.exitCode = 1
      } catch (error) {
        if (error?.code !== 'ERR_ATOMIC_WRITE_LOCK_PROTOCOL') process.exitCode = 1
      }
    `
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', childSource], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const result = await new Promise<number>((resolveResult, rejectResult) => {
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, 1_000)
      child.once('error', (error) => {
        clearTimeout(timer)
        rejectResult(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (timedOut) rejectResult(new Error(`FIFO lock acquisition blocked: ${stderr}`))
        else resolveResult(code ?? 1)
      })
    })
    expect(result, stderr).toBe(0)
  })

  it('recovers an uninitialized lock file after its creator exited', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    await writeFile(`${target}.lock`, '')

    await expect(withFileLock(target, async () => 'recovered', { waitMs: 0 }))
      .resolves.toBe('recovered')
    expect(await readFile(`${target}.lock`, 'utf8')).toBe(LOCK_PROTOCOL_MARKER)
  })
})
