import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { XaiConnection } from '../src/xai-connection.ts'
import { credentialStoreFrom } from '../src/auth.ts'

const login = vi.hoisted(() => vi.fn())
vi.mock('../src/models.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/models.ts')>(),
  createModels: () => ({ setProvider: () => {}, login }),
}))

const resources: Array<{ ctx: Context; dir: string }> = []
afterEach(async () => {
  for (const { ctx, dir } of resources.splice(0)) { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) }
  login.mockReset()
  vi.restoreAllMocks()
})

async function app() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-xai-test-')); const ctx = new Context(); resources.push({ ctx, dir })
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService); await ctx.plugin(XaiConnection)
  return { ctx, dir, connection: ctx.xaiConnection }
}

function grant() {
  return { type: 'oauth' as const, access: 'mock-access', refresh: 'mock-refresh', expires: Date.now() + 3_600_000 }
}

it('starts dormant, disconnected, and never touches the network', async () => {
  const { connection } = await app()
  expect(await connection.getState()).toEqual({ configured: true, connected: false, busy: false })
  await expect(connection.models()).rejects.toThrow('Sign in')
})

it('requires local-storage consent before starting device authorization', async () => {
  const { connection } = await app()
  await expect(connection.start(false)).rejects.toThrow('local credential storage')
  expect(login).not.toHaveBeenCalled()
})

it('publishes device instructions, then connects once the mocked login commits a grant', async () => {
  const { ctx, connection } = await app()
  const completed = Promise.withResolvers<undefined>()
  login.mockImplementation(async (_provider: string, _type: string, interaction: { notify: (event: unknown) => void }) => {
    interaction.notify({ type: 'device_code', userCode: 'ABCD-1234',
      verificationUri: 'https://x.ai/activate', verificationUriComplete: 'https://x.ai/activate?code=ABCD-1234',
      expiresInSeconds: 600 })
    await completed.promise
    const granted = grant()
    await credentialStoreFrom(ctx).modify('xai', async () => granted)
    return granted
  })
  const started = await connection.start(true)
  expect(started).toMatchObject({ url: 'https://x.ai/activate?code=ABCD-1234', code: 'ABCD-1234' })
  expect(typeof started.expiresAt).toBe('number')
  expect((await connection.getState()).busy).toBe(true)
  completed.resolve(undefined)
  await expect.poll(async () => (await connection.getState()).connected).toBe(true)
  const state = await connection.getState()
  expect(JSON.stringify(state)).not.toMatch(/mock-access|mock-refresh/)
  expect(typeof state.expiresAt).toBe('number')
})

it('serves grok-4.7 from the installed catalog once connected', async () => {
  const { ctx, connection } = await app()
  await credentialStoreFrom(ctx).modify('xai', async () => grant())
  const models = await connection.models()
  expect(models.map(model => model.id)).toContain('grok-4.7')
  expect(models.find(model => model.id === 'grok-4.7')).toMatchObject({ name: expect.any(String), reasoning: true })
})

it('waits for cancellation and keeps the previous grant when polling returns late', async () => {
  const { ctx, connection } = await app()
  const first = grant()
  await credentialStoreFrom(ctx).modify('xai', async () => first)
  const completed = Promise.withResolvers<undefined>()
  login.mockImplementation(async (_provider: string, _type: string, interaction: { notify: (event: unknown) => void }) => {
    interaction.notify({ type: 'device_code', userCode: 'WXYZ-9999', verificationUri: 'https://x.ai/activate' })
    await completed.promise
    await credentialStoreFrom(ctx).modify('xai', async () => ({ ...grant(), access: 'late-access' }))
    return grant()
  })
  await connection.start(true)
  const cancelled = connection.cancel()
  completed.resolve(undefined)
  await cancelled
  expect((await connection.getState()).busy).toBe(false)
})

it('clears the local grant on disconnect', async () => {
  const { ctx, connection } = await app()
  await credentialStoreFrom(ctx).modify('xai', async () => grant())
  expect((await connection.getState()).connected).toBe(true)
  await connection.disconnect()
  expect(await credentialStoreFrom(ctx).read('xai')).toBeUndefined()
  expect((await connection.getState()).connected).toBe(false)
})
