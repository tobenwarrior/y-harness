import type { SDKMessage, SDKAssistantMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { consumeClaudeQuery } from '../src/run.ts'
import { assistantBody } from './sdk-message-fixture.ts'

const sessionId = 'sdk-native-session'
const sourceMessageId = '00000000-0000-4000-8000-000000000001'

function call(id: string, name = 'Read', input: unknown = {}): SDKAssistantMessage {
  return {
    type: 'assistant', uuid: sourceMessageId, session_id: sessionId, parent_tool_use_id: null,
    message: assistantBody([{ type: 'tool_use', id, name, input }]),
  }
}

function receipt(id: string, isError?: boolean, toolResult?: unknown): SDKUserMessage {
  return {
    type: 'user', session_id: sessionId, parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, ...isError === undefined ? {} : { is_error: isError }, content: 'SECRET_TOOL_OUTPUT' }] },
    tool_use_result: toolResult,
  }
}

function completed(): SDKMessage {
  return { type: 'result', subtype: 'success', result: 'Final claim, not independent verification', is_error: false } as SDKMessage
}

async function capture(messages: SDKMessage[], maxItems = 8): Promise<readonly unknown[]> {
  const observed: unknown[] = []
  async function* stream() { yield* messages; yield completed() }
  await consumeClaudeQuery(stream(), undefined, undefined, {
    maxItems,
    sink: (items: readonly unknown[]) => { observed.push(...items) },
  })
  return observed
}

describe('direct native SDK tool observations', () => {
  it('retains actual call identity and reported results without arguments or output', async () => {
    expect(await capture([
      call('tool-read', 'Read', { file_path: '/private/SECRET_INPUT' }),
      call('tool-shell', 'Bash', { command: 'SECRET_COMMAND' }),
      receipt('tool-shell', true, { stdout: '', stderr: '', interrupted: false }), receipt('tool-read', false),
    ])).toEqual([
      { provider: 'claude-code', sessionId, sourceMessageId, itemId: 'tool-read', kind: 'read', name: 'Read', outcome: 'reported-success' },
      { provider: 'claude-code', sessionId, sourceMessageId, itemId: 'tool-shell', kind: 'command', name: 'Bash', outcome: 'reported-error' },
    ])
  })

  it('keeps an omitted error flag unknown instead of treating completion as success', async () => {
    expect(await capture([call('tool-unknown'), receipt('tool-unknown')])).toEqual([
      { provider: 'claude-code', sessionId, sourceMessageId, itemId: 'tool-unknown', kind: 'read', name: 'Read', outcome: 'unknown' },
    ])
  })

  it('excludes nested workers, replayed results, unsupported tools and orphan receipts', async () => {
    const nested = { ...call('nested'), parent_tool_use_id: 'Agent-parent' } as SDKMessage
    const replay = { ...receipt('replayed', false), isReplay: true } as SDKMessage
    expect(await capture([
      nested, receipt('nested', false), call('replayed'), replay,
      call('agent', 'Agent'), receipt('agent', false),
      call('mcp', 'mcp__server__tool'), receipt('mcp', false), receipt('orphan', false),
      call('direct'), receipt('direct', false),
    ])).toEqual([
      { provider: 'claude-code', sessionId, sourceMessageId, itemId: 'direct', kind: 'read', name: 'Read', outcome: 'reported-success' },
    ])
  })

  it('invalidates duplicate calls and receipts and mismatched native sessions', async () => {
    expect(await capture([
      call('duplicate-call'), call('duplicate-call'), receipt('duplicate-call', false),
      call('duplicate-result'), receipt('duplicate-result', false), receipt('duplicate-result', false),
      call('wrong-session'), { ...receipt('wrong-session', false), session_id: 'other-session' },
    ])).toEqual([])
  })

  it('invalidates background placeholders even when their task metadata arrives later', async () => {
    expect(await capture([
      call('requested-background', 'Bash', { run_in_background: true }), receipt('requested-background', false),
      call('automatic-background', 'Bash'), receipt('automatic-background', false, { backgroundTaskId: 'background-id' }),
      call('late-background', 'Bash'), receipt('late-background', false, { stdout: '', stderr: '', interrupted: false }),
      { type: 'system', subtype: 'task_started', tool_use_id: 'late-background' } as SDKMessage,
    ])).toEqual([])
  })

  it('excludes interrupted Bash receipts despite an explicit non-error result', async () => {
    expect(await capture([
      call('interrupted', 'Bash'), receipt('interrupted', false, { stdout: '', stderr: '', interrupted: true }),
    ])).toEqual([])
  })

  it('excludes unstructured Bash receipts that cannot rule out background placeholders', async () => {
    expect(await capture([call('placeholder', 'Bash'), receipt('placeholder', false)])).toEqual([])
  })

  it('does not resurrect calls after earlier task metadata identifies background work', async () => {
    expect(await capture([
      { type: 'system', subtype: 'task_started', tool_use_id: 'background' } as SDKMessage,
      call('background', 'Bash'), receipt('background', false, { stdout: '', stderr: '', interrupted: false }),
    ])).toEqual([])
  })

  it('invalidates the complete batch when its configured identity bound is exceeded', async () => {
    expect(await capture([
      call('one'), receipt('one', false), call('two'), receipt('two', false),
      call('three'), receipt('three', false),
    ], 2)).toEqual([])
  })

  it('does not publish a partial batch after an iterator failure', async () => {
    const observed: unknown[] = []
    async function* stream() {
      yield call('unfinished'); yield receipt('unfinished', false)
      throw new Error('SDK stream failed')
    }
    await expect(consumeClaudeQuery(stream(), undefined, undefined, {
      maxItems: 8, sink: (items: readonly unknown[]) => { observed.push(...items) },
    })).rejects.toThrow('SDK stream failed')
    expect(observed).toEqual([])
  })

  it('contains observation sink failures without changing the SDK result', async () => {
    async function* stream() { yield call('tool'); yield receipt('tool', false); yield completed() }
    await expect(consumeClaudeQuery(stream(), undefined, undefined, {
      maxItems: 8, sink: () => { throw new Error('consumer failed') },
    })).resolves.toMatchObject({ stopReason: 'completed' })
  })

  it('accepts explicit live replay flags and preserves actual receipt message ids', async () => {
    const resultMessageId = '00000000-0000-4000-8000-000000000002'
    expect(await capture([
      call('live'), Object.assign(receipt('live', false), { isReplay: false, uuid: resultMessageId }),
    ])).toEqual([{
      provider: 'claude-code', sessionId, sourceMessageId, resultMessageId,
      itemId: 'live', kind: 'read', name: 'Read', outcome: 'reported-success',
    }])
  })

  it('excludes receipts whose native session identity is absent', async () => {
    const message = receipt('missing-session', false)
    if (message.type === 'user') delete message.session_id
    expect(await capture([call('missing-session'), message])).toEqual([])
  })
})
