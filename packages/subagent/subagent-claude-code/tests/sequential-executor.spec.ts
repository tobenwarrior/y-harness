/** Real idle Y root and persistence composition; only native SDK and process enforcement are substituted. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import * as Llm from '@deepseek-ai/dsh-llm'
import * as Sessions from '@deepseek-ai/dsh-session'
import * as Projection from '@deepseek-ai/dsh-session-projection'
import * as Prompt from '@deepseek-ai/dsh-system-prompt'
import * as Tools from '@deepseek-ai/dsh-tools'
import * as Agents from '@deepseek-ai/dsh-agent'
import * as Loop from '@deepseek-ai/dsh-agent-loop'
import * as Policy from '@deepseek-ai/dsh-sandbox-policy'
import * as Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Workspace from '@deepseek-ai/dsh-workspace'
import * as Typert from '@deepseek-ai/dsh-typert-registry'
import * as Library from '../../../skill/skill-library/src/index.ts'
import { SandboxProvider, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SubprocessRuntime, { type SubprocessOutcome, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { claudeSequentialProjectDirectory, createClaudeSequentialExecutor, type ClaudeSequentialExecutor, type ClaudeSequentialSdk, type ClaudeSequentialSelection } from '../src/sequential.ts'
import { assistantBody } from './sdk-message-fixture.ts'

const nativeSessionId = '11111111-1111-4111-8111-111111111111'
const frameIds = {
  init: '22222222-2222-4222-8222-222222222221',
  running: '22222222-2222-4222-8222-222222222222',
  requesting: '22222222-2222-4222-8222-222222222223',
  assistantFirst: '22222222-2222-4222-8222-222222222224',
  assistantLater: '22222222-2222-4222-8222-222222222225',
  result: '22222222-2222-4222-8222-222222222226',
  idle: '22222222-2222-4222-8222-222222222227',
} as const
// Exercise the native executor's external startup boundary, rather than a
// configuration parser that would refuse the raw fixture value before entry.
function withStartupDeclaration(selection: ClaudeSequentialSelection, declaration: unknown): ClaudeSequentialSelection {
  const selected = { ...selection }
  Object.defineProperty(selected, 'knownUnmanagedStartup', { value: declaration, enumerable: true })
  return selected
}
type Script = (input: SDKUserMessage, options: Options) => AsyncGenerator<SDKMessage>
async function* normalFrames(input: SDKUserMessage, options: Options): AsyncGenerator<SDKMessage> {
  const session_id = options.resume!; const send = input.uuid!
  yield { type: 'system', subtype: 'init', uuid: frameIds.init, session_id, cwd: options.cwd!,
    apiKeySource: 'none', claude_code_version: '2.1.263', permissionMode: 'default', tools: [], agents: [], mcp_servers: [],
    model: 'fixture-native-model', slash_commands: [], output_style: 'default', skills: [], plugins: [], fast_mode_state: 'off' }
  yield { type: 'system', subtype: 'session_state_changed', state: 'running', uuid: frameIds.running, session_id }
  yield { type: 'system', subtype: 'status', status: 'requesting', uuid: frameIds.requesting, session_id }
  yield { type: 'assistant', uuid: frameIds.assistantFirst, session_id, parent_tool_use_id: null, user_message_uuid: send,
    message: assistantBody([{ type: 'text', text: 'First native reply', citations: null }]) }
  yield { type: 'assistant', uuid: frameIds.assistantLater, session_id, parent_tool_use_id: null,
    message: assistantBody([{ type: 'text', text: 'Second native reply', citations: null }]) }
  yield { type: 'result', subtype: 'success', uuid: frameIds.result, session_id, user_message_uuid: send,
    is_error: false, result: 'Completed native answer.', duration_ms: 1, duration_api_ms: 1, num_turns: 1,
    stop_reason: 'end_turn', total_cost_usd: 0, modelUsage: {}, permission_denials: [],
    usage: { cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0, inference_geo: 'fixture', input_tokens: 1,
      iterations: [], output_tokens: 1, server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
      service_tier: 'standard', speed: 'standard' } }
  yield { type: 'system', subtype: 'session_state_changed', state: 'idle', uuid: frameIds.idle, session_id }
}
async function fixture(script: Script = normalFrames, diagnostics = '') {
  const root = await realpath(await mkdtemp('/tmp/dsh-sequential-claude-'))
  const ctx = new Context()
  const owner: { fixtureHome?: string; executor?: ClaudeSequentialExecutor } = {}
  let stop = () => {}; let detach = () => {}
  onTestFinished(async () => {
    detach(); stop()
    if (owner.executor !== undefined) await Promise.allSettled([owner.executor.close()])
    try { await ctx.fiber.dispose() }
    finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        ...owner.fixtureHome === undefined ? [] : [rm(owner.fixtureHome, { recursive: true, force: true })],
      ])
    }
  })
  // Only fixture roots are created: the original user profile is never consulted.
  const home = await realpath(await mkdtemp(join(process.cwd(), '.fixture-native-profile-')))
  owner.fixtureHome = home
  const profile = join(home, '.claude'); const payload = join(home, 'payload'); const projectPath = join(root, 'project')
  await Promise.all([mkdir(join(projectPath, '.git'), { recursive: true }), mkdir(profile), mkdir(payload)])
  const stateDirectory = claudeSequentialProjectDirectory(profile, projectPath)
  await mkdir(stateDirectory, { recursive: true }); await writeFile(join(stateDirectory, `${nativeSessionId}.jsonl`), '')
  const nativeBytes = Buffer.from('fixture native payload; never executed')
  const nativeExecutablePath = join(payload, process.platform === 'win32' ? 'claude.exe' : 'claude'); await writeFile(nativeExecutablePath, nativeBytes)
  await writeFile(join(payload, 'package.json'), JSON.stringify({ name: `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`,
    version: '0.3.263', os: [process.platform], cpu: [process.arch] }))
  const selection: ClaudeSequentialSelection = { connectionId: 'original-fixture-profile', profileRoot: profile, directory: projectPath,
    shellHome: home, nodePath: await realpath(process.execPath), nativeExecutablePath,
    nativeExecutableSha256: createHash('sha256').update(nativeBytes).digest('hex'), processGraceMs: 20,
    knownUnmanagedStartup: true,
    maxTurnMs: 5000, maxInputBytes: 65536, maxOutputBytes: 1048576, maxSessionBytes: 8388608 }
  const observedOptions: Options[] = []; const inputs: SDKUserMessage[] = []
  const wrapped: { argv: readonly string[]; policy: SandboxPolicy }[] = []; const spawned: SubprocessSpawnSpec[] = []
  const started = Promise.withResolvers<undefined>()
  const stdout = new PassThrough(); const stderr = new PassThrough(); const stdin = new PassThrough()
  const exit = Promise.withResolvers<SubprocessOutcome>(); const terminate = vi.fn(() => {
    stdout.end(); stderr.end(); exit.resolve({ exitCode: 0, signal: null })
  })
  let spawnSignal: AbortSignal | undefined
  stop = terminate; detach = () => { spawnSignal?.removeEventListener('abort', terminate) }
  class Confine extends SandboxProvider {
    override async confine(argv: readonly string[], policy: SandboxPolicy) {
      wrapped.push({ argv, policy }); return { argv: ['fixture-confine', ...argv], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] }
    }
  }
  class Processes extends SubprocessRuntime {
    override resolveExecutable(): never { throw new Error('No executable discovery') }
    override terminalEnvironment(): never { throw new Error('No terminal') }
    override spawnTerminal(): never { throw new Error('No terminal') }
    override spawn(spec: SubprocessSpawnSpec) {
      spawned.push(spec); spawnSignal = spec.signal; spawnSignal?.addEventListener('abort', terminate, { once: true })
      started.resolve(undefined)
      return { stdin, stdout, stderr, control: undefined, collected: {}, done: exit.promise, terminate,
        waitForExit: async () => { await exit.promise; return true } }
    }
  }
  const query = vi.fn<ClaudeSequentialSdk['query']>(({ prompt, options }) => {
    if (options === undefined || typeof prompt === 'string') throw new Error('Fixture requires the finite UUID-bearing native input stream.')
    const inputStream: AsyncIterable<SDKUserMessage> = prompt
    observedOptions.push(options)
    const process = options.spawnClaudeCodeProcess!({
      command: nativeExecutablePath, args: [], cwd: options.cwd!, env: { ...options.env }, signal: options.abortController!.signal,
    })
    async function* frames(): AsyncGenerator<SDKMessage> {
      for await (const input of inputStream) { inputs.push(input); yield* script(input, options!) }
      await started.promise; stdout.end(); stderr.end(diagnostics); exit.resolve({ exitCode: 0, signal: null })
    }
    // The fixture supplies only the SDK methods consumed by this production path.
    return Object.assign(frames(), { close: () => { process.kill('SIGTERM') } }) as Query
  })
  const resolveSdk = vi.fn(async (): Promise<ClaudeSequentialSdk> => ({ query }))
  const verifyStartupPolicy = vi.fn(async () => ({ noManagedSettingsObserved: true as const, fingerprint: 'a'.repeat(64) }))
  const moduleEntries: [string, unknown][] = [
    ['llm', Llm], ['session', Sessions], ['session-projection', Projection], ['system-prompt', Prompt], ['tools', Tools],
    ['agent', Agents], ['agent-loop', Loop], ['sandbox-policy', Policy], ['storage', Storage], ['storage-json', JsonStorage],
    ['storage-domain', Domain], ['session-persistence-jsonl', Jsonl], ['workspace', Workspace], ['typert-registry', Typert], ['skill-library', Library],
    ['fixture-confine', { default: Confine }], ['fixture-processes', { default: Processes }],
  ]
  const modules = new Map<string, unknown>(moduleEntries.map(([name, module]) => [`@deepseek-ai/dsh-${name}`, module]))
  const config: Record<string, object> = { 'storage-json': { root: join(root, 'storage') }, 'storage-domain': { backend: 'json' },
    'session-persistence-jsonl': { root: join(root, 'sessions'), compression: 'none' }, 'sandbox-policy': { mode: 'workspace-write' },
    'agent-loop': { agents: [] }, 'skill-library': { dshHome: join(root, 'home'), agentsHome: join(root, 'agents'), automaticMaintenanceIntervalMs: 0 } }
  const path = join(root, 'cordis.yml'); await writeFile(path, JSON.stringify([...modules.keys()].map(name => ({ name, config: config[name.replace('@deepseek-ai/dsh-', '')] }))))
  ctx.baseUrl = pathToFileURL(root).href + '/'; await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  const internal: ModuleLoaderV2 = { version: 'v2', loadCache: new Map(), async import(specifier) {
    if (!modules.has(specifier)) throw new Error(`Unknown fixture module ${specifier}`); return modules.get(specifier)
  }, register(): never { throw new Error('No registration') }, getOrCreateModuleJob(): never { throw new Error('No module job') },
  resolveSync(): never { throw new Error('No resolution') }, load(): never { throw new Error('No load') } }
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } }); await ctx.loader.await()
  const project = await ctx.workspaceRegistry.create(projectPath)
  const agent = await ctx.agentLoop.create(Sessions.SessionId('sequential-native-claude'), { provider: 'fixture-native-unused', model: 'fixture-native-model' }, { cwd: project.path })
  const acquired = await ctx.agents.withInitiator(agent,
    () => createClaudeSequentialExecutor(ctx, selection, nativeSessionId, resolveSdk, verifyStartupPolicy))
  owner.executor = acquired
  return {
    ctx, agent, project, selection, executor: acquired, query, resolveSdk, verifyStartupPolicy,
    inputs, observedOptions, wrapped, spawned, terminate,
  }
}

it('cold-acquires without a query, then preserves original ID, profile, conversation controls and natural process evidence', async () => {
  const f = await fixture(); expect(f.query).not.toHaveBeenCalled(); expect(f.resolveSdk).not.toHaveBeenCalled()
  const beforeDispatch = vi.fn(async () => {
    expect(f.query).not.toHaveBeenCalled()
    expect(f.agent.session.snapshotEvents().some(event => event.type === 'claude-code/root-protocol' && event.data.phase === 'request')).toBe(true)
  })
  const receipt = await f.executor.turn('Continue the original native conversation.', new AbortController().signal, beforeDispatch)
  expect(beforeDispatch).toHaveBeenCalledOnce(); expect(f.query).toHaveBeenCalledOnce(); expect(f.inputs).toHaveLength(1)
  expect(f.verifyStartupPolicy).toHaveBeenCalledOnce()
  expect(receipt).toMatchObject({
    nativeTurnId: f.inputs[0]?.uuid, processExited: true, streamsDrained: true, noObservedPersistenceErrors: true,
  })
  expect(receipt.assistants.map(message => message.id)).toEqual([frameIds.assistantFirst, frameIds.assistantLater])
  const options = f.observedOptions[0]!
  expect(options).toMatchObject({ resume: nativeSessionId, forkSession: false, persistSession: true, cwd: f.project.path,
    pathToClaudeCodeExecutable: f.selection.nativeExecutablePath, settingSources: [], tools: [], allowedTools: [],
    plugins: [], skills: [], mcpServers: {}, strictMcpConfig: true, permissionMode: 'default',
    env: { CLAUDE_CONFIG_DIR: f.selection.profileRoot, CLAUDE_CODE_DISABLE_FAST_MODE: '1' },
    settings: { disableAllHooks: true, fastMode: false, fastModePerSessionOptIn: true } })
  expect(options).not.toHaveProperty('sessionId'); expect(options).not.toHaveProperty('resumeSessionAt')
  expect(f.wrapped[0]?.policy).toMatchObject({ mode: 'workspace-write', workspaceRoot: claudeSequentialProjectDirectory(f.selection.profileRoot, f.project.path) })
  expect(f.spawned[0]?.argv).toEqual(['fixture-confine', f.selection.nativeExecutablePath])
  expect(f.terminate).not.toHaveBeenCalled()
  expect(await options.canUseTool!('Bash', {}, { signal: new AbortController().signal, toolUseID: 'never-granted', requestId: 'never-granted-request' })).toMatchObject({ behavior: 'deny' })
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'skill/native-item')).toEqual([])
  expect(f.ctx.skillLibrary.listLearningEvidence({ projectId: f.project.id })).toEqual([])
  await f.executor.close(); expect(f.terminate).not.toHaveBeenCalled()
})

it.each(['11111111-1111-4111-111111111111', '11111111-1111-4111-8111-11111111111', 'not-a-native-session'])('refuses malformed original native ID %j before SDK resolution', async (id) => {
  const f = await fixture()
  await expect(f.ctx.agents.withInitiator(f.agent, () => createClaudeSequentialExecutor(f.ctx, f.selection, id, f.resolveSdk, f.verifyStartupPolicy))).rejects.toThrow('exact canonical original source')
  expect(f.resolveSdk).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled(); expect(f.spawned).toEqual([])
})

const malformedStartupDeclarations: { name: string; value: unknown }[] = [
  { name: 'truthy number', value: 1 },
  { name: 'true string', value: 'true' },
  { name: 'false string', value: 'false' },
  { name: 'object', value: {} },
  { name: 'array', value: [] },
]
it.each(malformedStartupDeclarations)('refuses $name startup declaration before native admission', async ({ value }) => {
  const f = await fixture(); const beforeDispatch = vi.fn(async () => {})
  const selected = withStartupDeclaration(f.selection, value)
  await expect(f.ctx.agents.withInitiator(f.agent, async () => {
    const candidate = await createClaudeSequentialExecutor(f.ctx, selected, nativeSessionId, f.resolveSdk, f.verifyStartupPolicy)
    try { return await candidate.turn('Continue.', new AbortController().signal, beforeDispatch) }
    finally { await candidate.close() }
  })).rejects.toThrow('exact canonical original source')
  expect(f.verifyStartupPolicy).not.toHaveBeenCalled(); expect(f.resolveSdk).not.toHaveBeenCalled()
  expect(beforeDispatch).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled(); expect(f.spawned).toEqual([])
  expect(f.agent.session.snapshotEvents().filter(event => event.type === 'claude-code/root-protocol')).toEqual([])
})

it.each(['/clear', '! shell command', 'Human text\n/resume other'])('rejects native control input %j before durable admission or query', async (text) => {
  const f = await fixture(); const beforeDispatch = vi.fn(async () => {})
  await expect(f.executor.turn(text, new AbortController().signal, beforeDispatch)).rejects.toThrow('control commands')
  expect(beforeDispatch).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled(); expect(f.resolveSdk).not.toHaveBeenCalled()
})

it('does not dispatch after the initiating policy changes while the durable admission callback awaits', async () => {
  const f = await fixture(); const beforeDispatch = vi.fn(async () => { Policy.setSandboxMode(f.agent.session, 'read-only') })
  await expect(f.executor.turn('Continue.', new AbortController().signal, beforeDispatch)).rejects.toThrow('could not be confirmed')
  expect(beforeDispatch).toHaveBeenCalledOnce(); expect(f.query).not.toHaveBeenCalled(); expect(f.spawned).toEqual([])
  await expect(f.executor.close()).rejects.toThrow()
})

it('does not dispatch when durable admission fails or the selected payload digest changes', async () => {
  const f = await fixture(); const callback = vi.fn(async () => { throw new Error('Fixture journal refused') })
  await expect(f.executor.turn('Continue.', new AbortController().signal, callback)).rejects.toThrow('could not be confirmed')
  expect(callback).toHaveBeenCalledOnce(); expect(f.query).not.toHaveBeenCalled()
  const g = await fixture(); await writeFile(g.selection.nativeExecutablePath, 'changed fixture payload')
  const changed = vi.fn(async () => {})
  await expect(g.executor.turn('Continue.', new AbortController().signal, changed)).rejects.toThrow('could not be confirmed')
  expect(changed).not.toHaveBeenCalled(); expect(g.query).not.toHaveBeenCalled(); expect(g.resolveSdk).not.toHaveBeenCalled()
})

it.each(['managed', 'remote', 'helper', 'parent', 'unknown'])('refuses %s startup observation before durable admission and query', async (scope) => {
  const f = await fixture(); f.verifyStartupPolicy.mockRejectedValue(new Error(`Fixture ${scope} policy is refused`))
  const beforeDispatch = vi.fn(async () => {})
  await expect(f.executor.turn('Continue.', new AbortController().signal, beforeDispatch)).rejects.toThrow('could not be confirmed')
  expect(beforeDispatch).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled(); expect(f.spawned).toEqual([])
})

it.each(['wrong-original-id', 'native-tools-enabled', 'fast-enabled', 'fast-enabled-result', 'compaction'])('blocks %s and drains owned native work without a release receipt', async (failure) => {
  const f = await fixture(async function* (input, options): AsyncGenerator<SDKMessage> {
    for await (const message of normalFrames(input, options)) {
      if (failure === 'wrong-original-id' && message.type === 'assistant') { yield { ...message, session_id: '44444444-4444-4444-8444-444444444444' }; return }
      if (failure === 'native-tools-enabled' && message.type === 'system' && message.subtype === 'init') { yield { ...message, tools: ['Bash'] }; return }
      if (failure === 'fast-enabled' && message.type === 'system' && message.subtype === 'init') { yield { ...message, fast_mode_state: 'on' as const }; return }
      if (failure === 'fast-enabled-result' && message.type === 'result') { yield { ...message, fast_mode_state: 'on' as const }; return }
      if (failure === 'compaction' && message.type === 'system' && message.subtype === 'status') { yield { ...message, status: 'compacting' as const }; return }
      yield message
    }
  })
  await expect(f.executor.turn('Continue.', new AbortController().signal, async () => {})).rejects.toThrow('could not be confirmed')
  expect(f.terminate).toHaveBeenCalled(); await expect(f.executor.close()).rejects.toThrow()
})

it('rejects any observed native diagnostic bytes even after success and zero natural exit', async () => {
  const f = await fixture(normalFrames, 'fixture persistence warning')
  await expect(f.executor.turn('Continue.', new AbortController().signal, async () => {})).rejects.toThrow('could not be confirmed')
  await expect(f.executor.close()).rejects.toThrow()
})

it.each(['tool_use', 'server_tool_use', 'mcp_tool_use', 'tool_result', 'web_search_tool_result', 'code_execution_tool_result', 'compaction'])('refuses unsupported assistant %s blocks in conversation-only completion evidence', async (type) => {
  const f = await fixture(async function* (input, options) {
    for await (const message of normalFrames(input, options)) {
      if (message.type === 'assistant') {
        // Malformed/unsupported native protocol data is deliberately supplied as external input.
        yield { ...message, message: { ...message.message, content: [{ type, id: 'unsupported-native-block', name: 'unsupported', input: {}, content: 'unsupported' }] } } as SDKMessage
        return
      }
      yield message
    }
  })
  await expect(f.executor.turn('Continue.', new AbortController().signal, async () => {})).rejects.toThrow('could not be confirmed')
  expect(f.terminate).toHaveBeenCalled(); await expect(f.executor.close()).rejects.toThrow()
})

it.each(['container', 'context-management', 'server-tool-usage', 'malformed-text'])('refuses unsupported assistant %s metadata', async (failure) => {
  const f = await fixture(async function* (input, options) {
    for await (const message of normalFrames(input, options)) {
      if (message.type === 'assistant') {
        const body = structuredClone(message.message)
        if (failure === 'container') Reflect.set(body, 'container', { id: 'native-container' })
        if (failure === 'context-management') Reflect.set(body, 'context_management', { applied_edits: [{}] })
        if (failure === 'server-tool-usage') Reflect.set(body.usage, 'server_tool_use', { web_search_requests: 1 })
        if (failure === 'malformed-text') Reflect.set(body, 'content', [{ type: 'text', text: 42 }])
        yield { ...message, message: body }; return
      }
      yield message
    }
  })
  await expect(f.executor.turn('Continue.', new AbortController().signal, async () => {})).rejects.toThrow('could not be confirmed')
  expect(f.terminate).toHaveBeenCalled()
})

it('matches pinned long native project path encoding and NFC normalization', () => {
  const directory = `/fixture/${'é'.repeat(210)}`; const normalized = process.platform === 'darwin' ? directory.normalize('NFC') : directory
  let hash = 0; for (const char of normalized) hash = (hash << 5) - hash + char.charCodeAt(0) | 0
  const expected = `${normalized.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200)}-${Math.abs(hash).toString(36)}`
  expect(claudeSequentialProjectDirectory('/fixture/profile', directory)).toBe(join('/fixture/profile', 'projects', expected))
  if (process.platform === 'darwin') expect(claudeSequentialProjectDirectory('/fixture/profile', directory.normalize('NFD'))).toBe(claudeSequentialProjectDirectory('/fixture/profile', directory))
})
