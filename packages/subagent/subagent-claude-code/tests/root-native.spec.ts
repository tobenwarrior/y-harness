/** Actual root agent and Loader composition with only external SDK/process/policy enforcement mocked. */
import { mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { it, expect, onTestFinished, vi } from 'vitest'
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import * as Llm from '@deepseek-ai/dsh-llm'
import * as Sessions from '@deepseek-ai/dsh-session'
import * as Projection from '@deepseek-ai/dsh-session-projection'
import * as Prompt from '@deepseek-ai/dsh-system-prompt'
import * as Tools from '@deepseek-ai/dsh-tools'
import * as Agents from '@deepseek-ai/dsh-agent'
import * as Loop from '@deepseek-ai/dsh-agent-loop'
import * as Policy from '@deepseek-ai/dsh-sandbox-policy'
import * as Approval from '@deepseek-ai/dsh-user-approval'
import * as Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Workspace from '@deepseek-ai/dsh-workspace'
import * as Typert from '@deepseek-ai/dsh-typert-registry'
import { SandboxProvider, writableRoots, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SubprocessRuntime, { type SubprocessOutcome, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import * as Library from '../../../skill/skill-library/src/index.ts'
import * as Root from '../src/root.ts'
import * as Plugin from '../src/index.ts'
import * as Subagents from '@deepseek-ai/dsh-subagent'
import { nativeProfile } from '../src/root-profile.ts'
import { assistantBody } from './sdk-message-fixture.ts'

const sdk = vi.hoisted(() => ({ query: vi.fn(), env: {} as Record<string, string> }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }))
vi.mock('@deepseek-ai/dsh-subprocess', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-subprocess')>(),
  scrubbedParentEnv: () => ({ ...sdk.env }),
}))

async function fixture(
  script: (input: SDKUserMessage, options: Options, count: number) => AsyncGenerator<SDKMessage>,
  rootConfig: Partial<Root.ClaudeCodeRootConfig> = {}, bundled = false,
  lifecycle: { deferredConfine?: boolean; throwAfterSpawn?: boolean; unconfirmed?: boolean } = {},
) {
  const root = await mkdtemp('/tmp/dsh-root-claude-')
  const profile = await mkdtemp(join(process.cwd(), '.fixture-native-profile-'))
  sdk.env = { HOME: profile, USERPROFILE: profile, CLAUDE_CONFIG_DIR: join(profile, '.claude') }
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true })
    await rm(profile, { recursive: true, force: true }); sdk.query.mockReset(); sdk.env = {}
  })
  const confinement = Promise.withResolvers<undefined>(); const confining = Promise.withResolvers<undefined>()
  const projectPath = join(root, 'project'); await mkdir(join(projectPath, '.git'), { recursive: true })
  const wrapped: { argv: readonly string[]; policy: SandboxPolicy }[] = []; const spawned: SubprocessSpawnSpec[] = []
  class Confine extends SandboxProvider {
    override async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal) {
      confining.resolve(undefined)
      if (lifecycle.deferredConfine) await new Promise<void>((resolve, reject) => {
        const abort = () => { reject(new Error('fixture confinement cancelled')) }
        signal?.addEventListener('abort', abort, { once: true })
        void confinement.promise.then(() => { signal?.removeEventListener('abort', abort); resolve() })
      })
      wrapped.push({ argv, policy }); return { argv: ['fixture-confine', ...argv], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] }
    }
  }
  class Processes extends SubprocessRuntime {
    override resolveExecutable(): never { throw new Error('unexpected executable resolution') }
    override terminalEnvironment(): never { throw new Error('unexpected terminal') }
    override spawnTerminal(): never { throw new Error('unexpected terminal') }
    override spawn(spec: SubprocessSpawnSpec) {
      spawned.push(spec)
      const done = Promise.withResolvers<SubprocessOutcome>()
      const terminate = () => { done.resolve({ exitCode: 0, signal: null }) }
      return { stdin: new PassThrough(), stdout: new PassThrough(), stderr: undefined, control: undefined,
        collected: {}, done: done.promise, terminate,
        waitForExit: async () => { await done.promise; return lifecycle.unconfirmed !== true } }
    }
  }
  const observedOptions: Options[] = []
  sdk.query.mockImplementation(({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    observedOptions.push(options)
    const process = options.spawnClaudeCodeProcess!({ command: '/fixture/claude', args: [], cwd: options.cwd!, env: { ...options.env }, signal: options.abortController!.signal })
    if (lifecycle.throwAfterSpawn) throw new Error('fixture SDK startup throw after custom spawn')
    let closed = false
    async function* frames(): AsyncGenerator<SDKMessage> {
      let count = 0
      for await (const input of prompt) {
        if (closed) return
        yield* script(input, options, ++count)
      }
    }
    return { [Symbol.asyncIterator]: frames, close() { closed = true; process.kill('SIGTERM') }, interrupt: async () => {} }
  })
  const moduleEntries: [string, unknown][] = [
    ['llm', Llm], ['session', Sessions], ['session-projection', Projection], ['system-prompt', Prompt], ['tools', Tools],
    ['agent', Agents], ['agent-loop', Loop], ['sandbox-policy', Policy], ['user-approval', Approval],
    ['storage', Storage], ['storage-json', JsonStorage], ['storage-domain', Domain], ['session-persistence-jsonl', Jsonl],
    ['workspace', Workspace], ['typert-registry', Typert], ['skill-library', Library],
    ...bundled ? [['subagent', Subagents] satisfies [string, unknown]] : [],
    ['fixture-confine', { default: Confine }], ['fixture-processes', { default: Processes }], ['fixture-root', bundled ? Plugin : Root],
  ]
  const modules = new Map<string, unknown>(moduleEntries.map(([name, module]) => [`@deepseek-ai/dsh-${name}`, module]))
  const config: Record<string, object> = { 'storage-json': { root: join(root, 'storage') }, 'storage-domain': { backend: 'json' },
    'session-persistence-jsonl': { root: join(root, 'sessions'), compression: 'none' }, 'sandbox-policy': { mode: 'workspace-write' },
    'agent-loop': { agents: [] }, 'user-approval': { policy: 'ask' },
    'skill-library': { dshHome: join(root, 'home'), agentsHome: join(root, 'agents'), automaticMaintenanceIntervalMs: 0 },
    'fixture-root': bundled ? { rootRoute: { connectionId: 'fixture-profile', model: 'fixture-native-model', ...rootConfig } } : { connectionId: 'fixture-profile', model: 'fixture-native-model', ...rootConfig } }
  const path = join(root, 'cordis.yml'); await writeFile(path, JSON.stringify([...modules.keys()].map(name => ({ name, config: config[name.replace('@deepseek-ai/dsh-', '')] }))))
  ctx.baseUrl = pathToFileURL(root).href + '/'; await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  const internal: ModuleLoaderV2 = { version: 'v2', loadCache: new Map(), async import(specifier) {
    if (!modules.has(specifier)) throw new Error(`unknown fixture module ${specifier}`); return modules.get(specifier)
  }, register(): never { throw new Error('unexpected registration') }, getOrCreateModuleJob(): never { throw new Error('unexpected module job') },
  resolveSync(): never { throw new Error('unexpected resolution') }, load(): never { throw new Error('unexpected load') } }
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } }); await ctx.loader.await()
  const project = await ctx.workspaceRegistry.create(projectPath)
  await ctx.skillLibrary.approveLearningPolicy({ validatorId: 'native-observation-validator', generatorId: 'native-observation', projectId: project.id, operations: ['create', 'update'] })
  const agent = await ctx.agentLoop.create(Sessions.SessionId('root-native-claude'), { provider: 'claude-code-native', model: 'fixture-native-model' }, { cwd: project.path })
  return { ctx, project, agent, observedOptions, wrapped, spawned, confinement, confining }
}

async function* normalFrames(input: SDKUserMessage, options: Options, count: number): AsyncGenerator<SDKMessage> {
  const send = input.uuid!; const session = options.sessionId!; const sequence = count === 1 ? ['Read', 'Bash'] : ['Bash', 'Read']
  for (const [index, name] of sequence.entries()) {
    const item = `${send}-${index}`
    yield { type: 'assistant', uuid: `${send}-source-${index}`, session_id: session, parent_tool_use_id: null,
      ...index === 0 ? { user_message_uuid: send } : {}, message: assistantBody([{ type: 'tool_use', id: item, name,
        input: name === 'Read' ? { file_path: join(options.cwd!, 'src/source.ts') } : { command: 'pnpm run test' } }]) }
    yield { type: 'user', uuid: `${send}-result-${index}`, session_id: session, parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: item, is_error: false, content: 'private raw tool output' }] },
      tool_use_result: name === 'Bash' ? { stdout: '', stderr: '', interrupted: false } : undefined }
  }
  yield { type: 'result', uuid: `${send}-terminal`, session_id: session, user_message_uuid: send,
    subtype: 'success', is_error: false, result: 'Inspected files and checks.' } as SDKMessage
}

it('keeps one native query across normal root turns and durably learns actual SDK identities', async () => {
  const { ctx, project, agent, observedOptions, wrapped, spawned } = await fixture(normalFrames, {}, true)
  for (const count of [1, 2]) {
    agent.followup(Llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect source and run checks.' }] })); await agent.whenIdle()
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end' && event.data.reason.kind === 'error')).toEqual([])
    await vi.waitFor(() => { expect(ctx.skillLibrary.listLearningEvidence({ projectId: project.id })).toHaveLength(count) })
  }
  const evidence = ctx.skillLibrary.listLearningEvidence({ projectId: project.id })
  expect(sdk.query).toHaveBeenCalledTimes(1); expect(wrapped).toHaveLength(1); expect(spawned[0]?.argv[0]).toBe('fixture-confine')
  expect(wrapped[0]?.policy).toMatchObject({ mode: 'workspace-write', workspaceRoot: project.path })
  expect(observedOptions[0]).toMatchObject({ persistSession: false, permissionMode: 'default', settingSources: [], tools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'] })
  expect(evidence[0]?.native?.sessionId).toBe(evidence[1]?.native?.sessionId)
  expect(evidence.every(row => row.native?.provider === 'claude-code' && !('turnId' in row.native) && row.checks.length === 0)).toBe(true)
  expect(evidence[0]?.native).not.toEqual(evidence[1]?.native)
  expect(JSON.stringify(evidence)).not.toContain('private raw tool output')
  await vi.waitFor(async () => { expect((await ctx.skillLibrary.list({ projectId: project.id })).items).toHaveLength(1) })
})

function followup(agent: Agents.Agent): void {
  agent.followup(Llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect source and run checks.' }] }))
}
function request(id: string, signal = new AbortController().signal) { return { signal, toolUseID: id, requestId: `${id}-permission` } }

it('waits for the exact assistant receipt when SDK permission control runs first, and grants only once', async () => {
  const outcomes: unknown[] = []
  let nativeOptions: Options | undefined
  const f = await fixture(async function* (input, options, count) {
    nativeOptions = options
    let first = true
    for await (const frame of normalFrames(input, options, count)) {
      if (frame.type === 'assistant' && first) {
        first = false
        const block = frame.message.content[0]!
        if (block.type !== 'tool_use') throw new Error('fixture expected tool use')
        const input = { file_path: join(options.cwd!, 'src/source.ts') }
        const pending = options.canUseTool!('Read', input, request(block.id))
        outcomes.push(await options.canUseTool!('Read', input, request(block.id)))
        yield frame
        outcomes.push(await pending)
        outcomes.push(await options.canUseTool!('Read', { file_path: 'different.ts' }, { ...request(block.id), requestId: `${block.id}-mismatch` }))
        continue
      }
      yield frame
    }
  })
  const answers = vi.fn(async (req: Approval.ApprovalRequest) => { expect(req.agent).toBe(f.agent); return 'allowed-once' as const })
  f.ctx.on('approval/request', answers)
  followup(f.agent); await f.agent.whenIdle()
  expect(answers).toHaveBeenCalledTimes(1)
  expect(outcomes[0]).toMatchObject({ behavior: 'deny' })
  expect(outcomes[1]).toMatchObject({ behavior: 'allow', updatedInput: { file_path: join(f.project.path, 'src/source.ts') } })
  expect(outcomes[1]).not.toHaveProperty('updatedPermissions')
  // A source identity with changed inputs cannot borrow the earlier grant.
  expect(outcomes[2]).toMatchObject({ behavior: 'deny' })
  expect(await nativeOptions!.canUseTool!('Read', {}, request('late-request'))).toMatchObject({ behavior: 'deny' })
})

it('denies a deferred approval after policy narrows and cancels the process before policy publication returns', async () => {
  const answer = Promise.withResolvers<'allowed-once'>(); const asked = Promise.withResolvers<undefined>(); const outcomes: unknown[] = []
  const f = await fixture(async function* (input, options, count) {
    for await (const frame of normalFrames(input, options, count)) {
      yield frame
      if (frame.type === 'assistant') {
        const block = frame.message.content[0]!
        if (block.type !== 'tool_use') throw new Error('fixture expected tool use')
        outcomes.push(await options.canUseTool!(block.name, { file_path: join(options.cwd!, 'src/source.ts') }, request(block.id)))
        return
      }
    }
  })
  f.ctx.on('approval/request', async () => { asked.resolve(undefined); return await answer.promise })
  followup(f.agent); await asked.promise
  const native = f.observedOptions[0]!
  Policy.setSandboxMode(f.agent.session, 'read-only')
  expect(native.abortController!.signal.aborted).toBe(true)
  answer.resolve('allowed-once'); await f.agent.whenIdle()
  expect(outcomes).toEqual([expect.objectContaining({ behavior: 'deny' })])
  expect(f.ctx.skillLibrary.listLearningEvidence({ projectId: f.project.id })).toEqual([])
  const endings = f.agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
  expect(endings).toHaveLength(1)
  expect(endings[0]?.data.reason).toMatchObject({ kind: 'error' })
})

it('uses a deny-or-neutral PreToolUse guard for current policy without granting native permissions', async () => {
  const results: unknown[] = []
  const f = await fixture(async function* (input, options, count) {
    const hook = options.hooks!.PreToolUse![0]!.hooks[0]!
    const base = { hook_event_name: 'PreToolUse' as const, session_id: options.sessionId!, transcript_path: '', cwd: options.cwd!, tool_name: 'Read', tool_input: {}, tool_use_id: 'hook-tool' }
    results.push(await hook(base, 'hook-tool', { signal: new AbortController().signal }))
    for (const patch of [{ agent_id: 'nested' }, { session_id: 'other-session' }, { cwd: '/outside' }, { tool_name: 'Agent' }]) results.push(await hook({ ...base, ...patch }, 'hook-tool', { signal: new AbortController().signal }))
    yield* normalFrames(input, options, count)
  })
  const asked = vi.fn(); f.ctx.on('approval/request', asked)
  followup(f.agent); await f.agent.whenIdle()
  expect(results[0]).toEqual({})
  expect(results.slice(1)).toHaveLength(4)
  for (const result of results.slice(1)) expect(result).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  expect(asked).not.toHaveBeenCalled()
})

it.each(['foreign-session', 'unbound', 'nested', 'replay', 'compaction', 'supersede', 'background'] as const)('closes unsupported %s native state without evidence', async (kind) => {
  const f = await fixture(async function* (input, options, count) {
    for await (const frame of normalFrames(input, options, count)) {
      if (frame.type === 'assistant') {
        if (kind === 'foreign-session') yield { ...frame, session_id: 'other-session' }
        else if (kind === 'unbound') { const { user_message_uuid: _echo, ...unbound } = frame; yield unbound }
        else if (kind === 'nested') yield { ...frame, parent_tool_use_id: 'native-child' }
        else if (kind === 'supersede') yield { ...frame, supersedes: ['00000000-0000-4000-8000-000000000099' as const] }
        else if (kind === 'compaction') yield {
          type: 'system', subtype: 'compact_boundary', session_id: options.sessionId!,
          uuid: '00000000-0000-4000-8000-000000000099', compact_metadata: { trigger: 'auto', pre_tokens: 1 },
        }
        else yield frame
      } else if (frame.type === 'user' && kind === 'replay') yield Object.assign(frame, { isReplay: true as const })
      else if (frame.type === 'user' && kind === 'background') yield { ...frame, tool_use_result: { backgroundTaskId: 'background-task' } }
      else yield frame
    }
  })
  followup(f.agent); await f.agent.whenIdle()
  expect(f.observedOptions[0]!.abortController!.signal.aborted).toBe(true)
  expect(f.ctx.skillLibrary.listLearningEvidence({ projectId: f.project.id })).toEqual([])
  if (kind === 'foreign-session') expect(JSON.stringify(f.agent.session.snapshotEvents().filter(event => event.type === 'claude-code/root-protocol'))).not.toContain('other-session')
})

it('counts oversized unbound frames and complete permission control payloads before filtering', async () => {
  const f = await fixture(async function* (input, options) {
    yield { type: 'assistant', uuid: '00000000-0000-4000-8000-000000000099', session_id: options.sessionId!, parent_tool_use_id: null,
      message: assistantBody([{ type: 'text', text: '多'.repeat(600), citations: null }]) }
    yield* normalFrames(input, options, 1)
  }, { maxOutputBytes: 1024 })
  followup(f.agent); await f.agent.whenIdle()
  expect(f.observedOptions[0]!.abortController!.signal.aborted).toBe(true)
  expect(f.ctx.skillLibrary.listLearningEvidence({ projectId: f.project.id })).toEqual([])
})

it('bounds incomplete sends by their complete lifetime and denies unpaired SDK permissions', async () => {
  const outcomes: unknown[] = []
  const f = await fixture(async function* (_input, options) {
    outcomes.push(await options.canUseTool!('Bash', { command: 'pnpm run test' }, request('no-receipt')))
  }, { maxTurnMs: 500 })
  followup(f.agent); await f.agent.whenIdle()
  expect(outcomes).toEqual([expect.objectContaining({ behavior: 'deny' })])
  expect(f.observedOptions[0]!.abortController!.signal.aborted).toBe(true)
})

it('keeps legal informational frames after result compatible with one persistent query', async () => {
  const f = await fixture(async function* (input, options, count) {
    yield* normalFrames(input, options, count)
    yield { type: 'system', subtype: 'status', status: null, uuid: '00000000-0000-4000-8000-000000000099', session_id: options.sessionId! }
  })
  followup(f.agent); await f.agent.whenIdle(); followup(f.agent); await f.agent.whenIdle()
  expect(sdk.query).toHaveBeenCalledTimes(1)
  expect(f.observedOptions[0]!.abortController!.signal.aborted).toBe(false)
})

it('logs exact owned SDK requests and public context separately, excluding raw bodies from learning', async () => {
  const f = await fixture(normalFrames)
  followup(f.agent); await f.agent.whenIdle()
  await vi.waitFor(() => { expect(f.ctx.skillLibrary.listLearningEvidence({ projectId: f.project.id })).toHaveLength(1) })
  const protocol = f.agent.session.snapshotEvents().filter(event => event.type === 'claude-code/root-protocol')
  expect(protocol).toHaveLength(6); expect(protocol.every(event => event.ignorable)).toBe(true)
  expect(protocol[0]!.data).toMatchObject({ phase: 'request', system: f.observedOptions[0]!.systemPrompt })
  expect(JSON.stringify(protocol)).toContain('private raw tool output')
  expect(JSON.stringify(f.ctx.skillLibrary.listLearningEvidence({ projectId: f.project.id }))).not.toContain('private raw tool output')
  expect(f.observedOptions[0]).toMatchObject({ settingSources: [], strictMcpConfig: true, mcpServers: {}, plugins: [], skills: [] })
})

it('rejects tiny complete-input bounds before sending and limits retained native sessions', async () => {
  const f = await fixture(normalFrames, { maxInputBytes: 100 })
  followup(f.agent); await f.agent.whenIdle()
  expect(sdk.query).not.toHaveBeenCalled()
})

it('narrows changed policy by closing old native memory and using a fresh query for the next root turn', async () => {
  const f = await fixture(normalFrames)
  followup(f.agent); await f.agent.whenIdle()
  Policy.setSandboxMode(f.agent.session, 'read-only')
  await vi.waitFor(() => { expect(f.observedOptions[0]!.abortController!.signal.aborted).toBe(true) })
  followup(f.agent); await f.agent.whenIdle()
  expect(sdk.query).toHaveBeenCalledTimes(2)
  expect(f.wrapped[1]!.policy.mode).toBe('read-only')
})

it('retains exact foreground Bash task metadata and authoritative idle frames without accepting background transfer', async () => {
  const f = await fixture(async function* (input, options, count) {
    for await (const frame of normalFrames(input, options, count)) {
      yield frame
      if (frame.type === 'assistant') {
        const block = frame.message.content[0]!
        if (block.type === 'tool_use' && block.name === 'Bash') yield { type: 'system', subtype: 'task_started', task_id: `${block.id}-task`, tool_use_id: block.id,
          task_type: 'local_bash', is_backgrounded: false, description: 'Running direct check', session_id: options.sessionId!, uuid: '00000000-0000-4000-8000-000000000099' }
      }
    }
    yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: options.sessionId!, uuid: '00000000-0000-4000-8000-000000000099' }
  })
  followup(f.agent); await f.agent.whenIdle(); followup(f.agent); await f.agent.whenIdle()
  expect(sdk.query).toHaveBeenCalledTimes(1)
  await vi.waitFor(() => { expect(f.ctx.skillLibrary.listLearningEvidence({ projectId: f.project.id })).toHaveLength(2) })
})

it('denies outstanding unpaired controls at terminal while allowing subsequent idle metadata', async () => {
  let pending: ReturnType<NonNullable<Options['canUseTool']>> | undefined
  const f = await fixture(async function* (input, options, count) {
    pending = options.canUseTool!('Read', {}, request('missing-source'))
    yield* normalFrames(input, options, count)
    yield { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: options.sessionId!, uuid: '00000000-0000-4000-8000-000000000099' }
  })
  followup(f.agent); await f.agent.whenIdle()
  expect(await pending!).toMatchObject({ behavior: 'deny' })
  expect(f.observedOptions[0]!.abortController!.signal.aborted).toBe(false)
})

it('starts a fresh native query when the preceding marker assistant body changes', async () => {
  const f = await fixture(normalFrames)
  followup(f.agent); await f.agent.whenIdle()
  const stop = f.ctx.on('llm/stream', function (options) {
    stop()
    return f.ctx.llm.stream({ ...options, messages: options.messages.map(message => message.role === 'assistant'
      ? { ...message, content: [{ type: 'text' as const, text: 'Changed previous native answer' }] } : message) })
  })
  followup(f.agent); await f.agent.whenIdle(); stop()
  expect(sdk.query).toHaveBeenCalledTimes(2)
})

it('rejects public native conversation resets and undeclared initialization sources', async () => {
  const f = await fixture(async function* (_input, options) {
    yield {
      type: 'conversation_reset', new_conversation_id: '00000000-0000-4000-8000-000000000098',
      session_id: options.sessionId!, uuid: '00000000-0000-4000-8000-000000000099',
    }
  })
  followup(f.agent); await f.agent.whenIdle()
  expect(f.observedOptions[0]!.abortController!.signal.aborted).toBe(true)
})

it('caps complete permission callback bytes even when no source tool receipt exists', async () => {
  const outcomes: unknown[] = []
  const f = await fixture(async function* (_input, options) {
    outcomes.push(await options.canUseTool!('Bash', { command: '多'.repeat(600) }, request('missing-source')))
  }, { maxOutputBytes: 1024 })
  followup(f.agent); await f.agent.whenIdle()
  expect(outcomes).toEqual([expect.objectContaining({ behavior: 'deny' })])
  expect(f.observedOptions[0]!.abortController!.signal.aborted).toBe(true)
})


it.each(['background-snapshot', 'memory-recall'] as const)('closes unsupported %s before logging its raw content', async (kind) => {
  const f = await fixture(async function* (_input, options) {
    if (kind === 'background-snapshot') yield { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'unowned-background', task_type: 'local_bash', description: 'rejected-private-context' }], session_id: options.sessionId!, uuid: '00000000-0000-4000-8000-000000000099' }
    else yield { type: 'system', subtype: 'memory_recall', mode: 'select', memories: [{ path: '/unowned/rejected-private-context', scope: 'personal' }], session_id: options.sessionId!, uuid: '00000000-0000-4000-8000-000000000099' }
  })
  followup(f.agent); await f.agent.whenIdle()
  expect(f.observedOptions[0]!.abortController!.signal.aborted).toBe(true)
  expect(JSON.stringify(f.agent.session.snapshotEvents().filter(event => event.type === 'claude-code/root-protocol'))).not.toContain('rejected-private-context')
})


it('records the exact launched native profile paths without inferring an account', async () => {
  const f = await fixture(normalFrames)
  followup(f.agent); await f.agent.whenIdle()
  const records = f.agent.session.snapshotEvents().filter(event => event.type === 'claude-code/root-protocol')
  expect(records.length).toBeGreaterThan(1)
  expect(records.every(event => event.data.profile.home.length > 0 && event.data.profile.configDirectory.length > 0)).toBe(true)
  expect(records.map(event => event.data.profile)).toEqual(records.map(() => records[0]!.data.profile))
  const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: f.project.path }
  expect(nativeProfile(f.observedOptions[0]!.env ?? {}, policy, writableRoots(policy))).toEqual(records[0]!.data.profile)
  expect(JSON.stringify(records[0]!.data.profile)).not.toContain('account')
})

it('refuses a writable project that overlaps the declared native config path before SDK startup', async () => {
  const f = await fixture(normalFrames)
  sdk.env.CLAUDE_CONFIG_DIR = join(f.project.path, 'native-profile')
  followup(f.agent); await f.agent.whenIdle(); expect(sdk.query).not.toHaveBeenCalled()
})

it('refuses full-access root mode before SDK startup', async () => {
  const f = await fixture(normalFrames)
  f.agent.session.append('sandbox/mode', { mode: 'danger-full-access' })
  followup(f.agent); await f.agent.whenIdle()
  expect(sdk.query).not.toHaveBeenCalled()
})


it.each(['temporary-root', 'symlink-ancestor'] as const)('refuses absent native profile under writable %s without auth reads', async (kind) => {
  const f = await fixture(normalFrames)
  let directory = `/tmp/native-profile-not-created-${f.agent.session.id}`
  if (kind === 'symlink-ancestor') {
    const alias = join(f.project.path, '..', 'project-alias'); await symlink(f.project.path, alias); directory = join(alias, 'profile-not-created')
  }
  sdk.env.CLAUDE_CONFIG_DIR = directory
  followup(f.agent); await f.agent.whenIdle(); expect(sdk.query).not.toHaveBeenCalled()
})


it('drains custom spawn ownership if SDK startup throws before Entry publication', async () => {
  const f = await fixture(normalFrames, {}, false, { throwAfterSpawn: true })
  followup(f.agent); await f.agent.whenIdle()
  expect(sdk.query).toHaveBeenCalledTimes(1); expect(f.spawned).toEqual([])
  expect(f.observedOptions[0]!.abortController!.signal.aborted).toBe(true)
})

it('disposes pending confinement without launching a child or retaining an opening query', async () => {
  const f = await fixture(normalFrames, {}, false, { deferredConfine: true })
  followup(f.agent); await f.confining.promise
  await f.ctx.fiber.dispose()
  expect(f.spawned).toEqual([]); expect(f.observedOptions[0]!.abortController!.signal.aborted).toBe(true)
})

it('counts idle retained native sessions toward admission', async () => {
  const f = await fixture(normalFrames, { maxSessions: 1 })
  followup(f.agent); await f.agent.whenIdle()
  const other = await f.ctx.agentLoop.create(Sessions.SessionId('second-root-native'), { provider: 'claude-code-native', model: 'fixture-native-model' }, { cwd: f.project.path })
  followup(other); await other.whenIdle()
  expect(sdk.query).toHaveBeenCalledTimes(1)
  expect(other.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'error')).toBe(true)
})

it.each(['none', 'mcp', 'plugin', 'skill', 'agent'] as const)('validates the actual native init declaration with %s sources', async (kind) => {
  const f = await fixture(async function* (input, options, count) {
    yield { type: 'system', subtype: 'init', session_id: options.sessionId!, uuid: '00000000-0000-4000-8000-000000000099', cwd: options.cwd!, model: options.model!,
      apiKeySource: 'none', claude_code_version: 'fixture', tools: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'], permissionMode: 'default', slash_commands: [], output_style: 'default',
      mcp_servers: kind === 'mcp' ? [{ name: 'foreign', status: 'connected' }] : [], plugins: kind === 'plugin' ? [{ name: 'foreign', path: '/foreign' }] : [],
      skills: kind === 'skill' ? ['foreign'] : [], agents: kind === 'agent' ? ['foreign'] : [] }
    yield* normalFrames(input, options, count)
  })
  followup(f.agent); await f.agent.whenIdle()
  expect(f.observedOptions[0]!.abortController!.signal.aborted).toBe(kind !== 'none')
})


it('blocks new native admission after managed shutdown cannot be confirmed', async () => {
  const f = await fixture(async function* (input, options, count) {
    for await (const frame of normalFrames(input, options, count)) { if (frame.type === 'assistant') yield { ...frame, session_id: 'unowned-session' }; else yield frame }
  }, {}, false, { unconfirmed: true })
  followup(f.agent); await f.agent.whenIdle()
  const other = await f.ctx.agentLoop.create(Sessions.SessionId('after-failed-shutdown'), { provider: 'claude-code-native', model: 'fixture-native-model' }, { cwd: f.project.path })
  followup(other); await other.whenIdle()
  expect(sdk.query).toHaveBeenCalledTimes(1)
})
