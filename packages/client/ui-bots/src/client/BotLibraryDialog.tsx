/** Owner view of a Bot’s delivered files and reply links. */
import { useEffect, useState } from 'react'
import type { BotLibraryCursor, BotLibraryItem, BotLibraryValue } from '@yharness/bots/client'
import { Button, FileTypeIcon, IconDownloadOutlineRegular, IconLinkOutlineRegular, Modal, StateDot } from '@yharness/client-ui-primitives'
import type { PropsLocale } from '@yharness/client-ui-slots'
import type { PresentedFileDownloads } from '@yharness/client-ui-deliverables/client'
import css from './BotLibraryDialog.module.css'

/** Read the next page of a Bot’s delivered files and reply links. */
export type ReadBotLibrary = (id: string, before?: BotLibraryCursor) => Promise<BotLibraryValue>

type Filter = 'all' | 'file' | 'media' | 'link'
type DateGroup = 'libraryToday' | 'libraryThisWeek' | 'libraryOlder'
const filters = { all: 'libraryAll', file: 'libraryFiles', media: 'libraryMedia', link: 'libraryLinks' } as const
const sections = ['libraryToday', 'libraryThisWeek', 'libraryOlder'] as const
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

function groupResults(items: readonly BotLibraryItem[], filter: Filter, now: Date): Record<DateGroup, BotLibraryItem[]> {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const monday = new Date(today)
  monday.setDate(today.getDate() - (today.getDay() + 6) % 7)
  const groups: Record<DateGroup, BotLibraryItem[]> = { libraryToday: [], libraryThisWeek: [], libraryOlder: [] }
  for (const item of items) {
    const filterCategory = item.category === 'file' || item.category === 'link' ? item.category : 'media'
    if (filter !== 'all' && filter !== filterCategory) continue
    const group = item.createdAt >= today.getTime() ? 'libraryToday'
      : item.createdAt >= monday.getTime() ? 'libraryThisWeek' : 'libraryOlder'
    groups[group].push(item)
  }
  return groups
}

/**
 * List delivered files and reply links while the Bot chat stays open.
 * @param props - exact Bot identity, its authorized Library reader, dismissal, and locale.
 * @returns the Library dialog for a mounted owner Bot.
 */
export function BotLibraryDialog({ botId, botName, read, downloadUrl, onClose, t }: PropsLocale<'bots'> & {
  readonly botId: string
  readonly botName: string
  readonly read: ReadBotLibrary
  readonly downloadUrl: PresentedFileDownloads['url']
  readonly onClose: () => void
}) {
  const [request, setRequest] = useState<{ readonly before?: BotLibraryCursor }>({})
  const [items, setItems] = useState<readonly BotLibraryItem[]>([])
  const [nextBefore, setNextBefore] = useState<BotLibraryCursor>()
  const [phase, setPhase] = useState<'loading' | 'error' | 'ready'>('loading')
  const [filter, setFilter] = useState<Filter>('all')
  const [now] = useState(() => new Date())
  useEffect(() => {
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
  const load = (before?: BotLibraryCursor): void => {
    setPhase('loading')
    setRequest(before === undefined ? {} : { before })
  }
  const groups = groupResults(items, filter, now)
  const emptyMessage = filter !== 'all' ? t('libraryFilterEmpty')
    : nextBefore === undefined ? t('libraryEmpty') : t('libraryPageEmpty')
  return <Modal open onClose={onClose} title={t('libraryTitle')} description={botName}
    closeLabel={t('close')} className={css.modal as string}>
    <div className={css.content} aria-busy={phase === 'loading'}>
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
            return <li key={`${item.eventSeq}:${item.fileIndex}`}>
              <a className={css.result} href={link ? item.url : downloadUrl(item.sessionId, item.eventSeq, item.fileIndex)}
                download={link ? undefined : true} target={link ? '_blank' : undefined}
                rel={link ? 'noopener noreferrer' : undefined}
                data-yh-open-external={link ? '' : undefined}
                aria-label={link ? t('libraryOpenLink', { name: item.label }) : t('libraryDownload', { name: item.label })}>
                {link ? <span className={css.linkIcon} aria-hidden="true"><IconLinkOutlineRegular size={16} /></span>
                  : <span className={css.fileIcon} aria-hidden="true"><FileTypeIcon path={item.label} /></span>}
                <span className={css.fileText}>
                  <span className={css.label}>{item.label}</span>
                  {link ? <span className={css.linkHost}>{new URL(item.url).host}</span>
                    : <time dateTime={new Date(item.createdAt).toISOString()}>{dateFormat.format(item.createdAt)}</time>}
                </span>
                {link ? null : <IconDownloadOutlineRegular className={css.download} size={16} aria-hidden="true" />}
              </a>
            </li>
          })}
        </ul>
      </section>)}
      {phase === 'ready' && sections.every(section => groups[section].length === 0)
        && <p className={css.notice} role="status">{emptyMessage}</p>}
      {phase === 'loading' && <div className={css.loading} role="status" aria-label={t('libraryLoading')}>
        <StateDot state="ongoing" size={18} />
      </div>}
      {phase === 'error' && <div className={css.notice} role="alert">
        <p>{t('libraryLoadFailed')}</p><Button size="sm" onClick={() => { load(request.before) }}>{t('retry')}</Button>
      </div>}
      {phase === 'ready' && nextBefore !== undefined && <div className={css.more}>
        <Button size="sm" variant="ghost" onClick={() => { load(nextBefore) }}>{t('libraryShowMore')}</Button>
      </div>}
    </div>
  </Modal>
}
