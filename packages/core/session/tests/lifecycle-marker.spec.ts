import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '../src/index.ts'

it('exposes only the immutable marker produced during this constructor lifecycle', () => {
  const original = Session.create(SessionId('constructor-marker'))
  expect(original.lifecycleMarker).toBeUndefined()
  original.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Existing input' }] }), { surfaceOp: 'append' })
  const retained = original.snapshotEvents()
  const restored = Session.create(original.id, retained, original.header)
  expect(restored.lifecycleMarker).toMatchObject({ seq: retained.length, type: 'session/end-seed', data: {} })
  expect(restored.lifecycleMarker?.time).toEqual(expect.any(Number))
  expect(restored.lifecycleMarker).toBe(restored.snapshotEvents().at(-1))
  expect(Object.isFrozen(restored.lifecycleMarker)).toBe(true)
  expect(restored.snapshotEvents().slice(0, retained.length)).toEqual(retained)
})

it('does not expose a borrowed seed marker as a newly produced lifecycle marker', () => {
  const original = Session.create(SessionId('borrowed-marker'))
  original.append('session/end-seed', {})
  const restored = Session.create(original.id, original.snapshotEvents(), original.header)
  expect(restored.lifecycleMarker).toBeUndefined()
  expect(restored.seq).toBe(original.seq)
})
