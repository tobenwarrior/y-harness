/** Synthetic external SDK frames exercise receipt attribution without native queries. */
import { expect, it } from 'vitest'
import { z } from 'zod'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SkillLearningNativeItem } from '@deepseek-ai/dsh-skill-library/types'
import { ClaudeRootObservations, nativeIdentity } from '../src/root-observations.ts'
import { createClaudeCodeToolObserver } from '../src/tool-observations.ts'
import { assistantBody } from './sdk-message-fixture.ts'

// JSON is the SDK wire carrier; these negative fixtures are not same-process requests.
const sdkWireEnvelope = z.custom<SDKMessage>(value => typeof value === 'object' && value !== null
  && 'type' in value && ['assistant', 'user', 'system', 'result'].includes(String(value.type)))
function wire(value: object): SDKMessage {
  const decoded: unknown = JSON.parse(JSON.stringify(value))
  return sdkWireEnvelope.parse(decoded)
}
function call(id = 'tool', name = 'Read', input: unknown = { file_path: 'src/a.ts' }, extra: object = {}): SDKMessage {
  return wire({ type: 'assistant', uuid: 'assistant-source', session_id: 'native-session', parent_tool_use_id: null,
    message: assistantBody([{ type: 'tool_use', id, name, input }]), ...extra })
}
function result(id = 'tool', is_error?: boolean, tool_use_result?: unknown, extra: object = {}): SDKMessage {
  return wire({ type: 'user', uuid: 'receipt-source', session_id: 'native-session', parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, ...is_error === undefined ? {} : { is_error } }] },
    tool_use_result, ...extra })
}
function task(subtype: string, extra: object = {}): SDKMessage {
  return wire({ type: 'system', subtype, uuid: 'task-source', session_id: 'native-session', task_id: 'task', tool_use_id: 'tool',
    task_type: 'local_bash', is_backgrounded: false, ...extra })
}
function root(maxItems = 8, projectRoot: string | undefined = '/fixture/project') {
  const items: SkillLearningNativeItem[] = []
  return { items, observer: new ClaudeRootObservations('connection', 'native-session', 'send', maxItems, item => items.push(item),
    projectRoot) }
}

it('bounds native identities before retaining opaque references', () => {
  for (const value of [undefined, null, 2, '', 'bad/id', 'a'.repeat(257)]) expect(nativeIdentity(value)).toBe(false)
  expect(nativeIdentity('a'.repeat(256))).toBe(true)
})

it('retains allowed read, check and file-change facts, while keeping other inputs unretained', () => {
  const f = root()
  for (const [id, name, input] of [
    ['check', 'Bash', { command: 'git diff --check' }], ['read', 'Read', { file_path: 'src/a.ts' }],
    ['edit', 'Edit', { file_path: 'src/a.ts' }], ['write', 'Write', {}],
    ['glob', 'Glob', {}], ['grep', 'Grep', {}], ['limited', 'Read', { file_path: 'src/a.ts', limit: 1 }],
    ['outside', 'Read', { file_path: '../outside.ts' }],
  ] as const) f.observer.observe(call(id, name, input))
  expect(f.items).toHaveLength(8)
  expect(f.items[0]?.procedure).toEqual({ kind: 'check', command: 'git diff --check' })
  expect(f.items[1]?.procedure).toEqual({ kind: 'read', path: 'src/a.ts' })
  expect(f.items.slice(2).every(item => item.procedure === undefined)).toBe(true)
  expect(f.items[2]?.kind).toBe('file-change'); expect(f.items[3]?.kind).toBe('file-change')
  expect(f.observer.matches('read', 'Read', { file_path: 'src/a.ts' })).toBe(true)
  expect(f.observer.matches('read', 'Read', { file_path: 'different.ts' })).toBe(false)
  expect(f.observer.matches('read', 'Bash', { file_path: 'src/a.ts' })).toBe(false)
})

it.each([
  ['unowned root', undefined, 'Read', { file_path: 'src/a.ts' }],
  ['nonobject input', '/fixture/project', 'Read', null],
  ['read offset', '/fixture/project', 'Read', { file_path: 'src/a.ts', offset: 1 }],
  ['missing path', '/fixture/project', 'Read', {}],
  ['nonallowlisted command', '/fixture/project', 'Bash', { command: 'secret command' }],
  ['oversized command', '/fixture/project', 'Bash', { command: 'x'.repeat(257) }],
] as const)('does not infer a procedure from %s', (_label, project, name, input) => {
  const items: SkillLearningNativeItem[] = []
  const observer = new ClaudeRootObservations('connection', 'native-session', 'send', 8, item => items.push(item), project)
  observer.observe(call('tool', name, input)); expect(items[0]).not.toHaveProperty('procedure')
})

it.each([
  call('bad/id'), call('tool', 'Agent'), call('tool', 'Bash', { run_in_background: true }),
  call('tool', 'Bash', { backgroundedByUser: true }), call('tool', 'Bash', { timedOutAfterMs: 1 }),
  call('tool', 'Bash', { backgroundTaskId: 'background' }), call('tool', 'Read', {}, { uuid: '' }),
  call('tool', 'Read', {}, { isSynthetic: true }), call('tool', 'Read', {}, { isReplay: true }),
  call('tool', 'Read', {}, { session_id: 'other' }), call('tool', 'Read', {}, { parent_tool_use_id: 'nested' }),
])('invalidates unsupported external starts without publishing later facts', (message) => {
  const f = root(); f.observer.observe(message); f.observer.observe(call('later'))
  expect(f.observer.isInvalid).toBe(true); expect(f.items).toEqual([])
})

it('invalidates duplicate starts and an exhausted item bound exactly once', () => {
  const f = root(1); f.observer.observe(call()); f.observer.observe(call()); f.observer.invalidate()
  expect(f.items.map(item => item.phase)).toEqual(['started', 'invalidated'])
  expect(f.observer.matches('tool', 'Read', { file_path: 'src/a.ts' })).toBe(false)
  const g = root(1); g.observer.observe(call()); g.observer.observe(call('second'))
  expect(g.observer.isInvalid).toBe(true)
})

it.each([true, false, undefined])('keeps reported outcome %j distinct from independent verification', (isError) => {
  const f = root(); f.observer.observe(call()); f.observer.observe(result('tool', isError))
  expect(f.items[1]).toMatchObject({ phase: 'settled', resultMessageId: 'receipt-source',
    outcome: isError === true ? 'reported-error' : isError === false ? 'reported-success' : 'unknown' })
})

it.each([
  result('orphan'), result('tool', false, { backgroundedByUser: true }), result('tool', false, undefined, { uuid: '' }),
])('invalidates unpaired or unsafe native results', (message) => {
  const f = root(); f.observer.observe(call()); f.observer.observe(message)
  expect(f.observer.isInvalid).toBe(true); expect(f.items.at(-1)?.phase).toBe('invalidated')
})

it('rejects duplicate results and unstructured or interrupted Bash receipts', () => {
  const f = root(); f.observer.observe(call()); f.observer.observe(result()); f.observer.observe(result())
  expect(f.observer.isInvalid).toBe(true)
  for (const output of [undefined, {}, { stdout: '', stderr: '', interrupted: true }, { stdout: 1, stderr: '', interrupted: false },
    { stdout: '', stderr: 1, interrupted: false }]) {
    const g = root(); g.observer.observe(call('tool', 'Bash', {})); g.observer.observe(result('tool', false, output))
    expect(g.observer.isInvalid).toBe(true)
  }
})

it('retains only matching foreground Bash task metadata across progress, updates and completion', () => {
  const f = root(); f.observer.observe(call('tool', 'Bash', { command: 'npm test' }))
  for (const frame of [task('task_started'), task('task_progress'), task('task_updated', { patch: { status: 'running' } }),
    task('task_notification')]) f.observer.observe(frame)
  f.observer.observe(result('tool', false, { stdout: '', stderr: '', interrupted: false }))
  expect(f.observer.isInvalid).toBe(false); expect(f.items.at(-1)?.phase).toBe('settled')
})

it.each([
  task('task_started', { task_type: 'agent' }), task('task_started', { is_backgrounded: true }), task('task_started',
    { subagent_type: 'worker' }),
  task('task_started', { ambient: true }), task('task_started', { skip_transcript: true }), task('task_started', { task_id: 'bad/id' }),
  task('task_started', { tool_use_id: 'bad/id' }), task('task_started', { tool_use_id: 'orphan' }),
  task('task_progress', { task_id: 'orphan' }), task('task_progress', { tool_use_id: 'other' }),
  task('task_progress', { subagent_type: 'worker' }), task('task_notification', { ambient: true }), task('task_notification',
    { skip_transcript: true }),
  task('task_updated', { patch: { is_backgrounded: true } }), task('task_updated', { patch: { status: 'paused' } }),
  wire({ type: 'system', subtype: 'task_notification', session_id: 'native-session' }),
])('invalidates unowned, transferred or ambiguous task metadata', (message) => {
  const f = root(); f.observer.observe(call('tool', 'Bash', {})); f.observer.observe(task('task_started'))
  f.observer.observe(message); expect(f.observer.isInvalid).toBe(true)
})

it('rejects duplicate foreground task IDs and bounded task-map overflow', () => {
  const f = root(); f.observer.observe(call('tool', 'Bash', {})); f.observer.observe(task('task_started'))
  f.observer.observe(task('task_started'))
  expect(f.observer.isInvalid).toBe(true)
  const g = root(1); g.observer.observe(call('tool', 'Bash', {})); g.observer.observe(task('task_started'))
  g.observer.observe(task('task_started', { task_id: 'second-task' })); expect(g.observer.isInvalid).toBe(true)
})

it('ignores non-tool blocks and ordinary informational or string user frames', () => {
  const f = root()
  f.observer.observe(wire({ type: 'assistant', uuid: 'text-source', session_id: 'native-session', parent_tool_use_id: null,
    message: assistantBody([{ type: 'text', text: 'text', citations: null }]) }))
  f.observer.observe(wire({ type: 'user', uuid: 'text-source', session_id: 'native-session', parent_tool_use_id: null,
    message: { role: 'user', content: 'text' } }))
  f.observer.observe(wire({ type: 'user', uuid: 'text-source', session_id: 'native-session', parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text: 'text' }] } }))
  expect(f.observer.isInvalid).toBe(false); expect(f.items).toEqual([])
})

it.each([0, -1, 1.5, 257, Number.NaN])('rejects an invalid child receipt collection bound %j', (maxItems) => {
  expect(() => createClaudeCodeToolObserver({ maxItems, sink: () => {} })).toThrow('integer from 1 to 256')
})

it('bounds excluded task IDs and ignores duplicate or unidentified task notices', () => {
  const sink = (items: readonly unknown[]) => { expect(items).toEqual([]) }
  const observer = createClaudeCodeToolObserver({ maxItems: 1, sink })
  observer.observe(task('task_progress', { tool_use_id: 'excluded' })); observer.observe(task('task_progress', { tool_use_id: 'excluded' }))
  observer.observe(task('task_progress', { tool_use_id: 'bad/id' }))
  observer.observe(wire({ type: 'system', subtype: 'task_notification', session_id: 'native-session', task_id: 'task' }))
  observer.observe(task('task_progress', { tool_use_id: 'second' })); observer.observe(call()); observer.publish()
})

it('drops malformed child identities and non-result user content without a sink call', () => {
  const observer = createClaudeCodeToolObserver({ maxItems: 8, sink: () => { throw new Error('must not publish') } })
  observer.observe(call('tool', 'Read', {}, { session_id: '' })); observer.observe(call('tool', 'Read', {}, { uuid: 'bad/id' }))
  observer.observe(wire({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'text' }] }, parent_tool_use_id: null }))
  observer.publish()
})
