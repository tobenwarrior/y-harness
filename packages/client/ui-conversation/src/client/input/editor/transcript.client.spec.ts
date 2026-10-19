/**
 * readLastAssistantText: structural reader over chat snapshots.
 * Fakes implement only { locations.getTurn, nodes.get }.
 */
import { describe, expect, it } from 'vitest'
import { readLastAssistantText, type ChatSnapshotLike } from './transcript.ts'

function snapshot(
  turns: ReadonlyMap<number, readonly { key: string; node: { kind: string; data?: { blocks?: readonly unknown[] } } }[]>,
): ChatSnapshotLike {
  const byKey = new Map<string, { kind: string; data?: { blocks?: readonly unknown[] } }>()
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
const user = () => ({ kind: 'user', data: undefined })

describe('readLastAssistantText', () => {
  it('joins assistant text blocks in anchor order, skipping other rows', () => {
    const snap = snapshot(new Map([
      [1, [
        { key: 'u1', node: user() },
        { key: 'a1', node: assistant('First.') },
        { key: 't1', node: { kind: 'tool', data: undefined } },
        { key: 'a2', node: assistant('Second.') },
      ]],
    ]))
    expect(readLastAssistantText(snap, 1)).toBe('First.\nSecond.')
  })

  it('ignores non-text blocks and trims', () => {
    const snap = snapshot(new Map([
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
    const snap = snapshot(new Map([[3, [{ key: 'a1', node: assistant('abcdef') }]]]))
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
