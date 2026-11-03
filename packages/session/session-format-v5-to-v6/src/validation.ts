/** Native V6 header, source, and delivery-generation validation. */

import {
  SessionFormatError,
  SessionFormatUnsupportedMigrationError,
  isSessionFormatJsonObject,
  sessionFormatCount,
} from '@yharness/session-format'
import type { SessionFormatArtifact, SessionFormatEvent } from '@yharness/session-format'
import { assertReleasedV5Header, restoreReleasedV5Artifact } from '@yharness/session-format-v4-to-v5'
import { assertV6MessageSources } from './message-sources.ts'

/** Validate the exact native V6 logical header.
 * @param header - decoded or otherwise untrusted V6 Session header candidate.
 */
export function assertReleasedV6Header(header: unknown): void {
  if (!isSessionFormatJsonObject(header) || header['version'] !== 6) {
    throw new SessionFormatError('expected format v6 header')
  }
  assertReleasedV5Header({ ...header, version: 5 })
}

function validateDeliveryAccepted(event: SessionFormatEvent): string | undefined {
  if (event.type !== 'session-log-deepseek/delivery-accepted') return undefined
  const data = event.data
  if (!isSessionFormatJsonObject(data)) throw new SessionFormatError('delivery-accepted data must be an object')
  const version = sessionFormatCount(
    data['sessionFormatVersion'] === undefined ? 0 : data['sessionFormatVersion'],
    'delivery sessionFormatVersion',
  )
  if (version !== 6) return undefined
  const throughSeq = sessionFormatCount(data['throughSeq'], 'delivery throughSeq')
  if (throughSeq >= event.seq) throw new SessionFormatError('delivery throughSeq must precede its marker')
  const id = data['sessionId']
  if (typeof id !== 'string' || id.length === 0) throw new SessionFormatError('delivery requires a nonempty Session id')
  return id
}

/** Validate V6 delivery ownership before delegating shared V5 relationships. */
function assertV6Relationships(artifact: SessionFormatArtifact, knownEventTypes: ReadonlySet<string>): void {
  const deliveryType = 'session-log-deepseek/delivery-accepted'
  for (const event of artifact.events) {
    if (!knownEventTypes.has(event.type)) continue
    assertV6MessageSources(event)
    const deliveryId = validateDeliveryAccepted(event)
    if (deliveryId !== undefined
      && !(artifact.header.parentSession !== undefined && event.seq < artifact.inheritedEventCount)
      && deliveryId !== artifact.header.id) {
      throw new SessionFormatError('current-generation delivery marker names the wrong Session')
    }
  }
  const delegatedKnownEventTypes = new Set(knownEventTypes)
  delegatedKnownEventTypes.delete(deliveryType)
  const delegatedEvents = artifact.events.map(event => event.type === deliveryType
    ? { ...event, ignorable: true }
    : event)
  restoreReleasedV5Artifact({ ...artifact, events: delegatedEvents, header: { ...artifact.header, version: 5 } }, delegatedKnownEventTypes)
}

/** Validate a complete detached V6 artifact without interpreting unknown ignorable events.
 * @param artifact - detached V6 artifact.
 * @param knownEventTypes - installed event types whose payloads this reader understands.
 * @returns the unchanged artifact after validation.
 */
export function restoreReleasedV6Artifact(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
): SessionFormatArtifact {
  assertReleasedV6Header(artifact.header)
  const cut = sessionFormatCount(artifact.inheritedEventCount, 'format v6 inherited event count')
  if (cut > artifact.events.length) throw new SessionFormatError('format v6 inherited event count exceeds its events')
  if (!artifact.header.isSeeded && cut !== 0) throw new SessionFormatError('unseeded format v6 Session has inherited events')
  let lastInheritedMarker: number | undefined
  for (const [index, event] of artifact.events.entries()) {
    if (!knownEventTypes.has(event.type) && event['ignorable'] !== true) {
      throw new SessionFormatUnsupportedMigrationError(
        `format v6 contains unknown event type ${JSON.stringify(event.type)} at seq ${index}`,
      )
    }
    if (event.seq !== index) throw new SessionFormatError(`format v6 event ${index} is not dense`)
    if (!knownEventTypes.has(event.type)) continue
    if (event.type === 'session/end-seed' && isSessionFormatJsonObject(event.data)
      && event.data['inherited'] === true) lastInheritedMarker = index
  }
  if (artifact.header.isSeeded && lastInheritedMarker !== cut) {
    throw new SessionFormatError('format v6 seeded header disagrees with its last inherited end-seed marker')
  }
  if (!artifact.header.isSeeded && lastInheritedMarker !== undefined) {
    throw new SessionFormatError('format v6 unseeded Session contains an inherited end-seed marker')
  }
  assertV6Relationships(artifact, knownEventTypes)
  return artifact
}
