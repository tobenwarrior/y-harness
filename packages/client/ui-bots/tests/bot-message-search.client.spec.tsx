// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BotId, type BotMessageSearchValue, type BotView } from '@yharness/bots/client'
import { makeTranslate } from '@yharness/client-test-runtime'
import { SessionId, SessionSeq } from '@yharness/session/types'
import { BotMessageSearchDialog } from '../src/client/BotMessageSearchDialog.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(en)
const bot: BotView = {
  id: BotId('bot-example'),
  sessionId: SessionId('bot-example-session'),
  name: 'Archive Scout',
  identity: 'browse',
  accent: 'teal',
  cwd: '/fixture',
  state: 'active',
  createdAt: 1,
  updatedAt: 1,
  availability: 'idle',
  pinned: false,
  hidden: false,
}

const match = { botId: bot.id, sessionId: bot.sessionId, seq: SessionSeq(42), snippet: 'Earlier match' }

function setup(search: (term: string) => Promise<BotMessageSearchValue>) {
  const openResult = vi.fn()
  const setOpen = vi.fn()
  render(<BotMessageSearchDialog
    bots={[bot]}
    actions={{ search, openResult, setOpen }}
    loadAvatar={async () => ''}
    t={t}
  />)
  return { input: screen.getByRole('searchbox', { name: en.searchChatMessages }), openResult, setOpen }
}

it('shows an authorized hit and opens its exact Session sequence with the keyboard', async () => {
  const search = vi.fn().mockResolvedValue({
    items: [
      match,
      { ...match, seq: SessionSeq(43), snippet: 'Later match' },
      { ...match, sessionId: SessionId('unrelated-session'), snippet: 'Unrelated chat' },
    ],
    hasMore: true,
  })
  const { input, openResult, setOpen } = setup(search)
  expect(search).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(openResult).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: ' earlier ' } })
  expect(screen.getByText(en.searchChatsLoading)).toBeTruthy()
  const result = await screen.findByRole('button', { name: /Archive Scout.*Earlier match/ })
  expect(search).toHaveBeenCalledWith('earlier')
  expect(screen.queryByText('Unrelated chat')).toBeNull()
  expect(screen.getByText(en.searchChatsMore)).toBeTruthy()
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  expect(openResult).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Home' })
  expect(openResult).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(result)
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(openResult).toHaveBeenCalledWith(match)
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(setOpen).toHaveBeenCalledWith(false)
})

it.each(['resolve', 'reject'] as const)('keeps an older search from replacing the current query when it settles with %s', async (outcome) => {
  const first = Promise.withResolvers<BotMessageSearchValue>()
  const search = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ items: [], hasMore: false })
  const { input } = setup(search)
  fireEvent.change(input, { target: { value: 'first' } })
  await vi.waitFor(() => { expect(search).toHaveBeenCalledWith('first') })
  fireEvent.change(input, { target: { value: 'second' } })
  await screen.findByText(en.searchChatsEmpty)
  await act(async () => {
    if (outcome === 'resolve') first.resolve({ items: [match], hasMore: false })
    else first.reject(new Error('synthetic stale search error'))
  })
  expect(screen.queryByText(match.snippet)).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByText(en.searchChatsEmpty)).toBeTruthy()
})

it('shows a localized error while leaving the query editable', async () => {
  const search = vi.fn().mockRejectedValueOnce(new Error('synthetic server detail'))
    .mockResolvedValueOnce({ items: [match], hasMore: false })
  const { input } = setup(search)
  fireEvent.change(input, { target: { value: 'wrong' } })
  expect((await screen.findByRole('alert')).textContent).toBe(en.searchChatsError)
  fireEvent.change(input, { target: { value: 'another' } })
  await screen.findByText(match.snippet)
  expect(screen.queryByRole('alert')).toBeNull()
})
