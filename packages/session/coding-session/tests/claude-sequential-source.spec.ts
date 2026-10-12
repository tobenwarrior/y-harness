/** Captured release reads survive public source closure; only external native execution and workers are mocked. */
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import type { ClaudeSequentialExecutor } from '@deepseek-ai/dsh-subagent-claude-code'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { createClaudeSource, type ClaudeSource, type ClaudeSourceConfig } from '../src/claude-source.ts'
import { claudeSequentialPolicyReceipt } from '../src/claude-source-worker.ts'
import type { CodingSessionNativeId, CodingSessionOwnerToken } from '../src/types.ts'

const native = vi.hoisted(() => ({ factory: vi.fn() }))
vi.mock('@deepseek-ai/dsh-subagent-claude-code', () => ({ createClaudeSequentialExecutor: native.factory }))
const original = brandString<CodingSessionNativeId>('11111111-1111-4111-8111-111111111111')
const request = { signal: new AbortController().signal, limit: 4, maxEvents: 10, maxBytes: 100000 }
const config: ClaudeSourceConfig = { id: 'original-work', label: 'Original fixture Claude', profileRoot: '/fixture/claude', directory: '/fixture/project',
  shellHome: '/fixture/home', nodePath: '/fixture/node', sdkModulePath: '/fixture/sdk.mjs', sdkManifestPath: '/fixture/package.json',
  sdkModuleSha256: 'a'.repeat(64), sdkVersion: '0.3.263', processGraceMs: 50,
  sequentialHandoff: { nativeExecutablePath: '/fixture/payload/claude', nativeExecutableSha256: 'b'.repeat(64),
    knownUnmanagedStartup: true,
    maxTurnMs: 5000, maxInputBytes: 65536, maxOutputBytes: 1048576, maxSessionBytes: 8388608 } }
async function fixture() {
  const ctx = new Context()
  const state: { owner?: ClaudeSource } = {}
  onTestFinished(async () => {
    try { if (state.owner !== undefined) await state.owner.close() }
    finally { await ctx.fiber.dispose(); native.factory.mockReset() }
  })
  // These are admission-presence fixtures only. The separate executor suite uses a real root.
  for (const service of ['agents', 'sessions', 'sandbox', 'sandboxPolicy', 'workspaceRegistry']) ctx.provide(service, {})
  let current = true
  const close = vi.fn(async () => { current = false })
  const turn = vi.fn<ClaudeSequentialExecutor['turn']>(async () => { throw new Error('No model turn authorized by this fixture') })
  const executor: ClaudeSequentialExecutor = { current: () => current, turn, close }
  native.factory.mockResolvedValue(executor)
  const specs: SubprocessSpawnSpec[] = []
  const metadata = { sessionId: original, summary: 'Original native fixture', lastModified: 10, cwd: config.directory }
  const messages = [{ type: 'user', uuid: 'original-user', session_id: original, message: { role: 'user', content: 'Original conversation' }, parent_tool_use_id: null, parent_agent_id: null }]
  const policyReceipt = claudeSequentialPolicyReceipt({ effective: {}, provenance: {}, sources: [] })
  const runtime = { spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    specs.push(spec); const stdout = new PassThrough(); const done = Promise.withResolvers<{ exitCode: number; signal: null }>()
    if (typeof spec.stdio.stdin !== 'object') throw new Error('Expected bounded metadata input')
    const operation = z.object({ operation: z.string() }).parse(JSON.parse(spec.stdio.stdin.data)).operation
    queueMicrotask(() => {
      stdout.end(JSON.stringify({ protocol: 1, ok: true, value: operation === 'inspectSequentialPolicy' ? policyReceipt : operation === 'getSessionInfo' ? metadata : operation === 'listSessions' ? [metadata] : messages }) + '\n')
      done.resolve({ exitCode: 0, signal: null })
    })
    return {
      stdin: undefined, stdout, stderr: undefined, control: undefined,
      collected: { stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
      done: done.promise,
      terminate: () => { stdout.end(); done.resolve({ exitCode: 0, signal: null }) },
      waitForExit: async () => { await done.promise; return true },
    }
  } }
  const sourceOwner = createClaudeSource(config, runtime, ctx); state.owner = sourceOwner
  const writer = sourceOwner.provider.sequentialWriter
  if (writer === undefined) throw new Error('Expected opted-in sequential writer')
  const source = { provider: 'claude' as const, profileId: sourceOwner.provider.profileId, nativeSessionId: original }
  const lease = await writer.acquire(source, { ...request, ownerToken: brandString<CodingSessionOwnerToken>('fixture-owned-token'), nativeProfileUnchanged: true })
  return { owner: sourceOwner, source, lease, writer, close, turn, specs, policyReceipt }
}

it('blocks public reads and new admission after close while captured lease release gets fresh original-ID metadata', async () => {
  const f = await fixture(); const beforeClose = f.specs.length
  await f.owner.close(); expect(f.owner.provider.connected()).toBe(false)
  await expect(f.owner.provider.read(original, request)).rejects.toThrow()
  await expect(f.writer.acquire(f.source, { ...request, ownerToken: brandString<CodingSessionOwnerToken>('another-token'), nativeProfileUnchanged: true })).rejects.toThrow()
  const receipt = await f.lease.release(request)
  expect(receipt).toMatchObject({ source: f.source, expectedPrefixPersisted: true, completedTurnPersisted: false, nativeTurnIds: [] })
  expect(f.specs.length).toBeGreaterThan(beforeClose); expect(f.turn).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalled()
  for (const spec of f.specs) {
    expect(spec.env).toMatchObject({ CLAUDE_CONFIG_DIR: config.profileRoot, HOME: config.shellHome })
    if (typeof spec.stdio.stdin !== 'object') throw new Error('Expected bounded metadata input')
    expect(z.object({ operation: z.string() }).parse(JSON.parse(spec.stdio.stdin.data)).operation).not.toBe('query')
  }
})

it.each([false, undefined])('keeps an undeclared unmanaged startup %s read-only without loading a native executor', async (knownUnmanagedStartup) => {
  native.factory.mockClear()
  const owner = createClaudeSource(
    { ...config, sequentialHandoff: { ...config.sequentialHandoff!, knownUnmanagedStartup } } as ClaudeSourceConfig,
    { spawn: () => { throw new Error('No read or query requested') } },
  )
  try { expect(owner.provider).not.toHaveProperty('sequentialWriter'); expect(owner.provider.connected()).toBe(true); expect(native.factory).not.toHaveBeenCalled() }
  finally { await owner.close() }
})

it('passes only a bounded selected-profile policy read to the executor startup guard', async () => {
  const f = await fixture()
  const inspect = z.custom<(signal: AbortSignal) => Promise<unknown>>(value => typeof value === 'function').parse(native.factory.mock.calls[0]?.[4])
  expect(await inspect(request.signal)).toEqual(f.policyReceipt)
  const spec = f.specs.at(-1)!
  if (typeof spec.stdio.stdin !== 'object') throw new Error('Expected bounded policy input')
  const body = z.object({ operation: z.literal('inspectSequentialPolicy'), profileRoot: z.literal('/fixture/claude'), directory: z.literal('/fixture/project'),
    protocol: z.literal(1), shellHome: z.string(), sdkModulePath: z.string(), sdkManifestPath: z.string(), sdkModuleSha256: z.string(),
    sdkVersion: z.literal('0.3.263'), maxBytes: z.number(), maxEvents: z.literal(1) }).strict().parse(JSON.parse(spec.stdio.stdin.data))
  expect(body.maxBytes).toBe(config.sequentialHandoff!.maxOutputBytes); expect(f.turn).not.toHaveBeenCalled()
})
