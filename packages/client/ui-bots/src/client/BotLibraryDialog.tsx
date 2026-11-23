/** Owner view of current and imported Bot files and reply links. */
import { useEffect, useState } from 'react'
import type { BotGrokLibraryCursor, BotGrokLibraryItem, BotGrokLibraryValue, BotLibraryCursor, BotLibraryItem, BotLibraryValue } from '@yharness/bots/client'
import { Button, FileTypeIcon, IconDownloadOutlineRegular, IconLinkOutlineRegular, Modal, StateDot } from '@yharness/client-ui-primitives'
import type { PropsLocale } from '@yharness/client-ui-slots'
import type { PresentedFileDownloads } from '@yharness/client-ui-deliverables/client'
import { grokAttachmentDownloadUrl } from './grok-attachment-download.ts'
import css from './BotLibraryDialog.module.css'

/** Read the next page of a Bot’s delivered files and reply links. */
export type ReadBotLibrary = (id: string, before?: BotLibraryCursor) => Promise<BotLibraryValue>

/** Read the next page of verified files and links from the imported archive. */
export type ReadGrokBotLibrary = (id: string, before?: BotGrokLibraryCursor) => Promise<BotGrokLibraryValue>

type LibraryItem = BotLibraryItem | BotGrokLibraryItem
type Filter = 'all' | 'file' | 'media' | 'link'
const filters = { all: 'libraryAll', file: 'libraryFiles', media: 'libraryMedia', link: 'libraryLinks' } as const
const sections = ['libraryToday', 'libraryThisWeek', 'libraryOlder', 'libraryUndated'] as const
type DateGroup = typeof sections[number]
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

function groupResults(items: readonly LibraryItem[], filter: Filter, now: Date): Record<DateGroup, LibraryItem[]> {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const monday = new Date(today)
  monday.setDate(today.getDate() - (today.getDay() + 6) % 7)
  const groups: Record<DateGroup, LibraryItem[]> = { libraryToday: [], libraryThisWeek: [], libraryOlder: [], libraryUndated: [] }
  for (const item of items.toSorted((left, right) => (right.createdAt ?? -1) - (left.createdAt ?? -1))) {
    const filterCategory = item.category === 'file' || item.category === 'link' ? item.category : 'media'
    if (filter !== 'all' && filter !== filterCategory) continue
    const group = item.createdAt === null ? 'libraryUndated' : item.createdAt >= today.getTime() ? 'libraryToday'
      : item.createdAt >= monday.getTime() ? 'libraryThisWeek' : 'libraryOlder'
    groups[group].push(item)
  }
  return groups
}

function useLibraryPage<Item, Cursor>(botId: string, read: ((id: string, before?: Cursor) => Promise<{
  readonly items: readonly Item[]
  readonly nextBefore?: Cursor
}>) | undefined) {
  const [request, setRequest] = useState<{ readonly before?: Cursor }>({})
  const [items, setItems] = useState<readonly Item[]>([])
  const [nextBefore, setNextBefore] = useState<Cursor>()
  const [phase, setPhase] = useState<'loading' | 'error' | 'ready'>('loading')
  useEffect(() => {
    if (read === undefined) return
    let active = true
    void read(botId, request.before).then((page) => {
      if (!active) return
      setItems(previous => request.before === undefined ? page.items : [...previous, ...page.items])
      setNextBefore(page.nextBefore)
      setPhase('ready')
    }, () => {
      if (active) setPhase('error')
    })
    return () => { active = false }
  }, [botId, read, request])
  const load = (before?: Cursor): void => {
    setPhase('loading')
    setRequest(before === undefined ? {} : { before })
  }
  return {
    items: read === undefined ? [] : items,
    phase: read === undefined ? 'ready' as const : phase,
    nextBefore: read === undefined ? undefined : nextBefore,
    retry: () => { load(request.before) },
    load,
  }
}

/**
 * List Bot Library items while the chat stays open.
 * @param props - exact Bot identity, authorized Library readers, dismissal, and locale.
 * @returns the Library dialog for a mounted owner Bot.
 */
export function BotLibraryDialog({ botId, botName, read, readImported, downloadUrl, onClose, t }: PropsLocale<'bots'> & {
  readonly botId: string
  readonly botName: string
  readonly read: ReadBotLibrary
  readonly readImported?: ReadGrokBotLibrary | undefined
  readonly downloadUrl: PresentedFileDownloads['url']
  readonly onClose: () => void
}) {
  const current = useLibraryPage(botId, read)
  const imported = useLibraryPage(botId, readImported)
  const [filter, setFilter] = useState<Filter>('all')
  const [now] = useState(() => new Date())
  const items: readonly LibraryItem[] = [...current.items, ...imported.items]
  const loading = current.phase === 'loading' || imported.phase === 'loading'
  const error = current.phase === 'error' ? 'libraryLoadFailed'
    : imported.phase === 'error' ? 'libraryImportedLoadFailed' : undefined
  const currentNext = current.phase === 'ready' ? current.nextBefore : undefined
  const importedNext = imported.phase === 'ready' ? imported.nextBefore : undefined
  const more = currentNext !== undefined || importedNext !== undefined
  const groups = groupResults(items, filter, now)
  const emptyMessage = filter !== 'all' ? t('libraryFilterEmpty')
    : more ? t('libraryPageEmpty') : t('libraryEmpty')
  return <Modal open onClose={onClose} title={t('libraryTitle')} description={botName}
    closeLabel={t('close')} className={css.modal as string}>
    <div className={css.content} aria-busy={loading}>
      {items.length > 0 && <div className={css.filters} role="group" aria-label={t('libraryFilter')}>
        {(['all', 'file', 'media', 'link'] as const).map(value => <Button key={value} size="sm"
          variant="ghost" aria-pressed={filter === value}
          onClick={() => { setFilter(value) }}>{t(filters[value])}</Button>)}
      </div>}
      {sections.map(section => groups[section].length === 0 ? null : <section className={css.section} key={section}>
        <h3>{t(section)}</h3>
        <ul className={css.files}>
          {groups[section].map((item) => {
            const link = item.category === 'link'
            const archived = 'origin' in item
            const key = archived ? JSON.stringify([item.sourceId, item.sourceSequence, item.itemIndex]) : `${item.eventSeq}:${item.fileIndex}`
            const href = link ? item.url : archived
              ? grokAttachmentDownloadUrl(item.botId, item.sourceId, item.sourceSequence)
              : downloadUrl(item.sessionId, item.eventSeq, item.fileIndex)
            return <li key={key}>
              <a className={css.result} href={href}
                download={link ? undefined : true} target={link ? '_blank' : undefined}
                rel={link ? 'noopener noreferrer' : undefined}
                data-yh-open-external={link ? '' : undefined}
                aria-description={archived ? t('libraryImportedGrok') : undefined}
                aria-label={link ? t('libraryOpenLink', { name: item.label }) : t('libraryDownload', { name: item.label })}>
                {link ? <span className={css.linkIcon} aria-hidden="true"><IconLinkOutlineRegular size={16} /></span>
                  : <span className={css.fileIcon} aria-hidden="true"><FileTypeIcon path={item.label} /></span>}
                <span className={css.fileText}>
                  <span className={css.label}>{item.label}</span>
                  <span className={css.fileMeta}>
                    {link ? <span className={css.linkHost}>{new URL(item.url).host}</span>
                      : item.createdAt === null ? null
                        : <time dateTime={new Date(item.createdAt).toISOString()}>{dateFormat.format(item.createdAt)}</time>}
                    {archived && <span>{t('libraryImportedGrok')}</span>}
                  </span>
                </span>
                {link ? null : <IconDownloadOutlineRegular className={css.download} size={16} aria-hidden="true" />}
              </a>
            </li>
          })}
        </ul>
      </section>)}
      {!loading && error === undefined && sections.every(section => groups[section].length === 0)
        && <p className={css.notice} role="status">{emptyMessage}</p>}
      {loading && <div className={css.loading} role="status" aria-label={t('libraryLoading')}>
        <StateDot state="ongoing" size={18} />
      </div>}
      {error !== undefined && <div className={css.notice} role="alert">
        <p>{t(error)}</p><Button size="sm" onClick={() => {
          if (current.phase === 'error') current.retry()
          if (imported.phase === 'error') imported.retry()
        }}>{t('retry')}</Button>
      </div>}
      {!loading && more && <div className={css.more}>
        <Button size="sm" variant="ghost" onClick={() => {
          if (currentNext !== undefined) current.load(currentNext)
          if (importedNext !== undefined) imported.load(importedNext)
        }}>{t('libraryShowMore')}</Button>
      </div>}
    </div>
  </Modal>
}
