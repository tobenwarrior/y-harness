import { describe, expect, it } from 'vitest'
import {
  BOT_LIBRARY_READ_CHUNK,
  readBotLibraryPage,
  type BotLibraryEvent,
  type BotLibraryEventReader,
} from '../src/library.ts'
import { readLibraryLinks } from '../src/library-links.ts'
import { BotId } from '../src/types.ts'
import { SessionId } from '@yharness/session'

const botId = BotId('bot-library')
const sessionId = SessionId('bot-session-library')

function presented(seq: number, time: number, files: readonly Record<string, unknown>[]): BotLibraryEvent {
  return { seq, time, type: 'deliverables/presented', data: { files } }
}

function reader(events: readonly BotLibraryEvent[], eventCount = events.length): BotLibraryEventReader & { reads: number[][] } {
  const reads: number[][] = []
  return {
    eventCount,
    reads,
    async read(offset, length) {
      reads.push([offset, length])
      return events.filter(event => event.seq >= offset && event.seq < offset + length)
    },
  }
}

describe('Bot Library event projection', () => {
  it('returns newest presented files with safe labels, categories, and stable download coordinates', async () => {
    const longDescription = 'a'.repeat(200)
    const source = reader([
      { seq: 0, time: 1, type: 'assistant/message', data: {} },
      presented(1, 2, [
        { path: '' },
        { path: '/private/research/report.pdf' },
        { path: 'assets/photo.PNG' },
        { path: 'sounds/clip.MP3' },
        { path: 'video/movie.MP4' },
        { path: '/tmp/ignored.txt', description: longDescription },
        { path: '/', description: '   ' },
        { path: '', description: 'not admitted' },
        { path: 'bad', description: 42 },
      ]),
      presented(2, 3, [{ path: 'notes/summary.md', description: '  Weekly summary\n' }]),
    ])

    const page = await readBotLibraryPage(botId, sessionId, source, 4)

    expect(page.items).toEqual([
      expect.objectContaining({ eventSeq: 2, fileIndex: 0, label: 'Weekly summary', category: 'file', createdAt: 3 }),
      expect.objectContaining({ eventSeq: 1, fileIndex: 6, label: 'Presented file', category: 'file', createdAt: 2 }),
      expect.objectContaining({ eventSeq: 1, fileIndex: 5, label: `${'a'.repeat(159)}…`, category: 'file' }),
      expect.objectContaining({ eventSeq: 1, fileIndex: 4, label: 'movie.MP4', category: 'video' }),
    ])
    expect(page.nextBefore).toEqual({ eventSeq: 1, fileIndex: 4 })
    expect(page.items.every(item => !item.label.includes('/'))).toBe(true)
    expect(source.reads.every(read => (read[1] ?? 0) <= BOT_LIBRARY_READ_CHUNK)).toBe(true)

    const media = await readBotLibraryPage(botId, sessionId, source, 3, page.nextBefore)
    expect(media.items.map(item => [item.fileIndex, item.category, item.label])).toEqual([
      [3, 'audio', 'clip.MP3'],
      [2, 'image', 'photo.PNG'],
      [1, 'file', 'report.pdf'],
    ])
  })

  it('lists links from settled Bot replies through the same cursor as presented files', async () => {
    const content = [{ type: 'text', text: [
      '[Release notes](https://docs.example.com/release)',
      'Read https://status.example.com/ today.',
      '[Runbook][runbook]',
      '[runbook]: https://support.example.com/runbook',
      '[Unsafe](javascript:alert(1)) [Credentials](https://account:password@example.com/login)',
      '![Picture](https://images.example.com/test.png)',
      '`https://code.example.com/snippet`',
    ].join('\n\n') }, { type: 'reasoning', text: 'Private https://reasoning.example.com/' }]
    const source = reader([
      { seq: 0, time: 1, type: 'user/message', data: { message: { content } } },
      presented(1, 2, [{ path: 'report.txt' }]),
      { seq: 2, time: 3, type: 'assistant/message', data: { message: { content } } },
    ])
    const first = await readBotLibraryPage(botId, sessionId, source, 2)
    expect(first.items).toEqual([
      expect.objectContaining({ category: 'link', label: 'Runbook', url: 'https://support.example.com/runbook', eventSeq: 2, fileIndex: 2 }),
      expect.objectContaining({ category: 'link', url: 'https://status.example.com/', eventSeq: 2, fileIndex: 1 }),
    ])
    expect(first.nextBefore).toEqual({ eventSeq: 2, fileIndex: 1 })
    const next = await readBotLibraryPage(botId, sessionId, source, 4, first.nextBefore)
    expect(next.items).toEqual([
      expect.objectContaining({ category: 'link', label: 'Release notes', url: 'https://docs.example.com/release', eventSeq: 2, fileIndex: 0 }),
      expect.objectContaining({ category: 'file', label: 'report.txt', eventSeq: 1, fileIndex: 0 }),
    ])
    expect(next.nextBefore).toBeUndefined()
  })

  it('keeps labels plain and bounds duplicates, URLs, and oversized replies', () => {
    const response = [
      '[**Runbook** `index`](https://docs.example.com/)',
      'https://docs.example.com/',
      '[invalid](https://)',
      `[too long](https://docs.example.com/${'x'.repeat(2_048)})`,
      `[${'x'.repeat(200)}](https://status.example.com/)`,
      ...Array.from({ length: 40 }, (_, index) => `[item](https://items.example.com/${index})`),
    ].join('\n\n')
    const links = readLibraryLinks(response)
    expect(links).toHaveLength(32)
    expect(links.slice(0, 2)).toEqual([
      { label: 'Runbook index', url: 'https://docs.example.com/' },
      { label: `${'x'.repeat(159)}…`, url: 'https://status.example.com/' },
    ])
    expect(readLibraryLinks(`${'z'.repeat(64 * 1024)} https://docs.example.com/`)).toEqual([])
    expect(readLibraryLinks(`[Encoded path](https://docs.example.com/${'é'.repeat(500)})`)).toEqual([])
    expect(readLibraryLinks('No links here.')).toEqual([])
  })

  it('seeks through files sharing one event and then older events without duplicates', async () => {
    const source = reader([
      presented(0, 10, [{ path: 'zero.txt' }]),
      presented(1, 11, [{ path: 'one-a.txt' }, { path: 'one-b.txt' }]),
      presented(2, 12, [{ path: 'two.txt' }]),
    ])

    const first = await readBotLibraryPage(botId, sessionId, source, 2)
    expect(first.items.map(item => [item.eventSeq, item.fileIndex])).toEqual([[2, 0], [1, 1]])
    expect(first.nextBefore).toEqual({ eventSeq: 1, fileIndex: 1 })

    const second = await readBotLibraryPage(botId, sessionId, source, 2, first.nextBefore)
    expect(second.items.map(item => [item.eventSeq, item.fileIndex])).toEqual([[1, 0], [0, 0]])
    expect(second.nextBefore).toBeUndefined()

    const third = await readBotLibraryPage(botId, sessionId, source, 2, { eventSeq: 0, fileIndex: 0 })
    expect(third.items).toEqual([])
  })

  it('handles empty and malformed reads, bounded cursors, and cancellation', async () => {
    const empty = reader([], 0)
    await expect(readBotLibraryPage(botId, sessionId, empty, 1)).resolves.toEqual({ botId, items: [] })

    const noRead = {
      eventCount: 3,
      async read() {
        return []
      },
    }
    await expect(readBotLibraryPage(botId, sessionId, noRead, 1)).resolves.toEqual({ botId, items: [] })

    const controller = new AbortController()
    controller.abort()
    await expect(readBotLibraryPage(botId, sessionId, reader([presented(0, 1, [{ path: 'x' }])]), 1, undefined, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('returns an older cursor when a sparse history needs another bounded read', async () => {
    const source = reader([
      presented(0, 0, [{ path: 'oldest.txt' }]),
      ...Array.from({ length: 256 }, (_, offset) => ({
        seq: offset + 1,
        time: offset + 1,
        type: 'assistant/message',
        data: {},
      })),
    ])

    const first = await readBotLibraryPage(botId, sessionId, source, 1)
    expect(first.items).toEqual([])
    expect(first.nextBefore).toEqual({ eventSeq: 1, fileIndex: 0 })
    expect(source.reads).toEqual([[193, 64], [129, 64], [65, 64], [1, 64]])

    const second = await readBotLibraryPage(botId, sessionId, source, 1, first.nextBefore)
    expect(second.items).toEqual([expect.objectContaining({ eventSeq: 0, fileIndex: 0, label: 'oldest.txt' })])
    expect(second.nextBefore).toBeUndefined()
  })

  it('caps a fallback basename without exposing its source path', async () => {
    const source = reader([presented(0, 1, [{ path: `/tmp/${'b'.repeat(200)}.txt` }])])
    const page = await readBotLibraryPage(botId, sessionId, source, 1)
    expect(page.items[0]?.label).toBe(`${'b'.repeat(159)}…`)
    expect(page.items[0]?.label).not.toContain('/')

    const describedPath = reader([presented(0, 1, [{ path: 'report.txt', description: '/private/report' }])])
    const describedPage = await readBotLibraryPage(botId, sessionId, describedPath, 1)
    expect(describedPage.items[0]?.label).toBe('private report')
  })

  it('rejects whitespace-only paths while preserving original file indices', async () => {
    const source = reader([presented(0, 1, [
      { path: '   ' },
      { path: 'report.txt' },
    ])])
    const page = await readBotLibraryPage(botId, sessionId, source, 1)
    expect(page.items).toEqual([expect.objectContaining({ fileIndex: 1, label: 'report.txt' })])
  })
})
