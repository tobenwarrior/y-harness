/** V6 validation for the durable source fields used by event routines. */

import { SessionFormatError, isSessionFormatJsonObject } from '@yharness/session-format'
import type { SessionFormatEvent } from '@yharness/session-format'

const BOT_EVENT_ROUTINE_ID_PATTERN = /^bot-event-routine-[A-Za-z0-9][A-Za-z0-9-]*$/u
const MAX_BOT_EVENT_ROUTINE_ID_LENGTH = 256
const MAX_BOT_EVENT_ROUTINE_CHAIN_ID_LENGTH = 256
const MAX_BOT_EVENT_ROUTINE_HOPS = 4
const MAX_BOT_EVENT_ROUTINE_TITLE_LENGTH = 120
const BOT_EVENT_ROUTINE_SUMMARY_OVERHEAD = 'Routine "" triggered'.length
const MAX_BOT_EVENT_ROUTINE_SUMMARY_LENGTH =
  BOT_EVENT_ROUTINE_SUMMARY_OVERHEAD + MAX_BOT_EVENT_ROUTINE_TITLE_LENGTH

function nonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SessionFormatError(`format v6 bot-event-routine source requires a non-negative ${label}`)
  }
}

function boundedNonEmptyString(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new SessionFormatError(`format v6 bot-event-routine source requires a non-empty ${label} of at most ${maximum} characters`)
  }
}

function chainId(value: unknown, label: string): void {
  if (typeof value !== 'string') {
    throw new SessionFormatError(`format v6 bot-event-routine source ${label} must be a string`)
  }
  boundedNonEmptyString(value, label, MAX_BOT_EVENT_ROUTINE_CHAIN_ID_LENGTH)
  if (value.trim().length === 0) {
    throw new SessionFormatError(`format v6 bot-event-routine source requires a non-blank ${label}`)
  }
}

function assertBotEventRoutineSource(value: unknown): void {
  if (!isSessionFormatJsonObject(value) || value['kind'] !== 'bot-event-routine') return
  if (value['form'] !== 'notice' || typeof value['summary'] !== 'string'
    || typeof value['routineId'] !== 'string') {
    throw new SessionFormatError('format v6 bot-event-routine source requires notice, summary, and routineId fields')
  }
  const summary = value['summary']
  boundedNonEmptyString(summary, 'summary', MAX_BOT_EVENT_ROUTINE_SUMMARY_LENGTH)
  if (summary.trim() !== summary) {
    throw new SessionFormatError('format v6 bot-event-routine source summary must not have surrounding whitespace')
  }
  const routineId = value['routineId']
  if (!BOT_EVENT_ROUTINE_ID_PATTERN.test(routineId)
    || routineId.length > MAX_BOT_EVENT_ROUTINE_ID_LENGTH) {
    throw new SessionFormatError('format v6 bot-event-routine source routineId is invalid')
  }
  nonNegativeInteger(value['triggerEventSeq'], 'triggerEventSeq')
  if (value['chainId'] !== undefined) chainId(value['chainId'], 'chainId')
  if (value['depth'] !== undefined) {
    const depth = value['depth']
    nonNegativeInteger(depth, 'depth')
    if (depth > MAX_BOT_EVENT_ROUTINE_HOPS) {
      throw new SessionFormatError(`format v6 bot-event-routine source depth must be at most ${MAX_BOT_EVENT_ROUTINE_HOPS}`)
    }
  }
}

function assertAgentRelayContext(value: unknown): void {
  if (!isSessionFormatJsonObject(value) || value['kind'] !== 'agent-message') return
  const relay = value['botEventRoutine']
  if (relay === undefined) return
  if (!isSessionFormatJsonObject(relay) || typeof relay['chainId'] !== 'string') {
    throw new SessionFormatError('format v6 agent-message botEventRoutine requires a string chainId')
  }
  chainId(relay['chainId'], 'agent-message botEventRoutine chainId')
  const depth = relay['depth']
  nonNegativeInteger(depth, 'agent-message botEventRoutine depth')
  if (depth > MAX_BOT_EVENT_ROUTINE_HOPS) {
    throw new SessionFormatError(`format v6 agent-message botEventRoutine depth must be at most ${MAX_BOT_EVENT_ROUTINE_HOPS}`)
  }
}

function assertMessageSource(value: unknown): void {
  assertBotEventRoutineSource(value)
  assertAgentRelayContext(value)
}

function visitMessageSources(event: SessionFormatEvent): void {
  const data = event.data
  if (!isSessionFormatJsonObject(data)) return
  if (event.type === 'user/message') {
    assertMessageSource(data['source'])
    return
  }
  if (event.type === 'developer/message' || event.type === 'system/message'
    || event.type === 'assistant/message' || event.type === 'tool/result') {
    const message = data['message']
    if (isSessionFormatJsonObject(message)) assertMessageSource(message['source'])
    return
  }
  const messages = event.type === 'agent/inbox/spliced' ? data['inserted']
    : event.type === 'session/title-llm-request' || event.type === 'skill/learning-request' ? data['messages']
      : undefined
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (isSessionFormatJsonObject(message)) assertMessageSource(message['source'])
  }
}

/** Validate V6 fields in every declared message slot of a complete event.
 * @param event - complete event whose declared message slots are inspected.
 */
export function assertV6MessageSources(event: SessionFormatEvent): void {
  visitMessageSources(event)
}

/** Validate V6 source fields in complete message objects before row recovery.
 * @param row - parsed physical row before ordinary decoder validation.
 */
export function assertV6SourceRowAdmission(row: unknown): void {
  if (!isSessionFormatJsonObject(row)) return
  const data = row['data']
  if (!isSessionFormatJsonObject(data)) return
  const messages = row['type'] === 'user/message' ? [data]
    : row['type'] === 'developer/message' || row['type'] === 'system/message'
      || row['type'] === 'assistant/message' || row['type'] === 'tool/result' ? [data['message']]
      : row['type'] === 'agent/inbox/spliced' ? data['inserted']
        : row['type'] === 'session/title-llm-request' || row['type'] === 'skill/learning-request' ? data['messages'] : []
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (isSessionFormatJsonObject(message)) assertMessageSource(message['source'])
  }
}
