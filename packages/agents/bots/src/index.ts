/** Durable user-owned Bot roster with one ordinary Session per Bot. */

import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { Context, Service } from '@yharness/cordis'
import { MessageId } from '@yharness/llm/brand'
import { freezeMessage } from '@yharness/llm'
import type { UserMessage } from '@yharness/llm'
import type { Agent } from '@yharness/agent'
import type {} from '@yharness/system-prompt'
import type {} from '@yharness/avatar-generation'
import { ScheduleId, ScheduleInputError, scheduleTitle, scheduleView } from '@yharness/schedule'
import { snapshotJsonValue, type JsonValue } from '@yharness/util-values'
import type {
  AtInput,
  CronInput,
  DailyInput,
  ScheduleCatalogEntry,
  ScheduleCreateRequest,
  ScheduleRecord,
  ScheduleTimingChange,
  WeeklyInput,
} from '@yharness/schedule'
import type { ImageAttachmentRef } from '@yharness/attachment'
import { SessionId } from '@yharness/session'
import type { SessionEvent } from '@yharness/session'
import type { SessionCreateRequest } from '@yharness/api-session-controller'
import type { Domain, KvTable } from '@yharness/storage-domain'
import z from '@yharness/schemastery'
import { Remote, RemoteError, TypertRemoteService, remoteErrorOf } from '@yharness/typert-protocol'
import { BOT_ACCENTS, BOT_EVENT_SOURCES, BOT_IDENTITIES, BotId } from './types.ts'
import { BotCollaborationError, BotCollaborationService } from './collaboration.ts'
import type { BotCollaborationClient } from './collaboration.ts'
import type { BotEventRelayContext } from './collaboration.ts'
import { createBotNativeToolProvider } from './native-tools.ts'
import type { BotNativeToolHost, BotRoutineCreateResolution, BotRoutineCreateReservation } from './native-tools.ts'
import { installBotCollaborationTools } from './scoped-tools.ts'
import { installBotRoutineTools } from './routine-tools.ts'
import type { BotEventRoutineToolHost } from './routine-tools.ts'
import { botInboxMessageState } from './inbox.ts'
import type { ToolExecution } from '@yharness/tools'
import type {
  BotAvailability,
  BotAccent,
  BotEventRoutine,
  BotEventRoutineDelivery,
  BotEventRoutineResult,
  BotEventRoutineView,
  BotEventSource,
  BotEventTrigger,
  BotAppearanceUpdateRequest,
  BotAppearanceUpdateValue,
  BotAvatarUpdateRequest,
  BotAvatarUpdateValue,
  BotAvatarReadRequest,
  BotAvatarReadValue,
  BotCreateRequest,
  BotCreateValue,
  BotIdentity,
  BotListRequest,
  BotListValue,
  BotRecord,
  BotRenameRequest,
  BotRenameValue,
  BotView,
} from './types.ts'
import { BOT_APPEARANCE_MIGRATION_VERSION, botDomain, imageAttachmentRefSchema } from './storage.ts'

type RoutineArguments = Record<string, unknown>

interface BotEventRoutineCreateRequest {
  readonly prompt: string
  readonly title: string
  readonly event: BotEventTrigger
}

type BotRoutineCreateRequest = ScheduleCreateRequest | BotEventRoutineCreateRequest

type BotRoutineTimingChange = ScheduleTimingChange | { readonly kind: 'event'; readonly event: BotEventTrigger }

function isEventRoutineRequest(request: BotRoutineCreateRequest): request is BotEventRoutineCreateRequest {
  return 'event' in request
}

/** Fixed safety ceiling for one event-routine peer-message chain. */
const MAX_EVENT_ROUTINE_HOPS = 4

interface EventRoutineTriggerInput {
  readonly message: UserMessage
  readonly eventSeq: number
  readonly eventTime: number
  readonly source: BotEventSource
  readonly relayContext?: BotEventRelayContext | undefined
}

export type * from './types.ts'
export { BOT_ACCENTS, BOT_EVENT_SOURCES, BOT_IDENTITIES, BotId } from './types.ts'
export { botDomain, botRecordSchema } from './storage.ts'
export {
  BotCollaborationError,
  BotCollaborationService,
  BotMessageId,
  projectBotTranscript,
} from './collaboration.ts'
export type {
  BotCollaborationClient,
  BotCollaborationAgent,
  BotCollaborationErrorCode,
  BotEventRelayContext,
  BotCollaborationHost,
  BotCollaborationInspection,
  BotCollaborationInspectionValue,
  BotCollaborationRosterEntry,
  BotCollaborationTranscriptEntry,
  BotDynamicToolEvent,
  BotDynamicToolEventResult,
  BotMessageSource,
  SendBotMessageRequest,
  SendBotMessageResult,
} from './collaboration.ts'
export { imageAttachmentRefSchema } from './storage.ts'
export { installBotCollaborationTools } from './scoped-tools.ts'

declare module '@yharness/cordis' {
  interface Context {
    /** Durable user-owned Bot roster and one-Session provisioning service. */
    bots: BotService
  }
}

/** Empty Bot service configuration. */
export const Config = z.object({})

interface NormalizedCreate {
  readonly id?: BotRecord['id']
  readonly name: string
  readonly description?: string
  readonly identity: BotIdentity
  readonly accent: BotAccent
  readonly cwd: string
  readonly agentPreset?: string
}

const BOT_ID_PATTERN = /^bot-[A-Za-z0-9][A-Za-z0-9-]*$/

function badRequest(message: string): never {
  throw new RemoteError('gateway/bad-request', message, {})
}

function textLength(value: string): number {
  return [...value].length
}

function normalizeName(value: string): string {
  if (typeof value !== 'string') return badRequest('Bot name must be a string')
  const name = value.trim()
  if (name.length === 0) return badRequest('Bot name must not be empty')
  if (textLength(name) > 80) return badRequest('Bot name must be at most 80 characters')
  return name
}

function normalizeOptionalText(
  label: string,
  value: string | undefined,
  max: number,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return badRequest(`${label} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (textLength(trimmed) > max) return badRequest(`${label} must be at most ${String(max)} characters`)
  return trimmed
}

function normalizeBotId(value: BotRecord['id'] | undefined): BotRecord['id'] | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !BOT_ID_PATTERN.test(value)) {
    return badRequest('Bot id must begin with bot- and contain simple URL-safe segments')
  }
  return BotId(value)
}

function normalizeIdentity(value: BotCreateRequest['identity']): BotIdentity {
  const identity = value ?? 'agent'
  if (!BOT_IDENTITIES.includes(identity)) return badRequest(`Unknown Bot identity '${String(identity)}'`)
  return identity
}

function normalizeAccent(value: BotCreateRequest['accent']): BotAccent {
  const accent = value ?? 'violet'
  if (!BOT_ACCENTS.includes(accent)) return badRequest(`Unknown Bot accent '${String(accent)}'`)
  return accent
}

function normalizeAppearanceIdentity(value: BotAppearanceUpdateRequest['identity']): BotIdentity | undefined {
  if (value === undefined) return undefined
  if (!BOT_IDENTITIES.includes(value)) return badRequest(`Unknown Bot identity '${String(value)}'`)
  return value
}

function normalizeAppearanceAccent(value: BotAppearanceUpdateRequest['accent']): BotAccent | undefined {
  if (value === undefined) return undefined
  if (!BOT_ACCENTS.includes(value)) return badRequest(`Unknown Bot accent '${String(value)}'`)
  return value
}

function normalizeClearAvatar(value: BotAppearanceUpdateRequest['clearAvatar']): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') return badRequest('Bot clearAvatar must be a boolean')
  return value
}

function normalizeCreate(request: BotCreateRequest): NormalizedCreate {
  if (request === null || typeof request !== 'object') return badRequest('Bot create request must be an object')
  const id = normalizeBotId(request.id)
  const name = normalizeName(request.name)
  const description = normalizeOptionalText('Bot description', request.description, 240)
  const cwdInput = normalizeOptionalText('Bot working directory', request.cwd, 4096)
  const agentPreset = normalizeOptionalText('Bot agent preset', request.agentPreset, 160)
  return {
    ...(id === undefined ? {} : { id }),
    name,
    ...(description === undefined ? {} : { description }),
    identity: normalizeIdentity(request.identity),
    accent: normalizeAccent(request.accent),
    cwd: resolve(cwdInput ?? process.cwd()),
    ...(agentPreset === undefined ? {} : { agentPreset }),
  }
}

function matchesMetadata(record: BotRecord, request: NormalizedCreate): boolean {
  return record.name === request.name
    && record.description === request.description
    && record.identity === request.identity
    && record.accent === request.accent
    && record.cwd === request.cwd
    && record.agentPreset === request.agentPreset
}

function routineText(args: RoutineArguments, key: string): string | undefined {
  const value = args[key]
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

function routineRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) record[key] = entry
  return record
}

function routineNumber(value: unknown, label: string): number {
  if (typeof value !== 'number') {
    throw new BotCollaborationError('message-invalid', `${label} must be a number.`)
  }
  return value
}

function routineWeekdays(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const days = value.filter((item): item is number => typeof item === 'number')
  return days.length === value.length ? days : undefined
}

function routineAt(value: unknown): AtInput {
  if (typeof value === 'string') return value
  const record = routineRecord(value)
  if (record === undefined
    || typeof record.date !== 'string' || typeof record.time !== 'string' || typeof record.time_zone !== 'string') {
    throw new BotCollaborationError('message-invalid', 'A routine at value must be an RFC 3339 string or a local date, time, and time_zone.')
  }
  return { date: record.date, time: record.time, time_zone: record.time_zone }
}

function routineDaily(value: unknown): DailyInput {
  const record = routineRecord(value)
  if (record === undefined || typeof record.time !== 'string' || typeof record.time_zone !== 'string') {
    throw new BotCollaborationError('message-invalid', 'A daily routine needs time and time_zone.')
  }
  return { time: record.time, time_zone: record.time_zone }
}

function routineWeekly(value: unknown): WeeklyInput {
  const record = routineRecord(value)
  const weekdays = record === undefined ? undefined : routineWeekdays(record.weekdays)
  if (record === undefined || typeof record.time !== 'string' || typeof record.time_zone !== 'string'
    || weekdays === undefined) {
    throw new BotCollaborationError('message-invalid', 'A weekly routine needs time, time_zone, and weekdays.')
  }
  return { time: record.time, time_zone: record.time_zone, weekdays: [...weekdays].sort((a, b) => a - b) }
}

function routineCron(value: unknown): CronInput {
  const record = routineRecord(value)
  if (record === undefined || typeof record.expression !== 'string' || typeof record.time_zone !== 'string') {
    throw new BotCollaborationError('message-invalid', 'A cron routine needs expression and time_zone.')
  }
  return { expression: record.expression, time_zone: record.time_zone }
}

function routineEvent(value: unknown): BotEventTrigger {
  const record = routineRecord(value)
  if (record === undefined || record.type !== 'message' || typeof record.source !== 'string'
    || !BOT_EVENT_SOURCES.includes(record.source as BotEventSource)) {
    throw new BotCollaborationError(
      'message-invalid',
      'A routine event must be { type: "message", source: "bot" | "user" }.',
    )
  }
  return { type: 'message', source: record.source as BotEventSource }
}

function routineCreateRequest(args: RoutineArguments): BotRoutineCreateRequest {
  rejectUnsupportedRoutineTrigger(args)
  const prompt = routineText(args, 'prompt')
  const title = routineText(args, 'title')
  if (prompt === undefined || title === undefined) {
    throw new BotCollaborationError('message-invalid', 'A routine needs non-empty prompt and title.')
  }
  if (args.event !== undefined) {
    const selectors = ['after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron']
      .filter(key => args[key] !== undefined)
    if (selectors.length > 0) {
      throw new BotCollaborationError('message-invalid', 'An event routine cannot also supply a timing selector.')
    }
    return { prompt, title, event: routineEvent(args.event) }
  }
  const request: ScheduleCreateRequest = { prompt, title }
  const selectors: Partial<ScheduleCreateRequest> = {}
  if (args.after_seconds !== undefined) selectors.after_seconds = routineNumber(args.after_seconds, 'after_seconds')
  if (args.at !== undefined) selectors.at = routineAt(args.at)
  if (args.every_seconds !== undefined) selectors.every_seconds = routineNumber(args.every_seconds, 'every_seconds')
  if (args.daily !== undefined) selectors.daily = routineDaily(args.daily)
  if (args.weekly !== undefined) selectors.weekly = routineWeekly(args.weekly)
  if (args.cron !== undefined) selectors.cron = routineCron(args.cron)
  if (Object.keys(selectors).length !== 1) {
    throw new BotCollaborationError('message-invalid', 'A routine needs exactly one timing selector.')
  }
  return { ...request, ...selectors }
}

/** Reject unrecognized event-trigger aliases instead of silently ignoring them. */
function rejectUnsupportedRoutineTrigger(args: RoutineArguments): void {
  if (Object.hasOwn(args, 'trigger') || Object.hasOwn(args, 'on_event')) {
    throw new BotCollaborationError(
      'message-invalid',
      'Use event: { type: "message", source: "bot" | "user" } for event-triggered routines.',
    )
  }
}

/** Remove catalog-only ownership and lifecycle fields before a compare-and-update. */
function routineCatalogRecord(entry: ScheduleCatalogEntry): ScheduleRecord {
  const { sessionId, status, lastDelivery, ...record } = entry
  void sessionId
  void status
  void lastDelivery
  return record
}

/** Stable Host retry identity for one Bot Session's native routine operation. */
function routineOperationKey(
  sessionId: SessionId,
  context: Pick<Parameters<NonNullable<BotNativeToolHost['routine']>>[2], 'callId' | 'threadId' | 'turnId'>,
): string {
  return createHash('sha256')
    .update('bot-routine-create\0')
    .update(String(sessionId))
    .update('\0')
    .update(context.callId)
    .update('\0')
    .update(context.threadId)
    .update('\0')
    .update(context.turnId)
    .digest('hex')
}

function routineIdempotencyKey(
  sessionId: SessionId,
  context: Parameters<NonNullable<BotNativeToolHost['routine']>>[2],
): string {
  return routineOperationKey(sessionId, context)
}

/** Stable identity for one native event-routine create operation. */
function eventRoutineOperationKey(
  sessionId: SessionId,
  context: Pick<Parameters<NonNullable<BotNativeToolHost['routine']>>[2], 'callId' | 'threadId' | 'turnId'>,
): string {
  return createHash('sha256')
    .update('bot-event-routine-create\0')
    .update(String(sessionId))
    .update('\0')
    .update(context.callId)
    .update('\0')
    .update(context.threadId)
    .update('\0')
    .update(context.turnId)
    .digest('hex')
}

/** Prefix a user-visible event routine id without exposing native call ids. */
function eventRoutineId(
  sessionId: SessionId,
  context: Pick<Parameters<NonNullable<BotNativeToolHost['routine']>>[2], 'callId' | 'threadId' | 'turnId'>,
): string {
  return `bot-event-routine-${eventRoutineOperationKey(sessionId, context)}`
}

/** Project one durable event routine into the common native routine view. */
function eventRoutineView(routine: BotEventRoutine): BotEventRoutineView {
  const { deliveries, results, ...view } = routine
  void deliveries
  void results
  return { ...view, kind: 'event', state: 'waiting', deliveryMode: 'host' }
}

/** Clear an uncertain follow-up marker for an explicit or cancellation-driven retry. */
function clearDispatchMarker(delivery: BotEventRoutineDelivery): BotEventRoutineDelivery {
  const { dispatchStartedAt, ...withoutDispatchMarker } = delivery
  void dispatchStartedAt
  return withoutDispatchMarker
}

/** Extract plain visible text from model content without exposing tool or reasoning blocks. */
function visibleText(content: readonly { readonly type: string; readonly text?: string }[]): string {
  return content.flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : []).join('')
}

/** Validate durable relay metadata and supply a stable chain for legacy routine notices. */
function relayContextOf(
  value: { readonly chainId?: string | undefined; readonly depth?: number | undefined } | undefined,
  fallbackChainId: string,
): BotEventRelayContext | undefined {
  if (value === undefined) return undefined
  const chainId = typeof value.chainId === 'string' && value.chainId.trim() !== '' ? value.chainId : fallbackChainId
  const depth = value.depth === undefined ? 0 : value.depth
  if (!Number.isSafeInteger(depth) || depth < 0) return { chainId, depth: MAX_EVENT_ROUTINE_HOPS }
  return { chainId, depth: Math.min(depth, MAX_EVENT_ROUTINE_HOPS) }
}

/** Return the currently open turn recorded in a Session log, if any. */
function openTurnFromEvents(events: readonly SessionEvent[]): number {
  let openTurn = -1
  for (const event of events) {
    if (event.type === 'turn/start') openTurn = event.data.turn
    else if (event.type === 'turn/end' && event.data.turn === openTurn) openTurn = -1
  }
  return openTurn
}

/** Reconstruct every routine-triggered turn from one persisted Session scan. */
function routineTurnsFromEvents(events: readonly SessionEvent[]): Map<number, EventRoutineTurn> {
  const turns = new Map<number, EventRoutineTurn>()
  let openTurn: EventRoutineTurn | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      openTurn = { turn: event.data.turn, runs: new Map(), output: [] }
      turns.set(event.data.turn, openTurn)
      continue
    }
    if (event.type === 'turn/end') {
      if (openTurn?.turn === event.data.turn) openTurn = undefined
      continue
    }
    if (openTurn === undefined) continue
    if (event.type === 'user/message') {
      if (event.data.source.kind === 'bot-event-routine') {
        openTurn.runs.set(String(event.data.id), event.data.source.routineId)
        openTurn.relayContext ??= relayContextOf(event.data.source, `${String(event.data.id)}:${String(openTurn.turn)}`)
      } else if (event.data.source.kind === 'agent-message' && event.data.source.botEventRoutine !== undefined) {
        openTurn.relayContext ??= relayContextOf(
          event.data.source.botEventRoutine,
          `${String(event.data.id)}:${String(openTurn.turn)}`,
        )
      }
    } else if (event.type === 'assistant/message') {
      openTurn.output.push(visibleText(event.data.message.content))
    }
  }
  return turns
}

/** Reconstruct one routine-triggered turn, retaining live facts when a surface read races it. */
function routineTurnFromEvents(
  events: readonly SessionEvent[],
  turnNumber: number,
  fallback: EventRoutineTurn | undefined,
): EventRoutineTurn {
  const persisted = routineTurnsFromEvents(events).get(turnNumber)
  const runs = new Map(persisted?.runs ?? [])
  const output = [...persisted?.output ?? []]
  if (runs.size === 0 && fallback !== undefined) {
    for (const [messageId, routineId] of fallback.runs) runs.set(messageId, routineId)
  }
  if (output.length === 0 && fallback !== undefined) output.push(...fallback.output)
  return {
    turn: turnNumber,
    runs,
    output,
    relayContext: persisted?.relayContext ?? fallback?.relayContext,
  }
}

/** Map a live Session turn reason into the bounded event-routine result vocabulary. */
function routineResultStatus(kind: string): BotEventRoutineResult['status'] {
  switch (kind) {
    case 'completed': return 'completed'
    case 'error': return 'error'
    case 'aborted': return 'aborted'
    case 'blocked': return 'blocked'
    case 'max-tokens': return 'max-tokens'
    case 'interrupted': return 'interrupted'
    case 'forked': return 'forked'
    default: return 'other'
  }
}

function routineUpdateContent(args: RoutineArguments): { readonly title?: string; readonly prompt?: string } {
  const title = args.title === undefined ? undefined : routineText(args, 'title')
  const prompt = args.prompt === undefined ? undefined : routineText(args, 'prompt')
  if (args.title !== undefined && title === undefined) {
    throw new BotCollaborationError('message-invalid', 'Routine title must be non-empty.')
  }
  if (args.prompt !== undefined && prompt === undefined) {
    throw new BotCollaborationError('message-invalid', 'Routine prompt must be non-empty.')
  }
  return { ...(title === undefined ? {} : { title }), ...(prompt === undefined ? {} : { prompt }) }
}

function routineTimingChange(args: RoutineArguments): BotRoutineTimingChange | undefined {
  rejectUnsupportedRoutineTrigger(args)
  const selectors = ['at', 'every_seconds', 'daily', 'weekly', 'cron'].filter(key => args[key] !== undefined)
  if (args.event !== undefined) {
    if (selectors.length > 0) throw new BotCollaborationError('message-invalid', 'An event routine update cannot also supply a timing selector.')
    return { kind: 'event', event: routineEvent(args.event) }
  }
  if (selectors.length > 1) throw new BotCollaborationError('message-invalid', 'A routine update accepts at most one timing selector.')
  const selector = selectors[0]
  if (selector === undefined) return undefined
  if (selector === 'at') return { kind: 'at', at: routineAt(args.at) }
  if (selector === 'every_seconds') return { kind: 'every', every_seconds: routineNumber(args.every_seconds, 'every_seconds') }
  if (selector === 'daily') return { kind: 'daily', daily: routineDaily(args.daily) }
  if (selector === 'weekly') return { kind: 'weekly', weekly: routineWeekly(args.weekly) }
  return { kind: 'cron', cron: routineCron(args.cron) }
}

function routineId(args: RoutineArguments): string {
  const value = args.id
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new BotCollaborationError('message-invalid', 'Routine id must be non-empty without surrounding whitespace.')
  }
  return value
}

function sessionRequest(record: BotRecord): SessionCreateRequest {
  return {
    sessionId: record.sessionId,
    cwd: record.cwd,
    ...(record.agentPreset === undefined ? {} : { agentPreset: record.agentPreset }),
  }
}

/** Stable scoped section name for one Bot's model-visible identity. */
const BOT_IDENTITY_SECTION = 'bot:identity'

/** Render the Bot identity that every model route, including native Codex, receives. */
function botIdentityPrompt(record: BotRecord): string {
  return [
    'You are a named Bot in Y Harness.',
    `Your Bot name is ${JSON.stringify(record.name)}.`,
    'When asked who you are or what your name is, identify yourself by that Bot name. Do not answer only with the underlying model or provider name.',
    ...(record.description === undefined ? [] : [`Your role is: ${record.description}`]),
  ].join('\n\n')
}

/** Replace legacy avatar selections without deleting their attachments. */
async function migrateLegacyAvatars(domain: Domain<typeof botDomain>): Promise<void> {
  if (domain.global.get().animatedAvatarVersion === BOT_APPEARANCE_MIGRATION_VERSION) return
  const bots = domain.table('bots')
  for (const [key, record] of bots.entries()) {
    if (record.avatar === undefined) continue
    const { avatar: legacyAvatar, ...withoutAvatar } = record
    void legacyAvatar
    await bots.put(key, withoutAvatar)
  }
  await domain.global.set({ animatedAvatarVersion: BOT_APPEARANCE_MIGRATION_VERSION })
}

interface EventRoutineTurn {
  readonly turn: number
  readonly runs: Map<string, string>
  readonly output: string[]
  relayContext?: BotEventRelayContext | undefined
}

const MAX_ROUTINE_RESULT_OUTPUT = 8_000
const MAX_ROUTINE_DELIVERIES = 200
const MAX_ROUTINE_RESULTS = 200

/** Validate and detach a native-tool result before exposing it to a scoped tool. */
function routineJsonResult(value: unknown): JsonValue {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) throw new Error('Bot routine returned a non-JSON result.')
  return snapshot as JsonValue
}

/** Host service that owns the durable roster and its Session mappings. */
export class BotService extends TypertRemoteService {
  private manageBots!: NonNullable<BotNativeToolHost['manage']>
  static inject = ['agents', 'storageDomain', 'sessionController', 'sessions', 'attachments', 'systemPrompt', 'tools']

  static Config = Config

  private readonly ready: Promise<Domain<typeof botDomain>>
  private readonly initialized: PromiseLike<unknown>
  private readonly recordsBySession = new Map<string, BotRecord>()
  private readonly promptFibers = new Map<Agent, ReturnType<Context['inject']>>()
  private readonly promptDisposals = new Set<Promise<void>>()
  private readonly eventRoutineTurns = new Map<string, EventRoutineTurn>()
  private readonly collaboration: BotCollaborationService
  private chain: Promise<unknown> = Promise.resolve()
  private stopping = false

  /**
   * @param ctx - Host context carrying storage and explicit Session creation.
   */
  constructor(ctx: Context) {
    super(ctx, 'bots', { namespace: 'bots' })
    this.ready = ctx.storageDomain.open(botDomain).then(async (domain) => {
      const seenSessions = new Set<string>()
      for (const [key, record] of domain.table('bots').entries()) {
        if (key !== record.id) {
          try {
            await domain.close()
          } catch (error: unknown) {
            ctx.logger.warn(`bots: closing after a key mismatch failed: ${String(error)}`)
          }
          throw new Error(`bots: stored key "${key}" differs from record id "${record.id}"`)
        }
        if (seenSessions.has(record.sessionId)) {
          try {
            await domain.close()
          } catch (error: unknown) {
            ctx.logger.warn(`bots: closing after a duplicate Session mapping failed: ${String(error)}`)
          }
          throw new Error(`bots: Session "${record.sessionId}" is mapped by more than one Bot`)
        }
        seenSessions.add(record.sessionId)
      }
      try {
        await migrateLegacyAvatars(domain)
      } catch (error) {
        try { await domain.close() } catch (closeError: unknown) {
          ctx.logger.warn(`bots: closing after startup failed: ${String(closeError)}`)
        }
        throw error
      }
      for (const [, record] of domain.table('bots').entries()) this.recordsBySession.set(String(record.sessionId), record)
      return domain
    })
    this.collaboration = new BotCollaborationService({
      listBots: async () => (await this.list({})).bots,
      inspectSession: async (sessionId) => {
        const inspection = await ctx.sessionController.inspect(sessionId)
        return { events: inspection.events }
      },
      resolveAgent: sessionId => ctx.sessionController.resolveAgent(sessionId),
      flushSession: async (sessionId) => {
        let session = ctx.sessions.get(sessionId)
        if (session === undefined) {
          const resolved = await ctx.sessionController.resolveAgent(sessionId)
          if (!('agent' in resolved)) throw resolved.error
          session = ctx.sessions.get(resolved.agent.id)
        }
        if (session === undefined) throw new Error(`Bot Session "${sessionId}" is not live.`)
        if (!await ctx.sessions.flush(session)) throw new Error('Bot Session has no durable persistence listener.')
      },
      eventRoutineContext: sessionId => this.eventRoutineContext(sessionId),
    })
    ctx.on('session/event', (session, event) => {
      void this.ready.then(() => {
        if (!this.stopping) this.observeEventRoutineSessionEvent(session.id, event)
      }).catch((error: unknown) => {
        ctx.logger.warn(`bots: event routine observer failed: ${String(error)}`)
      })
    }, { global: true })
    ctx.provide('codexDynamicTools', createBotNativeToolProvider({
      bind: async (sessionId) => {
        const agent = ctx.get('agents')?.get(sessionId)
        if (agent === undefined) return undefined
        try {
          return await this.collaboration.bind(agent)
        } catch (error: unknown) {
          if (error instanceof BotCollaborationError && error.code === 'sender-not-bot') return undefined
          throw error
        }
      },
      manage: this.manageBots = async (action, args, context) => {
        const text = (key: string): string | undefined => {
          const value = args[key]
          if (value === undefined) return undefined
          if (typeof value !== 'string' || value.trim() === '') throw new Error(`Invalid ${key}.`)
          return value.trim()
        }
        const name = text('name')
        const description = normalizeOptionalText('Bot description', text('description'), 240)
        const identityText = text('identity')
        const accentText = text('accent')
        const pictureDescription = text('pictureDescription')
        const identity = BOT_IDENTITIES.find(value => value === identityText)
        const accent = BOT_ACCENTS.find(value => value === accentText)
        if (identityText !== undefined && identity === undefined) throw new Error('Invalid Bot character.')
        if (accentText !== undefined && accent === undefined) throw new Error('Invalid Bot color.')
        if (action === 'edit' && name === undefined && description === undefined && identity === undefined && accent === undefined && pictureDescription === undefined) {
          throw new Error('Specify a profile change.')
        }
        const setPicture = async (botId: BotId): Promise<void> => {
          if (pictureDescription === undefined) return
          const generator = ctx.get('avatarGeneration')
          if (generator === undefined) throw new Error('Avatar generation is unavailable.')
          const preview = await generator.generate({ description: pictureDescription }, context.signal)
          context.signal.throwIfAborted()
          const { attachment } = await generator.commit(preview)
          context.signal.throwIfAborted()
          await this.updateAvatarImpl({ botId, avatar: attachment }, context.signal)
        }
        context.signal.throwIfAborted()
        if (action === 'create') {
          if (name === undefined) throw new Error('Bot name is required.')
          const sender = context.sessionId === undefined ? undefined : this.recordsBySession.get(String(context.sessionId))
          if (sender === undefined) throw new Error('Bot management requires a live Bot.')
          const digest = createHash('sha256').update(`${context.sessionId}:${context.threadId}:${context.turnId}:${context.callId}`).digest('hex')
          const created = await this.createImpl({ id: BotId(`bot-${digest}`), name,
            cwd: sender.cwd,
            ...(description === undefined ? {} : { description }),
            ...(identity === undefined ? {} : { identity }), ...(accent === undefined ? {} : { accent }) }, context.signal)
          try {
            await setPicture(created.bot.id)
          } catch {
            return { id: created.bot.id, name: created.bot.name, state: created.bot.state,
              pictureError: 'The Bot was created, but its picture could not be generated.' }
          }
          return { id: created.bot.id, name: created.bot.name, state: created.bot.state }
        }
        const current = context.sessionId === undefined ? undefined : this.recordsBySession.get(String(context.sessionId))
        const botId = BotId(text('botId') ?? current?.id ?? '')
        if (!(await this.list({})).bots.some(bot => bot.id === botId)) throw new Error('Bot not found.')
        if (name !== undefined) normalizeName(name)
        context.signal.throwIfAborted()
        await setPicture(botId)
        if (identity !== undefined || accent !== undefined) {
          await this.updateAppearanceImpl({ botId, ...(identity === undefined ? {} : { identity }),
            ...(accent === undefined ? {} : { accent }),
            clearAvatar: identity !== undefined && pictureDescription === undefined }, context.signal)
        }
        if (name !== undefined) await this.renameImpl({ botId, name }, context.signal)
        if (description !== undefined) await this.updateBotDescription(botId, description, context.signal)
        return { id: botId, updated: true }
      },
      routine: (action, args, context) => this.runRoutine(action, args, context),
      routineReconcile: async (args, pending, context): Promise<BotRoutineCreateResolution> => {
        const sessionId = context.sessionId
        if (sessionId === undefined || this.recordsBySession.get(String(sessionId)) === undefined) {
          throw new BotCollaborationError('sender-not-bot', 'Bot routines require a live Bot Session.')
        }
        try {
          const request = routineCreateRequest(args)
          if (isEventRoutineRequest(request)) {
            const existing = await this.findEventRoutine(sessionId, eventRoutineId(sessionId, pending))
            return existing === undefined
              ? { status: 'unknown' }
              : { status: 'committed', record: eventRoutineView(existing) }
          }
          const schedule = ctx.get('schedule')
          if (schedule === undefined) throw new Error('Bot routines are unavailable.')
          const resolution = await schedule.reconcileCreate(
            sessionId, request, routineOperationKey(sessionId, pending), context.signal,
          )
          context.signal.throwIfAborted()
          if (resolution.status === 'absent' || resolution.status === 'unknown') return resolution
          return { status: 'committed', record: { ...scheduleView(resolution.record, Date.now()) } }
        } catch (error: unknown) {
          if (error instanceof BotCollaborationError) throw error
          if (context.signal.aborted) throw new BotCollaborationError('cancelled', 'The Bot routine was cancelled.', { cause: error })
          if (error instanceof ScheduleInputError) {
            throw new BotCollaborationError('message-invalid', error.message, { cause: error })
          }
          throw error
        }
      },
      routineReserve: async (args, context): Promise<BotRoutineCreateReservation> => {
        const sessionId = context.sessionId
        if (sessionId === undefined || this.recordsBySession.get(String(sessionId)) === undefined) {
          throw new BotCollaborationError('sender-not-bot', 'Bot routines require a live Bot Session.')
        }
        try {
          const request = routineCreateRequest(args)
          if (isEventRoutineRequest(request)) return { status: 'reserved' }
          const schedule = ctx.get('schedule')
          if (schedule === undefined) throw new Error('Bot routines are unavailable.')
          const reservation = await schedule.reserveCreate(
            sessionId, request, routineOperationKey(sessionId, context), context.signal,
          )
          if (reservation.status === 'committed') {
            return { status: 'committed', record: { ...scheduleView(reservation.record, Date.now()) } }
          }
          return { status: 'reserved' }
        } catch (error: unknown) {
          if (error instanceof BotCollaborationError) throw error
          if (context.signal.aborted) throw new BotCollaborationError('cancelled', 'The Bot routine was cancelled.', { cause: error })
          if (error instanceof ScheduleInputError) {
            throw new BotCollaborationError('message-invalid', error.message, { cause: error })
          }
          throw error
        }
      },
      routineRelease: async (args, context): Promise<void> => {
        const sessionId = context.sessionId
        if (sessionId === undefined || this.recordsBySession.get(String(sessionId)) === undefined) return
        try {
          const request = routineCreateRequest(args)
          if (isEventRoutineRequest(request)) return
          const schedule = ctx.get('schedule')
          if (schedule === undefined) return
          await schedule.releaseCreate(sessionId, request, routineOperationKey(sessionId, context))
        } catch (error: unknown) {
          if (error instanceof ScheduleInputError) {
            throw new BotCollaborationError('message-invalid', error.message, { cause: error })
          }
          throw error
        }
      },
      routineAvailable: async (sessionId) => {
        const agent = ctx.agents.get(sessionId)
        if (agent === undefined) return false
        await this.installPrompt(agent)
        return [
          'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
          'schedule_pause', 'schedule_resume', 'schedule_history',
        ]
          .every(name => ctx.tools.get(name, agent) !== undefined)
      },
      persist: async (event) => {
        await this.ready
        const session = ctx.sessions.get(event.sessionId)
        if (session === undefined) throw new Error(`Bot Session "${event.sessionId}" is not live.`)
        session.append('bot/dynamic-tool', event)
        if (!await ctx.sessions.flush(session)) throw new Error('Bot Session has no durable persistence listener.')
      },
      replay: async (sessionId) => {
        await this.ready
        const inspection = await ctx.sessionController.inspect(sessionId)
        return inspection.events.flatMap(event => event.type === 'bot/dynamic-tool' ? [event.data] : [])
      },
    }))
    ctx.on('agent/created', async ({ agent }) => { await this.installPrompt(agent) })
    ctx.on('agent/disposed', ({ agent }) => { this.disposePrompt(agent) })
    this.initialized = ctx.effect(async () => {
      const domain = await this.ready
      let cleanup: () => Promise<void>
      try {
        cleanup = ctx.effect(() => async () => {
          this.stopping = true
          await this.chain
          const promptFibers = [...this.promptFibers.values()]
          this.promptFibers.clear()
          await Promise.all([
            ...promptFibers.map(fiber => fiber.dispose()),
            ...this.promptDisposals,
          ])
          await domain.close()
        })
      } catch (error) {
        this.stopping = true
        await domain.close()
        throw error
      }
      return cleanup
    })
  }

  async [Service.init](): Promise<void> {
    await this.initialized
    await Promise.all(this.ctx.agents.list().map(agent => this.installPrompt(agent)))
    await this.recoverPendingEventRoutines()
    await this.recoverEventRoutineResults()
  }

  /**
   * Bind peer-Bot operations to the live Agent that owns the current turn.
   *
   * The provider bridge must supply this Agent from its runtime context; the
   * returned client never accepts a model-supplied sender Session id. Each
   * operation rechecks that the Session remains owned by a durable Bot.
   * @param agent - live Agent supplied by the provider bridge or scoped tool.
   * @returns collaboration operations attributed to that Bot.
   */
  collaborationFor(agent: Pick<Agent, 'id'>): Promise<BotCollaborationClient> {
    return this.collaboration.bind(agent)
  }

  /**
   * Execute one native routine operation against the calling Bot's Session.
   *
   * The native provider performs approval before invoking this adapter. This
   * method still derives the Session from the provider context and rechecks
   * Bot ownership, so a stale native thread cannot retarget another Session.
   *
   * @param action - Routine operation requested by the native provider.
   * @param args - JSON arguments from the model boundary.
   * @param context - Native call identity and cancellation state.
   * @returns The canonical Schedule result or a structured management result.
   */
  private async runRoutine(
    action: 'create' | 'list' | 'update' | 'delete' | 'pause' | 'resume' | 'history',
    args: RoutineArguments,
    context: Parameters<NonNullable<BotNativeToolHost['routine']>>[2],
  ): Promise<unknown> {
    const sessionId = context.sessionId
    if (sessionId === undefined || this.recordsBySession.get(String(sessionId)) === undefined) {
      throw new BotCollaborationError('sender-not-bot', 'Bot routines require a live Bot Session.')
    }
    context.signal.throwIfAborted()
    try {
      if (action === 'create') {
        const request = routineCreateRequest(args)
        if (isEventRoutineRequest(request)) {
          const record = await this.createEventRoutine(sessionId, request, eventRoutineId(sessionId, context), context.signal)
          context.signal.throwIfAborted()
          return eventRoutineView(record)
        }
        const schedule = this.ctx.get('schedule')
        if (schedule === undefined) throw new Error('Bot routines are unavailable.')
        const record = await schedule.create(sessionId, request, context.signal, {
          idempotencyKey: routineIdempotencyKey(sessionId, context),
        })
        context.signal.throwIfAborted()
        return scheduleView(record, Date.now())
      }
      const schedule = this.ctx.get('schedule')
      if (schedule === undefined) throw new Error('Bot routines are unavailable.')
      if (action === 'list') {
        const entries = (await schedule.catalog()).filter(entry => entry.sessionId === sessionId && entry.status !== 'inactive')
        const eventRoutines = await this.listEventRoutines(sessionId)
        context.signal.throwIfAborted()
        return [
          ...entries.map(entry => ({ ...scheduleView(routineCatalogRecord(entry), Date.now()), status: entry.status })),
          ...eventRoutines.map(eventRoutineView),
        ]
      }
      if (action === 'delete') {
        const id = routineId(args)
        if (await this.findEventRoutine(sessionId, id) !== undefined) return await this.deleteEventRoutine(sessionId, id, context.signal)
        return await schedule.delete({ sessionId, id: ScheduleId(id) }, context.signal)
      }
      if (action === 'pause') {
        const id = routineId(args)
        if (await this.findEventRoutine(sessionId, id) !== undefined) return await this.pauseEventRoutine(sessionId, id, context.signal)
        return await schedule.pause({ sessionId, id: ScheduleId(id) }, context.signal)
      }
      if (action === 'resume') {
        const id = routineId(args)
        if (await this.findEventRoutine(sessionId, id) !== undefined) return await this.resumeEventRoutine(sessionId, id, context.signal)
        return await schedule.resume({ sessionId, id: ScheduleId(id) }, context.signal)
      }
      if (action === 'history') {
        const id = routineId(args)
        const limit = args.limit === undefined ? 50 : routineNumber(args.limit, 'limit')
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          throw new BotCollaborationError('message-invalid', 'limit must be a safe integer from 1 through 100.')
        }
        if (args.before !== undefined && typeof args.before !== 'string') {
          throw new BotCollaborationError('message-invalid', 'before must be a message id string.')
        }
        if (await this.findEventRoutine(sessionId, id) !== undefined) {
          if (args.before !== undefined) throw new BotCollaborationError('message-invalid', 'before is not supported for event routine history.')
          return await this.eventRoutineHistory(sessionId, id, limit, context.signal)
        }
        return await schedule.history({
          sessionId, id: ScheduleId(id), limit,
          ...(args.before === undefined ? {} : { before: MessageId(args.before) }),
        })
      }
      const id = routineId(args)
      const eventRoutine = await this.findEventRoutine(sessionId, id)
      if (eventRoutine !== undefined) {
        const content = routineUpdateContent(args)
        const change = routineTimingChange(args)
        if (change !== undefined && change.kind !== 'event') {
          throw new BotCollaborationError('message-invalid', 'An event routine update accepts only an event trigger, title, or prompt.')
        }
        if (change === undefined && content.title === undefined && content.prompt === undefined) {
          throw new BotCollaborationError('message-invalid', 'An event routine update needs a title, prompt, or event selector.')
        }
        return eventRoutineView(await this.updateEventRoutine(sessionId, id, {
          ...content, ...(change?.kind === 'event' ? { event: change.event } : {}),
        }, context.signal))
      }
      const entry = (await schedule.catalog()).find(candidate => candidate.sessionId === sessionId
        && String(candidate.id) === id && candidate.status !== 'inactive')
      context.signal.throwIfAborted()
      if (entry === undefined) {
        const catalog = await schedule.catalog()
        context.signal.throwIfAborted()
        const ended = catalog.some(entry => entry.sessionId === sessionId && String(entry.id) === id)
        return { id, updated: false, code: ended ? 'schedule_ended' : 'schedule_not_found' }
      }
      const expected = routineCatalogRecord(entry)
      const content = routineUpdateContent(args)
      const change = routineTimingChange(args)
      if (change === undefined && content.title === undefined && content.prompt === undefined) {
        throw new BotCollaborationError('message-invalid', 'A routine update needs a title, prompt, or timing selector.')
      }
      if (change?.kind === 'event') {
        throw new BotCollaborationError('message-invalid', 'A timed routine update cannot use an event trigger.')
      }
      const result = await schedule.update({
        sessionId,
        id: ScheduleId(id),
        expected,
        ...(change === undefined ? {} : { change }),
        ...content,
      }, context.signal)
      return 'record' in result ? scheduleView(result.record, Date.now()) : result
    } catch (error: unknown) {
      if (error instanceof BotCollaborationError) throw error
      if (context.signal.aborted) throw new BotCollaborationError('cancelled', 'The Bot routine was cancelled.', { cause: error })
      if (error instanceof ScheduleInputError) {
        throw new BotCollaborationError('message-invalid', error.message, { cause: error })
      }
      throw error
    }
  }

  /** Adapt a scoped event-routine tool call to the Bot's native routine host. */
  private runScopedRoutine(
    action: 'create' | 'list' | 'update' | 'delete' | 'pause' | 'resume' | 'history',
    args: Record<string, unknown>,
    exec: ToolExecution,
  ): Promise<JsonValue> {
    const agent = exec.agent
    return this.runRoutine(action, args, {
      callId: String(exec.callId),
      threadId: String(agent?.id ?? 'bot'),
      turnId: String(exec.callId),
      sessionId: agent?.id,
      signal: exec.signal,
      approvalPolicy: 'on-request',
      requestApproval: () => Promise.resolve(true),
    }).then(routineJsonResult)
  }

  /** Read one event routine without waking its Bot Session. */
  private async findEventRoutine(sessionId: SessionId, id: string): Promise<BotEventRoutine | undefined> {
    const domain = await this.getDomain()
    const record = this.currentBotRecord(domain, sessionId)
    return record?.sessionId === sessionId ? record.eventRoutines?.find(routine => routine.id === id) : undefined
  }

  /** Read the latest durable Bot row for one mapped Session. */
  private currentBotRecord(domain: Domain<typeof botDomain>, sessionId: SessionId): BotRecord | undefined {
    const mapped = this.recordsBySession.get(String(sessionId))
    return mapped === undefined ? undefined : domain.table('bots').get(mapped.id)
  }

  /** Create or replay one Bot event routine under the calling Bot Session. */
  private async createEventRoutine(
    sessionId: SessionId,
    request: BotEventRoutineCreateRequest,
    id: string,
    signal?: AbortSignal,
  ): Promise<BotEventRoutine> {
    return this.serialize(async () => {
      const domain = await this.getDomain()
      const bots = domain.table('bots')
      const current = this.currentBotRecord(domain, sessionId)
      if (current === undefined || current.sessionId !== sessionId) {
        throw new BotCollaborationError('sender-not-bot', 'Bot routines require a live Bot Session.')
      }
      const existing = current.eventRoutines?.find(routine => routine.id === id)
      if (existing !== undefined) {
        if (existing.title !== request.title || existing.prompt !== request.prompt || existing.trigger.source !== request.event.source) {
          throw new BotCollaborationError('message-invalid', 'This event routine operation identity was already used with different arguments.')
        }
        return existing
      }
      const title = scheduleTitle(request.title)
      const prompt = request.prompt.trim()
      if (prompt.length === 0 || prompt.length > 16_000) {
        throw new BotCollaborationError('message-invalid', 'A routine prompt must be non-empty and at most 16000 characters.')
      }
      signal?.throwIfAborted()
      const now = Date.now()
      const routine: BotEventRoutine = {
        id, title, prompt, trigger: request.event, status: 'active', createdAt: now, updatedAt: now,
        deliveries: [], results: [],
      }
      const next: BotRecord = { ...current, eventRoutines: [...current.eventRoutines ?? [], routine], updatedAt: now }
      await bots.put(next.id, next)
      this.recordsBySession.set(String(next.sessionId), next)
      this.emitChanged()
      return routine
    })
  }

  /** List active and paused event routines owned by one Bot Session. */
  private async listEventRoutines(sessionId: SessionId): Promise<readonly BotEventRoutine[]> {
    const domain = await this.getDomain()
    const record = this.currentBotRecord(domain, sessionId)
    return record?.sessionId === sessionId ? [...record.eventRoutines ?? []] : []
  }

  /** Update content or the message source of an event routine. */
  private async updateEventRoutine(
    sessionId: SessionId,
    id: string,
    change: { readonly title?: string; readonly prompt?: string; readonly event?: BotEventTrigger },
    signal?: AbortSignal,
  ): Promise<BotEventRoutine> {
    return this.serialize(async () => {
      const domain = await this.getDomain()
      const bots = domain.table('bots')
      const current = this.currentBotRecord(domain, sessionId)
      const routine = current?.eventRoutines?.find(candidate => candidate.id === id)
      if (current === undefined || routine === undefined || current.sessionId !== sessionId) {
        throw new BotCollaborationError('target-not-found', `Event routine "${id}" was not found.`)
      }
      const title = change.title === undefined ? routine.title : scheduleTitle(change.title)
      const prompt = change.prompt === undefined ? routine.prompt : change.prompt.trim()
      if (prompt.length === 0 || prompt.length > 16_000) {
        throw new BotCollaborationError('message-invalid', 'A routine prompt must be non-empty and at most 16000 characters.')
      }
      signal?.throwIfAborted()
      const nextRoutine: BotEventRoutine = {
        ...routine, title, prompt, ...(change.event === undefined ? {} : { trigger: change.event }),
        updatedAt: Math.max(Date.now(), routine.updatedAt),
      }
      const eventRoutines = current.eventRoutines ?? []
      const next: BotRecord = {
        ...current, eventRoutines: eventRoutines.map(candidate => candidate.id === id ? nextRoutine : candidate),
        updatedAt: Math.max(Date.now(), current.updatedAt),
      }
      await bots.put(next.id, next)
      this.recordsBySession.set(String(next.sessionId), next)
      this.emitChanged()
      return nextRoutine
    })
  }

  /** Delete one event routine and its bounded run history. */
  private async deleteEventRoutine(sessionId: SessionId, id: string, signal?: AbortSignal): Promise<unknown> {
    return this.serialize(async () => {
      const domain = await this.getDomain()
      const bots = domain.table('bots')
      const current = this.currentBotRecord(domain, sessionId)
      if (current === undefined || current.sessionId !== sessionId || !(current.eventRoutines ?? []).some(routine => routine.id === id)) {
        return { id, deleted: false, code: 'schedule_not_found' as const }
      }
      signal?.throwIfAborted()
      const next: BotRecord = {
        ...current,
        eventRoutines: (current.eventRoutines ?? []).filter(routine => routine.id !== id),
        updatedAt: Math.max(Date.now(), current.updatedAt),
      }
      await bots.put(next.id, next)
      this.recordsBySession.set(String(next.sessionId), next)
      this.emitChanged()
      return { id, deleted: true as const }
    })
  }

  /** Pause one event routine while preserving its delivery and result history. */
  private async pauseEventRoutine(sessionId: SessionId, id: string, signal?: AbortSignal): Promise<unknown> {
    return this.setEventRoutineStatus(sessionId, id, 'paused', signal)
  }

  /** Resume one paused event routine. */
  private async resumeEventRoutine(sessionId: SessionId, id: string, signal?: AbortSignal): Promise<unknown> {
    const resumed = await this.setEventRoutineStatus(sessionId, id, 'active', signal)
    if (typeof resumed !== 'object' || resumed === null || !('resumed' in resumed) || resumed.resumed !== true) return resumed
    await this.retryPendingEventRoutines(sessionId, id, true)
    const latest = await this.findEventRoutine(sessionId, id)
    return latest === undefined ? resumed : { ...eventRoutineView(latest), resumed: true }
  }

  private async setEventRoutineStatus(
    sessionId: SessionId,
    id: string,
    status: 'active' | 'paused',
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.serialize(async () => {
      const domain = await this.getDomain()
      const bots = domain.table('bots')
      const current = this.currentBotRecord(domain, sessionId)
      const routine = current?.eventRoutines?.find(candidate => candidate.id === id)
      if (current === undefined || routine === undefined || current.sessionId !== sessionId) {
        return { id, [status === 'active' ? 'resumed' : 'paused']: false, code: 'schedule_not_found' as const }
      }
      signal?.throwIfAborted()
      const nextRoutine = { ...routine, status, updatedAt: Math.max(Date.now(), routine.updatedAt) }
      const next: BotRecord = {
        ...current,
        eventRoutines: (current.eventRoutines ?? []).map(candidate => candidate.id === id ? nextRoutine : candidate),
        updatedAt: Math.max(Date.now(), current.updatedAt),
      }
      await bots.put(next.id, next)
      this.recordsBySession.set(String(next.sessionId), next)
      this.emitChanged()
      return { ...eventRoutineView(nextRoutine), [status === 'active' ? 'resumed' : 'paused']: true }
    })
  }

  /** Read bounded event deliveries and completed model results newest first. */
  private async eventRoutineHistory(sessionId: SessionId, id: string, limit: number, signal?: AbortSignal): Promise<unknown> {
    const routine = await this.findEventRoutine(sessionId, id)
    signal?.throwIfAborted()
    if (routine === undefined) return { id, code: 'schedule_not_found' as const }
    return {
      id,
      deliveries: routine.deliveries.slice(-limit).reverse(),
      results: routine.results.slice(-limit).reverse(),
    }
  }

  /** Observe Bot-owned message routines and retain only the turn facts needed for results. */
  private observeEventRoutineSessionEvent(sessionId: SessionId, event: SessionEvent): void {
    if (this.recordsBySession.get(String(sessionId))?.eventRoutines === undefined) return
    const turnKey = `${String(sessionId)}:${event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'assistant/message'
      ? event.data.turn
      : ''}`
    if (event.type === 'turn/start') {
      this.eventRoutineTurns.set(turnKey, { turn: event.data.turn, runs: new Map(), output: [] })
      return
    }
    // Inbox splices are pending admission and may be canceled. A routine only
    // fires, and a routine result only becomes attributable, after the input
    // is claimed into the model-visible user/message surface below.
    if (event.type === 'user/message') {
      this.observeEventRoutineMessage(sessionId, event.data, Number(event.seq), event.time)
      return
    }
    if (event.type === 'assistant/message') {
      this.eventRoutineTurns.get(turnKey)?.output.push(visibleText(event.data.message.content))
      return
    }
    if (event.type !== 'turn/end') return
    const turn = this.eventRoutineTurns.get(turnKey)
    this.eventRoutineTurns.delete(turnKey)
    queueMicrotask(() => {
      void this.recordEventRoutineResults(sessionId, turn, event)
    })
  }

  /** Handle one queued or surface message, deduplicating its two durable views. */
  private observeEventRoutineMessage(
    sessionId: SessionId,
    message: UserMessage,
    eventSeq: number,
    eventTime: number,
  ): void {
    const source = message.source
    if (source.kind === 'bot-event-routine') {
      const turn = this.eventRoutineTurns.get(`${String(sessionId)}:${this.openTurnNumber(sessionId)}`)
      if (turn !== undefined) {
        turn.runs.set(String(message.id), source.routineId)
        const relayContext = relayContextOf(source, `${String(sessionId)}:${String(message.id)}`)
        if (relayContext !== undefined) turn.relayContext = relayContext
      }
      queueMicrotask(() => {
        void this.markEventRoutineDeliveryClaimed(sessionId, source.routineId, MessageId(message.id), eventTime)
      })
      return
    }
    const trigger = source.kind === 'user'
      ? { source: 'user' as const, relayContext: undefined }
      : source.kind === 'agent-message'
        && source.senderSessionId !== sessionId
        && this.recordsBySession.get(String(source.senderSessionId))?.state === 'active'
        ? { source: 'bot' as const, relayContext: source.botEventRoutine }
        : undefined
    if (trigger === undefined) return
    const relayContext = trigger.relayContext === undefined
      ? undefined
      : relayContextOf(trigger.relayContext, `${String(sessionId)}:${String(message.id)}`)
    if (relayContext !== undefined) {
      const turn = this.eventRoutineTurns.get(`${String(sessionId)}:${this.openTurnNumber(sessionId)}`)
      if (turn !== undefined) turn.relayContext = relayContext
    }
    if (relayContext !== undefined && relayContext.depth >= MAX_EVENT_ROUTINE_HOPS) return
    queueMicrotask(() => {
      void this.triggerEventRoutines(sessionId, {
        message, eventSeq, eventTime, source: trigger.source, relayContext,
      })
    })
  }

  /** Return the most recently opened turn for one Session. */
  private openTurnNumber(sessionId: SessionId): number {
    const prefix = `${String(sessionId)}:`
    let latest = -1
    for (const key of this.eventRoutineTurns.keys()) {
      if (!key.startsWith(prefix)) continue
      const turn = Number(key.slice(prefix.length))
      if (Number.isSafeInteger(turn)) latest = Math.max(latest, turn)
    }
    return latest
  }

  /** Return relay metadata for the currently executing event-routine turn. */
  private eventRoutineContext(sessionId: SessionId): BotEventRelayContext | undefined {
    let openTurn = this.openTurnNumber(sessionId)
    let turn = this.eventRoutineTurns.get(`${String(sessionId)}:${openTurn}`)
    if (turn === undefined) {
      const session = this.ctx.sessions.get(sessionId)
      if (session !== undefined) {
        const events = session.snapshotEvents()
        openTurn = openTurn >= 0 ? openTurn : openTurnFromEvents(events)
        if (openTurn >= 0) turn = routineTurnFromEvents(events, openTurn, undefined)
      }
    }
    if (turn?.relayContext === undefined) return undefined
    return { ...turn.relayContext, depth: Math.min(turn.relayContext.depth + 1, MAX_EVENT_ROUTINE_HOPS) }
  }

  /** Retire a pending delivery once its routine message reaches the model-visible surface. */
  private async markEventRoutineDeliveryClaimed(
    sessionId: SessionId,
    routineId: string,
    messageId: MessageId,
    claimedAt: number,
  ): Promise<void> {
    try {
      const session = this.ctx.sessions.get(sessionId)
      if (session === undefined || !await this.ctx.sessions.flush(session)) {
        throw new Error('Bot Session persistence did not acknowledge the claimed routine message')
      }
      await this.serialize(async () => {
        const domain = await this.getDomain()
        const bots = domain.table('bots')
        const current = this.currentBotRecord(domain, sessionId)
        if (current === undefined) return
        const deliveredAt = new Date(claimedAt).toISOString()
        const routine = current.eventRoutines?.find(candidate => candidate.id === routineId)
        if (routine === undefined) return
        const pending = routine.deliveries.find(delivery => delivery.messageId === messageId && delivery.status === 'pending')
        if (pending === undefined) return
        const eventRoutines = (current.eventRoutines ?? []).map(candidate => candidate.id === routineId
          ? {
            ...candidate,
            deliveries: candidate.deliveries.map(delivery => delivery === pending
              ? { ...delivery, status: 'delivered' as const, deliveredAt }
              : delivery),
            updatedAt: Math.max(Date.now(), candidate.updatedAt),
          }
          : candidate)
        const next: BotRecord = { ...current, eventRoutines, updatedAt: Math.max(Date.now(), current.updatedAt) }
        await bots.put(next.id, next)
        this.recordsBySession.set(String(next.sessionId), next)
        this.emitChanged()
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(`bots: event routine delivery claim persistence failed: ${String(error)}`)
    }
  }

  /** Admit matching event routines and durably reserve their follow-up message ids. */
  private async triggerEventRoutines(
    sessionId: SessionId,
    input: EventRoutineTriggerInput,
  ): Promise<void> {
    try {
      await this.serialize(async () => {
        const domain = await this.getDomain()
        const bots = domain.table('bots')
        const current = this.currentBotRecord(domain, sessionId)
        if (current === undefined || current.sessionId !== sessionId) return
        let next = current
        for (const routine of current.eventRoutines ?? []) {
          if (routine.status !== 'active' || routine.trigger.source !== input.source) continue
          const existing = routine.deliveries.find(delivery => delivery.triggerMessageId === input.message.id
            || (delivery.triggerMessageId === undefined && delivery.triggerEventSeq === input.eventSeq))
          const chainId = input.relayContext?.chainId
            ?? createHash('sha256').update('bot-event-routine-chain\0').update(String(sessionId)).update('\0').update(String(input.message.id)).digest('hex')
          const depth = input.relayContext?.depth ?? 0
          const delivery = existing ?? {
            triggerEventSeq: input.eventSeq, triggerMessageId: MessageId(input.message.id), messageId: MessageId(randomUUID()),
            chainId, depth, status: 'pending' as const,
            createdAt: new Date(input.eventTime).toISOString(),
          }
          if (existing === undefined) {
            const updatedRoutine: BotEventRoutine = {
              ...routine,
              deliveries: [...routine.deliveries, delivery].slice(-MAX_ROUTINE_DELIVERIES),
              updatedAt: Math.max(Date.now(), routine.updatedAt),
            }
            next = {
              ...next,
              eventRoutines: (next.eventRoutines ?? []).map(candidate => candidate.id === routine.id ? updatedRoutine : candidate),
            }
            await bots.put(next.id, next)
            this.recordsBySession.set(String(next.sessionId), next)
          }
          const latest = next.eventRoutines?.find(candidate => candidate.id === routine.id)
          if (latest === undefined) continue
          const admitted = latest.deliveries.find(candidate => candidate.triggerMessageId === input.message.id
            || (candidate.triggerMessageId === undefined && candidate.triggerEventSeq === input.eventSeq))
          if (admitted === undefined || admitted.status === 'delivered') continue
          try {
            next = await this.deliverEventRoutine(next, latest, admitted, bots)
          } catch (error: unknown) {
            this.ctx.logger.warn(`bots: event routine ${routine.id} delivery failed: ${String(error)}`)
          }
        }
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(`bots: event routine dispatch failed: ${String(error)}`)
    }
  }

  /** Reconcile a pending event delivery after a Host restart or an uncertain flush. */
  private async deliverEventRoutine(
    record: BotRecord,
    routine: BotEventRoutine,
    delivery: BotEventRoutineDelivery,
    bots: KvTable<BotRecord['id'], BotRecord>,
  ): Promise<BotRecord> {
    const inspection = await this.ctx.sessionController.inspect(record.sessionId)
    const inboxState = botInboxMessageState(inspection.events, delivery.messageId)
    const canceled = inboxState?.disposition === 'canceled'
    const alreadyQueued = inspection.events.some(event => event.type === 'user/message' && event.data.id === delivery.messageId)
      || inboxState?.disposition === 'pending'
      || inboxState?.disposition === 'claimed'
    const attempt = canceled ? clearDispatchMarker(delivery) : delivery
    if (!alreadyQueued && !canceled && attempt.dispatchStartedAt !== undefined) {
      // The prior Host durably recorded Agent.followup before its Session receipt
      // became visible. Re-invoking it could run the same routine twice.
      return record
    }
    const resolved = await this.ctx.sessionController.resolveAgent(record.sessionId)
    if (!('agent' in resolved)) throw resolved.error
    let currentRecord = record
    let currentRoutine = routine
    let currentDelivery = attempt
    if (!alreadyQueued) {
      currentDelivery = { ...attempt, dispatchStartedAt: new Date(Date.now()).toISOString() }
      currentRoutine = {
        ...routine,
        deliveries: routine.deliveries.map(candidate => candidate.messageId === attempt.messageId ? currentDelivery : candidate),
        updatedAt: Math.max(Date.now(), routine.updatedAt),
      }
      currentRecord = {
        ...record,
        eventRoutines: (record.eventRoutines ?? []).map(candidate => candidate.id === routine.id ? currentRoutine : candidate),
        updatedAt: Math.max(Date.now(), record.updatedAt),
      }
      await bots.put(currentRecord.id, currentRecord)
      this.recordsBySession.set(String(currentRecord.sessionId), currentRecord)
      resolved.agent.followup(freezeMessage({
        id: currentDelivery.messageId,
        role: 'user',
        content: [{ type: 'text', text: `[BOT EVENT ROUTINE]\n${currentRoutine.prompt}` }],
        source: {
          kind: 'bot-event-routine', form: 'notice', summary: `Routine "${currentRoutine.title}" triggered`,
          routineId: currentRoutine.id, triggerEventSeq: currentDelivery.triggerEventSeq,
          ...(relayContextOf({ chainId: currentDelivery.chainId, depth: currentDelivery.depth }, `${String(currentRecord.sessionId)}:${String(currentDelivery.messageId)}`) ?? {}),
        },
      }))
    }
    // Even an already-admitted inbox message needs a fresh durability barrier:
    // the previous attempt may have observed the splice but lost its reply.
    if (!await this.ctx.sessions.flush(resolved.agent.session)) {
      throw new Error('Bot Session persistence did not acknowledge the event routine')
    }
    const afterFlush = await this.ctx.sessionController.inspect(record.sessionId)
    const afterInbox = botInboxMessageState(afterFlush.events, currentDelivery.messageId)
    const afterSurface = afterFlush.events.some(event => event.type === 'user/message' && event.data.id === currentDelivery.messageId)
    if (!afterSurface && afterInbox?.disposition === 'canceled') {
      const resetDelivery = clearDispatchMarker(currentDelivery)
      const resetRoutine: BotEventRoutine = {
        ...currentRoutine,
        deliveries: currentRoutine.deliveries.map(candidate => candidate.messageId === resetDelivery.messageId
          ? resetDelivery
          : candidate),
        updatedAt: Math.max(Date.now(), currentRoutine.updatedAt),
      }
      const resetRecord: BotRecord = {
        ...currentRecord,
        eventRoutines: (currentRecord.eventRoutines ?? []).map(candidate => candidate.id === resetRoutine.id
          ? resetRoutine
          : candidate),
        updatedAt: Math.max(Date.now(), currentRecord.updatedAt),
      }
      await bots.put(resetRecord.id, resetRecord)
      this.recordsBySession.set(String(resetRecord.sessionId), resetRecord)
      return resetRecord
    }
    if (!afterSurface && afterInbox?.disposition !== 'pending' && afterInbox?.disposition !== 'claimed') {
      // A successful flush without a durable receipt is still uncertain. Keep
      // the dispatch marker so recovery does not invoke the routine twice.
      return currentRecord
    }
    const deliveredAt = new Date(Date.now()).toISOString()
    const updatedRoutine: BotEventRoutine = {
      ...currentRoutine,
      deliveries: currentRoutine.deliveries.map(candidate => candidate.messageId === currentDelivery.messageId
        ? { ...candidate, status: 'delivered' as const, deliveredAt }
        : candidate),
      updatedAt: Math.max(Date.now(), currentRoutine.updatedAt),
    }
    const next: BotRecord = {
      ...currentRecord,
      eventRoutines: (currentRecord.eventRoutines ?? []).map(candidate => candidate.id === currentRoutine.id ? updatedRoutine : candidate),
      updatedAt: Math.max(Date.now(), currentRecord.updatedAt),
    }
    await bots.put(next.id, next)
    this.recordsBySession.set(String(next.sessionId), next)
    this.emitChanged()
    return next
  }

  /** Persist one completed model result without changing delivery semantics. */
  private async recordEventRoutineResults(
    sessionId: SessionId,
    turn: EventRoutineTurn | undefined,
    event: SessionEvent<'turn/end'>,
    persistedTurn?: EventRoutineTurn,
  ): Promise<void> {
    try {
      const attributedTurn = persistedTurn ?? routineTurnFromEvents(
        (await this.ctx.sessionController.inspect(sessionId)).events,
        event.data.turn,
        turn,
      )
      await this.serialize(async () => {
        const domain = await this.getDomain()
        const bots = domain.table('bots')
        const current = this.currentBotRecord(domain, sessionId)
        if (current === undefined) return
        const output = attributedTurn.output.join('').slice(0, MAX_ROUTINE_RESULT_OUTPUT)
        const status = routineResultStatus(event.data.reason.kind)
        const error = event.data.reason.kind === 'error' ? event.data.reason.error.message.slice(0, 4_000) : undefined
        let changedCount = 0
        const eventRoutines = (current.eventRoutines ?? []).map((routine) => {
          const messages = [...attributedTurn.runs.entries()].filter(([, routineId]) => routineId === routine.id)
          if (messages.length === 0) return routine
          const results = [...routine.results]
          let routineChanged = false
          for (const [messageId] of messages) {
            if (results.some(result => String(result.messageId) === messageId)) continue
            const result: BotEventRoutineResult = {
              messageId: MessageId(messageId), status, completedAt: new Date(event.time).toISOString(),
              ...(output === '' ? {} : { output }), ...(error === undefined ? {} : { error }),
            }
            results.push(result)
            routineChanged = true
            changedCount += 1
          }
          return routineChanged
            ? { ...routine, results: results.slice(-MAX_ROUTINE_RESULTS), updatedAt: Math.max(Date.now(), routine.updatedAt) }
            : routine
        })
        if (changedCount === 0) return
        const next: BotRecord = { ...current, eventRoutines, updatedAt: Math.max(Date.now(), current.updatedAt) }
        await bots.put(next.id, next)
        this.recordsBySession.set(String(next.sessionId), next)
        this.emitChanged()
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(`bots: event routine result persistence failed: ${String(error)}`)
    }
  }

  /** Retry deliveries reserved before a Host restart. */
  private async recoverPendingEventRoutines(): Promise<void> {
    await this.serialize(async () => {
      const domain = await this.getDomain()
      const bots = domain.table('bots')
      for (const [, record] of bots.entries()) {
        let current = record
        for (const routine of record.eventRoutines ?? []) {
          if (routine.status !== 'active') continue
          for (const delivery of routine.deliveries.filter(candidate => candidate.status === 'pending')) {
            try {
              const latest = current.eventRoutines?.find(candidate => candidate.id === routine.id)
              if (latest === undefined) continue
              const retry = latest.deliveries.find(candidate => candidate.messageId === delivery.messageId)
              if (retry === undefined || retry.status !== 'pending') continue
              current = await this.deliverEventRoutine(current, latest, retry, bots)
            } catch (error: unknown) {
              this.ctx.logger.warn(`bots: pending event routine ${routine.id} recovery failed: ${String(error)}`)
            }
          }
        }
      }
    })
  }

  /** Retry pending deliveries after an explicit resume starts a new attempt. */
  private async retryPendingEventRoutines(sessionId: SessionId, routineId: string, explicitRetry: boolean): Promise<void> {
    await this.serialize(async () => {
      const domain = await this.getDomain()
      const bots = domain.table('bots')
      const record = this.currentBotRecord(domain, sessionId)
      const routine = record?.eventRoutines?.find(candidate => candidate.id === routineId)
      if (record === undefined || routine === undefined || routine.status !== 'active') return
      let current = record
      if (explicitRetry) {
        const resetDeliveries = routine.deliveries.map((delivery) => {
          if (delivery.status !== 'pending' || delivery.dispatchStartedAt === undefined) return delivery
          return clearDispatchMarker(delivery)
        })
        if (resetDeliveries.some((delivery, index) => delivery !== routine.deliveries[index])) {
          const resetRoutine = { ...routine, deliveries: resetDeliveries, updatedAt: Math.max(Date.now(), routine.updatedAt) }
          current = {
            ...record,
            eventRoutines: (record.eventRoutines ?? []).map(candidate => candidate.id === routineId ? resetRoutine : candidate),
            updatedAt: Math.max(Date.now(), record.updatedAt),
          }
          await bots.put(current.id, current)
          this.recordsBySession.set(String(current.sessionId), current)
        }
      }
      for (const delivery of routine.deliveries.filter(candidate => candidate.status === 'pending')) {
        try {
          const latest = current.eventRoutines?.find(candidate => candidate.id === routineId)
          if (latest === undefined || latest.status !== 'active') continue
          const retry = latest.deliveries.find(candidate => candidate.messageId === delivery.messageId)
          if (retry === undefined || retry.status !== 'pending') continue
          current = await this.deliverEventRoutine(current, latest, retry, bots)
        } catch (error: unknown) {
          this.ctx.logger.warn(`bots: pending event routine ${routineId} retry failed: ${String(error)}`)
        }
      }
    })
  }

  /** Recover completed routine turns whose result write was interrupted by a restart. */
  private async recoverEventRoutineResults(): Promise<void> {
    const domain = await this.getDomain()
    for (const [, record] of domain.table('bots').entries()) {
      if ((record.eventRoutines ?? []).length === 0) continue
      try {
        const inspection = await this.ctx.sessionController.inspect(record.sessionId)
        const turns = routineTurnsFromEvents(inspection.events)
        for (const event of inspection.events) {
          if (event.type !== 'turn/end') continue
          const turn = turns.get(event.data.turn)
          if (turn === undefined || turn.runs.size === 0) continue
          await this.recordEventRoutineResults(record.sessionId, turn, event, turn)
        }
      } catch (error: unknown) {
        this.ctx.logger.warn(`bots: event routine result recovery failed for ${record.id}: ${String(error)}`)
      }
    }
  }

  private updateBotDescription(botId: BotId, description: string, signal?: AbortSignal): Promise<void> {
    return this.serialize(async () => {
      const bots = (await this.getDomain()).table('bots')
      const current = bots.get(botId)
      if (current === undefined) throw new RemoteError('bot/not-found', `Bot "${botId}" was not found`, { botId })
      const next = { ...current, description, updatedAt: Math.max(Date.now(), current.updatedAt) }
      signal?.throwIfAborted()
      await bots.put(botId, next)
      this.recordsBySession.set(String(next.sessionId), next)
      this.emitChanged()
    })
  }

  /**
   * List the durable Bot roster without activating cold Sessions.
   * @param _request - Empty list request reserved for future paging.
   * @returns one row per Bot, ordered by creation time and id.
   */
  @Remote('list')
  async list(_request: BotListRequest): Promise<BotListValue> {
    const bots = (await this.getDomain()).table('bots')
    return {
      bots: [...bots.entries()]
        .map(([, record]) => this.view(record))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    }
  }

  /**
   * Create one durable Bot and its exactly-one ordinary Session.
   *
   * A provisioning row is committed before Session creation. If Session creation
   * or activation cannot finish, the row remains visible and the same Bot id can
   * be retried safely; no second Session is allocated for that Bot.
   *
   * @param request - Name, visual identity, optional working directory, and preset.
   * @returns the active row or a retryable provisioning row.
   */
  @Remote('create')
  async create(request: BotCreateRequest): Promise<BotCreateValue> {
    return this.createImpl(request)
  }

  private async createImpl(request: BotCreateRequest, signal?: AbortSignal): Promise<BotCreateValue> {
    return this.serialize(async () => {
      const normalized = normalizeCreate(request)
      const bots = (await this.getDomain()).table('bots')
      signal?.throwIfAborted()
      const id = normalized.id ?? BotId(`bot-${randomUUID()}`)
      const existing = bots.get(id)
      if (existing !== undefined) {
        if (existing.state === 'active' && matchesMetadata(existing, normalized)) {
          return { bot: this.view(existing) }
        }
        if (existing.state !== 'provisioning') {
          throw new RemoteError('bot/id-conflict', `Bot "${id}" already exists`, { botId: id })
        }
        if (!matchesMetadata(existing, normalized)) {
          throw new RemoteError(
            'bot/provisioning-conflict',
            `Bot "${id}" is provisioning with different metadata`,
            { botId: id },
          )
        }
        const active = await this.provision(existing, bots)
        return { bot: this.view(active) }
      }

      const now = Date.now()
      // Keep the Session id independent from a caller-supplied Bot id. A Bot
      // id is user-facing and must never accidentally adopt an unrelated
      // ordinary Session with a matching derived name.
      const sessionId = SessionId(`bot-session-${randomUUID()}`)
      const record: BotRecord = {
        id,
        sessionId,
        name: normalized.name,
        ...(normalized.description === undefined ? {} : { description: normalized.description }),
        identity: normalized.identity,
        accent: normalized.accent,
        cwd: normalized.cwd,
        ...(normalized.agentPreset === undefined ? {} : { agentPreset: normalized.agentPreset }),
        state: 'provisioning',
        createdAt: now,
        updatedAt: now,
      }
      await bots.put(id, record)
      this.recordsBySession.set(String(record.sessionId), record)
      this.emitChanged()
      const active = await this.provision(record, bots)
      return { bot: this.view(active) }
    })
  }

  /**
   * Rename one Bot while preserving its one Session mapping and visual identity.
   * @param request - Bot id and new display name.
   * @returns the committed row.
   */
  @Remote('rename')
  async rename(request: BotRenameRequest): Promise<BotRenameValue> {
    return this.renameImpl(request)
  }

  private async renameImpl(request: BotRenameRequest, signal?: AbortSignal): Promise<BotRenameValue> {
    return this.serialize(async () => {
      const id = normalizeBotId(request.botId)
      if (id === undefined) return badRequest('Bot id is required')
      const name = normalizeName(request.name)
      const bots = (await this.getDomain()).table('bots')
      const current = bots.get(id)
      if (current === undefined) {
        throw new RemoteError('bot/not-found', `Bot "${id}" was not found`, { botId: id })
      }
      const next: BotRecord = { ...current, name, updatedAt: Math.max(Date.now(), current.updatedAt) }
      signal?.throwIfAborted()
      await bots.put(id, next)
      this.recordsBySession.set(String(next.sessionId), next)
      this.emitChanged()
      return { bot: this.view(next) }
    })
  }

  /**
   * Update a Bot's semantic identity and/or accent without creating or changing
   * its one backing Session. Generated avatars remain selected unless the
   * caller explicitly sets `clearAvatar` to true.
   * @param request - Bot id, optional appearance fields, and optional avatar clear.
   * @returns the committed row.
   */
  @Remote('updateAppearance')
  async updateAppearance(request: BotAppearanceUpdateRequest): Promise<BotAppearanceUpdateValue> {
    return this.updateAppearanceImpl(request)
  }

  private async updateAppearanceImpl(request: BotAppearanceUpdateRequest, signal?: AbortSignal): Promise<BotAppearanceUpdateValue> {
    return this.serialize(async () => {
      if (request === null || typeof request !== 'object') return badRequest('Bot appearance request must be an object')
      const id = normalizeBotId(request.botId)
      if (id === undefined) return badRequest('Bot id is required')
      const identity = normalizeAppearanceIdentity(request.identity)
      const accent = normalizeAppearanceAccent(request.accent)
      const clearAvatar = normalizeClearAvatar(request.clearAvatar)
      if (identity === undefined && accent === undefined && !clearAvatar) {
        return badRequest('Bot appearance request must change identity or accent, or clear its avatar')
      }

      const bots = (await this.getDomain()).table('bots')
      const current = bots.get(id)
      if (current === undefined) {
        throw new RemoteError('bot/not-found', `Bot "${id}" was not found`, { botId: id })
      }
      const updatedAt = Math.max(Date.now(), current.updatedAt)
      const withAppearance: BotRecord = {
        ...current,
        ...(identity === undefined ? {} : { identity }),
        ...(accent === undefined ? {} : { accent }),
        updatedAt,
      }
      let next: BotRecord
      if (clearAvatar) {
        const { avatar: ignoredAvatar, ...withoutAvatar } = withAppearance
        void ignoredAvatar
        next = withoutAvatar
      } else {
        next = withAppearance
      }
      signal?.throwIfAborted()
      await bots.put(id, next)
      this.emitChanged()
      return { bot: this.view(next) }
    })
  }

  /**
   * Persist or clear a generated avatar while preserving the Bot's Session mapping.
   * @param request - Bot id and generated avatar payload, or null to clear it.
   * @returns the updated Bot row.
   */
  @Remote('updateAvatar')
  async updateAvatar(request: BotAvatarUpdateRequest): Promise<BotAvatarUpdateValue> {
    return this.updateAvatarImpl(request)
  }

  private async updateAvatarImpl(request: BotAvatarUpdateRequest, signal?: AbortSignal): Promise<BotAvatarUpdateValue> {
    return this.serialize(async () => {
      if (request === null || typeof request !== 'object') return badRequest('Bot avatar request must be an object')
      const id = normalizeBotId(request.botId)
      if (id === undefined) return badRequest('Bot id is required')
      const bots = (await this.getDomain()).table('bots')
      const current = bots.get(id)
      if (current === undefined) {
        throw new RemoteError('bot/not-found', `Bot "${id}" was not found`, { botId: id })
      }
      const avatar = request.avatar === null ? undefined : await this.admitAvatar(id, request.avatar)
      const updatedAt = Math.max(Date.now(), current.updatedAt)
      let next: BotRecord
      if (request.avatar === null) {
        const { avatar: ignoredAvatar, ...withoutAvatar } = current
        void ignoredAvatar
        next = { ...withoutAvatar, updatedAt }
      } else {
        next = { ...current, avatar, updatedAt }
      }
      signal?.throwIfAborted()
      await bots.put(id, next)
      this.emitChanged()
      return { bot: this.view(next) }
    })
  }

  /**
   * Read the current Bot avatar through the Host attachment store.
   * @param request - Bot id whose selected avatar should be returned.
   * @returns canonical reference and bytes for a Client preview.
   */
  @Remote('readAvatar')
  async readAvatar(request: BotAvatarReadRequest): Promise<BotAvatarReadValue> {
    return this.serialize(async () => {
      if (request === null || typeof request !== 'object') return badRequest('Bot avatar request must be an object')
      const id = normalizeBotId(request.botId)
      if (id === undefined) return badRequest('Bot id is required')
      const bots = (await this.getDomain()).table('bots')
      const current = bots.get(id)
      if (current === undefined) {
        throw new RemoteError('bot/not-found', `Bot "${id}" was not found`, { botId: id })
      }
      if (current.avatar === undefined) {
        throw new RemoteError('bot/avatar-missing', `Bot "${id}" has no generated avatar`, { botId: id })
      }
      try {
        const stored = await this.ctx.attachments.readImage(current.avatar)
        const canonical = imageAttachmentRefSchema.safeParse(stored.ref)
        if (!canonical.success
          || String(canonical.data.attachmentId) !== String(current.avatar.attachmentId)
          || canonical.data.mediaType !== current.avatar.mediaType
          || canonical.data.bytes !== current.avatar.bytes
          || canonical.data.width !== current.avatar.width
          || canonical.data.height !== current.avatar.height) {
          throw new Error('Attachment storage returned a different image reference')
        }
        return { avatar: canonical.data, data: Buffer.from(stored.data).toString('base64') }
      } catch (error: unknown) {
        throw new RemoteError(
          'bot/avatar-invalid',
          `Bot "${id}" avatar could not be read from attachment storage`,
          { botId: id, reason: 'unreadable' },
          { cause: error },
        )
      }
    })
  }

  private async admitAvatar(botId: BotRecord['id'], candidate: ImageAttachmentRef): Promise<ImageAttachmentRef> {
    const parsed = imageAttachmentRefSchema.safeParse(candidate)
    if (!parsed.success) {
      throw new RemoteError(
        'bot/avatar-invalid',
        `Bot "${botId}" supplied an invalid avatar reference`,
        { botId, reason: 'invalid-reference' },
      )
    }
    try {
      const stored = await this.ctx.attachments.readImage(parsed.data)
      const canonical = imageAttachmentRefSchema.safeParse(stored.ref)
      if (!canonical.success
        || String(canonical.data.attachmentId) !== String(parsed.data.attachmentId)
        || canonical.data.mediaType !== parsed.data.mediaType
        || canonical.data.bytes !== parsed.data.bytes
        || canonical.data.width !== parsed.data.width
        || canonical.data.height !== parsed.data.height) {
        throw new Error('Attachment storage returned a different image reference')
      }
      return canonical.data
    } catch (error: unknown) {
      throw new RemoteError(
        'bot/avatar-invalid',
        `Bot "${botId}" avatar could not be read from attachment storage`,
        { botId, reason: 'unreadable' },
        { cause: error },
      )
    }
  }

  private async provision(
    record: BotRecord,
    bots: KvTable<BotRecord['id'], BotRecord>,
  ): Promise<BotRecord> {
    try {
      const created = await this.ctx.sessionController.create(sessionRequest(record))
      if (created.sessionId !== record.sessionId) {
        throw new Error(`Session controller returned "${created.sessionId}" for "${record.sessionId}"`)
      }
    } catch (error: unknown) {
      const detail = remoteErrorOf(error)
      const message = detail === undefined ? String(error) : detail.message
      throw new RemoteError(
        'bot/provisioning-failed',
        `Bot "${record.id}" could not create its Session: ${message}`,
        { botId: record.id, sessionId: record.sessionId },
        { cause: error },
      )
    }
    const active: BotRecord = {
      ...record,
      state: 'active',
      updatedAt: Math.max(Date.now(), record.updatedAt),
    }
    try {
      await bots.put(record.id, active)
    } catch (error: unknown) {
      throw new RemoteError(
        'bot/provisioning-failed',
        `Bot "${record.id}" Session was created but roster activation was not saved`,
        { botId: record.id, sessionId: record.sessionId },
        { cause: error },
      )
    }
    this.recordsBySession.set(String(active.sessionId), active)
    this.emitChanged()
    return active
  }

  /** Install the Bot identity in the Agent scope before its first model turn. */
  private async installPrompt(agent: Agent): Promise<void> {
    await this.ready
    if (this.recordsBySession.get(String(agent.id)) === undefined) return
    const existing = this.promptFibers.get(agent)
    if (existing !== undefined) {
      await existing
      return
    }
    const fiber = agent.ctx.inject(['systemPrompt', 'tools'], (scope) => {
      scope.systemPrompt.section({
        name: BOT_IDENTITY_SECTION,
        order: scope.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1,
        text: () => {
          const record = this.recordsBySession.get(String(agent.id))
          return record === undefined ? '' : botIdentityPrompt(record)
        },
        // Bot names and descriptions are user-authored prose, not variables.
        interpolate: false,
      })
      installBotCollaborationTools(scope, () => this.collaborationFor(agent), this.manageBots)
      // Scheduling is optional in minimal compositions. When present, the
      // injection registers the seven Host Schedule tools and Bot-specific
      // message-triggered routine tools in this Bot scope.
      const eventRoutineHost: BotEventRoutineToolHost = {
        run: (action, args, exec) => this.runScopedRoutine(action, args, exec),
      }
      installBotRoutineTools(scope, eventRoutineHost)
    })
    this.promptFibers.set(agent, fiber)
    await fiber
  }

  /** Release one Agent's scoped identity registration after its lifecycle ends. */
  private disposePrompt(agent: Agent): void {
    const fiber = this.promptFibers.get(agent)
    if (fiber === undefined) return
    this.promptFibers.delete(agent)
    const task = fiber.dispose().catch((error: unknown) => {
      this.ctx.logger.warn(`bots: prompt cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    this.promptDisposals.add(task)
    void task.finally(() => { this.promptDisposals.delete(task) })
  }

  private view(record: BotRecord): BotView {
    const agent = this.ctx.agents.get(record.sessionId)
    const availability: BotAvailability = agent === undefined
      ? 'offline'
      : agent.status === 'running' ? 'running' : 'idle'
    const { eventRoutines, ...roster } = record
    void eventRoutines
    return { ...roster, availability }
  }

  private async getDomain(): Promise<Domain<typeof botDomain>> {
    await this.initialized
    return this.ready
  }

  private emitChanged(): void {
    try {
      this.ctx.emit('bots/changed')
    } catch (error: unknown) {
      this.ctx.logger.warn(`bots: roster change listener failed: ${String(error)}`)
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('Bot service is stopping'))
    const pending = this.chain.then(work)
    this.chain = pending.catch(() => undefined)
    return pending
  }
}

export default BotService
