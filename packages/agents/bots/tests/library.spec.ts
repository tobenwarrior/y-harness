import { describe, expect, it } from 'vitest'
import {
  BOT_LIBRARY_READ_CHUNK,
  readBotLibraryPage,
  type BotLibraryEvent,
  type BotLibraryEventReader,
} from '../src/library.ts'
import { listBotGrokLibraryAttachmentPositions, readBotGrokLibraryPage } from '../src/grok-library.ts'
import { readLibraryLinks } from '../src/library-links.ts'
import { BotId, type BotGrokHistoryArchive } from '../src/types.ts'
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

describe('Imported Grok Bot Library projection', () => {
  const archive: BotGrokHistoryArchive = {
    source: 'grok-bot',
    version: 2,
    firstCachedSequence: 1,
    messages: [
      { sourceSequence: 1, role: 'assistant', text: '[Primary](https://primary.example/one)', timestampMs: 1_001 },
      { sourceSequence: 2, role: 'attachment', text: 'primary.pdf', timestampMs: 1_002 },
      {
        sourceSequence: 3,
        role: 'assistant',
        text: '[First](https://primary.example/first) [Second](https://primary.example/second)',
        timestampMs: 1_003,
      },
    ],
    sources: [{
      id: 'builder',
      label: 'Bot builder',
      firstCachedSequence: 0,
      messages: [
        { sourceSequence: 0, role: 'attachment', text: 'builder.png', timestampMs: null },
        { sourceSequence: 1, role: 'assistant', text: '[Builder](https://builder.example/)', timestampMs: 2_001 },
      ],
    }],
  }

  it('projects only bounded links and verified attachment positions with their archive source', () => {
    const page = readBotGrokLibraryPage(BotId('bot-imported-library'), archive, [
      { sourceId: 'primary', sourceSequence: 2 },
      { sourceId: 'builder', sourceSequence: 0 },
      { sourceId: 'primary', sourceSequence: 2 },
    ], 10)

    expect(page.items).toEqual([
      expect.objectContaining({
        origin: 'grok-history', sourceId: 'builder', sourceSequence: 1, itemIndex: 0,
        sourceLabel: 'Bot builder', category: 'link', url: 'https://builder.example/', createdAt: 2_001,
      }),
      expect.objectContaining({
        origin: 'grok-history', sourceId: 'primary', sourceSequence: 3, itemIndex: 1,
        category: 'link', url: 'https://primary.example/second', createdAt: 1_003,
      }),
      expect.objectContaining({
        origin: 'grok-history', sourceId: 'primary', sourceSequence: 3, itemIndex: 0,
        category: 'link', url: 'https://primary.example/first', createdAt: 1_003,
      }),
      expect.objectContaining({
        origin: 'grok-history', sourceId: 'primary', sourceSequence: 2, itemIndex: 0,
        category: 'file', label: 'primary.pdf', createdAt: 1_002,
      }),
      expect.objectContaining({
        origin: 'grok-history', sourceId: 'primary', sourceSequence: 1, itemIndex: 0,
        category: 'link', url: 'https://primary.example/one', createdAt: 1_001,
      }),
      expect.objectContaining({
        origin: 'grok-history', sourceId: 'builder', sourceSequence: 0, itemIndex: 0,
        sourceLabel: 'Bot builder', category: 'image', label: 'builder.png', createdAt: null,
      }),
    ])
    expect(page.items.every(item => item.botId === BotId('bot-imported-library'))).toBe(true)
    expect(page.items.every(item => item.label.length <= 160 && !item.label.includes('/'))).toBe(true)
  })

  it('uses timestamp and source coordinates for stable pages and does not mutate the archive', () => {
    const first = readBotGrokLibraryPage(BotId('bot-imported-library'), archive, [
      { sourceId: 'primary', sourceSequence: 2 },
      { sourceId: 'builder', sourceSequence: 0 },
    ], 2)
    expect(first.items.map(item => [item.sourceId, item.sourceSequence, item.itemIndex])).toEqual([
      ['builder', 1, 0], ['primary', 3, 1],
    ])
    expect(first.nextBefore).toEqual({ sourceId: 'primary', sourceSequence: 3, itemIndex: 1, createdAt: 1_003 })

    const second = readBotGrokLibraryPage(BotId('bot-imported-library'), archive, [
      { sourceId: 'primary', sourceSequence: 2 },
      { sourceId: 'builder', sourceSequence: 0 },
    ], 4, first.nextBefore)
    expect(second.items.map(item => [item.sourceId, item.sourceSequence, item.itemIndex])).toEqual([
      ['primary', 3, 0], ['primary', 2, 0], ['primary', 1, 0], ['builder', 0, 0],
    ])
    expect(second.nextBefore).toBeUndefined()

    const repeat = readBotGrokLibraryPage(BotId('bot-imported-library'), archive, [
      { sourceId: 'primary', sourceSequence: 2 },
      { sourceId: 'builder', sourceSequence: 0 },
    ], 2)
    expect(repeat).toEqual(first)
    expect(archive.sources?.[0]?.messages).toHaveLength(2)
  })

  it('ignores unverified or malformed attachment positions while retaining links', () => {
    const page = readBotGrokLibraryPage(BotId('bot-imported-library'), {
      ...archive,
      messages: [
        ...archive.messages,
        { sourceSequence: 4, role: 'attachment', text: 'unsafe/name.txt', timestampMs: 1_004 },
      ],
    }, [
      { sourceId: 'primary', sourceSequence: 4 },
      { sourceId: 'primary', sourceSequence: 99 },
      { sourceId: 'missing', sourceSequence: 1 },
    ], 20)
    expect(page.items.some(item => item.sourceSequence === 4)).toBe(false)
    expect(page.items.some(item => item.category === 'link')).toBe(true)
  })

  it('orders independent sources by immutable timestamps before stable coordinates', () => {
    const dated = readBotGrokLibraryPage(BotId('bot-imported-library'), {
      ...archive,
      sources: [{
        id: 'aaa', label: 'Older source', firstCachedSequence: 1,
        messages: [{ sourceSequence: 1, role: 'assistant' as const, text: '[Older](https://older.example/)', timestampMs: 1_500 }],
      }, ...(archive.sources ?? [])],
    }, [], 1)
    expect(dated.items[0]).toMatchObject({ sourceId: 'builder', sourceSequence: 1, createdAt: 2_001 })
    expect(dated.nextBefore).toMatchObject({ sourceId: 'builder', sourceSequence: 1, createdAt: 2_001 })
  })

  it('lists attachment candidates and projects version-one archives without source metadata', () => {
    const legacy: BotGrokHistoryArchive = {
      source: 'grok-bot', version: 1, firstCachedSequence: 1,
      messages: [
        { sourceSequence: 1, role: 'assistant', text: '[Older](https://legacy.example/older)', timestampMs: 1_000 },
        { sourceSequence: 2, role: 'assistant', text: '[Newer](https://legacy.example/newer)', timestampMs: 1_000 },
      ],
    }
    expect(listBotGrokLibraryAttachmentPositions(legacy)).toEqual([])
    expect(readBotGrokLibraryPage(BotId('bot-imported-library'), legacy, [], 10).items
      .flatMap(item => item.category === 'link' ? [item.url] : [])).toEqual([
      'https://legacy.example/newer', 'https://legacy.example/older',
    ])

    const sourceArchive: BotGrokHistoryArchive = {
      ...archive,
      sources: [
        { id: 'z-source', label: 'Z source', firstCachedSequence: 0, messages: [
          { sourceSequence: 0, role: 'attachment', text: 'z.txt', timestampMs: null },
        ] },
        { id: 'a-source', label: 'A source', firstCachedSequence: 0, messages: [
          { sourceSequence: 0, role: 'attachment', text: 'a.txt', timestampMs: null },
        ] },
      ],
    }
    expect(listBotGrokLibraryAttachmentPositions(sourceArchive)).toEqual([
      { sourceId: 'primary', sourceSequence: 2 },
      { sourceId: 'a-source', sourceSequence: 0 },
      { sourceId: 'z-source', sourceSequence: 0 },
    ])
  })

  it('rejects malformed attachment labels and truncates long safe labels', () => {
    const malformed: BotGrokHistoryArchive = {
      source: 'grok-bot', version: 2, firstCachedSequence: 0,
      messages: [
        { sourceSequence: 0, role: 'attachment', text: '', timestampMs: 0 },
        { sourceSequence: 1, role: 'attachment', text: 'a'.repeat(256), timestampMs: 1 },
        { sourceSequence: 2, role: 'attachment', text: '\uD800', timestampMs: 2 },
        { sourceSequence: 3, role: 'attachment', text: 'line\nbreak', timestampMs: 3 },
        { sourceSequence: 4, role: 'attachment', text: 'a'.repeat(161), timestampMs: 4 },
      ],
    }
    const available = malformed.messages.map(message => ({ sourceId: 'primary', sourceSequence: message.sourceSequence }))
    const page = readBotGrokLibraryPage(BotId('bot-imported-library'), malformed, available, 10)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({ sourceSequence: 4, category: 'file', label: `${'a'.repeat(159)}…` })
  })

  it('supports coordinate-only cursors and keeps a bounded page after truncation', () => {
    const coordinatePage = readBotGrokLibraryPage(BotId('bot-imported-library'), archive, [
      { sourceId: 'primary', sourceSequence: 2 },
      { sourceId: 'builder', sourceSequence: 0 },
    ], 10, { sourceId: 'primary', sourceSequence: 3, itemIndex: 1 })
    expect(coordinatePage.items.map(item => [item.sourceId, item.sourceSequence, item.itemIndex])).toEqual([
      ['builder', 1, 0], ['primary', 3, 0], ['primary', 2, 0], ['primary', 1, 0], ['builder', 0, 0],
    ])

    const dense: BotGrokHistoryArchive = {
      source: 'grok-bot', version: 2, firstCachedSequence: 0,
      messages: [
        { sourceSequence: 0, role: 'assistant', text: '[Newest](https://dense.example/)', timestampMs: 1_000 },
        ...Array.from({ length: 256 }, (_, index) => ({
          sourceSequence: index + 1, role: 'user' as const, text: `message-${index + 1}`, timestampMs: 999 - index,
        })),
      ],
    }
    const bounded = readBotGrokLibraryPage(BotId('bot-imported-library'), dense, [], 1)
    expect(bounded.items).toHaveLength(1)
    expect(bounded.nextBefore).toMatchObject({ sourceId: 'primary', sourceSequence: 0, itemIndex: 0, createdAt: 1_000 })
    expect(() => readBotGrokLibraryPage(BotId('bot-imported-library'), dense, [], 0)).toThrow(RangeError)
  })

  it('uses timestamp, source, sequence, and item tie-breakers for cursors', () => {
    const tied: BotGrokHistoryArchive = {
      source: 'grok-bot', version: 2, firstCachedSequence: 0,
      messages: [
        { sourceSequence: 0, role: 'assistant', text: '[Primary zero](https://tie.example/zero)', timestampMs: 100 },
        { sourceSequence: 1, role: 'assistant', text: '[Primary one](https://tie.example/one)', timestampMs: 100 },
        { sourceSequence: 2, role: 'assistant', text: '[Null](https://tie.example/null)', timestampMs: null },
        { sourceSequence: 3, role: 'assistant', text: '[Latest](https://tie.example/latest)', timestampMs: 200 },
      ],
      sources: [
        { id: 'z-source', label: 'Z source', firstCachedSequence: 0, messages: [
          { sourceSequence: 0, role: 'assistant', text: '[Z](https://tie.example/z)', timestampMs: 100 },
        ] },
        { id: 'a-source', label: 'A source', firstCachedSequence: 0, messages: [
          { sourceSequence: 0, role: 'assistant', text: '[A](https://tie.example/a)', timestampMs: 100 },
        ] },
      ],
    }
    const first = readBotGrokLibraryPage(BotId('bot-imported-library'), tied, [], 1)
    expect(first.items[0]?.category === 'link' ? first.items[0].url : undefined).toBe('https://tie.example/latest')
    expect(first.nextBefore).toBeDefined()
    const rest = readBotGrokLibraryPage(BotId('bot-imported-library'), tied, [], 20, first.nextBefore)
    expect(rest.items.flatMap(item => item.category === 'link' ? [item.url] : [])).toContain('https://tie.example/a')
    expect(rest.items.flatMap(item => item.category === 'link' ? [item.url] : [])).toContain('https://tie.example/null')
    const sameTimestamp = readBotGrokLibraryPage(BotId('bot-imported-library'), tied, [], 20, {
      sourceId: 'primary', sourceSequence: 1, itemIndex: 0, createdAt: 100,
    })
    expect(sameTimestamp.items.flatMap(item => item.category === 'link' ? [item.url] : [])).toContain('https://tie.example/a')
  })

  it('returns an exclusive continuation after a bounded sparse scan', () => {
    const sparse: BotGrokHistoryArchive = {
      source: 'grok-bot', version: 2, firstCachedSequence: 0,
      messages: [
        { sourceSequence: 0, role: 'assistant', text: '[Old](https://old.example/)', timestampMs: 0 },
        ...Array.from({ length: 256 }, (_, index) => ({
          sourceSequence: index + 1, role: 'user' as const, text: `message-${index + 1}`, timestampMs: index + 1,
        })),
      ],
    }
    const first = readBotGrokLibraryPage(BotId('bot-imported-library'), sparse, [], 1)
    expect(first.items).toEqual([])
    expect(first.nextBefore).toEqual({ sourceId: 'primary', sourceSequence: 1, itemIndex: 0, createdAt: 1 })
    const second = readBotGrokLibraryPage(BotId('bot-imported-library'), sparse, [], 1, first.nextBefore)
    expect(second.items).toEqual([expect.objectContaining({ sourceSequence: 0, url: 'https://old.example/' })])
    expect(second.nextBefore).toBeUndefined()
  })
})
