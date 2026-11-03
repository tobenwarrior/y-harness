/** V5 physical framing, reusing V4 rows while admitting the V5 source vocabulary. */

import { SessionFormatError, isSessionFormatJsonObject } from '@yharness/session-format'
import type {
  SessionFormatCodec,
  SessionFormatCurrentEncoder,
  SessionFormatHeader,
} from '@yharness/session-format'
import { releasedV4SessionFormatCodec, assertV4RowAdmission } from '@yharness/session-format-v3-to-v4'
import { assertReleasedV5Header } from './validation.ts'
import { assertV5SourceRowAdmission } from './message-sources.ts'

function v4PhysicalHeader(value: unknown): SessionFormatHeader {
  if (!isSessionFormatJsonObject(value) || value['version'] !== 5) {
    throw new SessionFormatError('expected format v5 physical header')
  }
  return { ...value, version: 4 } as SessionFormatHeader
}

/** Frozen physical JSON codec for released V5. */
export const releasedV5SessionFormatCodec = Object.freeze({
  version: 5,
  decodeHeader(value: unknown) {
    return { ...releasedV4SessionFormatCodec.decodeHeader(v4PhysicalHeader(value)), version: 5 }
  },
  createDecoder(value, recovery) {
    const decoder = releasedV4SessionFormatCodec.createDecoder(v4PhysicalHeader(value), recovery)
    return {
      ...decoder,
      header: { ...decoder.header, version: 5 },
      decodeRow(row, context) {
        assertV5RowAdmission(row)
        decoder.decodeRow(row, context)
      },
    }
  },
  encodeHeader(header: SessionFormatHeader, inheritedEventCount: number) {
    assertReleasedV5Header(header)
    return {
      ...releasedV4SessionFormatCodec.encodeHeader({ ...header, version: 4 }, inheritedEventCount),
      version: 5,
    }
  },
  encodeEvent(event) {
    assertV5RowAdmission(event)
    return releasedV4SessionFormatCodec.encodeEvent(event)
  },
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)

/**
 * Validate one physical V5 row before recovery can discard a malformed suffix.
 * @param row - parsed physical row.
 * @param knownEventTypes - installed event types used for ignorable admission.
 */
export function assertV5RowAdmission(row: unknown, knownEventTypes?: ReadonlySet<string>): void {
  if (isSessionFormatJsonObject(row) && row['type'] === 'developer/message' && row['ignorable'] === true
    && knownEventTypes?.has('developer/message') !== true) return
  assertV4RowAdmission(row, knownEventTypes)
  assertV5SourceRowAdmission(row)
}
