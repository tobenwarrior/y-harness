import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@yharness/cordis'
import AuthorizationService from '@yharness/authorization'
import type { AuthorizationInteraction } from '@yharness/authorization'
import type { CredentialRecord } from '@yharness/credentials'
import GitHubAppAuth, { GITHUB_APP_CREDENTIAL_KEY, GITHUB_MCP_URL } from '../src/index.ts'
import { MemoryCredentials } from './memory.ts'

const CLIENT_ID = 'github-client-id'
const OTHER_CLIENT_ID = 'other-client-id'

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function deviceResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    device_code: 'device-code',
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://github.com/login/device',
    expires_in: 600,
    interval: 1,
    ...overrides,
  }
}

function grant(overrides: Record<string, unknown> = {}): CredentialRecord {
  return {
    kind: 'grant',
    payload: {
      version: 1,
      clientId: CLIENT_ID,
      accessToken: 'access-token',
      ...overrides,
    },
  }
}

function interaction() {
  const notices: unknown[] = []
  const value: AuthorizationInteraction = {
    notify: (notice) => { notices.push(notice) },
    prompt: () => Promise.resolve(''),
  }
  return { value, notices }
}

async function fixture(clientId = CLIENT_ID): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(GitHubAppAuth, { clientId })
  return ctx
}

async function seed(ctx: Context, record: CredentialRecord): Promise<void> {
  await ctx.credentials.modifyRecord(GITHUB_APP_CREDENTIAL_KEY, () => Promise.resolve(record))
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('GitHubAppAuth', () => {
  it('rejects malformed device responses and refuses a non-official verification page', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const invalidResponses: Array<Record<string, unknown>> = [
      {},
      deviceResponse({ device_code: '' }),
      deviceResponse({ user_code: '' }),
      deviceResponse({ user_code: 'abcd-efgh' }),
      deviceResponse({ verification_uri: 'https://example.invalid/device' }),
      deviceResponse({ expires_in: 0 }),
      deviceResponse({ interval: 0 }),
      deviceResponse({ interval: 31_536_001 }),
    ]
    for (const response of invalidResponses) {
      const ctx = await fixture()
      fetchMock.mockResolvedValueOnce(json(response))
      const surface = interaction()
      await expect(ctx.authorization.begin({ key: GITHUB_APP_CREDENTIAL_KEY, method: 'device', interaction: surface.value }))
        .rejects.toThrow('invalid device authorization response')
      await ctx.fiber.dispose()
    }
  })

  it('accepts the documented default poll interval and cancels before its first poll', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(json(deviceResponse({ interval: undefined })))
    const ctx = await fixture()
    const surface = interaction()
    const attempt = ctx.authorization.begin({ key: GITHUB_APP_CREDENTIAL_KEY, method: 'device', interaction: surface.value })
    await flush()
    await ctx.githubAppAuth.disconnect()
    await expect(attempt).resolves.toEqual({ status: 'cancelled' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('completes the device flow, notifies only the official page, and stores a client-bound grant', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock
      .mockResolvedValueOnce(json({
        device_code: 'device-code', user_code: 'ABCD-EFGH',
        verification_uri: 'https://github.com/login/device', expires_in: 600, interval: 1,
      }))
      .mockResolvedValueOnce(json({
        access_token: 'access-token', token_type: 'bearer', expires_in: 3_600,
        refresh_token: 'refresh-token', refresh_token_expires_in: 15_552_000,
      }))
    const ctx = await fixture()
    const surface = interaction()
    const changed = vi.fn()
    ctx.on('github-app-auth/connection-changed', changed)

    const result = ctx.authorization.begin({ key: GITHUB_APP_CREDENTIAL_KEY, method: 'device', interaction: surface.value })
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(result).resolves.toEqual({ status: 'authorized' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://github.com/login/device/code')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://github.com/login/oauth/access_token')
    for (const [, init] of fetchMock.mock.calls) expect(init?.redirect).toBe('error')
    expect(surface.notices).toEqual([{
      message: 'Open GitHub to authorize Y Harness, then enter the code shown here.',
      url: 'https://github.com/login/device',
      code: 'ABCD-EFGH',
    }])
    expect(await ctx.githubAppAuth.status()).toBe('connected')
    expect(await ctx.credentials.readRecord(GITHUB_APP_CREDENTIAL_KEY)).toMatchObject({
      kind: 'grant',
      payload: { version: 1, clientId: CLIENT_ID, accessToken: 'access-token' },
    })
    expect(changed).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('keeps polling for authorization_pending and backs off after slow_down', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock
      .mockResolvedValueOnce(json(deviceResponse()))
      .mockResolvedValueOnce(json({ error: 'authorization_pending' }))
      .mockResolvedValueOnce(json({ error: 'slow_down' }))
      .mockResolvedValueOnce(json({ access_token: 'access-token', token_type: 'bearer', expires_in: 3_600 }))
    const ctx = await fixture()
    const surface = interaction()
    const attempt = ctx.authorization.begin({ key: GITHUB_APP_CREDENTIAL_KEY, method: 'device', interaction: surface.value })
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(6_000)
    await expect(attempt).resolves.toEqual({ status: 'authorized' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    await ctx.fiber.dispose()
  })

  it('handles every documented definitive OAuth error without exposing its code', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const errors = [
      'invalid_grant', 'incorrect_client_credentials', 'expired_token', 'access_denied',
      'device_flow_disabled', 'bad_verification_code', 'unexpected_error',
    ]
    for (const error of errors) {
      const ctx = await fixture()
      fetchMock
        .mockResolvedValueOnce(json(deviceResponse()))
        .mockResolvedValueOnce(json({ error }))
      const surface = interaction()
      const attempt = ctx.authorization.begin({ key: GITHUB_APP_CREDENTIAL_KEY, method: 'device', interaction: surface.value })
      const failure = expect(attempt).rejects.toThrow('GitHub authorization was not completed')
      await flush()
      await vi.advanceTimersByTimeAsync(1_000)
      await failure
      await ctx.fiber.dispose()
    }
  })

  it('stops polling at the device expiry before making another request', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(json(deviceResponse({ expires_in: 1, interval: 1 })))
    const ctx = await fixture()
    const surface = interaction()
    const attempt = ctx.authorization.begin({ key: GITHUB_APP_CREDENTIAL_KEY, method: 'device', interaction: surface.value })
    const failure = expect(attempt).rejects.toThrow('GitHub device authorization expired')
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    await failure
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()

    const secondCtx = await fixture()
    fetchMock.mockResolvedValueOnce(json(deviceResponse({ expires_in: 600, interval: 1 })))
    fetchMock.mockImplementationOnce(() => {
      vi.setSystemTime(Date.now() + 600_000)
      return Promise.resolve(json({ error: 'authorization_pending' }))
    })
    const second = secondCtx.authorization.begin({ key: GITHUB_APP_CREDENTIAL_KEY, method: 'device', interaction: interaction().value })
    const secondFailure = expect(second).rejects.toThrow('GitHub device authorization expired')
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    await secondFailure
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await secondCtx.fiber.dispose()
  })

  it('propagates a caller abort reason while waiting for the next device poll', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(json(deviceResponse()))
    const ctx = await fixture()
    const surface = interaction()
    const controller = new AbortController()
    const attempt = ctx.authorization.begin({
      key: GITHUB_APP_CREDENTIAL_KEY,
      method: 'device',
      interaction: surface.value,
      signal: controller.signal,
    })
    await flush()
    controller.abort('caller withdrew')
    await expect(attempt).resolves.toEqual({ status: 'cancelled' })
    await ctx.fiber.dispose()
  })

  it('waits for active authorization and refresh work during service disposal', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(json(deviceResponse()))
    const authCtx = await fixture()
    const authAttempt = authCtx.authorization.begin({
      key: GITHUB_APP_CREDENTIAL_KEY,
      method: 'device',
      interaction: interaction().value,
    })
    await flush()
    await authCtx.fiber.dispose()
    await expect(authAttempt).resolves.toEqual({ status: 'cancelled' })

    const pending = Promise.withResolvers<Response>()
    fetchMock.mockReturnValueOnce(pending.promise)
    const refreshCtx = await fixture()
    await seed(refreshCtx, grant({
      accessTokenExpiresAt: Date.now() - 1,
      refreshToken: 'refresh-token',
      refreshTokenExpiresAt: Date.now() + 60_000,
    }))
    const refreshAttempt = refreshCtx.githubAppAuth.tokenFor(new URL(GITHUB_MCP_URL))
    await flush()
    const disposal = refreshCtx.fiber.dispose()
    pending.resolve(json({ error: 'bad_refresh_token' }))
    await disposal
    await expect(refreshAttempt).resolves.toBeUndefined()
  })

  it('does not wrap a request that is cancelled by the authorization signal', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('request aborted')) }, { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = await fixture()
    const controller = new AbortController()
    const attempt = ctx.authorization.begin({
      key: GITHUB_APP_CREDENTIAL_KEY,
      method: 'device',
      interaction: interaction().value,
      signal: controller.signal,
    })
    await flush()
    controller.abort()
    await expect(attempt).resolves.toEqual({ status: 'cancelled' })
    await ctx.fiber.dispose()
  })

  it('does not publish a sign-in event when disposal begins after the grant commits', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock
      .mockResolvedValueOnce(json(deviceResponse()))
      .mockResolvedValueOnce(json({ access_token: 'access-token', token_type: 'bearer' }))
    const ctx = await fixture()
    const service = ctx.githubAppAuth
    const memory = ctx.credentials as MemoryCredentials
    const originalModify = memory.modifyRecord.bind(memory)
    let commit = true
    vi.spyOn(memory, 'modifyRecord').mockImplementation(async (key, mutate) => {
      const result = await originalModify(key, mutate)
      if (commit) {
        commit = false
        queueMicrotask(() => { Object.defineProperty(service, 'closed', { value: true, writable: true }) })
      }
      return result
    })
    const changed = vi.fn()
    ctx.on('github-app-auth/connection-changed', changed)
    const attempt = ctx.authorization.begin({ key: GITHUB_APP_CREDENTIAL_KEY, method: 'device', interaction: interaction().value })
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(attempt).resolves.toEqual({ status: 'authorized' })
    expect(changed).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('returns a fresh token without a refresh request or connection event', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const ctx = await fixture()
    await seed(ctx, grant({ accessTokenExpiresAt: Date.now() + 60_000 }))
    const changed = vi.fn()
    ctx.on('github-app-auth/connection-changed', changed)

    await expect(ctx.githubAppAuth.tokenFor(new URL(GITHUB_MCP_URL))).resolves.toBe('access-token')
    await expect(ctx.githubAppAuth.tokenFor(new URL('https://example.com/'))).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('refreshes expired access once and preserves a refresh token omitted by GitHub', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(json({ access_token: 'refreshed-token', token_type: 'bearer', expires_in: 3_600 }))
    const ctx = await fixture()
    await seed(ctx, grant({ accessTokenExpiresAt: Date.now() - 1, refreshToken: 'refresh-token', refreshTokenExpiresAt: Date.now() + 60_000 }))
    const changed = vi.fn()
    ctx.on('github-app-auth/connection-changed', changed)

    const tokens = await Promise.all([
      ctx.githubAppAuth.tokenFor(new URL(GITHUB_MCP_URL)),
      ctx.githubAppAuth.tokenFor(new URL(GITHUB_MCP_URL)),
    ])
    expect(tokens).toEqual(['refreshed-token', 'refreshed-token'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await ctx.credentials.readRecord(GITHUB_APP_CREDENTIAL_KEY)).toMatchObject({
      payload: { accessToken: 'refreshed-token', refreshToken: 'refresh-token', clientId: CLIENT_ID },
    })
    expect(changed).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('leaves the grant unchanged when refresh responses are malformed or transiently unavailable', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const responses: Array<Response | Error> = [
      json({ token_type: 'bearer' }),
      json({ access_token: 'new-token', token_type: 'not-bearer' }),
      json({ access_token: 'new-token', token_type: 'bearer', expires_in: 0 }),
      json({ access_token: 'new-token', token_type: 'bearer', refresh_token: '' }),
      json({ access_token: 'new-token', token_type: 'bearer', refresh_token_expires_in: 0 }),
      json({ error: 'temporary_failure' }),
      json({ message: 'server unavailable' }, 500),
      new Response('{', { status: 200 }),
      new Response('[]', { status: 200 }),
      new Error('network unavailable'),
    ]
    for (const response of responses) {
      const ctx = await fixture()
      const original = grant({
        accessTokenExpiresAt: Date.now() - 1,
        refreshToken: 'refresh-token',
        refreshTokenExpiresAt: Date.now() + 60_000,
      })
      await seed(ctx, original)
      if (response instanceof Error) fetchMock.mockRejectedValueOnce(response)
      else fetchMock.mockResolvedValueOnce(response)
      await expect(ctx.githubAppAuth.tokenFor(new URL(GITHUB_MCP_URL))).resolves.toBeUndefined()
      expect(await ctx.credentials.readRecord(GITHUB_APP_CREDENTIAL_KEY)).toEqual(original)
      await ctx.fiber.dispose()
    }

    const ctx = await fixture()
    const refreshExpiry = Date.now() + 60_000
    const original = grant({
      accessTokenExpiresAt: Date.now() - 1,
      refreshToken: 'refresh-token',
      refreshTokenExpiresAt: refreshExpiry,
    })
    await seed(ctx, original)
    fetchMock.mockResolvedValueOnce(json({ access_token: 'new-token', token_type: 'bearer' }))
    await expect(ctx.githubAppAuth.tokenFor(new URL(GITHUB_MCP_URL))).resolves.toBe('new-token')
    expect(await ctx.credentials.readRecord(GITHUB_APP_CREDENTIAL_KEY)).toMatchObject({
      payload: { accessToken: 'new-token', refreshToken: 'refresh-token', refreshTokenExpiresAt: refreshExpiry },
    })
    await ctx.fiber.dispose()
  })

  it('tombstones a grant rejected by a non-JSON OAuth error status', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(json({ message: 'unauthorized' }, 401))
    const ctx = await fixture()
    await seed(ctx, grant({ accessTokenExpiresAt: Date.now() - 1, refreshToken: 'refresh-token' }))
    const changed = vi.fn()
    ctx.on('github-app-auth/connection-changed', changed)

    await expect(ctx.githubAppAuth.tokenFor(new URL(GITHUB_MCP_URL))).resolves.toBeUndefined()
    expect(await ctx.credentials.readRecord(GITHUB_APP_CREDENTIAL_KEY)).toEqual({
      kind: 'grant', payload: { version: 1, invalidated: true },
    })
    expect(changed).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('does not mutate or emit from status for malformed, expired, or different-app grants', async () => {
    const ctx = await fixture()
    const records: CredentialRecord[] = [
      { kind: 'api-key', key: 'not-a-grant' },
      { kind: 'grant', payload: null },
      { kind: 'grant', payload: [] },
      { kind: 'grant', payload: { version: 2, clientId: CLIENT_ID, accessToken: 'access-token' } },
      { kind: 'grant', payload: { version: 1, clientId: '' , accessToken: 'access-token' } },
      { kind: 'grant', payload: { version: 1, clientId: 4, accessToken: 'access-token' } },
      { kind: 'grant', payload: { version: 1, clientId: CLIENT_ID, accessToken: '' } },
      { kind: 'grant', payload: { version: 1, clientId: CLIENT_ID, accessToken: 4 } },
      { kind: 'grant', payload: { version: 1, clientId: CLIENT_ID, accessToken: 'access-token', refreshToken: 4 } },
      { kind: 'grant', payload: { version: 1, clientId: CLIENT_ID, accessToken: 'access-token', accessTokenExpiresAt: 0 } },
      { kind: 'grant', payload: { version: 1, clientId: CLIENT_ID, accessToken: 'access-token', accessTokenExpiresAt: 'later' } },
      { kind: 'grant', payload: { version: 1, clientId: CLIENT_ID, accessToken: 'access-token', refreshToken: 'refresh-token', refreshTokenExpiresAt: 0 } },
      { kind: 'grant', payload: { version: 1, clientId: CLIENT_ID, accessToken: 'access-token', refreshToken: 'refresh-token', refreshTokenExpiresAt: 'later' } },
      grant({ accessTokenExpiresAt: Date.now() - 1 }),
      grant({ clientId: OTHER_CLIENT_ID }),
    ]
    const changed = vi.fn()
    ctx.on('github-app-auth/connection-changed', changed)
    for (const record of records) {
      await seed(ctx, record)
      expect(await ctx.githubAppAuth.status()).toBe('needs-auth')
      expect(await ctx.credentials.readRecord(GITHUB_APP_CREDENTIAL_KEY)).toEqual(record)
    }
    expect(changed).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('reports connected when only an unexpired refresh token remains', async () => {
    const ctx = await fixture()
    await seed(ctx, grant({ accessTokenExpiresAt: Date.now() - 1, refreshToken: 'refresh-token' }))
    await expect(ctx.githubAppAuth.status()).resolves.toBe('connected')
    await ctx.fiber.dispose()
  })

  it('returns needs-auth without a stored record', async () => {
    const ctx = await fixture()
    await expect(ctx.githubAppAuth.status()).resolves.toBe('needs-auth')
    await expect(ctx.githubAppAuth.tokenFor(new URL(GITHUB_MCP_URL))).resolves.toBeUndefined()
    await seed(ctx, { kind: 'api-key', key: 'not-a-grant' })
    await expect(ctx.githubAppAuth.tokenFor(new URL(GITHUB_MCP_URL))).resolves.toBeUndefined()
    expect(await ctx.credentials.readRecord(GITHUB_APP_CREDENTIAL_KEY)).toEqual({
      kind: 'grant', payload: { version: 1, invalidated: true },
    })
    await ctx.fiber.dispose()

    const raceCtx = await fixture()
    const raceMemory = raceCtx.credentials as MemoryCredentials
    const malformed = { kind: 'api-key', key: 'not-a-grant' } as CredentialRecord
    await seed(raceCtx, malformed)
    const originalRead = raceMemory.readRecord.bind(raceMemory)
    vi.spyOn(raceMemory, 'readRecord').mockImplementationOnce(async (key) => {
      const initial = await originalRead(key)
      raceMemory.deleteFromOtherProcess(key)
      return initial
    })
    await expect(raceCtx.githubAppAuth.tokenFor(new URL(GITHUB_MCP_URL))).resolves.toBeUndefined()
    expect(await raceCtx.credentials.readRecord(GITHUB_APP_CREDENTIAL_KEY)).toBeUndefined()
    await raceCtx.fiber.dispose()
  })

  it('preserves a well-formed grant when the configured GitHub App changes', async () => {
    const ctx = await fixture(OTHER_CLIENT_ID)
    const record = grant({ accessTokenExpiresAt: Date.now() + 60_000 })
    await seed(ctx, record)
    const changed = vi.fn()
    ctx.on('github-app-auth/connection-changed', changed)

    await expect(ctx.githubAppAuth.status()).resolves.toBe('needs-auth')
    await expect(ctx.githubAppAuth.tokenFor(new URL(GITHUB_MCP_URL))).resolves.toBeUndefined()
    expect(await ctx.credentials.readRecord(GITHUB_APP_CREDENTIAL_KEY)).toEqual(record)
    expect(changed).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('invalidates a grant whose access and refresh tokens have both expired', async () => {
    const ctx = await fixture()
    await seed(ctx, grant({
      accessTokenExpiresAt: Date.now() - 2_000,
      refreshToken: 'refresh-token',
      refreshTokenExpiresAt: Date.now() - 1_000,
    }))
    const changed = vi.fn()
    ctx.on('github-app-auth/connection-changed', changed)

    await expect(ctx.githubAppAuth.tokenFor(new URL(GITHUB_MCP_URL))).resolves.toBeUndefined()
    expect(await ctx.credentials.readRecord(GITHUB_APP_CREDENTIAL_KEY)).toEqual({
      kind: 'grant', payload: { version: 1, invalidated: true },
    })
    expect(changed).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('rejects a token request that becomes stale while the credential read is pending', async () => {
    const ctx = await fixture()
    const memory = ctx.credentials as MemoryCredentials
    const pending = Promise.withResolvers<CredentialRecord | undefined>()
    vi.spyOn(memory, 'readRecord').mockImplementationOnce(() => pending.promise)
    const request = ctx.githubAppAuth.tokenFor(new URL(GITHUB_MCP_URL))
    await flush()
    const disconnect = ctx.githubAppAuth.disconnect()
    pending.resolve(grant({ accessTokenExpiresAt: Date.now() + 60_000 }))
    await disconnect
    await expect(request).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('coalesces disconnects, refuses requests while disconnecting, and is inert after disposal', async () => {
    const ctx = await fixture()
    const service = ctx.githubAppAuth
    await seed(ctx, grant())
    const memory = ctx.credentials as MemoryCredentials
    const pending = Promise.withResolvers<CredentialRecord | undefined>()
    vi.spyOn(memory, 'readRecord').mockImplementationOnce(() => pending.promise)
    const first = service.disconnect()
    const second = service.disconnect()
    await expect(service.tokenFor(new URL(GITHUB_MCP_URL))).resolves.toBeUndefined()
    pending.resolve(grant())
    await expect(second).resolves.toBeUndefined()
    await expect(first).resolves.toBeUndefined()
    await ctx.fiber.dispose()
    await expect(service.disconnect()).resolves.toBeUndefined()
    await expect(service.tokenFor(new URL(GITHUB_MCP_URL))).resolves.toBeUndefined()
  })

  it('rechecks the record that the serialized refresh callback actually sees', async () => {
    const currentRecords: Array<[CredentialRecord, string | undefined]> = [
      [grant({ accessToken: 'fresh-token', accessTokenExpiresAt: Date.now() + 60_000 }), 'fresh-token'],
      [{ kind: 'grant', payload: { version: 1, clientId: CLIENT_ID, accessToken: '' } }, undefined],
      [grant({ clientId: OTHER_CLIENT_ID, accessTokenExpiresAt: Date.now() + 60_000 }), undefined],
      [grant({ accessTokenExpiresAt: Date.now() - 1, refreshToken: undefined }), undefined],
    ]
    for (const [current, expected] of currentRecords) {
      const fetchMock = vi.fn<typeof fetch>()
      vi.stubGlobal('fetch', fetchMock)
      const ctx = await fixture()
      const memory = ctx.credentials as MemoryCredentials
      await seed(ctx, grant({
        accessTokenExpiresAt: Date.now() - 1,
        refreshToken: 'refresh-token',
        refreshTokenExpiresAt: Date.now() + 60_000,
      }))
      const originalRead = memory.readRecord.bind(memory)
      vi.spyOn(memory, 'readRecord').mockImplementationOnce(async (key) => {
        const initial = await originalRead(key)
        memory.replaceFromOtherProcess(key, current)
        return initial
      })
      const token = await ctx.githubAppAuth.tokenFor(new URL(GITHUB_MCP_URL))
      expect(token).toBe(expected)
      expect(fetchMock).not.toHaveBeenCalled()
      await ctx.fiber.dispose()
    }
  })

  it('quiesces an in-flight refresh before disconnect removes the record', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const pending = Promise.withResolvers<Response>()
    fetchMock.mockReturnValueOnce(pending.promise)
    const ctx = await fixture()
    await seed(ctx, grant({
      accessTokenExpiresAt: Date.now() - 1,
      refreshToken: 'refresh-token',
      refreshTokenExpiresAt: Date.now() + 60_000,
    }))
    const request = ctx.githubAppAuth.tokenFor(new URL(GITHUB_MCP_URL))
    await flush()
    const disconnect = ctx.githubAppAuth.disconnect()
    pending.resolve(json({ access_token: 'late-token', token_type: 'bearer', expires_in: 3_600 }))
    await disconnect
    await expect(request).resolves.toBeUndefined()
    expect(await ctx.credentials.readRecord(GITHUB_APP_CREDENTIAL_KEY)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('does not emit a disconnect event if disposal wins the teardown race', async () => {
    const ctx = await fixture()
    const service = ctx.githubAppAuth
    await seed(ctx, grant())
    const memory = ctx.credentials as MemoryCredentials
    const pending = Promise.withResolvers<undefined>()
    const originalDelete = memory.deleteRecord.bind(memory)
    vi.spyOn(memory, 'deleteRecord').mockImplementationOnce(async (key) => {
      await pending.promise
      await originalDelete(key)
    })
    const changed = vi.fn()
    ctx.on('github-app-auth/connection-changed', changed)
    const disconnect = service.disconnect()
    await flush()
    await ctx.fiber.dispose()
    pending.resolve(undefined)
    await disconnect
    expect(changed).not.toHaveBeenCalled()
  })

  it('atomically invalidates a rejected grant without deleting a newer sign-in', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const pending = Promise.withResolvers<Response>()
    fetchMock.mockReturnValueOnce(pending.promise)
    const ctx = await fixture()
    await seed(ctx, grant({ accessTokenExpiresAt: Date.now() - 1, refreshToken: 'refresh-token', refreshTokenExpiresAt: Date.now() + 60_000 }))
    const changed = vi.fn()
    ctx.on('github-app-auth/connection-changed', changed)

    const request = ctx.githubAppAuth.tokenFor(new URL(GITHUB_MCP_URL))
    await flush()
    const memory = ctx.credentials as MemoryCredentials
    memory.replaceFromOtherProcess(
      GITHUB_APP_CREDENTIAL_KEY,
      grant({ accessToken: 'new-token', accessTokenExpiresAt: Date.now() + 60_000 }),
    )
    pending.resolve(json({ error: 'bad_refresh_token' }))
    await expect(request).resolves.toBeUndefined()
    expect(await ctx.credentials.readRecord(GITHUB_APP_CREDENTIAL_KEY)).toMatchObject({
      payload: { accessToken: 'new-token' },
    })
    expect(changed).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('writes one secret-free marker and emits once for a definitive refresh failure', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(json({ error: 'bad_refresh_token' }, 400))
    const ctx = await fixture()
    await seed(ctx, grant({ accessTokenExpiresAt: Date.now() - 1, refreshToken: 'refresh-token', refreshTokenExpiresAt: Date.now() + 60_000 }))
    const changed = vi.fn()
    ctx.on('github-app-auth/connection-changed', changed)

    await expect(ctx.githubAppAuth.tokenFor(new URL(GITHUB_MCP_URL))).resolves.toBeUndefined()
    await expect(ctx.githubAppAuth.tokenFor(new URL(GITHUB_MCP_URL))).resolves.toBeUndefined()
    expect(await ctx.credentials.readRecord(GITHUB_APP_CREDENTIAL_KEY)).toEqual({
      kind: 'grant', payload: { version: 1, invalidated: true },
    })
    expect(changed).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('blocks a new authorization while disconnect is quiescing and removes the grant', async () => {
    const ctx = await fixture()
    await seed(ctx, grant())
    const changed = vi.fn()
    ctx.on('github-app-auth/connection-changed', changed)
    const disconnect = ctx.githubAppAuth.disconnect()
    const surface = interaction()
    await expect(ctx.authorization.begin({ key: GITHUB_APP_CREDENTIAL_KEY, method: 'device', interaction: surface.value }))
      .resolves.toEqual({ status: 'cancelled' })
    await disconnect
    expect(await ctx.credentials.readRecord(GITHUB_APP_CREDENTIAL_KEY)).toBeUndefined()
    expect(changed).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('cancels a device poll before it can commit when disconnect starts', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(json({
      device_code: 'device-code', user_code: 'ABCD-EFGH',
      verification_uri: 'https://github.com/login/device', expires_in: 600, interval: 1,
    }))
    const ctx = await fixture()
    const surface = interaction()
    const attempt = ctx.authorization.begin({ key: GITHUB_APP_CREDENTIAL_KEY, method: 'device', interaction: surface.value })
    await flush()
    await ctx.githubAppAuth.disconnect()
    await expect(attempt).resolves.toEqual({ status: 'cancelled' })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await ctx.credentials.readRecord(GITHUB_APP_CREDENTIAL_KEY)).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
