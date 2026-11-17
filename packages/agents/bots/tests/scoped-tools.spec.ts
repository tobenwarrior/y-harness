import { Context } from '@yharness/cordis'
import type { Agent } from '@yharness/agent'
import { ToolCallId } from '@yharness/llm'
import { createScope } from '@yharness/scope'
import { Session, SessionId } from '@yharness/session'
import SystemPrompt from '@yharness/system-prompt'
import ToolRuntime from '@yharness/tools'
import ApprovalService from '@yharness/user-approval'
import { describe, expect, it, vi } from 'vitest'
import {
  BotMessageId,
  type BotCollaborationClient,
} from '../src/collaboration.ts'
import { BotMemoryId } from '../src/memory.ts'
import type { BotMemoryClient } from '../src/memory.ts'
import { BotGroupId, BotGroupMessageId } from '../src/group-chat.ts'
import type { BotGrokHistoryToolHost, BotGroupToolHost } from '../src/scoped-tools.ts'
import { BotId } from '../src/types.ts'
import { installBotCollaborationTools } from '../src/scoped-tools.ts'
import type { BotGrokHistoryPage } from '../src/grok-history.ts'

function client(): BotCollaborationClient {
  return {
    sender: { id: BotId('bot-alpha'), name: 'Alpha', availability: 'idle', state: 'active' },
    list: vi.fn<BotCollaborationClient['list']>(async () => [{ id: BotId('bot-beta'), name: 'Beta', availability: 'idle', state: 'active' }]),
    inspect: vi.fn<BotCollaborationClient['inspect']>(async botId => ({
      bot: { id: botId, name: 'Beta', availability: 'idle', state: 'active' }, recent: [],
    })),
    send: vi.fn<BotCollaborationClient['send']>(async request => ({
      messageId: request.messageId ?? BotMessageId('generated'), status: 'accepted' as const,
      sender: { id: BotId('bot-alpha'), name: 'Alpha', availability: 'idle', state: 'active' },
      target: { id: request.targetBotId, name: 'Beta', availability: 'idle', state: 'active' },
    })),
    memory: {
      list: vi.fn<BotMemoryClient['list']>(async () => []),
      remember: vi.fn<BotMemoryClient['remember']>(async request => ({
        id: request.memoryId ?? BotMemoryId('memory-created'), text: request.text, createdAt: 1,
      })),
      forget: vi.fn<BotMemoryClient['forget']>(async () => {}),
    },
  }
}

async function harness(withManagement = false, withApproval = false, withGroups = false, withHistory = false) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (withApproval) {
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    ctx.on('approval/request', () => Promise.resolve('allowed-once' as const))
  }
  const session = Session.create(SessionId('bot-session-alpha'))
  session.append('turn/start', { turn: 1 })
  const agent = { id: session.id, session } as Agent
  let scope!: ReturnType<typeof createScope>
  await ctx.plugin(Object.assign((inner: Context) => {
    scope = createScope(inner, agent)
    Object.defineProperty(agent, 'ctx', { value: scope.ctx })
  }, { inject: ['tools', 'systemPrompt'] }))
  const bound = client()
  const manage = vi.fn(async () => ({ id: 'bot-created' }))
  const groupTools: BotGroupToolHost = {
    list: vi.fn(async () => ({ groups: [] })),
    inspect: vi.fn(async request => ({ group: { id: request.groupId, name: 'Room', botIds: [], bots: [], createdAt: 1, updatedAt: 1 }, messages: [] })),
    create: vi.fn(async request => ({ group: { id: request.id ?? BotGroupId('bot-group-created'), name: request.name, botIds: request.botIds, bots: [], createdAt: 1, updatedAt: 1 } })),
    update: vi.fn(async request => ({ group: {
      id: request.groupId, name: request.name, botIds: request.botIds, bots: [], createdAt: 1, updatedAt: 1,
    } })),
    send: vi.fn(async request => ({ messageId: request.messageId ?? BotGroupMessageId('bot-group-message-created'), status: 'accepted' as const, deliveries: [] })),
  }
  const history: BotGrokHistoryPage = {
    source: 'grok-bot', version: 1, firstCachedSequence: 4, totalMessages: 2, nextBefore: 8,
    messages: [{ sourceSequence: 8, role: 'assistant', text: 'A'.repeat(2_000), timestampMs: 2_000 }],
  }
  const historyRead = vi.fn<BotGrokHistoryToolHost['read']>(async () => history)
  const dispose = installBotCollaborationTools(
    agent.ctx,
    async () => bound,
    withManagement ? manage : undefined,
    withGroups ? async () => groupTools : undefined,
    undefined,
    withHistory ? { read: historyRead } : undefined,
  )
  return { ctx, agent, bound, dispose, manage, groupTools, historyRead }
}

async function execute(ctx: Context, agent: Agent, name: string, arguments_: unknown, callId = `bot-call-${name}`) {
  return ctx.tools.execute({
    callId: ToolCallId(callId), name, arguments: arguments_,
    signal: new AbortController().signal, agent,
  })
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

describe('scoped Bot collaboration tools', () => {
  it('reads only the owned Grok archive as a paginated untrusted excerpt', async () => {
    const h = await harness(false, false, false, true)
    try {
      expect(h.ctx.tools.schemas(h.agent).map(tool => tool.name)).toContain('read_own_grok_history')
      const result = await execute(h.ctx, h.agent, 'read_own_grok_history', { limit: 1 })
      expect(result.isError).toBe(false)
      const value = JSON.parse(text(result)) as BotGrokHistoryPage
      expect(value).toMatchObject({
        firstCachedSequence: 4, totalMessages: 2, nextBefore: 8,
        messages: [{ sourceSequence: 8, role: 'assistant', timestampMs: 2_000 }],
      })
      expect(value.messages[0]?.text).toContain('[Untrusted Bot transcript;')
      expect(value.messages[0]?.text.length).toBeLessThan(1_300)
      expect(h.historyRead).toHaveBeenCalledWith({ limit: 1 }, expect.any(AbortSignal))

      const selected = await execute(h.ctx, h.agent, 'read_own_grok_history', { limit: 1, source: 'full-export' }, 'bot-history-full')
      expect(selected.isError).toBe(false)
      expect(h.historyRead).toHaveBeenLastCalledWith({ limit: 1, source: 'full-export' }, expect.any(AbortSignal))
    } finally {
      h.dispose()
      await h.ctx.fiber.dispose()
    }
  })

  it('exposes management tools and denies changes without approval', async () => {
    const h = await harness(true)
    try {
      expect(h.ctx.tools.schemas(h.agent).map(tool => tool.name)).toEqual(expect.arrayContaining(['create_bot', 'edit_bot_profile']))
      expect((await execute(h.ctx, h.agent, 'create_bot', { name: 'Research' })).isError).toBe(true)
      expect(h.manage).not.toHaveBeenCalled()
    } finally {
      h.dispose()
      await h.ctx.fiber.dispose()
    }
  })
  it('registers roster tools in one Bot scope and keeps messaging approval-gated', async () => {
    const h = await harness()
    try {
      const schemas = h.ctx.tools.schemas(h.agent)
      expect(schemas.map(tool => tool.name)).toEqual([
        'list_bots', 'inspect_bot', 'send_bot_message',
        'list_bot_memory', 'remember_bot_memory', 'forget_bot_memory',
      ])
      expect(schemas.find(tool => tool.name === 'inspect_bot')).toMatchObject({
        description: expect.stringContaining('dsh-bot:<bot-id>'),
      })
      expect(schemas.find(tool => tool.name === 'send_bot_message')).toMatchObject({
        description: expect.stringContaining('never sends a message'),
      })
      await expect(execute(h.ctx, h.agent, 'list_bots', {})).resolves.toMatchObject({ isError: false })
      expect(JSON.parse(text(await execute(h.ctx, h.agent, 'list_bots', {})))).toEqual([
        { id: 'bot-beta', name: 'Beta', availability: 'idle', state: 'active' },
      ])
      const inspected = await execute(h.ctx, h.agent, 'inspect_bot', { botId: 'bot-beta' })
      expect(JSON.parse(text(inspected))).toMatchObject({ bot: { id: 'bot-beta', name: 'Beta' }, recent: [] })
      const memories = await execute(h.ctx, h.agent, 'list_bot_memory', {})
      expect(JSON.parse(text(memories))).toEqual([])
      const denied = await execute(h.ctx, h.agent, 'send_bot_message', {
        targetBotId: 'bot-beta', text: 'hello', messageId: 'retry-1',
      })
      expect(denied.isError).toBe(true)
      expect(h.bound.send).not.toHaveBeenCalled()
    } finally {
      h.dispose()
      await h.ctx.fiber.dispose()
    }
  })

  it('unregisters all scoped tools when the Bot scope is disposed', async () => {
    const h = await harness()
    h.dispose()
    expect(h.ctx.tools.schemas(h.agent)).toEqual([])
    await h.ctx.fiber.dispose()
  })

  it('reuses one stable memory id when a scoped remember retry follows an uncertain result', async () => {
    const h = await harness(false, true)
    try {
      const remember = vi.mocked(h.bound.memory!.remember)
      remember.mockImplementationOnce(async () => { throw new Error('flush result was uncertain') })
      const first = await execute(h.ctx, h.agent, 'remember_bot_memory', { text: 'Keep the handoff short.' }, 'remember-call-1')
      expect(first.isError).toBe(true)
      const second = await execute(h.ctx, h.agent, 'remember_bot_memory', { text: 'Keep the handoff short.' }, 'remember-call-2')
      expect(second.isError).toBe(false)
      const requests = remember.mock.calls.map(call => call[0])
      expect(requests).toHaveLength(2)
      expect(requests[0]?.memoryId).toBeDefined()
      expect(requests[1]?.memoryId).toBe(requests[0]?.memoryId)
    } finally {
      h.dispose()
      await h.ctx.fiber.dispose()
    }
  })

  it('exposes group inspection, creation, and sender-bound delivery tools', async () => {
    const h = await harness(false, false, true)
    try {
      expect(h.ctx.tools.schemas(h.agent).map(tool => tool.name)).toEqual(expect.arrayContaining([
        'list_bot_groups', 'inspect_bot_group', 'create_bot_group', 'send_bot_group_message',
      ]))
      await expect(execute(h.ctx, h.agent, 'list_bot_groups', {})).resolves.toMatchObject({ isError: false })
      const denied = await execute(h.ctx, h.agent, 'send_bot_group_message', { groupId: 'bot-group-room', text: 'hello' })
      expect(denied.isError).toBe(true)
      expect(h.groupTools.send).not.toHaveBeenCalled()
      h.ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' as const }), { prepend: true })
      const created = await execute(h.ctx, h.agent, 'create_bot_group', { name: 'Room', botIds: ['bot-beta'] }, 'create-first')
      expect(created.isError).toBe(false)
      expect(vi.mocked(h.groupTools.create).mock.calls[0]?.[0].id).toMatch(/^bot-group-tool-/)
      const createdRetry = await execute(h.ctx, h.agent, 'create_bot_group', { name: 'Room', botIds: ['bot-beta'] }, 'create-after-lost-response')
      expect(createdRetry.isError).toBe(false)
      expect(vi.mocked(h.groupTools.create).mock.calls[1]?.[0].id).toBe(vi.mocked(h.groupTools.create).mock.calls[0]?.[0].id)
      await execute(h.ctx, h.agent, 'create_bot_group', {
        name: 'Canonical room', botIds: [' bot-zeta ', 'bot-beta'],
      }, 'create-canonical-first')
      await execute(h.ctx, h.agent, 'create_bot_group', {
        name: 'Canonical room', botIds: ['bot-beta', ' bot-zeta '],
      }, 'create-canonical-second')
      expect(vi.mocked(h.groupTools.create).mock.calls[3]?.[0].id).toBe(vi.mocked(h.groupTools.create).mock.calls[2]?.[0].id)
      await execute(h.ctx, h.agent, 'create_bot_group', {
        name: 'Self canonical room', botIds: ['bot-beta'],
      }, 'create-self-omitted')
      await execute(h.ctx, h.agent, 'create_bot_group', {
        name: 'Self canonical room', botIds: ['bot-alpha', 'bot-beta'],
      }, 'create-self-included')
      expect(vi.mocked(h.groupTools.create).mock.calls[5]?.[0].id).toBe(vi.mocked(h.groupTools.create).mock.calls[4]?.[0].id)
      const updated = await execute(h.ctx, h.agent, 'update_bot_group', {
        groupId: 'bot-group-room', name: 'Renamed room', botIds: ['bot-alpha', 'bot-beta'],
      }, 'update-room')
      expect(updated.isError).toBe(false)
      expect(vi.mocked(h.groupTools.update).mock.calls[0]?.[0]).toMatchObject({
        groupId: BotGroupId('bot-group-room'), name: 'Renamed room', botIds: [BotId('bot-alpha'), BotId('bot-beta')],
      })
      const sent = await execute(h.ctx, h.agent, 'send_bot_group_message', { groupId: 'bot-group-room', text: 'hello' }, 'send-first')
      expect(sent.isError).toBe(false)
      expect(vi.mocked(h.groupTools.send).mock.calls[0]?.[0].messageId).toMatch(/^bot-group-message-tool-/)
      const sentRetry = await execute(h.ctx, h.agent, 'send_bot_group_message', { groupId: 'bot-group-room', text: 'hello' }, 'send-after-lost-response')
      expect(sentRetry.isError).toBe(false)
      expect(vi.mocked(h.groupTools.send).mock.calls[1]?.[0].messageId).toBe(vi.mocked(h.groupTools.send).mock.calls[0]?.[0].messageId)
      await execute(h.ctx, h.agent, 'send_bot_group_message', {
        groupId: 'bot-group-room', text: 'hello Beta', targetBotIds: ['bot-beta'],
      }, 'send-mentioned')
      expect(vi.mocked(h.groupTools.send).mock.calls[2]?.[0].targetBotIds).toEqual([BotId('bot-beta')])
      await execute(h.ctx, h.agent, 'create_bot_group', {
        name: 'Explicit room', botIds: ['bot-beta'], groupId: 'bot-group-explicit',
      }, 'create-explicit')
      await execute(h.ctx, h.agent, 'send_bot_group_message', {
        groupId: ' bot-group-room ', text: ' hello ', messageId: 'bot-group-message-explicit',
      }, 'send-explicit')
      expect(vi.mocked(h.groupTools.create).mock.calls[6]?.[0].id).toBe('bot-group-explicit')
      expect(vi.mocked(h.groupTools.send).mock.calls[3]?.[0].messageId).toBe('bot-group-message-explicit')
    } finally {
      h.dispose()
      await h.ctx.fiber.dispose()
    }
  })
})
