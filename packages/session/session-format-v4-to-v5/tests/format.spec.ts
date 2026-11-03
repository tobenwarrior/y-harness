import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@yharness/session-format'
import type { SessionFormatEvent, SessionFormatHeader } from '@yharness/session-format'
import {
  assertReleasedV5Header,
  assertV5RowAdmission,
  releasedV5SessionFormatCodec,
  restoreReleasedV5Artifact,
  sessionFormatV4ToV5,
} from '../src/index.ts'
import { releasedV4SessionFormatCodec } from '@yharness/session-format-v3-to-v4'
import { assertV5MessageSources, assertV5SourceRowAdmission } from '../src/message-sources.ts'

const v4Header: SessionFormatHeader = {
  version: 4,
  id: 'group-source-session',
  createdAt: 1,
  isSeeded: false,
  delegationDepth: 0,
}

const v5Header: SessionFormatHeader = { ...v4Header, version: 5 }

const groupMessage: SessionFormatEvent = {
  type: 'user/message',
  seq: 0,
  time: 2,
  surfaceOp: 'append',
  data: {
    id: 'group-message',
    role: 'user',
    source: { kind: 'bot-group-message', groupId: 'group-1', messageId: 'message-1' },
    content: [{ type: 'text', text: 'A message from the bot group.' }],
  },
}

const malformedGroupMessage: SessionFormatEvent = {
  ...groupMessage,
  data: {
    ...groupMessage.data as Record<string, unknown>,
    source: { kind: 'bot-group-message', groupId: 'group-1' },
  },
}

describe('released V5 Session format', () => {
  it('round trips a bot-group message source through the native codec', () => {
    const physicalHeader = releasedV5SessionFormatCodec.encodeHeader(v5Header, 0)
    expect(physicalHeader).toEqual({ type: 'session', ...v5Header })
    expect(releasedV5SessionFormatCodec.decodeHeader(physicalHeader)).toEqual(v5Header)

    const decoder = releasedV5SessionFormatCodec.createDecoder(physicalHeader, 'strict')
    const output = new SessionFormatEventCollector()
    decoder.decodeRow(releasedV5SessionFormatCodec.encodeEvent(groupMessage), output)
    expect(decoder.finish(output)).toBe(0)
    expect(output.values).toEqual([groupMessage])

    const artifact = { header: v5Header, inheritedEventCount: 0, events: output.values }
    expect(restoreReleasedV5Artifact(artifact, new Set(['user/message']))).toBe(artifact)
  })

  it('rejects incomplete group attribution in native V5 while retaining V4 and unknown-event compatibility', () => {
    const physicalHeader = releasedV5SessionFormatCodec.encodeHeader(v5Header, 0)
    const decoder = releasedV5SessionFormatCodec.createDecoder(physicalHeader, 'recoverable')
    const output = new SessionFormatEventCollector()
    expect(() => decoder.decodeRow(malformedGroupMessage, output)).toThrow(
      'format v5 bot-group-message source requires string groupId and messageId',
    )
    expect(() => restoreReleasedV5Artifact({
      header: v5Header,
      inheritedEventCount: 0,
      events: [malformedGroupMessage],
    }, new Set(['user/message']))).toThrow(
      'format v5 bot-group-message source requires string groupId and messageId',
    )

    const v4Decoder = releasedV4SessionFormatCodec.createDecoder({ type: 'session', ...v4Header }, 'strict')
    const v4Output = new SessionFormatEventCollector()
    v4Decoder.decodeRow(malformedGroupMessage, v4Output)
    expect(v4Decoder.finish(v4Output)).toBe(0)
    expect(v4Output.values).toEqual([malformedGroupMessage])

    const unknown = {
      type: 'future/group-event', seq: 0, time: 2, ignorable: true,
      data: { source: { kind: 'bot-group-message' } },
    } as SessionFormatEvent
    const unknownArtifact = { header: v5Header, inheritedEventCount: 0, events: [unknown] }
    expect(restoreReleasedV5Artifact(unknownArtifact, new Set())).toBe(unknownArtifact)
  })

  it('checks only declared message slots and preserves incomplete-row handling', () => {
    const source = { kind: 'bot-group-message', groupId: 'group-1', messageId: 'message-1' }
    const message = { id: 'message', role: 'user', source, content: [] }
    const event = (type: string, data: unknown): SessionFormatEvent => ({ type, seq: 0, time: 1, data } as SessionFormatEvent)
    for (const candidate of [
      event('user/message', { ...message }),
      event('developer/message', { message: { ...message, role: 'developer' } }),
      event('system/message', { message: { ...message, role: 'system' } }),
      event('assistant/message', { message: { ...message, role: 'assistant' } }),
      event('tool/result', { message: { ...message, role: 'tool' } }),
      event('agent/inbox/spliced', { inserted: [null, message] }),
      event('session/title-llm-request', { messages: [message] }),
      event('future/event', { source: { kind: 'bot-group-message' } }),
      event('user/message', null),
      event('system/message', {}),
    ]) {
      expect(() => assertV5MessageSources(candidate)).not.toThrow()
    }
    for (const candidate of [undefined, null, {}, { kind: 'user' }]) {
      expect(() => assertV5MessageSources(event('user/message', { ...message, source: candidate }))).not.toThrow()
    }
    for (const candidate of [
      { kind: 'bot-group-message' },
      { kind: 'bot-group-message', groupId: 1, messageId: 'message-1' },
      { kind: 'bot-group-message', groupId: 'group-1', messageId: 1 },
    ]) {
      expect(() => assertV5MessageSources(event('user/message', { ...message, source: candidate }))).toThrow(
        'format v5 bot-group-message source requires string groupId and messageId',
      )
    }
    expect(() => assertV5SourceRowAdmission(null)).not.toThrow()
    expect(() => assertV5SourceRowAdmission({ type: 'user/message', data: null })).not.toThrow()
    expect(() => assertV5SourceRowAdmission({ type: 'system/message', data: {} })).not.toThrow()
    expect(() => assertV5SourceRowAdmission({ type: 'agent/inbox/spliced', data: { inserted: false } })).not.toThrow()
    expect(() => assertV5SourceRowAdmission({ type: 'agent/inbox/spliced', data: { inserted: [null, message] } })).not.toThrow()
    expect(() => assertV5SourceRowAdmission({ type: 'session/title-llm-request', data: { messages: [message] } })).not.toThrow()
    expect(() => assertV5SourceRowAdmission({ type: 'future/event', data: { source } })).not.toThrow()

    const opaqueDeveloper = { type: 'developer/message', ignorable: true, data: null }
    expect(() => assertV5RowAdmission(opaqueDeveloper)).not.toThrow()
    expect(() => assertV5RowAdmission(opaqueDeveloper, new Set(['developer/message']))).toThrow()
  })

  it('migrates V4 headers and events without rewriting group-source metadata', () => {
    const target = sessionFormatV4ToV5.migrateHeader(v4Header)
    expect(target).toEqual(v5Header)

    const output = new SessionFormatEventCollector()
    const stage = sessionFormatV4ToV5.createStage({
      sourceHeader: v4Header,
      targetHeader: target,
      sourceInheritedEventCount: 0,
      sourceKind: 'decoded',
    })
    stage.transformEvent(groupMessage, output)
    expect(stage.finish(output)).toBe(0)
    expect(output.values).toEqual([groupMessage])
  })

  it('treats V4 delivery markers as historical and validates only V5 ownership', () => {
    const marker = (sessionId: string, sessionFormatVersion: number): SessionFormatEvent => ({
      type: 'session-log-deepseek/delivery-accepted',
      seq: 1,
      time: 3,
      data: { sessionId, throughSeq: 0, sessionFormatVersion },
    })
    const known = new Set(['user/message', 'session-log-deepseek/delivery-accepted'])
    const historical = { header: v5Header, inheritedEventCount: 0, events: [groupMessage, marker('other-session', 4)] }
    expect(restoreReleasedV5Artifact(historical, known)).toBe(historical)

    expect(() => restoreReleasedV5Artifact({
      ...historical,
      events: [groupMessage, marker('other-session', 5)],
    }, known)).toThrow('wrong Session')
  })

  it('rejects headers from another generation', () => {
    expect(() => assertReleasedV5Header(v4Header)).toThrow('expected format v5 header')
    expect(() => releasedV5SessionFormatCodec.decodeHeader({ type: 'session', ...v4Header })).toThrow('v5 physical')
  })
})
