/** Grid of docked Session panes for the center column. */
import type { ReactNode } from 'react'
import type { DockedSession, SessionDockState } from './store.ts'
import css from './SessionDock.module.css'

/** Props of the docked grid. */
export interface SessionDockProps {
  /** Docked panes and their grid. */
  readonly state: SessionDockState
  /** Body of one pane; the caller binds the Session scope. */
  readonly renderBody: (sessionId: DockedSession) => ReactNode
}

/**
 * Render the docked Session grid, one pane per cell.
 * Pane controls live in the Session header utilities; the grid only lays out bodies.
 * @param props - docked state and the pane body renderer.
 * @returns the grid.
 */
export function SessionDock({ state, renderBody }: SessionDockProps): ReactNode {
  return (
    <div
      className={css.grid}
      data-yh-part="session-dock"
      data-dock-columns={state.columns}
      data-dock-rows={state.rows}
      style={{ gridTemplateColumns: `repeat(${state.columns}, minmax(0, 1fr))` }}
    >
      {state.panes.map((pane, index) => (
        <section className={css.pane} key={`${pane.sessionId ?? 'ambient'}-${String(index)}`}>
          <div className={css.body}>{renderBody(pane.sessionId)}</div>
        </section>
      ))}
    </div>
  )
}
