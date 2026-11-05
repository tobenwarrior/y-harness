import { describe, expect, it } from 'vitest'
import { mentionQueryAt, mentionTargets, resolveMentionTargets } from '../src/client/bot-mentions.ts'

describe('group Bot mentions', () => {
  const bots = [
    { id: 'bot-chief', name: 'Chief of staff' },
    { id: 'bot-analyst', name: 'Analyst (research)' },
  ]

  it('recognizes the partial mention at the cursor', () => {
    expect(mentionQueryAt('Please ask @Ana later', 15)).toBe('Ana')
    expect(mentionQueryAt('An email a@example.com', 22)).toBeNull()
  })

  it('keeps a selected identity through renames and refuses ambiguous typed names', () => {
    const duplicates = [{ id: 'bot-a', name: 'Scout' }, { id: 'bot-b', name: 'Scout' }]
    expect(resolveMentionTargets('@Scout check', duplicates, [])).toBeUndefined()
    expect(resolveMentionTargets('@Scout check', duplicates, [{ id: 'bot-b', name: 'Scout' }])).toEqual(['bot-b'])
    expect(resolveMentionTargets('@Scout check', [{ id: 'bot-b', name: 'Explorer' }], [{ id: 'bot-b', name: 'Scout' }])).toEqual(['bot-b'])
    expect(resolveMentionTargets('@Scout check', [{ id: 'bot-a', name: 'Scout' }], [{ id: 'bot-b', name: 'Scout' }])).toBeUndefined()
  })

  it('does not broadcast a partial Bot mention that matches a roster name', () => {
    expect(resolveMentionTargets('@Ana please check', bots, [])).toBeUndefined()
    expect(resolveMentionTargets('@someone else can help', bots, [])).toEqual([])
    expect(resolveMentionTargets('@Chief of staff please check', bots, [])).toEqual(['bot-chief'])
  })

  it('matches full names and treats punctuation in names literally', () => {
    expect(mentionTargets('@Chief of staff and @Analyst (research), please check', bots))
      .toEqual(['bot-chief', 'bot-analyst'])
    expect(mentionTargets('@Analyst research please check', bots)).toEqual([])
  })
})
