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
      expect(unexpected.content).toContainEqual(expect.objectContaining({
        type: 'text', text: expect.stringContaining('additionalProperties: false'),
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
        type: 'text', text: expect.stringContaining('owning Bot Session'),
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
        type: 'text', text: expect.stringContaining('owning Bot Session'),
      }))
    } finally {
      await ctx.fiber.dispose()
      await denied.fiber.dispose()
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
      socket.once('close', () => clearInterval(heartbeat))
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
