import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconEditOutlineRegular, IconLinkOutlineRegular,
  IconPaperPlaneOutlineRegular, IconPlusOutlineRegular,
  IconSidebarBotAddOutlineRegular, IconSidebarBotsOutlineRegular, IconSidebarSearchOutlineRegular,
  IconUsersOutlineRegular, Input, Modal, StateDot, Tag, Tooltip,
} from '@yharness/client-ui-primitives'
import type { PropsLocale } from '@yharness/client-ui-slots'
import { BotAvatar } from './BotAvatar.tsx'
import { BotAvatarEditor } from './BotAvatarEditor.tsx'
import { BotAppearancePicker } from './BotAppearancePicker.tsx'
import css from './BotWorkspace.module.css'
import type {
  BotAccent, BotGroupCreation, BotGroupDeliverySummary, BotGroupDetailData, BotGroupMessageSummary, BotGroupSummary,
  BotIdentity, BotStatus, BotSummary,
  BotWorkspaceProps,
} from './types.ts'

type BotWorkspaceViewProps = BotWorkspaceProps & PropsLocale<'bots'> & { children?: ReactNode }

/** Sidebar geometry passed to the roster when it occupies the shared app rail. */
export interface BotRosterLayoutProps {
  /** Whether the sidebar is showing its expanded content. */
  readonly wide?: boolean
  /** Expand the shared sidebar when a rail-only action needs the full roster. */
  readonly expandSidebar?: () => void
}
function statusState(status: BotStatus): 'ongoing' | 'idle' {
  switch (status) {
    case 'working': return 'ongoing'
    case 'preparing': return 'ongoing'
    case 'idle':
    case 'offline':
      return 'idle'
  }
}

function statusKey(status: BotStatus): 'status.idle' | 'status.working' | 'status.preparing' | 'status.offline' {
  switch (status) {
    case 'working': return 'status.working'
    case 'preparing': return 'status.preparing'
    case 'offline': return 'status.offline'
    case 'idle': return 'status.idle'
  }
}

function statusTone(status: BotStatus): 'info' | 'neutral' {
  switch (status) {
    case 'working': return 'info'
    case 'preparing': return 'info'
    case 'idle':
    case 'offline':
      return 'neutral'
  }
}

function groupBots(bots: readonly BotSummary[], fallback: string): readonly [string, readonly BotSummary[]][] {
  const groups = new Map<string, BotSummary[]>()
  for (const bot of bots) {
    const group = bot.group?.trim() || fallback
    const rows = groups.get(group)
    if (rows === undefined) groups.set(group, [bot])
    else rows.push(bot)
  }
  return [...groups.entries()]
}

function statusLabel(status: BotStatus, t: BotWorkspaceViewProps['t']): string {
  return t(statusKey(status))
}

function BotRow({ bot, selected, onSelect, t, loadAvatar }: {
  bot: BotSummary
  selected: boolean
  onSelect: () => void
  t: BotWorkspaceViewProps['t']
  loadAvatar: BotWorkspaceViewProps['loadAvatar']
}) {
  const unread = bot.unread !== undefined && bot.unread > 0
  const unreadCount = bot.unread ?? 0
  const summary = bot.preview ?? bot.description
  const status = bot.status
  return (
    <button
      type="button"
      className={clsx(css.botRow, selected && css.botRowSelected)}
      data-bot-id={bot.id}
      data-accent={bot.accent ?? 'violet'}
      aria-current={selected ? 'page' : undefined}
      aria-label={status === undefined ? bot.name : `${bot.name}, ${statusLabel(status, t)}`}
      onClick={onSelect}
    >
      <BotAvatar name={bot.name} identity={bot.identity} accent={bot.accent} avatar={bot.avatar}
        botId={bot.id} loadAvatar={loadAvatar} status={bot.status} />
      <span className={css.botRowCopy}>
        <span className={css.botRowHeading}>
          <span className={css.botName}>{bot.name}</span>
          {unread && <span className={css.unreadDot} aria-label={t('unread', { count: unreadCount })}>{unreadCount}</span>}
        </span>
        {summary !== undefined && summary !== '' && <span className={css.botPreview}>{summary}</span>}
        {(status !== undefined || bot.activity !== undefined) && <span className={css.botMeta}>
          {status !== undefined && <><StateDot state={statusState(status)} size={8} /><span>{statusLabel(status, t)}</span></>}
          {status !== undefined && bot.activity !== undefined && <span className={css.metaDivider}>·</span>}
          {bot.activity !== undefined && <span>{bot.activity}</span>}
        </span>}
      </span>
    </button>
  )
}

function GroupAvatarStack({ group, loadAvatar }: { group: BotGroupSummary; loadAvatar: BotWorkspaceProps['loadAvatar'] }) {
  return (
    <span className={css.groupAvatarStack} aria-hidden="true">
      {group.bots.slice(0, 3).map((bot, index) => (
        <span className={css.groupAvatar} key={bot.id} style={{ zIndex: 3 - index }}>
          <BotAvatar name={bot.name} identity={bot.identity} accent={bot.accent} avatar={bot.avatar} botId={bot.id} loadAvatar={loadAvatar} size="small" status={bot.status} />
        </span>
      ))}
      {group.bots.length > 3 && <span className={css.groupAvatarMore}>+{group.bots.length - 3}</span>}
    </span>
  )
}

function GroupRow({ group, selected, onSelect, loadAvatar, t }: {
  group: BotGroupSummary
  selected: boolean
  onSelect: () => void
  loadAvatar: BotWorkspaceProps['loadAvatar']
  t: BotWorkspaceViewProps['t']
}) {
  return (
    <button
      type="button"
      className={clsx(css.groupRow, selected && css.groupRowSelected)}
      aria-current={selected ? 'page' : undefined}
      aria-label={`${group.name}, ${t('groupMemberNames', { count: group.bots.length })}`}
      onClick={onSelect}
    >
      <GroupAvatarStack group={group} loadAvatar={loadAvatar} />
      <span className={css.groupRowCopy}>
        <span className={css.groupRowName}>{group.name}</span>
        <span className={css.groupRowMeta}>{t('groupMemberNames', { count: group.bots.length })}</span>
      </span>
    </button>
  )
}

function NewGroupDialog({ open, onClose, onCreate, bots, error, t }: {
  open: boolean
  onClose: () => void
  onCreate: ((creation: BotGroupCreation) => Promise<void>) | undefined
  bots: readonly BotSummary[]
  error: string | null
  t: BotWorkspaceViewProps['t']
}) {
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<readonly string[]>([])
  const [submitting, setSubmitting] = useState(false)
  useEffect(() => {
    if (!open) return
    setName('')
    setSelected([])
    setSubmitting(false)
  }, [open])
  const toggle = (id: string, checked: boolean): void => {
    setSelected(current => checked ? [...current, id] : current.filter(value => value !== id))
  }
  const submit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (onCreate === undefined || trimmed === '' || selected.length < 2 || selected.length > 6 || submitting) return
    setSubmitting(true)
    try {
      await onCreate({ name: trimmed, botIds: selected })
      onClose()
    } catch {
      // The owner publishes the durable failure; retain the choices for a retry.
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('newGroupTitle')}
      description={t('newGroupDescription')}
      closeLabel={t('cancel')}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" onClick={() => { void submit() }} disabled={name.trim() === '' || selected.length < 2 || selected.length > 6 || submitting}>
            {submitting ? t('groupCreating') : t('groupCreate')}
          </Button>
        </>
      )}
    >
      {error !== null && <div className={css.dialogNotice} role="alert">{error}</div>}
      <div className={css.dialogField} aria-busy={submitting}>
        <label className={css.dialogLabel} htmlFor="yharness-bots-new-group-name">{t('groupName')}</label>
        <Input
          id="yharness-bots-new-group-name"
          data-modal-autofocus
          value={name}
          placeholder={t('groupNamePlaceholder')}
          onChange={(event) => { setName(event.currentTarget.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submit()
            }
          }}
        />
      </div>
      <div className={css.dialogField}>
        <div className={css.dialogLabel}>{t('groupMembers')} · {t('groupMemberCount', { count: selected.length })}</div>
        {bots.length === 0
          ? <div className={css.groupNoBots}>{t('groupNoBots')}</div>
          : <div className={css.groupMemberChoices}>
            {bots.map((bot) => {
              const checked = selected.includes(bot.id)
              const disabled = !checked && selected.length >= 6
              return (
                <label className={clsx(css.groupMemberChoice, checked && css.groupMemberChoiceSelected)} key={bot.id}>
                  <input type="checkbox" checked={checked} disabled={disabled || submitting} aria-label={bot.name} onChange={(event) => { toggle(bot.id, event.currentTarget.checked) }} />
                  <BotAvatar
                    name={bot.name} identity={bot.identity} accent={bot.accent} avatar={bot.avatar}
                    botId={bot.id} loadAvatar={undefined}
                  />
                  <span className={css.groupMemberCopy}>
                    <span className={css.groupMemberName}>{bot.name}</span>
                    {bot.description !== undefined && <span className={css.groupMemberDescription}>{bot.description}</span>}
                  </span>
                </label>
              )
            })}
          </div>}
        {bots.length > 0 && selected.length < 2 && <span className={css.groupHelper}>{t('groupMinMembers')}</span>}
      </div>
    </Modal>
  )
}

function EditGroupDialog({ open, onClose, onUpdate, group, bots, error, t }: {
  open: boolean
  onClose: () => void
  onUpdate?: BotWorkspaceProps['onUpdateGroup']
  group: BotGroupDetailData
  bots: readonly BotSummary[]
  error: string | null
  t: BotWorkspaceViewProps['t']
}) {
  const [name, setName] = useState(group.name)
  const [selected, setSelected] = useState<readonly string[]>(group.bots.map(bot => bot.id))
  const [submitting, setSubmitting] = useState(false)
  useEffect(() => {
    if (!open) return
    setName(group.name)
    setSelected(group.bots.map(bot => bot.id))
    setSubmitting(false)
  }, [group, open])
  const toggle = (id: string, checked: boolean): void => {
    setSelected(current => checked ? [...current, id] : current.filter(value => value !== id))
  }
  const submit = async (): Promise<void> => {
    const trimmed = name.trim()
    if (onUpdate === undefined || trimmed === '' || selected.length < 2 || selected.length > 6 || submitting) return
    setSubmitting(true)
    try {
      await onUpdate({ groupId: group.id, name: trimmed, botIds: selected })
      onClose()
    } catch {
      // The owner keeps the durable failure beside the transcript so choices remain editable.
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('editGroupTitle')}
      description={t('editGroupDescription')}
      closeLabel={t('cancel')}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" onClick={() => { void submit() }} disabled={name.trim() === '' || selected.length < 2 || selected.length > 6 || submitting}>
            {submitting ? t('groupSaving') : t('groupSave')}
          </Button>
        </>
      )}
    >
      {error !== null && <div className={css.dialogNotice} role="alert">{error}</div>}
      <div className={css.dialogField} aria-busy={submitting}>
        <label className={css.dialogLabel} htmlFor="yharness-bots-edit-group-name">{t('groupName')}</label>
        <Input
          id="yharness-bots-edit-group-name"
          data-modal-autofocus
          value={name}
          placeholder={t('groupNamePlaceholder')}
          onChange={(event) => { setName(event.currentTarget.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submit()
            }
          }}
        />
      </div>
      <div className={css.dialogField}>
        <div className={css.dialogLabel}>{t('groupMembers')} · {t('groupMemberCount', { count: selected.length })}</div>
        <div className={css.groupMemberChoices}>
          {bots.map((bot) => {
            const checked = selected.includes(bot.id)
            const disabled = !checked && selected.length >= 6
            return (
              <label className={clsx(css.groupMemberChoice, checked && css.groupMemberChoiceSelected)} key={bot.id}>
                <input type="checkbox" checked={checked} disabled={disabled || submitting} aria-label={bot.name} onChange={(event) => { toggle(bot.id, event.currentTarget.checked) }} />
                <BotAvatar
                  name={bot.name} identity={bot.identity} accent={bot.accent} avatar={bot.avatar}
                  botId={bot.id} loadAvatar={undefined}
                />
                <span className={css.groupMemberCopy}>
                  <span className={css.groupMemberName}>{bot.name}</span>
                  {bot.description !== undefined && <span className={css.groupMemberDescription}>{bot.description}</span>}
                </span>
              </label>
            )
          })}
        </div>
        {selected.length < 2 && <span className={css.groupHelper}>{t('groupMinMembers')}</span>}
      </div>
    </Modal>
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function mentionQueryAt(text: string, cursor: number): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, cursor))
  return match === null ? null : match[1] ?? ''
}

function mentionTargets(text: string, bots: readonly BotSummary[]): readonly string[] {
  return bots.flatMap((bot) => {
    const pattern = new RegExp(`(?:^|\\s)@${escapeRegExp(bot.name)}(?=$|[\\s.,!?;:])`, 'iu')
    return pattern.test(text) ? [bot.id] : []
  })
}

function deliveryStatusText(
  delivery: BotGroupDeliverySummary,
  name: string,
  t: BotWorkspaceViewProps['t'],
): string {
  switch (delivery.status) {
    case 'pending': return t('groupDeliverySending', { name })
    case 'accepted': return t('groupDeliveryWaiting', { name })
    case 'responded': return t('groupDeliveryResponded', { name })
    case 'failed': return t('groupDeliveryFailed', { name, error: delivery.error ?? t('groupDeliveryFailure') })
    default: return t('groupDeliveryFailure')
  }
}

/** Render a persistent shared group transcript without creating a second Bot Session. */
export function BotGroupDetail({ group, bots, loading, error, onRetry, onUpdate, onSend, loadAvatar, t }: {
  group: BotGroupDetailData | undefined
  bots?: readonly BotSummary[]
  loading: boolean
  error: string | null
  onRetry: () => void
  onUpdate?: BotWorkspaceProps['onUpdateGroup']
  onSend: (text: string, messageId?: string, targetBotIds?: readonly string[]) => Promise<void>
  loadAvatar: BotWorkspaceProps['loadAvatar']
  t: BotWorkspaceViewProps['t']
}): ReactNode {
  const availableBots = bots ?? []
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [editOpen, setEditOpen] = useState(false)
  const [retryingMessageId, setRetryingMessageId] = useState<string | null>(null)
  const transcript = useMemo(() => group?.messages ?? [], [group])
  const deliveriesByMessage = useMemo(() => {
    const result = new Map<string, readonly BotGroupDeliverySummary[]>()
    for (const delivery of group?.deliveries ?? []) {
      const current = result.get(delivery.messageId)
      result.set(delivery.messageId, current === undefined ? [delivery] : [...current, delivery])
    }
    return result
  }, [group])
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLDivElement | null>(null)
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null)
  const mentionOptions = useMemo(() => {
    if (group === undefined || mentionQuery === null) return []
    const query = mentionQuery.toLocaleLowerCase()
    return group.bots.filter(bot => bot.name.toLocaleLowerCase().includes(query))
  }, [group, mentionQuery])
  useEffect(() => {
    const node = transcriptRef.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [transcript.length, transcriptRef])
  useEffect(() => {
    setDraft('')
    setMentionQuery(null)
    setMentionIndex(0)
  }, [group?.id])
  const selectMention = (bot: BotSummary): void => {
    const input = composerInputRef.current
    const cursor = input?.selectionStart ?? draft.length
    const before = draft.slice(0, cursor)
    const match = /(?:^|\s)@([^\s@]*)$/.exec(before)
    const start = match === null ? cursor : cursor - (match[1]?.length ?? 0) - 1
    const next = `${draft.slice(0, start)}@${bot.name} ${draft.slice(cursor)}`
    const nextCursor = start + bot.name.length + 2
    setDraft(next)
    setMentionQuery(null)
    setMentionIndex(0)
    requestAnimationFrame(() => {
      const nextInput = composerInputRef.current
      nextInput?.focus()
      nextInput?.setSelectionRange(nextCursor, nextCursor)
    })
  }
  const submit = async (): Promise<void> => {
    const text = draft.trim()
    if (text === '' || sending) return
    const targets = group === undefined ? [] : mentionTargets(text, group.bots)
    setSending(true)
    try {
      if (targets.length === 0) await onSend(text)
      else await onSend(text, undefined, targets)
      setDraft('')
      setMentionQuery(null)
    } catch {
      // Keep the draft visible while the owner exposes a retryable failure.
    } finally {
      setSending(false)
    }
  }
  const retryMessage = async (message: BotGroupMessageSummary): Promise<void> => {
    if (message.sender.kind !== 'user' || retryingMessageId !== null) return
    setRetryingMessageId(message.id)
    try {
      await onSend(message.text, message.id, message.targetBotIds)
    } catch {
      // The owner keeps the durable failure beside the transcript.
    } finally {
      setRetryingMessageId(null)
    }
  }
  if (group === undefined) {
    return (
      <section className={css.detailEmpty} aria-labelledby="yharness-bots-group-loading-title">
        <span className={css.emptyMark} aria-hidden="true"><IconUsersOutlineRegular size={24} /></span>
        <h2 id="yharness-bots-group-loading-title" className={css.emptyTitle}>{loading ? t('groupLoadingTitle') : t('chooseGroupTitle')}</h2>
        <p className={css.emptyDescription}>{loading ? t('groupLoadingDescription') : t('chooseGroupDescription')}</p>
        {error !== '' && error !== null && <div className={css.loadNotice} role="alert"><span>{error}</span><Button variant="ghost" size="sm" onClick={onRetry}>{t('retry')}</Button></div>}
      </section>
    )
  }
  const botsById = new Map(group.bots.map(bot => [bot.id, bot]))
  return (
    <section className={css.detail} aria-label={group.name}>
      <header className={css.detailHeader}>
        <span className={css.detailIdentity}>
          <GroupAvatarStack group={group} loadAvatar={loadAvatar} />
          <span className={css.detailIdentityCopy}>
            <span className={css.detailName}>{group.name}</span>
            <span className={css.detailRole}>{t('groupMemberNames', { count: group.bots.length })}</span>
          </span>
        </span>
        <span className={css.detailActions}>
          <Tag tone="neutral"><IconUsersOutlineRegular size={13} />{group.bots.length}</Tag>
          {onUpdate !== undefined && (
            <Tooltip label={t('editGroup')} side="bottom" portal>
              <Button variant="ghost" size="sm" aria-label={t('editGroup')} icon={<IconEditOutlineRegular size={14} />} onClick={() => { setEditOpen(true) }} />
            </Tooltip>
          )}
        </span>
      </header>
      {error !== '' && error !== null && <div className={css.groupNotice} role="alert"><span>{error}</span><Button variant="ghost" size="sm" onClick={onRetry}>{t('retry')}</Button></div>}
      <div className={css.groupThread} ref={(node) => { transcriptRef.current = node }} aria-live="polite">
        {transcript.length === 0
          ? <div className={css.threadEmpty}><p>{t('groupEmptyDescription')}</p></div>
          : transcript.map((message) => {
            const bot = message.sender.kind === 'bot' ? botsById.get(message.sender.botId) : undefined
            const deliveryStatuses = deliveriesByMessage.get(message.id) ?? []
            return (
              <article className={clsx(css.groupMessage, message.sender.kind === 'user' && css.groupMessageUser)} key={message.id}>
                {message.sender.kind === 'bot' && <BotAvatar name={message.sender.name} identity={bot?.identity} accent={bot?.accent} avatar={bot?.avatar} botId={bot?.id} loadAvatar={loadAvatar} size="small" status={bot?.status} />}
                <div className={css.groupMessageBody}>
                  <span className={css.groupMessageSender}>{message.sender.kind === 'user' ? t('you') : message.sender.name}</span>
                  <p>{message.text}</p>
                  {deliveryStatuses.length > 0 && (
                    <div className={css.groupDeliveryStatuses} aria-label={t('groupDeliveryStatus')}>
                      {deliveryStatuses.map((delivery) => {
                        const member = botsById.get(delivery.botId)
                        const name = member?.name ?? delivery.botId
                        const failed = delivery.status === 'failed'
                        return (
                          <span className={clsx(css.groupDeliveryStatus, failed && css.groupDeliveryStatusFailed)} key={`${delivery.messageId}-${delivery.botId}`}>
                            <span className={css.groupDeliveryStatusCopy}>{deliveryStatusText(delivery, name, t)}</span>
                            {failed && message.sender.kind === 'user' && (
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`${t('groupRetryDelivery')}: ${name}`}
                                disabled={retryingMessageId !== null}
                                onClick={() => { void retryMessage(message) }}
                              >
                                {retryingMessageId === message.id ? t('groupRetryingDelivery') : t('groupRetryDelivery')}
                              </Button>
                            )}
                          </span>
                        )
                      })}
                    </div>
                  )}
                </div>
              </article>
            )
          })}
      </div>
      <div
        className={css.groupComposerWrap}
        ref={composerRef}
        onBlur={(event) => {
          if (!composerRef.current?.contains(event.relatedTarget as Node | null)) setMentionQuery(null)
        }}
      >
        {mentionQuery !== null && mentionOptions.length > 0 && (
          <div className={css.mentionMenu} role="listbox" aria-label={t('mentionBots')}>
            {mentionOptions.map((bot, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === mentionIndex}
                className={clsx(css.mentionOption, index === mentionIndex && css.mentionOptionSelected)}
                key={bot.id}
                onMouseDown={(event) => { event.preventDefault() }}
                onClick={() => { selectMention(bot) }}
              >
                <BotAvatar name={bot.name} identity={bot.identity} accent={bot.accent} avatar={bot.avatar} botId={bot.id} loadAvatar={undefined} size="small" />
                <span className={css.mentionOptionCopy}>
                  <span className={css.mentionOptionName}>{bot.name}</span>
                  <span className={css.mentionOptionHint}>{t('mentionBotHint')}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        <textarea
          className={css.groupComposer}
          ref={composerInputRef}
          aria-label={t('groupMessagePlaceholder', { name: group.name })}
          placeholder={t('groupMessagePlaceholder', { name: group.name })}
          value={draft}
          disabled={sending}
          onChange={(event) => {
            const value = event.currentTarget.value
            setDraft(value)
            setMentionQuery(mentionQueryAt(value, event.currentTarget.selectionStart))
            setMentionIndex(0)
          }}
          onKeyDown={(event) => {
            if (mentionQuery !== null && mentionOptions.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault()
              setMentionIndex(current => event.key === 'ArrowDown'
                ? (current + 1) % mentionOptions.length
                : (current - 1 + mentionOptions.length) % mentionOptions.length)
              return
            }
            if (mentionQuery !== null && mentionOptions.length > 0 && (event.key === 'Enter' || event.key === 'Tab')) {
              event.preventDefault()
              const option = mentionOptions[mentionIndex]
              if (option !== undefined) selectMention(option)
              return
            }
            if (event.key === 'Escape' && mentionQuery !== null) {
              event.preventDefault()
              setMentionQuery(null)
              return
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <Button variant="primary" size="sm" aria-label={t('groupSend')} icon={<IconPaperPlaneOutlineRegular size={15} />} disabled={draft.trim() === '' || sending} onClick={() => { void submit() }} />
      </div>
      <EditGroupDialog
        open={editOpen}
        onClose={() => { setEditOpen(false) }}
        onUpdate={onUpdate}
        group={group}
        bots={availableBots}
        error={error}
        t={t}
      />
    </section>
  )
}

function NewBotDialog({ open, onClose, onCreate, error, t }: {
  open: boolean
  onClose: () => void
  onCreate: BotWorkspaceProps['onCreateBot']
  error: string | null
  t: BotWorkspaceViewProps['t']
}) {
  const [name, setName] = useState('')
  const [identity, setIdentity] = useState<BotIdentity>('agent')
  const [accent, setAccent] = useState<BotAccent>('violet')
  const [submitting, setSubmitting] = useState(false)
  const submit = async () => {
    const next = name.trim()
    if (next === '' || submitting) return
    setSubmitting(true)
    try {
      await onCreate({ name: next, identity, accent })
      setName('')
      setIdentity('agent')
      setAccent('violet')
      onClose()
    } catch {
      // The owner keeps the request and publishes its failure for this dialog.
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('newBotTitle')}
      description={t('newBotDescription')}
      closeLabel={t('cancel')}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" onClick={() => { void submit() }} disabled={name.trim() === '' || submitting}>{submitting ? t('creating') : t('create')}</Button>
        </>
      )}
    >
      {error !== null && <div className={css.dialogNotice} role="alert">{error}</div>}
      <div className={css.dialogField} aria-busy={submitting}>
        <label className={css.dialogLabel} htmlFor="yharness-bots-new-name">{t('newBotName')}</label>
        <Input
          id="yharness-bots-new-name"
          data-modal-autofocus
          value={name}
          placeholder={t('newBotNamePlaceholder')}
          onChange={(event) => { setName(event.currentTarget.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submit()
            }
          }}
        />
      </div>
      <BotAppearancePicker
        identity={identity}
        accent={accent}
        onIdentityChange={setIdentity}
        onAccentChange={setAccent}
        disabled={submitting}
        t={t}
      />
    </Modal>
  )
}

export function BotDetail({ bot, children, t, loadAvatar, onEditAvatar, loading }: {
  bot: BotSummary | undefined
  children: ReactNode
  t: BotWorkspaceViewProps['t']
  loadAvatar: BotWorkspaceViewProps['loadAvatar']
  onEditAvatar?: (() => void) | undefined
  loading: boolean
}) {
  if (bot === undefined) {
    if (loading) {
      return (
        <section className={css.detailEmpty} aria-labelledby="yharness-bots-loading-title">
          <span className={css.emptyMark} aria-hidden="true"><StateDot state="ongoing" size={16} /></span>
          <h2 id="yharness-bots-loading-title" className={css.emptyTitle}>{t('loadingTitle')}</h2>
          <p className={css.emptyDescription}>{t('loadingDescription')}</p>
        </section>
      )
    }
    return (
      <section className={css.detailEmpty} aria-labelledby="yharness-bots-empty-title">
        <span className={css.emptyMark} aria-hidden="true"><IconSidebarBotsOutlineRegular size={24} /></span>
        <h2 id="yharness-bots-empty-title" className={css.emptyTitle}>{t('chooseBotTitle')}</h2>
        <p className={css.emptyDescription}>{t('chooseBotDescription')}</p>
      </section>
    )
  }
  return (
    <section className={css.detail} aria-label={bot.name}>
      <header className={css.detailHeader}>
        <span className={css.detailIdentity}>
          <BotAvatar name={bot.name} identity={bot.identity} accent={bot.accent} avatar={bot.avatar} botId={bot.id} loadAvatar={loadAvatar} status={bot.status} size="large" />
          <span className={css.detailIdentityCopy}>
            <span className={css.detailName}>{bot.name}</span>
            {bot.description !== undefined && bot.description !== '' && <span className={css.detailRole}>{bot.description}</span>}
          </span>
        </span>
        <span className={css.detailActions}>
          {onEditAvatar !== undefined && (
            <Tooltip label={t('editAvatar')} side="bottom" portal>
              <Button variant="ghost" size="sm" aria-label={t('editAvatar')} icon={<IconEditOutlineRegular size={14} />} onClick={onEditAvatar} />
            </Tooltip>
          )}
          {bot.status !== undefined && (
            <Tag tone={statusTone(bot.status)}>
              <StateDot state={statusState(bot.status)} size={8} />
              {statusLabel(bot.status, t)}
            </Tag>
          )}
        </span>
      </header>
      {bot.status === 'working' && (bot.preview !== undefined || bot.activity !== undefined) && (
        <div className={css.activityBanner} role="status">
          <StateDot state="ongoing" size={14} />
          <span>{bot.preview ?? bot.activity}</span>
        </div>
      )}
      <div className={css.thread}>
        {children ?? <div className={css.threadEmpty} role="status"><p>{t(bot.status === 'preparing' ? 'preparingBot' : 'conversationUnavailable')}</p></div>}
      </div>
    </section>
  )
}

/**
 * Render only the bot roster for the shared application sidebar.
 *
 * Search, creation, and avatar actions remain local to this surface. The
 * selected bot's conversation is rendered by the main panel.
 * @param props - bot rows, selection callbacks, optional sidebar geometry, and locale.
 * @returns the sidebar roster and its dialogs.
 */
export function BotRoster({
  bots, selectedBotId, onSelectBot, onCreateBot, onConnectApps, onOpenAvatarSettings,
  groups: sharedGroups = [], selectedGroupId = null, onSelectGroup, onCreateGroup, groupError = null,
  onRetry, loadAvatar, avatarEditor, error = null, loading = false, wide = true, expandSidebar, t,
}: BotWorkspaceViewProps & BotRosterLayoutProps): ReactNode {
  const [query, setQuery] = useState('')
  const [newBotOpen, setNewBotOpen] = useState(false)
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  const [avatarEditorOpen, setAvatarEditorOpen] = useState(false)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredBots = useMemo(() => {
    if (normalizedQuery === '') return bots
    return bots.filter(bot => [bot.name, bot.description, bot.group, bot.preview, bot.activity]
      .some(value => value?.toLocaleLowerCase().includes(normalizedQuery)))
  }, [bots, normalizedQuery])
  const groups = useMemo(() => groupBots(filteredBots, t('defaultGroup')), [filteredBots, t])
  const filteredSharedGroups = useMemo(() => {
    if (normalizedQuery === '') return sharedGroups
    return sharedGroups.filter(group => [group.name, ...group.bots.map(bot => bot.name)]
      .some(value => value.toLocaleLowerCase().includes(normalizedQuery)))
  }, [sharedGroups, normalizedQuery])
  const selectedBot = bots.find(bot => bot.id === selectedBotId)
  const hasRows = bots.length > 0
  const openNewBot = (): void => {
    if (!wide) expandSidebar?.()
    setNewBotOpen(true)
  }
  const openAvatarEditor = (): void => {
    if (!wide) expandSidebar?.()
    setAvatarEditorOpen(true)
  }
  const openNewGroup = (): void => {
    if (!wide) expandSidebar?.()
    setNewGroupOpen(true)
  }

  return (
    <aside className={css.roster} aria-label={t('title')}>
      {wide
        ? (
          <>
            <header className={css.rosterHeader}>
              <div className={css.brandRow}>
                <span className={css.brandCopy}>
                  <span className={css.brandTitle}>{t('panel')}</span>
                </span>
                {selectedBot !== undefined && avatarEditor !== undefined && (
                  <Tooltip label={t('editAvatar')} side="bottom" portal>
                    <Button variant="ghost" size="sm" aria-label={t('editAvatar')} icon={<IconEditOutlineRegular size={15} />} onClick={openAvatarEditor} />
                  </Tooltip>
                )}
                <Button variant="ghost" size="sm" aria-label={t('newBot')} icon={<IconSidebarBotAddOutlineRegular size={16} />} onClick={openNewBot} />
              </div>
              <Input
                className={css.search ?? ''}
                icon={<IconSidebarSearchOutlineRegular size={16} />}
                placeholder={t('searchPlaceholder')}
                aria-label={t('searchLabel')}
                value={query}
                onChange={(event) => { setQuery(event.currentTarget.value) }}
              />
            </header>
            <div className={css.rosterScroll}>
              {error !== null && <div className={css.loadNotice} role="alert"><span>{error || t('loadError')}</span>{onRetry !== undefined && <Button variant="ghost" size="sm" onClick={onRetry}>{t('retry')}</Button>}</div>}
              {loading && (
                <div className={css.skeletonList} role="status" aria-label={t('loading')}>
                  {[0, 1, 2].map(index => <span key={index} className={css.skeletonRow} />)}
                </div>
              )}
              {!loading && groups.length > 0 && groups.map(([group, rows]) => (
                <section className={css.group} key={group} aria-labelledby={`yharness-bots-group-${group}`}>
                  <h2 id={`yharness-bots-group-${group}`} className={css.groupLabel}>{group}</h2>
                  <div className={css.groupRows}>
                    {rows.map(bot => (
                      <BotRow
                        key={bot.id}
                        bot={bot}
                        selected={bot.id === selectedBotId}
                        onSelect={() => { onSelectBot(bot.id) }}
                        t={t}
                        loadAvatar={loadAvatar}
                      />
                    ))}
                  </div>
                </section>
              ))}
              {onCreateGroup !== undefined && (
                <section className={css.group} aria-labelledby="yharness-bots-shared-groups">
                  <div className={css.groupHeadingRow}>
                    <h2 id="yharness-bots-shared-groups" className={css.groupLabel}>{t('sharedGroups')}</h2>
                    <Tooltip label={t('newGroup')} side="bottom" portal>
                      <Button variant="ghost" size="sm" aria-label={t('newGroup')} icon={<IconPlusOutlineRegular size={14} />} onClick={openNewGroup} />
                    </Tooltip>
                  </div>
                  {selectedGroupId === null && groupError !== null && (
                    <div className={css.groupNotice} role="alert">
                      <span>{groupError || t('groupLoadError')}</span>
                      {onRetry !== undefined && <Button variant="ghost" size="sm" onClick={onRetry}>{t('retry')}</Button>}
                    </div>
                  )}
                  {!loading && filteredSharedGroups.length > 0 && (
                    <div className={css.groupRows}>
                      {filteredSharedGroups.map(group => (
                        <GroupRow
                          key={group.id} group={group} selected={group.id === selectedGroupId}
                          onSelect={() => { onSelectGroup?.(group.id) }} loadAvatar={loadAvatar} t={t}
                        />
                      ))}
                    </div>
                  )}
                  {!loading && sharedGroups.length > 0 && filteredSharedGroups.length === 0 && <div className={css.groupNoResults}>{t('noSearchResults')}</div>}
                </section>
              )}
              {!loading && hasRows && groups.length === 0 && <div className={css.rosterEmpty}><strong>{t('noSearchResults')}</strong><span>{t('noSearchResultsDescription')}</span></div>}
              {!loading && !hasRows && error === null && (
                <div className={css.rosterEmpty}><span className={css.emptyMarkSmall} aria-hidden="true"><IconSidebarBotsOutlineRegular size={20} /></span><strong>{t('noBotsTitle')}</strong><span>{t('noBotsDescription')}</span><Button variant="outline" size="sm" onClick={openNewBot} icon={<IconSidebarBotAddOutlineRegular size={14} />}>{t('newBot')}</Button></div>
              )}
            </div>
            {onConnectApps !== undefined && <div className={css.rosterFooter}><Button variant="outline" className={css.connectButton} icon={<IconLinkOutlineRegular size={15} />} onClick={onConnectApps}>{t('connectApps')}</Button></div>}
          </>
        )
        : (
          <div className={css.botRail} aria-label={t('title')}>
            <Tooltip label={t('newBot')} side="right" delayMs={500}>
              <Button
                variant="ghost"
                size="sm"
                className={css.botRailAction}
                aria-label={t('newBot')}
                icon={<IconSidebarBotAddOutlineRegular size={18} />}
                onClick={openNewBot}
              />
            </Tooltip>
            {bots.map((bot) => {
              const status = bot.status
              const label = status === undefined ? bot.name : `${bot.name}, ${statusLabel(status, t)}`
              return (
                <Tooltip key={bot.id} label={label} side="right" delayMs={500}>
                  <button
                    type="button"
                    className={clsx(css.botRailRow, bot.id === selectedBotId && css.botRailRowSelected)}
                    data-bot-id={bot.id}
                    aria-current={bot.id === selectedBotId ? 'page' : undefined}
                    aria-label={label}
                    onClick={() => { onSelectBot(bot.id) }}
                  >
                    <BotAvatar
                      name={bot.name} identity={bot.identity} accent={bot.accent} avatar={bot.avatar}
                      botId={bot.id} loadAvatar={loadAvatar}
                    />
                  </button>
                </Tooltip>
              )
            })}
            {onCreateGroup !== undefined && (
              <>
                <Tooltip label={t('newGroup')} side="right" delayMs={500}>
                  <Button variant="ghost" size="sm" className={css.botRailAction} aria-label={t('newGroup')} icon={<IconPlusOutlineRegular size={18} />} onClick={openNewGroup} />
                </Tooltip>
                {sharedGroups.map(group => (
                  <Tooltip key={group.id} label={group.name} side="right" delayMs={500}>
                    <button type="button" className={clsx(css.botRailRow, group.id === selectedGroupId && css.botRailRowSelected)} aria-current={group.id === selectedGroupId ? 'page' : undefined} aria-label={group.name} onClick={() => { onSelectGroup?.(group.id) }}>
                      <GroupAvatarStack group={group} loadAvatar={loadAvatar} />
                    </button>
                  </Tooltip>
                ))}
              </>
            )}
          </div>
        )}
      <NewBotDialog open={newBotOpen} onClose={() => { setNewBotOpen(false) }} onCreate={onCreateBot} error={error} t={t} />
      <NewGroupDialog
        open={newGroupOpen} onClose={() => { setNewGroupOpen(false) }} onCreate={onCreateGroup}
        bots={bots} error={groupError} t={t}
      />
      {selectedBot !== undefined && avatarEditor !== undefined && (
        <BotAvatarEditor
          bot={selectedBot}
          actions={avatarEditor}
          loadAvatar={loadAvatar}
          open={avatarEditorOpen}
          onClose={() => { setAvatarEditorOpen(false) }}
          onOpenSettings={onOpenAvatarSettings}
          t={t}
        />
      )}
    </aside>
  )
}
