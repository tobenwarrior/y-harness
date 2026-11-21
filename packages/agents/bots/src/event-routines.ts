/** Shared event selectors and Session receipt recognition for Bot routines. */

import type { UserMessage } from '@yharness/llm'
import { z } from 'zod'
import { githubRoutineTriggerSchema } from './github-routines.ts'
import { sameSlackRoutineTrigger, slackRoutineTriggerSchema } from './slack-routines.ts'
import {
  BOT_EVENT_SOURCES, BOT_GITHUB_ROUTINE_EVENTS, BOT_SLACK_ROUTINE_EVENTS, type BotEventTrigger,
} from './types.ts'

const messageTrigger = z.object({ type: z.literal('message'), source: z.enum(BOT_EVENT_SOURCES) }).strict()
const webhookTrigger = z.object({ type: z.literal('webhook') }).strict()

/** Shared validation for routine commands and durable Bot profiles. */
export const botEventTriggerSchema = z.discriminatedUnion('type', [
  messageTrigger, githubRoutineTriggerSchema, slackRoutineTriggerSchema, webhookTrigger,
])

/** Model guidance shared by the standard and native routine tools. */
export const botRoutineEventToolDescription = 'Choose message with source bot or user, github with source, repository, and event, slack with source, workspaceId, and event, or webhook with only type. Slack supports optional channel, sender, text, and emoji filters.'

/** Model-visible event fields shared by both routine tool implementations. */
export const botRoutineEventToolProperties = {
  type: { type: 'string', enum: ['message', 'github', 'slack', 'webhook'] },
  source: { type: 'string', description: 'Message author type or the configured GitHub or Slack source id.' },
  repository: { type: 'string', description: 'GitHub repository in owner/repo form.' },
  event: { type: 'string', enum: [...BOT_GITHUB_ROUTINE_EVENTS, ...BOT_SLACK_ROUTINE_EVENTS] },
  workspaceId: { type: 'string', description: 'Required Slack workspace id, beginning with T.' },
  channelId: { type: 'string', description: 'Optional exact Slack conversation id.' },
  userId: { type: 'string', description: 'Optional Slack member id to match the author or person reacting.' },
  textIncludes: { type: 'string', description: 'Optional case-insensitive phrase for Slack message and app_mention events.' },
  reaction: { type: 'string', description: 'Optional Slack emoji name without colons for reaction_added.' },
} as const

/** Compare canonical selectors for creation retries and activation changes.
 * @param left - First selector.
 * @param right - Second selector.
 * @returns Whether both admit the same activity.
 */
export function sameRoutineTrigger(left: BotEventTrigger, right: BotEventTrigger): boolean {
  if (left.type === 'webhook') return right.type === 'webhook'
  if (left.type === 'message') return right.type === 'message' && left.source === right.source
  if (left.type === 'slack') return right.type === 'slack' && sameSlackRoutineTrigger(left, right)
  return right.type === 'github' && left.source === right.source
    && left.repository === right.repository && left.event === right.event
}

/** Read the owning routine id from an admitted Session message.
 * @param message - Persisted user-role Session message.
 * @returns The routine id for a recognized message or external trigger.
 */
export function routineFollowupId(message: UserMessage): string | undefined {
  const source = message.source
  if (source.kind === 'bot-event-routine') return source.routineId
  if (source.kind !== 'webhook') return undefined
  if (source.provider === 'github' && message.id.startsWith('bot-github-routine-')
    || source.provider === 'bot-webhook' && message.id.startsWith('bot-http-routine-')
    || source.provider === 'slack' && message.id.startsWith('bot-slack-routine-')) return String(source.ruleId)
  return undefined
}
