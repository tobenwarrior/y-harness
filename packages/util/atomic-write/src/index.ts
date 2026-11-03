/**
 * Atomic file replacement and kernel-backed writer coordination.
 * `writeFileAtomic` writes a random-suffix sibling with exclusive create and
 * the caller's permission bits, then renames it over the target, so readers
 * observe either the old or the new complete content and a replaced file ends
 * up with exactly the stated mode. `withFileLock` serializes cross-process
 * writers of one file through a kernel-owned `<file>.lock` handle, so a
 * read-modify-write cycle can never resurrect a state another writer just
 * replaced; readers stay lock-free because the rename commit is atomic. The
 * lock path is never removed or renamed: the operating system releases the
 * handle when its process exits.
 * @module @yharness/atomic-write
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { tryLockExclusive } from '@yharness/node-addon-system/flock'

const WINDOWS_TRANSIENT_RENAME_ERRORS: ReadonlySet<string> = new Set(['EACCES', 'EBUSY', 'EPERM'])
const WINDOWS_RENAME_RETRY_INITIAL_MS = 20
const WINDOWS_RENAME_RETRY_MAX_MS = 200
const WINDOWS_RENAME_RETRY_LIMIT = 8

/** Whether Windows reported temporary interference with an atomic replacement. */
function isTransientWindowsRenameError(error: unknown): boolean {
  if (process.platform !== 'win32') return false
  return WINDOWS_TRANSIENT_RENAME_ERRORS.has((error as NodeJS.ErrnoException | null)?.code ?? '')
}

/** Replace the target after bounded retries for transient Windows interference. */
async function renameAtomicTemp(temp: string, filename: string): Promise<void> {
  let delay = WINDOWS_RENAME_RETRY_INITIAL_MS
  for (let retries = 0;; retries += 1) {
    try {
      await rename(temp, filename)
      return
    } catch (error) {
      if (!isTransientWindowsRenameError(error)) throw error
      if (retries >= WINDOWS_RENAME_RETRY_LIMIT) throw error
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, WINDOWS_RENAME_RETRY_MAX_MS)
  }
}

/**
 * Filesystem options for {@link writeFileAtomic}; `mode` is required so the
 * permission decision stays visible at every call site.
 */
export interface WriteFileAtomicOptions {
  /**
   * Permission bits stamped on the fresh temp inode and carried through the
   * rename (subject to the process umask, like every fresh inode).
   */
  mode: number
  /**
   * Permission bits for parent directories this call creates (subject to the
   * umask; existing directories keep their mode). Omission uses the mkdir
   * default — pass `0o700` when the tree holds user-private data.
   */
  dirMode?: number
}

/**
 * Replace `filename` with `content` in one atomic step, creating parent
 * directories. The content is first written to a random-suffix sibling opened
 * with exclusive create (`wx`): the open refuses to follow a symlink planted
 * at the temp path, and the fresh inode carries `options.mode` through the
 * rename, so replacing a wider-permission file narrows it without a chmod
 * race. The rename also replaces a symlinked target itself instead of writing
 * through to its referent, and the same-directory sibling keeps the rename on
 * one filesystem. Windows replacement retries transient `EACCES`, `EBUSY`,
 * and `EPERM` failures for a bounded interval while the complete temp file
 * remains the rename source. On any remaining failure the temp file is
 * removed and the failure rethrown. Crash durability (fsync) is out of scope.
 * @param filename - final path receiving the content.
 * @param content - complete next file content.
 * @param options - permission bits for the replacement inode.
 */
export async function writeFileAtomic(filename: string, content: string, options: WriteFileAtomicOptions): Promise<void> {
  await mkdir(dirname(filename), {
    recursive: true,
    ...options.dirMode === undefined ? {} : { mode: options.dirMode },
  })
  // TODO(settings-atomic-durability): Use a replacement that fsyncs the file
  // and parent directory and preserves owner-only permissions on Windows.
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { mode: options.mode, flag: 'wx' })
    await renameAtomicTemp(temp, filename)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

const LOCK_PROTOCOL_MARKER = 'dsh-atomic-write-kernel-lock-v1\n'
const WAIT_OBJECT_0 = 0
const WAIT_TIMEOUT = 0x102

interface WindowsLockBindings {
  readonly createSemaphoreW: (security: null, initial: number, maximum: number, name: string) => number
  readonly waitForSingleObject: (handle: number, milliseconds: number) => number
  readonly releaseSemaphore: (handle: number, count: number, previous: null) => number
  readonly closeHandle: (handle: number) => number
  readonly getLastError: () => number
}

let windowsLockBindings: WindowsLockBindings | undefined

/** Load the Windows semaphore API only when a Windows lock is requested. */
async function loadWindowsLockBindings(): Promise<WindowsLockBindings> {
  if (windowsLockBindings !== undefined) return windowsLockBindings
  const koffi = (await import('koffi')).default
  const kernel32 = koffi.load('kernel32.dll')
  windowsLockBindings = {
    createSemaphoreW: kernel32.func('__stdcall', 'CreateSemaphoreW', 'intptr', ['void*', 'int', 'int', 'str16']) as WindowsLockBindings['createSemaphoreW'],
    waitForSingleObject: kernel32.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr', 'uint']) as WindowsLockBindings['waitForSingleObject'],
    releaseSemaphore: kernel32.func('__stdcall', 'ReleaseSemaphore', 'int', ['intptr', 'int', 'void*']) as WindowsLockBindings['releaseSemaphore'],
    closeHandle: kernel32.func('__stdcall', 'CloseHandle', 'int', ['intptr']) as WindowsLockBindings['closeHandle'],
    getLastError: kernel32.func('__stdcall', 'GetLastError', 'uint', []) as WindowsLockBindings['getLastError'],
  }
  return windowsLockBindings
}

function nativeLockError(syscall: string, code: string, errno?: number): NodeJS.ErrnoException {
  const error = new Error(`${code}: ${syscall} failed`) as NodeJS.ErrnoException
  error.code = code
  error.errno = errno
  error.syscall = syscall
  return error
}

/** Acquire one named Windows semaphore derived from the stable lock path. */
async function acquireWindowsLock(lockPath: string): Promise<number> {
  const api = await loadWindowsLockBindings()
  const name = `Local\\dsh-atomic-write-${createHash('sha256').update(resolve(lockPath).toLowerCase()).digest('hex')}`
  const handle = api.createSemaphoreW(null, 1, 1, name)
  if (handle === 0) throw nativeLockError('CreateSemaphoreW', 'EIO', api.getLastError())
  const wait = api.waitForSingleObject(handle, 0)
  if (wait === WAIT_OBJECT_0) return handle
  api.closeHandle(handle)
  if (wait === WAIT_TIMEOUT) throw nativeLockError('WaitForSingleObject', 'EBUSY')
  throw nativeLockError('WaitForSingleObject', 'EIO', api.getLastError())
}

/** Release one named Windows semaphore. */
async function releaseWindowsLock(handle: number): Promise<void> {
  const api = await loadWindowsLockBindings()
  const released = api.releaseSemaphore(handle, 1, null)
  const closed = api.closeHandle(handle)
  if (released === 0 || closed === 0) throw nativeLockError('ReleaseSemaphore', 'EIO', api.getLastError())
}

interface HeldLock {
  readonly file: FileHandle
  readonly windowsHandle: number | undefined
}

function lockProtocolError(lockPath: string): NodeJS.ErrnoException {
  const error = nativeLockError('open', 'ERR_ATOMIC_WRITE_LOCK_PROTOCOL')
  error.path = lockPath
  return error
}

/** Open and acquire the stable kernel lock without path-based cleanup. */
async function acquireLock(lockPath: string): Promise<HeldLock> {
  let file: FileHandle
  let created = false
  try {
    file = await open(lockPath, 'wx+', 0o600)
    created = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw error
    file = await open(lockPath, 'r+')
  }

  let windowsHandle: number | undefined
  try {
    let marker = ''
    if (!created) {
      marker = await file.readFile('utf8')
      // An empty file is either a creator between open and initialization or a
      // creator that exited before initialization. The kernel lock decides
      // which case it is; any other non-marker is an older protocol whose
      // holder cannot be coordinated safely with a kernel lock.
      if (marker.length > 0 && marker !== LOCK_PROTOCOL_MARKER) throw lockProtocolError(lockPath)
    }
    if (process.platform === 'win32') {
      windowsHandle = await acquireWindowsLock(lockPath)
    } else {
      await tryLockExclusive(file.fd)
    }
    if (created || marker.length === 0) {
      const markerBytes = Buffer.from(LOCK_PROTOCOL_MARKER)
      await file.write(markerBytes, 0, markerBytes.byteLength, 0)
      await file.truncate(LOCK_PROTOCOL_MARKER.length)
    }
    return { file, windowsHandle }
  } catch (error) {
    if (windowsHandle !== undefined) await releaseWindowsLock(windowsHandle).catch(() => {})
    await file.close().catch(() => {})
    throw error
  }
}

/** Whether a kernel lock attempt found another live holder. */
function isLockContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EAGAIN' || code === 'EWOULDBLOCK' || code === 'EBUSY'
}

/**
 * Retry cadence for a contended lock. These stay robustness invariants of the
 * cross-process write protocol rather than deployment tunables: they govern how
 * often a contender asks, which no caller has a reason to vary.
 */
const LOCK_RETRY_INITIAL_MS = 20
const LOCK_RETRY_MAX_MS = 200

/**
 * How long a contender waits when the caller states no limit — sized for the
 * render-and-rename cycle every call site had when this package was written.
 * Expiry fails the contender rather than guessing whether the existing lock
 * still has an owner. How long is *worth* waiting is a property of the
 * operation the lock holder runs, which is why {@link FileLockOptions.waitMs}
 * exists; the value here is the floor for an operation that does file work
 * alone.
 */
const DEFAULT_LOCK_WAIT_MS = 2_000

/** Release a held kernel lock by closing its OS handles; the lock path stays in place. */
async function releaseLock(lock: HeldLock): Promise<void> {
  let lastError: Error | undefined
  if (lock.windowsHandle !== undefined) {
    try {
      await releaseWindowsLock(lock.windowsHandle)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }
  try {
    await lock.file.close()
  } catch (error) {
    lastError ??= error instanceof Error ? error : new Error(String(error))
  }
  if (lastError !== undefined) throw lastError
}

/** Options for one {@link withFileLock} acquisition. */
export interface FileLockOptions {
  /**
   * Maximum time to wait for the lock, in milliseconds. State one when the
   * holder's operation legitimately runs longer than file work — a credential
   * mutation that refreshes a token performs a network round trip while
   * holding the lock, and leaving the default in place would fail every other
   * writer of the same file for the duration. Waiting is productive: a
   * contender that acquires the lock afterwards re-reads the committed state.
   */
  waitMs?: number
}

/**
 * Hold the cross-process writer lock for `filename` around one operation. The
 * lock is a stable `<filename>.lock` file held by POSIX `flock(2)` or a named
 * Windows semaphore; paired with the rename-based commit of
 * {@link writeFileAtomic}, readers stay lock-free and only writers contend.
 * `EAGAIN`, `EWOULDBLOCK`, and Windows `EBUSY` are contention. Contention backs
 * off exponentially and times out after the deadline. The first creator writes
 * a protocol marker while holding the kernel lock. An empty marker is accepted
 * after the kernel lock is acquired so an interrupted creator can be recovered;
 * any other marker is a legacy or unknown protocol and fails closed. The lock path is never
 * removed or renamed: closing the held descriptor or semaphore releases the
 * kernel lock, including after process death. Replacing the lock pathname is
 * unsupported because POSIX locks belong to the opened inode; the next caller
 * must use the stable path. The parent directory must exist.
 * @param filename - the file whose writers this lock serializes.
 * @param operation - the read-render-commit cycle to run while holding the lock.
 * @param options - acquisition options; omitted waits {@link DEFAULT_LOCK_WAIT_MS}.
 * @returns the operation's result; the lock releases on both outcomes.
 */
export async function withFileLock<T>(
  filename: string,
  operation: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  const lockPath = `${filename}.lock`
  let lock: HeldLock
  const deadline = Date.now() + (options?.waitMs ?? DEFAULT_LOCK_WAIT_MS)
  let delay = LOCK_RETRY_INITIAL_MS
  for (;;) {
    try {
      lock = await acquireLock(lockPath)
      break
    } catch (error) {
      if (!isLockContention(error)) throw error
    }
    if (Date.now() >= deadline) {
      throw new Error(`atomic-write: timed out waiting for the writer lock at ${lockPath}`)
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
  }
  try {
    return await operation()
  } finally {
    await releaseLock(lock)
  }
}
