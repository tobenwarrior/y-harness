import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { NousConnection } from '../src/nous-connection.ts'
import { credentialStoreFrom } from '../src/auth.ts'
import * as modelFactory from '../src/models.ts'
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
afterEach(() => { vi.restoreAllMocks(); for (const mock of Object.values(protocol)) mock.mockReset() })

const grant: NousGrant = { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh',
  expires: 1_900_000_000_000, clientId: 'fixture-client', scope: 'inference:invoke',
  inferenceBaseURL: 'https://inference-api.nousresearch.com/v1' }
async function app() {
  const directory = await mkdtemp(join(tmpdir(), 'nous-authorization-settlement-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await ctx.plugin(LocalCredentialProvider, { path: join(directory, 'credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(NousConnection, { clientId: grant.clientId })
  await credentialStoreFrom(ctx).modify('nous', async () => grant)
  return { ctx, connection: ctx.nousConnection }
}

describe('Nous authorization settlement', () => {
  it('keeps browser completion separate from a text prompt and preserves the existing grant on decline', async () => {
    const { ctx, connection } = await app()
    vi.spyOn(ctx.authorization, 'begin').mockImplementation(async (request) => {
      request.interaction.notify({ message: 'Synthetic portal progress' })
      await expect(request.interaction.prompt({ kind: 'text', message: 'Synthetic text prompt' }))
        .rejects.toThrow('system browser')
      return { status: 'cancelled' }
    })
    await expect(connection.start(true)).rejects.toThrow('Existing credentials were kept')
    expect(await connection.getState()).toMatchObject({ connected: true, busy: false })
    expect(await credentialStoreFrom(ctx).read('nous')).toEqual(grant)
    expect(protocol.start).not.toHaveBeenCalled()
  })

  it('settles a seam failure before a device flow begins and permits a later start', async () => {
    const { ctx, connection } = await app()
    vi.spyOn(ctx.authorization, 'begin').mockRejectedValue(new Error('Private seam diagnostic'))
    await expect(connection.start(true)).rejects.toThrow('Existing credentials were kept')
    expect(await connection.getState()).toMatchObject({ connected: true, busy: false })
    await connection.cancel()
    expect(await credentialStoreFrom(ctx).read('nous')).toEqual(grant)
    expect(JSON.stringify(await connection.getState())).not.toContain('Private seam diagnostic')
  })

  it.each([undefined, { auth: {} }, { auth: { apiKey: grant.access } }, { auth: { baseUrl: grant.inferenceBaseURL } }])
  ('keeps an incomplete external auth result out of catalog HTTP requests: %j', async (resolved) => {
    const { ctx, connection } = await app()
    const original = modelFactory.createModels
    vi.spyOn(modelFactory, 'createModels').mockImplementation((options) => {
      const models = original(options)
      vi.spyOn(models, 'getAuth').mockResolvedValue(resolved)
      return models
    })
    await expect(connection.models()).rejects.toThrow('Existing credentials were kept')
    expect(protocol.models).not.toHaveBeenCalled()
    expect(await credentialStoreFrom(ctx).read('nous')).toEqual(grant)
  })
})
