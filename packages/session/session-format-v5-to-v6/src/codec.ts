/** V6 physical framing, reusing V5 rows while admitting event-routine sources. */

import { SessionFormatError, isSessionFormatJsonObject } from '@yharness/session-format'
import type {
  SessionFormatCodec,
  SessionFormatCurrentEncoder,
  SessionFormatHeader,
} from '@yharness/session-format'
import { assertV5RowAdmission, releasedV5SessionFormatCodec } from '@yharness/session-format-v4-to-v5'
import { assertReleasedV6Header } from './validation.ts'
import { assertV6SourceRowAdmission } from './message-sources.ts'

function v5PhysicalHeader(value: unknown): SessionFormatHeader {
  if (!isSessionFormatJsonObject(value) || value['version'] !== 6) {
    throw new SessionFormatError('expected format v6 physical header')
  }
  return { ...value, version: 5 } as SessionFormatHeader
}

/** Frozen physical JSON codec for the current V6 format. */
export const releasedV6SessionFormatCodec = Object.freeze({
  version: 6,
  decodeHeader(value: unknown) {
    return { ...releasedV5SessionFormatCodec.decodeHeader(v5PhysicalHeader(value)), version: 6 }
  },
  createDecoder(value, recovery) {
    const decoder = releasedV5SessionFormatCodec.createDecoder(v5PhysicalHeader(value), recovery)
    return {
      ...decoder,
      header: { ...decoder.header, version: 6 },
      decodeRow(row, context) {
        assertV6RowAdmission(row)
        decoder.decodeRow(row, context)
      },
    }
  },
  encodeHeader(header: SessionFormatHeader, inheritedEventCount: number) {
    assertReleasedV6Header(header)
    return {
      ...releasedV5SessionFormatCodec.encodeHeader({ ...header, version: 5 }, inheritedEventCount),
      version: 6,
    }
  },
  encodeEvent(event) {
    assertV6RowAdmission(event)
    return releasedV5SessionFormatCodec.encodeEvent(event)
  },
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)

/** Validate one physical V6 row before recovery can discard a malformed suffix.
 * @param row - parsed physical row.
 * @param knownEventTypes - installed event types used for ignorable admission.
 */
export function assertV6RowAdmission(row: unknown, knownEventTypes?: ReadonlySet<string>): void {
  if (isSessionFormatJsonObject(row) && row['type'] === 'developer/message' && row['ignorable'] === true
    && knownEventTypes?.has('developer/message') !== true) return
  assertV5RowAdmission(row, knownEventTypes)
  assertV6SourceRowAdmission(row)
}
