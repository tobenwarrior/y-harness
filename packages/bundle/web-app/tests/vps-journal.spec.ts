import { createServer, type Server } from 'node:net'
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
import { afterEach, describe, expect, it } from 'vitest'
import { VpsJournal, registerVpsJournalTool, type VpsJournalConfig, type VpsJournalSnapshot } from '../src/vps-journal.ts'

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

const TEST_BOT = 'fixture-bot'
type JournalBounds = Pick<VpsJournalConfig, 'timeoutMs' | 'maxBytes' | 'maxEntries'>

async function readPayload(serialized: string, bounds: JournalBounds = {}): Promise<VpsJournalSnapshot> {
  const path = await socketPath()
  const server = createServer((socket) => { socket.end(serialized) })
  await listen(server, path)
  try {
    const journal = new VpsJournal({ socketPath: path, bots: [TEST_BOT], ...bounds })
    return await journal.read(TEST_BOT, new AbortController().signal)
  } finally {
    await close(server)
  }
}

describe('VPS Bot journal', () => {
  it('rejects invalid owner configuration and accepts explicit bounds', () => {
    const base = { socketPath: '/tmp/vps-journal.sock', bots: [TEST_BOT] }
    expect(() => new VpsJournal({ ...base, socketPath: 'relative.sock' })).toThrow('socketPath must be absolute')
    expect(() => new VpsJournal({ ...base, socketPath: '/tmp/vps-journal\u0000.sock' })).toThrow('socketPath must be absolute')
    expect(() => new VpsJournal({ ...base, bots: [] })).toThrow('at least one valid Bot id')
    expect(() => new VpsJournal({ ...base, bots: [null as never] })).toThrow('at least one valid Bot id')
    expect(() => new VpsJournal({ ...base, bots: [''] })).toThrow('at least one valid Bot id')
    expect(() => new VpsJournal({ ...base, bots: ['bad\u0000'] })).toThrow('at least one valid Bot id')
    expect(() => new VpsJournal({ ...base, bots: [TEST_BOT, TEST_BOT] })).toThrow('must be unique')

    for (const timeoutMs of [0, 60_001, 1.5]) {
      expect(() => new VpsJournal({ ...base, timeoutMs })).toThrow('timeoutMs is invalid')
    }
    for (const maxBytes of [0, 4 * 1024 * 1024 + 1, 1.5]) {
      expect(() => new VpsJournal({ ...base, maxBytes })).toThrow('maxBytes is invalid')
    }
    for (const maxEntries of [0, 257, 1.5]) {
      expect(() => new VpsJournal({ ...base, maxEntries })).toThrow('maxEntries is invalid')
    }

    const bounded = new VpsJournal({ ...base, timeoutMs: 1, maxBytes: 1, maxEntries: 1 })
    expect(bounded.authorized(TEST_BOT)).toBe(true)
    expect(bounded.authorized('other-bot')).toBe(false)
  })

  it('reads one bounded filtered response without sending bytes', async () => {
    const path = await socketPath()
    const bot = randomUUID()
    let receivedBytes = false
    const server = createServer((socket) => {
      socket.on('data', () => { receivedBytes = true })
      socket.end(JSON.stringify({
        version: 1,
        generatedAt: '2026-11-12T00:00:00.000Z',
        recovery: [{ id: 'recovery-entry', detail: { code: 17, tags: ['safe'] } }],
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
        recovery: [{ id: 'recovery-entry', detail: { code: 17, tags: ['safe'] } }],
        primaryAudit: [{ action: 'read', outcome: 'ok' }],
      })
      expect(receivedBytes).toBe(false)
    } finally {
      await close(server)
    }
  })

  it('retains bounded scalar, array, and nested journal values', async () => {
    await expect(readPayload(JSON.stringify({
      version: 2,
      generatedAt: 'now',
      recovery: [{ empty: null, enabled: true, count: 17, nested: [false, { label: 'safe' }] }],
      primaryAudit: [{ action: 'read', outcome: 'ok' }],
    }))).resolves.toEqual({
      version: 2,
      generatedAt: 'now',
      recovery: [{ empty: null, enabled: true, count: 17, nested: [false, { label: 'safe' }] }],
      primaryAudit: [{ action: 'read', outcome: 'ok' }],
    })
  })

  it('rejects malformed and over-bounded journal responses', async () => {
    const snapshot = { version: 1, generatedAt: 'now', recovery: [], primaryAudit: [] }
    const tooManyKeys = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`key-${index}`, true]))
    const tooManyArray = Array.from({ length: 257 }, () => true)
    const longText = 'x'.repeat(16 * 1024 + 1)
    let deep: Record<string, unknown> = { value: true }
    for (let depth = 0; depth < 8; depth += 1) deep = { next: deep }
    const invalidPayloads: Array<{ readonly serialized: string; readonly bounds?: JournalBounds }> = [
      { serialized: 'not-json' },
      { serialized: JSON.stringify([]) },
      { serialized: JSON.stringify(null) },
      { serialized: JSON.stringify({ ...snapshot, version: 'one' }) },
      { serialized: JSON.stringify({ ...snapshot, version: 1.5 }) },
      { serialized: JSON.stringify({ ...snapshot, version: -1 }) },
      { serialized: JSON.stringify({ ...snapshot, version: 2 ** 31 }) },
      { serialized: JSON.stringify({ ...snapshot, generatedAt: 1 }) },
      { serialized: JSON.stringify({ ...snapshot, generatedAt: longText }) },
      { serialized: JSON.stringify({ ...snapshot, recovery: 'bad' }) },
      { serialized: JSON.stringify({ ...snapshot, recovery: [null] }) },
      { serialized: JSON.stringify({ ...snapshot, recovery: [], primaryAudit: 'bad' }) },
      { serialized: '{"version":1,"generatedAt":"now","recovery":[{"value":1e400}],"primaryAudit":[]}' },
      { serialized: '{"version":1,"generatedAt":"now","recovery":[{"value":[1e400]}],"primaryAudit":[]}' },
      { serialized: JSON.stringify({ ...snapshot, recovery: [{ value: tooManyArray }] }) },
      { serialized: JSON.stringify({ ...snapshot, recovery: [{ value: deep }] }) },
      { serialized: JSON.stringify({ ...snapshot, recovery: [{ value: tooManyKeys }] }) },
      { serialized: JSON.stringify({ ...snapshot, recovery: [{ [longText]: true }] }) },
      { serialized: JSON.stringify({ ...snapshot, recovery: [{ value: longText }] }) },
      { serialized: JSON.stringify({ ...snapshot, recovery: [{}, {}] }), bounds: { maxEntries: 1 } },
    ]
    for (const payload of invalidPayloads) {
      await expect(readPayload(payload.serialized, payload.bounds)).rejects.toThrow('VPS journal response is invalid.')
    }
    await expect(readPayload(JSON.stringify(snapshot), { maxBytes: 8 })).rejects.toThrow('VPS journal response is invalid.')
  })

  it('maps a missing journal socket to a safe unavailable failure', async () => {
    const path = await socketPath()
    const journal = new VpsJournal({ socketPath: path, bots: [TEST_BOT] })
    await expect(journal.read(TEST_BOT, new AbortController().signal)).rejects.toThrow('VPS journal is unavailable.')
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
    try {
      await ctx.plugin(SystemPrompt)
      await denied.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await denied.plugin(ToolRuntime)
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
      expect(unexpected.content.some(block => block.type === 'text'
        && block.text.includes('additionalProperties: false'))).toBe(true)

      const otherSession = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(randomUUID()),
        name: 'vps_service_journal',
        arguments: {},
        agent: { id: randomUUID(), ctx } as Agent,
      })
      expect(otherSession.isError).toBe(true)
      expect(otherSession.content.some(block => block.type === 'text'
        && block.text.includes('owning Bot Session'))).toBe(true)

      const otherContext = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(randomUUID()),
        name: 'vps_service_journal',
        arguments: {},
        agent: { id: ownerSessionId, ctx: new Context() } as Agent,
      })
      expect(otherContext.isError).toBe(true)
      expect(otherContext.content.some(block => block.type === 'text'
        && block.text.includes('owning Bot Session'))).toBe(true)

      const missingAgent = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(randomUUID()),
        name: 'vps_service_journal',
        arguments: {},
      })
      expect(missingAgent.isError).toBe(true)
      expect(missingAgent.content.some(block => block.type === 'text'
        && block.text.includes('owning Bot Session'))).toBe(true)

      const alreadyAborted = new AbortController()
      alreadyAborted.abort()
      const aborted = await ctx.tools.execute({
        signal: alreadyAborted.signal,
        callId: ToolCallId(randomUUID()),
        name: 'vps_service_journal',
        arguments: {},
        agent: owner,
      })
      expect(aborted.isError).toBe(true)
    } finally {
      await ctx.fiber.dispose()
      await denied.fiber.dispose()
      await close(server)
    }
  })

  it('cancels a registered read when its Web lifetime ends and disposes the tool', async () => {
    const path = await socketPath()
    const bot = randomUUID()
    const ownerSessionId = randomUUID()
    const connected = Promise.withResolvers<undefined>()
    const disconnected = Promise.withResolvers<undefined>()
    const server = createServer((socket) => {
      connected.resolve(undefined)
      socket.once('close', () => { disconnected.resolve(undefined) })
    })
    await listen(server, path)
    const ctx = new Context()
    const lifetime = new AbortController()
    let tools: typeof ctx.tools | undefined
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      tools = ctx.tools
      const journal = new VpsJournal({ socketPath: path, bots: [bot] })
      registerVpsJournalTool(ctx, bot, ownerSessionId, journal, ctx, lifetime.signal)
      expect(tools.get('vps_service_journal')).toBeDefined()
      const pending = tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(randomUUID()),
        name: 'vps_service_journal',
        arguments: {},
        agent: { id: ownerSessionId, ctx } as Agent,
      })
      await connected.promise
      lifetime.abort()
      const result = await pending
      expect(result.isError).toBe(true)
      expect(result.content.some(block => block.type === 'text'
        && block.text.includes('cancelled'))).toBe(true)
      await disconnected.promise
    } finally {
      await ctx.fiber.dispose()
      expect(tools?.get('vps_service_journal')).toBeUndefined()
      await close(server)
    }
  })

  it('closes the read-only connection when the calling turn aborts', async () => {
    const path = await socketPath()
    const bot = randomUUID()
    const connected = Promise.withResolvers<undefined>()
    const disconnected = Promise.withResolvers<undefined>()
    const server = createServer((socket) => {
      socket.once('close', () => { disconnected.resolve(undefined) })
      connected.resolve(undefined)
    })
    await listen(server, path)
    const controller = new AbortController()
    try {
      const journal = new VpsJournal({ socketPath: path, bots: [bot] })
      const cancelled = expect(journal.read(bot, controller.signal)).rejects.toThrow('VPS journal request was cancelled.')
      await connected.promise
      controller.abort()
      await cancelled
      await disconnected.promise
    } finally {
      controller.abort()
      await close(server)
    }
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
      socket.write('{"version":1,"generatedAt":"now","recovery":[')
      const heartbeat = setInterval(() => socket.write(' '), 5)
      socket.once('error', (error: NodeJS.ErrnoException) => {
        clearInterval(heartbeat)
        if (error.code !== 'EPIPE' && error.code !== 'ECONNRESET') throw error
      })
      socket.once('close', () => { clearInterval(heartbeat) })
    })
    await listen(incrementalServer, path)
    try {
      await expect(journal.read(bot, new AbortController().signal)).rejects.toThrow('timed out')
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
})
