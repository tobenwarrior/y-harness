/** Explicit original Claude read sources with a separate default-off conversation handoff. */
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {} from './index.ts'
import { createClaudeSequentialWriter } from './claude-sequential.ts'
import { z } from 'zod'
import { createClaudeCodingSessionProvider } from './claude.ts'
import type { ClaudeSessionSdk } from './claude.ts'
import { codingSessionDigest } from './digest.ts'
import type { CodingSessionProvider, CodingSessionReadRequest } from './types.ts'
import { claudeSourceFields, claudeSourceInfoSchema, claudeSourceMessagesSchema, claudeSourceReplySchema, claudeSourceRequestSchema, claudeSequentialPolicyReceiptSchema, verifiedClaudeSequentialSdk } from './claude-source-worker.ts'
import type { ClaudeSourceRequest } from './claude-source-worker.ts'

const sourceSchema = z.object({
  id: z.string().trim().min(1), label: z.string().trim().min(1), ...claudeSourceFields,
  nodePath: z.string().min(1).refine(isAbsolute), processGraceMs: z.number().int().positive().max(2147483647),
  sequentialHandoff: z.object({
    nativeExecutablePath: z.string().min(1).refine(isAbsolute), nativeExecutableSha256: z.string().regex(/^[a-f0-9]{64}$/),
    knownUnmanagedStartup: z.boolean().default(false),
    maxTurnMs: z.number().int().positive().max(2147483647), maxInputBytes: z.number().int().positive(),
    maxOutputBytes: z.number().int().positive(), maxSessionBytes: z.number().int().positive(),
  }).strict().optional(),
}).strict()
/** One explicitly authorized original profile, project, runtime and verified SDK installation. */
export type ClaudeSourceConfig = z.infer<typeof sourceSchema>
/** Explicit sources and independently opted-in sequential bounds; listing configuration starts no process. */
export interface Config { /** Explicit selections; no implicit or all-project source is created. */ sources: ClaudeSourceConfig[] }
/** Deployment-owned source selection; every original root and executable is explicit. */
export const Config: schema<Config> = schema.object({ sources: schema.array(schema.object({
  id: schema.string().required(), label: schema.string().required(), profileRoot: schema.string().required(),
  directory: schema.string().required(), shellHome: schema.string().required(), nodePath: schema.string().required(),
  sdkModulePath: schema.string().required(), sdkManifestPath: schema.string().required(),
  sdkModuleSha256: schema.string().required(), sdkVersion: schema.const('0.3.263').required(),
  processGraceMs: schema.natural().min(1).max(2147483647).required(),
  sequentialHandoff: schema.union([schema.object({
    nativeExecutablePath: schema.string().required(), nativeExecutableSha256: schema.string().required(),
    knownUnmanagedStartup: schema.boolean().default(false).description('Trusted declaration that the selected account, profile and machine have no managed, remote, helper or parent startup policy; the public SDK cannot certify this absence.'),
    maxTurnMs: schema.natural().min(1).max(2147483647).default(300000), maxInputBytes: schema.natural().min(1).default(65536),
    maxOutputBytes: schema.natural().min(1).default(1048576), maxSessionBytes: schema.natural().min(1).default(8388608),
  }), schema.const(undefined)]),
})).default([]) })
/** Loader function-plugin identity. */
export const name = 'coding-session-claude-source'
/** Source registrations require their managed subprocess owner and coding-session service. */
export const inject = ['codingSessions', 'subprocess']
/** Read provider plus optional sequential owner and awaited managed-process disposal. */
export interface ClaudeSource {
  /** Original provider/profile/native identities remain independent of Harness runtime roots. */
  provider: CodingSessionProvider
  /** @returns after every admitted child and managed process range has stopped. */
  close(): Promise<void>
}
class ClaudeSourceReleaseError extends Error {}
function childEnvironment(source: ClaudeSourceConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...scrubbedParentEnv() }
  // Providers merge their current scrubbed parent base; tombstones make this an exact snapshot.
  for (const key of Object.keys(process.env)) if (!(key in env)) env[key] = undefined
  for (const key of Object.keys(env)) if (/^(NODE_|CLAUDE_|ANTHROPIC_|CODEX_|XDG_)/i.test(key)) env[key] = undefined
  env.CLAUDE_CONFIG_DIR = source.profileRoot; env.HOME = source.shellHome
  return env
}
/**
 * Create an original-profile read provider without loading its SDK or starting a child.
 * @param input - complete explicit source selection; no personal root is inferred.
 * @param runtime - managed subprocess provider used only after an explicit list/read operation.
 * @param authority - live Y root services, required only for an explicitly configured sequential handoff.
 * @returns a read provider with optional separate conversation-only handoff and quiescent disposal.
 */
export function createClaudeSource(input: ClaudeSourceConfig, runtime: Pick<SubprocessRuntime, 'spawn'>, authority?: Context): ClaudeSource {
  const source = sourceSchema.parse(input)
  for (const key of ['profileRoot', 'directory', 'shellHome', 'nodePath', 'sdkModulePath', 'sdkManifestPath'] as const) source[key] = resolve(source[key])
  const profileId = `original-sdk:${codingSessionDigest({ id: source.id, root: source.profileRoot, directory: source.directory })}`
  const workerPath = fileURLToPath(new URL('../lib/types/claude-source-worker.js', import.meta.url))
  // Emitted modules live beside the worker rather than under src.
  const executableWorker = import.meta.url.endsWith('/src/claude-source.ts') ? workerPath : fileURLToPath(new URL('./claude-source-worker.js', import.meta.url))
  let closed = false
  let releaseFailure: ClaudeSourceReleaseError | undefined
  const hasReleaseFailure = (): boolean => releaseFailure !== undefined
  const connected = (): boolean => !closed && releaseFailure === undefined
  const active = new Map<AbortController, Promise<unknown>>()
  const poison = (error: ClaudeSourceReleaseError): void => {
    releaseFailure ??= error
    for (const controller of active.keys()) controller.abort()
  }
  const read = (
    operation: ClaudeSourceRequest, request: CodingSessionReadRequest, release = false,
  ): Promise<{ value: unknown; bytes: number }> => {
    request.signal.throwIfAborted()
    if (releaseFailure !== undefined) return Promise.reject(releaseFailure)
    if (closed && !release) return Promise.reject(new Error('Claude source connection is closed.'))
    const body = JSON.stringify(claudeSourceRequestSchema.parse(operation)) + '\n'
    if (Buffer.byteLength(body, 'utf8') > request.maxBytes) {
      return Promise.reject(new Error('Claude source request exceeded the configured byte limit.'))
    }
    const controller = new AbortController()
    const task = (async () => {
      let child: ReturnType<SubprocessRuntime['spawn']>
      try { child = runtime.spawn({ argv: [source.nodePath, executableWorker, String(request.maxBytes)], cwd: source.directory, env: childEnvironment(source), graceMs: source.processGraceMs, signal: controller.signal, stdio: { stdin: { data: body }, stdout: 'pipe', stderr: { maxBytes: 1 } } }) }
      catch (_error) { throw new Error('Claude source worker could not start.') }
      const chunks: Buffer[] = []; let bytes = 0; let failure: Error | undefined
      let finishDrain!: () => void
      const drained = new Promise<void>((resolve) => { finishDrain = resolve })
      const terminate = (): void => {
        try { child.terminate() } catch (_error) {
          const error = new ClaudeSourceReleaseError('Claude source worker termination failed.'); failure = error; poison(error)
        }
      }
      const stop = (): void => { controller.abort() }
      const data = (value: unknown): void => {
        if (controller.signal.aborted || failure !== undefined) return
        if (!Buffer.isBuffer(value) && typeof value !== 'string') { failure = new Error('Claude source worker returned invalid output.'); stop(); return }
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8'); bytes += chunk.length
        if (bytes > request.maxBytes) { failure = new Error('Claude source response exceeded the configured byte limit.'); stop(); return }
        chunks.push(chunk)
      }
      const streamError = (_error: Error): void => { failure = new Error('Claude source worker output failed.'); stop(); finishDrain() }
      const streamClose = (): void => { if (!child.stdout?.readableEnded && !controller.signal.aborted) failure = new Error('Claude source worker output closed before draining.'); finishDrain() }
      const abort = (): void => { stop() }
      request.signal.addEventListener('abort', abort, { once: true })
      controller.signal.addEventListener('abort', () => { terminate(); finishDrain() }, { once: true })
      child.stdout?.on('data', data); child.stdout?.on('error', streamError); child.stdout?.once('end', finishDrain); child.stdout?.once('close', streamClose)
      if (child.stdout === undefined) { failure = new Error('Claude source worker output is unavailable.'); stop() }
      if (request.signal.aborted) stop()
      const direct = child.done.catch((_error: unknown) => { stop(); throw new Error('Claude source worker failed.') })
      const released = Promise.resolve().then(() => child.waitForExit()).then((value) => {
        if (!value) poison(new ClaudeSourceReleaseError('Claude source worker release could not be established.'))
        return value
      }, (_error: unknown) => {
        const error = new ClaudeSourceReleaseError('Claude source worker release could not be established.'); poison(error); throw error
      })
      const [outcome, range] = await Promise.allSettled([direct, released])
      await drained
      request.signal.removeEventListener('abort', abort)
      child.stdout?.off('data', data); child.stdout?.off('error', streamError); child.stdout?.off('end', finishDrain); child.stdout?.off('close', streamClose)
      if (range.status === 'rejected' || !range.value) throw new ClaudeSourceReleaseError('Claude source worker release could not be established.')
      if (failure !== undefined) throw failure
      request.signal.throwIfAborted()
      if (hasReleaseFailure() || closed && !release || controller.signal.aborted) {
        throw new Error('Claude source operation was cancelled or closed.')
      }
      if (outcome.status === 'rejected' || outcome.value.exitCode !== 0 || outcome.value.signal !== null) throw new Error('Claude source worker failed.')
      if (operation.operation === 'inspectSequentialPolicy') {
        const diagnostics = child.collected.stderr?.readFrom(0)
        if (diagnostics === undefined || diagnostics.nextOffset !== 0 || diagnostics.lossy) throw new Error('Claude sequential policy worker reported diagnostics or unknown stderr evidence.')
      }
      if (child.stdout === undefined) throw new Error('Claude source worker output is unavailable.')
      let reply: z.infer<typeof claudeSourceReplySchema>
      try { reply = claudeSourceReplySchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))) }
      catch (_error) { throw new Error('Claude source worker returned an invalid reply.') }
      if (!reply.ok) throw new Error(`Claude source worker refused the read (${reply.error}).`)
      return { value: reply.value, bytes }
    })()
    active.set(controller, task)
    void task.then(() => active.delete(controller), (error: unknown) => {
      if (error instanceof ClaudeSourceReleaseError) poison(error)
      active.delete(controller)
    })
    return task
  }
  const sdkFor = (request: CodingSessionReadRequest, release = false): Promise<ClaudeSessionSdk> => {
    const base = { protocol: 1 as const, ...source, maxBytes: request.maxBytes, maxEvents: request.maxEvents }
    const { id: _id, label: _label, nodePath: _nodePath, processGraceMs: _grace, sequentialHandoff: _sequential, ...scope } = base
    let historyBytes = 0
    return Promise.resolve({
      listSessions: async (options) => {
        const result = await read({ ...scope, operation: 'listSessions', limit: options?.limit ?? request.limit, offset: options?.offset ?? 0 }, request, release)
        return z.array(claudeSourceInfoSchema).parse(result.value) as Awaited<ReturnType<ClaudeSessionSdk['listSessions']>>
      },
      getSessionInfo: async (sessionId) => {
        const result = await read({ ...scope, operation: 'getSessionInfo', sessionId }, request, release)
        return result.value === null ? undefined : claudeSourceInfoSchema.parse(result.value) as Awaited<ReturnType<ClaudeSessionSdk['getSessionInfo']>>
      },
      getSessionMessages: async (sessionId, options) => {
        const offset = options?.offset ?? 0
        if (offset === 0) historyBytes = 0
        const result = await read({ ...scope, operation: 'getSessionMessages', sessionId, limit: options?.limit ?? request.limit, offset }, request, release)
        historyBytes += result.bytes
        if (historyBytes > request.maxBytes) throw new Error('Claude source complete raw history exceeded the configured byte limit.')
        return claudeSourceMessagesSchema.parse(result.value)
      },
    })
  }
  const provider = createClaudeCodingSessionProvider(profileId, source.label, source.directory, sdkFor, {
    profileRoot: source.profileRoot, connected,
  })
  const sequentialOptions = source.sequentialHandoff?.knownUnmanagedStartup === true ? source.sequentialHandoff : undefined
  if (sequentialOptions !== undefined && (authority === undefined || ['agents', 'sessions', 'sandbox', 'sandboxPolicy', 'workspaceRegistry'].some(name => authority.get(name) === undefined))) throw new Error('Claude sequential handoff requires explicit live root identity and confinement services.')
  // Captured lease release remains authorized after public source removal. This
  // reader is never registered and cannot admit a query or a new source claim.
  const releaseProvider = createClaudeCodingSessionProvider(profileId, source.label, source.directory,
    request => sdkFor(request, true), { profileRoot: source.profileRoot, connected: () => releaseFailure === undefined })
  const messagesFor = async (selection: Parameters<typeof provider.read>[0], request: CodingSessionReadRequest, release = false) => {
    const sdk = await sdkFor(request, release); const messages: z.infer<typeof claudeSourceMessagesSchema> = []
    for (let offset = 0;;) {
      const page = claudeSourceMessagesSchema.parse(await sdk.getSessionMessages(selection, {
        dir: source.directory, limit: request.limit, offset, includeSystemMessages: true,
      }))
      messages.push(...page)
      if (page.length > request.limit || messages.length > request.maxEvents) throw new Error('Claude sequential raw readback exceeds its configured history bound.')
      if (page.length < request.limit) return messages
      offset += page.length
    }
  }
  const sequential = sequentialOptions === undefined || authority === undefined ? undefined : createClaudeSequentialWriter(provider, {
    snapshot: (selection, request) => provider.read(selection.nativeSessionId, request),
    messages: (selection, request) => messagesFor(selection.nativeSessionId, request),
    releaseSnapshot: (selection, request) => releaseProvider.read(selection.nativeSessionId, request),
    releaseMessages: (selection, request) => messagesFor(selection.nativeSessionId, request, true),
  }, async (selection) => {
    const { createClaudeSequentialExecutor } = await import('@deepseek-ai/dsh-subagent-claude-code')
    return createClaudeSequentialExecutor(authority, {
      connectionId: source.id, profileRoot: source.profileRoot, directory: source.directory, shellHome: source.shellHome,
      nodePath: source.nodePath, processGraceMs: source.processGraceMs, ...sequentialOptions,
    }, selection.nativeSessionId, () => verifiedClaudeSequentialSdk(source), async (signal) => {
      const { id: _id, label: _label, nodePath: _nodePath, processGraceMs: _grace, sequentialHandoff: _sequential, ...scope } = source
      const receipt = await read(
        { protocol: 1, ...scope, operation: 'inspectSequentialPolicy', maxBytes: sequentialOptions.maxOutputBytes, maxEvents: 1 },
        { signal, limit: 1, maxEvents: 1, maxBytes: sequentialOptions.maxOutputBytes },
      )
      return claudeSequentialPolicyReceiptSchema.parse(receipt.value)
    })
  })
  return { provider: sequential === undefined ? provider : { ...provider, sequentialWriter: sequential.writer }, close: async () => {
    closed = true
    const pending = [...active.values()]
    for (const controller of active.keys()) controller.abort()
    const results = await Promise.allSettled([...pending, ...sequential === undefined ? [] : [sequential.close()]])
    const writerClose = sequential === undefined ? undefined : results.at(-1)
    if (writerClose?.status === 'rejected') throw writerClose.reason
    for (const result of results) if (result.status === 'rejected' && result.reason instanceof ClaudeSourceReleaseError) throw result.reason
    if (releaseFailure !== undefined) throw releaseFailure
  } }
}
/**
 * Register explicitly selected sources as reversible Loader effects.
 * @param ctx - coding-session registry and managed subprocess owner.
 * @param input - opted-in source selections; the default array is empty.
 * @returns after the selected sources have registered their reversible effects.
 */
export async function apply(ctx: Context, input: Config): Promise<void> {
  const config = Config(input)
  const sources = config.sources.map(source => sourceSchema.parse(source))
  if (new Set(sources.map(source => source.id)).size !== sources.length) throw new Error('Claude source ids must be unique.')
  for (const source of sources) await ctx.effect(async () => {
    const owner = await Promise.resolve(createClaudeSource(source, ctx.subprocess, ctx))
    const unregister = ctx.codingSessions.registerProvider(owner.provider)
    return async () => {
      try { await unregister() }
      finally { await owner.close() }
    }
  }, `coding-session-claude-source:${source.id}`)
}
