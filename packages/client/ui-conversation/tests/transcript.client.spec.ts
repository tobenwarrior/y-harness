/**
 * readLastAssistantText: structural reader over chat snapshots.
 * Fakes implement only { locations.getTurn, nodes.get }.
 */
import { describe, expect, it } from 'vitest'
import { readLastAssistantText, type ChatSnapshotLike } from '../src/client/input/editor/transcript.ts'

/** One row in a fake turn: a node that may or may not carry blocks. */
interface FakeNode {
  readonly kind: string
  /** Omitted for rows with no blocks (the real user/tool rows carry none). */
  readonly data?: { readonly blocks?: readonly unknown[] } | undefined
}
interface FakeEntry {
  readonly key: string
  readonly node: FakeNode
}

function snapshot(turns: ReadonlyMap<number, readonly FakeEntry[]>): ChatSnapshotLike {
  const byKey = new Map<string, FakeNode>()
  const byTurn = new Map<number, string[]>()
  for (const [turn, entries] of turns) {
    byTurn.set(turn, entries.map((entry) => {
      byKey.set(entry.key, entry.node)
      return entry.key
    }))
  }
  return {
    locations: { getTurn: (turn: number) => byTurn.get(turn) ?? [] },
    nodes: { get: (key: string) => byKey.get(key) },
  }
}

const assistant = (text: string) => ({
  kind: 'assistant',
  data: { blocks: [{ kind: 'text', text }] },
})
const user = (): FakeNode => ({ kind: 'user' })

describe('readLastAssistantText', () => {
  it('joins assistant text blocks in anchor order, skipping other rows', () => {
    const snap = snapshot(new Map<number, readonly FakeEntry[]>([
      [1, [
        { key: 'u1', node: user() },
        { key: 'a1', node: assistant('First.') },
        { key: 't1', node: { kind: 'tool' } },
        { key: 'a2', node: assistant('Second.') },
      ]],
    ]))
    expect(readLastAssistantText(snap, 1)).toBe('First.\nSecond.')
  })

  it('ignores non-text blocks and trims', () => {
    const snap = snapshot(new Map<number, readonly FakeEntry[]>([
      [2, [{
        key: 'a1',
        node: {
          kind: 'assistant',
          data: {
            blocks: [
              { kind: 'reasoning', text: '  private  ' },
              { kind: 'tool-call', callId: 'c1', name: 'run', argsRaw: '{}' },
              { kind: 'text', text: '  Visible.  ' },
            ],
          },
        },
      }]],
    ]))
    expect(readLastAssistantText(snap, 2)).toBe('Visible.')
  })

  it('caps length and returns empty for unknown turns or snapshots', () => {
    const snap = snapshot(new Map<number, readonly FakeEntry[]>([[3, [{ key: 'a1', node: assistant('abcdef') }]]]))
    expect(readLastAssistantText(snap, 3, 4)).toBe('abcd')
    expect(readLastAssistantText(snap, 99)).toBe('')
    expect(readLastAssistantText(undefined, 3)).toBe('')
    expect(readLastAssistantText(null, 3)).toBe('')
  })

  it('survives hostile snapshot implementations', () => {
    const hostile = {
      locations: { getTurn: () => { throw new Error('gone') } },
      nodes: { get: () => { throw new Error('gone') } },
    }
    expect(readLastAssistantText(hostile, 1)).toBe('')
  })
})
