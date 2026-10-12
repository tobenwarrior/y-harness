/** Plain Node exercises the emitted metadata worker with a temporary SDK fixture and no native provider. */
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

const worker = fileURLToPath(new URL('../lib/types/claude-source-worker.js', import.meta.url))
const roots: string[] = []
const children = new Map<ChildProcessWithoutNullStreams, Promise<{ code: number | null; signal: NodeJS.Signals | null }>>()
afterEach(async () => {
  for (const child of children.keys()) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await Promise.all(children.values()); children.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

type PolicyBehavior =
  | { kind: 'result'; value: unknown }
  | { kind: 'throw'; message: string; diagnostic: string }
async function fixture(summary = 'Original coding session · 雪', policy: PolicyBehavior = {
  kind: 'result', value: { effective: {}, provenance: {}, sources: [] },
}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'y-built-claude-source-'))); roots.push(root)
  const profileRoot = join(root, 'profile'); const shellHome = join(root, 'shell'); const directory = join(root, 'project')
  await Promise.all([profileRoot, shellHome, directory].map(path => mkdir(path)))
  const sdkModulePath = join(root, 'sdk.mjs'); const sdkManifestPath = join(root, 'package.json')
  const callsPath = join(root, 'calls.jsonl')
  const code = `import { appendFile } from 'node:fs/promises'
const scope = ${JSON.stringify({ profileRoot, shellHome, directory })}
const metadata = ${JSON.stringify({ sessionId: 'native-original', summary, lastModified: 1, cwd: directory })}
const policy = ${JSON.stringify(policy)}
async function observe(operation, options) {
  if (process.env.CLAUDE_CONFIG_DIR !== scope.profileRoot || process.env.HOME !== scope.shellHome || options.dir !== scope.directory) throw new Error('fixture scope mismatch')
  await appendFile(${JSON.stringify(callsPath)}, JSON.stringify({ operation, options }) + '\\n')
}
export async function listSessions(options) { await observe('listSessions', options); return [metadata] }
export async function getSessionInfo(id, options) { if (id !== metadata.sessionId) throw new Error('fixture ID mismatch'); await observe('getSessionInfo', options); return metadata }
export async function getSessionMessages(id, options) { if (id !== metadata.sessionId) throw new Error('fixture ID mismatch'); await observe('getSessionMessages', options); return [{ type: 'user', uuid: 'native-event', session_id: id, message: { content: 'Original message · 雪' }, parent_tool_use_id: null, parent_agent_id: null }] }
export async function resolveSettings(options) {
  if (process.env.CLAUDE_CONFIG_DIR !== scope.profileRoot || process.env.HOME !== scope.shellHome || options.cwd !== scope.directory
    || !Array.isArray(options.settingSources) || options.settingSources.length !== 0
    || Object.keys(options).sort().join(',') !== 'cwd,settingSources') throw new Error('fixture policy scope mismatch')
  await appendFile(${JSON.stringify(callsPath)}, JSON.stringify({ operation: 'resolveSettings', options }) + '\\n')
  if (policy.kind === 'throw') { process.stderr.write(policy.diagnostic + '\\n'); throw new Error(policy.message) }
  return policy.value
}
`
  await writeFile(sdkModulePath, code)
  await writeFile(sdkManifestPath, JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.263',
    main: 'sdk.mjs', exports: { '.': { default: './sdk.mjs' } } }))
  return { root, callsPath, summary, base: { protocol: 1, profileRoot, shellHome, directory,
    sdkModulePath, sdkManifestPath, sdkModuleSha256: createHash('sha256').update(code).digest('hex'),
    sdkVersion: '0.3.263', maxBytes: 10000, maxEvents: 10 } }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function runCaptured(f: Fixture, operation: object, maxBytes: number, signal: AbortSignal) {
  const child = spawn(process.execPath, [worker, String(maxBytes)], { cwd: f.root,
    env: { HOME: f.base.shellHome, CLAUDE_CONFIG_DIR: f.base.profileRoot,
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }) },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, termination) => { resolve({ code, signal: termination }) })
  })
  children.set(child, closed)
  let failure: Error | undefined
  child.once('error', (error) => { failure = error })
  // A refused oversized request may close stdin before the entire body drains.
  child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') failure = error })
  const stdout: Buffer[] = []; const stderr: Buffer[] = []
  let totalBytes = 0
  for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]] as const) stream.on('data', (chunk: Buffer) => {
    totalBytes += chunk.length
    if (totalBytes > 1024 * 1024) { failure = new Error('Built fixture worker exceeded the capture budget'); child.kill('SIGKILL'); return }
    chunks.push(chunk)
  })
  child.stdin.end(JSON.stringify({ ...f.base, ...operation, maxBytes }) + '\n')
  const outcome = await closed
  signal.throwIfAborted()
  if (failure !== undefined) throw failure
  expect(outcome.signal).toBeNull(); expect(outcome.code, Buffer.concat(stderr).toString('utf8')).toBe(0)
  expect(child.exitCode).toBe(0)
  const decode = new TextDecoder('utf-8', { fatal: true })
  return { stdout: decode.decode(Buffer.concat(stdout)), stderr: decode.decode(Buffer.concat(stderr)) }
}
async function run(...args: Parameters<typeof runCaptured>) { return (await runCaptured(...args)).stdout }
const reply = z.discriminatedUnion('ok', [z.object({ protocol: z.literal(1), ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ protocol: z.literal(1), ok: z.literal(false), error: z.string() }).strict()])
const parse = (text: string) => reply.parse(JSON.parse(text))
async function policyCalls(f: Fixture) {
  const call = z.object({ operation: z.literal('resolveSettings'),
    options: z.object({ cwd: z.string(), settingSources: z.array(z.string()) }).strict(),
  }).strict()
  return (await readFile(f.callsPath, 'utf8')).trim().split('\n').map(line => call.parse(JSON.parse(line)))
}

describe.skipIf(!existsSync(worker))('built original Claude metadata worker (plain Node, fixture SDK)', () => {
  it('preserves original identity and full UTF8 framing through all three supported metadata methods', { retry: 0 }, async ({ signal }) => {
    const f = await fixture()
    const listed = await run(f, { operation: 'listSessions', limit: 2, offset: 0 }, 10000, signal)
    expect(listed.endsWith('\n')).toBe(true); expect(listed.split('\n')).toHaveLength(2)
    expect(Buffer.byteLength(listed, 'utf8')).toBeGreaterThan(listed.length)
    expect(parse(listed)).toEqual({ protocol: 1, ok: true,
      value: [{ sessionId: 'native-original', summary: f.summary, lastModified: 1, cwd: f.base.directory }] })
    expect(parse(await run(f, { operation: 'getSessionInfo', sessionId: 'native-original' }, 10000, signal))).toMatchObject({
      ok: true, value: { sessionId: 'native-original' },
    })
    expect(parse(await run(f, { operation: 'getSessionMessages', sessionId: 'native-original', limit: 2, offset: 0 }, 10000, signal)))
      .toMatchObject({ ok: true, value: [{ uuid: 'native-event', session_id: 'native-original', message: { content: 'Original message · 雪' } }] })
    const calls = (await readFile(f.callsPath, 'utf8')).trim().split('\n').map(line => z.object({
      operation: z.string(), options: z.object({ dir: z.string() }).loose(),
    }).parse(JSON.parse(line)))
    expect(calls.map(call => call.operation)).toEqual(['listSessions', 'getSessionInfo', 'getSessionMessages'])
    expect(calls[0]?.options).toMatchObject({ dir: f.base.directory, includeWorktrees: false, includeProgrammatic: true })
    expect(calls[2]?.options).toMatchObject({ dir: f.base.directory, includeSystemMessages: true })
  })
  it('refuses an unsupported operation before invoking the fixture SDK', { retry: 0 }, async ({ signal }) => {
    const f = await fixture()
    expect(parse(await run(f, { operation: 'query', limit: 2, offset: 0 }, 10000, signal))).toEqual({
      protocol: 1, ok: false, error: 'request-invalid',
    })
    await expect(readFile(f.callsPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('bounds complete multibyte replies and tiny error wrappers', { retry: 0 }, async ({ signal }) => {
    const f = await fixture('雪'.repeat(2000))
    const bounded = await run(f, { operation: 'listSessions', limit: 2, offset: 0 }, 2048, signal)
    expect(parse(bounded)).toEqual({ protocol: 1, ok: false, error: 'response-limit' })
    expect(Buffer.byteLength(bounded, 'utf8')).toBeLessThanOrEqual(2048)
    expect(Buffer.byteLength(await run(f, { operation: 'listSessions', limit: 2, offset: 0 }, 1, signal), 'utf8')).toBeLessThanOrEqual(1)
  })
  it('observes only the explicitly selected empty policy and returns its exact sanitized fingerprint', { retry: 0 }, async ({ signal }) => {
    const f = await fixture()
    const result = await runCaptured(f, { operation: 'inspectSequentialPolicy' }, 10000, signal)
    expect(result.stderr).toBe(''); expect(result.stdout.endsWith('\n')).toBe(true)
    expect(result.stdout.split('\n')).toHaveLength(2)
    expect(parse(result.stdout)).toEqual({ protocol: 1, ok: true, value: {
      noManagedSettingsObserved: true,
      fingerprint: '5507be77834b32c19c0f7b25f948ac72717c97bbe552bf5dd0f730936080f487',
    } })
    const calls = await policyCalls(f)
    expect(calls).toEqual([{ operation: 'resolveSettings', options: { cwd: f.base.directory, settingSources: [] } }])
  })
  for (const [name, value] of [
    ['effective-settings', { effective: { disableAllHooks: false }, provenance: {}, sources: [] }],
    ['settings-origin', { effective: {}, provenance: { permissions: { source: 'managed' } }, sources: [] }],
    ['managed-file', { effective: {}, provenance: {}, sources: [{ source: 'managed', settings: {}, path: '/fixture/private-policy.json' }] }],
    ['startup-helper', { effective: {}, provenance: {}, sources: [{ source: 'managed', settings: {}, policyOrigin: 'helper' }] }],
    ['remote-policy', { effective: {}, provenance: {}, sources: [{ source: 'managed', settings: {}, policyOrigin: 'remote' }] }],
    ['unknown-field', { effective: {}, provenance: {}, sources: [], resolutionErrors: [] }],
    ['missing-sources', { effective: {}, provenance: {} }],
    ['invalid-sources', { effective: {}, provenance: {}, sources: {} }],
  ] as const) {
    it(`refuses emitted-worker ${name} policy observations without a success receipt`, { retry: 0 }, async ({ signal }) => {
      const f = await fixture(undefined, { kind: 'result', value })
      const result = await runCaptured(f, { operation: 'inspectSequentialPolicy' }, 10000, signal)
      expect(result.stderr).toBe('')
      expect(parse(result.stdout)).toEqual({ protocol: 1, ok: false, error: 'sdk-policy' })
      expect(result.stdout).not.toContain('private-policy'); expect(result.stdout).not.toContain('fingerprint')
      const calls = await policyCalls(f)
      expect(calls).toEqual([{ operation: 'resolveSettings', options: { cwd: f.base.directory, settingSources: [] } }])
    })
  }
  it('sanitizes failed policy inspection while keeping SDK diagnostic bytes out of the wire reply', { retry: 0 }, async ({ signal }) => {
    const f = await fixture(undefined, { kind: 'throw', message: 'PRIVATE_POLICY_EXCEPTION · 雪', diagnostic: 'PRIVATE_POLICY_DIAGNOSTIC · 雪' })
    const result = await runCaptured(f, { operation: 'inspectSequentialPolicy' }, 10000, signal)
    expect(parse(result.stdout)).toEqual({ protocol: 1, ok: false, error: 'sdk-policy' })
    expect(result.stderr).toBe('PRIVATE_POLICY_DIAGNOSTIC · 雪\n')
    expect(result.stdout).not.toContain('PRIVATE_POLICY'); expect(result.stdout).not.toContain('雪')
  })
  it('refuses policy-operation extras before invoking the SDK resolver', { retry: 0 }, async ({ signal }) => {
    const f = await fixture()
    expect(parse(await run(f, { operation: 'inspectSequentialPolicy', sessionId: 'native-original' }, 10000, signal))).toEqual({
      protocol: 1, ok: false, error: 'request-invalid',
    })
    await expect(readFile(f.callsPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
