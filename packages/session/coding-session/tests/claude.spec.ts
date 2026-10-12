/** Installed-SDK read fixtures use original UUIDs and complete chronological pages. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CodingSessionNativeId } from '../src/types.ts'
import { createClaudeCodingSessionProvider } from '../src/claude.ts'
import type { ClaudeSessionSdk } from '../src/claude.ts'
const original = brandString<CodingSessionNativeId>('11111111-1111-4111-8111-111111111111')
const request = { signal: new AbortController().signal, limit: 2, maxEvents: 10, maxBytes: 10000 }
afterEach(() => { vi.unstubAllEnvs() })
function fixture() {
  const messages = [{ type: 'user' as const, uuid: 'uuid-1', session_id: original, message: { role: 'user', content: 'Inspect parser' }, parent_tool_use_id: null, parent_agent_id: null },
    { type: 'assistant' as const, uuid: 'uuid-2', session_id: original, message: { role: 'assistant', content: [{ type: 'text', text: 'Parser checked' }] }, parent_tool_use_id: null, parent_agent_id: null },
    { type: 'system' as const, uuid: 'uuid-3', session_id: original, message: { content: 'Compaction boundary' }, parent_tool_use_id: null, parent_agent_id: null }]
  const calls: object[] = []
  const sdk: ClaudeSessionSdk = { listSessions: async (options) => { calls.push(options!); return [{ sessionId: original, summary: 'Repair parser', lastModified: 10, cwd: '/project' }] },
    getSessionInfo: async () => ({ sessionId: original, summary: 'Repair parser', lastModified: 10, cwd: '/project' }),
    getSessionMessages: async (id, options) => {
      calls.push({ id, ...options })
      return messages.slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? messages.length))
    },
  }
  return { sdk, calls, messages, provider: createClaudeCodingSessionProvider('local-sdk-project', 'Claude /project', '/project', async () => sdk) }
}
describe('Claude coding-session SDK adapter', () => {
  it('invalidates the captured native profile when the SDK root changes', async () => {
    const f = fixture(); vi.stubEnv('CLAUDE_CONFIG_DIR', '/different-native-profile')
    expect(f.provider.connected()).toBe(false)
    await expect(f.provider.read(original, request)).rejects.toThrow('profile')
    expect(f.calls).toEqual([])
  })
  it('discovers within the configured project and interprets an offset cursor', async () => {
    const f = fixture(); const page = await f.provider.discover(request, 'offset:2')
    expect(f.calls[0]).toEqual({ dir: '/project', limit: 2, offset: 2, includeWorktrees: false, includeProgrammatic: true })
    expect(page.items[0]?.source).toEqual({ provider: 'claude', profileId: 'local-sdk-project', nativeSessionId: original })
  })
  it('reads both full passes using original UUID, stable message IDs, and SDK pagination', async () => {
    const f = fixture(); const snapshot = await f.provider.read(original, request)
    expect(snapshot.events.map(event => [event.id, event.role, event.text])).toEqual([['uuid-1', 'user', 'Inspect parser'], ['uuid-2', 'assistant', 'Parser checked'], ['uuid-3', 'system', 'Compaction boundary']])
    expect(f.calls).toEqual([0, 2, 0, 2].map(offset => ({ id: original, dir: '/project', limit: 2, offset, includeSystemMessages: true })))
    expect(f.provider).not.toHaveProperty('writer')
  })
  it('rejects cross-session SDK messages and malformed offset cursors', async () => {
    const f = fixture(); f.messages[0]!.session_id = brandString<CodingSessionNativeId>('replacement')
    await expect(f.provider.read(original, request)).rejects.toThrow('original')
    await expect(f.provider.discover(request, 'offset:-1')).rejects.toThrow('cursor')
  })
  it('rejects edited native history between read passes', async () => {
    const f = fixture(); let count = 0; const read = f.sdk.getSessionMessages
    f.sdk.getSessionMessages = async (id, options) => { const value = await read(id, options); if (count++ > 1) value[0] = { ...value[0]!, message: { content: 'Changed' } }; return value }
    await expect(f.provider.read(original, request)).rejects.toThrow('changed')
  })
  it('honors cancelled reads and rejects missing source sessions instead of making an empty mirror', async () => {
    const f = fixture(); const signal = AbortSignal.abort(new Error('cancelled'))
    await expect(f.provider.read(original, { ...request, signal })).rejects.toThrow('cancelled')
    f.sdk.getSessionInfo = async () => undefined; await expect(f.provider.read(original, request)).rejects.toThrow('found')
  })
  it.each(['removed', 'metadata-changed'])('rejects a source %s during a complete history pass', async (mode) => {
    const f = fixture(); const info = await f.sdk.getSessionInfo(original)
    let reads = 0
    f.sdk.getSessionInfo = async () => reads++ === 0 ? info : mode === 'removed' ? undefined : { ...info!, lastModified: 11, summary: 'Changed native title' }
    if (mode === 'removed') f.sdk.getSessionMessages = async () => []
    await expect(f.provider.read(original, request)).rejects.toThrow()
  })
})
