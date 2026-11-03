import { Context } from '@yharness/cordis'
import AgentRegistry from '@yharness/agent'
import AgentLoop from '@yharness/agent-loop'
import LlmRuntime, { createUserMessage, freezeMessage, MessageId } from '@yharness/llm'
import SessionProjectionRegistry from '@yharness/session-projection'
import SessionStore, { Session, SessionId } from '@yharness/session'
import Storage from '@yharness/storage'
import type { StorageBackend } from '@yharness/storage'
import { DomainFacility } from '@yharness/storage-domain'
import type { Domain } from '@yharness/storage-domain'
import SystemPrompt from '@yharness/system-prompt'
import ToolRuntime from '@yharness/tools'
import { describe, expect, it, vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { BotGroupId, BotGroupMessageId, BotGroupService, botGroupDomain } from '../src/group-chat.ts'
import type { BotView } from '../src/types.ts'
import { BotId } from '../src/types.ts'
import '../src/collaboration.ts'

const MISSING_CREDENTIALS = 'This Bot could not reply because its provider credentials are missing. Connect the provider, then retry.'

async function openGroupDomain(pool: MemoryMediaPool): Promise<{
  readonly ctx: Context
  readonly domain: Domain<typeof botGroupDomain>
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
  return { ctx, domain: await facility.open(botGroupDomain) }
}

function botView(id: BotId, sessionId: SessionId, name: string): BotView {
  return {
    id, sessionId, name, identity: 'agent', accent: 'blue', cwd: '/tmp', state: 'active',
    availability: 'idle', pinned: false, hidden: false, createdAt: 1, updatedAt: 1,
  }
}

function waitFor<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${String(milliseconds)}ms`)), milliseconds)
    void promise.then(() => clearTimeout(timer), () => clearTimeout(timer))
  })
  return Promise.race([promise, timeout])
}

describe('Bot group delivery with a running Agent', () => {
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
      ctx.on('session/event', async (session, event) => {
        if (session !== target.session || event.type !== 'turn/end' || event.data.reason.kind !== 'error') return
        turnFailure = groupService.recordBotTurnFailure(targetBot.id, event.data.turn, MISSING_CREDENTIALS)
        await turnFailure
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
})
