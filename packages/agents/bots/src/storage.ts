/** Durable Bot roster declaration and record validation. */

import { SessionId } from '@yharness/session'
import { brandString } from '@yharness/brand'
import type { AttachmentId, ImageAttachmentRef } from '@yharness/attachment'
import { MessageId } from '@yharness/llm/brand'
import { defineDomain, domainTable } from '@yharness/storage-domain'
import { z } from 'zod'
import { BOT_ACCENTS, BOT_EVENT_SOURCES, BOT_IDENTITIES, BotId, BotShareMemoryId } from './types.ts'
import type { BotRecord } from './types.ts'
import { BOT_MEMORY_TEXT_LIMIT } from './memory.ts'
import { BOT_SHARE_ROLES, BotPrincipalId } from './sharing.ts'

/** Durable marker for a memory edit that was interrupted before its log write completed. */
export type BotStoredRecord = BotRecord & {
  /** Memory identity being recovered on the next Bot service startup. */
  readonly pendingMemoryUpdate?: {
    readonly memoryId: string
    readonly text: string
  } | undefined
}

/** Durable image reference admitted by the attachment store. */
export const imageAttachmentRefSchema = z.object({
  attachmentId: z.string().min(1).max(512).refine(
    value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value),
    'attachment provider id is invalid',
  ).transform(value => brandString<AttachmentId>(value)),
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

const botIdSchema = z.string()
  .regex(/^bot-[A-Za-z0-9][A-Za-z0-9-]*$/, 'Bot ids must begin with bot- and contain simple URL-safe segments')
  .transform(BotId)

const sessionIdSchema = z.string()
  .regex(/^bot-session-[A-Za-z0-9][A-Za-z0-9-]*$/, 'Bot Session ids must begin with bot-session-')
  .refine(value => value.trim() === value, {
    message: 'Session ids must not have surrounding whitespace',
  })
  .transform(SessionId)

const ownerIdSchema = z.string().min(1).max(128).refine(value => value.trim() === value, {
  message: 'Bot owner ids must not have surrounding whitespace',
})

const boundedText = (max: number) => z.string().min(1).max(max).refine(value => value.trim() === value, {
  message: 'Text values must be trimmed',
})

const instant = z.iso.datetime({ precision: 3 })

/** Durable message-trigger routine value validated inside each Bot row. */
export const botEventRoutineSchema = z.object({
  id: z.string().regex(/^bot-event-routine-[A-Za-z0-9][A-Za-z0-9-]*$/),
  title: boundedText(120),
  prompt: boundedText(16_000),
  trigger: z.object({
    type: z.literal('message'),
    source: z.enum(BOT_EVENT_SOURCES),
  }).strict(),
  status: z.enum(['active', 'paused']),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  deliveries: z.array(z.object({
    triggerEventSeq: z.number().int().nonnegative(),
    triggerMessageId: z.string().min(1).transform(MessageId).optional(),
    messageId: z.string().min(1).transform(MessageId),
    chainId: z.string().min(1).optional(),
    depth: z.number().int().nonnegative().optional(),
    status: z.enum(['pending', 'delivered']),
    dispatchStartedAt: instant.optional(),
    createdAt: instant,
    deliveredAt: instant.optional(),
  }).strict()).max(200),
  admissionWatermark: z.number().int().nonnegative().optional(),
  admissionTombstones: z.array(z.object({
    triggerEventSeq: z.number().int().nonnegative(),
    triggerMessageId: z.string().min(1).transform(MessageId).optional(),
  }).strict()).max(200).optional(),
  results: z.array(z.object({
    messageId: z.string().min(1).transform(MessageId),
    status: z.enum(['completed', 'error', 'aborted', 'blocked', 'max-tokens', 'interrupted', 'forked', 'other']),
    completedAt: instant,
    output: z.string().max(8_000).optional(),
    error: z.string().max(4_000).optional(),
  }).strict()).max(200),
}).strict().refine(record => record.updatedAt >= record.createdAt, {
  message: 'event routine updatedAt must not be earlier than createdAt',
})
const capability = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/)
/** Durable memory edit marker copied through the cross-process profile fence. */
export const botPendingMemoryUpdateSchema = z.object({
  memoryId: z.string().regex(/^memory-[A-Za-z0-9][A-Za-z0-9-]*$/).max(256),
  text: boundedText(BOT_MEMORY_TEXT_LIMIT),
}).strict()

/** Stored Bot row; malformed authoritative records reject domain opening. */
export const botRecordSchema = z.object({
  id: botIdSchema,
  sessionId: sessionIdSchema,
  ownerId: ownerIdSchema.optional(),
  name: boundedText(80),
  description: z.string().max(240).refine(value => value.trim() === value, {
    message: 'Descriptions must be trimmed',
  }).optional(),
  identity: z.enum(BOT_IDENTITIES),
  accent: z.enum(BOT_ACCENTS),
  avatar: imageAttachmentRefSchema.optional(),
  eventRoutines: z.array(botEventRoutineSchema).max(100).optional(),
  persona: z.string().max(4000).refine(value => value.trim() === value, {
    message: 'Personas must be trimmed',
  }).optional(),
  capabilities: z.array(capability).max(32).refine(values => new Set(values).size === values.length).optional(),
  connectedAppIds: z.array(z.string()).max(128).refine(
    values => new Set(values).size === values.length,
    { message: 'Connected-app ids must be unique' },
  ).readonly().optional(),
  connectedAppDenyIds: z.array(z.string()).max(128).refine(
    values => new Set(values).size === values.length,
    { message: 'Connected-app deny ids must be unique' },
  ).readonly().optional(),
  pinned: z.boolean().optional(),
  hidden: z.boolean().optional(),
  group: z.string().max(80).refine(value => value.trim() === value, {
    message: 'Bot sections must be trimmed',
  }).optional(),
  cwd: z.string().min(1).refine(value => value.trim() === value, {
    message: 'Working directories must not have surrounding whitespace',
  }),
  agentPreset: z.string().min(1).refine(value => value.trim() === value, {
    message: 'Agent presets must not have surrounding whitespace',
  }).optional(),
  state: z.enum(['provisioning', 'active']),
  createdAt: z.number().safe().int().nonnegative(),
  updatedAt: z.number().safe().int().nonnegative(),
  pendingMemoryUpdate: botPendingMemoryUpdateSchema.optional(),
}).strict().refine(record => record.updatedAt >= record.createdAt, {
  message: 'updatedAt must not be earlier than createdAt',
}).refine(record => String(record.id) !== String(record.sessionId), {
  message: 'Bot and Session identities must remain distinct',
}).transform((value): BotStoredRecord => ({
  ...value,
  ownerId: value.ownerId ?? 'local-owner',
}))

/** Durable marker for the one-time switch from image avatars to animated characters. */
export const botAppearanceMigrationSchema = z.object({
  animatedAvatarVersion: z.literal(1).optional(),
}).strict()

/** Current one-time appearance migration applied to existing Bot rows. */
export const BOT_APPEARANCE_MIGRATION_VERSION = 1

/** Authoritative Bot domain; earlier records remain readable as organization fields are optional. */
export const botDomain = defineDomain({
  name: 'agent_bots',
  version: 5,
  compatibleVersions: [1, 2, 3, 4],
  layout: 'per-record',
  global: {
    schema: botAppearanceMigrationSchema,
    initial: {} as z.infer<typeof botAppearanceMigrationSchema>,
  },
  tables: {
    bots: domainTable<BotRecord['id'], BotStoredRecord>(botRecordSchema),
  },
})

const sharedBotIdSchema = botIdSchema
const sharedPrincipalIdSchema = z.string()
  .regex(/^principal-[A-Za-z0-9-]+$/, 'Shared principal ids must begin with principal-')
  .transform(BotPrincipalId)
const sharedSessionIdSchema = z.string()
  .regex(/^shared-session-[A-Za-z0-9-]+$/, 'Shared Session ids must begin with shared-session-')
  .refine(value => !value.startsWith('shared-session-group-'), 'Private shared Session ids cannot use the group namespace')
  .transform(SessionId)
const sharedTimestamp = z.number().int().nonnegative()

/** Maximum number of Bot-specific shared-context policies in one authority record. */
export const SHARED_MEMORY_MAX_POLICIES = 256

/** Maximum number of shared-context entries across all Bots in one authority record. */
export const SHARED_MEMORY_MAX_ENTRIES = 4_096

/** Maximum number of shared-context entries that one Bot may retain. */
export const SHARED_MEMORY_MAX_ENTRIES_PER_BOT = 512

const sharedMemoryIdSchema = z.string()
  .regex(/^memory-[A-Za-z0-9-]+$/, 'Shared memory ids must begin with memory-')
  .transform(BotShareMemoryId)

/** One bounded note intentionally published to a shared Bot context. */
export const sharedMemoryEntrySchema = z.object({
  id: sharedMemoryIdSchema,
  botId: sharedBotIdSchema,
  principalId: sharedPrincipalIdSchema,
  text: z.string().min(1).max(2_000).refine(value => value.trim() === value, {
    message: 'Shared memory text must not have surrounding whitespace',
  }),
  createdAt: sharedTimestamp,
}).strict()

/** Shared-context policy and bounded entries stored with membership authority. */
export const sharedMemorySnapshotSchema = z.object({
  policies: z.array(z.object({
    botId: sharedBotIdSchema,
    enabled: z.boolean(),
    updatedAt: sharedTimestamp,
  }).strict()).max(SHARED_MEMORY_MAX_POLICIES),
  entries: z.array(sharedMemoryEntrySchema).max(SHARED_MEMORY_MAX_ENTRIES),
}).strict().superRefine((value, context) => {
  const policyBotIds = new Set<string>()
  for (const [index, policy] of value.policies.entries()) {
    const botId = String(policy.botId)
    if (policyBotIds.has(botId)) {
      context.addIssue({
        code: 'custom',
        message: 'Shared-context policies must be unique per Bot',
        path: ['policies', index, 'botId'],
      })
    }
    policyBotIds.add(botId)
  }
  const entriesByBot = new Map<string, number>()
  for (const entry of value.entries) {
    const botId = String(entry.botId)
    const count = (entriesByBot.get(botId) ?? 0) + 1
    entriesByBot.set(botId, count)
    if (count > SHARED_MEMORY_MAX_ENTRIES_PER_BOT) {
      context.addIssue({
        code: 'custom',
        message: 'Shared-context entries exceeded the per-Bot limit',
        path: ['entries'],
      })
    }
  }
})

/** Durable membership row for one Bot and authenticated shared principal. */
export const sharedMembershipSchema = z.object({
  botId: sharedBotIdSchema,
  principalId: sharedPrincipalIdSchema,
  role: z.enum(BOT_SHARE_ROLES),
  grantedBy: sharedPrincipalIdSchema,
  createdAt: sharedTimestamp,
  updatedAt: sharedTimestamp,
}).strict().refine(value => value.updatedAt >= value.createdAt, {
  message: 'Membership updatedAt must not be earlier than createdAt',
})

/** Durable pending invitation associated with one Bot share. */
export const sharedInviteSchema = z.object({
  digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  botId: sharedBotIdSchema,
  role: z.enum(BOT_SHARE_ROLES),
  createdAt: sharedTimestamp,
  expiresAt: sharedTimestamp,
}).strict().refine(value => value.expiresAt > value.createdAt, {
  message: 'Shared invite expiresAt must be after createdAt',
})

/** Durable private Session binding for one Bot and authenticated principal. */
export const sharedPrivateSessionSchema = z.object({
  botId: sharedBotIdSchema,
  principalId: sharedPrincipalIdSchema,
  sessionId: sharedSessionIdSchema,
  createdAt: sharedTimestamp,
  updatedAt: sharedTimestamp,
  revokedAt: sharedTimestamp.optional(),
}).strict().refine(value => value.updatedAt >= value.createdAt, {
  message: 'Private Session updatedAt must not be earlier than createdAt',
})

/** Authoritative shared-Bot membership and private-session domain. */
export const sharedBotDomain = defineDomain({
  name: 'agent_bot_shares',
  version: 1,
  layout: 'per-record',
  tables: {
    memberships: domainTable<string, z.infer<typeof sharedMembershipSchema>>(sharedMembershipSchema),
    invites: domainTable<string, z.infer<typeof sharedInviteSchema>>(sharedInviteSchema),
    private_sessions: domainTable<string, z.infer<typeof sharedPrivateSessionSchema>>(sharedPrivateSessionSchema),
  },
})

/** Parsed durable shared membership row. */
export type SharedMembershipRecord = z.infer<typeof sharedMembershipSchema>

/** Durable credential payload used to refresh Bot membership across processes. */
export const sharedMembershipSnapshotSchema = z.object({
  version: z.literal(1),
  memberships: z.array(sharedMembershipSchema),
  sharedMemory: sharedMemorySnapshotSchema.optional(),
  /** Shared group state is parsed by the group service before use. */
  sharedGroups: z.unknown().optional(),
}).strict()

/** Parsed shared membership snapshot. */
export type SharedMembershipSnapshot = z.infer<typeof sharedMembershipSnapshotSchema>

/** Parsed durable shared invitation row. */
export type SharedInviteRecord = z.infer<typeof sharedInviteSchema>

/** Parsed durable shared private-session row. */
export type SharedPrivateSessionRecord = z.infer<typeof sharedPrivateSessionSchema>

/** Parsed shared-context policy and entries. */
export type SharedMemorySnapshot = z.infer<typeof sharedMemorySnapshotSchema>

/** Parsed shared-context entry. */
export type SharedMemoryEntry = z.infer<typeof sharedMemoryEntrySchema>
