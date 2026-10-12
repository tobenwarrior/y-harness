/** External process fixtures exercise selected-profile reads without launching a native process. */
import { PassThrough } from 'node:stream'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import * as Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import * as Typert from '@deepseek-ai/dsh-typert-registry'
import * as CodingSessions from '../src/index.ts'
import * as ClaudeSourcePlugin from '../src/claude-source.ts'
import { createClaudeSource, Config } from '../src/claude-source.ts'
import type { ClaudeSourceConfig } from '../src/claude-source.ts'
import type { CodingSessionNativeId } from '../src/types.ts'

const original = brandString<CodingSessionNativeId>('11111111-1111-4111-8111-111111111111')
const config: ClaudeSourceConfig = { id: 'original-work', label: 'Original Claude work', profileRoot: '/native/claude', directory: '/native/project', shellHome: '/native/shell', nodePath: '/runtime/node', sdkModulePath: '/sdk/sdk.mjs', sdkManifestPath: '/sdk/package.json', sdkModuleSha256: 'a'.repeat(64), sdkVersion: '0.3.263', processGraceMs: 100 }
const request = { signal: new AbortController().signal, limit: 2, maxEvents: 10, maxBytes: 10000 }
const metadata = { sessionId: original, summary: 'Native parser repair', lastModified: 10, cwd: '/native/project' }
const messages = [{ type: 'user', uuid: 'native-message-uuid', session_id: original, message: { content: 'Inspect parser' }, parent_tool_use_id: null, parent_agent_id: null }]
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
function fixture(reply: (operation: string) => unknown = operation => operation === 'listSessions' ? [metadata] : operation === 'getSessionInfo' ? metadata : messages) {
  const specs: SubprocessSpawnSpec[] = []
  const children: {
    stdout: PassThrough
    done: ReturnType<typeof deferred<{ exitCode: number; signal: null }>>
    range: ReturnType<typeof deferred<boolean>>
    terminate: ReturnType<typeof vi.fn>
  }[] = []
  let automatic = true
  const runtime = { spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    specs.push(spec); const stdout = new PassThrough()
    const done = deferred<{ exitCode: number; signal: null }>(); const range = deferred<boolean>()
    const terminate = vi.fn(() => { stdout.end(); done.resolve({ exitCode: 0, signal: null }) })
    const child = { stdout, done, range, terminate }; children.push(child)
    if (automatic) queueMicrotask(() => {
      if (typeof spec.stdio.stdin !== 'object') throw new Error('Fixture requires bounded batch input')
      const body = z.object({ operation: z.string() }).parse(JSON.parse(spec.stdio.stdin.data))
      stdout.end(JSON.stringify({ protocol: 1, ok: true, value: reply(body.operation) }) + '\n')
      done.resolve({ exitCode: 0, signal: null }); range.resolve(true)
    })
    return {
      stdin: undefined, stdout, stderr: undefined, control: undefined, collected: {}, done: done.promise,
      terminate, waitForExit: () => range.promise,
    }
  } }
  const source = createClaudeSource(config, runtime)
  return { source, runtime, specs, children, manual: () => { automatic = false } }
}
afterEach(() => { vi.unstubAllEnvs() })
describe('explicit original Claude source', () => {
  it('defaults to no source and never starts a worker while registering or inspecting readiness', async () => {
    expect(Config({} as ClaudeSourcePlugin.Config).sources).toEqual([])
    const f = fixture(); expect(f.source.provider.connected()).toBe(true); expect(f.specs).toEqual([])
    await f.source.close(); expect(f.source.provider.connected()).toBe(false)
  })
  it('selects only the explicit child profile and preserves original native identities', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/parent/claude'); vi.stubEnv('HOME', '/parent/home'); vi.stubEnv('NODE_OPTIONS', '--require /parent/unsafe.cjs'); vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-secret')
    const f = fixture(); const page = await f.source.provider.discover(request)
    const snapshot = await f.source.provider.read(original, request)
    expect(page.items[0]?.source).toEqual(snapshot.source); expect(snapshot.events[0]?.id).toBe('native-message-uuid')
    expect(snapshot.source.nativeSessionId).toBe(original); expect(f.source.provider).not.toHaveProperty('writer')
    expect(process.env.CLAUDE_CONFIG_DIR).toBe('/parent/claude'); expect(process.env.HOME).toBe('/parent/home')
    expect(f.specs[0]?.env).toMatchObject({ CLAUDE_CONFIG_DIR: '/native/claude', HOME: '/native/shell', NODE_OPTIONS: undefined, ANTHROPIC_API_KEY: undefined })
    expect(f.specs[0]?.argv).toEqual(['/runtime/node', expect.stringMatching(/lib\/types\/claude-source-worker\.js$/), '10000'])
    expect(f.specs.every(spec => spec.cwd === '/native/project')).toBe(true)
    const operations = f.specs.map(spec => typeof spec.stdio.stdin === 'object' ? z.object({ operation: z.string() }).parse(JSON.parse(spec.stdio.stdin.data)).operation : '')
    expect(operations).toEqual(['listSessions', 'getSessionInfo', 'getSessionMessages', 'getSessionInfo', 'getSessionInfo', 'getSessionMessages', 'getSessionInfo'])
    await f.source.close()
  })
  it('distinguishes explicit source ids, native profile roots and projects', async () => {
    const f = fixture(); const same = createClaudeSource({ ...config }, { spawn: () => { throw new Error('No launch') } })
    expect(same.provider.profileId).toBe(f.source.provider.profileId)
    for (const value of [{ id: 'another' }, { profileRoot: '/other' }, { directory: '/another/project' }]) {
      const changed = createClaudeSource({ ...config, ...value }, { spawn: () => { throw new Error('No launch') } })
      expect(changed.provider.profileId).not.toBe(f.source.provider.profileId); await changed.close()
    }
    await same.close(); await f.source.close()
  })
  it('rejects incomplete explicit configuration before starting any process', () => {
    for (const value of [{ id: '' }, { label: '' }, { profileRoot: 'relative' }, { directory: 'relative' }, { nodePath: 'node' }, { shellHome: 'relative' }, { sdkModuleSha256: 'bad' }, { sdkVersion: '0.3.262' }, { processGraceMs: 0 }]) {
      expect(() => createClaudeSource({ ...config, ...value } as ClaudeSourceConfig, { spawn: () => { throw new Error('Unexpected launch') } })).toThrow()
    }
  })
  it('keeps metadata disappearance as a refusal after reading history', async () => {
    let info = 0; const f = fixture(operation => operation === 'getSessionInfo' ? ++info === 1 ? metadata : null : messages)
    await expect(f.source.provider.read(original, request)).rejects.toThrow('not found'); await f.source.close()
  })
  it('waits for managed release before exposing a successful reply', async () => {
    const f = fixture(); f.manual(); let settled = false
    const pending = f.source.provider.discover(request).finally(() => { settled = true })
    await Promise.resolve(); await Promise.resolve()
    const child = f.children[0]!; child.stdout.end(JSON.stringify({ protocol: 1, ok: true, value: [metadata] }) + '\n'); child.done.resolve({ exitCode: 0, signal: null })
    await new Promise(resolve => setImmediate(resolve)); expect(settled).toBe(false)
    child.range.resolve(true); expect((await pending).items[0]?.title).toBe('Native parser repair'); await f.source.close()
  })
  it('fences cancellation and disposal until the managed child range exits', async () => {
    const f = fixture(); f.manual(); const controller = new AbortController(); let closed = false
    const pending = f.source.provider.discover({ ...request, signal: controller.signal })
    const refusal = expect(pending).rejects.toThrow(/cancel|abort|closed/i)
    await Promise.resolve(); await Promise.resolve(); controller.abort()
    const closing = f.source.close().then(() => { closed = true }); const child = f.children[0]!
    await new Promise(resolve => setImmediate(resolve)); expect(child.terminate).toHaveBeenCalled(); expect(closed).toBe(false)
    child.stdout.write(JSON.stringify({ protocol: 1, ok: true, value: [metadata] }) + '\n')
    child.range.resolve(true); await refusal; await closing; expect(closed).toBe(true); expect(f.source.provider.connected()).toBe(false)
  })
  it('disconnects a source after unconfirmed release and aborts parallel admitted workers', async () => {
    const f = fixture(); f.manual()
    const first = f.source.provider.discover(request); const second = f.source.provider.discover(request)
    const firstRefusal = expect(first).rejects.toThrow('release'); const secondRefusal = expect(second).rejects.toThrow(/cancel|closed/i)
    await Promise.resolve(); await Promise.resolve(); f.children[0]!.range.resolve(false)
    await firstRefusal
    expect(f.source.provider.connected()).toBe(false); expect(f.children[1]!.terminate).toHaveBeenCalled()
    await expect(f.source.provider.discover(request)).rejects.toThrow(); expect(f.specs).toHaveLength(2)
    let closed = false; const closing = f.source.close().finally(() => { closed = true }); const closeRefusal = expect(closing).rejects.toThrow('release')
    await new Promise(resolve => setImmediate(resolve)); expect(closed).toBe(false)
    f.children[1]!.range.resolve(true); await secondRefusal; await closeRefusal
  })
  it('registers through the real Loader without a model and retains mirrors when the source unloads', async () => {
    const f = fixture(); const root = await mkdtemp(join(tmpdir(), 'y-original-claude-loader-')); const context = new Context()
    class FixtureProcesses extends SubprocessRuntime {
      resolveExecutable(): Promise<string> { throw new Error('No fixture executable lookup') }
      terminalEnvironment(): ReturnType<SubprocessRuntime['terminalEnvironment']> { throw new Error('No fixture terminal') }
      spawn(spec: SubprocessSpawnSpec): SubprocessHandle { return f.runtime.spawn(spec) }
      spawnTerminal(): ReturnType<SubprocessRuntime['spawnTerminal']> { throw new Error('No fixture terminal launch') }
    }
    try {
      const path = join(root, 'cordis.yml')
      await writeFile(path, JSON.stringify([{ name: '@deepseek-ai/dsh-storage' }, { name: '@deepseek-ai/dsh-storage-json', config: { root: join(root, 'storage') } }, { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } }, { name: '@deepseek-ai/dsh-typert-registry' }, { name: '@deepseek-ai/dsh-coding-session', config: { enableClaudeDiscovery: false } }, { name: 'fixture-processes' }, { name: '@deepseek-ai/dsh-coding-session/claude-source', config: { sources: [config] } }]))
      context.baseUrl = pathToFileURL(root).href + '/'; await context.plugin(Loader); context.loader.builtins.include = Include
      const modules = new Map<string, unknown>([['@deepseek-ai/dsh-storage', Storage], ['@deepseek-ai/dsh-storage-json', JsonStorage], ['@deepseek-ai/dsh-storage-domain', Domain], ['@deepseek-ai/dsh-typert-registry', Typert], ['@deepseek-ai/dsh-coding-session', CodingSessions], ['fixture-processes', { default: FixtureProcesses }], ['@deepseek-ai/dsh-coding-session/claude-source', ClaudeSourcePlugin]])
      const internal = context.loader.internal
      if (internal === undefined) throw new Error('Fixture needs Loader module resolution')
      context.loader.internal = new Proxy(internal, { get(target, property, receiver) {
        if (property === 'import') return async (specifier: string) => { if (!modules.has(specifier)) throw new Error('Unexpected fixture module'); return modules.get(specifier) }
        const value: unknown = Reflect.get(target, property, receiver); return value
      } })
      await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } }); await context.loader.await()
      const state = await context.codingSessions.getState()
      expect(state.sources).toHaveLength(1); expect(state.sources[0]).toMatchObject({ provider: 'claude', profileId: f.source.provider.profileId, label: 'Original Claude work' })
      expect(context.get('llm')).toBeUndefined(); expect(f.specs).toEqual([])
      const page = await context.codingSessions.discover({ provider: 'claude', profileId: f.source.provider.profileId })
      const imported = await context.codingSessions.importSession(page.items[0]!.source)
      expect((await context.codingSessions.detail(imported.id)).events[0]?.id).toBe('native-message-uuid')
      const entry = [...context.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-coding-session/claude-source')!
      await entry.fiber!.dispose(); expect((await context.codingSessions.getState()).sources).toEqual([])
      expect((await context.codingSessions.detail(imported.id)).source.nativeSessionId).toBe(original)
    } finally { await context.fiber.dispose(); await f.source.close(); await rm(root, { recursive: true, force: true }) }
  })
})
