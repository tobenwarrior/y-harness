/** Explicit original-profile reads never enable a model or dispatch a native writer. */
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { createConfiguredCodexSessionProvider, verifyCodexSessionSource } from '../src/coding-session-source.ts'
import type { CodingSessionNativeId } from '@deepseek-ai/dsh-coding-session/types'
import type { CodexSessionSourceConfig } from '../src/coding-session-source.ts'
import { openCodexSessionReadPeer } from '../src/codex-session-source-process.ts'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import * as Typert from '@deepseek-ai/dsh-typert-registry'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import * as CodingSessions from '../../../session/coding-session/src/index.ts'
import * as OriginalSource from '../src/coding-session-source.ts'

let root: string | undefined
let context: Context | undefined
afterEach(async () => {
  await context?.fiber.dispose(); context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true }); root = undefined
})
async function config(): Promise<CodexSessionSourceConfig> {
  root = await mkdtemp(join(tmpdir(), 'coding-source-'))
  const binary = join(root, 'bin/codex.js'); await mkdir(join(root, 'bin'))
  const bytes = Buffer.from('fixture wrapper, never executed'); await writeFile(binary, bytes)
  const manifest = join(root, 'package.json')
  await writeFile(manifest, JSON.stringify({ name: '@openai/codex', version: '0.160.0', bin: { codex: 'bin/codex.js' } }))
  return { id: 'original-cli', label: 'Original CLI', home: join(root, 'original'), binary, packageManifest: manifest,
    binarySha256: createHash('sha256').update(bytes).digest('hex'), version: '0.160.0', nodePath: '/configured/node',
    shellHome: join(root, 'shell'), cwd: join(root, 'project'), graceMs: 500 }
}
function processFixture(spec: CodexSessionSourceConfig, options: {
  home?: string
  agent?: string
  list?: object
  holdRead?: boolean
  holdRange?: boolean
  rangeFailure?: boolean
} = {}) {
  const spawned: SubprocessSpawnSpec[] = []; const calls: string[] = []; const replies: object[] = []
  let finish!: () => void; let released = false
  let reply!: (value: object) => void
  let releaseRange!: () => void
  const range = new Promise<boolean>((resolve) => { releaseRange = () => { resolve(true) } })
  const spawn = (request: SubprocessSpawnSpec): SubprocessHandle => {
    spawned.push(request)
    const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough()
    reply = (value) => { stdout.write(JSON.stringify(value) + '\n') }
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      finish = () => { released = true; resolve({ exitCode: 0, signal: null }) }
    })
    stdin.on('data', (bytes: Buffer) => {
      for (const line of bytes.toString().trim().split('\n')) {
        const message = JSON.parse(line) as { id?: string | number; method?: string }
        if (message.method === undefined) { replies.push(message); continue }
        calls.push(message.method)
        if (message.id === undefined) continue
        if (options.holdRead && message.method === 'thread/list') continue
        const result = message.method === 'initialize'
          ? { codexHome: options.home ?? spec.home, userAgent: options.agent ?? 'y-coding-session-reader/0.160.0 (fixture)' }
          : options.list ?? { data: [{ id: 'native-original', preview: 'Source session', cwd: spec.cwd, updatedAt: 1,
            status: { type: 'notLoaded' }, turns: [] }], nextCursor: null }
        queueMicrotask(() => { reply({ jsonrpc: '2.0', id: message.id, result }) })
      }
    })
    return { stdin, stdout, stderr, control: undefined, collected: {}, done,
      terminate: () => { finish() }, waitForExit: async () => {
        await done; if (options.rangeFailure) return false; return options.holdRange ? range : true
      } }
  }
  return { spawn, spawned, calls, replies, send: (value: object) => { reply(value) }, releaseRange, released: () => released }
}
const request = () => ({ signal: new AbortController().signal, limit: 10, maxEvents: 20, maxBytes: 10000 })
describe('explicit original Codex source', () => {
  it('verifies the selected wrapper package/version/hash without reading a native profile', async () => {
    const spec = await config(); await expect(verifyCodexSessionSource(spec)).resolves.toBeUndefined()
    await expect(verifyCodexSessionSource({ ...spec, binarySha256: '0'.repeat(64) })).rejects.toThrow('hash')
    await expect(verifyCodexSessionSource({ ...spec, version: '0.153.4' })).rejects.toThrow('version')
  })
  it('lists only the selected original home using a private managed read process and awaits release', async () => {
    const spec = await config(); const f = processFixture(spec)
    const provider = createConfiguredCodexSessionProvider(spec, f.spawn)
    expect(f.spawned).toEqual([])
    const page = await provider.discover({ signal: new AbortController().signal, limit: 10, maxEvents: 20, maxBytes: 10000 })
    expect(page.items[0]?.source).toMatchObject({ provider: 'codex', nativeSessionId: 'native-original' })
    expect(f.spawned[0]?.argv.slice(0, 2)).toEqual([spec.nodePath, spec.binary])
    expect(f.spawned[0]).toMatchObject({ cwd: spec.cwd, env: { CODEX_HOME: spec.home, HOME: spec.shellHome } })
    expect(f.calls).toEqual(['initialize', 'initialized', 'thread/list'])
    expect(provider).not.toHaveProperty('writer'); expect(f.released()).toBe(true)
  })
  it('refuses a changed binary before starting a source process', async () => {
    const spec = await config(); const f = processFixture(spec); const provider = createConfiguredCodexSessionProvider(spec, f.spawn)
    await writeFile(spec.binary, 'changed wrapper')
    await expect(provider.read(brandString<CodingSessionNativeId>('native-original'), {
      signal: new AbortController().signal, limit: 10, maxEvents: 20, maxBytes: 10000,
    })).rejects.toThrow('hash')
    expect(f.spawned).toEqual([])
  })
  it('bounds verification inputs before allocating or launching a native reader', async () => {
    const spec = await config(); const f = processFixture(spec)
    await writeFile(spec.packageManifest, ' '.repeat(64 * 1024 + 1))
    await expect(createConfiguredCodexSessionProvider(spec, f.spawn).discover(request())).rejects.toThrow('byte limit')
    expect(f.spawned).toEqual([])
  })
  it.each([
    { home: '/different/native/home', expected: 'different native home' },
    { agent: 'y-coding-session-reader/0.159.0 (fixture)', expected: 'unsupported binary version' },
    { agent: 'y-coding-session-reader/0.160.00 (fixture)', expected: 'unsupported binary version' },
  ])('refuses mismatched native initialization identity and releases the process', async (selection) => {
    const spec = await config(); const f = processFixture(spec, selection)
    await expect(createConfiguredCodexSessionProvider(spec, f.spawn).discover(request())).rejects.toThrow(selection.expected)
    expect(f.calls).toEqual(['initialize']); expect(f.released()).toBe(true)
  })
  it('denies native requests without dispatching an approval, writer, or model operation', async () => {
    const spec = await config(); const f = processFixture(spec)
    const peer = await openCodexSessionReadPeer(spec, request(), f.spawn)
    f.send({ jsonrpc: '2.0', id: 'native-approval', method: 'item/commandExecution/requestApproval', params: {} })
    await vi.waitFor(() => { expect(f.replies).toHaveLength(1) })
    expect(f.replies[0]).toMatchObject({ id: 'native-approval', error: { code: -32603 } })
    expect(f.calls).toEqual(['initialize', 'initialized'])
    await peer.close()
  })
  it('bounds complete multibyte protocol replies and awaits cleanup on refusal', async () => {
    const spec = await config(); const f = processFixture(spec, { list: { data: [], ignoredNativePayload: '雪'.repeat(2000) } })
    await expect(createConfiguredCodexSessionProvider(spec, f.spawn).discover({ ...request(), maxBytes: 2000 })).rejects.toThrow('did not complete')
    expect(f.released()).toBe(true)
  })
  it('bounds outbound initialization frames before forwarding bytes to the native process', async () => {
    const spec = await config(); const f = processFixture(spec)
    await expect(createConfiguredCodexSessionProvider(spec, f.spawn).discover({ ...request(), maxBytes: 80 })).rejects.toThrow('initialize')
    expect(f.calls).toEqual([]); expect(f.released()).toBe(true)
  })
  it('does not complete a read until the managed process range is quiescent', async () => {
    const spec = await config(); const f = processFixture(spec, { holdRange: true })
    let completed = false
    const work = createConfiguredCodexSessionProvider(spec, f.spawn).discover(request()).then(() => { completed = true })
    await vi.waitFor(() => { expect(f.released()).toBe(true) })
    expect(completed).toBe(false); f.releaseRange(); await work; expect(completed).toBe(true)
  })
  it('disposal cancels a pending read and drains its process range before returning', async () => {
    const spec = await config(); const f = processFixture(spec, { holdRead: true, holdRange: true })
    const provider = createConfiguredCodexSessionProvider(spec, f.spawn)
    const work = provider.discover(request()); const rejected = expect(work).rejects.toThrow('did not complete')
    await vi.waitFor(() => { expect(f.calls).toContain('thread/list') })
    let closed = false; const closing = provider.close().then(() => { closed = true })
    await vi.waitFor(() => { expect(f.released()).toBe(true) }); expect(closed).toBe(false)
    f.releaseRange(); await rejected; await closing; expect(closed).toBe(true); expect(provider.connected()).toBe(false)
  })
  it('fences subsequent reads and reports disposal failure after unconfirmed process release', async () => {
    const spec = await config(); const f = processFixture(spec, { rangeFailure: true })
    const provider = createConfiguredCodexSessionProvider(spec, f.spawn)
    await expect(provider.discover(request())).rejects.toThrow('managed process range')
    expect(provider.connected()).toBe(false)
    await expect(provider.discover(request())).rejects.toThrow('managed process range')
    expect(f.spawned).toHaveLength(1); await expect(provider.close()).rejects.toThrow('managed process range')
  })
  it('mounts the opt-in source through real Loader without enabling an LLM backend', async () => {
    const spec = await config(); const f = processFixture(spec)
    if (root === undefined) throw new Error('Fixture source directory is missing')
    class FixtureSubprocess extends SubprocessRuntime {
      async resolveExecutable(): Promise<never> { throw new Error('Executable lookup is not authorized by this fixture') }
      async terminalEnvironment(): Promise<never> { throw new Error('Terminal inspection is not authorized by this fixture') }
      spawn(value: SubprocessSpawnSpec): SubprocessHandle { return f.spawn(value) }
      async spawnTerminal(): Promise<never> { throw new Error('Terminal launch is not authorized by this fixture') }
    }
    const path = join(root, 'cordis.yml')
    await writeFile(path, JSON.stringify([{ name: '@deepseek-ai/dsh-storage' },
      { name: '@deepseek-ai/dsh-storage-json', config: { root: join(root, 'storage') } },
      { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
      { name: '@deepseek-ai/dsh-typert-registry' },
      { name: '@deepseek-ai/dsh-coding-session', config: { enableClaudeDiscovery: false } },
      { name: '@deepseek-ai/dsh-llm-pi-ai/coding-session-source', config: { sources: [spec] } }]))
    context = new Context(); context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(FixtureSubprocess); await context.plugin(Loader); context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([['@deepseek-ai/dsh-storage', Storage],
      ['@deepseek-ai/dsh-storage-json', JsonStorage], ['@deepseek-ai/dsh-storage-domain', Domain],
      ['@deepseek-ai/dsh-typert-registry', Typert], ['@deepseek-ai/dsh-coding-session', CodingSessions],
      ['@deepseek-ai/dsh-llm-pi-ai/coding-session-source', OriginalSource]])
    const internal = context.loader.internal
    if (internal === undefined) throw new Error('Fixture needs Loader module resolution')
    context.loader.internal = new Proxy(internal, { get(target, property, receiver): unknown {
      if (property === 'import') return async (specifier: string) => {
        if (!modules.has(specifier)) throw new Error('Unexpected fixture module'); return modules.get(specifier)
      }
      return Reflect.get(target, property, receiver)
    } })
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } }); await context.loader.await()
    const state = await context.codingSessions.getState()
    expect(context.get('llm')).toBeUndefined(); expect(f.spawned).toEqual([])
    expect(state.sources).toHaveLength(1); expect(state.sources[0]).toMatchObject({ provider: 'codex', label: spec.label })
    const source = state.sources[0]
    if (source === undefined) throw new Error('Configured source did not mount')
    expect((await context.codingSessions.discover(source)).items[0]?.source.nativeSessionId).toBe('native-original')
    expect(f.released()).toBe(true)
    const entry = [...context.loader.entries()].find(value => value.options.name === '@deepseek-ai/dsh-llm-pi-ai/coding-session-source')
    if (entry?.fiber === undefined) throw new Error('Configured source has no Loader lifecycle')
    await entry.fiber.dispose(); expect((await context.codingSessions.getState()).sources).toEqual([])
  })
})
