/** Parser admission keeps original immutable Session envelopes and refuses unsupported wire fields. */
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  admitCodingSessionImportedUserEvent, admitCodingSessionImportPlannedEvent,
} from '../src/linked-import-record.ts'
import type {
  CodingSessionImportMessageSource, CodingSessionProfileId, CodingSessionNativeId,
  CodingSessionMirrorId, CodingSessionLinkId,
} from '../src/types.ts'

const source: CodingSessionImportMessageSource = {
  kind: 'coding-session-import', provider: 'codex', profileId: brandString<CodingSessionProfileId>('fixture-profile'),
  nativeSessionId: brandString<CodingSessionNativeId>('fixture-native'),
  mirrorId: brandString<CodingSessionMirrorId>('fixture-mirror'),
  linkId: brandString<CodingSessionLinkId>('fixture-link'), generation: 1, disposition: 'active',
}

function user(session: Session, attribution: CodingSessionImportMessageSource = source) {
  return session.append('user/message', createUserMessage({
    source: attribution, content: [{ type: 'text', text: 'Quoted public fixture history; private native context Unknown.' }],
  }), { surfaceOp: 'append' })
}

describe('linked wire admission', () => {
  it('retains the original frozen captured user envelope instead of a parser copy', () => {
    const session = Session.create(SessionId('linked-wire-user'))
    const captured = user(session); const original = captured; const bytes = JSON.stringify(captured)
    admitCodingSessionImportedUserEvent(captured)
    expect(captured).toBe(original); expect(JSON.stringify(captured)).toBe(bytes)
    expect(Object.isFrozen(captured)).toBe(true); expect(Object.isFrozen(captured.data.source)).toBe(true)
    expect(session.deriveMessages()).toEqual([captured.data])
  })

  it('refuses unsafe, fractional and negative-zero journal sequences before accepting their envelope', () => {
    const captured = user(Session.create(SessionId('linked-wire-invalid-sequence')))
    for (const seq of [-0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN]) {
      const candidate = { ...captured, seq: brandNumber<SessionSeq>(seq) }
      expect(() => { admitCodingSessionImportedUserEvent(candidate) }).toThrow()
      expect(Object.is(candidate.seq, seq)).toBe(true)
    }
  })

  it('refuses a source field the durable parser would strip without changing its captured history', () => {
    const session = Session.create(SessionId('linked-wire-extra-source'))
    const extended = { ...source, unsupportedReplayState: 'fixture-only opaque provider field' }
    const captured = user(session, extended); const bytes = JSON.stringify(captured)
    expect(() => { admitCodingSessionImportedUserEvent(captured) }).toThrow(/captured envelope/i)
    expect(JSON.stringify(captured)).toBe(bytes); expect(session.deriveMessages()).toEqual([captured.data])
  })

  it('retains all six original initializer envelopes and an existing constructor marker', () => {
    const session = Session.create(SessionId('linked-wire-initializer'), [])
    const headMessage = createSystemMessage('')
    const events = [
      session.append('turn/start', { turn: 1 }),
      session.append('step/start', { turn: 1, step: 1 }),
      session.append('system/message', { turn: 1, step: 1, message: headMessage }, { surfaceOp: 'append' }),
      session.append('coding-session/import-initialization', {
        source: { provider: source.provider, profileId: source.profileId, nativeSessionId: source.nativeSessionId },
        mirrorId: source.mirrorId, linkId: source.linkId, systemMessageId: headMessage.id,
      }, { ignorable: true }),
      session.append('step/end', { turn: 1, step: 1 }),
      session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } }),
    ]
    const marker = session.lifecycleMarker; if (marker === undefined) throw new Error('Expected an actual constructor marker')
    const captured = [marker, ...events]; const originals = [...captured]; const bytes = captured.map(event => JSON.stringify(event))
    for (const event of captured) admitCodingSessionImportPlannedEvent(event)
    captured.forEach((event, index) => { expect(event).toBe(originals[index]); expect(Object.isFrozen(event)).toBe(true) })
    expect(captured.map(event => JSON.stringify(event))).toEqual(bytes)
    expect(session.deriveMessages()).toEqual([])
  })

  it('refuses other core-valid outcomes and nonempty system content without rewriting either event', () => {
    const session = Session.create(SessionId('linked-wire-outside-schema'))
    const events = [
      session.append('turn/start', { turn: 1 }),
      session.append('step/start', { turn: 1, step: 1 }),
      session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('Fixture prompt') }, { surfaceOp: 'append' }),
      session.append('step/end', { turn: 1, step: 1 }),
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    for (const event of [events[2]!, events[4]!]) {
      const bytes = JSON.stringify(event)
      expect(() => { admitCodingSessionImportPlannedEvent(event) }).toThrow()
      expect(JSON.stringify(event)).toBe(bytes); expect(Object.isFrozen(event)).toBe(true)
    }
  })
})
