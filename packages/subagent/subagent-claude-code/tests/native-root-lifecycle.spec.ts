/** Actual root agent and Loader composition with only external SDK/process/policy enforcement mocked. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { z } from 'zod'
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
import { SandboxProvider, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SubprocessRuntime, { type SubprocessOutcome, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import * as Library from '@deepseek-ai/dsh-skill-library'
import * as Root from '../src/root.ts'
import * as Plugin from '../src/index.ts'
import * as Subagents from '@deepseek-ai/dsh-subagent'
import { assistantBody } from './sdk-message-fixture.ts'
import { scriptedQuery } from './native-query-fixture.ts'

const sdk = vi.hoisted(() => {
  const env: Record<string, string> = {}
  return { query: vi.fn(), env }
})
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }))
vi.mock('@deepseek-ai/dsh-subprocess', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-subprocess')>(),
  scrubbedParentEnv: () => ({ ...sdk.env }),
}))

async function fixture(
  script: (input: SDKUserMessage, options: Options, count: number) => AsyncGenerator<SDKMessage, void>,
  rootConfig: Partial<Root.ClaudeCodeRootConfig> = {}, bundled = false,
  lifecycle: {
    deferredConfine?: boolean
    throwAfterSpawn?: boolean
    unconfirmed?: boolean
    noSpawn?: boolean
    early?: (options: Options) => SDKMessage[]
    closeThrows?: boolean
    changedSpawnProfile?: boolean
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-root-claude-'))
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
      wrapped.push({ argv, policy }); return { argv: ['fixture-confine', ...argv], enforcement: 'full' as const, denialSignatures: [],
        runnerFailureRules: [] }
    }
  }
  class Processes extends SubprocessRuntime {
    override resolveExecutable(): never { throw new Error('unexpected executable resolution') }
    override terminalEnvironment(): never { throw new Error('unexpected terminal') }
    override spawnTerminal(): never { throw new Error('unexpected terminal') }
    override spawn(spec: SubprocessSpawnSpec) {
      spawned.push(spec)
      const done = Promise.withResolvers<SubprocessOutcome>(); exits.push(done)
      const terminate = () => { done.resolve({ exitCode: 0, signal: null }) }
      return { stdin: new PassThrough(), stdout: new PassThrough(), stderr: undefined, control: undefined,
        collected: {}, done: done.promise, terminate,
        waitForExit: async () => { await done.promise; return lifecycle.unconfirmed !== true } }
    }
  }
  const observedOptions: Options[] = []; const exits: ReturnType<typeof Promise.withResolvers<SubprocessOutcome>>[] = []
  sdk.query.mockImplementation(({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    observedOptions.push(options)
    const process = lifecycle.noSpawn ? undefined : options.spawnClaudeCodeProcess!({ command: '/fixture/claude', args: [],
      cwd: options.cwd!, env: { ...options.env, ...lifecycle.changedSpawnProfile ? { CLAUDE_CONFIG_DIR: join(options.env!.HOME!,
        'different') } : {} }, signal: options.abortController!.signal })
    if (lifecycle.throwAfterSpawn) throw new Error('fixture SDK startup throw after custom spawn')
    let closed = false
    async function* frames(): AsyncGenerator<SDKMessage, void> {
      yield* lifecycle.early?.(options) ?? []
      let count = 0
      for await (const input of prompt) {
        if (closed) return
        yield* script(input, options, ++count)
      }
    }
    return scriptedQuery(frames(), () => { closed = true; process?.kill('SIGTERM')
      if (lifecycle.closeThrows) throw new Error('external close refused') })
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
    'fixture-root': bundled ? { rootRoute: { connectionId: 'fixture-profile', model: 'fixture-native-model',
      ...rootConfig } } : { connectionId: 'fixture-profile', model: 'fixture-native-model', ...rootConfig } }
  const path = join(root, 'cordis.yml'); await writeFile(path, JSON.stringify([...modules.keys()].map(name => ({ name,
    config: config[name.replace('@deepseek-ai/dsh-', '')] }))))
  ctx.baseUrl = pathToFileURL(root).href + '/'; await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  const internal: ModuleLoaderV2 = { version: 'v2', loadCache: new Map(), async import(specifier) {
    if (!modules.has(specifier)) throw new Error(`unknown fixture module ${specifier}`); return modules.get(specifier)
  }, register(): never { throw new Error('unexpected registration') },
  getOrCreateModuleJob(): never { throw new Error('unexpected module job') },
  resolveSync(): never { throw new Error('unexpected resolution') }, load(): never { throw new Error('unexpected load') } }
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } }); await ctx.loader.await()
  const project = await ctx.workspaceRegistry.create(projectPath)
  await ctx.skillLibrary.approveLearningPolicy({ validatorId: 'native-observation-validator', generatorId: 'native-observation',
    projectId: project.id, operations: ['create', 'update'] })
  const handle = await ctx.agents.create({ sessionId: Sessions.SessionId('root-native-claude'),
    agentOptions: { provider: 'claude-code-native', model: 'fixture-native-model' }, meta: { cwd: project.path } })
  const agent = handle.agent
  return { ctx, project, agent, observedOptions, wrapped, spawned, confinement, confining, exits, dispose: () => handle.dispose() }
}

async function* normalFrames(input: SDKUserMessage, options: Options, count: number): AsyncGenerator<SDKMessage, void> {
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
  yield wire({ type: 'result', uuid: `${send}-terminal`, session_id: session, user_message_uuid: send,
    subtype: 'success', is_error: false, result: 'Inspected files and checks.' })
}


function followup(agent: Agents.Agent): void {
  agent.followup(Llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect source and run checks.' }] }))
}
const sdkWireEnvelope = z.custom<SDKMessage>(value => typeof value === 'object' && value !== null
  && 'type' in value && ['assistant', 'user', 'system', 'result'].includes(String(value.type)))
function wire(value: object): SDKMessage {
  const decoded: unknown = JSON.parse(JSON.stringify(value))
  return sdkWireEnvelope.parse(decoded)
}
function request(id: string, signal = new AbortController().signal) { return { signal, toolUseID: id, requestId: `${id}-permission` } }

it('exposes only the configured native model and refuses another model before SDK startup', async () => {
  const f = await fixture(normalFrames)
  expect(await f.ctx.llm.listModels('claude-code-native')).toEqual([expect.objectContaining({ id: 'fixture-native-model' })])
  await expect(f.ctx.llm.resolveModelInfo('claude-code-native', 'other')).rejects.toThrow('explicit deployment model')
  expect(sdk.query).not.toHaveBeenCalled()
})

it.each(['unsupported-purpose', 'reasoning', 'service-tier', 'token-limit', 'nontext'])('refuses %s on the normal root route',
  async (kind) => {
    const f = await fixture(normalFrames)
    const options: Llm.GenerateOptions = { provider: 'claude-code-native', model: 'fixture-native-model', sessionId: f.agent.session.id,
      messages: [Llm.createUserMessage({ source: { kind: 'user' }, content: kind === 'nontext' ? [{ type: 'reasoning',
        text: 'fixture' }] : [{ type: 'text', text: 'text' }] })],
      ...kind === 'unsupported-purpose' ? { purpose: 'compaction' } : {},
      ...kind === 'reasoning' ? { reasoningEffort: Llm.ReasoningEffortId('high') } : {},
      ...kind === 'service-tier' ? { serviceTier: Llm.ServiceTierId('default') } : {}, ...kind === 'token-limit' ? { maxTokens: 1 } : {} }
    await expect(f.ctx.agents.withInitiator(f.agent, async () => {
      const chunks: Llm.StreamChunk[] = []
      for await (const chunk of f.ctx.llm.stream(options)) chunks.push(chunk)
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    })).resolves.toBeUndefined()
    expect(sdk.query).not.toHaveBeenCalled()
  })

it.each(['aborted-assistant', 'resumed-thinking', 'wrong-echo', 'multiple-echoes', 'bad-terminal-echo', 'error-terminal',
  'post-terminal-work', 'compacting', 'fallback', 'bad-task'])('refuses external %s and settles the native owner', async (kind) => {
  const f = await fixture(async function* (input, options, count) {
    if (kind === 'compacting' || kind === 'fallback') {
      yield wire({ type: 'system', subtype: kind === 'compacting' ? 'status' : 'model_refusal_fallback', status: 'compacting',
        session_id: options.sessionId!, uuid: 'native-info' }); return
    }
    for await (const message of normalFrames(input, options, count)) {
      if (message.type === 'assistant') {
        if (kind === 'aborted-assistant') { yield wire({ ...message, aborted: true }); return }
        if (kind === 'resumed-thinking') { yield wire({ ...message, resumed_from_incomplete_thinking: true }); return }
        if (kind === 'wrong-echo') { yield { ...message, user_message_uuid: 'different' }; return }
        if (kind === 'multiple-echoes') { yield { ...message, user_message_uuids: [input.uuid!, 'another'] }; return }
      }
      if (message.type === 'result') {
        if (kind === 'bad-terminal-echo') { yield { ...message, user_message_uuid: 'different' }; return }
        if (kind === 'error-terminal') { yield { ...message, is_error: true }; return }
      }
      yield message
      if (message.type === 'assistant' && kind === 'bad-task') { yield wire({ type: 'system', subtype: 'task_started', task_id: 'orphan',
        tool_use_id: 'orphan', session_id: options.sessionId! }); return }
      if (message.type === 'result' && kind === 'post-terminal-work') yield wire({ type: 'assistant', uuid: 'late',
        session_id: options.sessionId!, parent_tool_use_id: null, message: assistantBody([{ type: 'text', text: 'late',
          citations: null }]) })
    }
  })
  followup(f.agent); await f.agent.whenIdle()
  await vi.waitFor(() =>{  expect(f.observedOptions[0]!.abortController!.signal.aborted).toBe(true) })
})

it('contains optional native elicitation and user dialogs without creating approvals', async () => {
  const replies: unknown[] = []
  const f = await fixture(async function* (input, options, count) {
    replies.push(await options.onElicitation!({ serverName: 'fixture', message: 'fixture', requestedSchema: { type: 'object',
      properties: {} } }, { signal: new AbortController().signal, requestId: 'fixture' }))
    replies.push(await options.onUserDialog!({ dialogKind: 'fixture', payload: {} }, { signal: new AbortController().signal,
      requestId: 'fixture' }))
    yield* normalFrames(input, options, count)
  })
  followup(f.agent); await f.agent.whenIdle()
  expect(replies).toEqual([{ action: 'decline' }, { behavior: 'cancelled' }])
})

it('denies an observed action when the initiating user refuses approval', async () => {
  const outcomes: unknown[] = []
  const f = await fixture(async function* (input, options, count) {
    for await (const frame of normalFrames(input, options, count)) {
      yield frame
      if (frame.type === 'assistant') {
        const block = frame.message.content[0]!
        if (block.type === 'tool_use') outcomes.push(await options.canUseTool!(block.name,
          block.name === 'Read' ? { file_path: join(options.cwd!, 'src/source.ts') } : { command: 'pnpm run test' }, request(block.id)))
      }
    }
  })
  f.ctx.on('approval/request', async () => 'rejected')
  followup(f.agent); await f.agent.whenIdle()
  expect(outcomes).toHaveLength(2)
  expect(outcomes.every(value => typeof value === 'object' && value !== null && 'behavior' in value && value.behavior === 'deny')).toBe(true)
})

it('denies aborting permission receipt waits and oversized native hooks', async () => {
  const outcomes: unknown[] = []
  const f = await fixture(async function* (input, options, count) {
    const signal = new AbortController(); const pending = options.canUseTool!('Read', {}, request('absent', signal.signal)); signal.abort()
    outcomes.push(await pending)
    const hook = options.hooks!.PreToolUse![0]!.hooks[0]!
    outcomes.push(await hook({ hook_event_name: 'PreToolUse', session_id: options.sessionId!, transcript_path: '', cwd: options.cwd!,
      tool_name: 'Read', tool_input: { body: 'x'.repeat(5000) }, tool_use_id: 'hook' }, 'hook', { signal: new AbortController().signal }))
    yield* normalFrames(input, options, count)
  }, { maxOutputBytes: 2048 })
  followup(f.agent); await f.agent.whenIdle()
  expect(outcomes[0]).toMatchObject({ behavior: 'deny' })
  expect(outcomes[1]).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
})

it('refuses a second SDK process and a changed spawn profile while draining the original process owner', async () => {
  for (const kind of ['second', 'profile'] as const) {
    const f = await fixture(async function* (_input, options) {
      options.spawnClaudeCodeProcess!({ command: '/fixture/claude', args: [], cwd: options.cwd!,
        env: kind === 'profile' ? { ...options.env, CLAUDE_CONFIG_DIR: join(options.env!.HOME!, 'different') } : { ...options.env },
        signal: options.abortController!.signal })
      yield* []
    })
    followup(f.agent); await f.agent.whenIdle()
    expect(f.observedOptions[0]!.abortController!.signal.aborted).toBe(true); expect(f.spawned).toHaveLength(1)
  }
})

it('contains a native close failure while shutting down owned work', async () => {
  const f = await fixture(async function* (input, options, count) {
    for await (const message of normalFrames(input, options, count)) { if (message.type === 'assistant') { yield { ...message,
      session_id: 'other' }; return } yield message }
  }, {}, false, { closeThrows: true })
  followup(f.agent); await f.agent.whenIdle()
  expect(f.observedOptions[0]!.abortController!.signal.aborted).toBe(true)
})

it('records legal idle metadata after the root turn has actually settled', async () => {
  const ready = Promise.withResolvers<undefined>(); const owner: { agent?: Agents.Agent } = {}
  const f = await fixture(async function* (input, options, count) {
    yield* normalFrames(input, options, count)
    await owner.agent!.whenIdle()
    for (const frame of [
      { type: 'system', subtype: 'session_state_changed', state: 'idle' }, { type: 'system', subtype: 'status', status: null },
      { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
    ]) yield wire({ ...frame, session_id: options.sessionId!, uuid: 'idle' })
    ready.resolve(undefined)
  })
  owner.agent = f.agent; followup(f.agent); await f.agent.whenIdle(); await ready.promise
  await vi.waitFor(() =>{  expect(f.agent.session.snapshotEvents().filter(e => e.type === 'claude-code/root-protocol')).toHaveLength(9) })
  expect(f.observedOptions[0]!.abortController!.signal.aborted).toBe(false)
})

it('refuses foreign idle-session metadata and an exhausted idle protocol bound', async () => {
  for (const kind of ['foreign', 'bound'] as const) {
    const owner: { agent?: Agents.Agent } = {}
    const f = await fixture(async function* (input, options, count) {
      yield* normalFrames(input, options, count); await owner.agent!.whenIdle()
      yield wire({ type: 'system', subtype: 'status', status: null, session_id: kind === 'foreign' ? 'other' : options.sessionId!,
        uuid: 'idle', note: kind === 'bound' ? 'x'.repeat(20000) : '' })
    }, { maxSessionBytes: 12000 })
    owner.agent = f.agent; followup(f.agent); await f.agent.whenIdle()
    await vi.waitFor(() =>{  expect(f.observedOptions[0]!.abortController!.signal.aborted).toBe(true) })
  }
})

it('drains an SDK failure before custom spawn and a natural child exit during an admitted root turn', async () => {
  const f = await fixture(normalFrames, {}, false, { noSpawn: true, throwAfterSpawn: true })
  followup(f.agent); await f.agent.whenIdle(); expect(f.spawned).toEqual([])
  const g = await fixture(async function* () { yield* []; await new Promise<void>(resolve => setImmediate(resolve)) })
  followup(g.agent); await vi.waitFor(() =>{  expect(g.spawned).toHaveLength(1) })
  g.exits[0]!.resolve({ exitCode: 0, signal: null }); await g.agent.whenIdle()
  expect(g.observedOptions[0]!.abortController!.signal.aborted).toBe(true)
})

it('refuses a failed durable request or SDK frame receipt before reporting success', async () => {
  const f = await fixture(normalFrames); vi.spyOn(f.ctx.sessions, 'flush').mockResolvedValueOnce(false)
  followup(f.agent); await f.agent.whenIdle(); expect(f.observedOptions[0]!.abortController!.signal.aborted).toBe(true)
  const g = await fixture(async function* (input, options, count) {
    vi.spyOn(g.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    yield* normalFrames(input, options, count)
  })
  followup(g.agent); await g.agent.whenIdle(); expect(g.observedOptions[0]!.abortController!.signal.aborted).toBe(true)
})

it('contains an asynchronously rejecting child receipt observer without starving the next observer', async () => {
  const f = await fixture(normalFrames, {}, true)
  const received: unknown[] = []
  const rejectedObserver = (): unknown => Promise.reject(new Error('fixture async consumer refusal'))
  f.ctx.on('claude-code/tool-observations', rejectedObserver)
  f.ctx.on('claude-code/tool-observations', (items) => { received.push(...items) })
  const warn = vi.spyOn(f.ctx.logger, 'warn')
  sdk.query.mockImplementation(({ options }: { options: Options }) => {
    const child = options.spawnClaudeCodeProcess!({ command: '/fixture/claude', args: [], cwd: options.cwd!, env: { ...options.env },
      signal: options.abortController!.signal })
    return scriptedQuery((async function* (): AsyncGenerator<SDKMessage, void> {
      yield wire({ type: 'assistant', uuid: 'child-source', session_id: 'child-session', parent_tool_use_id: null,
        message: assistantBody([{ type: 'tool_use', id: 'child-tool', name: 'Read', input: {} }]) })
      yield wire({ type: 'user', uuid: 'child-result', session_id: 'child-session', parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'child-tool', is_error: false }] } })
      yield wire({ type: 'result', subtype: 'success', result: 'Completed', is_error: false })
    })(), () => { child.kill('SIGTERM') })
  })
  const run = await f.ctx.subagents.start('claude-code', { parent: f.agent, prompt: [{ type: 'text', text: 'Inspect fixture' }],
    signal: new AbortController().signal })
  expect(await run.result).toMatchObject({ stopReason: 'completed' })
  await vi.waitFor(() =>{  expect(warn).toHaveBeenCalledWith('subagent-claude-code: tool observation listener rejected: %o',
    expect.any(Error)) })
  expect(received).toHaveLength(1)
})

it('refuses an SDK-composed spawn profile that differs before the first child is published', async () => {
  const f = await fixture(normalFrames, {}, false, { changedSpawnProfile: true })
  followup(f.agent); await f.agent.whenIdle(); expect(f.spawned).toEqual([])
})

it('disposes native memory when its actual initiating Agent is disposed', async () => {
  const f = await fixture(normalFrames); followup(f.agent); await f.agent.whenIdle()
  await f.dispose(); await vi.waitFor(() =>{  expect(f.observedOptions[0]!.abortController!.signal.aborted).toBe(true) })
  const g = await fixture(normalFrames); await g.dispose(); expect(sdk.query).toHaveBeenCalledTimes(1)
})

it('contains failed native shutdown notifications and blocks later root admission', async () => {
  const f = await fixture(normalFrames, {}, false, { unconfirmed: true }); followup(f.agent); await f.agent.whenIdle()
  const warn = vi.spyOn(f.ctx.logger, 'warn'); await f.dispose()
  await vi.waitFor(() =>{  expect(warn).toHaveBeenCalledWith('Claude root session disposal failed: %o', expect.any(Error)) })
})

it('retains validated startup init metadata before the first actual user send', async () => {
  const f = await fixture(normalFrames, {}, false, { early: options => [wire({ type: 'system', subtype: 'init',
    session_id: options.sessionId!, uuid: 'startup', cwd: options.cwd!, permissionMode: 'default',
    tools: ['Read', 'Bash'], mcp_servers: [], plugins: [], skills: [] })] })
  followup(f.agent); await f.agent.whenIdle()
  expect(f.agent.session.snapshotEvents().filter(e => e.type === 'claude-code/root-protocol')).toHaveLength(7)
})

it('refuses request session-byte overflow', async () => {
  const g = await fixture(normalFrames, { maxSessionBytes: 1 }); followup(g.agent); await g.agent.whenIdle()
  expect(g.observedOptions[0]!.abortController!.signal.aborted).toBe(true)
})

it('uses a terminal text fallback when the native assistant carries no visible text', async () => {
  const f = await fixture(async function* (input, options) {
    yield wire({ type: 'assistant', uuid: 'thought', session_id: options.sessionId!, parent_tool_use_id: null,
      user_message_uuid: input.uuid!,
      message: assistantBody([{ type: 'thinking', thinking: 'private native thought', signature: 'fixture' }]) })
    yield wire({ type: 'result', subtype: 'success', uuid: 'terminal', session_id: options.sessionId!, user_message_uuid: input.uuid!,
      is_error: false, result: 'Visible final fallback' })
  })
  followup(f.agent); await f.agent.whenIdle()
  expect(JSON.stringify(f.agent.session.snapshotEvents().filter(e => e.type === 'assistant/message'))).toContain('Visible final fallback')
})

it('refuses a failed idle protocol flush and a frame session-byte overflow', async () => {
  const owner: { agent?: Agents.Agent } = {}
  const f = await fixture(async function* (input, options, count) {
    yield* normalFrames(input, options, count); await owner.agent!.whenIdle(); vi.spyOn(f.ctx.sessions,
      'flush').mockResolvedValueOnce(false)
    yield wire({ type: 'system', subtype: 'status', status: null, session_id: options.sessionId!, uuid: 'idle' })
  })
  owner.agent = f.agent; followup(f.agent); await f.agent.whenIdle()
  await vi.waitFor(() =>{  expect(f.observedOptions[0]!.abortController!.signal.aborted).toBe(true) })
  const g = await fixture(async function* (input, options, count) {
    for await (const message of normalFrames(input, options, count)) { yield wire({ ...message, extra: 'x'.repeat(6000) }) }
  }, { maxSessionBytes: 5000 })
  followup(g.agent); await g.agent.whenIdle(); expect(g.observedOptions[0]!.abortController!.signal.aborted).toBe(true)
})
