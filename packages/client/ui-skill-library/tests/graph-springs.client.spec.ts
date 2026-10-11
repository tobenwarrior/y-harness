import { describe, expect, it } from 'vitest'
import { compareGraphSprings } from '../src/client/graph.ts'

function spring(source: string, target: string, kind: 'link' | 'membership' = 'link'): Parameters<typeof compareGraphSprings>[0] {
  return { source: { node: { id: source } }, target: { node: { id: target } }, kind }
}

describe('skill graph spring ordering', () => {
  it.each([
    { label: 'source ids', before: spring('a', 'z'), after: spring('b', 'a') },
    { label: 'target ids after equal sources', before: spring('a', 'b'), after: spring('a', 'c') },
    { label: 'relationship kinds after equal endpoints', before: spring('a', 'b', 'link'), after: spring('a', 'b', 'membership') },
  ])('orders $label consistently in both directions', ({ before, after }) => {
    expect(compareGraphSprings(before, after)).toBe(-1)
    expect(compareGraphSprings(after, before)).toBe(1)
  })

  it('treats equal endpoint ids and relationship kinds as equal', () => {
    expect(compareGraphSprings(spring('a', 'b'), spring('a', 'b'))).toBe(0)
  })

  it('produces the same relationship order when input order changes', () => {
    const ordered = [spring('a', 'b', 'link'), spring('a', 'b', 'membership'), spring('a', 'c'), spring('b', 'c')]
    expect([...ordered].reverse().sort(compareGraphSprings)).toEqual(ordered)
  })
})
