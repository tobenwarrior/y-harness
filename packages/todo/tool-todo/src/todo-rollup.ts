/**
 * Nested todo progress with rollup (clean-room behavior spec: Claude Desktop's
 * checklist — a parent row reading "Build foundations (tasks 1-5) — 3/5 done"
 * with "1 running task" beneath it).
 *
 * The harness todo model is deliberately flat and identity-free: `TodoItem`
 * carries only `content` and `status`, and every `todo/write` replaces the
 * whole list. This module adds hierarchy WITHOUT breaking that discipline —
 * children nest inline, so nothing needs a stable id and last-write-wins still
 * holds.
 *
 * It is a pure derivation over the existing value: `rollupTodos(todos)` accepts
 * a plain `TodoItem[]` unchanged (children are optional), so a flat list keeps
 * exactly today's counts.
 */

/** Lifecycle state of one todo entry (mirrors the domain union). */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

/**
 * One todo entry, optionally containing sub-tasks. Structurally compatible with
 * the domain `TodoItem`, so existing lists pass through untouched.
 */
export interface TodoNodeLike {
  /** What this entry is — a short imperative line. */
  readonly content: string
  /** The entry's own declared state. */
  readonly status: TodoStatus
  /**
   * Sub-tasks. A parent groups work; the leaves are the work items the counts
   * describe. Omitted or empty means this entry is itself a work item.
   */
  readonly children?: readonly TodoNodeLike[] | undefined
}

/** Derived progress for one entry and its subtree. */
export interface TodoRollup {
  readonly content: string
  /**
   * The entry's own declared status. A parent may declare something its
   * subtree contradicts; the UI can surface that divergence rather than hide it.
   */
  readonly declared: TodoStatus
  /**
   * The status to display:
   * - a leaf uses its own declared status;
   * - a parent derives from its leaves — `completed` when every leaf is,
   *   `in_progress` when any leaf is underway (or when work is partly done and
   *   more remains), otherwise `pending`.
   */
  readonly effective: TodoStatus
  /** Completed leaf descendants, including this entry when it is a leaf. */
  readonly completed: number
  /** Running leaf descendants. */
  readonly running: number
  /** Total leaf descendants, including this entry when it is a leaf. */
  readonly total: number
  /** Child rollups in input order; empty for a leaf. */
  readonly children: readonly TodoRollup[]
}

/** Whether one entry is a group (has at least one child). */
function isGroup(node: TodoNodeLike): boolean {
  return node.children !== undefined && node.children.length > 0
}

/**
 * Derive the display status of a group from its leaves.
 *
 * Partly-done work is `in_progress` even when nothing is literally running:
 * three of five finished is underway, not pending, and a parent that reads
 * `pending` beside a `3/5` count would be self-contradictory.
 */
function deriveGroupStatus(completed: number, running: number, total: number): TodoStatus {
  if (total > 0 && completed === total) return 'completed'
  if (running > 0) return 'in_progress'
  if (completed > 0) return 'in_progress'
  return 'pending'
}

/**
 * Roll up progress for a todo list.
 * @param nodes - the current list; parents may nest children arbitrarily.
 * @returns one rollup per top-level entry, in input order.
 */
export function rollupTodos(nodes: readonly TodoNodeLike[]): readonly TodoRollup[] {
  return nodes.map(rollupNode)
}

/** Roll up one entry and its subtree. */
function rollupNode(node: TodoNodeLike): TodoRollup {
  if (!isGroup(node)) {
    const completed = node.status === 'completed' ? 1 : 0
    return {
      content: node.content,
      declared: node.status,
      effective: node.status,
      completed,
      running: node.status === 'in_progress' ? 1 : 0,
      total: 1,
      children: [],
    }
  }
  const children = (node.children ?? []).map(rollupNode)
  const completed = children.reduce((sum, child) => sum + child.completed, 0)
  const running = children.reduce((sum, child) => sum + child.running, 0)
  const total = children.reduce((sum, child) => sum + child.total, 0)
  return {
    content: node.content,
    declared: node.status,
    effective: deriveGroupStatus(completed, running, total),
    completed,
    running,
    total,
    children,
  }
}

/** "3/5 done", or "done" once every leaf finished, or '' when there is no work. */
export function formatRollupProgress(rollup: TodoRollup): string {
  if (rollup.total === 0) return ''
  if (rollup.completed === rollup.total) return 'done'
  return `${String(rollup.completed)}/${String(rollup.total)} done`
}

/** "1 running task" / "2 running tasks", or '' when nothing is running. */
export function formatRollupRunning(rollup: TodoRollup): string {
  if (rollup.running === 0) return ''
  return rollup.running === 1 ? '1 running task' : `${String(rollup.running)} running tasks`
}

/**
 * The two-line label a parent row renders: a progress count and, when work is
 * underway, how many sub-tasks are running.
 * @param rollup - the entry's derived progress.
 * @returns the label parts; either may be empty.
 */
export function formatRollupLabel(rollup: TodoRollup): { progress: string; running: string } {
  return { progress: formatRollupProgress(rollup), running: formatRollupRunning(rollup) }
}

/** Totals across a whole list, for a panel header. */
export interface TodoTotals {
  readonly completed: number
  readonly running: number
  readonly total: number
}

/**
 * Sum a rolled-up list, counting leaves once.
 * @param rollups - top-level rollups.
 */
export function totalRollups(rollups: readonly TodoRollup[]): TodoTotals {
  return rollups.reduce<TodoTotals>(
    (sum, rollup) => ({
      completed: sum.completed + rollup.completed,
      running: sum.running + rollup.running,
      total: sum.total + rollup.total,
    }),
    { completed: 0, running: 0, total: 0 },
  )
}

/**
 * Flatten a rolled-up list depth-first, marking each entry's depth so a
 * renderer can indent without re-walking the tree.
 * @param rollups - top-level rollups.
 * @param depth - starting depth (0 for top level).
 */
export function flattenRollups(
  rollups: readonly TodoRollup[],
  depth = 0,
): readonly { readonly rollup: TodoRollup; readonly depth: number }[] {
  const out: { rollup: TodoRollup; depth: number }[] = []
  for (const rollup of rollups) {
    out.push({ rollup, depth })
    out.push(...flattenRollups(rollup.children, depth + 1))
  }
  return out
}
