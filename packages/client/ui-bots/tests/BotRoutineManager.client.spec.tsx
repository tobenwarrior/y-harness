// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BotId } from '@yharness/bots'
import type { BotRoutineView } from '@yharness/bots/client'
import { makeTranslate } from '@yharness/client-test-runtime'
import { ScheduleId } from '@yharness/schedule'
import { SessionId } from '@yharness/session'
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
