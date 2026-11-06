/** Browser client for the isolated shared-Bot enrollment and chat route. */

import { brandString } from '@yharness/brand'
import type {
  BotAccent,
  BotIdentity,
  BotId as BotIdType,
  BotPrincipalId as BotPrincipalIdType,
  BotShareMemoryId as BotShareMemoryIdType,
  BotShareProfile,
  BotShareRosterEntry,
  BotShareMemoryEntry,
  BotShareMemoryValue,
  BotShareMemoryWriteValue,
  BotShareTranscriptEntry,
  BotGroupCreateRequest,
  BotGroupCreateValue,
  BotGroupDeliveryStatusView,
  BotGroupDeliveryView,
  BotGroupInspectValue,
  BotGroupListValue,
  BotGroupSendRemoteRequest,
  BotGroupSendValue,
  BotGroupUpdateRequest,
  BotGroupUpdateValue,
  BotGroupView,
  BotGroupMessageView,
  BotGroupMessageSenderView,
  BotGroupSettingsMember,
  BotGroupSettingsValue,
  BotInputAttachmentView,
  BotGroupMemberView,
  BotGroupId as BotGroupIdType,
  BotGroupMessageId as BotGroupMessageIdType,
} from '@yharness/bots/client'
import type { ClientConnectionRpc, ConnectionRpcFailure } from '@yharness/client-connection/client'
import { randomUUID } from '@yharness/util-crypto'
import {
  admitBotGroupAttachments,
  BotAttachmentClientError,
  isBotGroupImageType,
  parseBotAttachmentGrantValue,
  type BotAttachmentFetch,
} from './attachment-client.ts'
import type { BotGroupAttachmentDraft } from './types.ts'

type BotImageMediaType = Extract<BotInputAttachmentView, { readonly type: 'image' }>['mediaType']

const SHARED_BOTS_PATH = '/shared-bots' as const
const SHARED_AUTH_CHANNEL = 'yharness.client-ui-bots.shared-auth' as const
const SHARED_AUTH_MESSAGE = 'auth-invalidated' as const

const BOT_IDENTITIES = [
  'agent',
  'sparkle',
  'goal',
  'browse',
  'skill',
  'workspace',
  'round',
  'cloud',
  'tile',
  'clover',
  'heart',
  'drop',
  'oval',
  'triangle',
] as const satisfies readonly BotIdentity[]

const BOT_ACCENTS = ['blue', 'teal', 'amber', 'violet', 'rose', 'lime'] as const satisfies readonly BotAccent[]

/** Safe result returned by a shared-Bot client operation. */
export type SharedBotClientResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ConnectionRpcFailure }

/** Auth change delivered to shared-Bot UI subscribers. */
export interface SharedBotAuthChange {
  /** Whether the change originated in this tab or another tab. */
  readonly source: 'local' | 'remote'
  /** Whether the current cookie was invalidated or authenticated. */
  readonly reason: 'invalidated' | 'authenticated'
}

/** Receives local or cross-tab shared-Bot authentication transitions. */
export type SharedBotAuthListener = (change?: SharedBotAuthChange) => void

interface SharedAuthChannel {
  readonly addEventListener: (type: 'message', listener: (event: { readonly data: unknown }) => void) => void
  readonly removeEventListener: (type: 'message', listener: (event: { readonly data: unknown }) => void) => void
  readonly postMessage: (value: unknown) => void
  readonly close: () => void
}

type SharedAuthChannelConstructor = new (name: string) => SharedAuthChannel

function openSharedAuthChannel(listener: (event: { readonly data: unknown }) => void): SharedAuthChannel | undefined {
  const globals = globalThis as { readonly BroadcastChannel?: SharedAuthChannelConstructor }
  if (globals.BroadcastChannel === undefined) return undefined
  const channel = new globals.BroadcastChannel(SHARED_AUTH_CHANNEL)
  channel.addEventListener('message', listener)
  return channel
}

/**
 * Notify other browser tabs that the shared HttpOnly cookie or ACL may have changed.
 * @param senderId - Optional client identity used to ignore this tab's own broadcast.
 */
export function broadcastSharedAuthChanged(senderId?: string): void {
  const channel = openSharedAuthChannel(() => {})
  if (channel === undefined) return
  try {
    channel.postMessage({ type: SHARED_AUTH_MESSAGE, ...(senderId === undefined ? {} : { senderId }) })
  } finally {
    setTimeout(() => { channel.close() }, 0)
  }
}

/** Shared Bot enrollment response after the HttpOnly cookie is stored. */
export interface SharedBotEnrollmentValue {
  /** Newly minted collaborator principal. */
  readonly principalId: string
  /** Absolute cookie expiry. */
  readonly expiresAt: number
  /** Shared group admitted by a group-only invitation, when applicable. */
  readonly groupId?: string
}

/** Server-advertised owner-bootstrap capability for the active connection. */
export interface SharedBotOwnerCapability {
  /** Whether this connection can authenticate the local operator for owner setup. */
  readonly ownerBootstrap: boolean
}

/** Lifecycle inputs used to invalidate connection-scoped capability probes. */
export interface SharedBotsClientOptions {
  /** Subscribe to active Connection generation establishment, replacement, and loss. */
  readonly subscribeConnectionGeneration?: (listener: () => void) => () => void
  /** Transport used to upload shared files. */
  readonly attachmentFetcher?: BotAttachmentFetch
}
/** Private transcript response for one Bot and the current collaborator. */
export interface SharedBotPrivateChatValue {
  /** Bot whose private conversation was read. */
  readonly botId: string
  /** Backing private Session id after the first chat. */
  readonly sessionId?: string
  /** Bounded visible transcript entries. */
  readonly recent: readonly BotShareTranscriptEntry[]
}

/** Explicit shared context returned for one shared Bot. */
export type SharedBotMemoryValue = BotShareMemoryValue

/** Shared-context write response after explicit publication consent. */
export type SharedBotMemoryWriteValue = BotShareMemoryWriteValue

/** Chat response after the Host accepts one message. */
export interface SharedBotChatValue {
  /** Current Bot profile. */
  readonly bot: BotShareProfile
  /** Private Session backing this collaborator's conversation. */
  readonly sessionId: string
  /** True once the message has passed the durability barrier. */
  readonly accepted: true
}

/** Invite response for a collaborator who can manage membership. */
export interface SharedBotInviteValue {
  /** One-time invite code. */
  readonly code: string
  /** Absolute invite expiry. */
  readonly expiresAt: number
  /** Role granted when redeemed. */
  readonly role: 'owner' | 'manager' | 'collaborator'
}

/** Revoke response for one Bot-scoped membership deletion. */
export interface SharedBotRevokeValue {
  /** True after the membership and private binding are removed. */
  readonly revoked: true
  /** Removed principal. */
  readonly principalId: string
}

/** Group catalog visible to the authenticated collaborator. */
export type SharedBotGroupListValue = BotGroupListValue
/** Group transcript visible to the authenticated collaborator. */
export type SharedBotGroupInspectValue = BotGroupInspectValue
/** Group message delivery result. */
export type SharedBotGroupSendValue = BotGroupSendValue

/** One-time invite for an explicit shared-group ACL member. */
export interface SharedBotGroupInviteValue {
  /** Opaque invite code redeemed through the shared enrollment route. */
  readonly code: string
  /** Absolute invite expiry. */
  readonly expiresAt: number
}

/** Result of removing one principal from a shared-group ACL. */
export interface SharedBotGroupRevokeValue {
  /** Group whose ACL changed. */
  readonly groupId: string
  /** Removed principal. */
  readonly principalId: string
  /** True after durable removal. */
  readonly revoked: true
}

/** Current shared-room name, revision, permissions, and active people. */
export type SharedBotGroupSettingsValue = BotGroupSettingsValue

/** Stale-safe shared-room rename request. */
export interface SharedBotGroupRenameRequest {
  /** Group whose name should change. */
  readonly groupId: string
  /** New non-empty display name. */
  readonly name: string
  /** Revision returned by the last settings read. */
  readonly expectedUpdatedAt: number
}

/** JSON value shown to a collaborator when a connected-app call is awaiting approval. */
export type SharedBotApprovalArguments =
  | null
  | boolean
  | number
  | string
  | readonly SharedBotApprovalArguments[]
  | { readonly [key: string]: SharedBotApprovalArguments }

/** One bounded connected-app approval request visible to the authenticated collaborator. */
export interface SharedBotApprovalRequest {
  /** Opaque approval identity used for the one-shot decision. */
  readonly id: string
  /** Bot whose shared Session is waiting for the decision. */
  readonly botId: string
  /** Shared group that initiated the call, when the call came from a group Session. */
  readonly groupId?: string
  /** Human-readable connected-app identifier. */
  readonly appId: string
  /** Human-readable tool identifier. */
  readonly toolName: string
  /** Safe description of the side effect the tool is about to perform. */
  readonly action: string
  /** Model-provided explanation for the requested side effect. */
  readonly reason?: string
  /** Bounded JSON arguments, when the provider supplies them. */
  readonly arguments?: SharedBotApprovalArguments
  /** True when one or more argument values were hidden for safety. */
  readonly argumentsRedacted?: true
  /** True when argument data was shortened or omitted to stay bounded. */
  readonly argumentsTruncated?: true
  /** Optional call identity supplied for troubleshooting and support. */
  readonly callId?: string
  /** Optional creation time in Unix milliseconds. */
  readonly createdAt?: number
  /** Absolute expiry time in Unix milliseconds. */
  readonly expiresAt?: number
}

/** Pending connected-app approvals visible to the authenticated collaborator. */
export interface SharedBotApprovalListValue {
  readonly approvals: readonly SharedBotApprovalRequest[]
}

/** Result after a pending connected-app approval has been decided. */
export interface SharedBotApprovalDecisionValue {
  /** Whether this caller won the pending approval race. */
  readonly resolved: true
  /** Legacy outcome field retained while Hosts roll forward their endpoint response. */
  readonly accepted?: boolean
}

/** Browser operations exposed by the isolated `/shared-bots` route. */
export interface SharedBotsClient {
  /** Redeem an owner-issued invite; the response stores an HttpOnly cookie. */
  readonly enroll: (code: string) => Promise<SharedBotClientResult<SharedBotEnrollmentValue>>
  /**
   * Ask the authenticated local Host to enroll or reuse its durable owner.
   * The browser supplies no principal identity; the response stores the
   * Host-issued HttpOnly cookie.
   */
  readonly enrollOwner?: () => Promise<SharedBotClientResult<SharedBotEnrollmentValue>>
  /**
   * Discover whether the server can admit owner setup on this connection.
   * Transport, authentication, and malformed-response failures resolve to an
   * unavailable capability so the UI never offers a request that cannot work.
   */
  readonly getOwnerCapability?: () => Promise<SharedBotOwnerCapability>
  /** Re-run owner capability discovery when the active Connection generation changes. */
  readonly subscribeOwnerCapability?: (listener: () => void) => () => void
  /** Release the Connection-generation listener owned by this client. */
  readonly dispose?: () => void
  /** Restore the server-authenticated principal scope after a browser reload. */
  readonly restoreRetryScope: () => Promise<SharedBotClientResult<SharedBotEnrollmentValue>>
  /** Server-issued principal scope used to partition durable browser retry state. */
  readonly retryScope: string | undefined
  /** Monotonic generation for the authenticated principal and browser session. */
  readonly authGeneration?: number
  /** Subscribe to authenticated-principal or cross-tab ACL changes in this client instance. */
  readonly subscribeAuth?: (listener: SharedBotAuthListener) => () => void
  /** Discover Bots visible to the authenticated collaborator. */
  readonly list: () => Promise<SharedBotClientResult<{ readonly bots: readonly BotShareRosterEntry[] }>>
  /** Read one safe shared Bot profile. */
  readonly readProfile: (botId: string) => Promise<SharedBotClientResult<{ readonly bot: BotShareProfile }>>
  /** Read only the current collaborator's private transcript. */
  readonly readPrivateChat: (botId: string) => Promise<SharedBotClientResult<SharedBotPrivateChatValue>>
  /** Read the explicit shared context; this never includes the private transcript. */
  readonly readMemory: (botId: string) => Promise<SharedBotClientResult<SharedBotMemoryValue>>
  /** Send one message to the current collaborator's private Bot Session. */
  readonly chat: (botId: string, text: string) => Promise<SharedBotClientResult<SharedBotChatValue>>
  /** Publish one explicitly consented note to shared context. */
  readonly writeMemory: (botId: string, text: string) => Promise<SharedBotClientResult<SharedBotMemoryWriteValue>>
  /** Create one invite when the current membership role permits it. */
  readonly createInvite: (botId: string, role: SharedBotInviteValue['role']) => Promise<SharedBotClientResult<SharedBotInviteValue>>
  /** Revoke one member from one Bot when the current membership role permits it. */
  readonly revokeMember: (botId: string, principalId: string) => Promise<SharedBotClientResult<SharedBotRevokeValue>>
  /** List groups whose every Bot is shared with the current principal. */
  readonly listGroups?: () => Promise<SharedBotClientResult<SharedBotGroupListValue>>
  /** Create a group from Bots shared with the current principal. */
  readonly createGroup?: (request: BotGroupCreateRequest) => Promise<SharedBotClientResult<BotGroupCreateValue>>
  /** Update a group while retaining principal-derived membership access. */
  readonly updateGroup?: (request: BotGroupUpdateRequest) => Promise<SharedBotClientResult<BotGroupUpdateValue>>
  /** Read a shared group transcript without private Session events. */
  readonly inspectGroup?: (groupId: string) => Promise<SharedBotClientResult<SharedBotGroupInspectValue>>
  /** Send an idempotent shared group message attributed by the server. */
  readonly sendGroupMessage?: (request: BotGroupSendRemoteRequest) => Promise<SharedBotClientResult<SharedBotGroupSendValue>>
  /** Optional attachment-aware group transport supplied by a Host with attachment admission. */
  readonly sendGroupMessageWithAttachments?: (
    request: BotGroupSendRemoteRequest & { readonly attachments: readonly BotGroupAttachmentDraft[] },
  ) => Promise<SharedBotClientResult<SharedBotGroupSendValue>>
  /** Create one explicit ACL invite for a shared group. */
  readonly createGroupInvite?: (groupId: string) => Promise<SharedBotClientResult<SharedBotGroupInviteValue>>
  /** Revoke one explicit shared-group ACL member. */
  readonly revokeGroupMember?: (groupId: string, principalId: string) => Promise<SharedBotClientResult<SharedBotGroupRevokeValue>>
  /** Read the current shared-room name, revision, permissions, and members. */
  readonly readGroupSettings?: (groupId: string) => Promise<SharedBotClientResult<SharedBotGroupSettingsValue>>
  /** Rename a shared room using the revision captured by the caller. */
  readonly renameGroup?: (request: SharedBotGroupRenameRequest) => Promise<SharedBotClientResult<SharedBotGroupSettingsValue>>
  /** List pending connected-app approvals for the current shared principal. */
  readonly listApprovals?: (
    scope?: { readonly botId?: string; readonly groupId?: string },
  ) => Promise<SharedBotClientResult<SharedBotApprovalListValue>>
  /** Resolve one pending connected-app approval exactly once. */
  readonly decideApproval?: (id: string, decision: 'allow' | 'reject') => Promise<SharedBotClientResult<SharedBotApprovalDecisionValue>>
}

/**
 * Build a typed caller for the collaborator-only route.
 * @param rpc - Connection RPC carrier from the active Client generation.
 * @param options - Optional Connection-generation lifecycle subscription.
 * @returns shared-Bot operations using the dedicated channel only.
 */
export function createSharedBotsClient(rpc: ClientConnectionRpc, options: SharedBotsClientOptions = {}): SharedBotsClient {
  const attachmentFetcher: BotAttachmentFetch = options.attachmentFetcher ?? ((input, init) => globalThis.fetch(input, init))
  let retryScope: string | undefined
  let retryScopeRequestGeneration = 0
  let authGeneration = 0
  const authSenderId = `shared-client-${randomUUID()}`
  let authTransitionVersion = 0
  let authTransitionTail: Promise<void> = Promise.resolve()
  let authChannel: SharedAuthChannel | undefined
  const authListeners = new Set<SharedBotAuthListener>()
  const ownerCapabilityListeners = new Set<() => void>()
  let ownerCapabilityRequest: Promise<SharedBotOwnerCapability> | undefined
  let disposed = false
  const invalidateOwnerCapability = (): void => {
    ownerCapabilityRequest = undefined
    for (const listener of [...ownerCapabilityListeners]) listener()
  }
  let stopConnectionGeneration = options.subscribeConnectionGeneration?.(invalidateOwnerCapability)
  const notifyAuth = (change: SharedBotAuthChange): void => {
    for (const listener of [...authListeners]) listener(change)
  }
  const setRetryScope = (
    next: string | undefined,
    source: SharedBotAuthChange['source'] = 'local',
    broadcast = false,
    force = false,
  ): void => {
    if (retryScope === next && !force) return
    retryScope = next
    authGeneration += 1
    notifyAuth({ source, reason: next === undefined ? 'invalidated' : 'authenticated' })
    if (broadcast) broadcastSharedAuthChanged(authSenderId)
  }
  const receiveCrossTabAuthChange = (event: { readonly data: unknown }): void => {
    if (!isRecord(event.data) || event.data.type !== SHARED_AUTH_MESSAGE || event.data.senderId === authSenderId) return
    const observedTransitionVersion = authTransitionVersion
    void enqueueAuthTransition(() => {
      if (authTransitionVersion !== observedTransitionVersion) return Promise.resolve()
      authTransitionVersion += 1
      retryScopeRequestGeneration += 1
      setRetryScope(undefined, 'remote', false, true)
      return Promise.resolve()
    })
  }
  const enqueueAuthTransition = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = authTransitionTail
    let release!: () => void
    authTransitionTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await work()
    } finally {
      release()
    }
  }
  const call = async <T>(
    endpoint: string,
    payload: unknown,
    parse: (value: unknown) => T | undefined,
    broadcastUnauthorized = true,
  ): Promise<SharedBotClientResult<T>> => {
    const requestGeneration = retryScopeRequestGeneration
    const requestScope = retryScope
    let result
    try {
      result = await rpc.call(SHARED_BOTS_PATH, endpoint, payload)
    } catch (error: unknown) {
      return { ok: false, error: { code: 'gateway/transport', message: error instanceof Error ? error.message : 'Shared Bot transport failed', details: {} } }
    }
    if (!result.ok) {
      if (broadcastUnauthorized && result.error.code === 'gateway/unauthorized' && requestGeneration === retryScopeRequestGeneration
        && requestScope === retryScope) {
        retryScopeRequestGeneration += 1
        setRetryScope(undefined, 'local', true, true)
      }
      return result
    }
    const value = parse(result.value)
    if (value === undefined) {
      return { ok: false, error: { code: 'gateway/invalid-response', message: 'Shared Bot returned an invalid response', details: {} } }
    }
    return { ok: true, value }
  }

  const enroll = (code: string): Promise<SharedBotClientResult<SharedBotEnrollmentValue>> => enqueueAuthTransition(async () => {
    authTransitionVersion += 1
    const requestGeneration = retryScopeRequestGeneration + 1
    retryScopeRequestGeneration = requestGeneration
    setRetryScope(undefined, 'local', false, true)
    const result = await call('bots/share/enroll', { code }, parseEnrollment, false)
    if (requestGeneration === retryScopeRequestGeneration && result.ok) {
      setRetryScope(result.value.principalId, 'local', true, true)
      authTransitionVersion += 1
    }
    return result
  })
  const restoreRetryScope = (): Promise<SharedBotClientResult<SharedBotEnrollmentValue>> => enqueueAuthTransition(async () => {
    authTransitionVersion += 1
    const requestGeneration = retryScopeRequestGeneration + 1
    retryScopeRequestGeneration = requestGeneration
    setRetryScope(undefined)
    const result = await call('bots/share/session', {}, parseEnrollment, false)
    if (requestGeneration === retryScopeRequestGeneration && result.ok) {
      setRetryScope(result.value.principalId, 'local', false, true)
      authTransitionVersion += 1
    }
    return result
  })
  const sendGroupMessageWithAttachments = async (
    request: BotGroupSendRemoteRequest & { readonly attachments: readonly BotGroupAttachmentDraft[] },
  ): Promise<SharedBotClientResult<SharedBotGroupSendValue>> => {
    if (request.attachments.length === 0 || request.messageId === undefined) {
      return { ok: false, error: { code: 'gateway/bad-request', message: 'attachments require an explicit message id', details: {} } }
    }
    const inspect = await call('bots/share/inspect-group', { groupId: request.groupId }, parseGroupInspect)
    if (!inspect.ok) return inspect
    const existing = inspect.value.messages.find(message => message.id === request.messageId)
    if (existing !== undefined) {
      if (!groupAttachmentMatchesDrafts(existing, request.attachments)) {
        return { ok: false, error: { code: 'gateway/conflict', message: 'shared Bot message attachments differ from the retry', details: {} } }
      }
      return call('bots/share/send-group-message', {
        groupId: request.groupId,
        text: request.text,
        messageId: request.messageId,
        ...(request.targetBotIds === undefined ? {} : { targetBotIds: request.targetBotIds }),
      }, parseGroupSend)
    }
    try {
      const grants = await admitBotGroupAttachments(
        {
          groupId: String(request.groupId),
          messageId: String(request.messageId),
          ...(request.targetBotIds === undefined ? {} : { targetBotIds: request.targetBotIds.map(String) }),
        },
        request.attachments,
        async (imageRequest) => {
          const result = await call('bots/share/admit-group-image', imageRequest, parseBotAttachmentGrantValue)
          if (!result.ok) throw new BotAttachmentClientError(result.error.code, result.error.message)
          return result.value
        },
        attachmentFetcher,
        '/shared-bots/bots/share/uploadAttachment',
      )
      return call('bots/share/send-group-message', {
        groupId: request.groupId,
        text: request.text,
        messageId: request.messageId,
        ...(request.targetBotIds === undefined ? {} : { targetBotIds: request.targetBotIds }),
        attachmentGrants: grants,
      }, parseGroupSend)
    } catch (error: unknown) {
      return {
        ok: false,
        error: {
          code: error instanceof BotAttachmentClientError ? error.code : 'gateway/transport',
          message: error instanceof Error ? error.message : 'Shared Bot attachment admission failed',
          details: {},
        },
      }
    }
  }
  const enrollOwner = (): Promise<SharedBotClientResult<SharedBotEnrollmentValue>> => enqueueAuthTransition(async () => {
    authTransitionVersion += 1
    const requestGeneration = retryScopeRequestGeneration + 1
    retryScopeRequestGeneration = requestGeneration
    setRetryScope(undefined, 'local', false, true)
    const result = await call('bots/share/enroll', { owner: true }, parseEnrollment, false)
    if (requestGeneration === retryScopeRequestGeneration && result.ok) {
      setRetryScope(result.value.principalId, 'local', true, true)
      authTransitionVersion += 1
    }
    return result
  })
  const getOwnerCapability = (): Promise<SharedBotOwnerCapability> => {
    if (disposed) return Promise.resolve({ ownerBootstrap: false })
    if (ownerCapabilityRequest !== undefined) return ownerCapabilityRequest
    const request = (async () => {
      const result = await call('bots/share/enroll', { capability: true }, parseOwnerCapability, false)
      return result.ok ? result.value : { ownerBootstrap: false }
    })()
    ownerCapabilityRequest = request
    void request.then(
      () => { if (ownerCapabilityRequest === request) ownerCapabilityRequest = undefined },
      () => { if (ownerCapabilityRequest === request) ownerCapabilityRequest = undefined },
    )
    return request
  }
  const subscribeOwnerCapability = (listener: () => void): (() => void) => {
    if (disposed) return () => {}
    ownerCapabilityListeners.add(listener)
    return () => { ownerCapabilityListeners.delete(listener) }
  }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    stopConnectionGeneration?.()
    stopConnectionGeneration = undefined
    ownerCapabilityRequest = undefined
    ownerCapabilityListeners.clear()
  }

  return {
    get retryScope(): string | undefined { return retryScope },
    get authGeneration(): number { return authGeneration },
    subscribeAuth: (listener) => {
      authListeners.add(listener)
      if (authChannel === undefined) authChannel = openSharedAuthChannel(receiveCrossTabAuthChange)
      return () => {
        authListeners.delete(listener)
        if (authListeners.size === 0 && authChannel !== undefined) {
          authChannel.removeEventListener('message', receiveCrossTabAuthChange)
          authChannel.close()
          authChannel = undefined
        }
      }
    },
    enroll,
    enrollOwner,
    getOwnerCapability,
    subscribeOwnerCapability,
    dispose,
    restoreRetryScope,
    list: () => call('bots/share/list', {}, parseRoster),
    readProfile: botId => call('bots/share/read-profile', { botId }, parseProfileValue),
    readPrivateChat: botId => call('bots/share/read-private-chat', { botId }, parsePrivateChat),
    readMemory: botId => call('bots/share/read-memory', { botId }, parseMemoryValue),
    chat: (botId, text) => call('bots/share/chat', { botId, text }, parseChat),
    writeMemory: (botId, text) => call('bots/share/write-memory', { botId, text, consent: true }, parseMemoryWrite),
    createInvite: (botId, role) => call('bots/share/manage-members', { botId, action: 'create-invite', role }, parseInvite),
    revokeMember: (botId, principalId) => call('bots/share/manage-members', { botId, action: 'revoke', principalId }, parseRevoke),
    listGroups: () => call('bots/share/list-groups', {}, parseGroupList),
    createGroup: request => call('bots/share/create-group', request, parseGroupResult),
    updateGroup: request => call('bots/share/update-group', request, parseGroupResult),
    inspectGroup: groupId => call('bots/share/inspect-group', { groupId }, parseGroupInspect),
    sendGroupMessage: request => call('bots/share/send-group-message', request, parseGroupSend),
    sendGroupMessageWithAttachments,
    createGroupInvite: groupId => call('bots/share/manage-group-members', { groupId, action: 'create-invite' }, parseGroupInvite),
    revokeGroupMember: (groupId, principalId) => call('bots/share/manage-group-members', { groupId, action: 'revoke', principalId }, parseGroupRevoke),
    readGroupSettings: groupId => call('bots/share/group-settings', { groupId, action: 'read' }, parseGroupSettings),
    renameGroup: request => call('bots/share/group-settings', { ...request, action: 'rename' }, parseGroupSettings),
    listApprovals: scope => call('bots/share/list-approvals', scope ?? {}, parseApprovalList),
    decideApproval: (id, decision) => call('bots/share/decide-approval', { id, decision }, parseApprovalDecision),
  }
}

function parseEnrollment(value: unknown): SharedBotEnrollmentValue | undefined {
  if (!isRecord(value) || typeof value.principalId !== 'string' || !/^principal-[A-Za-z0-9-]+$/.test(value.principalId) || !isSafeInteger(value.expiresAt)) return undefined
  if (value.groupId !== undefined && (typeof value.groupId !== 'string' || !/^bot-group-[A-Za-z0-9][A-Za-z0-9-]*$/.test(value.groupId))) return undefined
  return {
    principalId: value.principalId,
    expiresAt: value.expiresAt,
    ...(value.groupId === undefined ? {} : { groupId: value.groupId }),
  }
}

function parseOwnerCapability(value: unknown): SharedBotOwnerCapability | undefined {
  if (!isRecord(value) || typeof value.ownerBootstrap !== 'boolean') return undefined
  return { ownerBootstrap: value.ownerBootstrap }
}

function parseRoster(value: unknown): { readonly bots: readonly BotShareRosterEntry[] } | undefined {
  if (!isRecord(value) || !Array.isArray(value.bots)) return undefined
  const bots = value.bots.map(parseRosterEntry)
  return bots.some(bot => bot === undefined)
    ? undefined
    : { bots: bots as readonly BotShareRosterEntry[] }
}

function parseRosterEntry(value: unknown): BotShareRosterEntry | undefined {
  const profile = parseProfile(value)
  if (profile === undefined || !isRecord(value) || typeof value.role !== 'string'
    || !['owner', 'manager', 'collaborator'].includes(value.role)) return undefined
  return { ...profile, role: value.role as BotShareRosterEntry['role'] }
}

function parseProfileValue(value: unknown): { readonly bot: BotShareProfile } | undefined {
  if (!isRecord(value)) return undefined
  const bot = parseProfile(value.bot)
  return bot === undefined ? undefined : { bot }
}

function parseProfile(value: unknown): BotShareProfile | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^bot-[A-Za-z0-9][A-Za-z0-9-]*$/.test(value.id)
    || typeof value.name !== 'string' || typeof value.state !== 'string' || !['provisioning', 'active'].includes(value.state)
    || typeof value.availability !== 'string' || !['running', 'idle', 'offline'].includes(value.availability)) return undefined
  const identity = enumValue(value.identity, BOT_IDENTITIES)
  const accent = enumValue(value.accent, BOT_ACCENTS)
  if (identity === undefined || accent === undefined) return undefined
  return {
    id: brandString<BotIdType>(value.id),
    name: value.name,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    identity,
    accent,
    state: value.state as BotShareProfile['state'],
    availability: value.availability as BotShareProfile['availability'],
  }
}

function parsePrivateChat(value: unknown): SharedBotPrivateChatValue | undefined {
  if (!isRecord(value) || typeof value.botId !== 'string' || !Array.isArray(value.recent)) return undefined
  const recent = value.recent.map(parseTranscript)
  if (recent.some(entry => entry === undefined)) return undefined
  return {
    botId: value.botId,
    ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
    recent: recent as readonly BotShareTranscriptEntry[],
  }
}

function parseMemoryValue(value: unknown): SharedBotMemoryValue | undefined {
  if (!isRecord(value) || typeof value.botId !== 'string' || !/^bot-[A-Za-z0-9][A-Za-z0-9-]*$/.test(value.botId)
    || typeof value.enabled !== 'boolean' || !isSafeInteger(value.updatedAt) || !Array.isArray(value.entries)) return undefined
  const entries = value.entries.map(parseMemoryEntry)
  return entries.some(entry => entry === undefined)
    ? undefined
    : {
      botId: brandString<BotIdType>(value.botId),
      enabled: value.enabled,
      updatedAt: value.updatedAt,
      entries: entries as readonly BotShareMemoryEntry[],
    }
}

function parseMemoryEntry(value: unknown): BotShareMemoryEntry | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^memory-[A-Za-z0-9-]+$/.test(value.id)
    || typeof value.principalId !== 'string' || !/^principal-[A-Za-z0-9-]+$/.test(value.principalId)
    || typeof value.text !== 'string' || !isSafeInteger(value.createdAt)) return undefined
  return {
    id: brandString<BotShareMemoryIdType>(value.id),
    principalId: brandString<BotPrincipalIdType>(value.principalId),
    text: value.text,
    createdAt: value.createdAt,
  }
}

function parseMemoryWrite(value: unknown): SharedBotMemoryWriteValue | undefined {
  if (!isRecord(value)) return undefined
  const entry = parseMemoryEntry(value.entry)
  return entry === undefined ? undefined : { entry }
}

function parseTranscript(value: unknown): BotShareTranscriptEntry | undefined {
  if (!isRecord(value) || (value.role !== 'user' && value.role !== 'assistant') || typeof value.text !== 'string') return undefined
  return { role: value.role, text: value.text }
}

function parseChat(value: unknown): SharedBotChatValue | undefined {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || value.accepted !== true) return undefined
  const profile = parseProfile(value.bot)
  return profile === undefined ? undefined : { bot: profile, sessionId: value.sessionId, accepted: true }
}

function parseInvite(value: unknown): SharedBotInviteValue | undefined {
  if (!isRecord(value) || typeof value.code !== 'string' || !isSafeInteger(value.expiresAt)
    || typeof value.role !== 'string' || !['owner', 'manager', 'collaborator'].includes(value.role)) return undefined
  return { code: value.code, expiresAt: value.expiresAt, role: value.role as SharedBotInviteValue['role'] }
}

function parseRevoke(value: unknown): SharedBotRevokeValue | undefined {
  if (!isRecord(value) || value.revoked !== true || typeof value.principalId !== 'string') return undefined
  return { revoked: true, principalId: value.principalId }
}

function parseGroupList(value: unknown): SharedBotGroupListValue | undefined {
  if (!isRecord(value) || !Array.isArray(value.groups)) return undefined
  const groups = value.groups.map(parseGroup)
  return groups.some(group => group === undefined) ? undefined : { groups: groups as readonly BotGroupView[] }
}

function parseGroupResult(value: unknown): { readonly group: BotGroupView } | undefined {
  if (!isRecord(value)) return undefined
  const group = parseGroup(value.group)
  return group === undefined ? undefined : { group }
}

function parseGroupInspect(value: unknown): SharedBotGroupInspectValue | undefined {
  if (!isRecord(value) || !Array.isArray(value.messages)) return undefined
  const group = parseGroup(value.group)
  if (group === undefined) return undefined
  const messages = value.messages.map(parseGroupMessage)
  if (messages.some(message => message === undefined)) return undefined
  const deliveryValue = value.deliveries
  if (deliveryValue !== undefined && !Array.isArray(deliveryValue)) return undefined
  const deliveries = deliveryValue === undefined ? undefined : deliveryValue.map(parseGroupDeliveryStatus)
  if (deliveries?.some(delivery => delivery === undefined)) return undefined
  return deliveries === undefined
    ? { group, messages: messages as readonly BotGroupMessageView[] }
    : {
      group,
      messages: messages as readonly BotGroupMessageView[],
      deliveries: deliveries as readonly BotGroupDeliveryStatusView[],
    }
}

function parseGroupSend(value: unknown): SharedBotGroupSendValue | undefined {
  if (!isRecord(value) || typeof value.messageId !== 'string'
    || !/^bot-group-message-[A-Za-z0-9][A-Za-z0-9-]*$/.test(value.messageId)
    || !['accepted', 'duplicate', 'partial'].includes(String(value.status))
    || !Array.isArray(value.deliveries)) return undefined
  const deliveries = value.deliveries.map(parseGroupDelivery)
  if (deliveries.some(delivery => delivery === undefined)) return undefined
  return {
    messageId: brandString<BotGroupMessageIdType>(value.messageId),
    status: value.status as SharedBotGroupSendValue['status'],
    deliveries: deliveries as readonly BotGroupDeliveryView[],
  }
}

function parseGroupInvite(value: unknown): SharedBotGroupInviteValue | undefined {
  if (!isRecord(value) || typeof value.code !== 'string' || !isSafeInteger(value.expiresAt)) return undefined
  return { code: value.code, expiresAt: value.expiresAt }
}

function parseGroupRevoke(value: unknown): SharedBotGroupRevokeValue | undefined {
  if (!isRecord(value) || typeof value.groupId !== 'string' || !/^bot-group-[A-Za-z0-9][A-Za-z0-9-]*$/.test(value.groupId)
    || typeof value.principalId !== 'string' || !/^principal-[A-Za-z0-9-]+$/.test(value.principalId) || value.revoked !== true) return undefined
  return { groupId: value.groupId, principalId: value.principalId, revoked: true }
}

function parseGroupSettings(value: unknown): SharedBotGroupSettingsValue | undefined {
  if (!isRecord(value) || typeof value.groupId !== 'string' || !/^bot-group-[A-Za-z0-9][A-Za-z0-9-]*$/.test(value.groupId)
    || typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 80
    || value.name.trim() !== value.name || !isSafeInteger(value.updatedAt) || typeof value.canManage !== 'boolean'
    || !Array.isArray(value.members)) return undefined
  const members = value.members.map(parseGroupSettingsMember)
  return members.some(member => member === undefined)
    ? undefined
    : {
      groupId: brandString<BotGroupIdType>(value.groupId),
      name: value.name,
      updatedAt: value.updatedAt,
      canManage: value.canManage,
      members: members as readonly BotGroupSettingsMember[],
    }
}

function parseGroupSettingsMember(value: unknown): BotGroupSettingsMember | undefined {
  if (!isRecord(value) || typeof value.principalId !== 'string' || !/^principal-[A-Za-z0-9-]+$/.test(value.principalId)
    || (value.role !== 'owner' && value.role !== 'member')) return undefined
  return { principalId: brandString<BotPrincipalIdType>(value.principalId), role: value.role }
}

function parseApprovalList(value: unknown): SharedBotApprovalListValue | undefined {
  if (!isRecord(value) || !Array.isArray(value.approvals)) return undefined
  const approvals = value.approvals.map(parseApprovalRequest)
  return approvals.some(approval => approval === undefined)
    ? undefined
    : { approvals: approvals as readonly SharedBotApprovalRequest[] }
}

function parseApprovalRequest(value: unknown): SharedBotApprovalRequest | undefined {
  if (!isRecord(value)
    || !boundedString(value.id, 256)
    || typeof value.botId !== 'string' || !/^bot-[A-Za-z0-9][A-Za-z0-9-]*$/.test(value.botId)
    || typeof value.appId !== 'string'
    || !boundedString(value.toolName, 256)
    || !boundedString(value.action, 1_024)) return undefined
  if (value.groupId !== undefined && (typeof value.groupId !== 'string' || !/^bot-group-[A-Za-z0-9][A-Za-z0-9-]*$/.test(value.groupId))) return undefined
  if (value.reason !== undefined && !boundedString(value.reason, 4096)) return undefined
  if (value.argumentsRedacted !== undefined && value.argumentsRedacted !== true) return undefined
  if (value.argumentsTruncated !== undefined && value.argumentsTruncated !== true) return undefined
  if (value.callId !== undefined && !boundedString(value.callId, 256)) return undefined
  if (value.createdAt !== undefined && !isSafeInteger(value.createdAt)) return undefined
  if (value.expiresAt !== undefined && !isSafeInteger(value.expiresAt)) return undefined
  let args: SharedBotApprovalArguments | undefined
  if (value.arguments !== undefined) {
    args = parseApprovalArguments(value.arguments)
    if (args === undefined) return undefined
  }
  return {
    id: value.id,
    botId: value.botId,
    ...(value.groupId === undefined ? {} : { groupId: value.groupId }),
    appId: value.appId,
    toolName: value.toolName,
    action: value.action,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    ...(args === undefined ? {} : { arguments: args }),
    ...(value.argumentsRedacted === undefined ? {} : { argumentsRedacted: true as const }),
    ...(value.argumentsTruncated === undefined ? {} : { argumentsTruncated: true as const }),
    ...(value.callId === undefined ? {} : { callId: value.callId }),
    ...(value.createdAt === undefined ? {} : { createdAt: value.createdAt }),
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
  }
}

function parseApprovalDecision(value: unknown): SharedBotApprovalDecisionValue | undefined {
  if (!isRecord(value)) return undefined
  if (value.resolved === true) return { resolved: true }
  return typeof value.accepted === 'boolean' ? { resolved: true, accepted: value.accepted } : undefined
}

function parseApprovalArguments(value: unknown, depth = 0): SharedBotApprovalArguments | undefined {
  if (depth > 6) return undefined
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') return value.length <= 8192 ? value : undefined
  if (Array.isArray(value)) {
    const items = value.map(item => parseApprovalArguments(item, depth + 1))
    return items.some(item => item === undefined) ? undefined : items as readonly SharedBotApprovalArguments[]
  }
  if (!isRecord(value) || Object.keys(value).length > 100) return undefined
  const entries = Object.entries(value).map(([key, item]) => {
    const parsed = parseApprovalArguments(item, depth + 1)
    return key.length <= 256 && parsed !== undefined ? [key, parsed] as const : undefined
  })
  if (entries.some(entry => entry === undefined)) return undefined
  return Object.fromEntries(entries as readonly (readonly [string, SharedBotApprovalArguments])[])
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function parseGroupDelivery(value: unknown): BotGroupDeliveryView | undefined {
  if (!isRecord(value) || typeof value.botId !== 'string'
    || !/^bot-[A-Za-z0-9][A-Za-z0-9-]*$/.test(value.botId)
    || !['accepted', 'duplicate', 'failed'].includes(String(value.status))) return undefined
  return {
    botId: brandString<BotIdType>(value.botId),
    status: value.status as BotGroupDeliveryView['status'],
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  }
}

function parseGroupDeliveryStatus(value: unknown): BotGroupDeliveryStatusView | undefined {
  if (!isRecord(value) || typeof value.messageId !== 'string'
    || !/^bot-group-message-[A-Za-z0-9][A-Za-z0-9-]*$/.test(value.messageId)
    || typeof value.botId !== 'string' || !/^bot-[A-Za-z0-9][A-Za-z0-9-]*$/.test(value.botId)
    || !['pending', 'accepted', 'responded', 'failed'].includes(String(value.status))) return undefined
  return {
    messageId: brandString<BotGroupMessageIdType>(value.messageId),
    botId: brandString<BotIdType>(value.botId),
    status: value.status as BotGroupDeliveryStatusView['status'],
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  }
}

function parseGroup(value: unknown): BotGroupView | undefined {
  if (!isRecord(value) || typeof value.id !== 'string'
    || !/^bot-group-[A-Za-z0-9][A-Za-z0-9-]*$/.test(value.id)
    || typeof value.name !== 'string' || !isSafeInteger(value.createdAt) || !isSafeInteger(value.updatedAt)
    || !Array.isArray(value.botIds) || !Array.isArray(value.bots)) return undefined
  const botIds = value.botIds.map(item => typeof item === 'string' && /^bot-[A-Za-z0-9][A-Za-z0-9-]*$/.test(item)
    ? brandString<BotIdType>(item)
    : undefined)
  const bots = value.bots.map(parseGroupMember)
  if (botIds.some(botId => botId === undefined) || bots.some(bot => bot === undefined)
    || bots.length !== botIds.length
    || new Set(botIds.filter((botId): botId is BotIdType => botId !== undefined).map(String)).size !== botIds.length
    || botIds.some(botId => botId !== undefined && !bots.some(bot => bot !== undefined && bot.id === botId))
    || bots.some(bot => bot !== undefined && !botIds.some(botId => botId !== undefined && botId === bot.id))) return undefined
  return {
    id: brandString<BotGroupIdType>(value.id),
    name: value.name,
    botIds: botIds as readonly BotIdType[],
    bots: bots as readonly BotGroupMemberView[],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function parseGroupMember(value: unknown): BotGroupMemberView | undefined {
  const profile = parseProfile(value)
  return profile === undefined ? undefined : profile
}

function parseGroupMessage(value: unknown): BotGroupMessageView | undefined {
  if (!isRecord(value) || typeof value.id !== 'string'
    || !/^bot-group-message-[A-Za-z0-9][A-Za-z0-9-]*$/.test(value.id)
    || typeof value.groupId !== 'string' || !/^bot-group-[A-Za-z0-9][A-Za-z0-9-]*$/.test(value.groupId)
    || typeof value.text !== 'string' || !isSafeInteger(value.createdAt)
    || !isRecord(value.sender)) return undefined
  const sender = parseGroupMessageSender(value.sender)
  if (sender === undefined) return undefined
  const targetValue = value.targetBotIds
  if (targetValue !== undefined && !Array.isArray(targetValue)) return undefined
  const targetBotIds = targetValue === undefined ? undefined : targetValue.map(item => (
    typeof item === 'string' && /^bot-[A-Za-z0-9][A-Za-z0-9-]*$/.test(item) ? brandString<BotIdType>(item) : undefined
  ))
  if (targetBotIds?.some(botId => botId === undefined)) return undefined
  const attachmentValue = value.attachments
  if (attachmentValue !== undefined && !Array.isArray(attachmentValue)) return undefined
  const attachments = attachmentValue === undefined ? undefined : attachmentValue.map(parseAttachmentView)
  if (attachments?.some(attachment => attachment === undefined)) return undefined
  return {
    id: brandString<BotGroupMessageIdType>(value.id),
    groupId: brandString<BotGroupIdType>(value.groupId),
    sender,
    text: value.text,
    createdAt: value.createdAt,
    ...(targetBotIds === undefined ? {} : { targetBotIds: targetBotIds as readonly BotIdType[] }),
    ...(attachments === undefined ? {} : { attachments: attachments as readonly BotInputAttachmentView[] }),
  }
}

function parseAttachmentView(value: unknown): BotInputAttachmentView | undefined {
  if (!isRecord(value) || typeof value.attachmentId !== 'string' || !isOpaqueAttachmentId(value.attachmentId)
    || typeof value.type !== 'string' || typeof value.bytes !== 'number' || !isSafeInteger(value.bytes) || value.bytes < 0) return undefined
  if (value.type === 'file') {
    return typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 255
      ? { type: 'file', attachmentId: value.attachmentId, name: value.name, bytes: value.bytes }
      : undefined
  }
  if (value.type !== 'image' || typeof value.mediaType !== 'string'
    || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value.mediaType)
    || typeof value.width !== 'number' || !isSafeInteger(value.width) || value.width < 1
    || typeof value.height !== 'number' || !isSafeInteger(value.height) || value.height < 1
    || (value.name !== undefined && (typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 255))) return undefined
  return {
    type: 'image', attachmentId: value.attachmentId, mediaType: value.mediaType as BotImageMediaType,
    bytes: value.bytes, width: value.width, height: value.height,
    ...(value.name === undefined ? {} : { name: value.name }),
  }
}

function isOpaqueAttachmentId(value: string): boolean {
  return value.length >= 1 && value.length <= 512 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}

function parseGroupMessageSender(value: Record<string, unknown>): BotGroupMessageSenderView | undefined {
  if (value.kind === 'user') {
    if (value.principalId === undefined) return { kind: 'user' }
    return typeof value.principalId === 'string' && /^principal-[A-Za-z0-9-]+$/.test(value.principalId)
      ? { kind: 'user', principalId: brandString<BotPrincipalIdType>(value.principalId) }
      : undefined
  }
  if (value.kind !== 'bot' || typeof value.botId !== 'string'
    || !/^bot-[A-Za-z0-9][A-Za-z0-9-]*$/.test(value.botId) || typeof value.name !== 'string') return undefined
  return { kind: 'bot', botId: brandString<BotIdType>(value.botId), name: value.name }
}

function groupAttachmentMatchesDrafts(
  message: BotGroupMessageView,
  drafts: readonly BotGroupAttachmentDraft[],
): boolean {
  const admitted = message.attachments
  if (admitted === undefined || admitted.length !== drafts.length || admitted.length === 0) return false
  return drafts.every((draft, index) => {
    const current = admitted[index]
    if (current === undefined || current.bytes !== draft.file.size) return false
    if (current.type === 'file') return current.name === (draft.file.name || current.name)
    return current.type === 'image'
      && isBotGroupImageType(draft.file.type)
      && current.mediaType === draft.file.type
      && (draft.file.name === '' || current.name === draft.file.name || current.name === undefined)
  })
}

function enumValue<T extends string>(value: unknown, choices: readonly T[]): T | undefined {
  return typeof value === 'string' && choices.some(choice => choice === value) ? value as T : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}
