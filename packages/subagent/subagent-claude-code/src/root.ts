/** Opt-in normal root Claude turns over a long-lived, confined official SDK query. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { query as officialQuery, type Query, type SDKMessage, type SDKUserMessage, type CanUseTool, type PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-workspace'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import { z as jsonSchema } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SkillNativeConnectionId, SkillClaudeSessionId, SkillClaudeSendId } from '@deepseek-ai/dsh-skill-library/types'
import type { ClaudeRootProtocolRecord } from './root-types.ts'
import { nativeProfile } from './root-profile.ts'
import { ClaudeRootProcess } from './root-process.ts'
import { ClaudeRootObservations, nativeIdentity } from './root-observations.ts'

export const name = 'llm-claude-code-native'
export const inject = ['llm', 'agents', 'sessions', 'sandbox', 'sandboxPolicy', 'approval', 'subprocess', 'workspaceRegistry']
/** Explicit native profile and model; all retained or pending work is deployment bounded. */
export interface ClaudeCodeRootConfig {
  /** Stable configured connection identity, distinct from SDK sessions. */
  connectionId: string
  /** Native model/alias chosen by the deployment; no model is inferred from authentication. */
  model: string
  /** Maximum live or shutting-down native root sessions; defaults to 4. */
  maxSessions?: number
  /** Maximum tool identities retained for one send; defaults to 64. */
  maxItems?: number
  /** Maximum pending SDK frames for one send; defaults to 256. */
  maxPendingFrames?: number
  /** Complete serialized root prompt and system byte bound; defaults to 65536. */
  maxInputBytes?: number
  /** Complete SDK-frame byte bound per send; defaults to 1048576. */
  maxOutputBytes?: number
  /** Maximum native send lifetime; defaults to 300000 milliseconds. */
  maxTurnMs?: number
  /** Complete retained public protocol byte bound per native session; defaults to 8388608. */
  maxSessionBytes?: number
  /** Managed process termination grace; defaults to 3000 milliseconds. */
  disposeGraceMs?: number
}
export const Config: z<ClaudeCodeRootConfig> = z.object({
  connectionId: z.string().min(1).max(256).required(), model: z.string().min(1).max(256).required(),
  maxSessions: z.natural().min(1).default(4), maxItems: z.natural().min(1).max(256).default(64),
  maxPendingFrames: z.natural().min(1).default(256), maxInputBytes: z.natural().min(1).default(65536),
  maxSessionBytes: z.natural().min(1).default(8388608),
  maxOutputBytes: z.natural().min(1).default(1048576), maxTurnMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(300000),
  disposeGraceMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(3000),
})

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage | undefined
  private wake: (() => void) | undefined
  private stopped = false
  push(message: SDKUserMessage): void {
    if (this.stopped || this.pending !== undefined) throw new Error('Claude root input queue is unavailable.')
    this.pending = message; this.wake?.()
  }
  close(): void { this.stopped = true; this.wake?.() }
  private isStopped(): boolean { return this.stopped }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.isStopped()) {
      if (this.pending === undefined) await new Promise<void>((resolve) => { this.wake = resolve })
      this.wake = undefined
      if (this.isStopped()) return
      const message = this.pending; this.pending = undefined
      if (message !== undefined) yield message
    }
  }
}
interface Active {
  readonly agent: Agent
  readonly sendId: string
  readonly signal: AbortSignal
  readonly frames: SDKMessage[]
  readonly observations: ClaudeRootObservations
  readonly permissionIds: Set<string>
  readonly receiptWaiters: Map<string, () => void>
  readonly project?: { readonly id: string; readonly path: string } | undefined
  wake?: (() => void) | undefined
  bound: boolean
  terminal: boolean
  bytes: number
  failure?: Error
}
interface Entry {
  readonly input: InputQueue
  readonly query: Query
  readonly lifetime: AbortController
  readonly nativeSession: string
  readonly system: string
  readonly policyKey: string
  readonly startupFrames: SDKMessage[]
  bytes: number
  answer: string
  readonly cwd: string
  readonly profile: ClaudeRootProtocolRecord['profile']
  readonly permissions: Set<Promise<unknown>>
  pump: Promise<void>
  process?: ClaudeRootProcess
  active?: Active | undefined
  last?: Active | undefined
  inputHistory: string
  marker: string
  closing?: Promise<void>
}
const nativeTools = ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write']
function permissionEnded(active: Active, signal: AbortSignal): boolean {
  return signal.aborted || active.terminal
}
function assertSendNotFailed(active: Active): void {
  if (active.failure !== undefined) throw active.failure
}
function assertSendActive(active: Active, signal: AbortSignal): void {
  assertSendNotFailed(active)
  signal.throwIfAborted()
}
function textHistory(options: GenerateOptions): string {
  return JSON.stringify(options.messages.map(message => ({ role: message.role, text: message.content.map((block) => {
    if (block.type !== 'text') throw new Error('Claude root route accepts only text history.')
    return block.text
  }).join('\n') })))
}
function correlated(message: { user_message_uuid?: string; user_message_uuids?: string[] }, send: string): boolean {
  return message.user_message_uuid === send && (message.user_message_uuids === undefined
    || message.user_message_uuids.length === 1 && message.user_message_uuids[0] === send)
}

class ClaudeRootAdapter extends LlmAdapter {
  private readonly entries = new Map<SessionId, Entry>()
  private closed = false
  private readonly starting = new Set<SessionId>()
  private readonly processes = new Set<ClaudeRootProcess>()
  constructor(
    private readonly ctx: Context, private readonly config: Required<ClaudeCodeRootConfig>,
    private readonly writableRoots: (policy: SandboxExecutionPolicy) => readonly string[],
  ) { super() }
  override providerInfo(provider: string) { return { id: provider, name: 'Claude Code (native root)', auxiliaryGeneration: 'native' as const } }
  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: this.config.model, name: this.config.model, inputModalities: ['text'] as const }])
  }
  override resolveModel(provider: string, id: string) {
    if (id !== this.config.model) return Promise.reject(new Error('Claude root model must match the explicit deployment model.'))
    return Promise.resolve({ provider, id, name: id, inputModalities: ['text'] as const })
  }
  private authority(entry: Entry, active: Active): boolean {
    try {
      if (!this.closed && !entry.lifetime.signal.aborted && !active.signal.aborted && entry.active === active
        && this.ctx.agents.get(active.agent.id) === active.agent && this.ctx.sessions.get(active.agent.session.id) === active.agent.session
        && active.agent.session.header.cwd === entry.cwd
        && JSON.stringify(this.ctx.sandboxPolicy.resolve({ session: active.agent.session })) === entry.policyKey
        && (active.project === undefined || this.ctx.get('workspaceRegistry')?.list().some(project => project.id === active.project?.id && project.path === active.project.path))) return true
    } catch (_error: unknown) { /* A stale service or policy has no continuing native authority. */ }
    this.fail(entry, new Error('Claude root initiating identity or policy changed.'))
    return false
  }
  private validateInit(entry: Entry, message: Extract<SDKMessage, { subtype: 'init' }>): void {
    if (message.session_id !== entry.nativeSession || message.cwd !== entry.cwd || message.permissionMode !== 'default'
      || message.tools.length === 0 || message.tools.some(tool => !nativeTools.includes(tool))
      || (message.agents?.length ?? 0) > 0 || message.mcp_servers.length > 0 || message.plugins.length > 0 || message.skills.length > 0) throw new Error('Claude root native initialization contains unsupported sources or permissions.')
  }
  private async permission(
    entry: Entry, active: Active, toolName: string, toolInput: Record<string, unknown>, request: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const controlBytes = Buffer.byteLength(JSON.stringify({
      toolName, input: toolInput, toolUseID: request.toolUseID, requestId: request.requestId, agentID: request.agentID,
    }))
    active.bytes += controlBytes; entry.bytes += controlBytes
    if (active.bytes > this.config.maxOutputBytes || entry.bytes > this.config.maxSessionBytes) { this.fail(entry, new Error('Claude root permission request exceeds its configured bounds.')) }
    const deny: PermissionResult = { behavior: 'deny', message: 'This request has no live root action authority.' }
    if (active.terminal || request.agentID !== undefined || request.signal.aborted || !nativeTools.includes(toolName)
      || !nativeIdentity(request.toolUseID) || !nativeIdentity(request.requestId)
      || active.permissionIds.has(request.requestId) || active.permissionIds.size >= this.config.maxItems
      || !this.authority(entry, active)) return deny
    active.permissionIds.add(request.requestId)
    const signal = AbortSignal.any([active.signal, request.signal, entry.lifetime.signal])
    // SDK control callbacks run independently of its output iterator. Wait for
    // the actual source receipt rather than inventing authority from a request.
    while (!active.observations.matches(request.toolUseID, toolName, toolInput)) {
      if (permissionEnded(active, signal) || active.observations.isInvalid || active.observations.starts.has(request.toolUseID)) return deny
      let wake: (() => void) | undefined
      try {
        await new Promise<void>((resolve) => {
          wake = () => { resolve() }; active.receiptWaiters.set(request.requestId, wake)
          signal.addEventListener('abort', wake, { once: true })
        })
      } finally {
        active.receiptWaiters.delete(request.requestId)
        if (wake !== undefined) signal.removeEventListener('abort', wake)
      }
    }
    if (permissionEnded(active, signal) || !this.authority(entry, active)) return deny
    const outcome = await this.ctx.approval.request({ agent: active.agent, toolName: `claude-code/${toolName}`,
      reason: JSON.stringify({ toolUseID: request.toolUseID, requestId: request.requestId, input: toolInput }), signal })
    if (permissionEnded(active, signal) || !this.authority(entry, active)
      || !active.observations.matches(request.toolUseID, toolName, toolInput)) return deny
    return outcome === 'allowed-once' ? { behavior: 'allow', updatedInput: toolInput, toolUseID: request.toolUseID }
      : { behavior: 'deny', message: 'The initiating user did not approve this action.' }
  }
  private fail(entry: Entry, error: Error): void {
    entry.lifetime.abort(error); entry.input.close(); entry.process?.kill('SIGTERM')
    try { entry.query.close() } catch (_error: unknown) { /* Managed process ownership still closes the complete range. */ }
    if (entry.active !== undefined) {
      entry.active.failure = error
      // A policy notification can run inside Session.append's publication.
      // Its reentry guard must never prevent process cancellation.
      try { entry.active.observations.invalidate() } catch (_error: unknown) { /* The failed turn grants no learning authority. */ }
      entry.active.wake?.()
    }
  }
  private close(entry: Entry): Promise<void> {
    entry.closing ??= (async () => {
      this.fail(entry, new Error('Claude root session closed.'))
      await Promise.allSettled([entry.pump, ...entry.process === undefined ? [] : [entry.process.done]])
      while (entry.permissions.size > 0) await Promise.allSettled([...entry.permissions])
      if (entry.process !== undefined && !entry.process.quiescent) { this.closed = true; throw new Error('Claude root process shutdown could not be confirmed.') }
    })()
    return entry.closing
  }
  private async create(
    agent: Agent, system: string, policy: SandboxExecutionPolicy, project: { readonly id: string; readonly path: string },
  ): Promise<Entry> {
    const nativeEnv = scrubbedParentEnv(); const profile = nativeProfile(nativeEnv, policy, this.writableRoots(policy))
    const input = new InputQueue(); const lifetime = new AbortController(); const nativeSession = randomUUID()
    const publication: { entry?: Entry } = {}
    let process: ClaudeRootProcess | undefined
    let query: Query
    try { query = officialQuery({ prompt: input, options: {
      abortController: lifetime, sessionId: nativeSession, cwd: agent.session.header.cwd ?? policy.workspaceRoot,
      model: this.config.model, systemPrompt: system, persistSession: false, permissionMode: 'default',
      settingSources: [], tools: nativeTools, mcpServers: {}, strictMcpConfig: true, plugins: [], skills: [], env: nativeEnv,
      hooks: { PreToolUse: [{ hooks: [(input, toolUseId, hook) => {
        const owned = publication.entry; const active = owned?.active
        const deny = { hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const,
          permissionDecisionReason: 'The exact initiating root policy is unavailable.',
        } }
        if (owned !== undefined && active !== undefined) {
          const bytes = Buffer.byteLength(JSON.stringify(input)); active.bytes += bytes; owned.bytes += bytes
          if (active.bytes > this.config.maxOutputBytes || owned.bytes > this.config.maxSessionBytes) {
            this.fail(owned, new Error('Claude root native tool hook exceeds its configured bound.'))
            return Promise.resolve(deny)
          }
        }
        if (owned === undefined || active === undefined || active.terminal || hook.signal.aborted || input.hook_event_name !== 'PreToolUse'
          || input.session_id !== owned.nativeSession || input.cwd !== owned.cwd || input.agent_id !== undefined
          || !nativeIdentity(input.tool_use_id) || toolUseId !== input.tool_use_id || !nativeTools.includes(input.tool_name)
          || !this.authority(owned, active)) return Promise.resolve(deny)
        return Promise.resolve({})
      }] }] },
      canUseTool: (toolName, toolInput, request) => {
        const owned = publication.entry; const active = owned?.active
        if (owned === undefined || active === undefined) return Promise.resolve({ behavior: 'deny', message: 'This request has no live root action authority.' })
        const work = this.permission(owned, active, toolName, toolInput, request)
        owned.permissions.add(work)
        void work.then(() => { owned.permissions.delete(work) }, () => { owned.permissions.delete(work) })
        return work
      },
      onElicitation: () => Promise.resolve({ action: 'decline' as const }),
      onUserDialog: () => Promise.resolve({ behavior: 'cancelled' as const }),
      spawnClaudeCodeProcess: (options) => {
        if (process !== undefined) throw new Error('Claude root query cannot spawn a second process.')
        if (JSON.stringify(nativeProfile(options.env, policy, this.writableRoots(policy))) !== JSON.stringify(profile)) {
          throw new Error('Claude root SDK spawn changed its declared native profile.')
        }
        process = new ClaudeRootProcess(this.ctx, options, policy, this.config.disposeGraceMs, lifetime.signal, () =>
          !this.closed && this.ctx.workspaceRegistry.list().some(candidate =>
            candidate.id === project.id && candidate.path === project.path)
          && this.ctx.agents.get(agent.id) === agent && this.ctx.sessions.get(agent.session.id) === agent.session
          && agent.session.header.cwd === policy.workspaceRoot
          && JSON.stringify(this.ctx.sandboxPolicy.resolve({ session: agent.session })) === JSON.stringify(policy),
        { lineBytes: this.config.maxOutputBytes, lifetimeBytes: this.config.maxSessionBytes })
        this.processes.add(process)
        const spawned = process
        const release = () => { if (spawned.quiescent) this.processes.delete(spawned) }
        void process.done.then(release, release)
        void process.done.then(() => {
          if (publication.entry !== undefined && !lifetime.signal.aborted) {
            this.fail(publication.entry, new Error('Claude root process exited.'))
          }
        }, () => {
          if (!spawned.quiescent) this.closed = true
          if (publication.entry !== undefined) {
            this.fail(publication.entry, new Error('Claude root process failed under the initiating policy.'))
          }
        })
        if (publication.entry !== undefined) publication.entry.process = process
        return process
      },
    } }) } catch (_error: unknown) {
      lifetime.abort(); input.close()
      const spawned = (): ClaudeRootProcess | undefined => process
      const child = spawned(); child?.kill('SIGTERM')
      if (child !== undefined) { await Promise.allSettled([child.done]); if (!child.quiescent) { this.closed = true; throw new Error('Claude root startup shutdown could not be confirmed.') } }
      throw new Error('Claude root SDK startup failed.')
    }
    const entry: Entry = { input, query, lifetime, nativeSession, system, policyKey: JSON.stringify(policy),
      cwd: agent.session.header.cwd ?? policy.workspaceRoot,
      profile, inputHistory: '', marker: '', bytes: 0, answer: '', startupFrames: [], permissions: new Set(), pump: Promise.resolve(), ...process === undefined ? {} : { process } }
    publication.entry = entry
    const owned = entry
    owned.pump = (async () => {
      try {
        for await (const message of query) {
          if (message.type === 'system' && message.subtype === 'background_tasks_changed' && message.tasks.length > 0
            || message.type === 'system' && message.subtype === 'memory_recall') {
            // Rejected raw wire bytes were already bounded before SDK decoding.
            owned.bytes += Buffer.byteLength(JSON.stringify(message))
            throw new Error('Claude root does not retain background tasks or recalled native memory.')
          }
          const active = owned.active
          if (active === undefined) {
            const prior = owned.last
            if (prior !== undefined && message.type === 'system' && (message.subtype === 'session_state_changed' && message.state === 'idle' || message.subtype === 'status' && message.status === null || message.subtype === 'background_tasks_changed' && message.tasks.length === 0)) {
              if (message.session_id !== owned.nativeSession) throw new Error('Claude root idle frame has a different native session.')
              const protocol: ClaudeRootProtocolRecord = { provider: 'claude-code', profile: owned.profile, connectionId: brandString<SkillNativeConnectionId>(this.config.connectionId),
                sessionId: brandString<SkillClaudeSessionId>(owned.nativeSession), sendId: brandString<SkillClaudeSendId>(prior.sendId), phase: 'frame', message: jsonSchema.json().parse(JSON.parse(JSON.stringify(message))) }
              owned.bytes += Buffer.byteLength(JSON.stringify(protocol))
              if (owned.bytes > this.config.maxSessionBytes) throw new Error('Claude root native session exceeds its configured protocol bound.')
              prior.agent.session.append('claude-code/root-protocol', protocol, { ignorable: true })
              if (!await this.ctx.sessions.flush(prior.agent.session)) throw new Error('Claude root idle metadata is not durable.')
              continue
            }
            owned.bytes += Buffer.byteLength(JSON.stringify(message))
            if (owned.bytes > this.config.maxSessionBytes || message.type !== 'system' || message.subtype !== 'init'
              || owned.startupFrames.length >= this.config.maxPendingFrames || prior !== undefined) throw new Error('Claude root received an unsupported idle frame.')
            this.validateInit(owned, message); owned.startupFrames.push(message); continue
          }
          const protocol: ClaudeRootProtocolRecord = { provider: 'claude-code', profile: owned.profile, connectionId: brandString<SkillNativeConnectionId>(this.config.connectionId),
            sessionId: brandString<SkillClaudeSessionId>(owned.nativeSession), sendId: brandString<SkillClaudeSendId>(active.sendId), phase: 'frame',
            message: jsonSchema.json().parse(JSON.parse(JSON.stringify(message))) }
          const frameBytes = Buffer.byteLength(JSON.stringify(protocol)); active.bytes += frameBytes; owned.bytes += frameBytes
          if (owned.bytes > this.config.maxSessionBytes) throw new Error('Claude root native session exceeds its configured protocol bound.')
          if (active.bytes > this.config.maxOutputBytes) throw new Error('Claude root frames exceed the configured output bound.')
          if (message.type === 'conversation_reset') throw new Error('Claude root does not continue after a native conversation reset.')
          if (message.type === 'system' && message.subtype === 'init') this.validateInit(owned, message)
          if (message.type === 'system' && (message.subtype === 'compact_boundary' || message.subtype === 'status' && message.status === 'compacting' || message.subtype === 'model_refusal_fallback')) throw new Error('Claude root does not retain unsupported compaction or background work.')
          if ('session_id' in message && message.session_id !== owned.nativeSession) throw new Error('Claude root frame has a different native session.')
          const replayed: unknown = 'isReplay' in message ? message.isReplay : false
          if ('parent_tool_use_id' in message && message.parent_tool_use_id !== null
            || 'isSynthetic' in message && message.isSynthetic || Boolean(replayed)) {
            throw new Error('Claude root does not retain nested, synthetic or replayed native state.')
          }
          if (active.terminal && message.type !== 'system') throw new Error('Claude root received native work after its terminal result.')
          if (message.type === 'assistant') {
            if (message.supersedes !== undefined || message.resumed_from_incomplete_thinking === true) throw new Error('Claude root does not continue unverifiable native context replacement.')
            if (message.aborted === true) throw new Error('Claude root assistant frame was interrupted.')
            if (message.user_message_uuid !== undefined && !correlated(message, active.sendId)) throw new Error('Claude root frame does not match the current send.')
            if (correlated(message, active.sendId)) active.bound = true
            if (!active.bound) throw new Error('Claude root assistant frame lacks the actual send correlation.')
          } else if (message.type === 'result') {
            if (!correlated(message, active.sendId)) throw new Error('Claude root terminal frame is not attributable to the current send.')
          }
          active.agent.session.append('claude-code/root-protocol', protocol, { ignorable: true })
          if (!await this.ctx.sessions.flush(active.agent.session)) throw new Error('Claude root public SDK frame is not durable.')
          if (message.type === 'system' && ['task_started', 'task_progress', 'task_notification', 'task_updated'].includes(message.subtype)) {
            active.observations.observe(message)
            if (active.observations.isInvalid) throw new Error('Claude root task metadata is not direct foreground Bash work.')
            continue
          }
          if (active.terminal || message.type === 'system' && !active.bound) continue
          if (active.frames.length >= this.config.maxPendingFrames) throw new Error('Claude root frames exceed the configured pending bound.')
          if (!this.authority(owned, active)) continue
          if (message.type === 'result') active.terminal = true
          active.observations.observe(message)
          if (active.observations.isInvalid) throw new Error('Claude root direct native action could not be attributed safely.')
          for (const wake of active.receiptWaiters.values()) wake()
          active.frames.push(message); active.wake?.()
        }
        if (!lifetime.signal.aborted) this.fail(owned, new Error('Claude root SDK stream ended.'))
      } catch (_error: unknown) { this.fail(owned, new Error('Claude root SDK stream failed or exceeded its attribution bounds.')) }
    })()
    return owned
  }
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const agent = this.ctx.agents.currentInitiator()
    if (this.closed || options.purpose !== undefined || options.model !== this.config.model
      || options.reasoningEffort !== undefined || options.serviceTier !== undefined || options.maxTokens !== undefined
      || agent === undefined || this.ctx.agents.get(agent.id) !== agent || options.sessionId !== agent.session.id
      || agent.session.header.parentSession !== undefined || agent.session.header.origin === 'subagent' || agent.session.header.isSeeded
      || (agent.session.header.delegationDepth ?? 0) !== 0) throw new Error('Claude native turns require the exact live root session and configured route.')
    options.signal?.throwIfAborted()
    const project = this.ctx.workspaceRegistry.list().find(candidate => candidate.path === agent.session.header.cwd)
    if (this.ctx.sessions.get(agent.session.id) !== agent.session || project === undefined) throw new Error('Claude root route requires the exact registered project and Session.')
    const policy = this.ctx.sandboxPolicy.resolve({ session: agent.session })
    if (policy.workspaceRoot !== project.path) throw new Error('Claude root policy must use the registered project root.')
    const system = [options.system, ...options.messages.filter(message => message.role === 'system').flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])),
      'Use the configured native tools within the current project instructions. Native results do not verify task quality.'].filter(Boolean).join('\n\n')
    const history = textHistory(options)
    if (Buffer.byteLength(JSON.stringify({ system, history })) > this.config.maxInputBytes) throw new Error('Claude root prompt exceeds the configured input bound.')
    const key = agent.session.id
    let entry = this.entries.get(key)
    if (entry !== undefined && entry.lifetime.signal.aborted && entry.active === undefined) {
      await this.close(entry); this.entries.delete(key); entry = undefined
    }
    if (entry?.active !== undefined || entry?.closing !== undefined) throw new Error('Finish the current Claude root session operation first.')
    const markerIndex = entry === undefined ? -1 : options.messages.findLastIndex(message => message.role === 'assistant'
      && typeof message.source.replayState === 'object' && message.source.replayState !== null
      && 'response' in message.source.replayState && typeof message.source.replayState.response === 'object'
      && message.source.replayState.response !== null && 'claudeRootMarker' in message.source.replayState.response
      && message.source.replayState.response.claudeRootMarker === entry?.marker)
    const continuing = entry !== undefined && markerIndex >= 0
      && textHistory({ ...options, messages: options.messages.slice(markerIndex, markerIndex + 1) }) === entry.answer
      && entry.system === system && entry.policyKey === JSON.stringify(policy)
      && textHistory({ ...options, messages: options.messages.slice(0, markerIndex) }) === entry.inputHistory
    if (entry !== undefined && !continuing) { await this.close(entry); this.entries.delete(key); entry = undefined }
    if (entry === undefined) {
      if (this.starting.has(key) || this.entries.size + this.starting.size >= this.config.maxSessions) throw new Error('Claude root native session limit reached.')
      this.starting.add(key)
      try { entry = await this.create(agent, system, policy, project); this.entries.set(key, entry) } finally { this.starting.delete(key) }
    }
    const owned = entry
    const turn = new AbortController()
    const signal = AbortSignal.any([turn.signal, owned.lifetime.signal, ...options.signal === undefined ? [] : [options.signal]])
    const sendId = randomUUID()
    const observations = new ClaudeRootObservations(this.config.connectionId, owned.nativeSession, sendId, this.config.maxItems,
      (item) => { agent.session.append('skill/native-item', item, { ignorable: true }) }, project.path)
    const active: Active = {
      agent, sendId, signal, observations, frames: [], permissionIds: new Set(), receiptWaiters: new Map(),
      project, bound: false, terminal: false, bytes: 0,
    }
    owned.active = active
    const onAbort = () => { this.fail(owned, new Error('Claude root turn was cancelled.')) }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => { this.fail(owned, new Error('Claude root turn exceeded its configured duration.')) }, this.config.maxTurnMs)
    let complete = false; let index = 0; const answer: string[] = []
    try {
      const suffix = continuing ? textHistory({ ...options, messages: options.messages.slice(markerIndex + 1) }) : history
      signal.throwIfAborted()
      const message: SDKUserMessage = { type: 'user', uuid: sendId, session_id: owned.nativeSession, parent_tool_use_id: null,
        message: { role: 'user', content: `Conversation context from Harness (quoted roles):\n${suffix}` } }
      const request: ClaudeRootProtocolRecord = { provider: 'claude-code', profile: owned.profile, connectionId: brandString<SkillNativeConnectionId>(this.config.connectionId),
        sessionId: brandString<SkillClaudeSessionId>(owned.nativeSession), sendId: brandString<SkillClaudeSendId>(sendId), phase: 'request', system,
        message: jsonSchema.json().parse(JSON.parse(JSON.stringify(message))) }
      const requestBytes = Buffer.byteLength(JSON.stringify(request)); owned.bytes += requestBytes
      if (requestBytes > this.config.maxInputBytes || owned.bytes > this.config.maxSessionBytes) throw new Error('Claude root complete SDK request exceeds its configured byte bound.')
      agent.session.append('claude-code/root-protocol', request, { ignorable: true })
      if (!await this.ctx.sessions.flush(agent.session)) throw new Error('Claude root SDK request is not durable.')
      signal.throwIfAborted()
      if (!this.authority(owned, active)) throw new Error('Claude root initiating authority changed before dispatch.')
      for (const frame of owned.startupFrames.splice(0)) {
        const protocol: ClaudeRootProtocolRecord = { provider: 'claude-code', profile: owned.profile, connectionId: request.connectionId, sessionId: request.sessionId, sendId: request.sendId,
          phase: 'frame', message: jsonSchema.json().parse(JSON.parse(JSON.stringify(frame))) }
        const bytes = Buffer.byteLength(JSON.stringify(protocol)); active.bytes += bytes; owned.bytes += bytes
        if (active.bytes > this.config.maxOutputBytes || owned.bytes > this.config.maxSessionBytes) throw new Error('Claude root startup protocol exceeds its configured bound.')
        agent.session.append('claude-code/root-protocol', protocol, { ignorable: true })
      }
      if (!await this.ctx.sessions.flush(agent.session)) throw new Error('Claude root startup protocol is not durable.')
      signal.throwIfAborted(); owned.input.push(message)
      while (!complete) {
        assertSendActive(active, signal)
        if (active.frames.length === 0) await new Promise<void>((resolve) => { active.wake = resolve })
        active.wake = undefined
        assertSendActive(active, signal)
        const message = active.frames.shift()
        if (message?.type === 'assistant') {
          for (const block of message.message.content) if (block.type === 'text') {
            answer.push(block.text)
            yield { type: 'block-start', index, blockType: 'text' }; yield { type: 'text-delta', index, text: block.text }
            yield { type: 'block-end', index: index++, block: { type: 'text', text: block.text } }
          }
        } else if (message?.type === 'result') {
          if (message.subtype !== 'success' || message.is_error) throw new Error('Claude root native turn did not complete successfully.')
          turn.abort()
          while (owned.permissions.size > 0) await Promise.allSettled([...owned.permissions])
          assertSendNotFailed(active)
          if (index === 0 && message.result.length > 0) {
            answer.push(message.result)
            yield { type: 'block-start', index, blockType: 'text' }; yield { type: 'text-delta', index, text: message.result }
            yield { type: 'block-end', index: index++, block: { type: 'text', text: message.result } }
          }
          owned.inputHistory = history; owned.answer = JSON.stringify([{ role: 'assistant', text: answer.join('\n') }]); owned.marker = randomUUID(); complete = true
          yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { claudeRootMarker: owned.marker } } }
        }
      }
    } finally {
      turn.abort()
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (complete) owned.last = active
      if (owned.active === active) owned.active = undefined
      if (!complete) {
        try { observations.invalidate() } catch (_error: unknown) { /* Closing still drains the exact native owner. */ }
        await this.close(owned); this.entries.delete(key)
      }
    }
  }
  async dispose(): Promise<void> {
    this.closed = true
    for (const process of this.processes) process.kill('SIGTERM')
    await Promise.all([...this.entries.values()].map(entry => this.close(entry)))
    await Promise.allSettled([...this.processes].map(process => process.done))
    if ([...this.processes].some(process => !process.quiescent)) throw new Error('Claude root process shutdown could not be confirmed.')
    this.entries.clear()
  }
  policyChanged(id: SessionId): void {
    const entry = this.entries.get(id)
    if (entry !== undefined) {
      this.fail(entry, new Error('Claude root policy changed.'))
      void this.close(entry).then(() => { if (this.entries.get(id) === entry) this.entries.delete(id) }, () => {})
    }
  }
  async disposeSession(id: SessionId): Promise<void> {
    const entry = this.entries.get(id)
    if (entry !== undefined) { await this.close(entry); this.entries.delete(id) }
  }
}

export async function apply(ctx: Context, config: ClaudeCodeRootConfig): Promise<void> {
  const resolved = Config(config) as Required<ClaudeCodeRootConfig>
  if (!nativeIdentity(resolved.connectionId)) throw new Error('Claude root connection identity must be bounded alphanumeric metadata.')
  const { writableRoots } = await import('@deepseek-ai/dsh-sandbox').catch((error: unknown) => {
    throw new Error('The enabled Claude root route requires the sandbox package.', { cause: error })
  })
  const adapter = new ClaudeRootAdapter(ctx, resolved, writableRoots)
  ctx.effect(() => ctx.llm.registerAdapter(['claude-code-native'], adapter))
  ctx.on('session/disposed', (session) => {
    void adapter.disposeSession(session.id).catch((error: unknown) => {
      ctx.logger.warn('Claude root session disposal failed: %o', error)
    })
  })
  ctx.on('session/event', (session, event) => { if (event.type === 'sandbox/mode') adapter.policyChanged(session.id) })
  ctx.effect(() => () => adapter.dispose())
}
