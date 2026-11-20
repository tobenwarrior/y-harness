import { MessageId } from '@yharness/llm/brand'
import { SessionId } from '@yharness/session'
import { WebhookDeliveryId, WebhookSourceId, type VerifiedWebhookDelivery } from '@yharness/webhook'
import { describe, expect, it } from 'vitest'
import {
  githubRoutineFollowup, githubRoutineMessageId, matchesGitHubRoutine,
  projectGitHubRoutineActivity, routineFollowupId, sameRoutineTrigger,
} from '../src/github-routines.ts'
import type { BotEventRoutine } from '../src/types.ts'

const repository = { full_name: 'Example/Workbench' }
const openedAt = Date.UTC(2026, 10, 20, 11, 0, 5)
const pullRequest = { number: 17, created_at: new Date(openedAt).toISOString() }
const receiptTime = openedAt + 5_000
const source = WebhookSourceId('github-workbench')
const routine: BotEventRoutine = {
  id: 'bot-event-routine-fixture',
  title: 'Review new pull requests',
  prompt: 'Explain what changed.',
  trigger: { type: 'github', source, repository: 'example/workbench', event: 'pull_request.opened' },
  status: 'active',
  createdAt: openedAt - 5_000,
  updatedAt: openedAt - 5_000,
  deliveries: [],
  results: [],
}

function delivery(event: VerifiedWebhookDelivery['event']): VerifiedWebhookDelivery {
  return { kind: 'github', source, deliveryId: WebhookDeliveryId('fixture-delivery'), receivedAt: receiptTime, event }
}

describe('GitHub activity for Bot routines', () => {
  it.each([
    ['unsupported event', delivery({ name: 'push', payload: {} })],
    ['unsupported action', delivery({ name: 'pull_request', payload: { action: 'closed', repository, pull_request: pullRequest } })],
    ['missing pull request', delivery({ name: 'pull_request', payload: { action: 'opened', repository } })],
    ['issue sent as a pull request', delivery({ name: 'pull_request', payload: { action: 'opened', repository, issue: pullRequest } })],
  ] as const)('ignores %s', (_label, input) => {
    expect(projectGitHubRoutineActivity(input)).toBeUndefined()
  })

  it('links an opened pull request in the model input and retains only its receipt', () => {
    const input = delivery({
      name: 'pull_request',
      payload: { action: 'opened', repository, pull_request: { ...pullRequest, body: 'Untrusted fixture text' } },
    })
    const activity = projectGitHubRoutineActivity(input)
    if (activity === undefined) throw new Error('Missing opened pull request')
    expect(activity).toEqual({
      receipt: {
        source, deliveryId: input.deliveryId, repository: 'example/workbench', event: 'pull_request.opened', subject: 17,
      },
      openedAt,
      receivedAt: receiptTime,
    })
    expect(matchesGitHubRoutine(routine, activity)).toBe(true)
    expect(matchesGitHubRoutine({ ...routine, firstEligibleGitHubAt: openedAt + 1 }, activity)).toBe(false)
    expect(matchesGitHubRoutine(routine, { ...activity, receivedAt: routine.createdAt - 1 })).toBe(false)

    const message = githubRoutineFollowup(routine, activity.receipt)
    expect(message.content).toEqual([{
      type: 'text',
      text: '[BOT EVENT ROUTINE]\nExplain what changed.\n\nGitHub opened pull request #17 in example/workbench.\nhttps://github.com/example/workbench/pull/17',
    }])
    const id = githubRoutineMessageId(SessionId('fixture-session'), routine.id, activity.receipt)
    expect(routineFollowupId({ id, role: 'user', ...message })).toBe(routine.id)
    expect(routineFollowupId({ id: MessageId('ordinary-webhook'), role: 'user', ...message })).toBeUndefined()
  })

  it('distinguishes selectors even when their names or repositories overlap', () => {
    const first = { type: 'github', source, repository: 'example/workbench', event: 'pull_request.opened' } as const
    expect(sameRoutineTrigger(first, { ...first })).toBe(true)
    expect(sameRoutineTrigger(first, { ...first, event: 'issues.opened' })).toBe(false)
    expect(sameRoutineTrigger(first, { ...first, source: WebhookSourceId('another-source') })).toBe(false)
    expect(sameRoutineTrigger(first, { ...first, repository: 'example/other' })).toBe(false)
  })
})
