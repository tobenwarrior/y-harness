/** Owns the private SSH forward used by the native Cloud workspace. */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SSH_EXECUTABLE = '/usr/bin/ssh'
const REMOTE_PORT = 3080
const REMOTE_COMMAND = 'python3 ~/.local/bin/yharness-vps url && exec sleep infinity'
const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/u
const REMOTE_LOGIN_PATTERN = /^http:\/\/127\.0\.0\.1:3080\/\?token=[A-Za-z0-9_-]{1,512}$/u
const MAX_STDOUT_CHARS = 64 * 1024

/** Maximum time allowed for the SSH session to publish its authenticated URL. */
export const CLOUD_CONNECTION_STARTUP_TIMEOUT_MS = 15_000

/** Maximum time allowed for the owned SSH process to leave after close or abort. */
export const CLOUD_CONNECTION_TERMINATE_TIMEOUT_MS = 2_000

/** A ready private loopback forward and the URL that authenticates its first browser request. */
export interface CloudConnection {
  /** HTTP origin served by the local forward. */
  readonly origin: string
  /** Authenticated login URL rewritten to the local forward's origin. */
  readonly loginUrl: string
  /** Settles after the SSH process, proxy sockets and private socket directory are closed. */
  readonly closed: Promise<void>
  /** Stop this connection; repeated calls are harmless. */
  close(): void
}

/** Internal process injection used by lifecycle tests; production callers leave it unset. */
export interface CloudConnectionTestOptions {
  readonly spawnProcess?: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess
  readonly startupTimeoutMs?: number
  readonly terminateTimeoutMs?: number
}

/**
 * Check an OpenSSH host destination without allowing command-line options or shell syntax.
 * OpenSSH resolves the accepted value through the user's existing alias, user and key config.
 * @param target - Host alias or `user@host` destination entered by the user.
 * @returns Whether the destination is a bounded, option-safe OpenSSH host name.
 */
export function isCloudTarget(target: string): boolean {
  return target.length <= 128 && target === target.trim() && TARGET_PATTERN.test(target)
}

function abortedError(): Error {
  const error = new Error('Cloud connection aborted')
  error.name = 'AbortError'
  return error
}

function timedOutError(): Error {
  return new Error('Cloud connection timed out')
}

function failedError(): Error {
  return new Error('Cloud connection failed')
}

function invalidTargetError(): Error {
  return new Error('Invalid Cloud SSH target')
}

function normalizeFailure(error: unknown): Error {
  return error instanceof Error ? error : failedError()
}

function childEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)))
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortedError()
}

function wait(milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve(false) }, milliseconds)
    timer.unref()
  })
}

function parseRemoteLoginUrl(line: string): string | undefined {
  const candidate = line.trim()
  if (!REMOTE_LOGIN_PATTERN.test(candidate)) return undefined
  try {
    const url = new URL(candidate)
    if (url.username || url.password || url.hash || url.pathname !== '/' || url.searchParams.size !== 1
      || url.searchParams.get('token') === null) return undefined
    return url.href
  } catch {
    return undefined
  }
}

function rewriteLoginUrl(remote: string, port: number): { origin: string; loginUrl: string } {
  const url = new URL(remote)
  url.port = String(port)
  const origin = url.origin
  return { origin, loginUrl: url.href }
}

function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) return Promise.resolve()
  return new Promise((resolve) => {
    server.close(() => { resolve() })
  })
}

/**
 * Open an authenticated Cloud workspace over the configured OpenSSH destination.
 *
 * A random owner-only Unix socket is the SSH listener. A TCP proxy binds its loopback
 * port before SSH starts, so the returned origin never points at a port that this
 * process reserved and then released. The SSH child is the only process this module
 * terminates; it is not placed in a process group shared with unrelated work.
 *
 * @param target - Existing OpenSSH host alias or `user@host` destination.
 * @param signal - Cancellation for startup and, after readiness, the connection lifetime.
 * @param testOptions - Test-only process and deadline injection.
 * @returns The private origin, authenticated login URL and owned lifecycle.
 * @throws If the destination is invalid, SSH cannot start, the server URL is invalid,
 * or startup is cancelled or exceeds its deadline. Failure messages never include target
 * names or child output.
 */
export async function openCloudConnection(
  target: string, signal: AbortSignal, testOptions: CloudConnectionTestOptions = {},
): Promise<CloudConnection> {
  if (!isCloudTarget(target)) throw invalidTargetError()
  throwIfAborted(signal)

  const startupTimeoutMs = testOptions.startupTimeoutMs ?? CLOUD_CONNECTION_STARTUP_TIMEOUT_MS
  const terminateTimeoutMs = testOptions.terminateTimeoutMs ?? CLOUD_CONNECTION_TERMINATE_TIMEOUT_MS
  const spawnProcess = testOptions.spawnProcess ?? ((file: string, args: readonly string[], options: SpawnOptions) =>
    spawn(file, args, options))
  const directory = await mkdtemp(join(tmpdir(), 'yharness-cloud-'))
  const socketPath = join(directory, 'forward.sock')
  const clients = new Set<Socket>()
  let server: Server | undefined
  let child: ChildProcess | undefined
  let childExitResolve!: () => void
  let childExited = false
  const childExitedPromise = new Promise<void>((resolve) => { childExitResolve = resolve })
  let finalizing: Promise<void> | undefined
  let closeRequested = false
  let abortListenerAttached = false
  let startupSettled = false
  let startupResolve!: (value: { origin: string; loginUrl: string }) => void
  let startupReject!: (error: Error) => void
  const startup = new Promise<{ origin: string; loginUrl: string }>((resolve, reject) => {
    startupResolve = resolve
    startupReject = reject
  })
  // Startup can fail before the await below is installed (for example, a synchronous spawn error).
  // Keep that internal rejection observed while preserving the original failure for the caller.
  void startup.catch(() => {})
  let closedResolve!: () => void
  const closed = new Promise<void>((resolve) => { closedResolve = resolve })

  const settleStartup = (error: Error | undefined, ready?: { origin: string; loginUrl: string }): void => {
    if (startupSettled) return
    startupSettled = true
    if (error === undefined && ready !== undefined) startupResolve(ready)
    else startupReject(error ?? failedError())
  }

  const terminateChild = async (): Promise<void> => {
    const owned = child
    if (owned === undefined || childExited) return
    try { owned.kill('SIGTERM') } catch { /* The owned child may have exited between the state read and kill. */ }
    if (await Promise.race([childExitedPromise.then(() => true), wait(terminateTimeoutMs)])) return
    try { owned.kill('SIGKILL') } catch { /* The owned child may have exited between the state read and kill. */ }
    await Promise.race([childExitedPromise, wait(terminateTimeoutMs)])
  }

  const finalize = (): Promise<void> => {
    if (finalizing !== undefined) return finalizing
    finalizing = (async () => {
      try {
        await terminateChild()
        for (const socket of clients) socket.destroy()
        clients.clear()
        await closeServer(server)
        await rm(directory, { recursive: true, force: true })
      } catch {
        // The owned process and listeners have already been stopped; cleanup failure must not leave
        // the caller's closed promise rejected with a filesystem path or native diagnostic.
      } finally {
        if (abortListenerAttached) signal.removeEventListener('abort', onAbort)
        closedResolve()
      }
    })()
    return finalizing
  }

  const requestClose = (): void => {
    if (closeRequested) return
    closeRequested = true
    void finalize()
  }

  const onAbort = (): void => {
    if (!startupSettled) settleStartup(abortedError())
    requestClose()
  }

  try {
    server = createServer((client) => {
      clients.add(client)
      const upstream = createConnection({ path: socketPath })
      clients.add(upstream)
      const closePair = (): void => {
        client.destroy()
        upstream.destroy()
      }
      client.once('close', () => { clients.delete(client); upstream.destroy() })
      upstream.once('close', () => { clients.delete(upstream); client.destroy() })
      client.once('error', closePair)
      upstream.once('error', closePair)
      client.pipe(upstream)
      upstream.pipe(client)
    })
    const localServer = server
    const localPort = await new Promise<number>((resolve, reject) => {
      let didListen = false
      const onServerError = (): void => {
        if (!didListen) reject(failedError())
        else {
          if (!startupSettled) settleStartup(failedError())
          requestClose()
        }
      }
      const onListening = (): void => {
        didListen = true
        const address = server?.address()
        if (address === null || address === undefined || typeof address === 'string' || !Number.isSafeInteger(address.port)) {
          reject(failedError())
        } else resolve(address.port)
      }
      localServer.on('error', onServerError)
      localServer.listen(0, '127.0.0.1', onListening)
    })
    throwIfAborted(signal)
    signal.addEventListener('abort', onAbort, { once: true })
    abortListenerAttached = true
    try {
      child = spawnProcess(SSH_EXECUTABLE, [
        '-a', '-x', '-T',
        '-o', 'BatchMode=yes',
        '-o', 'ControlMaster=no',
        '-o', 'ControlPath=none',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ForwardAgent=no',
        '-o', 'ForwardX11=no',
        '-o', 'PermitLocalCommand=no',
        '-o', 'RequestTTY=no',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=2',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', 'StreamLocalBindUnlink=yes',
        '-L', `${socketPath}:127.0.0.1:${String(REMOTE_PORT)}`,
        '--', target,
        REMOTE_COMMAND,
      ], { env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      throw failedError()
    }
    const owned = child
    owned.once('close', () => {
      childExited = true
      childExitResolve()
      if (!startupSettled) settleStartup(failedError())
      void finalize()
    })
    owned.once('error', () => {
      if (!startupSettled) settleStartup(failedError())
    })
    owned.stderr?.on('data', () => { /* Drain SSH diagnostics without retaining or logging them. */ })
    let stdout = ''
    owned.stdout?.on('data', (chunk: Buffer | string) => {
      stdout = (stdout + chunk.toString()).slice(-MAX_STDOUT_CHARS)
      const lines = stdout.split(/\r?\n/u)
      stdout = lines.pop() ?? ''
      for (const line of lines) {
        const remote = parseRemoteLoginUrl(line)
        if (remote !== undefined && !closeRequested) {
          settleStartup(undefined, rewriteLoginUrl(remote, localPort))
          return
        }
      }
      const remote = parseRemoteLoginUrl(stdout)
      if (remote !== undefined && !closeRequested) settleStartup(undefined, rewriteLoginUrl(remote, localPort))
    })
    if (owned.stdout === null || owned.stderr === null) throw failedError()
    const timeout = setTimeout(() => {
      if (!startupSettled) settleStartup(timedOutError())
      requestClose()
    }, startupTimeoutMs)
    try {
      const ready = await startup
      return {
        ...ready,
        closed,
        close: requestClose,
      }
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    const failure = normalizeFailure(error)
    settleStartup(failure)
    requestClose()
    await Promise.race([closed, wait(terminateTimeoutMs * 2)])
    if (failure.message === 'Cloud connection aborted' || failure.message === 'Cloud connection timed out'
      || failure.message === 'Invalid Cloud SSH target' || failure.message === 'Cloud connection failed') throw failure
    throw failedError()
  }
}
