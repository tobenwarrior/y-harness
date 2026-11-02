/** Durable multi-Bot groups and explicit fan-out delivery. */

import { createHash, randomUUID } from 'node:crypto'
import { brandString, type Branded } from '@yharness/brand'
import type { Domain } from '@yharness/storage-domain'
import { defineDomain, domainTable } from '@yharness/storage-domain'
import { BotId } from './types.ts'
import type { BotView } from './types.ts'
import { z } from 'zod'

/** Stable identity of one durable Bot group. */
export type BotGroupId = Branded<'BotGroupId'>

/** Apply the Bot group identity brand to a validated value. */
export function BotGroupId(value: string): BotGroupId {
  return brandString<BotGroupId>(value)
}

/** Stable identity of one message in a Bot group transcript. */
export type BotGroupMessageId = Branded<'BotGroupMessageId'>

/** Apply the Bot group message identity brand to a validated value. */
export function BotGroupMessageId(value: string): BotGroupMessageId {
  return brandString<BotGroupMessageId>(value)
}

/** Human-authored or Bot-authored group message attribution. */
export type BotGroupMessageSender =
  | { readonly kind: 'user' }
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
  /** User-visible text. */
  readonly text: string
  /** Creation time in Unix milliseconds. */
  readonly createdAt: number
}

/** Durable per-recipient delivery state for one group message. */
export interface BotGroupDeliveryRecord {
  /** Composite key `${messageId}:${botId}`. */
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
  | { readonly kind: 'user' }
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
}

/** Human or Bot group message request. */
export interface BotGroupSendRequest {
  /** Group receiving the message. */
  readonly groupId: BotGroupId
  /** Message text. */
  readonly text: string
  /** Optional retry identity. */
  readonly messageId?: BotGroupMessageId
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

/** Host operation used to deliver one message into a real Bot Session. */
export interface BotGroupDeliveryHost {
  /** Read the current durable Bot roster. */
  readonly listBots: () => Promise<readonly BotView[]>
  /** Queue a model-visible message in one target Bot Session and flush it. */
  readonly deliverToBot: (request: {
    readonly targetBotId: BotId
    readonly groupId: BotGroupId
    readonly groupName: string
    readonly text: string
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
  z.object({ kind: z.literal('user') }).strict(),
  z.object({ kind: z.literal('bot'), botId: botIdSchema }).strict(),
])

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
  text: groupTextSchema,
  createdAt: z.number().safe().int().nonnegative(),
}).strict()

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

/** Create one deterministic message id from a group and source message identity. */
function responseMessageId(groupId: BotGroupId, sourceId: string): BotGroupMessageId {
  const digest = createHash('sha256').update(`${String(groupId)}:${sourceId}`).digest('hex')
  return BotGroupMessageId(`bot-group-message-${digest}`)
}

function sameIds(left: readonly BotId[], right: readonly BotId[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/** Durable group roster and fan-out delivery owner. */
export class BotGroupService {
  private chain: Promise<unknown> = Promise.resolve()

  /** @param domain - Open group domain. @param host - Bot roster and delivery capabilities. */
  constructor(
    private readonly domain: Domain<typeof botGroupDomain>,
    private readonly host: BotGroupDeliveryHost,
  ) {}

  /** List durable groups with current member projections. */
  async list(_request: BotGroupListRequest): Promise<BotGroupListValue> {
    await this.chain
    const bots = await this.host.listBots()
    const table = this.domain.table('groups')
    const groups = [...table.entries()]
      .map(([, record]) => this.view(record, bots))
      .sort((left, right) => left.createdAt - right.createdAt || String(left.id).localeCompare(String(right.id)))
    return { groups }
  }

  /** Create or idempotently reuse one 2–6 Bot group. */
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
        if (existing.name === name && sameIds(existing.botIds, botIds)) return { group: this.view(existing, bots) }
        throw new BotGroupError('invalid', `Bot group "${String(id)}" already exists with different metadata`)
      }
      const now = Date.now()
      const record: BotGroupRecord = { id, name, botIds, createdAt: now, updatedAt: now }
      await groups.put(id, record)
      return { group: this.view(record, bots) }
    })
  }

  /** Read one durable group transcript. */
  async inspect(request: BotGroupInspectRequest): Promise<BotGroupInspectValue> {
    await this.chain
    const id = normalizeGroupId(request.groupId)
    const bots = await this.host.listBots()
    const group = this.domain.table('groups').get(id)
    if (group === undefined) throw new BotGroupError('not-found', `Bot group "${String(id)}" was not found`)
    const messages = [...this.domain.table('messages').entries()]
      .map(([, message]) => message)
      .filter(message => message.groupId === id)
      .sort((left, right) => left.createdAt - right.createdAt || String(left.id).localeCompare(String(right.id)))
      .map(message => this.messageView(message, bots))
    return { group: this.view(group, bots), messages }
  }

  /** Persist one human or Bot message, then fan it out to every intended recipient. */
  async send(request: BotGroupSendRequest): Promise<BotGroupSendValue> {
    return this.sendInternal(request)
  }

  /** Persist and fan out one message authored by the exact live Bot identity supplied by the Host. */
  async sendAsBot(senderBotId: BotId, request: BotGroupSendRequest): Promise<BotGroupSendValue> {
    return this.sendInternal(request, senderBotId)
  }

  private async sendInternal(request: BotGroupSendRequest, senderBotId?: BotId): Promise<BotGroupSendValue> {
    return this.serialize(async () => {
      const groupId = normalizeGroupId(request.groupId)
      const text = normalizeText(request.text, 'Bot group message', MAX_MESSAGE_TEXT)
      const group = this.domain.table('groups').get(groupId)
      if (group === undefined) throw new BotGroupError('not-found', `Bot group "${String(groupId)}" was not found`)
      const bots = await this.host.listBots()
      const sender = senderBotId === undefined
        ? ({ kind: 'user' } as const)
        : this.sender(group, senderBotId, bots)
      const messageId = normalizeMessageId(request.messageId)
      const messages = this.domain.table('messages')
      const existing = messages.get(messageId)
      if (existing !== undefined) {
        if (existing.groupId !== groupId || existing.text !== text || existing.sender.kind !== sender.kind
          || (existing.sender.kind === 'bot' && sender.kind === 'bot' && existing.sender.botId !== sender.botId)) {
          throw new BotGroupError('invalid', `Bot group message "${String(messageId)}" already exists with different content`)
        }
      } else {
        await messages.put(messageId, {
          id: messageId, groupId, sender, text, createdAt: Date.now(),
        })
      }
      const deliveries = this.domain.table('deliveries')
      const outcomes: BotGroupDeliveryView[] = []
      let admitted = false
      for (const botId of group.botIds) {
        if (sender.kind === 'bot' && sender.botId === botId) continue
        const id = deliveryId(messageId, botId)
        const current = deliveries.get(id)
        if (current?.status === 'accepted' || current?.status === 'responded') {
          outcomes.push({ botId, status: 'duplicate' })
          continue
        }
        const pending: BotGroupDeliveryRecord = {
          id, groupId, messageId, botId, status: 'pending', updatedAt: Date.now(),
        }
        if (current === undefined) await deliveries.put(id, pending)
        try {
          const result = await this.host.deliverToBot({
            targetBotId: botId,
            groupId,
            groupName: group.name,
            text,
            messageId,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          })
          const next: BotGroupDeliveryRecord = { ...pending, status: 'accepted', updatedAt: Date.now() }
          await deliveries.put(id, next)
          outcomes.push({ botId, status: result })
          admitted ||= result === 'accepted'
        } catch (error: unknown) {
          const detail = error instanceof Error ? error.message : String(error)
          await deliveries.put(id, { ...pending, status: 'failed', error: detail.slice(0, 400), updatedAt: Date.now() })
          outcomes.push({ botId, status: 'failed', error: detail.slice(0, 400) })
        }
      }
      const hasFailure = outcomes.some(outcome => outcome.status === 'failed')
      const status = hasFailure ? 'partial' : admitted ? 'accepted' : 'duplicate'
      const updatedAt = Date.now()
      if (updatedAt > group.updatedAt) await this.domain.table('groups').put(group.id, { ...group, updatedAt })
      return { messageId, status, deliveries: outcomes }
    })
  }

  /** Record the exact model turn and step that claimed one or more group messages. */
  async recordBotMessageClaims(
    botId: BotId,
    claims: readonly BotGroupDeliveryClaimInput[],
    turn: number,
    step: number,
    isolated: boolean,
  ): Promise<void> {
    return this.serialize(async () => {
      if (!Number.isSafeInteger(turn) || turn < 0 || !Number.isSafeInteger(step) || step < 0) {
        throw new BotGroupError('invalid', 'Bot group claims require nonnegative safe turn and step numbers')
      }
      if (claims.length === 0) return
      const groups = this.domain.table('groups')
      const deliveries = this.domain.table('deliveries')
      const now = Date.now()
      for (const claim of claims) {
        const group = groups.get(claim.groupId)
        if (group === undefined || !group.botIds.includes(botId)) continue
        const id = deliveryId(claim.messageId, botId)
        const delivery = deliveries.get(id)
        if (delivery === undefined || (delivery.status !== 'accepted' && delivery.status !== 'responded')) continue
        const nextClaim: BotGroupDeliveryClaim = { turn, step, isolated }
        if (delivery.claim?.turn === turn && delivery.claim.step === step && delivery.claim.isolated === isolated) continue
        await deliveries.put(id, { ...delivery, claim: nextClaim, updatedAt: now })
        if (now > group.updatedAt) await groups.put(group.id, { ...group, updatedAt: now })
      }
    })
  }

  /** Record one real Bot response against its one exact claimed group delivery. */
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
          && delivery.status === 'accepted'
          && delivery.claim?.turn === turn
          && delivery.claim.step === step
          && delivery.claim.isolated)
      if (candidates.length !== 1) return
      const pending = candidates[0]
      if (pending === undefined) return
      const group = this.domain.table('groups').get(pending.groupId)
      if (group === undefined || !group.botIds.includes(botId)) return
      const source = messages.get(pending.messageId)
      if (source === undefined) return
      const messageId = responseMessageId(group.id, sourceMessageId)
      const now = Math.max(Date.now(), source.createdAt + 1)
      if (messages.get(messageId) === undefined) {
        await messages.put(messageId, {
          id: messageId, groupId: group.id, sender: { kind: 'bot', botId }, text: messageText, createdAt: now,
        })
      }
      await deliveries.put(pending.id, {
        ...pending, status: 'responded', responseMessageId: messageId, updatedAt: now,
      })
    })
  }

  /** Wait until already-admitted group writes have settled before shutdown. */
  async whenIdle(): Promise<void> {
    await this.chain
  }

  private sender(group: BotGroupRecord, botId: BotId, bots: readonly BotView[]): { readonly kind: 'bot'; readonly botId: BotId } {
    const bot = bots.find(candidate => candidate.id === botId)
    if (bot === undefined || !group.botIds.includes(botId)) throw new BotGroupError('member-not-found', `Bot "${String(botId)}" is not a member of this group`)
    return { kind: 'bot', botId }
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

  private messageView(message: BotGroupMessageRecord, bots: readonly BotView[]): BotGroupMessageView {
    const sender = message.sender
    if (sender.kind === 'user') return { ...message, sender }
    const bot = bots.find(candidate => candidate.id === sender.botId)
    return {
      ...message,
      sender: { kind: 'bot', botId: sender.botId, name: bot?.name ?? String(sender.botId) },
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.chain.then(work)
    this.chain = pending.catch(() => undefined)
    return pending
  }
}

function deliveryId(messageId: BotGroupMessageId, botId: BotId): string {
  return `${String(messageId)}:${String(botId)}`
}

/** Keep the table type visible to BotService without exposing its implementation. */
export type BotGroupDomain = Domain<typeof botGroupDomain>
