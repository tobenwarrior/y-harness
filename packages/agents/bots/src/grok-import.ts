/** Validate a Grok Bot profile or supplemental memory export for owner-side import. */

import { RemoteError } from '@yharness/typert-protocol'
import { createCronScheduleRecord, ScheduleId, ScheduleInputError, type CronInput } from '@yharness/schedule'
import { z } from 'zod'
import { BOT_MEMORY_ENTRY_LIMIT, BOT_MEMORY_TEXT_LIMIT, fitsBotMemoryCapacity } from './memory.ts'
import type { BotGrokImportValue } from './types.ts'

const MAX_DOCUMENT_BYTES = 512 * 1024
const CREDENTIAL_KEY = /^(?:authorization|cookie|(?:.*[_-])?(?:password|secret|token|api[_-]?key|private[_-]?key))$/iu
const CREDENTIAL_TEXT = [
  /\b(?:sk-[\w-]{16,}|xox[abprs]-[\w-]{10,}|gh[pousr]_\w{20,}|github_pat_\w{20,})/iu,
  /\b(?:eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|bearer\s+[\w.~+/-]{20,})/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu,
]
const text = (maximum: number) => z.string().trim().min(1).max(maximum)
const memoryText = z.string().trim().min(1).refine(value => Array.from(value).length <= BOT_MEMORY_TEXT_LIMIT)
const memories = z.array(memoryText).max(BOT_MEMORY_ENTRY_LIMIT).default([])
const skill = z.object({
  name: text(160),
  description: z.string().trim().max(1024).default(''),
  instructions: text(64 * 1024),
})
const routine = z.object({
  name: text(120),
  instruction: text(64 * 1024),
  trigger: text(64),
  schedule_cron: text(128),
  timezone: text(128),
  skills: z.array(text(160)).max(24).default([]),
})
const profileExportSchema = z.object({
  format: z.literal('grok-bot-export'),
  version: z.literal(1),
  bots: z.array(z.object({
    name: text(160),
    memories,
    user_facts: memories,
    skills: z.array(skill).max(32).default([]),
    routines: z.array(routine).max(64).default([]),
  })).min(1).max(32),
})
const recoveredMemory = z.object({
  text: memoryText,
  source: z.enum(['own_profile', 'shared_profile', 'shared_journal']),
  truncated: z.boolean(),
})

const memoryRecoverySchema = z.object({
  format: z.literal('grok-bot-memory-completion'),
  version: z.literal(1),
  bot_name: text(160),
  reported_total: z.number().int().nonnegative(),
  retrieved_total: z.number().int().nonnegative(),
  memories: z.array(recoveredMemory).max(BOT_MEMORY_ENTRY_LIMIT),
  user_facts: z.array(recoveredMemory).max(BOT_MEMORY_ENTRY_LIMIT),
})

const documentSchema = z.discriminatedUnion('format', [profileExportSchema, memoryRecoverySchema])
const timedTriggers = new Set(['schedule', 'scheduled', 'cron', 'time', 'interval'])

interface GrokImportPlan {
  readonly name: string
  readonly memories: readonly string[]
  readonly memoryGaps?: BotGrokImportValue['memoryGaps']
  readonly skills: readonly z.infer<typeof skill>[]
  readonly routines: readonly {
    readonly title: string
    readonly prompt: string
    readonly cron: CronInput
    readonly skills: readonly string[]
  }[]
}

function invalid(message: string): never {
  throw new RemoteError('gateway/bad-request', message, {})
}

function checkCredentials(data: unknown): void {
  const pending = [data]
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value === 'string' && CREDENTIAL_TEXT.some(pattern => pattern.test(value))) {
      invalid('The Grok Bot export contains credential text. Remove credentials and try again.')
    }
    if (value === null || typeof value !== 'object') continue
    for (const [key, child] of Object.entries(value)) {
      if (CREDENTIAL_KEY.test(key)) invalid('The Grok Bot export contains a credential field. Remove credentials and try again.')
      pending.push(child)
    }
  }
}

function distinctMemories(texts: readonly string[]): readonly string[] {
  const unique = [...new Set(texts)]
  if (!fitsBotMemoryCapacity(unique)) return invalid('This export exceeds the Bot memory limit.')
  return unique
}

/** Parse one Bot and validate its rules before any durable writes.
 * @param document - Grok Bot profile or supplemental memory export JSON.
 * @param sourceName - Source Bot display name when the file contains multiple Bots.
 * @returns Complete memory text, supplemental memory gaps, skill definitions, and timed routines.
 */
export function parseGrokImport(document: string, sourceName?: string): GrokImportPlan {
  if (typeof document !== 'string' || Buffer.byteLength(document) > MAX_DOCUMENT_BYTES) {
    return invalid('Choose a Grok Bot export of at most 512 KiB.')
  }
  let json: unknown
  try {
    json = JSON.parse(document)
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error
    return invalid('The Grok Bot export must be valid JSON.')
  }
  checkCredentials(json)
  const parsed = documentSchema.safeParse(json)
  if (!parsed.success) return invalid('Expected a valid version-one Grok Bot profile or supplemental memory export.')
  const exportData = parsed.data
  const selectedName = sourceName?.trim().toLowerCase()
  if (exportData.format === 'grok-bot-memory-completion') {
    if (selectedName !== undefined && exportData.bot_name.toLowerCase() !== selectedName) {
      return invalid('Select exactly one source Bot from the Grok Bot export.')
    }
    const recovered = [...exportData.memories, ...exportData.user_facts]
    if (recovered.length !== exportData.retrieved_total || recovered.length > exportData.reported_total) {
      return invalid('The supplemental memory counts do not match the export.')
    }
    const complete = recovered.filter(row => !row.truncated)
    return {
      name: exportData.bot_name,
      memories: distinctMemories(complete.map(row => row.text)),
      memoryGaps: { truncated: recovered.length - complete.length, unretrieved: exportData.reported_total - recovered.length },
      skills: [], routines: [],
    }
  }
  const candidates = selectedName === undefined
    ? exportData.bots
    : exportData.bots.filter(bot => bot.name.toLowerCase() === selectedName)
  const [bot] = candidates
  if (bot === undefined || candidates.length !== 1) return invalid('Select exactly one source Bot from the Grok Bot export.')
  const uniqueMemories = distinctMemories([...bot.memories, ...bot.user_facts])
  const titles = new Set<string>()
  const now = Date.now()
  const routines = bot.routines.map((item) => {
    if (!timedTriggers.has(item.trigger.toLowerCase())) return invalid('This import supports timed Grok routines with a cron rule and time zone.')
    const key = item.name.toLowerCase()
    if (titles.has(key)) return invalid('Two imported routines have the same name.')
    titles.add(key)
    try {
      const cron = { expression: item.schedule_cron, time_zone: item.timezone }
      const { title, expression, timeZone } = createCronScheduleRecord(ScheduleId('schedule-grok-preview'), item.instruction, cron, now, item.name)
      return { title, prompt: item.instruction, cron: { expression, time_zone: timeZone }, skills: item.skills }
    } catch (error: unknown) {
      if (!(error instanceof ScheduleInputError)) throw error
      return invalid('An imported routine has an invalid cron rule or time zone.')
    }
  })
  return { name: bot.name, memories: uniqueMemories, skills: bot.skills, routines }
}
