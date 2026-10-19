/** Grid of docked Session panes for the center column. */
import type { ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { IconCloseOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DockedSession, SessionDockState } from './store.ts'
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
  /** Close the pane at `index` in reading order. */
  readonly onClose: (index: number) => void
  /** Show another Session in one pane. */
  readonly onShow: (index: number, sessionId: DockedSession) => void
  /** Localized control labels. */
  readonly labels: {
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
  state, sessions, titleOf, ambientLabel, renderBody, onClose, onShow, labels,
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
            {state.panes.length > 1 && (
              <Tooltip label={labels.close} side="bottom" delayMs={500}>
                <button type="button" className={css.close} aria-label={labels.close} onClick={() => { onClose(index) }}>
                  <IconCloseOutlineRegular />
                </button>
              </Tooltip>
            )}
          </header>
          <div className={css.body}>{renderBody(pane.sessionId)}</div>
        </section>
      ))}
    </div>
  )
}
