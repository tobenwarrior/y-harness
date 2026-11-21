/** Read-only Grok archive inside the current Bot conversation. */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { BotGrokHistoryView } from '@yharness/bots/client'
import {
  Button, IconDownloadOutlineRegular, IconSidebarSearchOutlineRegular, Input, Modal, StateDot, Tooltip,
} from '@yharness/client-ui-primitives'
import type { PropsLocale } from '@yharness/client-ui-slots'
import css from './BotWorkspace.module.css'

const MATCH_PAGE_SIZE = 50
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function messageLabel(
  message: BotGrokHistoryView['messages'][number],
  botName: string,
  t: PropsLocale<'bots'>['t'],
): string {
  if (message.fromBot !== undefined) return message.fromBot
  if (message.author !== undefined) return message.author
  if (message.role === 'user') return t('grokHistoryYou')
  if (message.role === 'assistant') return botName
  return message.role
}

function sourceIsPartial(source: {
  readonly firstCachedSequence: number
  readonly complete?: boolean
}): boolean {
  return source.complete === false || source.firstCachedSequence > 1
}

function hasVerifiedAttachment(
  history: BotGrokHistoryView,
  sourceId: string,
  message: BotGrokHistoryView['messages'][number],
): boolean {
  if (message.role !== 'attachment' || history.availableAttachments === undefined) return false
  return history.availableAttachments.some(attachment => (
    attachment.sourceId === sourceId && attachment.sourceSequence === message.sourceSequence
  ))
}

function attachmentDownloadUrl(botId: string, sourceId: string, sourceSequence: number): string {
  const query = new URLSearchParams({ botId, sourceId, sourceSequence: String(sourceSequence) })
  return `/api/bots/grokHistory/downloadAttachment?${query}`
}

/**
 * Open the recovered messages without replacing the current conversation.
 * @param props - selected Bot identity, archive reader, close action, and localized copy.
 * @returns The history dialog, with the archive fetched on demand.
 */
export function GrokHistoryDialog({
  botId, botName, read, open, onClose, t,
}: PropsLocale<'bots'> & {
  botId: string
  botName: string
  read: (id: string) => Promise<BotGrokHistoryView | null>
  open: boolean
  onClose: () => void
}) {
  const [history, setHistory] = useState<BotGrokHistoryView | null | undefined>()
  const [failed, setFailed] = useState(false)
  const [sourceId, setSourceId] = useState('primary')
  const [query, setQuery] = useState('')
  const [matchLimit, setMatchLimit] = useState(MATCH_PAGE_SIZE)
  const [focusedSequence, setFocusedSequence] = useState<number>()
  const focusedMessage = useRef<HTMLLIElement>(null)
  const searchText = query.trim().toLocaleLowerCase()
  const searching = searchText !== ''

  useEffect(() => {
    if (!open) return
    setHistory(undefined)
    setFailed(false)
    setSourceId('primary')
    setQuery('')
    setMatchLimit(MATCH_PAGE_SIZE)
    setFocusedSequence(undefined)
    let active = true
    void read(botId).then((archive) => {
      if (active) setHistory(archive)
    }, () => {
      if (active) setFailed(true)
    })
    return () => { active = false }
  }, [botId, open, read])
  useEffect(() => {
    focusedMessage.current?.focus()
  }, [sourceId, focusedSequence])

  const sources = useMemo(() => history == null ? [] : [
    { ...history, id: 'primary', label: t('grokHistoryPrimary') },
    ...(history.sources ?? []),
  ], [history, t])
  const selectedSource = sources.find(source => source.id === sourceId) ?? sources[0]
  const matches = useMemo(() => searching ? sources.flatMap(source => source.messages
    .filter(message => [message.text, message.author, message.fromBot]
      .some(text => text?.toLocaleLowerCase().includes(searchText) === true))
    .map(message => ({ source, message }))) : [], [searching, searchText, sources])
  const rows = searching ? matches.slice(0, matchLimit)
    : selectedSource?.messages.map(message => ({ source: selectedSource, message })) ?? []
  const partial = searching ? sources.some(sourceIsPartial)
    : selectedSource !== undefined && sourceIsPartial(selectedSource)
  return (
    <Modal open={open} onClose={onClose} title={t('grokHistory')} closeLabel={t('close')}
      {...(selectedSource === undefined ? {} : {
        description: t(partial ? 'grokHistoryPartial' : 'grokHistoryRecovered'),
      })}
      className={css.grokHistoryModal as string}>
      {failed && <p role="alert">{t('grokHistoryUnavailable')}</p>}
      {!failed && history === undefined && <div className={css.grokHistoryLoading} role="status" aria-label={t('grokHistoryLoading')}><StateDot state="ongoing" size={20} /></div>}
      {history === null && <p>{t('grokHistoryEmpty')}</p>}
      {history != null && (
        <div className={css.grokHistoryControls}>
          <Input
            type="search"
            icon={<IconSidebarSearchOutlineRegular size={16} />}
            aria-label={t('grokHistorySearch')}
            placeholder={t('grokHistorySearch')}
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value)
              setMatchLimit(MATCH_PAGE_SIZE)
              setFocusedSequence(undefined)
            }}
          />
          {searching
            ? <div className={css.grokHistoryMatchStatus} role="status">
              {matches.length === 0 ? t('grokHistoryNoMatches') : matches.length === 1
                ? t('grokHistoryOneMatch') : t('grokHistoryMatches', { count: matches.length })}
            </div>
            : sources.length > 1 && <label className={css.grokHistorySource}>
              <span>{t('grokHistorySource')}</span>
              <select value={sourceId} onChange={(event) => {
                setSourceId(event.currentTarget.value)
                setFocusedSequence(undefined)
              }}>
                {sources.map(source => <option key={source.id} value={source.id}>{source.label}</option>)}
              </select>
            </label>}
        </div>
      )}
      {history != null && rows.length > 0 && (
        <ol key={searching ? 'matches' : 'source-' + sourceId} className={css.grokHistoryMessages}>
          {rows.map(({ source, message }) => {
            const focused = !searching && focusedSequence === message.sourceSequence
            return (
              <li key={source.id + ':' + String(message.sourceSequence)} className={css.grokHistoryMessage}
                {...(focused ? { ref: focusedMessage, tabIndex: -1 } : {})}>
                <div className={css.grokHistoryMessageMeta}>
                  <span className={css.grokHistoryMessageMetaPrimary}>
                    <strong>{messageLabel(message, botName, t)}</strong>
                    {message.fromBot !== undefined && message.author !== undefined && message.author !== message.fromBot && (
                      <span>{t('grokHistoryAuthor', { name: message.author })}</span>
                    )}
                  </span>
                  <span className={css.grokHistoryMessageMetaActions}>
                    {typeof message.timestampMs === 'number' && Number.isFinite(message.timestampMs) ? (
                      <time dateTime={new Date(message.timestampMs).toISOString()}>{dateFormat.format(message.timestampMs)}</time>
                    ) : (
                      <span>{t('grokHistoryUnknownTimestamp')}</span>
                    )}
                    {hasVerifiedAttachment(history, source.id, message) && (
                      <Tooltip label={t('grokHistoryDownloadTooltip')} side="top" portal>
                        <a
                          className={css.grokHistoryDownload}
                          href={attachmentDownloadUrl(botId, source.id, message.sourceSequence)}
                          aria-label={t('grokHistoryDownloadAttachment', { name: message.text })}
                          download
                        >
                          <IconDownloadOutlineRegular size={14} />
                        </a>
                      </Tooltip>
                    )}
                  </span>
                </div>
                {message.text.length > 0 && <p>{message.text}</p>}
                {message.incomplete === true && <div className={css.grokHistoryMessageStatus}>{t('grokHistoryIncomplete')}</div>}
                {searching && <Button variant="ghost" size="sm" className={css.grokHistoryContext}
                  aria-label={t('grokHistoryOpenMessage', { source: source.label })}
                  onClick={() => {
                    setSourceId(source.id)
                    setQuery('')
                    setFocusedSequence(message.sourceSequence)
                  }}>
                  {t('grokHistoryOpenSource', { source: source.label })}
                </Button>}
              </li>
            )
          })}
          {searching && matches.length > matchLimit && (
            <li><Button variant="ghost" size="sm" onClick={() => { setMatchLimit(count => count + MATCH_PAGE_SIZE) }}>
              {t('grokHistoryMoreMatches')}
            </Button></li>
          )}
        </ol>
      )}
    </Modal>
  )
}
