import { describe, expect, it } from 'vitest'
import { layoutGraph, zoomGraph, type GraphInput } from '../src/client/graph.ts'

const input: GraphInput = {
  groups: [{ id: 'project-a', label: 'Project A' }, { id: 'shared', label: 'Shared' }],
  skills: [{ id: 'one', label: 'Release', groupId: 'project-a' }, { id: 'two', label: 'Review', groupId: 'shared' }],
  links: [{ source: 'one', target: 'two' }, { source: 'one', target: 'missing' }],
}

describe('skill graph navigation', () => {
  it('draws membership and existing explicit links without inferring relationships', () => {
    const graph = layoutGraph(input)
    expect(graph.nodes.map(node => [node.id, node.kind])).toEqual([
      ['project-a', 'group'], ['shared', 'group'], ['one', 'skill'], ['two', 'skill'],
    ])
    expect(graph.edges.map(edge => [edge.source, edge.target, edge.kind])).toEqual([
      ['project-a', 'one', 'membership'], ['shared', 'two', 'membership'], ['one', 'two', 'link'],
    ])
    expect(layoutGraph(input)).toEqual(graph)
    expect(graph.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true)
  })

  it('retains every skill when a project has many skills', () => {
    const graph = layoutGraph({ groups: [{ id: 'project', label: 'Project' }], links: [],
      skills: Array.from({ length: 130 }, (_, index) => ({ id: `s${index}`, label: `Skill ${index}`, groupId: 'project' })) })
    expect(graph.nodes).toHaveLength(131)
    expect(new Set(graph.nodes.map(node => `${node.x},${node.y}`)).size).toBe(131)
    expect(graph.nodes.every(node => node.x >= 0 && node.y >= 0 && node.x <= graph.width && node.y <= graph.height)).toBe(true)
  })

  it('shows every explicit project membership for skills shared by several projects', () => {
    const graph = layoutGraph({ ...input, memberships: [{ group: 'shared', skill: 'one' }, { group: 'missing', skill: 'one' }] })
    expect(graph.edges).toContainEqual({ source: 'shared', target: 'one', kind: 'membership' })
    expect(graph.edges.some(edge => edge.source === 'missing')).toBe(false)
  })

  it('keeps unassigned skill nodes without inventing project membership', () => {
    const graph = layoutGraph({ groups: [], links: [], skills: [{ id: 'orphan', label: 'Unassigned skill', groupId: '' }] })
    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]?.id).toBe('orphan')
    expect(graph.edges).toEqual([])
  })

  it('pulls explicitly linked skills together across project membership', () => {
    const separate: GraphInput = {
      groups: [{ id: 'alpha', label: 'Alpha' }, { id: 'beta', label: 'Beta' }],
      skills: [
        { id: 'alpha-release', label: 'Release', groupId: 'alpha' },
        { id: 'alpha-plan', label: 'Plan', groupId: 'alpha' },
        { id: 'beta-review', label: 'Review', groupId: 'beta' },
        { id: 'beta-notes', label: 'Notes', groupId: 'beta' },
      ],
      links: [],
    }
    const withoutLink = layoutGraph(separate)
    const withLink = layoutGraph({ ...separate, links: [{ source: 'alpha-release', target: 'beta-review' }] })
    const distance = (graph: ReturnType<typeof layoutGraph>) => {
      const release = graph.nodes.find(node => node.id === 'alpha-release')!
      const review = graph.nodes.find(node => node.id === 'beta-review')!
      return Math.hypot(release.x - review.x, release.y - review.y)
    }
    expect(distance(withLink)).toBeLessThan(distance(withoutLink) * 0.85)
    expect(withLink.nodes).not.toEqual(withoutLink.nodes)
    expect(withLink.edges.filter(edge => edge.kind === 'link')).toEqual([
      { source: 'alpha-release', target: 'beta-review', kind: 'link' },
    ])
  })

  it('uses known source membership and unique explicit degree for bounded node sizes', () => {
    const graph = layoutGraph({
      groups: [{ id: 'project', label: 'Project' }],
      skills: [
        { id: 'hub', label: 'Hub', groupId: 'project' },
        ...Array.from({ length: 30 }, (_, index) => ({ id: `leaf-${index}`, label: `Leaf ${index}`, groupId: 'project' })),
        { id: 'orphan', label: 'Orphan', groupId: 'missing' },
      ],
      links: [
        ...Array.from({ length: 30 }, (_, index) => ({ source: 'hub', target: `leaf-${index}` })),
        { source: 'leaf-0', target: 'hub' }, { source: 'hub', target: 'hub' }, { source: 'hub', target: 'missing' },
      ],
    })
    const project = graph.nodes.find(node => node.id === 'project')!
    const hub = graph.nodes.find(node => node.id === 'hub')!
    const leaf = graph.nodes.find(node => node.id === 'leaf-0')!
    const orphan = graph.nodes.find(node => node.id === 'orphan')!
    expect(project.groupId).toBe('project')
    expect(project.explicitDegree).toBe(0)
    expect(project.radius).toBeGreaterThan(hub.radius)
    expect(hub.groupId).toBe('project')
    expect(hub.explicitDegree).toBe(30)
    expect(leaf.explicitDegree).toBe(1)
    expect(orphan.groupId).toBeNull()
    expect(orphan.explicitDegree).toBe(0)
    expect(hub.radius).toBeGreaterThan(leaf.radius)
    expect(leaf.radius).toBeGreaterThan(orphan.radius)
    expect(graph.nodes.every(node => node.kind === 'group' || node.radius >= 5 && node.radius <= 10)).toBe(true)
  })

  it('keeps coordinates stable when metadata order changes or invalid links are added', () => {
    const graph = layoutGraph(input)
    const reordered = layoutGraph({
      ...input, groups: [...input.groups].reverse(), skills: [...input.skills].reverse(),
      links: [{ source: 'two', target: 'one' }, { source: 'one', target: 'two' }, { source: 'one', target: 'one' }],
    })
    const coordinates = (layout: ReturnType<typeof layoutGraph>) =>
      layout.nodes.map(node => ({ id: node.id, x: node.x, y: node.y })).sort((left, right) => left.id.localeCompare(right.id))
    expect(coordinates(reordered)).toEqual(coordinates(graph))
    expect(reordered.nodes.map(node => node.id)).toEqual(['shared', 'project-a', 'two', 'one'])
  })

  it('keeps unassigned skills distinct from an explicitly empty group id', () => {
    const graph = layoutGraph({
      groups: [{ id: '', label: 'Declared group' }],
      skills: [
        { id: 'member', label: 'Member', groupId: '' },
        { id: 'orphan', label: 'Orphan', groupId: 'missing' },
      ],
      links: [],
    })
    expect(graph.nodes.map(node => node.id)).toEqual(['', 'member', 'orphan'])
    expect(graph.nodes.find(node => node.id === 'member')?.groupId).toBe('')
    expect(graph.nodes.find(node => node.id === 'orphan')?.groupId).toBeNull()
    expect(graph.edges).toEqual([{ source: '', target: 'member', kind: 'membership' }])
  })

  it('keeps disconnected groups and a larger inventory visible within bounded drawing space', () => {
    const graph = layoutGraph({
      groups: Array.from({ length: 8 }, (_, index) => ({ id: `project-${index}`, label: `Project ${index}` })),
      skills: Array.from({ length: 1200 }, (_, index) => ({ id: `skill-${index}`, label: `Skill ${index}`, groupId: `project-${index % 8}` })),
      links: [],
    })
    expect(graph.nodes).toHaveLength(1208)
    expect(graph.edges).toHaveLength(1200)
    expect(new Set(graph.nodes.map(node => `${node.x},${node.y}`)).size).toBe(graph.nodes.length)
    expect(graph.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)
      && node.x >= node.radius && node.y >= node.radius
      && node.x <= graph.width - node.radius && node.y <= graph.height - node.radius)).toBe(true)
  })

  it('bounds zoom while preserving the world point under the cursor', () => {
    const next = zoomGraph({ scale: 1, x: 20, y: 30 }, 2, { x: 100, y: 100 })
    expect(next).toEqual({ scale: 2, x: -60, y: -40 })
    expect(zoomGraph(next, 20, { x: 100, y: 100 }).scale).toBe(4)
    expect(zoomGraph(next, 0.001, { x: 100, y: 100 }).scale).toBe(0.25)
  })
})
