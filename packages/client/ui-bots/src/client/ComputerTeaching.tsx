/** Owner review for a demonstrated Bot Browser task. */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal, StateDot } from '@yharness/client-ui-primitives'
import type { PropsLocale } from '@yharness/client-ui-slots'
import { assertNever } from '@yharness/util-values'
import type {
  ComputerTeachingAction, ComputerTeachingClient, ComputerTeachingId, ComputerTeachingTrace,
} from './computer-client.ts'
import css from './ComputerPanel.module.css'

interface ComputerTeachingProps extends PropsLocale<'bots'> {
  readonly teaching: ComputerTeachingClient
  readonly viewerId: string
  readonly sessionId: string
  readonly hasControl: boolean
  readonly sendForDraft: (text: string, id: ComputerTeachingId) => Promise<void>
}

type TeachingPhase =
  | { readonly kind: 'idle' | 'setup' }
  | { readonly kind: 'recording'; readonly id: ComputerTeachingId }
  | { readonly kind: 'review'; readonly trace: ComputerTeachingTrace }

type TeachingError = 'computerTeachStartFailed' | 'computerTeachStopFailed' | 'computerTeachSendFailed' | 'computerTeachInterrupted'

function describeAction(action: ComputerTeachingAction, t: PropsLocale<'bots'>['t']): string {
  switch (action.kind) {
    case 'navigate': return t('computerTeachNavigate', { origin: action.origin })
    case 'click': return t('computerTeachClick', { x: action.x, y: action.y, button: action.button })
    case 'drag': return t('computerTeachDrag', { x: action.x, y: action.y, toX: action.toX, toY: action.toY })
    case 'scroll': return t('computerTeachScroll', { x: action.x, y: action.y, delta: action.delta })
    /* v8 ignore next -- The Computer client validates the closed action union. */
    default: return assertNever(action, 'Computer teaching action')
  }
}

/**
 * Collect a task goal, then make its reviewed demonstration an explicit Bot prompt.
 * @param props - exact Browser owner, teaching transport, and private Chat submission.
 * @returns the Computer footer action and its setup or review dialog.
 */
export function ComputerTeaching({ teaching, viewerId, sessionId, hasControl, sendForDraft, t }: ComputerTeachingProps): ReactNode {
  const [phase, setPhase] = useState<TeachingPhase>({ kind: 'idle' })
  const [goal, setGoal] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, showError] = useState<TeachingError>()
  const inFlight = useRef<AbortController>()
  const review = phase.kind === 'review' ? phase.trace : undefined
  const actionText = review?.actions.map(action => describeAction(action, t)) ?? []

  useEffect(() => () => { inFlight.current?.abort() }, [])

  useEffect(() => {
    if (hasControl || phase.kind !== 'recording') return
    inFlight.current?.abort()
    inFlight.current = undefined
    setBusy(false)
    showError('computerTeachInterrupted')
    setPhase({ kind: 'idle' })
  }, [hasControl, phase.kind])

  const run = (failure: TeachingError, action: (signal: AbortSignal) => Promise<void>): void => {
    if (inFlight.current !== undefined) return
    const request = new AbortController()
    inFlight.current = request
    setBusy(true)
    showError(undefined)
    void action(request.signal).catch((error: unknown) => {
      if (!request.signal.aborted) showError(failure)
      void error
    }).finally(() => {
      if (request.signal.aborted) return
      inFlight.current = undefined
      setBusy(false)
    })
  }

  const start = (): void => {
    run('computerTeachStartFailed', async (signal) => {
      const id = await teaching.start(viewerId, sessionId, signal)
      if (!signal.aborted) setPhase({ kind: 'recording', id })
    })
  }

  const stop = (id: ComputerTeachingId): void => {
    run('computerTeachStopFailed', async (signal) => {
      const trace = await teaching.stop(viewerId, sessionId, signal)
      if (signal.aborted) return
      if (trace.id !== id || !trace.reviewable) {
        showError('computerTeachInterrupted')
        setPhase({ kind: 'idle' })
        return
      }
      setPhase({ kind: 'review', trace })
    })
  }

  const dismiss = (): void => {
    if (busy) return
    setPhase({ kind: 'idle' })
    showError(undefined)
  }

  const send = (id: ComputerTeachingId): void => {
    const actions = actionText.map((action, index) => `${index + 1}. ${action}`).join('\n')
    run('computerTeachSendFailed', async (signal) => {
      setSubmitted(true)
      await sendForDraft(t('computerTeachPrompt', { goal: goal.trim(), actions }), id)
      if (signal.aborted) return
      setGoal('')
      setPhase({ kind: 'idle' })
    })
  }

  const dialogOpen = phase.kind === 'setup' || review !== undefined
  return (
    <>
      {phase.kind === 'recording' ? (
        <Button variant="outline" size="sm" disabled={busy || !hasControl}
          icon={<StateDot state="warning" size={8} />} onClick={() => { stop(phase.id) }}>
          {t('computerTeachStop')}
        </Button>
      ) : hasControl && (
        <Button variant="ghost" size="sm" onClick={() => {
          showError(undefined)
          setSubmitted(false)
          setPhase({ kind: 'setup' })
        }}>{t('computerTeachTitle')}</Button>
      )}
      {!dialogOpen && error !== undefined && <span role="alert" className={css.teachingAlert}>{t(error)}</span>}
      {dialogOpen && (
        <Modal open onClose={dismiss} closeLabel={t('close')}
          title={t(review === undefined ? 'computerTeachTitle' : 'computerTeachReview')}
          description={t(review === undefined ? 'computerTeachDescription' : 'computerTeachReviewDescription')}
          footer={<>
            <Button variant="ghost" disabled={busy} onClick={dismiss}>{t('cancel')}</Button>
            {review === undefined ? (
              <Button variant="primary" disabled={busy || !hasControl || goal.trim() === ''} onClick={start}>
                {t('computerTeachStart')}
              </Button>
            ) : (
              <Button variant="primary" disabled={busy || goal.trim() === '' || actionText.length === 0} onClick={() => { send(review.id) }}>
                {t('computerTeachDraftSkill')}
              </Button>
            )}
          </>}
        >
          <div className={css.teachingContent}>
            <label className={css.teachingGoal}>
              <span>{t('computerTeachGoal')}</span>
              <textarea rows={2} value={goal} maxLength={500} disabled={busy || submitted} autoFocus={review === undefined}
                onChange={(event) => { setGoal(event.currentTarget.value) }} />
            </label>
            {review !== undefined && (
              <>
                {review.truncated && <p role="status">{t('computerTeachLimit')}</p>}
                {actionText.length === 0 ? <p>{t('computerTeachEmpty')}</p> : (
                  <ol className={css.teachingSteps}>
                    {actionText.map((action, index) => <li key={index}>{action}</li>)}
                  </ol>
                )}
              </>
            )}
            {error !== undefined && <p role="alert">{t(error)}</p>}
          </div>
        </Modal>
      )}
    </>
  )
}
