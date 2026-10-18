/** Sidebar-foot badge shown while the upstream repository publishes a newer release. */
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { CompoundUpdateFace } from './controller.ts'
import css from './UpdateBadge.module.css'

/**
 * Render the update badge; nothing renders while no newer release is known.
 * @param props - sidebar geometry, locale, and the indicator's data and actions.
 * @returns the badge, or null when this build already ships the released version.
 */
export function UpdateBadge({ t, useUpdate, show }: PropsRuntime<'sidebar.footer.action'> & PropsLocale<'compoundUpdate'> & InjectFace<CompoundUpdateFace>): ReactNode {
  const available = useUpdate(state => state.status?.updateAvailable === true)
  const released = useUpdate(state => state.status?.upstream ?? '')
  if (!available) return null
  return <button type="button" className={css.badge} onClick={show} title={t('badge')} aria-label={t('badge')}>
    <span className={css.dot} aria-hidden="true" />
    <span className={css.label}>{t('badgeShort')}</span>
    <span className={css.version}>{released}</span>
  </button>
}
