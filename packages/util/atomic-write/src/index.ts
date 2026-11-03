/**
 * Zero-dependency atomic file replacement and writer coordination.
 * `writeFileAtomic` writes a random-suffix sibling with exclusive create and
 * the caller's permission bits, then renames it over the target, so readers
 * observe either the old or the new complete content and a replaced file ends
 * up with exactly the stated mode. `withFileLock` serializes cross-process
 * writers of one file through an atomically-created `<file>.lock` directory
 * containing one unique owner record, so a read-modify-write cycle can never
 * resurrect a state another writer just replaced; readers stay lock-free
 * because the rename commit is atomic. A lock whose recorded holder process no
 * longer exists is taken over when the directory protocol can remove it
 * without a pathname race.
 * @module @yharness/atomic-write
 */

import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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

/** Whether an exclusive create found an existing lock. */
async function isLockContention(error: unknown, lockPath: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EEXIST') return true
  if (code !== 'EPERM') return false
  try {
    await lstat(lockPath)
    return true
  } catch {
    // Keep the original EPERM authoritative when lock existence is unproven.
    return false
  }
}

/** Whether the holder a `<pid>\n` record names is proven gone: a signal probe finds no such process. */
function holderExited(record: string): boolean {
  // Any other content is being written or was cut short, which proves nothing about its holder.
  if (!/^\d+\n$/.test(record)) return false
  const pid = Number(record.trim())
  // PID 0 addresses the caller's process group, and the probe accepts only positive int32 PIDs.
  if (pid === 0 || pid > 0x7fffffff) return false
  // This process is running; a runtime whose probe cannot see itself must not take over its own lock.
  if (pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    // EPERM means the process exists under another user.
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

interface LockObservation {
  readonly record: string
  readonly recordPath: string
  readonly directory: boolean
}

const LOCK_OWNER_NAME = /^owner-[0-9a-f]{32}$/

/** The lock record and its unique child path, or undefined when it cannot be read. */
async function readLockRecord(lockPath: string): Promise<LockObservation | undefined> {
  try {
    const current = await lstat(lockPath)
    if (!current.isDirectory()) {
      if (!current.isFile()) return undefined
      return { record: await readFile(lockPath, 'utf8'), recordPath: lockPath, directory: false }
    }
    const owners = (await readdir(lockPath)).filter(name => LOCK_OWNER_NAME.test(name))
    if (owners.length !== 1) return undefined
    const name = owners[0]
    if (name === undefined) return undefined
    const recordPath = join(lockPath, name)
    return { record: await readFile(recordPath, 'utf8'), recordPath, directory: true }
  } catch (error) {
    // A lock that vanished, or that Windows is still deleting, proves nothing about a holder.
    void error
    return undefined
  }
}

/**
 * Remove the lock when its recorded holder exited. Contenders that read the
 * same record serialize on a claim file named after it. Under the claim, the
 * claimant re-reads the lock and probes its PID again, and removes it only
 * when it still holds that record and that PID is still gone: the record's
 * holder can no longer release it, and no other contender can remove it
 * without the claim, so a removal never deletes a lock another contender
 * acquired after the dead holder's, including one whose holder reused the PID.
 * @returns Whether this call removed the dead holder's lock.
 */
async function takeOverExitedLock(lockPath: string): Promise<boolean> {
  const observed = await readLockRecord(lockPath)
  // Legacy regular-file locks are deliberately not removed: no portable
  // operation can conditionally unlink that pathname after verification.
  if (observed === undefined || !observed.directory || !holderExited(observed.record)) return false
  const claim = `${lockPath}.takeover-${createHash('sha256').update(observed.record).digest('hex').slice(0, 16)}`
  try {
    await writeFile(claim, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    // Another contender owns the claim for this record, or Windows still deletes the claim it released.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'EPERM') return false
    throw error
  }
  try {
    const current = await readLockRecord(lockPath)
    if (current === undefined || !current.directory
      || current.recordPath !== observed.recordPath
      || current.record !== observed.record
      || !holderExited(observed.record)) return false
    try {
      await rm(observed.recordPath, { force: true })
    } catch (error) {
      // Windows can refuse the removal while other software briefly holds the file; the next attempt retries.
      void error
      return false
    }
    try {
      await rmdir(lockPath)
      return true
    } catch (error) {
      // A successor's owner entry makes its directory non-empty, so rmdir
      // fails without touching that successor. An absent path is already free.
      const code = (error as NodeJS.ErrnoException | null)?.code
      return code === 'ENOENT'
    }
  } finally {
    await rm(claim, { force: true }).catch((error: unknown) => {
      // A claim left behind names a record that is no longer the lock, so it blocks no later takeover.
      void error
    })
  }
}

/**
 * Retry cadence for a contended lock. These stay robustness invariants of the
 * cross-process write protocol rather than deployment tunables: they govern how
 * often a contender asks, which no caller has a reason to vary.
 */
const LOCK_RETRY_INITIAL_MS = 20
const LOCK_RETRY_MAX_MS = 200
const LOCK_RELEASE_RETRY_LIMIT = 2
const LOCK_OWNER_PREFIX = 'owner-'

/** The unique owner entry created inside one lock directory. */
interface LockOwner {
  readonly record: string
  readonly recordPath: string
  readonly lockPath: string
}

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

/**
 * Release a held lock without leaving its pathname occupied after the
 * operation has settled. The owner entry has a unique name, and removing the
 * empty lock directory is atomic: a successor's owner entry makes `rmdir`
 * fail without removing the successor. A transient owner-entry unlink failure
 * is retried; after the bounded attempts release fails closed and leaves the
 * lock in place.
 */
async function releaseLock(owner: LockOwner): Promise<void> {
  let lastError: Error | undefined
  for (let attempt = 0; attempt < LOCK_RELEASE_RETRY_LIMIT; attempt += 1) {
    try {
      await rm(owner.recordPath, { force: true })
      lastError = undefined
      break
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }
  if (lastError !== undefined) throw lastError
  await removeEmptyLockDirectory(owner.lockPath)
}

/** Remove only an empty lock directory; an occupied successor remains intact. */
async function removeEmptyLockDirectory(lockPath: string): Promise<void> {
  let lastError: Error | undefined
  for (let attempt = 0; attempt < LOCK_RELEASE_RETRY_LIMIT; attempt += 1) {
    try {
      await rmdir(lockPath)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOTDIR') return
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }
  if (lastError !== undefined) throw lastError
  throw new Error(`atomic-write: failed to remove lock directory ${lockPath}`)
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
 * lock is an atomically-created directory (`<filename>.lock`) with one random
 * owner entry containing the holder's PID; paired with the rename-based commit
 * of {@link writeFileAtomic}, readers stay lock-free and only writers contend.
 * `EEXIST` is contention directly; an `EPERM` is contention only when a fresh
 * `lstat` confirms the lock path exists, covering Windows exclusive-create
 * behavior. Windows retries one unconfirmed EPERM because the holder can
 * release before the probe; a repeated unconfirmed permission error is
 * rethrown. A contender removes a directory lock and retries at once when no
 * process with its PID exists (`ESRCH`), but deliberately leaves legacy
 * regular-file locks for an operator because no portable conditional unlink is
 * available for that protocol. Any other lock, including one whose holder
 * exists under another user (`EPERM`), whose record is incomplete, or whose
 * directory is ambiguous, is waited for. Contention backs off exponentially
 * and times out after the deadline. A holder whose PID a live process reused
 * keeps its lock until an operator removes it. Takeover proves only that the
 * recorded process exited: an operation that starts other writers must stop
 * them with it or leave its successor a way to find them. PIDs are compared on
 * the contender's host, so writers on other hosts or in other PID namespaces
 * sharing the file are unsupported and could both hold the lock. The parent
 * directory must exist.
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
  const record = `${process.pid}\n`
  let owner: LockOwner | undefined
  const deadline = Date.now() + (options?.waitMs ?? DEFAULT_LOCK_WAIT_MS)
  let delay = LOCK_RETRY_INITIAL_MS
  let retriedUnconfirmedPermissionError = false
  for (;;) {
    let created = false
    try {
      await mkdir(lockPath, { mode: 0o700 })
      created = true
      const recordPath = join(lockPath, `${LOCK_OWNER_PREFIX}${randomBytes(16).toString('hex')}`)
      await writeFile(recordPath, record, { mode: 0o600, flag: 'wx' })
      owner = { record, recordPath, lockPath }
      break
    } catch (error) {
      if (created) {
        await rmdir(lockPath).catch((cleanupError: unknown) => { void cleanupError })
        throw error
      }
      if (!await isLockContention(error, lockPath)) {
        // Windows can release the competing lock between exclusive create and lstat.
        if (process.platform !== 'win32'
          || (error as NodeJS.ErrnoException | null)?.code !== 'EPERM'
          || retriedUnconfirmedPermissionError) throw error
        retriedUnconfirmedPermissionError = true
      } else if (await takeOverExitedLock(lockPath)) continue
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
    await releaseLock(owner)
  }
}
