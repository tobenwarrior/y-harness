/** Compact Bot-only card for a successful app connection request. */

import { useState, type ReactNode } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@yharness/client-ui-slots'
import type {} from '@yharness/client-ui-chat/client'
import {
  Button, StateDot, connectedAppGlyph,
} from '@yharness/client-ui-primitives'
import type { BotWorkspaceState } from './controller.ts'
import { GitHubAppSignInSection } from './BotWorkspace.tsx'
import type { GitHubAppSignInActions, GitHubAppSignInView } from './types.ts'
import {
  selectBotAppConnectionRequests,
  type BotAppConnectionRequest,
} from './bot-app-connection.ts'
import css from './BotAppConnectionCard.module.css'

/** Services required by the Bot-only app connection card. */
export interface BotAppConnectionCardInjected {
  readonly githubAppSignIn?: GitHubAppSignInActions
  readonly hooks: { readonly workspace: HostObservable<BotWorkspaceState> }
}

/** Props for the Bot Chat Turn-tail app connection entry. */
export type BotAppConnectionCardProps = PropsRuntime<'conversation.chat.turnTail'>
  & PropsLocale<'bots'>
  & InjectFace<BotAppConnectionCardInjected>

function AppConnectionRequestCard({ request, actions, t }: {
  request: BotAppConnectionRequest
  actions: GitHubAppSignInActions
  t: BotAppConnectionCardProps['t']
}): ReactNode {
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<GitHubAppSignInView | undefined>()
  const [error, setError] = useState(false)

  const connect = async (): Promise<void> => {
    setBusy(true)
    setError(false)
    try {
      const next = await actions.startGitHubAppSignIn()
      if (next.status === 'unavailable') {
        setError(true)
        return
      }
      setView(next)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={css.card} data-bot-app-connection-card={request.appId} aria-label={t('appConnectionRequestTitle')}>
      <span className={css.icon} aria-hidden="true">{connectedAppGlyph({ appId: request.appId, size: 16 })}</span>
      <div className={css.content}>
        <span className={css.title}>{t('appConnectionRequestTitle')}</span>
        <span className={css.description}>{t('appConnectionRequestDescription')}</span>
        {error && <span className={css.error} role="alert">{t('githubAccountError')}</span>}
        {view === undefined ? (
          <div className={css.actionRow}>
            {busy && <span className={css.status} role="status"><StateDot state="ongoing" size={8} />{t('appConnectionRequestStarting')}</span>}
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { void connect() }}>
              {busy ? t('appConnectionRequestStarting') : t('appConnectionRequestConnect')}
            </Button>
          </div>
        ) : (
          <GitHubAppSignInSection
            actions={actions}
            initialView={view}
            compact
            t={t}
          />
        )}
      </div>
    </section>
  )
}

/**
 * Render successful app connection requests only in a Bot-owned Session.
 * Technical tool rows remain hidden by Chat's Bot presentation policy.
 * @param props - Turn-tail data, Bot-session identity, owner actions, and locale.
 * @returns one card per matching request, or null for Code Chat/other turns.
 */
export function BotAppConnectionCard({ turn, seq, sessionId, githubAppSignIn, useWorkspace, t }: BotAppConnectionCardProps): ReactNode {
  const isBotSession = useWorkspace(state => state.bots.some(bot => bot.sessionId === sessionId))
  if (!isBotSession || githubAppSignIn === undefined) return null
  const requests = selectBotAppConnectionRequests({ turn, seq })
  if (requests.length === 0) return null
  return (
    <div className={css.list}>
      {requests.map(request => (
        <AppConnectionRequestCard key={request.callId} request={request} actions={githubAppSignIn} t={t} />
      ))}
    </div>
  )
}
