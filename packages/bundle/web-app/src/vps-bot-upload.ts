/** Bounded, owner-initiated file copies into one private VPS Bot workspace. */

import { execFile } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { z } from 'zod'
import { isVpsSharedPath, type VpsRuntime } from './vps-runtime.ts'

const exec = promisify(execFile)
const outcomes = z.enum(['stored', 'exists', 'folder-unavailable', 'no-space', 'incomplete', 'unavailable'])
const commit = Uint8Array.of(1)
const options = z.object({
  maxBytes: z.number().int().min(1).max(1_000_000_000).default(1_000_000_000),
  reserveBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1_000_000_000).default(128 * 1024 * 1024),
  timeoutMs: z.number().int().min(1000).max(15 * 60_000).default(5 * 60_000),
})

/** Transfer limits for the installed VPS. */
export interface VpsFileUploadConfig {
  /** Largest allowed file in bytes. */
  readonly maxBytes?: number
  /** Free space in bytes reserved on the destination filesystem. */
  readonly reserveBytes?: number
  /** Maximum transfer lifetime in milliseconds. */
  readonly timeoutMs?: number
}

/** Validated transfer limits with deployment defaults applied. */
export type VpsFileUploadLimits = z.output<typeof options>

/** A workspace-relative destination and the incoming raw file. */
export interface ComputerFileUpload {
  /** Private workspace-relative folder or an absolute shared project folder. */
  readonly directory: string
  /** One base filename with no directory components. */
  readonly name: string
  /** Exact incoming byte count, excluding transport framing. */
  readonly bytes: number
  /** Raw HTTP request body. */
  readonly body: ReadableStream<Uint8Array> | null
}

/** Settled result without container paths or process diagnostics. */
export type ComputerFileUploadOutcome = z.output<typeof outcomes>

/**
 * Validate the deployment's file transfer limits.
 * @param config - optional VPS-specific overrides.
 * @returns validated limits with defaults.
 */
export function resolveVpsFileUploadLimits(config: VpsFileUploadConfig | undefined): VpsFileUploadLimits {
  return options.parse(config ?? {})
}

class LengthMismatch extends Error {}

async function* committedChunks(file: ComputerFileUpload, signal: AbortSignal): AsyncIterable<Uint8Array> {
  const reader = file.body?.getReader()
  let remaining = file.bytes
  let ended = reader === undefined
  const cancel = (): void => {
    void reader?.cancel().catch((error: unknown) => { void error })
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    if (reader !== undefined) {
      for (;;) {
        const item = await reader.read()
        signal.throwIfAborted()
        if (item.done) {
          ended = true
          break
        }
        remaining -= item.value.byteLength
        if (remaining < 0) throw new LengthMismatch()
        yield item.value
      }
    }
    if (remaining !== 0) throw new LengthMismatch()
    yield commit
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!ended) cancel()
    reader?.releaseLock()
  }
}

// Existing images have Python and a read-only root. Relative directory
// descriptors pin each workspace component through publication.
const uploadWorker = `# The command receives only a selected workspace, relative folder and filename.
import contextlib, errno, os, secrets, signal, sys

class Rejected(Exception):
    pass

def timeout(_number, _frame):
    raise Rejected('incomplete')

def enough_room(directory, needed):
    space = os.fstatvfs(directory)
    if space.f_bavail * space.f_frsize < needed:
        raise Rejected('no-space')

def temporary_file(directory):
    if hasattr(os, 'O_TMPFILE'):
        try:
            return os.open('.', os.O_WRONLY | os.O_TMPFILE, 0o600, dir_fd=directory), None
        except OSError as error:
            if error.errno not in (errno.EOPNOTSUPP, errno.EINVAL, errno.EISDIR, errno.ENOSYS):
                raise
    name = '.yharness-upload-' + secrets.token_hex(16)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    return os.open(name, flags, 0o600, dir_fd=directory), name

def store(root, folder, name, length, reserve):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    with contextlib.ExitStack() as handles:
        directory = os.open(root, flags)
        handles.callback(os.close, directory)
        for segment in [] if folder == '.' else folder.split('/'):
            directory = os.open(segment, flags, dir_fd=directory)
            handles.callback(os.close, directory)
        try:
            os.stat(name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            pass  # The destination has no directory entry yet.
        else:
            raise Rejected('exists')
        enough_room(directory, reserve + length)
        descriptor, temporary = temporary_file(directory)
        try:
            with os.fdopen(descriptor, 'wb') as output:
                remaining = length
                while remaining:
                    chunk = sys.stdin.buffer.read(min(remaining, 256 * 1024))
                    if not chunk:
                        raise Rejected('incomplete')
                    enough_room(directory, reserve + len(chunk))
                    output.write(chunk)
                    remaining -= len(chunk)
                if sys.stdin.buffer.read(1) != b'\\x01':
                    raise Rejected('incomplete')
                output.flush()
                os.fsync(output.fileno())
                if temporary is None:
                    os.link(f'/proc/self/fd/{output.fileno()}', name, dst_dir_fd=directory)
                else:
                    os.link(temporary, name, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
            os.fsync(directory)
        finally:
            if temporary is not None:
                os.unlink(temporary, dir_fd=directory)

root, folder, name, length, reserve, seconds = sys.argv[1:]
signal.signal(signal.SIGALRM, timeout)
signal.alarm(int(seconds))
try:
    store(root, folder, name, int(length), int(reserve))
    print('stored')
except Rejected as error:
    print(error)
except FileExistsError:
    print('exists')
except OSError as error:
    if error.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
        print('folder-unavailable')
    elif error.errno in (errno.ENOSPC, errno.EDQUOT):
        print('no-space')
    else:
        print('unavailable')
`

/**
 * Publish one complete transfer in an authorized Bot volume.
 * @param runtime - runtime selected by the exact owner Bot.
 * @param sessionId - roster Session of the selected Bot.
 * @param file - validated destination and raw request body.
 * @param limits - validated deployment limits.
 * @param signal - request lifetime.
 * @returns worker outcome after the byte pipe and process have settled.
 */
export async function uploadComputerFile(
  runtime: VpsRuntime, sessionId: string, file: ComputerFileUpload, limits: VpsFileUploadLimits, signal: AbortSignal,
): Promise<ComputerFileUploadOutcome> {
  signal.throwIfAborted()
  const shared = isVpsSharedPath(file.directory)
  const release = runtime.beginUse(sessionId)
  try {
    const root = shared ? await runtime.sharedWorkspaceFor(sessionId) : runtime.workspace(sessionId)
    if (root === undefined) return 'folder-unavailable'
    const directory = shared ? file.directory.slice(root.length + 1) || '.' : file.directory
    await runtime.ensure(sessionId)
    signal.throwIfAborted()
    const seconds = Math.ceil(limits.timeoutMs / 1000)
    const [program, ...argv] = runtime.execArgv(sessionId, [
      '/usr/bin/python3', '-I', '-c', uploadWorker, root, directory, file.name,
      String(file.bytes), String(limits.reserveBytes), String(seconds),
    ], { stdin: true })
    const closed = new AbortController()
    const transfer = AbortSignal.any([signal, AbortSignal.timeout(limits.timeoutMs), closed.signal])
    const child = exec(program, argv, { env: {}, maxBuffer: 1024, timeout: seconds * 1000 + 5000 })
    const finished = child.finally(() => { closed.abort() })
    const input = child.child.stdin
    const sending = input === null
      ? Promise.reject(new Error('The VPS transfer pipe is unavailable.'))
      : pipeline(committedChunks(file, transfer), input, { signal: transfer })
    const [settled, sent] = await Promise.allSettled([finished, sending])
    signal.throwIfAborted()
    if (sent.status === 'rejected' && sent.reason instanceof LengthMismatch) return 'incomplete'
    if (settled.status === 'rejected') return 'unavailable'
    const result = outcomes.safeParse(settled.value.stdout.trim())
    return result.success ? result.data : 'unavailable'
  } finally {
    release()
  }
}
