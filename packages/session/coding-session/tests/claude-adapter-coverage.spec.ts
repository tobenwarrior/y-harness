/** SDK fixtures exercise project-scoped projection, complete read bounds and late cancellation. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createClaudeCodingSessionProvider } from '../src/claude.ts'
import type { ClaudeSessionSdk } from '../src/claude.ts'
import type { CodingSessionNativeId } from '../src/types.ts'

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  listSessions: async (options: { dir?: string }) => {
    if (options.dir !== '/fixture/default-project') throw new Error('Unexpected lazy SDK project')
    return []
  },
  getSessionInfo: async () => undefined,
  getSessionMessages: async () => [],
}))
const original = brandString<CodingSessionNativeId>('11111111-1111-4111-8111-111111111111')
const request = { signal: new AbortController().signal, limit: 2, maxEvents: 10, maxBytes: 10000 }
const metadata = { sessionId: original, summary: 'Fixture history', lastModified: 1 }
type Message = Awaited<ReturnType<ClaudeSessionSdk['getSessionMessages']>>[number]
const frame = (message: unknown, uuid = '22222222-2222-4222-8222-222222222222'): Message => ({
  type: 'user', uuid, session_id: original, message, parent_tool_use_id: null, parent_agent_id: null,
})
function fixture(message: unknown = { content: 'Fixture message' }) {
  const messages: Message[] = [frame(message)]
  const calls: string[] = []
  const sdk: ClaudeSessionSdk = {
    listSessions: async () => { calls.push('list'); return [metadata] },
    getSessionInfo: async () => { calls.push('info'); return metadata },
    getSessionMessages: async (_id, options) => {
      calls.push('messages')
      const offset = options?.offset ?? 0
      return messages.slice(offset, offset + (options?.limit ?? messages.length))
    },
  }
  const provider = createClaudeCodingSessionProvider('fixture-profile', 'Fixture Claude', '/fixture/project', async () => sdk)
  return { sdk, provider, messages, calls }
}
afterEach(() => { vi.unstubAllEnvs() })

describe('Claude SDK reader admission and projection', () => {
  it('rejects unsafe cursor offsets before resolving a history SDK', async () => {
    const f = fixture()
    await expect(f.provider.discover(request, 'offset:9007199254740992')).rejects.toThrow('cursor')
    expect(f.calls).toEqual([])
  })
  it('rejects relative project and explicit profile configuration without an SDK read', () => {
    const f = fixture()
    expect(() => createClaudeCodingSessionProvider('profile', 'Fixture', 'relative-project', async () => f.sdk)).toThrow('absolute')
    expect(() => createClaudeCodingSessionProvider('profile', 'Fixture', '/fixture/project', async () => f.sdk,
      { profileRoot: 'relative-profile', connected: () => true })).toThrow('absolute')
    expect(f.calls).toEqual([])
  })
  it('loads the lazy default SDK only for a scoped discovery using a fixture module', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', undefined)
    const provider = createClaudeCodingSessionProvider('default-profile', 'Fixture', '/fixture/default-project')
    expect(provider.connected()).toBe(true)
    expect(await provider.discover(request)).toEqual({ items: [] })
  })
  it('retains the explicit profile root despite parent environment changes and denies a revoked connection', async () => {
    const f = fixture(); let connected = true
    const provider = createClaudeCodingSessionProvider('explicit-profile', 'Fixture', '/fixture/project', async () => f.sdk,
      { profileRoot: '/fixture/explicit-profile', connected: () => connected })
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/fixture/unrelated-parent')
    expect((await provider.discover(request)).items[0]?.source.profileId).toBe('explicit-profile')
    connected = false
    await expect(provider.read(original, request)).rejects.toThrow('profile')
    expect(f.calls).toEqual(['list'])
  })
  it('publishes source-specific titles, optional projects and an exact continuation cursor', async () => {
    const f = fixture()
    f.sdk.listSessions = async (options) => {
      if (options?.offset !== 12 || options.limit !== 2 || options.includeWorktrees !== false || options.includeProgrammatic !== true) {
        throw new Error('Discovery scope changed')
      }
      return [{ ...metadata, customTitle: '' }, { ...metadata, sessionId: '33333333-3333-4333-8333-333333333333', cwd: '/fixture/project' }]
    }
    expect(await f.provider.discover(request, 'offset:12')).toEqual({ items: [
      { source: { provider: 'claude', profileId: 'fixture-profile', nativeSessionId: original }, title: '', writerState: 'unknown' },
      { source: { provider: 'claude', profileId: 'fixture-profile', nativeSessionId: '33333333-3333-4333-8333-333333333333' },
        title: 'Fixture history', cwd: '/fixture/project', writerState: 'unknown' },
    ], nextCursor: 'offset:14' })
  })
  it.each([
    [null, '[Native user message]'],
    [{ content: 7 }, '[Native user message]'],
    [{ content: [] }, ''],
    [{ content: [{ type: 'text', text: 'Visible text' }, { type: 'text' },
      { type: 'tool_use', input: { hidden: 'Fixture-only tool payload' } }, { type: 'thinking', text: 'Fixture-only reasoning' }] },
    'Visible text\n\n[Native tool_use block]\n[Native thinking block]'],
  ] satisfies Array<[unknown, string]>)('projects untrusted native body %j into readable bounded text', async (body, text) => {
    const f = fixture(body); const snapshot = await f.provider.read(original, request)
    expect(snapshot.title).toBe('Fixture history'); expect(snapshot).not.toHaveProperty('cwd')
    expect(snapshot.events).toHaveLength(1)
    expect(snapshot.events[0]).toMatchObject({ id: '22222222-2222-4222-8222-222222222222', role: 'user', text })
    expect(snapshot.events[0]?.digest).toMatch(/^[a-f0-9]{64}$/)
  })
  it('uses original metadata title and project from a stable full read', async () => {
    const f = fixture(); f.sdk.getSessionInfo = async () => ({ ...metadata, customTitle: 'Original fixture title', cwd: '/fixture/project' })
    expect(await f.provider.read(original, request)).toMatchObject({ title: 'Original fixture title', cwd: '/fixture/project' })
  })
  it('rejects metadata for another original session before reading its history', async () => {
    const f = fixture(); f.sdk.getSessionInfo = async () => ({ ...metadata, sessionId: '33333333-3333-4333-8333-333333333333' })
    await expect(f.provider.read(original, request)).rejects.toThrow('original native session')
    expect(f.calls).toEqual([])
  })
  it('bounds complete multibyte metadata before reading any history page', async () => {
    const f = fixture(); f.sdk.getSessionInfo = async () => ({ ...metadata, summary: '雪'.repeat(300) })
    await expect(f.provider.read(original, { ...request, maxBytes: 500 })).rejects.toThrow('metadata exceeded')
    expect(f.calls).toEqual([])
  })
  it('refuses an SDK page larger than the requested page limit', async () => {
    const f = fixture(); f.sdk.getSessionMessages = async () => [frame({ content: 'one' }), frame({ content: 'two' }), frame({ content: 'three' })]
    await expect(f.provider.read(original, request)).rejects.toThrow('history exceeded')
  })
  it('counts raw multibyte messages and cumulative pages before publication', async () => {
    const f = fixture({ content: '雪'.repeat(300) })
    await expect(f.provider.read(original, { ...request, maxBytes: 500 })).rejects.toThrow('history exceeded')
    f.messages.splice(0, 1, frame({ content: 'A'.repeat(80) }), frame({ content: 'B'.repeat(80) }))
    await expect(f.provider.read(original, { ...request, limit: 1, maxBytes: 500 })).rejects.toThrow('history exceeded')
  })
  it('bounds projected placeholder expansion even when raw messages fit', async () => {
    const f = fixture({ content: Array.from({ length: 100 }, () => ({ type: 'x' })) })
    expect(Buffer.byteLength(JSON.stringify(f.messages), 'utf8')).toBeLessThanOrEqual(1600)
    await expect(f.provider.read(original, { ...request, maxBytes: 1600 })).rejects.toThrow('history exceeded')
  })
  it('bounds total event count independently of a fitting raw byte count', async () => {
    const f = fixture(); f.messages.push(frame({ content: 'Second fixture event' }, '33333333-3333-4333-8333-333333333333'))
    await expect(f.provider.read(original, { ...request, maxEvents: 1 })).rejects.toThrow('history exceeded')
  })
  it.each(['resolve', 'list', 'info', 'messages'] as const)('fences cancellation after the %s await before publishing history', async (stage) => {
    const f = fixture(); const controller = new AbortController()
    const cancel = () => { controller.abort(new Error('Fixture cancelled')) }
    const list = f.sdk.listSessions; const info = f.sdk.getSessionInfo; const messages = f.sdk.getSessionMessages
    if (stage === 'list') f.sdk.listSessions = async (options) => { const value = await list(options); cancel(); return value }
    if (stage === 'info') f.sdk.getSessionInfo = async (id, options) => { const value = await info(id, options); cancel(); return value }
    if (stage === 'messages') f.sdk.getSessionMessages = async (id, options) => { const value = await messages(id, options); cancel(); return value }
    const provider = createClaudeCodingSessionProvider('cancel-profile', 'Fixture', '/fixture/project', async () => {
      if (stage === 'resolve') cancel()
      return f.sdk
    })
    const reading = stage === 'list' || stage === 'resolve' ? provider.discover({ ...request, signal: controller.signal })
      : provider.read(original, { ...request, signal: controller.signal })
    await expect(reading).rejects.toThrow('Fixture cancelled')
    expect(f.calls).toEqual(stage === 'resolve' ? [] : stage === 'list' ? ['list'] : stage === 'info' ? ['info'] : ['info', 'messages'])
  })
})
