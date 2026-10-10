/** Versioned import receipts and exact prepared Session events, independent from native history storage. */
import { z } from 'zod'
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { codingSessionDigest } from './digest.ts'
import { codingSessionMirrorSchema } from './record.ts'
import type { CodingSessionEventId, CodingSessionMirrorId, CodingSessionNativeId, CodingSessionProfileId } from './types.ts'
import type {
  CodingSessionImportedUserEvent, CodingSessionImportPlannedEvent, CodingSessionLinkId, CodingSessionLinkRecord,
} from './linked-import-types.ts'

const linkId = z.string().min(1).transform(value => brandString<CodingSessionLinkId>(value))
const mirrorId = z.string().min(1).transform(value => brandString<CodingSessionMirrorId>(value))
const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  .refine(value => !Object.is(value, -0), 'Session sequence cannot be negative zero.')
  .transform(value => brandNumber<SessionSeq>(value))
const source = z.object({
  provider: z.enum(['codex', 'claude']),
  profileId: z.string().min(1).transform(value => brandString<CodingSessionProfileId>(value)),
  nativeSessionId: z.string().min(1).transform(value => brandString<CodingSessionNativeId>(value)),
})
const nativeEvent = z.object({
  id: z.string().min(1).transform(value => brandString<CodingSessionEventId>(value)),
  role: z.enum(['user', 'assistant', 'system', 'tool']), text: z.string(), digest: z.string().min(1),
})
const messageSource = source.extend({
  kind: z.literal('coding-session-import'), mirrorId, linkId,
  generation: z.number().int().positive(), disposition: z.enum(['active', 'rolled-back']),
})
const message = z.object({
  id: z.string().min(1).transform(MessageId), role: z.literal('user'),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })).length(1), source: messageSource,
})
const userEvent = z.object({
  type: z.literal('user/message'), seq, time: z.number().int().nonnegative(), data: message,
  surfaceOp: z.union([z.literal('append'), z.object({ op: z.literal('replace'), startSeq: seq, endSeq: seq })]),
  sourceEventSeqs: z.array(seq).optional(),
})
/** Canonical JSON omits absent optional metadata instead of widening the core Session envelope. */
const normalizeUserEvent = (value: z.output<typeof userEvent>): CodingSessionImportedUserEvent => {
  const { sourceEventSeqs, ...event } = value
  return sourceEventSeqs === undefined ? event : { ...event, sourceEventSeqs }
}
const generation = z.object({
  generation: z.number().int().positive(), sourceRevision: z.number().int().positive(), rawEvents: z.array(nativeEvent),
  message, event: userEvent.transform(normalizeUserEvent), destinationSeq: seq,
  mappings: z.array(z.object({
    nativeEventId: z.string().min(1).transform(value => brandString<CodingSessionEventId>(value)),
    nativeDigest: z.string().min(1), destinationSeq: seq,
    textStart: z.number().int().nonnegative(), textEnd: z.number().int().nonnegative(),
  })),
  status: z.enum(['active', 'rolled-back']), rollbackSeq: seq.optional(),
})
const plannedEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session/end-seed'), seq, time: z.number().int().nonnegative(),
    data: z.object({ inherited: z.literal(true).optional() }),
  }),
  userEvent,
  z.object({ type: z.literal('turn/start'), seq, time: z.number().int().nonnegative(),
    data: z.object({ turn: z.number().int().positive() }).strict(),
  }).strict(),
  z.object({ type: z.literal('step/start'), seq, time: z.number().int().nonnegative(),
    data: z.object({ turn: z.number().int().positive(), step: z.literal(1) }).strict(),
  }).strict(),
  z.object({ type: z.literal('system/message'), seq, time: z.number().int().nonnegative(),
    data: z.object({ turn: z.number().int().positive(), step: z.literal(1),
      message: z.object({
        id: z.string().min(1).transform(MessageId), role: z.literal('system'), content: z.array(z.never()).length(0),
        source: z.object({ kind: z.literal('system-prompt') }).strict(),
      }).strict(),
    }).strict(), surfaceOp: z.literal('append'),
  }).strict(),
  z.object({ type: z.literal('coding-session/import-initialization'), seq, time: z.number().int().nonnegative(),
    ignorable: z.literal(true),
    data: z.object({ source, mirrorId, linkId, systemMessageId: z.string().min(1).transform(MessageId) }).strict(),
  }).strict(),
  z.object({ type: z.literal('step/end'), seq, time: z.number().int().nonnegative(),
    data: z.object({ turn: z.number().int().positive(), step: z.literal(1) }).strict(),
  }).strict(),
  z.object({ type: z.literal('turn/end'), seq, time: z.number().int().nonnegative(),
    data: z.object({ turn: z.number().int().positive(), reason: z.object({ kind: z.literal('blocked') }).strict() }).strict(),
  }).strict(),
]).transform((event): CodingSessionImportPlannedEvent => event.type === 'user/message' ? normalizeUserEvent(event)
  : event.type === 'session/end-seed'
    ? { ...event, data: event.data.inherited === undefined ? {} : { inherited: event.data.inherited } } : event)

/**
 * Narrow an accepted linked user event through the durable parser without changing its canonical envelope.
 * @param event - exact immutable event returned by Session.append().
 * @returns after validating the original immutable envelope in place; no bytes are rewritten.
 * @throws when the captured event is outside the durable linked schema or parsing would change recorded bytes.
 */
export function admitCodingSessionImportedUserEvent(
  event: SessionEvent<'user/message'>,
): asserts event is CodingSessionImportedUserEvent {
  const admitted = normalizeUserEvent(userEvent.parse(event))
  if (codingSessionDigest(admitted) !== codingSessionDigest(event)) throw new Error('Linked user admission changed its captured envelope.')
}
/**
 * Narrow an accepted local initializer envelope through the same durable parser.
 * @param event - exact immutable constructor or append event.
 * @returns after validating the original immutable envelope in place; no bytes are rewritten.
 * @throws when the event is outside the planned schema or parsing would change recorded bytes.
 */
export function admitCodingSessionImportPlannedEvent(event: SessionEvent): asserts event is CodingSessionImportPlannedEvent {
  const admitted = plannedEvent.parse(event)
  if (codingSessionDigest(admitted) !== codingSessionDigest(event)) {
    throw new Error('Linked initializer admission changed its captured envelope.')
  }
}
const destinationRevision = z.object({ eventCount: z.number().int().nonnegative(), digest: z.string().min(1) })
/** Durable journal validation; relation and ownership checks remain in the transaction executor. */
export const codingSessionLinkSchema = z.object({
  version: z.literal(1), id: linkId, mirrorId, source,
  destinationSessionId: z.string().min(1).transform(value => brandString<SessionId>(value)),
  project: z.string().min(1), revision: z.number().int().nonnegative(), status: z.enum(['active', 'rolled-back', 'conflict']),
  conflict: z.literal('history-diverged').optional(), mirror: codingSessionMirrorSchema, generations: z.array(generation),
  pending: z.object({
    kind: z.enum(['import', 'rollback']), before: destinationRevision, append: z.array(plannedEvent).min(1),
    nextMirror: codingSessionMirrorSchema, nextGenerations: z.array(generation),
  }).optional(),
})
/** One Host owns this versioned journal; destination mutation additionally requires SessionPersistence ownership. */
export const codingSessionLinkDomain = defineDomain({
  name: 'coding_session_links', version: 1,
  tables: { links: domainTable<CodingSessionLinkId, CodingSessionLinkRecord>(codingSessionLinkSchema) },
})
