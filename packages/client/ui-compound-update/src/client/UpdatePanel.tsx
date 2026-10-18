/** Update steps panel for the vendored Compound skills. */
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CompoundUpdateFace } from './controller.ts'
import css from './UpdatePanel.module.css'

/**
 * Render the released-version panel and the steps that bring it in.
 * @param props - locale plus the indicator's data and actions.
 * @returns the panel, or null while it is closed.
 */
export function UpdatePanel({ t, useUpdate, hide, refresh }: PropsLocale<'compoundUpdate'> & InjectFace<CompoundUpdateFace>): ReactNode {
  const open = useUpdate(state => state.open)
  const phase = useUpdate(state => state.phase)
  const status = useUpdate(state => state.status)
  if (!open) return null
  return <div className={css.root} role="presentation">
    <div className={css.mask} aria-hidden="true" onClick={hide} />
    <div className={css.card} role="dialog" aria-modal="true" aria-label={t('title')}>
      <h2 className={css.title}>{t('title')}</h2>
      {phase === 'loading' && <p className={css.body}>{t('checking')}</p>}
      {status !== null && status.error !== null && <p className={css.body}>{t('unavailable', { reason: status.error })}</p>}
      {status !== null && status.error === null && <p className={css.body}>
        {status.updateAvailable
          ? t('available', { upstream: status.upstream ?? '', vendored: status.vendored })
          : t('current', { vendored: status.vendored })}
      </p>}
      {status?.updateAvailable === true && <>
        <h3 className={css.subtitle}>{t('stepsTitle')}</h3>
        <p className={css.body}>{t('stepsBody')}</p>
        <p className={css.body}>
          {t('repository')}: <a className={css.link} href={`https://github.com/${status.repository}`} target="_blank" rel="noreferrer">{status.repository}</a>
        </p>
      </>}
      <div className={css.actions}>
        <Button variant="outline" size="sm" onClick={refresh}>{t('refresh')}</Button>
        <Button variant="outline" size="sm" onClick={hide}>{t('close')}</Button>
      </div>
    </div>
  </div>
}
