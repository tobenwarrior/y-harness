// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BotId, type BotLibraryFileItem, type BotLibraryValue } from '@yharness/bots/client'
import { makeTranslate } from '@yharness/client-test-runtime'
import { SessionId } from '@yharness/session/types'
import { BotDetail } from '../src/client/BotWorkspace.tsx'
import type { ReadBotLibrary, ReadGrokBotLibrary } from '../src/client/BotLibraryDialog.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

const t = makeTranslate(en)
const botId = BotId('bot-fixture')
const sessionId = SessionId('bot-session-fixture')
const archive = { eventSeq: 5, fileIndex: 2 }
const row = (patch: Partial<BotLibraryFileItem> = {}): BotLibraryFileItem => ({
  botId, sessionId, ...archive, label: 'notes.md', category: 'file', createdAt: new Date(2026, 10, 25, 9).getTime(), ...patch,
})

function openLibrary(read: ReadBotLibrary, readImported?: ReadGrokBotLibrary): void {
  render(<BotDetail bot={{ id: botId, name: 'Scout', accent: 'teal', identity: 'browse' }}
    loading={false} loadAvatar={undefined} children={<p>Existing conversation</p>} readLibrary={read} readGrokLibrary={readImported}
    downloadLibraryFile={(session, seq, index) => `api/present.download?sessionId=${session}&seq=${seq}&index=${index}`} t={t} />)
  expect(read).not.toHaveBeenCalled()
  if (readImported !== undefined) expect(readImported).not.toHaveBeenCalled()
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

it('adds imported links and verified files to the existing Library filters', async () => {
  const read = vi.fn<ReadBotLibrary>().mockResolvedValue({ botId, items: [row()] })
  const source = { botId, origin: 'grok-history' as const, sourceId: 'archive-fixture', sourceSequence: 2, itemIndex: 0, createdAt: null }
  const readImported = vi.fn<ReadGrokBotLibrary>().mockResolvedValue({ botId, items: [
    { ...source, category: 'file', label: 'Recovered plan.pdf' },
    { ...source, sourceSequence: 1, category: 'link', label: 'Recovered runbook', url: 'https://docs.example.com/archive' },
  ] })
  openLibrary(read, readImported)
  const recovered = await screen.findByRole('link', { name: 'Download Recovered plan.pdf' })
  expect(recovered.getAttribute('href')).toBe('/api/bots/grokHistory/downloadAttachment?botId=bot-fixture&sourceId=archive-fixture&sourceSequence=2')
  expect(screen.getByRole('link', { name: 'Download notes.md' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: en.libraryUndated })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.libraryLinks }))
  const link = screen.getByRole('link', { name: 'Open Recovered runbook' })
  expect(link.getAttribute('href')).toBe('https://docs.example.com/archive')
  expect(link.textContent).toContain(en.libraryImportedGrok)
  expect(screen.queryByRole('link', { name: 'Download Recovered plan.pdf' })).toBeNull()
  expect(readImported).toHaveBeenCalledExactlyOnceWith(botId, undefined)
})

it('keeps current items visible and continues with the imported page cursor after a retry', async () => {
  const read = vi.fn<ReadBotLibrary>().mockResolvedValue({ botId, items: [row()] })
  const before = { sourceId: 'primary', sourceSequence: 2, itemIndex: 0 }
  const source = { ...before, botId, origin: 'grok-history' as const, createdAt: null, category: 'file' as const }
  const readImported = vi.fn<ReadGrokBotLibrary>()
    .mockRejectedValueOnce(new Error('fixture unavailable'))
    .mockResolvedValueOnce({ botId, items: [{ ...source, label: 'Imported.pdf' }], nextBefore: before })
    .mockResolvedValueOnce({ botId, items: [{ ...source, sourceSequence: 1, label: 'Older.pdf' }] })
  openLibrary(read, readImported)
  expect((await screen.findByRole('alert')).textContent).toContain(en.libraryImportedLoadFailed)
  expect(await screen.findByRole('link', { name: 'Download notes.md' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  await screen.findByRole('link', { name: 'Download Imported.pdf' })
  fireEvent.click(screen.getByRole('button', { name: en.libraryShowMore }))
  await screen.findByRole('link', { name: 'Download Older.pdf' })
  expect(readImported.mock.calls).toEqual([[botId, undefined], [botId, undefined], [botId, before]])
  expect(read).toHaveBeenCalledOnce()
})

it('filters web links and opens them without using the file download route', async () => {
  const url = 'https://docs.example.com/release'
  const read = vi.fn<ReadBotLibrary>().mockResolvedValue({ botId, items: [
    row(), row({ eventSeq: 6, label: 'chart.png', category: 'image' }),
    { ...row({ eventSeq: 7, label: 'Release notes' }), category: 'link', url },
  ] })
  openLibrary(read)
  const link = await screen.findByRole('link', { name: 'Open Release notes' })
  expect(link.getAttribute('href')).toBe(url)
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  expect(link.hasAttribute('data-yh-open-external')).toBe(true)
  expect(link.hasAttribute('download')).toBe(false)
  expect(screen.getByText('docs.example.com')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.libraryMedia }))
  expect(screen.queryByRole('link', { name: 'Open Release notes' })).toBeNull()
  expect(screen.getByRole('link', { name: 'Download chart.png' }).hasAttribute('data-yh-open-external')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: en.libraryLinks }))
  expect(screen.getAllByRole('link')).toHaveLength(1)
  expect(screen.getByRole('link', { name: 'Open Release notes' })).toBeTruthy()
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
