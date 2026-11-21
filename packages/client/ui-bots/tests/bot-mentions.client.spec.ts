import { describe, expect, it } from 'vitest'
import {
  EVERYONE_MENTION, hasCompleteMention, mentionQueryAt, mentionTargets, removeCompleteMention, resolveMentionTargets,
} from '../src/client/bot-mentions.ts'

describe('group Bot mentions', () => {
  it('tracks and removes the complete Everyone token without touching ordinary text', () => {
    expect(hasCompleteMention('@everyone please review', EVERYONE_MENTION)).toBe(true)
    expect(hasCompleteMention('@everyoneElse please review', EVERYONE_MENTION)).toBe(false)
    expect(removeCompleteMention('@everyone please review', EVERYONE_MENTION)).toBe('please review')
    expect(removeCompleteMention('check @everyone, then @everyone.', EVERYONE_MENTION)).toBe('check, then.')
  })

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
    expect(resolveMentionTargets('@... please check', bots, [])).toEqual([])
    expect(resolveMentionTargets('@someone else can help', bots, [])).toEqual([])
    expect(resolveMentionTargets('@Chief of staff please check', bots, [])).toEqual(['bot-chief'])
  })

  it('matches full names and treats punctuation in names literally', () => {
    expect(mentionTargets('@Chief of staff and @Analyst (research), please check', bots))
      .toEqual(['bot-chief', 'bot-analyst'])
    expect(mentionTargets('@Analyst research please check', bots)).toEqual([])
  })

  it('requires an explicit Everyone selection before targeting the current group', () => {
    expect(resolveMentionTargets('@everyone please check', bots, [])).toBeUndefined()
    expect(resolveMentionTargets('@every please check', bots, [])).toBeUndefined()
    expect(resolveMentionTargets('@everyone please check', bots, [{ kind: 'everyone' }]))
      .toEqual(['bot-chief', 'bot-analyst'])
  })

  it('combines Everyone with named selections without changing named mention ids', () => {
    expect(resolveMentionTargets('@everyone and @Chief of staff', bots, [
      { kind: 'everyone' },
      { id: 'bot-chief', name: 'Chief of staff' },
    ])).toEqual(['bot-chief', 'bot-analyst'])
  })

  it('lets complete Eve names win over the reserved Everyone prefix', () => {
    const eveBots = [
      { id: 'bot-eve', name: 'Eve' },
      { id: 'bot-eve-research', name: 'Eve Research' },
      { id: 'bot-everyone', name: 'Everyone' },
    ]
    expect(resolveMentionTargets('@Eve please check', eveBots, [])).toEqual(['bot-eve'])
    expect(resolveMentionTargets('@Eve Research please check', eveBots, [])).toEqual(['bot-eve-research'])
    expect(resolveMentionTargets('@everyone please check', eveBots, [])).toBeUndefined()
    expect(resolveMentionTargets('@everyone please check', eveBots, [{ id: 'bot-everyone', name: 'Everyone' }]))
      .toEqual(['bot-everyone'])
    expect(resolveMentionTargets('@everyone please check', eveBots, [{ kind: 'everyone' }]))
      .toEqual(['bot-eve', 'bot-eve-research', 'bot-everyone'])
  })
})
