/** Stdio-only native Codex child with a deployment-owned binary and clean homes. */
import { lstat, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, win32 } from 'node:path'
import { Transform } from 'node:stream'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@yharness/subprocess'
import { JsonRpcLineTransport, JsonRpcResponseError } from '@yharness/sdk-protocol'
import type { CodexPeer } from './codex-backend.ts'
/** Absolute deployment-owned paths one Codex child is launched with. */
export interface CodexProcessOptions { binary: string; home: string; shellHome: string; cwd: string; nodePath: string }
/** Provider-owned process launcher; its handle owns descendant teardown and quiescence. */
export type CodexProcessSpawner = (spec: SubprocessSpawnSpec) => SubprocessHandle

/** Teardowns keyed by backend identity prevent a replacement from starting early. */
const pendingCodexTeardowns = new Map<string, Promise<void>>()

function codexProcessIdentity(options: CodexProcessOptions): string {
  return JSON.stringify([options.binary, options.home, options.nodePath])
}

/**
 * Build the minimal command search path for the isolated Codex child.
 * @param nodePath - absolute bundled Node executable.
 * @param platform - target process platform; defaults to the current platform.
 * @param systemRoot - Windows system root used by the target platform.
 * @returns a platform-correct, system-only search path.
 */
export function codexChildPath(
  nodePath: string,
  platform: NodeJS.Platform = process.platform,
  systemRoot = process.env.SystemRoot ?? 'C:\\Windows',
): string {
  const nodeDirectory = platform === 'win32' ? win32.dirname(nodePath) : dirname(nodePath)
  return platform === 'win32'
    ? [nodeDirectory, `${systemRoot}\\System32`, systemRoot].join(';')
    : [nodeDirectory, '/usr/bin', '/bin'].join(':')
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = error.code
  return typeof code === 'string' ? code : undefined
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  const missing: string[] = []
  let current = path
  while (true) {
    let metadata: Awaited<ReturnType<typeof lstat>>
    try { metadata = await lstat(current) }
    catch (error) {
      if (errorCode(error) !== 'ENOENT') throw new Error('Codex private home paths could not be inspected.')
      missing.push(current)
      const parent = dirname(current)
      if (parent === current) throw new Error('Codex private home paths could not be created.')
      current = parent
      continue
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Codex private home paths must be real directories.')
    break
  }
  for (const directory of missing.reverse()) {
    try { await mkdir(directory, { mode: 0o700 }) }
    catch (error) { if (errorCode(error) !== 'EEXIST') throw new Error('Codex private home paths could not be created.') }
    const metadata = await lstat(directory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Codex private home paths must be real directories.')
  }
}

/**
 * Create the private native profile and shell directories before a child starts.
 * @param options - validated absolute launch paths.
 * @returns completion after all directories exist; newly created directories use owner-only mode where supported.
 */
export async function prepareCodexHomeDirectories(options: CodexProcessOptions): Promise<void> {
  if (![options.home, options.shellHome, options.cwd, options.nodePath, options.binary].every(isAbsolute)) {
    throw new Error('Configure absolute local Codex paths before creating its private homes.')
  }
  const directories = [
    options.home,
    options.shellHome,
    join(options.shellHome, '.config'),
    join(options.shellHome, '.cache'),
    join(options.shellHome, 'tmp'),
  ]
  for (const path of directories) await ensurePrivateDirectory(path)
}
/**
 * Preserve unsupported-method information without exposing native diagnostics or error data.
 * @param method - native operation that failed.
 * @param error - transport rejection, deliberately not rendered.
 * @returns a display-safe failure with only the method-not-found protocol code retained.
 */
export function codexRequestFailure(method: string, error: unknown): Error {
  const message = `Codex ${method} did not complete. Try refreshing the backend.`
  return error instanceof JsonRpcResponseError && error.code === -32601
    ? new JsonRpcResponseError(-32601, message)
    : new Error(message)
}
/**
 * Native app-server config is explicit; no inherited secrets or global home.
 * @param options - validated launch paths whose shell home the child inherits.
 * @returns the argv passed to the pinned Codex binary.
 */
export function codexProcessArguments(options: CodexProcessOptions): string[] {
  return ['app-server', '--listen', 'stdio://',
    '-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false', '-c', 'history.persistence="none"',
    '-c', 'shell_environment_policy.inherit="none"', '-c', `shell_environment_policy.set={HOME=${JSON.stringify(options.shellHome)},PATH=${JSON.stringify(codexChildPath(options.nodePath))}}`]
}
/**
 * Fail the stream before the generic line transport buffers an oversized frame.
 * @param maximum - largest accepted protocol line in bytes.
 * @returns the byte-counting pass-through stream.
 */
export function boundedCodexInput(maximum = 4 * 1024 * 1024): Transform {
  let lineBytes = 0
  return new Transform({ transform(chunk: Buffer, _encoding, callback) {
    for (const byte of chunk) { if (byte === 10) lineBytes = 0; else lineBytes++; if (lineBytes > maximum) { callback(new Error('Codex protocol frame exceeded the size limit.')); return } }
    callback(null, chunk)
  } })
}

/**
 * Launch the pinned native Codex app server over stdio with a cleared environment.
 * @param options - absolute binary, home, shell-home, cwd, and Node paths.
 * @param handleRequest - routes native requests to the owning Harness turn.
 * @param spawnProcess - provider-managed launcher whose handle owns descendants and quiescence.
 * @returns the connected peer; closing it starts provider-owned teardown. A replacement with the same identity waits for that teardown.
 * @throws when any launch path is not absolute or the provider cannot provide protocol streams.
 */
export async function startCodexProcess(
  options: CodexProcessOptions,
  handleRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  spawnProcess: CodexProcessSpawner,
): Promise<CodexPeer> {
  if (![options.binary, options.home, options.shellHome, options.cwd, options.nodePath].every(isAbsolute)) throw new Error('Configure absolute local Codex paths before using this backend.')
  const identity = codexProcessIdentity(options)
  await pendingCodexTeardowns.get(identity)
  const child = spawnProcess({ argv: [options.nodePath, options.binary, ...codexProcessArguments(options)], cwd: options.cwd, env: {
    PATH: codexChildPath(options.nodePath), HOME: options.shellHome, CODEX_HOME: options.home,
    XDG_CONFIG_HOME: join(options.shellHome, '.config'), XDG_CACHE_HOME: join(options.shellHome, '.cache'),
    ZDOTDIR: options.shellHome, TMPDIR: join(options.shellHome, 'tmp'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  }, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: 2_000 })
  const stdin = child.stdin
  const stdout = child.stdout
  const stderr = child.stderr
  if (stdin === undefined || stdout === undefined || stderr === undefined) {
    void child.done.catch(() => {})
    child.terminate(); void child.waitForExit().catch(() => {})
    throw new Error('The Codex backend process did not provide private protocol streams.')
  }
  const bounded = boundedCodexInput()
  const transport = new JsonRpcLineTransport(bounded, stdin)
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>()
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true; transport.close(); stdin.end(); child.terminate()
    const quiescence = child.waitForExit().then((settled) => {
      if (!settled) throw new Error('Codex backend process teardown was cancelled before quiescence.')
    })
    pendingCodexTeardowns.set(identity, quiescence)
    void quiescence.then(() => {
      if (pendingCodexTeardowns.get(identity) === quiescence) pendingCodexTeardowns.delete(identity)
    }, () => {})
    for (const callback of listeners) callback('__closed', {})
    listeners.clear()
  }
  transport.onRequest(handleRequest)
  transport.onNotification((method, params) => { for (const callback of listeners) callback(method, params) })
  bounded.on('error', close); stdout.on('error', close); stdin.on('error', close)
  void child.done.then(close, close)
  // Native diagnostics can contain sign-in details; never relay stderr to logs or the renderer.
  stderr.resume(); stdout.pipe(bounded); transport.start()
  return { request: async (method, params) => {
    if (closed) throw new Error('Codex backend is closed.')
    try { return await transport.request(method, params, AbortSignal.timeout(25_000)) }
    catch (error) { if (method === 'initialize') close(); throw codexRequestFailure(method, error) }
  }, notify: (method) => { transport.notify(method) },
  subscribe: (callback) => { listeners.add(callback); return () => { listeners.delete(callback) } }, close }
}
