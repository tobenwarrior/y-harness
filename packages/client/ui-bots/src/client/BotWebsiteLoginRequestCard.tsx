/** Compact owner-only saved website-login request status in the Bot composer dock. */

import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@yharness/client-ui-slots'
import type {} from '@yharness/client-ui-conversation/client'
import { IconShieldOutlineRegular } from '@yharness/client-ui-primitives'
import { createBotWebsiteLoginRequestPoller, isBotWebsiteLoginRequestEnabled, type BotWebsiteLoginRequest } from './bot-website-login-request.ts'
import { isYHarnessCloudDesktop } from './bot-vault-request.ts'
import css from './BotVaultRequestCard.module.css'

/** Full props for the Bot-only composer dock entry. */
export type BotWebsiteLoginRequestCardProps = PropsRuntime<'conversation.composer.dock'>
  & PropsLocale<'bots'>

interface SessionRequest {
  readonly sessionId: string
  readonly request: BotWebsiteLoginRequest
}

/**
 * Render validated website-login metadata and the native-app handoff, never a value form.
 * @param props - Composer dock owner, Session lifecycle, and Bot locale seats.
 * @returns the card for a direct Bot conversation, or null elsewhere.
 */
export function BotWebsiteLoginRequestCard({ botChat, sessionId, useSession, t }: BotWebsiteLoginRequestCardProps): ReactNode {
  const running = useSession(snapshot => snapshot.running)
  const [sessionRequest, setSessionRequest] = useState<SessionRequest | null>(null)
  const enabled = isBotWebsiteLoginRequestEnabled() && botChat === true
  const request = enabled && sessionRequest?.sessionId === sessionId ? sessionRequest.request : null

  useEffect(() => {
    if (!enabled) {
      setSessionRequest(null)
      return undefined
    }
    const poller = createBotWebsiteLoginRequestPoller({
      onResult: (selectedSessionId, nextRequest) => {
        setSessionRequest(nextRequest === null ? null : { sessionId: selectedSessionId, request: nextRequest })
      },
    })
    poller.select(sessionId, running)
    return poller.dispose
  }, [enabled, running, sessionId])

  if (request === null) return null
  const desktop = isYHarnessCloudDesktop(typeof navigator === 'undefined' ? '' : navigator.userAgent)
  return (
    <section className={css.card} aria-label={t('websiteLoginRequestTitle')}>
      <span className={css.icon} aria-hidden="true"><IconShieldOutlineRegular size={16} /></span>
      <div className={css.content}>
        <span className={css.title}>{t('websiteLoginRequestTitle')}</span>
        <div className={css.target}>
          <span className={css.targetLabel}>{t('websiteLoginOrigin')}</span>
          <code className={css.targetValue}>{request.origin}</code>
          <span className={css.targetLabel}>{t('websiteLoginDestination')}</span>
          <code className={css.targetValue}>{request.destination}</code>
        </div>
        {desktop
          ? <a className={css.action} href={`/__yharness/vault-login-use/${request.id}`}>{t('websiteLoginOpenDesktop')}</a>
          : <p className={css.desktopHint}>{t('websiteLoginDesktopOnly')}</p>}
      </div>
    </section>
  )
}
