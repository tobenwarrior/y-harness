/** Keyboard-first search for the loaded transcript of a direct Bot chat. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import {
  Button, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconCloseOutlineRegular,
  IconSearchOutlineRegular, Input,
} from '@yharness/client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './ChatView.module.css'

/** Window event used by the Bot options menu to open the active Bot chat search. */
export const FIND_IN_CHAT_EVENT = 'yharness:bot-find-chat'

interface FindInChatEventDetail {
  readonly sessionId: string
}

interface FindInChatProps {
  readonly sessionId: string
  readonly contentRevision: string
  readonly scopeRef: RefObject<HTMLElement>
  readonly hasMore: boolean
  readonly loadingOlder: boolean
  readonly loadOlder: () => void
  readonly t: ChatViewSlotProps['t']
}

function normalized(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
}

function transcriptRows(scope: HTMLElement): readonly HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>('[data-chat-flow-kind]')]
    .filter(row => !row.closest('[hidden]'))
}

function sameRows(left: readonly HTMLElement[], right: readonly HTMLElement[]): boolean {
  return left.length === right.length && left.every((row, index) => row === right[index])
}

function belongsToAnotherSurface(element: EventTarget | null): boolean {
  return element instanceof Element
    && element.closest('[role="dialog"], [data-computer-panel]') !== null
}

/**
 * Render direct-Bot transcript search without replacing the session or querying
 * another Bot's history. Older durable rows are requested through the same
 * session loader used by the transcript's existing "Load earlier" control.
 * @param props - active session, transcript scope, history state, and locale.
 * @returns the transient find surface, or null while it is closed.
 */
export function FindInChat({
  sessionId, contentRevision, scopeRef, hasMore, loadingOlder, loadOlder, t,
}: FindInChatProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<readonly HTMLElement[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const activeRowRef = useRef<HTMLElement | undefined>(undefined)
  const queryRef = useRef('')

  const close = useCallback(() => {
    const restoreFocus = restoreFocusRef.current
    restoreFocusRef.current = null
    setOpen(false)
    setQuery('')
    setMatches([])
    setActiveIndex(0)
    requestAnimationFrame(() => {
      if (restoreFocus?.isConnected) restoreFocus.focus()
    })
  }, [])

  const openSearch = useCallback(() => {
    if (restoreFocusRef.current === null) {
      const active = globalThis.document.activeElement
      restoreFocusRef.current = active instanceof HTMLElement ? active : null
    }
    setOpen(true)
    requestAnimationFrame(() => { inputRef.current?.focus() })
  }, [])

  useEffect(() => {
    const onRequest = (event: Event): void => {
      const detail = (event as CustomEvent<FindInChatEventDetail>).detail
      if (detail.sessionId !== sessionId) return
      openSearch()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const key = event.key.toLocaleLowerCase()
      const activeElement = globalThis.document.activeElement
      if (belongsToAnotherSurface(event.target) || belongsToAnotherSurface(activeElement)) return
      if ((event.metaKey || event.ctrlKey) && !event.altKey && key === 'f') {
        event.preventDefault()
        openSearch()
      } else if (open && event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    }
    globalThis.addEventListener(FIND_IN_CHAT_EVENT, onRequest)
    globalThis.addEventListener('keydown', onKeyDown)
    return () => {
      globalThis.removeEventListener(FIND_IN_CHAT_EVENT, onRequest)
      globalThis.removeEventListener('keydown', onKeyDown)
    }
  }, [close, open, openSearch, sessionId])

  useLayoutEffect(() => {
    activeRowRef.current = matches[activeIndex]
  }, [activeIndex, matches])

  useLayoutEffect(() => {
    const scope = scopeRef.current
    const term = normalized(query)
    const queryChanged = queryRef.current !== term
    queryRef.current = term
    if (scope === null || term === '') {
      activeRowRef.current = undefined
      setMatches(current => current.length === 0 ? current : [])
      setActiveIndex(current => current === 0 ? current : 0)
      return
    }
    const found = transcriptRows(scope).filter(row => normalized(row.textContent).includes(term))
    const activeRow = activeRowRef.current
    const nextActiveIndex = queryChanged || activeRow === undefined
      ? 0
      : Math.max(0, found.indexOf(activeRow))
    setMatches(current => sameRows(current, found) ? current : found)
    setActiveIndex(() => found.length === 0 ? 0 : nextActiveIndex)
  }, [contentRevision, query, scopeRef])

  useLayoutEffect(() => {
    const scope = scopeRef.current
    if (scope === null) return
    scope.querySelectorAll<HTMLElement>('[data-chat-find-match], [data-chat-find-active]').forEach((row) => {
      delete row.dataset.chatFindMatch
      delete row.dataset.chatFindActive
    })
    matches.forEach((row) => { row.dataset.chatFindMatch = '' })
    const active = matches[activeIndex]
    if (active !== undefined) {
      active.dataset.chatFindActive = ''
      const scrollIntoView = Reflect.get(active, 'scrollIntoView')
      if (typeof scrollIntoView === 'function') {
        scrollIntoView.call(active, { behavior: 'smooth', block: 'center' })
      }
    }
  }, [activeIndex, matches, scopeRef])

  if (!open) return null

  const next = (): void => {
    if (matches.length === 0) return
    setActiveIndex(index => (index + 1) % matches.length)
  }
  const previous = (): void => {
    if (matches.length === 0) return
    setActiveIndex(index => (index - 1 + matches.length) % matches.length)
  }
  const resultLabel = query.trim() === ''
    ? t('chat.findHint')
    : matches.length === 0
      ? t('chat.findNoMatches')
      : t(hasMore ? 'chat.findResultsLoaded' : 'chat.findResults', {
        current: activeIndex + 1, count: matches.length,
      })

  return (
    <div className={css.findBar} role="search" aria-label={t('chat.findInChat')}>
      <Input
        ref={inputRef}
        className={css.findInput ?? ''}
        icon={<IconSearchOutlineRegular size={15} />}
        value={query}
        placeholder={t('chat.findPlaceholder')}
        aria-label={t('chat.findPlaceholder')}
        onChange={(event) => { setQuery(event.currentTarget.value) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            if (event.shiftKey) previous()
            else next()
          }
        }}
      />
      <span className={css.findStatus} role="status" aria-live="polite">{resultLabel}</span>
      <Button variant="ghost" size="sm" icon={<IconChevronUpOutlineRegular size={15} />}
        aria-label={t('chat.findPrevious')} disabled={matches.length === 0} onClick={previous} />
      <Button variant="ghost" size="sm" icon={<IconChevronDownOutlineRegular size={15} />}
        aria-label={t('chat.findNext')} disabled={matches.length === 0} onClick={next} />
      {query.trim() !== '' && hasMore && (
        <Button variant="ghost" size="sm" className={css.findOlder} disabled={loadingOlder} onClick={loadOlder}>
          {loadingOlder ? t('loading') : t('chat.findSearchOlder')}
        </Button>
      )}
      <Button variant="ghost" size="sm" icon={<IconCloseOutlineRegular size={15} />}
        aria-label={t('chat.findClose')} onClick={close} />
    </div>
  )
}
