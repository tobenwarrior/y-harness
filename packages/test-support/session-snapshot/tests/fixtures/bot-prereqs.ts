/** Seed fixed Bot-owned Sessions and provide the narrow controller seam used by headless replay. */

import type { Context } from '@yharness/cordis'
import type { AgentHandle } from '@yharness/agent'
import type {} from '@yharness/agent-default-model'
import type {} from '@yharness/storage-domain'
import { SessionId } from '@yharness/session'
import { BotId } from '../../../../agents/bots/src/types.ts'
import { botDomain } from '../../../../agents/bots/src/storage.ts'

export const name = 'snapshot-bot-prereqs'
export const inject = ['agentDefaultModel', 'agents', 'storageDomain']

/**
 * Keep this fixture focused on Bot-owned Session setup; the full HTTP Session
 * controller belongs to Web composition and would pull browser upload and
 * workspace services into the headless snapshot.
 */
export async function apply(ctx: Context): Promise<void> {
  const cwd = process.cwd()
  const selection = ctx.agentDefaultModel.currentSelection()
  const handles: AgentHandle[] = []
  for (const sessionId of ['bot-session-sender', 'bot-session-target']) {
    handles.push(await ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd },
      agentOptions: { provider: selection.provider, model: selection.model },
    }))
  }
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
      cwd,
      state: 'active' as const,
      createdAt: 0,
      updatedAt: 0,
    },
  ]
  for (const record of records) await bots.put(record.id, record)
  await domain.close()
  ctx.provide('snapshotBotAgents', handles as never)
  ctx.provide('sessionController', {
    create: async (request: { readonly sessionId?: string }) => {
      if (request.sessionId === undefined) throw new Error('snapshot Bot Session ids must be explicit')
      return { sessionId: request.sessionId }
    },
  } as never)
}
