/** Read-only Grok archive inside the current Bot conversation. */

import { useEffect, useState } from 'react'
import type { BotGrokHistoryArchive } from '@yharness/bots/client'
import { Button, IconArchiveOffOutlineRegular, Modal, Tooltip } from '@yharness/client-ui-primitives'
import type { PropsLocale } from '@yharness/client-ui-slots'
import css from './BotWorkspace.module.css'

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

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
  const close = (): void => { setOpen(false) }
  return (
    <>
      <Tooltip label={t('grokHistory')} side="bottom" portal>
        <Button variant="ghost" size="sm" aria-label={t('grokHistory')} icon={<IconArchiveOffOutlineRegular size={14} />}
          onClick={() => { setOpen(true) }} />
      </Tooltip>
      <Modal open={open} onClose={close} title={t('grokHistory')} closeLabel={t('close')}
        description={t(history.firstCachedSequence === 1 ? 'grokHistoryRecovered' : 'grokHistoryPartial')}
        className={css.grokHistoryModal as string}
        footer={<Button variant="ghost" onClick={close}>{t('close')}</Button>}>
        <ol className={css.grokHistoryMessages}>
          {history.messages.map(message => (
            <li key={message.sourceSequence} className={css.grokHistoryMessage}>
              <div className={css.grokHistoryMessageMeta}>
                <strong>{message.role === 'user' ? t('grokHistoryYou') : botName}</strong>
                <time dateTime={new Date(message.timestampMs).toISOString()}>{dateFormat.format(message.timestampMs)}</time>
              </div>
              <p>{message.text}</p>
            </li>
          ))}
        </ol>
      </Modal>
    </>
  )
}
