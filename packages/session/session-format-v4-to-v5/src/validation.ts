/** Native V5 header and relationship validation. */

import {
  SessionFormatError,
  SessionFormatUnsupportedMigrationError,
  isSessionFormatJsonObject,
  sessionFormatCount,
} from '@yharness/session-format'
import type { SessionFormatArtifact, SessionFormatEvent } from '@yharness/session-format'
import {
  assertReleasedV4Header,
  restoreReleasedV4Artifact,
} from '@yharness/session-format-v3-to-v4'
import { assertV5MessageSources } from './message-sources.ts'

/**
 * Validate the exact native V5 logical header.
 * @param header - decoded or otherwise untrusted V5 Session header candidate.
 */
export function assertReleasedV5Header(header: unknown): void {
  if (!isSessionFormatJsonObject(header) || header['version'] !== 5) {
    throw new SessionFormatError('expected format v5 header')
  }
  assertReleasedV4Header({ ...header, version: 4 })
}

function validateDeliveryAccepted(event: SessionFormatEvent): string | undefined {
  if (event.type !== 'session-log-deepseek/delivery-accepted') return undefined
  const data = event.data
  if (!isSessionFormatJsonObject(data)) throw new SessionFormatError('delivery-accepted data must be an object')
  const version = sessionFormatCount(
    data['sessionFormatVersion'] === undefined ? 0 : data['sessionFormatVersion'],
    'delivery sessionFormatVersion',
  )
  if (version !== 5) return undefined
  const throughSeq = sessionFormatCount(data['throughSeq'], 'delivery throughSeq')
  if (throughSeq >= event.seq) throw new SessionFormatError('delivery throughSeq must precede its marker')
  const id = data['sessionId']
  if (typeof id !== 'string' || id.length === 0) throw new SessionFormatError('delivery requires a nonempty Session id')
  return id
}

/** Validate V5 delivery ownership before delegating shared V4 relationships. */
function assertV5Relationships(artifact: SessionFormatArtifact, knownEventTypes: ReadonlySet<string>): void {
  const deliveryType = 'session-log-deepseek/delivery-accepted'
  for (const event of artifact.events) {
    if (!knownEventTypes.has(event.type)) continue
    assertV5MessageSources(event)
    const deliveryId = validateDeliveryAccepted(event)
    if (deliveryId !== undefined
      && !(artifact.header.parentSession !== undefined && event.seq < artifact.inheritedEventCount)
      && deliveryId !== artifact.header.id) {
      throw new SessionFormatError('current-generation delivery marker names the wrong Session')
    }
  }
  // The V4 validator treats its own delivery generation as active. Hide that
  // marker from the common V4 checks so V5 can validate only its own generation
  // while retaining V4 lifecycle, source, compaction, and native-field rules.
  const delegatedKnownEventTypes = new Set(knownEventTypes)
  delegatedKnownEventTypes.delete(deliveryType)
  const delegatedEvents = artifact.events.map(event => event.type === deliveryType
    ? { ...event, ignorable: true }
    : event)
  // V4 owns the common lifecycle, message-source, compaction, and native field
  // checks. It receives a private V4 header view and never escapes that view.
  restoreReleasedV4Artifact({ ...artifact, events: delegatedEvents, header: { ...artifact.header, version: 4 } }, delegatedKnownEventTypes)
}

/**
 * Validate a complete detached V5 artifact without interpreting unknown ignorable events.
 * @param artifact - detached V5 artifact.
 * @param knownEventTypes - installed event types whose payloads this reader understands.
 * @returns the unchanged artifact after validation.
 */
export function restoreReleasedV5Artifact(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
): SessionFormatArtifact {
  assertReleasedV5Header(artifact.header)
  const cut = sessionFormatCount(artifact.inheritedEventCount, 'format v5 inherited event count')
  if (cut > artifact.events.length) throw new SessionFormatError('format v5 inherited event count exceeds its events')
  if (!artifact.header.isSeeded && cut !== 0) throw new SessionFormatError('unseeded format v5 Session has inherited events')
  let lastInheritedMarker: number | undefined
  for (const [index, event] of artifact.events.entries()) {
    if (!knownEventTypes.has(event.type) && event['ignorable'] !== true) {
      throw new SessionFormatUnsupportedMigrationError(
        `format v5 contains unknown event type ${JSON.stringify(event.type)} at seq ${index}`,
      )
    }
    if (event.seq !== index) throw new SessionFormatError(`format v5 event ${index} is not dense`)
    if (!knownEventTypes.has(event.type)) continue
    if (event.type === 'session/end-seed' && isSessionFormatJsonObject(event.data)
      && event.data['inherited'] === true) lastInheritedMarker = index
  }
  if (artifact.header.isSeeded && lastInheritedMarker !== cut) {
    throw new SessionFormatError('format v5 seeded header disagrees with its last inherited end-seed marker')
  }
  if (!artifact.header.isSeeded && lastInheritedMarker !== undefined) {
    throw new SessionFormatError('format v5 unseeded Session contains an inherited end-seed marker')
  }
  assertV5Relationships(artifact, knownEventTypes)
  return artifact
}
