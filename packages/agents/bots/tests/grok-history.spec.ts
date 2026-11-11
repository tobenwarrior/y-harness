import { describe, expect, it } from 'vitest'
import {
  decodeGrokHistory,
  GROK_HISTORY_MAX_BYTES,
  GROK_HISTORY_V1_MAX_BYTES,
  readGrokHistoryPage,
  resolveGrokHistoryPageRequest,
} from '../src/grok-history.ts'

function messages(count: number, textLength: number) {
  return Array.from({ length: count }, (_, index) => ({
    sourceSequence: index + 1,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: 'x'.repeat(textLength),
    timestampMs: index,
  }))
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
})
