/** Mock native turns and isolated reads exercise the production sequential writer without a model or profile. */
import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ClaudeSequentialExecutor, ClaudeSequentialTurnReceipt } from '@deepseek-ai/dsh-subagent-claude-code'
import { createClaudeSequentialWriter, validateClaudeSequentialReadback } from '../src/claude-sequential.ts'
import type { ClaudeSequentialHistoryMessage } from '../src/claude-sequential.ts'
import { codingSessionDigest } from '../src/digest.ts'
import type { CodingSessionNativeId, CodingSessionProfileId, CodingSessionOwnerToken, CodingSessionSnapshot, CodingSessionEventId } from '../src/types.ts'

const source = { provider: 'claude' as const, profileId: brandString<CodingSessionProfileId>('explicit-original-profile'),
  nativeSessionId: brandString<CodingSessionNativeId>('11111111-1111-4111-8111-111111111111') }
const request = { signal: new AbortController().signal, limit: 4, maxEvents: 20, maxBytes: 100000 }
const acquisition = { ...request, ownerToken: brandString<CodingSessionOwnerToken>('owned-instance'), nativeProfileUnchanged: true as const }
function native(type: ClaudeSequentialHistoryMessage['type'], uuid: string, message: unknown): ClaudeSequentialHistoryMessage {
  return { type, uuid, message, session_id: source.nativeSessionId, parent_tool_use_id: null, parent_agent_id: null }
}
function snapshot(messages: ClaudeSequentialHistoryMessage[]): CodingSessionSnapshot {
  return { source, title: 'Original native conversation', cwd: '/fixture/project', writerState: 'unknown',
    cursor: codingSessionDigest(messages), events: messages.map(message => ({ id: brandString<CodingSessionEventId>(message.uuid),
      role: message.type, text: JSON.stringify(message.message), digest: codingSessionDigest(message) })) }
}
function receipt(): ClaudeSequentialTurnReceipt {
  return { nativeTurnId: '22222222-2222-4222-8222-222222222222', userMessage: { role: 'user', content: 'Continue the original task' },
    assistants: [{ id: '33333333-3333-4333-8333-333333333333', message: {
      id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture-native-model', content: [{ type: 'text', text: 'Native answer', citations: null }],
      container: null, context_management: null, stop_details: null, stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation: null, cache_creation_input_tokens: null,
        cache_read_input_tokens: null, inference_geo: null, iterations: null, server_tool_use: null, service_tier: null, speed: null },
    } }], processExited: true, streamsDrained: true, noObservedPersistenceErrors: true }
}
function fixture() {
  let messages = [native('user', 'old-user', { role: 'user', content: 'Existing original task' })]
  const completed = receipt(); let current = true
  const reads = vi.fn(async () => snapshot(messages))
  const raw = vi.fn(async () => structuredClone(messages))
  const turn = vi.fn<ClaudeSequentialExecutor['turn']>(async (_text, _signal, beforeDispatch) => {
    await beforeDispatch()
    messages = [...messages, native('user', completed.nativeTurnId, completed.userMessage),
      ...completed.assistants.map(message => native('assistant', message.id, message.message))]
    return completed
  })
  const close = vi.fn(async () => {})
  const executor: ClaudeSequentialExecutor = { current: () => current, turn, close }
  const owner = createClaudeSequentialWriter({ ...source, connected: () => true }, { snapshot: reads, messages: raw }, () => executor)
  return { owner, completed, reads, raw, turn, close, mutate: (next: ClaudeSequentialHistoryMessage[]) => { messages = next },
    messages: () => structuredClone(messages), stale: () => { current = false } }
}

it('acquires the explicit original source without a native query and exposes conversation-only authority', async () => {
  const f = fixture(); const lease = await f.owner.writer.acquire(source, acquisition)
  expect(f.owner.writer).toMatchObject({ authority: 'user-acknowledged-sequential', toolMode: 'conversation' })
  expect(lease.source).toEqual(source); expect(f.turn).not.toHaveBeenCalled()
  await expect(f.owner.writer.acquire(source, acquisition)).rejects.toThrow('another owner')
  const released = await lease.release(request)
  expect(released).toMatchObject({ source, completedTurnPersisted: false, nativeTurnIds: [], expectedPrefixPersisted: true })
  expect(f.close).toHaveBeenCalledOnce()
})

it('awaits durable dispatch then verifies exact native input and assistant bodies before original-ID release', async () => {
  const f = fixture(); const lease = await f.owner.writer.acquire(source, acquisition)
  const beforeDispatch = vi.fn(async () => { expect(f.messages()).toHaveLength(1) })
  const result = await lease.resumeOriginal({ source, text: 'Continue the original task', signal: request.signal, beforeDispatch })
  expect(beforeDispatch).toHaveBeenCalledOnce(); expect(result.nativeTurnId).toBe(f.completed.nativeTurnId)
  const released = await lease.release(request)
  expect(released).toMatchObject({ source, processExited: true, streamsDrained: true, expectedPrefixPersisted: true,
    completedTurnPersisted: true, noObservedPersistenceErrors: true, nativeTurnIds: [f.completed.nativeTurnId] })
  expect(released.snapshot.events).toHaveLength(3); expect(f.raw).toHaveBeenCalledOnce()
  expect(await lease.release(request)).toBe(released); expect(f.close).toHaveBeenCalledOnce()
})

it('refuses stale native history before the dispatch callback or any model turn', async () => {
  const f = fixture(); const lease = await f.owner.writer.acquire(source, acquisition)
  f.mutate([...f.messages(), native('user', 'external-writer', { role: 'user', content: 'Concurrent native input' })])
  const beforeDispatch = vi.fn(async () => {})
  await expect(lease.resumeOriginal({ source, text: 'Continue', signal: request.signal, beforeDispatch })).rejects.toThrow('uncertain')
  expect(beforeDispatch).not.toHaveBeenCalled(); expect(f.turn).not.toHaveBeenCalled()
  await expect(lease.release(request)).rejects.toThrow('uncertain'); expect(f.close).toHaveBeenCalledOnce()
  await expect(f.owner.writer.acquire(source, acquisition)).rejects.toThrow('another owner')
})

it('rechecks original history after native preparation and before the durable dispatch callback', async () => {
  const f = fixture(); const lease = await f.owner.writer.acquire(source, acquisition)
  f.turn.mockImplementation(async (_text, _signal, beforeDispatch) => {
    f.mutate([...f.messages(), native('user', 'during-preparation', { role: 'user', content: 'External native writer' })])
    await beforeDispatch(); return f.completed
  })
  const beforeDispatch = vi.fn(async () => {})
  await expect(lease.resumeOriginal({ source, text: 'Continue', signal: request.signal, beforeDispatch })).rejects.toThrow('uncertain')
  expect(beforeDispatch).not.toHaveBeenCalled(); await expect(lease.release(request)).rejects.toThrow('uncertain')
})

it.each(['missing', 'duplicate'])('rejects %s native durable admission while retaining ownership', async (failure) => {
  const f = fixture(); const lease = await f.owner.writer.acquire(source, acquisition)
  f.turn.mockImplementation(async (_text, _signal, beforeDispatch) => {
    if (failure === 'duplicate') { await beforeDispatch(); await beforeDispatch() }
    return f.completed
  })
  const beforeDispatch = vi.fn(async () => {})
  await expect(lease.resumeOriginal({ source, text: 'Continue', signal: request.signal, beforeDispatch })).rejects.toThrow('uncertain')
  expect(beforeDispatch).toHaveBeenCalledTimes(failure === 'duplicate' ? 1 : 0)
  await expect(lease.release(request)).rejects.toThrow('uncertain')
  await expect(f.owner.writer.acquire(source, acquisition)).rejects.toThrow('another owner')
})

it('rejects original-prefix rewrite and exact own-body mismatch even with preserved UUIDs', () => {
  const completed = receipt(); const beforeMessages = [native('user', 'old-user', { role: 'user', content: 'Original' })]
  const afterMessages = [...beforeMessages, native('user', completed.nativeTurnId, completed.userMessage),
    ...completed.assistants.map(message => native('assistant', message.id, message.message))]
  const before = snapshot(beforeMessages)
  validateClaudeSequentialReadback(before, snapshot(afterMessages), afterMessages, completed)
  const rewritten = structuredClone(afterMessages); rewritten[0]!.message = { role: 'user', content: 'Changed prefix' }
  expect(() => { validateClaudeSequentialReadback(before, snapshot(rewritten), rewritten, completed) }).toThrow('diverged')
  const bodyChanged = structuredClone(afterMessages); bodyChanged[2]!.message = { role: 'assistant', content: 'Changed answer' }
  expect(() => { validateClaudeSequentialReadback(before, snapshot(bodyChanged), bodyChanged, completed) }).toThrow('exactly')
})

it.each(['wrong-id', 'extra-native-input', 'missing-assistant'])('refuses %s in isolated completed-turn readback', (failure) => {
  const completed = receipt(); const beforeMessages = [native('user', 'old-user', { role: 'user', content: 'Original' })]
  const afterMessages = [...beforeMessages, native('user', completed.nativeTurnId, completed.userMessage),
    ...completed.assistants.map(message => native('assistant', message.id, message.message))]
  if (failure === 'wrong-id') afterMessages[2]!.session_id = '44444444-4444-4444-8444-444444444444'
  if (failure === 'extra-native-input') afterMessages.push(native('user', 'foreign-send', { role: 'user', content: 'External continuation' }))
  if (failure === 'missing-assistant') afterMessages.pop()
  expect(() => {
    validateClaudeSequentialReadback(snapshot(beforeMessages), snapshot(afterMessages), afterMessages, completed)
  }).toThrow()
})

it('binds every raw readback body to the accepted full snapshot even when raw UUIDs agree', () => {
  const completed = receipt(); const original = [native('user', 'old-user', { role: 'user', content: 'Original' })]
  const raw = [...original, native('user', completed.nativeTurnId, completed.userMessage),
    ...completed.assistants.map(message => native('assistant', message.id, message.message))]
  const observed = structuredClone(raw); observed[2]!.message = { role: 'assistant', content: 'Different persisted body' }
  expect(() => { validateClaudeSequentialReadback(snapshot(original), snapshot(observed), raw, completed) }).toThrow('diverged')
})

it('retains healthy native completion across transient readback failure and verifies it only on release', async () => {
  const f = fixture(); const lease = await f.owner.writer.acquire(source, acquisition)
  f.raw.mockRejectedValueOnce(new Error('Fixture reader unavailable'))
  await expect(lease.resumeOriginal({ source, text: 'Continue the original task', signal: request.signal, beforeDispatch: async () => {} })).rejects.toThrow('uncertain')
  expect(f.turn).toHaveBeenCalledOnce()
  await expect(lease.resumeOriginal({ source, text: 'Another turn', signal: request.signal, beforeDispatch: async () => {} })).rejects.toThrow('live owner')
  f.stale()
  const released = await lease.release(request)
  expect(released).toMatchObject({ completedTurnPersisted: true, nativeTurnIds: [f.completed.nativeTurnId], expectedPrefixPersisted: true })
  expect(f.turn).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce(); expect(f.raw).toHaveBeenCalledTimes(2)
})

it('keeps healthy receipt ownership blocked while a release reader still cannot verify it', async () => {
  const f = fixture(); const lease = await f.owner.writer.acquire(source, acquisition)
  f.raw.mockRejectedValueOnce(new Error('Fixture reader unavailable')).mockRejectedValueOnce(new Error('Fixture release reader still unavailable'))
  await expect(lease.resumeOriginal({ source, text: 'Continue the original task', signal: request.signal, beforeDispatch: async () => {} })).rejects.toThrow('uncertain')
  await expect(lease.release(request)).rejects.toThrow('still unavailable')
  await expect(f.owner.writer.acquire(source, acquisition)).rejects.toThrow('another owner')
  const released = await lease.release(request)
  expect(released.nativeTurnIds).toEqual([f.completed.nativeTurnId]); expect(f.turn).toHaveBeenCalledOnce()
})

it('drains a removed root owner before returning a rejected release receipt', async () => {
  const f = fixture(); const lease = await f.owner.writer.acquire(source, acquisition)
  f.turn.mockRejectedValue(new Error('Native cancellation'))
  await expect(lease.resumeOriginal({ source, text: 'Continue', signal: request.signal, beforeDispatch: async () => {} })).rejects.toThrow('uncertain')
  f.stale(); const drain = Promise.withResolvers<undefined>(); f.close.mockImplementation(() => drain.promise)
  let released = false
  const release = lease.release(request).finally(() => { released = true })
  const refused = expect(release).rejects.toThrow('uncertain')
  await Promise.resolve(); expect(f.close).toHaveBeenCalledOnce(); expect(released).toBe(false)
  drain.resolve(undefined); await refused
})

it('retains source ownership when persisted native state changes after an accepted turn', async () => {
  const f = fixture(); const lease = await f.owner.writer.acquire(source, acquisition)
  await lease.resumeOriginal({ source, text: 'Continue the original task', signal: request.signal, beforeDispatch: async () => {} })
  f.mutate([...f.messages(), native('user', 'late-external', { role: 'user', content: 'External writer' })])
  await expect(lease.release(request)).rejects.toThrow('before external release')
  await expect(f.owner.writer.acquire(source, acquisition)).rejects.toThrow('another owner')
})

it('honors an aborted release only after its owned executor has finished closing', async () => {
  const f = fixture(); const lease = await f.owner.writer.acquire(source, acquisition)
  const controller = new AbortController(); controller.abort()
  const drain = Promise.withResolvers<undefined>(); f.close.mockImplementation(() => drain.promise)
  let settled = false; const release = lease.release({ ...request, signal: controller.signal }).finally(() => { settled = true })
  const refused = expect(release).rejects.toThrow()
  await Promise.resolve(); expect(settled).toBe(false); drain.resolve(undefined); await refused
  expect(f.close).toHaveBeenCalledOnce(); await expect(f.owner.writer.acquire(source, acquisition)).rejects.toThrow('another owner')
})
