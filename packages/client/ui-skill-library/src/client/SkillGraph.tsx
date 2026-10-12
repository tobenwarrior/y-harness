/** Interactive metadata graph; instruction bodies never enter the drawing data. */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconFullscreenOutlineRegular, IconPlusOutlineRegular, IconSlidersTwoOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillLibraryId, SkillLibraryItem, SkillLibraryProject } from '@deepseek-ai/dsh-skill-library/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { layoutGraph, zoomGraph, type GraphInput, type GraphTransform } from './graph.ts'
import css from './SkillGraph.module.css'

interface SkillGraphProps {
  readonly items: readonly SkillLibraryItem[]
  readonly projects: readonly SkillLibraryProject[]
  readonly selectedId: SkillLibraryId | null
  readonly onSelect: (id: SkillLibraryId) => void
  readonly onProject: (id: string) => void
  readonly t: PropsLocale<'skillLibrary'>['t']
}

/**
 * Draw explicit project membership and resolved skill links with pan/zoom navigation.
 * @param props - filtered metadata and selection callbacks.
 * @returns the graph, legend, and accessible navigation controls.
 */
export function SkillGraph({ items, projects, selectedId, onSelect, onProject, t }: SkillGraphProps): ReactNode {
  const input = useMemo((): GraphInput => {
    const used = new Set(items.flatMap(item => item.projectIds))
    const groups = projects.filter(project => used.has(project.id)).map(project => ({ id: `project:${project.id}`, label: project.title }))
    for (const id of used) {
      if (!projects.some(project => project.id === id)) groups.push({ id: `project:${id}`, label: id })
    }
    if (items.some(item => item.scope === 'shared')) groups.push({ id: 'shared', label: t('shared') })
    return {
      groups,
      skills: items.map(item => ({
        id: item.id, label: item.name,
        groupId: item.scope === 'shared' ? 'shared' : item.projectIds.length === 0 ? '' : `project:${item.projectIds[0]}`,
      })),
      memberships: items.filter(item => item.scope === 'project').flatMap(item =>
        item.projectIds.map(project => ({ group: `project:${project}`, skill: item.id }))),
      links: items.flatMap(item => item.references.flatMap(reference =>
        reference.resolvedId === undefined ? [] : [{ source: item.id, target: reference.resolvedId }])),
    }
  }, [items, projects, t])
  const graph = useMemo(() => layoutGraph(input), [input])
  const positions = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph])
  const [transform, setTransform] = useState<GraphTransform>({ scale: 1, x: 0, y: 0 })
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [controlsOpen, setControlsOpen] = useState(false)
  const controlsId = useId()
  const controlsButton = useRef<HTMLButtonElement>(null)
  const activeId = hoveredId ?? focusedId ?? selectedId
  const connected = new Set<string>(activeId === null ? [] : [activeId])
  for (const edge of graph.edges) {
    if (edge.source === activeId) connected.add(edge.target)
    if (edge.target === activeId) connected.add(edge.source)
  }
  const layoutId = graph.nodes.map(node => `${node.id}:${node.x}:${node.y}`).join('\0')
  useEffect(() => { setTransform({ scale: 1, x: 0, y: 0 }) }, [layoutId])
  const drag = useRef<{ pointerId: number; x: number; y: number; origin: GraphTransform } | null>(null)
  const svg = useRef<SVGSVGElement>(null)
  const zoom = (factor: number): void => { setTransform(value => zoomGraph(value, factor, { x: graph.width / 2, y: graph.height / 2 })) }
  const activate = (id: string): void => {
    const skill = items.find(item => item.id === id)
    if (skill !== undefined) onSelect(skill.id)
    else onProject(id === 'shared' ? 'shared' : id.slice('project:'.length))
  }
  return <div className={css.graphWrap} onKeyDown={(event) => {
    if (event.key === 'Escape' && controlsOpen) {
      event.preventDefault()
      setControlsOpen(false)
      controlsButton.current?.focus()
    }
  }}>
    <div className={css.graphOverlay} data-graph-overlay="">
      <Button size="sm" className={css.canvasAction} aria-label={t('zoomOut')} title={t('zoomOut')}
        onClick={() => { zoom(1 / 1.25) }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </Button>
      <Button size="sm" className={css.canvasAction} aria-label={t('zoomIn')} title={t('zoomIn')}
        icon={<IconPlusOutlineRegular size={16} />} onClick={() => { zoom(1.25) }} />
      <Button size="sm" className={css.canvasAction} aria-label={t('fit')} title={t('fit')}
        icon={<IconFullscreenOutlineRegular size={16} />} onClick={() => { setTransform({ scale: 1, x: 0, y: 0 }) }} />
      <span className={css.actionSeparator} aria-hidden="true" />
      <Button ref={controlsButton} size="sm" className={css.canvasAction} aria-label={t('graphControls')} title={t('graphControls')}
        aria-expanded={controlsOpen} aria-controls={controlsId}
        icon={<IconSlidersTwoOutlineRegular size={16} />} onClick={() => { setControlsOpen(value => !value) }} />
    </div>
    {controlsOpen && <section id={controlsId} className={css.graphControls} role="region" aria-label={t('graphControls')}>
      <h3>{t('graphDisplay')}</h3>
      <p>{t('graphExplicit')}</p>
      <div className={css.graphLegend}>
        <span><i className={css.membershipKey} aria-hidden="true" />{t('membership')}</span>
        <span><i className={css.linkKey} aria-hidden="true" />{t('explicitLink')}</span>
      </div>
      <p>{t('graphLabels')}</p>
      <p>{t('graphNodeSize')}</p>
      <ul className={css.groupLegend}>
        {graph.nodes.filter(node => node.kind === 'group').map(node => <li key={node.id}>
          <span className={clsx(css.groupSwatch, nodeColor(node.groupId))} aria-hidden="true" />{node.label}
        </li>)}
      </ul>
      <p>{t('graphHint')}</p>
    </section>}
    <svg ref={svg} className={css.graphCanvas} role="application" aria-label={t('graphLabel')} tabIndex={0}
      viewBox={`0 0 ${graph.width} ${graph.height}`}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === '+' || event.key === '=' || event.key === '-') {
          event.preventDefault()
          zoom(event.key === '-' ? 1 / 1.25 : 1.25)
          return
        }
        const offset = event.key === 'ArrowLeft' ? { x: 40, y: 0 } : event.key === 'ArrowRight' ? { x: -40, y: 0 }
          : event.key === 'ArrowUp' ? { x: 0, y: 40 } : event.key === 'ArrowDown' ? { x: 0, y: -40 } : null
        if (offset !== null) {
          event.preventDefault()
          setTransform(value => ({ ...value, x: value.x + offset.x, y: value.y + offset.y }))
        }
      }}
      onWheel={(event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return
        const ratio = Math.min(rect.width / graph.width, rect.height / graph.height)
        const point = { x: (event.clientX - rect.left - (rect.width - graph.width * ratio) / 2) / ratio,
          y: (event.clientY - rect.top - (rect.height - graph.height * ratio) / 2) / ratio }
        setTransform(value => zoomGraph(value, event.deltaY < 0 ? 1.1 : 1 / 1.1, point))
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || (event.target instanceof Element && event.target.closest('[data-graph-node], [data-graph-hit]') !== null)) return
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, origin: transform }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const start = drag.current
        if (start === null || start.pointerId !== event.pointerId) return
        const rect = event.currentTarget.getBoundingClientRect()
        const ratio = Math.min(rect.width / graph.width, rect.height / graph.height)
        if (ratio === 0) return
        setTransform({
          ...start.origin,
          x: start.origin.x + (event.clientX - start.x) / ratio,
          y: start.origin.y + (event.clientY - start.y) / ratio,
        })
      }}
      onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
      <g data-graph-transform="" transform={`translate(${transform.x} ${transform.y}) scale(${transform.scale})`}>
        {(['membership', 'link'] as const).map(kind => <g key={kind} data-graph-layer={kind === 'link' ? 'links' : 'membership'}>
          {graph.edges.filter(edge => edge.kind === kind).map((edge) => {
            const source = positions.get(edge.source), target = positions.get(edge.target)
            if (source === undefined || target === undefined) throw new Error('Graph edge does not resolve to an existing node.')
            return <line key={`${edge.kind}:${edge.source}:${edge.target}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y}
              pointerEvents="none"
              className={clsx(edge.kind === 'link' ? css.graphLink : css.graphMembership,
                (edge.source === activeId || edge.target === activeId) && css.graphActiveEdge)} />
          })}
        </g>)}
        <g data-graph-layer="hit-targets" aria-hidden="true">
          {graph.nodes.map(node => <rect key={node.id} data-graph-hit="" data-graph-hit-for={node.id}
            className={css.graphHit} transform={`translate(${node.x} ${node.y})`}
            x={-24} y={-20} width={48} height={54} fill="transparent" pointerEvents="all" aria-hidden="true"
            onClick={() => { activate(node.id) }}
            onPointerEnter={() => { setHoveredId(node.id) }} onPointerLeave={() => { setHoveredId(null) }} />)}
        </g>
        <g data-graph-layer="nodes">
          {graph.nodes.map((node) => {
            const active = node.id === selectedId || node.id === hoveredId || node.id === focusedId
            const visible = active || (node.kind === 'group' ? transform.scale >= 0.6
              : transform.scale >= (graph.nodes.length <= 20 ? 0.9 : node.explicitDegree >= 3 ? 0.8 : node.explicitDegree > 0 ? 1.15 : 1.5))
            return <g key={node.id} data-graph-node="" data-graph-id={node.id} data-graph-group={node.groupId ?? undefined}
              data-graph-connected={connected.has(node.id)} role="button" tabIndex={0}
              aria-label={t(node.kind === 'skill' ? 'graphNode' : 'graphProject', { name: node.label })}
              aria-pressed={node.kind === 'skill' ? selectedId === node.id : undefined}
              onPointerEnter={() => { setHoveredId(node.id) }} onPointerLeave={() => { setHoveredId(null) }}
              onFocus={() => { setFocusedId(node.id) }} onBlur={() => { setFocusedId(null) }}
              className={clsx(css.graphNode, nodeColor(node.groupId), node.kind === 'group' && css.graphGroup,
                selectedId === node.id && css.graphSelected, connected.has(node.id) && css.graphConnected,
                activeId !== null && !connected.has(node.id) && css.graphDimmed)}
              transform={`translate(${node.x} ${node.y})`} onClick={() => { activate(node.id) }}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(node.id) } }}>
              <title>{node.label}</title>
              <circle r={node.radius} pointerEvents="all" />
              <text data-graph-label="" data-label-visible={visible} visibility={visible ? 'visible' : 'hidden'}
                aria-hidden="true" y={node.radius + 16} textAnchor="middle" pointerEvents="none">
                {active || node.label.length <= 34 ? node.label : `${node.label.slice(0, 33)}…`}
              </text>
            </g>
          })}
        </g>
      </g>
    </svg>
    <span className={css.graphHint}>{t('graphHint')}</span>
  </div>
}

function nodeColor(groupId: string | null): string | undefined {
  if (groupId === null) return undefined
  let hash = 2166136261
  for (let index = 0; index < groupId.length; index++) hash = Math.imul(hash ^ groupId.charCodeAt(index), 16777619) >>> 0
  return css[`groupColor${hash % 7}`]
}
