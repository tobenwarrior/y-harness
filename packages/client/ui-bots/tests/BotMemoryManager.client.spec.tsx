// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@yharness/client-test-runtime'
import { useState } from 'react'
import { BotMemoryManager } from '../src/client/BotMemoryManager.tsx'
import { en } from '../src/client/locales.ts'
import type { BotMemoryManagerActions, BotMemorySummary, BotSummary } from '../src/client/types.ts'

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

  it('searches note text without displaying internal memory ids', async () => {
    renderManager({
      list: vi.fn(async () => [
        { id: 'memory-one', text: 'Keep handoffs concise.', createdAt: 1 },
        { id: 'memory-two', text: 'Review quarterly notes.', createdAt: 2 },
      ]),
      update: vi.fn(),
      remove: vi.fn(),
    })

    const search = await screen.findByRole('searchbox', { name: 'Search memories' })
    expect(screen.getByText('2 saved')).toBeTruthy()
    expect(screen.queryByText('memory-one')).toBeNull()
    fireEvent.change(search, { target: { value: ' QUARTERLY ' } })
    expect(screen.getByText('Review quarterly notes.')).toBeTruthy()
    expect(screen.queryByText('Keep handoffs concise.')).toBeNull()

    fireEvent.change(search, { target: { value: 'unmatched text' } })
    expect(screen.getByText('No matching memories.')).toBeTruthy()
    fireEvent.change(search, { target: { value: '' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
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
    expect(within(row).getByRole('textbox', { name: 'Memory text' })).toHaveProperty('value', 'New text')
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

  it('retries a failed memory load through the manager controls', async () => {
    const memory: BotMemorySummary = { id: 'memory-retry', text: 'Retry this memory.', createdAt: 0 }
    const actions: BotMemoryManagerActions = {
      list: vi.fn()
        .mockRejectedValueOnce(new Error('memory service unavailable'))
        .mockResolvedValueOnce([memory]),
      update: vi.fn(),
      remove: vi.fn(),
    }

    renderManager(actions)

    expect((await screen.findByRole('alert')).textContent).toContain('The bot’s memories could not be loaded. Try again.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('listitem', { name: /memory-retry/ })).toBeTruthy()
    expect(actions.list).toHaveBeenCalledTimes(2)
  })

  it('ignores list responses that settle after the manager unmounts', async () => {
    const settled = Promise.withResolvers<readonly BotMemorySummary[]>()
    const rejected = Promise.withResolvers<readonly BotMemorySummary[]>()
    const actions: BotMemoryManagerActions = {
      list: vi.fn()
        .mockReturnValueOnce(settled.promise)
        .mockReturnValueOnce(rejected.promise),
      update: vi.fn(),
      remove: vi.fn(),
    }

    const first = renderManager(actions)
    await waitFor(() => { expect(actions.list).toHaveBeenCalledTimes(1) })
    first.unmount()
    settled.resolve([])
    await settled.promise

    const second = renderManager(actions)
    await waitFor(() => { expect(actions.list).toHaveBeenCalledTimes(2) })
    second.unmount()
    rejected.reject(new Error('stale memory load failure'))
    await rejected.promise.catch(() => undefined)
  })

  it('preserves a second draft while the first save is pending', async () => {
    const first = { id: 'memory-first', text: 'First memory.', createdAt: 1 }
    const second = { id: 'memory-second', text: 'Second memory.', createdAt: 2 }
    const pending = Promise.withResolvers<BotMemorySummary>()
    const update = vi.fn((_botId: string, memoryId: string, text: string) => memoryId === first.id
      ? pending.promise
      : Promise.resolve({ ...second, text }))
    const actions: BotMemoryManagerActions = {
      list: vi.fn(async () => [first, second]),
      update,
      remove: vi.fn(async () => {}),
    }

    const view = renderManager(actions)
    const firstRow = await screen.findByRole('listitem', { name: /memory-first/ })
    fireEvent.click(within(firstRow).getByRole('button', { name: 'Edit memory memory-first' }))
    fireEvent.change(within(firstRow).getByRole('textbox', { name: 'Memory text' }), { target: { value: 'Updated first memory.' } })
    fireEvent.click(within(firstRow).getByRole('button', { name: 'Save memory' }))
    await waitFor(() => { expect(update).toHaveBeenCalledWith(bot.id, first.id, 'Updated first memory.') })

    const secondRow = screen.getByRole('listitem', { name: /memory-second/ })
    fireEvent.click(within(secondRow).getByRole('button', { name: 'Edit memory memory-second' }))
    fireEvent.change(within(secondRow).getByRole('textbox', { name: 'Memory text' }), { target: { value: 'Updated second memory.' } })
    fireEvent.click(within(secondRow).getByRole('button', { name: 'Save memory' }))
    expect(update).toHaveBeenCalledOnce()

    const recreatedActions: BotMemoryManagerActions = {
      list: vi.fn(async () => [first, second]),
      update,
      remove: actions.remove,
    }
    view.rerender(<BotMemoryManager bot={bot} actions={recreatedActions} open onClose={vi.fn()} t={t} />)
    await waitFor(() => { expect(recreatedActions.list).toHaveBeenCalledWith(bot.id) })

    pending.resolve({ ...first, text: 'Updated first memory.', createdAt: 3 })
    expect(await screen.findByText('Updated first memory.')).toBeTruthy()
    const preservedSecondRow = screen.getByRole('listitem', { name: /memory-second/ })
    expect(within(preservedSecondRow).getByRole('textbox', { name: 'Memory text' })).toHaveProperty('value', 'Updated second memory.')
  })

  it('supports remove dialog cancellation and keeps it open while removal is pending', async () => {
    const memory: BotMemorySummary = { id: 'memory-dialog', text: 'Dialog memory.', createdAt: 1 }
    const pending = Promise.withResolvers<undefined>()
    const remove = vi.fn(() => pending.promise)
    const actions: BotMemoryManagerActions = {
      list: vi.fn(async () => [memory]),
      update: vi.fn(),
      remove,
    }

    renderManager(actions)
    const row = await screen.findByRole('listitem', { name: /memory-dialog/ })
    fireEvent.click(within(row).getByRole('button', { name: 'Remove memory memory-dialog' }))
    let confirmation = screen.getByRole('dialog', { name: 'Remove memory?' })
    fireEvent.click(within(confirmation).getAllByRole('button', { name: 'Cancel' }).at(-1)!)
    expect(screen.queryByRole('dialog', { name: 'Remove memory?' })).toBeNull()

    fireEvent.click(within(row).getByRole('button', { name: 'Remove memory memory-dialog' }))
    confirmation = screen.getByRole('dialog', { name: 'Remove memory?' })
    fireEvent.click(within(confirmation).getAllByRole('button', { name: 'Cancel' })[0]!)
    expect(screen.queryByRole('dialog', { name: 'Remove memory?' })).toBeNull()

    fireEvent.click(within(row).getByRole('button', { name: 'Remove memory memory-dialog' }))
    confirmation = screen.getByRole('dialog', { name: 'Remove memory?' })
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Remove memory' }))
    await waitFor(() => { expect(remove).toHaveBeenCalledOnce() })
    confirmation = screen.getByRole('dialog', { name: 'Remove memory?' })
    fireEvent.click(within(confirmation).getAllByRole('button', { name: 'Cancel' })[0]!)
    expect(screen.getByRole('dialog', { name: 'Remove memory?' })).toBeTruthy()
    pending.resolve(undefined)
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Remove memory?' })).toBeNull() })
  })

  it('closes the manager when its footer Close action is clicked', async () => {
    const actions: BotMemoryManagerActions = {
      list: vi.fn(async () => []),
      update: vi.fn(),
      remove: vi.fn(),
    }
    function Harness() {
      const [open, setOpen] = useState(true)
      return <BotMemoryManager bot={bot} actions={actions} open={open} onClose={() => { setOpen(false) }} t={t} />
    }

    render(<Harness />)

    const dialog = await screen.findByRole('dialog', { name: 'Bot memory' })
    const closeButtons = within(dialog).getAllByRole('button', { name: /^Close$/ })
    expect(closeButtons).toHaveLength(2)
    fireEvent.click(closeButtons.at(-1)!)

    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Bot memory' })).toBeNull() })
  })

  it('renders a memory with an invalid display date and supports cancelling its edit', async () => {
    const actions: BotMemoryManagerActions = {
      list: vi.fn(async () => [{ id: 'memory-invalid-date', text: 'Keep this note.', createdAt: Number.MAX_SAFE_INTEGER }]),
      update: vi.fn(),
      remove: vi.fn(),
    }

    renderManager(actions)

    const row = await screen.findByRole('listitem', { name: 'memory-invalid-date' })
    expect(within(row).queryByRole('time')).toBeNull()
    fireEvent.click(within(row).getByRole('button', { name: 'Edit memory memory-invalid-date' }))
    expect(within(row).getByRole('textbox', { name: 'Memory text' })).toHaveProperty('value', 'Keep this note.')
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel edit' }))
    expect(within(row).queryByRole('textbox', { name: 'Memory text' })).toBeNull()
  })

  it('removes another row without discarding the active draft', async () => {
    const memories: readonly BotMemorySummary[] = [
      { id: 'memory-editing', text: 'Keep the draft.', createdAt: 1 },
      { id: 'memory-remove', text: 'Remove this row.', createdAt: 2 },
    ]
    const actions: BotMemoryManagerActions = {
      list: vi.fn(async () => memories),
      update: vi.fn(),
      remove: vi.fn(async () => {}),
    }

    renderManager(actions)

    const editingRow = await screen.findByRole('listitem', { name: 'memory-editing' })
    const removeRow = screen.getByRole('listitem', { name: 'memory-remove' })
    fireEvent.click(within(editingRow).getByRole('button', { name: 'Edit memory memory-editing' }))
    fireEvent.change(within(editingRow).getByRole('textbox', { name: 'Memory text' }), { target: { value: 'Draft stays here.' } })
    fireEvent.click(within(removeRow).getByRole('button', { name: 'Remove memory memory-remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove memory' }))

    await waitFor(() => { expect(actions.remove).toHaveBeenCalledWith(bot.id, 'memory-remove') })
    expect(within(editingRow).getByRole('textbox', { name: 'Memory text' })).toHaveProperty('value', 'Draft stays here.')
    expect(screen.queryByRole('listitem', { name: 'memory-remove' })).toBeNull()
  })

  it('ignores a second confirmation click while removal is pending', async () => {
    const pending = Promise.withResolvers<undefined>()
    const memory: BotMemorySummary = { id: 'memory-pending', text: 'Pending removal.', createdAt: 1 }
    const remove = vi.fn(() => pending.promise)
    const actions: BotMemoryManagerActions = {
      list: vi.fn(async () => [memory]),
      update: vi.fn(),
      remove,
    }

    renderManager(actions)

    const row = await screen.findByRole('listitem', { name: 'memory-pending' })
    fireEvent.click(within(row).getByRole('button', { name: 'Remove memory memory-pending' }))
    const confirmation = screen.getByRole('dialog', { name: 'Remove memory?' })
    const confirm = within(confirmation).getByRole('button', { name: 'Remove memory' })
    fireEvent.click(confirm)
    await waitFor(() => { expect(remove).toHaveBeenCalledOnce() })
    fireEvent.click(confirm)
    expect(remove).toHaveBeenCalledOnce()
    pending.resolve(undefined)
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Remove memory?' })).toBeNull() })
  })

})
