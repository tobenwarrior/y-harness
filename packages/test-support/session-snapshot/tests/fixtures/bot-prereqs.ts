/** Seed fixed Bot-owned Sessions and provide the narrow controller seam used by headless replay. */

import type { Context } from '@yharness/cordis'
import type { AgentHandle } from '@yharness/agent'
import { MessageId } from '@yharness/llm'
import type {} from '@yharness/agent-default-model'
import type {} from '../../../../agents/bots/src/collaboration.ts'
import type { SessionEvent } from '@yharness/session'
import type {} from '@yharness/storage-domain'
import { SessionId } from '@yharness/session'
import { registerScheduleTools } from '../../../../schedule/tool-schedule/src/index.ts'
import { BotMemoryId } from '../../../../agents/bots/src/memory.ts'
import { BotGroupId, BotGroupMessageId } from '../../../../agents/bots/src/group-chat.ts'
import { BotId } from '../../../../agents/bots/src/types.ts'
import { botDomain } from '../../../../agents/bots/src/storage.ts'

export const name = 'snapshot-bot-prereqs'
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'storageDomain']

/**
 * Keep this fixture focused on Bot-owned Session setup; the full HTTP Session
 * controller belongs to Web composition and would pull browser upload and
 * workspace services into the headless snapshot.
 */
export async function apply(ctx: Context): Promise<void> {
  const cwd = process.cwd()
  // The snapshot exercises the Bot-scoped routine policy without pulling the
  // live Host scheduler into the headless profile. Mount the same model-facing
  // definitions that the standard preset contributes; no routine is executed.
  ctx.provide('schedule', {
    create: async () => { throw new Error('schedule create is not used by this snapshot') },
    list: async () => [],
    update: async () => { throw new Error('schedule update is not used by this snapshot') },
    delete: async () => { throw new Error('schedule delete is not used by this snapshot') },
  } as never)
  const selection = ctx.agentDefaultModel.currentSelection()
  const handles: AgentHandle[] = []
  for (const sessionId of ['bot-session-sender', 'bot-session-target']) {
    handles.push(await ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd },
      agentOptions: { provider: selection.provider, model: selection.model },
    }))
  }
  await Promise.all(handles.map(handle => handle.agent.ctx.inject(
    ['schedule', 'tools'], (scheduleScope: Context) => registerScheduleTools(scheduleScope),
  )))
  // The headless runner later adopts these persisted Sessions and creates new
  // Agent scopes. Keep the same Schedule tool composition on those scopes so
  // the replay header reflects the standard Bot capability set as well.
  ctx.on('agent/created', async ({ agent }) => {
    await agent.ctx.inject(
      ['schedule', 'tools'], (scheduleScope: Context) => registerScheduleTools(scheduleScope),
    )
  })
  const domain = await ctx.storageDomain.open(botDomain)
  const bots = domain.table('bots')
  const records = [
    {
      id: BotId('bot-sender'),
      sessionId: SessionId('bot-session-sender'),
      name: 'Chief of Staff',
      description: 'Coordinates the work with peer Bots.',
      identity: 'agent' as const,
      accent: 'violet' as const,
      cwd,
      state: 'active' as const,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: BotId('bot-grok'),
      sessionId: SessionId('bot-session-target'),
      name: 'Grok Bot',
      description: 'Researches a request and reports concise findings.',
      identity: 'browse' as const,
      accent: 'blue' as const,
      hidden: true,
      cwd,
      state: 'active' as const,
      createdAt: 0,
      updatedAt: 0,
    },
  ]
  for (const record of records) await bots.put(record.id, record)
  await domain.close()
  const senderSession = ctx.sessions.get(SessionId('bot-session-sender'))
  if (senderSession === undefined) throw new Error('snapshot Bot Session "bot-session-sender" is not live')
  senderSession.append('bot/memory', {
    botId: BotId('bot-sender'),
    memoryId: BotMemoryId('memory-snapshot'),
    operation: 'remember',
    text: 'The release checklist must include rollback steps.',
  })
  const targetSession = ctx.sessions.get(SessionId('bot-session-target'))
  if (targetSession === undefined) throw new Error('snapshot Bot Session "bot-session-target" is not live')
  targetSession.append('agent/inbox/spliced', {
    target: 'next-turn',
    start: 0,
    inserted: [{
      id: MessageId('bot-group-message-snapshot'),
      role: 'user',
      source: {
        kind: 'bot-group-message',
        groupId: BotGroupId('bot-group-snapshot'),
        messageId: BotGroupMessageId('bot-group-message-snapshot'),
      },
      content: [{ type: 'text', text: 'A group message remains queued after restart.' }],
    }],
  })
  const sessionEvents = new Map<string, readonly SessionEvent[]>()
  for (const handle of handles) {
    const session = ctx.sessions.get(handle.agent.id)
    if (session === undefined) throw new Error(`snapshot Bot Session "${handle.agent.id}" is not live`)
    sessionEvents.set(String(handle.agent.id), session.snapshotEvents())
  }
  ctx.provide('snapshotBotAgents', handles as never)
  ctx.provide('sessionController', {
    create: async (request: { readonly sessionId?: string }) => {
      if (request.sessionId === undefined) throw new Error('snapshot Bot Session ids must be explicit')
      return { sessionId: request.sessionId }
    },
    inspect: async (sessionId: SessionId) => ({ events: sessionEvents.get(String(sessionId)) ?? [] }),
  } as never)
}
