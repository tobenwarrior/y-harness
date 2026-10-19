/** Grid of docked Session panes for the center column. */
import type { ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DockDirection, DockedSession, SessionDockState } from './store.ts'
import css from './SessionDock.module.css'

/** Props of the docked grid. */
export interface SessionDockProps {
  /** Docked panes and their grid. */
  readonly state: SessionDockState
  /** Sessions the pane picker offers, in list order. */
  readonly sessions: readonly SessionId[]
  /** Label for one Session. */
  readonly titleOf: (sessionId: SessionId) => string
  /** Label for the ambient Session the client already follows. */
  readonly ambientLabel: string
  /** Body of one pane; the caller binds the Session scope. */
  readonly renderBody: (sessionId: DockedSession) => ReactNode
  /** Grow the grid; `direction` is the edge the new pane lands on. */
  readonly onSplit: (direction: DockDirection) => void
  /** Drop the last pane. */
  readonly onClose: () => void
  /** Show another Session in one pane. */
  readonly onShow: (index: number, sessionId: DockedSession) => void
  /** Whether another pane fits. */
  readonly canSplit: boolean
  /** Localized control labels. */
  readonly labels: {
    readonly splitRight: string
    readonly splitDown: string
    readonly close: string
    readonly pane: string
  }
}

/**
 * Render the docked Session grid, one pane per cell.
 * @param props - docked state, Session labels, and the pane controls.
 * @returns the grid.
 */
export function SessionDock({
  state, sessions, titleOf, ambientLabel, renderBody, onSplit, onClose, onShow, canSplit, labels,
}: SessionDockProps): ReactNode {
  return (
    <div
      className={css.grid}
      data-yh-part="session-dock"
      data-dock-columns={state.columns}
      data-dock-rows={state.rows}
      style={{ gridTemplateColumns: `repeat(${state.columns}, minmax(0, 1fr))` }}
    >
      {state.panes.map((pane, index) => (
        <section className={css.pane} key={`${pane.sessionId ?? 'ambient'}-${String(index)}`} aria-label={labels.pane}>
          <header className={css.header}>
            <select
              className={css.picker}
              value={pane.sessionId ?? ''}
              aria-label={labels.pane}
              onChange={(event) => { onShow(index, event.currentTarget.value === '' ? null : event.currentTarget.value as SessionId) }}
            >
              <option value="">{ambientLabel}</option>
              {sessions.map(sessionId => <option key={sessionId} value={sessionId}>{titleOf(sessionId)}</option>)}
            </select>
            {canSplit && <button type="button" className={css.control} onClick={() => { onSplit('right') }}>{labels.splitRight}</button>}
            {canSplit && <button type="button" className={css.control} onClick={() => { onSplit('down') }}>{labels.splitDown}</button>}
            {state.panes.length > 1 && <button type="button" className={css.control} onClick={onClose}>{labels.close}</button>}
          </header>
          <div className={css.body}>{renderBody(pane.sessionId)}</div>
        </section>
      ))}
    </div>
  )
}
