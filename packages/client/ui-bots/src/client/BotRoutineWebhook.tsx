/** Manage a routine's webhook connection without rendering its key in the page. */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconCopyOutlineRegular, StateDot, writeClipboard } from '@yharness/client-ui-primitives'
import type { PropsLocale } from '@yharness/client-ui-slots'
import type { BotRoutineWebhookSetup } from '@yharness/bots/client'
import css from './BotWorkspace.module.css'
import type { BotRoutineWebhookActions } from './types.ts'

type View =
  | { readonly phase: 'loading' }
  | { readonly phase: 'unavailable' }
  | { readonly phase: 'rotating' }
  | { readonly phase: 'unconfirmed' }
  | { readonly phase: 'ready'; readonly connection: BotRoutineWebhookSetup; readonly endpointHost: string }
type Feedback = 'copied' | 'copy-failed' | 'rotated'

/** Load and copy the selected routine's connection details, or replace its signing key. */
export function BotRoutineWebhook({ botId, routineId, actions, t }: {
  /** Owning Bot selected in the routine manager. */
  readonly botId: string
  /** Saved webhook routine. */
  readonly routineId: string
  /** Owner-scoped actions over the current workspace connection. */
  readonly actions: BotRoutineWebhookActions
  /** Locale-owned Bot workspace translator. */
  readonly t: PropsLocale<'bots'>['t']
}): ReactNode {
  const current = useRef(0)
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const [attempt, setAttempt] = useState(0)
  const [view, setView] = useState<View>({ phase: 'loading' })
  const [confirming, setConfirming] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>()

  useEffect(() => {
    const generation = ++current.current
    setView({ phase: 'loading' })
    setConfirming(false)
    setFeedback(undefined)
    void actionsRef.current.setup(botId, routineId).then((value) => {
      if (current.current !== generation) return
      setView({ phase: 'ready', connection: value, endpointHost: new URL(value.postUrl).host })
    }, () => {
      if (current.current === generation) setView({ phase: 'unavailable' })
    })
    return () => {
      current.current++
    }
  }, [attempt, botId, routineId])

  const copy = async (text: string): Promise<void> => {
    const generation = current.current
    const copied = await writeClipboard(text)
    if (generation === current.current) setFeedback(copied ? 'copied' : 'copy-failed')
  }

  const rotate = async (): Promise<void> => {
    const generation = ++current.current
    setView({ phase: 'rotating' })
    setConfirming(false)
    setFeedback(undefined)
    try {
      const next = await actionsRef.current.rotate(botId, routineId)
      if (current.current !== generation) return
      setView({ phase: 'ready', connection: next, endpointHost: new URL(next.postUrl).host })
      setFeedback('rotated')
    } catch {
      if (current.current === generation) setView({ phase: 'unconfirmed' })
    }
  }

  const status = view.phase
  return (
    <div className={css.routineWebhook} aria-label={t('routineWebhookSetup')} role="group">
      {status === 'loading' || status === 'rotating' ? (
        <div className={css.memoryLoading} role="status">
          <StateDot state="ongoing" size={13} />
          {t(status === 'loading' ? 'routineWebhookLoading' : 'routineWebhookReplacing')}
        </div>
      ) : status === 'unavailable' || status === 'unconfirmed' ? (
        <div className={css.routineWebhookActions} role="alert">
          <p>{t(status === 'unavailable' ? 'routineWebhookLoadFailed' : 'routineWebhookRotationUnconfirmed')}</p>
          <Button size="sm" variant="outline" onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button>
        </div>
      ) : (
        <>
          <div className={css.routineWebhookFields}>
            <div className={css.routineWebhookRow}>
              <div className={css.routineWebhookValue}>
                <span>{t('routineWebhookEndpoint')}</span>
                <code>{view.endpointHost}</code>
              </div>
              <Button size="sm" variant="ghost" icon={<IconCopyOutlineRegular size={14} />} disabled={confirming} onClick={() => { void copy(view.connection.postUrl) }}>{t('routineWebhookCopyUrl')}</Button>
            </div>
            <div className={css.routineWebhookRow}>
              <div className={css.routineWebhookValue}>
                <span>{t('routineWebhookKey')}</span>
                <code aria-hidden="true">{'•••• •••• ••••'}</code>
              </div>
              <Button size="sm" variant="ghost" icon={<IconCopyOutlineRegular size={14} />} disabled={confirming} onClick={() => { void copy(view.connection.key) }}>{t('routineWebhookCopyKey')}</Button>
            </div>
          </div>
          {confirming ? (
            <>
              <p>{t('routineWebhookRotateDescription')}</p>
              <div className={css.routineWebhookActions}>
                <Button size="sm" variant="primary" onClick={() => { void rotate() }}>{t('routineWebhookReplace')}</Button>
                <Button size="sm" variant="ghost" onClick={() => { setConfirming(false) }}>{t('cancel')}</Button>
              </div>
            </>
          ) : (
            <div className={css.routineWebhookActions}>
              <Button size="sm" variant="outline" onClick={() => { void copy('Authorization: Bearer ' + view.connection.key) }}>{t('routineWebhookCopyHeader')}</Button>
              <Button size="sm" variant="ghost" onClick={() => { setConfirming(true); setFeedback(undefined) }}>{t('routineWebhookRotate')}</Button>
            </div>
          )}
          {feedback !== undefined && (
            <p role={feedback === 'copy-failed' ? 'alert' : 'status'}>
              {t(feedback === 'copied' ? 'routineWebhookCopied' : feedback === 'copy-failed' ? 'routineWebhookCopyFailed' : 'routineWebhookRotated')}
            </p>
          )}
        </>
      )}
    </div>
  )
}
