/** Owns the private SSH forward used by the native Cloud workspace. */

import { execFile, spawn, type ChildProcess, type ExecFileOptions, type SpawnOptions } from 'node:child_process'
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
const MAX_VAULT_OUTPUT = 160 * 1024
const VAULT_COMMAND = '/usr/local/sbin/yharness-vault desktop-client'

/** Maximum time allowed for the SSH session to publish its authenticated URL. */
export const CLOUD_CONNECTION_STARTUP_TIMEOUT_MS = 15_000

/** Maximum time allowed for the owned SSH process to leave after close or abort. */
export const CLOUD_CONNECTION_TERMINATE_TIMEOUT_MS = 2_000

/** Exchange a serialized Vault request over the current Cloud connection. */
export type CloudVaultTransport = (payload: string, signal: AbortSignal) => Promise<string | undefined>

/** Execution seam for tests that exercise Vault stdin, stdout, and cancellation. */
export type VaultExec = (
  file: string, args: readonly string[], options: ExecFileOptions & { encoding: 'utf8' },
  complete: (error: Error | null, stdout: string) => void,
) => ChildProcess

/** A ready private loopback forward and the URL that authenticates its first browser request. */
export interface CloudConnection {
  /** HTTP origin served by the local forward. */
  readonly origin: string
  /** Authenticated login URL rewritten to the local forward's origin. */
  readonly loginUrl: string
  /** Send a Vault request to the same authenticated SSH account and return its bounded stdout. */
  readonly sendVaultRequest: CloudVaultTransport
  /** Settles after the owned SSH processes, proxy sockets and private socket directory are closed. */
  readonly closed: Promise<void>
  /** Stop this connection; repeated calls are harmless. */
  close(): void
}

/** Loopback listener ownership and internal test seams for an SSH attempt. */
export interface CloudConnectionOptions {
  /** Reusable loopback origin owned by the workspace. The attempt owns one when omitted. */
  readonly forward?: CloudForward
  readonly spawnProcess?: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess
  readonly executeVault?: VaultExec
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

/**
 * Run the fixed Vault client on a connection-owned OpenSSH control socket.
 * @param target - The private connection's verified destination.
 * @param controlPath - The private control socket of that connection.
 * @param payload - One serialized Vault request to send on stdin.
 * @param signal - Cancellation for the current request and connection.
 * @param execute - Optional local subprocess fixture.
 * @returns The bounded response after the process closes, or undefined on failure.
 */
export function runCloudVaultCommand(
  target: string, controlPath: string, payload: string, signal: AbortSignal, execute: VaultExec = execFile,
): Promise<string | undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    let response: string | undefined
    let child: ChildProcess
    try {
      child = execute(SSH_EXECUTABLE, [
        '-F', '/dev/null', '-a', '-x', '-T',
        '-S', controlPath,
        '-o', 'BatchMode=yes',
        '-o', 'ClearAllForwardings=yes',
        '-o', 'ControlMaster=no',
        '-o', 'ControlPersist=no',
        '-o', 'ForwardAgent=no',
        '-o', 'ForwardX11=no',
        '-o', 'PermitLocalCommand=no',
        // If the owned socket has closed, OpenSSH must fail without a fresh connection.
        '-o', 'ProxyCommand=/usr/bin/false',
        '-o', 'RequestTTY=no',
        '-o', 'StrictHostKeyChecking=yes', '--', target, VAULT_COMMAND,
      ], {
        encoding: 'utf8', timeout: 25_000, maxBuffer: MAX_VAULT_OUTPUT,
        killSignal: 'SIGKILL', env: childEnvironment(),
      }, (error, stdout) => {
        if (error === null) response = stdout
      })
    } catch {
      resolve(undefined)
      return
    }
    const abort = (): void => { child.kill('SIGKILL') }
    let inputFailed = false
    child.once('close', () => {
      signal.removeEventListener('abort', abort)
      resolve(signal.aborted || inputFailed ? undefined : response)
    })
    // OpenSSH can exit before reading stdin when the private connection is gone.
    child.stdin?.on('error', () => { inputFailed = true })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else child.stdin?.end(payload, 'utf8')
  })
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

function rewriteLoginUrl(remote: string, origin: string): { origin: string; loginUrl: string } {
  const url = new URL(remote)
  return { origin, loginUrl: origin + '/' + url.search }
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve) => {
    server.close(() => { resolve() })
  })
}

/** Private loopback origin retained by one Cloud workspace across SSH attempts. */
export interface CloudForward {
  /** Random local HTTP origin owned by this listener until it closes. */
  readonly origin: string
  /** Settles after the listener and all proxied sockets have closed. */
  readonly closed: Promise<void>
  /**
   * Route new connections to one private Unix socket until its SSH attempt ends.
   * @param socketPath - Absolute socket path owned by the SSH attempt.
   * @returns A release function that also closes that attempt's proxied connections.
   */
  attach(socketPath: string): () => void
  /** Release the loopback origin and close existing connections. */
  close(): void
}

/**
 * Reserve a random local origin for one Cloud workspace. An unbound listener refuses traffic.
 * @returns The ready listener that can be reused by sequential SSH attempts.
 */
export async function openCloudForward(): Promise<CloudForward> {
  const clients = new Set<Socket>()
  let destination: { readonly path: string } | undefined
  let closing = false
  const closed = Promise.withResolvers<void>()
  const disconnect = (): void => {
    destination = undefined
    for (const socket of clients) socket.destroy()
    clients.clear()
  }
  const server = createServer((client) => {
    if (destination === undefined) { client.destroy(); return }
    const upstream = createConnection(destination)
    clients.add(client)
    clients.add(upstream)
    const closePair = (): void => { client.destroy(); upstream.destroy() }
    client.once('close', () => { clients.delete(client); upstream.destroy() })
    upstream.once('close', () => { clients.delete(upstream); client.destroy() })
    client.once('error', closePair)
    upstream.once('error', closePair)
    client.pipe(upstream)
    upstream.pipe(client)
  })
  const close = (): void => {
    if (closing) return
    closing = true
    disconnect()
    void closeServer(server).finally(closed.resolve)
  }
  const port = await new Promise<number>((resolve, reject) => {
    server.on('error', () => {
      close()
      reject(failedError())
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        close()
        reject(failedError())
      } else resolve(address.port)
    })
  })
  return {
    origin: 'http://127.0.0.1:' + String(port),
    closed: closed.promise,
    attach(socketPath) {
      if (closing || destination !== undefined) throw failedError()
      const owned = { path: socketPath }
      destination = owned
      return () => { if (destination === owned) disconnect() }
    },
    close,
  }
}

/**
 * Open an authenticated Cloud workspace over the configured OpenSSH destination.
 *
 * A random owner-only Unix socket is the SSH listener. A TCP proxy binds its loopback
 * port before SSH starts and keeps that port for the connection's lifetime. Vault
 * commands reuse that SSH session through a control socket in the same private
 * directory. Teardown terminates only the processes owned by this connection.
 *
 * @param target - Existing OpenSSH host alias or `user@host` destination.
 * @param signal - Cancellation for startup and, after readiness, the connection lifetime.
 * @param options - Optional workspace-owned origin and test seams.
 * @returns The private origin, authenticated login URL and owned lifecycle.
 * @throws If the destination is invalid, SSH cannot start, the server URL is invalid,
 * or startup is cancelled or exceeds its deadline. Failure messages never include target
 * names or child output.
 */
export async function openCloudConnection(
  target: string, signal: AbortSignal, options: CloudConnectionOptions = {},
): Promise<CloudConnection> {
  if (!isCloudTarget(target)) throw invalidTargetError()
  throwIfAborted(signal)

  const startupTimeoutMs = options.startupTimeoutMs ?? CLOUD_CONNECTION_STARTUP_TIMEOUT_MS
  const terminateTimeoutMs = options.terminateTimeoutMs ?? CLOUD_CONNECTION_TERMINATE_TIMEOUT_MS
  const spawnProcess = options.spawnProcess ?? ((file: string, args: readonly string[], options: SpawnOptions) =>
    spawn(file, args, options))
  const directory = await mkdtemp(join(tmpdir(), 'yharness-cloud-'))
  const socketPath = join(directory, 'forward.sock')
  let forward: CloudForward | undefined
  let detach: (() => void) | undefined
  const controlPath = join(directory, 'c')
  const vaultLifetime = new AbortController()
  const vaultRequests = new Set<Promise<string | undefined>>()
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
        vaultLifetime.abort()
        await Promise.all([terminateChild(), ...vaultRequests])
        if (options.forward === undefined) await forward?.closed
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
    detach?.()
    if (options.forward === undefined) forward?.close()
    void finalize()
  }

  const onAbort = (): void => {
    if (!startupSettled) settleStartup(abortedError())
    requestClose()
  }

  try {
    forward = options.forward ?? await openCloudForward()
    const origin = forward.origin
    throwIfAborted(signal)
    detach = forward.attach(socketPath)
    if (options.forward === undefined) {
      void forward.closed.then(() => {
        if (!startupSettled) settleStartup(failedError())
        requestClose()
      })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    abortListenerAttached = true
    try {
      child = spawnProcess(SSH_EXECUTABLE, [
        '-a', '-x', '-T',
        '-o', 'BatchMode=yes',
        '-S', controlPath,
        '-o', 'ControlMaster=yes',
        '-o', 'ControlPersist=no',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ForkAfterAuthentication=no',
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
      requestClose()
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
          settleStartup(undefined, rewriteLoginUrl(remote, origin))
          return
        }
      }
      const remote = parseRemoteLoginUrl(stdout)
      if (remote !== undefined && !closeRequested) settleStartup(undefined, rewriteLoginUrl(remote, origin))
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
        async sendVaultRequest(payload, requestSignal) {
          const active = AbortSignal.any([requestSignal, vaultLifetime.signal])
          const pending = runCloudVaultCommand(target, controlPath, payload, active, options.executeVault)
          vaultRequests.add(pending)
          try { return await pending } finally { vaultRequests.delete(pending) }
        },
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
