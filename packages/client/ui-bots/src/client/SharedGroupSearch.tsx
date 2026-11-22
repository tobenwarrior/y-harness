/** Search the shared rooms visible to the current collaborator. */
import { useEffect, useRef, useState } from 'react'
import type { BotGroupMessageSearchItem, BotGroupMessageSearchRequest, BotGroupMessageSearchValue } from '@yharness/bots/client'
import { Button, IconSidebarSearchOutlineRegular, IconUsersOutlineRegular, Input } from '@yharness/client-ui-primitives'
import type { PropsLocale } from '@yharness/client-ui-slots'
import { searchResultKey } from './search-result-key.ts'
import css from './BotMessageSearchDialog.module.css'

const SEARCH_DELAY_MS = 160

interface SearchPage {
  readonly query: string
  readonly value: BotGroupMessageSearchValue | null
}

/**
 * Find durable room messages and load earlier matches on demand.
 * @param props - Room search operations and locale.
 * @returns The inline search field and results within the shared workspace.
 */
export function SharedGroupSearch({ search, onSelect, t }: PropsLocale<'bots'> & {
  readonly search: (request: BotGroupMessageSearchRequest) => Promise<BotGroupMessageSearchValue>
  readonly onSelect: (hit: BotGroupMessageSearchItem) => void
}) {
  const [text, setText] = useState('')
  const [page, setPage] = useState<SearchPage>()
  const [older, setOlder] = useState<'loading' | 'error'>()
  const generation = useRef(0)
  const searchRef = useRef(search)
  searchRef.current = search
  const firstResult = useRef<HTMLButtonElement | null>(null)
  const resultList = useRef<HTMLUListElement | null>(null)
  const revealResultIndex = useRef<number | null>(null)
  const field = useRef<HTMLInputElement | null>(null)
  const query = text.trim()
  const current = query === '' || page?.query !== query ? undefined : page.value

  useEffect(() => { field.current?.focus() }, [])
  useEffect(() => {
    const index = revealResultIndex.current
    if (index === null) return
    revealResultIndex.current = null
    const next = resultList.current?.children.item(index)?.querySelector('button')
    next?.scrollIntoView({ block: 'nearest' })
    next?.focus({ preventScroll: true })
  }, [page])
  useEffect(() => {
    if (query === '') return
    const request = generation.current
    const timer = window.setTimeout(() => {
      void searchRef.current({ query }).then((value) => {
        if (generation.current === request) setPage({ query, value })
      }, () => {
        if (generation.current === request) setPage({ query, value: null })
      })
    }, SEARCH_DELAY_MS)
    return () => {
      generation.current += 1
      window.clearTimeout(timer)
    }
  }, [query])

  async function searchOlder(): Promise<void> {
    const previous = current?.items.at(-1)
    if (current?.hasMore !== true || previous === undefined || older === 'loading') return
    const request = generation.current
    setOlder('loading')
    try {
      const next = await searchRef.current({ query, before: { groupId: previous.groupId, messageId: previous.messageId } })
      if (generation.current !== request) return
      if (next.items.length > 0) revealResultIndex.current = current.items.length
      setPage({ query, value: { items: [...current.items, ...next.items], hasMore: next.hasMore } })
      setOlder(undefined)
    } catch (_error) {
      if (generation.current === request) setOlder('error')
    }
  }

  return <div className={`${css.content} ${css.inline}`}>
    <Input
      ref={field}
      type="search"
      value={text}
      maxLength={500}
      className={css.input as string}
      aria-label={t('sharedGroupSearch')}
      placeholder={t('searchChatsPlaceholder')}
      icon={<IconSidebarSearchOutlineRegular size={16} />}
      onChange={(event) => {
        const next = event.currentTarget.value
        if (next.trim() !== query) {
          generation.current += 1
          revealResultIndex.current = null
          setPage(undefined)
          setOlder(undefined)
        }
        setText(next)
      }}
      onKeyDown={(event) => { searchResultKey(event, firstResult.current) }}
    />
    {query !== '' && current === undefined && <p className={css.status} role="status">{t('searchChatsLoading')}</p>}
    {current === null && <p className={css.status} role="alert">{t('sharedGroupSearchError')}</p>}
    {current?.items.length === 0 && <p className={css.status} role="status">{t('searchChatsEmpty')}</p>}
    {current != null && current.items.length > 0 && <ul ref={resultList} className={css.results} aria-label={t('sharedGroupSearch')}>
      {current.items.map((hit, index) => <li key={`${String(hit.groupId)}:${String(hit.messageId)}`}>
        <button type="button" ref={index === 0 ? firstResult : undefined} className={css.result} onClick={() => { onSelect(hit) }}>
          <span className={css.roomIcon} aria-hidden="true"><IconUsersOutlineRegular size={16} /></span>
          <span className={css.resultCopy}><strong>{hit.groupName}</strong><span>{hit.snippet}</span></span>
        </button>
      </li>)}
    </ul>}
    {current?.hasMore === true && <Button size="sm" className={css.older} disabled={older === 'loading'} onClick={() => { void searchOlder() }}>
      {older === 'loading' ? t('searchChatsLoading') : t('sharedGroupSearchOlder')}
    </Button>}
    {older === 'error' && <p className={css.status} role="alert">{t('sharedGroupSearchOlderError')}</p>}
  </div>
}
