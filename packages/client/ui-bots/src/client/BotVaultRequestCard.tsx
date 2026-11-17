/** Compact owner-only Vault request status in the Bot composer dock. */

import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@yharness/client-ui-slots'
import type {} from '@yharness/client-ui-conversation/client'
import { IconShieldOutlineRegular, StateDot } from '@yharness/client-ui-primitives'
import { createBotVaultRequestPoller, isYHarnessCloudDesktop, type BotVaultRequest } from './bot-vault-request.ts'
import css from './BotVaultRequestCard.module.css'

/** Full props for the Bot-only composer dock entry. */
export type BotVaultRequestCardProps = PropsRuntime<'conversation.composer.dock'>
  & PropsLocale<'bots'>

interface SessionRequest {
  readonly sessionId: string
  readonly request: BotVaultRequest
}

declare global {
  interface Window {
    __YH_BOT_VAULT_REQUESTS__?: true
    __YH_BOT_SHARED_VAULT_REQUESTS__?: true
  }
}

function userAgent(): string {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent
}

type SettledBotVaultRequestState = Exclude<BotVaultRequest['state'], 'pending'>

function statusState(state: SettledBotVaultRequestState): 'done' | 'idle' {
  switch (state) {
    case 'saved': return 'done'
    case 'cancelled': return 'idle'
  }
}

/**
 * Render validated Vault metadata and the native-app handoff, never a value form.
 * @param props - Composer dock owner, Session lifecycle, and Bot locale seats.
 * @returns the card for a direct Bot conversation, or null elsewhere.
 */
export function BotVaultRequestCard({ botChat, sessionId, useSession, t }: BotVaultRequestCardProps): ReactNode {
  const running = useSession(snapshot => snapshot.running)
  const [sessionRequest, setSessionRequest] = useState<SessionRequest | null>(null)
  const enabled = typeof window !== 'undefined' && window.__YH_BOT_VAULT_REQUESTS__ === true && botChat === true
  const sharedRequestsEnabled = typeof window !== 'undefined' && window.__YH_BOT_SHARED_VAULT_REQUESTS__ === true
  const request = enabled && sessionRequest?.sessionId === sessionId ? sessionRequest.request : null

  useEffect(() => {
    if (!enabled) {
      setSessionRequest(null)
      return undefined
    }
    const poller = createBotVaultRequestPoller({
      onResult: (selectedSessionId, nextRequest) => {
        setSessionRequest(nextRequest === null ? null : { sessionId: selectedSessionId, request: nextRequest })
      },
    })
    poller.select(sessionId, running || sharedRequestsEnabled)
    return poller.dispose
  }, [enabled, running, sessionId, sharedRequestsEnabled])

  if (request === null) return null
  const desktop = isYHarnessCloudDesktop(userAgent())
  const title = request.scope === 'shared' ? t('vaultRequestSharedTitle') : t('vaultRequestTitle')
  const state = request.state
  return (
    <section className={css.card} data-bot-vault-request-state={state} aria-label={title}>
      <span className={css.icon} aria-hidden="true"><IconShieldOutlineRegular size={16} /></span>
      <div className={css.content}>
        <span className={css.title}>{title}</span>
        <div className={css.target}>
          <span className={css.targetLabel}>{t('vaultRequestService')}</span>
          <code className={css.targetValue}>{request.unit}</code>
          <span className={css.targetLabel}>{t('vaultRequestKey')}</span>
          <code className={css.targetValue}>{request.name}</code>
        </div>
        {state === 'pending' && (
          desktop
            ? <a className={css.action} href={`/__yharness/vault-request/${request.id}`}>{t('vaultRequestOpenDesktop')}</a>
            : <p className={css.desktopHint}>{t('vaultRequestDesktopOnly')}</p>
        )}
        {state !== 'pending' && (
          <span className={css.status} data-state={state}>
            <StateDot state={statusState(state)} size={8} />
            {state === 'saved' ? t('vaultRequestSaved') : t('vaultRequestCancelled')}
          </span>
        )}
      </div>
    </section>
  )
}
