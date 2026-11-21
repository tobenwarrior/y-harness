// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BotId } from '@yharness/bots/types'
import type { BotRoutineTestRun, BotRoutineView } from '@yharness/bots/client'
import { makeTranslate } from '@yharness/client-test-runtime'
import { MessageId } from '@yharness/llm/brand'
import { ScheduleId } from '@yharness/schedule'
import { SessionId } from '@yharness/session'
import { WebhookDeliveryId, WebhookSourceId } from '@yharness/webhook/brand'
import { BotRoutineManager } from '../src/client/BotRoutineManager.tsx'
import { BotRoutineTest } from '../src/client/BotRoutineTest.tsx'
import { en } from '../src/client/locales.ts'
import type { BotRoutineManagerActions, BotRoutineTestActions, BotSummary } from '../src/client/types.ts'

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
      test: { start: vi.fn<BotRoutineTestActions['start']>(), status: vi.fn<BotRoutineTestActions['status']>() },
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
    expect(screen.queryByRole('button', { name: 'Run test' })).toBeNull()
    expect(actions.test?.status).not.toHaveBeenCalled()
    fireEvent.click(within(list).getByRole('button', { name: 'View results for Desk updates' }))
    expect(await screen.findByText('example/desk #17')).toBeTruthy()
  })

  it.each(['schedule', 'message'] as const)('retries a paused %s test and returns to the Bot chat', async (trigger) => {
    const timed = schedule({ status: 'paused' })
    const routine: BotRoutineView = trigger === 'schedule' ? timed : {
      kind: 'event',
      id: 'routine-message-test',
      title: timed.title,
      prompt: timed.prompt,
      trigger: { type: 'message', source: 'user' },
      status: 'paused',
      state: 'waiting',
      deliveryMode: 'host',
      createdAt: 0,
      updatedAt: 0,
      botId: timed.botId,
      sessionId: timed.sessionId,
    }
    const receipt = { messageId: MessageId('bot-test-message'), requestedAt: 1, status: 'completed' as const }
    let latest: typeof receipt | undefined
    const start = vi.fn<BotRoutineTestActions['start']>(async () => {
      latest = receipt
      return receipt
    }).mockRejectedValueOnce(new Error('Connection interrupted'))
    const status = vi.fn(async () => latest)
    const close = vi.fn()
    const actions = actionsFor([routine], { test: { start, status } })

    render(<BotRoutineManager bot={bot} actions={actions} open onClose={close} t={t} />)

    const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'Run test' })
    await waitFor(() => { expect(button.disabled).toBe(false) })
    fireEvent.click(button)
    await screen.findByRole('alert')
    fireEvent.click(button)
    await screen.findByText('Test completed')
    expect(start).toHaveBeenCalledTimes(2)
    expect(start.mock.calls[0]).toEqual(start.mock.calls[1])
    expect(status).toHaveBeenCalledWith(bot.id, routine.id)
    expect(screen.getByRole('button', { name: 'Resume Routine cadence' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }))
    expect(close).toHaveBeenCalledOnce()
  })

  it('recovers a running test after a status read fails and stops checking on close', async () => {
    const receipt = { messageId: MessageId('running-test'), requestedAt: 1 }
    const status = vi.fn<BotRoutineTestActions['status']>()
      .mockResolvedValueOnce({ ...receipt, status: 'queued' })
      .mockRejectedValueOnce(new Error('The app disconnected'))
      .mockResolvedValueOnce({ ...receipt, status: 'running' })
    const start = vi.fn<BotRoutineTestActions['start']>()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { unmount } = render(<BotRoutineTest botId={bot.id} routineId="routine"
        actions={{ start, status }} onViewChat={vi.fn()} t={t} />)
      await act(async () => {})
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Queued…' }).disabled).toBe(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      expect(screen.getByRole('status').textContent).toBe('Test status unavailable.')
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Running…' }).disabled).toBe(true)
      unmount()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(status).toHaveBeenCalledTimes(3)
      expect(start).not.toHaveBeenCalled()
    } finally {
      cleanup()
      vi.useRealTimers()
    }
  })

  it.each(['success', 'failure'] as const)('ignores a late %s after closing the test panel', async (outcome) => {
    const lookup = Promise.withResolvers<BotRoutineTestRun | undefined>()
    const receipt = Promise.withResolvers<BotRoutineTestRun>()
    const status = vi.fn<BotRoutineTestActions['status']>().mockResolvedValueOnce(undefined).mockReturnValue(lookup.promise)
    const start = vi.fn<BotRoutineTestActions['start']>(() => receipt.promise)

    const first = render(<BotRoutineTest botId={bot.id} routineId="earlier"
      actions={{ start, status }} onViewChat={vi.fn()} t={t} />)
    const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'Run test' })
    await waitFor(() => { expect(button.disabled).toBe(false) })
    fireEvent.click(button)
    expect(start).toHaveBeenCalledOnce()
    first.unmount()
    const second = render(<BotRoutineTest botId={bot.id} routineId="later"
      actions={{ start, status }} onViewChat={vi.fn()} t={t} />)
    expect(status).toHaveBeenLastCalledWith(bot.id, 'later')
    second.unmount()
    await act(async () => {
      if (outcome === 'success') {
        const value = { messageId: MessageId('late-test'), requestedAt: 1, status: 'completed' as const }
        receipt.resolve(value)
        lookup.resolve(value)
      } else {
        receipt.reject(new Error('Late test response'))
        lookup.reject(new Error('Late status response'))
      }
    })
    expect(status).toHaveBeenCalledTimes(2)
  })

  it('hides Test for ended schedules', async () => {
    const ended = schedule({ status: 'inactive' })
    const actions = actionsFor([ended], {
      test: {
        start: vi.fn(async () => ({ messageId: MessageId('never-started'), requestedAt: 1, status: 'completed' as const })),
        status: vi.fn(async () => undefined),
      },
    })
    render(<BotRoutineManager bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)
    await screen.findByRole('region', { name: 'Routine details' })
    expect(screen.queryByRole('button', { name: 'Run test' })).toBeNull()
    expect(actions.test?.status).not.toHaveBeenCalled()
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
