/** Optional native Codex loop. This route does not dispatch Harness tools. */
import { Buffer } from 'node:buffer'
import type { CodexCodingSessionReader } from './codex-coding-sessions.ts'
import { randomUUID } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'
import { LlmAdapter, ReasoningEffortId, ServiceTierId, offloadedImageText } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, RequestMessage, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { CodexBackendModelView, CodexBackendView } from './codex-types.ts'
import type { CodexTurnAccess } from './codex-backend-access.ts'
import type { NativeSkillLibraryObservation, SkillLibraryProject } from '@deepseek-ai/dsh-skill-library/types'
import { parseCodexSkills } from './codex-skill-library.ts'
import { codexNativeItem } from './codex-native-evidence.ts'
import type { SkillLearningNativeItem } from '@deepseek-ai/dsh-skill-library/types'

type Obj = Record<string, unknown>
function obj(value: unknown): Obj { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {} }
function text(value: unknown): string { return typeof value === 'string' ? value : '' }
/**
 * Native modality tags this route republishes. The LLM seam's modality map has
 * no audio member, so an audio-only advertisement would be an unsupported claim.
 */
const SEAM_MODALITIES = ['text', 'image'] as const
/**
 * Modalities assumed when the native catalog omits the field. The app-server
 * schema declares `["text","image"]` as the field default, so omission means
 * the protocol default rather than unknown capability.
 */
const DEFAULT_NATIVE_MODALITIES: Array<'text' | 'image'> = ['text', 'image']
/** Synthetic standard tier the composer offers beside the catalog's own tiers. */
const STANDARD_TIER: { id: string; name: string } = { id: 'default', name: 'Standard' }
/**
 * Preserve model-owned native effort/tier/modality vocabulary without synthesizing capabilities.
 * @param value - the app-server `model/list` result.
 * @returns one view per visible catalog row, in catalog order.
 * @throws when the result carries no `data` array.
 */
export function parseCodexModels(value: unknown): CodexBackendModelView[] {
  const data = obj(value).data
  if (!Array.isArray(data)) throw new Error('Codex returned an invalid model catalog.')
  return data.flatMap((raw) => {
    const row = obj(raw)
    if (row.hidden === true || !text(row.model || row.id)) return []
    const efforts = Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts.flatMap((rawEffort) => {
      const effort = obj(rawEffort); const id = text(effort.reasoningEffort)
      return id ? [{ id, description: text(effort.description) }] : []
    }) : []
    const serviceTiers = Array.isArray(row.serviceTiers) ? row.serviceTiers.flatMap((rawTier) => {
      const tier = obj(rawTier); const id = text(tier.id)
      return id ? [{ id, name: text(tier.name) || id, description: text(tier.description) }] : []
    }) : []
    const advertised = Array.isArray(row.inputModalities)
      ? row.inputModalities.filter((modality): modality is typeof SEAM_MODALITIES[number] =>
        SEAM_MODALITIES.some(candidate => candidate === modality))
      : []
    const inputModalities = advertised.length > 0 ? [...new Set(advertised)] : [...DEFAULT_NATIVE_MODALITIES]
    const defaultEffort = text(row.defaultReasoningEffort)
    const defaultServiceTier = text(row.defaultServiceTier)
    return [{ id: text(row.model || row.id), name: text(row.displayName) || text(row.model || row.id),
      description: text(row.description), efforts,
      ...(efforts.some(e => e.id === defaultEffort) ? { defaultEffort } : {}), serviceTiers,
      ...(defaultServiceTier === '' ? {} : { defaultServiceTier }), inputModalities }]
  })
}
/**
 * A missing approval bridge never grants additional execution or filesystem access.
 * @param method - the app-server request method.
 * @param _params - request parameters, deliberately unread.
 * @returns the declining response for a known request, or a rejection for an unknown one.
 */
export function declineCodexRequest(method: string, _params: Obj): Promise<unknown> {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return Promise.resolve({ decision: 'decline' })
  if (method === 'item/permissions/requestApproval') return Promise.resolve({ permissions: {}, scope: 'turn' })
  if (method === 'item/tool/requestUserInput') return Promise.resolve({ answers: {} })
  return Promise.reject(new Error('This Codex backend does not support that server request.'))
}
/** One projected history message: text for the transcript, references for native image inputs. */
export interface CodexHistoryEntry {
  role: string
  text: string
  images: ImageAttachmentRef[]
}
/**
 * Text-and-image history seed, visibly separated from the current user message.
 * Every image also leaves a placeholder in the text, so a quoted transcript
 * still records where the attachment sat; offloaded occurrences are text only.
 * @param messages - assembled Harness request messages including system roles.
 * @returns one entry per non-system message in order.
 */
export function projectCodexHistory(messages: RequestMessage[]): CodexHistoryEntry[] {
  return messages.filter(message => message.role !== 'system').map((message) => {
    const images: ImageAttachmentRef[] = []
    const parts = message.content.map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'reasoning') return ''
      if (block.type === 'tool-call') return JSON.stringify({ tool: block.name, arguments: block.arguments })
      if (block.type === 'tool-addition' || block.type === 'tool-removal') return ''
      if (block.type === 'image') {
        if (block.offloaded === true) return offloadedImageText(block.attachment)
        images.push(block.attachment)
        return '[image attachment]'
      }
      throw new Error('The optional Codex backend currently accepts text and image content only. Use another route for other attachments.')
    })
    return { role: message.role, text: parts.filter(Boolean).join('\n'), images }
  })
}
/** JSON-RPC surface one live Codex app-server child exposes to the runtime. */
export interface CodexPeer {
  request(method: string, params: object): Promise<unknown>
  notify(method: string): void
  subscribe(handler: (method: string, params: Obj) => void): () => void
  close(): void
}
/** Project-local Codex display state: the cached catalog and the stored tier choices. */
export interface CodexPreferences {
  enabled: boolean
  models: CodexBackendModelView[]
  tiers: Record<string, string>
  /**
   * Whether a connected account may publish this route without an explicit
   * enable. Absent means allowed; the first explicit enable or disable from a
   * user surface records their own choice and stops the automatic one.
   */
  auto?: boolean
}
interface RuntimeOptions {
  connect: (handleRequest: (method: string, params: Obj) => Promise<unknown>) => Promise<CodexPeer>
  resolveAccess: (options: GenerateOptions) => CodexTurnAccess
  /** Actual registered root for this initiating request; absence disables reusable facts. */
  resolveObservationProjectRoot?: (options: GenerateOptions) => string | undefined
  preferences: CodexPreferences
  persist: (preferences: CodexPreferences) => Promise<void>
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Configured process/profile identity; observation is disabled when absent. */
  connectionId?: string
  /** Maximum distinct retained native tool identities per turn. */
  nativeEvidenceMaxItems?: number
  /** Receives sanitized current-turn item facts without tool authority. */
  observeNativeItem?: (options: GenerateOptions, item: SkillLearningNativeItem) => void
}
interface ThreadCursor { id: string; marker: string; input: string; instructions: string; access: string }
/** Lazy process and account lifecycle; merely mounting Models never starts Codex. */
export class CodexBackendRuntime {
  private peer: CodexPeer | undefined
  private opening: Promise<CodexPeer> | undefined
  private label: string | undefined
  private connected = false
  private loginId: string | undefined
  private error: string | undefined
  private running = 0
  private disposed = false
  private signingIn = false
  private readonly cursors = new Map<string, ThreadCursor>()
  private activeRequest: { threadId: string; turnId: string | undefined; access: CodexTurnAccess; items: Map<string, Obj> } | undefined
  constructor(private readonly options: RuntimeOptions) {
    if (options.nativeEvidenceMaxItems !== undefined
      && (!Number.isSafeInteger(options.nativeEvidenceMaxItems) || options.nativeEvidenceMaxItems < 1)) throw new Error('Invalid native evidence item bound.')
  }
  /**
   * Read display state without touching the native process.
   * @returns enablement, connection, running count, optional label/error, and stored tiers.
   */
  view(): CodexBackendView { return {
    enabled: this.options.preferences.enabled, connected: this.connected,
    busy: this.loginId !== undefined || this.signingIn, running: this.running,
    ...(this.label === undefined ? {} : { label: this.label }),
    ...(this.error === undefined ? {} : { error: this.error }), tiers: { ...this.options.preferences.tiers } } }
  /**
   * Read the cached native catalog.
   * @returns a detached copy of the stored model views.
   */
  models(): CodexBackendModelView[] { return structuredClone(this.options.preferences.models) }
  /**
   * Capture only the exact already connected peer's supported history reads.
   * No native subprocess is started, and reconnect invalidates this capability.
   * @returns a read-only connected-peer capability, or unavailable.
   */
  codingSessionReader(): CodexCodingSessionReader | undefined {
    const peer = this.peer
    if (peer === undefined || !this.skillLibraryPeerCurrent(peer)) return undefined
    return { connected: () => this.skillLibraryPeerCurrent(peer), request: async (method, params) => {
      if (!this.skillLibraryPeerCurrent(peer)) throw new Error('Native Codex coding session connection changed.')
      const value = await peer.request(method, params)
      if (!this.skillLibraryPeerCurrent(peer)) throw new Error('Native Codex coding session connection changed.')
      return value
    } }
  }

  /**
   * Observe native skills through an existing connected peer; discovery never launches Codex.
   * @param projects - registered project directories; an empty list scans nothing.
   * @param forceReload - whether the native server bypasses its skill metadata cache.
   * @returns metadata and connection support, with implicit usage left unknown.
   */
  async listSkills(projects: readonly SkillLibraryProject[], forceReload = false): Promise<NativeSkillLibraryObservation> {
    const peer = this.peer
    const disconnected: NativeSkillLibraryObservation = { entries: [], status: {
      provider: 'codex-backend', state: 'disconnected', message: 'Native skill inventory requires an already connected Codex backend. Usage is unknown.',
    } }
    if (this.disposed || peer === undefined || !this.connected) return disconnected
    if (projects.length === 0) return { entries: [], status: { provider: 'codex-backend', state: 'connected' } }
    try {
      if (projects.some(project => !isAbsolute(project.path))) throw new Error('Native skill discovery requires absolute project paths.')
      const cwds = [...new Set(projects.map(project => normalize(project.path)))]
      const result = await peer.request('skills/list', { cwds, forceReload })
      if (!this.skillLibraryPeerCurrent(peer)) return disconnected
      return parseCodexSkills(result, projects)
    } catch (error) {
      if (!this.skillLibraryPeerCurrent(peer)) return disconnected
      const unsupported = obj(error).code === -32601
      return { entries: [], status: { provider: 'codex-backend', state: unsupported ? 'unsupported' : 'unavailable',
        message: unsupported ? 'This Codex runtime does not expose skill inventory. Usage is unknown.' : 'Native skill inventory is unavailable. Usage is unknown.' } }
    }
  }
  private skillLibraryPeerCurrent(peer: CodexPeer): boolean {
    return peer === this.peer && this.connected && !this.disposed
  }

  private async ensure(): Promise<CodexPeer> {
    if (this.disposed) throw new Error('Codex backend is closed.')
    if (this.peer !== undefined) return this.peer
    this.opening ??= (async () => {
      const peer = await this.options.connect((method, params) => {
        const active = this.activeRequest
        if (active === undefined || params.threadId !== active.threadId
          || (active.turnId !== undefined && params.turnId !== active.turnId)) return declineCodexRequest(method, params)
        return active.access.request(method, { ...params,
          ...(active.items.has(text(params.itemId)) ? { item: active.items.get(text(params.itemId)) } : {}) })
      })
      try {
        await peer.request('initialize', { clientInfo: { name: 'deepseek-harness-local', title: 'Y Harness', version: '0.2.1-alpha.1' }, capabilities: { experimentalApi: false } })
        if (this.disposed) { peer.close(); throw new Error('Codex backend is closed.') }
        peer.notify('initialized')
        peer.subscribe((method, params) => {
          if (method === '__closed') { this.peer = undefined; this.connected = false; this.label = undefined; this.loginId = undefined; this.cursors.clear() }
          if (method === 'account/login/completed' && params.loginId === this.loginId) {
            this.loginId = undefined
            if (params.success !== true) this.error = 'Codex sign-in did not complete. Try again.'
            else void this.refresh().catch(() => { this.error = 'Sign-in completed; refresh the Codex backend to read its status.' })
          }
        })
        this.peer = peer
        return peer
      } catch { peer.close(); throw new Error('The local Codex backend could not start.') }
    })().finally(() => { this.opening = undefined })
    return this.opening
  }
  private async readAccount(peer: CodexPeer): Promise<void> {
    const account = obj(obj(await peer.request('account/read', { refreshToken: false })).account)
    this.connected = account.type === 'chatgpt'
    this.label = this.connected ? [text(account.email), text(account.planType)].filter(Boolean).join(' · ') || 'ChatGPT account' : undefined
  }
  /**
   * Read the native account and replace the cached model catalog.
   * @returns the resulting view.
   */
  async refresh(): Promise<CodexBackendView> {
    const peer = await this.ensure()
    await this.readAccount(peer)
    const models: CodexBackendModelView[] = []; let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const result = obj(await peer.request('model/list', { limit: 100, includeHidden: false, ...(cursor === undefined ? {} : { cursor }) }))
      models.push(...parseCodexModels(result)); cursor = text(result.nextCursor) || undefined
      if (cursor === undefined) break
      if (page === 19) throw new Error('Codex model catalog exceeded the supported page limit.')
    }
    this.options.preferences.models = [...new Map(models.map(model => [model.id, model])).values()]
    await this.options.persist(this.options.preferences)
    this.error = undefined
    return this.view()
  }
  /**
   * Start native device login only after explicit local-file consent.
   * @param consent - whether the user consented to storing native credentials locally.
   * @returns the device verification URL and user code.
   */
  async login(consent: boolean): Promise<{ verificationUrl: string; userCode: string }> {
    if (!consent) throw new Error('Give local credential storage consent before Codex sign-in.')
    if (this.signingIn || this.loginId !== undefined || this.running > 0) throw new Error('Finish the active Codex operation first.')
    this.signingIn = true
    try {
      const peer = await this.ensure()
      const result = obj(await peer.request('account/login/start', { type: 'chatgptDeviceCode' }))
      const url = text(result.verificationUrl)
      if (result.type !== 'chatgptDeviceCode' || !text(result.loginId) || !text(result.userCode) || !url.startsWith('https://auth.openai.com/')) throw new Error('Codex returned an invalid sign-in response.')
      this.loginId = text(result.loginId); this.error = undefined
      return { verificationUrl: url, userCode: text(result.userCode) }
    } finally { this.signingIn = false }
  }
  /**
   * Cancel this native device login.
   * @returns fulfillment after the pending login is cleared.
   */
  async cancel(): Promise<void> {
    if (this.loginId === undefined) return
    const loginId = this.loginId
    try { await this.peer?.request('account/login/cancel', { loginId }) }
    catch { this.peer?.close(); throw new Error('Codex sign-in cancellation failed; the backend was closed.') }
    finally { if (this.loginId === loginId) this.loginId = undefined }
  }
  /**
   * Publish this route once its account is connected, unless the user has
   * already decided for themselves. The stored sign-in is only observable after
   * a native read, so this is what keeps a connected subscription usable
   * without a second, non-obvious confirmation step.
   * @returns the resulting view; unchanged when the account or catalog is not ready.
   */
  async publish(): Promise<CodexBackendView> {
    if (this.options.preferences.auto === false || this.options.preferences.enabled) return this.view()
    if (!this.connected || this.options.preferences.models.length === 0) return this.view()
    this.options.preferences.enabled = true
    await this.options.persist(this.options.preferences)
    return this.view()
  }
  /**
   * Enable this route or store one catalog-advertised processing tier.
   * @param enabled - whether the route accepts turns.
   * @param modelId - model whose tier changes; omit to change enablement only.
   * @param tier - catalog tier id, or `default` for standard speed.
   * @returns the resulting view.
   */
  async configure(enabled: boolean, modelId?: string, tier?: string): Promise<CodexBackendView> {
    if (this.running > 0) throw new Error('Finish the active Codex turn before changing this backend.')
    if (enabled && !this.connected) throw new Error('Sign in and refresh this Codex profile before enabling it.')
    if (modelId !== undefined && tier !== undefined) {
      const model = this.options.preferences.models.find(candidate => candidate.id === modelId)
      if (model === undefined || (tier !== 'default' && !model.serviceTiers.some(choice => choice.id === tier))) throw new Error('That processing tier is not in the Codex catalog.')
      this.options.preferences.tiers[modelId] = tier
    }
    this.options.preferences.enabled = enabled
    // An explicit choice, either way, is the user's; stop publishing on their behalf.
    this.options.preferences.auto = false
    await this.options.persist(this.options.preferences)
    return this.view()
  }
  /**
   * Logout this separate Codex profile and withdraw its selectable models.
   * @returns the resulting view.
   */
  async logout(): Promise<CodexBackendView> {
    if (this.running > 0) throw new Error('Finish the active Codex turn before disconnecting.')
    await this.cancel()
    const peer = await this.ensure()
    await peer.request('account/logout', {})
    this.connected = false; this.label = undefined; this.options.preferences.enabled = false; this.cursors.clear()
    this.options.preferences.auto = false
    await this.options.persist(this.options.preferences)
    return this.view()
  }
  /** Terminate the native child and drop every cached cursor. */
  close(): void { this.disposed = true; this.peer?.close(); this.peer = undefined; this.connected = false; this.cursors.clear() }
  /**
   * Run one native turn for the assembled request.
   * @param options - provider, model, effort, tier, messages, and cancellation.
   * @returns the streamed text, usage, and terminal finish chunks.
   */
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (this.running > 0 || this.signingIn || this.loginId !== undefined) throw new Error('Finish the active Codex operation first.')
    const lifetime = new AbortController()
    const signal = options.signal === undefined ? lifetime.signal : AbortSignal.any([options.signal, lifetime.signal])
    this.running++
    try { yield* this.streamTurn({ ...options, signal }) } finally { lifetime.abort(); this.running-- }
  }
  private async *streamTurn(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (!this.options.preferences.enabled) throw new Error('Enable the optional Codex backend in Models first.')
    const model = this.options.preferences.models.find(candidate => candidate.id === options.model)
    if (model === undefined) throw new Error('Refresh the native Codex catalog before selecting this model.')
    const effort = options.reasoningEffort ?? model.defaultEffort
    if (effort !== undefined && !model.efforts.some(choice => choice.id === effort)) throw new Error('That reasoning effort is not in the native Codex catalog.')
    const tier = options.serviceTier ?? this.options.preferences.tiers[model.id] ?? 'default'
    if (tier !== 'default' && !model.serviceTiers.some(choice => choice.id === tier)) throw new Error('That processing tier is not in the native Codex catalog.')
    options.signal?.throwIfAborted()
    const access = this.options.resolveAccess(options)
    const observationProjectRoot = this.options.resolveObservationProjectRoot?.(options)
    const accessKey = JSON.stringify([access.cwd, access.sandbox, access.approvalPolicy, access.sandboxPolicy])
    const history = projectCodexHistory(options.messages)
    const instructions = [options.system, ...options.messages.filter(message => message.role === 'system').flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])),
      'Use your native Codex tools. Harness tool descriptions in prior context do not grant access.'].filter(Boolean).join('\n\n')
    const peer = await this.ensure(); await this.readAccount(peer)
    if (!this.connected) throw new Error('Sign in to the separate Codex profile before sending a turn.')
    const key = options.purpose === undefined && options.sessionId !== undefined ? `${options.sessionId}/${options.model}` : randomUUID()
    let cursor = this.cursors.get(key)
    const markerIndex = cursor === undefined ? -1 : options.messages.findLastIndex(message => message.role === 'assistant' && text(obj(obj(message.source.replayState).response).codexMarker) === cursor?.marker)
    const prefix = markerIndex < 0 ? '' : JSON.stringify(projectCodexHistory(options.messages.slice(0, markerIndex)))
    const continuing = cursor !== undefined && prefix === cursor.input
      && cursor.instructions === instructions && cursor.access === accessKey
    if (!continuing) {
      const result = obj(await peer.request('thread/start', { model: options.model, cwd: access.cwd, sandbox: access.sandbox,
        approvalPolicy: access.approvalPolicy, approvalsReviewer: 'user', ephemeral: false, developerInstructions: instructions,
        config: { sandbox_workspace_write: { writable_roots: access.writableRoots, network_access: true,
          exclude_tmpdir_env_var: true, exclude_slash_tmp: true } } }))
      const id = text(obj(result.thread).id)
      if (!id) throw new Error('Codex returned an invalid thread.')
      cursor = { id, marker: randomUUID(), input: '', instructions, access: accessKey }
    }
    if (cursor === undefined) throw new Error('Codex thread was not created.')
    const activeCursor = cursor
    const activeRequest = { threadId: activeCursor.id, access, turnId: undefined as string | undefined, items: new Map<string, Obj>() }
    const suffix = continuing ? projectCodexHistory(options.messages.slice(markerIndex + 1)) : history
    const transcript = suffix.map(({ role, text: entryText }) => ({ role, text: entryText }))
    const prompt = suffix.length === 1 && suffix[0]?.role === 'user' ? suffix[0].text : `Conversation context from Harness (quoted transcript; retain each role):\n${JSON.stringify(transcript)}`
    // Only the turn's own user message carries native image inputs; images in a
    // quoted transcript stay text placeholders, because the transcript is one text input.
    const latest = suffix.at(-1)
    const imageInputs = latest === undefined || latest.role !== 'user'
      ? []
      : await Promise.all(latest.images.map(reference => this.imageInput(reference)))
    const queue: Array<{ method: string; params: Obj }> = []
    let wake: (() => void) | undefined
    const unsubscribe = peer.subscribe((method, params) => {
      if (method !== '__closed' && params.threadId !== activeCursor.id) return
      if (method === 'item/started' && (activeRequest.turnId === undefined || params.turnId === activeRequest.turnId)) {
        const item = obj(params.item)
        if (item.type === 'fileChange') activeRequest.items.set(text(item.id), item)
      }
      if (method === 'item/completed') activeRequest.items.delete(text(obj(params.item).id))
      if (queue.length >= 4096) { queue.length = 0; queue.push({ method: '__overflow', params: {} }); peer.close() }
      else queue.push({ method, params })
      wake?.()
    })
    let turnId: string | undefined; let terminal = false
    const onAbort = (): void => {
      if (turnId !== undefined) void peer.request('turn/interrupt', { threadId: activeCursor.id, turnId }).catch(() => {})
      wake?.()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const blocks = new Map<string, { index: number; text: string; ended: boolean }>()
    const nativeItems = new Map<string, SkillLearningNativeItem>()
    const settledItems = new Set<string>()
    let evidenceInvalidated = false
    let usage: TokenUsage | undefined
    try {
      this.activeRequest = activeRequest
      const result = obj(await peer.request('turn/start', { threadId: activeCursor.id, model: options.model, effort, serviceTier: tier === 'priority' ? 'fast' : tier,
        cwd: access.cwd, input: [{ type: 'text', text: prompt, text_elements: [] }, ...imageInputs],
        approvalPolicy: access.approvalPolicy, approvalsReviewer: 'user', sandboxPolicy: access.sandboxPolicy }))
      turnId = text(obj(result.turn).id)
      activeRequest.turnId = turnId
      if (!turnId) throw new Error('Codex returned an invalid turn.')
      options.signal?.throwIfAborted()
      while (!terminal) {
        if (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; if (options.signal?.aborted) resolve() })
        wake = undefined
        options.signal?.throwIfAborted()
        const event = queue.shift(); if (event === undefined) continue
        if (event.method === '__overflow') throw new Error('Codex stream exceeded the pending-event limit.')
        if (event.method === '__closed') throw new Error('Codex stopped before the turn completed.')
        const params = event.params
        if (params.turnId !== undefined && params.turnId !== turnId) continue
        if ((event.method === 'item/started' || event.method === 'item/completed') && params.turnId === turnId
          && options.purpose === undefined && this.options.connectionId !== undefined && !evidenceInvalidated) {
          const phase = event.method === 'item/started' ? 'started' : 'settled'
          const item = codexNativeItem(
            this.options.connectionId, activeCursor.id, turnId, phase, params.item,
            observationProjectRoot, this.options.nativeEvidenceMaxItems ?? 64,
          )
          if (item !== undefined && !settledItems.has(item.itemId)) {
            const start = nativeItems.get(item.itemId)
            if (phase === 'started' && start === undefined) {
              if (nativeItems.size >= (this.options.nativeEvidenceMaxItems ?? 64)) {
                evidenceInvalidated = true; nativeItems.clear(); settledItems.clear()
                try { this.options.observeNativeItem?.(options, { ...item, phase: 'invalidated' }) }
                catch (error) { void error /* Observation failure grants no source-write authority. */ }
                continue
              }
              nativeItems.set(item.itemId, item)
            } else if (phase === 'settled' && start !== undefined) {
              if (start.kind !== item.kind || start.name !== item.name || start.skillReadPath !== item.skillReadPath
                || JSON.stringify(start.procedure) !== JSON.stringify(item.procedure)) {
                evidenceInvalidated = true; nativeItems.clear(); settledItems.clear()
                try { this.options.observeNativeItem?.(options, { ...item, phase: 'invalidated' }) }
                catch (error) { void error /* Mismatching settlement grants no learning authority. */ }
                continue
              }
              settledItems.add(item.itemId)
            } else continue
            try { this.options.observeNativeItem?.(options, item) }
            catch (error) { void error /* Evidence observers cannot change native result or permission settlement. */ }
          }
        }
        if (event.method === 'thread/tokenUsage/updated') {
          const counts = obj(obj(params.tokenUsage).last)
          const input = Number(counts.inputTokens)
          const cached = Number(counts.cachedInputTokens ?? 0)
          const written = Number(counts.cacheWriteInputTokens ?? 0)
          const output = Number(counts.outputTokens)
          if ([input, cached, written, output].every(n => Number.isFinite(n) && n >= 0)) {
            usage = { inputTokens: Math.max(0, input - cached - written), outputTokens: output,
              cacheReadTokens: cached, cacheWriteTokens: written }
          }
        }
        if (event.method === 'item/agentMessage/delta') {
          const id = text(params.itemId); let block = blocks.get(id)
          if (block === undefined) {
            block = { index: blocks.size, text: '', ended: false }
            blocks.set(id, block)
            yield { type: 'block-start', index: block.index, blockType: 'text' }
          }
          const delta = text(params.delta)
          block.text += delta
          yield { type: 'text-delta', index: block.index, text: delta }
        }
        if (event.method === 'item/completed' && obj(params.item).type === 'agentMessage') {
          const item = obj(params.item); const id = text(item.id); let block = blocks.get(id)
          if (block === undefined) { block = { index: blocks.size, text: text(item.text), ended: false }; blocks.set(id, block); yield { type: 'block-start', index: block.index, blockType: 'text' }; yield { type: 'text-delta', index: block.index, text: block.text } }
          if (!block.ended) { block.ended = true; yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } } }
        }
        if (event.method === 'turn/completed') {
          const turn = obj(params.turn); if (turn.id !== turnId) continue
          terminal = true
          for (const block of blocks.values()) if (!block.ended) yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
          if (usage !== undefined) yield { type: 'usage', usage }
          if (turn.status !== 'completed') {
            yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CODEX_TURN_FAILED', message: turn.status === 'interrupted' ? 'Codex turn was interrupted.' : 'Codex turn failed. Refresh the backend or check account access.' } } }
          } else {
            activeCursor.input = JSON.stringify(history); activeCursor.marker = randomUUID(); this.cursors.set(key, activeCursor)
            yield { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { codexMarker: activeCursor.marker } } }
          }
        }
      }
    } finally {
      if (this.activeRequest === activeRequest) this.activeRequest = undefined
      unsubscribe(); options.signal?.removeEventListener('abort', onAbort)
      if (!terminal) { this.cursors.delete(key); onAbort() }
    }
  }
  /**
   * Encode one durable image as a native Codex image input. The inline data URL
   * keeps the turn self-contained: the Codex process runs in a separate profile
   * whose sandbox may not reach the Harness attachment directory.
   * @param reference - durable image reference carried by the request message.
   * @returns the app-server `image` user-input item.
   */
  private async imageInput(reference: ImageAttachmentRef): Promise<Obj> {
    const attachments = this.options.resolveAttachments?.()
    if (attachments === undefined) {
      throw new Error('Codex image input requires the durable attachment service; this deployment mounts none.')
    }
    const stored = await attachments.readImage(reference)
    return { type: 'image', url: `data:${reference.mediaType};base64,${Buffer.from(stored.data).toString('base64')}` }
  }
}
/** Native Codex model routing while Codex, rather than Harness, owns tools. */
export class CodexBackendAdapter extends LlmAdapter {
  constructor(private readonly runtime: CodexBackendRuntime) { super() }
  override providerInfo(provider: string): { id: string; name: string; auxiliaryGeneration: 'native' } { return { id: provider, name: 'Codex (native backend)', auxiliaryGeneration: 'native' } }
  override listModels(provider: string): Promise<LlmModelInfo[]> {
    const models: LlmModelInfo[] = this.runtime.view().enabled
      ? this.runtime.models().map(model => ({
        provider, id: model.id, name: model.name, description: model.description,
        inputModalities: [...model.inputModalities],
      }))
      : []
    return Promise.resolve(models)
  }
  /**
   * Publish one catalog model with its effort, tier, and modality metadata.
   * @param provider - registered `codex-backend` route.
   * @param id - catalog model id.
   * @returns the exact model metadata, or a rejection when the catalog is stale.
   */
  override resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
    const model = this.runtime.models().find(model => model.id === id)
    if (model === undefined) return Promise.reject(new Error('Refresh the Codex backend catalog.'))
    const preferredTier = this.runtime.view().tiers[model.id]
    return Promise.resolve({
      provider, id, name: model.name, inputModalities: [...model.inputModalities],
      reasoning: { efforts: model.efforts.map(e => ({ id: ReasoningEffortId(e.id), name: e.id, description: e.description })),
        ...(model.defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(model.defaultEffort) }) },
      // Standard is always offered so a caller can return to it after choosing
      // a native fast tier; the stored per-model preference is the adapter default,
      // and standard is the default of that default.
      serviceTiers: {
        tiers: [{ id: ServiceTierId(STANDARD_TIER.id), name: STANDARD_TIER.name },
          ...model.serviceTiers.map(tier => ({ id: ServiceTierId(tier.id), name: tier.name,
            ...tier.description === '' ? {} : { description: tier.description } }))],
        defaultTier: ServiceTierId(preferredTier ?? STANDARD_TIER.id),
      },
    })
  }
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> { return this.runtime.stream(options) }
}
