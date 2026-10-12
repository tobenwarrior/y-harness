// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { SkillLibraryId, SkillLibraryItem } from '@deepseek-ai/dsh-skill-library/types'
import { SkillGraph } from '../src/client/SkillGraph.tsx'
import type { SkillLibraryPageProps } from '../src/client/SkillLibraryPage.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const dictionary = { ...commonEn, ...en }
const t: SkillLibraryPageProps['t'] = (key, params) => Object.entries(params ?? {}).reduce(
  (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), dictionary[key])
const longName = 'Review the complete release checklist before publishing a package'
const items: SkillLibraryItem[] = Array.from({ length: 24 }, (_, index) => ({
  id: `skill:${index}` as SkillLibraryId, name: index === 5 ? longName : `Workflow ${index}`,
  description: 'Sample data', provider: 'filesystem', source: 'project',
  path: `/sample/.dsh/skills/${index}/SKILL.md`, scope: 'project', projectIds: [index < 12 ? 'a' : 'b'],
  ownership: 'protected', status: 'active', shadowed: false, pinned: false, automaticCleanup: false,
  invocation: { modelInvocable: true, userInvocable: true }, contentHash: `hash:${index}`, bodyBytes: 400,
  usage: { coverage: 'unknown', loadCount: 0 },
  references: index > 0 && index < 5 ? [{ target: 'Workflow 0', kind: 'skill', resolvedId: 'skill:0' as SkillLibraryId }] : [],
  capabilities: { adopt: true, archive: false, restore: false, cleanup: false, native: false },
}))
const projects = [{ id: 'a', title: 'Project A', path: '/sample/a' }, { id: 'b', title: 'Project B', path: '/sample/b' }]
function fixture(selectedId: SkillLibraryId | null = null) {
  const onSelect = vi.fn(), onProject = vi.fn()
  const result = render(<SkillGraph items={items} projects={projects} selectedId={selectedId}
    onSelect={onSelect} onProject={onProject} t={t} />)
  const graph = screen.getByRole('application', { name: en.graphLabel })
  const visibleLabels = () => graph.querySelectorAll('[data-graph-label][data-label-visible="true"]').length
  return { ...result, graph, visibleLabels, onSelect, onProject }
}

describe('skill graph canvas', () => {
  it('keeps navigation in a floating overlay and opens the display explanation deliberately', () => {
    fixture()
    const controls = screen.getByRole('button', { name: 'Graph controls' })
    expect(controls.getAttribute('aria-expanded')).toBe('false')
    expect(controls.closest('[data-graph-overlay]')).not.toBeNull()
    expect(screen.queryByRole('region', { name: 'Graph controls' })).toBeNull()
    fireEvent.click(controls)
    const panel = screen.getByRole('region', { name: 'Graph controls' })
    expect(within(panel).getByText(en.graphExplicit)).toBeTruthy()
    expect(within(panel).getByText(en.membership)).toBeTruthy()
    expect(within(panel).getByText(en.explicitLink)).toBeTruthy()
    fireEvent.keyDown(panel, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Graph controls' })).toBeNull()
    expect(document.activeElement).toBe(controls)
  })

  it('reveals names progressively without discarding nodes or explicit edges', () => {
    const state = fixture()
    const nodes = state.graph.querySelectorAll('[data-graph-node]')
    expect(nodes).toHaveLength(26)
    const fitted = state.visibleLabels()
    expect(fitted).toBeGreaterThan(0)
    expect(fitted).toBeLessThan(nodes.length)
    fireEvent.click(screen.getByRole('button', { name: en.zoomOut }))
    fireEvent.click(screen.getByRole('button', { name: en.zoomOut }))
    expect(state.visibleLabels()).toBeLessThan(fitted)
    fireEvent.click(screen.getByRole('button', { name: en.fit }))
    fireEvent.click(screen.getByRole('button', { name: en.zoomIn }))
    fireEvent.click(screen.getByRole('button', { name: en.zoomIn }))
    expect(state.visibleLabels()).toBe(nodes.length)
    expect(state.graph.querySelectorAll('[data-graph-node]')).toHaveLength(26)
    expect(state.graph.querySelectorAll('[data-graph-layer="membership"] line')).toHaveLength(24)
    expect(state.graph.querySelectorAll('[data-graph-layer="links"] line')).toHaveLength(4)
    expect(Array.from(state.graph.querySelectorAll('line')).every(edge => edge.getAttribute('pointer-events') === 'none')).toBe(true)
  })

  it('paints every visible node above every generous pointer fallback', () => {
    const state = fixture()
    const hits = Array.from(state.graph.querySelectorAll('[data-graph-hit]'))
    const circles = Array.from(state.graph.querySelectorAll('[data-graph-node] circle'))
    expect(hits).toHaveLength(26)
    expect(circles).toHaveLength(26)
    // SVG paint order also owns pointer priority: no fallback may cover any visible glyph.
    for (const hit of hits) {
      expect(circles.every(circle => Boolean(hit.compareDocumentPosition(circle) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true)
    }
    expect(state.graph.querySelectorAll('[data-graph-layer="hit-targets"] [data-graph-hit]')).toHaveLength(26)
    expect(state.graph.querySelectorAll('[data-graph-node] [data-graph-hit]')).toHaveLength(0)
    expect(state.graph.querySelectorAll('[data-graph-node][role="button"][tabindex="0"]')).toHaveLength(26)
  })

  it('activates and highlights fallback hits without initiating canvas drag', () => {
    const state = fixture()
    const hit = state.graph.querySelector('[data-graph-hit-for="skill:6"]')
    if (hit === null) throw new Error('Expected a pointer fallback for Workflow 6')
    expect(hit.getAttribute('width')).toBe('48')
    expect(hit.getAttribute('height')).toBe('54')
    expect(hit.getAttribute('aria-hidden')).toBe('true')
    const capture = vi.fn()
    Object.defineProperty(state.graph, 'setPointerCapture', { value: capture })
    fireEvent(state.graph, new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    expect(capture).toHaveBeenCalledOnce()
    fireEvent.pointerUp(state.graph)
    capture.mockClear()
    fireEvent(hit, new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    expect(capture).not.toHaveBeenCalled()
    fireEvent.pointerEnter(hit)
    expect(screen.getByRole('button', { name: 'Open skill Workflow 6' }).getAttribute('data-graph-connected')).toBe('true')
    fireEvent.click(hit)
    expect(state.onSelect).toHaveBeenCalledWith('skill:6')
    fireEvent.pointerLeave(hit)
    expect(state.graph.querySelectorAll('[data-graph-connected="true"]')).toHaveLength(0)
  })

  it('preserves selected and focused full names at distant zoom and keyboard activation', () => {
    const state = fixture('skill:0' as SkillLibraryId)
    for (let index = 0; index < 6; index++) fireEvent.keyDown(state.graph, { key: '-' })
    const selected = screen.getByRole('button', { name: 'Open skill Workflow 0' })
    expect(selected.getAttribute('aria-pressed')).toBe('true')
    expect(selected.querySelector('[data-graph-label]')?.getAttribute('visibility')).toBe('visible')
    const longNode = screen.getByRole('button', { name: `Open skill ${longName}` })
    fireEvent.focus(longNode)
    expect(longNode.querySelector('[data-graph-label]')?.textContent).toBe(longName)
    expect(longNode.querySelector('[data-graph-label]')?.getAttribute('visibility')).toBe('visible')
    fireEvent.keyDown(longNode, { key: 'Enter' })
    expect(state.onSelect).toHaveBeenCalledWith('skill:5')
    fireEvent.keyDown(screen.getByRole('button', { name: 'Filter project Project A' }), { key: ' ' })
    expect(state.onProject).toHaveBeenCalledWith('a')
  })

  it('keeps a keyboard-focused name visible after the pointer leaves', () => {
    const state = fixture()
    for (let index = 0; index < 6; index++) fireEvent.keyDown(state.graph, { key: '-' })
    const node = screen.getByRole('button', { name: `Open skill ${longName}` })
    fireEvent.focus(node)
    fireEvent.pointerEnter(node)
    fireEvent.pointerLeave(node)
    expect(node.querySelector('[data-graph-label]')?.getAttribute('visibility')).toBe('visible')
    expect(node.querySelector('[data-graph-label]')?.textContent).toBe(longName)
    const other = screen.getByRole('button', { name: 'Open skill Workflow 6' })
    fireEvent.pointerEnter(other)
    fireEvent.pointerLeave(other)
    expect(node.querySelector('[data-graph-label]')?.getAttribute('visibility')).toBe('visible')
    fireEvent.blur(node)
    expect(node.querySelector('[data-graph-label]')?.getAttribute('visibility')).toBe('hidden')
  })

  it('retains keyboard pan and fit, and derives visual groups and radius from relationships', () => {
    const state = fixture()
    const layer = state.graph.querySelector('[data-graph-transform]')
    const before = layer?.getAttribute('transform')
    fireEvent.keyDown(state.graph, { key: '+' })
    expect(layer?.getAttribute('transform')).not.toBe(before)
    fireEvent.keyDown(state.graph, { key: 'ArrowRight' })
    expect(layer?.getAttribute('transform')).toMatch(/translate\(-/)
    fireEvent.click(screen.getByRole('button', { name: en.fit }))
    expect(layer?.getAttribute('transform')).toBe('translate(0 0) scale(1)')
    const hub = screen.getByRole('button', { name: 'Open skill Workflow 0' })
    const isolated = screen.getByRole('button', { name: 'Open skill Workflow 6' })
    expect(Number(hub.querySelector('circle')?.getAttribute('r'))).toBeGreaterThan(Number(isolated.querySelector('circle')?.getAttribute('r')))
    expect(hub.getAttribute('data-graph-group')).toBe('project:a')
    expect(screen.getByRole('button', { name: 'Open skill Workflow 12' }).getAttribute('data-graph-group')).toBe('project:b')
  })

  it('marks only the active node and its actual neighbors', () => {
    const state = fixture()
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Open skill Workflow 0' }))
    const connected = Array.from(state.graph.querySelectorAll('[data-graph-connected="true"]')).map(node => node.getAttribute('aria-label'))
    expect(connected).toEqual(expect.arrayContaining(['Open skill Workflow 0', 'Open skill Workflow 1', 'Filter project Project A']))
    expect(connected).not.toContain('Open skill Workflow 6')
    expect(connected).not.toContain('Filter project Project B')
    fireEvent.pointerLeave(screen.getByRole('button', { name: 'Open skill Workflow 0' }))
    expect(state.graph.querySelectorAll('[data-graph-connected="true"]')).toHaveLength(0)
  })
})
