// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { brandString } from '@yharness/brand'
import { type BotGroupId, type BotGroupMessageId, type BotGroupMessageSearchValue } from '@yharness/bots/client'
import { makeTranslate } from '@yharness/client-test-runtime'
import { en } from '../src/client/locales.ts'
import { SharedGroupSearch } from '../src/client/SharedGroupSearch.tsx'

afterEach(cleanup)

const originalScrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
})
afterAll(() => {
  if (originalScrollIntoViewDescriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  else Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoViewDescriptor)
})

const hit = {
  groupId: brandString<BotGroupId>('bot-group-research'),
  groupName: 'Research room',
  messageId: brandString<BotGroupMessageId>('bot-group-message-first'),
  snippet: 'A recent source finding',
}
const olderHit = {
  ...hit,
  messageId: brandString<BotGroupMessageId>('bot-group-message-older'),
  snippet: 'An earlier source finding',
}
const t = makeTranslate(en)

function setup(search: Parameters<typeof SharedGroupSearch>[0]['search']) {
  const onSelect = vi.fn()
  render(<SharedGroupSearch search={search} onSelect={onSelect} t={t} />)
  return { onSelect, field: screen.getByRole('searchbox', { name: en.sharedGroupSearch }) }
}

it('appends an older page and retains exact room and message identity for keyboard selection', async () => {
  const next = Promise.withResolvers<BotGroupMessageSearchValue>()
  const search = vi.fn().mockResolvedValueOnce({ items: [hit], hasMore: true }).mockReturnValueOnce(next.promise)
  const { field, onSelect } = setup(search)
  expect(document.activeElement).toBe(field)
  fireEvent.keyDown(field, { key: 'Enter' })
  fireEvent.change(field, { target: { value: ' source ' } })
  await screen.findByText(hit.snippet)
  expect(search).toHaveBeenNthCalledWith(1, { query: 'source' })

  fireEvent.click(screen.getByRole('button', { name: en.sharedGroupSearchOlder }))
  expect(search).toHaveBeenNthCalledWith(2, { query: 'source', before: { groupId: hit.groupId, messageId: hit.messageId } })
  expect(screen.getByRole('button', { name: en.searchChatsLoading })).toHaveProperty('disabled', true)
  await act(async () => { next.resolve({ items: [olderHit], hasMore: false }) })
  const olderResult = screen.getByRole('button', { name: /Research room.*earlier source/ })
  expect(document.activeElement).toBe(olderResult)
  const first = screen.getByRole('button', { name: /Research room.*recent source/ })
  fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
  fireEvent.keyDown(field, { key: 'Home' })
  expect(onSelect).not.toHaveBeenCalled()
  fireEvent.keyDown(field, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(first)
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(onSelect).toHaveBeenCalledWith(hit)
  fireEvent.click(screen.getByRole('button', { name: /Research room.*earlier source/ }))
  expect(onSelect).toHaveBeenLastCalledWith(olderHit)
  expect(screen.queryByRole('button', { name: en.sharedGroupSearchOlder })).toBeNull()
})

it.each(['resolve', 'reject'] as const)('discards an older query when it settles with %s', async (outcome) => {
  const pending = Promise.withResolvers<BotGroupMessageSearchValue>()
  const search = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ items: [], hasMore: false })
  const { field } = setup(search)
  fireEvent.change(field, { target: { value: 'early' } })
  await vi.waitFor(() => { expect(search).toHaveBeenCalledWith({ query: 'early' }) })
  fireEvent.change(field, { target: { value: 'later' } })
  await screen.findByText(en.searchChatsEmpty)
  await act(async () => {
    if (outcome === 'resolve') pending.resolve({ items: [hit], hasMore: false })
    else pending.reject(new Error('synthetic stale error'))
  })
  expect(screen.queryByText(hit.snippet)).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['resolve', 'reject'] as const)('discards a stale older page after the query changes (%s)', async (outcome) => {
  const older = Promise.withResolvers<BotGroupMessageSearchValue>()
  const search = vi.fn()
    .mockResolvedValueOnce({ items: [hit], hasMore: true })
    .mockReturnValueOnce(older.promise)
    .mockResolvedValueOnce({ items: [], hasMore: false })
  const { field } = setup(search)
  fireEvent.change(field, { target: { value: 'source' } })
  await screen.findByText(hit.snippet)
  const olderButton = screen.getByRole('button', { name: en.sharedGroupSearchOlder })
  fireEvent.click(olderButton)
  fireEvent.change(field, { target: { value: 'later' } })
  await screen.findByText(en.searchChatsEmpty)
  await act(async () => {
    if (outcome === 'resolve') older.resolve({ items: [olderHit], hasMore: false })
    else older.reject(new Error('synthetic stale older-page error'))
    await Promise.resolve()
  })
  expect(screen.queryByText(olderHit.snippet)).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('does not request an older page without a result cursor', async () => {
  const search = vi.fn().mockResolvedValue({ items: [], hasMore: true })
  const { field } = setup(search)
  fireEvent.change(field, { target: { value: 'empty' } })
  await screen.findByText(en.searchChatsEmpty)
  fireEvent.click(screen.getByRole('button', { name: en.sharedGroupSearchOlder }))
  expect(search).toHaveBeenCalledTimes(1)
})

it('does not restart a search when only input spacing changes', async () => {
  const search = vi.fn().mockResolvedValue({ items: [hit], hasMore: false })
  const { field } = setup(search)
  fireEvent.change(field, { target: { value: 'source' } })
  await screen.findByText(hit.snippet)
  fireEvent.change(field, { target: { value: ' source ' } })
  await new Promise(resolve => setTimeout(resolve, 220))
  expect(search).toHaveBeenCalledTimes(1)
})

it('keeps the current matches available after an older page fails', async () => {
  const search = vi.fn().mockRejectedValueOnce(new Error('synthetic unavailable search'))
    .mockResolvedValueOnce({ items: [hit], hasMore: true }).mockRejectedValueOnce(new Error('synthetic unavailable page'))
    .mockResolvedValueOnce({ items: [olderHit], hasMore: false })
  const { field } = setup(search)
  fireEvent.change(field, { target: { value: 'wrong' } })
  expect((await screen.findByRole('alert')).textContent).toBe(en.sharedGroupSearchError)
  fireEvent.change(field, { target: { value: 'source' } })
  await screen.findByText(hit.snippet)
  fireEvent.click(screen.getByRole('button', { name: en.sharedGroupSearchOlder }))
  expect((await screen.findByRole('alert')).textContent).toBe(en.sharedGroupSearchOlderError)
  expect(screen.getByText(hit.snippet)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.sharedGroupSearchOlder }))
  expect(await screen.findByText(olderHit.snippet)).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
})
