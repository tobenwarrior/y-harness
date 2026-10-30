import { Context, Service } from '@yharness/cordis'
import { AttachmentId, type ImageAttachmentRef, type StoredImageAttachment } from '@yharness/attachment'
import type { Agent } from '@yharness/agent'
import { createScope } from '@yharness/scope'
import { Session, SessionId } from '@yharness/session'
import type { UserMessage } from '@yharness/llm'
import Storage from '@yharness/storage'
import { DomainFacility } from '@yharness/storage-domain'
import type { StorageBackend } from '@yharness/storage'
import SystemPrompt, { renderPrompt } from '@yharness/system-prompt'
import ToolRuntime from '@yharness/tools'
import { describe, expect, it, vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import BotService from '../src/index.ts'
import type { BotNativeToolProvider } from '../src/native-tools.ts'
import { BotId } from '../src/types.ts'

async function harness(
  pool = new MemoryMediaPool(),
  create = vi.fn(async (request: { sessionId?: string }) => ({ sessionId: request.sessionId })),
  readImage = vi.fn(async (ref: ImageAttachmentRef): Promise<StoredImageAttachment> => ({
    ref,
    data: Uint8Array.of(1, 2, 3),
  })),
  existingSessionIds: readonly string[] = [],
) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const backend: StorageBackend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => {
      await facility.closeAll()
      unmount()
    }
  })
  const followups = existingSessionIds.map(() => vi.fn<(message: UserMessage) => void>())
  const agents = existingSessionIds.map((sessionId, index) => {
    const followup = followups[index]
    if (followup === undefined) throw new Error('test followup was not created')
    const id = SessionId(sessionId)
    const agent: Agent = {
      id,
      options: {},
      session: Session.create(id),
      inbox: {
        nextTurn: [], nextStep: [], clear() {}, append() {}, prepend() {},
        replace() { return false }, remove() { return false }, splice() { return [] },
      },
      status: 'idle',
      ctx: new Context(),
      send() {},
      followup,
      steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
      inject() {},
      cancel() {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    const scope = createScope(ctx, agent)
    Object.defineProperty(agent, 'ctx', { value: scope.ctx })
    return agent
  })
  ctx.provide('agents', {
    get: (sessionId: SessionId) => agents.find(agent => agent.id === sessionId),
    list: () => [...agents],
  } as never)
  ctx.provide('attachments', { readImage } as never)
  const inspect = vi.fn(async (sessionId: SessionId) => ({
    events: agents.find(agent => agent.id === sessionId)?.session.snapshotEvents() ?? [],
  }))
  const resolveAgent = vi.fn(async (sessionId: SessionId) => {
    const agent = agents.find(candidate => candidate.id === sessionId)
    return agent === undefined ? { error: new Error('session not found') } : { agent }
  })
  const flush = vi.fn(async () => true)
  const sessions = {
    get: (sessionId: SessionId) => agents.find(agent => agent.id === sessionId)?.session,
    flush,
  }
  ctx.provide('sessions', sessions as never)
  ctx.provide('sessionController', { create, inspect, resolveAgent } as never)
  const service = new BotService(ctx)
  await service[Service.init]()
  return { ctx, service, pool, create, readImage, agents, inspect, resolveAgent, flush, followups }
}

async function close(ctx: Context): Promise<void> {
  await ctx.fiber.dispose()
}

describe('durable Bot roster', () => {
  it('mounts native collaboration actions only for Bot-owned Sessions', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const created = await first.service.create({ name: 'Native bridge owner', cwd: '/tmp' })
    await close(first.ctx)

    const h = await harness(pool, undefined, undefined, [String(created.bot.sessionId)])
    try {
      const provider = h.ctx.get('codexDynamicTools') as BotNativeToolProvider | undefined
      expect(provider).toBeDefined()
      const tools = await provider!.resolve({ sessionId: created.bot.sessionId })
      expect(tools.map(tool => tool.name)).toEqual(['list_bots', 'inspect_bot', 'send_bot_message'])
      await expect(provider!.resolve({ sessionId: SessionId('ordinary-session') })).resolves.toEqual([])
    } finally {
      await close(h.ctx)
    }
  })

  it('binds collaboration to a Bot Agent and flushes explicit peer delivery', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const sender = await first.service.create({ name: 'Sender', cwd: '/tmp' })
    const target = await first.service.create({ name: 'Target', cwd: '/tmp' })
    await close(first.ctx)

    const h = await harness(pool, undefined, undefined, [
      String(sender.bot.sessionId), String(target.bot.sessionId),
    ])
    try {
      const senderAgent = h.agents[0]
      const targetAgent = h.agents[1]
      const targetFollowup = h.followups[1]
      if (senderAgent === undefined) throw new Error('sender test Agent was not created')
      if (targetAgent === undefined) throw new Error('target test Agent was not created')
      if (targetFollowup === undefined) throw new Error('target test followup was not created')
      const collaboration = await h.service.collaborationFor(senderAgent)
      expect(collaboration.sender.id).toBe(sender.bot.id)
      await expect(collaboration.send({
        targetBotId: target.bot.id,
        text: 'Please report your status.',
      })).resolves.toMatchObject({
        status: 'accepted',
        sender: { id: sender.bot.id },
        target: { id: target.bot.id },
      })
      expect(targetFollowup).toHaveBeenCalledTimes(1)
      expect(h.resolveAgent).toHaveBeenCalledWith(target.bot.sessionId)
      expect(h.flush).toHaveBeenCalledTimes(1)
    } finally {
      await close(h.ctx)
    }
  })

  it('durably records native collaboration action observations on the Bot Session', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const created = await first.service.create({ name: 'Native owner', cwd: '/tmp' })
    await close(first.ctx)
    const h = await harness(pool, undefined, undefined, [String(created.bot.sessionId)])
    try {
      const agent = h.agents[0]
      if (agent === undefined) throw new Error('native test Agent was not created')
      const provider = h.ctx.get('codexDynamicTools') as BotNativeToolProvider | undefined
      if (provider === undefined) throw new Error('native action provider was not mounted')
      const event = {
        phase: 'settled' as const,
        name: 'list_bots',
        callId: 'call-native',
        threadId: 'thread-native',
        turnId: 'turn-native',
        sessionId: agent.id,
        arguments: {},
        result: { success: true, contentItems: [{ type: 'inputText' as const, text: '[]' }] },
      }
      await provider.observe(event)
      expect(agent.session.snapshotEvents()).toMatchObject([{
        type: 'bot/dynamic-tool', data: event,
      }])
      await expect(provider.replay({ sessionId: agent.id })).resolves.toEqual([event])
      expect(h.flush).toHaveBeenCalledWith(agent.session)
    } finally {
      await close(h.ctx)
    }
  })

  it('creates one real Session mapping, lists it, and renames it', async () => {
    const h = await harness()
    try {
      const created = await h.service.create({
        name: 'Research partner', identity: 'sparkle', accent: 'blue', cwd: '/tmp',
      })
      expect(created.bot.state).toBe('active')
      expect(created.bot.identity).toBe('sparkle')
      expect(created.bot.accent).toBe('blue')
      expect(created.bot.sessionId).toMatch(/^bot-session-/)
      expect(h.create).toHaveBeenCalledWith({
        sessionId: created.bot.sessionId, cwd: '/tmp',
      })

      await expect(h.service.list({})).resolves.toMatchObject({
        bots: [{ id: created.bot.id, sessionId: created.bot.sessionId, availability: 'offline' }],
      })
      await expect(h.service.rename({ botId: created.bot.id, name: 'Research desk' })).resolves.toMatchObject({
        bot: { id: created.bot.id, name: 'Research desk', sessionId: created.bot.sessionId },
      })
    } finally {
      await close(h.ctx)
    }
  })

  it('keeps a provisioning row retryable with the same Session id', async () => {
    const create = vi.fn(async (request: { sessionId?: string }) => {
      if (create.mock.calls.length === 1) throw new Error('model unavailable')
      return { sessionId: request.sessionId }
    })
    const h = await harness(new MemoryMediaPool(), create)
    try {
      const id = BotId('bot-retry')
      const failed = h.service.create({ id, name: 'Retry me', cwd: '/tmp' })
      await expect(failed).rejects.toMatchObject({
        code: 'bot/provisioning-failed',
      })
      const firstSessionId = create.mock.calls[0]?.[0]?.sessionId
      expect(firstSessionId).toMatch(/^bot-session-/)
      await expect(h.service.list({})).resolves.toMatchObject({
        bots: [{ id, state: 'provisioning', sessionId: firstSessionId }],
      })
      const retried = await h.service.create({ id, name: 'Retry me', cwd: '/tmp' })
      expect(retried.bot.state).toBe('active')
      expect(create).toHaveBeenNthCalledWith(2, { sessionId: firstSessionId, cwd: '/tmp' })
    } finally {
      await close(h.ctx)
    }
  })

  it('does not create a Session when the durable row cannot be written', async () => {
    const pool = new MemoryMediaPool()
    pool.failNextWrites = 1
    const h = await harness(pool)
    try {
      await expect(h.service.create({ name: 'No orphan', cwd: '/tmp' })).rejects.toThrow('injected write failure')
      expect(h.create).not.toHaveBeenCalled()
      await expect(h.service.list({})).resolves.toEqual({ bots: [] })
    } finally {
      await close(h.ctx)
    }
  })

  it('reloads the same roster from durable storage without creating another Session', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const created = await first.service.create({ name: 'Persistent', identity: 'goal', accent: 'amber', cwd: '/tmp' })
    await close(first.ctx)

    const second = await harness(pool)
    try {
      await expect(second.service.list({})).resolves.toMatchObject({
        bots: [{ id: created.bot.id, sessionId: created.bot.sessionId, state: 'active' }],
      })
      await expect(second.service.create({
        id: created.bot.id, name: 'Persistent', identity: 'goal', accent: 'amber', cwd: '/tmp',
      })).resolves.toMatchObject({
        bot: { id: created.bot.id, sessionId: created.bot.sessionId, state: 'active' },
      })
      expect(second.create).not.toHaveBeenCalled()
      await expect(second.service.create({
        id: created.bot.id, name: 'Different name', identity: 'goal', accent: 'amber', cwd: '/tmp',
      })).rejects.toMatchObject({ code: 'bot/id-conflict' })
    } finally {
      await close(second.ctx)
    }
  })

  it('teaches an existing Bot Session its current name and refreshes it after rename', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const created = await first.service.create({ name: 'Persistent identity', cwd: '/tmp' })
    await close(first.ctx)

    const second = await harness(pool, undefined, undefined, [String(created.bot.sessionId)])
    try {
      const agent = second.agents[0]
      if (agent === undefined) throw new Error('test agent was not created')
      await second.ctx.serial('agent/created', { agent, source: 'resume' })

      const prompt = async () => renderPrompt(await second.ctx.systemPrompt.assemble({ scope: agent }))
      expect(await prompt()).toContain('Persistent identity')
      await second.service.rename({ botId: created.bot.id, name: 'Renamed identity' })
      expect(await prompt()).toContain('Renamed identity')
      expect(await prompt()).not.toContain('Persistent identity')
    } finally {
      await close(second.ctx)
    }
  })

  it('rejects an active id retry when omitted optional metadata differs', async () => {
    const h = await harness()
    try {
      const id = BotId('bot-metadata-conflict')
      const created = await h.service.create({
        id,
        name: 'Metadata owner',
        description: 'First description',
        identity: 'goal',
        accent: 'amber',
        cwd: '/tmp/first-bot-directory',
        agentPreset: 'first-preset',
      })

      await expect(h.service.create({
        id,
        name: created.bot.name,
        identity: created.bot.identity,
        accent: created.bot.accent,
      })).rejects.toMatchObject({ code: 'bot/id-conflict' })
      expect(h.create).toHaveBeenCalledTimes(1)
    } finally {
      await close(h.ctx)
    }
  })

  it('persists and clears a generated avatar without changing the Bot Session mapping', async () => {
    const h = await harness()
    try {
      const created = await h.service.create({ name: 'Avatar owner', cwd: '/tmp' })
      const avatar: ImageAttachmentRef = {
        attachmentId: AttachmentId(`sha256:${'cd'.repeat(32)}`),
        mediaType: 'image/png',
        bytes: 3,
        width: 64,
        height: 64,
        name: 'avatar.png',
      }
      await expect(h.service.updateAvatar({ botId: created.bot.id, avatar })).resolves.toMatchObject({
        bot: { id: created.bot.id, sessionId: created.bot.sessionId, avatar },
      })
      expect(h.readImage).toHaveBeenCalledWith(avatar)
      await expect(h.service.list({})).resolves.toMatchObject({ bots: [{ id: created.bot.id, avatar }] })
      await expect(h.service.readAvatar({ botId: created.bot.id })).resolves.toEqual({
        avatar,
        data: Buffer.from([1, 2, 3]).toString('base64'),
      })
      await expect(h.service.updateAvatar({ botId: created.bot.id, avatar: null })).resolves.toMatchObject({
        bot: { id: created.bot.id, sessionId: created.bot.sessionId },
      })
      const listed = await h.service.list({})
      expect(listed.bots).toHaveLength(1)
      expect(listed.bots[0]?.id).toBe(created.bot.id)
      expect(listed.bots[0]).not.toHaveProperty('avatar')
      await expect(h.service.readAvatar({ botId: created.bot.id })).rejects.toMatchObject({ code: 'bot/avatar-missing' })
    } finally {
      await close(h.ctx)
    }
  })

  it('rejects malformed or unreadable avatar references without changing the Bot row', async () => {
    const readImage = vi.fn(async (): Promise<StoredImageAttachment> => {
      throw new Error('attachment missing')
    })
    const h = await harness(new MemoryMediaPool(), undefined, readImage)
    try {
      const created = await h.service.create({ name: 'Avatar guard', cwd: '/tmp' })
      const invalid = { attachmentId: 'not-a-digest', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
      await expect(h.service.updateAvatar({ botId: created.bot.id, avatar: invalid as never }))
        .rejects.toMatchObject({ code: 'bot/avatar-invalid', details: { reason: 'invalid-reference' } })
      await expect(h.service.updateAvatar({
        botId: created.bot.id,
        avatar: {
          attachmentId: AttachmentId(`sha256:${'ef'.repeat(32)}`),
          mediaType: 'image/png', bytes: 3, width: 1, height: 1,
        },
      })).rejects.toMatchObject({ code: 'bot/avatar-invalid', details: { reason: 'unreadable' } })
      const listed = await h.service.list({})
      expect(listed.bots).toHaveLength(1)
      expect(listed.bots[0]?.id).toBe(created.bot.id)
      expect(listed.bots[0]).not.toHaveProperty('avatar')
    } finally {
      await close(h.ctx)
    }
  })

  it('updates identity and accent without replacing its Session or generated avatar, emits a change, and reloads', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const avatar: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`),
      mediaType: 'image/png',
      bytes: 3,
      width: 64,
      height: 64,
    }
    let firstClosed = false
    try {
      const created = await first.service.create({ name: 'Appearance owner', cwd: '/tmp' })
      await first.service.updateAvatar({ botId: created.bot.id, avatar })
      const changes: number[] = []
      first.ctx.on('bots/changed', () => { changes.push(changes.length + 1) })

      await expect(first.service.updateAppearance({
        botId: created.bot.id,
        identity: 'browse',
        accent: 'teal',
      })).resolves.toMatchObject({
        bot: {
          id: created.bot.id,
          sessionId: created.bot.sessionId,
          identity: 'browse',
          accent: 'teal',
          avatar,
        },
      })
      expect(changes).toEqual([1])
      expect(first.create).toHaveBeenCalledTimes(1)
      await close(first.ctx)
      firstClosed = true

      const second = await harness(pool)
      try {
        await expect(second.service.list({})).resolves.toMatchObject({
          bots: [{
            id: created.bot.id,
            sessionId: created.bot.sessionId,
            identity: 'browse',
            accent: 'teal',
            avatar,
          }],
        })
        expect(second.create).not.toHaveBeenCalled()
      } finally {
        await close(second.ctx)
      }
    } finally {
      if (!firstClosed) await close(first.ctx)
    }
  })

  it('clears a generated avatar only when updateAppearance explicitly requests it', async () => {
    const h = await harness()
    try {
      const created = await h.service.create({ name: 'Appearance clear', cwd: '/tmp' })
      const avatar: ImageAttachmentRef = {
        attachmentId: AttachmentId(`sha256:${'bc'.repeat(32)}`),
        mediaType: 'image/png',
        bytes: 3,
        width: 64,
        height: 64,
      }
      await h.service.updateAvatar({ botId: created.bot.id, avatar })

      await expect(h.service.updateAppearance({
        botId: created.bot.id,
        identity: 'skill',
        clearAvatar: true,
      })).resolves.toMatchObject({
        bot: {
          id: created.bot.id,
          sessionId: created.bot.sessionId,
          identity: 'skill',
          accent: 'violet',
        },
      })
      const listed = await h.service.list({})
      expect(listed.bots[0]).not.toHaveProperty('avatar')
      await expect(h.service.readAvatar({ botId: created.bot.id })).rejects.toMatchObject({ code: 'bot/avatar-missing' })
      expect(h.create).toHaveBeenCalledTimes(1)
    } finally {
      await close(h.ctx)
    }
  })

  it('rejects invalid appearance fields without changing the Bot row or emitting a change', async () => {
    const h = await harness()
    try {
      const created = await h.service.create({ name: 'Appearance guard', cwd: '/tmp' })
      const changes: number[] = []
      h.ctx.on('bots/changed', () => { changes.push(changes.length + 1) })
      await expect(h.service.updateAppearance({
        botId: created.bot.id,
        identity: 'unknown' as never,
      })).rejects.toMatchObject({ code: 'gateway/bad-request' })
      await expect(h.service.updateAppearance({
        botId: created.bot.id,
        accent: 'unknown' as never,
      })).rejects.toMatchObject({ code: 'gateway/bad-request' })
      await expect(h.service.updateAppearance({
        botId: created.bot.id,
        clearAvatar: 'yes' as never,
      })).rejects.toMatchObject({ code: 'gateway/bad-request' })
      await expect(h.service.updateAppearance({ botId: created.bot.id })).rejects.toMatchObject({ code: 'gateway/bad-request' })

      await expect(h.service.list({})).resolves.toMatchObject({
        bots: [{
          id: created.bot.id,
          sessionId: created.bot.sessionId,
          identity: 'agent',
          accent: 'violet',
        }],
      })
      expect(changes).toEqual([])
      expect(h.create).toHaveBeenCalledTimes(1)
    } finally {
      await close(h.ctx)
    }
  })
})
