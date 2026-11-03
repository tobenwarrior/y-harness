import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconCloseOutlineRegular, IconEditOutlineRegular, IconTrashOutlineRegular, Modal, StateDot, Tooltip,
} from '@yharness/client-ui-primitives'
import type { PropsLocale } from '@yharness/client-ui-slots'
import { BotAvatar } from './BotAvatar.tsx'
import css from './BotWorkspace.module.css'
import type { BotMemoryManagerActions, BotMemorySummary, BotSummary, BotWorkspaceProps } from './types.ts'

type Translate = PropsLocale<'bots'>['t']

/** Props for the selected Bot's private memory manager. */
export interface BotMemoryManagerProps {
  /** Selected Bot whose private memory projection is shown. */
  readonly bot: BotSummary
  /** Host-backed list, update, and logical-remove actions. */
  readonly actions: BotMemoryManagerActions
  /** Optional Bot-owned image loader for the manager identity chip. */
  readonly loadAvatar?: BotWorkspaceProps['loadAvatar']
  /** Whether the manager modal is visible. */
  readonly open: boolean
  /** Close the manager without changing the selected Bot. */
  readonly onClose: () => void
  /** Locale-owned Bot workspace translator. */
  readonly t: Translate
}

function memoryDate(value: number): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString()
}

/** Render a bot-scoped memory list with explicit edit and logical-remove controls. */
export function BotMemoryManager({ bot, actions, loadAvatar, open, onClose, t }: BotMemoryManagerProps): ReactNode {
  const [memories, setMemories] = useState<readonly BotMemorySummary[]>([])
  const [loading, setLoading] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<'load' | 'update' | null>(null)
  const [removeError, setRemoveError] = useState(false)

  useEffect(() => {
    if (!open) return
    let live = true
    setLoading(true)
    setError(null)
    setEditingId(null)
    setConfirmingId(null)
    setRemoveError(false)
    void actions.list(bot.id).then((next) => {
      if (!live) return
      setMemories(next)
    }).catch(() => {
      if (live) setError('load')
    }).finally(() => {
      if (live) setLoading(false)
    })
    return () => { live = false }
  }, [actions, bot.id, loadAttempt, open])

  const beginEdit = (id: string, text: string): void => {
    setEditingId(id)
    setDraft(text)
    setError(null)
    setConfirmingId(null)
    setRemoveError(false)
  }

  const cancelEdit = (): void => {
    setEditingId(null)
    setDraft('')
  }

  const save = async (id: string): Promise<void> => {
    const text = draft.trim()
    if (text === '' || working !== null) return
    setWorking(id)
    setError(null)
    try {
      const updated = await actions.update(bot.id, id, text)
      setMemories(current => current.map(memory => memory.id === id ? updated : memory))
      cancelEdit()
    } catch {
      setError('update')
    } finally {
      setWorking(current => current === id ? null : current)
    }
  }

  const remove = async (id: string): Promise<void> => {
    if (working !== null) return
    setWorking(id)
    setError(null)
    setRemoveError(false)
    try {
      await actions.remove(bot.id, id)
      setMemories(current => current.filter(memory => memory.id !== id))
      setConfirmingId(null)
      setRemoveError(false)
      if (editingId === id) cancelEdit()
    } catch {
      setRemoveError(true)
    } finally {
      setWorking(current => current === id ? null : current)
    }
  }

  const errorText = error === 'load'
    ? t('memoryLoadFailed')
    : error === 'update'
      ? t('memorySaveFailed')
      : undefined

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={t('memoryManagerTitle')}
        description={t('memoryManagerDescription')}
        closeLabel={t('close')}
        className={css.memoryModal as string}
        contentClassName={css.memoryModalContent as string}
        footer={<Button variant="ghost" onClick={onClose}>{t('close')}</Button>}
      >
        <div className={css.memoryManagerHeading}>
          <BotAvatar name={bot.name} identity={bot.identity} accent={bot.accent} avatar={bot.avatar} botId={bot.id} loadAvatar={loadAvatar} size="small" />
          <span>
            <strong>{bot.name}</strong>
            <span>{t('memoryPrivateHint')}</span>
          </span>
        </div>
        {errorText !== undefined && <div className={css.memoryNotice} role="alert">{errorText}</div>}
        {loading && <div className={css.memoryLoading} role="status"><StateDot state="ongoing" size={13} />{t('memoryLoading')}</div>}
        {!loading && error === 'load' && (
          <div className={css.memoryEmpty}>
            <p>{t('memoryLoadFailed')}</p>
            <Button variant="outline" size="sm" onClick={() => { setLoadAttempt(value => value + 1) }}>{t('retry')}</Button>
          </div>
        )}
        {!loading && error !== 'load' && memories.length === 0 && (
          <div className={css.memoryEmpty} role="status">
            <strong>{t('memoryEmptyTitle')}</strong>
            <span>{t('memoryEmptyDescription')}</span>
          </div>
        )}
        {!loading && memories.length > 0 && (
          <ul className={css.memoryList} aria-label={t('memoryListLabel')}>
            {memories.map((memory) => {
              const editing = editingId === memory.id
              const busy = working === memory.id
              return (
                <li key={memory.id} className={css.memoryRow} aria-label={memory.id}>
                  <div className={css.memoryRowMeta}>
                    <span className={css.memoryId}>{memory.id}</span>
                    {memoryDate(memory.createdAt) !== '' && <time dateTime={new Date(memory.createdAt).toISOString()}>{memoryDate(memory.createdAt)}</time>}
                  </div>
                  {editing
                    ? (
                      <div className={css.memoryEditor}>
                        <label className={css.dialogLabel} htmlFor={`yharness-memory-${memory.id}`}>{t('memoryTextLabel')}</label>
                        <textarea
                          id={`yharness-memory-${memory.id}`}
                          className={css.memoryTextarea}
                          value={draft}
                          maxLength={2000}
                          onChange={(event) => { setDraft(event.currentTarget.value) }}
                          disabled={busy}
                        />
                        <div className={css.memoryEditorActions}>
                          <Button variant="ghost" size="sm" onClick={cancelEdit} disabled={busy} icon={<IconCloseOutlineRegular size={13} />}>{t('memoryCancel')}</Button>
                          <Button variant="primary" size="sm" onClick={() => { void save(memory.id) }} disabled={busy || draft.trim() === '' || draft.trim() === memory.text}>
                            {busy ? t('memorySaving') : t('memorySave')}
                          </Button>
                        </div>
                      </div>
                    )
                    : <p className={css.memoryText}>{memory.text}</p>}
                  {!editing && (
                    <div className={css.memoryRowActions}>
                      <Tooltip label={t('memoryEdit')} side="top" portal>
                        <Button variant="ghost" size="sm" aria-label={`${t('memoryEdit')} ${memory.id}`} icon={<IconEditOutlineRegular size={14} />} onClick={() => { beginEdit(memory.id, memory.text) }} />
                      </Tooltip>
                      <Tooltip label={t('memoryRemove')} side="top" portal>
                        <Button variant="ghost" size="sm" aria-label={`${t('memoryRemove')} ${memory.id}`} icon={<IconTrashOutlineRegular size={14} />} onClick={() => { setConfirmingId(memory.id); setError(null); setRemoveError(false) }} />
                      </Tooltip>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Modal>
      <Modal
        open={confirmingId !== null}
        onClose={() => { if (working === null) { setConfirmingId(null); setRemoveError(false) } }}
        title={t('memoryRemoveTitle')}
        description={t('memoryRemoveDescription')}
        closeLabel={t('cancel')}
        footer={(
          <>
            <Button variant="ghost" onClick={() => { setConfirmingId(null) }} disabled={working !== null}>{t('cancel')}</Button>
            <Button variant="primary" className={css.memoryDanger} onClick={() => { if (confirmingId !== null) void remove(confirmingId) }} disabled={working !== null}>
              {working !== null ? t('memoryRemoving') : t('memoryRemoveConfirm')}
            </Button>
          </>
        )}
      >
        {removeError && <div className={css.memoryNotice} role="alert">{t('memoryRemoveFailed')}</div>}
      </Modal>
    </>
  )
}
