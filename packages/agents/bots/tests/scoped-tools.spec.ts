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

async function harness() {
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
  const dispose = installBotCollaborationTools(agent.ctx, async () => bound)
  return { ctx, agent, bound, dispose }
}

async function execute(ctx: Context, agent: Agent, name: string, arguments_: unknown) {
  return ctx.tools.execute({
    callId: ToolCallId(`bot-call-${name}`), name, arguments: arguments_,
    signal: new AbortController().signal, agent,
  })
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

describe('scoped Bot collaboration tools', () => {
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
})
