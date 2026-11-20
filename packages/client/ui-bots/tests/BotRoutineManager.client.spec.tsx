// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BotId } from '@yharness/bots/types'
import type { BotRoutineView } from '@yharness/bots/client'
import { makeTranslate } from '@yharness/client-test-runtime'
import { MessageId } from '@yharness/llm/brand'
import { ScheduleId } from '@yharness/schedule'
import { SessionId } from '@yharness/session'
import { WebhookDeliveryId, WebhookSourceId } from '@yharness/webhook/brand'
import { BotRoutineManager } from '../src/client/BotRoutineManager.tsx'
import { en } from '../src/client/locales.ts'
import type { BotRoutineManagerActions, BotSummary } from '../src/client/types.ts'

afterEach(cleanup)

const t = makeTranslate(en)
const bot: BotSummary = {
  id: 'bot-routines',
  name: 'Routine bot',
  identity: 'agent',
  accent: 'violet',
}

function schedule(patch: Partial<Extract<BotRoutineView, { readonly kind: 'schedule' }>> = {}): Extract<BotRoutineView, { readonly kind: 'schedule' }> {
  return {
    kind: 'schedule',
    scheduleKind: 'every',
    id: ScheduleId('schedule-routine'),
    title: 'Routine cadence',
    prompt: 'Run the cadence',
    everySeconds: 61,
    scheduledAt: '2026-11-04T03:00:00.000Z',
    state: 'scheduled',
    deliveryMode: 'host',
    status: 'active',
    botId: BotId('bot-routines'),
    sessionId: SessionId('session-routines'),
    ...patch,
  }
}

function actionsFor(routines: readonly BotRoutineView[], overrides: Partial<BotRoutineManagerActions> = {}): BotRoutineManagerActions {
  return {
    list: vi.fn(async () => routines),
    pause: vi.fn(async () => routines[0]!),
    resume: vi.fn(async () => routines[0]!),
    remove: vi.fn(async () => {}),
    history: vi.fn(async (_botId: string, routineId: string) => ({ kind: 'event' as const, id: routineId, deliveries: [], results: [] })),
    ...overrides,
  }
}

describe('BotRoutineManager', () => {
  it.each([
    ['pull_request.opened', 'Runs when a pull request opens in example/desk'],
    ['issues.opened', 'Runs when an issue opens in example/desk'],
  ] as const)('shows the %s rule and its delivered GitHub item', async (event, rule) => {
    const source = WebhookSourceId('github-desk')
    const routine: Extract<BotRoutineView, { kind: 'event' }> = {
      kind: 'event',
      id: 'routine-github',
      title: 'Desk updates',
      prompt: 'Review the new item',
      trigger: { type: 'github', source, repository: 'example/desk', event },
      status: 'active',
      state: 'waiting',
      deliveryMode: 'host',
      createdAt: 0,
      updatedAt: 0,
      botId: BotId(bot.id),
      sessionId: SessionId('session-routines'),
    }
    const actions = actionsFor([routine], {
      history: vi.fn(async () => ({
        kind: 'event' as const,
        id: routine.id,
        deliveries: [{
          github: { source, deliveryId: WebhookDeliveryId('delivery-17'), repository: 'example/desk', event, subject: 17 },
          messageId: MessageId('message-17'),
          status: 'delivered' as const,
          createdAt: '2026-11-04T03:00:00.000Z',
        }],
        results: [],
      })),
    })

    render(<BotRoutineManager bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)

    const list = await screen.findByRole('list', { name: 'Bot routines' })
    expect(within(list).getByText('GitHub trigger')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Routine details' })).getByText(rule)).toBeTruthy()
    fireEvent.click(within(list).getByRole('button', { name: 'View results for Desk updates' }))
    expect(await screen.findByText('example/desk #17')).toBeTruthy()
  })

  it('formats a one-second remainder in a compound interval', async () => {
    const routine = schedule()
    const actions = actionsFor([routine])

    render(<BotRoutineManager bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)

    const list = await screen.findByRole('list', { name: 'Bot routines' })
    const detail = screen.getByRole('region', { name: 'Routine details' })
    expect(within(detail).getByText('Repeats every 1 minute 1 second')).toBeTruthy()
    expect(within(list).getByRole('button', { name: 'View results for Routine cadence' })).toBeTruthy()
  })

  it('does not submit a second delete while the first removal is pending', async () => {
    const pending = Promise.withResolvers<undefined>()
    const routine = schedule()
    const remove = vi.fn(() => pending.promise)
    const actions = actionsFor([routine], { remove })

    render(<BotRoutineManager bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)

    await screen.findByRole('button', { name: 'Delete Routine cadence' })
    fireEvent.click(screen.getByRole('button', { name: 'Delete Routine cadence' }))
    const confirmation = screen.getByRole('dialog', { name: 'Delete routine?' })
    const confirm = within(confirmation).getByRole('button', { name: 'Delete routine' })
    fireEvent.click(confirm)
    await waitFor(() => { expect(remove).toHaveBeenCalledOnce() })
    fireEvent.click(confirm)
    expect(remove).toHaveBeenCalledOnce()
    pending.resolve(undefined)
    await waitFor(() => { expect(screen.queryByRole('button', { name: 'Delete Routine cadence' })).toBeNull() })
  })
})
