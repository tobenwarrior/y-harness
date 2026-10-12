/** Cold, persisted, original-ID Claude conversation turns; native project tools remain disabled. */
import { randomUUID, createHash } from 'node:crypto'
import { lstat, open, realpath, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Options, Query, SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z as jsonSchema } from 'zod'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-workspace'
import type { SkillNativeConnectionId, SkillClaudeSessionId, SkillClaudeSendId } from '@deepseek-ai/dsh-skill-library/types'
import { nativeProfile } from './root-profile.ts'
import { ClaudeRootProcess } from './root-process.ts'
import type { ClaudeRootProtocolRecord } from './root-types.ts'

/** Explicit installed SDK/profile/project selection; paths are deployment-owned, never discovered from authentication. */
export interface ClaudeSequentialSelection {
  /** Deployment-owned source identity, independent of native and Y session IDs. */
  connectionId: string
  /** Exact canonical original CLAUDE_CONFIG_DIR; no auth path discovery occurs. */
  profileRoot: string
  /** Exact registered original project cwd. */
  directory: string
  /** Explicit canonical native home; existing account state stays read-only. */
  shellHome: string
  /** Canonical Node runtime already selected for independent metadata readers. */
  nodePath: string
  /** Exact ordinary platform payload belonging to SDK 0.3.263. */
  nativeExecutablePath: string
  /** Deployment-certified SHA256 of that native payload, checked before dispatch. */
  nativeExecutableSha256: string
  /** Trusted unmanaged-startup declaration; the SDK cannot certify absent future remote/helper policy. */
  knownUnmanagedStartup: boolean
  /** Bounded managed process termination and range-observation grace. */
  processGraceMs: number
  /** Entire native turn deadline, including independent natural settlement. */
  maxTurnMs: number
  /** Complete human conversation text byte bound. */
  maxInputBytes: number
  /** Complete public SDK-frame byte bound for one turn. */
  maxOutputBytes: number
  /** Complete retained wire and diagnostic byte bound for the owned process. */
  maxSessionBytes: number
}
/** Exact native user UUID and completed assistant bodies expected in isolated persisted readback. */
export interface ClaudeSequentialTurnReceipt {
  nativeTurnId: string
  userMessage: SDKUserMessage['message']
  assistants: { id: string; message: SDKAssistantMessage['message'] }[]
  processExited: true
  streamsDrained: true
  noObservedPersistenceErrors: true
}
/** SDK query implementation is verified by the source owner before any cold native turn. */
export interface ClaudeSequentialSdk {
  /**
   * @param request - one bounded native input stream and explicit execution controls.
   * @returns the installed SDK query under its independent managed process owner.
   */
  query(request: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query
}
/** Fresh selected-profile observation, separate from the trusted unmanaged-startup declaration. */
export interface ClaudeSequentialStartupPolicyReceipt { noManagedSettingsObserved: true; fingerprint: string }
/** Root-bound executor kept private to one sequential source lease. */
export interface ClaudeSequentialExecutor {
  /** @returns whether the original initiating root, project and current policy still match. */
  current(): boolean
  /**
   * @param text - one explicit human prompt.
   * @param signal - turn cancellation.
   * @param beforeDispatch - awaited durable dispatch marker.
   * @returns exact native completion and owned process receipts.
   */
  turn(text: string, signal: AbortSignal, beforeDispatch: () => Promise<void>): Promise<ClaudeSequentialTurnReceipt>
  /** @returns after all admitted SDK work and managed process ranges settle; uncertain release rejects. */
  close(): Promise<void>
}

/**
 * Derive the SDK 0.3.263 native project directory without reading a profile.
 * @param profileRoot - explicitly selected original CLAUDE_CONFIG_DIR.
 * @param directory - exact absolute native project cwd.
 * @returns the installed SDK's project transcript directory, including its long-path hash suffix.
 */
export function claudeSequentialProjectDirectory(profileRoot: string, directory: string): string {
  const path = process.platform === 'darwin' ? resolve(directory).normalize('NFC') : resolve(directory)
  const encoded = path.replace(/[^a-zA-Z0-9]/g, '-')
  let hash = 0
  for (let index = 0; index < path.length; index++) hash = (hash << 5) - hash + path.charCodeAt(index) | 0
  const segment = encoded.length <= 200 ? encoded : `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`
  return join(resolve(profileRoot).normalize('NFC'), 'projects', segment)
}

async function verifyNativeExecutable(selection: ClaudeSequentialSelection): Promise<void> {
  const executable = selection.nativeExecutablePath
  if (!isAbsolute(executable) || basename(executable) !== (process.platform === 'win32' ? 'claude.exe' : 'claude')
    || await realpath(executable) !== executable || !(await lstat(executable)).isFile()) throw new Error('Claude sequential runtime requires its explicitly selected ordinary native SDK payload.')
  const manifestPath = join(dirname(executable), 'package.json')
  const manifestStat = await lstat(manifestPath)
  if (await realpath(manifestPath) !== manifestPath || !manifestStat.isFile() || manifestStat.size > 65536) throw new Error('Claude sequential native payload manifest is invalid.')
  const manifest = jsonSchema.object({ name: jsonSchema.string(), version: jsonSchema.literal('0.3.263'),
    os: jsonSchema.array(jsonSchema.string()), cpu: jsonSchema.array(jsonSchema.string()) }).parse(JSON.parse(await readFile(manifestPath, 'utf8')))
  const platformName = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  if (manifest.name !== platformName && !(process.platform === 'linux' && manifest.name === `${platformName}-musl`)
    || !manifest.os.includes(process.platform) || !manifest.cpu.includes(process.arch)) throw new Error('Claude sequential native payload does not match the pinned SDK platform.')
  const file = await open(executable, 'r'); const hash = createHash('sha256'); let bytes = 0
  try {
    const buffer = Buffer.alloc(65536)
    for (;;) {
      const read = await file.read(buffer, 0, buffer.length, null)
      if (read.bytesRead === 0) break
      bytes += read.bytesRead
      if (bytes > 512 * 1024 * 1024) throw new Error('Claude sequential native payload exceeds its verification bound.')
      hash.update(buffer.subarray(0, read.bytesRead))
    }
  } finally { await file.close() }
  if (hash.digest('hex') !== selection.nativeExecutableSha256) throw new Error('Claude sequential native payload digest changed.')
}

function environment(selection: ClaudeSequentialSelection): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...scrubbedParentEnv() }
  for (const key of Object.keys(process.env)) if (!(key in env)) env[key] = undefined
  for (const key of Object.keys(env)) if (/^(NODE_|CLAUDE_|ANTHROPIC_|CODEX_|XDG_)/i.test(key)) env[key] = undefined
  env.HOME = selection.shellHome; env.USERPROFILE = selection.shellHome
  env.CLAUDE_CONFIG_DIR = selection.profileRoot
  env.CLAUDE_CODE_DISABLE_FAST_MODE = '1'
  return env
}
function exactRoot(ctx: Context, agent: Agent, selection: ClaudeSequentialSelection, policy: SandboxExecutionPolicy): boolean {
  try {
    return ctx.agents.get(agent.id) === agent && ctx.sessions.get(agent.session.id) === agent.session
      && agent.status === 'idle' && agent.session.header.cwd === selection.directory
      && agent.session.header.parentSession === undefined && agent.session.header.origin !== 'subagent'
      && !agent.session.header.isSeeded && (agent.session.header.delegationDepth ?? 0) === 0
      && ctx.workspaceRegistry.list().some(project => project.path === selection.directory)
      && JSON.stringify(ctx.sandboxPolicy.resolve({ session: agent.session })) === JSON.stringify(policy)
  } catch (_error: unknown) { return false }
}
const supportedSystem = (message: Extract<SDKMessage, { type: 'system' }>): boolean =>
  message.subtype === 'status' && (message.status === null || message.status === 'requesting')
    && (message.permissionMode === undefined || message.permissionMode === 'default') && message.compact_error === undefined
  || message.subtype === 'session_state_changed' && (message.state === 'idle' || message.state === 'running')
  || message.subtype === 'background_tasks_changed' && message.tasks.length === 0

// Public SDK declarations describe expected values; native frames still cross
// an external boundary and must independently establish conversation evidence.
const nativeFrameEvidence = jsonSchema.object({ fast_mode_state: jsonSchema.literal('off').optional() }).loose()
const conversationAssistantEvidence = jsonSchema.object({
  container: jsonSchema.null().optional(), context_management: jsonSchema.null().optional(),
  usage: jsonSchema.object({ server_tool_use: jsonSchema.null().optional() }).loose(),
  content: jsonSchema.array(jsonSchema.discriminatedUnion('type', [
    jsonSchema.object({ type: jsonSchema.literal('text'), text: jsonSchema.string() }).loose(),
    jsonSchema.object({ type: jsonSchema.literal('thinking'), thinking: jsonSchema.string(), signature: jsonSchema.string() }).loose(),
    jsonSchema.object({ type: jsonSchema.literal('redacted_thinking'), data: jsonSchema.string() }).loose(),
  ])),
}).loose()

/**
 * Capture the exact live Y root without starting a native query or reading a native profile.
 * @param ctx - existing root identity, Session, sandbox and managed subprocess authorities.
 * @param selection - explicit original profile/project/runtime and configured bounds.
 * @param nativeSessionId - original persisted UUID, never a replacement ID.
 * @param resolveSdk - verified official installed query resolver; fixtures substitute only this native API.
 * @param verifyStartupPolicy - fresh isolated public settings observation; no managed policy is overridden.
 * @returns a cold conversation executor; close never treats SDK cleanup as a process-exit receipt.
 */
export async function createClaudeSequentialExecutor(
  ctx: Context, selection: ClaudeSequentialSelection, nativeSessionId: string,
  resolveSdk: () => Promise<ClaudeSequentialSdk>,
  verifyStartupPolicy: (signal: AbortSignal) => Promise<ClaudeSequentialStartupPolicyReceipt>,
): Promise<ClaudeSequentialExecutor> {
  const agent = ctx.agents.currentInitiator()
  const trustedStartup = jsonSchema.literal(true).safeParse(selection.knownUnmanagedStartup)
  if (!trustedStartup.success || agent === undefined
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeSessionId)
    || ![selection.profileRoot, selection.directory, selection.shellHome, selection.nodePath].every(isAbsolute)
    || selection.profileRoot !== selection.profileRoot.normalize('NFC')
    || process.platform === 'darwin' && selection.directory !== selection.directory.normalize('NFC')) throw new Error('Claude sequential handoff requires an exact canonical original source and live root.')
  const policy = ctx.sandboxPolicy.resolve({ session: agent.session })
  if (policy.mode === 'danger-full-access' || policy.workspaceRoot !== selection.directory || !exactRoot(ctx, agent, selection, policy)) throw new Error('Claude sequential handoff requires the selected idle project root and confined Y policy.')
  // This check protects the existing tool policy. The separate native persistence
  // process below has no model tools and gets only this project's transcript root.
  const { writableRoots } = await import('@deepseek-ai/dsh-sandbox')
  if (!exactRoot(ctx, agent, selection, policy)) throw new Error('Claude sequential initiating root changed during authority resolution.')
  const env = environment(selection); const profile = nativeProfile(env, policy, writableRoots(policy))
  const stateDirectory = claudeSequentialProjectDirectory(selection.profileRoot, selection.directory)
  const processPolicy: SandboxExecutionPolicy = { mode: 'workspace-write', workspaceRoot: stateDirectory, sessionId: agent.session.id }
  let closed = false; let releaseFailure: Error | undefined; let active: Promise<ClaudeSequentialTurnReceipt> | undefined
  const processes = new Set<ClaudeRootProcess>(); const controllers = new Set<AbortController>()
  const current = () => !closed && releaseFailure === undefined && exactRoot(ctx, agent, selection, policy)
  const poison = (error: Error) => { releaseFailure ??= error }
  const record = async (sendId: string, phase: 'request' | 'frame', message: ClaudeRootProtocolRecord['message']): Promise<void> => {
    const base = { provider: 'claude-code' as const, connectionId: brandString<SkillNativeConnectionId>(selection.connectionId),
      sessionId: brandString<SkillClaudeSessionId>(nativeSessionId), sendId: brandString<SkillClaudeSendId>(sendId), profile, message }
    agent.session.append('claude-code/root-protocol', phase === 'request' ? { ...base, phase, system: '' } : { ...base, phase }, { ignorable: true })
    if (!await ctx.sessions.flush(agent.session)) throw new Error('Claude sequential public protocol was not persisted to the initiating Y Session.')
  }
  const turn = (text: string, signal: AbortSignal, beforeDispatch: () => Promise<void>): Promise<ClaudeSequentialTurnReceipt> => {
    if (!current() || active !== undefined || text.trim() === '' || /^\s*(?:\/|!)/mu.test(text)
      || Buffer.byteLength(text, 'utf8') > selection.maxInputBytes) return Promise.reject(new Error('Claude sequential source accepts bounded conversation text without native control commands.'))
    signal.throwIfAborted()
    const work = (async (): Promise<ClaudeSequentialTurnReceipt> => {
      const lifetime = new AbortController(); controllers.add(lifetime)
      const combined = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(selection.maxTurnMs)])
      const sendId = randomUUID()
      const user: SDKUserMessage = { type: 'user', uuid: sendId, session_id: nativeSessionId,
        parent_tool_use_id: null, message: { role: 'user', content: text } }
      const input = async function* (): AsyncGenerator<SDKUserMessage> { yield await Promise.resolve(user) }
      let process: ClaudeRootProcess | undefined; let query: Query | undefined
      try {
        combined.throwIfAborted()
        for (const path of [selection.profileRoot, selection.directory, selection.shellHome, selection.nodePath, stateDirectory]) {
          if (await realpath(path) !== path) throw new Error('Claude sequential selected paths must be canonical.')
        }
        const transcript = join(stateDirectory, `${nativeSessionId}.jsonl`)
        if (!(await lstat(transcript)).isFile() || await realpath(transcript) !== transcript) throw new Error('Claude original transcript is not an ordinary file in the selected native project.')
        await verifyNativeExecutable(selection); combined.throwIfAborted()
        const sdk = await resolveSdk(); combined.throwIfAborted()
        jsonSchema.object({
          noManagedSettingsObserved: jsonSchema.literal(true), fingerprint: jsonSchema.string().regex(/^[a-f0-9]{64}$/),
        }).strict().parse(await verifyStartupPolicy(combined))
        combined.throwIfAborted()
        if (!current()) throw new Error('Claude sequential initiating root changed before the native turn.')
        await record(sendId, 'request', jsonSchema.json().parse(JSON.parse(JSON.stringify(user))))
        if (!current()) throw new Error('Claude sequential initiating root changed before native dispatch.')
        await beforeDispatch()
        combined.throwIfAborted()
        if (!current()) throw new Error('Claude sequential initiating root changed while native dispatch was recorded.')
        const stop = () => { lifetime.abort(); process?.kill('SIGTERM'); try { query?.close() } catch (_error: unknown) { /* The independent managed owner remains authoritative. */ } }
        const recheckCallback = () => { if (!current()) lifetime.abort(new Error('Claude sequential initiating root changed before native control.')) }
        combined.addEventListener('abort', stop, { once: true })
        try {
          query = sdk.query({ prompt: input(), options: {
            resume: nativeSessionId, forkSession: false, persistSession: true,
            cwd: selection.directory, pathToClaudeCodeExecutable: selection.nativeExecutablePath, env,
            abortController: lifetime, permissionMode: 'default', tools: [], allowedTools: [],
            settingSources: [], settings: { disableAllHooks: true, disableBundledSkills: true, disableSkillShellExecution: true,
              disableWorkflows: true, disableRemoteControl: true, autoMemoryEnabled: false,
              fastMode: false, fastModePerSessionOptIn: true },
            plugins: [], skills: [], mcpServers: {}, strictMcpConfig: true,
            hooks: { PreToolUse: [{ hooks: [() => {
              recheckCallback()
              return Promise.resolve({ hookSpecificOutput: {
                hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Sequential handoff is conversation only.',
              } })
            }] }] },
            canUseTool: () => { recheckCallback(); return Promise.resolve({ behavior: 'deny', message: 'Sequential handoff is conversation only.' }) },
            onElicitation: () => { recheckCallback(); return Promise.resolve({ action: 'decline' }) },
            onUserDialog: () => { recheckCallback(); return Promise.resolve({ behavior: 'cancelled' }) },
            spawnClaudeCodeProcess: (options) => {
              if (process !== undefined || options.cwd !== selection.directory || options.command !== selection.nativeExecutablePath
                || !current() || JSON.stringify(nativeProfile(options.env, policy, writableRoots(policy))) !== JSON.stringify(profile)) throw new Error('Claude sequential SDK spawn changed its selected profile or authority.')
              process = new ClaudeRootProcess(ctx, options, processPolicy, selection.processGraceMs, lifetime.signal,
                () => current(), { lineBytes: selection.maxOutputBytes, lifetimeBytes: selection.maxSessionBytes }, true)
              processes.add(process); return process
            },
          } })
          let bytes = 0; let terminal = false; let initialized = false; let bound = false
          const assistants: ClaudeSequentialTurnReceipt['assistants'] = []
          for await (const message of query) {
            combined.throwIfAborted()
            if (!current()) throw new Error('Claude sequential initiating identity or policy changed during the native turn.')
            bytes += Buffer.byteLength(JSON.stringify(message), 'utf8')
            nativeFrameEvidence.parse(message)
            if (bytes > selection.maxOutputBytes || 'session_id' in message && message.session_id !== nativeSessionId) {
              throw new Error('Claude sequential native frame exceeds its bound or changes the original ID.')
            }
            if (message.type === 'system' && message.subtype === 'init') {
              if (initialized || message.cwd !== selection.directory || message.permissionMode !== 'default' || message.claude_code_version !== '2.1.263'
                || message.tools.length > 0 || (message.agents?.length ?? 0) > 0 || message.mcp_servers.length > 0 || message.plugins.length > 0 || message.skills.length > 0) throw new Error('Claude sequential native initialization enables unsupported authority.')
              initialized = true
            } else if (message.type === 'assistant') {
              conversationAssistantEvidence.parse(message.message)
              if (message.user_message_uuid === sendId) bound = true
              if (!initialized || !bound || terminal || message.parent_tool_use_id !== null || message.aborted === true
                || 'isSynthetic' in message && message.isSynthetic || 'isReplay' in message && message.isReplay
                || message.error !== undefined || message.subagent_type !== undefined
                || message.supersedes !== undefined || message.resumed_from_incomplete_thinking
                || message.user_message_uuid !== undefined && message.user_message_uuid !== sendId
                || message.user_message_uuids !== undefined
                && (message.user_message_uuids.length !== 1 || message.user_message_uuids[0] !== sendId)) {
                throw new Error('Claude sequential assistant is not attributable to the one native conversation turn.')
              }
              assistants.push({ id: message.uuid, message: message.message })
            } else if (message.type === 'result') {
              if (!initialized || terminal || assistants.length === 0 || message.subtype !== 'success' || message.is_error
                || message.user_message_uuid !== sendId || message.user_message_uuids !== undefined
                && (message.user_message_uuids.length !== 1 || message.user_message_uuids[0] !== sendId)
                || (message.queued_turn_count ?? 0) !== 0) throw new Error('Claude sequential native turn did not complete exactly once.')
              terminal = true
            } else if (message.type !== 'system' || !supportedSystem(message)) {
              throw new Error('Claude sequential received unsupported native work or diagnostics.')
            }
            await record(sendId, 'frame', jsonSchema.json().parse(JSON.parse(JSON.stringify(message))))
          }
          if (!terminal || process === undefined) throw new Error('Claude sequential native stream ended without owned completion.')
          await process.done
          combined.throwIfAborted()
          if (!process.quiescent || !process.outputDrained || process.killed || process.exitCode !== 0 || process.signalCode !== null
            || process.diagnosticOutput) throw new Error('Claude sequential native persistence/process evidence is incomplete.')
          processes.delete(process)
          return { nativeTurnId: sendId, userMessage: user.message, assistants,
            processExited: true, streamsDrained: true, noObservedPersistenceErrors: true }
        } finally { combined.removeEventListener('abort', stop) }
      } catch (_error: unknown) {
        const failure = new Error('Claude sequential native turn or persistence settlement could not be confirmed.')
        poison(failure); lifetime.abort(); process?.kill('SIGTERM')
        try { query?.close() } catch (_closeError: unknown) { /* The managed process wait below still governs quiescence. */ }
        throw failure
      } finally {
        if (process !== undefined) {
          await Promise.allSettled([process.done])
          if (!process.quiescent) poison(new Error('Claude sequential managed process release remains uncertain.'))
          else processes.delete(process)
        }
        controllers.delete(lifetime)
      }
    })()
    active = work
    void work.then(() => { active = undefined }, () => { active = undefined })
    return work
  }
  return { current, turn, close: async () => {
    closed = true
    for (const controller of controllers) controller.abort()
    for (const process of processes) process.kill('SIGTERM')
    if (active !== undefined) await Promise.allSettled([active])
    await Promise.allSettled([...processes].map(process => process.done))
    if ([...processes].some(process => !process.quiescent)) poison(new Error('Claude sequential managed range remains uncertain.'))
    if (releaseFailure !== undefined) throw releaseFailure
  } }
}
