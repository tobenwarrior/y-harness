/** Resolve graph relationships against the drawing layer's current node positions. */
import type { GraphEdge, GraphNode } from './graph.ts'

/**
 * Keep relationship order and refuse any edge whose endpoint is unavailable.
 * @param edges - explicit relationships in drawing order.
 * @param positions - the current node positions indexed by node id.
 * @returns each relationship with its source and target nodes.
 */
export function resolveGraphEdges(edges: readonly GraphEdge[],
  positions: ReadonlyMap<string, GraphNode>): { edge: GraphEdge; source: GraphNode; target: GraphNode }[] {
  return edges.map((edge) => {
    const source = positions.get(edge.source), target = positions.get(edge.target)
    if (source === undefined || target === undefined) throw new Error('Graph edge does not resolve to an existing node.')
    return { edge, source, target }
  })
}
