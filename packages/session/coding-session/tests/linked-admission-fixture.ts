/** Test-owned ordinary Session logs and durable receipt transport; no external source or model. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { codingSessionDigest } from '../src/digest.ts'
import { CodingSessionLinkedImports } from '../src/linked-import.ts'
import { codingSessionLinkSchema } from '../src/linked-import-record.ts'
import type { CodingSessionLinkedImportOptions } from '../src/linked-import-options.ts'
import type { CodingSessionLinkId, CodingSessionLinkRecord, CodingSessionMirror } from '../src/types.ts'

export function linkedMirror(revision = 1): CodingSessionMirror {
  const events: CodingSessionMirror['events'] = [{ id: brandString<CodingSessionMirror['events'][number]['id']>('native-1'),
    role: 'user', text: 'Synthetic public history', digest: 'digest-1' }]
  return { id: brandString<CodingSessionMirror['id']>('admission-mirror'), source: { provider: 'claude',
    profileId: brandString<CodingSessionMirror['source']['profileId']>('admission-profile'),
    nativeSessionId: brandString<CodingSessionMirror['source']['nativeSessionId']>('admission-original') },
  title: 'Synthetic quoted title', cwd: '/fixture/project', writerState: 'unknown', events, cursor: `cursor-${revision}`,
  digest: codingSessionDigest(events.map(event => [event.id, event.digest])), revision,
  refreshedAt: '2026-10-11T00:00:00.000Z', status: 'ready',
  capabilities: { discover: true, read: true, refresh: true, continue: false, reason: 'native-writer-handoff-unavailable' } }
}

export function linkedFixture(head = true, bounds: Partial<Pick<CodingSessionLinkedImportOptions,
  'maxBytes' | 'maxRecords' | 'maxEvents' | 'maxGenerations'>> = {}) {
  const id = SessionId('admission-destination'); const other = SessionId('admission-other')
  const destinations = new Map<SessionId, { header: Session['header']; events: readonly SessionEvent[] }>()
  for (const selected of [id, other]) {
    const session = Session.create(selected, undefined, { id: selected, version: 4, createdAt: 1, isSeeded: false, cwd: '/fixture/project' })
    if (head) {
      session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
      session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('') }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } })
    }
    destinations.set(selected, { header: session.header, events: session.snapshotEvents() })
  }
  const records = new Map<CodingSessionLinkId, CodingSessionLinkRecord>()
  let flushMode: 'publish' | 'reject-before' | 'omit' = 'publish'
  let publishBarrier: (() => Promise<void>) | undefined
  const options: CodingSessionLinkedImportOptions = { maxBytes: 100000, maxEvents: 100, maxRecords: 10, maxGenerations: 10, ...bounds,
    store: { get: key => records.get(key), entries: () => records.entries(),
      put: async (key, value) => { records.set(key, structuredClone(value)) } },
    inspectDestination: async selected => ({ id: selected, events: slot(selected).events }),
    withDestination: async (selected, use) => {
      const retained = slot(selected); const session = Session.create(selected, retained.events, retained.header)
      let recorded: readonly SessionEvent[] | undefined
      return use({ session, get persistedEvents() { return retained.events },
        appendRecorded: async (events) => {
          const next = [...retained.events, ...events]
          Session.create(selected, next, retained.header); recorded = next
        }, flush: async () => {
          await publishBarrier?.(); publishBarrier = undefined
          if (flushMode === 'reject-before') throw new Error('Synthetic flush unavailable')
          if (flushMode === 'publish') retained.events = recorded ?? session.snapshotEvents()
        } })
    } }
  function slot(selected = id) {
    const retained = destinations.get(selected)
    if (retained === undefined) throw new Error('Fixture destination missing')
    return retained
  }
  const manager = new CodingSessionLinkedImports(options)
  async function acknowledgement(revision = 1, linkRevision?: number, selected = id) {
    return { destinationSessionId: selected, expectedMirrorRevision: revision,
      expectedDestinationRevision: (await manager.inspectDestination(selected)).revision,
      ...linkRevision === undefined ? {} : { expectedLinkRevision: linkRevision } }
  }
  return { id, other, options, records, manager, acknowledgement, slot,
    flush: (mode: typeof flushMode) => { flushMode = mode },
    barrier: (wait: () => Promise<void>) => { publishBarrier = wait },
    /** Decode a persisted JSON receipt through the real schema before the executor's relation guards. */
    persist: (value: unknown) => {
      const decoded = codingSessionLinkSchema.parse(JSON.parse(JSON.stringify(value)))
      records.set(decoded.id, decoded); return decoded
    },
  }
}
