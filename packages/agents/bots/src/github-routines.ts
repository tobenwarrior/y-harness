/** Validate GitHub selectors and project the only fields used by Bot routines. */

import { createHash } from 'node:crypto'
import type { UserMessage } from '@yharness/llm'
import { MessageId } from '@yharness/llm/brand'
import type { SessionId } from '@yharness/session'
import { WebhookDeliveryId, WebhookRuleId, WebhookSourceId, type VerifiedWebhookDelivery } from '@yharness/webhook'
import { z } from 'zod'
import { BOT_GITHUB_ROUTINE_EVENTS } from './types.ts'
import type { BotEventRoutine, BotGitHubRoutineReceipt } from './types.ts'

/** Ingress identifier accepted by GitHub routine rules. */
export const githubRoutineSourceSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,95}$/i).transform(WebhookSourceId)

const repository = z.string().regex(/^[a-z0-9-]{1,39}\/[a-z0-9._-]{1,100}$/i)
  .refine(value => !value.endsWith('/.') && !value.endsWith('/..'))
  .transform(value => value.toLowerCase())
const deliveryId = z.string().min(1).max(128).transform(WebhookDeliveryId)
const subjectNumber = z.number().int().positive()
const eventKind = z.enum(BOT_GITHUB_ROUTINE_EVENTS)

/** Validate the selected GitHub source, repository, and event. */
export const githubRoutineTriggerSchema = z.object({
  type: z.literal('github'), source: githubRoutineSourceSchema, repository, event: eventKind,
}).strict()

/** Fields persisted with a verified GitHub delivery. */
export const githubRoutineReceiptSchema = z.object({
  source: githubRoutineSourceSchema, deliveryId, repository, event: eventKind, subject: subjectNumber,
}).strict()

const subjectValue = z.object({ number: subjectNumber, created_at: z.iso.datetime() })
const openedPayload = z.object({
  action: z.literal('opened'),
  repository: z.object({ full_name: repository }),
  pull_request: subjectValue.optional(),
  issue: subjectValue.optional(),
})
const openedDelivery = z.object({
  kind: z.literal('github'),
  source: githubRoutineSourceSchema,
  deliveryId,
  receivedAt: z.number().int().nonnegative(),
  event: z.object({ name: z.enum(['pull_request', 'issues']), payload: openedPayload }),
})

/** Validated activity offered to matching routines. */
export interface BotGitHubRoutineActivity {
  /** Durable routing data for the resulting run. */
  readonly receipt: BotGitHubRoutineReceipt
  /** Time GitHub opened the issue or pull request, signed as part of the body. */
  readonly openedAt: number
  /** Time the Host received the authenticated delivery. */
  readonly receivedAt: number
}

/**
 * Read an opened issue or pull request from a delivery already verified by GitHub ingress.
 * @param delivery - signed and parsed delivery from the Host adapter.
 * @returns Relevant routing coordinates, or undefined for unsupported and incomplete input.
 */
export function projectGitHubRoutineActivity(delivery: VerifiedWebhookDelivery): BotGitHubRoutineActivity | undefined {
  const parsed = openedDelivery.safeParse(delivery)
  if (!parsed.success) return undefined
  const { source, deliveryId: id, event, receivedAt } = parsed.data
  const pullRequest = event.name === 'pull_request'
  const subject = pullRequest ? event.payload.pull_request : event.payload.issue
  if (subject === undefined) return undefined
  return {
    receipt: {
      source, deliveryId: id, repository: event.payload.repository.full_name,
      event: pullRequest ? 'pull_request.opened' : 'issues.opened',
      subject: subject.number,
    },
    openedAt: Date.parse(subject.created_at),
    receivedAt,
  }
}

/**
 * Identify one opened issue or pull request in one Bot routine across redeliveries.
 * @param sessionId - target session.
 * @param routineId - target routine.
 * @param receipt - signed repository and item identity, independent of the delivery header.
 * @returns Stable Session message id.
 */
export function githubRoutineMessageId(sessionId: SessionId, routineId: string, receipt: BotGitHubRoutineReceipt): MessageId {
  const digest = createHash('sha256').update(JSON.stringify([
    sessionId, routineId, receipt.repository, receipt.event, receipt.subject,
  ])).digest('hex')
  return MessageId('bot-github-routine-' + digest)
}

/**
 * Test whether a verified activity matches the active part of a routine.
 * @param routine - Bot-owned rule and activation dates.
 * @param activity - validated GitHub activity.
 * @returns Whether the routine can admit the event.
 */
export function matchesGitHubRoutine(
  routine: BotEventRoutine,
  activity: BotGitHubRoutineActivity,
): boolean {
  const { receipt } = activity
  const trigger = routine.trigger
  const since = routine.firstEligibleGitHubAt ?? routine.createdAt
  return routine.status === 'active' && trigger.type === 'github'
    && trigger.source === receipt.source && trigger.repository === receipt.repository && trigger.event === receipt.event
    && activity.openedAt >= since && activity.receivedAt >= since
}

/**
 * Render an admitted GitHub event using the existing Session webhook notice.
 * @param routine - selected rule and trusted owner-authored prompt.
 * @param receipt - signed routing data kept in the Bot row.
 * @returns Model input and user-visible notice metadata.
 */
export function githubRoutineFollowup(
  routine: Pick<BotEventRoutine, 'id' | 'prompt'>,
  receipt: BotGitHubRoutineReceipt,
): Pick<UserMessage, 'content' | 'source'> {
  const pull = receipt.event === 'pull_request.opened'
  const label = pull ? 'pull request' : 'issue'
  const url = 'https://github.com/' + receipt.repository + (pull ? '/pull/' : '/issues/') + String(receipt.subject)
  return {
    content: [{ type: 'text', text: [
      '[BOT EVENT ROUTINE]',
      routine.prompt,
      '',
      'GitHub opened ' + label + ' #' + String(receipt.subject) + ' in ' + receipt.repository + '.',
      url,
    ].join('\n') }],
    source: {
      kind: 'webhook', provider: 'github', source: receipt.source, deliveryId: receipt.deliveryId,
      ruleId: WebhookRuleId(routine.id), form: 'notice', summary: 'GitHub · ' + label + ' #' + String(receipt.subject),
    },
  }
}
