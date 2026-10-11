/** Corrupt persisted receipts cannot acquire a destination writer or erase retained evidence. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { codingSessionDigest } from '../src/digest.ts'
import type { CodingSessionImportGeneration, CodingSessionImportPending, CodingSessionLinkRecord } from '../src/types.ts'
import { linkedFixture, linkedMirror } from './linked-admission-fixture.ts'

type Fixture = ReturnType<typeof linkedFixture>
interface Corruption { name: string; error: string; change: (record: CodingSessionLinkRecord) => unknown }

function generation(record: CodingSessionLinkRecord): CodingSessionImportGeneration {
  const value = record.generations[0]
  if (value === undefined) throw new Error('Fixture committed generation missing')
  return value
}
function intent(record: CodingSessionLinkRecord): CodingSessionImportPending {
  if (record.pending === undefined) throw new Error('Fixture prepared receipt missing')
  return record.pending
}
function nextGeneration(record: CodingSessionLinkRecord): CodingSessionImportGeneration {
  const value = intent(record).nextGenerations[0]
  if (value === undefined) throw new Error('Fixture prepared generation missing')
  return value
}
function quotedText(value: CodingSessionImportGeneration): string {
  const block = value.message.content[0]
  if (block?.type !== 'text') throw new Error('Fixture historical quote missing')
  return block.text
}
function rewriteQuote(value: CodingSessionImportGeneration, text: string): void {
  value.message = { ...value.message, content: [{ type: 'text', text }] }
  value.event = { ...value.event, data: value.message }
}
async function committed(f: Fixture): Promise<CodingSessionLinkRecord> {
  return f.manager.importMirror(linkedMirror(), await f.acknowledgement())
}
async function preparedImport(f: Fixture): Promise<CodingSessionLinkRecord> {
  f.flush('reject-before')
  await expect(committed(f)).rejects.toThrow('Synthetic flush unavailable')
  const retained = f.records.values().next().value
  if (retained === undefined) throw new Error('Fixture prepared journal missing')
  return structuredClone(retained)
}
async function preparedRollback(f: Fixture): Promise<CodingSessionLinkRecord> {
  const record = await committed(f)
  f.flush('reject-before')
  await expect(f.manager.rollback(record.id, { expectedLinkRevision: record.revision,
    expectedDestinationRevision: (await f.manager.inspectDestination(f.id)).revision })).rejects.toThrow('Synthetic flush unavailable')
  return f.manager.detail(record.id)
}
async function refusesPersisted(f: Fixture, value: unknown, error: string): Promise<void> {
  // persist accepts unknown JSON and decodes the real durable schema before executor relation checks.
  const decoded = f.persist(value)
  const destinationBytes = JSON.stringify(f.slot().events)
  const journalBytes = JSON.stringify([...f.records.entries()])
  const acquire = vi.spyOn(f.options, 'withDestination')

  await expect(f.manager.recover(decoded.id)).rejects.toThrow(error)

  expect(acquire).not.toHaveBeenCalled()
  expect(JSON.stringify(f.slot().events)).toBe(destinationBytes)
  expect(JSON.stringify([...f.records.entries()])).toBe(journalBytes)
}

const committedCorruptions: Corruption[] = [
  { name: 'foreign destination identity', error: 'inconsistent source or destination identities', change: record =>
    ({ ...record, destinationSessionId: brandString<CodingSessionLinkRecord['destinationSessionId']>('foreign-destination') }) },
  { name: 'relative project on both retained source and link', error: 'inconsistent source or destination identities', change: record =>
    ({ ...record, project: 'relative/project', mirror: { ...record.mirror, cwd: 'relative/project' } }) },
  { name: 'active link with no retained generation', error: 'inconsistent committed generation state', change: record =>
    ({ ...record, generations: [] }) },
  { name: 'rolled-back link retaining active generations', error: 'inconsistent committed generation state', change: record =>
    ({ ...record, status: 'rolled-back' }) },
  { name: 'conflict state without its disclosure', error: 'inconsistent committed generation state', change: record =>
    ({ ...record, status: 'conflict' }) },
  { name: 'uncommitted revision without a pending receipt', error: 'inconsistent committed generation state', change: record =>
    ({ ...record, revision: 0 }) },
  { name: 'active generations differing from admitted native history', error: 'inconsistent committed generation state', change: (record) => {
    const events = [...record.mirror.events, { id: brandString<CodingSessionLinkRecord['mirror']['events'][number]['id']>('native-2'),
      role: 'user' as const, text: 'Other native history', digest: 'digest-2' }]
    record.mirror = { ...record.mirror, events, digest: codingSessionDigest(events.map(event => [event.id, event.digest])) }
    return record
  } },
  { name: 'foreign generation ownership', error: 'inconsistent generation ownership or rollback receipts', change: (record) => {
    const value = generation(record)
    value.message = { ...value.message, source: { ...value.message.source,
      linkId: brandString<CodingSessionLinkRecord['id']>('foreign-link') } }
    value.event = { ...value.event, data: value.message }; return record
  } },
  { name: 'stale captured event sequence', error: 'inconsistent generation ownership or rollback receipts', change: (record) => {
    const value = generation(record); value.event.seq = SessionSeq(value.destinationSeq + 1); return record
  } },
  { name: 'unexpected projection source metadata', error: 'inconsistent generation ownership or rollback receipts', change: (record) => {
    generation(record).event.sourceEventSeqs = []; return record
  } },
  { name: 'missing one-to-one native mappings', error: 'inconsistent generation ownership or rollback receipts', change: (record) => {
    generation(record).mappings = []; return record
  } },
  { name: 'rolled-back generation without its compensation sequence', error: 'inconsistent generation ownership or rollback receipts', change: (record) => {
    generation(record).status = 'rolled-back'; return record
  } },
  { name: 'missing historical role disclosure', error: 'inconsistent quoted frame or role disclosure', change: (record) => {
    const value = generation(record); rewriteQuote(value, quotedText(value).replace('Imported public', 'Unattributed public')); return record
  } },
  { name: 'malformed quoted JSON title', error: 'invalid quoted historical title', change: (record) => {
    const value = generation(record); rewriteQuote(value, quotedText(value).replace(`title: ${JSON.stringify(record.mirror.title)}`, 'title: unquoted')); return record
  } },
  { name: 'nonstring quoted JSON title', error: 'noncanonical quoted historical title', change: (record) => {
    const value = generation(record); rewriteQuote(value, quotedText(value).replace(`title: ${JSON.stringify(record.mirror.title)}`, 'title: 0')); return record
  } },
  { name: 'noncanonical whitespace around a quoted title', error: 'noncanonical quoted historical title', change: (record) => {
    const value = generation(record); rewriteQuote(value, quotedText(value).replace('title: ', 'title:  ')); return record
  } },
  { name: 'contradictory native mapping digest', error: 'inconsistent ordered native event mappings', change: (record) => {
    const mapping = generation(record).mappings[0]
    if (mapping === undefined) throw new Error('Fixture native mapping missing')
    mapping.nativeDigest = 'contradictory-digest'; return record
  } },
  { name: 'extra text after the exact quoted native records', error: 'noncanonical quoted frame or native record order', change: (record) => {
    const value = generation(record); rewriteQuote(value, `${quotedText(value)}Unrecorded tail`); return record
  } },
]

const importCorruptions: Corruption[] = [
  { name: 'next mirror source changed', error: 'changed its original source or project', change: (record) => {
    const pending = intent(record); pending.nextMirror.source.profileId = brandString<CodingSessionLinkRecord['source']['profileId']>('foreign-profile'); return record
  } },
  { name: 'noncontiguous captured append', error: 'do not contiguously follow their reviewed prefix', change: (record) => {
    const first = intent(record).append[0]
    if (first === undefined) throw new Error('Fixture prepared append missing')
    first.seq = SessionSeq(first.seq + 1); return record
  } },
  { name: 'foreign quoted append ownership', error: 'inconsistent import ownership', change: (record) => {
    const pending = intent(record)
    pending.append = pending.append.map(event => event.type === 'user/message' ? { ...event,
      data: { ...event.data, source: { ...event.data.source, linkId: brandString<CodingSessionLinkRecord['id']>('foreign-link') } } } : event)
    return record
  } },
  { name: 'generation admits another native revision', error: 'does not match its retained source and destination generation', change: (record) => {
    nextGeneration(record).sourceRevision++; return record
  } },
  { name: 'quoted append differs from captured generation bytes', error: 'does not match its retained source and destination generation', change: (record) => {
    const pending = intent(record)
    pending.append = pending.append.map(event => event.type === 'user/message' ? { ...event, time: event.time + 1 } : event)
    return record
  } },
  { name: 'initializer turn disagrees with the balanced local reservation', error: 'inconsistent local system-head initializer', change: (record) => {
    const pending = intent(record)
    pending.append = pending.append.map(event => event.type === 'turn/start' ? { ...event, data: { turn: event.data.turn + 1 } } : event)
    return record
  } },
  { name: 'initializer receipt names another link', error: 'inconsistent local system-head initializer', change: (record) => {
    const pending = intent(record)
    pending.append = pending.append.map(event => event.type === 'coding-session/import-initialization' ? { ...event,
      data: { ...event.data, linkId: brandString<CodingSessionLinkRecord['id']>('foreign-link') } } : event)
    return record
  } },
]

describe('linked durable journal admission', () => {
  it.each(committedCorruptions)('refuses persisted $name without changing either retained log', async ({ change, error }) => {
    const f = linkedFixture(); onTestFinished(() => f.manager.close())
    await refusesPersisted(f, change(await committed(f)), error)
  })

  it.each(importCorruptions)('refuses a prepared import with $name before acquiring the destination writer', async ({ name, change, error }) => {
    const f = linkedFixture(name.startsWith('initializer') ? false : true); onTestFinished(() => f.manager.close())
    await refusesPersisted(f, change(await preparedImport(f)), error)
  })

  it('bounds all retained native events even when the current mirror fits', async () => {
    const f = linkedFixture(); onTestFinished(() => f.manager.close())
    const record = await committed(f)
    record.mirror = { ...record.mirror, events: [], digest: codingSessionDigest([]) }
    f.options.maxEvents = 0
    await refusesPersisted(f, record, 'configured retained event limit')
  })

  it('bounds retained generations before interpreting any owned destination receipt', async () => {
    const f = linkedFixture(); onTestFinished(() => f.manager.close())
    const record = await committed(f); f.options.maxGenerations = 0
    await refusesPersisted(f, record, 'configured generation limit')
  })

  it('refuses a prepared rollback missing one retained generation', async () => {
    const f = linkedFixture(); onTestFinished(() => f.manager.close())
    const record = await preparedRollback(f); intent(record).nextGenerations = []
    await refusesPersisted(f, record, 'does not match its retained generations')
  })

  it('refuses a prepared rollback whose replacement targets another destination node', async () => {
    const f = linkedFixture(); onTestFinished(() => f.manager.close())
    const record = await preparedRollback(f); const pending = intent(record)
    pending.append = pending.append.map(event => event.type === 'user/message' && event.surfaceOp !== 'append' ? {
      ...event, surfaceOp: { ...event.surfaceOp, endSeq: SessionSeq(event.surfaceOp.endSeq + 1) },
    } : event)
    await refusesPersisted(f, record, 'changed an unowned node or generation receipt')
  })

  it.each([false, true])('preserves an older rollback receipt during later recovery (corrupt=%s)', async (corrupt) => {
    const f = linkedFixture(); onTestFinished(() => f.manager.close())
    const first = await committed(f)
    const rolled = await f.manager.rollback(first.id, { expectedLinkRevision: first.revision,
      expectedDestinationRevision: (await f.manager.inspectDestination(f.id)).revision })
    const second = await f.manager.importMirror(linkedMirror(2), await f.acknowledgement(2, rolled.revision))
    f.flush('reject-before')
    await expect(f.manager.rollback(second.id, { expectedLinkRevision: second.revision,
      expectedDestinationRevision: (await f.manager.inspectDestination(f.id)).revision })).rejects.toThrow('Synthetic flush unavailable')
    const record = f.manager.detail(second.id); const older = nextGeneration(record)
    if (corrupt) {
      older.sourceRevision++
      await refusesPersisted(f, record, 'changed an older retained receipt')
    } else {
      const retained = structuredClone(older)
      f.persist(record); f.flush('publish')
      const recovered = await f.manager.recover(second.id)
      expect(recovered.pending).toBeUndefined()
      expect(recovered.status).toBe('rolled-back')
      expect(recovered.generations[0]).toEqual(retained)
      expect(recovered.generations.map(value => value.status)).toEqual(['rolled-back', 'rolled-back'])
      expect(recovered.generations.map(value => value.rawEvents)).toEqual(second.generations.map(value => value.rawEvents))
    }
  })
})
