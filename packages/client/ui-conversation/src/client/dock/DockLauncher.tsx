/** Header control that opens the first docked pane. */
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationDockFace } from './face.ts'
import { MAX_DOCK_COLUMNS, MAX_DOCK_ROWS } from './store.ts'
import css from './SessionDock.module.css'

/**
 * Render the split controls for the Session header.
 * @param props - dock state and its actions, plus locale copy.
 * @returns the two controls, or null once the grid is full.
 */
export function DockLauncher({ t, useDock, split }: PropsLocale<'conversation'> & InjectFace<ConversationDockFace>): ReactNode {
  const dock = useDock(state => state)
  if (dock.columns >= MAX_DOCK_COLUMNS && dock.rows >= MAX_DOCK_ROWS) return null
  return (
    <span className={css.launcher} data-yh-part="session-dock-launcher">
      <button type="button" className={css.control} onClick={() => { split('right') }}>{t('dock.splitRight')}</button>
      <button type="button" className={css.control} onClick={() => { split('down') }}>{t('dock.splitDown')}</button>
    </span>
  )
}
