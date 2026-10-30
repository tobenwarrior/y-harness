/** Durable Bot roster declaration and record validation. */

import { SessionId } from '@yharness/session'
import { brandString } from '@yharness/brand'
import type { AttachmentId, ImageAttachmentRef } from '@yharness/attachment'
import { defineDomain, domainTable } from '@yharness/storage-domain'
import { z } from 'zod'
import { BOT_ACCENTS, BOT_IDENTITIES, BotId } from './types.ts'
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

/** Authoritative version-one Bot domain. */
export const botDomain = defineDomain({
  name: 'agent_bots',
  version: 1,
  layout: 'per-record',
  tables: {
    bots: domainTable<BotRecord['id'], BotRecord>(botRecordSchema),
  },
})

/** Parsed durable Bot row returned by the storage-domain schema. */
export type BotStoredRecord = z.infer<typeof botRecordSchema>
