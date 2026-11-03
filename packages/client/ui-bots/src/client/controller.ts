/** Remote-backed Bot roster state and one retained Session per selection. */

import { brandString } from '@yharness/brand'
import type {
  BotAppearanceUpdateRequest,
  BotAppearanceUpdateValue,
  BotAvatar,
  BotAvatarUpdateValue,
  BotConnectedAppAccessRequest,
  BotConnectedAppAccessValue,
  BotConnectedAppsValue,
  BotCreateRequest,
  BotId as BotIdType,
  BotListRequest,
  BotOrganizationUpdateRequest,
  BotOrganizationUpdateValue,
  BotView,
  BotShareInviteRequest,
  BotShareInviteValue,
  BotShareMemoryPolicyRequest,
  BotShareMemoryPolicyValue,
  BotShareMemberRevokeRequest,
  BotShareMemberRevokeValue,
  BotShareMembersRequest,
  BotShareMembersValue,
} from '@yharness/bots/client'
import { BotPrincipalId } from '@yharness/bots/client'
import type {
  AvatarGenerationRequest,
  AvatarGenerationCommitValue,
  AvatarGenerationStatus,
  AvatarGenerationValue,
} from '@yharness/avatar-generation/types'
import type { ISessions, SessionReference } from '@yharness/api-session-controller/client'
import { createSnapshotStore, type SnapshotStore } from '@yharness/client-store'
import type { HostObservable } from '@yharness/client-ui-slots'
import type { RemoteResult } from '@yharness/api-remotes/client'
import { randomUUID } from '@yharness/util-crypto'
import type { BotAccent, BotAvatarEditorActions, BotConnectedAppAccess, BotCreation, BotIdentity, BotOrganizationPatch } from './types.ts'
import type { SharedBotsClient } from './shared-client.ts'

/** Remote methods consumed by the Bot workspace. */
export interface BotWorkspaceRemote {
  list(request: BotListRequest): Promise<RemoteResult<{ readonly bots: readonly BotView[] }>>
  create(request: BotCreateRequest): Promise<RemoteResult<{ readonly bot: BotView }>>
  rename(request: { readonly botId: BotIdType; readonly name: string }): Promise<RemoteResult<{ readonly bot: BotView }>>
  updateOrganization?: (request: BotOrganizationUpdateRequest) => Promise<RemoteResult<BotOrganizationUpdateValue>>
  updateAvatar?: (request: { readonly botId: BotIdType; readonly avatar: BotAvatar | null }) => Promise<RemoteResult<BotAvatarUpdateValue>>
  uploadAvatar?: (request: { readonly botId: BotIdType; readonly data: string; readonly mediaType: 'image/png' }) => Promise<RemoteResult<BotAvatarUpdateValue>>
  updateAppearance?: (request: BotAppearanceUpdateRequest) => Promise<RemoteResult<BotAppearanceUpdateValue>>
  readAvatar?: (request: { readonly botId: BotIdType }) => Promise<RemoteResult<{ readonly avatar: BotAvatar; readonly data: string }>>
  createShareInvite?: (request: BotShareInviteRequest) => Promise<RemoteResult<BotShareInviteValue>>
  listShareMembers?: (request: BotShareMembersRequest) => Promise<RemoteResult<BotShareMembersValue>>
  revokeShareMember?: (request: BotShareMemberRevokeRequest) => Promise<RemoteResult<BotShareMemberRevokeValue>>
  getShareMemoryPolicy?: (request: BotShareMembersRequest) => Promise<RemoteResult<BotShareMemoryPolicyValue>>
  setShareMemoryPolicy?: (request: BotShareMemoryPolicyRequest) => Promise<RemoteResult<BotShareMemoryPolicyValue>>
  listConnectedApps?: (request: { readonly botId: BotIdType }) => Promise<RemoteResult<BotConnectedAppsValue>>
  setConnectedAppAccess?: (request: BotConnectedAppAccessRequest) => Promise<RemoteResult<BotConnectedAppAccessValue>>
}

/** Owner-facing shared-Bot roster and invite actions. */
export interface BotShareActions {
  /** List members of one owned Bot. */
  readonly listMembers: (botId: string) => Promise<BotShareMembersValue>
  /** Issue a one-time invite for one owned Bot. */
  readonly createInvite: (botId: string, role: BotShareInviteRequest['role']) => Promise<BotShareInviteValue>
  /** Remove one non-owner member from one owned Bot. */
  readonly revokeMember: (botId: string, principalId: string) => Promise<BotShareMemberRevokeValue>
  /** Read the explicit shared-context policy for one owned Bot. */
  readonly getMemoryPolicy?: (botId: string) => Promise<BotShareMemoryPolicyValue>
  /** Change the explicit shared-context policy for one owned Bot. */
  readonly setMemoryPolicy?: (botId: string, enabled: boolean) => Promise<BotShareMemoryPolicyValue>
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
  readonly rename: (id: string, name: string) => Promise<void>
  readonly organize?: (id: string, patch: BotOrganizationPatch) => Promise<void>
  readonly loadConnectedApps?: (botId: string) => Promise<readonly BotConnectedAppAccess[]>
  readonly setConnectedAppAccess?: (botId: string, appId: string, allowed: boolean) => Promise<void>
  readonly loadAvatar: (botId: string, avatar: BotAvatar) => Promise<string>
  readonly avatarEditor?: BotAvatarEditorActions
  readonly retry: () => void
  /** Owner controls for sharing the selected Bot, when the Host mounts them. */
  readonly share?: BotShareActions
  /** Collaborator-only enrollment, discovery, and private chat client. */
  readonly sharedClient?: SharedBotsClient
}

declare module '@yharness/api-session-controller/client' {
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
  private selectionGeneration = 0
  private rosterRevision = 0
  private refreshAfterPending = false

  constructor(
    private readonly remote: BotWorkspaceRemote,
    private readonly sessions: ISessions,
    private readonly unexpectedResponse: () => string,
    private readonly avatarGeneration?: BotAvatarGenerationRemote,
    private readonly sharedClient?: SharedBotsClient,
  ) {}

  /** Stop asynchronous reads and release the selected Session. */
  dispose(): void {
    this.disposed = true
    this.selectionGeneration++
    this.refreshAfterPending = false
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
      rename: async (id, name) => {
        const result = await this.remote.rename({ botId: brandString<BotIdType>(id), name })
        if (!result.ok) throw new Error(result.error.message)
        if (this.disposed) return
        const current = this.source.getSnapshot()
        this.source.set({ ...current, bots: current.bots.map(bot =>
          bot.id === id && bot.updatedAt <= result.value.bot.updatedAt ? result.value.bot : bot,
        ) })
      },
      ...(this.remote.updateOrganization === undefined
        ? {}
        : { organize: (id: string, patch: BotOrganizationPatch) => this.organize(id, patch) }),
      ...(this.remote.listConnectedApps === undefined
        ? {}
        : { loadConnectedApps: (id: string) => this.loadConnectedApps(id) }),
      ...(this.remote.setConnectedAppAccess === undefined
        ? {}
        : { setConnectedAppAccess: (id: string, appId: string, allowed: boolean) => this.setConnectedAppAccess(id, appId, allowed) }),
      loadAvatar: (botId, avatar) => this.loadAvatar(botId, avatar),
      ...(
        this.remote.updateAppearance !== undefined
        || this.remote.uploadAvatar !== undefined
        || (this.avatarGeneration !== undefined && this.remote.updateAvatar !== undefined)
          ? { avatarEditor: this.avatarEditor() }
          : {}
      ),
      ...(() => {
        const share = this.shareActions()
        return share === undefined ? {} : { share }
      })(),
      ...(this.sharedClient === undefined ? {} : { sharedClient: this.sharedClient }),
      retry: () => {
        void this.retry().catch((error: unknown) => {
          this.fail(error instanceof Error ? error.message : String(error))
        })
      },
    }
  }

  /** Load or refresh the durable Bot roster. */
  async load(): Promise<void> {
    if (this.disposed) return
    if (this.pending !== undefined) {
      this.refreshAfterPending = true
      return this.pending
    }
    const before = this.source.getSnapshot()
    this.source.set({ ...before, phase: 'loading', error: null })
    const pending = this.read()
    this.pending = pending
    try {
      await pending
    } finally {
      if (this.pending === pending) {
        this.pending = undefined
        if (this.refreshAfterPending && !this.disposed) {
          this.refreshAfterPending = false
          void this.load().catch((error: unknown) => {
            this.fail(error instanceof Error ? error.message : String(error))
          })
        }
      }
    }
  }

  private async read(): Promise<void> {
    const rosterRevision = this.rosterRevision
    let result: RemoteResult<{ readonly bots: readonly BotView[] }>
    try {
      result = await this.remote.list({ includeHidden: true })
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
    if (this.disposed) return
    if (rosterRevision !== this.rosterRevision) {
      this.refreshAfterPending = true
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
    if (selected !== current.selectedBotId) this.selectionGeneration++
    const selectionGeneration = this.selectionGeneration
    const currentBot = current.bots.find(bot => bot.id === selected)
    const nextBot = result.value.bots.find(bot => bot.id === selected)
    const needsReference = selected !== current.selectedBotId
      || this.selectedReference === undefined
      || currentBot?.sessionId !== nextBot?.sessionId
      || currentBot?.state !== nextBot?.state
    let referenceError = needsReference ? this.retainSelected(selected, result.value.bots) : undefined
    if (this.shouldRefreshCatalog(selected, result.value.bots, referenceError)) {
      referenceError = await this.retryRetainAfterCatalogRefresh(
        selected,
        result.value.bots,
        () => !this.disposed && this.selectionGeneration === selectionGeneration,
      )
    }
    if (this.disposed || this.selectionGeneration !== selectionGeneration) return
    if (rosterRevision !== this.rosterRevision) {
      this.refreshAfterPending = true
      return
    }
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
    const selectionGeneration = ++this.selectionGeneration
    const referenceError = this.retainSelected(bot.id, current.bots)
    this.source.set({ ...current, selectedBotId: bot.id, error: referenceError ?? null })
    if (this.shouldRefreshCatalog(bot.id, current.bots, referenceError)) {
      void this.retrySelectionAfterCatalogRefresh(bot.id, selectionGeneration)
    }
  }

  private async retrySelectionAfterCatalogRefresh(id: BotIdType, selectionGeneration: number): Promise<void> {
    try {
      await this.sessions.refresh()
    } catch (error: unknown) {
      if (this.disposed) return
      const current = this.source.getSnapshot()
      if (current.selectedBotId !== id || this.selectionGeneration !== selectionGeneration) return
      this.source.set({ ...current, error: error instanceof Error ? error.message : String(error) })
      return
    }
    if (this.disposed || this.selectionGeneration !== selectionGeneration) return
    const current = this.source.getSnapshot()
    if (current.selectedBotId !== id) return
    const referenceError = this.retainSelected(id, current.bots)
    if (this.disposed || this.selectionGeneration !== selectionGeneration) {
      this.selectedReference?.release()
      this.selectedReference = undefined
      return
    }
    this.source.set({ ...current, error: referenceError ?? null })
  }

  private async retainSelectedWithCatalogRetry(
    id: BotIdType | null,
    bots: readonly BotView[],
    canCommit: () => boolean = () => !this.disposed,
  ): Promise<string | undefined> {
    const referenceError = this.retainSelected(id, bots)
    if (!this.shouldRefreshCatalog(id, bots, referenceError)) return referenceError
    return this.retryRetainAfterCatalogRefresh(id, bots, canCommit)
  }

  private async retryRetainAfterCatalogRefresh(
    id: BotIdType | null,
    bots: readonly BotView[],
    canCommit: () => boolean = () => !this.disposed,
  ): Promise<string | undefined> {
    try {
      await this.sessions.refresh()
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error)
    }
    if (!canCommit()) return undefined
    return this.retainSelected(id, bots)
  }

  private shouldRefreshCatalog(
    id: BotIdType | null,
    bots: readonly BotView[],
    error: string | undefined,
  ): boolean {
    if (error === undefined || id === null) return false
    const bot = bots.find(candidate => candidate.id === id)
    return bot?.state === 'active' && this.sessions.list.getSnapshot().byId[bot.sessionId] === undefined
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
    const updateAppearance = this.remote.updateAppearance
    const uploadAvatar = this.remote.uploadAvatar
    const generationActions: BotAvatarEditorActions = generation === undefined || updateAvatar === undefined
      ? {}
      : {
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
    return {
      ...(uploadAvatar === undefined ? {} : { upload: async (botId: string, preview: AvatarGenerationValue) => {
        const result = await uploadAvatar({ botId: brandString<BotIdType>(botId), ...preview })
        if (!result.ok) throw new Error(result.error.message)
        if (String(result.value.bot.id) !== botId) throw new Error(this.unexpectedResponse())
        if (this.disposed) return
        const current = this.source.getSnapshot()
        this.source.set({ ...current, bots: current.bots.map(bot =>
          bot.id === botId && bot.updatedAt <= result.value.bot.updatedAt ? result.value.bot : bot,
        ) })
      } }),
      ...generationActions,
      ...(updateAppearance === undefined ? {} : {
        updateAppearance: async (botId: string, appearance: {
          readonly identity: BotIdentity
          readonly accent: BotAccent
          readonly clearAvatar: boolean
        }) => {
          const result = await updateAppearance({ botId: brandString<BotIdType>(botId), ...appearance })
          if (!result.ok) throw new Error(result.error.message)
          if (String(result.value.bot.id) !== botId) throw new Error(this.unexpectedResponse())
          const current = this.source.getSnapshot()
          const bots = current.bots.some(bot => bot.id === botId)
            ? current.bots.map(bot => bot.id === botId ? result.value.bot : bot)
            : [...current.bots, result.value.bot]
          this.source.set({ ...current, bots, error: null })
        },
      }),
    }
  }

  private async organize(id: string, patch: BotOrganizationPatch): Promise<void> {
    const updateOrganization = this.remote.updateOrganization
    if (updateOrganization === undefined) return
    let result: RemoteResult<BotOrganizationUpdateValue>
    try {
      result = await updateOrganization({ botId: brandString<BotIdType>(id), ...patch })
    } catch (error: unknown) {
      if (this.disposed) return
      const message = error instanceof Error ? error.message : String(error)
      this.fail(message)
      throw new Error(message)
    }
    if (this.disposed) return
    if (!result.ok) {
      this.fail(result.error.message)
      throw new Error(result.error.message)
    }
    if (String(result.value.bot.id) !== id) {
      const message = this.unexpectedResponse()
      this.fail(message)
      throw new Error(message)
    }
    this.rosterRevision++
    const current = this.source.getSnapshot()
    const bots = current.bots.some(bot => bot.id === id)
      ? current.bots.map(bot => bot.id === id ? result.value.bot : bot)
      : [...current.bots, result.value.bot]
    this.source.set({ ...current, bots, error: null })
  }

  private shareActions(): BotShareActions | undefined {
    const listMembers = this.remote.listShareMembers
    const createInvite = this.remote.createShareInvite
    const revokeMember = this.remote.revokeShareMember
    const getMemoryPolicy = this.remote.getShareMemoryPolicy
    const setMemoryPolicy = this.remote.setShareMemoryPolicy
    if (listMembers === undefined || createInvite === undefined || revokeMember === undefined) return undefined
    return {
      listMembers: async (botId) => {
        const result = await listMembers({ botId: brandString<BotIdType>(botId) })
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      createInvite: async (botId, role) => {
        const result = await createInvite({ botId: brandString<BotIdType>(botId), role })
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      revokeMember: async (botId, principalId) => {
        const result = await revokeMember({
          botId: brandString<BotIdType>(botId),
          principalId: BotPrincipalId(principalId),
        })
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
      ...(getMemoryPolicy === undefined ? {} : {
        getMemoryPolicy: async (botId: string) => {
          const result = await getMemoryPolicy({ botId: brandString<BotIdType>(botId) })
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
      }),
      ...(setMemoryPolicy === undefined ? {} : {
        setMemoryPolicy: async (botId: string, enabled: boolean) => {
          const result = await setMemoryPolicy({ botId: brandString<BotIdType>(botId), enabled })
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
      }),
    }
  }

  private async loadConnectedApps(id: string): Promise<readonly BotConnectedAppAccess[]> {
    const listConnectedApps = this.remote.listConnectedApps
    if (listConnectedApps === undefined) return []
    const result = await listConnectedApps({ botId: brandString<BotIdType>(id) })
    if (!result.ok) throw new Error(result.error.message)
    if (String(result.value.bot.id) !== id) throw new Error(this.unexpectedResponse())
    return result.value.apps
  }

  private async setConnectedAppAccess(id: string, appId: string, allowed: boolean): Promise<void> {
    const setConnectedAppAccess = this.remote.setConnectedAppAccess
    if (setConnectedAppAccess === undefined) return
    const result = await setConnectedAppAccess({ botId: brandString<BotIdType>(id), appId, allowed })
    if (!result.ok) throw new Error(result.error.message)
    if (String(result.value.bot.id) !== id) throw new Error(this.unexpectedResponse())
    if (this.disposed) return
    const current = this.source.getSnapshot()
    this.source.set({
      ...current,
      bots: current.bots.map(bot => bot.id === id && bot.updatedAt <= result.value.bot.updatedAt ? result.value.bot : bot),
      error: null,
    })
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
    const selectionGeneration = ++this.selectionGeneration
    const referenceError = await this.retainSelectedWithCatalogRetry(
      result.value.bot.id,
      bots,
      () => !this.disposed && this.selectionGeneration === selectionGeneration,
    )
    if (this.disposed || this.selectionGeneration !== selectionGeneration) return
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
