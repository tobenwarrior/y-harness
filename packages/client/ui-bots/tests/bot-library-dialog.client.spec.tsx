// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BotId, type BotLibraryItem, type BotLibraryValue } from '@yharness/bots/client'
import { makeTranslate } from '@yharness/client-test-runtime'
import { SessionId } from '@yharness/session/types'
import { BotDetail } from '../src/client/BotWorkspace.tsx'
import type { ReadBotLibrary } from '../src/client/BotLibraryDialog.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

const t = makeTranslate(en)
const botId = BotId('bot-fixture')
const sessionId = SessionId('bot-session-fixture')
const archive = { eventSeq: 5, fileIndex: 2 }
const row = (patch: Partial<BotLibraryItem> = {}): BotLibraryItem => ({
  botId, sessionId, ...archive, label: 'notes.md', category: 'file', previewable: false,
  createdAt: new Date(2026, 10, 25, 9).getTime(), ...patch,
})

function openLibrary(read: ReadBotLibrary, previewUrl?: (session: string, seq: number, index: number) => string): void {
  render(<BotDetail bot={{ id: botId, name: 'Scout', accent: 'teal', identity: 'browse' }}
    loading={false} loadAvatar={undefined} children={<p>Existing conversation</p>} readLibrary={read}
    downloadLibraryFile={(session, seq, index) => `api/present.download?sessionId=${session}&seq=${seq}&index=${index}`}
    {...(previewUrl === undefined ? {} : { previewLibraryFile: previewUrl })} t={t} />)
  expect(read).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.botMenu }))
  fireEvent.click(screen.getByRole('menuitem', { name: en.libraryTitle }))
}

it('loads only when opened, filters, and appends older deliveries using the provided file cursor', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 25, 12))
  const read = vi.fn<ReadBotLibrary>()
    .mockResolvedValueOnce({ botId, items: [
      row(),
      row({ eventSeq: 6, label: 'chart.png', category: 'image' }),
      row({ eventSeq: 7, label: 'weekly.md', createdAt: new Date(2026, 10, 24, 9).getTime() }),
    ], nextBefore: archive })
    .mockResolvedValueOnce({ botId, items: [row({ eventSeq: 4, label: 'older.md', createdAt: new Date(2026, 10, 22).getTime() })] })
  openLibrary(read)
  await screen.findByRole('heading', { name: en.libraryToday })
  expect(screen.getByRole('heading', { name: en.libraryThisWeek })).toBeTruthy()
  expect(read).toHaveBeenNthCalledWith(1, botId, undefined)
  expect(screen.getByRole('link', { name: 'Download notes.md' }).getAttribute('href'))
    .toBe('api/present.download?sessionId=bot-session-fixture&seq=5&index=2')
  fireEvent.click(screen.getByRole('button', { name: en.libraryMedia }))
  expect(screen.queryByText('notes.md')).toBeNull()
  expect(screen.getByText('chart.png')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.libraryFiles }))
  expect(screen.queryByText('chart.png')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.libraryShowMore }))
  await screen.findByRole('heading', { name: en.libraryOlder })
  expect(read).toHaveBeenNthCalledWith(2, botId, archive)
  expect(screen.getByRole('link', { name: 'Download older.md' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: en.libraryShowMore })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(screen.queryByRole('dialog', { name: en.libraryTitle })).toBeNull()
  expect(screen.getByText('Existing conversation')).toBeTruthy()
})

it('retries a failed read and shows an empty library after the next response', async () => {
  const read = vi.fn<ReadBotLibrary>().mockRejectedValueOnce(new Error('fixture unavailable'))
    .mockResolvedValueOnce({ botId, items: [] })
  openLibrary(read)
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  expect(await screen.findByText(en.libraryEmpty)).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(read.mock.calls).toEqual([[botId, undefined], [botId, undefined]])
})

it('continues past an empty page when earlier messages remain', async () => {
  const read = vi.fn<ReadBotLibrary>()
    .mockResolvedValueOnce({ botId, items: [], nextBefore: archive })
    .mockResolvedValueOnce({ botId, items: [row({ eventSeq: 4 })] })
  openLibrary(read)
  await screen.findByText(en.libraryPageEmpty)
  fireEvent.click(screen.getByRole('button', { name: en.libraryShowMore }))
  expect(await screen.findByRole('link', { name: 'Download notes.md' })).toBeTruthy()
  expect(screen.queryByText(en.libraryPageEmpty)).toBeNull()
})
it.each(['success', 'error'] as const)('ignores a late %s from a closed Library request', async (settlement) => {
  const firstPage = Promise.withResolvers<BotLibraryValue>()
  const read = vi.fn<ReadBotLibrary>()
    .mockReturnValueOnce(firstPage.promise)
    .mockResolvedValueOnce({ botId, items: [row({ eventSeq: 7, label: 'current.md' })] })
  openLibrary(read)
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  fireEvent.click(screen.getByRole('button', { name: en.botMenu }))
  fireEvent.click(screen.getByRole('menuitem', { name: en.libraryTitle }))
  await screen.findByRole('link', { name: 'Download current.md' })
  await act(async () => {
    if (settlement === 'success') firstPage.resolve({ botId, items: [row({ label: 'stale.md' })] })
    else firstPage.reject(new Error('stale read failed'))
    await Promise.allSettled([firstPage.promise])
  })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByText('stale.md')).toBeNull()
  expect(screen.getByRole('link', { name: 'Download current.md' })).toBeTruthy()
})

it('previews image deliveries through the exact authenticated file coordinates', async () => {
  const read = vi.fn<ReadBotLibrary>().mockResolvedValueOnce({
    botId, items: [row({ label: 'chart.png', category: 'image', previewable: true })],
  })
  const preview = vi.fn((session: string, seq: number, index: number) =>
    `api/present.preview?sessionId=${session}&seq=${seq}&index=${index}`)
  openLibrary(read, preview)
  await screen.findByText('chart.png')
  fireEvent.click(screen.getByRole('button', { name: 'Preview chart.png' }))
  expect(preview).toHaveBeenCalledWith(sessionId, archive.eventSeq, archive.fileIndex)
  expect(screen.getByRole('dialog', { name: en.libraryPreviewDialog })).toBeTruthy()
  expect(screen.getByRole('img', { name: 'chart.png' }).getAttribute('src'))
    .toBe('api/present.preview?sessionId=bot-session-fixture&seq=5&index=2')
  fireEvent.click(screen.getByRole('button', { name: en.libraryPreviewClose }))
  expect(screen.queryByRole('dialog', { name: en.libraryPreviewDialog })).toBeNull()
})
