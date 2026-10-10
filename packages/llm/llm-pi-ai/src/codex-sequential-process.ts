/** Cold owned stdio peer; process exit, stream EOF and managed-range drainage remain separate facts. */
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Transform, Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type { CodingSessionReadRequest } from '@deepseek-ai/dsh-coding-session/types'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import { codexProcessArguments, codexRequestFailure } from './codex-backend-process.ts'
import type { CodexSessionSourceConfig } from './coding-session-source.ts'
import { restrictionArguments } from './codex-sequential-guards.ts'
import type { CodexDisabledServers } from './codex-sequential-guards.ts'

type Obj = Record<string, unknown>
/** Peer injection permits entirely fixture-owned protocol/process verification. */
export interface CodexSequentialPeer {
  request(method: string, params: object | undefined, signal: AbortSignal): Promise<unknown>
  onRequest(handler: (method: string, params: Obj) => Promise<unknown>): void
  subscribe(handler: (method: string, params: Obj) => void): () => void
  connected(): boolean
  observedFailure(): boolean
  /**
   * @param request - release lifetime; cancellation forces cleanup and rejects receipt.
   * @returns observed normal owned process/range exit and stream EOF.
   */
  close(request: CodingSessionReadRequest): Promise<void>
  /** Force disposal still awaits the owned range and streams. @returns process disposal, never a release receipt. */
  dispose(): Promise<void>
}
/**
 * Acquire one independent cold peer with selected policy and stable-profile exclusions.
 * @param config - explicit original profile, package and launch paths.
 * @param request - bounded acquisition/read lifetime; it does not own the held peer lifetime.
 * @param servers - observed literal MCP names to disable at startup.
 * @param policyArguments - optional exact Y sandbox and approval argument entries.
 * @returns an initialized private peer whose process and streams the caller must release.
 */
export type CodexSequentialPeerFactory = (
  config: CodexSessionSourceConfig, request: CodingSessionReadRequest,
  servers: CodexDisabledServers, policyArguments?: string[],
) => Promise<CodexSequentialPeer>
const initialization = z.object({ codexHome: z.string(), userAgent: z.string() })
const clientPrefix = 'y-coding-session-sequential'
/** An unconfirmed owned range permanently prevents another sequential claim. */
export class CodexSequentialProcessReleaseError extends Error {}
function frames(maximum: number): Transform {
  let pending = Buffer.alloc(0)
  return new Transform({ transform(chunk: Buffer, _encoding, callback) {
    pending = Buffer.concat([pending, chunk])
    for (;;) {
      const end = pending.indexOf(10)
      if (end < 0) break
      if (end > maximum) { callback(new Error('Original Codex protocol frame exceeded its byte limit.')); return }
      const line = pending.subarray(0, end)
      pending = pending.subarray(end + 1)
      if (line.toString('utf8').trim().length === 0) continue
      try {
        const value: unknown = JSON.parse(line.toString('utf8'))
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid frame')
      } catch { callback(new Error('Original Codex emitted a malformed protocol frame.')); return }
      this.push(Buffer.concat([line, Buffer.from('\n')]))
    }
    if (pending.byteLength > maximum) callback(new Error('Original Codex protocol frame exceeded its byte limit.'))
    else callback()
  }, flush(callback) {
    if (pending.toString('utf8').trim().length !== 0) callback(new Error('Original Codex protocol ended with an incomplete frame.'))
    else callback()
  } })
}

/**
 * Open a managed stdio peer with startup exclusions and observed remote-control checks.
 * @param config - verified explicit paths; no inherited native profile or auth choice.
 * @param request - acquisition budget; it does not remain the writer's lifetime signal.
 * @param servers - literal names from a prior no-thread public-config preflight.
 * @param spawn - injected managed subprocess owner.
 * @param policyArguments - exact selected Y sandbox and approval argument entries, appended without a shell.
 * @returns the private initialized peer; every caller must await cleanup.
 */
export async function openCodexSequentialPeer(
  config: CodexSessionSourceConfig, request: CodingSessionReadRequest,
  servers: CodexDisabledServers, spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle, policyArguments: string[] = [],
): Promise<CodexSequentialPeer> {
  request.signal.throwIfAborted()
  // Remote control resolves persisted enrollment by EXACT raw stdio client
  // name. A never-reused unpredictable name has no enrollment in a stable
  // original profile; a fixed application name could reconnect one.
  const clientName = `${clientPrefix}-${randomUUID()}`
  const { scrubbedParentEnv } = await import('@deepseek-ai/dsh-subprocess')
  request.signal.throwIfAborted()
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(scrubbedParentEnv()).map(key => [key, undefined]))
  Object.assign(env, { PATH: `${dirname(config.nodePath)}:/usr/bin:/bin`, HOME: config.shellHome, CODEX_HOME: config.home,
    XDG_CONFIG_HOME: join(config.shellHome, '.config'), XDG_CACHE_HOME: join(config.shellHome, '.cache'),
    ZDOTDIR: config.shellHome, TMPDIR: join(config.shellHome, 'tmp'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' })
  // Do not bind this held writer to the claim's expiring read deadline. Each operation owns its signal.
  const child = spawn({
    argv: [config.nodePath, config.binary, ...codexProcessArguments(config), ...restrictionArguments(servers), ...policyArguments],
    cwd: config.cwd, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: config.graceMs, env })
  if (child.stdin === undefined || child.stdout === undefined || child.stderr === undefined) {
    child.terminate()
    await Promise.allSettled([child.done])
    if (!await child.waitForExit()) throw new CodexSequentialProcessReleaseError('Original Codex process range could not be drained.')
    throw new Error('Original Codex process did not provide its private streams.')
  }
  const stdin = child.stdin; const stdout = child.stdout; const stderr = child.stderr
  const input = frames(request.maxBytes)
  const output = new Writable({ write(chunk: Buffer, _encoding, callback) {
    if (chunk.byteLength > request.maxBytes) callback(new Error('Original Codex request exceeded its byte limit.'))
    else stdin.write(chunk, callback)
  } })
  const transport = new JsonRpcLineTransport(input, output)
  const lifetime = new AbortController()
  let failure = false; let forced = false; let closing = false; let ended = false
  let disposedQuiescent = false
  let closure: Promise<void> | undefined
  const listeners = new Set<(method: string, params: Obj) => void>()
  const requests = new Set<Promise<unknown>>()
  let handler = (_method: string, _params: Obj): Promise<unknown> => Promise.reject(new Error('Native requests are unavailable before sequential turn admission.'))
  const fail = (): void => {
    if (forced) return
    failure = true; forced = true; lifetime.abort(new Error('Original Codex private process lost its bounded lifetime.'))
    child.terminate()
    for (const notify of listeners) notify('__closed', {})
    // A forced path cannot produce a receipt. Destroy caller-owned streams so
    // cleanup still settles after their source loses a valid EOF channel.
    stdout.destroy(); stderr.destroy(); input.destroy(); output.destroy()
  }
  input.on('error', fail); output.on('error', fail); stdin.on('error', fail); stdout.on('error', fail); stderr.on('error', fail)
  // Observe diagnostics without retaining or relaying credentials or native output.
  let diagnosticBytes = 0; let tail = ''
  stderr.on('data', (chunk: Buffer) => {
    diagnosticBytes += chunk.byteLength
    const value = tail + chunk.toString('utf8')
    if (/\b(error|failed|failure|timed out|timeout)\b|persist|recorder|flush|shutdown.*warn/iu.test(value)) failure = true
    tail = value.slice(-256)
    if (diagnosticBytes > request.maxBytes) fail()
  })
  const drains = [finished(stdout, { cleanup: true }), finished(stderr, { cleanup: true }), finished(input, { cleanup: true })]
  // Attach rejection observers immediately; the final receipt inspects every result.
  for (const drain of drains) void drain.catch(() => { failure = true })
  transport.onRequest((method, params) => {
    if (requests.size >= request.maxEvents) { fail(); return Promise.reject(new Error('Original Codex native callback count exceeded its configured limit.')) }
    const work = closing ? Promise.reject(new Error('Original Codex process is releasing.')) : handler(method, params)
    requests.add(work); void work.then(() => { requests.delete(work) }, () => { requests.delete(work) })
    return work
  })
  transport.onNotification((method, params) => {
    if (method === 'remoteControl/status/changed' && params.status !== 'disabled') { fail(); return }
    if (method === 'error') failure = true
    for (const notify of listeners) notify(method, params)
  })
  void child.done.then(() => { ended = true; if (!closing) fail() }, () => { ended = true; fail() })
  stdout.pipe(input); stderr.resume(); transport.start()
  const close = (release: CodingSessionReadRequest, force: boolean): Promise<void> => {
    if (force) fail()
    return closure ??= (async () => {
      closing = true
      const abort = (): void => { fail() }
      release.signal.addEventListener('abort', abort, { once: true })
      if (release.signal.aborted) abort()
      // Native EOF shutdown has its own bounded background drain. graceMs belongs
      // to the subprocess provider's forced-termination procedure, not that drain.
      const timer = setTimeout(abort, 30_000)
      timer.unref()
      let outcome: Awaited<SubprocessHandle['done']> | undefined
      let range = false
      try {
        await Promise.allSettled([...requests])
        if (!forced) { try { await transport.flush() } catch { fail() } }
        try { stdin.end() } catch { fail() }
        try { outcome = await child.done } catch { failure = true }
        // No signal race returns an external-ready receipt before the owned range and streams settle.
        try { range = await child.waitForExit() } catch { failure = true }
        const drained = await Promise.allSettled(drains)
        if (drained.some(result => result.status === 'rejected')) failure = true
        disposedQuiescent = range && outcome !== undefined
      } finally {
        clearTimeout(timer); release.signal.removeEventListener('abort', abort)
        lifetime.abort(new Error('Original Codex private process is closed.'))
        transport.close(); output.destroy(); listeners.clear()
      }
      if (forced || failure || !range || outcome?.exitCode !== 0 || outcome.signal != null) {
        throw new Error('Original Codex release could not establish normal process exit and complete stream/range drainage.')
      }
      release.signal.throwIfAborted()
    })()
  }
  const peer: CodexSequentialPeer = {
    connected: () => !closing && !ended && !lifetime.signal.aborted,
    observedFailure: () => failure || forced,
    onRequest: (next) => { handler = next },
    subscribe: (callback) => { listeners.add(callback); return () => { listeners.delete(callback) } },
    request: async (method, params, signal) => {
      if (!peer.connected()) throw new Error('Original Codex private process is unavailable.')
      const combined = AbortSignal.any([signal, lifetime.signal]); combined.throwIfAborted()
      try { return await transport.request(method, params, combined) } catch (error) { throw codexRequestFailure(method, error) }
    }, close: release => close(release, false),
    dispose: async () => {
      try { await close({ ...request, signal: new AbortController().signal }, true) }
      catch { if (!disposedQuiescent) throw new CodexSequentialProcessReleaseError('Original Codex process cleanup did not establish owned-range quiescence.') }
    },
  }
  try {
    const value = initialization.parse(await peer.request('initialize', { clientInfo: { name: clientName, title: 'Y Harness', version: '0.2.1-alpha.1' },
      capabilities: { experimentalApi: true, explicitGatewayOauth: true } }, request.signal))
    if (resolve(value.codexHome) !== resolve(config.home) || !value.userAgent.startsWith(`${clientName}/${config.version} (`)) {
      throw new Error('Original Codex home or pinned version did not match the selected source.')
    }
    transport.notify('initialized')
    // This public pinned read uses Option<()>: omit params, do not send {}.
    const remote = z.object({ status: z.literal('disabled') }).loose().safeParse(await peer.request('remoteControl/status/read', undefined, request.signal))
    if (!remote.success) throw new Error('Original Codex private process did not confirm disabled remote control.')
    return peer
  } catch (error) {
    await peer.dispose()
    throw error
  }
}
