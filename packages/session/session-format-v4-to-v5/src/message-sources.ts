/** V5 validation for the durable source fields used by Bot group delivery. */

import { SessionFormatError, isSessionFormatJsonObject } from '@yharness/session-format'
import type { SessionFormatEvent } from '@yharness/session-format'

function assertBotGroupMessageSource(value: unknown): void {
  if (!isSessionFormatJsonObject(value) || value['kind'] !== 'bot-group-message') return
  if (typeof value['groupId'] !== 'string' || typeof value['messageId'] !== 'string') {
    throw new SessionFormatError('format v5 bot-group-message source requires string groupId and messageId')
  }
}

/** Visit the declared message slots without interpreting arbitrary event payloads. */
function visitMessageSources(event: SessionFormatEvent): void {
  const data = event.data
  if (!isSessionFormatJsonObject(data)) return
  if (event.type === 'user/message') {
    assertBotGroupMessageSource(data['source'])
    return
  }
  if (event.type === 'developer/message' || event.type === 'system/message'
    || event.type === 'assistant/message' || event.type === 'tool/result') {
    const message = data['message']
    if (isSessionFormatJsonObject(message)) assertBotGroupMessageSource(message['source'])
    return
  }
  const messages = event.type === 'agent/inbox/spliced' ? data['inserted']
    : event.type === 'session/title-llm-request' ? data['messages'] : undefined
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (isSessionFormatJsonObject(message)) assertBotGroupMessageSource(message['source'])
  }
}

/** Validate V5 fields in every declared message slot of a complete event.
 * @param event - complete event whose declared message slots are inspected.
 */
export function assertV5MessageSources(event: SessionFormatEvent): void {
  visitMessageSources(event)
}

/** Validate V5 source fields in complete message objects without classifying incomplete rows.
 * @param row - parsed physical row before ordinary decoder validation.
 */
export function assertV5SourceRowAdmission(row: unknown): void {
  if (!isSessionFormatJsonObject(row)) return
  const data = row['data']
  if (!isSessionFormatJsonObject(data)) return
  const messages = row['type'] === 'user/message' ? [data]
    : row['type'] === 'developer/message' || row['type'] === 'system/message'
      || row['type'] === 'assistant/message' || row['type'] === 'tool/result' ? [data['message']]
      : row['type'] === 'agent/inbox/spliced' ? data['inserted']
        : row['type'] === 'session/title-llm-request' ? data['messages'] : []
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (isSessionFormatJsonObject(message)) assertBotGroupMessageSource(message['source'])
  }
}
