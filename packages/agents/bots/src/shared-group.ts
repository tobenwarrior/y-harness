/** Durable shared-group ACLs, transcripts, and isolated Session admission. */

import { createHash, randomUUID } from 'node:crypto'
import type { Agent } from '@yharness/agent'
import {
  SharedAccessAuthority,
  SharedAccessStateSnapshot,
  SharedInviteCode,
  sharedInviteDigest,
  sharedPrincipalOf,
  type ConnectionTrustRequest,
  type SharedAccessEnrollment,
} from '@yharness/client-connection'
import { SessionId } from '@yharness/session'
import { BotId } from './types.ts'
import type { BotView } from './types.ts'
import { BotPrincipalId } from './sharing.ts'
import type { BotShareOperation } from './sharing.ts'
import {
  botGroupMessageRecordSchema,
  BotGroupId,
  BotGroupMessageId,
} from './group-chat.ts'
import type {
  BotGroupCreateRequest,
  BotGroupCreateValue,
  BotGroupDeliveryClaim,
  BotGroupDeliveryClaimInput,
  BotGroupDeliveryRecord,
  BotGroupDeliveryStatusView,
  BotGroupDeliveryView,
  BotGroupInspectValue,
  BotGroupListValue,
  BotGroupMessageRecord,
  BotGroupMessageView,
  BotGroupSendRemoteRequest,
  BotGroupSendValue,
  BotGroupUpdateRequest,
  BotGroupUpdateValue,
  BotGroupView,
} from './group-chat.ts'
import {
  sharedMembershipSnapshotSchema,
  type SharedMembershipRecord,
  type SharedMembershipSnapshot,
} from './storage.ts'
import z from 'zod'

/** Extension field containing the canonical shared-group state. */
export const SHARED_GROUPS_FIELD = 'sharedGroups' as const

/** Current serialized shared-group state version. */
export const SHARED_GROUPS_VERSION = 1 as const

/** Maximum shared groups retained in one authority extension. */
const MAX_SHARED_GROUPS = 256
/** Maximum shared-group messages retained in one authority extension. */
const MAX_SHARED_GROUP_MESSAGES = 8_192
/** Maximum shared-group delivery rows retained in one authority extension. */
const MAX_SHARED_GROUP_DELIVERIES = 49_152
/** Maximum isolated shared-group Session bindings retained in one authority extension. */
const MAX_SHARED_GROUP_SESSIONS = 1_536
/** Maximum outstanding group invitation rows retained in one authority extension. */
const MAX_SHARED_GROUP_INVITES = 1_024
const MAX_GROUP_MEMBERS = 6
const MAX_GROUP_NAME = 80
const MAX_MESSAGE_TEXT = 16_000
const SHARED_GROUP_DELIVERY_LEASE_MS = 30_000
const MAX_SHARED_GROUP_RECOVERY_BATCH = 64
const SHARED_GROUP_RECOVERY_CONCURRENCY = 4
const SHARED_GROUP_RECOVERY_TIMEOUT_MS = 15_000

const botIdSchema = z.string().regex(/^bot-[A-Za-z0-9][A-Za-z0-9-]*$/).transform(BotId)
const groupIdSchema = z.string().regex(/^bot-group-[A-Za-z0-9][A-Za-z0-9-]*$/).transform(BotGroupId)
const principalIdSchema = z.string().regex(/^principal-[A-Za-z0-9-]+$/).transform(BotPrincipalId)
const groupNameSchema = z.string().min(1).max(MAX_GROUP_NAME).refine(value => value.trim() === value)
const safeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const timestampSchema = safeIntegerSchema
const sharedGroupSessionIdSchema = z.string()
  .regex(/^shared-session-group-[A-Za-z0-9-]+$/)
  .transform(SessionId)

const sharedGroupRecordSchema = z.object({
  id: groupIdSchema,
  name: groupNameSchema,
  botIds: z.array(botIdSchema).min(2).max(MAX_GROUP_MEMBERS),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  ownerPrincipalId: principalIdSchema,
  memberPrincipalIds: z.array(principalIdSchema).min(1).max(256),
  revision: safeIntegerSchema,
}).strict().superRefine((record, context) => {
  if (new Set(record.botIds.map(String)).size !== record.botIds.length) {
    context.addIssue({ code: 'custom', message: 'shared group Bot members must be unique', path: ['botIds'] })
  }
  if (new Set(record.memberPrincipalIds.map(String)).size !== record.memberPrincipalIds.length) {
    context.addIssue({ code: 'custom', message: 'shared group principals must be unique', path: ['memberPrincipalIds'] })
  }
  if (!record.memberPrincipalIds.some(principal => String(principal) === String(record.ownerPrincipalId))) {
    context.addIssue({ code: 'custom', message: 'shared group owner must be a member', path: ['ownerPrincipalId'] })
  }
  if (record.updatedAt < record.createdAt) {
    context.addIssue({ code: 'custom', message: 'shared group updatedAt must not be earlier than createdAt', path: ['updatedAt'] })
  }
})

const sharedGroupDeliverySchema = z.object({
  id: z.string().min(1).max(256),
  groupId: groupIdSchema,
  messageId: z.string().regex(/^bot-group-message-[A-Za-z0-9][A-Za-z0-9-]*$/).transform(BotGroupMessageId),
  botId: botIdSchema,
  status: z.enum(['pending', 'accepted', 'responded', 'failed']),
  responseMessageId: z.string().regex(/^bot-group-message-[A-Za-z0-9][A-Za-z0-9-]*$/).transform(BotGroupMessageId).optional(),
  error: z.string().min(1).max(400).optional(),
  claim: z.object({
    turn: safeIntegerSchema,
    step: safeIntegerSchema,
    isolated: z.boolean(),
  }).strict().optional(),
  dispatchToken: z.string().min(1).max(256).optional(),
  dispatchLeaseUntil: timestampSchema.optional(),
  authorizationRevision: safeIntegerSchema,
  senderPrincipalId: principalIdSchema,
  updatedAt: timestampSchema,
}).strict().transform((value): SharedGroupDeliveryRecord => ({
  id: value.id,
  groupId: value.groupId,
  messageId: value.messageId,
  botId: value.botId,
  status: value.status,
  ...(value.responseMessageId === undefined ? {} : { responseMessageId: value.responseMessageId }),
  ...(value.error === undefined ? {} : { error: value.error }),
  ...(value.claim === undefined ? {} : { claim: value.claim }),
  ...(value.dispatchToken === undefined ? {} : { dispatchToken: value.dispatchToken }),
  ...(value.dispatchLeaseUntil === undefined ? {} : { dispatchLeaseUntil: value.dispatchLeaseUntil }),
  authorizationRevision: value.authorizationRevision,
  senderPrincipalId: value.senderPrincipalId,
  updatedAt: value.updatedAt,
}))

const sharedGroupSessionSchema = z.object({
  groupId: groupIdSchema,
  botId: botIdSchema,
  sessionId: sharedGroupSessionIdSchema,
  botName: z.string().min(1).max(MAX_GROUP_NAME).optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  revokedAt: timestampSchema.optional(),
}).strict().refine(value => value.updatedAt >= value.createdAt, {
  message: 'shared group Session updatedAt must not be earlier than createdAt',
})

const sharedGroupInviteSchema = z.object({
  digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  groupId: groupIdSchema,
  createdBy: principalIdSchema,
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
}).strict().refine(value => value.expiresAt > value.createdAt, {
  message: 'shared group invite expiresAt must be after createdAt',
})

/** Parsed durable shared-group state stored inside the shared-membership extension. */
export const sharedGroupSnapshotSchema = z.object({
  version: z.literal(SHARED_GROUPS_VERSION),
  revision: safeIntegerSchema,
  groups: z.array(sharedGroupRecordSchema).max(MAX_SHARED_GROUPS),
  messages: z.array(botGroupMessageRecordSchema).max(MAX_SHARED_GROUP_MESSAGES),
  deliveries: z.array(sharedGroupDeliverySchema).max(MAX_SHARED_GROUP_DELIVERIES),
  sessions: z.array(sharedGroupSessionSchema).max(MAX_SHARED_GROUP_SESSIONS),
  invites: z.array(sharedGroupInviteSchema).max(MAX_SHARED_GROUP_INVITES),
  responseReservations: z.array(z.string().min(1).max(256)).max(MAX_SHARED_GROUP_MESSAGES).optional().default([]),
}).strict().superRefine((snapshot, context) => {
  const groupIds = new Set<string>()
  for (const group of snapshot.groups) {
    if (groupIds.has(String(group.id))) context.addIssue({ code: 'custom', message: 'shared group ids must be unique', path: ['groups'] })
    groupIds.add(String(group.id))
  }
  const messageIds = new Set<string>()
  for (const message of snapshot.messages) {
    if (messageIds.has(String(message.id))) context.addIssue({ code: 'custom', message: 'shared group message ids must be unique', path: ['messages'] })
    messageIds.add(String(message.id))
  }
  const deliveryIds = new Set<string>()
  for (const delivery of snapshot.deliveries) {
    if (deliveryIds.has(delivery.id)) context.addIssue({ code: 'custom', message: 'shared group delivery ids must be unique', path: ['deliveries'] })
    deliveryIds.add(delivery.id)
    if (delivery.id !== deliveryKey(delivery.messageId, delivery.botId)) {
      context.addIssue({ code: 'custom', message: 'shared group delivery id must be canonical', path: ['deliveries'] })
    }
    if ((delivery.dispatchToken === undefined) !== (delivery.dispatchLeaseUntil === undefined)) {
      context.addIssue({ code: 'custom', message: 'shared group delivery dispatch lease must include its token and expiry', path: ['deliveries'] })
    }
    if (delivery.status !== 'pending' && (delivery.dispatchToken !== undefined || delivery.dispatchLeaseUntil !== undefined)) {
      context.addIssue({ code: 'custom', message: 'shared group dispatch lease is only valid for pending deliveries', path: ['deliveries'] })
    }
    if (delivery.status === 'responded' && delivery.responseMessageId === undefined) {
      context.addIssue({ code: 'custom', message: 'responded shared group delivery must link its response message', path: ['deliveries'] })
    }
    if (delivery.status !== 'responded' && delivery.responseMessageId !== undefined) {
      context.addIssue({ code: 'custom', message: 'non-responded shared group delivery cannot link a response message', path: ['deliveries'] })
    }
    if ((delivery.status === 'pending' || delivery.status === 'accepted')
      && !snapshot.responseReservations.includes(delivery.id)) {
      context.addIssue({ code: 'custom', message: 'active shared group delivery must have a response reservation', path: ['deliveries'] })
    }
  }
  const groupsById = new Map(snapshot.groups.map(group => [String(group.id), group]))
  const messagesById = new Map(snapshot.messages.map(message => [String(message.id), message]))
  const deliveriesById = new Map(snapshot.deliveries.map(delivery => [delivery.id, delivery]))
  const deliveryBotsByMessage = new Map<string, Set<string>>()
  for (const delivery of snapshot.deliveries) {
    const bots = deliveryBotsByMessage.get(String(delivery.messageId)) ?? new Set<string>()
    bots.add(String(delivery.botId))
    deliveryBotsByMessage.set(String(delivery.messageId), bots)
  }
  const sessionBotsByGroup = new Map<string, Set<string>>()
  for (const session of snapshot.sessions) {
    const bots = sessionBotsByGroup.get(String(session.groupId)) ?? new Set<string>()
    bots.add(String(session.botId))
    sessionBotsByGroup.set(String(session.groupId), bots)
  }
  for (const message of snapshot.messages) {
    const group = groupsById.get(String(message.groupId))
    if (group === undefined) {
      context.addIssue({ code: 'custom', message: 'shared group message must target an existing group', path: ['messages'] })
      continue
    }
    const targets = message.targetBotIds ?? group.botIds
    const targetIds = new Set(message.targetBotIds === undefined
      ? [...targets.map(String), ...(deliveryBotsByMessage.get(String(message.id)) ?? [])]
      : targets.map(String))
    const knownBots = sessionBotsByGroup.get(String(group.id)) ?? new Set(group.botIds.map(String))
    if (new Set(targets.map(String)).size !== targets.length || [...targetIds].some(botId => !knownBots.has(botId))) {
      context.addIssue({ code: 'custom', message: 'shared group message targets must be group Bots', path: ['messages'] })
    }
    if (message.sender.kind === 'bot' && !knownBots.has(String(message.sender.botId))) {
      context.addIssue({ code: 'custom', message: 'shared group response sender must be a group Bot', path: ['messages'] })
    }
  }
  for (const delivery of snapshot.deliveries) {
    const group = groupsById.get(String(delivery.groupId))
    const message = messagesById.get(String(delivery.messageId))
    if (group === undefined || message === undefined || message.groupId !== delivery.groupId) {
      context.addIssue({ code: 'custom', message: 'shared group delivery must reference its group message', path: ['deliveries'] })
      continue
    }
    const targets = message.targetBotIds ?? group.botIds
    const targetIds = new Set(message.targetBotIds === undefined
      ? [...targets.map(String), ...(deliveryBotsByMessage.get(String(message.id)) ?? [])]
      : targets.map(String))
    const knownBots = sessionBotsByGroup.get(String(group.id)) ?? new Set(group.botIds.map(String))
    if (!knownBots.has(String(delivery.botId)) || !targetIds.has(String(delivery.botId))) {
      context.addIssue({ code: 'custom', message: 'shared group delivery Bot must be a message target', path: ['deliveries'] })
    }
    if ((delivery.status === 'pending' || delivery.status === 'accepted')
      && !snapshot.sessions.some(session => session.groupId === delivery.groupId
        && session.botId === delivery.botId && session.revokedAt === undefined)) {
      context.addIssue({ code: 'custom', message: 'active shared group delivery must have an active Session binding', path: ['deliveries'] })
    }
    if (message.sender.kind !== 'user' || String(message.sender.principalId ?? '') !== String(delivery.senderPrincipalId)) {
      context.addIssue({ code: 'custom', message: 'shared group delivery sender must match its user message', path: ['deliveries'] })
    }
    if (delivery.responseMessageId !== undefined) {
      const response = messagesById.get(String(delivery.responseMessageId))
      if (response === undefined || response.groupId !== delivery.groupId
        || response.sender.kind !== 'bot' || response.sender.botId !== delivery.botId) {
        context.addIssue({ code: 'custom', message: 'shared group delivery response link is invalid', path: ['deliveries'] })
      }
    }
  }
  const sessionKeys = new Set<string>()
  const sessionIds = new Set<string>()
  for (const session of snapshot.sessions) {
    const key = `${String(session.groupId)}:${String(session.botId)}`
    if (sessionKeys.has(key)) context.addIssue({ code: 'custom', message: 'shared group Session bindings must be unique', path: ['sessions'] })
    sessionKeys.add(key)
    if (sessionIds.has(String(session.sessionId))) {
      context.addIssue({ code: 'custom', message: 'shared group Session ids must be unique', path: ['sessions'] })
    }
    sessionIds.add(String(session.sessionId))
    const group = snapshot.groups.find(candidate => candidate.id === session.groupId)
    if (group === undefined || (session.revokedAt === undefined && !group.botIds.includes(session.botId))) {
      context.addIssue({ code: 'custom', message: 'shared group Session binding must target a group Bot', path: ['sessions'] })
    }
  }
  for (const invite of snapshot.invites) {
    if (!snapshot.groups.some(group => group.id === invite.groupId)) {
      context.addIssue({ code: 'custom', message: 'shared group invite must target an existing group', path: ['invites'] })
    }
  }
  if (new Set(snapshot.responseReservations).size !== snapshot.responseReservations.length) {
    context.addIssue({ code: 'custom', message: 'shared group response reservations must be unique', path: ['responseReservations'] })
  }
  for (const reservation of snapshot.responseReservations) {
    const delivery = deliveriesById.get(reservation)
    if (delivery === undefined || (delivery.status !== 'pending' && delivery.status !== 'accepted')) {
      context.addIssue({ code: 'custom', message: 'shared group response reservation must reference an active delivery', path: ['responseReservations'] })
    }
  }
})

/** Parsed shared-group state type. */
export type SharedGroupSnapshot = z.infer<typeof sharedGroupSnapshotSchema>

/** Durable shared-group Session binding projected to the Host. */
export type SharedGroupSessionBinding = z.infer<typeof sharedGroupSessionSchema>

/** Shared delivery record with the authorization revision and dispatch lease that admitted it. */
export type SharedGroupDeliveryRecord = Omit<BotGroupDeliveryRecord, 'updatedAt'> & {
  readonly authorizationRevision: number
  readonly senderPrincipalId: ReturnType<typeof BotPrincipalId>
  readonly dispatchToken?: string
  readonly dispatchLeaseUntil?: number
  readonly updatedAt: number
}

/** Host capabilities needed to create and deliver an isolated shared-group Session. */
export interface SharedGroupHost {
  /** Read the current operator-owned Bot roster. */
  readonly listBots: (signal?: AbortSignal) => Promise<readonly BotView[]>
  /** Admit a new durable group Session with the shared-only preset and cwd. */
  readonly createSharedGroupSession?: (
    bot: BotView,
    sessionId: SessionId,
    groupId: ReturnType<typeof BotGroupId>,
    signal?: AbortSignal,
  ) => Promise<Pick<Agent, 'id' | 'cancel' | 'whenIdle'> | void>
  /** Resolve one previously bound shared-group Session after checking its metadata. */
  readonly resolveSharedGroupAgent?: (
    sessionId: SessionId,
    groupId: ReturnType<typeof BotGroupId>,
    botId: BotId,
    signal: AbortSignal,
  ) => Promise<{ readonly agent: Pick<Agent, 'id' | 'followup' | 'cancel' | 'whenIdle'> } | { readonly error: Error }>
  /** Inspect only the durable events of an isolated shared-group Session. */
  readonly inspectSharedGroupSession?: (sessionId: SessionId, signal: AbortSignal) => Promise<{ readonly events: readonly import('@yharness/session').SessionEvent[] }>
  /** Flush one isolated shared-group Session after message admission. */
  readonly flushSharedGroupSession?: (sessionId: SessionId, signal?: AbortSignal) => Promise<boolean>
  /** Register newly committed bindings before the caller can send a retry. */
  readonly registerSharedGroupSessions?: (bindings: readonly SharedGroupSessionBinding[]) => void
  /** Queue one idempotent message into the exact isolated group Session. */
  readonly deliverSharedGroup?: (request: {
    readonly groupId: ReturnType<typeof BotGroupId>
    readonly groupName: string
    readonly targetBotId: BotId
    readonly sessionId: SessionId
    readonly text: string
    readonly messageId: ReturnType<typeof BotGroupMessageId>
    readonly signal?: AbortSignal
  }) => Promise<'accepted' | 'duplicate'>
}

/** Stable error category returned by shared-group endpoint operations. */
export type SharedGroupErrorCode = 'gateway/bad-request' | 'gateway/conflict' | 'gateway/forbidden' | 'gateway/not-found' | 'gateway/unavailable'

/** Error carrying a safe shared-group RPC failure category. */
export class SharedGroupError extends Error {
  /** @param code - Safe RPC error category. @param message - User-safe diagnostic. */
  constructor(readonly code: SharedGroupErrorCode, message: string) {
    super(message)
    this.name = 'SharedGroupError'
  }
}

interface SharedGroupMutationResult<T> {
  readonly snapshot: SharedGroupSnapshot
  readonly value: T
}

/** Durable shared-group owner and collaborator service. */
export class SharedBotGroupService {
  private readonly now: () => number
  private readonly recoveryController = new AbortController()
  private readonly recoveryTimers = new Set<ReturnType<typeof setTimeout>>()
  private readonly recoveryTasks = new Set<Promise<void>>()
  private recoverySweepTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false

  /** @param authority - Shared identity authority providing the durable lock.
   * @param host - Isolated Session capabilities.
   * @param now - Testable clock.
   */
  constructor(
    private readonly authority: SharedAccessAuthority,
    private readonly host: SharedGroupHost,
    now: () => number = Date.now,
  ) {
    this.now = now
  }

  /** Stop delayed shared-group recovery work before the authority is closed. */
  async dispose(): Promise<void> {
    this.stopped = true
    this.recoveryController.abort()
    for (const timer of this.recoveryTimers) clearTimeout(timer)
    this.recoveryTimers.clear()
    if (this.recoverySweepTimer !== undefined) clearTimeout(this.recoverySweepTimer)
    this.recoverySweepTimer = undefined
    await Promise.allSettled([...this.recoveryTasks])
    this.recoveryTasks.clear()
  }

  /** Return durable group Session bindings for Host startup recovery. */
  async sessionBindings(): Promise<readonly SharedGroupSessionBinding[]> {
    const extension = await this.authority.readExtension('agent-bots/shared-memberships')
    return parseGroups(parseMembershipExtension(extension.value).sharedGroups).sessions
  }

  /** Replay durable pending deliveries after a Host restart or crash. */
  async recoverPendingDeliveries(signal?: AbortSignal): Promise<void> {
    if (this.stopped) return
    this.requireIsolatedHost()
    signal?.throwIfAborted()
    const extension = await this.authority.readExtension('agent-bots/shared-memberships')
    const snapshot = parseGroups(parseMembershipExtension(extension.value).sharedGroups)
    this.host.registerSharedGroupSessions?.(snapshot.sessions.filter(session => session.revokedAt === undefined))
    const pending = snapshot.deliveries.filter(candidate => candidate.status === 'pending')
    const batch = pending.slice(0, MAX_SHARED_GROUP_RECOVERY_BATCH)
    let nextIndex = 0
    const worker = async (): Promise<void> => {
      while (true) {
        signal?.throwIfAborted()
        const index = nextIndex++
        const delivery = batch[index]
        if (delivery === undefined) return
        await this.recoverPendingDelivery(delivery.id, signal)
      }
    }
    await Promise.all(Array.from({ length: Math.min(SHARED_GROUP_RECOVERY_CONCURRENCY, batch.length) }, () => worker()))
    if (pending.length > batch.length) this.scheduleRecoverySweep()
  }

  /** Return whether an enrollment code is currently a group invite. */
  async hasInvite(code: SharedInviteCode): Promise<boolean> {
    const extension = await this.authority.readExtension('agent-bots/shared-memberships')
    const snapshot = parseMembershipExtension(extension.value)
    const groups = parseGroups(snapshot.sharedGroups)
    return groups.invites.some(invite => invite.digest === sharedInviteDigest(code) && this.now() < invite.expiresAt)
  }

  /** Create a group from Bots the authenticated principal can currently use. */
  async create(
    request: BotGroupCreateRequest,
    principalId: ReturnType<typeof BotPrincipalId>,
    signal: AbortSignal,
  ): Promise<BotGroupCreateValue> {
    this.requireIsolatedHost()
    const name = normalizeText(request.name, 'Bot group name', MAX_GROUP_NAME)
    const botIds = normalizeBotIds(request.botIds)
    const id = request.id === undefined ? BotGroupId(`bot-group-${randomUUID()}`) : normalizeGroupId(request.id)
    const result = await this.locked(principalId, 'write-group', signal, async (snapshot, memberships) => {
      requireBotAccess(memberships, botIds, principalId, 'write-group')
      const bots = await this.activeBots(botIds, signal)
      const existing = snapshot.groups.find(group => group.id === id)
      if (existing !== undefined) {
        if (existing.ownerPrincipalId !== principalId || existing.name !== name || !sameIdSet(existing.botIds, botIds)) {
          throw new SharedGroupError('gateway/conflict', `shared Bot group "${String(id)}" already exists with different metadata`)
        }
        return { snapshot, value: { group: groupView(existing, bots) } }
      }
      const now = this.now()
      const group: SharedGroupRecord = {
        id,
        name,
        botIds,
        createdAt: now,
        updatedAt: now,
        ownerPrincipalId: principalId,
        memberPrincipalIds: [principalId],
        revision: snapshot.revision + 1,
      }
      const sessions = [
        ...snapshot.sessions,
        ...botIds.map((botId): SharedGroupSessionBinding => ({
          groupId: id,
          botId,
          sessionId: SessionId(`shared-session-group-${randomUUID()}`),
          botName: bots.find(bot => bot.id === botId)?.name,
          createdAt: now,
          updatedAt: now,
        })),
      ]
      const next = { ...snapshot, revision: snapshot.revision + 1, groups: [...snapshot.groups, group], sessions }
      return { snapshot: next, value: { group: groupView(group, bots) } }
    })
    this.host.registerSharedGroupSessions?.(result.snapshot.sessions.filter(session => session.revokedAt === undefined))
    return result.value
  }

  /** List only groups for which the principal has both ACL and Bot membership. */
  async list(principalId: ReturnType<typeof BotPrincipalId>, signal: AbortSignal): Promise<BotGroupListValue> {
    this.requireIsolatedHost()
    const result = await this.locked(principalId, 'read-group', signal, async (snapshot, memberships) => {
      const bots = await this.host.listBots(signal)
      const groups: BotGroupView[] = []
      for (const group of snapshot.groups) {
        if (!hasGroupAccess(group, memberships, principalId, 'read-group')) continue
        const view = safeGroupView(group, bots)
        if (view !== undefined) groups.push(view)
      }
      return {
        snapshot,
        value: {
          groups: groups.sort(
            (left, right) => left.createdAt - right.createdAt || String(left.id).localeCompare(String(right.id)),
          ),
        },
      }
    })
    return result.value
  }

  /** Update a group roster through its explicit owner ACL. */
  async update(
    request: BotGroupUpdateRequest,
    principalId: ReturnType<typeof BotPrincipalId>,
    signal: AbortSignal,
  ): Promise<BotGroupUpdateValue> {
    this.requireIsolatedHost()
    const name = normalizeText(request.name, 'Bot group name', MAX_GROUP_NAME)
    const botIds = normalizeBotIds(request.botIds)
    const result = await this.locked(principalId, 'write-group', signal, async (snapshot, memberships) => {
      const group = findGroup(snapshot, normalizeGroupId(request.groupId))
      requireGroupAccess(group, memberships, principalId, 'write-group')
      if (group.ownerPrincipalId !== principalId) throw new SharedGroupError('gateway/forbidden', 'only the shared group owner may edit its roster')
      requireBotAccess(memberships, botIds, principalId, 'write-group')
      const bots = await this.activeBots(botIds, signal)
      if (group.name === name && sameIdSet(group.botIds, botIds)) return { snapshot, value: { group: groupView(group, bots) } }
      const now = Math.max(this.now(), group.updatedAt + 1)
      const nextGroup: SharedGroupRecord = {
        ...group,
        name,
        botIds,
        updatedAt: now,
        revision: snapshot.revision + 1,
      }
      const retainedSessions = snapshot.sessions.map((session) => {
        if (session.groupId !== group.id) return session
        if (botIds.includes(session.botId)) {
          if (session.revokedAt === undefined) return session
          const { revokedAt: _revokedAt, ...active } = session
          return {
            ...active,
            sessionId: SessionId(`shared-session-group-${randomUUID()}`),
            createdAt: now,
            updatedAt: now,
          }
        }
        if (session.revokedAt !== undefined) return session
        return { ...session, revokedAt: Math.max(now, session.updatedAt), updatedAt: now }
      })
      const addedSessions = botIds
        .filter(
          botId => !retainedSessions.some(
            session => session.groupId === group.id && session.botId === botId && session.revokedAt === undefined,
          ),
        )
        .map((botId): SharedGroupSessionBinding => ({
          groupId: group.id,
          botId,
          sessionId: SessionId(`shared-session-group-${randomUUID()}`),
          botName: bots.find(bot => bot.id === botId)?.name,
          createdAt: now,
          updatedAt: now,
        }))
      const removedBotIds = new Set(group.botIds.filter(botId => !botIds.includes(botId)).map(String))
      const removedDeliveries = snapshot.deliveries.map((delivery) => {
        if (delivery.groupId !== group.id || !removedBotIds.has(String(delivery.botId))
          || (delivery.status !== 'pending' && delivery.status !== 'accepted')) return delivery
        return withoutDispatchLease({
          ...delivery,
          status: 'failed' as const,
          error: 'Shared Bot group Bot was removed from the roster',
          updatedAt: now,
        })
      })
      const removedDeliveryIds = new Set(removedDeliveries
        .filter((delivery, index) => delivery !== snapshot.deliveries[index])
        .map(delivery => delivery.id))
      const next = {
        ...snapshot,
        revision: snapshot.revision + 1,
        groups: snapshot.groups.map(candidate => candidate.id === group.id ? nextGroup : candidate),
        sessions: [...retainedSessions, ...addedSessions],
        deliveries: removedDeliveries,
        responseReservations: snapshot.responseReservations.filter(id => !removedDeliveryIds.has(id)),
      }
      return { snapshot: next, value: { group: groupView(nextGroup, bots) } }
    })
    this.host.registerSharedGroupSessions?.(result.snapshot.sessions.filter(session => session.revokedAt === undefined))
    return result.value
  }

  /** Read one shared-group transcript, never the owner-local group domain. */
  async inspect(
    groupId: ReturnType<typeof BotGroupId>,
    principalId: ReturnType<typeof BotPrincipalId>,
    signal: AbortSignal,
  ): Promise<BotGroupInspectValue> {
    this.requireIsolatedHost()
    const result = await this.locked(principalId, 'read-group', signal, async (snapshot, memberships) => {
      const group = findGroup(snapshot, groupId)
      requireGroupAccess(group, memberships, principalId, 'read-group')
      const bots = await this.activeBots(group.botIds, signal)
      const messages = snapshot.messages
        .filter(message => message.groupId === group.id)
        .sort((left, right) => left.createdAt - right.createdAt || String(left.id).localeCompare(String(right.id)))
        .map(message => messageView(message, bots))
      const messageIds = new Set(messages.map(message => String(message.id)))
      const deliveries: BotGroupDeliveryStatusView[] = snapshot.deliveries
        .filter(delivery => delivery.groupId === group.id && messageIds.has(String(delivery.messageId)))
        .sort(
          (left, right) => String(left.messageId).localeCompare(String(right.messageId))
            || String(left.botId).localeCompare(String(right.botId)),
        )
        .map(delivery => ({
          messageId: delivery.messageId,
          botId: delivery.botId,
          status: delivery.status,
          ...(delivery.error === undefined ? {} : { error: delivery.error }),
        }))
      return { snapshot, value: { group: groupView(group, bots), messages, deliveries } }
    })
    return result.value
  }

  /** Persist one principal-authored shared-group message, then deliver outside the authority lock. */
  async send(
    request: BotGroupSendRemoteRequest,
    principalId: ReturnType<typeof BotPrincipalId>,
    signal: AbortSignal,
  ): Promise<BotGroupSendValue> {
    this.requireIsolatedHost()
    const text = normalizeText(request.text, 'Bot group message', MAX_MESSAGE_TEXT)
    const groupId = normalizeGroupId(request.groupId)
    const messageId = request.messageId === undefined
      ? BotGroupMessageId(`bot-group-message-${randomUUID()}`)
      : normalizeMessageId(request.messageId)
    const result = await this.locked(principalId, 'write-group', signal, async (snapshot, memberships) => {
      const group = findGroup(snapshot, groupId)
      requireGroupAccess(group, memberships, principalId, 'write-group')
      const targetBotIds = requestedRecipients(group, request.targetBotIds)
      const existing = snapshot.messages.find(message => message.id === messageId)
      if (existing !== undefined) {
        if (existing.groupId !== group.id || existing.text !== text
          || existing.sender.kind !== 'user' || String(existing.sender.principalId ?? '') !== String(principalId)
          || !sameIdSet(existing.targetBotIds ?? group.botIds, targetBotIds)) {
          throw new SharedGroupError('gateway/conflict', `shared Bot group message "${String(messageId)}" already exists with different content`)
        }
      }
      if (existing === undefined && snapshot.messages.length >= MAX_SHARED_GROUP_MESSAGES) {
        throw new SharedGroupError('gateway/unavailable', 'shared Bot group transcript capacity is exhausted')
      }
      let messages = snapshot.messages
      let deliveries = snapshot.deliveries
      let responseReservations = snapshot.responseReservations
      let changed = false
      let newDeliveryCount = 0
      let newResponseReservationCount = 0
      const bindings = new Map<string, SharedGroupSessionBinding>()
      const attempts: SharedGroupDeliveryPlan[] = []
      const failedRows = new Map<string, SharedGroupDeliveryRecord>()
      const outcomes = new Map<string, BotGroupDeliveryView>()

      for (const botId of targetBotIds) {
        const deliveryId = deliveryKey(messageId, botId)
        const current = snapshot.deliveries.find(delivery => delivery.id === deliveryId)
        if (current?.status === 'responded') {
          outcomes.set(String(botId), { botId, status: 'duplicate' })
          continue
        }
        if (current?.status === 'accepted') {
          outcomes.set(String(botId), { botId, status: 'duplicate' })
          if (!snapshot.responseReservations.includes(deliveryId)) newResponseReservationCount += 1
          continue
        }
        const binding = snapshot.sessions.find(
          session => session.groupId === group.id && session.botId === botId && session.revokedAt === undefined,
        )
        if (binding === undefined) {
          if (current === undefined) newDeliveryCount += 1
          failedRows.set(deliveryId, {
            id: deliveryId,
            groupId: group.id,
            messageId,
            botId,
            status: 'failed',
            error: 'Shared Bot group Session is unavailable',
            authorizationRevision: group.revision,
            senderPrincipalId: principalId,
            updatedAt: this.now(),
          })
          outcomes.set(String(botId), { botId, status: 'failed', error: 'Shared Bot group Session is unavailable' })
          continue
        }
        bindings.set(String(botId), binding)
        if (current === undefined) newDeliveryCount += 1
        if (!snapshot.responseReservations.includes(deliveryId)) newResponseReservationCount += 1
        attempts.push({ botId, sessionId: binding.sessionId, deliveryId })
      }
      if (snapshot.deliveries.length + newDeliveryCount > MAX_SHARED_GROUP_DELIVERIES) {
        throw new SharedGroupError('gateway/unavailable', 'shared Bot group delivery capacity is exhausted')
      }
      if (snapshot.messages.length + (existing === undefined ? 1 : 0)
        + snapshot.responseReservations.length + newResponseReservationCount > MAX_SHARED_GROUP_MESSAGES) {
        throw new SharedGroupError('gateway/unavailable', 'shared Bot group response capacity is exhausted')
      }
      if (existing === undefined) {
        const message: BotGroupMessageRecord = {
          id: messageId,
          groupId: group.id,
          sender: { kind: 'user', principalId },
          text,
          targetBotIds,
          createdAt: this.now(),
        }
        messages = [...messages, message]
        changed = true
      }
      for (const botId of targetBotIds) {
        const deliveryId = deliveryKey(messageId, botId)
        const current = deliveries.find(delivery => delivery.id === deliveryId)
        if (current?.status === 'responded') continue
        if (current?.status === 'accepted') {
          if (!responseReservations.includes(deliveryId)) {
            responseReservations = [...responseReservations, deliveryId]
            changed = true
          }
          changed = true
          continue
        }
        const failed = failedRows.get(deliveryId)
        if (failed !== undefined) {
          deliveries = putDelivery(deliveries, failed)
          responseReservations = responseReservations.filter(id => id !== deliveryId)
          changed = true
          continue
        }
        const binding = bindings.get(String(botId))
        if (binding === undefined) continue
        const pending: SharedGroupDeliveryRecord = {
          id: deliveryId,
          groupId: group.id,
          messageId,
          botId,
          status: 'pending',
          authorizationRevision: group.revision,
          senderPrincipalId: principalId,
          updatedAt: this.now(),
          ...(current?.claim === undefined ? {} : { claim: current.claim }),
          ...(current?.dispatchToken === undefined ? {} : { dispatchToken: current.dispatchToken }),
          ...(current?.dispatchLeaseUntil === undefined ? {} : { dispatchLeaseUntil: current.dispatchLeaseUntil }),
        }
        deliveries = putDelivery(deliveries, pending)
        if (!responseReservations.includes(deliveryId)) responseReservations = [...responseReservations, deliveryId]
        changed = true
      }
      const nextGroup = changed ? { ...group, updatedAt: Math.max(this.now(), group.updatedAt), revision: snapshot.revision + 1 } : group
      const next: SharedGroupSnapshot = {
        ...snapshot,
        revision: changed ? snapshot.revision + 1 : snapshot.revision,
        groups: changed ? snapshot.groups.map(candidate => candidate.id === group.id ? nextGroup : candidate) : snapshot.groups,
        messages,
        deliveries,
        responseReservations,
      }
      return {
        snapshot: next,
        value: {
          plan: {
            groupId: group.id,
            groupName: group.name,
            text,
            messageId,
            targetBotIds,
            attempts,
            outcomes,
            senderPrincipalId: principalId,
          },
        },
      }
    })
    this.host.registerSharedGroupSessions?.(result.snapshot.sessions.filter(session => session.revokedAt === undefined))
    const { plan } = result.value
    const outcomes = new Map(plan.outcomes)
    for (const attempt of plan.attempts) {
      const binding = result.snapshot.sessions.find(session => session.sessionId === attempt.sessionId)
      if (binding === undefined) {
        const error = 'Shared Bot group Session is unavailable'
        outcomes.set(String(attempt.botId), { botId: attempt.botId, status: 'failed', error })
        await this.recordDeliveryOutcome(attempt.deliveryId, undefined, 'failed', error)
        continue
      }
      const dispatch = await this.dispatchDelivery(plan, attempt, binding, signal)
      if (dispatch.kind === 'duplicate') {
        outcomes.set(String(attempt.botId), { botId: attempt.botId, status: 'duplicate' })
      } else if (dispatch.kind === 'accepted') {
        outcomes.set(String(attempt.botId), { botId: attempt.botId, status: dispatch.result })
      } else {
        outcomes.set(String(attempt.botId), { botId: attempt.botId, status: 'failed', error: dispatch.error })
      }
    }
    const ordered = plan.targetBotIds.flatMap((botId) => {
      const outcome = outcomes.get(String(botId))
      return outcome === undefined ? [] : [outcome]
    })
    const status: BotGroupSendValue['status'] = ordered.some(outcome => outcome.status === 'failed')
      ? 'partial'
      : ordered.some(outcome => outcome.status === 'accepted') ? 'accepted' : 'duplicate'
    return { messageId: plan.messageId, status, deliveries: ordered }
  }

  /** Create one explicit group ACL invitation. */
  async createInvite(
    groupId: ReturnType<typeof BotGroupId>,
    principalId: ReturnType<typeof BotPrincipalId>,
  ): Promise<{ readonly code: SharedInviteCode; readonly expiresAt: number }> {
    this.requireIsolatedHost()
    const invite = await this.authority.createInviteIf((_state, extensions) => {
      const snapshot = parseMembershipExtension(extensions['agent-bots/shared-memberships'])
      const groups = parseGroups(snapshot.sharedGroups)
      const group = findGroup(groups, groupId)
      if (group.ownerPrincipalId !== principalId) throw new SharedGroupError('gateway/forbidden', 'only the shared group owner may invite members')
      requireBotAccess(snapshot.memberships, group.botIds, principalId, 'write-group')
      if (pruneExpiredInvites(groups.invites, this.now()).length >= MAX_SHARED_GROUP_INVITES) {
        throw new SharedGroupError('gateway/unavailable', 'shared group invitation capacity is exhausted')
      }
    })
    try {
      await this.authority.mutateExtension('agent-bots/shared-memberships', (current) => {
        const snapshot = parseMembershipExtension(current)
        const groups = parseGroups(snapshot.sharedGroups)
        const group = groups.groups.find(candidate => candidate.id === groupId)
        if (group === undefined || group.ownerPrincipalId !== principalId) throw new SharedGroupError('gateway/conflict', 'shared Bot group changed before its invite was stored')
        requireBotAccess(snapshot.memberships, group.botIds, principalId, 'write-group')
        const now = this.now()
        const invites = pruneExpiredInvites(groups.invites, now)
        if (invites.length >= MAX_SHARED_GROUP_INVITES) throw new SharedGroupError('gateway/unavailable', 'shared group invitation capacity is exhausted')
        const next: SharedGroupSnapshot = {
          ...groups,
          revision: groups.revision + 1,
          invites: [...invites, {
            digest: sharedInviteDigest(invite.code),
            groupId,
            createdBy: principalId,
            createdAt: now,
            expiresAt: invite.expiresAt,
          }],
        }
        return { value: undefined, next: { ...snapshot, [SHARED_GROUPS_FIELD]: next } }
      })
    } catch (error) {
      await this.authority.cancelInvite(invite.code).catch(() => undefined)
      throw error
    }
    return invite
  }

  /** Redeem a group invite and add the authenticated principal to its ACL. */
  async redeemInvite(
    code: SharedInviteCode,
    request: ConnectionTrustRequest,
  ): Promise<SharedAccessEnrollment & { readonly groupId: ReturnType<typeof BotGroupId> }> {
    this.requireIsolatedHost()
    const admitted = await this.authority.admit(request)
    if (!('peer' in admitted)) throw new SharedGroupError('gateway/forbidden', 'an active shared Bot membership is required before redeeming a group invite')
    const admittedPrincipal = sharedPrincipalOf(admitted.peer)
    if (admittedPrincipal === undefined) throw new SharedGroupError('gateway/forbidden', 'an active shared Bot membership is required before redeeming a group invite')
    const admittedPrincipalId = BotPrincipalId(String(admittedPrincipal))
    const digest = sharedInviteDigest(code)
    const before = await this.authority.readExtension('agent-bots/shared-memberships')
    const beforeSnapshot = parseMembershipExtension(before.value)
    const pending = parseGroups(beforeSnapshot.sharedGroups).invites.find(invite => invite.digest === digest)
    if (pending === undefined || this.now() >= pending.expiresAt) {
      throw new SharedGroupError('gateway/bad-request', 'shared group invite is invalid or expired')
    }
    const pendingGroups = parseGroups(beforeSnapshot.sharedGroups)
    const pendingGroup = findGroup(pendingGroups, pending.groupId)
    requireBotAccess(beforeSnapshot.memberships, pendingGroup.botIds, admittedPrincipalId, 'read-group')
    if (!pendingGroup.memberPrincipalIds.some(member => String(member) === String(admittedPrincipalId))
      && pendingGroup.memberPrincipalIds.length >= 256) {
      throw new SharedGroupError('gateway/unavailable', 'shared group member capacity is exhausted')
    }
    const enrollment = await this.authority.redeemInvite(code, request).catch(() => {
      throw new SharedGroupError('gateway/bad-request', 'shared group invite is invalid or expired')
    })
    const principalId = BotPrincipalId(String(enrollment.principalId))
    if (principalId !== admittedPrincipalId) throw new SharedGroupError('gateway/forbidden', 'shared group invite principal changed during redemption')
    try {
      await this.authority.mutateExtension('agent-bots/shared-memberships', (current, state) => {
        const snapshot = parseMembershipExtension(current)
        const groups = parseGroups(snapshot.sharedGroups)
        const group = groups.groups.find(candidate => candidate.id === pending.groupId)
        const authorityPrincipal = state.principals.find(candidate => String(candidate.id) === String(principalId))
        if (group === undefined || authorityPrincipal === undefined || authorityPrincipal.revokedAt !== undefined) {
          throw new SharedGroupError('gateway/forbidden', 'shared group is no longer available')
        }
        requireBotAccess(snapshot.memberships, group.botIds, principalId, 'read-group')
        const now = this.now()
        const currentInvite = groups.invites.find(invite => invite.digest === digest)
        if (currentInvite === undefined || now >= currentInvite.expiresAt) {
          throw new SharedGroupError('gateway/bad-request', 'shared group invite is invalid or expired')
        }
        const invites = pruneExpiredInvites(groups.invites, now).filter(invite => invite.digest !== digest)
        if (!group.memberPrincipalIds.some(member => String(member) === String(principalId))) {
          if (group.memberPrincipalIds.length >= 256) throw new SharedGroupError('gateway/unavailable', 'shared group member capacity is exhausted')
          const nextGroup = {
            ...group,
            memberPrincipalIds: [...group.memberPrincipalIds, principalId],
            updatedAt: Math.max(now, group.updatedAt),
            revision: groups.revision + 1,
          }
          return {
            value: undefined,
            next: {
              ...snapshot,
              [SHARED_GROUPS_FIELD]: {
                ...groups,
                revision: groups.revision + 1,
                groups: groups.groups.map(candidate => candidate.id === group.id ? nextGroup : candidate),
                invites,
              },
            },
          }
        }
        return {
          value: undefined,
          next: {
            ...snapshot,
            [SHARED_GROUPS_FIELD]: {
              ...groups,
              revision: groups.revision + 1,
              invites,
            },
          },
        }
      })
    } catch (error) {
      throw error
    }
    return { ...enrollment, groupId: pending.groupId }
  }

  /** Remove one explicit ACL member without changing the Bot memberships. */
  async revokeMember(
    groupId: ReturnType<typeof BotGroupId>,
    principalId: ReturnType<typeof BotPrincipalId>,
    actor: ReturnType<typeof BotPrincipalId>,
    signal: AbortSignal,
  ): Promise<{
    readonly groupId: ReturnType<typeof BotGroupId>
    readonly principalId: ReturnType<typeof BotPrincipalId>
    readonly revoked: true
  }> {
    const result = await this.locked(actor, 'write-group', signal, (snapshot, memberships) => {
      const group = findGroup(snapshot, groupId)
      requireGroupAccess(group, memberships, actor, 'write-group')
      if (group.ownerPrincipalId !== actor) throw new SharedGroupError('gateway/forbidden', 'only the shared group owner may revoke members')
      if (principalId === group.ownerPrincipalId) throw new SharedGroupError('gateway/forbidden', 'the shared group owner cannot be revoked')
      if (!group.memberPrincipalIds.some(member => member === principalId)) throw new SharedGroupError('gateway/not-found', 'shared group member was not found')
      const now = Math.max(this.now(), group.updatedAt + 1)
      const nextGroup = {
        ...group,
        memberPrincipalIds: group.memberPrincipalIds.filter(member => member !== principalId),
        updatedAt: now,
        revision: snapshot.revision + 1,
      }
      const deliveries = snapshot.deliveries.map(delivery => delivery.groupId === group.id && delivery.senderPrincipalId === principalId
        && (delivery.status === 'pending' || delivery.status === 'accepted')
        ? withoutDispatchLease({ ...delivery, status: 'failed' as const, error: 'Shared group membership was revoked', updatedAt: now })
        : delivery)
      const failedIds = new Set(deliveries
        .filter((delivery, index) => delivery !== snapshot.deliveries[index] && delivery.status === 'failed')
        .map(delivery => delivery.id))
      return {
        snapshot: {
          ...snapshot,
          revision: snapshot.revision + 1,
          groups: snapshot.groups.map(candidate => candidate.id === group.id ? nextGroup : candidate),
          deliveries,
          responseReservations: snapshot.responseReservations.filter(id => !failedIds.has(id)),
        },
        value: { groupId, principalId, revoked: true as const },
      }
    })
    return result.value
  }

  /** Record the exact model step that claimed a shared-group delivery. */
  async recordBotMessageClaims(
    groupId: ReturnType<typeof BotGroupId>,
    botId: BotId,
    claims: readonly BotGroupDeliveryClaimInput[],
    turn: number,
    step: number,
    isolated: boolean,
    competingInput: boolean,
  ): Promise<void> {
    await this.mutateWithoutActor((snapshot) => {
      if (!Number.isSafeInteger(turn) || turn < 0 || !Number.isSafeInteger(step) || step < 0) return snapshot
      const now = this.now()
      let deliveries = snapshot.deliveries
      let changed = false
      if (competingInput) {
        deliveries = deliveries.map(delivery => delivery.groupId === groupId && delivery.botId === botId
          && delivery.claim?.turn === turn && delivery.claim.isolated
          ? { ...delivery, claim: { ...delivery.claim, isolated: false }, updatedAt: now }
          : delivery)
        changed = deliveries.some((delivery, index) => delivery !== snapshot.deliveries[index])
      }
      for (const claim of claims) {
        const delivery = deliveries.find(
          candidate => candidate.groupId === claim.groupId
            && candidate.messageId === claim.messageId
            && candidate.botId === botId,
        )
        if (delivery === undefined || (delivery.status !== 'pending' && delivery.status !== 'accepted' && delivery.status !== 'responded')) continue
        const nextClaim: BotGroupDeliveryClaim = { turn, step, isolated }
        if (delivery.claim?.turn === turn && delivery.claim.step === step && delivery.claim.isolated === isolated) continue
        deliveries = putDelivery(deliveries, { ...delivery, claim: nextClaim, updatedAt: now })
        changed = true
      }
      const sameTurn = deliveries.filter(delivery => delivery.groupId === groupId && delivery.botId === botId
        && delivery.claim?.turn === turn && delivery.claim.isolated)
      if (sameTurn.length > 1) {
        for (const delivery of sameTurn) {
          const claim = delivery.claim
          if (claim === undefined) continue
          deliveries = putDelivery(deliveries, { ...delivery, claim: { ...claim, isolated: false }, updatedAt: now })
        }
        changed = true
      }
      return changed ? { ...snapshot, deliveries, revision: snapshot.revision + 1 } : snapshot
    })
  }

  /** Record a visible Bot response against one exact isolated group turn. */
  async recordBotResponse(
    groupId: ReturnType<typeof BotGroupId>,
    botId: BotId,
    turn: number,
    step: number,
    text: string,
    sourceMessageId: string,
  ): Promise<void> {
    const messageText = normalizeText(text, 'Bot group response', MAX_MESSAGE_TEXT)
    await this.mutateWithoutActor((snapshot) => {
      if (!Number.isSafeInteger(turn) || turn < 0 || !Number.isSafeInteger(step) || step < 0) return snapshot
      const candidates = snapshot.deliveries.filter(delivery => delivery.groupId === groupId && delivery.botId === botId
        && (delivery.status === 'pending' || delivery.status === 'accepted')
        && delivery.claim?.turn === turn && delivery.claim.isolated && delivery.claim.step <= step)
      if (candidates.length !== 1) return snapshot
      const pending = candidates[0]
      if (pending === undefined) return snapshot
      const responseId = responseMessageId(groupId, botId, sourceMessageId)
      const now = Math.max(this.now(), snapshot.messages.find(message => message.id === pending.messageId)?.createdAt ?? 0)
      const hasResponse = snapshot.messages.some(message => message.id === responseId)
      if (!hasResponse && snapshot.messages.length >= MAX_SHARED_GROUP_MESSAGES) {
        return {
          ...snapshot,
          revision: snapshot.revision + 1,
          deliveries: putDelivery(snapshot.deliveries, withoutDispatchLease({
            ...pending,
            status: 'failed',
            error: 'Shared Bot group transcript capacity is exhausted',
            updatedAt: now,
          })),
          responseReservations: snapshot.responseReservations.filter(id => id !== pending.id),
        }
      }
      const senderName = snapshot.sessions.find(session => session.groupId === groupId && session.botId === botId)?.botName
      const messages = hasResponse
        ? snapshot.messages
        : [...snapshot.messages, {
          id: responseId,
          groupId,
          sender: { kind: 'bot', botId },
          ...(senderName === undefined ? {} : { senderName }),
          text: messageText,
          createdAt: now,
        } satisfies BotGroupMessageRecord]
      return {
        ...snapshot,
        revision: snapshot.revision + 1,
        messages,
        deliveries: putDelivery(snapshot.deliveries, withoutDispatchLease({ ...pending, status: 'responded', responseMessageId: responseId, updatedAt: now })),
        responseReservations: snapshot.responseReservations.filter(id => id !== pending.id),
      }
    })
  }

  /** Record a safe failure for one isolated shared-group turn. */
  async recordBotTurnFailure(
    groupId: ReturnType<typeof BotGroupId>,
    botId: BotId,
    turn: number,
    error: string,
  ): Promise<void> {
    const safeError = normalizeText(error, 'Bot group failure', 400)
    await this.mutateWithoutActor((snapshot) => {
      if (!Number.isSafeInteger(turn) || turn < 0) return snapshot
      const now = this.now()
      const deliveries = snapshot.deliveries.map((delivery) => {
        if (delivery.groupId !== groupId || delivery.botId !== botId || (delivery.status !== 'pending' && delivery.status !== 'accepted')
          || delivery.claim?.turn !== turn || !delivery.claim.isolated) return delivery
        return withoutDispatchLease({ ...delivery, status: 'failed' as const, error: safeError, updatedAt: now })
      })
      if (!deliveries.some((delivery, index) => delivery !== snapshot.deliveries[index])) return snapshot
      const failedIds = new Set(deliveries
        .filter((delivery, index) => delivery !== snapshot.deliveries[index] && delivery.status === 'failed')
        .map(delivery => delivery.id))
      return {
        ...snapshot,
        deliveries,
        responseReservations: snapshot.responseReservations.filter(id => !failedIds.has(id)),
        revision: snapshot.revision + 1,
      }
    })
  }

  private async dispatchDelivery(
    plan: SharedGroupSendPlan,
    attempt: SharedGroupDeliveryPlan,
    binding: SharedGroupSessionBinding | undefined,
    signal?: AbortSignal,
  ): Promise<SharedGroupDeliveryDispatch> {
    const claim = await this.claimDelivery(plan, attempt)
    if (claim.kind === 'duplicate') return claim
    if (claim.kind === 'busy') return {
      kind: 'busy',
      error: 'Shared Bot group delivery is already in progress',
      leaseUntil: claim.leaseUntil,
    }
    if (claim.kind === 'denied') {
      const error = 'Shared Bot group authorization changed before delivery'
      return { kind: 'failed', error }
    }
    if (binding === undefined) {
      const error = 'Shared Bot group Session is unavailable'
      await this.recordDeliveryOutcome(attempt.deliveryId, claim.token, 'failed', error)
      return { kind: 'failed', error }
    }
    const stopLeaseRenewal = this.startDeliveryLeaseRenewal(attempt.deliveryId, claim.token)
    try {
      const deliverSharedGroup = this.host.deliverSharedGroup
      if (deliverSharedGroup === undefined) throw new SharedGroupError('gateway/unavailable', 'shared Bot group delivery is unavailable without an isolated Session')
      const deliveryResult = await deliverSharedGroup({
        groupId: plan.groupId,
        groupName: plan.groupName,
        targetBotId: attempt.botId,
        sessionId: binding.sessionId,
        text: plan.text,
        messageId: plan.messageId,
        ...(signal === undefined ? {} : { signal }),
      })
      await this.recordDeliveryOutcome(attempt.deliveryId, claim.token, 'accepted')
      return { kind: 'accepted', result: deliveryResult }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      const safeError = detail.trim().slice(0, 400) || 'Bot delivery failed'
      await this.recordDeliveryOutcome(attempt.deliveryId, claim.token, 'failed', safeError)
      return { kind: 'failed', error: safeError }
    } finally {
      await stopLeaseRenewal()
    }
  }

  private async recordDeliveryOutcome(
    deliveryId: string,
    dispatchToken: string | undefined,
    status: 'accepted' | 'failed',
    error?: string,
  ): Promise<void> {
    await this.mutateWithoutActor((snapshot) => {
      const current = snapshot.deliveries.find(delivery => delivery.id === deliveryId)
      if (current === undefined) return snapshot
      if (dispatchToken === undefined
        ? current.dispatchToken !== undefined
        : current.dispatchToken !== dispatchToken) return snapshot
      if (status === 'failed' && current.status !== 'pending') return snapshot
      if (status === 'accepted' && current.status !== 'pending') return snapshot
      const now = this.now()
      const nextDelivery = withoutDispatchLease({
        ...current,
        status,
        ...(error === undefined ? {} : { error }),
        updatedAt: now,
      })
      return {
        ...snapshot,
        revision: snapshot.revision + 1,
        deliveries: putDelivery(snapshot.deliveries, nextDelivery),
        ...(status === 'failed'
          ? { responseReservations: snapshot.responseReservations.filter(id => id !== deliveryId) }
          : {}),
      }
    })
  }

  private async failPendingDelivery(deliveryId: string, error: string): Promise<void> {
    await this.mutateWithoutActor((snapshot) => {
      const current = snapshot.deliveries.find(delivery => delivery.id === deliveryId)
      if (current === undefined || current.status !== 'pending') return snapshot
      return {
        ...snapshot,
        revision: snapshot.revision + 1,
        deliveries: putDelivery(snapshot.deliveries, withoutDispatchLease({
          ...current,
          status: 'failed',
          error,
          updatedAt: this.now(),
        })),
        responseReservations: snapshot.responseReservations.filter(id => id !== deliveryId),
      }
    })
  }

  private async claimDelivery(
    plan: SharedGroupSendPlan,
    attempt: SharedGroupDeliveryPlan,
  ): Promise<SharedGroupDeliveryClaimResult> {
    return this.authority.mutateExtension<SharedGroupDeliveryClaimResult>(
      'agent-bots/shared-memberships',
      (current, authorityState) => {
        const membershipSnapshot = parseMembershipExtension(current)
        const groups = parseGroups(membershipSnapshot.sharedGroups)
        const group = groups.groups.find(candidate => candidate.id === plan.groupId)
        const delivery = groups.deliveries.find(candidate => candidate.id === attempt.deliveryId)
        if (group === undefined || delivery === undefined) return { value: { kind: 'denied' }, next: current }
        if (delivery.status === 'accepted' || delivery.status === 'responded') {
          return { value: { kind: 'duplicate' }, next: current }
        }
        if (delivery.status !== 'pending' || !groups.responseReservations.includes(delivery.id)) {
          return { value: { kind: 'denied' }, next: current }
        }
        const authorized = group.memberPrincipalIds.some(member => String(member) === String(plan.senderPrincipalId))
          && delivery.senderPrincipalId === plan.senderPrincipalId
          && hasActiveSharedPrincipal(authorityState, membershipSnapshot.memberships, group, plan.senderPrincipalId)
          && group.botIds.includes(attempt.botId)
          && groups.sessions.some(session => session.groupId === group.id
            && session.botId === attempt.botId && session.sessionId === attempt.sessionId && session.revokedAt === undefined)
        if (!authorized) {
          if (delivery.status !== 'pending') return { value: { kind: 'denied' }, next: current }
          const failed = withoutDispatchLease({
            ...delivery,
            status: 'failed' as const,
            error: 'Shared Bot group authorization changed before delivery',
            updatedAt: this.now(),
          })
          const nextGroups = {
            ...groups,
            revision: groups.revision + 1,
            deliveries: putDelivery(groups.deliveries, failed),
            responseReservations: groups.responseReservations.filter(id => id !== delivery.id),
          }
          return {
            value: { kind: 'denied' },
            next: { ...membershipSnapshot, [SHARED_GROUPS_FIELD]: validateSnapshot(nextGroups) },
          }
        }
        const now = this.now()
        if (delivery.dispatchLeaseUntil !== undefined && delivery.dispatchLeaseUntil > now) {
          return { value: { kind: 'busy', leaseUntil: delivery.dispatchLeaseUntil }, next: current }
        }
        const token = `shared-group-dispatch-${randomUUID()}`
        const claimed: SharedGroupDeliveryRecord = {
          ...delivery,
          status: 'pending',
          dispatchToken: token,
          dispatchLeaseUntil: now + SHARED_GROUP_DELIVERY_LEASE_MS,
          updatedAt: now,
        }
        const nextGroups = {
          ...groups,
          revision: groups.revision + 1,
          deliveries: putDelivery(groups.deliveries, claimed),
        }
        return {
          value: { kind: 'authorized', token },
          next: { ...membershipSnapshot, [SHARED_GROUPS_FIELD]: validateSnapshot(nextGroups) },
        }
      },
    )
  }

  private startDeliveryLeaseRenewal(deliveryId: string, dispatchToken: string): () => Promise<void> {
    let inFlight: Promise<void> | undefined
    const timer = setInterval(() => {
      if (inFlight !== undefined) return
      inFlight = this.renewDeliveryClaim(deliveryId, dispatchToken)
        .then(() => undefined, () => undefined)
        .finally(() => { inFlight = undefined })
    }, Math.max(1, Math.floor(SHARED_GROUP_DELIVERY_LEASE_MS / 3)))
    timer.unref?.()
    return async () => {
      clearInterval(timer)
      await inFlight
    }
  }

  private async renewDeliveryClaim(deliveryId: string, dispatchToken: string): Promise<void> {
    await this.authority.mutateExtension('agent-bots/shared-memberships', (current) => {
      const membershipSnapshot = parseMembershipExtension(current)
      const groups = parseGroups(membershipSnapshot.sharedGroups)
      const delivery = groups.deliveries.find(candidate => candidate.id === deliveryId)
      if (delivery === undefined || delivery.status !== 'pending' || delivery.dispatchToken !== dispatchToken) {
        return { value: undefined, next: current }
      }
      const now = this.now()
      const nextGroups = {
        ...groups,
        revision: groups.revision + 1,
        deliveries: putDelivery(groups.deliveries, {
          ...delivery,
          dispatchLeaseUntil: now + SHARED_GROUP_DELIVERY_LEASE_MS,
          updatedAt: Math.max(now, delivery.updatedAt),
        }),
      }
      return {
        value: undefined,
        next: { ...membershipSnapshot, [SHARED_GROUPS_FIELD]: validateSnapshot(nextGroups) },
      }
    })
  }

  private schedulePendingRecovery(deliveryId: string, delayMs: number): void {
    if (this.stopped) return
    const timer = setTimeout(() => {
      this.recoveryTimers.delete(timer)
      const task = this.recoverPendingDelivery(deliveryId)
      this.recoveryTasks.add(task)
      void task.then(
        () => { this.recoveryTasks.delete(task) },
        () => { this.recoveryTasks.delete(task) },
      )
    }, Math.max(1, delayMs))
    timer.unref?.()
    this.recoveryTimers.add(timer)
  }

  private scheduleRecoverySweep(): void {
    if (this.stopped || this.recoverySweepTimer !== undefined) return
    const timer = setTimeout(() => {
      this.recoverySweepTimer = undefined
      const task = this.recoverPendingDeliveries(this.recoveryController.signal)
      this.recoveryTasks.add(task)
      void task.then(
        () => { this.recoveryTasks.delete(task) },
        () => { this.recoveryTasks.delete(task) },
      )
    }, 1)
    timer.unref?.()
    this.recoverySweepTimer = timer
  }

  private async recoverPendingDelivery(deliveryId: string, signal = this.recoveryController.signal): Promise<void> {
    if (this.stopped || signal.aborted) return
    const extension = await this.authority.readExtension('agent-bots/shared-memberships')
    const snapshot = parseGroups(parseMembershipExtension(extension.value).sharedGroups)
    const delivery = snapshot.deliveries.find(candidate => candidate.id === deliveryId)
    if (delivery === undefined || delivery.status !== 'pending') return
    const group = snapshot.groups.find(candidate => candidate.id === delivery.groupId)
    const message = snapshot.messages.find(candidate => candidate.id === delivery.messageId)
    const binding = snapshot.sessions.find(candidate => candidate.groupId === delivery.groupId
      && candidate.botId === delivery.botId && candidate.revokedAt === undefined)
    if (group === undefined || message === undefined || binding === undefined || message.sender.kind !== 'user') {
      await this.failPendingDelivery(delivery.id, 'Shared Bot group Session is unavailable')
      return
    }
    const plan: SharedGroupSendPlan = {
      groupId: group.id,
      groupName: group.name,
      text: message.text,
      messageId: message.id,
      targetBotIds: [delivery.botId],
      attempts: [{ botId: delivery.botId, sessionId: binding.sessionId, deliveryId: delivery.id }],
      outcomes: new Map(),
      senderPrincipalId: delivery.senderPrincipalId,
    }
    const attempt = plan.attempts[0]
    if (attempt === undefined) return
    const timeout = AbortSignal.timeout(SHARED_GROUP_RECOVERY_TIMEOUT_MS)
    const dispatchSignal = AbortSignal.any([signal, this.recoveryController.signal, timeout])
    const result = await this.dispatchDelivery(plan, attempt, binding, dispatchSignal)
    if (result.kind === 'busy') this.schedulePendingRecovery(delivery.id, result.leaseUntil - this.now())
  }

  private async locked<T>(
    principalId: ReturnType<typeof BotPrincipalId>,
    operation: BotShareOperation,
    signal: AbortSignal,
    work: (
      snapshot: SharedGroupSnapshot,
      memberships: readonly SharedMembershipRecord[],
    ) => SharedGroupMutationResult<T> | Promise<SharedGroupMutationResult<T>>,
  ): Promise<SharedGroupMutationResult<T>> {
    signal.throwIfAborted()
    void operation
    return this.authority.mutateExtension<SharedGroupMutationResult<T>>('agent-bots/shared-memberships', async (current, authorityState) => {
      const membershipSnapshot = parseMembershipExtension(current)
      const groups = parseGroups(membershipSnapshot.sharedGroups)
      requireActivePrincipal(authorityState, principalId)
      const result = await work(groups, membershipSnapshot.memberships)
      return {
        value: result,
        next: { ...membershipSnapshot, [SHARED_GROUPS_FIELD]: validateSnapshot(result.snapshot) },
      }
    })
  }

  private async mutateWithoutActor(
    work: (snapshot: SharedGroupSnapshot) => SharedGroupSnapshot | Promise<SharedGroupSnapshot>,
  ): Promise<void> {
    await this.authority.mutateExtension('agent-bots/shared-memberships', async (current) => {
      const membershipSnapshot = parseMembershipExtension(current)
      const next = validateSnapshot(await work(parseGroups(membershipSnapshot.sharedGroups)))
      return { value: undefined, next: { ...membershipSnapshot, [SHARED_GROUPS_FIELD]: next } }
    })
  }

  private async activeBots(botIds: readonly BotId[], signal: AbortSignal): Promise<readonly BotView[]> {
    const bots = await this.host.listBots(signal)
    const selected: BotView[] = []
    for (const botId of botIds) {
      const bot = bots.find(candidate => candidate.id === botId)
      if (bot === undefined || bot.state !== 'active') {
        throw new SharedGroupError('gateway/not-found', 'one or more shared group Bots are unavailable')
      }
      selected.push(bot)
    }
    return selected
  }

  private requireIsolatedHost(): void {
    if (this.host.createSharedGroupSession === undefined
      || this.host.resolveSharedGroupAgent === undefined
      || this.host.inspectSharedGroupSession === undefined
      || this.host.flushSharedGroupSession === undefined
      || this.host.registerSharedGroupSessions === undefined
      || this.host.deliverSharedGroup === undefined) {
      throw new SharedGroupError('gateway/unavailable', 'shared Bot group delivery is unavailable without an isolated Session')
    }
  }
}

function parseMembershipExtension(value: unknown): SharedMembershipSnapshot {
  const parsed = sharedMembershipSnapshotSchema.safeParse(value)
  if (!parsed.success) throw new SharedGroupError('gateway/unavailable', 'shared Bot membership state is invalid')
  return parsed.data
}

function parseGroups(value: unknown): SharedGroupSnapshot {
  if (value === undefined) return emptySnapshot()
  const parsed = sharedGroupSnapshotSchema.safeParse(value)
  if (!parsed.success) throw new SharedGroupError('gateway/unavailable', 'shared Bot group state is invalid')
  return parsed.data
}

function validateSnapshot(value: SharedGroupSnapshot): SharedGroupSnapshot {
  const parsed = sharedGroupSnapshotSchema.safeParse(value)
  if (!parsed.success) throw new SharedGroupError('gateway/unavailable', 'shared Bot group limits were exceeded')
  return parsed.data
}

function emptySnapshot(): SharedGroupSnapshot {
  return {
    version: SHARED_GROUPS_VERSION,
    revision: 0,
    groups: [],
    messages: [],
    deliveries: [],
    sessions: [],
    invites: [],
    responseReservations: [],
  }
}

function normalizeGroupId(value: ReturnType<typeof BotGroupId>): ReturnType<typeof BotGroupId> {
  if (typeof value !== 'string' || !/^bot-group-[A-Za-z0-9][A-Za-z0-9-]*$/.test(value)) throw new SharedGroupError('gateway/bad-request', 'invalid shared Bot group id')
  return BotGroupId(value)
}

function normalizeMessageId(value: ReturnType<typeof BotGroupMessageId>): ReturnType<typeof BotGroupMessageId> {
  if (typeof value !== 'string' || !/^bot-group-message-[A-Za-z0-9][A-Za-z0-9-]*$/.test(value)) throw new SharedGroupError('gateway/bad-request', 'invalid shared Bot group message id')
  return BotGroupMessageId(value)
}

function normalizeText(value: string, label: string, max: number): string {
  if (typeof value !== 'string') throw new SharedGroupError('gateway/bad-request', `${label} must be a string`)
  const text = value.trim()
  if (text.length === 0 || Array.from(text).length > max) {
    throw new SharedGroupError('gateway/bad-request', `${label} must contain 1-${String(max)} characters`)
  }
  return text
}

function normalizeBotIds(botIds: readonly BotId[]): BotId[] {
  if (botIds.length < 2 || botIds.length > MAX_GROUP_MEMBERS) throw new SharedGroupError('gateway/bad-request', `a shared Bot group must contain 2-${String(MAX_GROUP_MEMBERS)} Bots`)
  if (new Set(botIds.map(String)).size !== botIds.length) throw new SharedGroupError('gateway/bad-request', 'shared Bot group members must be unique')
  return [...botIds]
}

function pruneExpiredInvites(
  invites: readonly z.infer<typeof sharedGroupInviteSchema>[],
  now: number,
): z.infer<typeof sharedGroupInviteSchema>[] {
  return invites.filter(invite => invite.expiresAt > now)
}

function findGroup(snapshot: SharedGroupSnapshot, groupId: ReturnType<typeof BotGroupId>): SharedGroupRecord {
  const group = snapshot.groups.find(candidate => candidate.id === groupId)
  if (group === undefined) throw new SharedGroupError('gateway/not-found', 'shared Bot group was not found')
  return group
}

function requireActivePrincipal(state: SharedAccessStateSnapshot, principalId: ReturnType<typeof BotPrincipalId>): void {
  const principal = state.principals.find(candidate => String(candidate.id) === String(principalId))
  if (principal === undefined || principal.revokedAt !== undefined) throw new SharedGroupError('gateway/forbidden', 'shared Bot identity is no longer active')
}

function hasActiveSharedPrincipal(
  state: SharedAccessStateSnapshot,
  memberships: readonly SharedMembershipRecord[],
  group: SharedGroupRecord,
  principalId: ReturnType<typeof BotPrincipalId>,
): boolean {
  const principal = state.principals.find(candidate => String(candidate.id) === String(principalId))
  if (principal === undefined || principal.revokedAt !== undefined) return false
  try {
    requireBotAccess(memberships, group.botIds, principalId, 'read-group')
    return true
  } catch (error: unknown) {
    if (error instanceof SharedGroupError && error.code === 'gateway/forbidden') return false
    throw error
  }
}

function requireBotAccess(
  memberships: readonly SharedMembershipRecord[],
  botIds: readonly BotId[],
  principalId: ReturnType<typeof BotPrincipalId>,
  operation: BotShareOperation,
): void {
  for (const botId of botIds) {
    const roster = { botId, memberships: memberships.filter(member => member.botId === botId) }
    const member = roster.memberships.find(candidate => candidate.principalId === principalId)
    if (member === undefined) throw new SharedGroupError('gateway/forbidden', 'shared Bot membership is required for every group Bot')
    if (operation !== 'read-group' && operation !== 'write-group') throw new SharedGroupError('gateway/forbidden', 'shared Bot group operation is not permitted')
    const ownerCount = roster.memberships.filter(candidate => candidate.role === 'owner').length
    if (ownerCount !== 1 || roster.memberships.some(candidate => String(candidate.grantedBy) !== String(roster.memberships.find(owner => owner.role === 'owner')?.principalId))) {
      throw new SharedGroupError('gateway/forbidden', 'shared Bot membership is not valid')
    }
    void member
  }
}

function hasGroupAccess(
  group: SharedGroupRecord,
  memberships: readonly SharedMembershipRecord[],
  principalId: ReturnType<typeof BotPrincipalId>,
  operation: BotShareOperation,
): boolean {
  try {
    requireGroupAccess(group, memberships, principalId, operation)
    return true
  } catch (error: unknown) {
    if (error instanceof SharedGroupError && error.code === 'gateway/forbidden') return false
    throw error
  }
}

function requireGroupAccess(
  group: SharedGroupRecord,
  memberships: readonly SharedMembershipRecord[],
  principalId: ReturnType<typeof BotPrincipalId>,
  operation: BotShareOperation,
): void {
  if (!group.memberPrincipalIds.some(member => String(member) === String(principalId))) throw new SharedGroupError('gateway/forbidden', 'shared Bot group membership is required')
  requireBotAccess(memberships, group.botIds, principalId, operation)
}

function requestedRecipients(group: SharedGroupRecord, requested: readonly BotId[] | undefined): readonly BotId[] {
  if (requested === undefined) return [...group.botIds]
  if (requested.length === 0 || requested.length > MAX_GROUP_MEMBERS || new Set(requested.map(String)).size !== requested.length) throw new SharedGroupError('gateway/bad-request', 'shared Bot group targets are invalid')
  if (requested.some(botId => !group.botIds.includes(botId))) throw new SharedGroupError('gateway/forbidden', 'shared Bot group target is not a member')
  return [...requested]
}

function sameIdSet(left: readonly BotId[], right: readonly BotId[]): boolean {
  return left.length === right.length
    && new Set(left.map(String)).size === new Set(right.map(String)).size
    && left.every(id => right.some(candidate => String(candidate) === String(id)))
}

type SharedGroupRecord = z.infer<typeof sharedGroupRecordSchema>

interface SharedGroupDeliveryPlan {
  readonly botId: BotId
  readonly sessionId: SessionId
  readonly deliveryId: string
}

type SharedGroupDeliveryClaimResult =
  | { readonly kind: 'authorized'; readonly token: string }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'busy'; readonly leaseUntil: number }
  | { readonly kind: 'denied' }

type SharedGroupDeliveryDispatch =
  | { readonly kind: 'accepted'; readonly result: 'accepted' | 'duplicate' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'failed'; readonly error: string }
  | { readonly kind: 'busy'; readonly error: string; readonly leaseUntil: number }

interface SharedGroupSendPlan {
  readonly groupId: BotGroupId
  readonly groupName: string
  readonly text: string
  readonly messageId: BotGroupMessageId
  readonly targetBotIds: readonly BotId[]
  readonly attempts: readonly SharedGroupDeliveryPlan[]
  readonly outcomes: ReadonlyMap<string, BotGroupDeliveryView>
  readonly senderPrincipalId: ReturnType<typeof BotPrincipalId>
}

function groupView(record: SharedGroupRecord, bots: readonly BotView[]): BotGroupView {
  const projected: BotView[] = []
  for (const botId of record.botIds) {
    const bot = bots.find(candidate => candidate.id === botId)
    if (bot === undefined) throw new SharedGroupError('gateway/forbidden', 'shared Bot group membership is no longer valid')
    projected.push(bot)
  }
  return {
    id: record.id,
    name: record.name,
    botIds: record.botIds,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    bots: projected.map(bot => ({
      id: bot.id,
      name: bot.name,
      ...(bot.description === undefined ? {} : { description: bot.description }),
      identity: bot.identity,
      accent: bot.accent,
      ...(bot.avatar === undefined ? {} : { avatar: bot.avatar }),
      availability: bot.availability,
      state: bot.state,
    })),
  }
}

function safeGroupView(record: SharedGroupRecord, bots: readonly BotView[]): BotGroupView | undefined {
  try { return groupView(record, bots) } catch (error: unknown) {
    if (error instanceof SharedGroupError && error.code === 'gateway/forbidden') return undefined
    throw error
  }
}

function messageView(message: BotGroupMessageRecord, bots: readonly BotView[]): BotGroupMessageView {
  const sender = message.sender
  if (sender.kind === 'user') return { ...message, sender }
  const bot = bots.find(candidate => candidate.id === sender.botId)
  return {
    ...message,
    sender: { kind: 'bot', botId: sender.botId, name: message.senderName ?? bot?.name ?? String(sender.botId) },
  }
}

function deliveryKey(messageId: ReturnType<typeof BotGroupMessageId>, botId: BotId): string {
  return `delivery-${createHash('sha256').update(`${String(messageId)}:${String(botId)}`).digest('hex')}`
}

function putDelivery(deliveries: readonly SharedGroupDeliveryRecord[], value: SharedGroupDeliveryRecord): SharedGroupDeliveryRecord[] {
  const index = deliveries.findIndex(delivery => delivery.id === value.id)
  return index === -1
    ? [...deliveries, value]
    : deliveries.map((delivery, current) => current === index ? value : delivery)
}

function withoutDispatchLease(delivery: SharedGroupDeliveryRecord): SharedGroupDeliveryRecord {
  const { dispatchToken: _dispatchToken, dispatchLeaseUntil: _dispatchLeaseUntil, ...withoutLease } = delivery
  return withoutLease
}

function responseMessageId(groupId: ReturnType<typeof BotGroupId>, botId: BotId, sourceId: string): ReturnType<typeof BotGroupMessageId> {
  return BotGroupMessageId(`bot-group-message-${createHash('sha256').update(`${String(groupId)}:${String(botId)}:${sourceId}`).digest('hex')}`)
}
