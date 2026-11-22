/** Lazy, read-only Grok archive entry rendered above a Bot's live conversation. */

import { useEffect, useRef, useState } from 'react'
import type { BotGrokHistoryView } from '@yharness/bots/client'
import type { PropsLocale } from '@yharness/client-ui-slots'
import {
  Button, IconArchiveOffOutlineRegular, StateDot,
} from '@yharness/client-ui-primitives'
import {
  GrokHistoryMessages, GrokHistorySourceSelect, sourceIsPartial,
} from './GrokHistoryAction.tsx'
import css from './BotWorkspace.module.css'

type InlineRead = (botId: string, signal?: AbortSignal) => Promise<BotGrokHistoryView | null>

type InlineState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'loaded'; readonly history: BotGrokHistoryView | null }

/** Props for the inline archive entry. */
export interface GrokHistoryInlineProps extends PropsLocale<'bots'> {
  readonly botId: string
  readonly botName: string
  readonly read: InlineRead
}

/**
 * Keep imported messages in the same scroll stream as the live Bot chat.
 * @param props - Bot identity, owner-scoped archive reader, and localized copy.
 * @returns A collapsed history entry that fetches only when opened.
 */
export function GrokHistoryInline({ botId, botName, read, t }: GrokHistoryInlineProps) {
  const [expanded, setExpanded] = useState(false)
  const [sourceId, setSourceId] = useState('primary')
  const [readAttempt, setReadAttempt] = useState(0)
  const [state, setState] = useState<InlineState>({ kind: 'idle' })
  const readRef = useRef(read)
  const generationRef = useRef(0)
  readRef.current = read

  useEffect(() => {
    setState({ kind: 'idle' })
    setSourceId('primary')
    setReadAttempt(0)
  }, [botId])

  useEffect(() => {
    if (!expanded) return
    const controller = new AbortController()
    const generation = ++generationRef.current
    setState({ kind: 'loading' })
    void readRef.current(botId, controller.signal).then((history) => {
      if (controller.signal.aborted || generationRef.current !== generation) return
      setState({ kind: 'loaded', history })
    }, () => {
      if (controller.signal.aborted || generationRef.current !== generation) return
      setState({ kind: 'error' })
    })
    return () => {
      controller.abort()
      generationRef.current += 1
    }
  }, [botId, expanded, readAttempt])

  const history = state.kind === 'loaded' ? state.history : undefined
  const sources = history?.sources ?? []
  const selectedSource = sources.find(source => source.id === sourceId) ?? history
  const showSourceDescription = !(expanded && state.kind === 'loaded' && history !== null)
  const showLabel = expanded ? t('grokHistoryInlineHide') : t('grokHistoryInlineShow')

  return (
    <section className={css.grokHistoryInline} aria-label={t('grokHistory')}>
      <header className={css.grokHistoryInlineHeader}>
        <div className={css.grokHistoryInlineTitle}>
          <IconArchiveOffOutlineRegular size={16} />
          <div>
            <strong>{t('grokHistory')}</strong>
            {showSourceDescription && <span>{t('grokHistoryInlineDescription')}</span>}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          aria-controls={`grok-history-inline-${botId}`}
          onClick={() => { setExpanded(value => !value) }}
        >
          {showLabel}
        </Button>
      </header>
      {expanded && (
        <div id={`grok-history-inline-${botId}`} className={css.grokHistoryInlineBody}>
          {state.kind === 'loading' && (
            <div className={css.grokHistoryInlineLoading} role="status" aria-label={t('grokHistoryLoading')}>
              <StateDot state="ongoing" size={16} />
              <span>{t('grokHistoryLoading')}</span>
            </div>
          )}
          {state.kind === 'error' && (
            <div className={css.grokHistoryInlineNotice} role="alert">
              <span>{t('grokHistoryInlineUnavailable')}</span>
              <Button variant="ghost" size="sm" onClick={() => { setReadAttempt(value => value + 1) }}>
                {t('retry')}
              </Button>
            </div>
          )}
          {state.kind === 'loaded' && history === null && <p className={css.grokHistoryInlineEmpty}>{t('grokHistoryEmpty')}</p>}
          {history != null && selectedSource != null && (
            <>
              <p className={css.grokHistoryInlineStatus}>
                {t(sourceIsPartial(selectedSource) ? 'grokHistoryPartial' : 'grokHistoryRecovered')}
              </p>
              <GrokHistorySourceSelect sources={sources} sourceId={sourceId} onChange={setSourceId} t={t} />
              <GrokHistoryMessages
                history={history}
                botId={botId}
                botName={botName}
                sourceId={sourceId}
                messages={selectedSource.messages}
                inline
                t={t}
              />
            </>
          )}
        </div>
      )}
    </section>
  )
}
