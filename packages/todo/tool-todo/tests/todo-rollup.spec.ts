/**
 * rollupTodos: hierarchy rolls up from leaves, a flat list keeps today's
 * counts exactly, and partly-done groups never read as pending.
 */
import { describe, expect, it } from 'vitest'
import {
  flattenRollups,
  formatRollupLabel,
  formatRollupProgress,
  formatRollupRunning,
  rollupTodos,
  totalRollups,
  type TodoNodeLike,
} from '../src/todo-rollup.ts'

/** The right-hand tree from the reference screenshot. */
const REFERENCE_TREE: readonly TodoNodeLike[] = [
  { content: 'Look at existing papertrade bots and Y Harness', status: 'completed' },
  { content: 'Brainstorm design and confirm with you', status: 'completed' },
  { content: 'Write design spec for your review', status: 'completed' },
  { content: 'Write implementation plan', status: 'completed' },
  {
    content: 'Build foundations (tasks 1-5)',
    status: 'in_progress',
    children: [
      { content: 'Task 1', status: 'completed' },
      { content: 'Task 2', status: 'completed' },
      { content: 'Task 3', status: 'completed' },
      { content: 'Task 4', status: 'in_progress' },
      { content: 'Task 5', status: 'pending' },
    ],
  },
  { content: 'Build engine, fake venue, grid (tasks 6-10)', status: 'pending' },
  { content: 'Build Papertrade connector (tasks 11-14)', status: 'pending' },
]

describe('flat lists keep today’s behavior', () => {
  it('counts every entry as one work item', () => {
    const todos = [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ] as const
    const rollups = rollupTodos(todos)
    expect(totalRollups(rollups)).toEqual({ completed: 1, running: 1, total: 3 })
    expect(rollups.map(r => r.effective)).toEqual(['completed', 'in_progress', 'pending'])
  })

  it('accepts plain TodoItem-shaped values with no children field', () => {
    // Structurally identical to the domain TodoItem.
    const items: readonly { content: string; status: 'pending' | 'in_progress' | 'completed' }[] = [
      { content: 'x', status: 'pending' },
    ]
    expect(rollupTodos(items)[0]).toMatchObject({ total: 1, completed: 0, running: 0, effective: 'pending' })
  })

  it('handles an empty list', () => {
    expect(rollupTodos([])).toEqual([])
    expect(totalRollups([])).toEqual({ completed: 0, running: 0, total: 0 })
  })
})

describe('group rollup', () => {
  it('counts leaves, not the parent row itself', () => {
    const rollups = rollupTodos(REFERENCE_TREE)
    const foundations = rollups[4]
    expect(foundations?.total).toBe(5)
    expect(foundations?.completed).toBe(3)
    expect(foundations?.running).toBe(1)
  })

  it('renders the reference labels', () => {
    const foundations = rollupTodos(REFERENCE_TREE)[4]
    if (foundations === undefined) throw new Error('unreachable')
    expect(formatRollupProgress(foundations)).toBe('3/5 done')
    expect(formatRollupRunning(foundations)).toBe('1 running task')
  })

  it('derives a group’s status from its leaves', () => {
    const effective = rollupTodos(REFERENCE_TREE).map(r => r.effective)
    // Four finished leaves, then the partly-done group, then pending groups.
    expect(effective).toEqual([
      'completed', 'completed', 'completed', 'completed',
      'in_progress', 'pending', 'pending',
    ])
  })

  it('marks a fully-finished group completed', () => {
    const rollup = rollupTodos([{
      content: 'all done',
      status: 'pending', // deliberately stale declaration
      children: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'completed' },
      ],
    }])[0]
    expect(rollup?.effective).toBe('completed')
    expect(formatRollupProgress(rollup!)).toBe('done')
  })

  it('never reports a partly-done group as pending', () => {
    const rollup = rollupTodos([{
      content: 'partly done',
      status: 'pending',
      children: [
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'pending' },
      ],
    }])[0]
    // A parent reading "pending" beside "1/2 done" would contradict itself.
    expect(rollup?.effective).toBe('in_progress')
  })

  it('keeps a group pending while nothing started', () => {
    const rollup = rollupTodos([{
      content: 'not started',
      status: 'pending',
      children: [
        { content: 'a', status: 'pending' },
        { content: 'b', status: 'pending' },
      ],
    }])[0]
    expect(rollup?.effective).toBe('pending')
  })

  it('rolls up nested groups recursively', () => {
    const rollup = rollupTodos([{
      content: 'outer',
      status: 'pending',
      children: [
        {
          content: 'inner A',
          status: 'pending',
          children: [
            { content: 'leaf 1', status: 'completed' },
            { content: 'leaf 2', status: 'in_progress' },
          ],
        },
        { content: 'inner B', status: 'completed' },
      ],
    }])[0]
    // Leaves only: 2 completed of 3.
    expect(rollup).toMatchObject({ completed: 2, running: 1, total: 3, effective: 'in_progress' })
    expect(rollup?.children[0]).toMatchObject({ completed: 1, running: 1, total: 2 })
    expect(rollup?.children[1]).toMatchObject({ completed: 1, running: 0, total: 1 })
  })

  it('records the declared status beside the derived one', () => {
    const rollup = rollupTodos([{
      content: 'group',
      status: 'completed',
      children: [{ content: 'still open', status: 'pending' }],
    }])[0]
    // Divergence is preserved, not hidden.
    expect(rollup?.declared).toBe('completed')
    expect(rollup?.effective).toBe('pending')
  })
})

describe('formatters', () => {
  it('pluralizes the running count', () => {
    const one = rollupTodos([{ content: 'g', status: 'pending', children: [{ content: 'a', status: 'in_progress' }] }])[0]!
    const two = rollupTodos([{
      content: 'g',
      status: 'pending',
      children: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }],
    }])[0]!
    expect(formatRollupRunning(one)).toBe('1 running task')
    expect(formatRollupRunning(two)).toBe('2 running tasks')
  })

  it('renders nothing for absent parts', () => {
    const idle = rollupTodos([{ content: 'leaf', status: 'pending' }])[0]!
    expect(formatRollupRunning(idle)).toBe('')
    expect(formatRollupLabel(idle).running).toBe('')
  })

  it('returns a label pair for a parent row', () => {
    const foundations = rollupTodos(REFERENCE_TREE)[4]!
    expect(formatRollupLabel(foundations)).toEqual({ progress: '3/5 done', running: '1 running task' })
  })
})

describe('flattenRollups', () => {
  it('walks depth-first with depth markers for indentation', () => {
    const flat = flattenRollups(rollupTodos(REFERENCE_TREE))
    expect(flat).toHaveLength(7 + 5)
    expect(flat[4]).toMatchObject({ depth: 0 })
    expect(flat[5]).toMatchObject({ depth: 1 })
    expect(flat[9]).toMatchObject({ depth: 1 })
    expect(flat[10]).toMatchObject({ depth: 0 })
  })
})
