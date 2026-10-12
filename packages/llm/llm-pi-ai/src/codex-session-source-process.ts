/** Private managed Codex process exposes only supported history reads. */
import { dirname, join, resolve } from 'node:path'
import { Writable } from 'node:stream'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { CodingSessionReadRequest } from '@deepseek-ai/dsh-coding-session/types'
import type { CodexCodingSessionReader } from './codex-coding-sessions.ts'
import { boundedCodexInput, codexProcessArguments, codexRequestFailure } from './codex-backend-process.ts'
import type { CodexSessionSourceConfig } from './coding-session-source.ts'
import { z } from 'zod'

const initialization = z.object({ codexHome: z.string(), userAgent: z.string() })
const methods = new Set(['thread/list', 'thread/read', 'thread/turns/list', 'thread/items/list'])
const clientName = 'y-coding-session-reader'
/** Failed process-range observation must survive provider disposal and remain visible. */
export class CodexSessionSourceReleaseError extends Error {}
async function settledRange(child: SubprocessHandle): Promise<void> {
  try { await child.done } catch { throw new Error('Original Codex source process did not complete.') } finally {
    let quiescent: boolean
    try { quiescent = await child.waitForExit() } catch { quiescent = false }
    if (!quiescent) throw new CodexSessionSourceReleaseError('Original Codex source did not release its managed process range.')
  }
}

/** Child ownership covers the initialized read facade and awaited process-range cleanup. */
export interface CodexSessionReadPeer {
  reader: CodexCodingSessionReader
  /** Stop requests and await the managed range before reporting release. @returns native process quiescence. */
  close(): Promise<void>
}

/**
 * Open the explicitly selected original profile without a model, login, or native turn.
 * @param config - verified local wrapper and explicitly authorized source paths.
 * @param request - complete read budgets and cancellation.
 * @param spawn - managed subprocess owner; fixtures replace this external dependency.
 * @returns initialized history-only peer; the caller must await close.
 */
export async function openCodexSessionReadPeer(
  config: CodexSessionSourceConfig, request: CodingSessionReadRequest,
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle,
): Promise<CodexSessionReadPeer> {
  request.signal.throwIfAborted()
  const { scrubbedParentEnv } = await import('@deepseek-ai/dsh-subprocess')
  request.signal.throwIfAborted()
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(scrubbedParentEnv()).map(key => [key, undefined]))
  Object.assign(env, {
    PATH: `${dirname(config.nodePath)}:/usr/bin:/bin`, HOME: config.shellHome, CODEX_HOME: config.home,
    XDG_CONFIG_HOME: join(config.shellHome, '.config'), XDG_CACHE_HOME: join(config.shellHome, '.cache'),
    ZDOTDIR: config.shellHome, TMPDIR: join(config.shellHome, 'tmp'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  })
  const child = spawn({ argv: [config.nodePath, config.binary, ...codexProcessArguments(config)], cwd: config.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: config.graceMs, signal: request.signal, env })
  if (child.stdin === undefined || child.stdout === undefined || child.stderr === undefined) {
    child.terminate(); await settledRange(child)
    throw new Error('Original Codex source did not provide private protocol streams.')
  }
  const bounded = boundedCodexInput(Math.max(0, request.maxBytes - 1))
  const output = new Writable({ write(chunk: Buffer, _encoding, callback) {
    if (chunk.byteLength > request.maxBytes) callback(new Error('Original Codex request exceeded its protocol byte limit.'))
    else child.stdin?.write(chunk, callback)
  } })
  const transport = new JsonRpcLineTransport(bounded, output)
  const lifetime = new AbortController()
  const signal = AbortSignal.any([request.signal, lifetime.signal])
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= (async () => {
    lifetime.abort(new Error('Original Codex source is closed.'))
    transport.close(); child.stdin?.end(); child.stdout?.unpipe(bounded); bounded.destroy(); output.destroy(); child.terminate()
    await settledRange(child)
  })()
  const protocolFailure = (): void => {
    lifetime.abort(new Error('Original Codex source exceeded or lost its private protocol stream.')); child.terminate()
  }
  bounded.on('error', protocolFailure); output.on('error', protocolFailure); child.stdin.on('error', protocolFailure)
  void child.done.then(() => { lifetime.abort(new Error('Original Codex source exited.')) }, (_error: unknown) => {
    lifetime.abort(new Error('Original Codex source process did not complete.'))
  })
  transport.onRequest(() => Promise.reject(new Error('Native requests are unavailable during source history discovery.')))
  child.stderr.resume(); child.stdout.pipe(bounded); transport.start()
  try {
    const response = initialization.parse(await transport.request('initialize', {
      clientInfo: { name: clientName, title: 'Y Harness', version: '0.2.1-alpha.1' },
      capabilities: { experimentalApi: false, explicitGatewayOauth: true },
    }, signal))
    if (resolve(response.codexHome) !== resolve(config.home)) throw new Error('Original Codex source returned a different native home.')
    // 0.160.0 initialize sets the originator to clientInfo.name; the following version is CARGO_PKG_VERSION.
    if (!response.userAgent.startsWith(`${clientName}/${config.version} (`)) {
      throw new Error('Original Codex source reported an unsupported binary version.')
    }
    transport.notify('initialized')
    return { reader: { connected: () => !signal.aborted, request: async (method, params) => {
      if (!methods.has(method)) throw new Error('Only supported native history reads are available.')
      signal.throwIfAborted()
      try { return await transport.request(method, params, signal) } catch (error) { throw codexRequestFailure(method, error) }
    } }, close }
  } catch (error) {
    await close()
    if (error instanceof Error && /different native home|unsupported binary version/.test(error.message)) throw error
    throw new Error('Original Codex source could not initialize supported history reads.')
  }
}
