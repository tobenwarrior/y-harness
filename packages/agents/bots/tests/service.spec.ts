import { Context, Service } from '@yharness/cordis'
import { AttachmentId, type ImageAttachmentRef, type StoredImageAttachment } from '@yharness/attachment'
import type { Agent } from '@yharness/agent'
import { createScope } from '@yharness/scope'
import { Session, SessionId } from '@yharness/session'
import { freezeMessage, MessageId } from '@yharness/llm'
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
  try {
    await service[Service.init]()
  } catch (error) {
    await close(ctx)
    throw error
  }
  return { ctx, service, pool, create, readImage, agents, inspect, resolveAgent, flush, followups }
}

async function close(ctx: Context): Promise<void> {
  await ctx.fiber.dispose()
}

describe('durable Bot roster', () => {
  it('persists an additional character shape across restarts', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const created = await first.service.create({ name: 'Heart bot', identity: 'heart', cwd: '/tmp' })
    await close(first.ctx)
    const reopened = await harness(pool)
    try {
      await expect(reopened.service.list({})).resolves.toMatchObject({ bots: [{ id: created.bot.id, identity: 'heart', sessionId: created.bot.sessionId }] })
    } finally {
      await close(reopened.ctx)
    }
  })
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
      expect(tools.map(tool => tool.name)).toEqual(['list_bots', 'inspect_bot', 'send_bot_message', 'create_bot', 'edit_bot_profile'])
      const context = {
        callId: 'create-1', threadId: 'thread-1', turnId: 'turn-1', sessionId: created.bot.sessionId,
        signal: new AbortController().signal, approvalPolicy: 'on-request' as const, requestApproval: async () => true,
      }
      const create = tools.find(tool => tool.name === 'create_bot')!
      expect((await create.execute({ name: 'Research', identity: 'heart', accent: 'rose' }, context)).success).toBe(true)
      const bots = (await h.service.list({})).bots
      const research = bots.find(bot => bot.name === 'Research')!
      expect(research).toMatchObject({ identity: 'heart', accent: 'rose', cwd: '/tmp' })
      expect((await create.execute({ name: 'Research', identity: 'heart', accent: 'rose' }, context)).success).toBe(true)
      expect((await h.service.list({})).bots.filter(bot => bot.name === 'Research')).toHaveLength(1)
      const edit = tools.find(tool => tool.name === 'edit_bot_profile')!
      expect((await edit.execute({ botId: research.id, name: 'Scout', identity: 'cloud', description: 'Research markets' }, context)).success).toBe(true)
      expect((await h.service.list({})).bots.find(bot => bot.id === research.id)).toMatchObject({
        name: 'Scout', identity: 'cloud', description: 'Research markets', sessionId: research.sessionId,
      })
      const partial = await create.execute({ name: 'Writer', pictureDescription: 'An owl' }, { ...context, callId: 'create-picture' })
      expect(partial.success).toBe(true)
      expect(partial.contentItems[0]?.text).toContain('pictureError')
      expect((await h.service.list({})).bots.filter(bot => bot.name === 'Writer')).toHaveLength(1)
      const avatar: ImageAttachmentRef = {
        attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`), mediaType: 'image/png', bytes: 3, width: 64, height: 64,
      }
      const generator = {
        generate: vi.fn(async () => ({ data: 'AQID', mediaType: 'image/png' as const })),
        commit: vi.fn(async () => ({ attachment: avatar })),
      }
      h.ctx.provide('avatarGeneration', generator as never)
      expect((await edit.execute({ botId: research.id, pictureDescription: 'A friendly fox' }, context)).success).toBe(true)
      expect((await h.service.list({})).bots.find(bot => bot.id === research.id)).toMatchObject({ avatar })
      const cancelled = new AbortController()
      generator.generate.mockImplementation(async () => {
        cancelled.abort()
        return { data: 'AQID', mediaType: 'image/png' }
      })
      expect((await edit.execute({ botId: research.id, pictureDescription: 'A cat' }, {
        ...context, signal: cancelled.signal,
      })).success).toBe(false)
      expect(generator.commit).toHaveBeenCalledOnce()
      expect((await h.service.list({})).bots.find(bot => bot.id === research.id)).toMatchObject({ avatar })
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

  it('persists a multi-Bot group and delivers one human message to every member', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const alpha = await first.service.create({ name: 'Alpha', cwd: '/tmp' })
    const beta = await first.service.create({ name: 'Beta', cwd: '/tmp' })
    const gamma = await first.service.create({ name: 'Gamma', cwd: '/tmp' })
    await close(first.ctx)

    const h = await harness(pool, undefined, undefined, [
      String(alpha.bot.sessionId), String(beta.bot.sessionId), String(gamma.bot.sessionId),
    ])
    try {
      const created = await h.service.createGroup({
        name: 'Launch room',
        botIds: [alpha.bot.id, beta.bot.id, gamma.bot.id],
      })
      expect(created.group).toMatchObject({ name: 'Launch room', botIds: [alpha.bot.id, beta.bot.id, gamma.bot.id] })

      await expect(h.service.sendGroupMessage({
        groupId: created.group.id,
        text: 'Coordinate the release plan.',
        messageId: 'bot-group-message-1',
      })).resolves.toMatchObject({
        status: 'accepted',
        deliveries: [
          { botId: alpha.bot.id, status: 'accepted' },
          { botId: beta.bot.id, status: 'accepted' },
          { botId: gamma.bot.id, status: 'accepted' },
        ],
      })
      expect(h.followups.map(followup => followup.mock.calls[0]?.[0])).toEqual([
        expect.objectContaining({ role: 'user', source: { kind: 'user' } }),
        expect.objectContaining({ role: 'user', source: { kind: 'user' } }),
        expect.objectContaining({ role: 'user', source: { kind: 'user' } }),
      ])
      expect(h.followups[0]?.mock.calls[0]?.[0].content).toEqual([
        { type: 'text', text: 'Message from group "Launch room":\nCoordinate the release plan.' },
      ])
      await expect(h.service.sendGroupMessage({
        groupId: created.group.id,
        text: 'Coordinate the release plan.',
        messageId: 'bot-group-message-1',
      })).resolves.toMatchObject({ status: 'duplicate' })
      expect(h.followups[0]).toHaveBeenCalledTimes(1)

      const firstAgent = h.agents[0]
      if (firstAgent === undefined) throw new Error('first group Bot Agent was not created')
      const responseEvent = firstAgent.session.append('assistant/message', {
        turn: 1,
        step: 1,
        message: freezeMessage({
          id: MessageId('assistant-alpha'),
          role: 'assistant',
          content: [{ type: 'text', text: 'Alpha is ready.' }],
          source: { kind: 'model', provider: 'test', model: 'test' },
        }),
        stream: [],
      }, { surfaceOp: 'append' })
      h.ctx.emit('session/event', firstAgent.session, responseEvent)
      await expect(h.service.inspectGroup({ groupId: created.group.id })).resolves.toMatchObject({
        messages: [
          { sender: { kind: 'user' }, text: 'Coordinate the release plan.' },
          { sender: { kind: 'bot', botId: alpha.bot.id }, text: 'Alpha is ready.' },
        ],
      })

      await close(h.ctx)
      const reopened = await harness(pool, undefined, undefined, [
        String(alpha.bot.sessionId), String(beta.bot.sessionId), String(gamma.bot.sessionId),
      ])
      try {
        await expect(reopened.service.listGroups({})).resolves.toMatchObject({
          groups: [{ id: created.group.id, name: 'Launch room', botIds: [alpha.bot.id, beta.bot.id, gamma.bot.id] }],
        })
        await expect(reopened.service.inspectGroup({ groupId: created.group.id })).resolves.toMatchObject({
          group: { id: created.group.id },
          messages: [
            { sender: { kind: 'user' }, text: 'Coordinate the release plan.' },
            { sender: { kind: 'bot', botId: alpha.bot.id }, text: 'Alpha is ready.' },
          ],
        })
      } finally {
        await close(reopened.ctx)
      }
    } finally {
      if (!h.ctx.disposed) await close(h.ctx)
    }
  })

  it('rejects duplicate members and groups with fewer than two Bots', async () => {
    const h = await harness()
    try {
      const alpha = await h.service.create({ name: 'Alpha', cwd: '/tmp' })
      await expect(h.service.createGroup({ name: 'Invalid', botIds: [alpha.bot.id] })).rejects.toThrow('at least two')
      await expect(h.service.createGroup({ name: 'Invalid', botIds: [alpha.bot.id, alpha.bot.id] })).rejects.toThrow('unique')
    } finally {
      await close(h.ctx)
    }
  })

  it('retries only the failed member of a partially delivered group message', async () => {
    const pool = new MemoryMediaPool()
    const seed = await harness(pool)
    const alpha = await seed.service.create({ name: 'Alpha', cwd: '/tmp' })
    const beta = await seed.service.create({ name: 'Beta', cwd: '/tmp' })
    const gamma = await seed.service.create({ name: 'Gamma', cwd: '/tmp' })
    await close(seed.ctx)
    const h = await harness(pool, undefined, undefined, [
      String(alpha.bot.sessionId), String(beta.bot.sessionId), String(gamma.bot.sessionId),
    ])
    try {
      const liveAgents = new Map(h.agents.map(agent => [String(agent.id), agent]))
      let failBeta = true
      h.resolveAgent.mockImplementation(async (sessionId) => {
        if (sessionId === beta.bot.sessionId && failBeta) {
          failBeta = false
          return { error: new Error('Beta is offline') }
        }
        const agent = liveAgents.get(String(sessionId))
        return agent === undefined ? { error: new Error('Session is missing') } : { agent }
      })
      const group = await h.service.createGroup({ name: 'Release room', botIds: [alpha.bot.id, beta.bot.id, gamma.bot.id] })
      await expect(h.service.sendGroupMessage({
        groupId: group.group.id,
        text: 'Prepare the release.',
        messageId: 'bot-group-message-partial',
      })).resolves.toMatchObject({
        status: 'partial',
        deliveries: [
          { botId: alpha.bot.id, status: 'accepted' },
          { botId: beta.bot.id, status: 'failed' },
          { botId: gamma.bot.id, status: 'accepted' },
        ],
      })
      expect(h.followups[0]).toHaveBeenCalledTimes(1)
      expect(h.followups[1]).toHaveBeenCalledTimes(0)
      expect(h.followups[2]).toHaveBeenCalledTimes(1)

      await expect(h.service.sendGroupMessage({
        groupId: group.group.id,
        text: 'Prepare the release.',
        messageId: 'bot-group-message-partial',
      })).resolves.toMatchObject({
        status: 'accepted',
        deliveries: [
          { botId: alpha.bot.id, status: 'duplicate' },
          { botId: beta.bot.id, status: 'accepted' },
          { botId: gamma.bot.id, status: 'duplicate' },
        ],
      })
      expect(h.followups[0]).toHaveBeenCalledTimes(1)
      expect(h.followups[1]).toHaveBeenCalledTimes(1)
      expect(h.followups[2]).toHaveBeenCalledTimes(1)
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
    const h = await harness(pool)
    try {
      pool.failNextWrites = 1
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

  it('replaces legacy generated avatars once while retaining the Bot and allowing future selection', async () => {
    const pool = new MemoryMediaPool()
    const avatar: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'ca'.repeat(32)}`),
      mediaType: 'image/png',
      bytes: 3,
      width: 64,
      height: 64,
    }
    const legacy = {
      id: 'bot-legacy-avatar',
      sessionId: 'bot-session-legacy-avatar',
      name: 'Legacy avatar',
      identity: 'agent',
      accent: 'violet',
      avatar,
      cwd: '/tmp',
      state: 'active',
      createdAt: 1,
      updatedAt: 1,
    }
    pool.versions.set('agent_bots', 1)
    pool.media.set('agent_bots', {
      tables: new Map([['bots', new Map([[legacy.id, legacy]])]]),
      global: null,
    })

    const second = await harness(pool)
    try {
      const migrated = await second.service.list({})
      expect(migrated.bots).toMatchObject([{
        id: legacy.id,
        sessionId: legacy.sessionId,
        name: 'Legacy avatar',
      }])
      expect(migrated.bots[0]).not.toHaveProperty('avatar')

      const replacement: ImageAttachmentRef = {
        attachmentId: AttachmentId(`sha256:${'cb'.repeat(32)}`),
        mediaType: 'image/png',
        bytes: 3,
        width: 64,
        height: 64,
      }
      await second.service.updateAvatar({ botId: BotId(legacy.id), avatar: replacement })
      await close(second.ctx)

      const third = await harness(pool)
      try {
        await expect(third.service.list({})).resolves.toMatchObject({ bots: [{ id: legacy.id, avatar: replacement }] })
      } finally {
        await close(third.ctx)
      }
    } catch (error) {
      await close(second.ctx)
      throw error
    }
  })

  it('retries an incomplete legacy avatar migration after a durable write failure', async () => {
    const pool = new MemoryMediaPool()
    const avatar: ImageAttachmentRef = {
      attachmentId: AttachmentId(`sha256:${'cc'.repeat(32)}`),
      mediaType: 'image/png',
      bytes: 3,
      width: 64,
      height: 64,
    }
    const legacy = {
      id: 'bot-retry-avatar',
      sessionId: 'bot-session-retry-avatar',
      name: 'Retry avatar migration',
      identity: 'agent',
      accent: 'violet',
      avatar,
      cwd: '/tmp',
      state: 'active',
      createdAt: 1,
      updatedAt: 1,
    }
    pool.versions.set('agent_bots', 1)
    pool.media.set('agent_bots', {
      tables: new Map([['bots', new Map([[legacy.id, legacy]])]]),
      global: null,
    })
    pool.failNextWrites = 1

    await expect(harness(pool)).rejects.toThrow('injected write failure')
    expect(pool.media.get('agent_bots')?.tables.get('bots')?.get(legacy.id)).toHaveProperty('avatar')

    const retried = await harness(pool)
    try {
      const listed = await retried.service.list({})
      expect(listed.bots[0]).not.toHaveProperty('avatar')
      expect(pool.media.get('agent_bots')?.global).toEqual({ animatedAvatarVersion: 1 })
    } finally {
      await close(retried.ctx)
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
