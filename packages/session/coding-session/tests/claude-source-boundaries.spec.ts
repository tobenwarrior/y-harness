/** Controlled worker streams and fixture SDKs exercise original-source failure and release admission. */
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputRead, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ClaudeSequentialExecutor, ClaudeSequentialTurnReceipt } from '@deepseek-ai/dsh-subagent-claude-code'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { apply, createClaudeSource } from '../src/claude-source.ts'
import type { ClaudeSource, ClaudeSourceConfig } from '../src/claude-source.ts'
import { claudeSourceRequestSchema } from '../src/claude-source-worker.ts'
import type { ClaudeSourceRequest } from '../src/claude-source-worker.ts'
import type { CodingSessionNativeId, CodingSessionOwnerToken, CodingSessionProvider } from '../src/types.ts'

const native = vi.hoisted(() => ({ factory: vi.fn() }))
vi.mock('@deepseek-ai/dsh-subagent-claude-code', () => ({ createClaudeSequentialExecutor: native.factory }))
const original = brandString<CodingSessionNativeId>('11111111-1111-4111-8111-111111111111')
const request = { signal: new AbortController().signal, limit: 2, maxEvents: 10, maxBytes: 10000 }
const config: ClaudeSourceConfig = {
  id: 'fixture-original', label: 'Fixture original', profileRoot: '/fixture/profile', directory: '/fixture/project',
  shellHome: '/fixture/shell', nodePath: '/fixture/node', sdkModulePath: '/fixture/sdk.mjs', sdkManifestPath: '/fixture/package.json',
  sdkModuleSha256: 'a'.repeat(64), sdkVersion: '0.3.263', processGraceMs: 20,
}
const metadata = { sessionId: original, summary: 'Fixture original', lastModified: 1 }
const message = { type: 'user', uuid: '22222222-2222-4222-8222-222222222222', session_id: original,
  message: { content: 'Fixture text' }, parent_tool_use_id: null, parent_agent_id: null }
const policyReceipt = { noManagedSettingsObserved: true,
  fingerprint: '5507be77834b32c19c0f7b25f948ac72717c97bbe552bf5dd0f730936080f487' }
type Mode = 'normal' | 'spawn-error' | 'missing-output' | 'stream-error' | 'early-close' | 'invalid-chunk' | 'invalid-utf8'
  | 'invalid-json' | 'invalid-reply' | 'worker-refusal' | 'done-error' | 'nonzero' | 'signalled' | 'release-false' | 'release-error'
type Options = {
  mode?: Mode
  value?: (operation: ClaudeSourceRequest) => unknown
  stringOutput?: boolean
  terminateThrows?: boolean
  terminateEnds?: boolean
  duringSpawn?: () => void
  diagnostics?: SubprocessOutputRead | 'missing'
  closeError?: boolean
  turn?: ClaudeSequentialExecutor['turn']
}
const owners: ClaudeSource[] = []; const expectedCloseFailures = new Set<ClaudeSource>()
const contexts: Context[] = []; const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const owner of owners.splice(0)) {
    try { await owner.close() } catch (error) { if (!expectedCloseFailures.has(owner)) throw error }
  }
  expectedCloseFailures.clear()
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  native.factory.mockReset()
})
function valueFor(operation: ClaudeSourceRequest): unknown {
  if (operation.operation === 'listSessions') return [metadata]
  if (operation.operation === 'getSessionInfo') return metadata
  if (operation.operation === 'inspectSequentialPolicy') return policyReceipt
  return operation.offset === 0 ? [message] : []
}
function fixture(options: Options = {}, selection = config, authority?: Context) {
  const specs: SubprocessSpawnSpec[] = []; const operations: ClaudeSourceRequest[] = []
  const children: Array<{ stdout: PassThrough | undefined; terminated: number }> = []
  const runtime = { spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (options.mode === 'spawn-error') throw new Error('PRIVATE_STARTUP_FAILURE /private/runtime')
    specs.push(spec)
    if (typeof spec.stdio.stdin !== 'object') throw new Error('Fixture needs bounded worker input')
    const operation = claudeSourceRequestSchema.parse(JSON.parse(spec.stdio.stdin.data)); operations.push(operation)
    const stdout = options.mode === 'missing-output' ? undefined : new PassThrough()
    if (options.stringOutput) stdout?.setEncoding('utf8')
    const done = Promise.withResolvers<SubprocessOutcome>(); const range = Promise.withResolvers<boolean>()
    const child = { stdout, terminated: 0 }; children.push(child)
    const terminate = () => {
      child.terminated += 1
      if (options.terminateEnds !== false && stdout !== undefined && !stdout.destroyed) stdout.end()
      done.resolve({ exitCode: 0, signal: null })
      if (options.terminateThrows) throw new Error('PRIVATE_TERMINATION_FAILURE /private/range')
    }
    options.duringSpawn?.()
    queueMicrotask(() => {
      if (stdout !== undefined && !stdout.destroyed && !stdout.writableEnded) {
        if (options.mode === 'stream-error') stdout.destroy(new Error('PRIVATE_STREAM_FAILURE /private/output'))
        else if (options.mode === 'early-close') stdout.destroy()
        else {
          if (options.mode === 'invalid-chunk') stdout.emit('data', { private: 'PRIVATE_CHUNK_CONTENT' })
          if (!stdout.writableEnded) {
            if (options.mode === 'invalid-utf8') stdout.end(Buffer.from([0xff]))
            else if (options.mode === 'invalid-json') stdout.end('{PRIVATE_INVALID_JSON')
            else if (options.mode === 'invalid-reply') stdout.end('{"protocol":1,"ok":true,"value":[],"extra":"PRIVATE_REPLY"}')
            else if (options.mode === 'worker-refusal') stdout.end('{"protocol":1,"ok":false,"error":"sdk-read"}\n')
            else stdout.end(JSON.stringify({ protocol: 1, ok: true, value: (options.value ?? valueFor)(operation) }) + '\n')
          }
        }
      }
      if (options.mode === 'done-error') done.reject(new Error('PRIVATE_PROCESS_FAILURE /private/process'))
      else done.resolve({ exitCode: options.mode === 'nonzero' ? 7 : 0, signal: options.mode === 'signalled' ? 'SIGTERM' : null })
      if (options.mode === 'release-error') range.reject(new Error('PRIVATE_RANGE_FAILURE /private/range'))
      else range.resolve(options.mode !== 'release-false')
    })
    const diagnostics = options.diagnostics ?? { text: '', nextOffset: 0, lossy: false }
    return {
      stdin: undefined, stdout, stderr: undefined, control: undefined,
      collected: diagnostics === 'missing' ? {} : { stderr: { readFrom: (offset) => {
        if (offset !== 0) throw new Error('Policy diagnostics were not read from the beginning')
        return diagnostics
      } } },
      done: done.promise, terminate, waitForExit: () => range.promise,
    }
  } }
  const owner = createClaudeSource(selection, runtime, authority); owners.push(owner)
  if (options.mode === 'release-false' || options.mode === 'release-error' || options.terminateThrows || options.closeError) {
    expectedCloseFailures.add(owner)
  }
  return { owner, runtime, specs, operations, children, options }
}
async function sequential(options: Options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-source-installed-fixture-'))); roots.push(root)
  const code = 'export function query() { throw new Error("FORBIDDEN MODEL REQUEST") }\n'
  const sdkModulePath = join(root, 'sdk.mjs'); const sdkManifestPath = join(root, 'package.json')
  await writeFile(sdkModulePath, code)
  await writeFile(sdkManifestPath, JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.263', main: 'sdk.mjs' }))
  const context = new Context(); contexts.push(context)
  for (const service of ['agents', 'sessions', 'sandbox', 'sandboxPolicy', 'workspaceRegistry']) context.provide(service, {})
  let current = true
  const executor: ClaudeSequentialExecutor = {
    current: () => current,
    turn: options.turn ?? (async () => { throw new Error('No fixture model turn is authorized') }),
    close: async () => { current = false; if (options.closeError) throw new Error('Fixture executor close failed') },
  }
  native.factory.mockResolvedValue(executor)
  const selection: ClaudeSourceConfig = { ...config, sdkModulePath, sdkManifestPath,
    sdkModuleSha256: createHash('sha256').update(code).digest('hex'), sequentialHandoff: {
      nativeExecutablePath: '/fixture/claude', nativeExecutableSha256: 'b'.repeat(64), knownUnmanagedStartup: true,
      maxTurnMs: 5000, maxInputBytes: 10000, maxOutputBytes: 10000, maxSessionBytes: 10000,
    } }
  const f = fixture(options, selection, context)
  const writer = f.owner.provider.sequentialWriter
  if (writer === undefined) throw new Error('Fixture requires opted-in sequential ownership')
  const source = { provider: 'claude' as const, profileId: f.owner.provider.profileId, nativeSessionId: original }
  return { ...f, source, writer, context }
}
const inspectFunction = z.custom<(signal: AbortSignal) => Promise<unknown>>(value => typeof value === 'function')
const resolverFunction = z.custom<() => Promise<{ query: (...args: never[]) => unknown }>>(value => typeof value === 'function')
const claim = { ...request, ownerToken: brandString<CodingSessionOwnerToken>('fixture-owner'), nativeProfileUnchanged: true as const }

describe('Claude source process results and ownership', () => {
  it('rejects a request too small for its complete worker framing before spawning', async () => {
    const f = fixture()
    await expect(f.owner.provider.discover({ ...request, maxBytes: 32 })).rejects.toThrow('request exceeded')
    expect(f.children).toEqual([])
  })
  it.each([
    ['spawn-error', 'Claude source worker could not start.'], ['missing-output', 'Claude source worker output is unavailable.'],
    ['stream-error', 'Claude source worker output failed.'], ['early-close', 'Claude source worker output closed before draining.'],
    ['invalid-chunk', 'Claude source worker returned invalid output.'], ['invalid-utf8', 'Claude source worker returned an invalid reply.'],
    ['invalid-json', 'Claude source worker returned an invalid reply.'], ['invalid-reply', 'Claude source worker returned an invalid reply.'],
    ['worker-refusal', 'Claude source worker refused the read (sdk-read).'],
    ['done-error', 'Claude source operation was cancelled or closed.'], ['nonzero', 'Claude source worker failed.'],
    ['signalled', 'Claude source worker failed.'],
  ] satisfies Array<[Mode, string]>)('sanitizes %s without publishing worker bytes', async (mode, message) => {
    const f = fixture({ mode })
    await expect(f.owner.provider.discover(request)).rejects.toMatchObject({ message })
    expect(f.owner.provider.connected()).toBe(true)
  })
  it('drains the captured admitted stream and removes listeners before and after source disposal', async () => {
    const f = fixture(); await f.owner.provider.discover(request)
    const stream = f.children[0]?.stdout
    if (stream === undefined) throw new Error('Fixture requires an admitted readonly stream')
    expect(stream.readableEnded).toBe(true)
    for (const event of ['data', 'error', 'end', 'close']) expect(stream.listenerCount(event)).toBe(0)
    await f.owner.close()
    expect(f.children[0]?.stdout).toBe(stream)
    for (const event of ['data', 'error', 'end', 'close']) expect(stream.listenerCount(event)).toBe(0)
  })
  it.each(['release-false', 'release-error'] as const)('disconnects after %s and retains the release refusal on close', async (mode) => {
    const f = fixture({ mode })
    await expect(f.owner.provider.discover(request)).rejects.toThrow('release could not be established')
    expect(f.owner.provider.connected()).toBe(false)
    await expect(f.owner.close()).rejects.toThrow('release could not be established')
  })
  it('accepts decoded string chunks while scrubbing child-only controls and credential tombstones', async () => {
    vi.stubEnv('CLAUDE_FIXTURE_FLAG', 'Fixture parent flag'); vi.stubEnv('CODEX_FIXTURE_FLAG', 'Fixture Codex flag')
    vi.stubEnv('XDG_FIXTURE_HOME', '/fixture/unrelated-xdg'); vi.stubEnv('OPENAI_API_KEY', 'Fixture-only credential')
    const f = fixture({ stringOutput: true })
    expect((await f.owner.provider.discover(request)).items[0]?.title).toBe('Fixture original')
    expect(f.specs[0]?.env).toMatchObject({ CLAUDE_FIXTURE_FLAG: undefined, CODEX_FIXTURE_FLAG: undefined,
      XDG_FIXTURE_HOME: undefined, OPENAI_API_KEY: undefined })
  })
  it('bounds complete multibyte worker replies including the envelope', async () => {
    const f = fixture({ value: () => [{ ...metadata, summary: '雪'.repeat(2000) }] })
    await expect(f.owner.provider.discover({ ...request, maxBytes: 1024 })).rejects.toThrow('response exceeded')
    expect(f.children[0]?.terminated).toBe(1)
  })
  it('poisons source ownership when termination fails and never admits a later worker', async () => {
    const controller = new AbortController(); const f = fixture({ terminateThrows: true,
      duringSpawn: () => { controller.abort(new Error('Fixture cancellation')) } })
    await expect(f.owner.provider.discover({ ...request, signal: controller.signal })).rejects.toThrow('termination failed')
    expect(f.owner.provider.connected()).toBe(false)
    await expect(f.owner.provider.discover(request)).rejects.toThrow('profile')
    expect(f.specs).toHaveLength(1)
    await expect(f.owner.close()).rejects.toThrow('termination failed')
  })
  it('fences cancellation during spawn and ignores later readable worker bytes', async () => {
    const controller = new AbortController(); const f = fixture({ terminateEnds: false,
      duringSpawn: () => { controller.abort(new Error('Fixture cancellation')) } })
    await expect(f.owner.provider.discover({ ...request, signal: controller.signal })).rejects.toThrow('Fixture cancellation')
    expect(f.children[0]?.terminated).toBe(1)
    expect(f.owner.provider.connected()).toBe(true)
  })
  it('awaits an admitted failing range and refuses source closure until release is established', async () => {
    const spawned = Promise.withResolvers<undefined>()
    const f = fixture({ mode: 'release-false', duringSpawn: () => { spawned.resolve(undefined) } })
    const read = f.owner.provider.discover(request)
    const rejectedRead = expect(read).rejects.toThrow('release could not be established')
    await spawned.promise
    await expect(f.owner.close()).rejects.toThrow('release could not be established')
    await rejectedRead
    expect(f.children[0]?.terminated).toBe(1)
    expect(f.owner.provider.connected()).toBe(false)
  })
  it('bounds the cumulative complete raw history envelopes across individually fitting pages', async () => {
    const f = fixture({ value: operation => operation.operation === 'getSessionMessages'
      ? operation.offset < 4 ? [{ ...message, uuid: `${operation.offset}2222222-2222-4222-8222-222222222222` }] : []
      : valueFor(operation) })
    await expect(f.owner.provider.read(original, { ...request, limit: 1, maxBytes: 900 })).rejects.toThrow('complete raw history exceeded')
    expect(f.owner.provider.connected()).toBe(true)
  })
  it('rejects duplicate configured source IDs before starting a registry effect', async () => {
    const context = new Context(); contexts.push(context)
    await expect(apply(context, { sources: [config, config] })).rejects.toThrow('unique')
    expect(native.factory).not.toHaveBeenCalled()
  })
  it('closes the real provider even when its external unregister operation rejects', async () => {
    const context = new Context(); contexts.push(context)
    let provider: CodingSessionProvider | undefined
    context.provide('subprocess', { spawn: () => { throw new Error('No worker requested') } })
    context.provide('codingSessions', { registerProvider: (value: CodingSessionProvider) => {
      provider = value
      return async () => { throw new Error('Fixture registry cleanup failed') }
    } })
    await apply(context, { sources: [config] })
    if (provider === undefined) throw new Error('Source was not registered')
    expect(provider.connected()).toBe(true)
    await context.fiber.dispose()
    expect(provider.connected()).toBe(false)
  })
})

describe('Claude source explicitly opted-in sequential readers', () => {
  it('requires every live root service before exposing a sequential writer', () => {
    const context = new Context(); contexts.push(context)
    const selection = { ...config, sequentialHandoff: { nativeExecutablePath: '/fixture/claude', nativeExecutableSha256: 'b'.repeat(64),
      knownUnmanagedStartup: true, maxTurnMs: 5000, maxInputBytes: 10000, maxOutputBytes: 10000, maxSessionBytes: 10000 } }
    const runtime = { spawn: () => { throw new Error('No worker requested') } }
    expect(() => createClaudeSource(selection, runtime)).toThrow('live root')
    expect(() => createClaudeSource(selection, runtime, context)).toThrow('live root')
  })
  it('resolves only the certified fixture query export and captures a bounded policy guard without running a turn', async () => {
    const f = await sequential(); const lease = await f.writer.acquire(f.source, claim)
    const resolve = resolverFunction.parse(native.factory.mock.calls[0]?.[3])
    const inspect = inspectFunction.parse(native.factory.mock.calls[0]?.[4])
    expect(typeof (await resolve()).query).toBe('function'); expect(await inspect(request.signal)).toEqual(policyReceipt)
    expect(f.operations.at(-1)).toMatchObject({ operation: 'inspectSequentialPolicy', maxBytes: 10000, maxEvents: 1 })
    await lease.release(request)
  })
  it.each(['missing', 'bytes', 'lossy'] as const)('refuses %s policy diagnostics instead of accepting an unmanaged receipt', async (mode) => {
    const diagnostics = mode === 'missing' ? 'missing' : { text: mode === 'bytes' ? 'PRIVATE_POLICY_DIAGNOSTIC' : '',
      nextOffset: mode === 'bytes' ? 1 : 0, lossy: mode === 'lossy' }
    const f = await sequential({ diagnostics }); const lease = await f.writer.acquire(f.source, claim)
    const inspect = inspectFunction.parse(native.factory.mock.calls[0]?.[4])
    await expect(inspect(request.signal)).rejects.toThrow('diagnostics or unknown stderr evidence')
    await lease.release(request)
  })
  it('denies a captured policy read after public source closure without starting another worker', async () => {
    const f = await sequential(); await f.writer.acquire(f.source, claim)
    const inspect = inspectFunction.parse(native.factory.mock.calls[0]?.[4]); await f.owner.close()
    const before = f.specs.length
    await expect(inspect(request.signal)).rejects.toThrow('connection is closed')
    expect(f.specs).toHaveLength(before)
  })
  it('keeps the release failure authoritative for later captured policy reads', async () => {
    const f = await sequential(); await f.writer.acquire(f.source, claim)
    const inspect = inspectFunction.parse(native.factory.mock.calls[0]?.[4]); f.options.mode = 'release-false'
    expectedCloseFailures.add(f.owner)
    await expect(inspect(request.signal)).rejects.toThrow('release could not be established')
    await expect(inspect(request.signal)).rejects.toThrow('release could not be established')
  })
  it('surfaces the sequential owner close failure after all admitted reader ranges have stopped', async () => {
    const f = await sequential({ closeError: true }); await f.writer.acquire(f.source, claim)
    await expect(f.owner.close()).rejects.toThrow('Fixture executor close failed')
    expect(f.owner.provider.connected()).toBe(false)
  })
  it('rejects a raw sequential readback page that exceeds the snapshot page limit', async () => {
    let afterTurn = false; let pages = 0
    const f = await sequential({ value: operation => operation.operation === 'getSessionMessages'
      ? afterTurn && ++pages % 3 === 0 ? [message, message, message] : [message] : valueFor(operation),
    turn: async (_text, _signal, beforeDispatch) => {
      await beforeDispatch(); afterTurn = true
      return { nativeTurnId: '33333333-3333-4333-8333-333333333333', userMessage: { role: 'user', content: 'Fixture input' },
        assistants: [], processExited: true, streamsDrained: true, noObservedPersistenceErrors: true }
    } })
    const lease = await f.writer.acquire(f.source, claim)
    await expect(lease.resumeOriginal({ source: f.source, text: 'Fixture input', signal: request.signal,
      beforeDispatch: async () => {} })).rejects.toThrow('readback remains uncertain')
    await expect(lease.release(request)).rejects.toThrow('raw readback exceeds')
    expect(pages).toBe(6)
  })
  it('paginates exact synthetic turn readback and preserves the same original identity through release', async () => {
    const userBody = { role: 'user' as const, content: 'Fixture input' }
    const responseFields = { diagnostics: null }; const usageFields = { fallback_credit: null, output_tokens_details: null }
    const assistantBody: ClaudeSequentialTurnReceipt['assistants'][number]['message'] = {
      ...responseFields, id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture-model',
      content: [{ type: 'text', text: 'Fixture output', citations: null }], container: null, context_management: null,
      stop_details: null, stop_reason: 'end_turn', stop_sequence: null,
      usage: { ...usageFields, input_tokens: 1, output_tokens: 1, cache_creation: null, cache_creation_input_tokens: null,
        cache_read_input_tokens: null, inference_geo: null, iterations: null, server_tool_use: null, service_tier: null, speed: null },
    }
    const appended = [{ ...message, uuid: '33333333-3333-4333-8333-333333333333', message: userBody },
      { ...message, type: 'assistant', uuid: '44444444-4444-4444-8444-444444444444', message: assistantBody }]
    let completed = false
    const f = await sequential({ value: operation => operation.operation === 'getSessionMessages'
      ? (completed ? [message, ...appended] : [message]).slice(operation.offset, operation.offset + operation.limit) : valueFor(operation),
    turn: async (_text, _signal, beforeDispatch) => {
      await beforeDispatch(); completed = true
      return { nativeTurnId: appended[0]!.uuid, userMessage: userBody, assistants: [{ id: appended[1]!.uuid, message: assistantBody }],
        processExited: true, streamsDrained: true, noObservedPersistenceErrors: true }
    } })
    const lease = await f.writer.acquire(f.source, claim)
    expect(await lease.resumeOriginal({ source: f.source, text: 'Fixture input', signal: request.signal,
      beforeDispatch: async () => {} })).toEqual({ nativeTurnId: appended[0]!.uuid })
    expect(await lease.release(request)).toMatchObject({ source: f.source, completedTurnPersisted: true,
      expectedPrefixPersisted: true, nativeTurnIds: [appended[0]!.uuid] })
    expect(f.operations.filter(operation => operation.operation === 'getSessionMessages' && operation.offset === 2)).not.toEqual([])
  })
  it('bounds total raw sequential records even when every page fits its individual limit', async () => {
    let afterTurn = false; let pages = 0
    const f = await sequential({ value: operation => operation.operation === 'getSessionMessages'
      ? afterTurn && ++pages > 2 ? [message, message] : [message] : valueFor(operation),
    turn: async (_text, _signal, beforeDispatch) => {
      await beforeDispatch(); afterTurn = true
      return { nativeTurnId: '33333333-3333-4333-8333-333333333333', userMessage: { role: 'user', content: 'Fixture input' },
        assistants: [], processExited: true, streamsDrained: true, noObservedPersistenceErrors: true }
    } })
    const lease = await f.writer.acquire(f.source, claim)
    await expect(lease.resumeOriginal({ source: f.source, text: 'Fixture input', signal: request.signal,
      beforeDispatch: async () => {} })).rejects.toThrow('readback remains uncertain')
    expect(pages).toBe(8)
    expect(f.owner.provider.connected()).toBe(true)
  })
})
