/**
 * Docked Session panes for the center column.
 *
 * The grid holds at most three columns and two rows, mirroring the desktop
 * client this fork is used beside. The first pane is the *ambient* Session the
 * rest of the client follows; a pane the user adds takes the next Session that
 * is not docked yet, so splitting always shows work that is not already on
 * screen. A pane can be pointed at another Session afterwards.
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
  private candidates: () => readonly SessionId[] = () => []
  /** Splits in the order they happened, so closing reverses the last one. */
  private readonly growth: DockDirection[] = []

  constructor() {
    this.source = createSnapshotStore<SessionDockState>({ panes: [{ sessionId: null }], columns: 1, rows: 1 })
  }

  /** The reading source the panel binds as a hook. */
  get observable(): SnapshotStore<SessionDockState> {
    return this.source
  }

  /**
   * Declare how new panes pick a Session.
   * @param candidates - Sessions in the order they should be considered.
   */
  seedFrom(candidates: () => readonly SessionId[]): void {
    this.candidates = candidates
  }

  /**
   * Grow the grid, seeding the new cell.
   * @param direction - `right` adds a column, `down` adds a row.
   * @returns whether the grid grew; false at the grid's limit, or with no Session left to seed.
   */
  split(direction: DockDirection): boolean {
    const state = this.source.getSnapshot()
    const columns = direction === 'right' ? state.columns + 1 : state.columns
    const rows = direction === 'down' ? state.rows + 1 : state.rows
    if (columns > MAX_DOCK_COLUMNS || rows > MAX_DOCK_ROWS) return false
    const sessionId = this.nextSession(state)
    if (sessionId === undefined) return false
    this.growth.push(direction)
    this.source.set({ panes: [...state.panes, { sessionId }], columns, rows })
    return true
  }

  /**
   * Drop the last pane, shrinking the grid with it.
   * @returns whether a pane was removed; false for a single pane, which stays.
   */
  closeLast(): boolean {
    const state = this.source.getSnapshot()
    const grew = this.growth.pop()
    if (grew === undefined) return false
    this.source.set({
      panes: state.panes.slice(0, -1),
      columns: grew === 'right' ? state.columns - 1 : state.columns,
      rows: grew === 'down' ? state.rows - 1 : state.rows,
    })
    return true
  }

  /**
   * Place a Session dragged from the sidebar, growing the grid toward the drop side.
   *
   * The dropped Session is known, so nothing is seeded: a left or top drop puts it
   * first in reading order, a right or bottom drop puts it last.
   * @param sessionId - Session that was dragged in.
   * @param zone - edge of the conversation the pointer was released on.
   * @returns whether a pane was added.
   */
  dropSession(sessionId: SessionId, zone: DropZone): boolean {
    const state = this.source.getSnapshot()
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

  /**
   * Show another Session in one pane.
   * @param index - pane position in reading order.
   * @param sessionId - Session to render there.
   */
  show(index: number, sessionId: DockedSession): void {
    const state = this.source.getSnapshot()
    if (!state.panes.some((_, position) => position === index)) return
    this.source.set({
      ...state,
      panes: state.panes.map((pane, position) => position === index ? { sessionId } : pane),
    })
  }

  /** Whether another cell fits in the grid. */
  canSplit(): boolean {
    const state = this.source.getSnapshot()
    return state.columns < MAX_DOCK_COLUMNS || state.rows < MAX_DOCK_ROWS
  }

  /** The Session a new pane should take: the first candidate not docked already. */
  private nextSession(state: SessionDockState): SessionId | undefined {
    const docked = new Set(state.panes.map(pane => pane.sessionId))
    return this.candidates().find(candidate => !docked.has(candidate))
  }
}
