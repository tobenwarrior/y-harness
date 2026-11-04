/** Identity V5-to-V6 migration for the event-routine source vocabulary. */

import {
  defineSessionFormatMigration,
  SessionFormatError,
  SessionFormatUnsupportedMigrationError,
  isSessionFormatJsonObject,
  sessionFormatCount,
} from '@yharness/session-format'
import type {
  SessionFormatEvent,
  SessionFormatEventRun,
  SessionFormatMigrationContext,
  SessionFormatMigrationStage,
  SessionFormatMigrationStageInput,
} from '@yharness/session-format'
import { assertReleasedV5Header } from '@yharness/session-format-v4-to-v5'
import { assertReleasedV6Header } from './validation.ts'

/** Advance a V5 header and retain every logical event unchanged. */
export const sessionFormatV5ToV6 = defineSessionFormatMigration({
  name: '@yharness/session-format-v5-to-v6',
  fromVersion: 5,
  toVersion: 6,
  migrateHeader(header) {
    assertReleasedV5Header(header)
    return { ...header, version: 6 }
  },
  createStage(input) {
    return new ReleasedV5ToV6Stage(input)
  },
  validateTargetHeader: assertReleasedV6Header,
})

class ReleasedV5ToV6Stage implements SessionFormatMigrationStage {
  readonly headerInheritedEventCount?: number
  private inheritedCut: number | undefined
  private foreignDeliverySeq: number | undefined

  constructor(private readonly input: SessionFormatMigrationStageInput) {
    assertReleasedV5Header(input.sourceHeader)
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
    const sourceCut = sessionFormatCount(this.inheritedCut, 'format v5 inherited event count')
    if (this.input.sourceInheritedEventCount !== undefined && sourceCut !== this.input.sourceInheritedEventCount) {
      throw new SessionFormatError('format v5 inherited event count disagrees with its source cut')
    }
    if (this.foreignDeliverySeq !== undefined
      && (this.input.sourceHeader.parentSession === undefined || this.foreignDeliverySeq >= sourceCut)) {
      throw new SessionFormatError('current-generation delivery marker names the wrong Session')
    }
    return sourceCut
  }

  private observeDelivery(event: SessionFormatEvent): void {
    if (event.type !== 'session-log-deepseek/delivery-accepted') return
    const deliveryId = validateDeliveryAccepted(event)
    const data = event.data
    if (!isSessionFormatJsonObject(data)) return
    if (data['sessionFormatVersion'] === 6) {
      throw new SessionFormatUnsupportedMigrationError('format v5 delivery marker claims target format v6')
    }
    if (deliveryId !== undefined && deliveryId !== this.input.sourceHeader.id) {
      this.foreignDeliverySeq = event.seq
    }
  }
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

function isInheritedMarker(value: unknown): value is { readonly inherited: true } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as { inherited?: unknown }).inherited === true
}
