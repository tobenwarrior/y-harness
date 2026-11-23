// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BotId, type BotLibraryItem } from '@yharness/bots/client'
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
  botId, sessionId, ...archive, label: 'notes.md', category: 'file', createdAt: new Date(2026, 10, 25, 9).getTime(), ...patch,
})

function openLibrary(read: ReadBotLibrary): void {
  render(<BotDetail bot={{ id: botId, name: 'Scout', accent: 'teal', identity: 'browse' }}
    loading={false} loadAvatar={undefined} children={<p>Existing conversation</p>} readLibrary={read} downloadLibraryFile={(session, seq, index) => `api/present.download?sessionId=${session}&seq=${seq}&index=${index}`} t={t} />)
  expect(read).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.botMenu }))
  fireEvent.click(screen.getByRole('menuitem', { name: en.libraryTitle }))
}

it('loads only when opened, filters, and appends older deliveries using the provided file cursor', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 25, 12))
  const read = vi.fn<ReadBotLibrary>()
    .mockResolvedValueOnce({ botId, items: [row(), row({ eventSeq: 6, label: 'chart.png', category: 'image' })], nextBefore: archive })
    .mockResolvedValueOnce({ botId, items: [row({ eventSeq: 4, label: 'older.md', createdAt: new Date(2026, 10, 22).getTime() })] })
  openLibrary(read)
  await screen.findByRole('heading', { name: en.libraryToday })
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
