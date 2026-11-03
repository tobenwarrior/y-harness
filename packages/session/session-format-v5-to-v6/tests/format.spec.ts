import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@yharness/session-format'
import type { SessionFormatEvent, SessionFormatHeader } from '@yharness/session-format'
import {
  assertReleasedV6Header,
  assertV6RowAdmission,
  releasedV6SessionFormatCodec,
  restoreReleasedV6Artifact,
  sessionFormatV5ToV6,
} from '../src/index.ts'
import { assertV6MessageSources } from '../src/message-sources.ts'
import { releasedV5SessionFormatCodec } from '@yharness/session-format-v4-to-v5'

const v5Header: SessionFormatHeader = {
  version: 5,
  id: 'routine-source-session',
  createdAt: 1,
  isSeeded: false,
  delegationDepth: 0,
}

const v6Header: SessionFormatHeader = { ...v5Header, version: 6 }

const routineSource = {
  kind: 'bot-event-routine',
  form: 'notice',
  summary: 'Routine triggered',
  routineId: 'bot-event-routine-example',
  triggerEventSeq: 3,
  chainId: 'chain-1',
  depth: 1,
} as const

const routineMessage: SessionFormatEvent = {
  type: 'user/message',
  seq: 0,
  time: 2,
  surfaceOp: 'append',
  data: {
    id: 'routine-message',
    role: 'user',
    source: routineSource,
    content: [{ type: 'text', text: 'A routine-triggered message.' }],
  },
}

const malformedRoutineMessage: SessionFormatEvent = {
  ...routineMessage,
  data: {
    ...routineMessage.data as Record<string, unknown>,
    source: { ...routineSource, triggerEventSeq: -1 },
  },
}

describe('released V6 Session format', () => {
  it('round trips an event-routine source through the native codec', () => {
    const physicalHeader = releasedV6SessionFormatCodec.encodeHeader(v6Header, 0)
    expect(physicalHeader).toEqual({ type: 'session', ...v6Header })
    expect(releasedV6SessionFormatCodec.decodeHeader(physicalHeader)).toEqual(v6Header)

    const decoder = releasedV6SessionFormatCodec.createDecoder(physicalHeader, 'strict')
    const output = new SessionFormatEventCollector()
    decoder.decodeRow(releasedV6SessionFormatCodec.encodeEvent(routineMessage), output)
    expect(decoder.finish(output)).toBe(0)
    expect(output.values).toEqual([routineMessage])

    const artifact = { header: v6Header, inheritedEventCount: 0, events: output.values }
    expect(restoreReleasedV6Artifact(artifact, new Set(['user/message']))).toBe(artifact)
  })

  it('rejects malformed routine fields before recovery can discard a suffix', () => {
    expect(() => assertV6RowAdmission(malformedRoutineMessage)).toThrow(
      'format v6 bot-event-routine source requires a non-negative triggerEventSeq',
    )
    expect(() => restoreReleasedV6Artifact({
      header: v6Header,
      inheritedEventCount: 0,
      events: [malformedRoutineMessage],
    }, new Set(['user/message']))).toThrow(
      'format v6 bot-event-routine source requires a non-negative triggerEventSeq',
    )

    for (const [source, diagnostic] of [
      [{ ...routineSource, summary: '' }, 'requires a non-empty summary'],
      [{ ...routineSource, routineId: '' }, 'routineId is invalid'],
      [{ ...routineSource, routineId: `bot-event-routine-${'a'.repeat(256)}` }, 'routineId is invalid'],
      [{ ...routineSource, chainId: '' }, 'requires a non-empty chainId'],
      [{ ...routineSource, chainId: ' '.repeat(256) }, 'requires a non-blank chainId'],
      [{ ...routineSource, depth: 5 }, 'depth must be at most 4'],
      [{ ...routineSource, summary: `Routine "${'a'.repeat(121)}" triggered` }, 'requires a non-empty summary'],
    ] as const) {
      expect(() => assertV6RowAdmission({ ...routineMessage, data: {
        ...routineMessage.data as Record<string, unknown>, source,
      } })).toThrow(`format v6 bot-event-routine source ${diagnostic}`)
    }
    expect(() => assertV6RowAdmission({ ...routineMessage, data: {
      ...routineMessage.data as Record<string, unknown>, source: {
        kind: 'agent-message', form: 'relay', senderSessionId: 'sender',
        botEventRoutine: { chainId: 'chain-1', depth: 5 },
      },
    } })).toThrow('format v6 agent-message botEventRoutine depth must be at most 4')
    for (const chainId of ['', ' '.repeat(256), 'a'.repeat(257)]) {
      expect(() => assertV6RowAdmission({ ...routineMessage, data: {
        ...routineMessage.data as Record<string, unknown>, source: {
          kind: 'agent-message', form: 'relay', senderSessionId: 'sender',
          botEventRoutine: { chainId, depth: 0 },
        },
      } })).toThrow('format v6 bot-event-routine source')
    }
  })

  it('checks every declared message slot and leaves unknown event payloads opaque', () => {
    const message = { id: 'message', role: 'user', source: routineSource, content: [] }
    const event = (type: string, data: unknown): SessionFormatEvent => ({ type, seq: 0, time: 1, data } as SessionFormatEvent)
    for (const candidate of [
      event('user/message', message),
      event('developer/message', { message: { ...message, role: 'developer' } }),
      event('system/message', { message: { ...message, role: 'system' } }),
      event('assistant/message', { message: { ...message, role: 'assistant' } }),
      event('tool/result', { message: { ...message, role: 'tool' } }),
      event('agent/inbox/spliced', { inserted: [message] }),
      event('session/title-llm-request', { messages: [message] }),
      event('skill/learning-request', { messages: [message] }),
      event('future/event', { source: { kind: 'bot-event-routine' } }),
    ]) {
      expect(() => assertV6MessageSources(candidate)).not.toThrow()
    }
  })

  it('migrates V5 headers and events without rewriting source metadata', () => {
    const target = sessionFormatV5ToV6.migrateHeader(v5Header)
    expect(target).toEqual(v6Header)

    const output = new SessionFormatEventCollector()
    const stage = sessionFormatV5ToV6.createStage({
      sourceHeader: v5Header,
      targetHeader: target,
      sourceInheritedEventCount: 0,
      sourceKind: 'decoded',
    })
    stage.transformEvent(routineMessage, output)
    expect(stage.finish(output)).toBe(0)
    expect(output.values).toEqual([routineMessage])
  })

  it('retains V5 physical framing and rejects a V5 source claiming V6 delivery', () => {
    const v5Physical = releasedV5SessionFormatCodec.encodeHeader(v5Header, 0)
    expect(() => releasedV6SessionFormatCodec.decodeHeader(v5Physical)).toThrow('v6 physical')
    const marker: SessionFormatEvent = {
      type: 'session-log-deepseek/delivery-accepted',
      seq: 1,
      time: 3,
      data: { sessionId: v5Header.id, throughSeq: 0, sessionFormatVersion: 6 },
    }
    const output = new SessionFormatEventCollector()
    const stage = sessionFormatV5ToV6.createStage({
      sourceHeader: v5Header,
      targetHeader: v6Header,
      sourceInheritedEventCount: 0,
      sourceKind: 'decoded',
    })
    expect(() => stage.transformEvent(marker, output)).toThrow('claims target format v6')
  })

  it('rejects headers from another generation', () => {
    expect(() => assertReleasedV6Header(v5Header)).toThrow('expected format v6 header')
    expect(() => releasedV6SessionFormatCodec.decodeHeader({ type: 'session', ...v5Header })).toThrow('v6 physical')
  })
})
