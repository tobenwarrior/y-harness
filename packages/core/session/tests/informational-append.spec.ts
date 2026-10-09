import { describe, expect, expectTypeOf, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset, snapshotSessionEvent, type SessionEvent, type SessionInformationalOptions } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'fixture/information': { nested: { count: number } }
  }
}

describe('informational Session append options', () => {
  it('snapshots and freezes the explicit marker and payload through durable JSON restoration', () => {
    const session = Session.create(SessionId('informational-roundtrip'))
    const payload = { nested: { count: 1 } }
    const options: { ignorable: true | false } = { ignorable: true }
    const event = session.append('fixture/information', payload, options as SessionInformationalOptions)
    payload.nested.count = 2
    options.ignorable = false
    expect(event.ignorable).toBe(true)
    expect(event.data.nested.count).toBe(1)
    expect(Object.isFrozen(event)).toBe(true)
    expect(Object.isFrozen(event.data.nested)).toBe(true)
    expect(session.snapshotEvents()[0]).toBe(event)
    const restored = Session.fromRestore(session.id, JSON.parse(JSON.stringify(session.snapshotEvents())) as SessionEvent[], session.header, SessionLogOffset(0), 'detached')
    expect(restored.snapshotEvents()[0]).toEqual(event)
    expect(restored.snapshotEvents()[0]?.ignorable).toBe(true)
    expect(restored.deriveMessages()).toEqual([])
  })

  it('defaults to required and materializes a marker getter only once', () => {
    const session = Session.create(SessionId('informational-default'))
    expect(session.append('fixture/information', { nested: { count: 1 } })).not.toHaveProperty('ignorable')
    expect(session.append('fixture/information', { nested: { count: 1 } }, {})).not.toHaveProperty('ignorable')
    let reads = 0
    const options = { get ignorable() { reads++; return reads === 1 ? true : false } }
    const event = session.append('fixture/information', { nested: { count: 1 } }, options as SessionInformationalOptions)
    expect(reads).toBe(1)
    expect(event.ignorable).toBe(true)
  })

  it('rejects non-true markers and unexpected non-surface metadata without changing the log', () => {
    const session = Session.create(SessionId('informational-invalid'))
    const append = session.append.bind(session) as (type: string, data: unknown, options?: unknown) => SessionEvent
    for (const options of [{ ignorable: false }, { ignorable: 'true' }, { ignorable: null }, { ignorable: undefined }, { extra: true }, [], null]) {
      expect(() => append('fixture/information', { nested: { count: 1 } }, options)).toThrow(/ignorable|metadata/)
    }
    for (const options of [{ surfaceOp: 'append' }, { sourceEventSeqs: [0] }, { ignorable: true, surfaceOp: 'append' }]) {
      expect(() => append('fixture/information', { nested: { count: 1 } }, options)).toThrow(/not surface-eligible/)
    }
    expect(session.snapshotEvents()).toEqual([])
  })

  it('rejects informational markers in surface append options and validates imported marker values', () => {
    const session = Session.create(SessionId('informational-surface'))
    const message = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
    const append = session.append.bind(session) as (type: string, data: unknown, options?: unknown) => SessionEvent
    expect(() => append('user/message', message, { surfaceOp: 'append', ignorable: true })).toThrow(/ignorable.*surface|surface.*ignorable/)
    const valid = session.append('user/message', message, { surfaceOp: 'append' })
    expect(valid.surfaceOp).toBe('append')
    expect(valid).not.toHaveProperty('ignorable')
    const snapshot = snapshotSessionEvent as (event: unknown) => SessionEvent
    expect(() => snapshot({ type: 'fixture/information', seq: valid.seq, time: 1, data: { nested: { count: 1 } }, ignorable: false })).toThrow(/ignorable/)
  })

  it('keeps the informational options vocabulary separate from surface placement', () => {
    expectTypeOf<{ ignorable: true }>().toExtend<SessionInformationalOptions>()
    expectTypeOf<{ ignorable: false }>().not.toExtend<SessionInformationalOptions>()
    expectTypeOf<{ surfaceOp: 'append' }>().not.toExtend<SessionInformationalOptions>()
    // These branches are type-check fixtures and never execute.
    if (false) {
      const session = Session.create(SessionId('informational-types'))
      session.append('fixture/information', { nested: { count: 1 } }, { ignorable: true })
      // @ts-expect-error -- only the literal true informational marker is accepted.
      session.append('fixture/information', { nested: { count: 1 } }, { ignorable: false })
      // @ts-expect-error -- log-only events cannot claim surface placement.
      session.append('fixture/information', { nested: { count: 1 } }, { surfaceOp: 'append' })
      // @ts-expect-error -- message-producing events cannot be appended as informational.
      session.append('user/message', createUserMessage({ content: [], source: { kind: 'user' } }), { surfaceOp: 'append', ignorable: true })
    }
  })
})
