/** Deterministic layout for explicit membership and skill relationships. */

/** Metadata used by the drawing layer; it contains no instruction bodies. */
export interface GraphInput {
  readonly groups: readonly { readonly id: string; readonly label: string }[]
  readonly skills: readonly { readonly id: string; readonly label: string; readonly groupId: string }[]
  readonly links: readonly { readonly source: string; readonly target: string }[]
  readonly memberships?: readonly { readonly group: string; readonly skill: string }[]
}

/** A navigable node; size reflects known explicit link degree, never inferred usage. */
export interface GraphNode {
  readonly id: string
  readonly label: string
  readonly kind: 'group' | 'skill'
  readonly groupId: string | null
  readonly explicitDegree: number
  readonly radius: number
  readonly x: number
  readonly y: number
}
/** Only source-declared relationships become edges. */
export interface GraphEdge { readonly source: string; readonly target: string; readonly kind: 'membership' | 'link' }
/** Complete drawing data and its enclosing bounds. */
export interface GraphLayout {
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
  readonly width: number
  readonly height: number
}
/** Local viewport transformation, independent of the skill source. */
export interface GraphTransform { readonly scale: number; readonly x: number; readonly y: number }

interface LayoutPoint {
  readonly node: Omit<GraphNode, 'x' | 'y'>
  readonly anchorX: number
  readonly anchorY: number
  readonly order: number
  x: number
  y: number
  forceX: number
  forceY: number
}

const compareIds = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
const goldenAngle = Math.PI * (3 - Math.sqrt(5))

function seedPhase(id: string): number {
  let hash = 2166136261
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619)
  return (hash >>> 0) / 0x100000000 * Math.PI * 2
}

/**
 * Place every skill using stronger explicit-link springs and weaker membership springs.
 * Coordinates use stable ids and 36 fixed passes with at most 16 nearby samples per
 * spatial cell; no animation loop, similarity edges, or instruction reads are used.
 * @param input - actual groups, memberships, and explicit skill links.
 * @returns deterministic nodes, valid edges, and enclosing drawing bounds.
 */
export function layoutGraph(input: GraphInput): GraphLayout {
  const groupIds = new Set(input.groups.map(group => group.id))
  const skillIds = new Set(input.skills.map(skill => skill.id))
  const byGroup = new Map<string | null, GraphInput['skills'][number][]>()
  for (const skill of input.skills) {
    const key = groupIds.has(skill.groupId) ? skill.groupId : null
    const skills = byGroup.get(key) ?? []
    skills.push(skill)
    byGroup.set(key, skills)
  }
  const edges: GraphEdge[] = []
  const memberships = new Set<string>()
  for (const group of input.groups) {
    for (const skill of byGroup.get(group.id) ?? []) {
      edges.push({ source: group.id, target: skill.id, kind: 'membership' })
      memberships.add(`${group.id}\0${skill.id}`)
    }
  }
  for (const membership of input.memberships ?? []) {
    const key = `${membership.group}\0${membership.skill}`
    if (groupIds.has(membership.group) && skillIds.has(membership.skill) && !memberships.has(key)) {
      edges.push({ source: membership.group, target: membership.skill, kind: 'membership' })
      memberships.add(key)
    }
  }
  const seen = new Set<string>()
  const degrees = new Map<string, number>()
  for (const link of input.links) {
    const key = [link.source, link.target].sort(compareIds).join('\0')
    if (skillIds.has(link.source) && skillIds.has(link.target) && link.source !== link.target && !seen.has(key)) {
      edges.push({ ...link, kind: 'link' })
      seen.add(key)
      degrees.set(link.source, (degrees.get(link.source) ?? 0) + 1)
      degrees.set(link.target, (degrees.get(link.target) ?? 0) + 1)
    }
  }
  const orderedNodes: Omit<GraphNode, 'x' | 'y'>[] = input.groups.map(group => ({
    ...group, kind: 'group', groupId: group.id, explicitDegree: 0, radius: 11,
  }))
  for (const group of input.groups) {
    for (const skill of byGroup.get(group.id) ?? []) {
      const explicitDegree = degrees.get(skill.id) ?? 0
      orderedNodes.push({
        id: skill.id, label: skill.label, kind: 'skill', groupId: group.id, explicitDegree,
        radius: Math.min(10, 5 + Math.sqrt(explicitDegree) * 1.25),
      })
    }
  }
  for (const skill of byGroup.get(null) ?? []) {
    const explicitDegree = degrees.get(skill.id) ?? 0
    orderedNodes.push({
      id: skill.id, label: skill.label, kind: 'skill', groupId: null, explicitDegree,
      radius: Math.min(10, 5 + Math.sqrt(explicitDegree) * 1.25),
    })
  }

  const width = Math.max(720, Math.ceil(Math.sqrt(orderedNodes.length) * 84))
  const height = Math.max(480, Math.ceil(width / 1.5))
  const groups = [...input.groups].sort((left, right) => compareIds(left.id, right.id))
  const anchors = new Map<string, { x: number; y: number }>()
  groups.forEach((group, index) => {
    const angle = index * goldenAngle + 0.25
    const distance = groups.length === 1 ? 0 : Math.sqrt((index + 0.5) / groups.length) * 0.35
    anchors.set(group.id, { x: width * (0.5 + Math.cos(angle) * distance), y: height * (0.5 + Math.sin(angle) * distance) })
  })
  const seeds = new Map<string, { x: number; y: number }>(anchors)
  for (const [groupId, skills] of byGroup) {
    const center = groupId === null ? { x: width / 2, y: height / 2 } : anchors.get(groupId) as { x: number; y: number }
    const sorted = [...skills].sort((left, right) => compareIds(left.id, right.id))
    sorted.forEach((skill, index) => {
      const angle = index * goldenAngle + seedPhase(skill.id) * 0.2
      const distance = 28 + Math.sqrt(index + 1) * 27
      seeds.set(skill.id, { x: center.x + Math.cos(angle) * distance, y: center.y + Math.sin(angle) * distance })
    })
  }
  const points: LayoutPoint[] = orderedNodes.map((node, order) => {
    const seed = seeds.get(node.id) as { x: number; y: number }
    const margin = node.radius + 28
    const x = Math.max(margin, Math.min(width - margin, seed.x))
    const y = Math.max(margin, Math.min(height - margin, seed.y))
    return { node, anchorX: x, anchorY: y, order, x, y, forceX: 0, forceY: 0 }
  }).sort((left, right) => compareIds(left.node.id, right.node.id))
  const byId = new Map(points.map(point => [point.node.id, point]))
  const springs = edges.map((edge) => {
    const first = byId.get(edge.source) as LayoutPoint
    const second = byId.get(edge.target) as LayoutPoint
    const forward = compareIds(first.node.id, second.node.id) < 0
    const source = forward ? first : second
    const target = forward ? second : first
    return { source, target, kind: edge.kind }
  }).sort((left, right) => compareIds(left.source.node.id, right.source.node.id)
    || compareIds(left.target.node.id, right.target.node.id) || compareIds(left.kind, right.kind))

  for (let pass = 0; pass < 36; pass++) {
    const cells = new Map<string, LayoutPoint[]>()
    points.forEach((point) => {
      point.forceX = (point.anchorX - point.x) * (point.node.kind === 'group' ? 0.03 : 0.001)
      point.forceY = (point.anchorY - point.y) * (point.node.kind === 'group' ? 0.03 : 0.001)
      const key = `${Math.floor(point.x / 64)},${Math.floor(point.y / 64)}`
      const cell = cells.get(key) ?? []
      cell.push(point)
      cells.set(key, cell)
    })
    points.forEach((point, index) => {
      const cellX = Math.floor(point.x / 64)
      const cellY = Math.floor(point.y / 64)
      for (let offsetX = -1; offsetX <= 1; offsetX++) {
        for (let offsetY = -1; offsetY <= 1; offsetY++) {
          const cell = cells.get(`${cellX + offsetX},${cellY + offsetY}`)
          if (!cell) continue
          const start = index % cell.length
          const nearby = cell.slice(start, start + 16)
          if (nearby.length < 16) nearby.push(...cell.slice(0, Math.min(start, 16 - nearby.length)))
          for (const other of nearby) {
            if (other === point) continue
            let dx = point.x - other.x
            let dy = point.y - other.y
            let distance = Math.hypot(dx, dy)
            if (distance === 0) {
              const angle = seedPhase(point.node.id) + seedPhase(other.node.id)
              const direction = compareIds(point.node.id, other.node.id) < 0 ? 1 : -1
              dx = Math.cos(angle) * direction
              dy = Math.sin(angle) * direction
              distance = 1
            }
            const gap = point.node.radius + other.node.radius + 22 - distance
            if (gap <= 0) continue
            point.forceX += dx / distance * gap * 0.28
            point.forceY += dy / distance * gap * 0.28
          }
        }
      }
    })
    for (const spring of springs) {
      const { source, target } = spring
      const dx = target.x - source.x
      const dy = target.y - source.y
      const distance = Math.max(1, Math.hypot(dx, dy))
      const group = source.node.kind === 'group' ? source : target
      const rest = spring.kind === 'link' ? 68 : 72 + Math.sqrt(byGroup.get(group.node.id)?.length ?? 0) * 10
      const strength = (distance - rest) * (spring.kind === 'link' ? 0.065 : 0.01) / distance
      source.forceX += dx * strength
      source.forceY += dy * strength
      target.forceX -= dx * strength
      target.forceY -= dy * strength
    }
    points.forEach((point) => {
      const movement = Math.max(1, Math.hypot(point.forceX, point.forceY) / 12)
      const margin = point.node.radius + 28
      point.x = Math.max(margin, Math.min(width - margin, point.x + point.forceX / movement))
      point.y = Math.max(margin, Math.min(height - margin, point.y + point.forceY / movement))
    })
  }
  const nodes = [...points].sort((left, right) => left.order - right.order)
    .map(point => ({ ...point.node, x: point.x, y: point.y }))
  return { nodes, edges, width, height }
}

/**
 * Zoom around a fixed viewport point, with bounded scale.
 * @param current - current viewport transformation.
 * @param factor - multiplicative zoom step.
 * @param point - cursor or viewport center in drawing coordinates.
 * @returns the bounded transform preserving the point's world coordinate.
 */
export function zoomGraph(current: GraphTransform, factor: number, point: { x: number; y: number }): GraphTransform {
  const scale = Math.max(0.25, Math.min(4, current.scale * factor))
  const ratio = scale / current.scale
  return { scale, x: point.x - (point.x - current.x) * ratio, y: point.y - (point.y - current.y) * ratio }
}
