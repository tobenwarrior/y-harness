/** Remote-backed Bot roster state and one retained Session per selection. */

import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  BotAvatar,
  BotAvatarUpdateValue,
  BotCreateRequest,
  BotId as BotIdType,
  BotListRequest,
  BotView,
} from '@deepseek-ai/dsh-bots/client'
import type {
  AvatarGenerationRequest,
  AvatarGenerationCommitValue,
  AvatarGenerationStatus,
  AvatarGenerationValue,
} from '@deepseek-ai/dsh-avatar-generation/types'
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { BotAvatarEditorActions, BotCreation } from './types.ts'

/** Remote methods consumed by the Bot workspace. */
export interface BotWorkspaceRemote {
  list(request: BotListRequest): Promise<RemoteResult<{ readonly bots: readonly BotView[] }>>
  create(request: BotCreateRequest): Promise<RemoteResult<{ readonly bot: BotView }>>
  updateAvatar?: (request: { readonly botId: BotIdType; readonly avatar: BotAvatar | null }) => Promise<RemoteResult<BotAvatarUpdateValue>>
  readAvatar?: (request: { readonly botId: BotIdType }) => Promise<RemoteResult<{ readonly avatar: BotAvatar; readonly data: string }>>
}

/** Avatar generation namespace mounted by the API remotes assembly. */
export interface BotAvatarGenerationRemote {
  status(): Promise<RemoteResult<AvatarGenerationStatus>>
  generate(request: AvatarGenerationRequest, signal?: AbortSignal): Promise<RemoteResult<AvatarGenerationValue>>
  commit(preview: AvatarGenerationValue): Promise<RemoteResult<AvatarGenerationCommitValue>>
}

/** Observable data published to the Bot panel. */
export interface BotWorkspaceState {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly bots: readonly BotView[]
  readonly selectedBotId: BotIdType | null
  readonly error: string | null
}

/** Registration face supplied to the pure Bot panel. */
export interface BotWorkspaceFace {
  readonly hooks: { readonly workspace: HostObservable<BotWorkspaceState> }
  readonly reference: () => SessionReference | undefined
  readonly select: (id: string) => void
  readonly create: (creation: BotCreation) => Promise<void>
  readonly loadAvatar: (botId: string, avatar: BotAvatar) => Promise<string>
  readonly avatarEditor?: BotAvatarEditorActions
  readonly retry: () => void
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** One retained reference owned by the Bot workspace selection. */
    botWorkspace: unknown
  }
}

const INITIAL_STATE: BotWorkspaceState = {
  phase: 'idle',
  bots: [],
  selectedBotId: null,
  error: null,
}

/** Owns the remote roster query and the selected Bot's single Session reference. */
export class BotWorkspaceController {
  /** Observable roster state consumed by the Bot panel. */
  readonly source: SnapshotStore<BotWorkspaceState> = createSnapshotStore(INITIAL_STATE)
  private selectedReference: SessionReference | undefined
  private pending: Promise<void> | undefined
  private pendingCreation: BotCreateRequest | undefined
  private creating: Promise<void> | undefined
  private readonly avatarLoads = new Map<string, Promise<string>>()
  private disposed = false

  constructor(
    private readonly remote: BotWorkspaceRemote,
    private readonly sessions: ISessions,
    private readonly unexpectedResponse: () => string,
    private readonly avatarGeneration?: BotAvatarGenerationRemote,
  ) {}

  /** Stop asynchronous reads and release the selected Session. */
  dispose(): void {
    this.disposed = true
    this.selectedReference?.release()
    this.selectedReference = undefined
    this.avatarLoads.clear()
  }

  /** Build the narrow data-and-callback face consumed by the panel.
   * @returns The panel-facing roster state and callbacks.
   */
  face(): BotWorkspaceFace {
    return {
      hooks: { workspace: this.source },
      reference: () => this.selectedReference,
      select: (id) => { this.select(id) },
      create: creation => this.create(creation),
      loadAvatar: (botId, avatar) => this.loadAvatar(botId, avatar),
      ...(this.avatarGeneration === undefined || this.remote.updateAvatar === undefined
        ? {}
        : { avatarEditor: this.avatarEditor() }),
      retry: () => {
        void this.retry().catch((error: unknown) => {
          this.fail(error instanceof Error ? error.message : String(error))
        })
      },
    }
  }

  /** Load or refresh the durable Bot roster. */
  async load(): Promise<void> {
    if (this.disposed || this.pending !== undefined) return this.pending ?? Promise.resolve()
    const before = this.source.getSnapshot()
    this.source.set({ ...before, phase: 'loading', error: null })
    const pending = this.read()
    this.pending = pending
    try {
      await pending
    } finally {
      if (this.pending === pending) this.pending = undefined
    }
  }

  private async read(): Promise<void> {
    let result: RemoteResult<{ readonly bots: readonly BotView[] }>
    try {
      result = await this.remote.list({})
    } catch (error: unknown) {
      this.fail(error instanceof Error ? error.message : String(error))
      return
    }
    if (this.disposed) return
    if (!result.ok) {
      this.fail(result.error.message)
      return
    }
    try {
      await this.sessions.refresh()
    } catch (error: unknown) {
      this.fail(error instanceof Error ? error.message : String(error))
      return
    }
    const current = this.source.getSnapshot()
    const pendingBot = this.pendingCreation === undefined
      ? undefined
      : result.value.bots.find(bot => bot.id === this.pendingCreation?.id)
    if (pendingBot?.state === 'active') this.pendingCreation = undefined
    if (this.pendingCreation === undefined) {
      const provisioning = result.value.bots.find(bot => bot.state === 'provisioning')
      if (provisioning !== undefined) this.pendingCreation = requestFromBot(provisioning)
    }
    const selected = current.selectedBotId !== null && result.value.bots.some(bot => bot.id === current.selectedBotId)
      ? current.selectedBotId
      : result.value.bots[0]?.id ?? null
    const currentBot = current.bots.find(bot => bot.id === selected)
    const nextBot = result.value.bots.find(bot => bot.id === selected)
    const needsReference = selected !== current.selectedBotId
      || this.selectedReference === undefined
      || currentBot?.sessionId !== nextBot?.sessionId
      || currentBot?.state !== nextBot?.state
    const referenceError = needsReference ? this.retainSelected(selected, result.value.bots) : undefined
    this.source.set({
      phase: 'ready',
      bots: result.value.bots,
      selectedBotId: selected,
      error: referenceError ?? null,
    })
  }

  private fail(message: string): void {
    if (this.disposed) return
    const current = this.source.getSnapshot()
    this.source.set({ ...current, phase: 'error', error: message })
  }

  private select(id: string): void {
    if (this.disposed) return
    const current = this.source.getSnapshot()
    const bot = current.bots.find(candidate => candidate.id === id)
    if (bot === undefined || bot.id === current.selectedBotId) return
    const referenceError = this.retainSelected(bot.id, current.bots)
    this.source.set({ ...current, selectedBotId: bot.id, error: referenceError ?? null })
  }

  private retainSelected(id: BotIdType | null, bots: readonly BotView[]): string | undefined {
    this.selectedReference?.release()
    this.selectedReference = undefined
    if (id === null) return undefined
    const bot = bots.find(candidate => candidate.id === id)
    if (bot === undefined || bot.state !== 'active') return undefined
    try {
      const reference = this.sessions.retain(bot.sessionId, { source: 'botWorkspace' })
      this.selectedReference = reference
      void reference.ready.catch((error: unknown) => {
        if (this.selectedReference !== reference || this.disposed) return
        this.selectedReference = undefined
        reference.release()
        this.fail(error instanceof Error ? error.message : String(error))
      })
      return undefined
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  private retry(): Promise<void> {
    return this.pendingCreation === undefined ? this.load() : this.retryPendingCreate()
  }

  private loadAvatar(botId: string, avatar: BotAvatar): Promise<string> {
    const key = `${botId}:${String(avatar.attachmentId)}`
    const cached = this.avatarLoads.get(key)
    if (cached !== undefined) return cached
    const readAvatar = this.remote.readAvatar
    const pending = readAvatar === undefined
      ? Promise.reject(new Error())
      : readAvatar({ botId: brandString<BotIdType>(botId) }).then((result) => {
        if (!result.ok) throw new Error(result.error.message)
        if (String(result.value.avatar.attachmentId) !== String(avatar.attachmentId)) {
          throw new Error()
        }
        return `data:${result.value.avatar.mediaType};base64,${result.value.data}`
      })
    this.avatarLoads.set(key, pending)
    void pending.catch(() => {
      if (this.avatarLoads.get(key) === pending) this.avatarLoads.delete(key)
    })
    return pending
  }

  private avatarEditor(): BotAvatarEditorActions {
    const generation = this.avatarGeneration
    const updateAvatar = this.remote.updateAvatar
    if (generation === undefined || updateAvatar === undefined) {
      throw new Error()
    }
    return {
      status: async () => {
        const result = await generation.status()
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      generate: async (request, signal) => {
        const result = await generation.generate(request, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      commit: async (preview) => {
        const result = await generation.commit(preview)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      update: async (botId, avatar) => {
        const result = await updateAvatar({ botId: brandString<BotIdType>(botId), avatar })
        if (!result.ok) throw new Error(result.error.message)
        if (String(result.value.bot.id) !== botId) {
          throw new Error(this.unexpectedResponse())
        }
        const current = this.source.getSnapshot()
        const bots = current.bots.some(bot => bot.id === botId)
          ? current.bots.map(bot => bot.id === botId ? result.value.bot : bot)
          : [...current.bots, result.value.bot]
        this.source.set({ ...current, bots, error: null })
      },
    }
  }

  private create(creation: BotCreation): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.pendingCreation !== undefined) return this.retryPendingCreate()
    this.pendingCreation = {
      id: brandString<BotIdType>(`bot-${randomUUID()}`),
      name: creation.name,
      identity: creation.identity,
      accent: creation.accent,
    }
    return this.retryPendingCreate()
  }

  private retryPendingCreate(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const current = this.creating
    if (current !== undefined) return current
    const request = this.pendingCreation
    if (request === undefined) return this.load()
    const pending = this.performCreate(request)
    this.creating = pending
    const clear = () => {
      if (this.creating === pending) this.creating = undefined
    }
    void pending.then(clear, clear)
    return pending
  }

  private async performCreate(request: BotCreateRequest): Promise<void> {
    let result: RemoteResult<{ readonly bot: BotView }>
    try {
      result = await this.remote.create(request)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (await this.reconcileCreate(request)) return
      this.fail(message)
      throw new Error(message)
    }
    if (this.disposed) return
    if (!result.ok) {
      if (await this.reconcileCreate(request)) return
      this.fail(result.error.message)
      throw new Error(result.error.message)
    }
    if (result.value.bot.id !== request.id) {
      const message = this.unexpectedResponse()
      this.fail(message)
      throw new Error(message)
    }
    const current = this.source.getSnapshot()
    const bots = current.bots.some(bot => bot.id === result.value.bot.id)
      ? current.bots.map(bot => bot.id === result.value.bot.id ? result.value.bot : bot)
      : [...current.bots, result.value.bot]
    const referenceError = this.retainSelected(result.value.bot.id, bots)
    this.pendingCreation = result.value.bot.state === 'active' ? undefined : request
    this.source.set({ phase: 'ready', bots, selectedBotId: result.value.bot.id, error: referenceError ?? null })
  }

  private async reconcileCreate(request: BotCreateRequest): Promise<boolean> {
    await this.load()
    const committed = this.source.getSnapshot().bots.find(bot => bot.id === request.id)
    if (committed?.state !== 'active') return false
    this.pendingCreation = undefined
    return true
  }
}

function requestFromBot(bot: BotView): BotCreateRequest {
  return {
    id: bot.id,
    name: bot.name,
    ...(bot.description === undefined ? {} : { description: bot.description }),
    identity: bot.identity,
    accent: bot.accent,
    cwd: bot.cwd,
    ...(bot.agentPreset === undefined ? {} : { agentPreset: bot.agentPreset }),
  }
}
