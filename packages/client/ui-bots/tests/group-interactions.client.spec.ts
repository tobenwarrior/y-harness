import { describe, expect, it } from 'vitest'
import {
  compactGroupQuote,
  GROUP_REACTION_OPTIONS,
  readGroupReactions,
  readGroupReplyToMessageId,
} from '../src/client/group-interactions.ts'

describe('shared-group message interactions', () => {
  it('reads only valid group reply parents from projected messages', () => {
    expect(readGroupReplyToMessageId({})).toBeUndefined()
    expect(readGroupReplyToMessageId({ replyToMessageId: 'bot-group-message-parent-1' }))
      .toBe('bot-group-message-parent-1')
    expect(readGroupReplyToMessageId({ replyToMessageId: 7 })).toBeUndefined()
    expect(readGroupReplyToMessageId({ replyToMessageId: 'message-parent' })).toBeUndefined()
  })

  it('keeps supported reaction summaries and omits invalid wire entries', () => {
    expect(GROUP_REACTION_OPTIONS).toEqual(['👍', '❤️', '😂', '🎉', '👀', '🙏'])
    expect(readGroupReactions({})).toEqual([])
    expect(readGroupReactions({ reactions: undefined })).toEqual([])

    expect(readGroupReactions({ reactions: [
      { emoji: '👍', count: 1 },
      { emoji: '❤️', count: 2, viewerReacted: true },
      { emoji: '😂', count: 3, viewerReacted: false },
      { emoji: '🎉', count: 100_000 },
      { emoji: '👀', count: 4 },
      { emoji: '🙏', count: 5 },
      null,
      [],
      { count: 1 },
      { emoji: '', count: 1 },
      { emoji: 'x'.repeat(17), count: 1 },
      { emoji: '👍', count: '1' },
      { emoji: '👍', count: 1.5 },
      { emoji: '👍', count: 0 },
      { emoji: '👍', count: 100_001 },
      { emoji: '👍', count: 1, viewerReacted: 'yes' },
      { emoji: '🚀', count: 1 },
    ] })).toEqual([
      { emoji: '👍', count: 1 },
      { emoji: '❤️', count: 2, viewerReacted: true },
      { emoji: '😂', count: 3, viewerReacted: false },
      { emoji: '🎉', count: 100_000 },
      { emoji: '👀', count: 4 },
      { emoji: '🙏', count: 5 },
    ])
  })

  it('normalizes whitespace and bounds compact reply previews', () => {
    expect(compactGroupQuote('  First\n\tsecond  ')).toBe('First second')
    expect(compactGroupQuote('short', 5)).toBe('short')
    expect(compactGroupQuote('  First   second  ', 10)).toBe('First sec…')
    expect(compactGroupQuote('long text', 1)).toBe('l…')
  })
})
