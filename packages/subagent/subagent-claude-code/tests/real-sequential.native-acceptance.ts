/** Actual pinned SDK/CLI and Y process confinement; only Messages responses and transport routing are fixtures. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import * as Llm from '@deepseek-ai/dsh-llm'
import * as Sessions from '@deepseek-ai/dsh-session'
import * as Projection from '@deepseek-ai/dsh-session-projection'
import * as Prompt from '@deepseek-ai/dsh-system-prompt'
import * as Tools from '@deepseek-ai/dsh-tools'
import * as Agents from '@deepseek-ai/dsh-agent'
import * as Loop from '@deepseek-ai/dsh-agent-loop'
import * as Policy from '@deepseek-ai/dsh-sandbox-policy'
import * as Storage from '../../../storage/storage/src/index.ts'
import * as JsonStorage from '../../../storage/storage-json/src/index.ts'
import * as Domain from '../../../storage/storage-domain/src/index.ts'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Workspace from '@deepseek-ai/dsh-workspace'
import * as Typert from '../../../typert/registry/src/index.ts'
import { LocalSandboxProvider } from '../../../sandbox/sandbox-local/src/index.ts'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { createClaudeSource, type ClaudeSource, type ClaudeSourceConfig } from '../../../session/coding-session/src/claude-source.ts'
import { createClaudeSequentialWriter, type ClaudeSequentialWriterOwner } from '../../../session/coding-session/src/claude-sequential.ts'
import { claudeSourceMessagesSchema, claudeSourceReplySchema, claudeSequentialPolicyReceiptSchema } from '../../../session/coding-session/src/claude-source-worker.ts'
import type { CodingSessionNativeId, CodingSessionOwnerToken, CodingSessionReadRequest, CodingSessionSource } from '../../../session/coding-session/src/types.ts'
import { ClaudeRootProcess } from '../src/root-process.ts'
import { claudeSequentialProjectDirectory, createClaudeSequentialExecutor } from '../src/sequential.ts'
import { startMessagesFixture, type MessagesFixture } from './messages-fixture.ts'

const originalPrompt = 'Store ORIGINAL_NATIVE_FIXTURE_INPUT in the original conversation.'
const continuationPrompt = 'Continue the exact original conversation with CONTINUED_NATIVE_FIXTURE_INPUT.'
const fakeKey = 'dsh-sequential-fixture-dummy-key'
const answer = 'SEQUENTIAL_NATIVE_FIXTURE_ANSWER'
const bytes = 1048576
const graceMs = 5000
const pinnedSdkModuleSha256 = '3d690c23ec82b4ba05f7ac8c26e2510f84e112c68ced68053ec40cf7d5dcbfe2'
const pinnedSdkManifestSha256 = 'dda13abc4e1fc75c83c525e7f926ada50a0049055b5a0c74f277e0c1e5286d5e'
const pinnedDarwinArm64Sha256 = 'ef5d2909c8af49f31ab6d5487e90316777bc2fac170adfe8160716caa8aaf4f9'

/** Clear inherited names rather than borrowing the developer's API, proxy, or native account environment. */
function fixtureEnvironment(home: string, profile: string, baseUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]))
  return { ...env, PATH: process.env.PATH, LANG: 'en_US.UTF-8', TMPDIR: '/tmp',
    HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: profile, XDG_CONFIG_HOME: join(home, 'xdg'),
    ANTHROPIC_API_KEY: fakeKey, ANTHROPIC_BASE_URL: baseUrl,
    CLAUDE_CODE_DISABLE_FAST_MODE: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost',
    http_proxy: '', https_proxy: '', all_proxy: '', no_proxy: '127.0.0.1,localhost' }
}

/** Retain the real Y file-effect profile and add only an exact-loopback-port network restriction. */
function sandboxModule(port: number) {
  return class LoopbackSandbox extends LocalSandboxProvider {
    override async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal) {
      const confined = await super.confine(argv, policy, signal)
      const [runner, option, profile, separator] = confined.argv
      if (process.platform !== 'darwin' || runner !== 'sandbox-exec' || option !== '-p'
        || profile === undefined || separator !== '--' || confined.enforcement !== 'full') {
        throw new Error('Actual sequential fixture requires the unchanged macOS Y Seatbelt confiner.')
      }
      return { ...confined, argv: [runner, option,
        `${profile} (deny network*) (allow network-outbound (remote tcp "localhost:${port}"))`,
        separator, ...confined.argv.slice(4)] }
    }
  }
}

async function boot(ctx: Context, root: string, port: number): Promise<void> {
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  const entries: [string, unknown][] = [
    ['llm', Llm], ['session', Sessions], ['session-projection', Projection], ['system-prompt', Prompt],
    ['tools', Tools], ['agent', Agents], ['agent-loop', Loop], ['sandbox-policy', Policy],
    ['storage', Storage], ['storage-json', JsonStorage], ['storage-domain', Domain],
    ['session-persistence-jsonl', Jsonl], ['workspace', Workspace], ['typert-registry', Typert],
    ['fixture-sandbox', { default: sandboxModule(port) }], ['fixture-subprocess', { default: LocalSubprocessRuntime }],
  ]
  const modules = new Map<string, unknown>(entries.map(([name, module]) => [`@deepseek-ai/dsh-${name}`, module]))
  const internal = ctx.loader.internal
  if (internal === undefined) throw new Error('Actual fixture needs Loader module resolution')
  ctx.loader.internal = new Proxy(internal, { get(target, property, receiver): unknown {
    if (property === 'import') return async (specifier: string) => {
      if (!modules.has(specifier)) throw new Error('Unexpected actual fixture module')
      return modules.get(specifier)
    }
    return Reflect.get(target, property, receiver)
  } })
  const config: Record<string, object> = {
    'storage-json': { root: join(root, 'storage') }, 'storage-domain': { backend: 'json' },
    'session-persistence-jsonl': { root: join(root, 'sessions'), compression: 'none' },
    'sandbox-policy': { mode: 'workspace-write' }, 'agent-loop': { agents: [] },
  }
  for (const name of modules.keys()) await ctx.loader.create({ name, config: config[name.replace('@deepseek-ai/dsh-', '')] })
  await ctx.loader.await()
}

async function readStream(handle: SubprocessHandle, maxBytes = bytes): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  const stream = handle.stdout
  if (stream === undefined) throw new Error('Actual fixture requires an owned output pipe')
  const drain = (async () => {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value))
      total += chunk.length
      if (total > maxBytes) { handle.terminate(); throw new Error('Actual fixture output exceeded its bound') }
      chunks.push(chunk)
    }
  })()
  const [outcome] = await Promise.all([handle.done, drain])
  expect(outcome).toEqual({ exitCode: 0, signal: null })
  expect(await handle.waitForExit(AbortSignal.timeout(graceMs + 1000))).toBe(true)
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
}

/** Kernel acceptance is required before the first native CLI receives the fake key. */
async function proveNetworkFence(
  ctx: Context, root: string, env: NodeJS.ProcessEnv, allowedPort: number, deniedPort: number,
): Promise<void> {
  const script = `const {createConnection}=require('node:net');
const connect=p=>new Promise(resolve=>{const s=createConnection({host:'127.0.0.1',port:p});
s.once('connect',()=>{s.destroy();resolve('allowed')});s.once('error',e=>resolve(e.code));
s.setTimeout(3000,()=>{s.destroy();resolve('TIMEOUT')})});
Promise.all([connect(${allowedPort}),connect(${deniedPort})]).then(v=>process.stdout.write(JSON.stringify(v)+'\\n'));`
  const confined = await ctx.sandbox.confine([process.execPath, '-e', script], { mode: 'read-only', workspaceRoot: root })
  const handle = ctx.subprocess.spawn({ argv: confined.argv, cwd: root, env, signal: AbortSignal.timeout(10000),
    graceMs, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 1024 } } })
  expect(JSON.parse(await readStream(handle))).toEqual(['allowed', 'EPERM'])
}

/** The production transcript policy must deny harmless sibling project/profile writes before native resume. */
async function proveTranscriptFence(
  ctx: Context, stateDirectory: string, project: string, profile: string, env: NodeJS.ProcessEnv,
): Promise<void> {
  const targets = [join(stateDirectory, 'fixture-write-probe'), join(project, 'fixture-denied-probe'), join(profile, 'fixture-denied-probe')]
  const script = `const fs=require('node:fs');process.stdout.write(JSON.stringify(${JSON.stringify(targets)}.map(p=>{
try{fs.writeFileSync(p,'OWNED_FIXTURE_PROBE');return 'allowed'}catch(e){return e.code}}))+'\\n');`
  const confined = await ctx.sandbox.confine([process.execPath, '-e', script], { mode: 'workspace-write', workspaceRoot: stateDirectory })
  const handle = ctx.subprocess.spawn({ argv: confined.argv, cwd: project, env, graceMs, signal: AbortSignal.timeout(10000),
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: 1024 } } })
  expect(JSON.parse(await readStream(handle))).toEqual(['allowed', 'EPERM', 'EPERM'])
  await rm(targets[0]!)
}

/** Hash complete file bytes independently of the source owner's digest helper. */
async function sha(path: string): Promise<string> {
  const file = await open(path, 'r'); const hash = createHash('sha256'); let total = 0
  try {
    const buffer = Buffer.alloc(65536)
    for (;;) {
      const result = await file.read(buffer, 0, buffer.length, null)
      if (result.bytesRead === 0) return hash.digest('hex')
      total += result.bytesRead
      if (total > 512 * 1024 * 1024) throw new Error('Actual fixture selected artifact exceeded its certification byte limit')
      hash.update(buffer.subarray(0, result.bytesRead))
    }
  } finally { await file.close() }
}

/** Bound cleanup publication while retaining uncertain fixtures; timeout never supplies an exit receipt. */
async function boundedCleanup(work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error('Actual native fixture cleanup exceeded its bounded observation window.')) }, 10000) })
  try { await Promise.race([work, timeout]) } finally { if (timer !== undefined) clearTimeout(timer) }
}

/** Only the actual native SDK query's transport env changes; its process owner and all production controls remain intact. */
function loopbackSdk(actual: typeof import('@anthropic-ai/claude-agent-sdk'), env: NodeJS.ProcessEnv, observed: SDKMessage[]) {
  return { query(request: { prompt: string | AsyncIterable<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>; options?: Options }): Query {
    const query = actual.query({ ...request, options: { ...request.options, env: { ...request.options?.env, ...env } } })
    return new Proxy(query, { get(target, property): unknown {
      if (property === Symbol.asyncIterator) return async function* () {
        for await (const message of target) { observed.push(message); yield message }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  } }
}

it.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')('persists a confined actual original-ID Claude continuation and releases only after cold exact-body readback', async () => {
  // These imports resolve to installed official artifacts. There is no vi.mock SDK or process implementation.
  const sdkModulePath = await realpath(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk')))
  const sdkManifestPath = join(dirname(sdkModulePath), 'package.json')
  expect(await sha(sdkModulePath)).toBe(pinnedSdkModuleSha256)
  expect(await sha(sdkManifestPath)).toBe(pinnedSdkManifestSha256)
  const manifest = z.object({ version: z.literal('0.3.263'), claudeCodeVersion: z.literal('2.1.263') }).parse(JSON.parse(await readFile(sdkManifestPath, 'utf8')))
  expect(manifest).toEqual({ version: '0.3.263', claudeCodeVersion: '2.1.263' })
  const platformRoot = join(dirname(sdkModulePath), '..', `claude-agent-sdk-${process.platform}-${process.arch}`)
  const nativeExecutablePath = await realpath(join(platformRoot, 'claude'))
  const nativeExecutableSha256 = await sha(nativeExecutablePath)
  expect(nativeExecutableSha256).toBe(pinnedDarwinArm64Sha256)
  const actual = await import('@anthropic-ai/claude-agent-sdk')
  const nodePath = await realpath(process.execPath)
  const workerPath = await realpath(fileURLToPath(new URL('../../../session/coding-session/lib/types/claude-source-worker.js', import.meta.url)))

  // Outside /tmp, so the transcript-only resume cannot borrow Y's general temp write grants for profile/project files.
  const root = await realpath(await mkdtemp(join(process.cwd(), '.fixture-claude-sequential-')))
  const resources: {
    ctx?: Context
    server?: MessagesFixture
    denied?: MessagesFixture
    owner?: ClaudeSequentialWriterOwner
    sourceOwner?: ClaudeSource
    seed?: Query
    restoreSpawn?: () => void
  } = {}
  let seedProcess: ClaudeRootProcess | undefined
  const lifetime = new AbortController(); const handles: SubprocessHandle[] = []
  // One ordered cleanup owns every acquired resource; profiles survive any unconfirmed process range.
  onTestFinished(async () => {
    lifetime.abort()
    const failures: unknown[] = []; let quiescent = true
    try { resources.seed?.close() } catch (error: unknown) { quiescent = false; failures.push(error) }
    for (const close of [
      async () => { await resources.owner?.close() },
      async () => { await resources.sourceOwner?.close() },
      async () => { await resources.ctx?.fiber.dispose() },
    ]) {
      try { await boundedCleanup(close()) } catch (error: unknown) { quiescent = false; failures.push(error) }
    }
    if (seedProcess !== undefined) {
      try {
        await boundedCleanup(Promise.allSettled([seedProcess.done]))
      } catch (error: unknown) { quiescent = false; failures.push(error) }
    }
    const ranges = await Promise.allSettled(handles.map(handle => handle.waitForExit(AbortSignal.timeout(graceMs + 1000))))
    for (const result of ranges) {
      if (result.status === 'rejected') { quiescent = false; failures.push(result.reason) }
      else if (!result.value) quiescent = false
    }
    for (const fixture of [resources.server, resources.denied]) {
      try { await boundedCleanup(fixture?.close() ?? Promise.resolve()) } catch (error: unknown) { quiescent = false; failures.push(error) }
    }
    resources.restoreSpawn?.()
    if (quiescent) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    else failures.push(new Error('Actual native fixture retained its isolated profile because process release was not confirmed.'))
    if (failures.length > 0) throw new AggregateError(failures, 'Actual native fixture teardown was incomplete')
  }, 90000)
  const home = join(root, 'home'); const profile = join(home, '.claude'); const project = join(root, 'project')
  await mkdir(join(project, '.git'), { recursive: true }); await mkdir(join(home, 'xdg'), { recursive: true })
  await mkdir(profile, { recursive: true }); await writeFile(join(profile, 'settings.json'), '{}\n')
  const sentinel = join(project, 'untouched.txt'); await writeFile(sentinel, 'PROJECT_SENTINEL_UNCHANGED\n')
  const beforeSentinel = await readFile(sentinel)
  const server = resources.server = await startMessagesFixture({ kind: 'complete', text: answer })
  const denied = resources.denied = await startMessagesFixture({ kind: 'hold' })
  const allowedPort = Number(new URL(server.baseUrl).port); const deniedPort = Number(new URL(denied.baseUrl).port)
  const env = fixtureEnvironment(home, profile, server.baseUrl)
  const runtime = resources.ctx = new Context()
  await boot(runtime, root, allowedPort)
  const specs: SubprocessSpawnSpec[] = []
  const spawn = runtime.subprocess.spawn.bind(runtime.subprocess)
  const observedSpawn = vi.spyOn(runtime.subprocess, 'spawn').mockImplementation((spec) => {
    specs.push(spec)
    const handle = spawn(spec)
    handles.push(handle)
    return handle
  })
  resources.restoreSpawn = () => { observedSpawn.mockRestore() }
  await proveNetworkFence(runtime, root, env, allowedPort, deniedPort)
  expect(denied.requests).toEqual([])
  await runtime.workspaceRegistry.create(project)
  const agent = await runtime.agentLoop.create(Sessions.SessionId(`sequential-fixture-y-root-${randomUUID()}`), { provider: 'fixture-never-called', model: 'fixture-never-called' }, { cwd: project })
  expect(agent.status).toBe('idle')
  const original = brandString<CodingSessionNativeId>(randomUUID())
  const stateDirectory = claudeSequentialProjectDirectory(profile, project)
  await mkdir(stateDirectory, { recursive: true })
  const frames: SDKMessage[] = []
  const sdk = loopbackSdk(actual, env, frames)
  const seedSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(60000)])
  const sdkModuleSha256 = await sha(sdkModulePath)
  const inspectPolicy = async (signal: AbortSignal) => {
    const body = JSON.stringify({ protocol: 1, operation: 'inspectSequentialPolicy', profileRoot: profile, directory: project,
      shellHome: home, sdkModulePath, sdkManifestPath, sdkModuleSha256, sdkVersion: '0.3.263', maxBytes: bytes, maxEvents: 100 }) + '\n'
    const confined = await runtime.sandbox.confine([nodePath, workerPath, String(bytes)], { mode: 'read-only', workspaceRoot: project }, signal)
    const handle = runtime.subprocess.spawn({ argv: confined.argv, cwd: project, env, graceMs, signal,
      stdio: { stdin: { data: body }, stdout: 'pipe', stderr: 'pipe' } })
    let diagnosticBytes = 0
    const diagnostics = (async () => { if (handle.stderr === undefined) throw new Error('Actual policy reader diagnostic pipe is unavailable')
      for await (const value of handle.stderr) {
        diagnosticBytes += Buffer.isBuffer(value) ? value.length : Buffer.byteLength(String(value))
        if (diagnosticBytes > 0) { handle.terminate(); throw new Error('Actual startup-policy observation emitted unsupported diagnostics') }
      } })()
    const [text] = await Promise.all([readStream(handle), diagnostics])
    expect(diagnosticBytes).toBe(0)
    const reply = claudeSourceReplySchema.parse(JSON.parse(text))
    if (!reply.ok) throw new Error(`Actual public SDK startup-policy read was refused (${reply.error})`)
    return claudeSequentialPolicyReceiptSchema.parse(reply.value)
  }
  if (process.env.Y_HARNESS_CLAUDE_FIXTURE_KNOWN_UNMANAGED_STARTUP !== '1') {
    throw new Error('Actual native fixture requires an explicit operator declaration of known unmanaged startup; temporary HOME and resolveSettings cannot certify it.')
  }
  await inspectPolicy(seedSignal)
  const originalQuery = resources.seed = sdk.query({ prompt: originalPrompt, options: {
    sessionId: original, persistSession: true, cwd: project, pathToClaudeCodeExecutable: nativeExecutablePath,
    permissionMode: 'default', tools: [], allowedTools: [], settingSources: [], plugins: [], skills: [],
    mcpServers: {}, strictMcpConfig: true, env, abortController: lifetime,
    settings: { disableAllHooks: true, disableBundledSkills: true, disableSkillShellExecution: true,
      disableWorkflows: true, disableRemoteControl: true, autoMemoryEnabled: false, fastMode: false, fastModePerSessionOptIn: true },
    canUseTool: async () => ({ behavior: 'deny', message: 'Native fixture is conversation only.' }),
    spawnClaudeCodeProcess(options) {
      if (seedProcess !== undefined) throw new Error('Actual fixture seed spawned more than once')
      seedProcess = new ClaudeRootProcess(runtime, options, { mode: 'workspace-write', workspaceRoot: root, sessionId: agent.session.id },
        graceMs, seedSignal, () => true, { lineBytes: bytes, lifetimeBytes: bytes * 8 }, true)
      return seedProcess
    },
  } })
  const seedFrames: SDKMessage[] = []
  for await (const message of originalQuery) seedFrames.push(message)
  expect(seedFrames.filter(frame => frame.type === 'result')).toEqual([expect.objectContaining({ subtype: 'success', is_error: false, session_id: original })])
  if (seedProcess === undefined) throw new Error('Actual native seed process did not start')
  await seedProcess.done
  expect(seedProcess).toMatchObject({
    quiescent: true, outputDrained: true, diagnosticOutput: false, killed: false, exitCode: 0, signalCode: null,
  })

  const sourceConfig: ClaudeSourceConfig = { id: 'isolated-native-fixture', label: 'Isolated native fixture',
    profileRoot: profile, directory: project, shellHome: home, nodePath, sdkModulePath, sdkManifestPath,
    sdkModuleSha256, sdkVersion: '0.3.263', processGraceMs: graceMs }
  const readRequest: CodingSessionReadRequest = { signal: AbortSignal.timeout(30000), limit: 100, maxEvents: 100, maxBytes: bytes }
  const workerArgv = [nodePath, workerPath, String(bytes)]
  const metadataConfined = await runtime.sandbox.confine(workerArgv, { mode: 'read-only', workspaceRoot: project })
  const originalSource = resources.sourceOwner = createClaudeSource(sourceConfig, { spawn(spec) {
    expect(spec.argv).toEqual(workerArgv)
    return runtime.subprocess.spawn({ ...spec, argv: metadataConfined.argv })
  } })
  const source = { provider: 'claude' as const, profileId: originalSource.provider.profileId, nativeSessionId: original }
  const snapshot = (selection: CodingSessionSource, request: CodingSessionReadRequest) => {
    expect(selection).toEqual(source)
    return originalSource.provider.read(selection.nativeSessionId, request)
  }
  const raw = async (selection: CodingSessionSource, request: CodingSessionReadRequest) => {
    expect(selection).toEqual(source); request.signal.throwIfAborted()
    const messages: z.infer<typeof claudeSourceMessagesSchema> = []; let historyBytes = 0
    for (let offset = 0;;) {
      const body = JSON.stringify({ protocol: 1, operation: 'getSessionMessages', profileRoot: profile, directory: project,
        shellHome: home, sdkModulePath, sdkManifestPath, sdkModuleSha256: sourceConfig.sdkModuleSha256, sdkVersion: '0.3.263',
        maxBytes: request.maxBytes, maxEvents: request.maxEvents, sessionId: selection.nativeSessionId, limit: request.limit, offset }) + '\n'
      const confined = await runtime.sandbox.confine([nodePath, workerPath, String(request.maxBytes)], { mode: 'read-only', workspaceRoot: project }, request.signal)
      const handle = runtime.subprocess.spawn({ argv: confined.argv, cwd: project, env, graceMs,
        signal: request.signal, stdio: { stdin: { data: body }, stdout: 'pipe', stderr: { maxBytes: 1024 } } })
      const text = await readStream(handle, request.maxBytes); historyBytes += Buffer.byteLength(text, 'utf8')
      if (historyBytes > request.maxBytes) throw new Error('Actual complete native history exceeded the requested byte limit')
      const reply = claudeSourceReplySchema.parse(JSON.parse(text))
      if (!reply.ok) throw new Error(`Actual metadata worker refused exact readback (${reply.error})`)
      const page = claudeSourceMessagesSchema.parse(reply.value); messages.push(...page)
      if (page.length > request.limit || messages.length > request.maxEvents) throw new Error('Actual complete native history exceeded the requested event limit')
      request.signal.throwIfAborted()
      if (page.length < request.limit) return messages
      offset += page.length
    }
  }
  const before = await snapshot(source, readRequest); const originalRaw = await raw(source, readRequest)
  expect(before.source).toEqual(source); expect(originalRaw).toHaveLength(2)
  expect(JSON.stringify(originalRaw)).toContain(originalPrompt); expect(JSON.stringify(originalRaw)).toContain(answer)
  const nativeFilesBefore = (await readdir(stateDirectory)).filter(name => name.endsWith('.jsonl')).sort()
  expect(nativeFilesBefore).toEqual([`${original}.jsonl`])
  await proveTranscriptFence(runtime, stateDirectory, project, profile, env)
  const nativeOwner = resources.owner = createClaudeSequentialWriter(originalSource.provider, { snapshot, messages: raw }, async () =>
    runtime.agents.withInitiator(agent, () => createClaudeSequentialExecutor(runtime, {
      connectionId: sourceConfig.id, profileRoot: profile, directory: project, shellHome: home, nodePath,
      nativeExecutablePath, nativeExecutableSha256, knownUnmanagedStartup: true, processGraceMs: graceMs, maxTurnMs: 60000,
      maxInputBytes: 65536, maxOutputBytes: bytes, maxSessionBytes: bytes * 8,
    }, original, async () => sdk, inspectPolicy)))
  const lease = await nativeOwner.writer.acquire(source, { ...readRequest, signal: AbortSignal.timeout(30000),
    ownerToken: brandString<CodingSessionOwnerToken>('isolated-actual-native-owner'), nativeProfileUnchanged: true })
  const requestCountBefore = server.requests.length
  let admitted = false
  const turn = await lease.resumeOriginal({
    source, text: continuationPrompt, signal: AbortSignal.timeout(60000), beforeDispatch: async () => {
      // The production executor has already flushed its public request to the real initiating Y Session.
      const records = agent.session.snapshotEvents().filter(event => event.type === 'claude-code/root-protocol' && event.data.phase === 'request')
      expect(records).toHaveLength(1); expect(await runtime.sessions.flush(agent.session)).toBe(true); admitted = true
      expect(server.requests).toHaveLength(requestCountBefore)
    },
  })
  expect(admitted).toBe(true)
  const released = await lease.release({ ...readRequest, signal: AbortSignal.timeout(30000) })
  expect(released).toMatchObject({ source, processExited: true, streamsDrained: true, expectedPrefixPersisted: true,
    completedTurnPersisted: true, noObservedPersistenceErrors: true, nativeTurnIds: [turn.nativeTurnId] })
  expect(released.snapshot.events.slice(0, before.events.length)).toEqual(before.events)
  const after = await raw(source, { ...readRequest, signal: AbortSignal.timeout(30000) })
  expect(after.slice(0, originalRaw.length)).toEqual(originalRaw)
  expect(after).toHaveLength(4); expect(after[2]?.uuid).toBe(turn.nativeTurnId)
  expect(JSON.stringify(after[2]?.message)).toContain(continuationPrompt)
  expect(JSON.stringify(after[3]?.message)).toContain(answer)
  expect((await readdir(stateDirectory)).filter(name => name.endsWith('.jsonl')).sort()).toEqual(nativeFilesBefore)
  expect(await readFile(sentinel)).toEqual(beforeSentinel)
  expect(server.requests).toHaveLength(2)
  for (const request of server.requests) {
    expect(request.method).toBe('POST'); expect(request.path).toMatch(/^\/v1\/messages(?:\?.*)?$/)
    expect(request.headers['x-api-key']).toBe(fakeKey)
    expect(z.array(z.unknown()).optional().default([]).parse(request.body.tools)).toEqual([])
  }
  const resumedBody = JSON.stringify(server.requests[1]?.body.messages)
  expect(resumedBody).toContain(originalPrompt); expect(resumedBody).toContain(answer); expect(resumedBody).toContain(continuationPrompt)
  expect(frames.filter(frame => frame.type === 'system' && frame.subtype === 'init')).toHaveLength(2)
  expect(frames.filter(frame => 'session_id' in frame).every(frame => frame.session_id === original)).toBe(true)
  expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toEqual([])
  const nativeSpecs = specs.filter(spec => spec.argv.includes(nativeExecutablePath))
  expect(nativeSpecs).toHaveLength(2)
  const resumedProfile = nativeSpecs[1]?.argv[2]
  expect(resumedProfile).toContain(`(subpath ${JSON.stringify(stateDirectory)})`)
  for (const outside of [root, project, home, profile]) expect(resumedProfile).not.toContain(`(subpath ${JSON.stringify(outside)})`)
  for (const spec of specs) {
    expect(spec.argv[0]).toBe('sandbox-exec')
    expect(spec.argv[2]).toContain(`(deny network*) (allow network-outbound (remote tcp "localhost:${allowedPort}"))`)
    expect(spec.env?.HOME).toBe(home); expect(spec.env?.CLAUDE_CONFIG_DIR).toBe(profile)
  }
  for (const handle of handles) expect(await handle.waitForExit(AbortSignal.timeout(graceMs + 1000))).toBe(true)
}, 180000)
