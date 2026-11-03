import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector } from '@yharness/session-format'
import type { SessionFormatEvent, SessionFormatHeader } from '@yharness/session-format'
import {
  assertReleasedV5Header,
  releasedV5SessionFormatCodec,
  restoreReleasedV5Artifact,
  sessionFormatV4ToV5,
} from '../src/index.ts'

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
