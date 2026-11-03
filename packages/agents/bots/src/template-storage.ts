/** Durable storage declaration for reusable signed Bot template snapshots. */

import { defineDomain, domainTable } from '@yharness/storage-domain'
import { z } from 'zod'
import { brandString } from '@yharness/brand'
import { BOT_ACCENTS, BOT_IDENTITIES } from './types.ts'
import { BotTemplateId, BotTemplateShareCode } from './template-types.ts'
import type {
  BotTemplateAvatar,
  BotTemplateCapability,
  BotTemplateProfile,
  BotTemplateView,
} from './template-types.ts'
import {
  BOT_TEMPLATE_CODE_MAX_LENGTH,
  botTemplateAvatarSchema,
  botTemplateProfileSchema,
} from './template-codec.ts'

const templateIdSchema = z.string()
  .regex(/^bot-template-[A-Za-z0-9][A-Za-z0-9-]*$/)
  .transform(BotTemplateId)

const shareCodeSchema = z.string()
  .min(1)
  .max(BOT_TEMPLATE_CODE_MAX_LENGTH)
  .refine(value => value.trim() === value, {
    message: 'Template share codes must not have surrounding whitespace',
  })
  .transform(BotTemplateShareCode)

const ownerIdSchema = z.string().min(1).max(128).refine(value => value.trim() === value, {
  message: 'Template owner ids must not have surrounding whitespace',
})

const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/)
const importDigestSchema = z.string().regex(/^[0-9a-f]{64}$/)
/** Maximum durable import retry bindings retained by one Host. */
export const BOT_TEMPLATE_IMPORT_BINDING_LIMIT = 4096
/** Maximum explicit portable-artifact approvals retained by one Host. */
export const BOT_TEMPLATE_APPROVAL_LIMIT = 4096
const boundedText = (max: number) => z.string().min(1).max(max).refine(value => value.trim() === value, {
  message: 'Template text must not have surrounding whitespace',
})
const personaSchema = z.string().min(1).max(4000).refine(value => value.trim() === value, {
  message: 'Template personas must not have surrounding whitespace',
})
const capabilitySchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/)

/** Durable template row with its Host-local publication owner. */
export interface BotTemplateStoredRecord extends BotTemplateView {
  /** Deployment-local owner scope; never included in a portable code. */
  readonly ownerId: string
}

/** Host-local state required to sign portable template codes. */
export interface BotTemplateGlobalState {
  /** PKCS#8 Ed25519 private key encoded as base64url. */
  readonly signingKey?: string
  /** Local idempotency bindings keyed by a one-way import-operation digest. */
  readonly imports?: Readonly<Record<string, { readonly fingerprint: string; readonly botId: string; readonly name?: string }>>
  /** Exact signed-artifact fingerprints explicitly approved by the Host owner. */
  readonly approvals?: Readonly<Record<string, number>>
}

/** Stored reusable Bot template record. */
export const botTemplateRecordSchema = z.object({
  id: templateIdSchema,
  shareCode: shareCodeSchema,
  ownerId: ownerIdSchema.optional(),
  name: boundedText(80),
  description: z.string().min(1).max(240).refine(value => value.trim() === value, {
    message: 'Template descriptions must not have surrounding whitespace',
  }).optional(),
  identity: z.enum(BOT_IDENTITIES),
  accent: z.enum(BOT_ACCENTS),
  persona: personaSchema.optional(),
  capabilities: z.array(capabilitySchema).max(32).refine(values => new Set(values).size === values.length).optional(),
  profile: botTemplateProfileSchema.optional(),
  avatar: botTemplateAvatarSchema.optional(),
  agentPreset: boundedText(160).optional(),
  fingerprint: fingerprintSchema.optional(),
  portableVersion: z.number().safe().int().positive().optional(),
  createdAt: z.number().safe().int().nonnegative(),
  revokedAt: z.number().safe().int().nonnegative().optional(),
}).strict().refine(record => record.revokedAt === undefined || record.revokedAt >= record.createdAt, {
  message: 'Template revocation must not predate publication',
}).transform((value): BotTemplateStoredRecord => ({
  id: value.id,
  shareCode: value.shareCode,
  ownerId: value.ownerId ?? 'local-owner',
  name: value.name,
  ...(value.description === undefined ? {} : { description: value.description }),
  identity: value.identity,
  accent: value.accent,
  ...(value.persona === undefined ? {} : { persona: value.persona }),
  ...(value.capabilities === undefined ? {} : { capabilities: value.capabilities as readonly BotTemplateCapability[] }),
  ...(value.profile === undefined ? {} : { profile: value.profile as BotTemplateProfile }),
  ...(value.avatar === undefined ? {} : { avatar: value.avatar as BotTemplateAvatar }),
  ...(value.agentPreset === undefined ? {} : { agentPreset: value.agentPreset }),
  ...(value.fingerprint === undefined ? {} : { fingerprint: value.fingerprint }),
  ...(value.portableVersion === undefined ? {} : { portableVersion: value.portableVersion }),
  createdAt: value.createdAt,
  ...(value.revokedAt === undefined ? {} : { revokedAt: value.revokedAt }),
}))

/** Durable Bot template domain kept separate from Bot roster and Sessions. */
export const botTemplateDomain = defineDomain({
  name: 'agent_bot_templates',
  version: 1,
  layout: 'per-record',
  global: {
    schema: z.object({
      signingKey: z.string().max(1024).optional(),
      imports: z.record(importDigestSchema, z.object({
        fingerprint: fingerprintSchema,
        botId: z.string().regex(/^bot-[A-Za-z0-9][A-Za-z0-9-]*$/),
        name: boundedText(80).optional(),
      }).strict()).refine(value => Object.keys(value).length <= BOT_TEMPLATE_IMPORT_BINDING_LIMIT, {
        message: 'Template import retry bindings exceed the Host limit',
      }).optional(),
      approvals: z.record(fingerprintSchema, z.number().safe().int().nonnegative()).refine(
        value => Object.keys(value).length <= BOT_TEMPLATE_APPROVAL_LIMIT,
        {
          message: 'Template approvals exceed the Host limit',
        },
      ).optional(),
    }).strict(),
    initial: {} as BotTemplateGlobalState,
  },
  tables: {
    templates: domainTable<BotTemplateId, BotTemplateStoredRecord>(botTemplateRecordSchema),
  },
})

/**
 * Validate and brand one durable template id.
 * @param value - Candidate durable template id.
 * @returns Validated branded template id.
 */
export function normalizeBotTemplateId(value: BotTemplateId): BotTemplateId {
  if (typeof value !== 'string' || !/^bot-template-[A-Za-z0-9][A-Za-z0-9-]*$/.test(value)) {
    throw new Error('Bot template id must begin with bot-template- and contain URL-safe segments')
  }
  return brandString<BotTemplateId>(value)
}

/**
 * Validate and brand one opaque template share code.
 * @param value - Candidate opaque template share code.
 * @returns Validated branded template share code.
 */
export function normalizeBotTemplateShareCode(value: BotTemplateShareCode): BotTemplateShareCode {
  if (typeof value !== 'string' || value.length === 0 || value.length > BOT_TEMPLATE_CODE_MAX_LENGTH || value.trim() !== value) {
    throw new Error('Bot template share codes must be bounded and must not have surrounding whitespace')
  }
  return brandString<BotTemplateShareCode>(value)
}
