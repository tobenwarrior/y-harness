import { createServer, type Server } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { SessionId } from '@yharness/session'
import {
  submitAutomaticVpsLogin, VPS_VAULT_REQUEST_SOCKET, VpsVaultRequests, vpsVaultAccessRoute, type VpsVaultRequestsConfig,
} from '../src/vps-vault-requests.ts'

const bot = 'bot-example'
const session = SessionId('bot-session-7e2e3bd7-aec8-4f11-925d-478a83ed004a')
const other = SessionId('bot-session-2d12d9ae-30aa-4465-83ad-2253c62bbb59')
const credential = { unit: 'example-worker.service', name: 'EXAMPLE_API_KEY' }

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
    socket.on('data', (chunk) => { input += chunk })
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

const unixTest = it.skipIf(process.platform === 'win32')

unixTest('sends only the private browser request coordinates and accepts only a fixed sign-in result', async () => {
  const id = 'a'.repeat(32)
  let response: object = { state: 'submitted' }
  await withBroker(() => response, async (path, calls) => {
    const signal = new AbortController().signal
    const submit = () => submitAutomaticVpsLogin(path, bot, session, id, signal)
    await expect(submit()).resolves.toBe('submitted')
    expect(calls).toEqual([{ action: 'automatic-login', bot, session, id }])
    response = { state: 'approval-required' }
    await expect(submit()).resolves.toBe('approval-required')
    response = { state: 'submitted', value: 'fixture' }
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
