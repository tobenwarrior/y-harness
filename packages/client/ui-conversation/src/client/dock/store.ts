/**
 * Docked Session panes for the center column.
 *
 * The grid holds at most three columns and two rows, mirroring the desktop
 * client this fork is used beside. The first pane is the *ambient* Session the
 * rest of the client follows; dropping a Session from the sidebar grows the
 * grid toward the drop side.
 *
 * @module @deepseek-ai/dsh-client-ui-conversation/client/dock/store
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Widest grid the dock grows to. */
export const MAX_DOCK_COLUMNS = 3
/** Tallest grid the dock grows to. */
export const MAX_DOCK_ROWS = 2

/** Which way a split adds a cell. */
export type DockDirection = 'right' | 'down'

/** Edge of the conversation a dragged Session was released on. */
export type DropZone = 'left' | 'right' | 'top' | 'bottom'

/** Session one pane renders; `null` is the ambient Session the client already follows. */
export type DockedSession = SessionId | null

/** One docked pane, in reading order. */
export interface DockedPane {
  /** Session this pane renders. */
  readonly sessionId: DockedSession
}

/** Docked panes and the grid they are laid out in. */
export interface SessionDockState {
  /** Panes in reading order: left to right, then top to bottom. Never empty. */
  readonly panes: readonly DockedPane[]
  /** Grid width in panes, 1..{@link MAX_DOCK_COLUMNS}. */
  readonly columns: number
  /** Grid height in panes, 1..{@link MAX_DOCK_ROWS}. */
  readonly rows: number
}

/**
 * Own the docked grid: which Sessions are shown, and how the grid grows.
 *
 * React-free: the panel subscribes through the snapshot store and calls the
 * operations. A single pane is the ambient Session, which is what the client
 * showed before anything was docked.
 */
export class SessionDockStore {
  private readonly source: SnapshotStore<SessionDockState>
  /** Grid growth in the order it happened, so closing reverses the last one. */
  private readonly growth: DockDirection[] = []

  constructor() {
    this.source = createSnapshotStore<SessionDockState>({ panes: [{ sessionId: null }], columns: 1, rows: 1 })
  }

  /** The reading source the panel binds as a hook. */
  get observable(): SnapshotStore<SessionDockState> {
    return this.source
  }

  /**
   * Drop the pane at `index`, shrinking the grid with it.
   *
   * Closing reverses the most recent growth whichever pane held it: the grid
   * tracks growth order, not which pane each growth added.
   * @param index - pane position in reading order.
   * @returns whether a pane was removed; false for an unknown index or a single pane, which stays.
   */
  closePane(index: number): boolean {
    const state = this.source.getSnapshot()
    if (!state.panes.some((_, position) => position === index)) return false
    const grew = this.growth.pop()
    if (grew === undefined) return false
    this.source.set({
      panes: state.panes.filter((_, position) => position !== index),
      columns: grew === 'right' ? state.columns - 1 : state.columns,
      rows: grew === 'down' ? state.rows - 1 : state.rows,
    })
    return true
  }

  /**
   * Place a Session dragged from the sidebar, growing the grid toward the drop side.
   *
   * The dropped Session is known, so nothing is seeded: a left or top drop puts it
   * first in reading order, a right or bottom drop puts it last. A Session that
   * is already on screen is refused, so header controls resolve their pane by
   * Session without ambiguity.
   * @param sessionId - Session that was dragged in.
   * @param zone - edge of the conversation the pointer was released on.
   * @returns whether a pane was added.
   */
  dropSession(sessionId: SessionId, zone: DropZone): boolean {
    const state = this.source.getSnapshot()
    if (state.panes.some(pane => pane.sessionId === sessionId)) return false
    const direction: DockDirection = zone === 'top' || zone === 'bottom' ? 'down' : 'right'
    const columns = direction === 'right' ? state.columns + 1 : state.columns
    const rows = direction === 'down' ? state.rows + 1 : state.rows
    if (columns > MAX_DOCK_COLUMNS || rows > MAX_DOCK_ROWS) return false
    const pane: DockedPane = { sessionId }
    this.growth.push(direction)
    this.source.set({
      panes: zone === 'left' || zone === 'top' ? [pane, ...state.panes] : [...state.panes, pane],
      columns,
      rows,
    })
    return true
  }
}
