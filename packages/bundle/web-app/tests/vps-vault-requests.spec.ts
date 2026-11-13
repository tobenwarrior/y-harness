import { createServer, type Server } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { SessionId } from '@yharness/session'
import { VpsVaultRequests } from '../src/vps-vault-requests.ts'

const bot = 'bot-example'
const session = SessionId('bot-session-7e2e3bd7-aec8-4f11-925d-478a83ed004a')
const other = SessionId('bot-session-2d12d9ae-30aa-4465-83ad-2253c62bbb59')
const credential = { unit: 'example-worker.service', name: 'EXAMPLE_API_KEY' }

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
