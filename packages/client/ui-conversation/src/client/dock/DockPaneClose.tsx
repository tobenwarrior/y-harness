/** Per-pane close control for the Session header utilities. */
import type { ReactNode } from 'react'
import { IconCloseOutlineRegular, Tooltip } from '@yharness/client-ui-primitives'
import type { HostObservable } from '@yharness/client-ui-slots'
import type { InjectFace, PropsLocale, PropsRuntime } from '@yharness/client-ui-slots'
import type { SessionDockState } from './store.ts'
import css from './DockPaneClose.module.css'

/** Dock bindings for the pane-close header contribution. */
export interface DockPaneCloseInjected {
  /** Docked panes and their grid, bound as useDock. */
  readonly hooks: { readonly dock: HostObservable<SessionDockState> }
  /** Close the pane at `index` in reading order. */
  readonly closePane: (index: number) => void
}

/** Props of the pane-close header contribution. */
export type DockPaneCloseProps = PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<'conversation'> & InjectFace<DockPaneCloseInjected>

/**
 * Close the docked pane showing this Session, beside the header corner control.
 *
 * Each pane's header resolves its own index by Session: drops never add a
 * Session that is already on screen, so the match is unambiguous. The ambient
 * pane, which the client follows, has no close control by design.
 * @param props - header scope Session, dock state, and the close action.
 * @returns the close control, or nothing outside a multi-pane dock.
 */
export function DockPaneClose({ sessionId, useDock, closePane, t }: DockPaneCloseProps): ReactNode {
  const panes = useDock(state => state.panes)
  if (panes.length <= 1) return null
  let index = -1
  for (let position = panes.length - 1; position >= 0; position -= 1) {
    if (panes[position]?.sessionId === sessionId) { index = position; break }
  }
  if (index === -1) return null
  return (
    <Tooltip label={t('dock.close')} side="bottom" delayMs={500}>
      <button type="button" className={css.close} aria-label={t('dock.close')} onClick={() => { closePane(index) }}>
        <IconCloseOutlineRegular />
      </button>
    </Tooltip>
  )
}
