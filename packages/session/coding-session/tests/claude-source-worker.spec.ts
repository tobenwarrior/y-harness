/** Worker protocol executes fixture SDK reads in process; no child or official SDK is started. */
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { executeClaudeSourceRequest } from '../src/claude-source-worker.ts'

const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(value = [{ sessionId: 'original', summary: 'Native source', lastModified: 1 }]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'y-claude-sdk-fixture-'))); roots.push(root)
  const sdkModulePath = join(root, 'sdk.mjs'); const sdkManifestPath = join(root, 'package.json')
  const code = `export async function listSessions(options) { if (options.dir !== '/selected/project' || options.includeWorktrees !== false) throw new Error('wrong project'); return ${JSON.stringify(value)} }
export async function getSessionInfo(id, options) { if (id !== 'original' || options.dir !== '/selected/project') throw new Error('wrong original'); return undefined }
export async function getSessionMessages() { return [{ type: 'user', uuid: 'native-uuid', session_id: 'original', message: { content: 'text', extra: 'raw-frame'.repeat(100) }, parent_tool_use_id: null, parent_agent_id: null }] }
export function query() { throw new Error('FORBIDDEN MODEL LAUNCH') }
`
  await writeFile(sdkModulePath, code); await writeFile(sdkManifestPath, JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.263', main: 'sdk.mjs', exports: { '.': { default: './sdk.mjs' } } }))
  vi.stubEnv('CLAUDE_CONFIG_DIR', '/selected/profile'); vi.stubEnv('HOME', '/selected/shell')
  const body = { protocol: 1, profileRoot: '/selected/profile', shellHome: '/selected/shell', directory: '/selected/project', sdkModulePath, sdkManifestPath, sdkModuleSha256: createHash('sha256').update(code).digest('hex'), sdkVersion: '0.3.263', maxBytes: 10000, maxEvents: 10, operation: 'listSessions', limit: 2, offset: 0 }
  return { body, sdkManifestPath }
}
const replySchema = z.object({ protocol: z.literal(1), ok: z.boolean(), value: z.unknown().optional(), error: z.string().optional() })
const parseReply = (value: string) => replySchema.parse(JSON.parse(value))
const parse = async (body: object, maxBytes = 10000) => parseReply(await executeClaudeSourceRequest(JSON.stringify(body) + '\n', maxBytes))
describe('Claude metadata-only worker protocol', () => {
  it('allows only original-project history methods and serializes missing metadata', async () => {
    const f = await fixture(); expect(await parse(f.body)).toEqual({ protocol: 1, ok: true, value: [{ sessionId: 'original', summary: 'Native source', lastModified: 1 }] })
    const { limit: _limit, offset: _offset, ...body } = f.body
    expect(await parse({ ...body, operation: 'getSessionInfo', sessionId: 'original' })).toEqual({ protocol: 1, ok: true, value: null })
  })
  it('denies unknown operations and extra source-scan arguments before resolving an SDK', async () => {
    const f = await fixture()
    expect((await parse({ ...f.body, operation: 'query' })).ok).toBe(false)
    expect((await parse({ ...f.body, sessionStore: {} })).ok).toBe(false)
  })
  it('denies an unverified SDK hash or a mismatched official package version and name', async () => {
    const f = await fixture(); expect((await parse({ ...f.body, sdkModuleSha256: '0'.repeat(64) })).error).toBe('sdk-verification')
    for (const manifest of [{ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.262', main: 'sdk.mjs' }, { name: 'unrelated-package', version: '0.3.263', main: 'sdk.mjs' }, { name: '@anthropic-ai/claude-agent-sdk', version: '0.3.263', main: 'other.mjs' }]) {
      await writeFile(f.sdkManifestPath, JSON.stringify(manifest)); expect((await parse(f.body)).error).toBe('sdk-verification')
    }
  })
  it('refuses a selected-root mismatch without exposing profile details or SDK errors', async () => {
    const f = await fixture(); vi.stubEnv('CLAUDE_CONFIG_DIR', '/different/private-profile')
    const value = await executeClaudeSourceRequest(JSON.stringify(f.body), 10000)
    expect(parseReply(value).error).toBe('profile-mismatch'); expect(value).not.toContain('/different/private-profile')
  })
  it('counts full UTF8 request and reply wrappers, including multi-byte content', async () => {
    const f = await fixture([{ sessionId: 'original', summary: '界'.repeat(320), lastModified: 1 }])
    const body = { ...f.body, maxBytes: 1024 }
    const reply = await parse(body, 1024); expect(reply.error).toBe('response-limit')
    const text = JSON.stringify({ ...f.body, profileRoot: '/'+ '界'.repeat(2000) })
    expect(parseReply(await executeClaudeSourceRequest(text, 1024)).error).toBe('request-limit')
  })
  it('bounds raw complete SDK frames before text projection', async () => {
    const f = await fixture(); const value = await parse({ ...f.body, operation: 'getSessionMessages', sessionId: 'original', maxBytes: 1000 }, 1000)
    expect(value.error).toBe('response-limit')
  })
  it('never emits an error wrapper larger than the launcher byte budget', async () => {
    const value = await executeClaudeSourceRequest('{}', 1)
    expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(1)
  })
})
