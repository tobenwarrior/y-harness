/** Read-only Grok archive inside the current Bot conversation. */

import { useEffect, useState } from 'react'
import type { BotGrokHistoryArchive } from '@yharness/bots/client'
import { Button, IconArchiveOffOutlineRegular, Modal, Tooltip } from '@yharness/client-ui-primitives'
import type { PropsLocale } from '@yharness/client-ui-slots'
import css from './BotWorkspace.module.css'

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function messageLabel(
  message: BotGrokHistoryArchive['messages'][number],
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

/**
 * Open the recovered messages without replacing the current conversation.
 * @param props - selected Bot identity, archive reader, and localized copy.
 * @returns An archive action when history is available.
 */
export function GrokHistoryAction({
  botId, botName, read, t,
}: PropsLocale<'bots'> & {
  botId: string
  botName: string
  read: (id: string) => Promise<BotGrokHistoryArchive | null>
}) {
  const [history, setHistory] = useState<BotGrokHistoryArchive | null>(null)
  const [open, setOpen] = useState(false)
  const [sourceId, setSourceId] = useState('primary')
  useEffect(() => {
    let active = true
    void read(botId).then((archive) => {
      if (active) setHistory(archive)
    }, () => {
      if (active) setHistory(null)
    })
    return () => { active = false }
  }, [botId, read])
  if (history === null) return null
  const sources = history.sources ?? []
  const selectedSource = sources.find(source => source.id === sourceId) ?? history
  const close = (): void => { setOpen(false) }
  return (
    <>
      <Tooltip label={t('grokHistory')} side="bottom" portal>
        <Button variant="ghost" size="sm" aria-label={t('grokHistory')} icon={<IconArchiveOffOutlineRegular size={14} />}
          onClick={() => { setSourceId('primary'); setOpen(true) }} />
      </Tooltip>
      <Modal open={open} onClose={close} title={t('grokHistory')} closeLabel={t('close')}
        description={t(sourceIsPartial(selectedSource) ? 'grokHistoryPartial' : 'grokHistoryRecovered')}
        className={css.grokHistoryModal as string}
        footer={<Button variant="ghost" onClick={close}>{t('close')}</Button>}>
        {sources.length > 0 && (
          <label className={css.grokHistorySource}>
            <span>{t('grokHistorySource')}</span>
            <select value={sourceId} onChange={(event) => { setSourceId(event.target.value) }}>
              <option value="primary">{t('grokHistoryPrimary')}</option>
              {sources.map(source => <option key={source.id} value={source.id}>{source.label}</option>)}
            </select>
          </label>
        )}
        <ol key={sourceId} className={css.grokHistoryMessages}>
          {selectedSource.messages.map(message => (
            <li key={message.sourceSequence} className={css.grokHistoryMessage}>
              <div className={css.grokHistoryMessageMeta}>
                <strong>{messageLabel(message, botName, t)}</strong>
                {message.fromBot !== undefined && message.author !== undefined && message.author !== message.fromBot && (
                  <span>{t('grokHistoryAuthor', { name: message.author })}</span>
                )}
                {typeof message.timestampMs === 'number' && Number.isFinite(message.timestampMs) ? (
                  <time dateTime={new Date(message.timestampMs).toISOString()}>{dateFormat.format(message.timestampMs)}</time>
                ) : (
                  <span>{t('grokHistoryUnknownTimestamp')}</span>
                )}
              </div>
              {message.text.length > 0 && <p>{message.text}</p>}
              {message.incomplete === true && <div className={css.grokHistoryMessageStatus}>{t('grokHistoryIncomplete')}</div>}
            </li>
          ))}
        </ol>
      </Modal>
    </>
  )
}
