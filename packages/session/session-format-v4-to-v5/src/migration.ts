/** Identity V4-to-V5 migration for the group-message source vocabulary. */

import { defineSessionFormatMigration, SessionFormatError, isSessionFormatJsonObject, sessionFormatCount } from '@yharness/session-format'
import type {
  SessionFormatEvent,
  SessionFormatEventRun,
  SessionFormatMigrationContext,
  SessionFormatMigrationStage,
  SessionFormatMigrationStageInput,
} from '@yharness/session-format'
import { assertReleasedV4Header, validateDeliveryAccepted } from '@yharness/session-format-v3-to-v4'
import { assertReleasedV5Header } from './validation.ts'

/** Advance a V4 header and retain every logical event unchanged. */
export const sessionFormatV4ToV5 = defineSessionFormatMigration({
  name: '@yharness/session-format-v4-to-v5',
  fromVersion: 4,
  toVersion: 5,
  migrateHeader(header) {
    assertReleasedV4Header(header)
    return { ...header, version: 5 }
  },
  createStage(input) {
    return new ReleasedV4ToV5Stage(input)
  },
  validateTargetHeader: assertReleasedV5Header,
})

class ReleasedV4ToV5Stage implements SessionFormatMigrationStage {
  readonly headerInheritedEventCount?: number
  private inheritedCut: number | undefined
  private foreignDeliverySeq: number | undefined

  constructor(private readonly input: SessionFormatMigrationStageInput) {
    assertReleasedV4Header(input.sourceHeader)
    this.inheritedCut = input.sourceHeader.isSeeded ? undefined : 0
    if (!input.sourceHeader.isSeeded) this.headerInheritedEventCount = 0
  }

  transformEvent(event: SessionFormatEvent, context: SessionFormatMigrationContext): void {
    this.observeDelivery(event)
    if (event.type === 'session/end-seed' && isInheritedMarker(event.data)) this.inheritedCut = event.seq
    context.emitEvent(event)
  }

  transformRun(run: SessionFormatEventRun, context: SessionFormatMigrationContext): void {
    context.emitRun(run)
  }

  finish(_context: SessionFormatMigrationContext): number {
    const sourceCut = sessionFormatCount(this.inheritedCut, 'format v4 inherited event count')
    if (this.input.sourceInheritedEventCount !== undefined && sourceCut !== this.input.sourceInheritedEventCount) {
      throw new SessionFormatError('format v4 inherited event count disagrees with its source cut')
    }
    if (this.foreignDeliverySeq !== undefined
      && (this.input.sourceHeader.parentSession === undefined || this.foreignDeliverySeq >= sourceCut)) {
      throw new SessionFormatError('current-generation delivery marker names the wrong Session')
    }
    return sourceCut
  }

  private observeDelivery(event: SessionFormatEvent): void {
    if (event.type !== 'session-log-deepseek/delivery-accepted') return
    const deliveryId = validateDeliveryAccepted(event, 4)
    const data = event.data
    if (!isSessionFormatJsonObject(data)) return
    if (data['sessionFormatVersion'] === 5) {
      throw new SessionFormatError('format v4 delivery marker claims target format v5')
    }
    if (deliveryId !== undefined && deliveryId !== this.input.sourceHeader.id) {
      this.foreignDeliverySeq = event.seq
    }
  }
}

function isInheritedMarker(value: unknown): value is { readonly inherited: true } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as { inherited?: unknown }).inherited === true
}
