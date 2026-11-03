// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@yharness/client-test-runtime'
import { BotMemoryManager } from '../src/client/BotMemoryManager.tsx'
import { en } from '../src/client/locales.ts'
import type { BotMemoryManagerActions, BotSummary } from '../src/client/types.ts'

afterEach(cleanup)

const t = makeTranslate(en)
const bot: BotSummary = {
  id: 'bot-chief',
  name: 'Chief of staff',
  identity: 'agent',
  accent: 'violet',
}

function renderManager(actions: BotMemoryManagerActions) {
  return render(
    <BotMemoryManager bot={bot} actions={actions} open onClose={vi.fn()} t={t} />,
  )
}

describe('BotMemoryManager', () => {
  it('loads private memories, edits one, and removes it after confirmation', async () => {
    const actions: BotMemoryManagerActions = {
      list: vi.fn(async () => [{ id: 'memory-one', text: 'Keep handoffs concise.', createdAt: 1 }]),
      update: vi.fn(async (_botId: string, memoryId: string, text: string) => ({ id: memoryId, text, createdAt: 2 })),
      remove: vi.fn(async () => {}),
    }

    renderManager(actions)

    expect(actions.list).toHaveBeenCalledWith(bot.id)
    const row = await screen.findByRole('listitem', { name: /memory-one/ })
    expect(within(row).getByText('Keep handoffs concise.')).toBeTruthy()

    fireEvent.click(within(row).getByRole('button', { name: 'Edit memory memory-one' }))
    const editor = within(row).getByRole('textbox', { name: 'Memory text' })
    fireEvent.change(editor, { target: { value: 'Keep reviews concise.' } })
    fireEvent.click(within(row).getByRole('button', { name: 'Save memory' }))

    await waitFor(() => {
      expect(actions.update).toHaveBeenCalledWith(bot.id, 'memory-one', 'Keep reviews concise.')
    })
    expect(within(row).getByText('Keep reviews concise.')).toBeTruthy()

    fireEvent.click(within(row).getByRole('button', { name: 'Remove memory memory-one' }))
    expect(screen.getByRole('heading', { name: 'Remove memory?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove memory' }))

    await waitFor(() => { expect(actions.remove).toHaveBeenCalledWith(bot.id, 'memory-one') })
    expect(screen.queryByRole('listitem', { name: /memory-one/ })).toBeNull()
  })

  it('keeps the loaded memory visible and reports an edit failure', async () => {
    const actions: BotMemoryManagerActions = {
      list: vi.fn(async () => [{ id: 'memory-one', text: 'Keep handoffs concise.', createdAt: 1 }]),
      update: vi.fn(async () => { throw new Error('memory service unavailable') }),
      remove: vi.fn(async () => {}),
    }

    renderManager(actions)
    const row = await screen.findByRole('listitem', { name: /memory-one/ })
    fireEvent.click(within(row).getByRole('button', { name: 'Edit memory memory-one' }))
    fireEvent.change(within(row).getByRole('textbox', { name: 'Memory text' }), { target: { value: 'New text' } })
    fireEvent.click(within(row).getByRole('button', { name: 'Save memory' }))

    expect((await screen.findByRole('alert')).textContent).toContain('The memory could not be saved. Try again.')
    expect(within(row).getByRole('textbox', { name: 'Memory text' }).value).toBe('New text')
  })

  it('keeps the remove confirmation open and reports a removal failure inside it', async () => {
    const actions: BotMemoryManagerActions = {
      list: vi.fn(async () => [{ id: 'memory-one', text: 'Keep handoffs concise.', createdAt: 1 }]),
      update: vi.fn(async (_botId: string, memoryId: string, text: string) => ({ id: memoryId, text, createdAt: 2 })),
      remove: vi.fn(async () => { throw new Error('memory service unavailable') }),
    }

    renderManager(actions)
    const row = await screen.findByRole('listitem', { name: /memory-one/ })
    fireEvent.click(within(row).getByRole('button', { name: 'Remove memory memory-one' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove memory' }))

    expect((await screen.findByRole('alert')).textContent).toContain('The memory could not be removed. Try again.')
    expect(screen.getByRole('heading', { name: 'Remove memory?' })).toBeTruthy()
    expect(screen.getByRole('listitem', { name: /memory-one/ })).toBeTruthy()
  })
})
