import { Context } from '@yharness/cordis'
import AgentRegistry from '@yharness/agent'
import AgentLoop from '@yharness/agent-loop'
import LlmRuntime, { createUserMessage } from '@yharness/llm'
import SessionProjectionRegistry from '@yharness/session-projection'
import SessionStore, { SessionId } from '@yharness/session'
import Storage from '@yharness/storage'
import type { StorageBackend } from '@yharness/storage'
import { DomainFacility } from '@yharness/storage-domain'
import SystemPrompt from '@yharness/system-prompt'
import ToolRuntime from '@yharness/tools'
import { describe, expect, it } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { BotGroupId, BotGroupMessageId, BotGroupService, botGroupDomain } from '../src/group-chat.ts'
import { BotPrincipalId } from '../src/sharing.ts'
import type { BotView } from '../src/types.ts'
import { BotId } from '../src/types.ts'
import '../src/collaboration.ts'

const MISSING_CREDENTIALS = 'This Bot could not reply because its provider credentials are missing. Connect the provider, then retry.'

async function openGroupDomain(pool: MemoryMediaPool): Promise<{
  readonly ctx: Context
  readonly domain: Awaited<ReturnType<DomainFacility['open']>>
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
})
