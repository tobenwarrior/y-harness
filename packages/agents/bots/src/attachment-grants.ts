/** Durable Bot-message attachment grants and shared-private delivery leases. */

import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { FileAttachmentRef, ImageAttachmentRef } from '@yharness/attachment'
import { AttachmentId } from '@yharness/attachment'
import { brandString, type Branded } from '@yharness/brand'
import type { ContentBlock } from '@yharness/llm'
import { defineDomain, domainTable, type Domain } from '@yharness/storage-domain'
import { z } from 'zod'
import { BotGroupId, BotGroupMessageId } from './group-chat.ts'
import { BotPrincipalId } from './sharing.ts'
import { BotId } from './types.ts'

/** Stable opaque identity for one admitted Bot-message attachment grant. */
export type BotAttachmentGrantId = Branded<'BotAttachmentGrantId'>

/**
 * Apply the grant identity brand to a validated value.
 * @param value - Validated grant identity.
 * @returns Branded grant identity.
 */
export function BotAttachmentGrantId(value: string): BotAttachmentGrantId {
  return brandString<BotAttachmentGrantId>(value)
}

/** Stable identity for one shared-private message. */
export type BotPrivateMessageId = Branded<'BotPrivateMessageId'>

/**
 * Apply the private-message identity brand to a validated value.
 * @param value - Validated message identity.
 * @returns Branded private-message identity.
 */
export function BotPrivateMessageId(value: string): BotPrivateMessageId {
  return brandString<BotPrivateMessageId>(value)
}

/** Attachment content admitted into one model-visible Bot message. */
export type BotInputAttachment =
  | { readonly type: 'image'; readonly attachment: ImageAttachmentRef }
  | { readonly type: 'file'; readonly attachment: FileAttachmentRef }

/** Safe attachment metadata returned before a message is sent. */
export type BotAttachmentMetadata =
  | {
    readonly type: 'image'
    readonly mediaType: ImageAttachmentRef['mediaType']
    readonly bytes: number
    readonly width: number
    readonly height: number
    readonly name?: string
  }
  | { readonly type: 'file'; readonly name: string; readonly bytes: number }

/** Attachment metadata returned in an inspected Bot-group message. */
export type BotInputAttachmentView = BotAttachmentMetadata & {
  /** Immutable provider id; it is not a filesystem path or upload receipt. */
  readonly attachmentId: string
}

/** Exact ownership and recipient scope bound to a grant. */
export type BotAttachmentScope =
  | {
    readonly kind: 'local-group'
    readonly ownerId: string
    readonly groupId: ReturnType<typeof BotGroupId>
    readonly messageId: ReturnType<typeof BotGroupMessageId>
    readonly targetBotIds: readonly BotId[]
    readonly authorizationRevision: number
  }
  | {
    readonly kind: 'shared-group'
    readonly principalId: ReturnType<typeof BotPrincipalId>
    readonly groupId: ReturnType<typeof BotGroupId>
    readonly messageId: ReturnType<typeof BotGroupMessageId>
    readonly targetBotIds: readonly BotId[]
    readonly authorizationRevision: number
  }
  | {
    readonly kind: 'shared-private'
    readonly principalId: ReturnType<typeof BotPrincipalId>
    readonly botId: BotId
    readonly messageId: BotPrivateMessageId
    readonly authorizationRevision: number
  }

/** Durable grant lifecycle. A consumed grant remains available for idempotent retries. */
export type BotAttachmentGrantState = 'reserved' | 'consumed' | 'revoked'

/** Durable grant record stored in the additive attachment domain. */
export interface BotAttachmentGrantRecord {
  readonly id: BotAttachmentGrantId
  readonly scope: BotAttachmentScope
  readonly attachments: readonly BotInputAttachment[]
  readonly state: BotAttachmentGrantState
  readonly createdAt: number
  readonly consumedAt?: number
}

/** Public result of one successful attachment admission. */
export interface BotAttachmentGrantValue {
  readonly grantId: BotAttachmentGrantId
  readonly attachments: readonly BotAttachmentMetadata[]
}

/** Durable shared-private delivery state. */
export interface BotPrivateDeliveryRecord {
  readonly id: string
  readonly scope: Extract<BotAttachmentScope, { readonly kind: 'shared-private' }>
  readonly token: string
  readonly state: 'pending' | 'accepted'
  readonly leaseUntil: number
  readonly updatedAt: number
}

/** Stable failure from grant admission, scope checks, or lease fencing. */
export class BotAttachmentGrantError extends Error {
  /** @param code - Stable safe failure category. @param message - Safe diagnostic. */
  constructor(readonly code: 'invalid' | 'not-found' | 'forbidden' | 'conflict', message: string) {
    super(message)
    this.name = 'BotAttachmentGrantError'
  }
}

const MAX_GRANT_ATTACHMENTS = 8
const MAX_OWNER_ID = 128
const MAX_PRIVATE_MESSAGE_ID = 128
const MAX_LEASE_TOKEN = 256
const grantIdSchema = z.string().regex(/^bot-attachment-grant-[A-Za-z0-9][A-Za-z0-9-]*$/).transform(BotAttachmentGrantId)
const botIdSchema = z.string().regex(/^bot-[A-Za-z0-9][A-Za-z0-9-]*$/).transform(BotId)
const groupIdSchema = z.string().regex(/^bot-group-[A-Za-z0-9][A-Za-z0-9-]*$/).transform(BotGroupId)
const groupMessageIdSchema = z.string().regex(/^bot-group-message-[A-Za-z0-9][A-Za-z0-9-]*$/).transform(BotGroupMessageId)
const privateMessageIdSchema = z.string()
  .regex(/^bot-private-message-[A-Za-z0-9][A-Za-z0-9-]*$/)
  .max(MAX_PRIVATE_MESSAGE_ID)
  .transform(BotPrivateMessageId)
const principalIdSchema = z.string().regex(/^principal-[A-Za-z0-9-]+$/).transform(BotPrincipalId)
const attachmentIdSchema = z.string().min(1).max(512).refine(
  value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value),
  'attachment provider id is invalid',
).transform(AttachmentId)
const fileAttachmentSchema = z.object({
  attachmentId: attachmentIdSchema,
  name: z.string().min(1).max(255),
  bytes: z.number().safe().int().nonnegative(),
}).strict().transform((value): FileAttachmentRef => ({
  attachmentId: value.attachmentId,
  name: value.name,
  bytes: value.bytes,
}))
const imageAttachmentSchema = z.object({
  attachmentId: attachmentIdSchema,
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: z.number().safe().int().nonnegative(),
  width: z.number().safe().int().positive(),
  height: z.number().safe().int().positive(),
  name: z.string().min(1).max(255).optional(),
  originalDimensions: z.object({
    width: z.number().safe().int().positive(),
    height: z.number().safe().int().positive(),
  }).strict().optional(),
}).strict().transform((value): ImageAttachmentRef => ({
  attachmentId: value.attachmentId,
  mediaType: value.mediaType,
  bytes: value.bytes,
  width: value.width,
  height: value.height,
  ...(value.name === undefined ? {} : { name: value.name }),
  ...(value.originalDimensions === undefined ? {} : { originalDimensions: value.originalDimensions }),
}))
const inputAttachmentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('image'), attachment: imageAttachmentSchema }).strict(),
  z.object({ type: z.literal('file'), attachment: fileAttachmentSchema }).strict(),
])
const targetBotIdsSchema = z.array(botIdSchema).min(1).max(6).refine(
  values => new Set(values.map(String)).size === values.length,
  'Bot attachment targets must be unique',
)
const revisionSchema = z.number().safe().int().nonnegative()
const localScopeSchema = z.object({
  kind: z.literal('local-group'),
  ownerId: z.string().min(1).max(MAX_OWNER_ID).refine(value => value.trim() === value),
  groupId: groupIdSchema,
  messageId: groupMessageIdSchema,
  targetBotIds: targetBotIdsSchema,
  authorizationRevision: revisionSchema,
}).strict()
const sharedGroupScopeSchema = z.object({
  kind: z.literal('shared-group'),
  principalId: principalIdSchema,
  groupId: groupIdSchema,
  messageId: groupMessageIdSchema,
  targetBotIds: targetBotIdsSchema,
  authorizationRevision: revisionSchema,
}).strict()
const sharedGroupProjectionScopeSchema = sharedGroupScopeSchema
const sharedPrivateScopeSchema = z.object({
  kind: z.literal('shared-private'),
  principalId: principalIdSchema,
  botId: botIdSchema,
  messageId: privateMessageIdSchema,
  authorizationRevision: revisionSchema,
}).strict()
const scopeSchema = z.discriminatedUnion('kind', [localScopeSchema, sharedGroupScopeSchema, sharedPrivateScopeSchema])

/** Durable grant schema exported for persistence gates and focused validation tests. */
export const botAttachmentGrantSchema = z.object({
  id: grantIdSchema,
  scope: scopeSchema,
  attachments: z.array(inputAttachmentSchema).min(1).max(MAX_GRANT_ATTACHMENTS),
  state: z.enum(['reserved', 'consumed', 'revoked']),
  createdAt: z.number().safe().int().nonnegative(),
  consumedAt: z.number().safe().int().nonnegative().optional(),
}).strict().superRefine((record, context) => {
  if (record.state === 'consumed' && record.consumedAt === undefined) {
    context.addIssue({ code: 'custom', message: 'consumed grants require consumedAt', path: ['consumedAt'] })
  }
  if (record.state !== 'consumed' && record.consumedAt !== undefined) {
    context.addIssue({ code: 'custom', message: 'only consumed grants may have consumedAt', path: ['consumedAt'] })
  }
}).transform((value): BotAttachmentGrantRecord => ({
  id: value.id,
  scope: value.scope,
  attachments: value.attachments,
  state: value.state,
  createdAt: value.createdAt,
  ...(value.consumedAt === undefined ? {} : { consumedAt: value.consumedAt }),
}))

const privateDeliverySchema = z.object({
  id: z.string().min(1).max(512),
  scope: sharedPrivateScopeSchema,
  token: z.string().min(1).max(MAX_LEASE_TOKEN),
  state: z.enum(['pending', 'accepted']),
  leaseUntil: z.number().safe().int().nonnegative(),
  updatedAt: z.number().safe().int().nonnegative(),
}).strict().transform((value): BotPrivateDeliveryRecord => ({
  id: value.id,
  scope: value.scope,
  token: value.token,
  state: value.state,
  leaseUntil: value.leaseUntil,
  updatedAt: value.updatedAt,
}))

/** Additive durable domain for grants and shared-private delivery leases. */
export const botAttachmentDomain = defineDomain({
  name: 'agent_bot_input_attachments',
  version: 1,
  layout: 'per-record',
  tables: {
    grants: domainTable<BotAttachmentGrantId, BotAttachmentGrantRecord>(botAttachmentGrantSchema),
    private_deliveries: domainTable<string, BotPrivateDeliveryRecord>(privateDeliverySchema),
  },
})

/** Additive store shared by local and shared Bot message consumers. */
export class BotAttachmentGrantStore {
  private readonly grants
  private readonly privateDeliveries

  /** @param domain - Open additive attachment domain. */
  constructor(private readonly domain: Domain<typeof botAttachmentDomain>) {
    this.grants = domain.table('grants')
    this.privateDeliveries = domain.table('private_deliveries')
  }

  /** Reload grant and delivery projections before a shared authority operation. */
  async refresh(): Promise<void> {
    await this.domain.refresh()
  }

  /**
   * Persist one opaque grant after the caller has checked its ACL.
   * @param scope - Exact message and recipient scope.
   * @param attachments - Provider-admitted immutable references.
   * @param now - Durable creation timestamp.
   * @returns opaque grant id and safe metadata.
   */
  async admit(
    scope: BotAttachmentScope,
    attachments: readonly BotInputAttachment[],
    now = Date.now(),
  ): Promise<BotAttachmentGrantValue> {
    const normalizedScope = normalizeScope(scope)
    const parsedAttachments = parseAttachments(attachments)
    const id = BotAttachmentGrantId(`bot-attachment-grant-${randomUUID()}`)
    const record: BotAttachmentGrantRecord = {
      id,
      scope: normalizedScope,
      attachments: parsedAttachments,
      state: 'reserved',
      createdAt: safeTimestamp(now, 'grant creation time'),
    }
    await this.grants.put(id, record)
    return { grantId: id, attachments: parsedAttachments.map(attachmentMetadata) }
  }

  /**
   * Consume grants whose scopes exactly match one message operation.
   * @param scope - Current authorization and recipient scope.
   * @param ids - Opaque grant ids supplied by the caller.
   * @param now - Durable consumption timestamp.
   * @returns admitted references and whether this was a retry.
   */
  async consume(
    scope: BotAttachmentScope,
    ids: readonly BotAttachmentGrantId[],
    now = Date.now(),
  ): Promise<{ readonly status: 'none' | 'accepted' | 'duplicate'; readonly attachments: readonly BotInputAttachment[] }> {
    if (ids.length === 0) return { status: 'none', attachments: [] }
    const normalizedScope = normalizeScope(scope)
    const records = this.readGrantRecords(normalizedScope, ids)
    const status = records.every(record => record.state === 'consumed') ? 'duplicate' : 'accepted'
    const timestamp = safeTimestamp(now, 'grant consumption time')
    for (const record of records) {
      if (record.state !== 'reserved') continue
      await this.grants.put(record.id, { ...record, state: 'consumed', consumedAt: timestamp })
    }
    return {
      status,
      attachments: records.flatMap(record => record.attachments),
    }
  }

  /**
   * Validate grant ids and scope without changing their durable state.
   * @param scope - Current authorization and recipient scope.
   * @param ids - Opaque grant ids supplied by the caller.
   */
  validate(scope: BotAttachmentScope, ids: readonly BotAttachmentGrantId[]): void {
    if (ids.length === 0) return
    this.readGrantRecords(normalizeScope(scope), ids)
  }

  /**
   * Preview the immutable references for a grant set without consuming it.
   * @param scope - Current authorization and message scope.
   * @param ids - Opaque grant ids supplied by the caller.
   * @returns references in grant order, suitable for retry-content validation.
   */
  preview(scope: BotAttachmentScope, ids: readonly BotAttachmentGrantId[]): readonly BotInputAttachment[] {
    if (ids.length === 0) return []
    return this.readGrantRecords(normalizeScope(scope), ids).flatMap(record => record.attachments)
  }

  /**
   * Read consumed attachment content for an exact message scope.
   * @param scope - Current authorization scope.
   * @returns references in durable admission order.
   */
  attachmentsForMessage(scope: BotAttachmentScope): readonly BotInputAttachment[] {
    const normalizedScope = normalizeScope(scope)
    return [...this.grants.entries()]
      .map(([, record]) => record)
      .filter(record => record.state === 'consumed' && sameMessageScope(record.scope, normalizedScope))
      .sort((left, right) => left.createdAt - right.createdAt || String(left.id).localeCompare(String(right.id)))
      .flatMap(record => record.attachments)
  }

  /**
   * Read shared-group attachments for an already ACL-authorized transcript.
   * The sender principal remains part of the projection scope so a reused
   * message id cannot expose another principal's consumed grant.
   * @param scope - Group message and recipient projection scope.
   * @returns references in durable admission order.
   */
  attachmentsForSharedGroupMessage(
    scope: Pick<Extract<BotAttachmentScope, { readonly kind: 'shared-group' }>, 'principalId' | 'groupId' | 'messageId' | 'targetBotIds' | 'authorizationRevision'>,
  ): readonly BotInputAttachment[] {
    const parsed = sharedGroupProjectionScopeSchema.safeParse({ kind: 'shared-group', ...scope })
    if (!parsed.success) throw new BotAttachmentGrantError('invalid', 'shared-group attachment projection scope is invalid')
    const { principalId, groupId, messageId, targetBotIds } = parsed.data
    const normalizedTargets = sortIds(targetBotIds)
    return [...this.grants.entries()]
      .map(([, record]) => record)
      .filter(record => record.state === 'consumed'
        && record.scope.kind === 'shared-group'
        && record.scope.principalId === principalId
        && record.scope.groupId === groupId
        && record.scope.messageId === messageId
        && isDeepStrictEqual(record.scope.targetBotIds, normalizedTargets))
      .sort((left, right) => left.createdAt - right.createdAt || String(left.id).localeCompare(String(right.id)))
      .flatMap(record => record.attachments)
  }

  /**
   * Reserve one shared-private message lease under the caller's authority lock.
   * @param scope - Exact principal, Bot, message, and membership revision.
   * @param token - Caller-owned lease token.
   * @param now - Current durable time.
   * @param leaseMs - Positive bounded lease duration.
   * @returns reserved, busy, or duplicate.
   */
  async reservePrivateDelivery(
    scope: Extract<BotAttachmentScope, { readonly kind: 'shared-private' }>,
    token: string,
    now: number,
    leaseMs: number,
  ): Promise<'reserved' | 'busy' | 'duplicate'> {
    if (token.length < 1 || token.length > MAX_LEASE_TOKEN) {
      throw new BotAttachmentGrantError('invalid', 'private delivery lease token is invalid')
    }
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) {
      throw new BotAttachmentGrantError('invalid', 'private delivery lease duration is invalid')
    }
    const normalizedScope = normalizePrivateScope(scope)
    const id = privateDeliveryKey(normalizedScope)
    const current = this.privateDeliveries.get(id)
    const timestamp = safeTimestamp(now, 'private delivery time')
    if (current?.state === 'accepted') return 'duplicate'
    if (current !== undefined && current.leaseUntil > timestamp) return 'busy'
    await this.privateDeliveries.put(id, {
      id,
      scope: normalizedScope,
      token,
      state: 'pending',
      leaseUntil: timestamp + leaseMs,
      updatedAt: timestamp,
    })
    return 'reserved'
  }

  /**
   * Extend a live private delivery lease without changing its owner token.
   * @param scope - Exact principal, Bot, message, and membership revision.
   * @param token - Lease token returned by reservation.
   * @param now - Current durable time.
   * @param leaseMs - Positive bounded lease duration.
   * @returns whether this token still owns a pending lease.
   */
  async renewPrivateDelivery(
    scope: Extract<BotAttachmentScope, { readonly kind: 'shared-private' }>,
    token: string,
    now: number,
    leaseMs: number,
  ): Promise<boolean> {
    if (token.length < 1 || token.length > MAX_LEASE_TOKEN) {
      throw new BotAttachmentGrantError('invalid', 'private delivery lease token is invalid')
    }
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 300_000) {
      throw new BotAttachmentGrantError('invalid', 'private delivery lease duration is invalid')
    }
    const normalizedScope = normalizePrivateScope(scope)
    const id = privateDeliveryKey(normalizedScope)
    const current = this.privateDeliveries.get(id)
    if (current === undefined || current.state !== 'pending' || current.token !== token) return false
    const timestamp = safeTimestamp(now, 'private delivery renewal time')
    await this.privateDeliveries.put(id, {
      ...current,
      leaseUntil: timestamp + leaseMs,
      updatedAt: timestamp,
    })
    return true
  }

  /**
   * Read the durable private-message lease for one exact authorization scope.
   * @param scope - Principal, Bot, message, and membership revision.
   * @returns the current lease, when one exists.
   */
  readPrivateDelivery(
    scope: Extract<BotAttachmentScope, { readonly kind: 'shared-private' }>,
  ): BotPrivateDeliveryRecord | undefined {
    const normalizedScope = normalizePrivateScope(scope)
    return this.privateDeliveries.get(privateDeliveryKey(normalizedScope))
  }

  /**
   * Mark a private delivery accepted if its lease is still current.
   * @param scope - Exact operation scope.
   * @param token - Lease token returned by reservation.
   * @param state - Durable completion state.
   * @param now - Completion timestamp.
   * @returns whether this token still owned the pending lease.
   */
  async settlePrivateDelivery(
    scope: Extract<BotAttachmentScope, { readonly kind: 'shared-private' }>,
    token: string,
    state: 'accepted',
    now = Date.now(),
  ): Promise<boolean> {
    const normalizedScope = normalizePrivateScope(scope)
    const id = privateDeliveryKey(normalizedScope)
    const current = this.privateDeliveries.get(id)
    if (current === undefined || current.token !== token || current.state !== 'pending') return false
    await this.privateDeliveries.put(id, {
      ...current,
      state,
      leaseUntil: safeTimestamp(now, 'private delivery settlement time'),
      updatedAt: safeTimestamp(now, 'private delivery settlement time'),
    })
    return true
  }

  /**
   * Release a pending private lease after grant admission fails before delivery.
   * @param scope - Exact private message scope.
   * @param token - Lease token returned by reservation.
   */
  async releasePrivateDelivery(
    scope: Extract<BotAttachmentScope, { readonly kind: 'shared-private' }>,
    token: string,
  ): Promise<void> {
    const normalizedScope = normalizePrivateScope(scope)
    const id = privateDeliveryKey(normalizedScope)
    const current = this.privateDeliveries.get(id)
    if (current?.state === 'pending' && current.token === token) await this.privateDeliveries.delete(id)
  }

  private readGrantRecords(
    normalizedScope: BotAttachmentScope,
    ids: readonly BotAttachmentGrantId[],
  ): BotAttachmentGrantRecord[] {
    if (ids.length > MAX_GRANT_ATTACHMENTS || new Set(ids.map(String)).size !== ids.length) {
      throw new BotAttachmentGrantError('invalid', 'attachment grants must be unique and contain at most eight ids')
    }
    return ids.map((id) => {
      const record = this.grants.get(id)
      if (record === undefined) throw new BotAttachmentGrantError('not-found', 'attachment grant was not found')
      // A consumed grant is durable evidence for an already-admitted retry.
      // Its group revision may advance while finalization is in flight, but
      // the immutable message and recipient identity must still match.
      // Reserved grants remain fenced to their admission revision.
      if (!isDeepStrictEqual(record.scope, normalizedScope)
        && !(record.state === 'consumed' && sameMessageScope(record.scope, normalizedScope))) {
        throw new BotAttachmentGrantError('forbidden', 'attachment grant scope is no longer authorized')
      }
      if (record.state === 'revoked') throw new BotAttachmentGrantError('forbidden', 'attachment grant was revoked')
      return record
    })
  }
}

/**
 * Normalize scope ids and recipient order before persistence or comparison.
 * @param scope - Scope to validate and normalize.
 * @returns The validated scope with sorted group recipients.
 */
export function normalizeScope(scope: BotAttachmentScope): BotAttachmentScope {
  const parsed = scopeSchema.safeParse(scope)
  if (!parsed.success) throw new BotAttachmentGrantError('invalid', 'attachment grant scope is invalid')
  const value = parsed.data
  if (value.kind === 'local-group') return { ...value, targetBotIds: sortIds(value.targetBotIds) }
  if (value.kind === 'shared-group') return { ...value, targetBotIds: sortIds(value.targetBotIds) }
  return value
}

/**
 * Convert internal references to safe metadata without exposing storage ids.
 * @param attachment - Provider reference to project.
 * @returns Metadata safe for an admission response.
 */
export function attachmentMetadata(attachment: BotInputAttachment): BotAttachmentMetadata {
  if (attachment.type === 'image') {
    return {
      type: 'image', mediaType: attachment.attachment.mediaType, bytes: attachment.attachment.bytes,
      width: attachment.attachment.width, height: attachment.attachment.height,
      ...(attachment.attachment.name === undefined ? {} : { name: attachment.attachment.name }),
    }
  }
  return { type: 'file', name: attachment.attachment.name, bytes: attachment.attachment.bytes }
}

/**
 * Return safe metadata for an inspected message attachment.
 * @param attachment - Provider reference to project.
 * @returns Metadata plus the immutable provider reference id.
 */
export function attachmentView(attachment: BotInputAttachment): BotInputAttachmentView {
  return {
    ...attachmentMetadata(attachment),
    attachmentId: String(attachment.attachment.attachmentId),
  }
}

/**
 * Compare immutable provider references before accepting an idempotent retry.
 * @param left - First attachment list.
 * @param right - Second attachment list.
 * @returns Whether both lists contain the same immutable references.
 */
export function sameAttachmentRefs(
  left: readonly BotInputAttachment[],
  right: readonly BotInputAttachment[],
): boolean {
  return isDeepStrictEqual(left, right)
}

/**
 * Convert admitted references into the existing model-visible content blocks.
 * @param attachments - Provider references in message order.
 * @returns Existing image/file content blocks in the same order.
 */
export function attachmentContentBlocks(attachments: readonly BotInputAttachment[]): readonly ContentBlock[] {
  return attachments.map((attachment): ContentBlock => attachment.type === 'image'
    ? { type: 'image', attachment: attachment.attachment }
    : { type: 'file', attachment: attachment.attachment })
}

function parseAttachments(attachments: readonly BotInputAttachment[]): readonly BotInputAttachment[] {
  if (attachments.length < 1 || attachments.length > MAX_GRANT_ATTACHMENTS) {
    throw new BotAttachmentGrantError('invalid', 'a grant must contain one to eight attachments')
  }
  const parsed = z.array(inputAttachmentSchema).min(1).max(MAX_GRANT_ATTACHMENTS).safeParse(attachments)
  if (!parsed.success) throw new BotAttachmentGrantError('invalid', 'attachment references are invalid')
  return parsed.data
}

function sortIds(ids: readonly BotId[]): readonly BotId[] {
  return [...ids].sort((left, right) => String(left).localeCompare(String(right)))
}

function safeTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new BotAttachmentGrantError('invalid', `${label} is invalid`)
  return value
}

function privateDeliveryKey(scope: Extract<BotAttachmentScope, { readonly kind: 'shared-private' }>): string {
  return createHash('sha256')
    // Authorization revision fences reservation and grant admission, while
    // the immutable private message identity remains the idempotency key.
    .update(`${String(scope.principalId)}:${String(scope.botId)}:${String(scope.messageId)}`)
    .digest('hex')
}

function normalizePrivateScope(
  scope: Extract<BotAttachmentScope, { readonly kind: 'shared-private' }>,
): Extract<BotAttachmentScope, { readonly kind: 'shared-private' }> {
  const normalized = normalizeScope(scope)
  if (normalized.kind !== 'shared-private') {
    throw new BotAttachmentGrantError('invalid', 'private delivery scope is invalid')
  }
  return normalized
}

function sameMessageScope(left: BotAttachmentScope, right: BotAttachmentScope): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'local-group' && right.kind === 'local-group') {
    return String(left.ownerId) === String(right.ownerId)
      && left.groupId === right.groupId
      && left.messageId === right.messageId
      && isDeepStrictEqual(left.targetBotIds, right.targetBotIds)
  }
  if (left.kind === 'shared-group' && right.kind === 'shared-group') {
    return left.principalId === right.principalId
      && left.groupId === right.groupId
      && left.messageId === right.messageId
      && isDeepStrictEqual(left.targetBotIds, right.targetBotIds)
  }
  if (left.kind !== 'shared-private' || right.kind !== 'shared-private') return false
  return left.principalId === right.principalId
    && left.botId === right.botId
    && left.messageId === right.messageId
}

/** Open-domain type exported for consumers that retain the provider. */
export type BotAttachmentDomain = Domain<typeof botAttachmentDomain>
