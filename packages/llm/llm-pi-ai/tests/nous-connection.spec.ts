import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { NousConnection } from '../src/nous-connection.ts'
import { credentialStoreFrom, recordKeyFor } from '../src/auth.ts'
import type { NousGrant } from '../src/nous-protocol.ts'

const protocol = vi.hoisted(() => ({ start: vi.fn(), complete: vi.fn(), refresh: vi.fn(), models: vi.fn() }))
vi.mock('../src/nous-protocol.ts', async original => ({
  ...await original<typeof import('../src/nous-protocol.ts')>(),
  startNousDeviceAuthorization: protocol.start,
  completeNousDeviceAuthorization: protocol.complete,
  refreshNousGrant: protocol.refresh,
  readNousModels: protocol.models,
}))
const resources: Array<{ ctx: Context; dir: string }> = []
afterEach(async () => {
  for (const { ctx, dir } of resources.splice(0)) { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) }
  for (const mock of Object.values(protocol)) mock.mockReset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const grant: NousGrant = { type: 'oauth', access: 'mock-access', refresh: 'mock-refresh', expires: Date.now() + 3_600_000,
  clientId: 'approved-test-client', scope: 'inference:invoke', inferenceBaseURL: 'https://inference-api.nousresearch.com/v1' }
const verification = { url: 'https://portal.nousresearch.com/device?user_code=TEST', code: 'TEST', expiresAt: Date.now() + 600_000 }
async function app(clientId?: string | (() => string | undefined)) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-nous-test-')); const ctx = new Context(); resources.push({ ctx, dir })
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService); await ctx.plugin(NousConnection, clientId === undefined ? {} : { clientId })
  return { ctx, dir, connection: ctx.nousConnection }
}
function startProtocol() {
  protocol.start.mockResolvedValue({ deviceCode: 'private-device-code', verification, intervalSeconds: 5 })
}
it('stays dormant without a chosen public client and never starts network authentication', async () => {
  const { connection } = await app()
  expect(await connection.getState()).toEqual({ configured: false, connected: false, busy: false })
  await expect(connection.start(true)).rejects.toThrow('Choose a public Nous device-flow client ID')
  expect(protocol.start).not.toHaveBeenCalled()
})
it('requires local-storage consent and commits a completed grant without exposing credentials', async () => {
  const { ctx, dir, connection } = await app(grant.clientId)
  await expect(connection.start(false)).rejects.toThrow('local credential storage')
  startProtocol(); const completed = Promise.withResolvers<NousGrant>(); protocol.complete.mockReturnValue(completed.promise)
  expect(await connection.start(true)).toEqual(verification)
  expect((await connection.getState()).busy).toBe(true)
  completed.resolve(grant)
  await expect.poll(async () => (await connection.getState()).connected).toBe(true)
  expect(await credentialStoreFrom(ctx).read('nous')).toEqual(grant)
  expect(JSON.stringify(await connection.getState())).not.toMatch(/mock-access|mock-refresh|private-device-code|user_code/)
  expect((await stat(join(dir, '.credentials.yaml'))).mode & 0o777).toBe(0o600)
})
it('waits for cancellation cleanup and keeps the previous grant when polling returns late', async () => {
  const { ctx, connection } = await app(grant.clientId)
  await credentialStoreFrom(ctx).modify('nous', async () => grant)
  startProtocol(); const completed = Promise.withResolvers<NousGrant>(); protocol.complete.mockReturnValue(completed.promise)
  await connection.start(true)
  const cancelled = connection.cancel()
  completed.resolve({ ...grant, access: 'late-access', refresh: 'late-refresh' })
  await cancelled
  expect((await connection.getState()).busy).toBe(false)
  expect(await credentialStoreFrom(ctx).read('nous')).toEqual(grant)
})
it('waits for an admitted commit queued behind another credential mutation', async () => {
  const { ctx, connection } = await app(grant.clientId)
  await credentialStoreFrom(ctx).modify('nous', async () => grant)
  const lock = Promise.withResolvers<undefined>(); const entered = Promise.withResolvers<undefined>()
  const mutation = ctx.credentials.modifyRecord(recordKeyFor('nous'), async (current) => { entered.resolve(undefined); await lock.promise; return current })
  await entered.promise
  const admitted = Promise.withResolvers<undefined>()
  const originalModify = ctx.credentials.modifyRecord.bind(ctx.credentials)
  vi.spyOn(ctx.credentials, 'modifyRecord').mockImplementation((key, mutate) => { admitted.resolve(undefined); return originalModify(key, mutate) })
  startProtocol(); protocol.complete.mockResolvedValue({ ...grant, access: 'queued-access' })
  await connection.start(true)
  await admitted.promise
  const cancelled = connection.cancel()
  lock.resolve(undefined); await mutation; await cancelled
  expect(await credentialStoreFrom(ctx).read('nous')).toEqual({ ...grant, access: 'queued-access' })
  expect((await connection.getState()).error).toBeUndefined()
})
it('waits for an active durable save and reports the committed connection when cancelled after admission', async () => {
  const { ctx, connection } = await app(grant.clientId)
  await credentialStoreFrom(ctx).modify('nous', async () => grant)
  const admitted = Promise.withResolvers<undefined>(); const release = Promise.withResolvers<undefined>()
  const originalModify = ctx.credentials.modifyRecord.bind(ctx.credentials)
  vi.spyOn(ctx.credentials, 'modifyRecord').mockImplementation((key, mutate) => originalModify(key, async (current) => {
    const next = await mutate(current)
    if (next?.kind === 'grant' && (next.payload as NousGrant).access === 'saved-access') { admitted.resolve(undefined); await release.promise }
    return next
  }))
  startProtocol(); protocol.complete.mockResolvedValue({ ...grant, access: 'saved-access', refresh: 'saved-refresh' })
  await connection.start(true); await admitted.promise
  let settled = false
  const cancelled = connection.cancel().then(() => { settled = true })
  await Promise.resolve(); expect(settled).toBe(false)
  release.resolve(undefined); await cancelled
  expect(await credentialStoreFrom(ctx).read('nous')).toMatchObject({ access: 'saved-access', refresh: 'saved-refresh' })
  expect(await connection.getState()).toMatchObject({ connected: true, busy: false })
  expect((await connection.getState()).error).toBeUndefined()
})
it('uses one serialized refresh for concurrent catalog reads and persists its rotated pair', async () => {
  const { ctx, connection } = await app(grant.clientId)
  await credentialStoreFrom(ctx).modify('nous', async () => ({ ...grant, expires: Date.now() - 1 }))
  protocol.refresh.mockResolvedValue({ ...grant, access: 'new-access', refresh: 'new-refresh' })
  protocol.models.mockResolvedValue([{ id: 'test/model', name: 'Test model', reasoning: false }])
  const [first, second] = await Promise.all([connection.models(), connection.models()])
  expect(first).toEqual(second); expect(protocol.refresh).toHaveBeenCalledTimes(1)
  expect(protocol.models).toHaveBeenCalledWith('new-access', grant.inferenceBaseURL, expect.any(AbortSignal))
  expect(await credentialStoreFrom(ctx).read('nous')).toMatchObject({ access: 'new-access', refresh: 'new-refresh' })
  await connection.disconnect()
  expect(await credentialStoreFrom(ctx).read('nous')).toBeUndefined()
  expect((await connection.getState()).connected).toBe(false)
})
it('keeps the grant after transient refresh failure and exposes a sanitized failure', async () => {
  const { ctx, connection } = await app(grant.clientId)
  const expired = { ...grant, expires: Date.now() - 1 }; await credentialStoreFrom(ctx).modify('nous', async () => expired)
  protocol.refresh.mockRejectedValue(new Error('mock-access private upstream body'))
  await expect(connection.models()).rejects.toThrow('Nous model catalog could not be loaded')
  expect(protocol.refresh).toHaveBeenCalledOnce()
  expect(protocol.models).not.toHaveBeenCalled()
  expect(await credentialStoreFrom(ctx).read('nous')).toEqual(expired)
  expect(JSON.stringify(await connection.getState())).not.toContain('mock-access')
})


it('accepts a live public client choice without starting authorization and binds a later grant to it', async () => {
  let clientId: string | undefined
  const { ctx, connection } = await app(() => clientId)
  expect((await connection.getState()).configured).toBe(false)
  clientId = 'hermes-cli'
  expect(await connection.getState()).toMatchObject({ configured: true, connected: false, busy: false })
  expect(protocol.start).not.toHaveBeenCalled()
  expect(protocol.complete).not.toHaveBeenCalled()
  startProtocol(); protocol.complete.mockResolvedValue({ ...grant, clientId: 'hermes-cli' })
  await connection.start(true)
  await expect.poll(async () => (await connection.getState()).connected).toBe(true)
  expect(protocol.start).toHaveBeenCalledWith('hermes-cli', expect.any(AbortSignal))
  expect(protocol.complete).toHaveBeenCalledWith('hermes-cli', expect.anything(), expect.any(AbortSignal))
  clientId = 'my-public-client'
  expect((await connection.getState()).connected).toBe(false)
  expect(await credentialStoreFrom(ctx).read('nous')).toMatchObject({ clientId: 'hermes-cli' })
})

it('keeps the previous grant if client configuration changes during device approval', async () => {
  let clientId = grant.clientId
  const { ctx, connection } = await app(() => clientId)
  await credentialStoreFrom(ctx).modify('nous', async () => grant)
  startProtocol(); const completed = Promise.withResolvers<NousGrant>(); protocol.complete.mockReturnValue(completed.promise)
  await connection.start(true)
  clientId = 'other-public-client'
  completed.resolve({ ...grant, access: 'uncommitted-access' })
  await expect.poll(async () => (await connection.getState()).busy).toBe(false)
  expect(await credentialStoreFrom(ctx).read('nous')).toEqual(grant)
  expect((await connection.getState()).connected).toBe(false)
})
