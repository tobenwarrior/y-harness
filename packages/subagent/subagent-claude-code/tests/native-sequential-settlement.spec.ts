/** Real idle Y root and persistence composition; only native SDK and process enforcement are substituted. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { z } from 'zod'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
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
import * as Library from '@deepseek-ai/dsh-skill-library'
import { SandboxProvider, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SubprocessRuntime, { type SubprocessOutcome, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { claudeSequentialProjectDirectory, createClaudeSequentialExecutor, type ClaudeSequentialExecutor, type ClaudeSequentialSdk,
  type ClaudeSequentialSelection } from '../src/sequential.ts'
import { assistantBody } from './sdk-message-fixture.ts'
import { scriptedQuery } from './native-query-fixture.ts'

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
type Script = (input: SDKUserMessage, options: Options) => AsyncGenerator<SDKMessage, void>
async function* normalFrames(input: SDKUserMessage, options: Options): AsyncGenerator<SDKMessage, void> {
  const session_id = options.resume!; const send = input.uuid!
  const usageFields = { fallback_credit: { status: { type: 'not_applied', reason: 'not_enabled' } },
    output_tokens_details: { thinking_tokens: 0 } } as const
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
    usage: { ...usageFields, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0, inference_geo: 'fixture', input_tokens: 1,
      iterations: [], output_tokens: 1, server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
      service_tier: 'standard', speed: 'standard' } }
  yield { type: 'system', subtype: 'session_state_changed', state: 'idle', uuid: frameIds.idle, session_id }
}
async function fixture(script: Script = normalFrames, diagnostics = '', controls: {
  unconfirmed?: boolean
  hold?: Promise<void>
  closeThrows?: boolean
  skipSpawn?: boolean
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-sequential-claude-')))
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
  const nativeExecutablePath = join(payload, process.platform === 'win32' ? 'claude.exe' : 'claude')
  await writeFile(nativeExecutablePath, nativeBytes)
  await writeFile(join(payload, 'package.json'),
    JSON.stringify({ name: `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`,
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
      wrapped.push({ argv, policy }); return { argv: ['fixture-confine', ...argv], enforcement: 'full' as const, denialSignatures: [],
        runnerFailureRules: [] }
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
        waitForExit: async () => { await exit.promise; return controls.unconfirmed !== true } }
    }
  }
  const query = vi.fn<ClaudeSequentialSdk['query']>(({ prompt, options }) => {
    if (options === undefined || typeof prompt === 'string') throw new Error('Fixture requires the finite UUID-bearing native input stream.')
    const inputStream: AsyncIterable<SDKUserMessage> = prompt
    observedOptions.push(options)
    const process = controls.skipSpawn ? undefined : options.spawnClaudeCodeProcess!({
      command: nativeExecutablePath, args: [], cwd: options.cwd!, env: { ...options.env }, signal: options.abortController!.signal,
    })
    async function* frames(): AsyncGenerator<SDKMessage, void> {
      for await (const input of inputStream) { inputs.push(input); yield* script(input, options!) }
      if (!controls.skipSpawn) await started.promise; await controls.hold; if (!stdout.writableEnded) stdout.end()
      if (!stderr.writableEnded) stderr.end(diagnostics); exit.resolve({ exitCode: 0, signal: null })
    }
    // The fixture supplies only the SDK methods consumed by this production path.
    return scriptedQuery(frames(), () => { process?.kill('SIGTERM')
      if (controls.closeThrows) throw new Error('external SDK close failure') })
  })
  const resolveSdk = vi.fn(async (): Promise<ClaudeSequentialSdk> => ({ query }))
  const verifyStartupPolicy = vi.fn(async () => ({ noManagedSettingsObserved: true as const, fingerprint: 'a'.repeat(64) }))
  const moduleEntries: [string, unknown][] = [
    ['llm', Llm], ['session', Sessions], ['session-projection', Projection], ['system-prompt', Prompt], ['tools', Tools],
    ['agent', Agents], ['agent-loop', Loop], ['sandbox-policy', Policy], ['storage', Storage], ['storage-json', JsonStorage],
    ['storage-domain', Domain], ['session-persistence-jsonl', Jsonl], ['workspace', Workspace], ['typert-registry', Typert],
    ['skill-library', Library],
    ['fixture-confine', { default: Confine }], ['fixture-processes', { default: Processes }],
  ]
  const modules = new Map<string, unknown>(moduleEntries.map(([name, module]) => [`@deepseek-ai/dsh-${name}`, module]))
  const config: Record<string, object> = { 'storage-json': { root: join(root, 'storage') }, 'storage-domain': { backend: 'json' },
    'session-persistence-jsonl': { root: join(root, 'sessions'), compression: 'none' }, 'sandbox-policy': { mode: 'workspace-write' },
    'agent-loop': { agents: [] }, 'skill-library': { dshHome: join(root, 'home'), agentsHome: join(root, 'agents'),
      automaticMaintenanceIntervalMs: 0 } }
  const path = join(root, 'cordis.yml'); await writeFile(path, JSON.stringify([...modules.keys()].map(name => ({ name,
    config: config[name.replace('@deepseek-ai/dsh-', '')] }))))
  ctx.baseUrl = pathToFileURL(root).href + '/'; await ctx.plugin(Loader); ctx.loader.builtins.include = Include
  const internal: ModuleLoaderV2 = { version: 'v2', loadCache: new Map(), async import(specifier) {
    if (!modules.has(specifier)) throw new Error(`Unknown fixture module ${specifier}`); return modules.get(specifier)
  }, register(): never { throw new Error('No registration') }, getOrCreateModuleJob(): never { throw new Error('No module job') },
  resolveSync(): never { throw new Error('No resolution') }, load(): never { throw new Error('No load') } }
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } }); await ctx.loader.await()
  const project = await ctx.workspaceRegistry.create(projectPath)
  const agent = await ctx.agentLoop.create(Sessions.SessionId('sequential-native-claude'), { provider: 'fixture-native-unused',
    model: 'fixture-native-model' }, { cwd: project.path })
  const acquired = await ctx.agents.withInitiator(agent,
    () => createClaudeSequentialExecutor(ctx, selection, nativeSessionId, resolveSdk, verifyStartupPolicy))
  owner.executor = acquired
  return {
    ctx, agent, project, selection, executor: acquired, query, resolveSdk, verifyStartupPolicy,
    inputs, observedOptions, wrapped, spawned, terminate, stdout, stderr, exit,
  }
}


const sdkWireEnvelope = z.custom<SDKMessage>(value => typeof value === 'object' && value !== null
  && 'type' in value && ['assistant', 'user', 'system', 'result'].includes(String(value.type)))
function wire(value: object): SDKMessage {
  const decoded: unknown = JSON.parse(JSON.stringify(value))
  return sdkWireEnvelope.parse(decoded)
}

it('refuses cold acquisition without an initiator and under a full-access current policy', async () => {
  const f = await fixture()
  await expect(createClaudeSequentialExecutor(f.ctx, f.selection, nativeSessionId, f.resolveSdk,
    f.verifyStartupPolicy)).rejects.toThrow('live root')
  Policy.setSandboxMode(f.agent.session, 'danger-full-access')
  await expect(f.ctx.agents.withInitiator(f.agent, () => createClaudeSequentialExecutor(f.ctx, f.selection, nativeSessionId, f.resolveSdk,
    f.verifyStartupPolicy))).rejects.toThrow('confined Y policy')
  expect(f.query).not.toHaveBeenCalled()
})

it('rejects empty, oversized and cancelled human sends before durable admission', async () => {
  const f = await fixture(); const before = vi.fn(async () => {})
  for (const text of [' ', 'x'.repeat(f.selection.maxInputBytes + 1)]) await expect(f.executor.turn(text, new AbortController().signal,
    before)).rejects.toThrow('bounded conversation')
  const cancelled = new AbortController(); cancelled.abort(new Error('human cancelled'))
  await expect(async () => f.executor.turn('Continue.', cancelled.signal, before)).rejects.toThrow('human cancelled')
  expect(before).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled()
})

it.each(['linked-payload', 'linked-manifest', 'manifest-directory', 'oversized-manifest', 'wrong-platform', 'wrong-os',
  'wrong-cpu'])('refuses selected %s before SDK resolution or durable dispatch', async (kind) => {
  const f = await fixture(); const manifest = join(f.selection.nativeExecutablePath, '..', 'package.json')
  if (kind === 'linked-payload') {
    const target = f.selection.nativeExecutablePath + '-target'; await rm(f.selection.nativeExecutablePath)
    await writeFile(target, 'fixture'); await symlink(target, f.selection.nativeExecutablePath)
  } else if (kind === 'linked-manifest') {
    const target = manifest + '-target'; await rm(manifest); await writeFile(target, '{}'); await symlink(target, manifest)
  } else if (kind === 'manifest-directory') { await rm(manifest); await mkdir(manifest) }
  else if (kind === 'oversized-manifest') await writeFile(manifest, 'x'.repeat(65537))
  else await writeFile(manifest,
    JSON.stringify({ name: kind === 'wrong-platform' ? '@anthropic-ai/other' : `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`,
      version: '0.3.263', os: kind === 'wrong-os' ? [] : [process.platform], cpu: kind === 'wrong-cpu' ? [] : [process.arch] }))
  const before = vi.fn(async () => {})
  await expect(f.executor.turn('Continue.', new AbortController().signal, before)).rejects.toThrow('could not be confirmed')
  expect(before).not.toHaveBeenCalled(); expect(f.resolveSdk).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled()
})

it('refuses replaced original transcript and noncanonical selected project paths', async () => {
  const f = await fixture(); const transcript = join(claudeSequentialProjectDirectory(f.selection.profileRoot, f.selection.directory),
    `${nativeSessionId}.jsonl`)
  await rm(transcript); await mkdir(transcript)
  await expect(f.executor.turn('Continue.', new AbortController().signal, async () => {})).rejects.toThrow('could not be confirmed')
  expect(f.query).not.toHaveBeenCalled()
  const g = await fixture(); const project = g.selection.directory; const moved = project + '-original'; await rename(project, moved)
  await symlink(moved, project)
  await expect(g.executor.turn('Continue.', new AbortController().signal, async () => {})).rejects.toThrow('could not be confirmed')
  expect(g.query).not.toHaveBeenCalled()
})

it('refuses a nondurable public request and a policy change while its flush awaits', async () => {
  const f = await fixture(); vi.spyOn(f.ctx.sessions, 'flush').mockResolvedValueOnce(false)
  const before = vi.fn(async () => {})
  await expect(f.executor.turn('Continue.', new AbortController().signal, before)).rejects.toThrow('could not be confirmed')
  expect(before).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled()
  const g = await fixture(); const flush = g.ctx.sessions.flush.bind(g.ctx.sessions)
  vi.spyOn(g.ctx.sessions, 'flush').mockImplementationOnce(async (session) => { const result = await flush(session)
    Policy.setSandboxMode(g.agent.session, 'read-only'); return result })
  await expect(g.executor.turn('Continue.', new AbortController().signal, async () => {})).rejects.toThrow('could not be confirmed')
  expect(g.query).not.toHaveBeenCalled()
})

it.each(['duplicate-init', 'no-init', 'no-result', 'no-assistant', 'duplicate-result', 'after-result', 'wrong-echo', 'multiple-echoes',
  'nested', 'aborted', 'synthetic', 'replay', 'assistant-error', 'subagent', 'superseded', 'resumed-thinking', 'queued-result',
  'failed-result', 'error-result', 'multiple-result-echoes', 'oversized-frame', 'single-wrong-echo',
  'single-wrong-result-echo'])('refuses external %s conversation evidence and withholds release', async (failure) => {
  const f = await fixture(async function* (input, options) {
    for await (const message of normalFrames(input, options)) {
      if (message.type === 'system' && message.subtype === 'init') {
        if (failure === 'no-init') continue
        yield message
        if (failure === 'duplicate-init') yield message
        if (failure === 'oversized-frame') yield wire({ type: 'system', subtype: 'status', status: null, session_id: options.resume!,
          uuid: 'large', note: 'x'.repeat(1048577) })
        continue
      }
      if (message.type === 'assistant') {
        if (failure === 'no-assistant') continue
        const change = failure === 'single-wrong-echo' ? { user_message_uuids: ['wrong'] } : failure === 'wrong-echo' ? { user_message_uuid: 'wrong' } : failure === 'multiple-echoes' ? { user_message_uuids: [input.uuid!, 'wrong'] }
          : failure === 'nested' ? { parent_tool_use_id: 'worker' } : failure === 'aborted' ? { aborted: true }
            : failure === 'synthetic' ? { isSynthetic: true } : failure === 'replay' ? { isReplay: true }
              : failure === 'assistant-error' ? { error: 'invalid_request' } : failure === 'subagent' ? { subagent_type: 'worker' }
                : failure === 'superseded' ? { supersedes: ['previous'] } : failure === 'resumed-thinking' ? { resumed_from_incomplete_thinking: true } : {}
        yield wire({ ...message, ...change }); continue
      }
      if (message.type === 'result') {
        if (failure === 'no-result') continue
        yield wire({ ...message, ...failure === 'queued-result' ? { queued_turn_count: 1 } : {},
          ...failure === 'failed-result' ? { subtype: 'error_during_execution' } : {},
          ...failure === 'error-result' ? { is_error: true } : {},
          ...failure === 'single-wrong-result-echo' ? { user_message_uuids: ['wrong'] } : {},
          ...failure === 'multiple-result-echoes' ? { user_message_uuids: [input.uuid!, 'wrong'] } : {} })
        if (failure === 'duplicate-result') yield message
        if (failure === 'after-result') yield wire({ type: 'assistant', uuid: 'late', session_id: options.resume!,
          parent_tool_use_id: null, message: assistantBody([{ type: 'text', text: 'late', citations: null }]) })
        continue
      }
      yield message
    }
  })
  await expect(f.executor.turn('Continue.', new AbortController().signal, async () => {})).rejects.toThrow('could not be confirmed')
  await expect(f.executor.close()).rejects.toThrow()
})

it('rechecks policy in all native control callbacks and refuses native spawn profile changes', async () => {
  const replies: unknown[] = []
  const f = await fixture(async function* (input, options) {
    const control = { signal: new AbortController().signal, requestId: 'fixture-control' }
    replies.push(await options.hooks!.PreToolUse![0]!.hooks[0]!({ hook_event_name: 'PreToolUse', session_id: options.resume!,
      transcript_path: '', cwd: options.cwd!, tool_name: 'Read', tool_input: {}, tool_use_id: 'tool' }, 'tool', control))
    replies.push(await options.onElicitation!({ serverName: 'fixture', message: 'fixture' }, control))
    replies.push(await options.onUserDialog!({ dialogKind: 'fixture', payload: {} }, control))
    yield* normalFrames(input, options)
  })
  await f.executor.turn('Continue.', new AbortController().signal, async () => {})
  expect(replies).toEqual([expect.objectContaining({ hookSpecificOutput: { permissionDecision: 'deny', hookEventName: 'PreToolUse',
    permissionDecisionReason: 'Sequential handoff is conversation only.' } }), { action: 'decline' }, { behavior: 'cancelled' }])
  const g = await fixture(async function* (_input, options) {
    Policy.setSandboxMode(g.agent.session, 'read-only')
    await options.canUseTool!('Read', {}, { signal: new AbortController().signal, requestId: 'tool-control', toolUseID: 'tool' }); yield* []
  })
  await expect(g.executor.turn('Continue.', new AbortController().signal, async () => {})).rejects.toThrow('could not be confirmed')
})

it('refuses repeated SDK spawn and contains a thrown SDK close during failure settlement', async () => {
  const f = await fixture(async function* (_input, options) {
    options.spawnClaudeCodeProcess!({ command: options.pathToClaudeCodeExecutable!, args: [], cwd: options.cwd!, env: { ...options.env },
      signal: options.abortController!.signal })
    yield* []
  }, '', { closeThrows: true })
  await expect(f.executor.turn('Continue.', new AbortController().signal, async () => {})).rejects.toThrow('could not be confirmed')
  await expect(f.executor.close()).rejects.toThrow()
})

it('rejects an SDK success without an owned process and poisons uncertain range release', async () => {
  const f = await fixture(normalFrames, '', { skipSpawn: true })
  await expect(f.executor.turn('Continue.', new AbortController().signal, async () => {})).rejects.toThrow('could not be confirmed')
  const g = await fixture(normalFrames, '', { unconfirmed: true })
  await expect(g.executor.turn('Continue.', new AbortController().signal, async () => {})).rejects.toThrow('could not be confirmed')
  await expect(g.executor.close()).rejects.toThrow(); expect(g.executor.current()).toBe(false)
})

it('rejects concurrent sends and waits for active work when the executor closes', async () => {
  const ready = Promise.withResolvers<undefined>(); const released = Promise.withResolvers<undefined>()
  const f = await fixture(async function* (input, options) { ready.resolve(undefined); await released.promise; yield* normalFrames(input,
    options) })
  const turn = f.executor.turn('Continue.', new AbortController().signal, async () => {})
  const refused = expect(turn).rejects.toThrow('could not be confirmed'); await ready.promise
  await expect(f.executor.turn('Overlapping.', new AbortController().signal, async () => {})).rejects.toThrow('bounded conversation')
  let settled = false; const close = f.executor.close().finally(() => { settled = true }); void close.catch(() => {})
  expect(settled).toBe(false); released.resolve(undefined); await refused; await expect(close).rejects.toThrow()
  expect(f.executor.current()).toBe(false); expect(f.terminate).toHaveBeenCalled()
})

it('bounds ordinary native payload verification before dispatch', async () => {
  const f = await fixture(); await truncate(f.selection.nativeExecutablePath, 512 * 1024 * 1024 + 1)
  await expect(f.executor.turn('Continue.', new AbortController().signal, async () => {})).rejects.toThrow('could not be confirmed')
  expect(f.resolveSdk).not.toHaveBeenCalled()
})

it('refuses policy-service failure and policy changes during acquisition, startup observation or frame consumption', async () => {
  const f = await fixture(); vi.spyOn(f.ctx.sandboxPolicy,
    'resolve').mockImplementationOnce(() => { throw new Error('fixture policy service unavailable') })
  expect(f.executor.current()).toBe(false)
  const g = await fixture(); const acquired = g.ctx.agents.withInitiator(g.agent, () => createClaudeSequentialExecutor(g.ctx, g.selection,
    nativeSessionId, g.resolveSdk, g.verifyStartupPolicy))
  Policy.setSandboxMode(g.agent.session, 'read-only'); await expect(acquired).rejects.toThrow('during authority resolution')
  const h = await fixture(); h.resolveSdk.mockImplementationOnce(async () => { Policy.setSandboxMode(h.agent.session, 'read-only')
    return { query: h.query } })
  await expect(h.executor.turn('Continue.', new AbortController().signal, async () => {})).rejects.toThrow('could not be confirmed')
  expect(h.query).not.toHaveBeenCalled()
  const i = await fixture(async function* (input, options) {
    for await (const message of normalFrames(input, options)) { Policy.setSandboxMode(i.agent.session, 'read-only'); yield message; return }
  })
  await expect(i.executor.turn('Continue.', new AbortController().signal, async () => {})).rejects.toThrow('could not be confirmed')
})
