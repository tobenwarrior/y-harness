import { describe, expect, it, vi } from 'vitest'
import {
  decodeGrokHistory,
  frameGrokHistoryPage,
  grokHistoryMessageCount,
  GROK_HISTORY_MAX_BYTES,
  GROK_HISTORY_V1_MAX_BYTES,
  mergeGrokHistoryArchives,
  readGrokHistoryPage,
  resolveGrokHistoryPageRequest,
  type BotGrokHistoryPage,
} from '../src/grok-history.ts'
import type {
  BotGrokHistoryArchive,
  BotGrokHistoryMessage,
  BotGrokHistorySource,
} from '../src/types.ts'

function messages(count: number, textLength: number) {
  return Array.from({ length: count }, (_, index) => ({
    sourceSequence: index + 1,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: 'x'.repeat(textLength),
    timestampMs: index,
  }))
}

function historyMessage(sequence: number, overrides: Partial<BotGrokHistoryMessage> = {}): BotGrokHistoryMessage {
  const sourceSequence = overrides.sourceSequence ?? sequence
  const role = overrides.role ?? 'assistant'
  const text = overrides.text ?? `message-${sequence}`
  const timestampMs = overrides.timestampMs === undefined ? sequence : overrides.timestampMs
  return {
    sourceSequence,
    role,
    text,
    timestampMs,
    ...(overrides.author === undefined ? {} : { author: overrides.author }),
    ...(overrides.fromBot === undefined ? {} : { fromBot: overrides.fromBot }),
    ...(overrides.incomplete === undefined ? {} : { incomplete: overrides.incomplete }),
  }
}

function versionOneArchive(
  archiveMessages: readonly BotGrokHistoryMessage[] = [historyMessage(1, { role: 'user' })],
  firstCachedSequence = 1,
): BotGrokHistoryArchive {
  return {
    source: 'grok-bot',
    version: 1,
    firstCachedSequence,
    messages: archiveMessages,
  }
}

function supplementalSource(
  id = 'builder',
  archiveMessages: readonly BotGrokHistoryMessage[] = [historyMessage(1)],
  firstCachedSequence = 1,
  options: { readonly complete?: false } = {},
): BotGrokHistorySource {
  return {
    id,
    label: `${id} source`,
    firstCachedSequence,
    messages: archiveMessages,
    ...(options.complete === false ? { complete: false as const } : {}),
  }
}

function versionTwoArchive(
  archiveMessages: readonly BotGrokHistoryMessage[] = [historyMessage(1)],
  firstCachedSequence = 1,
  options: { readonly complete?: false; readonly sources?: readonly BotGrokHistorySource[] } = {},
): BotGrokHistoryArchive {
  return {
    source: 'grok-bot',
    version: 2,
    firstCachedSequence,
    messages: archiveMessages,
    ...(options.complete === false ? { complete: false as const } : {}),
    ...(options.sources === undefined ? {} : { sources: options.sources }),
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

  it('decodes valid version-one archives and rejects malformed documents', () => {
    const validVersionOne = versionOneArchive([historyMessage(1, { role: 'user' })])
    expect(decodeGrokHistory(JSON.stringify(validVersionOne))).toEqual(validVersionOne)
    expect(decodeGrokHistory('{')).toBeUndefined()
    expect(decodeGrokHistory('null')).toBeUndefined()
    expect(decodeGrokHistory('42')).toBeUndefined()
    const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => { throw new Error('unexpected parse failure') })
    try {
      expect(() => decodeGrokHistory(JSON.stringify(validVersionOne))).toThrow('unexpected parse failure')
    } finally {
      parse.mockRestore()
    }

    expect(decodeGrokHistory(JSON.stringify({
      ...validVersionOne,
      messages: [historyMessage(2, { role: 'user' }), historyMessage(1, { role: 'assistant' })],
    }))).toBeUndefined()

    expect(decodeGrokHistory(JSON.stringify(versionTwoArchive([
      historyMessage(0, { text: '', timestampMs: null }),
    ], 0)))).toBeUndefined()

    const incompleteToolMessage = historyMessage(0, { role: 'tool', text: '', timestampMs: null, incomplete: true })
    expect(decodeGrokHistory(JSON.stringify(versionTwoArchive([incompleteToolMessage], 0, {
      sources: [supplementalSource('primary', [incompleteToolMessage], 0)],
    })))).toBeUndefined()
    expect(decodeGrokHistory(JSON.stringify(versionTwoArchive([incompleteToolMessage], 0, {
      sources: [supplementalSource('builder', [incompleteToolMessage, incompleteToolMessage], 0)],
    })))).toBeUndefined()
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

  it('validates bounded page requests', () => {
    expect(resolveGrokHistoryPageRequest()).toEqual({ limit: 5 })
    expect(resolveGrokHistoryPageRequest({ limit: 10, before: 0, source: 'builder' })).toEqual({
      limit: 10, before: 0, source: 'builder',
    })
    for (const limit of [0, 11, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveGrokHistoryPageRequest({ limit })).toThrow(RangeError)
    }
    for (const before of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveGrokHistoryPageRequest({ before })).toThrow(RangeError)
    }
    for (const source of ['', ' builder', 'builder ', 'primary', 'x'.repeat(129)]) {
      expect(() => resolveGrokHistoryPageRequest({ source })).toThrow(RangeError)
    }
  })

  it('frames transcript fields as bounded untrusted excerpts', () => {
    const longText = 'x'.repeat(1_200)
    const page: BotGrokHistoryPage = {
      source: 'grok-bot',
      version: 2,
      sourceId: 'builder',
      sourceLabel: longText,
      complete: false,
      sources: [{ id: 'builder', label: longText }, { id: 'short', label: 'Short label' }],
      firstCachedSequence: 0,
      totalMessages: 1,
      nextBefore: 0,
      messages: [historyMessage(0, {
        role: 'tool', text: longText, timestampMs: null, author: longText, fromBot: 'source-bot', incomplete: true,
      })],
    }
    expect(frameGrokHistoryPage(page)).toMatchObject({
      source: 'grok-bot',
      version: 2,
      sourceId: 'builder',
      sourceLabel: expect.stringContaining('[excerpt truncated]'),
      complete: false,
      sources: [
        { id: 'builder', label: expect.stringContaining('[excerpt truncated]') },
        { id: 'short', label: expect.stringContaining('[Untrusted Bot transcript;') },
      ],
      nextBefore: 0,
      messages: [{
        role: 'tool',
        text: expect.stringContaining('[excerpt truncated]'),
        author: expect.stringContaining('[excerpt truncated]'),
        fromBot: expect.stringContaining('[Untrusted Bot transcript;'),
        timestampMs: null,
        incomplete: true,
      }],
    })

    expect(frameGrokHistoryPage({
      source: 'grok-bot', version: 1, firstCachedSequence: 1, totalMessages: 1,
      messages: [historyMessage(1)],
    })).toMatchObject({
      source: 'grok-bot', version: 1, firstCachedSequence: 1, totalMessages: 1,
      messages: [{ text: expect.stringContaining('[Untrusted Bot transcript;') }],
    })
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

  it('projects primary pages and reports unavailable source selections', () => {
    const primary = versionTwoArchive([historyMessage(0), historyMessage(1)], 0, { complete: false })
    expect(readGrokHistoryPage(primary, resolveGrokHistoryPageRequest({ limit: 10 }))).toMatchObject({
      version: 2, firstCachedSequence: 0, totalMessages: 2, complete: false,
      messages: [{ sourceSequence: 0 }, { sourceSequence: 1 }],
    })

    const source = supplementalSource('builder', [historyMessage(0), historyMessage(2)], 0, { complete: false })
    const withSource = versionTwoArchive([historyMessage(0)], 0, { sources: [source] })
    expect(readGrokHistoryPage(withSource, resolveGrokHistoryPageRequest({ limit: 10 }))).toMatchObject({
      firstCachedSequence: 0, totalMessages: 1, messages: [{ sourceSequence: 0 }],
    })
    expect(readGrokHistoryPage(withSource, resolveGrokHistoryPageRequest({ source: 'builder', limit: 10 }))).toMatchObject({
      sourceId: 'builder', sourceLabel: 'builder source', complete: false,
      firstCachedSequence: 0, totalMessages: 2,
    })
    expect(() => readGrokHistoryPage(withSource, resolveGrokHistoryPageRequest({ source: 'missing' }))).toThrow(RangeError)
    expect(() => readGrokHistoryPage(versionOneArchive(), resolveGrokHistoryPageRequest({ source: 'builder' }))).toThrow(RangeError)
  })

  it('merges additive version-two archives while preserving recovered facts', () => {
    const versionOne = versionOneArchive([historyMessage(1, { role: 'user' })])
    const upgraded = versionTwoArchive([historyMessage(1, { role: 'user' })])
    expect(mergeGrokHistoryArchives(versionOne, upgraded)).toBe(upgraded)
    expect(mergeGrokHistoryArchives(versionOne, versionOneArchive([historyMessage(1, { role: 'user' })]))).toMatchObject({ version: 1 })

    const currentSource = supplementalSource('builder', [historyMessage(0, { timestampMs: null })], 0, { complete: false })
    const current = versionTwoArchive([historyMessage(0, {
      timestampMs: null, author: 'old-author', fromBot: 'old-bot', incomplete: true,
    })], 0, { complete: false, sources: [currentSource] })
    const incomingSource = supplementalSource('builder', [historyMessage(0, { timestampMs: 100 })], 0, { complete: false })
    const incoming = versionTwoArchive([
      historyMessage(0, { timestampMs: 100, author: 'old-author', fromBot: 'old-bot', incomplete: true }),
      historyMessage(1),
    ], 0, { complete: false, sources: [incomingSource] })
    expect(mergeGrokHistoryArchives(current, incoming)).toBe(incoming)
    expect(mergeGrokHistoryArchives(versionTwoArchive(), versionTwoArchive([historyMessage(1), historyMessage(2)]))).toMatchObject({
      messages: [{ sourceSequence: 1 }, { sourceSequence: 2 }],
    })
  })

  it('rejects archive downgrades, coverage loss, and message conflicts', () => {
    const recoveredMessage = historyMessage(1, { timestampMs: 100, author: 'author', fromBot: 'bot' })
    const currentMessage: BotGrokHistoryMessage = { ...recoveredMessage, incomplete: true }
    const sources = [supplementalSource('builder', [historyMessage(1, { timestampMs: 100 })], 1, { complete: false })]
    const current = versionTwoArchive([currentMessage], 1, { complete: false, sources })
    expect(() => mergeGrokHistoryArchives(current, versionOneArchive([historyMessage(1)]))).toThrow('downgraded')
    expect(() => mergeGrokHistoryArchives(current, versionTwoArchive(current.messages, 1, { sources }))).toThrow('completeness')
    expect(() => mergeGrokHistoryArchives(current, versionTwoArchive([historyMessage(2)], 2, { complete: false, sources }))).toThrow('coverage')
    expect(() => mergeGrokHistoryArchives(current, versionTwoArchive([historyMessage(2)], 1, { complete: false, sources }))).toThrow('message conflict')

    const conflictingMessages: readonly BotGrokHistoryMessage[] = [
      { ...currentMessage, role: 'user' },
      { ...currentMessage, text: 'changed text' },
      { ...currentMessage, timestampMs: 200 },
      { ...currentMessage, author: 'changed author' },
      { ...currentMessage, fromBot: 'changed bot' },
      recoveredMessage,
    ]
    for (const conflictingMessage of conflictingMessages) {
      expect(() => mergeGrokHistoryArchives(current, versionTwoArchive([conflictingMessage], 1, { complete: false, sources }))).toThrow('message conflict')
    }
  })

  it('rejects supplemental source removal, changes, and incomplete markers', () => {
    const source = supplementalSource('builder', [historyMessage(1)], 1, { complete: false })
    const current = versionTwoArchive([historyMessage(1)], 1, { sources: [source] })
    expect(() => mergeGrokHistoryArchives(current, versionTwoArchive([historyMessage(1)], 1))).toThrow('supplemental source changed')
    expect(() => mergeGrokHistoryArchives(current, versionTwoArchive([historyMessage(1)], 1, {
      sources: [{ ...source, label: 'renamed source' }],
    }))).toThrow('supplemental source changed')
    expect(() => mergeGrokHistoryArchives(current, versionTwoArchive([historyMessage(1)], 1, {
      sources: [supplementalSource('builder', [historyMessage(2)], 2, { complete: false })],
    }))).toThrow('coverage')
    expect(() => mergeGrokHistoryArchives(current, versionTwoArchive([historyMessage(1)], 1, {
      sources: [supplementalSource('builder', [historyMessage(1, { text: 'changed' })], 1, { complete: false })],
    }))).toThrow('message conflict')
    expect(() => mergeGrokHistoryArchives(current, versionTwoArchive([historyMessage(1)], 1, {
      sources: [supplementalSource('builder', [historyMessage(1)], 1)],
    }))).toThrow('completeness')
  })

  it('counts primary and supplemental records', () => {
    expect(grokHistoryMessageCount(versionOneArchive([historyMessage(1), historyMessage(2)]))).toBe(2)
    expect(grokHistoryMessageCount(versionTwoArchive([historyMessage(1)]))).toBe(1)
    expect(grokHistoryMessageCount(versionTwoArchive([historyMessage(1)], 1, {
      sources: [supplementalSource('builder', [historyMessage(1), historyMessage(2)])],
    }))).toBe(3)
  })
})
