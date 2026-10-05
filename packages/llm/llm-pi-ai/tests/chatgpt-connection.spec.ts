import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { ChatGPTConnection } from '../src/chatgpt-connection.ts'
import { modifyChatGPTState, readChatGPTState } from '../src/chatgpt-state.ts'
import { credentialStoreFrom } from '../src/auth.ts'
import { refreshGrant } from '../src/chatgpt-protocol.ts'

const protocol = vi.hoisted(() => ({ start: vi.fn(), revoke: vi.fn() }))
vi.mock('../src/chatgpt-protocol.ts', async original => ({ ...await original<typeof import('../src/chatgpt-protocol.ts')>(), startAuthorization: protocol.start, revokeGrant: protocol.revoke }))
const resources: Array<{ ctx: Context; dir: string }> = []
afterEach(async () => { for (const { ctx, dir } of resources.splice(0)) { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) } protocol.start.mockReset(); protocol.revoke.mockReset(); vi.unstubAllGlobals() })
const grant = { type: 'oauth' as const, access: 'mock-access', refresh: 'mock-refresh', expires: 0, clientId: 'oaiapp_test', subject: 'mock-user', email: 'user@example.test' }
async function app() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-test-')); const ctx = new Context(); resources.push({ ctx, dir })
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService); await ctx.plugin(ChatGPTConnection)
  return { ctx, dir, connection: ctx.chatGPTConnection }
}
it('keeps saved registrations separate and exposes only account metadata', async () => {
  const { ctx, connection, dir } = await app()
  await modifyChatGPTState(ctx, async state => ({ ...state, activeId: 'a', accounts: [
    { id: 'a', clientId: grant.clientId, subject: grant.subject, email: grant.email, grant },
    { id: 'b', clientId: 'oaiapp_other', subject: 'other', email: grant.email, grant: { ...grant, clientId: 'oaiapp_other', subject: 'other', access: 'second-access' } },
  ] }))
  const view = await connection.select('b')
  expect(view.activeId).toBe('b'); expect(view.accounts).toHaveLength(2)
  expect(view.accounts[0]!.label).not.toBe(view.accounts[1]!.label)
  expect(JSON.stringify(view)).not.toMatch(/mock-access|mock-refresh|second-access/)
  expect(await credentialStoreFrom(ctx).read('chatgpt')).toMatchObject({ access: 'second-access' })
  expect((await stat(join(dir, '.credentials.yaml'))).mode & 0o777).toBe(0o600)
})
it('serializes refresh-token rotation across concurrent provider requests', async () => {
  const { ctx } = await app()
  await modifyChatGPTState(ctx, async state => ({ ...state, activeId: 'a', accounts: [{ id: 'a', clientId: grant.clientId, subject: grant.subject, email: grant.email, grant }] }))
  let calls = 0
  vi.stubGlobal('fetch', async () => { calls++; return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' }) })
  const store = credentialStoreFrom(ctx)
  await Promise.all([1, 2].map(() => store.modify('chatgpt', async current => {
    if (current?.type !== 'oauth') throw new Error('Missing test grant')
    return current.expires > Date.now() ? current : refreshGrant({ ...grant, ...current }, new AbortController().signal)
  })))
  expect(calls).toBe(1)
  expect(await store.read('chatgpt')).toMatchObject({ access: 'rotated-access', refresh: 'rotated-refresh' })
})
it('clears local tokens while retaining account/client mapping if revocation cannot be confirmed', async () => {
  const { ctx, connection } = await app()
  await modifyChatGPTState(ctx, async state => ({ ...state, activeId: 'a', accounts: [{ id: 'a', clientId: grant.clientId, subject: grant.subject, email: grant.email, grant }] }))
  protocol.revoke.mockResolvedValue(false)
  expect(await connection.disconnect('a')).toBe(false)
  const state = await readChatGPTState(ctx)
  expect(state?.activeId).toBeUndefined(); expect(state?.accounts[0]).toMatchObject({ clientId: 'oaiapp_test', subject: 'mock-user' })
  expect(state?.accounts[0]?.grant).toBeUndefined()
})
it('waits for the cancelled flow to clean up before releasing the attempt', async () => {
  const { connection } = await app()
  let cleaned = false
  protocol.start.mockImplementation(async (_host: string, _previous: unknown, signal: AbortSignal) => ({
    url: 'https://auth.openai.com/mock-authorize',
    completion: new Promise((_, reject) => signal.addEventListener('abort', () => { queueMicrotask(() => { cleaned = true; reject(new Error('cancelled')) }) }, { once: true })),
  }))
  await connection.start(undefined, true)
  await connection.cancel()
  expect(cleaned).toBe(true)
  expect((await connection.getState()).busy).toBe(false)
})
