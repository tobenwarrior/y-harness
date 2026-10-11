/** Fixture SDK and controlled streams exercise worker refusal paths without a native query or profile. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { executeClaudeSourceRequest, verifiedClaudeSequentialSdk } from '../src/claude-source-worker.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const settingsFieldSourcesKeyParts = ['prove', 'nance'] as const
const settingsFieldSourcesKey = settingsFieldSourcesKeyParts.join('') as `${typeof settingsFieldSourcesKeyParts[0]}${typeof settingsFieldSourcesKeyParts[1]}`
const metadata = { sessionId: 'fixture-original', summary: 'Selected history · 雪', lastModified: 1, extra: { retained: true } }
const message = { type: 'user', uuid: 'fixture-event', session_id: 'fixture-original', message: { content: 'Selected message · 雪' }, parent_tool_use_id: null, parent_agent_id: null }
type Behavior = {
  list?: unknown
  info?: unknown
  messages?: unknown
  policy?: unknown
  throwRead?: boolean
  throwPolicy?: boolean
  missingRead?: boolean
  missingQuery?: boolean
  missingPolicy?: boolean
}
async function fixture(behavior: Behavior = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-worker-protocol-'))); roots.push(root)
  const profileRoot = join(root, 'profile'); const shellHome = join(root, 'shell'); const directory = join(root, 'project')
  await Promise.all([profileRoot, shellHome, directory].map(path => mkdir(path)))
  const sdkModulePath = join(root, 'sdk.mjs'); const sdkManifestPath = join(root, 'package.json'); const callsPath = join(root, 'calls.jsonl')
  const values = {
    list: [metadata], info: metadata, messages: [message],
    policy: { effective: {}, [settingsFieldSourcesKey]: {}, sources: [] }, ...behavior,
  }
  const code = `import { appendFile } from 'node:fs/promises'
const values = ${JSON.stringify(values)}
const directory = ${JSON.stringify(directory)}
async function record(operation, options) {
  if (values.throwRead) throw new Error('PRIVATE_READ_STACK /private/source')
  await appendFile(${JSON.stringify(callsPath)}, JSON.stringify({ operation, options }) + '\\n')
}
${behavior.missingRead ? 'export const listSessions = 1' : `export async function listSessions(options) {
  if (options.dir !== directory || options.limit !== 2 || options.offset !== 0 || options.includeWorktrees !== false || options.includeProgrammatic !== true) throw new Error('Wrong list scope')
  await record('listSessions', options); return values.list
}`}
export async function getSessionInfo(id, options) {
  if (id !== 'fixture-original' || options.dir !== directory || Object.keys(options).join(',') !== 'dir') throw new Error('Wrong info scope')
  await record('getSessionInfo', options); return values.info
}
export async function getSessionMessages(id, options) {
  if (id !== 'fixture-original' || options.dir !== directory || options.offset !== 0 || options.includeSystemMessages !== true) throw new Error('Wrong message scope')
  await record('getSessionMessages', options); return values.messages
}
${behavior.missingQuery ? 'export const query = 1' : 'export function query() { throw new Error(\'FORBIDDEN NATIVE MODEL REQUEST\') }'}
${behavior.missingPolicy ? 'export const resolveSettings = 1' : `export async function resolveSettings(options) {
  if (options.cwd !== directory || !Array.isArray(options.settingSources) || options.settingSources.length !== 0 || Object.keys(options).sort().join(',') !== 'cwd,settingSources') throw new Error('Wrong policy scope')
  await appendFile(${JSON.stringify(callsPath)}, JSON.stringify({ operation: 'resolveSettings', options }) + '\\n')
  if (values.throwPolicy) throw new Error('PRIVATE_POLICY_STACK /private/policy')
  return values.policy
}`}
`
  await writeFile(sdkModulePath, code)
  await writeFile(sdkManifestPath, JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.263', main: 'sdk.mjs', exports: { '.': { default: './sdk.mjs' } } }))
  vi.stubEnv('CLAUDE_CONFIG_DIR', profileRoot); vi.stubEnv('HOME', shellHome)
  const base = { protocol: 1, profileRoot, shellHome, directory, sdkModulePath, sdkManifestPath,
    sdkModuleSha256: createHash('sha256').update(code).digest('hex'), sdkVersion: '0.3.263', maxBytes: 10000, maxEvents: 10 }
  return { root, base, callsPath }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const list = { operation: 'listSessions', limit: 2, offset: 0 }
const info = { operation: 'getSessionInfo', sessionId: 'fixture-original' }
const messages = { operation: 'getSessionMessages', sessionId: 'fixture-original', limit: 2, offset: 0 }
const inspect = { operation: 'inspectSequentialPolicy' }
async function run(f: Fixture, operation: object = list, maxBytes = 10000) {
  return executeClaudeSourceRequest(JSON.stringify({ ...f.base, ...operation, maxBytes }) + '\n', maxBytes)
}
const errorReply = (error: string) => `{"protocol":1,"ok":false,"error":"${error}"}\n`
async function expectNoRead(f: Fixture) { await expect(readFile(f.callsPath)).rejects.toMatchObject({ code: 'ENOENT' }) }

describe('Claude worker verified read and policy replies', () => {
  it.each([NaN, Infinity, 1.5, 0, -1, Number.MAX_SAFE_INTEGER + 1])(
    'emits no over-budget wrapper for invalid launcher budget %s', async (budget) => {
      expect(await executeClaudeSourceRequest('{}', budget)).toBe('')
    },
  )
  it('accepts an exactly fitting failure wrapper and refuses it one byte below the complete UTF8 budget', async () => {
    const reply = errorReply('request-invalid')
    expect(await executeClaudeSourceRequest('{}', Buffer.byteLength(reply))).toBe(reply)
    expect(await executeClaudeSourceRequest('{}', Buffer.byteLength(reply) - 1)).toBe('')
  })
  it('rejects malformed JSON and a mismatched declared budget before loading the selected SDK', async () => {
    const f = await fixture()
    expect(await executeClaudeSourceRequest('{', 10000)).toBe(errorReply('request-invalid'))
    expect(await executeClaudeSourceRequest(JSON.stringify({ ...f.base, ...list, maxBytes: 9999 }), 10000)).toBe(errorReply('request-invalid'))
    await expectNoRead(f)
  })
  it('refuses a shell-home mismatch without disclosing the selected paths', async () => {
    const f = await fixture(); vi.stubEnv('HOME', join(f.root, 'different-private-home'))
    expect(await run(f)).toBe(errorReply('profile-mismatch')); await expectNoRead(f)
  })
  it('keeps complete metadata and message fields while enforcing scoped reader options', async () => {
    const f = await fixture()
    expect(JSON.parse(await run(f))).toEqual({ protocol: 1, ok: true, value: [metadata] })
    expect(JSON.parse(await run(f, info))).toEqual({ protocol: 1, ok: true, value: metadata })
    expect(JSON.parse(await run(f, messages))).toEqual({ protocol: 1, ok: true, value: [message] })
    const calls = (await readFile(f.callsPath, 'utf8')).trim().split('\n').map(line => z.unknown().parse(JSON.parse(line)))
    expect(calls).toEqual([
      { operation: 'listSessions', options: { dir: f.base.directory, limit: 2, offset: 0, includeWorktrees: false, includeProgrammatic: true } },
      { operation: 'getSessionInfo', options: { dir: f.base.directory } },
      { operation: 'getSessionMessages', options: { dir: f.base.directory, limit: 2, offset: 0, includeSystemMessages: true } },
    ])
  })
  it.each([
    ['list-count', { list: [metadata, metadata, metadata] }, list, 'response-limit'],
    ['malformed-list', { list: [{}] }, list, 'sdk-read'],
    ['malformed-info', { info: {} }, info, 'sdk-read'],
    ['message-count', { messages: [message, message, message] }, messages, 'response-limit'],
    ['message-event-budget', { messages: [message, message] }, { ...messages, maxEvents: 1 }, 'response-limit'],
    ['message-request-budget', { messages: [message, message] }, { ...messages, limit: 1 }, 'response-limit'],
    ['malformed-messages', { messages: [{ ...message, parent_tool_use_id: 1 }] }, messages, 'sdk-read'],
    ['reader-throw', { throwRead: true }, list, 'sdk-read'],
  ] satisfies Array<[string, Behavior, object, string]>)('sanitizes %s without returning raw SDK values', async (_name, behavior, operation, error) => {
    const f = await fixture(behavior); expect(await run(f, operation)).toBe(errorReply(error))
  })
  it('accepts an installed SDK without an exports map and verifies query without starting it', async () => {
    const f = await fixture()
    await writeFile(f.base.sdkManifestPath, JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.263', main: 'sdk.mjs' }))
    expect(JSON.parse(await run(f))).toEqual({ protocol: 1, ok: true, value: [metadata] })
    const selected = await verifiedClaudeSequentialSdk(f.base)
    expect(typeof selected.query).toBe('function')
    expect((await readFile(f.callsPath, 'utf8')).trim().split('\n')).toHaveLength(1)
  })
  it('rejects a verified module whose query or required reader export is not callable', async () => {
    const reader = await fixture({ missingRead: true }); expect(await run(reader)).toBe(errorReply('sdk-verification')); await expectNoRead(reader)
    const query = await fixture({ missingQuery: true })
    await expect(verifiedClaudeSequentialSdk(query.base)).rejects.toThrow(); await expectNoRead(query)
  })
  it('returns only the observed-empty settings fingerprint and scoped resolver call', async () => {
    const f = await fixture()
    expect(await run(f, inspect)).toBe('{"protocol":1,"ok":true,"value":{"noManagedSettingsObserved":true,"fingerprint":"5507be77834b32c19c0f7b25f948ac72717c97bbe552bf5dd0f730936080f487"}}\n')
    expect(JSON.parse((await readFile(f.callsPath, 'utf8')).trim())).toEqual({ operation: 'resolveSettings', options: { cwd: f.base.directory, settingSources: [] } })
  })
  it.each([
    { missingPolicy: true }, { throwPolicy: true },
    { policy: { effective: {}, [settingsFieldSourcesKey]: {}, sources: [{ source: 'managed', settings: {}, path: '/private/policy' }] } },
    { policy: { effective: {}, [settingsFieldSourcesKey]: {}, sources: [], unknown: true } },
  ] satisfies Behavior[])('fails closed for unavailable, throwing or managed policy %j', async (behavior) => {
    const f = await fixture(behavior); expect(await run(f, inspect)).toBe(errorReply('sdk-policy'))
  })
  it('refuses a manifest whose exported entry does not match the selected module', async () => {
    const f = await fixture()
    await writeFile(f.base.sdkManifestPath, JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.263', main: 'sdk.mjs', exports: { '.': { default: './other.mjs' } } }))
    expect(await run(f)).toBe(errorReply('sdk-verification')); await expectNoRead(f)
  })
  it.each(['module', 'manifest'] as const)('refuses a symlinked SDK %s before reading user history', async (selection) => {
    const f = await fixture(); const alias = join(f.root, `alias-${selection}`)
    await symlink(selection === 'module' ? f.base.sdkModulePath : f.base.sdkManifestPath, alias)
    if (selection === 'module') {
      await writeFile(f.base.sdkManifestPath, JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.263', main: 'alias-module' }))
    }
    const operation = selection === 'module' ? { ...list, sdkModulePath: alias } : { ...list, sdkManifestPath: alias }
    expect(await run(f, operation)).toBe(errorReply('sdk-verification')); await expectNoRead(f)
  })
  it.each(['module', 'manifest'] as const)('refuses a non-file SDK %s', async (selection) => {
    const f = await fixture()
    if (selection === 'module') await writeFile(f.base.sdkManifestPath, JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.263', main: '.' }))
    const operation = selection === 'module' ? { ...list, sdkModulePath: f.root } : { ...list, sdkManifestPath: f.root }
    expect(await run(f, operation)).toBe(errorReply('sdk-verification')); await expectNoRead(f)
  })
  it.each(['oversized', 'invalid-utf8'] as const)('refuses a %s SDK manifest with a sanitized verification error', async (kind) => {
    const f = await fixture(); await writeFile(f.base.sdkManifestPath, kind === 'oversized' ? Buffer.alloc(65537, 32) : Buffer.from([0xff]))
    expect(await run(f)).toBe(errorReply('sdk-verification')); await expectNoRead(f)
  })
  it('refuses a module above the certification byte limit without importing it', async () => {
    const f = await fixture(); await truncate(f.base.sdkModulePath, 64 * 1024 * 1024 + 1)
    expect(await run(f)).toBe(errorReply('sdk-verification')); await expectNoRead(f)
  })
})

const workerPath = fileURLToPath(new URL('../src/claude-source-worker.ts', import.meta.url))
async function entry(
  chunks: Iterable<Buffer | string> | AsyncIterable<Buffer | string>, budget: string, argvPath: string | null = workerPath,
) {
  vi.resetModules()
  const stdin = Readable.from(chunks)
  let complete: (() => void) | undefined
  const written = new Promise<void>((resolve) => { complete = resolve })
  const output: Buffer[] = []
  const stdout = new Writable({ write(chunk: Buffer, _encoding, callback) { output.push(Buffer.from(chunk)); callback(); complete?.() } })
  const controlled = Object.create(process) as typeof process
  Object.defineProperties(controlled, {
    argv: { value: argvPath === null ? [process.execPath] : [process.execPath, argvPath, budget] },
    stdin: { value: stdin }, stdout: { value: stdout }, exitCode: { value: undefined, writable: true },
  })
  vi.stubGlobal('process', controlled)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await import('../src/claude-source-worker.ts')
    if (argvPath === workerPath) {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('Worker produced no framed reply')) }, 3000)
      })
      await Promise.race([written, timeout])
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    return { text: Buffer.concat(output).toString('utf8'), destroyed: stdin.destroyed, exitCode: controlled.exitCode }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    stdin.destroy(); stdout.destroy(); vi.unstubAllGlobals()
  }
}

describe('Claude worker executable entry with controlled process I/O', () => {
  it.each(['NaN', '0', '-1', '1.5'])('refuses invalid argv budget %s without consuming input', async (budget) => {
    const outcome = await entry([], budget); expect(outcome.text).toBe(''); expect(outcome.exitCode).toBeUndefined()
  })
  it('counts mixed string and Buffer chunks and destroys oversized input', async () => {
    const outcome = await entry(['x'.repeat(40), Buffer.alloc(40, 120)], '60')
    expect(outcome.text).toBe(errorReply('request-limit')); expect(outcome.destroyed).toBe(true); expect(outcome.exitCode).toBeUndefined()
  })
  it('stops reading an unbounded input stream as soon as the byte limit is exceeded', async () => {
    let releaseInput: (() => void) | undefined
    const trailingInput = new Promise<void>((resolve) => { releaseInput = resolve })
    async function* input() { yield 'x'.repeat(40); yield Buffer.alloc(40, 120); await trailingInput; yield 'tail' }
    try {
      const outcome = await entry(input(), '60')
      expect(outcome.text).toBe(errorReply('request-limit')); expect(outcome.destroyed).toBe(true); expect(outcome.exitCode).toBeUndefined()
    } finally { releaseInput?.() }
  })
  it('refuses malformed UTF8 without revealing undecodable source bytes', async () => {
    const outcome = await entry([Buffer.from([0xc3, 0x28])], '100')
    expect(outcome.text).toBe(errorReply('request-invalid')); expect(outcome.exitCode).toBeUndefined()
  })
  it('executes a framed metadata request across chunk boundaries', async () => {
    const f = await fixture(); const payload = JSON.stringify({ ...f.base, ...list }) + '\n'
    const outcome = await entry([payload.slice(0, 100), Buffer.from(payload.slice(100))], '10000')
    expect(JSON.parse(outcome.text)).toEqual({ protocol: 1, ok: true, value: [metadata] }); expect(outcome.text.endsWith('\n')).toBe(true); expect(outcome.exitCode).toBeUndefined()
  })
  it('reports an input-stream failure with a sanitized reply and a failure exit code', async () => {
    async function* brokenInput() { yield Buffer.alloc(0); throw new Error('PRIVATE_INPUT_FAILURE /private/input') }
    const outcome = await entry(brokenInput(), '100')
    expect(outcome.text).toBe(errorReply('sdk-read')); expect(outcome.exitCode).toBe(1)
  })
  it('keeps the worker dormant when imported with no executable argv path', async () => {
    expect((await entry([], '100', null)).text).toBe('')
  })
})
