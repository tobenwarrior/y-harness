/** Read-only Grok archive inside the current Bot conversation. */

import { useEffect, useState } from 'react'
import type { BotGrokHistoryView } from '@yharness/bots/client'
import { Button, IconDownloadOutlineRegular, Modal, StateDot, Tooltip } from '@yharness/client-ui-primitives'
import type { PropsLocale } from '@yharness/client-ui-slots'
import css from './BotWorkspace.module.css'

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
  useEffect(() => {
    if (!open) return
    setHistory(undefined)
    setFailed(false)
    setSourceId('primary')
    let active = true
    void read(botId).then((archive) => {
      if (active) setHistory(archive)
    }, () => {
      if (active) setFailed(true)
    })
    return () => { active = false }
  }, [botId, open, read])
  const sources = history?.sources ?? []
  const selectedSource = sources.find(source => source.id === sourceId) ?? history
  return (
    <Modal open={open} onClose={onClose} title={t('grokHistory')} closeLabel={t('close')}
      {...(selectedSource == null ? {} : {
        description: t(sourceIsPartial(selectedSource) ? 'grokHistoryPartial' : 'grokHistoryRecovered'),
      })}
      className={css.grokHistoryModal as string}
      footer={<Button variant="ghost" onClick={onClose}>{t('close')}</Button>}>
      {failed && <p role="alert">{t('grokHistoryUnavailable')}</p>}
      {!failed && history === undefined && <div className={css.grokHistoryLoading} role="status" aria-label={t('grokHistoryLoading')}><StateDot state="ongoing" size={20} /></div>}
      {history === null && <p>{t('grokHistoryEmpty')}</p>}
      {sources.length > 0 && (
        <label className={css.grokHistorySource}>
          <span>{t('grokHistorySource')}</span>
          <select value={sourceId} onChange={(event) => { setSourceId(event.target.value) }}>
            <option value="primary">{t('grokHistoryPrimary')}</option>
            {sources.map(source => <option key={source.id} value={source.id}>{source.label}</option>)}
          </select>
        </label>
      )}
      {history != null && selectedSource != null && <ol key={sourceId} className={css.grokHistoryMessages}>
        {selectedSource.messages.map(message => (
          <li key={message.sourceSequence} className={css.grokHistoryMessage}>
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
                {hasVerifiedAttachment(history, sourceId, message) && (
                  <Tooltip label={t('grokHistoryDownloadTooltip')} side="top" portal>
                    <a
                      className={css.grokHistoryDownload}
                      href={attachmentDownloadUrl(botId, sourceId, message.sourceSequence)}
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
          </li>
        ))}
      </ol>}
    </Modal>
  )
}
