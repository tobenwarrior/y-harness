/** Linked initializer admission preserves complete immutable envelopes from the Session API. */
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { admitCodingSessionImportPlannedEvent } from '../src/linked-import-record.ts'
import type {} from '../src/linked-import-options.ts'

describe('linked initializer immutable envelopes', () => {
  it('retains the inherited marker created at a seeded child session cut', () => {
    const parent = Session.create(SessionId('fixture-linked-parent'))
    parent.append('turn/start', { turn: 1 })
    parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const id = SessionId('fixture-linked-child')
    const child = Session.create(id, parent.snapshotEvents(), { ...parent.header, id, isSeeded: true }, parent.seq)
    const captured = child.lifecycleMarker
    if (captured === undefined) throw new Error('The seeded child did not publish its inherited marker')
    const original = captured; const bytes = JSON.stringify(captured)

    expect(() => { admitCodingSessionImportPlannedEvent(captured) }).not.toThrow()

    expect(captured.data).toEqual({ inherited: true })
    expect(captured).toBe(original)
    expect(JSON.stringify(captured)).toBe(bytes)
    expect(Object.isFrozen(captured)).toBe(true)
    expect(child.ownEvents()).toEqual([captured])
  })

  it('refuses an initializer whose accepted informational metadata would be stripped by its durable parser', () => {
    const session = Session.create(SessionId('fixture-linked-informational-marker'))
    const captured = session.append('session/end-seed', {}, { ignorable: true })
    const bytes = JSON.stringify(captured)

    expect(() => { admitCodingSessionImportPlannedEvent(captured) })
      .toThrow('Linked initializer admission changed its captured envelope')

    expect(captured.ignorable).toBe(true)
    expect(JSON.stringify(captured)).toBe(bytes)
    expect(Object.isFrozen(captured)).toBe(true)
    expect(session.snapshotEvents()).toEqual([captured])
  })
})
