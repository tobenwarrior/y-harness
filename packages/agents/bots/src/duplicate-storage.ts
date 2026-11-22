/** Durable owner-local snapshots for retryable Bot duplication operations. */

import { defineDomain, domainTable } from '@yharness/storage-domain'
import { z } from 'zod'
import { BOT_ACCENTS, BOT_EVENT_SOURCES, BOT_IDENTITIES, BotId } from './types.ts'
import { botSkillPolicySchema, imageAttachmentRefSchema } from './storage.ts'

const operationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
const ownerIdSchema = z.string().min(1).max(128).refine(value => value.trim() === value)
const botIdSchema = z.string().regex(/^bot-[A-Za-z0-9][A-Za-z0-9-]*$/).transform(BotId)
const boundedText = (max: number) => z.string().min(1).max(max).refine(value => value.trim() === value)
const optionalText = (max: number) => z.string().max(max).refine(value => value.trim() === value).optional()

const modelSelectionSchema = z.object({
  provider: boundedText(160),
  model: boundedText(256),
  reasoningEffort: optionalText(128),
  serviceTier: optionalText(128),
}).strict()

/** Session-local model choice retained by a duplicate operation snapshot. */
export interface BotDuplicateModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string | undefined
  readonly serviceTier?: string | undefined
}

const dailySchema = z.object({
  time: boundedText(32),
  time_zone: boundedText(128),
}).strict()

const weeklySchema = z.object({
  time: boundedText(32),
  time_zone: boundedText(128),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
}).strict()

const cronSchema = z.object({
  expression: boundedText(160),
  time_zone: boundedText(128),
}).strict()

/** Canonical timed routine request retained before any target-side writes. */
export const botDuplicateScheduleRequestSchema = z.object({
  prompt: boundedText(16_000),
  title: boundedText(120),
  after_seconds: z.number().int().positive().optional(),
  at: boundedText(64).optional(),
  every_seconds: z.number().int().positive().optional(),
  daily: dailySchema.optional(),
  weekly: weeklySchema.optional(),
  cron: cronSchema.optional(),
}).strict().superRefine((request, context) => {
  const selectorCount = [request.after_seconds, request.at, request.every_seconds, request.daily, request.weekly, request.cron]
    .filter(value => value !== undefined).length
  if (selectorCount !== 1) context.addIssue({ code: 'custom', message: 'A duplicate timed routine must retain exactly one selector' })
})
/** Validated timed routine definition retained by a duplicate operation. */
export type BotDuplicateScheduleRequest = z.infer<typeof botDuplicateScheduleRequestSchema>

const eventTriggerSchema = z.object({
  type: z.literal('message'),
  source: z.enum(BOT_EVENT_SOURCES),
}).strict()

const profileSchema = z.object({
  description: optionalText(240),
  identity: z.enum(BOT_IDENTITIES),
  accent: z.enum(BOT_ACCENTS),
  avatar: imageAttachmentRefSchema.optional(),
  agentPreset: optionalText(160),
  persona: optionalText(4_000),
  capabilities: z.array(z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/)).max(32).optional(),
  skillPolicy: botSkillPolicySchema.optional(),
  modelSelection: modelSelectionSchema.optional(),
}).strict()

const scheduleRoutineSchema = z.object({
  kind: z.literal('schedule'),
  sourceId: z.string().min(1).max(256),
  request: botDuplicateScheduleRequestSchema,
}).strict()

const eventRoutineSchema = z.object({
  kind: z.literal('event'),
  sourceId: z.string().min(1).max(256),
  title: boundedText(120),
  prompt: boundedText(16_000),
  event: eventTriggerSchema,
}).strict()

const routineSchema = z.discriminatedUnion('kind', [scheduleRoutineSchema, eventRoutineSchema])
const skippedRoutineSchema = z.object({
  id: z.string().min(1).max(256),
  reason: z.enum(['inactive', 'expired', 'schedule-unavailable']),
}).strict()

/** Durable source snapshot and progress marker for one duplication operation. */
export const botDuplicateOperationSchema = z.object({
  ownerId: ownerIdSchema,
  sourceBotId: botIdSchema,
  operationId: operationIdSchema,
  targetBotId: botIdSchema,
  requestedName: z.string().max(80).refine(value => value.trim() === value).nullable(),
  targetName: boundedText(80),
  profile: profileSchema,
  routines: z.array(routineSchema).max(512),
  skippedRoutines: z.array(skippedRoutineSchema).max(512),
  createdAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().optional(),
}).strict().refine(record => record.completedAt === undefined || record.completedAt >= record.createdAt, {
  message: 'Duplicate operation completion cannot predate its snapshot',
})

/** Validated durable snapshot and progress state for a duplicate operation. */
export type BotDuplicateStoredRecord = z.infer<typeof botDuplicateOperationSchema>

/** Host-local durable state for duplicate operation snapshots and receipts. */
export const botDuplicateDomain = defineDomain({
  name: 'agent_bot_duplicates',
  version: 1,
  layout: 'per-record',
  tables: {
    operations: domainTable<string, BotDuplicateStoredRecord>(botDuplicateOperationSchema),
  },
})
