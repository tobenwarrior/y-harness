import { describe, expect, it, vi } from 'vitest'
import {
  decodeGrokHistory,
  frameGrokHistoryPage,
  GROK_HISTORY_MAX_BYTES,
  GROK_HISTORY_MAX_MESSAGES,
  GROK_HISTORY_MAX_SOURCES,
  GROK_HISTORY_V1_MAX_BYTES,
  grokHistoryMessageCount,
  mergeGrokHistoryArchives,
  readGrokHistoryPage,
  resolveGrokHistoryPageRequest,
} from '../src/grok-history.ts'
import type { BotGrokHistoryArchive, BotGrokHistoryMessage } from '../src/types.ts'

function messages(count: number, textLength: number) {
  return Array.from({ length: count }, (_, index) => ({
    sourceSequence: index + 1,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: 'x'.repeat(textLength),
    timestampMs: index,
  }))
}

const primaryMessage: BotGrokHistoryMessage = {
  sourceSequence: 1,
  role: 'user',
  text: 'hello',
  timestampMs: 100,
}

function archiveV1(overrides: Partial<BotGrokHistoryArchive> = {}): BotGrokHistoryArchive {
  return {
    source: 'grok-bot',
    version: 1,
    firstCachedSequence: 1,
    messages: [primaryMessage],
    ...overrides,
  }
}

function archiveV2(overrides: Partial<BotGrokHistoryArchive> = {}): BotGrokHistoryArchive {
  return {
    source: 'grok-bot',
    version: 2,
    firstCachedSequence: 1,
    messages: [primaryMessage],
    ...overrides,
  }
}

describe('Grok history archive codec', () => {
  it('keeps the version-one cap while admitting a bounded version-two archive', () => {
    const recovered = messages(16, 40_000)
    const versionOne = JSON.stringify({
      source: 'grok-bot', version: 1, firstCachedSequence: 1, messages: recovered,
    })
    const versionTwo = JSON.stringify({
      source: 'grok-bot', version: 2, firstCachedSequence: 1, messages: recovered,
    })

    expect(Buffer.byteLength(versionOne)).toBeGreaterThan(GROK_HISTORY_V1_MAX_BYTES)
    expect(Buffer.byteLength(versionOne)).toBeLessThan(GROK_HISTORY_MAX_BYTES)
    expect(decodeGrokHistory(versionOne)).toBeUndefined()
    expect(decodeGrokHistory(versionTwo)).toMatchObject({ version: 2, messages: recovered })

    const overVersionTwoLimit = JSON.stringify({
      source: 'grok-bot', version: 2, firstCachedSequence: 1, messages: messages(50, 45_000),
    })
    expect(Buffer.byteLength(overVersionTwoLimit)).toBeGreaterThan(GROK_HISTORY_MAX_BYTES)
    expect(decodeGrokHistory(overVersionTwoLimit)).toBeUndefined()
  })

  it('rejects non-monotonic messages and duplicate supplemental source ids', () => {
    const base = {
      source: 'grok-bot', version: 2, firstCachedSequence: 0,
      messages: [{ sourceSequence: 0, role: 'tool', text: '', timestampMs: null, incomplete: true }],
    }
    expect(decodeGrokHistory(JSON.stringify({
      ...base,
      messages: [base.messages[0], { ...base.messages[0], sourceSequence: 0 }],
    }))).toBeUndefined()
    expect(decodeGrokHistory(JSON.stringify({
      ...base,
      sources: [
        { id: 'builder', label: 'Builder', firstCachedSequence: 0, messages: base.messages },
        { id: 'builder', label: 'Other builder', firstCachedSequence: 0, messages: base.messages },
      ],
    }))).toBeUndefined()
  })

  it('discovers and traverses supplemental records starting at sequence zero', () => {
    const archive = decodeGrokHistory(JSON.stringify({
      source: 'grok-bot', version: 2, firstCachedSequence: 0,
      messages: [{ sourceSequence: 0, role: 'tool', text: 'primary', timestampMs: null, incomplete: true }],
      sources: [{
        id: 'builder', label: 'Bot builder', firstCachedSequence: 0,
        messages: [
          { sourceSequence: 0, role: 'tool', text: 'first', timestampMs: null, incomplete: true },
          { sourceSequence: 2, role: 'assistant', text: 'second', timestampMs: 2_000 },
          { sourceSequence: 4, role: 'assistant', text: 'last', timestampMs: 4_000 },
        ],
      }],
    }))
    if (archive === undefined) throw new Error('test archive should be valid')

    const newest = readGrokHistoryPage(archive, resolveGrokHistoryPageRequest({ source: 'builder', limit: 2 }))
    expect(newest).toMatchObject({
      sourceId: 'builder', sourceLabel: 'Bot builder', firstCachedSequence: 0,
      totalMessages: 3, nextBefore: 2,
      messages: [{ sourceSequence: 2 }, { sourceSequence: 4 }],
      sources: [{ id: 'builder', label: 'Bot builder' }],
    })

    const oldest = readGrokHistoryPage(archive, resolveGrokHistoryPageRequest({ source: 'builder', limit: 2, before: 2 }))
    expect(oldest).toMatchObject({ totalMessages: 3, messages: [{ sourceSequence: 0, text: 'first' }] })
    expect(oldest.nextBefore).toBeUndefined()
  })

  it('preserves valid version-one archives and propagates unexpected parser failures', () => {
    const versionOne = archiveV1()
    expect(decodeGrokHistory(JSON.stringify(versionOne))).toEqual(versionOne)
    expect(decodeGrokHistory('{')).toBeUndefined()

    const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw new Error('unexpected parser failure')
    })
    try {
      expect(() => decodeGrokHistory('{}')).toThrow('unexpected parser failure')
    } finally {
      parse.mockRestore()
    }
    expect(decodeGrokHistory(JSON.stringify(versionOne))).toEqual(versionOne)
  })

  it('rejects malformed versioned records at the import boundary', () => {
    const versionTwoMessage = { sourceSequence: 0, role: 'tool', text: 'tool output', timestampMs: null }
    const validVersionTwo = {
      source: 'grok-bot', version: 2, firstCachedSequence: 0, messages: [versionTwoMessage],
    }
    expect(decodeGrokHistory(JSON.stringify(validVersionTwo))).toEqual(validVersionTwo)

    const invalidDocuments = [
      null,
      [],
      { source: 'grok-bot', version: 3, firstCachedSequence: 1, messages: [primaryMessage] },
      { source: 'grok-bot', version: 1, firstCachedSequence: 1, messages: [] },
      {
        source: 'grok-bot', version: 1, firstCachedSequence: 1,
        messages: [primaryMessage, { ...primaryMessage, sourceSequence: 1 }],
      },
      {
        source: 'grok-bot', version: 1, firstCachedSequence: 1,
        messages: [{ ...primaryMessage, role: 'tool' }],
      },
      {
        source: 'grok-bot', version: 2, firstCachedSequence: 0,
        messages: [{ sourceSequence: 0, role: 'tool', text: '', timestampMs: null }],
      },
      {
        source: 'grok-bot', version: 2, firstCachedSequence: 0,
        messages: [{ sourceSequence: 0, role: 'Tool', text: 'invalid role', timestampMs: null }],
      },
      {
        source: 'grok-bot', version: 2, firstCachedSequence: 0,
        messages: [{ sourceSequence: 0, role: 'tool ', text: 'invalid role', timestampMs: null }],
      },
      {
        source: 'grok-bot', version: 2, firstCachedSequence: 0,
        messages: [{ sourceSequence: 0, role: 'tool', text: 'invalid timestamp', timestampMs: -1 }],
      },
      {
        source: 'grok-bot', version: 2, firstCachedSequence: 0,
        messages: [{ sourceSequence: 0, role: 'tool', text: 'invalid extra', timestampMs: null, extra: true }],
      },
      {
        source: 'grok-bot', version: 2, firstCachedSequence: 0,
        messages: [versionTwoMessage], sources: [{ id: 'primary', label: 'Primary', firstCachedSequence: 0, messages: [versionTwoMessage] }],
      },
      {
        source: 'grok-bot', version: 2, firstCachedSequence: 0,
        messages: [versionTwoMessage], sources: [{ id: ' bad', label: 'Bad id', firstCachedSequence: 0, messages: [versionTwoMessage] }],
      },
      {
        source: 'grok-bot', version: 2, firstCachedSequence: 0,
        messages: [versionTwoMessage], sources: [{ id: 'source', label: '', firstCachedSequence: 0, messages: [versionTwoMessage] }],
      },
      {
        source: 'grok-bot', version: 2, firstCachedSequence: 0,
        messages: [versionTwoMessage], sources: [{
          id: 'source', label: 'Source', firstCachedSequence: 0,
          messages: [versionTwoMessage, { ...versionTwoMessage }],
        }],
      },
    ]
    for (const document of invalidDocuments) expect(decodeGrokHistory(JSON.stringify(document))).toBeUndefined()
  })

  it('validates bounded page requests and preserves explicitly supplied cursors', () => {
    expect(resolveGrokHistoryPageRequest()).toEqual({ limit: 5 })
    expect(resolveGrokHistoryPageRequest({ limit: 10, before: 0, source: 'builder' })).toEqual({
      limit: 10, before: 0, source: 'builder',
    })
    for (const limit of [0, -1, 11, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => resolveGrokHistoryPageRequest({ limit })).toThrow(RangeError)
    }
    for (const before of [-1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => resolveGrokHistoryPageRequest({ before })).toThrow(RangeError)
    }
    for (const source of [' ', 'a'.repeat(129), 'primary']) {
      expect(() => resolveGrokHistoryPageRequest({ source })).toThrow(RangeError)
    }
  })

  it('frames optional transcript metadata and bounds every untrusted excerpt', () => {
    const longText = 'x'.repeat(1_200)
    const framed = frameGrokHistoryPage({
      source: 'grok-bot',
      version: 2,
      sourceId: 'builder',
      sourceLabel: longText,
      complete: false,
      sources: [{ id: 'builder', label: longText }],
      firstCachedSequence: 0,
      totalMessages: 2,
      nextBefore: 1,
      messages: [
        {
          sourceSequence: 0,
          role: 'tool',
          text: longText,
          author: longText,
          fromBot: 'Grok',
          timestampMs: null,
          incomplete: true,
        },
        { sourceSequence: 1, role: 'assistant', text: 'short', timestampMs: 1 },
      ],
    })
    expect(framed).toMatchObject({
      source: 'grok-bot',
      version: 2,
      sourceId: 'builder',
      complete: false,
      nextBefore: 1,
      sources: [{ id: 'builder' }],
      messages: [{ sourceSequence: 0, incomplete: true }, { sourceSequence: 1, role: 'assistant' }],
    })
    if (framed === null || typeof framed !== 'object' || Array.isArray(framed)) throw new Error('framed page should be an object')
    const sourceLabel = framed.sourceLabel
    const framedMessages = framed.messages
    if (typeof sourceLabel !== 'string' || !Array.isArray(framedMessages)) throw new Error('framed metadata should be present')
    const firstMessage = framedMessages[0]
    if (firstMessage === null || typeof firstMessage !== 'object' || Array.isArray(firstMessage)) {
      throw new Error('framed message should be an object')
    }
    const framedText = firstMessage.text
    const framedAuthor = firstMessage.author
    if (typeof framedText !== 'string' || typeof framedAuthor !== 'string') throw new Error('framed text should be present')
    expect(sourceLabel).toContain('[excerpt truncated]')
    expect(framedText).toContain('[excerpt truncated]')
    expect(framedAuthor).toContain('[excerpt truncated]')

    expect(frameGrokHistoryPage({
      source: 'grok-bot', version: 1, firstCachedSequence: 1, totalMessages: 0, messages: [],
    })).toEqual({ source: 'grok-bot', version: 1, firstCachedSequence: 1, totalMessages: 0, messages: [] })
  })

  it('reads primary and supplemental pages while retaining completeness and cursors', () => {
    const primary = archiveV2({
      firstCachedSequence: 0,
      complete: false,
      messages: [
        { sourceSequence: 0, role: 'tool', text: 'first', timestampMs: null, incomplete: true },
        { sourceSequence: 2, role: 'assistant', text: 'last', timestampMs: 2 },
      ],
    })
    expect(readGrokHistoryPage(primary, resolveGrokHistoryPageRequest({ limit: 1 }))).toMatchObject({
      complete: false,
      totalMessages: 2,
      nextBefore: 2,
      messages: [{ sourceSequence: 2 }],
    })
    expect(readGrokHistoryPage(primary, resolveGrokHistoryPageRequest({ before: 0, limit: 1 }))).toMatchObject({
      messages: [],
    })
    expect(readGrokHistoryPage(archiveV2(), resolveGrokHistoryPageRequest({ limit: 1 }))).toMatchObject({
      messages: [primaryMessage],
    })

    expect(() => readGrokHistoryPage(archiveV1(), resolveGrokHistoryPageRequest({ source: 'builder' }))).toThrow(
      'version-one archive',
    )
    const supplemental = archiveV2({
      sources: [{
        id: 'builder', label: 'Builder', firstCachedSequence: 0, complete: false,
        messages: [{ sourceSequence: 0, role: 'tool', text: 'supplement', timestampMs: null }],
      }],
    })
    expect(readGrokHistoryPage(supplemental, resolveGrokHistoryPageRequest({ source: 'builder' }))).toMatchObject({
      sourceId: 'builder', sourceLabel: 'Builder', complete: false, messages: [{ text: 'supplement' }],
    })
    expect(() => readGrokHistoryPage(supplemental, resolveGrokHistoryPageRequest({ source: 'missing' }))).toThrow(
      'was not found',
    )
    expect(() => readGrokHistoryPage(archiveV2(), resolveGrokHistoryPageRequest({ source: 'missing' }))).toThrow(
      'was not found',
    )
  })

  it('merges additive imports and refuses every attempted loss of recovered facts', () => {
    const currentMessage: BotGrokHistoryMessage = {
      sourceSequence: 1,
      role: 'assistant',
      text: 'answer',
      timestampMs: 100,
      author: 'A',
      fromBot: 'Grok',
      incomplete: true,
    }
    const currentSourceMessage: BotGrokHistoryMessage = {
      sourceSequence: 1, role: 'tool', text: 'source answer', timestampMs: null,
    }
    const current = archiveV2({
      firstCachedSequence: 1,
      complete: false,
      messages: [currentMessage],
      sources: [{
        id: 'builder', label: 'Builder', firstCachedSequence: 1, complete: false,
        messages: [currentSourceMessage],
      }],
    })
    const incoming = archiveV2({
      firstCachedSequence: 0,
      complete: false,
      messages: [
        { sourceSequence: 0, role: 'user', text: 'question', timestampMs: 0 },
        currentMessage,
      ],
      sources: [{
        id: 'builder', label: 'Builder', firstCachedSequence: 0, complete: false,
        messages: [{ sourceSequence: 0, role: 'tool', text: 'source question', timestampMs: null }, currentSourceMessage],
      }],
    })
    expect(mergeGrokHistoryArchives(current, incoming)).toEqual(incoming)
    expect(grokHistoryMessageCount(archiveV1())).toBe(1)
    expect(grokHistoryMessageCount(archiveV2())).toBe(1)
    expect(grokHistoryMessageCount(incoming)).toBe(4)
    const incomingSource = incoming.sources?.[0]
    if (incomingSource === undefined) throw new Error('test source should be present')
    const withoutOptionalMetadata: BotGrokHistoryMessage = {
      sourceSequence: currentMessage.sourceSequence,
      role: currentMessage.role,
      text: currentMessage.text,
      timestampMs: currentMessage.timestampMs,
    }
    const sourceWithoutComplete = {
      id: incomingSource.id,
      label: incomingSource.label,
      firstCachedSequence: incomingSource.firstCachedSequence,
      messages: incomingSource.messages,
    }

    expect(() => mergeGrokHistoryArchives(current, archiveV1({ messages: [currentMessage] }))).toThrow('downgraded')
    expect(() => mergeGrokHistoryArchives(archiveV2(), archiveV1())).toThrow('downgraded')
    expect(() => mergeGrokHistoryArchives(current, archiveV2({ firstCachedSequence: 2, messages: [currentMessage], complete: false, sources: [incomingSource] }))).toThrow('source coverage')
    expect(() => mergeGrokHistoryArchives(current, archiveV2({ messages: [currentMessage], sources: [incomingSource] }))).toThrow('completeness')
    expect(() => mergeGrokHistoryArchives(current, archiveV2({ complete: false, messages: [], sources: [incomingSource] }))).toThrow('message conflict')
    expect(() => mergeGrokHistoryArchives(current, archiveV2({ complete: false, messages: [{ ...currentMessage, role: 'user' }], sources: [incomingSource] }))).toThrow('message conflict')
    expect(() => mergeGrokHistoryArchives(current, archiveV2({ complete: false, messages: [{ ...currentMessage, timestampMs: 101 }], sources: [incomingSource] }))).toThrow('message conflict')
    expect(() => mergeGrokHistoryArchives(current, archiveV2({ complete: false, messages: [{ ...currentMessage, author: 'B' }], sources: [incomingSource] }))).toThrow('message conflict')
    expect(() => mergeGrokHistoryArchives(current, archiveV2({ complete: false, messages: [{ ...currentMessage, fromBot: 'Other' }], sources: [incomingSource] }))).toThrow('message conflict')
    const partialMetadataArchive = archiveV2({ complete: false, messages: [withoutOptionalMetadata], sources: [incomingSource] })
    expect(mergeGrokHistoryArchives(current, partialMetadataArchive)).toMatchObject({ messages: [currentMessage] })
    expect(mergeGrokHistoryArchives(current, archiveV2({ complete: false, messages: [currentMessage], sources: [] }))).toMatchObject({
      sources: current.sources,
    })
    expect(() => mergeGrokHistoryArchives(current, archiveV2({ complete: false, messages: [currentMessage], sources: [{ ...incomingSource, label: 'Changed' }] }))).toThrow('supplemental source changed')
    expect(() => mergeGrokHistoryArchives(current, archiveV2({ complete: false, messages: [currentMessage], sources: [{ ...incomingSource, firstCachedSequence: 2 }] }))).toThrow('source coverage')
    expect(() => mergeGrokHistoryArchives(current, archiveV2({ complete: false, messages: [currentMessage], sources: [sourceWithoutComplete] }))).toThrow('completeness')
    expect(mergeGrokHistoryArchives(archiveV2(), archiveV2())).toMatchObject({ version: 2, messages: [primaryMessage] })
    expect(mergeGrokHistoryArchives(archiveV1(), archiveV1())).toMatchObject({ version: 1, messages: [primaryMessage] })
  })

  it('reconciles disjoint reviewed fragments into one ordered archive', () => {
    const current = archiveV2({
      firstCachedSequence: 5,
      complete: false,
      messages: [{ sourceSequence: 5, role: 'assistant', text: 'later', timestampMs: 500 }],
      sources: [{
        id: 'builder', label: 'Builder', firstCachedSequence: 3, complete: false,
        messages: [{ sourceSequence: 3, role: 'tool', text: 'later source', timestampMs: null }],
      }],
    })
    const incoming = archiveV2({
      firstCachedSequence: 1,
      complete: false,
      messages: [{ sourceSequence: 1, role: 'user', text: 'earlier', timestampMs: 100 }],
      sources: [{
        id: 'builder', label: 'Builder', firstCachedSequence: 1, complete: false,
        messages: [{ sourceSequence: 1, role: 'tool', text: 'earlier source', timestampMs: null }],
      }],
    })

    expect(mergeGrokHistoryArchives(current, incoming)).toEqual({
      source: 'grok-bot',
      version: 2,
      firstCachedSequence: 1,
      complete: false,
      messages: [
        { sourceSequence: 1, role: 'user', text: 'earlier', timestampMs: 100 },
        { sourceSequence: 5, role: 'assistant', text: 'later', timestampMs: 500 },
      ],
      sources: [{
        id: 'builder', label: 'Builder', firstCachedSequence: 1, complete: false,
        messages: [
          { sourceSequence: 1, role: 'tool', text: 'earlier source', timestampMs: null },
          { sourceSequence: 3, role: 'tool', text: 'later source', timestampMs: null },
        ],
      }],
    })
  })

  it('fills reviewed null timestamps and absent optional metadata without inventing fields', () => {
    const current = archiveV2({
      complete: false,
      messages: [{ sourceSequence: 2, role: 'tool', text: '', timestampMs: null, incomplete: true }],
    })
    const incoming = archiveV2({
      complete: false,
      messages: [{
        sourceSequence: 2,
        role: 'tool',
        text: '',
        timestampMs: 200,
        author: 'Recovered author',
        fromBot: 'Recovered bot',
        incomplete: true,
      }],
    })

    expect(mergeGrokHistoryArchives(current, incoming)).toMatchObject({
      messages: [{
        sourceSequence: 2,
        timestampMs: 200,
        author: 'Recovered author',
        fromBot: 'Recovered bot',
        incomplete: true,
      }],
    })

    const knownTimestamp = archiveV2({
      messages: [{
        sourceSequence: 2,
        role: 'tool',
        text: '',
        timestampMs: 200,
        incomplete: true,
      }],
    })
    const erasedTimestamp = archiveV2({
      messages: [{
        sourceSequence: 2,
        role: 'tool',
        text: '',
        timestampMs: null,
        incomplete: true,
      }],
    })
    expect(() => mergeGrokHistoryArchives(knownTimestamp, erasedTimestamp)).toThrow('message conflict')
  })

  it('keeps an incomplete marker supplied by a matching recovered record', () => {
    const incoming = archiveV2({ messages: [{ ...primaryMessage, incomplete: true }] })

    expect(mergeGrokHistoryArchives(archiveV2(), incoming).messages).toEqual(incoming.messages)
  })

  it('rejects fragments that would exceed the message limit together', () => {
    const current = archiveV2({
      messages: Array.from({ length: GROK_HISTORY_MAX_MESSAGES }, (_, index) => ({
        ...primaryMessage, sourceSequence: index + 1,
      })),
    })
    const incoming = archiveV2({ messages: [{ ...primaryMessage, sourceSequence: GROK_HISTORY_MAX_MESSAGES + 1 }] })

    expect(() => mergeGrokHistoryArchives(current, incoming)).toThrow('archive exceeds the message limit')
  })

  it('retains omitted supplemental sources while merging an incremental source fragment', () => {
    const current = archiveV2({
      sources: [
        {
          id: 'builder', label: 'Builder', firstCachedSequence: 1,
          messages: [{ sourceSequence: 1, role: 'tool', text: 'first', timestampMs: null }],
        },
        {
          id: 'auditor', label: 'Auditor', firstCachedSequence: 1,
          messages: [{ sourceSequence: 1, role: 'tool', text: 'audit', timestampMs: null }],
        },
      ],
    })
    const incoming = archiveV2({
      sources: [{
        id: 'builder', label: 'Builder', firstCachedSequence: 1,
        messages: [{ sourceSequence: 2, role: 'tool', text: 'second', timestampMs: null }],
      }],
    })

    expect(mergeGrokHistoryArchives(current, incoming).sources).toEqual([
      {
        id: 'builder', label: 'Builder', firstCachedSequence: 1,
        messages: [
          { sourceSequence: 1, role: 'tool', text: 'first', timestampMs: null },
          { sourceSequence: 2, role: 'tool', text: 'second', timestampMs: null },
        ],
      },
      {
        id: 'auditor', label: 'Auditor', firstCachedSequence: 1,
        messages: [{ sourceSequence: 1, role: 'tool', text: 'audit', timestampMs: null }],
      },
    ])
  })

  it('keeps merged source and byte limits enforced', () => {
    const source = (id: string) => ({
      id, label: id, firstCachedSequence: 1,
      messages: [{ sourceSequence: 1, role: 'tool' as const, text: id, timestampMs: null }],
    })
    const current = archiveV2({ sources: Array.from({ length: GROK_HISTORY_MAX_SOURCES }, (_, index) => source(`source-${index}`)) })
    expect(() => mergeGrokHistoryArchives(current, archiveV2({ sources: [source('new-source')] }))).toThrow('source limit')

    const large = 'x'.repeat(1_100_000)
    expect(() => mergeGrokHistoryArchives(
      archiveV2({ messages: [{ sourceSequence: 1, role: 'assistant', text: large, timestampMs: null }] }),
      archiveV2({ messages: [{ sourceSequence: 2, role: 'assistant', text: large, timestampMs: null }] }),
    )).toThrow('byte limit')
  })
})
