/** Sidebar-foot status control for a pending or failed Compound skills check. */
import type { ReactNode } from 'react'
import {
  IconDownloadOutlineRegular, IconWarningTriangleOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { CompoundUpdateFace } from './controller.ts'
import css from './UpdateBadge.module.css'

/**
 * Render the update status control; nothing renders before the first reading
 * or after a successful check finds no pending revision. The host applies
 * Compound updates automatically, so a current-state button would be noise.
 * The control is icon-only in both sidebar widths; its tooltip and accessible
 * name identify Compound skills updates.
 * @param props - sidebar geometry, locale, and the indicator's data and actions.
 * @returns the status control, or null before the first reading/current state.
 */
export function UpdateBadge({ wide, t, useUpdate, show }: PropsRuntime<'sidebar.footer.action'> & PropsLocale<'compoundUpdate'> & InjectFace<CompoundUpdateFace>): ReactNode {
  const status = useUpdate(state => state.status)
  if (status === null || (status.error === null && !status.updateAvailable)) return null
  const failed = status.error !== null
  const title = failed ? t('badgeError') : t('badge')
  return <Tooltip label={title} side={wide ? 'top' : 'right'} delayMs={500}>
    <button
      type="button"
      className={`${css.badge} ${failed ? css.error : css.available}`}
      onClick={show}
      aria-label={title}
    >
      <span className={css.icon} aria-hidden="true">
        {failed
          ? <IconWarningTriangleOutlineRegular size={14} />
          : <IconDownloadOutlineRegular size={14} />}
      </span>
    </button>
  </Tooltip>
}
