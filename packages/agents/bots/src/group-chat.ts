/** Durable multi-Bot groups and explicit fan-out delivery. */

import { createHash, randomUUID } from 'node:crypto'
import { brandString, type Branded } from '@yharness/brand'
import { MessageId } from '@yharness/llm'
import type { EncodedImageAttachment } from '@yharness/attachment'
import type { SessionEvent } from '@yharness/session/types'
import type { Domain } from '@yharness/storage-domain'
import { defineDomain, domainTable } from '@yharness/storage-domain'
import { BotId } from './types.ts'
import type { BotView } from './types.ts'
import { BotPrincipalId } from './sharing.ts'
import type { BotPrincipalId as BotPrincipalIdType } from './sharing.ts'
import { botInboxMessageState } from './inbox.ts'
import { z } from 'zod'
import type {
  BotAttachmentGrantId as BotAttachmentGrantIdType,
  BotAttachmentGrantStore,
  BotAttachmentScope,
  BotInputAttachment,
  BotInputAttachmentView,
} from './attachment-grants.ts'
import { sameAttachmentRefs } from './attachment-grants.ts'

/** Stable identity of one durable Bot group. */
export type BotGroupId = Branded<'BotGroupId'>

/** Apply the Bot group identity brand to a validated value.
 * @param value - Validated group identity text.
 * @returns The branded Bot group identity.
 */
export function BotGroupId(value: string): BotGroupId {
  return brandString<BotGroupId>(value)
}

/** Stable identity of one message in a Bot group transcript. */
export type BotGroupMessageId = Branded<'BotGroupMessageId'>

/** Apply the Bot group message identity brand to a validated value.
 * @param value - Validated group message identity text.
 * @returns The branded Bot group message identity.
 */
export function BotGroupMessageId(value: string): BotGroupMessageId {
  return brandString<BotGroupMessageId>(value)
}

/** Human-authored or Bot-authored group message attribution. */
export type BotGroupMessageSender =
  | { readonly kind: 'user'; readonly principalId?: BotPrincipalIdType }
  | { readonly kind: 'bot'; readonly botId: BotId }

/** Stored group metadata. */
export interface BotGroupRecord {
  /** Stable group identity. */
  readonly id: BotGroupId
  /** User-visible group name. */
  readonly name: string
  /** Distinct Bot members in their chosen display order. */
  readonly botIds: readonly BotId[]
  /** Group creation time in Unix milliseconds. */
  readonly createdAt: number
  /** Last durable group or delivery mutation in Unix milliseconds. */
  readonly updatedAt: number
}

/** Stored message in a group transcript. */
export interface BotGroupMessageRecord {
  /** Stable message identity used for retries. */
  readonly id: BotGroupMessageId
  /** Parent group. */
  readonly groupId: BotGroupId
  /** Human or Bot sender. */
  readonly sender: BotGroupMessageSender
  /** Historical display name captured for Bot responses that outlive a roster removal. */
  readonly senderName?: string
  /** User-visible text. */
  readonly text: string
  /** Recipients selected by the author; omitted in legacy records that broadcast to the group. */
  readonly targetBotIds?: readonly BotId[]
  /** Creation time in Unix milliseconds. */
  readonly createdAt: number
}

/** Durable per-recipient delivery state for one group message. */
export interface BotGroupDeliveryRecord {
  /** Stable path-safe key derived from the message and recipient identities. */
  readonly id: string
  /** Parent group. */
  readonly groupId: BotGroupId
  /** Source group message. */
  readonly messageId: BotGroupMessageId
  /** Recipient Bot. */
  readonly botId: BotId
  /** Current delivery lifecycle. */
  readonly status: 'pending' | 'accepted' | 'responded' | 'failed'
  /** Stable group transcript message id for the observed response. */
  readonly responseMessageId?: BotGroupMessageId
  /** Safe failure description when dispatch failed. */
  readonly error?: string
  /** Exact model turn and step that claimed this delivery, when known. */
  readonly claim?: BotGroupDeliveryClaim
  /** Last state transition time in Unix milliseconds. */
  readonly updatedAt: number
}

/** Durable causal link from a group delivery to one admitted model step. */
export interface BotGroupDeliveryClaim {
  /** Model turn that claimed the delivery. */
  readonly turn: number
  /** Model step that admitted the delivery. */
  readonly step: number
  /** Whether this delivery was the only queued user message in that step. */
  readonly isolated: boolean
}

/** One group message observed in the exact user batch admitted to a step. */
export interface BotGroupDeliveryClaimInput {
  /** Group that owns the message. */
  readonly groupId: BotGroupId
  /** Message identity admitted to the step. */
  readonly messageId: BotGroupMessageId
}

/** Browser-facing group member metadata. */
export type BotGroupMemberView = Pick<BotView, 'id' | 'name' | 'description' | 'identity' | 'accent' | 'avatar' | 'availability' | 'state'>

/** Browser-facing group row. */
export interface BotGroupView extends Omit<BotGroupRecord, 'botIds'> {
  /** Stable member ids in display order. */
  readonly botIds: readonly BotId[]
  /** Current roster projections for those members. */
  readonly bots: readonly BotGroupMemberView[]
}

/** Browser-facing transcript sender with a resolved Bot name when applicable. */
export type BotGroupMessageSenderView =
  | { readonly kind: 'user'; readonly principalId?: BotPrincipalIdType }
  | { readonly kind: 'bot'; readonly botId: BotId; readonly name: string }

/** Browser-facing transcript row. */
export interface BotGroupMessageView {
  /** Stable message identity. */
  readonly id: BotGroupMessageId
  /** Parent group. */
  readonly groupId: BotGroupId
  /** Resolved sender. */
  readonly sender: BotGroupMessageSenderView
  /** User-visible text. */
  readonly text: string
  /** Recipients selected by the author, in the original mention order. */
  readonly targetBotIds?: readonly BotId[]
  /** Safe metadata and immutable ids for attachments admitted to this message. */
  readonly attachments?: readonly BotInputAttachmentView[]
  /** Creation time in Unix milliseconds. */
  readonly createdAt: number
}

/** Group catalog request. */
export interface BotGroupListRequest {
  /** Reserved cursor for a future bounded catalog. */
  readonly cursor?: string
}

/** Group catalog response. */
export interface BotGroupListValue {
  /** Durable groups ordered by creation time, then id. */
  readonly groups: readonly BotGroupView[]
}

/** Group creation request. */
export interface BotGroupCreateRequest {
  /** Optional caller-selected id for retry-safe creation. */
  readonly id?: BotGroupId
  /** Non-empty display name. */
  readonly name: string
  /** Two through six existing Bot ids. */
  readonly botIds: readonly BotId[]
}

/** Group creation response. */
export interface BotGroupCreateValue {
  /** Newly created or idempotently reused group. */
  readonly group: BotGroupView
}

/** Group metadata and membership replacement request. */
export interface BotGroupUpdateRequest {
  /** Group to update. */
  readonly groupId: BotGroupId
  /** New non-empty display name. */
  readonly name: string
  /** Two through six existing Bot ids in their new display order. */
  readonly botIds: readonly BotId[]
}

/** Group update response. */
export interface BotGroupUpdateValue {
  /** Updated group projection. */
  readonly group: BotGroupView
}

/** Group transcript request. */
export interface BotGroupInspectRequest {
  /** Group to inspect. */
  readonly groupId: BotGroupId
}

/** Group transcript response. */
export interface BotGroupInspectValue {
  /** Current group metadata. */
  readonly group: BotGroupView
  /** Durable messages in chronological order. */
  readonly messages: readonly BotGroupMessageView[]
  /** Durable per-recipient state for the messages in this transcript. */
  readonly deliveries?: readonly BotGroupDeliveryStatusView[]
}

/** Browser-safe per-recipient state for one persisted group delivery. */
export interface BotGroupDeliveryStatusView {
  /** Source group message identity. */
  readonly messageId: BotGroupMessageId
  /** Recipient Bot identity. */
  readonly botId: BotId
  /** Durable execution state. */
  readonly status: BotGroupDeliveryRecord['status']
  /** Safe user-facing failure description, when the Bot could not complete. */
  readonly error?: string
}

/** Human or Bot group message request. */
export interface BotGroupSendRequest {
  /** Group receiving the message. */
  readonly groupId: BotGroupId
  /** Message text. */
  readonly text: string
  /** Optional retry identity. */
  readonly messageId?: BotGroupMessageId
  /** Optional targeted recipients; omitted messages are delivered to every other member. */
  readonly targetBotIds?: readonly BotId[]
  /** Opaque grants admitted for this exact message and recipient set. */
  readonly attachmentGrants?: readonly BotAttachmentGrantIdType[]
  /** Cancellation for delivery admission. */
  readonly signal?: AbortSignal
}

/** Remote-safe group message request without the process-local cancellation signal. */
export interface BotGroupSendRemoteRequest {
  /** Group receiving the message. */
  readonly groupId: BotGroupId
  /** Message text. */
  readonly text: string
  /** Optional retry identity. */
  readonly messageId?: BotGroupMessageId
  /** Optional targeted recipients; omitted messages are delivered to every group member. */
  readonly targetBotIds?: readonly BotId[]
  /** Opaque grants admitted for this exact message and recipient set. */
  readonly attachmentGrants?: readonly BotAttachmentGrantIdType[]
}

/** Explicit owner-local recovery request for one isolated shared-group recipient fence. */
export interface BotGroupDeliveryRecoveryRequest {
  /** Shared group containing the delivery. */
  readonly groupId: BotGroupId
  /** Recipient Bot whose isolated Session owns the fence. */
  readonly botId: BotId
  /** Exact durable isolated Session id recorded by the operator. */
  readonly sessionId: string
  /** Source group message whose recipient fence is being reconciled. */
  readonly messageId: BotGroupMessageId
  /** Explicit, unverified operator assertion that every Host able to own the Session is quiesced. */
  readonly confirmQuiescent: true
}

/** Result of explicit owner-local shared-group recipient recovery. */
export interface BotGroupDeliveryRecoveryValue {
  /** Recipient Bot whose fence was inspected. */
  readonly botId: BotId
  /** Source message whose fence was inspected. */
  readonly messageId: BotGroupMessageId
  /** Durable recovery result. */
  readonly status: 'accepted' | 'released' | 'busy' | 'operator-required'
  /** Retry hint when another Host still owns the fresh lock. */
  readonly retryAt?: number
}

/** One recipient's group delivery outcome. */
export interface BotGroupDeliveryView {
  /** Recipient Bot id. */
  readonly botId: BotId
  /** Accepted, already delivered, or failed. */
  readonly status: 'accepted' | 'duplicate' | 'failed'
  /** Safe failure description when dispatch failed. */
  readonly error?: string
}

/** Group message delivery response. */
export interface BotGroupSendValue {
  /** Group message identity. */
  readonly messageId: BotGroupMessageId
  /** Accepted when at least one new recipient was admitted, duplicate when all were already complete, partial when one failed. */
  readonly status: 'accepted' | 'duplicate' | 'partial'
  /** Per-recipient durable delivery outcomes. */
  readonly deliveries: readonly BotGroupDeliveryView[]
}

/** Owner-local request to bind provider-admitted attachments to a message. */
export interface BotGroupAttachmentAdmissionRequest {
  /** Group receiving the message. */
  readonly groupId: BotGroupId
  /** Message identity selected by the caller before upload. */
  readonly messageId: BotGroupMessageId
  /** Optional explicit recipients; omitted means every other group member. */
  readonly targetBotIds?: readonly BotId[]
  /** Provider-admitted immutable references. */
  readonly attachments: readonly BotInputAttachment[]
}

/** Remote-safe owner request for one encoded image grant. */
export interface BotGroupImageAdmissionRequest {
  /** Group receiving the message. */
  readonly groupId: BotGroupId
  /** Message identity selected by the caller before upload. */
  readonly messageId: BotGroupMessageId
  /** Optional explicit recipients. */
  readonly targetBotIds?: readonly BotId[]
  /** Encoded image bytes; the Host validates and stores them before granting. */
  readonly image: EncodedImageAttachment
}

/** Host operation used to deliver one message into a real Bot Session. */
export interface BotGroupDeliveryHost {
  /** Read the current durable Bot roster. */
  readonly listBots: () => Promise<readonly BotView[]>
  /** Re-read one target Session before repairing a cancellation race. */
  readonly inspectSession?: (sessionId: BotView['sessionId']) => Promise<{ readonly events: readonly SessionEvent[] }>
  /** Notify the owning runtime after a durable group mutation. */
  readonly changed?: () => void
  /** Queue a model-visible message in one target Bot Session and flush it. */
  readonly deliverToBot: (request: {
    readonly targetBotId: BotId
    readonly groupId: BotGroupId
    readonly groupName: string
    /** Display name of the Bot that authored the group message, when applicable. */
    readonly senderName?: string
    readonly text: string
    /** Provider-admitted immutable content references. */
    readonly attachments?: readonly BotInputAttachment[]
    readonly messageId: BotGroupMessageId
    readonly signal?: AbortSignal
  }) => Promise<'accepted' | 'duplicate'>
  /**
   * Queue a shared-principal message in an isolated shared-group Session.
   * Hosts that cannot provide this separate durable Session must omit the
   * capability; principal-authored sends then fail before any transcript row
   * is written rather than entering an owner-local Bot Session.
   */
  readonly deliverToSharedGroup?: (request: {
    readonly principalId: BotPrincipalIdType
    readonly targetBotId: BotId
    readonly groupId: BotGroupId
    readonly groupName: string
    readonly text: string
    /** Provider-admitted immutable content references. */
    readonly attachments?: readonly BotInputAttachment[]
    readonly messageId: BotGroupMessageId
    readonly signal?: AbortSignal
  }) => Promise<'accepted' | 'duplicate'>
}

/** Error raised when a group operation cannot be admitted. */
export class BotGroupError extends Error {
  /** @param code - Stable failure category. @param message - Safe diagnostic. */
  constructor(readonly code: 'invalid' | 'not-found' | 'member-not-found' | 'delivery-failed', message: string) {
    super(message)
    this.name = 'BotGroupError'
  }
}

const GROUP_ID_PATTERN = /^bot-group-[A-Za-z0-9][A-Za-z0-9-]*$/
const MESSAGE_ID_PATTERN = /^bot-group-message-[A-Za-z0-9][A-Za-z0-9-]*$/
const MAX_GROUP_MEMBERS = 6
const MAX_GROUP_NAME = 80
const MAX_MESSAGE_TEXT = 16_000

const groupIdSchema = z.string().regex(GROUP_ID_PATTERN).transform(BotGroupId)
const messageIdSchema = z.string().regex(MESSAGE_ID_PATTERN).transform(BotGroupMessageId)
const botIdSchema = z.string().regex(/^bot-[A-Za-z0-9][A-Za-z0-9-]*$/).transform(BotId)
const groupNameSchema = z.string().min(1).max(MAX_GROUP_NAME).refine(value => value.trim() === value)
const groupTextSchema = z.string().min(1).max(MAX_MESSAGE_TEXT).refine(value => value.trim() === value)
const senderSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    principalId: z.string().regex(/^principal-[A-Za-z0-9-]+$/).transform(BotPrincipalId).optional(),
  }).strict(),
  z.object({ kind: z.literal('bot'), botId: botIdSchema }).strict(),
]).transform((sender): BotGroupMessageSender => sender.kind === 'user'
  ? sender.principalId === undefined ? { kind: 'user' } : { kind: 'user', principalId: sender.principalId }
  : sender)

/** Stored group row schema. */
export const botGroupRecordSchema = z.object({
  id: groupIdSchema,
  name: groupNameSchema,
  botIds: z.array(botIdSchema).min(2).max(MAX_GROUP_MEMBERS),
  createdAt: z.number().safe().int().nonnegative(),
  updatedAt: z.number().safe().int().nonnegative(),
}).strict().refine(record => new Set(record.botIds.map(String)).size === record.botIds.length, {
  message: 'Bot group members must be unique',
}).refine(record => record.updatedAt >= record.createdAt, {
  message: 'updatedAt must not be earlier than createdAt',
})

/** Stored group transcript message schema. */
export const botGroupMessageRecordSchema = z.object({
  id: messageIdSchema,
  groupId: groupIdSchema,
  sender: senderSchema,
  senderName: z.string().min(1).max(MAX_GROUP_NAME).optional(),
  text: groupTextSchema,
  targetBotIds: z.array(botIdSchema).min(1).max(MAX_GROUP_MEMBERS).optional(),
  createdAt: z.number().safe().int().nonnegative(),
}).strict().transform((value): BotGroupMessageRecord => ({
  id: value.id,
  groupId: value.groupId,
  sender: value.sender,
  ...(value.senderName === undefined ? {} : { senderName: value.senderName }),
  text: value.text,
  ...(value.targetBotIds === undefined ? {} : { targetBotIds: value.targetBotIds }),
  createdAt: value.createdAt,
}))

/** Stored per-recipient delivery schema. */
export const botGroupDeliveryRecordSchema = z.object({
  id: z.string().min(1),
  groupId: groupIdSchema,
  messageId: messageIdSchema,
  botId: botIdSchema,
  status: z.enum(['pending', 'accepted', 'responded', 'failed']),
  responseMessageId: messageIdSchema.optional(),
  error: z.string().min(1).max(400).optional(),
  claim: z.object({
    turn: z.number().safe().int().nonnegative(),
    step: z.number().safe().int().nonnegative(),
    isolated: z.boolean(),
  }).strict().optional(),
  updatedAt: z.number().safe().int().nonnegative(),
}).strict().transform((value): BotGroupDeliveryRecord => ({
  id: value.id,
  groupId: value.groupId,
  messageId: value.messageId,
  botId: value.botId,
  status: value.status,
  ...(value.responseMessageId === undefined ? {} : { responseMessageId: value.responseMessageId }),
  ...(value.error === undefined ? {} : { error: value.error }),
  ...(value.claim === undefined ? {} : { claim: value.claim }),
  updatedAt: value.updatedAt,
}))

/** Durable group domain kept separate from the Bot roster for additive upgrades. */
export const botGroupDomain = defineDomain({
  name: 'agent_bot_groups',
  version: 1,
  layout: 'per-record',
  tables: {
    groups: domainTable<BotGroupId, BotGroupRecord>(botGroupRecordSchema),
    messages: domainTable<BotGroupMessageId, BotGroupMessageRecord>(botGroupMessageRecordSchema),
    deliveries: domainTable<string, BotGroupDeliveryRecord>(botGroupDeliveryRecordSchema),
  },
})

/** Normalize one group id at the durable service boundary. */
function normalizeGroupId(value: BotGroupId): BotGroupId {
  if (typeof value !== 'string' || !GROUP_ID_PATTERN.test(value)) {
    throw new BotGroupError('invalid', 'Bot group id must begin with bot-group- and contain URL-safe segments')
  }
  return BotGroupId(value)
}

/** Normalize one message id at the durable service boundary. */
function normalizeMessageId(value: BotGroupMessageId | undefined): BotGroupMessageId {
  if (value === undefined) return BotGroupMessageId(`bot-group-message-${randomUUID()}`)
  if (typeof value !== 'string' || !MESSAGE_ID_PATTERN.test(value)) {
    throw new BotGroupError('invalid', 'Bot group message ids must begin with bot-group-message-')
  }
  return BotGroupMessageId(value)
}

/** Normalize bounded text without silently changing caller intent. */
function normalizeText(value: string, label: string, max: number): string {
  if (typeof value !== 'string') throw new BotGroupError('invalid', `${label} must be a string`)
  const text = value.trim()
  if (text.length === 0 || [...text].length > max) {
    throw new BotGroupError('invalid', `${label} must contain 1-${String(max)} characters`)
  }
  return text
}

/** Create one deterministic message id from a group, Bot, and source message identity. */
function responseMessageId(groupId: BotGroupId, botId: BotId, sourceId: string): BotGroupMessageId {
  const digest = createHash('sha256').update(`${String(groupId)}:${String(botId)}:${sourceId}`).digest('hex')
  return BotGroupMessageId(`bot-group-message-${digest}`)
}

function sameIds(left: readonly BotId[], right: readonly BotId[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every(id => rightSet.has(id))
}

function sameIdSet(left: readonly BotId[], right: readonly BotId[]): boolean {
  if (left.length !== right.length) return false
  const rightIds = new Set(right.map(String))
  return new Set(left.map(String)).size === rightIds.size && left.every(id => rightIds.has(String(id)))
}

/** Fixed retry delays for a group acceptance write that lost its durability race. */
const GROUP_FINALIZATION_RETRY_DELAYS_MS = [0, 25, 100, 400, 1_000] as const

function groupFinalizationRetryDelay(attempt: number): number | undefined {
  return GROUP_FINALIZATION_RETRY_DELAYS_MS[attempt - 1]
}

/** Durable group roster and fan-out delivery owner. */
export class BotGroupService {
  private chain: Promise<unknown> = Promise.resolve()
  private readonly externalDeliveries = new Set<Promise<void>>()
  private readonly inFlightDeliveries = new Map<string, BotGroupDeliveryFlight>()
  private nextDeliveryGeneration = 0
  private readonly deliveryGenerations = new Map<string, number>()
  private readonly finalizationRetryAttempts = new Map<string, number>()
  private readonly finalizationRetryTimers = new Set<Promise<void>>()
  private readonly finalizationRetryPromises = new Set<Promise<void>>()

  /** @param domain - Open group domain. @param host - Bot roster and delivery capabilities. */
  constructor(
    private readonly domain: Domain<typeof botGroupDomain>,
    private readonly host: BotGroupDeliveryHost,
    private readonly attachments?: BotAttachmentGrantStore,
    private readonly ownerId = 'local-owner',
  ) {}

  /**
   * Admit immutable provider references for one owner-local group message.
   * @param request - Group, message, recipient, and admitted references.
   * @returns opaque grant id and safe attachment metadata.
   */
  async admitAttachment(request: BotGroupAttachmentAdmissionRequest): Promise<import('./attachment-grants.ts').BotAttachmentGrantValue> {
    const store = this.attachments
    if (store === undefined) throw new BotGroupError('delivery-failed', 'Bot attachment admission is unavailable')
    return this.serialize(async () => {
      const groupId = normalizeGroupId(request.groupId)
      const messageId = normalizeMessageId(request.messageId)
      const group = this.domain.table('groups').get(groupId)
      if (group === undefined) throw new BotGroupError('not-found', `Bot group "${String(groupId)}" was not found`)
      if (this.domain.table('messages').get(messageId) !== undefined) {
        throw new BotGroupError('invalid', `Bot group message "${String(messageId)}" already exists`)
      }
      const targetBotIds = this.recipientIds(group, { kind: 'user' }, request.targetBotIds)
      const scope: BotAttachmentScope = {
        kind: 'local-group', ownerId: this.ownerId, groupId, messageId, targetBotIds,
        authorizationRevision: group.updatedAt,
      }
      return await store.admit(scope, request.attachments)
    })
  }

  /** List durable groups with current member projections.
   * @param _request - Reserved list request fields.
   * @returns Current group projections.
   */
  async list(_request: BotGroupListRequest): Promise<BotGroupListValue> {
    await this.chain
    const bots = await this.host.listBots()
    const table = this.domain.table('groups')
    const groups = [...table.entries()]
      .map(([, record]) => this.view(record, bots))
      .sort((left, right) => left.createdAt - right.createdAt || String(left.id).localeCompare(String(right.id)))
    return { groups }
  }

  /** Create or idempotently reuse one 2–6 Bot group.
   * @param request - Group name, members, and optional retry identity.
   * @returns The created or reused group projection.
   */
  async create(request: BotGroupCreateRequest): Promise<BotGroupCreateValue> {
    return this.serialize(async () => {
      const name = normalizeText(request.name, 'Bot group name', MAX_GROUP_NAME)
      const botIds = [...request.botIds]
      if (botIds.length < 2) throw new BotGroupError('invalid', 'A Bot group must contain at least two Bots')
      if (botIds.length > MAX_GROUP_MEMBERS) throw new BotGroupError('invalid', `A Bot group may contain at most ${String(MAX_GROUP_MEMBERS)} Bots`)
      if (new Set(botIds.map(String)).size !== botIds.length) throw new BotGroupError('invalid', 'Bot group members must be unique')
      const bots = await this.host.listBots()
      for (const botId of botIds) {
        const bot = bots.find(candidate => candidate.id === botId)
        if (bot === undefined) throw new BotGroupError('member-not-found', `Bot "${String(botId)}" was not found`)
        if (bot.state !== 'active') throw new BotGroupError('member-not-found', `Bot "${String(botId)}" is not active`)
      }
      const id = request.id === undefined ? BotGroupId(`bot-group-${randomUUID()}`) : normalizeGroupId(request.id)
      const groups = this.domain.table('groups')
      const existing = groups.get(id)
      if (existing !== undefined) {
        if (existing.name === name && sameIdSet(existing.botIds, botIds)) return { group: this.view(existing, bots) }
        throw new BotGroupError('invalid', `Bot group "${String(id)}" already exists with different metadata`)
      }
      const now = Date.now()
      const record: BotGroupRecord = { id, name, botIds, createdAt: now, updatedAt: now }
      await groups.put(id, record)
      this.host.changed?.()
      return { group: this.view(record, bots) }
    })
  }

  /** Update a group from the human workspace while preserving its durable identity.
   * @param request - Group identity, name, and member list.
   * @returns The updated group projection.
   */
  async update(request: BotGroupUpdateRequest): Promise<BotGroupUpdateValue> {
    return this.updateInternal(request)
  }

  /** Update a group from a live member Bot after re-checking membership.
   * @param senderBotId - Authenticated member Bot identity.
   * @param request - Group identity, name, and member list.
   * @returns The updated group projection.
   */
  async updateAsBot(senderBotId: BotId, request: BotGroupUpdateRequest): Promise<BotGroupUpdateValue> {
    return this.updateInternal(request, senderBotId)
  }

  private async updateInternal(request: BotGroupUpdateRequest, senderBotId?: BotId): Promise<BotGroupUpdateValue> {
    return this.serialize(async () => {
      const groupId = normalizeGroupId(request.groupId)
      const name = normalizeText(request.name, 'Bot group name', MAX_GROUP_NAME)
      const botIds = [...request.botIds]
      if (botIds.length < 2) throw new BotGroupError('invalid', 'A Bot group must contain at least two Bots')
      if (botIds.length > MAX_GROUP_MEMBERS) throw new BotGroupError('invalid', `A Bot group may contain at most ${String(MAX_GROUP_MEMBERS)} Bots`)
      if (new Set(botIds.map(String)).size !== botIds.length) throw new BotGroupError('invalid', 'Bot group members must be unique')
      const groups = this.domain.table('groups')
      const group = groups.get(groupId)
      if (group === undefined) throw new BotGroupError('not-found', `Bot group "${String(groupId)}" was not found`)
      const bots = await this.host.listBots()
      if (senderBotId !== undefined && !group.botIds.includes(senderBotId)) {
        throw new BotGroupError('member-not-found', `Bot "${String(senderBotId)}" is not a member of this group`)
      }
      if (senderBotId !== undefined && !botIds.includes(senderBotId)) {
        throw new BotGroupError('invalid', 'The Bot making this change must remain a member of the group')
      }
      for (const botId of botIds) {
        const bot = bots.find(candidate => candidate.id === botId)
        if (bot === undefined) throw new BotGroupError('member-not-found', `Bot "${String(botId)}" was not found`)
        if (bot.state !== 'active') throw new BotGroupError('member-not-found', `Bot "${String(botId)}" is not active`)
      }
      if (group.name === name && sameIds(group.botIds, botIds)) return { group: this.view(group, bots) }
      const updatedAt = Math.max(Date.now(), group.updatedAt)
      const next = { ...group, name, botIds, updatedAt }
      await groups.put(groupId, next)
      this.host.changed?.()
      return { group: this.view(next, bots) }
    })
  }

  /** Read one durable group transcript.
   * @param request - Group identity to inspect.
   * @returns Group metadata, transcript, and delivery statuses.
   */
  async inspect(request: BotGroupInspectRequest): Promise<BotGroupInspectValue> {
    await this.chain
    return this.inspectInternal(request)
  }

  /** Read one durable group transcript while authorizing the live member atomically.
   * @param senderBotId - Authenticated member Bot identity.
   * @param request - Group identity to inspect.
   * @returns Group metadata, transcript, and delivery statuses.
   */
  async inspectAsBot(senderBotId: BotId, request: BotGroupInspectRequest): Promise<BotGroupInspectValue> {
    return this.serialize(async () => this.inspectInternal(request, senderBotId))
  }

  /** Mark group deliveries canceled when the target Session removed their inbox receipt.
   * @param botId - Target Bot whose Session emitted the cancellation.
   * @param events - Session events containing the cancellation evidence.
   * @returns A promise that settles after the durable delivery repair attempt.
   */
  async reconcileCanceledDeliveries(botId: BotId, events: readonly SessionEvent[]): Promise<void> {
    const deferred = await this.serialize(async (): Promise<readonly Promise<BotGroupDeliveryAttempt>[]> => {
      const bot = (await this.host.listBots()).find(candidate => candidate.id === botId)
      if (bot === undefined) return []
      const currentEvents = this.host.inspectSession === undefined
        ? events
        : (await this.host.inspectSession(bot.sessionId)).events
      const deliveries = this.domain.table('deliveries')
      const groups = this.domain.table('groups')
      const now = Date.now()
      const canceledError = 'Bot canceled the group message before it reached the model.'
      const surfaceIds = new Set(currentEvents.flatMap(event => event.type === 'user/message' ? [String(event.data.id)] : []))
      const changedGroups = new Set<BotGroupId>()
      const deferred = new Set<Promise<BotGroupDeliveryAttempt>>()
      for (const [id, delivery] of deliveries.entries()) {
        if (delivery.botId !== botId || (delivery.status !== 'pending' && delivery.status !== 'accepted')) continue
        if (delivery.status === 'pending') {
          const flight = this.inFlightDeliveries.get(id)
          if (flight !== undefined) {
            deferred.add(flight.promise)
            continue
          }
        }
        const inbox = botInboxMessageState(currentEvents, MessageId(String(delivery.messageId)))
        const surfaced = currentEvents.find(event => event.type === 'user/message'
          && String(event.data.id) === String(delivery.messageId))
        const surfacedGroupMessage = surfaced?.type === 'user/message'
          && surfaced.data.source.kind === 'bot-group-message'
        if (inbox?.message.source.kind !== 'bot-group-message' && !surfacedGroupMessage) continue
        if (delivery.status === 'pending'
          && (surfaceIds.has(String(delivery.messageId)) || inbox?.disposition === 'pending' || inbox?.disposition === 'claimed')) {
          await deliveries.put(id, {
            ...delivery,
            status: 'accepted',
            updatedAt: Math.max(now, delivery.updatedAt),
          })
          changedGroups.add(delivery.groupId)
          continue
        }
        if (surfaceIds.has(String(delivery.messageId))) continue
        if (inbox?.disposition !== 'canceled') continue
        await deliveries.put(id, {
          ...delivery,
          status: 'failed',
          error: canceledError,
          updatedAt: Math.max(now, delivery.updatedAt),
        })
        changedGroups.add(delivery.groupId)
      }
      for (const groupId of changedGroups) {
        const group = groups.get(groupId)
        if (group !== undefined) await groups.put(group.id, { ...group, updatedAt: Math.max(now, group.updatedAt) })
      }
      if (changedGroups.size > 0) this.host.changed?.()
      return [...deferred]
    })
    if (deferred.length === 0) return
    await Promise.all(deferred)
    await this.reconcileCanceledDeliveries(botId, events)
  }

  private async inspectInternal(request: BotGroupInspectRequest, senderBotId?: BotId): Promise<BotGroupInspectValue> {
    const id = normalizeGroupId(request.groupId)
    const group = this.domain.table('groups').get(id)
    if (group === undefined) throw new BotGroupError('not-found', `Bot group "${String(id)}" was not found`)
    if (senderBotId !== undefined && !group.botIds.includes(senderBotId)) {
      throw new BotGroupError('member-not-found', `Bot "${String(senderBotId)}" is not a member of this group`)
    }
    const bots = await this.host.listBots()
    const messages = [...this.domain.table('messages').entries()]
      .map(([, message]) => message)
      .filter(message => message.groupId === id)
      .sort((left, right) => left.createdAt - right.createdAt || String(left.id).localeCompare(String(right.id)))
      .map(message => this.messageView(message, bots, group))
    const messageIds = new Set(messages.map(message => String(message.id)))
    const deliveries = [...this.domain.table('deliveries').entries()]
      .map(([, delivery]) => delivery)
      .filter(delivery => delivery.groupId === id && messageIds.has(String(delivery.messageId)))
      .sort((left, right) => String(left.messageId).localeCompare(String(right.messageId))
        || String(left.botId).localeCompare(String(right.botId)))
      .map((delivery): BotGroupDeliveryStatusView => ({
        messageId: delivery.messageId,
        botId: delivery.botId,
        status: delivery.status,
        ...(delivery.error === undefined ? {} : { error: delivery.error }),
      }))
    return { group: this.view(group, bots), messages, deliveries }
  }

  /** Persist one human or Bot message, then fan it out to every intended recipient.
   * @param request - Group message and optional recipient or retry identity.
   * @returns Fan-out status and each recipient's delivery result.
   */
  async send(request: BotGroupSendRequest): Promise<BotGroupSendValue> {
    return this.sendInternal(request)
  }

  /** Persist and fan out one message authored by an authenticated collaborator.
   * @param principalId - Principal authenticated by the shared-Bot Host.
   * @param request - Group message and optional recipient or retry identity.
   * @returns Fan-out status and each recipient's delivery result.
   */
  async sendAsPrincipal(principalId: BotPrincipalIdType, request: BotGroupSendRequest): Promise<BotGroupSendValue> {
    return this.sendInternal(request, undefined, principalId)
  }

  /** Persist and fan out one message authored by the exact live Bot identity supplied by the Host.
   * @param senderBotId - Authenticated Bot author.
   * @param request - Group message and optional recipient or retry identity.
   * @returns Fan-out status and each recipient's delivery result.
   */
  async sendAsBot(senderBotId: BotId, request: BotGroupSendRequest): Promise<BotGroupSendValue> {
    return this.sendInternal(request, senderBotId)
  }

  private sendInternal(
    request: BotGroupSendRequest,
    senderBotId?: BotId,
    principalId?: BotPrincipalIdType,
  ): Promise<BotGroupSendValue> {
    return this.trackExternal(this.sendInternalImpl(request, senderBotId, principalId))
  }

  private async sendInternalImpl(
    request: BotGroupSendRequest,
    senderBotId?: BotId,
    principalId?: BotPrincipalIdType,
  ): Promise<BotGroupSendValue> {
    if (principalId !== undefined && this.host.deliverToSharedGroup === undefined) {
      throw new BotGroupError('delivery-failed', 'Shared Bot group delivery is unavailable without an isolated Session')
    }
    if (principalId !== undefined && (request.attachmentGrants?.length ?? 0) > 0) {
      throw new BotGroupError('delivery-failed', 'Shared group attachments require the isolated shared-group service')
    }
    const createdFlights: Array<{ readonly id: string; readonly flight: BotGroupDeliveryFlight }> = []
    let prepared: PreparedBotGroupSend
    try {
      prepared = await this.serialize(async () => {
        const groupId = normalizeGroupId(request.groupId)
        const text = normalizeText(request.text, 'Bot group message', MAX_MESSAGE_TEXT)
        const group = this.domain.table('groups').get(groupId)
        if (group === undefined) throw new BotGroupError('not-found', `Bot group "${String(groupId)}" was not found`)
        const bots = await this.host.listBots()
        const sender = senderBotId === undefined
          ? principalId === undefined ? ({ kind: 'user' } as const) : ({ kind: 'user', principalId } as const)
          : this.sender(group, senderBotId, bots)
        const senderName = sender.kind === 'bot' ? bots.find(bot => bot.id === sender.botId)?.name : undefined
        const targetBotIds = this.recipientIds(group, sender, request.targetBotIds)
        const messageId = normalizeMessageId(request.messageId)
        if ((request.attachmentGrants?.length ?? 0) > 0 && request.messageId === undefined) {
          throw new BotGroupError('invalid', 'attachment grants require an explicit message id')
        }
        const attachmentScope: BotAttachmentScope = {
          kind: 'local-group',
          ownerId: this.ownerId,
          groupId,
          messageId,
          targetBotIds,
          authorizationRevision: group.updatedAt,
        }
        const attachmentStore = this.attachments
        const messages = this.domain.table('messages')
        const existing = messages.get(messageId)
        const existingAttachments = attachmentStore?.attachmentsForMessage(attachmentScope) ?? []
        if (existing === undefined && existingAttachments.length > 0) {
          throw new BotGroupError('invalid', 'This attachment send could not be confirmed; start a new message')
        }
        if (request.attachmentGrants !== undefined && request.attachmentGrants.length > 0) {
          if (attachmentStore === undefined) {
            throw new BotGroupError('delivery-failed', 'Bot attachment admission is unavailable')
          }
          if (existing !== undefined && existingAttachments.length === 0) {
            throw new BotGroupError('invalid', `Bot group message "${String(messageId)}" already exists without attachments`)
          }
          const preview = attachmentStore.preview(attachmentScope, request.attachmentGrants)
          if (existing !== undefined && !sameAttachmentRefs(existingAttachments, preview)) {
            throw new BotGroupError('invalid', `Bot group message "${String(messageId)}" already exists with different attachments`)
          }
        }
        if (existing === undefined && request.attachmentGrants !== undefined && request.attachmentGrants.length > 0) {
          await attachmentStore?.consume(attachmentScope, request.attachmentGrants)
        }
        const messageAttachments = attachmentStore?.attachmentsForMessage(attachmentScope) ?? []
        let changed = false
        if (existing !== undefined) {
          if (existing.groupId !== groupId || existing.text !== text || existing.sender.kind !== sender.kind
          || (existing.sender.kind === 'user' && sender.kind === 'user'
            && String(existing.sender.principalId ?? '') !== String(sender.principalId ?? ''))
          || (existing.sender.kind === 'bot' && sender.kind === 'bot' && existing.sender.botId !== sender.botId)
          || !sameIdSet(existing.targetBotIds ?? this.recipientIds(group, existing.sender), targetBotIds)
          ) {
            throw new BotGroupError('invalid', `Bot group message "${String(messageId)}" already exists with different content`)
          }
        } else {
          await messages.put(messageId, {
            id: messageId, groupId, sender, text, targetBotIds, createdAt: Date.now(),
          })
          changed = true
        }
        const deliveries = this.domain.table('deliveries')
        const outcomes = new Map<string, BotGroupDeliveryView>()
        const pending: PreparedBotGroupDelivery[] = []
        for (const botId of targetBotIds) {
          const id = deliveryId(messageId, botId)
          const current = deliveries.get(id)
          if (current?.status === 'accepted' || current?.status === 'responded') {
            outcomes.set(String(botId), { botId, status: 'duplicate' })
            continue
          }
          const flight = this.inFlightDeliveries.get(id)
          const owner = flight === undefined
          const generation = flight !== undefined
            ? this.deliveryGenerations.get(id) ?? this.claimDeliveryGeneration(id)
            : current === undefined || current.status === 'failed' || (current.status === 'pending' && owner)
              ? this.claimDeliveryGeneration(id)
              : this.deliveryGenerations.get(id) ?? this.claimDeliveryGeneration(id)
          const reservation: BotGroupDeliveryRecord = {
            id, groupId, messageId, botId, status: 'pending', updatedAt: Date.now(),
          }
          if (current === undefined || current.status === 'failed' || (current.status === 'pending' && owner)) {
            await deliveries.put(id, reservation)
            changed = true
          }
          const nextFlight = flight ?? createBotGroupDeliveryFlight()
          if (owner) {
            this.inFlightDeliveries.set(id, nextFlight)
            createdFlights.push({ id, flight: nextFlight })
          }
          pending.push({
            id, groupId, messageId, botId, generation, groupName: group.name, text,
            ...(messageAttachments.length === 0 ? {} : { attachments: messageAttachments }),
            flight: nextFlight,
            owner,
            ...(principalId === undefined ? {} : { principalId }),
            ...(senderName === undefined ? {} : { senderName }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          })
        }
        const updatedAt = Date.now()
        if (updatedAt > group.updatedAt) {
          await this.domain.table('groups').put(group.id, { ...group, updatedAt })
          changed = true
        }
        if (changed) this.host.changed?.()
        return { groupId, messageId, pending, outcomes, targetBotIds, attachments: messageAttachments }
      })
    } catch (error: unknown) {
      for (const { id, flight } of createdFlights) {
        if (this.inFlightDeliveries.get(id) === flight) this.inFlightDeliveries.delete(id)
      }
      throw error
    }

    for (const delivery of prepared.pending) {
      if (delivery.owner) void this.deliverExternal(delivery)
    }
    const attempts = await Promise.all(prepared.pending.map(delivery => delivery.flight.promise))

    try {
      return await this.finalizeSend(prepared, attempts)
    } catch (error: unknown) {
      this.scheduleFinalizationRetry(prepared, attempts, 1)
      throw error
    } finally {
      for (const delivery of prepared.pending) {
        if (delivery.owner && this.inFlightDeliveries.get(delivery.id) === delivery.flight) {
          this.inFlightDeliveries.delete(delivery.id)
        }
      }
    }
  }

  /** Persist the result of one already-completed fan-out attempt. */
  private async finalizeSend(
    prepared: PreparedBotGroupSend,
    attempts: readonly BotGroupDeliveryAttempt[],
  ): Promise<BotGroupSendValue> {
    return this.serialize(async () => {
      const deliveries = this.domain.table('deliveries')
      const groups = this.domain.table('groups')
      let changed = false
      let admitted = false
      for (const attempt of attempts) {
        const current = deliveries.get(attempt.delivery.id)
        if (current === undefined || current.groupId !== attempt.delivery.groupId
        || current.messageId !== attempt.delivery.messageId || current.botId !== attempt.delivery.botId
        || this.deliveryGenerations.get(attempt.delivery.id) !== attempt.delivery.generation) {
          prepared.outcomes.set(String(attempt.delivery.botId), {
            botId: attempt.delivery.botId, status: 'failed', error: 'Bot delivery reservation changed before completion',
          })
          continue
        }
        if (current?.status === 'accepted' || current?.status === 'responded') {
          prepared.outcomes.set(String(attempt.delivery.botId), { botId: attempt.delivery.botId, status: 'duplicate' })
          admitted ||= current.status === 'responded'
          continue
        }
        if (current?.status === 'failed') {
          prepared.outcomes.set(String(attempt.delivery.botId), {
            botId: attempt.delivery.botId, status: 'failed', error: current.error ?? 'Bot delivery failed',
          })
          continue
        }
        if (attempt.error !== undefined) {
          const error = attempt.error
          await deliveries.put(attempt.delivery.id, {
            id: attempt.delivery.id,
            groupId: attempt.delivery.groupId,
            messageId: attempt.delivery.messageId,
            botId: attempt.delivery.botId,
            status: 'failed', error, updatedAt: Date.now(),
          })
          prepared.outcomes.set(String(attempt.delivery.botId), { botId: attempt.delivery.botId, status: 'failed', error })
          changed = true
          continue
        }
        const result = attempt.result
        if (result === undefined) {
          prepared.outcomes.set(String(attempt.delivery.botId), {
            botId: attempt.delivery.botId, status: 'failed', error: 'Bot delivery did not return a result',
          })
          continue
        }
        const prior = current ?? {
          id: attempt.delivery.id,
          groupId: attempt.delivery.groupId,
          messageId: attempt.delivery.messageId,
          botId: attempt.delivery.botId,
          status: 'pending' as const,
          updatedAt: Date.now(),
        }
        await deliveries.put(attempt.delivery.id, { ...prior, status: 'accepted', updatedAt: Date.now() })
        prepared.outcomes.set(String(attempt.delivery.botId), { botId: attempt.delivery.botId, status: result })
        admitted ||= result === 'accepted'
        changed = true
      }
      const group = groups.get(prepared.groupId)
      if (changed && group !== undefined) {
        await groups.put(group.id, { ...group, updatedAt: Math.max(Date.now(), group.updatedAt) })
      }
      if (changed) this.host.changed?.()
      const deliveriesInOrder = prepared.targetBotIds.flatMap((botId) => {
        const outcome = prepared.outcomes.get(String(botId))
        return outcome === undefined ? [] : [outcome]
      })
      const status = deliveriesInOrder.some(outcome => outcome.status === 'failed')
        ? 'partial'
        : admitted ? 'accepted' : 'duplicate'
      return { messageId: prepared.messageId, status, deliveries: deliveriesInOrder }
    })
  }

  /** Retry a finalization write while its pending delivery row remains durable. */
  private scheduleFinalizationRetry(
    prepared: PreparedBotGroupSend,
    attempts: readonly BotGroupDeliveryAttempt[],
    attempt: number,
  ): void {
    const key = prepared.pending
      .map(delivery => `${delivery.id}:${String(delivery.generation)}`)
      .sort()
      .join('|')
    const delay = groupFinalizationRetryDelay(attempt)
    if (delay === undefined) return
    const prior = this.finalizationRetryAttempts.get(key)
    if (prior !== undefined && prior >= attempt) return
    this.finalizationRetryAttempts.set(key, attempt)
    const run = () => {
      const retry = this.finalizeSend(prepared, attempts)
        .catch(() => { this.scheduleFinalizationRetry(prepared, attempts, attempt + 1) })
        .finally(() => {
          if (this.finalizationRetryAttempts.get(key) === attempt) this.finalizationRetryAttempts.delete(key)
        })
      const tracked = retry.then(() => undefined)
      this.finalizationRetryPromises.add(tracked)
      void tracked.finally(() => { this.finalizationRetryPromises.delete(tracked) })
    }
    const wait = delay === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => { setTimeout(resolve, delay) })
    this.finalizationRetryTimers.add(wait)
    void wait.then(() => {
      this.finalizationRetryTimers.delete(wait)
      run()
    })
  }

  /** Record the exact model turn and step that claimed one or more group messages.
   * @param botId - Authenticated Bot identity that claimed the messages.
   * @param claims - Group deliveries claimed in the turn.
   * @param turn - Durable model turn number.
   * @param step - Model step that observed the claims.
   * @param isolated - Whether the claims are the turn's isolated input.
   * @param competingInput - Whether competing input makes prior isolated claims non-isolated.
   */
  async recordBotMessageClaims(
    botId: BotId,
    claims: readonly BotGroupDeliveryClaimInput[],
    turn: number,
    step: number,
    isolated: boolean,
    competingInput = false,
  ): Promise<void> {
    return this.serialize(async () => {
      if (!Number.isSafeInteger(turn) || turn < 0 || !Number.isSafeInteger(step) || step < 0) {
        throw new BotGroupError('invalid', 'Bot group claims require nonnegative safe turn and step numbers')
      }
      const groups = this.domain.table('groups')
      const deliveries = this.domain.table('deliveries')
      const now = Date.now()
      let changed = false
      if (competingInput) {
        for (const [id, delivery] of deliveries.entries()) {
          if (delivery.botId !== botId || delivery.claim?.turn !== turn || delivery.claim.isolated === false) continue
          await deliveries.put(id, { ...delivery, claim: { ...delivery.claim, isolated: false }, updatedAt: now })
          changed = true
        }
      }
      for (const claim of claims) {
        const group = groups.get(claim.groupId)
        if (group === undefined) continue
        const id = deliveryId(claim.messageId, botId)
        const delivery = deliveries.get(id)
        const newerRetry = delivery?.status === 'failed'
          && (delivery.claim === undefined || turn > delivery.claim.turn)
        if (delivery === undefined
          || delivery.groupId !== claim.groupId
          || delivery.messageId !== claim.messageId
          || delivery.botId !== botId
          || (!newerRetry && delivery.status !== 'pending' && delivery.status !== 'accepted' && delivery.status !== 'responded')) continue
        if (delivery.claim !== undefined
          && (turn < delivery.claim.turn
            || (turn === delivery.claim.turn && step < delivery.claim.step))) continue
        const nextClaim: BotGroupDeliveryClaim = { turn, step, isolated }
        if (delivery.claim?.turn === turn && delivery.claim.step === step && delivery.claim.isolated === isolated) continue
        const nextDelivery: BotGroupDeliveryRecord = newerRetry
          ? {
            id: delivery.id,
            groupId: delivery.groupId,
            messageId: delivery.messageId,
            botId: delivery.botId,
            status: 'accepted',
            ...(delivery.responseMessageId === undefined ? {} : { responseMessageId: delivery.responseMessageId }),
            claim: nextClaim,
            updatedAt: now,
          }
          : { ...delivery, claim: nextClaim, updatedAt: now }
        await deliveries.put(id, nextDelivery)
        changed = true
        if (now > group.updatedAt) await groups.put(group.id, { ...group, updatedAt: now })
      }
      const sameTurnClaims = [...deliveries.entries()]
        .map(([, delivery]) => delivery)
        .filter(delivery => delivery.botId === botId && delivery.claim?.turn === turn && delivery.claim.isolated)
      if (sameTurnClaims.length > 1) {
        for (const delivery of sameTurnClaims) {
          const claim = delivery.claim
          if (claim === undefined) continue
          await deliveries.put(delivery.id, { ...delivery, claim: { ...claim, isolated: false }, updatedAt: now })
          changed = true
        }
      }
      if (changed) this.host.changed?.()
    })
  }

  /**
   * Persist a failed model turn against its isolated group delivery.
   *
   * Queuing a message only proves that it entered the Bot Session. The turn
   * end event is the durable evidence that the model either replied or failed;
   * only an isolated, still-pending or accepted delivery can be changed here
   * so private or already projected turns never leak into a group transcript.
   * @param botId - Live Bot identity owning the model turn.
   * @param turn - Durable model turn number.
   * @param error - Safe user-facing failure description.
   */
  async recordBotTurnFailure(botId: BotId, turn: number, error: string): Promise<void> {
    await this.serialize(async () => {
      if (!Number.isSafeInteger(turn) || turn < 0) return
      const safeError = normalizeText(error, 'Bot group failure', 400)
      const deliveries = this.domain.table('deliveries')
      const groups = this.domain.table('groups')
      const now = Date.now()
      let changed = false
      for (const [id, delivery] of deliveries.entries()) {
        const claim = delivery.claim
        if (delivery.botId !== botId
          || (delivery.status !== 'pending' && delivery.status !== 'accepted')
          || claim === undefined
          || claim.turn !== turn
          || !claim.isolated) continue
        const group = groups.get(delivery.groupId)
        if (group === undefined) continue
        await deliveries.put(id, { ...delivery, status: 'failed', error: safeError, updatedAt: now })
        if (now > group.updatedAt) await groups.put(group.id, { ...group, updatedAt: now })
        changed = true
      }
      if (changed) this.host.changed?.()
    })
  }

  /** Record one real Bot response against its one exact claimed group delivery.
   * @param botId - Authenticated Bot identity that produced the response.
   * @param turn - Durable model turn number.
   * @param step - Model step that produced the response.
   * @param text - Visible response text.
   * @param sourceMessageId - Source message identity used to derive the response id.
   */
  async recordBotResponse(botId: BotId, turn: number, step: number, text: string, sourceMessageId: string): Promise<void> {
    await this.serialize(async () => {
      const messageText = normalizeText(text, 'Bot group response', MAX_MESSAGE_TEXT)
      const bots = await this.host.listBots()
      const bot = bots.find(candidate => candidate.id === botId)
      if (bot === undefined) return
      const deliveries = this.domain.table('deliveries')
      const messages = this.domain.table('messages')
      if (!Number.isSafeInteger(turn) || turn < 0 || !Number.isSafeInteger(step) || step < 0) return
      const candidates = [...deliveries.entries()]
        .map(([, delivery]) => delivery)
        .filter(delivery => delivery.botId === botId
          && (delivery.status === 'pending' || delivery.status === 'accepted' || delivery.status === 'responded')
          && delivery.claim?.turn === turn
          && delivery.claim.isolated)
        .filter(delivery => delivery.claim !== undefined && delivery.claim.step <= step)
      if (candidates.length !== 1) return
      const delivery = candidates[0]
      if (delivery === undefined) return
      const group = this.domain.table('groups').get(delivery.groupId)
      if (group === undefined) return
      const source = messages.get(delivery.messageId)
      if (source === undefined) return
      if (source.groupId !== delivery.groupId) return
      const messageId = responseMessageId(group.id, botId, sourceMessageId)
      const now = Math.max(Date.now(), source.createdAt + 1)
      let changed = false
      const currentResponse = messages.get(messageId)
      if (currentResponse === undefined) {
        await messages.put(messageId, {
          id: messageId,
          groupId: group.id,
          sender: { kind: 'bot', botId },
          senderName: bot.name,
          text: messageText,
          createdAt: now,
        })
        changed = true
      } else if (currentResponse.groupId !== group.id
        || currentResponse.sender.kind !== 'bot'
        || currentResponse.sender.botId !== botId
        || currentResponse.text !== messageText) {
        await messages.put(messageId, {
          ...currentResponse, groupId: group.id, sender: { kind: 'bot', botId }, text: messageText,
        })
        changed = true
      }
      const previousResponseId = delivery.responseMessageId
      if (previousResponseId !== undefined && previousResponseId !== messageId) {
        const previousResponse = messages.get(previousResponseId)
        if (previousResponse?.groupId === group.id
          && previousResponse.sender.kind === 'bot'
          && previousResponse.sender.botId === botId) {
          await messages.delete(previousResponseId)
          changed = true
        }
      }
      await deliveries.put(delivery.id, {
        ...delivery, status: 'responded', responseMessageId: messageId, updatedAt: now,
      })
      changed = true
      if (changed) this.host.changed?.()
    })
  }

  /** Wait until already-admitted group writes have settled before shutdown. */
  async whenIdle(): Promise<void> {
    while (true) {
      await this.chain
      const pending = [...this.externalDeliveries]
      const timers = [...this.finalizationRetryTimers]
      const retries = [...this.finalizationRetryPromises]
      if (pending.length === 0 && timers.length === 0 && retries.length === 0) return
      await Promise.all([...pending, ...timers, ...retries])
    }
  }

  private sender(group: BotGroupRecord, botId: BotId, bots: readonly BotView[]): { readonly kind: 'bot'; readonly botId: BotId } {
    const bot = bots.find(candidate => candidate.id === botId)
    if (bot === undefined || !group.botIds.includes(botId)) throw new BotGroupError('member-not-found', `Bot "${String(botId)}" is not a member of this group`)
    return { kind: 'bot', botId }
  }

  /** Bind a new in-process reservation claim for one durable delivery id. */
  private claimDeliveryGeneration(id: string): number {
    this.nextDeliveryGeneration += 1
    this.deliveryGenerations.set(id, this.nextDeliveryGeneration)
    return this.nextDeliveryGeneration
  }

  private recipientIds(
    group: BotGroupRecord,
    sender: BotGroupMessageSender,
    requested?: readonly BotId[],
  ): readonly BotId[] {
    const defaults = group.botIds.filter(botId => sender.kind !== 'bot' || botId !== sender.botId)
    if (requested === undefined) return defaults
    if (requested.length === 0 || requested.length > MAX_GROUP_MEMBERS) {
      throw new BotGroupError('invalid', `Bot group targets must contain 1-${String(MAX_GROUP_MEMBERS)} members`)
    }
    if (new Set(requested.map(String)).size !== requested.length) {
      throw new BotGroupError('invalid', 'Bot group targets must be unique')
    }
    for (const botId of requested) {
      if (!group.botIds.includes(botId)) throw new BotGroupError('member-not-found', `Bot "${String(botId)}" is not a member of this group`)
      if (sender.kind === 'bot' && sender.botId === botId) {
        throw new BotGroupError('invalid', 'A Bot cannot target itself in a group message')
      }
    }
    return [...requested]
  }

  private view(record: BotGroupRecord, bots: readonly BotView[]): BotGroupView {
    return {
      ...record,
      bots: record.botIds.flatMap((botId) => {
        const bot = bots.find(candidate => candidate.id === botId)
        return bot === undefined ? [] : [{
          id: bot.id, name: bot.name, ...(bot.description === undefined ? {} : { description: bot.description }),
          identity: bot.identity, accent: bot.accent, ...(bot.avatar === undefined ? {} : { avatar: bot.avatar }),
          availability: bot.availability, state: bot.state,
        }]
      }),
    }
  }

  private messageView(message: BotGroupMessageRecord, bots: readonly BotView[], group: BotGroupRecord): BotGroupMessageView {
    const sender = message.sender
    if (sender.kind === 'user') {
      const attachments = this.attachments?.attachmentsForMessage({
        kind: 'local-group',
        ownerId: this.ownerId,
        groupId: group.id,
        messageId: message.id,
        targetBotIds: message.targetBotIds ?? this.recipientIds(group, sender),
        authorizationRevision: group.updatedAt,
      }) ?? []
      return {
        ...message,
        sender,
        ...(attachments.length === 0 ? {} : { attachments: attachments.map(localAttachmentView) }),
      }
    }
    const bot = bots.find(candidate => candidate.id === sender.botId)
    return {
      ...message,
      sender: { kind: 'bot', botId: sender.botId, name: message.senderName ?? bot?.name ?? String(sender.botId) },
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.chain.then(work)
    this.chain = pending.catch(() => undefined)
    return pending
  }

  private trackExternal<T>(work: Promise<T>): Promise<T> {
    const settled = work.then(() => undefined, () => undefined)
    this.externalDeliveries.add(settled)
    void settled.then(() => { this.externalDeliveries.delete(settled) })
    return work
  }

  private async deliverExternal(delivery: PreparedBotGroupDelivery): Promise<void> {
    try {
      let result: 'accepted' | 'duplicate'
      if (delivery.principalId === undefined) {
        result = await this.host.deliverToBot({
          targetBotId: delivery.botId,
          groupId: delivery.groupId,
          groupName: delivery.groupName,
          ...(delivery.senderName === undefined ? {} : { senderName: delivery.senderName }),
          text: delivery.text,
          ...(delivery.attachments === undefined ? {} : { attachments: delivery.attachments }),
          messageId: delivery.messageId,
          ...(delivery.signal === undefined ? {} : { signal: delivery.signal }),
        })
      } else {
        const deliverToSharedGroup = this.host.deliverToSharedGroup
        if (deliverToSharedGroup === undefined) {
          throw new BotGroupError('delivery-failed', 'Shared Bot group delivery is unavailable without an isolated Session')
        }
        result = await deliverToSharedGroup({
          principalId: delivery.principalId,
          targetBotId: delivery.botId,
          groupId: delivery.groupId,
          groupName: delivery.groupName,
          text: delivery.text,
          ...(delivery.attachments === undefined ? {} : { attachments: delivery.attachments }),
          messageId: delivery.messageId,
          ...(delivery.signal === undefined ? {} : { signal: delivery.signal }),
        })
      }
      delivery.flight.resolve({ delivery, result })
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      delivery.flight.resolve({ delivery, error: detail.slice(0, 400) || 'Bot delivery failed' })
    }
  }
}

interface PreparedBotGroupDelivery {
  readonly id: string
  readonly groupId: BotGroupId
  readonly messageId: BotGroupMessageId
  readonly botId: BotId
  readonly generation: number
  readonly groupName: string
  readonly flight: BotGroupDeliveryFlight
  readonly owner: boolean
  readonly principalId?: BotPrincipalIdType
  readonly senderName?: string
  readonly text: string
  readonly attachments?: readonly BotInputAttachment[]
  readonly signal?: AbortSignal
}

interface PreparedBotGroupSend {
  readonly groupId: BotGroupId
  readonly messageId: BotGroupMessageId
  readonly pending: readonly PreparedBotGroupDelivery[]
  readonly outcomes: Map<string, BotGroupDeliveryView>
  readonly targetBotIds: readonly BotId[]
  readonly attachments: readonly BotInputAttachment[]
}

interface BotGroupDeliveryAttempt {
  readonly delivery: PreparedBotGroupDelivery
  readonly result?: 'accepted' | 'duplicate'
  readonly error?: string
}

interface BotGroupDeliveryFlight {
  readonly promise: Promise<BotGroupDeliveryAttempt>
  readonly resolve: (attempt: BotGroupDeliveryAttempt) => void
}

function createBotGroupDeliveryFlight(): BotGroupDeliveryFlight {
  let settle: ((attempt: BotGroupDeliveryAttempt) => void) | undefined
  const promise = new Promise<BotGroupDeliveryAttempt>((resolve) => { settle = resolve })
  return {
    promise,
    resolve: (attempt) => { settle?.(attempt) },
  }
}

function deliveryId(messageId: BotGroupMessageId, botId: BotId): string {
  return `delivery-${createHash('sha256').update(`${String(messageId)}:${String(botId)}`).digest('hex')}`
}

function localAttachmentView(attachment: BotInputAttachment): BotInputAttachmentView {
  if (attachment.type === 'image') {
    return {
      type: 'image',
      attachmentId: String(attachment.attachment.attachmentId),
      mediaType: attachment.attachment.mediaType,
      bytes: attachment.attachment.bytes,
      width: attachment.attachment.width,
      height: attachment.attachment.height,
      ...(attachment.attachment.name === undefined ? {} : { name: attachment.attachment.name }),
    }
  }
  return {
    type: 'file', attachmentId: String(attachment.attachment.attachmentId),
    name: attachment.attachment.name, bytes: attachment.attachment.bytes,
  }
}

/** Keep the table type visible to BotService without exposing its implementation. */
export type BotGroupDomain = Domain<typeof botGroupDomain>
