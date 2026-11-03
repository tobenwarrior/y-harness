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

import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { close as closeFd, fstat as fstatFd, ftruncate as ftruncateFd, read as readFd, write as writeFd } from 'node:fs'
import { lstat, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, resolve, toNamespacedPath } from 'node:path'
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
 * removed and the failure rethrown. Paths ending in `.lock` are reserved for
 * {@link withFileLock} sidecars and are rejected before any temp file is
 * created. Crash durability (fsync) is out of scope.
 * @param filename - final path receiving the content.
 * @param content - complete next file content.
 * @param options - permission bits for the replacement inode.
 */
export async function writeFileAtomic(filename: string, content: string, options: WriteFileAtomicOptions): Promise<void> {
  if (/\.lock$/iu.test(filename)) throw lockSidecarError(filename)
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
const LOCK_SIDECAR_ERROR = 'ERR_ATOMIC_WRITE_LOCK_PATH'
const WINDOWS_INVALID_HANDLE = -1
const WINDOWS_INVALID_FD = -1
const WINDOWS_GENERIC_READ = 0x80000000
const WINDOWS_GENERIC_WRITE = 0x40000000
const WINDOWS_FILE_SHARE_READ = 0x1
const WINDOWS_FILE_SHARE_WRITE = 0x2
const WINDOWS_OPEN_ALWAYS = 4
const WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
const WINDOWS_FILE_ATTRIBUTE_NORMAL = 0x80
const WINDOWS_LOCKFILE_EXCLUSIVE = 0x2
const WINDOWS_LOCKFILE_FAIL_IMMEDIATELY = 0x1
const WINDOWS_ERROR_FILE_NOT_FOUND = 2
const WINDOWS_ERROR_PATH_NOT_FOUND = 3
const WINDOWS_ERROR_ACCESS_DENIED = 5
const WINDOWS_ERROR_SHARING_VIOLATION = 32
const WINDOWS_ERROR_LOCK_VIOLATION = 33

type Koffi = typeof import('koffi')['default']
type WindowsPointer = ReturnType<Koffi['pointer']>

interface WindowsLockBindings {
  readonly createFileW: (
    fileName: string,
    desiredAccess: number,
    shareMode: number,
    security: null,
    creationDisposition: number,
    flagsAndAttributes: number,
    template: null,
  ) => number
  readonly lockFileEx: (
    handle: number,
    flags: number,
    reserved: number,
    bytesLow: number,
    bytesHigh: number,
    overlapped: WindowsPointer,
  ) => number
  readonly unlockFileEx: (
    handle: number,
    reserved: number,
    bytesLow: number,
    bytesHigh: number,
    overlapped: WindowsPointer,
  ) => number
  readonly closeHandle: (handle: number) => number
  readonly getLastError: () => number
  readonly openOsfHandle: (handle: number) => number
}

let windowsLockBindings: WindowsLockBindings | undefined

/** Load the Windows file-lock API only when a Windows lock is requested. */
async function loadWindowsLockBindings(): Promise<WindowsLockBindings> {
  if (windowsLockBindings !== undefined) return windowsLockBindings
  const koffi = (await import('koffi')).default
  const kernel32 = koffi.load('kernel32.dll')
  const node = koffi.load(null)
  windowsLockBindings = {
    createFileW: kernel32.func('__stdcall', 'CreateFileW', 'intptr', [
      'str16', 'uint32', 'uint32', 'void*', 'uint32', 'uint32', 'void*',
    ]) as WindowsLockBindings['createFileW'],
    lockFileEx: kernel32.func('__stdcall', 'LockFileEx', 'int', [
      'intptr', 'uint32', 'uint32', 'uint32', 'uint32', 'void*',
    ]) as WindowsLockBindings['lockFileEx'],
    unlockFileEx: kernel32.func('__stdcall', 'UnlockFileEx', 'int', [
      'intptr', 'uint32', 'uint32', 'uint32', 'void*',
    ]) as WindowsLockBindings['unlockFileEx'],
    closeHandle: kernel32.func('__stdcall', 'CloseHandle', 'int', ['intptr']) as WindowsLockBindings['closeHandle'],
    getLastError: kernel32.func('__stdcall', 'GetLastError', 'uint', []) as WindowsLockBindings['getLastError'],
    openOsfHandle: node.func('uv_open_osfhandle', 'int', ['intptr']) as WindowsLockBindings['openOsfHandle'],
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

function windowsErrorCode(code: number): string {
  switch (code) {
    case WINDOWS_ERROR_FILE_NOT_FOUND:
    case WINDOWS_ERROR_PATH_NOT_FOUND:
      return 'ENOENT'
    case WINDOWS_ERROR_ACCESS_DENIED:
      return 'EACCES'
    case WINDOWS_ERROR_SHARING_VIOLATION:
    case WINDOWS_ERROR_LOCK_VIOLATION:
      return 'EBUSY'
    default:
      return 'EIO'
  }
}

function windowsLockError(syscall: string, code: number, path: string): NodeJS.ErrnoException {
  const error = nativeLockError(syscall, windowsErrorCode(code), code)
  error.path = path
  return error
}

/** Acquire one byte-range lock on the opened Windows lock-file handle. */
async function acquireWindowsLock(lockPath: string): Promise<{
  readonly handle: number
  readonly fd: number
  readonly overlapped: WindowsPointer
}> {
  const api = await loadWindowsLockBindings()
  const handle = api.createFileW(
    toNamespacedPath(resolve(lockPath)),
    WINDOWS_GENERIC_READ | WINDOWS_GENERIC_WRITE,
    WINDOWS_FILE_SHARE_READ | WINDOWS_FILE_SHARE_WRITE,
    null,
    WINDOWS_OPEN_ALWAYS,
    WINDOWS_FILE_ATTRIBUTE_NORMAL | WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT,
    null,
  )
  const createError = api.getLastError()
  if (handle === 0 || handle === WINDOWS_INVALID_HANDLE) throw windowsLockError('CreateFileW', createError, lockPath)
  const overlapped = (await import('koffi')).default.alloc('uint8', 32) as WindowsPointer
  if (api.lockFileEx(handle, WINDOWS_LOCKFILE_EXCLUSIVE | WINDOWS_LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, overlapped) !== 0) {
    const fd = api.openOsfHandle(handle)
    if (fd !== WINDOWS_INVALID_FD) return { handle, fd, overlapped }
    const openError = api.getLastError()
    api.closeHandle(handle)
    throw nativeLockError('uv_open_osfhandle', 'EIO', openError)
  }
  const lockError = api.getLastError()
  api.closeHandle(handle)
  throw windowsLockError('LockFileEx', lockError, lockPath)
}

function readWindowsFd(fd: number, buffer: Buffer, position: number): Promise<number> {
  return new Promise((resolveRead, rejectRead) => {
    readFd(fd, buffer, 0, buffer.byteLength, position, (error, bytesRead) => {
      if (error !== null) rejectRead(error)
      else resolveRead(bytesRead)
    })
  })
}

function writeWindowsFd(fd: number, buffer: Buffer, position: number): Promise<number> {
  return new Promise((resolveWrite, rejectWrite) => {
    writeFd(fd, buffer, 0, buffer.byteLength, position, (error, bytesWritten) => {
      if (error !== null) rejectWrite(error)
      else resolveWrite(bytesWritten)
    })
  })
}

function truncateWindowsFd(fd: number, length: number): Promise<void> {
  return new Promise((resolveTruncate, rejectTruncate) => {
    ftruncateFd(fd, length, (error) => {
      if (error !== null) rejectTruncate(error)
      else resolveTruncate()
    })
  })
}

function closeWindowsFd(fd: number): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    closeFd(fd, (error) => {
      if (error !== null) rejectClose(error)
      else resolveClose()
    })
  })
}

/** Release one byte-range lock and close its Windows file handle. */
async function releaseWindowsLock(
  lockPath: string,
  handle: number,
  fd: number,
  overlapped: WindowsPointer,
): Promise<void> {
  const api = await loadWindowsLockBindings()
  const released = api.unlockFileEx(handle, 0, 1, 0, overlapped)
  const unlockError = released === 0 ? api.getLastError() : undefined
  let closeError: unknown
  try {
    await closeWindowsFd(fd)
  } catch (error) {
    closeError = error
  }
  if (released === 0) throw windowsLockError('UnlockFileEx', unlockError ?? 0, lockPath)
  if (closeError !== undefined) {
    throw closeError instanceof Error ? closeError : new Error('Windows fd close failed')
  }
}

interface HeldLock {
  readonly file: FileHandle | undefined
  readonly windowsLock: {
    readonly handle: number
    readonly fd: number
    readonly overlapped: WindowsPointer
    readonly path: string
  } | undefined
}

function lockProtocolError(lockPath: string): NodeJS.ErrnoException {
  const error = nativeLockError('open', 'ERR_ATOMIC_WRITE_LOCK_PROTOCOL')
  error.path = lockPath
  return error
}

function lockSidecarError(lockPath: string): NodeJS.ErrnoException {
  const error = nativeLockError('writeFileAtomic', LOCK_SIDECAR_ERROR)
  error.path = lockPath
  return error
}

async function writeLockMarker(file: FileHandle, lockPath: string): Promise<void> {
  const marker = Buffer.from(LOCK_PROTOCOL_MARKER)
  const result = await file.write(marker, 0, marker.byteLength, 0)
  if (result.bytesWritten !== marker.byteLength) throw nativeLockError('write', 'EIO', result.bytesWritten)
  try {
    await file.truncate(marker.byteLength)
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    if ((failure as NodeJS.ErrnoException).path === undefined) (failure as NodeJS.ErrnoException).path = lockPath
    throw failure
  }
}

async function readLockMarker(file: FileHandle, lockPath: string): Promise<string> {
  try {
    return await file.readFile('utf8')
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    const code = (failure as NodeJS.ErrnoException).code
    if (code === 'ELOOP' || code === 'EISDIR' || code === 'ENOTDIR') throw lockProtocolError(lockPath)
    if ((failure as NodeJS.ErrnoException).path === undefined) (failure as NodeJS.ErrnoException).path = lockPath
    throw failure
  }
}

function statWindowsFd(fd: number): Promise<{
  readonly size: bigint
  readonly dev: bigint
  readonly ino: bigint
  isFile: () => boolean
}> {
  return new Promise((resolveStat, rejectStat) => {
    fstatFd(fd, { bigint: true }, (error, stats) => {
      if (error !== null) rejectStat(error)
      else resolveStat(stats)
    })
  })
}

async function readWindowsLockMarker(fd: number, lockPath: string): Promise<string> {
  const info = await statWindowsFd(fd)
  if (!info.isFile()) throw lockProtocolError(lockPath)
  const markerLength = Buffer.byteLength(LOCK_PROTOCOL_MARKER)
  if (info.size > BigInt(markerLength)) throw lockProtocolError(lockPath)
  const buffer = Buffer.alloc(Number(info.size))
  if (buffer.byteLength === 0) return ''
  const bytesRead = await readWindowsFd(fd, buffer, 0)
  if (bytesRead !== buffer.byteLength) throw nativeLockError('ReadFile', 'EIO', bytesRead)
  return buffer.toString('utf8')
}

async function writeWindowsLockMarker(fd: number, lockPath: string): Promise<void> {
  const marker = Buffer.from(LOCK_PROTOCOL_MARKER)
  const bytesWritten = await writeWindowsFd(fd, marker, 0)
  if (bytesWritten !== marker.byteLength) throw nativeLockError('WriteFile', 'EIO', bytesWritten)
  try {
    await truncateWindowsFd(fd, marker.byteLength)
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    if ((failure as NodeJS.ErrnoException).path === undefined) (failure as NodeJS.ErrnoException).path = lockPath
    throw failure
  }
}

/** Open and lock a POSIX sidecar without following a symlink. */
async function acquirePosixLock(lockPath: string): Promise<HeldLock> {
  let file: FileHandle
  let created = false
  try {
    file = await open(lockPath, 'wx+', 0o600)
    created = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw error
    const info = await lstat(lockPath).catch((lstatError: unknown) => {
      if ((lstatError as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
      throw lstatError
    })
    if (info !== undefined && !info.isFile()) throw lockProtocolError(lockPath)
    try {
      file = await open(lockPath, fsConstants.O_RDWR | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ELOOP' || code === 'EISDIR' || code === 'ENOTDIR') throw lockProtocolError(lockPath)
      throw error
    }
  }

  try {
    if (!(await file.stat()).isFile()) throw lockProtocolError(lockPath)
    const marker = created ? '' : await readLockMarker(file, lockPath)
    if (marker.length > 0 && marker !== LOCK_PROTOCOL_MARKER) throw lockProtocolError(lockPath)
    await tryLockExclusive(file.fd)
    if (marker.length === 0) await writeLockMarker(file, lockPath)
    return { file, windowsLock: undefined }
  } catch (error) {
    await file.close().catch(() => {})
    throw error
  }
}

async function acquireWindowsFileLock(lockPath: string): Promise<HeldLock> {
  const windowsLock = await acquireWindowsLock(lockPath)
  try {
    const info = await lstat(lockPath)
    if (!info.isFile()) throw lockProtocolError(lockPath)
    const held = await statWindowsFd(windowsLock.fd)
    const current = await stat(lockPath, { bigint: true })
    if (held.dev === 0n || held.ino === 0n || current.dev === 0n || current.ino === 0n
      || held.dev !== current.dev || held.ino !== current.ino) throw lockProtocolError(lockPath)
    const marker = await readWindowsLockMarker(windowsLock.fd, lockPath)
    if (marker.length > 0 && marker !== LOCK_PROTOCOL_MARKER) throw lockProtocolError(lockPath)
    if (marker.length === 0) await writeWindowsLockMarker(windowsLock.fd, lockPath)
    return { file: undefined, windowsLock: { ...windowsLock, path: lockPath } }
  } catch (error) {
    await releaseWindowsLock(lockPath, windowsLock.handle, windowsLock.fd, windowsLock.overlapped).catch(() => {})
    throw error
  }
}

/** Open and acquire the stable kernel lock without path-based cleanup. */
async function acquireLock(lockPath: string): Promise<HeldLock> {
  return process.platform === 'win32'
    ? acquireWindowsFileLock(lockPath)
    : acquirePosixLock(lockPath)
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
  if (lock.windowsLock !== undefined) {
    try {
      await releaseWindowsLock(lock.windowsLock.path, lock.windowsLock.handle, lock.windowsLock.fd, lock.windowsLock.overlapped)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }
  if (lock.file !== undefined) {
    try {
      await lock.file.close()
    } catch (error) {
      lastError ??= error instanceof Error ? error : new Error(String(error))
    }
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
 * lock is a stable `<filename>.lock` file held by POSIX `flock(2)` or a Windows
 * `LockFileEx` byte-range lock; paired with the rename-based commit of
 * {@link writeFileAtomic}, readers stay lock-free and only writers contend.
 * `EAGAIN`, `EWOULDBLOCK`, and Windows `EBUSY` are contention. Contention backs
 * off exponentially and times out after the deadline. The first creator writes
 * a protocol marker while holding the kernel lock. An empty marker is accepted
 * after the kernel lock is acquired so an interrupted creator can be recovered;
 * any other marker is a legacy or unknown protocol and fails closed. The lock path is never
 * removed or renamed: closing the held descriptor or native handle releases the
 * kernel lock, including after process death. Replacing the lock pathname is
 * unsupported because POSIX locks belong to the opened inode; public
 * {@link writeFileAtomic} calls reject sidecar paths, and the next caller must
 * use the stable path. Symlink, directory, and other non-file sidecars fail
 * closed. The parent directory must exist.
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
