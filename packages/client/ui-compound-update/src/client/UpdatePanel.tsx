/** Update steps panel for the vendored Compound skills. */
import type { ReactNode } from 'react'
import {
  Button, IconCheckCircleOutlineRegular, IconCloseOutlineRegular, IconDownloadOutlineRegular,
  IconLoadingOutlineRegular, IconRefreshOutlineRegular, IconWarningTriangleOutlineRegular, Modal,
} from '@yharness/client-ui-primitives'
import type { InjectFace, PropsLocale } from '@yharness/client-ui-slots'
import type { CompoundUpdateFace } from './controller.ts'
import css from './UpdatePanel.module.css'

/**
 * Render the released-version panel and the steps that bring it in.
 * @param props - locale plus the indicator's data and actions.
 * @returns the panel, or null while it is closed.
 */
export function UpdatePanel({ t, useUpdate, hide, refresh, apply }: PropsLocale<'compoundUpdate'> & InjectFace<CompoundUpdateFace>): ReactNode {
  const open = useUpdate(state => state.open)
  const phase = useUpdate(state => state.phase)
  const status = useUpdate(state => state.status)
  const progress = useUpdate(state => state.apply)
  if (!open) return null
  return (
    <Modal open onClose={hide} title={t('title')} headless className={css.card as string}>
      <div className={css.heading}>
        <span className={css.titleIcon} aria-hidden="true"><IconDownloadOutlineRegular size={16} /></span>
        <h2 className={css.title}>{t('title')}</h2>
      </div>
      {phase === 'loading' && <div className={`${css.status} ${css.loading}`} role="status" aria-live="polite">
        <span className={css.statusIcon} aria-hidden="true"><IconLoadingOutlineRegular className={css.spinner} size={16} /></span>
        <p className={css.body}>{t('checking')}</p>
      </div>}
      {status !== null && status.error !== null && <div className={`${css.status} ${css.error}`} role="status" aria-live="polite">
        <span className={css.statusIcon} aria-hidden="true"><IconWarningTriangleOutlineRegular size={16} /></span>
        <p className={css.body}>{t('unavailable', { reason: status.error })}</p>
      </div>}
      {status !== null && status.error === null && <div className={`${css.status} ${status.updateAvailable ? css.available : css.current}`} role="status" aria-live="polite">
        <span className={css.statusIcon} aria-hidden="true">
          {status.updateAvailable ? <IconDownloadOutlineRegular size={16} /> : <IconCheckCircleOutlineRegular size={16} />}
        </span>
        <p className={css.body}>
          {status.updateAvailable
            ? t('available', { upstream: status.upstream ?? '', vendored: status.vendored })
            : t('current', { vendored: status.vendored })}
        </p>
      </div>}
      {status?.updateAvailable === true && <>
        <h3 className={css.subtitle}>{t('stepsTitle')}</h3>
        <p className={css.body}>{t('restartHint')}</p>
        {progress.phase === 'failed' && <p className={css.body}>{t('updateFailed', { reason: progress.error ?? '' })}</p>}
        <p className={css.body}>
          {t('repository')}: <a className={css.link} href={`https://github.com/${status.repository}`} target="_blank" rel="noreferrer">{status.repository}</a>
        </p>
      </>}
      <div className={css.actions}>
        {status?.updateAvailable === true && <Button variant="primary" size="sm" icon={<IconDownloadOutlineRegular size={14} />} disabled={progress.phase === 'running' || progress.phase === 'done'} aria-busy={progress.phase === 'running'} onClick={apply}>
          {progress.phase === 'running'
            ? t('updating')
            : progress.phase === 'done' ? t('updated') : t('update', { upstream: status.upstream ?? '' })}
        </Button>}
        <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={14} />} onClick={refresh}>{t('refresh')}</Button>
        <Button variant="ghost" size="sm" icon={<IconCloseOutlineRegular size={14} />} onClick={hide}>{t('close')}</Button>
      </div>
    </Modal>
  )
}
