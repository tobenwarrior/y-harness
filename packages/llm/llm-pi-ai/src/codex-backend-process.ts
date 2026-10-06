/** Stdio-only native Codex child with a deployment-owned binary and clean homes. */
import { spawn } from 'node:child_process'
import { dirname, isAbsolute, join } from 'node:path'
import { Transform } from 'node:stream'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { declineCodexRequest } from './codex-backend.ts'
import type { CodexPeer } from './codex-backend.ts'
/** Absolute deployment-owned paths one Codex child is launched with. */
export interface CodexProcessOptions { binary: string; home: string; shellHome: string; cwd: string; nodePath: string }
/**
 * Native app-server config is explicit; no inherited secrets or global home.
 * @param options - validated launch paths whose shell home the child inherits.
 * @returns the argv passed to the pinned Codex binary.
 */
export function codexProcessArguments(options: CodexProcessOptions): string[] {
  return ['app-server', '--listen', 'stdio://', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="on-request"',
    '-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false', '-c', 'history.persistence="none"', '-c', 'web_search="disabled"',
    '-c', 'shell_environment_policy.inherit="none"', '-c', `shell_environment_policy.set={HOME=${JSON.stringify(options.shellHome)},PATH="/usr/bin:/bin"}`]
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
 * @returns the connected peer; closing it terminates the child.
 * @throws when any launch path is not absolute.
 */
export function startCodexProcess(options: CodexProcessOptions): CodexPeer {
  if (![options.binary, options.home, options.shellHome, options.cwd, options.nodePath].every(isAbsolute)) throw new Error('Configure absolute local Codex paths before using this backend.')
  const child = spawn(options.nodePath, [options.binary, ...codexProcessArguments(options)], { cwd: options.cwd, env: {
    PATH: `${dirname(options.nodePath)}:/usr/bin:/bin`, HOME: options.shellHome, CODEX_HOME: options.home,
    XDG_CONFIG_HOME: join(options.shellHome, '.config'), XDG_CACHE_HOME: join(options.shellHome, '.cache'),
    ZDOTDIR: options.shellHome, TMPDIR: join(options.shellHome, 'tmp'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  }, stdio: ['pipe', 'pipe', 'pipe'] })
  const bounded = boundedCodexInput()
  const transport = new JsonRpcLineTransport(bounded, child.stdin)
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>()
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true; transport.close(); child.stdin.end(); child.kill('SIGTERM')
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 2000); timer.unref()
    child.once('exit', () => { clearTimeout(timer) })
    for (const callback of listeners) callback('__closed', {})
    listeners.clear()
  }
  transport.onRequest(declineCodexRequest)
  transport.onNotification((method, params) => { for (const callback of listeners) callback(method, params) })
  bounded.on('error', close); child.on('error', close); child.once('exit', close); child.stdin.on('error', close)
  // Native diagnostics can contain sign-in details; never relay stderr to logs or the renderer.
  child.stderr.resume(); child.stdout.pipe(bounded); transport.start()
  return { request: async (method, params) => {
    if (closed) throw new Error('Codex backend is closed.')
    try { return await transport.request(method, params, AbortSignal.timeout(25_000)) }
    catch { if (method === 'initialize') close(); throw new Error(`Codex ${method} did not complete. Try refreshing the backend.`) }
  }, notify: (method) => { transport.notify(method) },
  subscribe: (callback) => { listeners.add(callback); return () => { listeners.delete(callback) } }, close }
}
