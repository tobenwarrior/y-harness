import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { NousConnection } from '../src/nous-connection.ts'
import { credentialStoreFrom, recordKeyFor } from '../src/auth.ts'
import { NousProtocolError } from '../src/nous-protocol.ts'
import type { NousGrant } from '../src/nous-protocol.ts'

const protocol = vi.hoisted(() => ({
  start: vi.fn<typeof import('../src/nous-protocol.ts').startNousDeviceAuthorization>(),
  complete: vi.fn<typeof import('../src/nous-protocol.ts').completeNousDeviceAuthorization>(),
  models: vi.fn<typeof import('../src/nous-protocol.ts').readNousModels>(),
}))
vi.mock('../src/nous-protocol.ts', async original => ({
  ...await original<typeof import('../src/nous-protocol.ts')>(),
  startNousDeviceAuthorization: protocol.start, completeNousDeviceAuthorization: protocol.complete,
  readNousModels: protocol.models,
}))
afterEach(() => { for (const mock of Object.values(protocol)) mock.mockReset() })
const grant: NousGrant = { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh',
  expires: Date.now() + 3_600_000, clientId: 'fixture-public-client', scope: 'inference:invoke',
  inferenceBaseURL: 'https://inference-api.nousresearch.com/v1' }

async function app(clientId?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'nous-boundaries-')); const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, 'fixture-credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(NousConnection, clientId === undefined ? {} : { clientId })
  return { ctx, connection: ctx.nousConnection }
}

describe('Nous settings admission and durable grant boundaries', () => {
  it.each(['', ' padded', 'padded ', 'line\nbreak', 'delete\u007f'])('refuses unsafe public client identities before device authorization: %j', async (clientId) => {
    await expect(app(clientId)).rejects.toThrow('public client identity')
    expect(protocol.start).not.toHaveBeenCalled()
  })

  it('refuses an authorization flow begun outside its Models settings owner', async () => {
    const { ctx } = await app(grant.clientId)
    await expect(ctx.authorization.begin({ key: recordKeyFor('nous'), method: 'oauth',
      interaction: { notify() {}, prompt: async () => { throw new Error('No prompt expected') } },
    })).rejects.toThrow('Start Nous authorization in Models settings')
    expect(protocol.start).not.toHaveBeenCalled()
    expect(await credentialStoreFrom(ctx).read('nous')).toBeUndefined()
  })

  it('rejects unconfigured catalog loading before credential or network resolution', async () => {
    const { connection } = await app()
    await expect(connection.models()).rejects.toThrow('public Nous device-flow client ID')
    expect(protocol.models).not.toHaveBeenCalled()
  })

  it('holds identity, catalog and disconnect controls until its pending sign-in settles', async () => {
    const { ctx, connection } = await app(grant.clientId)
    await credentialStoreFrom(ctx).modify('nous', async () => grant)
    const completed = Promise.withResolvers<NousGrant>()
    protocol.start.mockResolvedValue({ deviceCode: 'fixture-device', intervalSeconds: 5,
      verification: { url: 'https://portal.nousresearch.com/device', code: 'FIXTURE', expiresAt: Date.now() + 60_000 } })
    protocol.complete.mockReturnValue(completed.promise)
    await connection.start(true)
    try {
      expect(() => { connection.assertClientChange(grant.clientId) }).not.toThrow()
      expect(() => { connection.assertClientChange('another-client') }).toThrow('public client ID')
      expect(() => { connection.assertClientChange(undefined) }).toThrow('public client ID')
      await expect(connection.start(true)).rejects.toThrow('already in progress')
      await expect(connection.models()).rejects.toThrow('before loading models')
      await expect(connection.disconnect()).rejects.toThrow('before disconnecting')
      expect(protocol.start).toHaveBeenCalledOnce(); expect(protocol.models).not.toHaveBeenCalled()
    } finally {
      const cancelled = connection.cancel(); completed.resolve(grant); await cancelled
    }
    expect(await credentialStoreFrom(ctx).read('nous')).toEqual(grant)
    expect((await connection.getState()).busy).toBe(false)
    expect(() => { connection.assertClientChange('another-client') }).not.toThrow()
  })

  it.each([undefined, { ...grant, clientId: 'another-client' }, { access: 3, refresh: 'private-malformed' }])('keeps missing, mismatched or malformed durable grants out of catalog requests: %j', async (payload) => {
    const { ctx, connection } = await app(grant.clientId)
    if (payload !== undefined) await ctx.credentials.modifyRecord(recordKeyFor('nous'), async () => ({ kind: 'grant', payload }))
    expect((await connection.getState()).connected).toBe(false)
    await expect(connection.models()).rejects.toThrow(payload !== undefined && !('clientId' in payload)
      ? 'Sign in again in Models settings' : 'Existing credentials were kept')
    expect(protocol.models).not.toHaveBeenCalled()
    expect((await ctx.credentials.readRecord(recordKeyFor('nous')))?.kind).toBe(payload === undefined ? undefined : 'grant')
    expect(JSON.stringify(await connection.getState())).not.toMatch(/private-malformed|fixture-access|fixture-refresh/)
  })

  it.each([true, false])('sanitizes a catalog refusal and preserves the grant (reauthenticate=%s)', async (reauthenticate) => {
    const { ctx, connection } = await app(grant.clientId)
    await credentialStoreFrom(ctx).modify('nous', async () => grant)
    protocol.models.mockRejectedValue(new Error('private wrapper', { cause: new NousProtocolError('invalid_token', false, reauthenticate) }))
    await expect(connection.models()).rejects.toThrow(reauthenticate ? 'Sign in again in Models settings' : 'try again later')
    expect(protocol.models).toHaveBeenCalledOnce()
    expect(await credentialStoreFrom(ctx).read('nous')).toEqual(grant)
    expect(JSON.stringify(await connection.getState())).not.toContain('private wrapper')
  })
})
