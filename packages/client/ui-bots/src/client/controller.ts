/** Remote-backed Bot roster state and one retained Session per selection. */

import { brandString } from '@yharness/brand'
import type {
  BotAppearanceUpdateRequest,
  BotAppearanceUpdateValue,
  BotAvatar,
  BotAvatarUpdateValue,
  BotCreateRequest,
  BotId as BotIdType,
  BotGroupCreateRequest,
  BotGroupCreateValue,
  BotGroupId as BotGroupIdType,
  BotGroupInspectRequest,
  BotGroupInspectValue,
  BotGroupListRequest,
  BotGroupListValue,
  BotGroupMessageId as BotGroupMessageIdType,
  BotGroupMessageView,
  BotGroupSendRemoteRequest,
  BotGroupSendValue,
  BotGroupView,
  BotListRequest,
  BotView,
} from '@yharness/bots/client'
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
import type {
  BotAccent, BotAvatarEditorActions, BotCreation, BotGroupCreation, BotGroupDetailData,
  BotGroupSummary, BotIdentity,
} from './types.ts'

/** Remote methods consumed by the Bot workspace. */
export interface BotWorkspaceRemote {
  list(request: BotListRequest): Promise<RemoteResult<{ readonly bots: readonly BotView[] }>>
  create(request: BotCreateRequest): Promise<RemoteResult<{ readonly bot: BotView }>>
  listGroups?: (request: BotGroupListRequest) => Promise<RemoteResult<BotGroupListValue>>
  createGroup?: (request: BotGroupCreateRequest) => Promise<RemoteResult<BotGroupCreateValue>>
  inspectGroup?: (request: BotGroupInspectRequest) => Promise<RemoteResult<BotGroupInspectValue>>
  sendGroupMessage?: (request: BotGroupSendRemoteRequest) => Promise<RemoteResult<BotGroupSendValue>>
  updateAvatar?: (request: { readonly botId: BotIdType; readonly avatar: BotAvatar | null }) => Promise<RemoteResult<BotAvatarUpdateValue>>
  updateAppearance?: (request: BotAppearanceUpdateRequest) => Promise<RemoteResult<BotAppearanceUpdateValue>>
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
  readonly groups: readonly BotGroupSummary[]
  readonly selectedGroupId: string | null
  readonly selectedGroup: BotGroupDetailData | null
  readonly groupPhase: 'idle' | 'loading' | 'ready' | 'error'
  readonly groupError: string | null
  readonly error: string | null
}

/** IDs retained while a group mutation may have committed without returning. */
export interface BotGroupPendingState {
  /** Group creation keys and their stable Remote ids. */
  readonly creations: Readonly<Record<string, string>>
  /** Group send keys with the text and stable Remote message ids. */
  readonly messages: Readonly<Record<string, { readonly text: string; readonly messageId: string }>>
}

/** Durable browser-backed store used to recover an uncertain group operation. */
export interface BotGroupPendingStore {
  /** Whether a write can survive controller recreation. */
  readonly durable: boolean
  /** Read the last persisted operation ids. */
  readonly read: () => BotGroupPendingState
  /** Persist operation ids before or after a Remote call. */
  readonly write: (state: BotGroupPendingState) => boolean
}

/** Registration face supplied to the pure Bot panel. */
export interface BotWorkspaceFace {
  readonly hooks: { readonly workspace: HostObservable<BotWorkspaceState> }
  readonly reference: () => SessionReference | undefined
  readonly select: (id: string) => void
  readonly selectGroup: (id: string) => void
  readonly create: (creation: BotCreation) => Promise<void>
  readonly createGroup: (creation: BotGroupCreation) => Promise<void>
  readonly sendGroupMessage: (text: string, messageId?: string) => Promise<void>
  readonly retryGroup: () => void
  readonly loadAvatar: (botId: string, avatar: BotAvatar) => Promise<string>
  readonly avatarEditor?: BotAvatarEditorActions
  readonly retry: () => void
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
  groups: [],
  selectedGroupId: null,
  selectedGroup: null,
  groupPhase: 'idle',
  groupError: null,
  error: null,
}

const EMPTY_PENDING_GROUP_STATE: BotGroupPendingState = { creations: {}, messages: {} }
const PENDING_GROUP_STORAGE_KEY = 'yharness.client-ui-bots.pending-group-operations'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function restorePendingGroupState(value: unknown): BotGroupPendingState {
  const creations: Record<string, string> = {}
  const messages: Record<string, { readonly text: string; readonly messageId: string }> = {}
  if (!isRecord(value) || !isRecord(value.creations) || !isRecord(value.messages)) {
    throw new Error('invalid pending Bot group state')
  }
  for (const [key, id] of Object.entries(value.creations)) {
    if (key.length === 0 || key.length > 4096 || typeof id !== 'string' || id.length === 0) {
      throw new Error('invalid pending Bot group creation')
    }
    creations[key] = id
  }
  for (const [key, pending] of Object.entries(value.messages)) {
    if (key.length === 0 || key.length > 4096 || !isRecord(pending)
      || typeof pending.text !== 'string' || pending.text.length === 0
      || typeof pending.messageId !== 'string' || pending.messageId.length === 0) {
      throw new Error('invalid pending Bot group message')
    }
    messages[key] = { text: pending.text, messageId: pending.messageId }
  }
  return { creations, messages }
}

function createPendingGroupStore(): BotGroupPendingStore {
  if (typeof localStorage === 'undefined') {
    return { durable: false, read: () => EMPTY_PENDING_GROUP_STATE, write: () => false }
  }
  let healthy = true
  try {
    localStorage.getItem(PENDING_GROUP_STORAGE_KEY)
  } catch {
    healthy = false
  }
  return {
    get durable() { return healthy },
    read: () => {
      if (!healthy) return EMPTY_PENDING_GROUP_STATE
      try {
        const raw = localStorage.getItem(PENDING_GROUP_STORAGE_KEY)
        if (raw === null) return EMPTY_PENDING_GROUP_STATE
        const parsed: unknown = JSON.parse(raw)
        return restorePendingGroupState(parsed)
      } catch {
        healthy = false
        return EMPTY_PENDING_GROUP_STATE
      }
    },
    write: (state) => {
      if (!healthy) return false
      try {
        localStorage.setItem(PENDING_GROUP_STORAGE_KEY, JSON.stringify(state))
        return true
      } catch {
        healthy = false
        return false
      }
    },
  }
}

/** Owns the remote roster query and the selected Bot's single Session reference. */
export class BotWorkspaceController {
  /** Observable roster state consumed by the Bot panel. */
  readonly source: SnapshotStore<BotWorkspaceState> = createSnapshotStore(INITIAL_STATE)
  private selectedReference: SessionReference | undefined
  private pending: Promise<void> | undefined
  private reloadRequested = false
  private pendingCreation: BotCreateRequest | undefined
  private creating: Promise<void> | undefined
  private readonly avatarLoads = new Map<string, Promise<string>>()
  private readonly pendingGroupMessages = new Map<string, { readonly text: string; readonly messageId: BotGroupMessageIdType }>()
  private readonly pendingGroupCreations = new Map<string, BotGroupIdType>()
  private readonly pendingGroupStore: BotGroupPendingStore
  private disposed = false
  private selectionGeneration = 0

  constructor(
    private readonly remote: BotWorkspaceRemote,
    private readonly sessions: ISessions,
    private readonly unexpectedResponse: () => string,
    private readonly avatarGeneration?: BotAvatarGenerationRemote,
    private readonly groupDeliveryFailure: () => string = unexpectedResponse,
    pendingGroupStore?: BotGroupPendingStore,
  ) {
    this.pendingGroupStore = pendingGroupStore ?? createPendingGroupStore()
    const restored = this.pendingGroupStore.read()
    for (const [key, id] of Object.entries(restored.creations)) {
      this.pendingGroupCreations.set(key, brandString<BotGroupIdType>(id))
    }
    for (const [key, pending] of Object.entries(restored.messages)) {
      this.pendingGroupMessages.set(key, { text: pending.text, messageId: brandString<BotGroupMessageIdType>(pending.messageId) })
    }
  }

  /** Stop asynchronous reads and release the selected Session. */
  dispose(): void {
    this.disposed = true
    this.reloadRequested = false
    this.selectionGeneration++
    this.selectedReference?.release()
    this.selectedReference = undefined
    this.avatarLoads.clear()
  }

  private persistPendingGroupOperations(): boolean {
    return this.pendingGroupStore.write({
      creations: Object.fromEntries(this.pendingGroupCreations),
      messages: Object.fromEntries([...this.pendingGroupMessages.entries()].map(([key, pending]) => [key, {
        text: pending.text, messageId: String(pending.messageId),
      }])),
    })
  }

  private requirePendingDurability(): void {
    if (!this.pendingGroupStore.durable) {
      throw new Error('Cannot safely start or retry a Bot group operation because retry persistence is unavailable.')
    }
  }

  private async reconcileGroupCreation(
    id: BotGroupIdType,
    name: string,
    botIds: readonly string[],
  ): Promise<BotGroupView | undefined> {
    const listGroups = this.remote.listGroups
    if (listGroups === undefined) throw new Error('Cannot safely retry Bot group creation because the group catalog is unavailable.')
    const result = await listGroups({})
    if (!result.ok) throw new Error(`Could not verify existing Bot groups before creating: ${result.error.message}`)
    const existing = result.value.groups.find(group => group.id === id)
    if (existing === undefined) return undefined
    if (existing.name !== name || existing.botIds.length !== botIds.length
      || !existing.botIds.every((botId, index) => String(botId) === botIds[index])) {
      throw new Error(`Cannot safely retry Bot group creation because ${String(id)} has different metadata.`)
    }
    return existing
  }

  private async reconcileGroupMessage(
    groupId: string,
    messageId: BotGroupMessageIdType,
    text: string,
  ): Promise<BotGroupMessageView | undefined> {
    const inspectGroup = this.remote.inspectGroup
    if (inspectGroup === undefined) throw new Error('Cannot safely retry Bot group messaging because the group transcript is unavailable.')
    const result = await inspectGroup({ groupId: brandString<BotGroupIdType>(groupId) })
    if (!result.ok) throw new Error(`Could not verify existing Bot messages before sending: ${result.error.message}`)
    const existing = result.value.messages.find(message => message.id === messageId)
    if (existing === undefined) return undefined
    if (existing.groupId !== brandString<BotGroupIdType>(groupId) || existing.text !== text || existing.sender.kind !== 'user') {
      throw new Error(`Cannot safely retry Bot message ${String(messageId)} because its content differs.`)
    }
    return existing
  }

  /** Build the narrow data-and-callback face consumed by the panel.
   * @returns The panel-facing roster state and callbacks.
   */
  face(): BotWorkspaceFace {
    return {
      hooks: { workspace: this.source },
      reference: () => this.selectedReference,
      select: (id) => { this.select(id) },
      selectGroup: (id) => { this.selectGroup(id) },
      create: creation => this.create(creation),
      createGroup: creation => this.createGroup(creation),
      sendGroupMessage: (text, messageId) => this.sendGroupMessage(text, messageId),
      retryGroup: () => {
        void this.retryGroup().catch((error: unknown) => {
          this.setGroupError(error instanceof Error ? error.message : String(error))
        })
      },
      loadAvatar: (botId, avatar) => this.loadAvatar(botId, avatar),
      ...(
        this.remote.updateAppearance !== undefined
        || (this.avatarGeneration !== undefined && this.remote.updateAvatar !== undefined)
          ? { avatarEditor: this.avatarEditor() }
          : {}
      ),
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
      this.reloadRequested = true
      return this.pending
    }
    const before = this.source.getSnapshot()
    this.source.set({ ...before, phase: 'loading', error: null })
    const pending = this.read()
    this.pending = pending
    try {
      await pending
    } finally {
      if (this.pending === pending) this.pending = undefined
      if (this.reloadRequested && !this.disposed) {
        this.reloadRequested = false
        void this.load()
      }
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
    const groupsResult = await this.readGroups()
    if (this.disposed) return
    const current = this.source.getSnapshot()
    const groups = groupsResult.groups
    const selectedGroupId = current.selectedGroupId !== null && groups.some(group => group.id === current.selectedGroupId)
      ? current.selectedGroupId
      : null
    if (selectedGroupId !== current.selectedGroupId) this.selectionGeneration++
    if (selectedGroupId !== null) {
      this.selectedReference?.release()
      this.selectedReference = undefined
      const selectionGeneration = this.selectionGeneration
      this.source.set({
        ...current,
        phase: 'ready',
        bots: result.value.bots,
        groups,
        selectedBotId: null,
        selectedGroupId,
        selectedGroup: current.selectedGroupId === selectedGroupId ? current.selectedGroup : null,
        groupPhase: current.selectedGroupId === selectedGroupId && current.selectedGroup !== null ? 'ready' : 'loading',
        groupError: groupsResult.error,
        error: null,
      })
      if (this.remote.inspectGroup !== undefined) await this.refreshGroup(selectedGroupId, selectionGeneration)
      return
    }
    try {
      await this.sessions.refresh()
    } catch (error: unknown) {
      this.fail(error instanceof Error ? error.message : String(error))
      return
    }
    if (this.disposed) return
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
    this.source.set({
      phase: 'ready',
      bots: result.value.bots,
      groups,
      selectedBotId: selected,
      selectedGroupId: null,
      selectedGroup: null,
      groupPhase: 'idle',
      groupError: groupsResult.error,
      error: referenceError ?? null,
    })
  }

  private async readGroups(): Promise<{ readonly groups: readonly BotGroupSummary[]; readonly error: string | null }> {
    const listGroups = this.remote.listGroups
    const current = this.source.getSnapshot()
    if (listGroups === undefined) return { groups: current.groups, error: null }
    try {
      const result = await listGroups({})
      if (!result.ok) return { groups: current.groups, error: result.error.message }
      return { groups: result.value.groups.map(groupSummary), error: null }
    } catch (error: unknown) {
      return { groups: current.groups, error: error instanceof Error ? error.message : String(error) }
    }
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
    if (bot === undefined || (bot.id === current.selectedBotId && current.selectedGroupId === null)) return
    const selectionGeneration = ++this.selectionGeneration
    const referenceError = this.retainSelected(bot.id, current.bots)
    this.source.set({
      ...current,
      selectedBotId: bot.id,
      selectedGroupId: null,
      selectedGroup: null,
      groupPhase: 'idle',
      groupError: null,
      error: referenceError ?? null,
    })
    if (this.shouldRefreshCatalog(bot.id, current.bots, referenceError)) {
      void this.retrySelectionAfterCatalogRefresh(bot.id, selectionGeneration)
    }
  }

  private selectGroup(id: string): void {
    if (this.disposed) return
    const current = this.source.getSnapshot()
    if (!current.groups.some(group => group.id === id) || current.selectedGroupId === id) return
    const selectionGeneration = ++this.selectionGeneration
    this.selectedReference?.release()
    this.selectedReference = undefined
    this.source.set({
      ...current,
      selectedBotId: null,
      selectedGroupId: id,
      selectedGroup: null,
      groupPhase: 'loading',
      groupError: null,
      error: null,
    })
    void this.refreshGroup(id, selectionGeneration)
  }

  private async refreshGroup(id: string, selectionGeneration: number): Promise<void> {
    const inspectGroup = this.remote.inspectGroup
    if (inspectGroup === undefined) {
      this.setGroupError(this.unexpectedResponse(), id, selectionGeneration)
      return
    }
    let result: RemoteResult<BotGroupInspectValue>
    try {
      result = await inspectGroup({ groupId: brandString<BotGroupIdType>(id) })
    } catch (error: unknown) {
      this.setGroupError(error instanceof Error ? error.message : String(error), id, selectionGeneration)
      return
    }
    if (this.disposed || this.selectionGeneration !== selectionGeneration) return
    const current = this.source.getSnapshot()
    if (current.selectedGroupId !== id) return
    if (!result.ok) {
      this.setGroupError(result.error.message, id, selectionGeneration)
      return
    }
    const selectedGroup = groupDetail(result.value)
    const groups = current.groups.some(group => group.id === selectedGroup.id)
      ? current.groups.map(group => group.id === selectedGroup.id ? selectedGroup : group)
      : [...current.groups, selectedGroup]
    this.source.set({
      ...current,
      groups,
      selectedGroup,
      groupPhase: 'ready',
      groupError: null,
    })
  }

  private setGroupError(message: string, id?: string, selectionGeneration?: number): void {
    if (this.disposed) return
    const current = this.source.getSnapshot()
    if (id !== undefined && (current.selectedGroupId !== id || selectionGeneration !== this.selectionGeneration)) return
    this.source.set({ ...current, groupPhase: 'error', groupError: message })
  }

  private async createGroup(creation: BotGroupCreation): Promise<void> {
    if (this.disposed) return
    const createGroup = this.remote.createGroup
    if (createGroup === undefined) {
      const message = this.unexpectedResponse()
      this.setGroupError(message)
      throw new Error(message)
    }
    const name = creation.name.trim()
    const botIds = creation.botIds.map(id => id.trim())
    const pendingKey = `${name}\u0000${botIds.join('\u0000')}`
    const explicitId = creation.groupId?.trim()
    const pendingId = explicitId === undefined ? this.pendingGroupCreations.get(pendingKey) : undefined
    let id: BotGroupIdType
    let recoveredGroup: BotGroupView | undefined
    if (explicitId !== undefined && explicitId !== '') {
      id = brandString<BotGroupIdType>(explicitId)
    } else if (pendingId !== undefined) {
      try {
        this.requirePendingDurability()
        recoveredGroup = await this.reconcileGroupCreation(pendingId, name, botIds)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        this.setGroupError(message)
        throw new Error(message)
      }
      id = pendingId
    } else {
      try {
        this.requirePendingDurability()
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        this.setGroupError(message)
        throw new Error(message)
      }
      id = brandString<BotGroupIdType>(`bot-group-${randomUUID()}`)
    }
    const request: BotGroupCreateRequest = {
      id,
      name,
      botIds: botIds.map(id => brandString<BotIdType>(id)),
    }
    const retainsPending = explicitId === undefined || explicitId === ''
    if (retainsPending && pendingId === undefined) {
      this.pendingGroupCreations.set(pendingKey, id)
      if (!this.persistPendingGroupOperations()) {
        this.pendingGroupCreations.delete(pendingKey)
        const message = 'Cannot safely start Bot group creation because retry persistence is unavailable.'
        this.setGroupError(message)
        throw new Error(message)
      }
    }
    let result: RemoteResult<BotGroupCreateValue>
    try {
      result = recoveredGroup === undefined
        ? await createGroup(request)
        : { ok: true, value: { group: recoveredGroup } }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.setGroupError(message)
      throw new Error(message)
    }
    if (!result.ok) {
      this.setGroupError(result.error.message)
      throw new Error(result.error.message)
    }
    if (retainsPending && this.pendingGroupCreations.get(pendingKey) === id) {
      this.pendingGroupCreations.delete(pendingKey)
      if (!this.persistPendingGroupOperations()) {
        this.pendingGroupCreations.set(pendingKey, id)
        const message = 'Bot group creation succeeded, but retry state could not be cleared safely.'
        this.setGroupError(message)
        throw new Error(message)
      }
    }
    if (this.disposed) return
    const created = groupSummary(result.value.group)
    const current = this.source.getSnapshot()
    const groups = current.groups.some(group => group.id === created.id)
      ? current.groups.map(group => group.id === created.id ? created : group)
      : [...current.groups, created]
    const selectionGeneration = ++this.selectionGeneration
    this.selectedReference?.release()
    this.selectedReference = undefined
    this.source.set({
      ...current,
      phase: 'ready',
      bots: current.bots,
      groups,
      selectedBotId: null,
      selectedGroupId: created.id,
      selectedGroup: null,
      groupPhase: 'loading',
      groupError: null,
      error: null,
    })
    await this.refreshGroup(created.id, selectionGeneration)
  }

  private async sendGroupMessage(text: string, explicitMessageId?: string): Promise<void> {
    const sendGroupMessage = this.remote.sendGroupMessage
    const current = this.source.getSnapshot()
    if (current.selectedGroupId === null || sendGroupMessage === undefined) {
      const message = this.unexpectedResponse()
      this.setGroupError(message)
      throw new Error(message)
    }
    const normalizedText = text.trim()
    const pendingKey = `${current.selectedGroupId}\u0000${normalizedText}`
    const normalizedExplicitId = explicitMessageId?.trim()
    const pending = normalizedExplicitId === undefined ? this.pendingGroupMessages.get(pendingKey) : undefined
    let messageId: BotGroupMessageIdType
    if (normalizedExplicitId !== undefined && normalizedExplicitId !== '') {
      messageId = brandString<BotGroupMessageIdType>(normalizedExplicitId)
    } else if (pending !== undefined) {
      try {
        this.requirePendingDurability()
        await this.reconcileGroupMessage(current.selectedGroupId, pending.messageId, normalizedText)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        this.setGroupError(message)
        throw new Error(message)
      }
      messageId = pending.messageId
    } else {
      try {
        this.requirePendingDurability()
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        this.setGroupError(message)
        throw new Error(message)
      }
      messageId = brandString<BotGroupMessageIdType>(`bot-group-message-${randomUUID()}`)
    }
    const retainsPending = normalizedExplicitId === undefined || normalizedExplicitId === ''
    if (retainsPending && pending === undefined) {
      this.pendingGroupMessages.set(pendingKey, { text: normalizedText, messageId })
      if (!this.persistPendingGroupOperations()) {
        this.pendingGroupMessages.delete(pendingKey)
        const message = 'Cannot safely start Bot group messaging because retry persistence is unavailable.'
        this.setGroupError(message)
        throw new Error(message)
      }
    }
    let result: RemoteResult<BotGroupSendValue>
    try {
      result = await sendGroupMessage({ groupId: brandString<BotGroupIdType>(current.selectedGroupId), text: normalizedText, messageId })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.setGroupError(message)
      throw new Error(message)
    }
    if (!result.ok) {
      this.setGroupError(result.error.message)
      throw new Error(result.error.message)
    }
    if (result.value.status === 'partial') {
      const message = this.groupDeliveryFailure()
      this.setGroupError(message)
      throw new Error(message)
    }
    if (retainsPending && this.pendingGroupMessages.get(pendingKey)?.messageId === messageId) {
      this.pendingGroupMessages.delete(pendingKey)
      if (!this.persistPendingGroupOperations()) {
        this.pendingGroupMessages.set(pendingKey, { text: normalizedText, messageId })
        const message = 'Bot message delivery succeeded, but retry state could not be cleared safely.'
        this.setGroupError(message)
        throw new Error(message)
      }
    }
    if (this.disposed) return
    await this.refreshGroup(current.selectedGroupId, this.selectionGeneration)
  }

  private retryGroup(): Promise<void> {
    const current = this.source.getSnapshot()
    if (current.selectedGroupId === null) return this.load()
    return this.refreshGroup(current.selectedGroupId, this.selectionGeneration)
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
    this.source.set({
      phase: 'ready',
      bots,
      groups: current.groups,
      selectedBotId: result.value.bot.id,
      selectedGroupId: null,
      selectedGroup: null,
      groupPhase: 'idle',
      groupError: null,
      error: referenceError ?? null,
    })
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

function groupSummary(group: BotGroupView): BotGroupSummary {
  return {
    id: String(group.id),
    name: group.name,
    bots: group.bots.map(member => ({
      id: String(member.id),
      name: member.name,
      ...(member.description === undefined ? {} : { description: member.description }),
      identity: member.identity,
      accent: member.accent,
      ...(member.avatar === undefined ? {} : { avatar: member.avatar }),
      status: member.state === 'provisioning'
        ? 'preparing'
        : member.availability === 'running' ? 'working' : member.availability,
    })),
  }
}

function groupDetail(value: BotGroupInspectValue): BotGroupDetailData {
  const summary = groupSummary(value.group)
  return {
    ...summary,
    messages: value.messages.map(message => ({
      id: String(message.id),
      sender: message.sender.kind === 'bot'
        ? { kind: 'bot' as const, botId: String(message.sender.botId), name: message.sender.name }
        : { kind: 'user' as const },
      text: message.text,
      createdAt: message.createdAt,
    })),
  }
}
