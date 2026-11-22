/** Search the owner's visible Bot messages and open the matching event. */

import { useEffect, useRef, useState } from 'react'
import type { BotMessageSearchItem, BotMessageSearchValue, BotView } from '@yharness/bots/client'
import { IconSidebarSearchOutlineRegular, Input, Modal } from '@yharness/client-ui-primitives'
import type { PropsLocale } from '@yharness/client-ui-slots'
import { BotAvatar } from './BotAvatar.tsx'
import type { BotWorkspaceFace } from './controller.ts'
import { searchResultKey } from './search-result-key.ts'
import css from './BotMessageSearchDialog.module.css'

const SEARCH_DELAY_MS = 160

type SearchResult = {
  readonly query: string
  readonly value: BotMessageSearchValue | null
}

/** Callbacks for the sidebar's owner-only Bot search dialog. */
export interface BotMessageSearchActions {
  /** Query the owner Bot roster through its Host. */
  readonly search: (query: string) => Promise<BotMessageSearchValue>
  /** Select and reveal an authorized matching event. */
  readonly openResult: (result: BotMessageSearchItem) => void
  /** Open or dismiss the dialog. */
  readonly setOpen: (open: boolean) => void
}

/**
 * Show matching chats with their current Bot avatar and a bounded text excerpt.
 * @param props - Current roster, search actions, and dialog visibility.
 * @returns Modal content while searching.
 */
export function BotMessageSearchDialog({
  bots, actions, loadAvatar, t,
}: PropsLocale<'bots'> & {
  readonly bots: readonly BotView[]
  readonly actions: BotMessageSearchActions
  readonly loadAvatar: BotWorkspaceFace['loadAvatar']
}) {
  const [text, setText] = useState('')
  const [result, setResult] = useState<SearchResult | undefined>()
  const query = text.trim()
  const { search, setOpen, openResult } = actions
  useEffect(() => {
    if (query === '') return
    let current = true
    const timer = window.setTimeout(() => {
      void search(query).then((value) => {
        if (current) setResult({ query, value })
      }, () => {
        if (current) setResult({ query, value: null })
      })
    }, SEARCH_DELAY_MS)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [query, search])

  const current = query === '' || result?.query !== query ? undefined : result
  const matches = (current?.value?.items ?? []).flatMap((item) => {
    const bot = bots.find(candidate => candidate.id === item.botId && candidate.sessionId === item.sessionId)
    return bot === undefined ? [] : [{ bot, item }]
  })
  const firstResult = useRef<HTMLButtonElement | null>(null)

  return (
    <Modal open onClose={() => { setOpen(false) }} title={t('searchChats')} closeLabel={t('close')} className={css.dialog as string}>
      <div className={css.content}>
        <Input
          type="search"
          value={text}
          maxLength={500}
          className={css.input as string}
          data-modal-autofocus
          aria-label={t('searchChatMessages')}
          placeholder={t('searchChatsPlaceholder')}
          icon={<IconSidebarSearchOutlineRegular size={16} />}
          onChange={(event) => { setText(event.currentTarget.value) }}
          onKeyDown={(event) => { searchResultKey(event, firstResult.current) }}
        />
        {query !== '' && current === undefined && <p className={css.status} role="status">{t('searchChatsLoading')}</p>}
        {current?.value === null && <p className={css.status} role="alert">{t('searchChatsError')}</p>}
        {current?.value != null && matches.length === 0 && <p className={css.status} role="status">{t('searchChatsEmpty')}</p>}
        {matches.length > 0 && (
          <ul className={css.results} aria-label={t('searchChatMessages')}>
            {matches.map(({ bot, item }, index) => (
              <li key={`${item.sessionId}:${String(item.seq)}`}>
                <button
                  type="button"
                  ref={index === 0 ? firstResult : undefined}
                  className={css.result}
                  onClick={() => { openResult(item) }}
                >
                  <span aria-hidden="true">
                    <BotAvatar name={bot.name} botId={bot.id} identity={bot.identity} accent={bot.accent}
                      avatar={bot.avatar} loadAvatar={loadAvatar} size="small" />
                  </span>
                  <span className={css.resultCopy}>
                    <strong>{bot.name}</strong>
                    <span>{item.snippet}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {current?.value?.hasMore === true && <p className={css.status} role="status">{t('searchChatsMore')}</p>}
      </div>
    </Modal>
  )
}
