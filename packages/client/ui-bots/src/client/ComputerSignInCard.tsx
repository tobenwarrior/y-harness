/** Owner sign-in handoff shown above the Bot composer. */

import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconShieldOutlineRegular } from '@yharness/client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@yharness/client-ui-slots'
import type {} from '@yharness/client-ui-conversation/client'
import type { ComputerClient, ComputerSignInRequest } from './computer-client.ts'
import css from './BotVaultRequestCard.module.css'

/** Shared Computer controls exposed to the sign-in card. */
export interface ComputerSignInFace {
  readonly computer: ComputerClient
  readonly openSignIn: (sessionId: string, requestId: string) => void
}

type Props = PropsRuntime<'conversation.composer.dock'> & PropsLocale<'bots'> & InjectFace<ComputerSignInFace>
const POLL_MS = 1_200

declare global {
  interface Window {
    __YH_BOT_COMPUTER_SIGN_IN__?: true
  }
}

/**
 * Display the current Bot request and open the existing Computer panel to accept it.
 * @param props - Conversation context and Computer actions.
 * @returns A card while the selected Bot has a sign-in request.
 */
export function ComputerSignInCard({ botChat, sessionId, computer, openSignIn, t }: Props): ReactNode {
  const [current, setCurrent] = useState<{ sessionId: string; request: ComputerSignInRequest }>()
  const [cancelling, setCancelling] = useState<string>()
  const [error, setError] = useState<string>()
  const api = computer.signIn
  const enabled = botChat === true && typeof window !== 'undefined' && window.__YH_BOT_COMPUTER_SIGN_IN__ === true
  const request = current?.sessionId === sessionId ? current.request : undefined

  useEffect(() => {
    if (!enabled || api === undefined) return
    const lifetime = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const result = await api.status(sessionId, lifetime.signal)
        if (!lifetime.signal.aborted) setCurrent(result.request === null ? undefined : { sessionId, request: result.request })
      } catch (error) {
        // A disconnected client or older Host has no current card to display.
        void error
        if (!lifetime.signal.aborted) setCurrent(undefined)
      }
      if (!lifetime.signal.aborted) timer = setTimeout(() => { void poll() }, POLL_MS)
    }
    void poll()
    return () => { lifetime.abort(); clearTimeout(timer) }
  }, [api, enabled, sessionId])

  if (!enabled || request === undefined || api === undefined) return null
  return (
    <section className={`${css.card} ${css.signIn}`} aria-label={t('computerSignInTitle')} data-computer-sign-in-card>
      <span className={css.icon} aria-hidden="true"><IconShieldOutlineRegular size={16} /></span>
      <div className={css.content}>
        <span className={css.title}>{t('computerSignInTitle')}</span>
        <span>{t('computerSignInDescription')}</span>
        {error === request.id && <span role="alert">{t('computerSignInError')}</span>}
      </div>
      <div className={css.signInActions}>
        {request.canCancel && (
          <Button variant="ghost" size="sm" disabled={cancelling === request.id} onClick={() => {
            setCancelling(request.id)
            setError(undefined)
            void api.cancel(sessionId, request.id).then(() => {
              setCurrent(value => value?.request.id === request.id ? undefined : value)
            }, () => { setError(request.id) }).finally(() => {
              setCancelling(value => value === request.id ? undefined : value)
            })
          }}>{t('cancel')}</Button>
        )}
        <Button variant="outline" size="sm" disabled={cancelling === request.id}
          onClick={() => { openSignIn(sessionId, request.id) }}>{t('computerSignInTake')}</Button>
      </div>
    </section>
  )
}
