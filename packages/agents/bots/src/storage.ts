/** Durable Bot roster declaration and record validation. */

import { SessionId } from '@yharness/session'
import { brandString } from '@yharness/brand'
import type { AttachmentId, ImageAttachmentRef } from '@yharness/attachment'
import { defineDomain, domainTable } from '@yharness/storage-domain'
import { z } from 'zod'
import { BOT_ACCENTS, BOT_IDENTITIES, BotId } from './types.ts'
import type { BotRecord } from './types.ts'
import { BOT_MEMORY_TEXT_LIMIT } from './memory.ts'
import { BOT_SKILL_NAME_LIMIT, BOT_SKILL_NAME_MAX_LENGTH } from './skills.ts'

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

const ownerIdSchema = z.string().min(1).max(128).refine(value => value.trim() === value, {
  message: 'Bot owner ids must not have surrounding whitespace',
})

const boundedText = (max: number) => z.string().min(1).max(max).refine(value => value.trim() === value, {
  message: 'Text values must be trimmed',
})

const capability = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/)
const botSkillName = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(BOT_SKILL_NAME_MAX_LENGTH)
const botSkillPolicySchema = z.object({
  mode: z.enum(['all', 'selected']),
  enabled: z.array(botSkillName).max(BOT_SKILL_NAME_LIMIT),
  disabled: z.array(botSkillName).max(BOT_SKILL_NAME_LIMIT),
}).strict().refine(value => new Set(value.enabled).size === value.enabled.length, {
  message: 'Bot skill enabled names must be unique',
}).refine(value => new Set(value.disabled).size === value.disabled.length, {
  message: 'Bot skill disabled names must be unique',
})
const pendingMemoryUpdateSchema = z.object({
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
  persona: z.string().max(4000).refine(value => value.trim() === value, {
    message: 'Personas must be trimmed',
  }).optional(),
  capabilities: z.array(capability).max(32).refine(values => new Set(values).size === values.length).optional(),
  connectedAppIds: z.array(z.string()).max(128).refine(
    values => new Set(values).size === values.length,
    { message: 'Connected-app ids must be unique' },
  ).optional(),
  connectedAppDenyIds: z.array(z.string()).max(128).refine(
    values => new Set(values).size === values.length,
    { message: 'Connected-app deny ids must be unique' },
  ).optional(),
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
  skillPolicy: botSkillPolicySchema.optional(),
  skillPolicyRevision: z.number().safe().int().nonnegative().optional(),
  state: z.enum(['provisioning', 'active']),
  createdAt: z.number().safe().int().nonnegative(),
  updatedAt: z.number().safe().int().nonnegative(),
  pendingMemoryUpdate: pendingMemoryUpdateSchema.optional(),
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
  version: 7,
  compatibleVersions: [1, 2, 3, 4, 5, 6],
  layout: 'per-record',
  global: {
    schema: botAppearanceMigrationSchema,
    initial: {} as z.infer<typeof botAppearanceMigrationSchema>,
  },
  tables: {
    bots: domainTable<BotRecord['id'], BotStoredRecord>(botRecordSchema),
  },
})
