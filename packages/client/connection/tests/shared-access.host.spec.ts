/** Self-hosted collaborator enrollment and the isolated shared-bot RPC seam. */
import { EventEmitter } from 'node:events'
import { PassThrough, Readable } from 'node:stream'
import { Context } from '@yharness/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute, WebServer, WebUpgradeRoute } from '@yharness/host-webserver'
import { CredentialProvider, credentialKey } from '@yharness/credentials'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@yharness/credentials'
import {
  SHARED_BOTS_PATH,
  SharedAccessAuthority,
  SharedInviteCode,
  apply,
  inject,
  sharedPrincipalOf,
  sharedSessionExpiresAt,
  sharedRevocationSignal,
  type ClientRequest,
  type ConnectionConfig,
  type HostConnectionHandle,
} from '../src/index.ts'

class KeyedCredentials extends CredentialProvider {
  failReads = false
  constructor(ctx: Context, private readonly records = new Map<CredentialKey, CredentialRecord>()) { super(ctx) }
  private tail = Promise.resolve()

  resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> { return Promise.resolve(undefined) }

  describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  set(_ref: CredentialRef, _value: string): Promise<void> { return Promise.resolve() }

  unset(_ref: CredentialRef): Promise<void> { return Promise.resolve() }

  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.records.get(key))
  }

  describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = this.records.get(key)
    return Promise.resolve(record === undefined
      ? { configured: false, writable: true }
      : { configured: true, kind: record.kind, writable: true })
  }

  listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([...this.records].map(([key, record]) => ({ key, kind: record.kind })))
  }

  modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    if (this.failReads) return Promise.reject(new Error('credential store unavailable'))
    const run = this.tail.then(async () => {
      const next = await mutate(this.records.get(key))
      if (next !== undefined) this.records.set(key, next)
      return this.records.get(key)
    })
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  deleteRecord(key: CredentialKey): Promise<void> {
    this.records.delete(key)
    return Promise.resolve()
  }
}

function fakeHttpServer(routes: WebRoute[], upgrades: WebUpgradeRoute[] = []): Pick<WebServer, 'register' | 'registerUpgrade' | 'tapIndex' | 'port'> {
  return {
    register(route) {
      if (routes.some(candidate => candidate.kind === route.kind && candidate.path === route.path)) {
        throw new Error(`duplicate route ${route.path}`)
      }
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    registerUpgrade(route) {
      upgrades.push(route)
      return () => { upgrades.splice(upgrades.indexOf(route), 1) }
    },
    tapIndex: () => () => {},
    port: 0,
  }
}

function fakeRequest(headers: Record<string, string>, url = '/api/session.list'): IncomingMessage {
  const request = Readable.from([]) as IncomingMessage
  Object.assign(request, { url, method: 'GET', headers })
  return request
}

function fakePost(headers: Record<string, string>, url: string, body: unknown): IncomingMessage {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage
  Object.assign(request, { url, method: 'POST', headers: { 'content-type': 'application/json', ...headers } })
  return request
}

function fakeResponse(): { response: ServerResponse; state: { status?: number; headers?: Record<string, string>; body?: string } } {
  const state: { status?: number; headers?: Record<string, string>; body?: string } = {}
  const chunks: Buffer[] = []
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    writeHead(value: number, headers?: Record<string, string>) {
      state.status = value
      if (headers !== undefined) state.headers = headers
      return this
    },
    write(value: string | Uint8Array) { chunks.push(Buffer.from(value)); return true },
    end(this: { writableEnded: boolean }, value?: unknown) {
      if (typeof value === 'string' || value instanceof Uint8Array) chunks.push(Buffer.from(value))
      if (chunks.length > 0) state.body = Buffer.concat(chunks).toString()
      this.writableEnded = true
      return this
    },
  }) as ServerResponse
  return { response, state }
}

async function mounted(config?: ConnectionConfig, options: { webServer?: boolean } = {}): Promise<{
  ctx: Context
  credentials: CredentialProvider
  routes: WebRoute[]
  upgrades: WebUpgradeRoute[]
  connection: HostConnectionHandle
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  const upgrades: WebUpgradeRoute[] = []
  const credentials = new KeyedCredentials(ctx)
  if (options.webServer !== false) {
    ctx.provide('webServer', fakeHttpServer(routes, upgrades) as WebServer)
  }
  const fiber = ctx.plugin({ inject: [...inject], apply }, config)
  await fiber.await()
  return {
    ctx,
    credentials,
    routes,
    upgrades,
    connection: ctx.get('connection') as HostConnectionHandle,
    dispose: () => fiber.dispose(),
  }
}

function browserCookie(connection: HostConnectionHandle, authority: string): string {
  const url = new URL(connection.authenticatedUrl(`http://${authority}`))
  const exchanged = fakeResponse()
  connection.authorizeIndex(
    fakeRequest({ host: authority }, `${url.pathname}${url.search}`),
    exchanged.response,
  )
  const setCookie = exchanged.state.headers?.['set-cookie']
  if (setCookie === undefined) throw new Error('browser token exchange did not set a cookie')
  return setCookie.split(';', 1)[0]!
}

function cookieFromSetCookie(setCookie: string): string {
  return setCookie.split(';', 1)[0]!
}

function parsedJson(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as Record<string, unknown>
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('expected JSON object')
  return parsed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

describe('self-hosted shared-bot access', () => {
  it('redeems a one-time invite into a principal-bound cookie and revokes it', async () => {
    const { ctx, connection, dispose } = await mounted()
    const authority = await SharedAccessAuthority.create(ctx, ctx.credentials, {
      sessionMaxAgeMs: 60_000,
      inviteMaxAgeMs: 60_000,
      now: () => 1_000,
    })
    try {
      const invite = await authority.createInvite()
      const enrollment = await authority.redeemInvite(invite.code, fakeRequest({ host: '127.0.0.1:3080' }))
      expect(enrollment.principalId).toMatch(/^principal-/)
      expect(enrollment.setCookie).toContain('HttpOnly')
      await expect(authority.redeemInvite(invite.code, fakeRequest({ host: '127.0.0.1:3080' }))).rejects.toThrow(/invalid or expired/)

      const admitted = await connection.admitShared(fakeRequest({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }), authority)
      expect('peer' in admitted).toBe(true)
      if ('peer' in admitted) expect(sharedPrincipalOf(admitted.peer)).toBe(enrollment.principalId)

      await authority.revokePrincipal(enrollment.principalId)
      expect(await connection.admitShared(fakeRequest({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }), authority)).toEqual({ rejection: 401 })
    } finally {
      await authority.dispose()
      await dispose()
    }
  })

  it('serializes invite consumption and observes revocation across authority instances', async () => {
    const { ctx, dispose } = await mounted()
    const options = { sessionMaxAgeMs: 60_000, inviteMaxAgeMs: 60_000, now: () => 1_000 }
    const first = await SharedAccessAuthority.create(ctx, ctx.credentials, options)
    const invite = await first.createInvite()
    const second = await SharedAccessAuthority.create(ctx, ctx.credentials, options)
    try {
      const redeemed = await Promise.allSettled([
        first.redeemInvite(invite.code, fakeRequest({ host: '127.0.0.1:3080' })),
        second.redeemInvite(invite.code, fakeRequest({ host: '127.0.0.1:3080' })),
      ])
      expect(redeemed.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(redeemed.filter(result => result.status === 'rejected')).toHaveLength(1)

      const enrollment = await first.redeemInvite((await first.createInvite()).code, fakeRequest({ host: '127.0.0.1:3080' }))
      const observer = await SharedAccessAuthority.create(ctx, ctx.credentials, options)
      await first.revokePrincipal(enrollment.principalId)
      expect(await observer.admit(fakeRequest({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }))).toEqual({ rejection: 401 })
      await observer.dispose()
    } finally {
      await second.dispose()
      await first.dispose()
      await dispose()
    }
  })

  it('reuses one durable owner principal across concurrent Hosts and restart', async () => {
    const { ctx, credentials, dispose } = await mounted()
    const options = { sessionMaxAgeMs: 60_000, inviteMaxAgeMs: 60_000, now: () => 1_000 }
    const first = await SharedAccessAuthority.create(ctx, credentials, options)
    const second = await SharedAccessAuthority.create(ctx, credentials, options)
    let reloaded: SharedAccessAuthority | undefined
    try {
      const [one, two] = await Promise.all([
        first.enrollOwner(fakeRequest({ host: '127.0.0.1:3080' })),
        second.enrollOwner(fakeRequest({ host: '127.0.0.1:3080' })),
      ])
      expect(one.principalId).toBe(two.principalId)
      const record = await credentials.readRecord(credentialKey('client-connection', 'shared-access'))
      expect(record).toMatchObject({
        payload: {
          principals: [{ id: one.principalId }],
          extensions: {
            'client-connection/shared-owner': { version: 1, principalId: one.principalId },
          },
        },
      })

      await first.dispose()
      await second.dispose()
      reloaded = await SharedAccessAuthority.create(ctx, credentials, options)
      const afterRestart = await reloaded.enrollOwner(fakeRequest({ host: '127.0.0.1:3080' }))
      expect(afterRestart.principalId).toBe(one.principalId)
      expect(await reloaded.admit(fakeRequest({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(afterRestart.setCookie),
      }))).toHaveProperty('peer')
    } finally {
      await reloaded?.dispose()
      await second.dispose()
      await first.dispose()
      await dispose()
    }
  })

  it('extends an active collaborator principal when redeeming a second invite', async () => {
    const { ctx, dispose } = await mounted()
    const authority = await SharedAccessAuthority.create(ctx, ctx.credentials, {
      sessionMaxAgeMs: 60_000,
      inviteMaxAgeMs: 60_000,
      now: () => 1_000,
    })
    try {
      const first = await authority.redeemInvite(
        (await authority.createInvite()).code,
        fakeRequest({ host: '127.0.0.1:3080' }),
      )
      const second = await authority.redeemInvite(
        (await authority.createInvite()).code,
        fakeRequest({
          host: '127.0.0.1:3080',
          cookie: cookieFromSetCookie(first.setCookie),
        }),
      )
      expect(second.principalId).toBe(first.principalId)
      const admitted = await authority.admit(fakeRequest({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(second.setCookie),
      }))
      expect('peer' in admitted && sharedPrincipalOf(admitted.peer)).toBe(first.principalId)
    } finally {
      await authority.dispose()
      await dispose()
    }
  })

  it('closes active sockets admitted by another authority instance when a principal is revoked', async () => {
    const { ctx, credentials, upgrades, connection, dispose } = await mounted()
    const options = { sessionMaxAgeMs: 60_000, inviteMaxAgeMs: 60_000, now: () => 1_000 }
    const issuer = await SharedAccessAuthority.create(ctx, credentials, options)
    const observer = await SharedAccessAuthority.create(ctx, credentials, options)
    const enrollment = await issuer.redeemInvite((await issuer.createInvite()).code, fakeRequest({ host: '127.0.0.1:3080' }))
    const admitted = await observer.admit(fakeRequest({
      host: '127.0.0.1:3080',
      cookie: cookieFromSetCookie(enrollment.setCookie),
    }))
    expect('peer' in admitted).toBe(true)
    const remove = connection.sharedRpc.upgrade(SHARED_BOTS_PATH, observer, async () => {}, { maxInboundBytes: 64 })
    try {
      const route = upgrades.find(candidate => candidate.path === SHARED_BOTS_PATH)
      expect(route).toBeDefined()
      const socket = new PassThrough()
      await route!.handler(fakeRequest({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }), socket, Buffer.alloc(0))
      expect(socket.destroyed).toBe(false)
      await issuer.revokePrincipal(enrollment.principalId)
      if ('peer' in admitted) expect(sharedRevocationSignal(admitted.peer)?.aborted).toBe(true)
      expect(socket.destroyed).toBe(true)
    } finally {
      await remove()
      await observer.dispose()
      await issuer.dispose()
      await dispose()
    }
  })

  it('closes active sockets after a revocation in a separate authority process', async () => {
    vi.useFakeTimers()
    const sharedRecords = new Map<CredentialKey, CredentialRecord>()
    const first = await mounted()
    const firstCredentialsContext = new Context()
    const secondCredentialsContext = new Context()
    const secondCredentials = new KeyedCredentials(secondCredentialsContext, sharedRecords)
    const firstCredentials = new KeyedCredentials(firstCredentialsContext, sharedRecords)
    let issuer: SharedAccessAuthority | undefined
    let observer: SharedAccessAuthority | undefined
    let remove: (() => Promise<void>) | undefined
    try {
      const options = { sessionMaxAgeMs: 60_000, inviteMaxAgeMs: 60_000, now: Date.now }
      issuer = await SharedAccessAuthority.create(first.ctx, firstCredentials, options)
      observer = await SharedAccessAuthority.create(first.ctx, secondCredentials, options)
      const enrollment = await issuer.redeemInvite(
        (await issuer.createInvite()).code,
        fakeRequest({ host: '127.0.0.1:3080' }),
      )
      remove = first.connection.sharedRpc.upgrade(SHARED_BOTS_PATH, observer, async () => {}, { maxInboundBytes: 64 })
      const route = first.upgrades.find(candidate => candidate.path === SHARED_BOTS_PATH)
      expect(route).toBeDefined()
      const socket = new PassThrough()
      await route!.handler(fakeRequest({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }), socket, Buffer.alloc(0))
      expect(socket.destroyed).toBe(false)

      await issuer.revokePrincipal(enrollment.principalId)
      expect(await observer.admit(fakeRequest({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }))).toEqual({ rejection: 401 })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(socket.destroyed).toBe(true)
    } finally {
      vi.useRealTimers()
      await remove?.()
      await observer?.dispose()
      await issuer?.dispose()
      await secondCredentialsContext.fiber.dispose()
      await firstCredentialsContext.fiber.dispose()
      await first.dispose()
    }
  })

  it('requires the trust fence for direct admission and secure cookies for network authorities', async () => {
    const { ctx, dispose } = await mounted()
    const authority = await SharedAccessAuthority.create(ctx, ctx.credentials, {
      sessionMaxAgeMs: 60_000,
      inviteMaxAgeMs: 60_000,
      now: () => 1_000,
    })
    try {
      const enrollment = await authority.redeemInvite((await authority.createInvite()).code, fakeRequest({ host: '127.0.0.1:3080' }))
      expect(await authority.admit({ headers: { cookie: cookieFromSetCookie(enrollment.setCookie) } })).toEqual({ rejection: 403 })
    } finally {
      await authority.dispose()
      await dispose()
    }

    const network = await mounted()
    try {
      await expect(SharedAccessAuthority.create(network.ctx, network.ctx.credentials, {
        sessionMaxAgeMs: 60_000,
        inviteMaxAgeMs: 60_000,
        trustedHosts: ['harness.example'],
      })).rejects.toThrow(/secureCookie/)
      const secure = await SharedAccessAuthority.create(network.ctx, network.ctx.credentials, {
        sessionMaxAgeMs: 60_000,
        inviteMaxAgeMs: 60_000,
        trustedHosts: ['harness.example'],
        secureCookie: true,
      })
      try {
        const enrollment = await secure.redeemInvite((await secure.createInvite()).code, fakeRequest({ host: 'harness.example:443' }))
        expect(enrollment.setCookie).toContain('; Secure')
      } finally {
        await secure.dispose()
      }
    } finally {
      await network.dispose()
    }
  })

  it('reloads durable sessions and rejects tampered or expired cookies', async () => {
    const { ctx, connection, dispose } = await mounted()
    let now = 1_000
    const options = { sessionMaxAgeMs: 60_000, inviteMaxAgeMs: 60_000, now: () => now }
    const authority = await SharedAccessAuthority.create(ctx, ctx.credentials, options)
    const enrollment = await authority.redeemInvite((await authority.createInvite()).code, fakeRequest({ host: '127.0.0.1:3080' }))
    await authority.dispose()
    const reloaded = await SharedAccessAuthority.create(ctx, ctx.credentials, options)
    try {
      const headers = { host: '127.0.0.1:3080', cookie: cookieFromSetCookie(enrollment.setCookie) }
      expect(await connection.admitShared(fakeRequest(headers), reloaded)).toHaveProperty('peer')
      const tampered = `${headers.cookie.slice(0, -1)}${headers.cookie.endsWith('A') ? 'B' : 'A'}`
      expect(await connection.admitShared(fakeRequest({ ...headers, cookie: tampered }), reloaded)).toEqual({ rejection: 401 })
      now = 61_000
      expect(await connection.admitShared(fakeRequest(headers), reloaded)).toEqual({ rejection: 401 })
    } finally {
      await reloaded.dispose()
      await dispose()
    }
  })

  it('binds an enrollment cookie to the exact request authority', async () => {
    const { ctx, connection, dispose } = await mounted()
    const authority = await SharedAccessAuthority.create(ctx, ctx.credentials, {
      sessionMaxAgeMs: 60_000,
      inviteMaxAgeMs: 60_000,
      now: () => 1_000,
    })
    try {
      const enrollment = await authority.redeemInvite(
        (await authority.createInvite()).code,
        fakeRequest({ host: '127.0.0.1:3080' }),
      )
      expect(await connection.admitShared(fakeRequest({
        host: '127.0.0.1:3081',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }), authority)).toEqual({ rejection: 401 })
      expect(await connection.admitShared(fakeRequest({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }), authority)).toHaveProperty('peer')
    } finally {
      await authority.dispose()
      await dispose()
    }
  })

  it('prunes expired sessions from durable state after closing their peer scope', async () => {
    const { ctx, dispose } = await mounted()
    let now = 1_000
    const authority = await SharedAccessAuthority.create(ctx, ctx.credentials, {
      sessionMaxAgeMs: 60_000,
      inviteMaxAgeMs: 60_000,
      now: () => now,
    })
    try {
      const enrollment = await authority.redeemInvite((await authority.createInvite()).code, fakeRequest({ host: '127.0.0.1:3080' }))
      expect(await authority.admit(fakeRequest({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }))).toHaveProperty('peer')
      now = 61_000
      expect(await authority.admit(fakeRequest({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }))).toEqual({ rejection: 401 })
      const record = await ctx.credentials.readRecord(credentialKey('client-connection', 'shared-access'))
      expect(record).toMatchObject({ payload: { sessions: [] } })
    } finally {
      await authority.dispose()
      await dispose()
    }
  })

  it('keeps shared-bot RPC separate from the operator /api route', async () => {
    const { ctx, routes, connection, dispose } = await mounted()
    const authority = await SharedAccessAuthority.create(ctx, ctx.credentials, {
      sessionMaxAgeMs: 60_000,
      inviteMaxAgeMs: 60_000,
      now: () => 1_000,
    })
    const enrollment = await authority.redeemInvite((await authority.createInvite()).code, fakeRequest({ host: '127.0.0.1:3080' }))
    const calls: Array<{ endpoint: string; principalId: string | undefined }> = []
    const remove = connection.sharedRpc.handle(SHARED_BOTS_PATH, authority, async (endpoint, _payload, _signal, peer) => {
      if (endpoint === 'bots/share/fail') throw new Error('secret handler failure')
      if (endpoint === 'bots/share/serialize') {
        const circular: { self?: unknown } = {}
        circular.self = circular
        return { ok: true, value: circular }
      }
      calls.push({ endpoint, principalId: sharedPrincipalOf(peer) })
      return { ok: true, value: { accepted: true } }
    }, { endpoints: ['bots/share/chat', 'bots/share/fail', 'bots/share/serialize'] })
    try {
      const route = routes.find(candidate => candidate.path === SHARED_BOTS_PATH)
      expect(route).toBeDefined()
      const request: ClientRequest = {
        type: 'client-request',
        rpcId: 'shared-rpc' as ClientRequest['rpcId'],
        method: 'bots/share/chat',
        payload: { args: { botId: 'bot-shared', message: 'hello' } },
      }
      const answered = fakeResponse()
      await route!.handler(fakePost({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }, `${SHARED_BOTS_PATH}/bots/share/chat`, request), answered.response)
      expect(answered.state.status).toBe(200)
      expect(JSON.parse(answered.state.body!)).toMatchObject({ result: { ok: true, value: { accepted: true } } })
      expect(calls).toEqual([{ endpoint: 'bots/share/chat', principalId: enrollment.principalId }])

      const ordinary = fakeResponse()
      await route!.handler(fakePost({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }, `${SHARED_BOTS_PATH}/session/list`, { ...request, method: 'session/list' }), ordinary.response)
      expect(JSON.parse(ordinary.state.body!)).toMatchObject({
        result: { ok: false, error: { code: 'gateway/forbidden' } },
      })
      expect(calls).toHaveLength(1)

      const unlisted = fakeResponse()
      await route!.handler(fakePost({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }, `${SHARED_BOTS_PATH}/bots/share/other`, { ...request, method: 'bots/share/other' }), unlisted.response)
      expect(JSON.parse(unlisted.state.body!)).toMatchObject({
        result: { ok: false, error: { code: 'gateway/forbidden' } },
      })
      expect(calls).toHaveLength(1)

      const failed = fakeResponse()
      await route!.handler(fakePost({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }, `${SHARED_BOTS_PATH}/bots/share/fail`, { ...request, method: 'bots/share/fail' }), failed.response)
      expect(failed.state.body).not.toContain('secret handler failure')
      expect(JSON.parse(failed.state.body!)).toMatchObject({
        result: { ok: false, error: { code: 'gateway/internal' } },
      })

      const serialization = fakeResponse()
      await route!.handler(fakePost({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }, `${SHARED_BOTS_PATH}/bots/share/serialize`, { ...request, method: 'bots/share/serialize' }), serialization.response)
      expect(serialization.state.body).not.toContain('circular')
      expect(JSON.parse(serialization.state.body!)).toMatchObject({
        result: { ok: false, error: { code: 'gateway/internal' } },
      })

      const operatorCookie = browserCookie(connection, '127.0.0.1:3080')
      const sharedWithOperator = fakeResponse()
      await route!.handler(fakePost({
        host: '127.0.0.1:3080', cookie: operatorCookie,
      }, `${SHARED_BOTS_PATH}/bots/share/chat`, request), sharedWithOperator.response)
      expect(sharedWithOperator.state).toMatchObject({ status: 401, body: 'unauthorized' })

      const operatorRoute = routes.find(candidate => candidate.path === '/api')!
      const operatorWithShared = fakeResponse()
      await operatorRoute.handler(fakePost({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }, '/api/bots/share/chat', request), operatorWithShared.response)
      expect(operatorWithShared.state).toMatchObject({ status: 401, body: 'unauthorized' })
    } finally {
      await remove()
      await authority.dispose()
      await dispose()
    }
  })

  it('restores the authenticated shared principal without exposing credentials', async () => {
    const { ctx, routes, connection, dispose } = await mounted()
    const authority = await SharedAccessAuthority.create(ctx, ctx.credentials, {
      sessionMaxAgeMs: 60_000,
      inviteMaxAgeMs: 60_000,
      now: () => 1_000,
    })
    const enrollment = await authority.redeemInvite((await authority.createInvite()).code, fakeRequest({ host: '127.0.0.1:3080' }))
    const remove = connection.sharedRpc.handle(SHARED_BOTS_PATH, authority, async (endpoint, _payload, _signal, peer) => {
      if (endpoint !== 'bots/share/session') return { ok: false, error: { code: 'gateway/forbidden', message: 'unexpected endpoint', details: {} } }
      return {
        ok: true,
        value: {
          principalId: sharedPrincipalOf(peer),
          expiresAt: sharedSessionExpiresAt(peer),
        },
      }
    }, { endpoints: ['bots/share/session'] })
    try {
      const route = routes.find(candidate => candidate.path === SHARED_BOTS_PATH)
      expect(route).toBeDefined()
      const request: ClientRequest = {
        type: 'client-request',
        rpcId: 'shared-session' as ClientRequest['rpcId'],
        method: 'bots/share/session',
        payload: {},
      }
      const authenticated = fakeResponse()
      await route!.handler(fakePost({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }, `${SHARED_BOTS_PATH}/bots/share/session`, request), authenticated.response)
      expect(authenticated.state.status).toBe(200)
      const body = parsedJson(authenticated.state.body!)
      expect(body).toMatchObject({
        result: { ok: true, value: { principalId: enrollment.principalId, expiresAt: 61_000 } },
      })
      expect(body).not.toHaveProperty('result.value.setCookie')

      const unauthenticated = fakeResponse()
      await route!.handler(fakePost({ host: '127.0.0.1:3080' }, `${SHARED_BOTS_PATH}/bots/share/session`, request), unauthenticated.response)
      expect(unauthenticated.state.status).toBe(401)

      const mismatchedOrigin = fakeResponse()
      await route!.handler(fakePost({
        host: '127.0.0.1:3080',
        origin: 'http://evil.example',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }, `${SHARED_BOTS_PATH}/bots/share/session`, request), mismatchedOrigin.response)
      expect(mismatchedOrigin.state.status).toBe(403)
    } finally {
      await remove()
      await authority.dispose()
      await dispose()
    }
  })

  it('mounts only the trust-fenced shared enrollment endpoint', async () => {
    const { ctx, routes, connection, dispose } = await mounted()
    const authority = await SharedAccessAuthority.create(ctx, ctx.credentials, {
      sessionMaxAgeMs: 60_000,
      inviteMaxAgeMs: 60_000,
      now: () => 1_000,
    })
    const invite = await authority.createInvite()
    const remove = connection.sharedRpc.enroll(SHARED_BOTS_PATH, async (endpoint, payload, _signal, request) => {
      if (endpoint !== 'bots/share/enroll' || typeof payload !== 'object' || payload === null
        || !('code' in payload) || typeof payload.code !== 'string') {
        return { ok: false, error: { code: 'gateway/bad-request', message: 'invalid enrollment', details: {} } }
      }
      const enrollment = await authority.redeemInvite(SharedInviteCode(payload.code), request)
      return { ok: true, value: enrollment }
    })
    try {
      const route = routes.find(candidate => candidate.path === `${SHARED_BOTS_PATH}/bots/share/enroll`)
      expect(route?.kind).toBe('exact')
      const response = fakeResponse()
      const body: ClientRequest = {
        type: 'client-request',
        rpcId: 'enroll-rpc' as ClientRequest['rpcId'],
        method: 'bots/share/enroll',
        payload: { code: String(invite.code) },
      }
      await route!.handler(fakePost({ host: '127.0.0.1:3080' }, `${SHARED_BOTS_PATH}/bots/share/enroll`, body), response.response)
      expect(response.state.status).toBe(200)
      expect(response.state.headers?.['set-cookie']).toContain('dsh-shared-bot=')
      expect(response.state.body).not.toContain('setCookie')
      const parsed = parsedJson(response.state.body!)
      expect(parsed).toMatchObject({ result: { ok: true } })
      const result = parsed.result
      if (!isRecord(result) || !isRecord(result.value) || typeof result.value.principalId !== 'string') {
        throw new Error('enrollment response omitted its principal')
      }
      expect(result.value.principalId).toMatch(/^principal-/)

      const denied = fakeResponse()
      await route!.handler(fakePost({ host: 'other.example' }, `${SHARED_BOTS_PATH}/bots/share/enroll`, body), denied.response)
      expect(denied.state).toMatchObject({ status: 403, body: 'forbidden' })
    } finally {
      await remove()
      await authority.dispose()
      await dispose()
    }
  })

  it('rejects an untrusted shared-bot request before collaborator authentication', async () => {
    const { ctx, routes, connection, dispose } = await mounted()
    const authority = await SharedAccessAuthority.create(ctx, ctx.credentials, {
      sessionMaxAgeMs: 60_000,
      inviteMaxAgeMs: 60_000,
      now: () => 1_000,
    })
    const remove = connection.sharedRpc.handle(SHARED_BOTS_PATH, authority, async () => ({ ok: true, value: null }), {
      endpoints: ['bots/share/chat'],
    })
    try {
      const route = routes.find(candidate => candidate.path === SHARED_BOTS_PATH)!
      const denied = fakeResponse()
      await route.handler(fakePost({ host: 'other.example' }, `${SHARED_BOTS_PATH}/bots/share/chat`, {}), denied.response)
      expect(denied.state).toMatchObject({ status: 403, body: 'forbidden' })
    } finally {
      await remove()
      await authority.dispose()
      await dispose()
    }
  })

  it('enforces the configured body limit on shared-bot requests', async () => {
    const { ctx, routes, connection, dispose } = await mounted()
    const authority = await SharedAccessAuthority.create(ctx, ctx.credentials, {
      sessionMaxAgeMs: 60_000,
      inviteMaxAgeMs: 60_000,
      now: () => 1_000,
    })
    const enrollment = await authority.redeemInvite((await authority.createInvite()).code, fakeRequest({ host: '127.0.0.1:3080' }))
    const remove = connection.sharedRpc.handle(SHARED_BOTS_PATH, authority, async () => ({ ok: true, value: null }), {
      endpoints: ['bots/share/chat'], maxRequestBodyBytes: 64,
    })
    try {
      const route = routes.find(candidate => candidate.path === SHARED_BOTS_PATH)!
      const oversized = fakeResponse()
      await route.handler(fakePost({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }, `${SHARED_BOTS_PATH}/bots/share/chat`, {
        type: 'client-request', rpcId: 'oversized', method: 'bots/share/chat', payload: 'x'.repeat(512),
      }), oversized.response)
      expect(oversized.state.status).toBe(413)
    } finally {
      await remove()
      await authority.dispose()
      await dispose()
    }
  })

  it('bounds shared HTTP concurrency independently of the ordinary API', async () => {
    const { ctx, routes, connection, dispose } = await mounted()
    const authority = await SharedAccessAuthority.create(ctx, ctx.credentials, {
      sessionMaxAgeMs: 60_000,
      inviteMaxAgeMs: 60_000,
      now: () => 1_000,
    })
    const enrollment = await authority.redeemInvite((await authority.createInvite()).code, fakeRequest({ host: '127.0.0.1:3080' }))
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const remove = connection.sharedRpc.handle(SHARED_BOTS_PATH, authority, async () => {
      await blocked
      return { ok: true, value: null }
    }, { endpoints: ['bots/share/chat'], maxConcurrentRequests: 1 })
    try {
      const route = routes.find(candidate => candidate.path === SHARED_BOTS_PATH)
      expect(route).toBeDefined()
      const body: ClientRequest = {
        type: 'client-request', rpcId: 'concurrency' as ClientRequest['rpcId'], method: 'bots/share/chat', payload: {},
      }
      const headers = {
        host: '127.0.0.1:3080', cookie: cookieFromSetCookie(enrollment.setCookie),
      }
      const firstResponse = fakeResponse()
      const first = route!.handler(fakePost(headers, `${SHARED_BOTS_PATH}/bots/share/chat`, body), firstResponse.response)
      await Promise.resolve()
      const secondResponse = fakeResponse()
      await route!.handler(fakePost(headers, `${SHARED_BOTS_PATH}/bots/share/chat`, body), secondResponse.response)
      expect(secondResponse.state.status).toBe(429)
      release?.()
      await first
      expect(firstResponse.state.status).toBe(200)
    } finally {
      release?.()
      await remove()
      await authority.dispose()
      await dispose()
    }
  })

  it('does not let pending collaborator authentication consume handler capacity', async () => {
    const { routes, connection, dispose } = await mounted()
    let releaseFirst: (() => void) | undefined
    const firstEntered = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let entered = false
    let calls = 0
    const authenticator = {
      admit: async () => {
        calls += 1
        if (calls === 1) {
          entered = true
          await firstEntered
        }
        return { rejection: 401 as const }
      },
    }
    const remove = connection.sharedRpc.handle(SHARED_BOTS_PATH, authenticator, async () => ({ ok: true, value: null }), {
      endpoints: ['bots/share/chat'], maxConcurrentRequests: 1,
    })
    try {
      const route = routes.find(candidate => candidate.path === SHARED_BOTS_PATH)
      expect(route).toBeDefined()
      const request = {
        host: '127.0.0.1:3080',
      }
      const firstResponse = fakeResponse()
      const first = route!.handler(fakePost(request, `${SHARED_BOTS_PATH}/bots/share/chat`, {}), firstResponse.response)
      await vi.waitFor(() => { expect(entered).toBe(true) })
      const secondResponse = fakeResponse()
      await route!.handler(fakePost(request, `${SHARED_BOTS_PATH}/bots/share/chat`, {}), secondResponse.response)
      expect(secondResponse.state.status).toBe(401)
      releaseFirst?.()
      await first
      expect(firstResponse.state.status).toBe(401)
    } finally {
      releaseFirst?.()
      await remove()
      await dispose()
    }
  })

  it('does not let an authenticated slow body consume handler capacity', async () => {
    const { ctx, routes, connection, dispose } = await mounted()
    const authority = await SharedAccessAuthority.create(ctx, ctx.credentials, {
      sessionMaxAgeMs: 60_000,
      inviteMaxAgeMs: 60_000,
      now: () => 1_000,
    })
    const enrollment = await authority.redeemInvite((await authority.createInvite()).code, fakeRequest({ host: '127.0.0.1:3080' }))
    let handled = 0
    const remove = connection.sharedRpc.handle(SHARED_BOTS_PATH, authority, async () => {
      handled += 1
      return { ok: true, value: null }
    }, { endpoints: ['bots/share/chat'], maxConcurrentRequests: 1 })
    let releaseBody: (() => void) | undefined
    try {
      const route = routes.find(candidate => candidate.path === SHARED_BOTS_PATH)
      expect(route).toBeDefined()
      let bodyStartedResolve: (() => void) | undefined
      const bodyStarted = new Promise<void>((resolve) => { bodyStartedResolve = resolve })
      const slowBody = new Readable({
        read() {
          bodyStartedResolve?.()
          releaseBody = () => { slowBody.push(null) }
        },
      }) as IncomingMessage
      Object.assign(slowBody, {
        url: `${SHARED_BOTS_PATH}/bots/share/chat`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: '127.0.0.1:3080',
          cookie: cookieFromSetCookie(enrollment.setCookie),
        },
      })
      const firstResponse = fakeResponse()
      const first = route!.handler(slowBody, firstResponse.response)
      await bodyStarted
      const secondResponse = fakeResponse()
      await route!.handler(fakePost({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }, `${SHARED_BOTS_PATH}/bots/share/chat`, {
        type: 'client-request', rpcId: 'body-fairness', method: 'bots/share/chat', payload: {},
      }), secondResponse.response)
      expect(secondResponse.state.status).toBe(200)
      expect(handled).toBe(1)
      releaseBody?.()
      await first
      expect(firstResponse.state.status).toBe(400)
    } finally {
      releaseBody?.()
      await remove()
      await authority.dispose()
      await dispose()
    }
  })

  it('admits collaborator WebSocket upgrades as the same principal-bound Peer', async () => {
    const { ctx, upgrades, connection, dispose } = await mounted()
    const authority = await SharedAccessAuthority.create(ctx, ctx.credentials, {
      sessionMaxAgeMs: 60_000,
      inviteMaxAgeMs: 60_000,
      now: () => 1_000,
    })
    const enrollment = await authority.redeemInvite((await authority.createInvite()).code, fakeRequest({ host: '127.0.0.1:3080' }))
    let principalId: string | undefined
    const remove = connection.sharedRpc.upgrade(SHARED_BOTS_PATH, authority, async (_request, _socket, _head, peer) => {
      principalId = sharedPrincipalOf(peer)
    }, { maxInboundBytes: 64 })
    try {
      const route = upgrades.find(candidate => candidate.path === SHARED_BOTS_PATH)
      expect(route).toBeDefined()
      const socket = new PassThrough()
      await route!.handler(fakeRequest({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }), socket, Buffer.alloc(0))
      expect(principalId).toBe(enrollment.principalId)
      expect(socket.destroyed).toBe(false)
      const oversized = new PassThrough()
      await route!.handler(fakeRequest({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }), oversized, Buffer.from([0x82, 126, 0, 65]))
      expect(oversized.destroyed).toBe(true)
      await authority.revokePrincipal(enrollment.principalId)
      expect(socket.destroyed).toBe(true)
    } finally {
      await remove()
      await authority.dispose()
      await dispose()
    }
  })

  it('closes an active collaborator WebSocket when its session expires', async () => {
    const { ctx, upgrades, connection, dispose } = await mounted()
    vi.useFakeTimers()
    let authority: SharedAccessAuthority | undefined
    let remove: (() => Promise<void>) | undefined
    try {
      authority = await SharedAccessAuthority.create(ctx, ctx.credentials, {
        sessionMaxAgeMs: 20,
        inviteMaxAgeMs: 1_000,
        now: Date.now,
      })
      const enrollment = await authority.redeemInvite((await authority.createInvite()).code, fakeRequest({ host: '127.0.0.1:3080' }))
      remove = connection.sharedRpc.upgrade(SHARED_BOTS_PATH, authority, async () => {}, { maxInboundBytes: 64 })
      const route = upgrades.find(candidate => candidate.path === SHARED_BOTS_PATH)
      expect(route).toBeDefined()
      const socket = new PassThrough()
      await route!.handler(fakeRequest({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }), socket, Buffer.alloc(0))
      await vi.advanceTimersByTimeAsync(21)
      expect(socket.destroyed).toBe(true)
    } finally {
      vi.useRealTimers()
      await remove?.()
      await authority?.dispose()
      await dispose()
    }
  })

  it('closes an expiring peer when its durable refresh fails', async () => {
    vi.useFakeTimers()
    const host = await mounted()
    const credentialsContext = new Context()
    const credentials = new KeyedCredentials(credentialsContext)
    let authority: SharedAccessAuthority | undefined
    try {
      authority = await SharedAccessAuthority.create(host.ctx, credentials, {
        sessionMaxAgeMs: 20,
        inviteMaxAgeMs: 1_000,
        now: Date.now,
      })
      const enrollment = await authority.redeemInvite((await authority.createInvite()).code, fakeRequest({ host: '127.0.0.1:3080' }))
      const admitted = await authority.admit(fakeRequest({
        host: '127.0.0.1:3080',
        cookie: cookieFromSetCookie(enrollment.setCookie),
      }))
      expect('peer' in admitted).toBe(true)
      if (!('peer' in admitted)) return
      expect(sharedRevocationSignal(admitted.peer)?.aborted).toBe(false)
      credentials.failReads = true
      await vi.advanceTimersByTimeAsync(21)
      expect(sharedRevocationSignal(admitted.peer)?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
      await authority?.dispose()
      await credentialsContext.fiber.dispose()
      await host.dispose()
    }
  })

  it('mounts shared routes from a child owner without requiring webServer injection', async () => {
    const { ctx, routes, dispose } = await mounted()
    let child: ReturnType<Context['plugin']> | undefined
    try {
      child = ctx.plugin({
        inject: ['credentials'],
        apply(owner) {
          const connection = owner.get('connection')
          if (connection === undefined) throw new Error('connection service is unavailable')
          connection.sharedRpc.enroll(SHARED_BOTS_PATH, async () => ({ ok: true, value: null }))
        },
      })
      await child.await()
      expect(routes.some(route => route.path === `${SHARED_BOTS_PATH}/bots/share/enroll`)).toBe(true)
    } finally {
      await child?.dispose()
      await dispose()
    }
  })

  it('keeps shared route registration optional for headless Connection users', async () => {
    const { ctx, routes, upgrades, dispose } = await mounted(undefined, { webServer: false })
    let child: ReturnType<Context['plugin']> | undefined
    try {
      child = ctx.plugin({
        apply(owner) {
          const connection = owner.get('connection')
          if (connection === undefined) throw new Error('connection service is unavailable')
          connection.sharedRpc.enroll(SHARED_BOTS_PATH, async () => ({ ok: true, value: null }))
        },
      })
      await child.await()
      expect(ctx.get('connection')).toBeDefined()
      expect(routes).toHaveLength(0)
      ctx.provide('webServer', fakeHttpServer(routes, upgrades) as WebServer)
      await vi.waitFor(() => {
        expect(routes.some(route => route.path === `${SHARED_BOTS_PATH}/bots/share/enroll`)).toBe(true)
      })
    } finally {
      await child?.dispose()
      await dispose()
    }
  })
})
