/** Sidebar-foot status control for a pending or failed Compound skills check. */
import type { ReactNode } from 'react'
import {
  IconDownloadOutlineRegular, IconWarningTriangleOutlineRegular,
} from '@yharness/client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@yharness/client-ui-slots'
import type {} from '@yharness/client-ui-sidebar/client'
import type { CompoundUpdateFace } from './controller.ts'
import css from './UpdateBadge.module.css'

/**
 * Render the update status control; nothing renders before the first reading
 * or after a successful check finds no pending revision. The host applies
 * Compound updates automatically, so a current-state button would be noise.
 * @param props - sidebar geometry, locale, and the indicator's data and actions.
 * @returns the status control, or null before the first reading/current state.
 */
export function UpdateBadge({ t, useUpdate, show }: PropsRuntime<'sidebar.footer.action'> & PropsLocale<'compoundUpdate'> & InjectFace<CompoundUpdateFace>): ReactNode {
  const status = useUpdate(state => state.status)
  if (status === null || (status.error === null && !status.updateAvailable)) return null
  const failed = status.error !== null
  const title = failed ? t('badgeError') : t('badge')
  const label = failed ? t('badgeErrorShort') : t('badgeShort')
  const released = failed ? '' : status.upstream ?? status.vendored
  return <button
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
    <span className={css.label}>{label}</span>
    {released !== '' && <span className={css.version}>{released}</span>}
  </button>
}
