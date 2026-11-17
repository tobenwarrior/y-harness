import { Context } from '@yharness/cordis'
import AgentRegistry from '@yharness/agent'
import AgentLoop from '@yharness/agent-loop'
import { AttachmentId, type FileAttachmentRef, type ImageAttachmentRef } from '@yharness/attachment'
import LlmRuntime, { createUserMessage, freezeMessage, MessageId } from '@yharness/llm'
import SessionProjectionRegistry from '@yharness/session-projection'
import SessionStore, { Session, SessionId, SessionSeq, type SessionEvent } from '@yharness/session'
import Storage from '@yharness/storage'
import type { StorageBackend } from '@yharness/storage'
import { DomainFacility } from '@yharness/storage-domain'
import type { Domain } from '@yharness/storage-domain'
import SystemPrompt from '@yharness/system-prompt'
import ToolRuntime from '@yharness/tools'
import { describe, expect, it, vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { BotAttachmentGrantId, BotAttachmentGrantStore, botAttachmentDomain } from '../src/attachment-grants.ts'
import {
  BotGroupId,
  BotGroupMessageId,
  BotGroupService,
  type BotGroupDeliveryHost,
  botGroupDeliveryRecordSchema,
  botGroupMessageRecordSchema,
  botGroupRecordSchema,
  botGroupDomain,
} from '../src/group-chat.ts'
import { BOT_GROUP_REACTION_EMOJIS } from '../src/group-reactions.ts'
import { BotPrincipalId } from '../src/sharing.ts'
import type { BotView } from '../src/types.ts'
import { BotId } from '../src/types.ts'
import '../src/collaboration.ts'

const MISSING_CREDENTIALS = 'This Bot could not reply because its provider credentials are missing. Connect the provider, then retry.'

async function openGroupDomain(pool: MemoryMediaPool): Promise<{
  readonly ctx: Context
  readonly domain: Domain<typeof botGroupDomain>
  readonly attachments: Domain<typeof botAttachmentDomain>
}> {
  const ctx = new Context()
  await ctx.plugin(Storage)
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
  return { ctx, domain: await facility.open(botGroupDomain), attachments: await facility.open(botAttachmentDomain) }
}

function botView(id: BotId, sessionId: SessionId, name: string): BotView {
  return {
    id, sessionId, name, identity: 'agent', accent: 'blue', cwd: '/tmp', state: 'active',
    availability: 'idle', pinned: false, hidden: false, createdAt: 1, updatedAt: 1,
  }
}

function waitFor<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`Timed out after ${String(milliseconds)}ms`)) }, milliseconds)
    void promise.then(() => { clearTimeout(timer) }, () => { clearTimeout(timer) })
  })
  return Promise.race([promise, timeout])
}

describe('Bot group delivery with a running Agent', () => {
  it('persists bounded replies and idempotent local reactions', async () => {
    const storage = await openGroupDomain(new MemoryMediaPool())
    const alpha = botView(BotId('bot-reply-alpha'), SessionId('session-reply-alpha'), 'Reply alpha')
    const beta = botView(BotId('bot-reply-beta'), SessionId('session-reply-beta'), 'Reply beta')
    try {
      const deliveredTexts: string[] = []
      const service = new BotGroupService(storage.domain, {
        listBots: async () => [alpha, beta],
        deliverToBot: async ({ text }) => {
          deliveredTexts.push(text)
          return 'accepted'
        },
      })
      const group = await service.create({
        id: BotGroupId('bot-group-replies-reactions'),
        name: 'Replies and reactions',
        botIds: [alpha.id, beta.id],
      })
      const parentId = BotGroupMessageId('bot-group-message-reply-parent')
      await service.send({
        groupId: group.group.id,
        text: 'The original message stays unchanged.',
        targetBotIds: [alpha.id],
        messageId: parentId,
      })
      const replyId = BotGroupMessageId('bot-group-message-reply-child')
      await service.send({
        groupId: group.group.id,
        text: 'A reply that points at the original.',
        targetBotIds: [beta.id],
        messageId: replyId,
        replyToMessageId: parentId,
      })
      expect(deliveredTexts.at(-1)).toContain('> The original message stays unchanged.')

      const firstReaction = await service.react({
        groupId: group.group.id,
        messageId: parentId,
        emoji: BOT_GROUP_REACTION_EMOJIS[0],
        action: 'add',
      })
      const duplicateReaction = await service.react({
        groupId: group.group.id,
        messageId: parentId,
        emoji: BOT_GROUP_REACTION_EMOJIS[0],
        action: 'add',
      })
      expect(firstReaction).toEqual(duplicateReaction)
      expect(firstReaction.reactions).toContainEqual({
        emoji: BOT_GROUP_REACTION_EMOJIS[0], count: 1, viewerReacted: true,
      })
      const secondReaction = await service.react({
        groupId: group.group.id,
        messageId: parentId,
        emoji: BOT_GROUP_REACTION_EMOJIS[1],
        action: 'add',
      })
      expect(secondReaction.reactions).toEqual([
        { emoji: BOT_GROUP_REACTION_EMOJIS[0], count: 1, viewerReacted: true },
        { emoji: BOT_GROUP_REACTION_EMOJIS[1], count: 1, viewerReacted: true },
      ])

      const inspected = await service.inspect({ groupId: group.group.id })
      const parent = inspected.messages.find(message => message.id === parentId)
      const reply = inspected.messages.find(message => message.id === replyId)
      expect(parent).toMatchObject({
        text: 'The original message stays unchanged.',
        reactions: [
          { emoji: BOT_GROUP_REACTION_EMOJIS[0], count: 1, viewerReacted: true },
          { emoji: BOT_GROUP_REACTION_EMOJIS[1], count: 1, viewerReacted: true },
        ],
      })
      expect(reply).toMatchObject({
        text: 'A reply that points at the original.',
        replyTo: { messageId: parentId, text: 'The original message stays unchanged.' },
      })

      const removed = await service.react({
        groupId: group.group.id,
        messageId: parentId,
        emoji: BOT_GROUP_REACTION_EMOJIS[1],
        action: 'remove',
      })
      const duplicateRemoval = await service.react({
        groupId: group.group.id,
        messageId: parentId,
        emoji: BOT_GROUP_REACTION_EMOJIS[1],
        action: 'remove',
      })
      expect(removed).toEqual(duplicateRemoval)
      expect(removed.reactions).toEqual([
        { emoji: BOT_GROUP_REACTION_EMOJIS[0], count: 1, viewerReacted: true },
      ])
    } finally {
      await storage.ctx.fiber.dispose()
    }
  })

  it('rejects a reply parent from another local group', async () => {
    const storage = await openGroupDomain(new MemoryMediaPool())
    const alpha = botView(BotId('bot-cross-room-alpha'), SessionId('session-cross-room-alpha'), 'Cross-room alpha')
    const beta = botView(BotId('bot-cross-room-beta'), SessionId('session-cross-room-beta'), 'Cross-room beta')
    const gamma = botView(BotId('bot-cross-room-gamma'), SessionId('session-cross-room-gamma'), 'Cross-room gamma')
    try {
      const service = new BotGroupService(storage.domain, {
        listBots: async () => [alpha, beta, gamma],
        deliverToBot: async () => 'accepted',
      })
      const first = await service.create({
        id: BotGroupId('bot-group-cross-room-first'), name: 'First room', botIds: [alpha.id, beta.id],
      })
      const second = await service.create({
        id: BotGroupId('bot-group-cross-room-second'), name: 'Second room', botIds: [alpha.id, gamma.id],
      })
      const parentId = BotGroupMessageId('bot-group-message-cross-room-parent')
      await service.send({ groupId: first.group.id, text: 'Only in the first room.', messageId: parentId })
      await expect(service.send({
        groupId: second.group.id,
        text: 'This must be rejected.',
        messageId: BotGroupMessageId('bot-group-message-cross-room-child'),
        replyToMessageId: parentId,
      })).rejects.toMatchObject({ code: 'invalid' })
      await expect(service.inspect({ groupId: second.group.id })).resolves.toMatchObject({ messages: [] })
    } finally {
      await storage.ctx.fiber.dispose()
    }
  })

  it('keeps V1 user rows readable and binds shared author identity to idempotency', async () => {
    const storage = await openGroupDomain(new MemoryMediaPool())
    const alpha = botView(BotId('bot-v1-alpha'), SessionId('session-v1-alpha'), 'V1 alpha')
    const beta = botView(BotId('bot-v1-beta'), SessionId('session-v1-beta'), 'V1 beta')
    try {
      const service = new BotGroupService(storage.domain, {
        listBots: async () => [alpha, beta],
        deliverToBot: async () => 'accepted',
      })
      const group = await service.create({
        id: BotGroupId('bot-group-v1-compatible'),
        name: 'V1-compatible room',
        botIds: [alpha.id, beta.id],
      })
      await storage.domain.table('messages').put(BotGroupMessageId('bot-group-message-v1'), {
        id: BotGroupMessageId('bot-group-message-v1'),
        groupId: group.group.id,
        sender: { kind: 'user' },
        text: 'Legacy transcript row',
        createdAt: 1,
      })
      await expect(service.inspect({ groupId: group.group.id })).resolves.toMatchObject({
        messages: [{ sender: { kind: 'user' }, text: 'Legacy transcript row' }],
      })

      await expect(service.inspect({ groupId: group.group.id })).resolves.toMatchObject({
        messages: [{ sender: { kind: 'user' }, text: 'Legacy transcript row' }],
      })
    } finally {
      await storage.ctx.fiber.dispose()
    }
  })

  it('does not fan out a legacy retry to Bots added after admission', async () => {
    const storage = await openGroupDomain(new MemoryMediaPool())
    const alpha = botView(BotId('bot-legacy-retry-alpha'), SessionId('session-legacy-retry-alpha'), 'Legacy alpha')
    const beta = botView(BotId('bot-legacy-retry-beta'), SessionId('session-legacy-retry-beta'), 'Legacy beta')
    const gamma = botView(BotId('bot-legacy-retry-gamma'), SessionId('session-legacy-retry-gamma'), 'Legacy gamma')
    const delivered: BotId[] = []
    try {
      const service = new BotGroupService(storage.domain, {
        listBots: async () => [alpha, beta, gamma],
        deliverToBot: async ({ targetBotId }) => {
          delivered.push(targetBotId)
          return 'accepted'
        },
      })
      const group = await service.create({
        id: BotGroupId('bot-group-legacy-retry'),
        name: 'Legacy retry room',
        botIds: [alpha.id, beta.id],
      })
      const messageId = BotGroupMessageId('bot-group-message-legacy-retry')
      await service.send({ groupId: group.group.id, text: 'Keep the original audience.', messageId })
      expect(delivered).toEqual([alpha.id, beta.id])
      const stored = storage.domain.table('messages').get(messageId)
      if (stored === undefined) throw new Error('legacy retry message missing')
      const { targetBotIds: _targetBotIds, ...legacy } = stored
      void _targetBotIds
      await storage.domain.table('messages').put(messageId, legacy)
      await service.update({ groupId: group.group.id, name: group.group.name, botIds: [alpha.id, beta.id, gamma.id] })
      delivered.length = 0
      await expect(service.send({ groupId: group.group.id, text: 'Keep the original audience.', messageId }))
        .resolves.toMatchObject({ status: 'duplicate' })
      expect(delivered).toEqual([])
    } finally {
      await storage.ctx.fiber.dispose()
    }
  })

  it('fails closed for principal delivery when no isolated shared session exists', async () => {
    const storage = await openGroupDomain(new MemoryMediaPool())
    const alpha = botView(BotId('bot-shared-alpha'), SessionId('session-shared-alpha'), 'Shared alpha')
    const beta = botView(BotId('bot-shared-beta'), SessionId('session-shared-beta'), 'Shared beta')
    let ordinaryDeliveries = 0
    try {
      const service = new BotGroupService(storage.domain, {
        listBots: async () => [alpha, beta],
        deliverToBot: async () => {
          ordinaryDeliveries += 1
          return 'accepted'
        },
      })
      const group = await service.create({
        id: BotGroupId('bot-group-shared-isolation'), name: 'Shared isolation room', botIds: [alpha.id, beta.id],
      })

      await expect(service.sendAsPrincipal(BotPrincipalId('principal-shared'), {
        groupId: group.group.id,
        text: 'Must not enter an owner-local Session.',
        messageId: BotGroupMessageId('bot-group-message-shared-isolation'),
      })).rejects.toMatchObject({ code: 'delivery-failed' })
      expect(ordinaryDeliveries).toBe(0)
      await expect(service.inspect({ groupId: group.group.id })).resolves.toMatchObject({ messages: [] })
    } finally {
      await storage.ctx.fiber.dispose()
    }
  })

  it('does not hold the group serializer while pre-step and turn-end projections await it', async () => {
    const pool = new MemoryMediaPool()
    const storage = await openGroupDomain(pool)
    const ctx = storage.ctx
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(AgentLoop, { agents: [] })
      ctx.llm.registerAdapter(['mock'], new MockAdapter([[
        { type: 'finish', reason: { kind: 'error', failure: { message: 'provider key missing', code: 'MISSING_CREDENTIAL' } } },
      ]]))

      const target = await ctx.agentLoop.create(SessionId('session-live-target'), { provider: 'mock', model: 'mock' })
      const targetBot = botView(BotId('bot-live-target'), target.id, 'Live target')
      const otherBot = botView(BotId('bot-live-other'), SessionId('session-live-other'), 'Other target')
      let turnFailure: Promise<void> | undefined
      const groupService = new BotGroupService(storage.domain, {
        listBots: async () => [targetBot, otherBot],
        deliverToBot: async (request) => {
          if (request.targetBotId === targetBot.id) {
            target.followup(createUserMessage({
              content: [{ type: 'text', text: request.text }],
              source: { kind: 'bot-group-message', groupId: request.groupId, messageId: request.messageId },
            }))
            await target.whenIdle()
          }
          return 'accepted'
        },
      })
      ctx.on('agent/pre-step', async ({ agent, messages, turn, step }, next) => {
        const decision = await next()
        if (agent !== target) return decision
        const admitted = decision.kind === 'enter' ? decision.messages : messages
        const claims = admitted.flatMap(message => message.source.kind === 'bot-group-message'
          ? [{ groupId: message.source.groupId, messageId: message.source.messageId }]
          : [])
        await groupService.recordBotMessageClaims(targetBot.id, claims, turn, step, claims.length === 1)
        return decision
      })
      ctx.on('session/event', (session, event) => {
        if (session !== target.session || event.type !== 'turn/end' || event.data.reason.kind !== 'error') return
        turnFailure = groupService.recordBotTurnFailure(targetBot.id, event.data.turn, MISSING_CREDENTIALS)
      })

      const group = await groupService.create({
        id: BotGroupId('bot-group-live-agent'), name: 'Live Agent room', botIds: [targetBot.id, otherBot.id],
      })
      const send = groupService.send({
        groupId: group.group.id,
        text: 'Please report your status.',
        targetBotIds: [targetBot.id],
        messageId: BotGroupMessageId('bot-group-message-live-agent'),
      })
      await expect(waitFor(send, 2_000)).resolves.toMatchObject({
        status: 'partial', deliveries: [{ botId: targetBot.id, status: 'failed', error: MISSING_CREDENTIALS }],
      })
      if (turnFailure !== undefined) await turnFailure
      await groupService.whenIdle()
      await expect(groupService.inspect({ groupId: group.group.id })).resolves.toMatchObject({
        deliveries: [expect.objectContaining({
          messageId: 'bot-group-message-live-agent', botId: targetBot.id,
          status: 'failed', error: MISSING_CREDENTIALS,
        })],
      })
    } finally {
      await ctx.fiber.dispose()
    }

    const reopened = await openGroupDomain(pool)
    try {
      const service = new BotGroupService(reopened.domain, {
        listBots: async () => [],
        deliverToBot: async () => 'accepted',
      })
      await expect(service.inspect({ groupId: BotGroupId('bot-group-live-agent') })).resolves.toMatchObject({
        deliveries: [expect.objectContaining({
          messageId: 'bot-group-message-live-agent', botId: BotId('bot-live-target'),
          status: 'failed', error: MISSING_CREDENTIALS,
        })],
      })
    } finally {
      await reopened.ctx.fiber.dispose()
    }
  })

  it('coalesces concurrent sends for the same pending delivery', async () => {
    const storage = await openGroupDomain(new MemoryMediaPool())
    try {
      const alpha = botView(BotId('bot-flight-alpha'), SessionId('session-flight-alpha'), 'Flight alpha')
      const beta = botView(BotId('bot-flight-beta'), SessionId('session-flight-beta'), 'Flight beta')
      let calls = 0
      let release: ((result: 'accepted') => void) | undefined
      let resolveStarted: (() => void) | undefined
      const started = new Promise<void>((resolve) => { resolveStarted = resolve })
      const gate = new Promise<'accepted'>((resolve) => { release = resolve })
      const groupService = new BotGroupService(storage.domain, {
        listBots: async () => [alpha, beta],
        deliverToBot: async () => {
          calls += 1
          if (calls === 2) resolveStarted?.()
          return gate
        },
      })
      const group = await groupService.create({
        id: BotGroupId('bot-group-flight'), name: 'Flight room', botIds: [alpha.id, beta.id],
      })
      const request = {
        groupId: group.group.id,
        text: 'Deliver this once per Bot.',
        messageId: BotGroupMessageId('bot-group-message-flight'),
      }
      const first = groupService.send(request)
      const second = groupService.send(request)
      await started
      expect(calls).toBe(2)
      if (release === undefined) throw new Error('delivery gate was not created')
      release('accepted')
      const results = await Promise.all([first, second])
      expect(results.map(result => result.status).sort()).toEqual(['accepted', 'duplicate'])
      expect(results.every(result => result.deliveries.length === 2)).toBe(true)
    } finally {
      await storage.ctx.fiber.dispose()
    }
  })

  it('does not let an old failed finalization overwrite a newer retry', async () => {
    vi.useFakeTimers()
    const storage = await openGroupDomain(new MemoryMediaPool())
    const alpha = botView(BotId('bot-finalization-alpha'), SessionId('session-finalization-alpha'), 'Finalization alpha')
    const beta = botView(BotId('bot-finalization-beta'), SessionId('session-finalization-beta'), 'Finalization beta')
    const deliveries = storage.domain.table('deliveries')
    const originalPut = deliveries.put.bind(deliveries)
    let acceptedWriteFailures = 0
    let acceptedWriteAttempts = 0
    const oldRetryReached = Promise.withResolvers<undefined>()
    let initialDelivery = true
    const releaseRetry = Promise.withResolvers<undefined>()
    try {
      vi.spyOn(deliveries, 'put').mockImplementation(async (id, record) => {
        if (record.status === 'accepted' && record.botId === beta.id) {
          acceptedWriteAttempts += 1
          if (acceptedWriteFailures < 2) {
            acceptedWriteFailures += 1
            if (acceptedWriteFailures === 2) oldRetryReached.resolve(undefined)
            throw new Error('injected finalization failure')
          }
        }
        await originalPut(id, record)
      })
      const groupService = new BotGroupService(storage.domain, {
        listBots: async () => [alpha, beta],
        deliverToBot: async ({ targetBotId }) => {
          if (initialDelivery && targetBotId === alpha.id) {
            throw new Error('first delivery failed')
          }
          if (initialDelivery) {
            initialDelivery = false
            return 'accepted'
          }
          await releaseRetry.promise
          return 'accepted'
        },
      })
      const group = await groupService.create({
        id: BotGroupId('bot-group-finalization-race'), name: 'Finalization race room', botIds: [alpha.id, beta.id],
      })
      const request = {
        groupId: group.group.id,
        text: 'Retry the failed delivery.',
        messageId: BotGroupMessageId('bot-group-message-finalization-race'),
      }
      await expect(groupService.send(request)).rejects.toThrow('injected finalization failure')
      const retry = groupService.send(request)
      await oldRetryReached.promise
      await vi.advanceTimersByTimeAsync(25)
      releaseRetry.resolve(undefined)
      await expect(retry).resolves.toMatchObject({
        status: 'accepted',
        deliveries: [
          { botId: alpha.id, status: 'accepted' },
          { botId: beta.id, status: 'accepted' },
        ],
      })
      await groupService.whenIdle()
      await expect(groupService.inspect({ groupId: group.group.id })).resolves.toMatchObject({
        deliveries: [
          { messageId: request.messageId, botId: alpha.id, status: 'accepted' },
          { messageId: request.messageId, botId: beta.id, status: 'accepted' },
        ],
      })
      expect(acceptedWriteAttempts).toBeGreaterThanOrEqual(3)
    } finally {
      await storage.ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('bounds repeated finalization failures before a later retry can succeed', async () => {
    vi.useFakeTimers()
    const storage = await openGroupDomain(new MemoryMediaPool())
    const alpha = botView(BotId('bot-finalization-limit-alpha'), SessionId('session-finalization-limit-alpha'), 'Finalization limit alpha')
    const beta = botView(BotId('bot-finalization-limit-beta'), SessionId('session-finalization-limit-beta'), 'Finalization limit beta')
    const deliveries = storage.domain.table('deliveries')
    const originalPut = deliveries.put.bind(deliveries)
    let acceptedWriteFailures = 6
    const put = vi.spyOn(deliveries, 'put').mockImplementation(async (id, record) => {
      if (record.status === 'accepted' && acceptedWriteFailures > 0) {
        acceptedWriteFailures -= 1
        throw new Error('injected bounded finalization failure')
      }
      await originalPut(id, record)
    })
    const service = new BotGroupService(storage.domain, {
      listBots: async () => [alpha, beta],
      deliverToBot: async () => 'accepted',
    })
    const groupId = BotGroupId('bot-group-finalization-limit')
    const request = {
      groupId,
      messageId: BotGroupMessageId('bot-group-message-finalization-limit'),
      text: 'Bound finalization retries.',
      targetBotIds: [beta.id],
    }
    try {
      await service.create({ id: groupId, name: 'Finalization limit', botIds: [alpha.id, beta.id] })
      await expect(service.send(request)).rejects.toThrow('injected bounded finalization failure')
      await vi.runAllTimersAsync()
      await service.whenIdle()
      expect(acceptedWriteFailures).toBe(0)
      put.mockImplementation(originalPut)
      await expect(service.send(request)).resolves.toMatchObject({ status: 'accepted' })
    } finally {
      vi.clearAllTimers()
      await storage.ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('coalesces duplicate finalization retries for concurrent sends', async () => {
    const storage = await openGroupDomain(new MemoryMediaPool())
    const alpha = botView(BotId('bot-finalization-coalesce-alpha'), SessionId('session-finalization-coalesce-alpha'), 'Finalization coalesce alpha')
    const beta = botView(BotId('bot-finalization-coalesce-beta'), SessionId('session-finalization-coalesce-beta'), 'Finalization coalesce beta')
    const deliveries = storage.domain.table('deliveries')
    const originalPut = deliveries.put.bind(deliveries)
    let acceptedWriteFailures = 2
    const put = vi.spyOn(deliveries, 'put').mockImplementation(async (id, record) => {
      if (record.status === 'accepted' && acceptedWriteFailures > 0) {
        acceptedWriteFailures -= 1
        throw new Error('injected coalescing failure')
      }
      await originalPut(id, record)
    })
    const service = new BotGroupService(storage.domain, {
      listBots: async () => [alpha, beta],
      deliverToBot: async () => 'accepted',
    })
    const groupId = BotGroupId('bot-group-finalization-coalesce')
    const request = {
      groupId,
      messageId: BotGroupMessageId('bot-group-message-finalization-coalesce'),
      text: 'Coalesce finalization retries.',
      targetBotIds: [beta.id],
    }
    try {
      await service.create({ id: groupId, name: 'Finalization coalesce', botIds: [alpha.id, beta.id] })
      const first = service.send(request)
      const second = service.send(request)
      await expect(first).rejects.toThrow('injected coalescing failure')
      await expect(second).rejects.toThrow('injected coalescing failure')
      put.mockImplementation(originalPut)
      await service.whenIdle()
      await expect(service.inspect({ groupId })).resolves.toMatchObject({
        deliveries: [{ messageId: request.messageId, botId: beta.id, status: 'accepted' }],
      })
    } finally {
      await storage.ctx.fiber.dispose()
    }
  })

  it('repairs a pending delivery that already reached the user-message surface', async () => {
    vi.useFakeTimers()
    const pool = new MemoryMediaPool()
    const storage = await openGroupDomain(pool)
    const alpha = botView(BotId('bot-surface-alpha'), SessionId('session-surface-alpha'), 'Surface alpha')
    const beta = botView(BotId('bot-surface-beta'), SessionId('session-surface-beta'), 'Surface beta')
    const targetSession = Session.create(beta.sessionId)
    const deliveries = storage.domain.table('deliveries')
    const originalPut = deliveries.put.bind(deliveries)
    let acceptanceFailures = 6
    const put = vi.spyOn(deliveries, 'put').mockImplementation(async (id, record) => {
      if (record.status === 'accepted' && acceptanceFailures > 0) {
        acceptanceFailures -= 1
        throw new Error('injected finalization failure')
      }
      await originalPut(id, record)
    })
    try {
      const groupService = new BotGroupService(storage.domain, {
        listBots: async () => [alpha, beta],
        inspectSession: async () => ({ events: targetSession.snapshotEvents() }),
        deliverToBot: async () => 'accepted',
      })
      const group = await groupService.create({
        id: BotGroupId('bot-group-surface-repair'), name: 'Surface repair room', botIds: [alpha.id, beta.id],
      })
      const messageId = BotGroupMessageId('bot-group-message-surface-repair')
      await expect(groupService.send({
        groupId: group.group.id, text: 'Repair after surface admission.', targetBotIds: [beta.id], messageId,
      })).rejects.toThrow('injected finalization failure')
      const message = freezeMessage({
        id: MessageId(String(messageId)), role: 'user',
        content: [{ type: 'text', text: 'Repair after surface admission.' }],
        source: { kind: 'bot-group-message', groupId: group.group.id, messageId },
      })
      targetSession.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
      targetSession.append('user/message', message, { surfaceOp: 'append' })
      targetSession.append('agent/inbox/spliced', {
        target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled',
      })
      put.mockImplementation(originalPut)
      await groupService.reconcileCanceledDeliveries(beta.id, targetSession.snapshotEvents())
      await expect(groupService.inspect({ groupId: group.group.id })).resolves.toMatchObject({
        deliveries: [{ messageId, botId: beta.id, status: 'accepted' }],
      })
    } finally {
      vi.clearAllTimers()
      await storage.ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('repairs a surfaced-only pending delivery without an inbox splice', async () => {
    vi.useFakeTimers()
    const storage = await openGroupDomain(new MemoryMediaPool())
    const alpha = botView(BotId('bot-surface-only-alpha'), SessionId('session-surface-only-alpha'), 'Surface-only alpha')
    const beta = botView(BotId('bot-surface-only-beta'), SessionId('session-surface-only-beta'), 'Surface-only beta')
    const targetSession = Session.create(beta.sessionId)
    const deliveries = storage.domain.table('deliveries')
    const originalPut = deliveries.put.bind(deliveries)
    let acceptanceFailures = 6
    const put = vi.spyOn(deliveries, 'put').mockImplementation(async (id, record) => {
      if (record.status === 'accepted' && acceptanceFailures > 0) {
        acceptanceFailures -= 1
        throw new Error('injected finalization failure')
      }
      await originalPut(id, record)
    })
    try {
      const groupService = new BotGroupService(storage.domain, {
        listBots: async () => [alpha, beta],
        inspectSession: async () => ({ events: targetSession.snapshotEvents() }),
        deliverToBot: async () => 'accepted',
      })
      const group = await groupService.create({
        id: BotGroupId('bot-group-surface-only-repair'), name: 'Surface-only repair room', botIds: [alpha.id, beta.id],
      })
      const messageId = BotGroupMessageId('bot-group-message-surface-only-repair')
      await expect(groupService.send({
        groupId: group.group.id, text: 'Repair a surfaced-only message.', targetBotIds: [beta.id], messageId,
      })).rejects.toThrow('injected finalization failure')
      targetSession.append('user/message', freezeMessage({
        id: MessageId(String(messageId)), role: 'user',
        content: [{ type: 'text', text: 'Repair a surfaced-only message.' }],
        source: { kind: 'bot-group-message', groupId: group.group.id, messageId },
      }), { surfaceOp: 'append' })
      put.mockImplementation(originalPut)
      await groupService.reconcileCanceledDeliveries(beta.id, targetSession.snapshotEvents())
      await expect(groupService.inspect({ groupId: group.group.id })).resolves.toMatchObject({
        deliveries: [{ messageId, botId: beta.id, status: 'accepted' }],
      })
    } finally {
      vi.clearAllTimers()
      await storage.ctx.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('covers group admission validation and roster projection edges', async () => {
    const storage = await openGroupDomain(new MemoryMediaPool())
    const alpha = botView(BotId('bot-validation-alpha'), SessionId('session-validation-alpha'), 'Validation alpha')
    const beta = {
      ...botView(BotId('bot-validation-beta'), SessionId('session-validation-beta'), 'Validation beta'),
      description: 'A described validation Bot.',
      avatar: {
        attachmentId: AttachmentId('provider:validation-avatar'), mediaType: 'image/png' as const,
        bytes: 3, width: 1, height: 1,
      } satisfies ImageAttachmentRef,
    }
    const inactive = { ...botView(BotId('bot-validation-inactive'), SessionId('session-validation-inactive'), 'Inactive'), state: 'provisioning' as const }
    const delta = botView(BotId('bot-validation-delta'), SessionId('session-validation-delta'), 'Validation delta')
    const bots = [alpha, beta, inactive, delta]
    const changed = vi.fn()
    const service = new BotGroupService(storage.domain, {
      listBots: async () => bots,
      changed,
      deliverToBot: async () => 'accepted',
    })
    const groupId = BotGroupId('bot-group-validation')
    try {
      const record = {
        id: groupId, name: 'Validation', botIds: [alpha.id, beta.id], createdAt: 1, updatedAt: 1,
      }
      expect(botGroupRecordSchema.safeParse({ ...record, botIds: [alpha.id, beta.id, beta.id] }).success).toBe(false)
      const duplicateReaction = { emoji: BOT_GROUP_REACTION_EMOJIS[0], actorId: 'owner', createdAt: 1 }
      expect(botGroupMessageRecordSchema.safeParse({
        id: BotGroupMessageId('bot-group-message-invalid-reactions'), groupId,
        sender: { kind: 'user' }, text: 'duplicate reactions', reactions: [duplicateReaction, duplicateReaction], createdAt: 1,
      }).success).toBe(false)
      expect(botGroupMessageRecordSchema.safeParse({
        id: BotGroupMessageId('bot-group-message-full-record'), groupId,
        sender: { kind: 'user', principalId: BotPrincipalId('principal-validation') }, senderName: 'Human', text: 'full record',
        targetBotIds: [alpha.id], replyToMessageId: BotGroupMessageId('bot-group-message-parent'), reactions: [duplicateReaction], createdAt: 1,
      }).success).toBe(true)
      expect(botGroupMessageRecordSchema.safeParse({
        id: BotGroupMessageId('bot-group-message-bot-record'), groupId,
        sender: { kind: 'bot', botId: alpha.id }, text: 'bot record', createdAt: 1,
      }).success).toBe(true)
      expect(botGroupDeliveryRecordSchema.safeParse({
        id: 'delivery-validation-full', groupId, messageId: BotGroupMessageId('bot-group-message-full-record'), botId: beta.id,
        status: 'failed', responseMessageId: BotGroupMessageId('bot-group-message-response'), error: 'failure',
        claim: { turn: 1, step: 1, isolated: true }, updatedAt: 1,
      }).success).toBe(true)
      expect(botGroupDeliveryRecordSchema.safeParse({
        id: 'delivery-validation-sparse', groupId, messageId: BotGroupMessageId('bot-group-message-bot-record'), botId: beta.id,
        status: 'pending', updatedAt: 1,
      }).success).toBe(true)

      await expect(service.create({ name: ' ', botIds: [alpha.id, beta.id] })).rejects.toMatchObject({ code: 'invalid' })
      await expect(service.create({ name: 'x'.repeat(81), botIds: [alpha.id, beta.id] })).rejects.toMatchObject({ code: 'invalid' })
      await expect(service.create({ name: 'Too few', botIds: [alpha.id] })).rejects.toMatchObject({ code: 'invalid' })
      await expect(service.create({ name: 'Too many', botIds: Array.from({ length: 7 }, (_, index) => BotId(`bot-over-${String(index)}`)) }))
        .rejects.toMatchObject({ code: 'invalid' })
      await expect(service.create({ name: 'Duplicate', botIds: [alpha.id, alpha.id] })).rejects.toMatchObject({ code: 'invalid' })
      await expect(service.create({ name: 'Missing', botIds: [alpha.id, BotId('bot-validation-missing')] })).rejects.toMatchObject({ code: 'member-not-found' })
      await expect(service.create({ name: 'Inactive', botIds: [alpha.id, inactive.id] })).rejects.toMatchObject({ code: 'member-not-found' })
      await expect(service.create({ id: BotGroupId('not-a-group'), name: 'Invalid id', botIds: [alpha.id, beta.id] }))
        .rejects.toMatchObject({ code: 'invalid' })

      const created = await service.create({ id: groupId, name: 'Validation', botIds: [alpha.id, beta.id] })
      await expect(service.create({ id: groupId, name: 'Validation', botIds: [beta.id, alpha.id] })).resolves.toEqual(created)
      await expect(service.create({ id: groupId, name: 'Validation', botIds: [alpha.id, beta.id, delta.id] }))
        .rejects.toMatchObject({ code: 'invalid' })
      await expect(service.create({ id: groupId, name: 'Validation', botIds: [alpha.id, delta.id] })).rejects.toMatchObject({ code: 'invalid' })
      await expect(service.create({ id: groupId, name: 'Different', botIds: [alpha.id, beta.id] })).rejects.toMatchObject({ code: 'invalid' })
      const generated = await service.create({ name: 'Generated', botIds: [alpha.id, beta.id] })
      expect(String(generated.group.id)).toMatch(/^bot-group-/)
      const listedGroups = await service.list({})
      const listedValidationGroup = listedGroups.groups.find(group => group.id === groupId)
      expect(listedValidationGroup?.bots).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: alpha.id }),
        expect.objectContaining({ id: beta.id, description: 'A described validation Bot.', avatar: beta.avatar }),
      ]))

      await expect(service.update({ groupId: BotGroupId('bot-group-missing'), name: 'Missing', botIds: [alpha.id, beta.id] }))
        .rejects.toMatchObject({ code: 'not-found' })
      await expect(service.update({ groupId, name: ' ', botIds: [alpha.id, beta.id] })).rejects.toMatchObject({ code: 'invalid' })
      await expect(service.update({ groupId, name: 'Too few', botIds: [alpha.id] })).rejects.toMatchObject({ code: 'invalid' })
      await expect(service.update({ groupId, name: 'Too many', botIds: Array.from({ length: 7 }, (_, index) => BotId(`bot-update-over-${String(index)}`)) }))
        .rejects.toMatchObject({ code: 'invalid' })
      await expect(service.update({ groupId, name: 'Duplicate', botIds: [alpha.id, alpha.id] })).rejects.toMatchObject({ code: 'invalid' })
      await expect(service.updateAsBot(inactive.id, { groupId, name: 'No access', botIds: [alpha.id, beta.id] }))
        .rejects.toMatchObject({ code: 'member-not-found' })
      await expect(service.updateAsBot(alpha.id, { groupId, name: 'Removed sender', botIds: [beta.id, delta.id] }))
        .rejects.toMatchObject({ code: 'invalid' })
      await expect(service.update({ groupId, name: 'Missing member', botIds: [alpha.id, BotId('bot-validation-missing')] }))
        .rejects.toMatchObject({ code: 'member-not-found' })
      await expect(service.update({ groupId, name: 'Inactive member', botIds: [alpha.id, inactive.id] }))
        .rejects.toMatchObject({ code: 'member-not-found' })
      const unchanged = await service.update({ groupId, name: 'Validation', botIds: [alpha.id, beta.id] })
      expect(unchanged.group.name).toBe('Validation')
      await expect(service.update({ groupId, name: 'Validation', botIds: [alpha.id, beta.id, delta.id] }))
        .resolves.toMatchObject({ group: { botIds: [alpha.id, beta.id, delta.id] } })
      await expect(service.update({ groupId, name: 'Validation expanded', botIds: [alpha.id, beta.id, delta.id] }))
        .resolves.toMatchObject({ group: { botIds: [alpha.id, beta.id, delta.id] } })
      await expect(service.update({ groupId, name: 'Validation changed', botIds: [alpha.id, delta.id] }))
        .resolves.toMatchObject({ group: { name: 'Validation changed', botIds: [alpha.id, delta.id] } })

      const directViewGroup = storage.domain.table('groups').get(groupId)
      if (directViewGroup === undefined) throw new Error('validation group was not persisted')
      await storage.domain.table('groups').put(groupId, { ...directViewGroup, botIds: [alpha.id, BotId('bot-validation-missing')] })
      await expect(service.inspect({ groupId })).resolves.toMatchObject({ group: { bots: [expect.objectContaining({ id: alpha.id })] } })
      const reactionMessageId = BotGroupMessageId('bot-group-message-validation-reaction-view')
      await storage.domain.table('messages').put(reactionMessageId, {
        id: reactionMessageId, groupId, sender: { kind: 'user' }, text: 'reaction view', createdAt: 3,
        reactions: [{ emoji: BOT_GROUP_REACTION_EMOJIS[0], actorId: 'another-owner', createdAt: 3 }],
      })
      await expect(service.inspect({ groupId })).resolves.toMatchObject({ messages: [expect.objectContaining({
        id: reactionMessageId, reactions: [{ emoji: BOT_GROUP_REACTION_EMOJIS[0], count: 1, viewerReacted: false }],
      })] })
      await expect(service.react({ groupId, messageId: reactionMessageId, emoji: 'not-supported', action: 'add' }))
        .rejects.toMatchObject({ code: 'invalid' })
      await expect(service.react({ groupId: BotGroupId('bot-group-missing'), messageId: reactionMessageId, emoji: BOT_GROUP_REACTION_EMOJIS[0], action: 'add' }))
        .rejects.toMatchObject({ code: 'not-found' })
      await expect(service.react({ groupId, messageId: BotGroupMessageId('bot-group-message-missing'), emoji: BOT_GROUP_REACTION_EMOJIS[0], action: 'add' }))
        .rejects.toMatchObject({ code: 'not-found' })
      await expect(service.react({ groupId, messageId: reactionMessageId, emoji: BOT_GROUP_REACTION_EMOJIS[0], action: 'add' })).resolves.toMatchObject({ reactions: [{ count: 2 }] })
      await expect(service.react({ groupId, messageId: reactionMessageId, emoji: BOT_GROUP_REACTION_EMOJIS[0], action: 'remove' })).resolves.toMatchObject({ reactions: [{ count: 1 }] })
      const lastReactionId = BotGroupMessageId('bot-group-message-validation-last-reaction')
      await storage.domain.table('messages').put(lastReactionId, {
        id: lastReactionId, groupId, sender: { kind: 'user' }, text: 'last reaction', createdAt: 3,
        reactions: [{ emoji: BOT_GROUP_REACTION_EMOJIS[0], actorId: 'local-owner', createdAt: 3 }],
      })
      await expect(service.react({ groupId, messageId: lastReactionId, emoji: BOT_GROUP_REACTION_EMOJIS[0], action: 'remove' })).resolves.toMatchObject({ reactions: [] })

      const botParentId = BotGroupMessageId('bot-group-message-validation-bot-parent')
      const botReplyId = BotGroupMessageId('bot-group-message-validation-bot-reply')
      await storage.domain.table('messages').put(botParentId, {
        id: botParentId, groupId, sender: { kind: 'bot', botId: BotId('bot-validation-removed') }, text: 'x'.repeat(600), createdAt: 4,
      })
      await expect(service.send({ groupId, messageId: botReplyId, text: 'Reply to removed Bot', targetBotIds: [alpha.id], replyToMessageId: botParentId }))
        .resolves.toMatchObject({ status: 'accepted' })
      const validationInspection = await service.inspect({ groupId })
      const botReply = validationInspection.messages.find(message => message.id === botReplyId)
      expect(botReply?.replyTo?.sender).toEqual({ kind: 'bot', botId: BotId('bot-validation-removed'), name: 'bot-validation-removed' })
      expect(botReply?.replyTo?.text).toContain('…')

      const tiedA = BotGroupId('bot-group-validation-tied-a')
      const tiedB = BotGroupId('bot-group-validation-tied-b')
      await storage.domain.table('groups').put(tiedA, { id: tiedA, name: 'Tied A', botIds: [alpha.id, beta.id], createdAt: 5, updatedAt: 5 })
      await storage.domain.table('groups').put(tiedB, { id: tiedB, name: 'Tied B', botIds: [alpha.id, beta.id], createdAt: 5, updatedAt: 5 })
      const tiedGroups = await service.list({})
      expect(tiedGroups.groups.map(group => group.id)).toEqual(expect.arrayContaining([tiedA, tiedB]))
      expect(changed).toHaveBeenCalled()
    } finally {
      await storage.ctx.fiber.dispose()
    }
  })

  it('admits, resolves, and rejects owner-local attachment references at the group boundary', async () => {
    const storage = await openGroupDomain(new MemoryMediaPool())
    const alpha = botView(BotId('bot-attachment-alpha'), SessionId('session-attachment-alpha'), 'Attachment alpha')
    const beta = botView(BotId('bot-attachment-beta'), SessionId('session-attachment-beta'), 'Attachment beta')
    const host = { listBots: async () => [alpha, beta], deliverToBot: async () => 'accepted' as const }
    const withoutStore = new BotGroupService(storage.domain, host)
    const store = new BotAttachmentGrantStore(storage.attachments)
    const service = new BotGroupService(storage.domain, host, store)
    const groupId = BotGroupId('bot-group-attachment-boundary')
    const messageId = BotGroupMessageId('bot-group-message-attachment-boundary')
    const image: ImageAttachmentRef = {
      attachmentId: AttachmentId('provider:attachment-image'), mediaType: 'image/png', bytes: 4, width: 1, height: 1, name: 'named.png',
    }
    const file: FileAttachmentRef = { attachmentId: AttachmentId('provider:attachment-file'), name: 'named.txt', bytes: 5 }
    try {
      const group = await withoutStore.create({ id: groupId, name: 'Attachment boundary', botIds: [alpha.id, beta.id] })
      await expect(withoutStore.admitAttachment({
        groupId, messageId, attachments: [{ type: 'file', attachment: file }],
      })).rejects.toMatchObject({ code: 'delivery-failed' })
      await expect(service.admitAttachment({
        groupId: BotGroupId('bot-group-missing'), messageId, attachments: [{ type: 'file', attachment: file }],
      })).rejects.toMatchObject({ code: 'not-found' })
      await expect(service.admitAttachment({
        groupId, messageId, targetBotIds: [], attachments: [{ type: 'file', attachment: file }],
      })).rejects.toMatchObject({ code: 'invalid' })
      await expect(service.admitAttachment({
        groupId, messageId, targetBotIds: [BotId('bot-attachment-missing')], attachments: [{ type: 'file', attachment: file }],
      })).rejects.toMatchObject({ code: 'member-not-found' })

      const grant = await service.admitAttachment({
        groupId, messageId, targetBotIds: [beta.id],
        attachments: [{ type: 'image', attachment: image }, { type: 'file', attachment: file }],
      })
      await expect(service.send({ groupId, messageId, targetBotIds: [beta.id], text: 'Review attachments.', attachmentGrants: [grant.grantId] }))
        .resolves.toMatchObject({ status: 'accepted' })
      const admittedMessage = storage.domain.table('messages').get(messageId)
      const admittedDelivery = [...storage.domain.table('deliveries').entries()]
        .find(([, delivery]) => delivery.messageId === messageId && delivery.botId === beta.id)
      if (admittedMessage === undefined || admittedDelivery === undefined) throw new Error('attachment admission was not persisted')
      await storage.domain.table('messages').put(messageId, {
        ...admittedMessage,
        sender: { kind: 'user', principalId: BotPrincipalId('principal-attachment-retry') },
      })
      await storage.domain.table('deliveries').put(admittedDelivery[0], { ...admittedDelivery[1], status: 'failed' })
      const sharedAttachments = vi.fn(async (request: { readonly attachments?: readonly unknown[] }): Promise<'accepted' | 'duplicate'> => {
        expect(request.attachments).toHaveLength(2)
        return 'accepted'
      })
      const sharedAttachmentService = new BotGroupService(storage.domain, {
        listBots: async () => [alpha, beta],
        deliverToBot: async () => 'accepted',
        deliverToSharedGroup: sharedAttachments,
      }, store)
      await expect(sharedAttachmentService.sendAsPrincipal(BotPrincipalId('principal-attachment-retry'), {
        groupId, messageId, text: 'Review attachments.',
      })).resolves.toMatchObject({ status: 'accepted' })
      expect(sharedAttachments).toHaveBeenCalledOnce()
      await expect(service.admitAttachment({
        groupId, messageId, attachments: [{ type: 'file', attachment: file }],
      })).rejects.toMatchObject({ code: 'invalid' })
      await expect(service.resolveAttachment(groupId, messageId, String(image.attachmentId)))
        .resolves.toMatchObject({ type: 'image', attachment: { name: 'named.png' } })
      await expect(service.resolveAttachment(groupId, messageId, 'provider:missing'))
        .rejects.toMatchObject({ code: 'not-found' })
      await expect(service.inspect({ groupId })).resolves.toMatchObject({ messages: [{ attachments: [
        { type: 'image', name: 'named.png' }, { type: 'file', name: 'named.txt' },
      ] }] })

      const legacyId = BotGroupMessageId('bot-group-message-attachment-legacy')
      await storage.domain.table('messages').put(legacyId, {
        id: legacyId, groupId, sender: { kind: 'user' }, text: 'Legacy without recipients', createdAt: 2,
      })
      await expect(service.resolveAttachment(groupId, legacyId, String(file.attachmentId)))
        .rejects.toMatchObject({ code: 'not-found' })
      const legacyWithDeliveryId = BotGroupMessageId('bot-group-message-attachment-legacy-delivery')
      await storage.domain.table('messages').put(legacyWithDeliveryId, {
        id: legacyWithDeliveryId, groupId, sender: { kind: 'user' }, text: 'Legacy with recipients', createdAt: 2,
      })
      await storage.domain.table('deliveries').put('delivery-attachment-legacy', {
        id: 'delivery-attachment-legacy', groupId, messageId: legacyWithDeliveryId, botId: beta.id, status: 'accepted', updatedAt: 2,
      })
      await expect(service.resolveAttachment(groupId, legacyWithDeliveryId, String(file.attachmentId)))
        .rejects.toMatchObject({ code: 'not-found' })
      const noStoreMessage = BotGroupMessageId('bot-group-message-no-store')
      await expect(withoutStore.send({ groupId, messageId: noStoreMessage, text: 'No attachment store.' }))
        .resolves.toMatchObject({ status: 'accepted' })
      await expect(withoutStore.resolveAttachment(groupId, noStoreMessage, 'provider:missing'))
        .rejects.toMatchObject({ code: 'not-found' })
      await expect(service.resolveAttachment(BotGroupId('bot-group-missing'), messageId, String(file.attachmentId)))
        .rejects.toMatchObject({ code: 'not-found' })
      const orphanId = BotGroupMessageId('bot-group-message-attachment-orphan')
      await storage.domain.table('messages').put(orphanId, {
        id: orphanId, groupId, sender: { kind: 'user' }, text: 'Orphan legacy row', createdAt: 2,
      })
      await expect(service.send({ groupId, messageId: orphanId, text: 'Retry orphan row' })).rejects.toMatchObject({ code: 'invalid' })
      const existingWithoutAttachmentsId = BotGroupMessageId('bot-group-message-attachment-existing-no-attachments')
      await expect(withoutStore.send({ groupId, messageId: existingWithoutAttachmentsId, text: 'Existing no attachments', targetBotIds: [beta.id] }))
        .resolves.toMatchObject({ status: 'accepted' })
      const currentGroup = storage.domain.table('groups').get(groupId)
      if (currentGroup === undefined) throw new Error('attachment group was not persisted')
      const unattachedGrant = await store.admit({
        kind: 'local-group', ownerId: 'local-owner', groupId, messageId: existingWithoutAttachmentsId,
        targetBotIds: [beta.id], authorizationRevision: currentGroup.updatedAt,
      }, [{ type: 'file', attachment: file }])
      await expect(service.send({ groupId, messageId: existingWithoutAttachmentsId, text: 'Existing no attachments', targetBotIds: [beta.id], attachmentGrants: [unattachedGrant.grantId] }))
        .rejects.toMatchObject({ code: 'invalid' })
      expect(group.group.botIds).toEqual([alpha.id, beta.id])
    } finally {
      await storage.ctx.fiber.dispose()
    }
  })

  it('cleans reservations when a durable group update fails during admission', async () => {
    const storage = await openGroupDomain(new MemoryMediaPool())
    const alpha = botView(BotId('bot-admission-failure-alpha'), SessionId('session-admission-failure-alpha'), 'Admission alpha')
    const beta = botView(BotId('bot-admission-failure-beta'), SessionId('session-admission-failure-beta'), 'Admission beta')
    const service = new BotGroupService(storage.domain, {
      listBots: async () => [alpha, beta],
      deliverToBot: async () => 'accepted',
    })
    const groupId = BotGroupId('bot-group-admission-failure')
    const messageId = BotGroupMessageId('bot-group-message-admission-failure')
    try {
      await service.create({ id: groupId, name: 'Admission failure', botIds: [alpha.id, beta.id] })
      const groups = storage.domain.table('groups')
      const group = groups.get(groupId)
      if (group === undefined) throw new Error('admission group was not persisted')
      await groups.put(groupId, { ...group, updatedAt: 0 })
      const originalPut = groups.put.bind(groups)
      const failingPut = vi.spyOn(groups, 'put').mockImplementation(async (id, record) => {
        if (record.updatedAt > 0) throw new Error('injected admission update failure')
        await originalPut(id, record)
      })
      await expect(service.send({ groupId, messageId, text: 'Retry after admission failure', targetBotIds: [beta.id] }))
        .rejects.toThrow('injected admission update failure')
      failingPut.mockImplementation(originalPut)
      await expect(service.send({ groupId, messageId, text: 'Retry after admission failure', targetBotIds: [beta.id] }))
        .resolves.toMatchObject({ status: 'accepted' })
    } finally {
      await storage.ctx.fiber.dispose()
    }
  })

  it('routes principal and Bot sends through their selected delivery providers', async () => {
    const storage = await openGroupDomain(new MemoryMediaPool())
    const alpha = botView(BotId('bot-routing-alpha'), SessionId('session-routing-alpha'), 'Routing alpha')
    const beta = botView(BotId('bot-routing-beta'), SessionId('session-routing-beta'), 'Routing beta')
    const delivered: Array<{ readonly targetBotId: BotId; readonly signal?: AbortSignal }> = []
    const deliverToBot = vi.fn(async (request: { readonly targetBotId: BotId; readonly signal?: AbortSignal }): Promise<'accepted' | 'duplicate'> => {
      delivered.push(request)
      return 'accepted' as const
    })
    const service = new BotGroupService(storage.domain, {
      listBots: async () => [alpha, beta],
      deliverToBot,
    })
    const groupId = BotGroupId('bot-group-routing')
    try {
      await service.create({ id: groupId, name: 'Routing', botIds: [alpha.id, beta.id] })
      await expect(service.send({ groupId, text: 'generated identity', targetBotIds: [beta.id] }))
        .resolves.toMatchObject({ status: 'accepted' })
      const botMessageId = BotGroupMessageId('bot-group-message-routing-bot')
      await expect(service.sendAsBot(alpha.id, { groupId, messageId: botMessageId, text: 'Bot-authored message', targetBotIds: [beta.id] }))
        .resolves.toMatchObject({ status: 'accepted' })
      const botInspection = await service.inspect({ groupId })
      const botMessage = botInspection.messages.find(message => message.id === botMessageId)
      expect(botMessage?.sender).toEqual({ kind: 'bot', botId: alpha.id, name: alpha.name })
      const gamma = botView(BotId('bot-routing-gamma'), SessionId('session-routing-gamma'), 'Routing gamma')
      const botRetryService = new BotGroupService(storage.domain, {
        listBots: async () => [alpha, beta, gamma],
        deliverToBot: async () => 'accepted',
      })
      const botRetryGroupId = BotGroupId('bot-group-routing-bot-retry')
      await botRetryService.create({ id: botRetryGroupId, name: 'Bot retry', botIds: [alpha.id, beta.id, gamma.id] })
      const botRetryMessageId = BotGroupMessageId('bot-group-message-routing-bot-retry')
      await botRetryService.sendAsBot(alpha.id, {
        groupId: botRetryGroupId, messageId: botRetryMessageId, text: 'Bot sender retry', targetBotIds: [gamma.id],
      })
      await expect(botRetryService.sendAsBot(beta.id, {
        groupId: botRetryGroupId, messageId: botRetryMessageId, text: 'Bot sender retry',
      })).rejects.toMatchObject({ code: 'invalid' })
      await expect(service.sendAsBot(BotId('bot-routing-missing'), { groupId, text: 'unknown sender', targetBotIds: [beta.id] }))
        .rejects.toMatchObject({ code: 'member-not-found' })
      await expect(service.sendAsBot(alpha.id, { groupId, text: 'self target', targetBotIds: [alpha.id] }))
        .rejects.toMatchObject({ code: 'invalid' })
      await expect(service.send({ groupId, text: 'empty targets', targetBotIds: [] })).rejects.toMatchObject({ code: 'invalid' })
      await expect(service.send({ groupId, text: 'duplicate targets', targetBotIds: [beta.id, beta.id] }))
        .rejects.toMatchObject({ code: 'invalid' })
      await expect(service.send({ groupId, text: 'unknown target', targetBotIds: [BotId('bot-routing-missing')] }))
        .rejects.toMatchObject({ code: 'member-not-found' })
      await expect(service.send({ groupId, text: 'too many targets', targetBotIds: [alpha.id, beta.id, alpha.id, beta.id, alpha.id, beta.id, alpha.id] }))
        .rejects.toMatchObject({ code: 'invalid' })
      await expect(service.send({ groupId: BotGroupId('not-a-group'), text: 'unknown group' })).rejects.toMatchObject({ code: 'invalid' })
      await expect(service.send({ groupId: BotGroupId('bot-group-routing-missing'), text: 'unknown group' })).rejects.toMatchObject({ code: 'not-found' })
      await expect(service.send({ groupId, text: ' ' })).rejects.toMatchObject({ code: 'invalid' })
      await expect(service.send({ groupId, messageId: BotGroupMessageId('invalid-message'), text: 'bad message id' }))
        .rejects.toMatchObject({ code: 'invalid' })
      await expect(service.send({ groupId, text: 'bad reply id', replyToMessageId: BotGroupMessageId('invalid-reply') }))
        .rejects.toMatchObject({ code: 'invalid' })

      const parentId = BotGroupMessageId('bot-group-message-routing-parent')
      await service.send({ groupId, messageId: parentId, text: 'routing parent', targetBotIds: [beta.id] })
      const otherParentId = BotGroupMessageId('bot-group-message-routing-other-parent')
      await service.send({ groupId, messageId: otherParentId, text: 'other parent', targetBotIds: [beta.id] })
      const childId = BotGroupMessageId('bot-group-message-routing-child')
      await service.send({ groupId, messageId: childId, text: 'routing child', targetBotIds: [beta.id], replyToMessageId: parentId })
      await expect(service.send({ groupId, messageId: childId, text: 'routing child', targetBotIds: [beta.id] }))
        .rejects.toMatchObject({ code: 'invalid' })
      await expect(service.send({ groupId, messageId: childId, text: 'routing child', targetBotIds: [beta.id], replyToMessageId: parentId }))
        .resolves.toMatchObject({ status: 'duplicate' })
      await expect(service.send({ groupId, messageId: childId, text: 'routing child', targetBotIds: [beta.id], replyToMessageId: otherParentId }))
        .rejects.toMatchObject({ code: 'invalid' })
      await expect(service.send({ groupId, messageId: childId, text: 'changed child', targetBotIds: [beta.id], replyToMessageId: parentId }))
        .rejects.toMatchObject({ code: 'invalid' })
      await expect(service.send({ groupId, messageId: childId, text: 'routing child', targetBotIds: [alpha.id], replyToMessageId: parentId }))
        .rejects.toMatchObject({ code: 'invalid' })
      const noReplyExistingId = BotGroupMessageId('bot-group-message-routing-no-reply-existing')
      await service.send({ groupId, messageId: noReplyExistingId, text: 'existing without a reply', targetBotIds: [beta.id] })
      await expect(service.send({ groupId, messageId: noReplyExistingId, text: 'existing without a reply', targetBotIds: [beta.id], replyToMessageId: parentId }))
        .rejects.toMatchObject({ code: 'invalid' })
      await expect(service.send({ groupId, text: 'attachment grant requires id', attachmentGrants: [BotAttachmentGrantId('bot-attachment-grant-routing-no-id')] }))
        .rejects.toMatchObject({ code: 'invalid' })
      await expect(service.send({ groupId, messageId: BotGroupMessageId('bot-group-message-routing-no-store-grant'), text: 'attachment store missing', attachmentGrants: [BotAttachmentGrantId('bot-attachment-grant-routing-no-store')] }))
        .rejects.toMatchObject({ code: 'delivery-failed' })

      deliverToBot.mockResolvedValueOnce('duplicate')
      await expect(service.send({ groupId, messageId: BotGroupMessageId('bot-group-message-routing-duplicate'), text: 'provider duplicate', targetBotIds: [beta.id] }))
        .resolves.toMatchObject({ status: 'duplicate', deliveries: [{ status: 'duplicate' }] })
      deliverToBot.mockRejectedValueOnce(new Error('provider failed'))
      await expect(service.send({ groupId, messageId: BotGroupMessageId('bot-group-message-routing-error'), text: 'provider error', targetBotIds: [beta.id] }))
        .resolves.toMatchObject({ status: 'partial', deliveries: [{ status: 'failed', error: 'provider failed' }] })
      deliverToBot.mockRejectedValueOnce('provider non-error failure')
      await expect(service.send({ groupId, messageId: BotGroupMessageId('bot-group-message-routing-string-error'), text: 'string error', targetBotIds: [beta.id] }))
        .resolves.toMatchObject({ status: 'partial', deliveries: [{ status: 'failed', error: 'provider non-error failure' }] })
      deliverToBot.mockRejectedValueOnce(new Error(''))
      await expect(service.send({ groupId, messageId: BotGroupMessageId('bot-group-message-routing-empty-error'), text: 'empty error', targetBotIds: [beta.id] }))
        .resolves.toMatchObject({ status: 'partial', deliveries: [{ status: 'failed', error: 'Bot delivery failed' }] })
      const localController = new AbortController()
      await expect(service.send({ groupId, messageId: BotGroupMessageId('bot-group-message-routing-signal'), text: 'local signal', targetBotIds: [beta.id], signal: localController.signal }))
        .resolves.toMatchObject({ status: 'accepted' })

      let releaseIdle: (() => void) | undefined
      const idleGate = new Promise<'accepted'>((resolve) => { releaseIdle = () => { resolve('accepted') } })
      let idleStarted: () => void = () => undefined
      const idleStart = new Promise<void>((resolve) => { idleStarted = resolve })
      const idleService = new BotGroupService(storage.domain, {
        listBots: async () => [alpha, beta],
        deliverToBot: async () => { idleStarted(); return idleGate },
      })
      const idleGroupId = BotGroupId('bot-group-routing-idle')
      await idleService.create({ id: idleGroupId, name: 'Idle', botIds: [alpha.id, beta.id] })
      const idleSend = idleService.send({ groupId: idleGroupId, messageId: BotGroupMessageId('bot-group-message-routing-idle'), text: 'idle delivery', targetBotIds: [beta.id] })
      await idleStart
      const idleWait = idleService.whenIdle()
      releaseIdle?.()
      await expect(Promise.all([idleSend, idleWait])).resolves.toHaveLength(2)

      const principalDeliveries: Array<{ readonly signal?: AbortSignal }> = []
      const sharedHost = {
        listBots: async () => [alpha, beta],
        deliverToBot: async () => 'accepted' as const,
        deliverToSharedGroup: vi.fn(async (request: { readonly signal?: AbortSignal }) => {
          principalDeliveries.push(request)
          return 'accepted' as const
        }),
      }
      const shared = new BotGroupService(storage.domain, sharedHost)
      await expect(shared.sendAsPrincipal(BotPrincipalId('principal-routing'), {
        groupId, messageId: BotGroupMessageId('bot-group-message-routing-principal'), text: 'principal message', targetBotIds: [beta.id],
      })).resolves.toMatchObject({ status: 'accepted' })
      const controller = new AbortController()
      await expect(shared.sendAsPrincipal(BotPrincipalId('principal-routing'), {
        groupId, messageId: BotGroupMessageId('bot-group-message-routing-principal-signal'), text: 'principal signal', targetBotIds: [beta.id], signal: controller.signal,
      })).resolves.toMatchObject({ status: 'accepted' })
      expect(principalDeliveries.map(request => request.signal)).toEqual([undefined, controller.signal])
      await expect(shared.sendAsPrincipal(BotPrincipalId('principal-routing'), {
        groupId, messageId: BotGroupMessageId('bot-group-message-routing-principal-attachments'), text: 'principal attachments', targetBotIds: [beta.id], attachmentGrants: [BotAttachmentGrantId('bot-attachment-grant-routing')],
      })).rejects.toMatchObject({ code: 'delivery-failed' })

      const disappearingSharedHost: BotGroupDeliveryHost = {
        listBots: async () => { Reflect.deleteProperty(disappearingSharedHost, 'deliverToSharedGroup'); return [alpha, beta] },
        deliverToBot: async () => 'accepted',
        deliverToSharedGroup: async () => 'accepted',
      }
      const disappearingShared = new BotGroupService(storage.domain, disappearingSharedHost)
      await expect(disappearingShared.sendAsPrincipal(BotPrincipalId('principal-disappearing'), {
        groupId, messageId: BotGroupMessageId('bot-group-message-routing-disappearing'), text: 'shared provider disappeared', targetBotIds: [beta.id],
      })).resolves.toMatchObject({ status: 'partial', deliveries: [{ status: 'failed' }] })
      expect(delivered.at(-1)?.targetBotId).toBe(beta.id)

      const racingMessageId = BotGroupMessageId('bot-group-message-routing-racing-finalization')
      const racingDeliveries = storage.domain.table('deliveries')
      const racingService = new BotGroupService(storage.domain, {
        listBots: async () => [alpha, beta],
        deliverToBot: async () => {
          const row = [...racingDeliveries.entries()].find(([, delivery]) => delivery.messageId === racingMessageId)
          if (row === undefined) throw new Error('racing delivery reservation was not persisted')
          await racingDeliveries.put(row[0], { ...row[1], status: 'failed', updatedAt: Date.now() })
          return 'accepted'
        },
      })
      await racingService.create({ id: BotGroupId('bot-group-routing-racing'), name: 'Racing finalization', botIds: [alpha.id, beta.id] })
      await expect(racingService.send({
        groupId: BotGroupId('bot-group-routing-racing'), messageId: racingMessageId, text: 'Durability race', targetBotIds: [beta.id],
      })).resolves.toMatchObject({ status: 'partial', deliveries: [{ status: 'failed', error: 'Bot delivery failed' }] })
    } finally {
      await storage.ctx.fiber.dispose()
    }
  })

  it('records isolated claims, failures, and durable Bot responses without crossing groups', async () => {
    const storage = await openGroupDomain(new MemoryMediaPool())
    const alpha = botView(BotId('bot-record-alpha'), SessionId('session-record-alpha'), 'Record alpha')
    const beta = botView(BotId('bot-record-beta'), SessionId('session-record-beta'), 'Record beta')
    const gamma = botView(BotId('bot-record-gamma'), SessionId('session-record-gamma'), 'Record gamma')
    const service = new BotGroupService(storage.domain, {
      listBots: async () => [alpha, beta, gamma],
      deliverToBot: async () => 'accepted',
    })
    const groupId = BotGroupId('bot-group-records')
    try {
      await service.create({ id: groupId, name: 'Records', botIds: [alpha.id, beta.id] })
      const firstId = BotGroupMessageId('bot-group-message-record-first')
      const secondId = BotGroupMessageId('bot-group-message-record-second')
      const responseId = BotGroupMessageId('bot-group-message-record-response')
      await service.send({ groupId, messageId: firstId, text: 'First input', targetBotIds: [beta.id] })
      await service.send({ groupId, messageId: secondId, text: 'Second input', targetBotIds: [beta.id] })
      await expect(service.recordBotMessageClaims(beta.id, [], -1, 0, true)).rejects.toMatchObject({ code: 'invalid' })
      await service.recordBotMessageClaims(beta.id, [
        { groupId, messageId: firstId }, { groupId, messageId: secondId },
      ], 1, 1, true)
      const firstDelivery = [...storage.domain.table('deliveries').entries()]
        .map(([, delivery]) => delivery).find(delivery => delivery.messageId === firstId && delivery.botId === beta.id)
      const secondDelivery = [...storage.domain.table('deliveries').entries()]
        .map(([, delivery]) => delivery).find(delivery => delivery.messageId === secondId && delivery.botId === beta.id)
      expect(firstDelivery?.claim?.isolated).toBe(false)
      expect(secondDelivery?.claim?.isolated).toBe(false)
      await service.recordBotMessageClaims(beta.id, [{ groupId: BotGroupId('bot-group-missing'), messageId: firstId }], 2, 1, true)
      await service.recordBotMessageClaims(beta.id, [{ groupId, messageId: BotGroupMessageId('bot-group-message-record-no-delivery') }], 2, 1, true)

      await service.send({ groupId, messageId: responseId, text: 'Response source', targetBotIds: [beta.id] })
      await service.recordBotMessageClaims(beta.id, [{ groupId, messageId: responseId }], 3, 2, true)
      await service.recordBotMessageClaims(beta.id, [{ groupId, messageId: responseId }], 3, 1, false)
      await service.recordBotMessageClaims(beta.id, [{ groupId, messageId: responseId }], 3, 2, true)
      await service.recordBotResponse(beta.id, 3, 2, 'A durable answer.', String(responseId))
      await service.recordBotResponse(beta.id, 3, 2, 'A durable answer.', String(responseId))
      await service.recordBotResponse(beta.id, 3, 2, 'An edited answer.', String(responseId))
      const responseMessage = [...storage.domain.table('messages').entries()]
        .map(([, message]) => message).find(message => message.sender.kind === 'bot' && message.text === 'An edited answer.')
      if (responseMessage === undefined) throw new Error('response was not persisted')
      expect(responseMessage.sender).toEqual({ kind: 'bot', botId: beta.id })

      const responseDelivery = [...storage.domain.table('deliveries').entries()]
        .map(([, delivery]) => delivery).find(delivery => delivery.messageId === responseId && delivery.botId === beta.id)
      if (responseDelivery === undefined) throw new Error('response delivery was not persisted')
      const oldResponseId = BotGroupMessageId('bot-group-message-record-old-response')
      await storage.domain.table('messages').put(oldResponseId, {
        id: oldResponseId, groupId, sender: { kind: 'bot', botId: beta.id }, text: 'Old answer', createdAt: 1,
      })
      await storage.domain.table('deliveries').put(responseDelivery.id, { ...responseDelivery, responseMessageId: oldResponseId })
      await service.recordBotResponse(beta.id, 3, 2, 'Replacement answer.', 'replacement-source')
      expect(storage.domain.table('messages').get(oldResponseId)).toBeUndefined()

      await service.recordBotTurnFailure(beta.id, -1, 'invalid turn')
      await service.recordBotTurnFailure(BotId('bot-record-missing'), 3, 'missing Bot')
      await service.recordBotTurnFailure(beta.id, 3, 'isolated turn failed')
      await service.recordBotResponse(BotId('bot-record-missing'), 3, 2, 'ignored', String(responseId))
      await service.recordBotResponse(beta.id, -1, 2, 'ignored', String(responseId))
      await service.recordBotResponse(beta.id, 3, -1, 'ignored', String(responseId))

      const missingGroupMessage = BotGroupMessageId('bot-group-message-record-missing-group')
      await storage.domain.table('deliveries').put('delivery-record-missing-group', {
        id: 'delivery-record-missing-group', groupId: BotGroupId('bot-group-missing'), messageId: missingGroupMessage,
        botId: beta.id, status: 'accepted', claim: { turn: 100, step: 1, isolated: true }, updatedAt: 1,
      })
      await service.recordBotTurnFailure(beta.id, 100, 'missing group')
      await service.recordBotResponse(beta.id, 100, 1, 'ignored', String(missingGroupMessage))
      const missingSourceMessage = BotGroupMessageId('bot-group-message-record-missing-source')
      await storage.domain.table('deliveries').put('delivery-record-missing-source', {
        id: 'delivery-record-missing-source', groupId, messageId: missingSourceMessage,
        botId: beta.id, status: 'accepted', claim: { turn: 101, step: 1, isolated: true }, updatedAt: 1,
      })
      await service.recordBotResponse(beta.id, 101, 1, 'ignored', String(missingSourceMessage))
      const secondGroupId = BotGroupId('bot-group-records-other')
      await service.create({ id: secondGroupId, name: 'Other records', botIds: [alpha.id, gamma.id] })
      const wrongGroupSource = BotGroupMessageId('bot-group-message-record-wrong-group')
      await storage.domain.table('messages').put(wrongGroupSource, {
        id: wrongGroupSource, groupId: secondGroupId, sender: { kind: 'user' }, text: 'Wrong group source', createdAt: 1,
      })
      await storage.domain.table('deliveries').put('delivery-record-wrong-group', {
        id: 'delivery-record-wrong-group', groupId, messageId: wrongGroupSource,
        botId: beta.id, status: 'accepted', claim: { turn: 102, step: 1, isolated: true }, updatedAt: 1,
      })
      await service.recordBotResponse(beta.id, 102, 1, 'ignored', String(wrongGroupSource))
      const wrongPreviousId = BotGroupMessageId('bot-group-message-record-wrong-previous')
      await storage.domain.table('messages').put(wrongPreviousId, {
        id: wrongPreviousId, groupId: secondGroupId, sender: { kind: 'bot', botId: beta.id }, text: 'Wrong previous', createdAt: 1,
      })
      await storage.domain.table('deliveries').put(responseDelivery.id, { ...responseDelivery, responseMessageId: wrongPreviousId })
      await service.recordBotResponse(beta.id, 3, 2, 'Keeps wrong previous', 'keeps-wrong-previous')
      expect(storage.domain.table('messages').get(wrongPreviousId)).toBeDefined()

      await service.send({ groupId, messageId: BotGroupMessageId('bot-group-message-record-multi-a'), text: 'Multi A', targetBotIds: [beta.id] })
      await service.send({ groupId, messageId: BotGroupMessageId('bot-group-message-record-multi-b'), text: 'Multi B', targetBotIds: [beta.id] })
      await service.recordBotMessageClaims(beta.id, [
        { groupId, messageId: BotGroupMessageId('bot-group-message-record-multi-a') },
        { groupId, messageId: BotGroupMessageId('bot-group-message-record-multi-b') },
      ], 200, 1, true, true)
      await service.recordBotResponse(beta.id, 200, 1, 'ambiguous', 'ambiguous')

      const retryId = BotGroupMessageId('bot-group-message-record-retry')
      await service.send({ groupId, messageId: retryId, text: 'Retry me', targetBotIds: [beta.id] })
      await service.recordBotMessageClaims(beta.id, [{ groupId, messageId: retryId }], 300, 1, true)
      await service.recordBotTurnFailure(beta.id, 300, 'retryable failure')
      const retryDelivery = [...storage.domain.table('deliveries').entries()]
        .find(([, delivery]) => delivery.messageId === retryId && delivery.botId === beta.id)
      if (retryDelivery === undefined) throw new Error('retry delivery was not persisted')
      await storage.domain.table('deliveries').put(retryDelivery[0], {
        ...retryDelivery[1], responseMessageId: responseId,
      })
      await service.recordBotMessageClaims(beta.id, [{ groupId, messageId: retryId }], 300, 2, true)
      await service.recordBotMessageClaims(beta.id, [{ groupId, messageId: retryId }], 301, 1, true)
      await service.recordBotMessageClaims(beta.id, [], 301, 2, false, true)

      const retryWithoutResponseId = BotGroupMessageId('bot-group-message-record-retry-without-response')
      await service.send({ groupId, messageId: retryWithoutResponseId, text: 'Retry without response id', targetBotIds: [beta.id] })
      await service.recordBotMessageClaims(beta.id, [{ groupId, messageId: retryWithoutResponseId }], 400, 1, true)
      await service.recordBotTurnFailure(beta.id, 400, 'retry without response id')
      await service.recordBotMessageClaims(beta.id, [{ groupId, messageId: retryWithoutResponseId }], 401, 1, true)
    } finally {
      await storage.ctx.fiber.dispose()
    }
  })

  it('repairs pending and canceled deliveries from owner-local Session evidence', async () => {
    const storage = await openGroupDomain(new MemoryMediaPool())
    const alpha = botView(BotId('bot-reconcile-alpha'), SessionId('session-reconcile-alpha'), 'Reconcile alpha')
    const beta = botView(BotId('bot-reconcile-beta'), SessionId('session-reconcile-beta'), 'Reconcile beta')
    const changed = vi.fn()
    const service = new BotGroupService(storage.domain, {
      listBots: async () => [alpha, beta],
      changed,
      deliverToBot: async () => 'accepted',
    })
    const groupId = BotGroupId('bot-group-reconcile-boundary')
    const message = (id: BotGroupMessageId) => freezeMessage({
      id: MessageId(String(id)), role: 'user' as const,
      content: [{ type: 'text' as const, text: String(id) }],
      source: { kind: 'bot-group-message' as const, groupId, messageId: id },
    })
    const userSurface = (id: BotGroupMessageId, seq: number): SessionEvent => ({
      type: 'user/message', seq: SessionSeq(seq), time: seq, data: message(id), surfaceOp: 'append',
    })
    const canceledInbox = (id: BotGroupMessageId, seq: number): readonly SessionEvent[] => [
      { type: 'agent/inbox/spliced', seq: SessionSeq(seq), time: seq, data: { target: 'next-turn', start: 0, inserted: [message(id)] } },
      { type: 'agent/inbox/spliced', seq: SessionSeq(seq + 1), time: seq + 1, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' } },
    ]
    const putDelivery = async (id: string, messageId: BotGroupMessageId, status: 'pending' | 'accepted', group = groupId) => {
      await storage.domain.table('deliveries').put(id, {
        id, groupId: group, messageId, botId: beta.id, status, updatedAt: 1,
      })
    }
    try {
      await service.create({ id: groupId, name: 'Reconcile boundary', botIds: [alpha.id, beta.id] })
      const surfacedId = BotGroupMessageId('bot-group-message-reconcile-surfaced')
      const acceptedSurfacedId = BotGroupMessageId('bot-group-message-reconcile-accepted-surfaced')
      const canceledId = BotGroupMessageId('bot-group-message-reconcile-canceled')
      const unprovenId = BotGroupMessageId('bot-group-message-reconcile-unproven')
      const acceptedInboxId = BotGroupMessageId('bot-group-message-reconcile-accepted-inbox')
      const missingGroupId = BotGroupMessageId('bot-group-message-reconcile-missing-group')
      await putDelivery('delivery-reconcile-surfaced', surfacedId, 'pending')
      await putDelivery('delivery-reconcile-accepted-surfaced', acceptedSurfacedId, 'accepted')
      await putDelivery('delivery-reconcile-canceled', canceledId, 'accepted')
      await putDelivery('delivery-reconcile-unproven', unprovenId, 'pending')
      await putDelivery('delivery-reconcile-accepted-inbox', acceptedInboxId, 'accepted')
      await putDelivery('delivery-reconcile-missing-group', missingGroupId, 'accepted', BotGroupId('bot-group-reconcile-missing'))
      const evidence = [
        userSurface(surfacedId, 1), userSurface(acceptedSurfacedId, 2),
        ...canceledInbox(canceledId, 3), ...canceledInbox(missingGroupId, 5),
      ]
      expect(evidence[1]?.type === 'user/message' && String(evidence[1].data.id)).toBe(String(acceptedSurfacedId))
      const pendingInbox: SessionEvent[] = [{
        type: 'agent/inbox/spliced', seq: SessionSeq(7), time: 7,
        data: { target: 'next-turn', start: 0, inserted: [message(acceptedInboxId)] },
      }]
      await service.reconcileCanceledDeliveries(beta.id, [...evidence, ...pendingInbox])
      expect(storage.domain.table('deliveries').get('delivery-reconcile-surfaced')?.status).toBe('accepted')
      expect(storage.domain.table('deliveries').get('delivery-reconcile-accepted-surfaced')?.status).toBe('accepted')
      expect(storage.domain.table('deliveries').get('delivery-reconcile-accepted-inbox')?.status).toBe('accepted')
      expect(storage.domain.table('deliveries').get('delivery-reconcile-canceled')).toMatchObject({
        status: 'failed', error: 'Bot canceled the group message before it reached the model.',
      })
      expect(storage.domain.table('deliveries').get('delivery-reconcile-unproven')?.status).toBe('pending')
      expect(storage.domain.table('deliveries').get('delivery-reconcile-missing-group')?.status).toBe('failed')
      expect(changed).toHaveBeenCalled()
      await service.reconcileCanceledDeliveries(BotId('bot-reconcile-missing'), evidence)

      let releaseFlight: (() => void) | undefined
      const flightGate = new Promise<'accepted'>((resolve) => { releaseFlight = () => { resolve('accepted') } })
      let flightStarted: () => void = () => undefined
      const started = new Promise<void>((resolve) => { flightStarted = resolve })
      const flightService = new BotGroupService(storage.domain, {
        listBots: async () => [alpha, beta],
        deliverToBot: async () => { flightStarted(); return flightGate },
      })
      const flightMessageId = BotGroupMessageId('bot-group-message-reconcile-flight')
      const flightSend = flightService.send({ groupId, messageId: flightMessageId, text: 'deferred repair', targetBotIds: [beta.id] })
      await started
      const reconciliation = flightService.reconcileCanceledDeliveries(beta.id, [])
      releaseFlight?.()
      await expect(Promise.all([flightSend, reconciliation])).resolves.toHaveLength(2)

      const claimedId = BotGroupMessageId('bot-group-message-reconcile-claimed')
      await putDelivery('delivery-reconcile-claimed', claimedId, 'pending')
      const claimedEvents: SessionEvent[] = [{
        type: 'agent/inbox/spliced', seq: SessionSeq(10), time: 10,
        data: { target: 'next-turn', start: 0, inserted: [message(claimedId)] },
      }, {
        type: 'agent/inbox/spliced', seq: SessionSeq(11), time: 11,
        data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] },
      }]
      await service.reconcileCanceledDeliveries(beta.id, claimedEvents)
      expect(storage.domain.table('deliveries').get('delivery-reconcile-claimed')?.status).toBe('accepted')

      const inspecting = new BotGroupService(storage.domain, {
        listBots: async () => [alpha, beta],
        inspectSession: async () => ({ events: evidence }),
        deliverToBot: async () => 'accepted',
      })
      await inspecting.reconcileCanceledDeliveries(beta.id, [])
      await expect(inspecting.inspectAsBot(alpha.id, { groupId })).resolves.toBeDefined()
      await expect(inspecting.inspectAsBot(BotId('bot-reconcile-missing'), { groupId }))
        .rejects.toMatchObject({ code: 'member-not-found' })
      await expect(inspecting.inspect({ groupId: BotGroupId('bot-group-reconcile-missing') }))
        .rejects.toMatchObject({ code: 'not-found' })
    } finally {
      await storage.ctx.fiber.dispose()
    }
  })
})
