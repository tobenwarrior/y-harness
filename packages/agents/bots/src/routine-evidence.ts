/** Owner-facing evidence from scheduled deliveries and recorded Bot turns. */
import type { MessageId } from '@yharness/llm/brand'
import type { UserMessage } from '@yharness/llm'
import type { SessionEvent } from '@yharness/session'
import type { SkillLearningNativeItem } from '@yharness/skill-library/types'
import type {} from '@yharness/skill-library'
import type {} from '@yharness/schedule'
import type { BotDynamicToolEvent } from './collaboration.ts'
import type { BotRoutineExecutionEvidence, BotRoutineExecutionCounts } from './types.ts'

const SYNTHETIC_CONTEXT_SOURCES: ReadonlySet<string> = new Set([
  'runtime-context',
  'agent-instructions',
  'skill-catalog',
  'model-selection',
  'goal',
  'plan-mode',
  'time-context',
  'tmux-context',
  'repeat-tool-reminder',
  'tool-jobs',
  'tool-goal',
])

const SYNTHETIC_CONTEXT_FORMS: ReadonlySet<string> = new Set([
  'instructions',
  'catalog',
  'snapshot',
  'recall',
])

type NativeOutcome = 'success' | 'failure' | 'unknown' | 'conflicting'
type EndStatus = NonNullable<BotRoutineExecutionEvidence['turnStatus']>

interface TurnEvidence {
  readonly turn: number
  readonly targetMatches: Map<MessageId, number>
  readonly nativeOutcomes: Map<string, NativeOutcome>
  independentMessages: number
  attributionUncertain: boolean
  ordinaryCalls: number
  ordinarySucceeded: number
  ordinaryFailed: number
  end?: { status: EndStatus; time: number }
}

function counts(turn: TurnEvidence): BotRoutineExecutionCounts {
  let succeeded = 0
  let failed = 0
  for (const outcome of turn.nativeOutcomes.values()) {
    if (outcome === 'success') succeeded += 1
    if (outcome === 'failure') failed += 1
  }
  return {
    nativeActions: { settled: turn.nativeOutcomes.size, succeeded, failed },
    ordinaryTools: {
      calls: turn.ordinaryCalls,
      succeeded: turn.ordinarySucceeded,
      failed: turn.ordinaryFailed,
    },
  }
}

function turnStatus(kind: string): EndStatus {
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

function isSyntheticContext(message: UserMessage): boolean {
  if (SYNTHETIC_CONTEXT_SOURCES.has(message.source.kind)) return true
  return 'form' in message.source && SYNTHETIC_CONTEXT_FORMS.has(message.source.form)
}

function newTurn(turn: number): TurnEvidence {
  return {
    turn,
    targetMatches: new Map(),
    independentMessages: 0,
    attributionUncertain: false,
    ordinaryCalls: 0,
    ordinarySucceeded: 0,
    ordinaryFailed: 0,
    nativeOutcomes: new Map(),
  }
}

function recordNativeOutcome(turn: TurnEvidence, key: string, outcome: Exclude<NativeOutcome, 'conflicting'>): void {
  const prior = turn.nativeOutcomes.get(key)
  if (prior === undefined || prior === 'unknown') {
    turn.nativeOutcomes.set(key, outcome)
  } else if (outcome !== 'unknown' && prior !== outcome) {
    turn.nativeOutcomes.set(key, 'conflicting')
  }
}

function addNativeEvent(turn: TurnEvidence, event: BotDynamicToolEvent): void {
  if (event.phase !== 'settled') return
  // Use the native thread, turn, and call identities shared with skill/native-item.
  const key = [event.threadId, event.turnId, event.callId].join('\0')
  const success = event.result?.success
  recordNativeOutcome(turn, key, success === true ? 'success' : success === false ? 'failure' : 'unknown')
}

function addNativeItem(turn: TurnEvidence, item: SkillLearningNativeItem): void {
  if (item.phase !== 'settled') return
  const nativeTurnId = item.provider === 'codex' ? item.turnId : item.sendId
  const key = [item.sessionId, nativeTurnId, item.itemId].join('\0')
  const outcome = item.outcome
  recordNativeOutcome(turn, key, outcome === 'reported-success' ? 'success' : outcome === 'reported-error' ? 'failure' : 'unknown')
}

function recordAction(turn: TurnEvidence, event: SessionEvent): void {
  switch (event.type) {
    case 'tool/call':
    case 'tool/result': {
      if (event.data.turn !== turn.turn) return
      if (turn.targetMatches.size === 0) {
        turn.attributionUncertain = true
      } else if (event.type === 'tool/call') {
        turn.ordinaryCalls += 1
      } else if (event.data.message.isError) {
        turn.ordinaryFailed += 1
      } else {
        turn.ordinarySucceeded += 1
      }
      return
    }
    case 'bot/dynamic-tool':
    case 'skill/native-item': {
      if (event.data.phase === 'invalidated' || turn.targetMatches.size === 0) {
        turn.attributionUncertain = true
      } else if (event.type === 'bot/dynamic-tool') {
        addNativeEvent(turn, event.data)
      } else {
        addNativeItem(turn, event.data)
      }
      return
    }
    default:
      // Other producers in the extensible Session event map carry no action evidence.
      return
  }
}

function evidenceStatus(turn: TurnEvidence, targetMatches: number): BotRoutineExecutionEvidence['status'] {
  if (targetMatches !== 1 || turn.independentMessages !== targetMatches || turn.attributionUncertain) return 'ambiguous'
  if (turn.end === undefined) return 'started'
  if (turn.end.status !== 'completed') return 'ambiguous'
  const usedTool = turn.nativeOutcomes.size > 0 || turn.ordinaryCalls > 0 || turn.ordinarySucceeded > 0 || turn.ordinaryFailed > 0
  return usedTool ? 'completed-with-tool-use' : 'completed-no-tool-use'
}

function retainTurn(evidence: Map<string, BotRoutineExecutionEvidence>, turn: TurnEvidence): void {
  if (turn.targetMatches.size === 0) return
  const toolCounts = counts(turn)
  for (const [messageId, matches] of turn.targetMatches) {
    const key = String(messageId)
    const previous = evidence.get(key)
    if (previous !== undefined) {
      evidence.set(key, { ...previous, status: 'ambiguous' })
      continue
    }
    evidence.set(key, {
      messageId,
      status: evidenceStatus(turn, matches),
      turn: turn.turn,
      ...(turn.end === undefined ? {} : { turnStatus: turn.end.status, completedAt: new Date(turn.end.time).toISOString() }),
      ...toolCounts,
    })
  }
}

function emptyEvidence(messageId: MessageId, status: 'delivery-only' | 'unavailable'): BotRoutineExecutionEvidence {
  return {
    messageId,
    status,
    nativeActions: { settled: 0, succeeded: 0, failed: 0 },
    ordinaryTools: { calls: 0, succeeded: 0, failed: 0 },
  }
}

/**
 * Correlate one delivery page with the persisted Session in one traversal.
 * Only evidence for requested deliveries is retained. Earlier work in a turn
 * cannot be attributed to a scheduled message that arrives later.
 * @param events - Persisted events from the Bot Session.
 * @param messageIds - Delivery identities retained by the Schedule page.
 * @returns Evidence keyed by the string form of each requested delivery identity.
 */
export function routineExecutionEvidenceForMessages(
  events: readonly SessionEvent[],
  messageIds: readonly MessageId[],
): ReadonlyMap<string, BotRoutineExecutionEvidence> {
  const targets = new Set(messageIds)
  const evidence = new Map<string, BotRoutineExecutionEvidence>()
  if (targets.size === 0) return evidence

  let current: TurnEvidence | undefined
  const targetsOutsideTurn = new Set<MessageId>()
  for (const event of events) {
    if (event.type === 'turn/start') {
      if (current !== undefined) retainTurn(evidence, current)
      current = newTurn(event.data.turn)
      continue
    }
    if (event.type === 'turn/end') {
      if (current?.turn !== event.data.turn) continue
      current.end = { status: turnStatus(event.data.reason.kind), time: event.time }
      retainTurn(evidence, current)
      current = undefined
      continue
    }
    if (event.type === 'user/message') {
      const message = event.data
      const sourceKind: string = message.source.kind
      const matches = sourceKind === 'schedule' && targets.has(message.id)
      if (current === undefined) {
        if (matches) targetsOutsideTurn.add(message.id)
      } else {
        if (matches) current.targetMatches.set(message.id, (current.targetMatches.get(message.id) ?? 0) + 1)
        if (!isSyntheticContext(message)) current.independentMessages += 1
      }
      continue
    }
    if (current !== undefined) recordAction(current, event)
  }
  if (current !== undefined) retainTurn(evidence, current)

  for (const messageId of targets) {
    const key = String(messageId)
    const observed = evidence.get(key)
    const outside = targetsOutsideTurn.has(messageId)
    if (observed === undefined) evidence.set(key, emptyEvidence(messageId, outside ? 'unavailable' : 'delivery-only'))
    else if (outside) evidence.set(key, { ...observed, status: 'ambiguous' })
  }
  return evidence
}

/**
 * Create the redacted result used when a bounded Session inspection cannot be
 * completed. The failure does not expose the underlying inspection error.
 * @param messageId - Delivery identity retained by the Schedule record.
 * @returns An unavailable evidence result with zeroed work counts.
 */
export function unavailableRoutineExecutionEvidence(messageId: MessageId): BotRoutineExecutionEvidence {
  return emptyEvidence(messageId, 'unavailable')
}
