import { describe, expect, it } from 'vitest'
import { resolveGraphEdges } from '../src/client/graph-edges.ts'
import type { GraphEdge, GraphNode } from '../src/client/graph.ts'

const first: GraphNode = { id: 'first', label: 'First', kind: 'skill', groupId: null, explicitDegree: 1, radius: 5, x: 10, y: 20 }
const second: GraphNode = { ...first, id: 'second', label: 'Second', x: 30, y: 40 }
const edges: GraphEdge[] = [
  { source: 'first', target: 'second', kind: 'link' }, { source: 'second', target: 'first', kind: 'membership' },
]

describe('skill graph endpoint resolution', () => {
  it('preserves relationship order and the exact current node positions', () => {
    const resolved = resolveGraphEdges(edges, new Map([[first.id, first], [second.id, second]]))
    expect(resolved).toEqual([{ edge: edges[0], source: first, target: second }, { edge: edges[1], source: second, target: first }])
    expect(resolved[0]?.source).toBe(first)
    expect(resolved[0]?.target).toBe(second)
  })

  it.each([{ entries: [] }, { entries: [[first.id, first]] }, { entries: [[second.id, second]] }] as const)(
    'refuses a relationship with unavailable endpoints: %j', ({ entries }) => {
      expect(() => resolveGraphEdges(edges, new Map<string, GraphNode>(entries))).toThrow('Graph edge does not resolve to an existing node.')
    })

  it('accepts an empty relationship layer without requiring positions', () => {
    expect(resolveGraphEdges([], new Map())).toEqual([])
  })
})
