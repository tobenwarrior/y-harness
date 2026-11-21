/** Review of proposed shared Bot context, scoped to the selected Bot. */
import { useEffect, useRef, useState } from 'react'
import type { BotId, BotShareLearningSuggestion, BotShareLearningValue, BotShareMemoryEntry } from '@yharness/bots/client'
import type { PropsLocale } from '@yharness/client-ui-slots'
import { Button, StateDot } from '@yharness/client-ui-primitives'
import type { SharedBotsClient } from './shared-client.ts'
import css from './BotWorkspace.module.css'

/** Actions supplied by the authenticated reviewer surface. */
export interface SharedLearningReviewProps extends PropsLocale<'bots'> {
  /** Bot whose suggestions are available. */
  readonly botId: BotId
  /** Read pending suggestions and recently published notes. */
  readonly list: NonNullable<SharedBotsClient['listLearning']>
  /** Resolve one suggestion. */
  readonly decide: NonNullable<SharedBotsClient['decideLearning']>
  /** Apply the new published note to the visible shared context. */
  readonly onPublished?: (entry: BotShareMemoryEntry) => void
  /** Show published notes beneath the review when the surrounding view has no context list. */
  readonly showPublished?: boolean
}

/**
 * Expand an authenticated Bot's pending learning suggestions on demand.
 * @param props - Active Bot, authorized actions, and localized copy.
 * @returns A compact reviewer control and its expandable content.
 */
export function SharedLearningReview({ botId, list, decide, onPublished, showPublished, t }: SharedLearningReviewProps) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState<BotShareLearningValue | null>(null)
  const [error, setError] = useState(false)
  const [reviewing, setReviewing] = useState<BotShareLearningSuggestion['id'] | null>(null)
  const [retry, setRetry] = useState(0)
  const generation = useRef(0)
  const current = value?.botId === botId ? value : null

  useEffect(() => {
    if (!open) return
    const request = ++generation.current
    setValue(null)
    setError(false)
    setReviewing(null)
    void list({ botId }).then((result) => {
      if (generation.current !== request) return
      if (result.ok && result.value.botId === botId) setValue(result.value)
      else setError(true)
    }).catch(() => { if (generation.current === request) setError(true) })
    return () => { generation.current += 1 }
  }, [botId, list, open, retry])

  async function resolve(
    currentValue: BotShareLearningValue, suggestionId: BotShareLearningSuggestion['id'], decision: 'approve' | 'reject',
  ): Promise<void> {
    const request = generation.current
    setError(false)
    setReviewing(suggestionId)
    try {
      const result = await decide({ botId, suggestionId, decision })
      if (generation.current !== request) return
      if (!result.ok || result.value.botId !== botId || result.value.suggestionId !== suggestionId) {
        if (!result.ok && (result.error.code === 'gateway/forbidden' || result.error.code === 'gateway/unauthorized')) setValue(null)
        setError(true)
        return
      }
      const { entry } = result.value
      setValue({
        ...currentValue,
        pending: currentValue.pending.filter(item => item.id !== suggestionId),
        recentlyLearned: entry === undefined ? currentValue.recentlyLearned : [entry, ...currentValue.recentlyLearned],
      })
      if (entry !== undefined) onPublished?.(entry)
    } catch {
      if (generation.current === request) setError(true)
    } finally {
      if (generation.current === request) setReviewing(null)
    }
  }

  return (
    <div className={css.sharedLearning}>
      <Button variant="outline" size="sm" aria-expanded={open} onClick={() => { setOpen(!open) }}>
        {t('reviewSharedLearning')}
      </Button>
      {open && (
        <div className={css.sharedLearningContent}>
          {error && (
            <div className={css.shareInviteRow}>
              <span className={css.sharedMemoryDescription} role="alert">{t('sharedLearningFailed')}</span>
              {current === null && <Button variant="ghost" size="sm" onClick={() => { setRetry(retry + 1) }}>{t('retry')}</Button>}
            </div>
          )}
          {current === null && !error && (
            <div className={css.shareLoading} role="status" aria-label={t('sharedLearningLoading')}><StateDot state="ongoing" size={12} /></div>
          )}
          {current !== null && (
            <>
              {current.pending.length === 0 && <p className={css.sharedMemoryDescription}>{t('sharedLearningEmpty')}</p>}
              {current.pending.map(item => (
                <div className={css.sharedLearningItem} key={item.id}>
                  <p className={css.sharedMemoryEntry}>{item.text}</p>
                  <div className={css.sharedLearningActions}>
                    <Button size="sm" variant="ghost" disabled={reviewing !== null} onClick={() => { void resolve(current, item.id, 'reject') }}>
                      {t('rejectSharedLearning')}
                    </Button>
                    <Button size="sm" variant="outline" disabled={reviewing !== null} onClick={() => { void resolve(current, item.id, 'approve') }}>
                      {t('approveSharedLearning')}
                    </Button>
                  </div>
                </div>
              ))}
              {showPublished === true && current.recentlyLearned.length > 0 && (
                <div className={css.sharedMemoryEntries}>
                  <div className={css.sharedContextLabel}>{t('recentlySharedLearning')}</div>
                  {current.recentlyLearned.map(item => <p className={css.sharedMemoryEntry} key={item.id}>{item.text}</p>)}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
