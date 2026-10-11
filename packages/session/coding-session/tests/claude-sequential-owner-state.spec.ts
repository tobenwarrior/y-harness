/** Captured native owners retain readback and disposal uncertainty without another dispatch. */
import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ClaudeSequentialExecutor, ClaudeSequentialTurnReceipt } from '@deepseek-ai/dsh-subagent-claude-code'
import { createClaudeSequentialWriter } from '../src/claude-sequential.ts'
import type { ClaudeSequentialHistoryMessage } from '../src/claude-sequential.ts'
import { codingSessionDigest } from '../src/digest.ts'
import type { CodingSessionEventId, CodingSessionNativeId, CodingSessionOwnerToken, CodingSessionProfileId,
  CodingSessionSnapshot } from '../src/types.ts'

const source = { provider: 'claude' as const, profileId: brandString<CodingSessionProfileId>('owner-state-fixture'),
  nativeSessionId: brandString<CodingSessionNativeId>('11111111-1111-4111-8111-111111111111') }
const request = { signal: new AbortController().signal, limit: 4, maxEvents: 20, maxBytes: 100000 }
const acquisition = { ...request, ownerToken: brandString<CodingSessionOwnerToken>('fixture-owner'), nativeProfileUnchanged: true as const }
const completion: ClaudeSequentialTurnReceipt = {
  nativeTurnId: '22222222-2222-4222-8222-222222222222', userMessage: { role: 'user', content: 'Synthetic native input' },
  assistants: [], processExited: true, streamsDrained: true, noObservedPersistenceErrors: true,
}
function native(uuid: string, message: unknown): ClaudeSequentialHistoryMessage {
  return { type: 'user', uuid, message, session_id: source.nativeSessionId, parent_tool_use_id: null, parent_agent_id: null }
}
function snapshot(messages: ClaudeSequentialHistoryMessage[]): CodingSessionSnapshot {
  return { source, title: 'Synthetic original', cwd: '/fixture/project', writerState: 'unknown', cursor: codingSessionDigest(messages),
    events: messages.map(message => ({ id: brandString<CodingSessionEventId>(message.uuid), role: message.type,
      text: JSON.stringify(message.message), digest: codingSessionDigest(message) })) }
}
function fixture() {
  const messages = [native('original-user', { role: 'user', content: 'Original synthetic task' })]
  let current = true
  const reads = vi.fn(async () => snapshot(messages))
  const raw = vi.fn(async () => structuredClone(messages))
  const close = vi.fn(async () => {})
  const turn = vi.fn<ClaudeSequentialExecutor['turn']>(async (_text, _signal, beforeDispatch) => {
    await beforeDispatch()
    messages.push(native(completion.nativeTurnId, completion.userMessage))
    return completion
  })
  const executor: ClaudeSequentialExecutor = { current: () => current, turn, close }
  const owner = createClaudeSequentialWriter({ ...source, connected: () => true }, { snapshot: reads, messages: raw }, () => executor)
  return { owner, reads, raw, close, turn, snapshot: () => snapshot(messages),
    appendExternal: () => { messages.push(native('external-user', { role: 'user', content: 'Synthetic external change' })) },
    stale: () => { current = false } }
}

it('reads only an unchanged current owner and refuses reads after confirmed release', async () => {
  const f = fixture(); const lease = await f.owner.writer.acquire(source, acquisition)
  expect(await lease.read(request)).toEqual(f.snapshot())
  expect(f.turn).not.toHaveBeenCalled()
  await lease.release(request)
  const reads = f.reads.mock.calls.length
  await expect(lease.read(request)).rejects.toThrow('no longer current')
  expect(f.reads).toHaveBeenCalledTimes(reads)
})

it('refuses an externally changed read without dispatch and keeps the original owner held', async () => {
  const f = fixture(); const lease = await f.owner.writer.acquire(source, acquisition)
  f.appendExternal()
  await expect(lease.read(request)).rejects.toThrow('changed outside its owned turn')
  expect(f.turn).not.toHaveBeenCalled()
  await expect(lease.release(request)).rejects.toThrow('changed before external release')
  await expect(f.owner.writer.acquire(source, acquisition)).rejects.toThrow('another owner')
  await f.owner.close()
})

it('does not read a removed initiating root or a failed native owner', async () => {
  const stale = fixture(); const removedLease = await stale.owner.writer.acquire(source, acquisition)
  stale.stale(); const before = stale.reads.mock.calls.length
  await expect(removedLease.read(request)).rejects.toThrow('no longer current')
  expect(stale.reads).toHaveBeenCalledTimes(before)
  await removedLease.release(request)
  const failed = fixture(); const failedLease = await failed.owner.writer.acquire(source, acquisition)
  failed.turn.mockRejectedValueOnce(new Error('Synthetic native process failed'))
  await expect(failedLease.resumeOriginal({ source, text: 'Synthetic native input', signal: request.signal,
    beforeDispatch: async () => {} })).rejects.toThrow('uncertain')
  const failedReads = failed.reads.mock.calls.length
  await expect(failedLease.read(request)).rejects.toThrow('no longer current')
  expect(failed.reads).toHaveBeenCalledTimes(failedReads)
  await failed.owner.close()
})

it('retains a healthy receipt when its verification changes and accepts it only after stable release readback', async () => {
  const f = fixture(); const lease = await f.owner.writer.acquire(source, acquisition)
  const stable = f.reads.getMockImplementation()
  if (stable === undefined) throw new Error('Fixture snapshot reader is absent')
  f.raw.mockImplementationOnce(async () => {
    f.reads.mockResolvedValueOnce({ ...f.snapshot(), cursor: 'changed-during-verification' })
    return f.snapshot().events.map(event => native(event.id, event.id === completion.nativeTurnId
      ? completion.userMessage : { role: 'user', content: 'Original synthetic task' }))
  })
  await expect(lease.resumeOriginal({ source, text: 'Synthetic native input', signal: request.signal,
    beforeDispatch: async () => {} })).rejects.toThrow('uncertain')
  await expect(lease.read(request)).rejects.toThrow('no longer current')
  expect(f.turn).toHaveBeenCalledOnce()
  f.reads.mockImplementation(stable)
  const released = await lease.release(request)
  expect(released).toMatchObject({ completedTurnPersisted: true, nativeTurnIds: [completion.nativeTurnId],
    expectedPrefixPersisted: true })
  expect(f.turn).toHaveBeenCalledOnce()
})

it('refuses a different original identity during acquisition and closes its captured executor', async () => {
  const f = fixture()
  f.reads.mockResolvedValueOnce({ ...f.snapshot(), source: {
    ...source, nativeSessionId: brandString<CodingSessionNativeId>('33333333-3333-4333-8333-333333333333'),
  } })
  await expect(f.owner.writer.acquire(source, acquisition)).rejects.toThrow('acquisition could not be confirmed')
  expect(f.close).toHaveBeenCalledOnce(); expect(f.turn).not.toHaveBeenCalled()
  await expect(f.owner.writer.acquire(source, acquisition)).rejects.toThrow('another owner')
  await f.owner.close()
})

it('retains failed acquisition when native preparation returns no executor and never reads a history', async () => {
  const reads = vi.fn(async () => snapshot([]))
  const raw = vi.fn(async () => [])
  const executorFor = vi.fn(async () => { throw new Error('Synthetic native preparation failed') })
  const owner = createClaudeSequentialWriter({ ...source, connected: () => true }, { snapshot: reads, messages: raw }, executorFor)
  await expect(owner.writer.acquire(source, acquisition)).rejects.toThrow('acquisition could not be confirmed')
  expect(executorFor).toHaveBeenCalledOnce(); expect(reads).not.toHaveBeenCalled(); expect(raw).not.toHaveBeenCalled()
  await expect(owner.writer.acquire(source, acquisition)).rejects.toThrow('another owner')
  expect(executorFor).toHaveBeenCalledOnce()
  await owner.close()
})

it('refuses a fresh read for a different original identity before returning its history', async () => {
  const f = fixture(); const lease = await f.owner.writer.acquire(source, acquisition)
  f.reads.mockResolvedValueOnce({ ...f.snapshot(), source: {
    ...source, nativeSessionId: brandString<CodingSessionNativeId>('33333333-3333-4333-8333-333333333333'),
  } })
  await expect(lease.read(request)).rejects.toThrow('different original source')
  expect(f.turn).not.toHaveBeenCalled()
  await lease.release(request)
})

it('refuses release while an admitted turn remains unresolved despite an early executor close', async () => {
  const f = fixture(); const lease = await f.owner.writer.acquire(source, acquisition)
  const entered = Promise.withResolvers<undefined>(); const settled = Promise.withResolvers<ClaudeSequentialTurnReceipt>()
  f.turn.mockImplementationOnce(async () => { entered.resolve(undefined); return settled.promise })
  const turn = lease.resumeOriginal({ source, text: 'Synthetic native input', signal: request.signal,
    beforeDispatch: async () => {} })
  const uncertain = expect(turn).rejects.toThrow('uncertain')
  await entered.promise
  await expect(lease.release(request)).rejects.toThrow('admitted native work is unresolved')
  expect(f.close).toHaveBeenCalledOnce()
  await expect(f.owner.writer.acquire(source, acquisition)).rejects.toThrow('another owner')
  settled.resolve(completion); await uncertain
  await f.owner.close()
})

it('reports executor disposal failure after every admitted close has settled and keeps the writer closed', async () => {
  const f = fixture(); await f.owner.writer.acquire(source, acquisition)
  const failure = new Error('Synthetic executor close failed')
  f.close.mockRejectedValueOnce(failure)
  await expect(f.owner.close()).rejects.toBe(failure)
  expect(f.close).toHaveBeenCalledOnce(); expect(f.turn).not.toHaveBeenCalled()
  await expect(f.owner.writer.acquire(source, acquisition)).rejects.toThrow('another owner')
  await f.owner.close()
})
