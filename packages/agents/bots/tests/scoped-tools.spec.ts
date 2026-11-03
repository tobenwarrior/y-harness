import { Context } from '@yharness/cordis'
import type { Agent } from '@yharness/agent'
import { ToolCallId } from '@yharness/llm'
import { createScope } from '@yharness/scope'
import { SessionId } from '@yharness/session'
import SystemPrompt from '@yharness/system-prompt'
import ToolRuntime from '@yharness/tools'
import { describe, expect, it, vi } from 'vitest'
import {
  BotMessageId,
  type BotCollaborationClient,
} from '../src/collaboration.ts'
import { BotGroupId, BotGroupMessageId } from '../src/group-chat.ts'
import type { BotGroupToolHost } from '../src/scoped-tools.ts'
import { BotId } from '../src/types.ts'
import { installBotCollaborationTools } from '../src/scoped-tools.ts'

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
  }
}

async function harness(withManagement = false, withGroups = false) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const agent = { id: SessionId('bot-session-alpha') } as Agent
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
    send: vi.fn(async request => ({ messageId: request.messageId ?? BotGroupMessageId('bot-group-message-created'), status: 'accepted' as const, deliveries: [] })),
  }
  const dispose = installBotCollaborationTools(
    agent.ctx,
    async () => bound,
    withManagement ? manage : undefined,
    withGroups ? async () => groupTools : undefined,
  )
  return { ctx, agent, bound, dispose, manage, groupTools }
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
      expect(h.ctx.tools.schemas(h.agent).map(tool => tool.name)).toEqual([
        'list_bots', 'inspect_bot', 'send_bot_message',
      ])
      await expect(execute(h.ctx, h.agent, 'list_bots', {})).resolves.toMatchObject({ isError: false })
      expect(JSON.parse(text(await execute(h.ctx, h.agent, 'list_bots', {})))).toEqual([
        { id: 'bot-beta', name: 'Beta', availability: 'idle', state: 'active' },
      ])
      const inspected = await execute(h.ctx, h.agent, 'inspect_bot', { botId: 'bot-beta' })
      expect(JSON.parse(text(inspected))).toMatchObject({ bot: { id: 'bot-beta', name: 'Beta' }, recent: [] })

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

  it('exposes group inspection, creation, and sender-bound delivery tools', async () => {
    const h = await harness(false, true)
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
      const sent = await execute(h.ctx, h.agent, 'send_bot_group_message', { groupId: 'bot-group-room', text: 'hello' }, 'send-first')
      expect(sent.isError).toBe(false)
      expect(vi.mocked(h.groupTools.send).mock.calls[0]?.[0].messageId).toMatch(/^bot-group-message-tool-/)
      const sentRetry = await execute(h.ctx, h.agent, 'send_bot_group_message', { groupId: 'bot-group-room', text: 'hello' }, 'send-after-lost-response')
      expect(sentRetry.isError).toBe(false)
      expect(vi.mocked(h.groupTools.send).mock.calls[1]?.[0].messageId).toBe(vi.mocked(h.groupTools.send).mock.calls[0]?.[0].messageId)
    } finally {
      h.dispose()
      await h.ctx.fiber.dispose()
    }
  })
})
