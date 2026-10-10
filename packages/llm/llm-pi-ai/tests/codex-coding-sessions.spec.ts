/** Connected-native read fixtures preserve original IDs and refuse unstable snapshots. */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CodingSessionNativeId } from '@deepseek-ai/dsh-coding-session/types'
import { createCodexCodingSessionProvider } from '../src/codex-coding-sessions.ts'
const nativeId = brandString<CodingSessionNativeId>('native-123')
const thread = () => ({ historyMode: 'legacy', id: 'native-123', name: 'Fix parser', preview: 'Inspect parser', cwd: '/project', updatedAt: 10, status: { type: 'idle' }, turns: [
  { id: 'turn-1', status: 'completed', items: [{ id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Inspect parser' }] }, { id: 'assistant-1', type: 'agentMessage', text: 'Parser checked' }] },
] })
const request = { signal: new AbortController().signal, limit: 20, maxEvents: 50, maxBytes: 10000 }
function fixture() {
  const calls: Array<{ method: string; params: object }> = []
  let current = thread()
  let connected = true
  const provider = createCodexCodingSessionProvider('configured-home', 'Local Codex', () => ({ connected: () => connected,
    request: async (method, params) => { calls.push({ method, params }); return method === 'thread/list' ? { data: [current], nextCursor: 'next-native' } : { thread: structuredClone(current) } },
  }))
  return { provider, calls, set: (value: ReturnType<typeof thread>) => { current = value }, disconnect: () => { connected = false } }
}
describe('Codex coding session read adapter', () => {
  it('passes opaque pagination and labels every source with its configured connection', async () => {
    const f = fixture(); const page = await f.provider.discover(request, 'old-native')
    expect(page).toMatchObject({ nextCursor: 'next-native', items: [{ source: { provider: 'codex', profileId: 'configured-home', nativeSessionId: 'native-123' }, title: 'Fix parser' }] })
    expect(f.calls).toEqual([{ method: 'thread/list', params: { limit: 20, cursor: 'old-native', sortKey: 'updated_at', sortDirection: 'desc', useStateDbOnly: true } }])
  })
  it('reads the original thread twice and keeps stable native turn/item identities', async () => {
    const f = fixture(); const snapshot = await f.provider.read(nativeId, request)
    expect(f.calls).toEqual([{ method: 'thread/read', params: { threadId: 'native-123', includeTurns: false } }, { method: 'thread/read', params: { threadId: 'native-123', includeTurns: true } }, { method: 'thread/read', params: { threadId: 'native-123', includeTurns: true } }])
    expect(snapshot.events.map(event => [event.id, event.role, event.text])).toEqual([['["turn-1","user-1"]', 'user', 'Inspect parser'], ['["turn-1","assistant-1"]', 'assistant', 'Parser checked']])
    expect(snapshot.cursor).not.toBe(''); expect(f.provider).not.toHaveProperty('writer')
  })
  it('rejects partial history and active turns instead of silently making a truncated mirror', async () => {
    const f = fixture(); const partial = { ...thread(), turns: [{ ...thread().turns[0]!, itemsView: 'summary' }] }; f.set(partial)
    await expect(f.provider.read(nativeId, request)).rejects.toThrow('complete')
    f.set({ ...thread(), status: { type: 'active' } }); await expect(f.provider.read(nativeId, request)).rejects.toThrow('active')
  })
  it('refuses cross-ID responses and disconnects before returning source history', async () => {
    const f = fixture(); f.set({ ...thread(), id: 'replacement' })
    await expect(f.provider.read(nativeId, request)).rejects.toThrow('original')
    f.disconnect(); await expect(f.provider.discover(request)).rejects.toThrow('connected')
  })
  it('hydrates every paginated turn and item page using original source IDs without full-history persistence', async () => {
    const calls: Array<{ method: string; params: object }> = []
    const provider = createCodexCodingSessionProvider('configured-home', 'Codex', () => ({ connected: () => true, request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'thread/read') return { thread: { ...thread(), historyMode: 'paginated', turns: [] } }
      const fields = params as { cursor?: string; turnId?: string }
      if (method === 'thread/turns/list') return fields.cursor === undefined
        ? { data: [{ id: 'turn-1', status: 'completed', items: [], itemsView: 'notLoaded' }], nextCursor: 'turn-page-2' }
        : { data: [{ id: 'turn-2', status: 'completed', items: [], itemsView: 'notLoaded' }], nextCursor: null }
      if (fields.turnId === 'turn-1') return fields.cursor === undefined
        ? { data: [{ turnId: 'turn-1', item: thread().turns[0]!.items[0] }], nextCursor: 'item-page-2' }
        : { data: [{ turnId: 'turn-1', item: thread().turns[0]!.items[1] }], nextCursor: null }
      return { data: [{ turnId: 'turn-2', item: { id: 'assistant-2', type: 'agentMessage', text: 'Final repair' } }], nextCursor: null }
    } }))
    const snapshot = await provider.read(nativeId, request)
    expect(snapshot.events.map(event => [event.id, event.text])).toEqual([['["turn-1","user-1"]', 'Inspect parser'], ['["turn-1","assistant-1"]', 'Parser checked'], ['["turn-2","assistant-2"]', 'Final repair']])
    expect(calls.filter(value => value.method === 'thread/read').every(value => JSON.stringify(value.params).includes('"includeTurns":false'))).toBe(true)
    expect(calls.filter(value => value.method === 'thread/turns/list')).toHaveLength(4)
    expect(calls.filter(value => value.method === 'thread/items/list')).toHaveLength(6)
    expect(calls.filter(value => value.method === 'thread/items/list').map(value => value.params)).toContainEqual({ threadId: 'native-123', turnId: 'turn-1', limit: 20, sortDirection: 'asc', cursor: 'item-page-2' })
  })
  it.each(['repeated-cursor', 'wrong-turn', 'in-progress', 'oversized'])('refuses %s paginated snapshots', async (mode) => {
    const provider = createCodexCodingSessionProvider('configured-home', 'Codex', () => ({ connected: () => true, request: async (method) => {
      if (method === 'thread/read') return { thread: { ...thread(), historyMode: 'paginated', turns: [] } }
      if (method === 'thread/turns/list') return { data: [{ id: 'turn-1', status: mode === 'in-progress' ? 'inProgress' : 'completed', items: [], itemsView: 'notLoaded' }], nextCursor: mode === 'repeated-cursor' ? 'same' : null }
      return { data: [{ turnId: mode === 'wrong-turn' ? 'different' : 'turn-1', item: { id: 'assistant-1', type: 'agentMessage', text: mode === 'oversized' ? 'x'.repeat(11000) : 'Checked' } }], nextCursor: null }
    } }))
    await expect(provider.read(nativeId, request)).rejects.toThrow()
  })
  it('detects a concurrent native change between full reads', async () => {
    let count = 0
    const provider = createCodexCodingSessionProvider('configured-home', 'Codex', () => ({ connected: () => true, request: async () => {
      const value = thread(); if (count++ > 1) value.turns[0]!.items[1]!.text = 'Concurrent edit'; return { thread: value }
    } }))
    await expect(provider.read(nativeId, request)).rejects.toThrow('changed')
  })
})
