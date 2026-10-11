import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CodingSessionNativeId, CodingSessionReadRequest } from '@deepseek-ai/dsh-coding-session/types'
import { createCodexCodingSessionProvider } from '../src/codex-coding-sessions.ts'
import type { CodexCodingSessionReader } from '../src/codex-coding-sessions.ts'

const nativeId = brandString<CodingSessionNativeId>('fixture-original')
const read = (fields: Partial<CodingSessionReadRequest> = {}): CodingSessionReadRequest => ({
  signal: new AbortController().signal, limit: 3, maxEvents: 10, maxBytes: 10000, ...fields,
})
const thread = (fields: Record<string, unknown> = {}) => ({
  id: nativeId, name: null, preview: 'Fixture history', cwd: '/fixture/project', updatedAt: 1,
  historyMode: 'paginated', status: { type: 'idle' }, turns: [], ...fields,
})
const turn = (fields: Record<string, unknown> = {}) => ({ id: 'turn-1', status: 'completed', items: [], ...fields })
const head = (fields: Record<string, unknown> = {}) => ({ thread: thread(fields) })

function scripted(responses: unknown[]) {
  const methods: string[] = []
  const reader: CodexCodingSessionReader = { connected: () => true, request: async (method) => {
    methods.push(method)
    if (responses.length === 0) throw new Error('Unexpected fixture request')
    return responses.shift()
  } }
  return { provider: createCodexCodingSessionProvider('fixture-profile', 'Fixture', () => reader), methods }
}

describe('Codex history import limits', () => {
  it.each([
    ['turn page count', [head(), { data: [], nextCursor: 'next' }], read({ maxEvents: 1 }), /turn pagination/],
    ['turn count', [head(), { data: [turn(), turn({ id: 'turn-2' })] }], read({ maxEvents: 1 }), /turn list/],
    ['turn page size', [head(), { data: [turn(), turn({ id: 'turn-2' })] }], read({ limit: 1 }), /turn list/],
    ['repeated turn identity', [head(), { data: [turn(), turn()] }, { data: [] }], read(), /turn identity/],
    ['repeated turn cursor', [head(), { data: [], nextCursor: 'same' }, { data: [], nextCursor: 'same' }], read(), /turn cursor/],
    ['item page count', [head(), { data: [turn()] }, { data: [], nextCursor: 'next' }], read({ maxEvents: 1 }), /item pagination/],
    ['repeated item cursor', [head(), { data: [turn()] }, { data: [], nextCursor: 'same' }, { data: [], nextCursor: 'same' }], read(), /item cursor/],
    ['item page size', [head(), { data: [turn()] }, { data: [
      { turnId: 'turn-1', item: { id: 'a', type: 'reasoning' } },
      { turnId: 'turn-1', item: { id: 'b', type: 'reasoning' } },
    ] }], read({ limit: 1 }), /event limit/],
    ['event count', [head(), { data: [turn()] }, { data: [
      { turnId: 'turn-1', item: { id: 'a', type: 'reasoning' } },
      { turnId: 'turn-1', item: { id: 'b', type: 'reasoning' } },
    ] }], read({ maxEvents: 1 }), /event limit/],
    ['turn page bytes', [head(), { data: [turn({ extra: 'x'.repeat(1000) })] }], read({ maxBytes: 100 }), /byte limit/],
    ['final metadata bytes', [head(), { data: [] }, head({ preview: 'x'.repeat(1000) })], read({ maxBytes: 100 }), /byte limit/],
  ])('refuses %s before returning any imported snapshot', async (_name, responses, request, message) => {
    const fixture = scripted(responses)
    await expect(fixture.provider.read(nativeId, request)).rejects.toThrow(message)
    expect(fixture.methods.every(method => ['thread/read', 'thread/turns/list', 'thread/items/list'].includes(method))).toBe(true)
  })

  it.each([
    [{ id: 'replacement' }, /original native session/],
    [{ historyMode: 'paginated' }, /history mode/],
    [{ status: { type: 'active' } }, /active/],
    [{ turns: [turn({ status: 'inProgress' })] }, /active/],
  ])('refuses changed legacy metadata %j', async (fields, message) => {
    const fixture = scripted([head({ historyMode: 'legacy' }), head({ historyMode: 'legacy', ...fields })])
    await expect(fixture.provider.read(nativeId, read())).rejects.toThrow(message)
  })

  it.each([
    [read({ maxBytes: 100 }), [turn({ items: [{ id: 'a', type: 'agentMessage', text: 'x'.repeat(1000) }] })], /byte limit/],
    [read({ maxEvents: 1 }), [turn({ items: [{ id: 'a', type: 'reasoning' }, { id: 'b', type: 'reasoning' }] })], /event limit/],
  ])('bounds complete legacy history', async (request, turns, message) => {
    const fixture = scripted([head({ historyMode: 'legacy' }), head({ historyMode: 'legacy', turns })])
    await expect(fixture.provider.read(nativeId, request)).rejects.toThrow(message)
  })

  it('keeps transcript order and projects multimodal inputs and opaque native items', async () => {
    const turns = [turn({ items: [
      { id: 'u', type: 'userMessage', content: [{ type: 'text' }, { type: 'image' }, { type: 'text', text: 'Inspect' }] },
      { id: 'r', type: 'reasoning', text: 'Private native reasoning' },
      { id: 't', type: 'commandExecution', command: 'Private command' },
      { id: 'a', type: 'agentMessage', text: 'Result' },
    ] })]
    const fixture = scripted([head({ historyMode: 'legacy' }), head({ historyMode: 'legacy', turns }), head({ historyMode: 'legacy', turns })])
    const snapshot = await fixture.provider.read(nativeId, read())
    expect(snapshot.title).toBe('Fixture history')
    expect(snapshot.events.map(event => [event.role, event.text])).toEqual([
      ['user', '\n[Native image input]\nInspect'], ['system', '[Native reasoning item]'],
      ['tool', '[Native commandExecution item]'], ['assistant', 'Result'],
    ])
    expect(snapshot.events.map(event => event.id)).toEqual(['["turn-1","u"]', '["turn-1","r"]', '["turn-1","t"]', '["turn-1","a"]'])
    expect(JSON.stringify(snapshot)).not.toMatch(/Private native reasoning|Private command/)
  })

  it('discovers active and unknown writer states without claiming idle ownership', async () => {
    const fixture = scripted([{ data: [thread({ status: { type: 'active' } }), thread({ id: 'not-loaded', status: { type: 'notLoaded' } })], nextCursor: null }])
    expect(await fixture.provider.discover(read())).toMatchObject({ items: [{ title: 'Fixture history', writerState: 'active' }, { writerState: 'unknown' }] })
    expect(fixture.provider).not.toHaveProperty('writer')
  })

  it('refuses an absent reader and observes cancellation after the native response', async () => {
    const absent = createCodexCodingSessionProvider('fixture-profile', 'Fixture', () => undefined)
    expect(absent.connected()).toBe(false)
    await expect(absent.discover(read())).rejects.toThrow(/not connected/)
    const abort = new AbortController()
    const provider = createCodexCodingSessionProvider('fixture-profile', 'Fixture', () => ({
      connected: () => true, request: async () => { abort.abort(new Error('Fixture cancelled')); return { data: [] } },
    }))
    await expect(provider.discover(read({ signal: abort.signal }))).rejects.toThrow('Fixture cancelled')
  })
})
