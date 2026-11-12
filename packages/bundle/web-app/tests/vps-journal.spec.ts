import { createServer, type Server, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Agent } from '@yharness/agent'
import { Context } from '@yharness/cordis'
import { ToolCallId } from '@yharness/llm'
import SystemPrompt from '@yharness/system-prompt'
import ToolRuntime from '@yharness/tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VpsJournal, registerVpsJournalTool } from '../src/vps-journal.ts'

const temporaryRoots: string[] = []

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function socketPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'yh-vps-journal-'))
  temporaryRoots.push(root)
  return join(root, 'j')
}

async function listen(server: Server, path: string): Promise<void> {
  server.listen(path)
  await once(server, 'listening')
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  server.close()
  await once(server, 'close')
}

function observeConnection(server: Server): { connected: Promise<void>; closed: Promise<void> } {
  let resolveConnected!: () => void
  let resolveClosed!: () => void
  const connected = new Promise<void>((resolve) => { resolveConnected = resolve })
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve })
  server.once('connection', (socket: Socket) => {
    resolveConnected()
    socket.once('close', resolveClosed)
  })
  return { connected, closed }
}

function snapshotFrame(recovery: unknown[]): string {
  return JSON.stringify({ version: 1, generatedAt: 'now', recovery, primaryAudit: [] })
}

function nestedObjects(count: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true }
  for (let index = 0; index < count; index += 1) value = { next: value }
  return value
}

function objectWithKeys(count: number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`key-${index}`, index]))
}

describe('VPS Bot journal', () => {
  it('reads one bounded filtered response without sending bytes', async () => {
    const path = await socketPath()
    const bot = randomUUID()
    let receivedBytes = false
    const server = createServer((socket) => {
      socket.on('data', () => { receivedBytes = true })
      socket.end(JSON.stringify({
        version: 1,
        generatedAt: '2026-11-12T00:00:00.000Z',
        recovery: [{ id: 'recovery-entry', detail: { code: 17, tags: ['safe'], enabled: true, note: null } }],
        primaryAudit: [{ action: 'read', outcome: 'ok' }],
        unexposed: 'not retained',
      }))
    })
    await listen(server, path)
    try {
      const journal = new VpsJournal({ socketPath: path, bots: [bot] })
      await expect(journal.read(bot, new AbortController().signal)).resolves.toEqual({
        version: 1,
        generatedAt: '2026-11-12T00:00:00.000Z',
        recovery: [{ id: 'recovery-entry', detail: { code: 17, tags: ['safe'], enabled: true, note: null } }],
        primaryAudit: [{ action: 'read', outcome: 'ok' }],
      })
      expect(receivedBytes).toBe(false)
    } finally {
      await close(server)
    }
  })

  it('rejects a response over the byte bound and tears down its client socket', async () => {
    const path = await socketPath()
    const bot = randomUUID()
    const payload = JSON.stringify({ version: 1, generatedAt: 'now', recovery: [], primaryAudit: [], note: 'bounded' })
    const server = createServer((socket) => { socket.write(payload) })
    const signals = observeConnection(server)
    await listen(server, path)
    try {
      const journal = new VpsJournal({
        socketPath: path, bots: [bot], maxBytes: Buffer.byteLength(payload, 'utf8') - 1,
      })
      await expect(journal.read(bot, new AbortController().signal)).rejects.toThrow('response is invalid')
      await signals.closed
    } finally {
      await close(server)
    }
  })

  it('rejects a response with too many entries under the configured bound', async () => {
    const path = await socketPath()
    const bot = randomUUID()
    const server = createServer((socket) => {
      socket.end(JSON.stringify({
        version: 1, generatedAt: 'now', recovery: [{ id: 1 }, { id: 2 }], primaryAudit: [],
      }))
    })
    await listen(server, path)
    try {
      const journal = new VpsJournal({ socketPath: path, bots: [bot], maxEntries: 1 })
      await expect(journal.read(bot, new AbortController().signal)).rejects.toThrow('response is invalid')
    } finally {
      await close(server)
    }
  })

  it('cancels an in-flight read and waits for the client socket to close', async () => {
    const path = await socketPath()
    const bot = randomUUID()
    const server = createServer(() => {})
    const signals = observeConnection(server)
    await listen(server, path)
    try {
      const journal = new VpsJournal({ socketPath: path, bots: [bot] })
      const controller = new AbortController()
      const pending = journal.read(bot, controller.signal)
      await signals.connected
      controller.abort()
      await expect(pending).rejects.toThrow('request was cancelled')
      await signals.closed
    } finally {
      await close(server)
    }
  })

  it('rejects empty socket replies and validates private owner bounds', async () => {
    const path = await socketPath()
    const bot = randomUUID()
    const server = createServer((socket) => { socket.end() })
    await listen(server, path)
    try {
      expect(() => new VpsJournal({ socketPath: 'relative.sock', bots: [bot] })).toThrow('socketPath')
      expect(() => new VpsJournal({ socketPath: path + '\u0000', bots: [bot] })).toThrow('socketPath')
      expect(() => new VpsJournal({ socketPath: path, bots: [] })).toThrow('at least one')
      expect(() => new VpsJournal({ socketPath: path, bots: [''] })).toThrow('at least one')
      expect(() => new VpsJournal({ socketPath: path, bots: [bot, bot] })).toThrow('unique')
      expect(() => new VpsJournal({ socketPath: path, bots: [bot], timeoutMs: 0 })).toThrow('timeoutMs')
      expect(() => new VpsJournal({ socketPath: path, bots: [bot], maxBytes: 4 * 1024 * 1024 + 1 })).toThrow('maxBytes')
      expect(() => new VpsJournal({ socketPath: path, bots: [bot], maxEntries: 257 })).toThrow('maxEntries')

      const journal = new VpsJournal({ socketPath: path, bots: [bot] })
      await expect(journal.read(bot, new AbortController().signal)).rejects.toThrow('unavailable')
    } finally {
      await close(server)
    }
  })

  it('registers the exact tool only for an authorized Bot', async () => {
    const path = await socketPath()
    const bot = randomUUID()
    const ownerSessionId = randomUUID()
    const otherBot = randomUUID()
    const server = createServer((socket) => {
      socket.end(JSON.stringify({ version: 1, generatedAt: 'now', recovery: [], primaryAudit: [] }))
    })
    await listen(server, path)
    const ctx = new Context()
    const denied = new Context()
    let tools!: typeof ctx.tools
    try {
      await ctx.plugin(SystemPrompt)
      await denied.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await denied.plugin(ToolRuntime)
      tools = ctx.tools
      const journal = new VpsJournal({ socketPath: path, bots: [bot] })
      registerVpsJournalTool(ctx, bot, ownerSessionId, journal)
      registerVpsJournalTool(denied, otherBot, ownerSessionId, journal)
      expect(ctx.tools.get('vps_service_journal')).toBeDefined()
      expect(denied.tools.get('vps_service_journal')).toBeUndefined()
      expect(ctx.tools.get('vps_service_journal')?.parameters).toEqual({
        type: 'object', properties: {}, additionalProperties: false,
      })
      const owner = { id: ownerSessionId, ctx } as Agent
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(randomUUID()),
        name: 'vps_service_journal',
        arguments: {},
        agent: owner,
      })
      expect(result.isError).toBe(false)
      expect(result.content).toContainEqual({ type: 'text', text: JSON.stringify({
        version: 1, generatedAt: 'now', recovery: [], primaryAudit: [],
      }) })
      const unexpected = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(randomUUID()),
        name: 'vps_service_journal',
        arguments: { unexpected: true },
        agent: owner,
      })
      expect(unexpected.isError).toBe(true)
      expect(unexpected.content).toContainEqual(expect.objectContaining({
        type: 'text', text: expect.stringContaining('additionalProperties: false') as string,
      }))

      const otherSession = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(randomUUID()),
        name: 'vps_service_journal',
        arguments: {},
        agent: { id: randomUUID(), ctx } as Agent,
      })
      expect(otherSession.isError).toBe(true)
      expect(otherSession.content).toContainEqual(expect.objectContaining({
        type: 'text', text: expect.stringContaining('owning Bot Session') as string,
      }))

      const missingSession = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(randomUUID()),
        name: 'vps_service_journal',
        arguments: {},
      })
      expect(missingSession.isError).toBe(true)
      expect(missingSession.content).toContainEqual(expect.objectContaining({
        type: 'text', text: expect.stringContaining('owning Bot Session') as string,
      }))

      const otherContext = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(randomUUID()),
        name: 'vps_service_journal',
        arguments: {},
        agent: { id: ownerSessionId, ctx: new Context() } as Agent,
      })
      expect(otherContext.isError).toBe(true)
      expect(otherContext.content).toContainEqual(expect.objectContaining({
        type: 'text', text: expect.stringContaining('owning Bot Session') as string,
      }))
    } finally {
      await ctx.fiber.dispose()
      await denied.fiber.dispose()
      await close(server)
    }
    expect(tools.get('vps_service_journal')).toBeUndefined()
  })

  it('uses fixed safe failures for authorization, abort, timeout, close, and invalid data', async () => {
    const path = await socketPath()
    const bot = randomUUID()
    const otherBot = randomUUID()
    const journal = new VpsJournal({ socketPath: path, bots: [bot], timeoutMs: 20 })
    await expect(journal.read(otherBot, new AbortController().signal)).rejects.toThrow('not authorized')

    const abortServer = createServer(() => {})
    await listen(abortServer, path)
    try {
      const controller = new AbortController()
      controller.abort(new Error('secret path must not escape'))
      await expect(journal.read(bot, controller.signal)).rejects.toThrow('cancelled')
      await expect(journal.read(bot, controller.signal)).rejects.not.toThrow(path)
    } finally {
      await close(abortServer)
    }

    const timeoutServer = createServer(() => {})
    await listen(timeoutServer, path)
    try {
      await expect(journal.read(bot, new AbortController().signal)).rejects.toThrow('timed out')
    } finally {
      await close(timeoutServer)
    }

    const incrementalServer = createServer((socket) => {
      let heartbeat: ReturnType<typeof setInterval> | undefined
      const stopHeartbeat = (): void => {
        if (heartbeat !== undefined) {
          clearInterval(heartbeat)
          heartbeat = undefined
        }
      }
      socket.once('close', stopHeartbeat)
      socket.once('end', stopHeartbeat)
      socket.on('error', stopHeartbeat)
      socket.write('{"version":1,"generatedAt":"now","recovery":[')
      heartbeat = setInterval(() => {
        if (socket.destroyed || !socket.writable) {
          stopHeartbeat()
          return
        }
        socket.write(' ')
      }, 5)
    })
    const incrementalSignals = observeConnection(incrementalServer)
    await listen(incrementalServer, path)
    try {
      await expect(journal.read(bot, new AbortController().signal)).rejects.toThrow('timed out')
      await incrementalSignals.closed
    } finally {
      await close(incrementalServer)
    }

    const closeServer = createServer((socket) => { socket.destroy() })
    await listen(closeServer, path)
    try {
      await expect(journal.read(bot, new AbortController().signal)).rejects.toThrow('unavailable')
    } finally {
      await close(closeServer)
    }

    const invalidServer = createServer((socket) => { socket.end('{"version":1,"generatedAt":"now","recovery":[],"primaryAudit":"bad"}') })
    await listen(invalidServer, path)
    try {
      await expect(journal.read(bot, new AbortController().signal)).rejects.toThrow('invalid')
    } finally {
      await close(invalidServer)
    }
  })

  it('rejects malformed JSON and invalid snapshot metadata at the socket boundary', async () => {
    const path = await socketPath()
    const bot = randomUUID()
    const frames = [
      'not-json',
      JSON.stringify({ version: -1, generatedAt: 'now', recovery: [], primaryAudit: [] }),
    ]

    for (const frame of frames) {
      const server = createServer((socket) => { socket.end(frame) })
      await listen(server, path)
      try {
        const journal = new VpsJournal({ socketPath: path, bots: [bot] })
        await expect(journal.read(bot, new AbortController().signal)).rejects.toThrow('response is invalid')
      } finally {
        await close(server)
      }
    }

    const missing = new VpsJournal({ socketPath: await socketPath(), bots: [bot] })
    await expect(missing.read(bot, new AbortController().signal)).rejects.toThrow('unavailable')
  })

  it.each([
    {
      name: 'non-finite exponent number',
      frame: '{"version":1,"generatedAt":"now","recovery":[{"value":1e9999}],"primaryAudit":[]}',
    },
    {
      name: 'object depth beyond the limit',
      frame: snapshotFrame([nestedObjects(8)]),
    },
    {
      name: 'nested array over the limit',
      frame: snapshotFrame([{ values: Array.from({ length: 257 }, () => 0) }]),
    },
    {
      name: 'nested string over the byte limit',
      frame: snapshotFrame([{ value: 'x'.repeat(16 * 1024 + 1) }]),
    },
    {
      name: 'invalid child inside a nested array',
      frame: snapshotFrame([{ values: ['x'.repeat(16 * 1024 + 1)] }]),
    },
    {
      name: 'object with too many keys',
      frame: snapshotFrame([objectWithKeys(129)]),
    },
    {
      name: 'object key over the byte limit',
      frame: snapshotFrame([{ ['x'.repeat(16 * 1024 + 1)]: true }]),
    },
    {
      name: 'non-record journal entry',
      frame: snapshotFrame([null]),
    },
  ])('rejects $name before retaining unbounded JSON', async ({ frame }) => {
    const path = await socketPath()
    const bot = randomUUID()
    const server = createServer((socket) => { socket.end(frame) })
    await listen(server, path)
    try {
      const journal = new VpsJournal({
        socketPath: path, bots: [bot], maxBytes: 4 * 1024 * 1024, maxEntries: 256,
      })
      await expect(journal.read(bot, new AbortController().signal)).rejects.toThrow('response is invalid')
    } finally {
      await close(server)
    }
  })

  it('maps a synchronous socket-open failure to the safe unavailable error', async () => {
    const path = await socketPath()
    const bot = randomUUID()
    const createConnectionMock = vi.fn(() => {
      throw new Error('private socket open failed')
    })
    vi.resetModules()
    vi.doMock('node:net', async importOriginal => ({
      ...await importOriginal<typeof import('node:net')>(),
      createConnection: createConnectionMock,
    }))
    try {
      const isolated = await import('../src/vps-journal.ts')
      const journal = new isolated.VpsJournal({ socketPath: path, bots: [bot] })
      await expect(journal.read(bot, new AbortController().signal)).rejects.toThrow('unavailable')
      await expect(journal.read(bot, new AbortController().signal)).rejects.not.toThrow(path)
      expect(createConnectionMock).toHaveBeenCalledWith({ path })
    } finally {
      vi.doUnmock('node:net')
      vi.resetModules()
    }
  })
})
