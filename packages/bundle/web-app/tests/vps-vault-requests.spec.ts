import { createServer, Socket, type Server } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@yharness/cordis'
import { BotId } from '@yharness/bots'
import SystemPrompt from '@yharness/system-prompt'
import ToolRuntime from '@yharness/tools'
import { ToolCallId } from '@yharness/llm'
import { expect, it, vi } from 'vitest'
import { SessionId } from '@yharness/session'
import {
  mountVpsVaultRequests, submitAutomaticVpsLogin, VPS_VAULT_REQUEST_SOCKET, VpsVaultRequests, vpsVaultAccessRoute,
  vpsVaultRequestRoute, type VpsVaultRequestsConfig,
} from '../src/vps-vault-requests.ts'

const bot = 'bot-example'
const session = SessionId('bot-session-7e2e3bd7-aec8-4f11-925d-478a83ed004a')
const other = SessionId('bot-session-2d12d9ae-30aa-4465-83ad-2253c62bbb59')
const credential = { unit: 'example-worker.service', name: 'EXAMPLE_API_KEY' }
const unixTest = it.skipIf(process.platform === 'win32')

it.each<{ label: string; config?: VpsVaultRequestsConfig | null; mode: string; scoped?: true }>([
  { label: 'absent requests', mode: 'disabled' },
  { label: 'disabled requests', config: null, mode: 'disabled' },
  { label: 'the standard broker', config: { socketPath: VPS_VAULT_REQUEST_SOCKET }, mode: 'managed', scoped: true },
  { label: 'null grants', config: { socketPath: VPS_VAULT_REQUEST_SOCKET, grants: null }, mode: 'managed', scoped: true },
  { label: 'profile grants', config: { socketPath: VPS_VAULT_REQUEST_SOCKET, grants: [{ bot, ...credential }] }, mode: 'external' },
  { label: 'a custom broker', config: { socketPath: '/run/another-vault.sock', sharedRequests: true }, mode: 'external' },
  { label: 'sharing disabled', config: { socketPath: VPS_VAULT_REQUEST_SOCKET, sharedRequests: false }, mode: 'managed' },
])('reports Bot access mode for $label without disclosing the policy', async ({ config, mode, scoped }) => {
  const route = vpsVaultAccessRoute(config)
  const response = await route.fetch(new Request('http://127.0.0.1/api/bot-vault-access'))
  expect(route.path).toBe('/api/bot-vault-access')
  expect(route.methods).toEqual(['GET'])
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('X-YH-Vault-Grant-Scopes')).toBe(scoped ? '1' : null)
  expect(await response.json()).toEqual({ mode })
})

it('rejects non-Unix Vault socket paths, including valid-looking paths on Windows', () => {
  expect(() => new VpsVaultRequests({ socketPath: 'relative.sock' })).toThrow('absolute Unix path')
  expect(() => new VpsVaultRequests({ socketPath: '/run/vault.sock\u0000' })).toThrow('absolute Unix path')
  if (process.platform === 'win32') {
    expect(() => new VpsVaultRequests({ socketPath: '/run/vault.sock' })).toThrow('absolute Unix path')
  }
})

unixTest('validates Vault configuration and keeps explicit grants isolated by Bot', async () => {
  expect(() => new VpsVaultRequests({ socketPath: '/run/vault.sock', grants: [] })).toThrow('exact Bot')
  expect(() => new VpsVaultRequests({
    socketPath: '/run/vault.sock', grants: [{ bot: 'not-a-bot', ...credential }],
  })).toThrow('exact Bot')
  expect(() => new VpsVaultRequests({
    socketPath: '/run/vault.sock', grants: [{ bot, unit: 'invalid', name: credential.name }],
  })).toThrow('exact Bot')
  expect(() => new VpsVaultRequests({
    socketPath: '/run/vault.sock', grants: [{ bot, unit: 'worker@.service', name: credential.name }],
  })).toThrow('exact Bot')
  expect(() => new VpsVaultRequests({
    socketPath: '/run/vault.sock', grants: [{ bot, unit: credential.unit, name: 'with-dash' }],
  })).toThrow('exact Bot')
  expect(() => new VpsVaultRequests({
    socketPath: '/run/vault.sock',
    grants: [{ bot, unit: credential.unit, name: credential.name }, ...Array.from({ length: 64 }, (_, index) => ({
      bot, unit: `worker-${index}.service`, name: `KEY_${index}`,
    }))],
  })).toThrow('exact Bot')
  expect(() => new VpsVaultRequests({
    socketPath: '/run/vault.sock', grants: [{ bot, unit: credential.unit, name: credential.name }], sharedRequests: true,
  })).toThrow('Vault-managed grants')

  const managed = new VpsVaultRequests({ socketPath: VPS_VAULT_REQUEST_SOCKET })
  expect(managed.brokerManaged).toBe(true)
  expect(managed.sharedEnabled).toBe(true)
  expect(managed.credentialsFor(bot)).toEqual([])
  await managed.dispose()

  const explicit = new VpsVaultRequests({
    socketPath: '/run/vault.sock',
    grants: [{ bot, ...credential }, { bot: 'bot-other', unit: 'other.service', name: 'OTHER_KEY' }],
  })
  expect(explicit.brokerManaged).toBe(false)
  expect(explicit.sharedEnabled).toBe(false)
  expect(explicit.credentialsFor(bot)).toEqual([credential])
  expect(explicit.credentialsFor('bot-missing')).toEqual([])
  await explicit.dispose()
})

async function withBroker<T>(
  reply: (request: Record<string, unknown>) => object | string,
  body: (path: string, calls: readonly Record<string, unknown>[]) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'yh-vault-'))
  const path = join(root, 'r')
  const calls: Record<string, unknown>[] = []
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    let input = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => { input += chunk.toString() })
    socket.once('end', () => {
      const request = JSON.parse(input) as Record<string, unknown>
      calls.push(request)
      const result = reply(request)
      socket.end(typeof result === 'string' ? result : JSON.stringify(result))
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, resolve)
    })
    return await body(path, calls)
  } finally {
    try {
      if (server.listening) await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
    } finally { await rm(root, { recursive: true, force: true }) }
  }
}

unixTest('returns only owner-authenticated request metadata from the chat route', async () => {
  await withBroker(({ action }) => action === 'cancel' ? { state: 'cancelled' } : { state: 'pending' }, async (socketPath) => {
    const requests = new VpsVaultRequests({ socketPath, grants: [{ bot, ...credential }] })
    const lookups = vi.fn(async (id: string) => {
      if (id === session) return { id: bot, sessionId: session, state: 'active' }
      if (id === other) return { id: bot, sessionId: other, state: 'stopped' }
      return undefined
    })
    const route = vpsVaultRequestRoute({ bots: { ownerBotForSession: lookups } } as never as Context, requests)
    expect(route.path).toBe('/api/bot-vault-request')
    expect(route.methods).toEqual(['GET'])
    expect(route.requestBody).toBe('buffered')
    const empty = await route.fetch(new Request('http://127.0.0.1/api/bot-vault-request'))
    expect(await empty.json()).toEqual({ request: null })
    expect(empty.headers.get('cache-control')).toBe('no-store')
    const duplicate = await route.fetch(new Request('http://127.0.0.1/api/bot-vault-request?sessionId=' + session + '&sessionId=' + session))
    expect(await duplicate.json()).toEqual({ request: null })
    const extra = await route.fetch(new Request('http://127.0.0.1/api/bot-vault-request?sessionId=' + session + '&other=1'))
    expect(await extra.json()).toEqual({ request: null })
    const invalid = await route.fetch(new Request('http://127.0.0.1/api/bot-vault-request?sessionId=%00'))
    expect(await invalid.json()).toEqual({ request: null })
    expect(lookups).not.toHaveBeenCalled()

    const controller = new AbortController()
    const pending = requests.request(bot, session, credential, controller.signal)
    await expect.poll(() => requests.current(session)).toMatchObject({ ...credential, state: 'pending' })
    const active = await route.fetch(new Request('http://127.0.0.1/api/bot-vault-request?sessionId=' + session))
    expect(await active.json()).toMatchObject({ request: { ...credential, state: 'pending' } })
    const inactive = await route.fetch(new Request('http://127.0.0.1/api/bot-vault-request?sessionId=' + other))
    expect(await inactive.json()).toEqual({ request: null })
    controller.abort()
    await expect(pending).resolves.toEqual({ state: 'cancelled' })
    await requests.dispose()
  })
})

unixTest('mounts the owner tool, metadata route, and index marker with exact turn authority', async () => {
  let result: 'saved' | 'cancelled' = 'saved'
  await withBroker(() => ({ state: result }), async (socketPath) => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const routes: unknown[] = []
    const register = vi.fn((route: unknown) => {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    })
    const bots = {
      ownerBotForSession: vi.fn(async (id: string) => {
        if (id === session) return { id: bot, sessionId: session, state: 'active' }
        if (id === other) return { id: 'bot-other', sessionId: other, state: 'active' }
        return undefined
      }),
      isDirectOwnerTurn: vi.fn(async () => true),
    }
    ctx.provide('bots', bots as never)
    ctx.provide('connection', { fetch: { register } } as never)
    mountVpsVaultRequests(ctx, { socketPath, grants: [{ bot, ...credential }] })
    await new Promise<void>(resolve => setImmediate(resolve))
    const injections: Array<{ readonly name: string; readonly value: boolean }> = []
    ctx.emit('webserver/index-inject', injections as never)
    expect(injections).toContainEqual({ kind: 'global', name: '__YH_BOT_VAULT_REQUESTS__', value: true })
    expect(injections).not.toContainEqual({ kind: 'global', name: '__YH_BOT_SHARED_VAULT_REQUESTS__', value: true })
    expect(register).toHaveBeenCalledOnce()

    const agent = { id: session, ctx } as never
    await ctx.serial('agent/created', { agent, source: 'resume' })
    await ctx.serial('agent/created', { agent: { id: other, ctx } as never, source: 'resume' })
    await ctx.serial('agent/created', { agent: { id: 'unknown-session', ctx } as never, source: 'resume' })
    const definition = ctx.tools.get('request_vps_secret')
    expect(definition).toBeDefined()
    expect(definition?.output.render({}, { credentials: [] })).toEqual([{ type: 'text', text: 'This Bot has no VPS Vault grants.' }])
    expect(definition?.output.render({}, { credentials: [credential] })).toEqual([{
      type: 'text', text: 'Allowed service and key pairs:\n' + credential.unit + ' / ' + credential.name,
    }])
    expect(definition?.output.render({}, { state: 'saved' })).toEqual([{
      type: 'text', text: 'The key is saved in the VPS Vault. The service loads it on its next start.',
    }])
    expect(definition?.output.render({}, { state: 'cancelled' })).toEqual([{
      type: 'text', text: 'The owner did not save a key through this request.',
    }])
    const call = (arguments_: Record<string, unknown>, target = agent) => ctx.tools.execute({
      name: 'request_vps_secret', callId: ToolCallId('vault-mount-fixture'), arguments: arguments_, agent: target,
      signal: new AbortController().signal,
    })
    bots.isDirectOwnerTurn.mockResolvedValueOnce(false)
    await expect(call({ unit: credential.unit, name: credential.name })).resolves.toMatchObject({ isError: true })
    await expect(call({})).resolves.toMatchObject({ isError: true })
    await expect(call({ unit: credential.unit, name: credential.name })).resolves.toMatchObject({ isError: false })
    result = 'cancelled'
    await expect(call({ unit: credential.unit, name: credential.name })).resolves.toMatchObject({ isError: false })
    const route = routes[0] as { fetch(request: Request): Promise<Response> }
    const metadata = await route.fetch(new Request('http://127.0.0.1/api/bot-vault-request?sessionId=' + session))
    expect(await metadata.json()).toMatchObject({ request: { ...credential, state: 'cancelled' } })
    const idle = await route.fetch(new Request('http://127.0.0.1/api/bot-vault-request?sessionId=' + other))
    expect(await idle.json()).toEqual({ request: null })
    await ctx.fiber.dispose()
    expect(routes).toEqual([])
  })
})

unixTest('uses a broker-managed custom socket for direct discovery without shared scope', async () => {
  await withBroker(command => command.action === 'list' ? { credentials: [] } : { state: 'saved' }, async (socketPath) => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const bots = {
      ownerBotForSession: vi.fn(async () => ({ id: bot, sessionId: session, state: 'active' })),
      isDirectOwnerTurn: vi.fn(async () => true),
    }
    ctx.provide('bots', bots as never)
    ctx.provide('connection', { fetch: { register: vi.fn(() => () => {}) } } as never)
    mountVpsVaultRequests(ctx, { socketPath, sharedRequests: false })
    await new Promise<void>(resolve => setImmediate(resolve))
    const agent = { id: session, ctx } as never
    await ctx.serial('agent/created', { agent, source: 'resume' })
    const call = (arguments_: Record<string, unknown>) => ctx.tools.execute({
      name: 'request_vps_secret', callId: ToolCallId('vault-managed-fixture'), arguments: arguments_, agent,
      signal: new AbortController().signal,
    })
    await expect(call({})).resolves.toMatchObject({ isError: false })
    await expect(call({ unit: credential.unit })).resolves.toMatchObject({ isError: true })
    await ctx.fiber.dispose()
  })
})

unixTest('publishes the shared Vault provider without admitting a different shared Agent', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('bots', {} as never)
  ctx.provide('connection', { fetch: { register: vi.fn(() => () => {}) } } as never)
  mountVpsVaultRequests(ctx, { socketPath: VPS_VAULT_REQUEST_SOCKET })
  const injections: unknown[] = []
  ctx.emit('webserver/index-inject', injections as never)
  expect(injections).toEqual([
    { kind: 'global', name: '__YH_BOT_VAULT_REQUESTS__', value: true },
    { kind: 'global', name: '__YH_BOT_SHARED_VAULT_REQUESTS__', value: true },
  ])
  const agent = { id: 'shared-agent', ctx } as never
  const otherAgent = { id: 'other-agent', ctx } as never
  const provider = ctx.botSharedVaultRequests
  expect(provider).toBeDefined()
  const tool = provider?.toolForSession(ctx, agent, BotId(bot), session, async () => true)
  expect(tool).toBeDefined()
  if (tool === undefined) throw new Error('shared Vault tool was not installed')
  ctx.tools.register(tool)
  const result = await ctx.tools.execute({
    name: 'request_vps_secret', callId: ToolCallId('shared-vault-fixture'), arguments: {},
    agent: otherAgent, signal: new AbortController().signal,
  })
  expect(result.isError).toBe(true)
  expect(result.content.some(block => block.type === 'text' && block.text.includes('could not confirm'))).toBe(true)
  await ctx.fiber.dispose()
})

unixTest('sends only the private browser request coordinates and accepts only a fixed sign-in result', async () => {
  const id = 'a'.repeat(32)
  let response: object | string = { state: 'submitted' }
  await withBroker(() => response, async (path, calls) => {
    const signal = new AbortController().signal
    const submit = () => submitAutomaticVpsLogin(path, bot, session, id, signal)
    await expect(submit()).resolves.toBe('submitted')
    expect(calls).toEqual([{ action: 'automatic-login', bot, session, id }])
    response = { state: 'approval-required' }
    await expect(submit()).resolves.toBe('approval-required')
    response = { state: 'submitted', value: 'fixture' }
    await expect(submit()).resolves.toBe('unavailable')
    response = 'x'.repeat(129)
    await expect(submit()).resolves.toBe('unavailable')
  })
})

unixTest('uses the Vault’s latest grant for a Bot without recreating the request registry', async () => {
  let allowed = false
  await withBroker((request) => {
    if (request.action === 'list') return { credentials: allowed && request.bot === bot ? [credential] : [] }
    return { state: request.bot === bot && allowed ? 'saved' : 'cancelled' }
  }, async (socketPath, calls) => {
    const requests = new VpsVaultRequests({ socketPath })
    const signal = new AbortController().signal
    await expect(requests.discover(bot, signal)).resolves.toEqual([])
    allowed = true
    await expect(requests.discover(bot, signal)).resolves.toEqual([credential])
    await expect(requests.discover('bot-other', signal)).resolves.toEqual([])
    await expect(requests.request(bot, session, credential, signal)).resolves.toEqual({ state: 'saved' })
    expect(calls.at(-1)).toMatchObject({ action: 'create', bot, ...credential })
    allowed = false
    await expect(requests.discover(bot, signal)).resolves.toEqual([])
    await requests.dispose()
  })
})

unixTest('rejects unexpected fields in the Vault’s credential list', async () => {
  await withBroker(() => ({ credentials: [{ ...credential, value: 'synthetic key' }] }), async (socketPath) => {
    const requests = new VpsVaultRequests({ socketPath })
    await expect(requests.discover(bot, new AbortController().signal)).rejects.toThrow('could not confirm')
    await requests.dispose()
  })
})

unixTest('rejects malformed credential lists at every durable-field check', async () => {
  const replies: Array<object | string> = [
    'null',
    '[]',
    JSON.stringify({ credentials: null }),
    JSON.stringify({ credentials: [null] }),
    JSON.stringify({ credentials: [{ unit: credential.unit }] }),
    JSON.stringify({ credentials: [{ unit: 'invalid', name: credential.name }] }),
    JSON.stringify({ credentials: [{ unit: 'worker@.service', name: credential.name }] }),
    JSON.stringify({ credentials: [{ unit: credential.unit, name: 'BAD!' }] }),
    JSON.stringify({ credentials: Array.from({ length: 65 }, () => credential) }),
    '{',
  ]
  for (const reply of replies) {
    await withBroker(() => reply, async (socketPath) => {
      const requests = new VpsVaultRequests({ socketPath })
      await expect(requests.discover(bot, new AbortController().signal)).rejects.toThrow('could not confirm')
      await requests.dispose()
    })
  }
})

unixTest('maps every automatic-login state and transport failure to a safe result', async () => {
  let response: object | string = { state: 'needs-owner' }
  await withBroker(() => response, async (path) => {
    const signal = new AbortController().signal
    await expect(submitAutomaticVpsLogin(path, bot, session, 'a'.repeat(32), signal)).resolves.toBe('needs-owner')
    response = { state: 'unavailable' }
    await expect(submitAutomaticVpsLogin(path, bot, session, 'a'.repeat(32), signal)).resolves.toBe('unavailable')
    response = { state: 'unknown' }
    await expect(submitAutomaticVpsLogin(path, bot, session, 'a'.repeat(32), signal)).resolves.toBe('unavailable')
    response = '{'
    await expect(submitAutomaticVpsLogin(path, bot, session, 'a'.repeat(32), signal)).resolves.toBe('unavailable')
  })
  await expect(submitAutomaticVpsLogin('/run/no-such-yh-vault.sock', bot, session, 'a'.repeat(32), new AbortController().signal))
    .resolves.toBe('unavailable')
  const controller = new AbortController()
  controller.abort()
  await expect(submitAutomaticVpsLogin('/run/no-such-yh-vault.sock', bot, session, 'a'.repeat(32), controller.signal))
    .resolves.toBe('unavailable')
})

unixTest('discards a response that arrives after an exchange was cancelled', async () => {
  const root = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'yh-vault-abort-'))
  const path = join(root, 'r')
  const controller = new AbortController()
  const server = createServer((socket) => {
    socket.once('error', () => {})
    socket.once('data', () => {
      controller.abort()
      socket.end(JSON.stringify({ state: 'submitted' }))
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, resolve)
    })
    await expect(submitAutomaticVpsLogin(path, bot, session, 'a'.repeat(32), controller.signal)).resolves.toBe('unavailable')
  } finally {
    try {
      if (server.listening) await new Promise<void>((resolve) => {
        server.close(() => { resolve() })
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

unixTest('ignores a clean socket end after a failed exchange', async () => {
  const originalDestroyMethod = Reflect.get(Socket.prototype, 'destroy')
  const originalDestroy = (socket: Socket, error?: Error): Socket => {
    Reflect.apply(originalDestroyMethod, socket, error === undefined ? [] : [error])
    return socket
  }
  const destroy = vi.spyOn(Socket.prototype, 'destroy').mockImplementation(function (this: Socket, error?: Error) {
    this.emit('end')
    return originalDestroy(this, error)
  })
  try {
    const root = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'yh-vault-failed-end-'))
    const path = join(root, 'r')
    const controller = new AbortController()
    const server = createServer((socket) => {
      socket.once('error', () => {})
      socket.once('data', () => {
        controller.abort()
        socket.end(JSON.stringify({ state: 'submitted' }))
      })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(path, resolve)
      })
      await expect(submitAutomaticVpsLogin(path, bot, session, 'a'.repeat(32), controller.signal)).resolves.toBe('unavailable')
    } finally {
      try {
        if (server.listening) await new Promise<void>((resolve) => {
          server.close(() => { resolve() })
        })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  } finally {
    destroy.mockRestore()
  }
})

unixTest('shows the pending request in its owning Session and returns only the owner’s receipt', async () => {
  let saved = false
  await withBroker(({ action }) => ({ state: action === 'status' && saved ? 'saved' : 'pending' }), async (socketPath, calls) => {
    const requests = new VpsVaultRequests({ socketPath, grants: [{ bot, ...credential }] })
    const controller = new AbortController()
    const result = requests.request(bot, session, credential, controller.signal)
    try {
      await expect.poll(() => requests.current(session)).toMatchObject({ ...credential, state: 'pending' })
      expect(requests.current(other)).toBeUndefined()
      expect(requests.current(session)?.id).toMatch(/^[0-9a-f]{32}$/u)
      await expect(requests.request(bot, session, credential, controller.signal)).rejects.toThrow('already pending')
      saved = true
      await expect(result).resolves.toEqual({ state: 'saved' })
      expect(requests.current(session)).toMatchObject({ ...credential, state: 'saved' })
      expect(calls).toEqual([
        { action: 'create', id: requests.current(session)?.id, ...credential },
        { action: 'status', id: requests.current(session)?.id },
      ])
    } finally {
      controller.abort()
      await result.catch(() => undefined)
    }
  })
})

unixTest('rejects an ungranted credential before the broker or the chat sees it', async () => {
  await withBroker(() => ({ state: 'pending' }), async (socketPath, calls) => {
    const requests = new VpsVaultRequests({ socketPath, grants: [{ bot, ...credential }] })
    await expect(requests.request(bot, session, { ...credential, name: 'OTHER_KEY' }, new AbortController().signal))
      .rejects.toThrow('has no Vault grant')
    expect(requests.current(session)).toBeUndefined()
    expect(calls).toEqual([])
  })
})

unixTest('rejects invalid authority and credential inputs before opening the broker', async () => {
  await withBroker(() => ({ state: 'saved' }), async (socketPath) => {
    const explicit = new VpsVaultRequests({ socketPath, grants: [{ bot, ...credential }] })
    const signal = new AbortController().signal
    await expect(explicit.request('not-a-bot', session, credential, signal)).rejects.toThrow('has no Vault grant')
    await expect(explicit.request(bot, session, { unit: 'invalid', name: credential.name }, signal)).rejects.toThrow('has no Vault grant')
    await expect(explicit.request(bot, session, credential, signal, async () => true)).rejects.toThrow('could not confirm')
    const aborted = new AbortController()
    aborted.abort()
    await expect(explicit.request(bot, session, credential, aborted.signal)).rejects.toThrow()
    await explicit.dispose()

    const managed = new VpsVaultRequests({ socketPath, sharedRequests: false })
    await managed.dispose()
    await expect(managed.discover('not-a-bot', signal)).rejects.toThrow('could not confirm')
    await expect(managed.request(bot, session, credential, signal)).rejects.toThrow()
  })
})

unixTest('publishes immediate saved and cancelled receipts and expires old cards', async () => {
  let next: 'saved' | 'cancelled' = 'saved'
  await withBroker(() => ({ state: next }), async (socketPath) => {
    const requests = new VpsVaultRequests({ socketPath, grants: [{ bot, ...credential }] })
    await expect(requests.request(bot, session, credential, new AbortController().signal)).resolves.toEqual({ state: 'saved' })
    expect(requests.current(session)).toMatchObject({ ...credential, state: 'saved' })
    next = 'cancelled'
    await expect(requests.request(bot, other, credential, new AbortController().signal)).resolves.toEqual({ state: 'cancelled' })
    expect(requests.current(other)).toMatchObject({ ...credential, state: 'cancelled' })
    vi.useFakeTimers()
    try {
      vi.advanceTimersByTime(2 * 60_000 + 1)
      expect(requests.current(session)).toBeUndefined()
      expect(requests.current(other)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
    await requests.dispose()
  })
})

unixTest('withdraws a pending request when the calling turn stops', async () => {
  await withBroker(({ action }) => ({ state: action === 'cancel' ? 'cancelled' : 'pending' }), async (socketPath, calls) => {
    const requests = new VpsVaultRequests({ socketPath, grants: [{ bot, ...credential }] })
    const controller = new AbortController()
    const result = requests.request(bot, session, credential, controller.signal)
    try {
      await expect.poll(() => requests.current(session)?.state).toBe('pending')
      controller.abort()
      await expect(result).resolves.toEqual({ state: 'cancelled' })
      expect(requests.current(session)?.state).toBe('cancelled')
      expect(calls.at(-1)).toEqual({ action: 'cancel', id: requests.current(session)?.id })
    } finally {
      controller.abort()
      await result.catch(() => undefined)
    }
  })
})

unixTest('cancels uncertain non-shared requests and removes unusable receipts', async () => {
  let cancelState: object | string = { state: 'cancelled' }
  await withBroker((command) => {
    if (command.action === 'create') return { state: 'pending' }
    if (command.action === 'status') return { state: 'awaiting-authorization', challenge: 'a'.repeat(32) }
    return cancelState
  }, async (socketPath, calls) => {
    const requests = new VpsVaultRequests({ socketPath, grants: [{ bot, ...credential }] })
    await expect(requests.request(bot, session, credential, new AbortController().signal)).resolves.toEqual({ state: 'cancelled' })
    expect(calls.map(call => call.action)).toEqual(['create', 'status', 'cancel'])
    expect(requests.current(session)?.state).toBe('cancelled')
    cancelState = { state: 'pending' }
    await expect(requests.request(bot, other, credential, new AbortController().signal)).rejects.toThrow('could not confirm')
    expect(requests.current(other)).toBeUndefined()
    cancelState = '{'
    await expect(requests.request(bot, session, credential, new AbortController().signal)).rejects.toThrow('could not confirm')
    expect(requests.current(session)).toBeUndefined()
    await requests.dispose()
  })
}, 15_000)

unixTest('cancels a create response that is not a receipt state', async () => {
  let createReply: object | string = 'null'
  await withBroker(command => command.action === 'cancel' ? { state: 'cancelled' } : createReply, async (socketPath, calls) => {
    const requests = new VpsVaultRequests({ socketPath, grants: [{ bot, ...credential }] })
    await expect(requests.request(bot, session, credential, new AbortController().signal)).resolves.toEqual({ state: 'cancelled' })
    createReply = { state: 'awaiting-authorization', challenge: 'a'.repeat(32) }
    await expect(requests.request(bot, other, credential, new AbortController().signal)).resolves.toEqual({ state: 'cancelled' })
    createReply = { state: 'awaiting-authorization', challenge: 'bad' }
    await expect(requests.request(bot, SessionId('bot-session-invalid-state'), credential, new AbortController().signal))
      .resolves.toEqual({ state: 'cancelled' })
    expect(calls.map(call => call.action)).toEqual(['create', 'cancel', 'create', 'cancel', 'create', 'cancel'])
    await requests.dispose()
  })
})

unixTest('covers shared admission failures before and after the broker exchange', async () => {
  await withBroker((command) => {
    if (command.action === 'list') return { credentials: [] }
    if (command.action === 'create') return { state: 'saved' }
    return { state: 'cancelled' }
  }, async (socketPath, calls) => {
    const requests = new VpsVaultRequests({ socketPath, sharedRequests: true })
    const signal = new AbortController().signal
    await expect(requests.discover(bot, signal, async () => true)).resolves.toEqual([])
    let discoverChecks = 0
    await expect(requests.discover(bot, signal, async () => {
      discoverChecks++
      return discoverChecks === 1
    })).rejects.toThrow('could not confirm')
    await expect(requests.discover(bot, signal, async () => { throw new Error('fixture admission') })).rejects.toThrow('fixture admission')
    let checks = 0
    const revokedAfterCreate = async (_signal: AbortSignal, start?: () => void) => {
      checks++
      if (checks === 1) {
        start?.()
        return true
      }
      return false
    }
    await expect(requests.request(bot, session, credential, signal, revokedAfterCreate)).rejects.toThrow('could not confirm')
    expect(requests.current(session)).toMatchObject({ ...credential, state: 'saved', scope: 'shared' })
    expect(calls).toHaveLength(3)
    expect(calls[0]).toEqual({ action: 'list', bot, scope: 'shared' })
    expect(calls[1]).toEqual({ action: 'list', bot, scope: 'shared' })
    expect(calls[2]).toMatchObject({ action: 'create', unit: credential.unit, name: credential.name, bot, scope: 'shared' })
    expect(typeof calls[2]?.id).toBe('string')
    await requests.dispose()
  })
})

unixTest('withdraws a shared challenge when its authorization result is not pending', async () => {
  let failCreate = false
  await withBroker((command) => {
    if (command.action === 'create') return failCreate ? '{' : { state: 'pending' }
    if (command.action === 'status') return { state: 'awaiting-authorization', challenge: 'b'.repeat(32) }
    if (command.action === 'authorize') return { state: 'saved' }
    return { state: 'cancelled' }
  }, async (socketPath, calls) => {
    const requests = new VpsVaultRequests({ socketPath, sharedRequests: true })
    const signal = new AbortController().signal
    const authorize = async (_signal: AbortSignal, start?: () => void) => {
      if (start !== undefined) start()
      return true
    }
    await expect(requests.request(bot, session, credential, signal, authorize)).resolves.toEqual({ state: 'cancelled' })
    expect(requests.current(session)?.state).toBe('cancelled')
    expect(calls.map(call => call.action)).toEqual(['create', 'status', 'authorize', 'cancel'])

    const noStart = async () => true
    await expect(requests.request(bot, other, credential, signal, noStart)).resolves.toEqual({ state: 'cancelled' })
    expect(requests.current(other)?.state).toBe('cancelled')
    let earlyChecks = 0
    const revokedBeforeStatus = async (_signal: AbortSignal, start?: () => void) => {
      earlyChecks++
      if (earlyChecks === 1) {
        start?.()
        return true
      }
      return false
    }
    await expect(requests.request(bot, other, credential, signal, revokedBeforeStatus)).rejects.toThrow('could not confirm')
    failCreate = true
    await expect(requests.request(bot, other, credential, signal, authorize)).resolves.toEqual({ state: 'cancelled' })
    await requests.dispose()
  })
})

unixTest('caps pending requests and evicts only non-pending receipts', async () => {
  await withBroker(command => command.action === 'cancel' ? { state: 'cancelled' } : { state: 'pending' }, async (socketPath) => {
    const requests = new VpsVaultRequests({ socketPath, grants: [{ bot, ...credential }] })
    const pendingSessions = Array.from({ length: 64 }, (_, index) => SessionId(`bot-session-pending-${index}`))
    const signal = new AbortController().signal
    const flights = pendingSessions.map(id => requests.request(bot, id, credential, signal))
    await expect.poll(() => pendingSessions.filter(id => requests.current(id)?.state === 'pending')).toHaveLength(64)
    await expect(requests.request(bot, SessionId('bot-session-overflow'), credential, signal)).rejects.toThrow('could not confirm')
    await requests.dispose()
    await Promise.all(flights)
  })
}, 15_000)

unixTest('keeps a pending card while evicting an older completed receipt', async () => {
  let firstId: string | undefined
  await withBroker((command) => {
    if (command.action === 'create') {
      if (firstId === undefined) {
        firstId = String(command.id)
        return { state: 'pending' }
      }
      return { state: 'saved' }
    }
    if (command.action === 'cancel') return { state: 'cancelled' }
    return { state: 'pending' }
  }, async (socketPath) => {
    const requests = new VpsVaultRequests({ socketPath, grants: [{ bot, ...credential }] })
    const pendingSession = SessionId('bot-session-card-pending')
    const controller = new AbortController()
    const pending = requests.request(bot, pendingSession, credential, controller.signal)
    await expect.poll(() => requests.current(pendingSession)?.state).toBe('pending')
    const completedSessions = Array.from({ length: 63 }, (_, index) => SessionId(`bot-session-completed-${index}`))
    for (const id of completedSessions) {
      await expect(requests.request(bot, id, credential, new AbortController().signal)).resolves.toEqual({ state: 'saved' })
    }
    const newest = SessionId('bot-session-completed-new')
    await expect(requests.request(bot, newest, credential, new AbortController().signal)).resolves.toEqual({ state: 'saved' })
    expect(requests.current(pendingSession)?.state).toBe('pending')
    expect(requests.current(completedSessions[0]!)).toBeUndefined()
    expect(requests.current(newest)?.state).toBe('saved')
    controller.abort()
    await expect(pending).resolves.toEqual({ state: 'cancelled' })
    await requests.dispose()
  })
}, 15_000)

unixTest('rejects a broker response with trailing bytes and withdraws the uncertain request', async () => {
  await withBroker(({ action }) => action === 'cancel' ? { state: 'cancelled' }
    : JSON.stringify({ state: 'saved' }) + ' '.repeat(128), async (socketPath, calls) => {
    const requests = new VpsVaultRequests({ socketPath, grants: [{ bot, ...credential }] })
    await expect(requests.request(bot, session, credential, new AbortController().signal))
      .resolves.toEqual({ state: 'cancelled' })
    expect(requests.current(session)?.state).toBe('cancelled')
    expect(calls.map(call => call.action)).toEqual(['create', 'cancel'])
  })
})

unixTest('discovers only shared grants for an admitted collaborator', async () => {
  await withBroker(request => ({ credentials: request.scope === 'shared' ? [credential] : [] }), async (socketPath, calls) => {
    const requests = new VpsVaultRequests({ socketPath, sharedRequests: true })
    const signal = new AbortController().signal
    const authorize = async (_signal: AbortSignal, start?: () => void) => { start?.(); return true }
    try {
      await expect(requests.discover(bot, signal, authorize)).resolves.toEqual([credential])
      await expect(requests.discover(bot, signal, async () => false)).rejects.toThrow('could not confirm')
      expect(calls).toEqual([{ action: 'list', bot, scope: 'shared' }])
    } finally {
      await requests.dispose()
    }
  })
})

unixTest.each([false, true])('checks live admission when a shared owner enters a key (revoked: %s)', async (revocation) => {
  let revoked = false
  let approved = false
  const challenge = 'a'.repeat(32)
  await withBroker((command) => {
    if (command.action === 'cancel') return { state: 'cancelled' }
    if (command.action === 'authorize') {
      expect(command.challenge).toBe(challenge)
      approved = true
      return { state: 'pending' }
    }
    if (command.action === 'status') {
      if (approved) return { state: 'saved' }
      revoked = revocation
      return { state: 'awaiting-authorization', challenge }
    }
    return { state: 'pending' }
  }, async (socketPath, calls) => {
    const requests = new VpsVaultRequests({ socketPath, sharedRequests: true })
    const signal = new AbortController().signal
    const authorize = async (_signal: AbortSignal, start?: () => void) => {
      if (revoked) return false
      start?.()
      return true
    }
    const result = requests.request(bot, session, credential, signal, authorize)
    const outcome = revocation ? expect(result).rejects.toThrow('could not confirm')
      : expect(result).resolves.toEqual({ state: 'saved' })
    try {
      await expect.poll(() => requests.current(session)).toMatchObject({ ...credential, state: 'pending', scope: 'shared' })
      expect(requests.current(other)).toBeUndefined()
      expect(JSON.stringify(requests.current(session))).not.toContain(challenge)
      await outcome
      expect(approved).toBe(!revocation)
      expect(requests.current(session)?.state).toBe(revocation ? 'cancelled' : 'saved')
      expect(calls.map(call => call.action)).toEqual(revocation
        ? ['create', 'status', 'cancel'] : ['create', 'status', 'authorize', 'status'])
      expect(calls.every(call => call.bot === bot && call.scope === 'shared' && !Object.hasOwn(call, 'value'))).toBe(true)
    } finally {
      await requests.dispose()
    }
  })
}, 10_000)
