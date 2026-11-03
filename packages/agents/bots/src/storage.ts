/** Durable Bot roster declaration and record validation. */

import { SessionId } from '@yharness/session'
import { brandString } from '@yharness/brand'
import type { AttachmentId, ImageAttachmentRef } from '@yharness/attachment'
import { MessageId } from '@yharness/llm/brand'
import { defineDomain, domainTable } from '@yharness/storage-domain'
import { z } from 'zod'
import { BOT_ACCENTS, BOT_EVENT_SOURCES, BOT_IDENTITIES, BotId } from './types.ts'
import type { BotRecord } from './types.ts'

/** Durable image reference admitted by the attachment store. */
export const imageAttachmentRefSchema = z.object({
  attachmentId: z.string().regex(/^sha256:[0-9a-f]{64}$/).transform(value => brandString<AttachmentId>(value)),
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

/** Stored Bot row; malformed authoritative records reject domain opening. */
export const botRecordSchema = z.object({
  id: botIdSchema,
  sessionId: sessionIdSchema,
  name: boundedText(80),
  description: z.string().max(240).refine(value => value.trim() === value, {
    message: 'Descriptions must be trimmed',
  }).optional(),
  identity: z.enum(BOT_IDENTITIES),
  accent: z.enum(BOT_ACCENTS),
  avatar: imageAttachmentRefSchema.optional(),
  eventRoutines: z.array(botEventRoutineSchema).max(100).optional(),
  cwd: z.string().min(1).refine(value => value.trim() === value, {
    message: 'Working directories must not have surrounding whitespace',
  }),
  agentPreset: z.string().min(1).refine(value => value.trim() === value, {
    message: 'Agent presets must not have surrounding whitespace',
  }).optional(),
  state: z.enum(['provisioning', 'active']),
  createdAt: z.number().safe().int().nonnegative(),
  updatedAt: z.number().safe().int().nonnegative(),
}).strict().refine(record => record.updatedAt >= record.createdAt, {
  message: 'updatedAt must not be earlier than createdAt',
}).refine(record => String(record.id) !== String(record.sessionId), {
  message: 'Bot and Session identities must remain distinct',
})

/** Durable marker for the one-time switch from image avatars to animated characters. */
export const botAppearanceMigrationSchema = z.object({
  animatedAvatarVersion: z.literal(1).optional(),
}).strict()

/** Current one-time appearance migration applied to existing Bot rows. */
export const BOT_APPEARANCE_MIGRATION_VERSION = 1

/** Authoritative Bot domain; v1 records remain readable for the appearance migration. */
export const botDomain = defineDomain({
  name: 'agent_bots',
  version: 2,
  compatibleVersions: [1],
  layout: 'per-record',
  global: {
    schema: botAppearanceMigrationSchema,
    initial: {} as z.infer<typeof botAppearanceMigrationSchema>,
  },
  tables: {
    bots: domainTable<BotRecord['id'], BotRecord>(botRecordSchema),
  },
})

/** Parsed durable Bot row returned by the storage-domain schema. */
export type BotStoredRecord = z.infer<typeof botRecordSchema>
