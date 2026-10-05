/** Optional native Codex loop. This route does not dispatch Harness tools. */
import { randomUUID } from 'node:crypto'
import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, RequestMessage, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { CodexBackendModelView, CodexBackendView } from './chatgpt-types.ts'

type Obj = Record<string, unknown>
function obj(value: unknown): Obj { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {} }
function text(value: unknown): string { return typeof value === 'string' ? value : '' }
/** Preserve model-owned native effort/tier vocabulary without synthesizing capabilities. */
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
    const defaultEffort = text(row.defaultReasoningEffort)
    return [{ id: text(row.model || row.id), name: text(row.displayName) || text(row.model || row.id), description: text(row.description), efforts,
      ...(efforts.some(e => e.id === defaultEffort) ? { defaultEffort } : {}), serviceTiers }]
  })
}
/** A missing approval bridge never grants additional execution or filesystem access. */
export async function declineCodexRequest(method: string, _params: Obj): Promise<unknown> {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: 'decline' }
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' }
  if (method === 'item/tool/requestUserInput') return { answers: {} }
  throw new Error('This Codex backend does not support that server request.')
}
/** Text-only history seed, visibly separated from the current user message. */
export function projectCodexHistory(messages: RequestMessage[]): Array<{ role: string; text: string }> {
  return messages.filter(message => message.role !== 'system').map((message) => {
    const parts = message.content.map((block) => {
      if (block.type === 'text') return block.text
      if (block.type === 'reasoning') return ''
      if (block.type === 'tool-call') return JSON.stringify({ tool: block.name, arguments: block.arguments })
      if (block.type === 'tool-addition' || block.type === 'tool-removal') return ''
      throw new Error('The optional Codex backend currently accepts text only. Use another route for attachments.')
    })
    return { role: message.role, text: parts.filter(Boolean).join('\n') }
  })
}
export interface CodexPeer {
  request(method: string, params: object): Promise<unknown>
  notify(method: string): void
  subscribe(handler: (method: string, params: Obj) => void): () => void
  close(): void
}
export interface CodexPreferences { enabled: boolean; models: CodexBackendModelView[]; tiers: Record<string, string> }
interface RuntimeOptions { connect(): Promise<CodexPeer>; cwd: string; preferences: CodexPreferences; persist(preferences: CodexPreferences): Promise<void> }
interface ThreadCursor { id: string; marker: string; input: string; instructions: string }
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
  constructor(private readonly options: RuntimeOptions) {}
  view(): CodexBackendView { return { enabled: this.options.preferences.enabled, connected: this.connected, busy: this.loginId !== undefined || this.signingIn, running: this.running,
    ...(this.label === undefined ? {} : { label: this.label }), ...(this.error === undefined ? {} : { error: this.error }), tiers: { ...this.options.preferences.tiers } } }
  models(): CodexBackendModelView[] { return structuredClone(this.options.preferences.models) }
  private async ensure(): Promise<CodexPeer> {
    if (this.disposed) throw new Error('Codex backend is closed.')
    if (this.peer !== undefined) return this.peer
    this.opening ??= (async () => {
      const peer = await this.options.connect()
      try {
        await peer.request('initialize', { clientInfo: { name: 'deepseek-harness-local', title: 'DeepSeek Harness', version: '0.2.1-alpha.1' }, capabilities: { experimentalApi: false } })
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
  async cancel(): Promise<void> {
    if (this.loginId === undefined) return
    const loginId = this.loginId
    try { await this.peer?.request('account/login/cancel', { loginId }) }
    catch { this.peer?.close(); throw new Error('Codex sign-in cancellation failed; the backend was closed.') }
    finally { if (this.loginId === loginId) this.loginId = undefined }
  }
  async configure(enabled: boolean, modelId?: string, tier?: string): Promise<CodexBackendView> {
    if (this.running > 0) throw new Error('Finish the active Codex turn before changing this backend.')
    if (enabled && !this.connected) throw new Error('Sign in and refresh this Codex profile before enabling it.')
    if (modelId !== undefined && tier !== undefined) {
      const model = this.options.preferences.models.find(candidate => candidate.id === modelId)
      if (model === undefined || (tier !== 'default' && !model.serviceTiers.some(choice => choice.id === tier))) throw new Error('That processing tier is not in the Codex catalog.')
      this.options.preferences.tiers[modelId] = tier
    }
    this.options.preferences.enabled = enabled
    await this.options.persist(this.options.preferences)
    return this.view()
  }
  async logout(): Promise<CodexBackendView> {
    if (this.running > 0) throw new Error('Finish the active Codex turn before disconnecting.')
    await this.cancel()
    const peer = await this.ensure()
    await peer.request('account/logout', {})
    this.connected = false; this.label = undefined; this.options.preferences.enabled = false; this.cursors.clear()
    await this.options.persist(this.options.preferences)
    return this.view()
  }
  close(): void { this.disposed = true; this.peer?.close(); this.peer = undefined; this.connected = false; this.cursors.clear() }
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (this.running > 0 || this.signingIn || this.loginId !== undefined) throw new Error('Finish the active Codex operation first.')
    this.running++
    try { yield* this.streamTurn(options) } finally { this.running-- }
  }
  private async *streamTurn(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    if (!this.options.preferences.enabled) throw new Error('Enable the optional Codex backend in Models first.')
    const model = this.options.preferences.models.find(candidate => candidate.id === options.model)
    if (model === undefined) throw new Error('Refresh the native Codex catalog before selecting this model.')
    const effort = options.reasoningEffort ?? model.defaultEffort
    if (effort !== undefined && !model.efforts.some(choice => choice.id === effort)) throw new Error('That reasoning effort is not in the native Codex catalog.')
    options.signal?.throwIfAborted()
    const history = projectCodexHistory(options.messages)
    const instructions = [options.system, ...options.messages.filter(message => message.role === 'system').flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])),
      'Use your native Codex tools. Harness tool descriptions in prior context do not grant access. This backend has a read-only sandbox; approval requests are declined.'].filter(Boolean).join('\n\n')
    const peer = await this.ensure(); await this.readAccount(peer)
    if (!this.connected) throw new Error('Sign in to the separate Codex profile before sending a turn.')
    const key = options.purpose === undefined && options.sessionId !== undefined ? `${options.sessionId}/${options.model}` : randomUUID()
    let cursor = this.cursors.get(key)
    const markerIndex = cursor === undefined ? -1 : options.messages.findLastIndex(message => message.role === 'assistant' && text(obj(obj(message.source.replayState).response).codexMarker) === cursor?.marker)
    const prefix = markerIndex < 0 ? '' : JSON.stringify(projectCodexHistory(options.messages.slice(0, markerIndex)))
    const continuing = cursor !== undefined && prefix === cursor.input && cursor.instructions === instructions
    if (!continuing) {
      const result = obj(await peer.request('thread/start', { model: options.model, cwd: this.options.cwd, sandbox: 'read-only', approvalPolicy: 'on-request', ephemeral: false, developerInstructions: instructions }))
      const id = text(obj(result.thread).id)
      if (!id) throw new Error('Codex returned an invalid thread.')
      cursor = { id, marker: randomUUID(), input: '', instructions }
    }
    if (cursor === undefined) throw new Error('Codex thread was not created.')
    const activeCursor = cursor
    const suffix = continuing ? projectCodexHistory(options.messages.slice(markerIndex + 1)) : history
    const prompt = suffix.length === 1 && suffix[0]?.role === 'user' ? suffix[0].text : `Conversation context from Harness (quoted transcript; retain each role):\n${JSON.stringify(suffix)}`
    const queue: Array<{ method: string; params: Obj }> = []
    let wake: (() => void) | undefined
    const unsubscribe = peer.subscribe((method, params) => { if (method === '__closed' || params.threadId === activeCursor.id) { queue.push({ method, params }); wake?.() } })
    let turnId: string | undefined; let terminal = false
    const onAbort = (): void => {
      if (turnId !== undefined) void peer.request('turn/interrupt', { threadId: activeCursor.id, turnId }).catch(() => {})
      wake?.()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const blocks = new Map<string, { index: number; text: string; ended: boolean }>()
    let usage: TokenUsage | undefined
    try {
      const result = obj(await peer.request('turn/start', { threadId: activeCursor.id, model: options.model, effort, serviceTier: this.options.preferences.tiers[model.id] === 'priority' ? 'fast' : this.options.preferences.tiers[model.id] ?? 'default',
        input: [{ type: 'text', text: prompt, text_elements: [] }], approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } }))
      turnId = text(obj(result.turn).id)
      if (!turnId) throw new Error('Codex returned an invalid turn.')
      options.signal?.throwIfAborted()
      while (!terminal) {
        if (queue.length === 0) await new Promise<void>(resolve => { wake = resolve; if (options.signal?.aborted) resolve() })
        wake = undefined
        options.signal?.throwIfAborted()
        const event = queue.shift(); if (event === undefined) continue
        if (event.method === '__closed') throw new Error('Codex stopped before the turn completed.')
        const params = event.params
        if (params.turnId !== undefined && params.turnId !== turnId) continue
        if (event.method === 'thread/tokenUsage/updated') {
          const counts = obj(obj(params.tokenUsage).last)
          const input = Number(counts.inputTokens); const cached = Number(counts.cachedInputTokens ?? 0); const written = Number(counts.cacheWriteInputTokens ?? 0); const output = Number(counts.outputTokens)
          if ([input, cached, written, output].every(n => Number.isFinite(n) && n >= 0)) usage = { inputTokens: Math.max(0, input - cached - written), outputTokens: output, cacheReadTokens: cached, cacheWriteTokens: written }
        }
        if (event.method === 'item/agentMessage/delta') {
          const id = text(params.itemId); let block = blocks.get(id)
          if (block === undefined) { block = { index: blocks.size, text: '', ended: false }; blocks.set(id, block); yield { type: 'block-start', index: block.index, blockType: 'text' } }
          const delta = text(params.delta); block.text += delta
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
      unsubscribe(); options.signal?.removeEventListener('abort', onAbort)
      if (!terminal) { this.cursors.delete(key); onAbort() }
    }
  }
}
/** Native Codex model routing while Codex, rather than Harness, owns tools. */
export class CodexBackendAdapter extends LlmAdapter {
  constructor(private readonly runtime: CodexBackendRuntime) { super() }
  override providerInfo(provider: string): { id: string; name: string } { return { id: provider, name: 'Codex (native backend)' } }
  override async listModels(provider: string): Promise<LlmModelInfo[]> { return this.runtime.view().enabled ? this.runtime.models().map(model => ({ provider, id: model.id, name: model.name, description: model.description, inputModalities: ['text'] })) : [] }
  override async resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
    const model = this.runtime.models().find(model => model.id === id)
    if (model === undefined) throw new Error('Refresh the Codex backend catalog.')
    return { provider, id, name: model.name, inputModalities: ['text'], reasoning: { efforts: model.efforts.map(e => ({ id: ReasoningEffortId(e.id), name: e.id, description: e.description })),
      ...(model.defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(model.defaultEffort) }) } }
  }
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> { return this.runtime.stream(options) }
}
