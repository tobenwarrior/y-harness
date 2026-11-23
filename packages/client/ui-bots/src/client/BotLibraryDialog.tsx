/** Owner view of a Bot’s delivered files. */
import { useEffect, useState } from 'react'
import type { BotLibraryCursor, BotLibraryItem, BotLibraryValue } from '@yharness/bots/client'
import { Button, FileTypeIcon, IconDownloadOutlineRegular, ImageLightbox, Modal, StateDot } from '@yharness/client-ui-primitives'
import type { PropsLocale } from '@yharness/client-ui-slots'
import type { PresentedFileDownloads, PresentedFilePreviews } from '@yharness/client-ui-deliverables/client'
import css from './BotLibraryDialog.module.css'

/** Read the next page of a Bot’s delivered files. */
export type ReadBotLibrary = (id: string, before?: BotLibraryCursor) => Promise<BotLibraryValue>

type Filter = 'all' | 'file' | 'media'
type DateGroup = 'libraryToday' | 'libraryThisWeek' | 'libraryOlder'
const filters = { all: 'libraryAll', file: 'libraryFiles', media: 'libraryMedia' } as const
const sections = ['libraryToday', 'libraryThisWeek', 'libraryOlder'] as const
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

function groupResults(items: readonly BotLibraryItem[], filter: Filter, now: Date): Record<DateGroup, BotLibraryItem[]> {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const monday = new Date(today)
  monday.setDate(today.getDate() - (today.getDay() + 6) % 7)
  const groups: Record<DateGroup, BotLibraryItem[]> = { libraryToday: [], libraryThisWeek: [], libraryOlder: [] }
  for (const item of items) {
    if (filter === 'file' && item.category !== 'file') continue
    if (filter === 'media' && item.category === 'file') continue
    const group = item.createdAt >= today.getTime() ? 'libraryToday'
      : item.createdAt >= monday.getTime() ? 'libraryThisWeek' : 'libraryOlder'
    groups[group].push(item)
  }
  return groups
}

/**
 * List and download delivered files while the Bot chat stays open behind the dialog.
 * @param props - exact Bot identity, its authorized Library reader, dismissal, and locale.
 * @returns the Library dialog for a mounted owner Bot.
 */
export function BotLibraryDialog({ botId, botName, read, downloadUrl, previewUrl, onClose, t }: PropsLocale<'bots'> & {
  readonly botId: string
  readonly botName: string
  readonly read: ReadBotLibrary
  readonly downloadUrl: PresentedFileDownloads['url']
  readonly previewUrl?: PresentedFilePreviews['url'] | undefined
  readonly onClose: () => void
}) {
  const [request, setRequest] = useState<{ readonly before?: BotLibraryCursor }>({})
  const [items, setItems] = useState<readonly BotLibraryItem[]>([])
  const [nextBefore, setNextBefore] = useState<BotLibraryCursor>()
  const [phase, setPhase] = useState<'loading' | 'error' | 'ready'>('loading')
  const [filter, setFilter] = useState<Filter>('all')
  const [preview, setPreview] = useState<BotLibraryItem | undefined>()
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
  return <>
    <Modal open onClose={onClose} title={t('libraryTitle')} description={botName}
      closeLabel={t('close')} className={css.modal as string}>
      <div className={css.content} aria-busy={phase === 'loading'}>
        {items.length > 0 && <div className={css.filters} role="group" aria-label={t('libraryFilter')}>
          {(['all', 'file', 'media'] as const).map(value => <Button key={value} size="sm"
            variant="ghost" aria-pressed={filter === value}
            onClick={() => { setFilter(value) }}>{t(filters[value])}</Button>)}
        </div>}
        {sections.map(section => groups[section].length === 0 ? null : <section className={css.section} key={section}>
          <h3>{t(section)}</h3>
          <ul className={css.files}>
            {groups[section].map((item) => {
              const canPreview = item.previewable && previewUrl !== undefined
              const details = <>
                <span className={css.fileIcon} aria-hidden="true"><FileTypeIcon path={item.label} /></span>
                <span className={css.fileText}>
                  <span className={css.label}>{item.label}</span>
                  <time dateTime={new Date(item.createdAt).toISOString()}>{dateFormat.format(item.createdAt)}</time>
                </span>
              </>
              return <li key={`${item.eventSeq}:${item.fileIndex}`}>
                <div className={css.result}>
                  {canPreview
                    ? <button type="button" className={css.preview} onClick={() => { setPreview(item) }}
                      aria-label={t('libraryPreview', { name: item.label })}>{details}</button>
                    : <span className={css.fileInfo}>{details}</span>}
                  <a className={css.download} href={downloadUrl(item.sessionId, item.eventSeq, item.fileIndex)} download
                    aria-label={t('libraryDownload', { name: item.label })}>
                    <IconDownloadOutlineRegular size={16} aria-hidden="true" />
                  </a>
                </div>
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
    {preview !== undefined && previewUrl !== undefined && <ImageLightbox
      src={previewUrl(preview.sessionId, preview.eventSeq, preview.fileIndex)} alt={preview.label}
      labels={{ dialog: t('libraryPreviewDialog'), close: t('libraryPreviewClose') }}
      onClose={() => { setPreview(undefined) }} />}
  </>
}
