import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconArchiveOffOutlineRegular, IconCheckOutlineRegular, IconEditOutlineRegular, IconEllipsisOutlineRegular,
  IconFolderOpenOutlineRegular, IconLinkOutlineRegular, IconPaperPlaneOutlineRegular, IconPlusOutlineRegular,
  IconPinFillRegular, IconPinOutlineRegular, IconShareOutlineRegular, IconContextInjectionOutlineRegular, IconClockOutlineRegular,
  IconSidebarBotAddOutlineRegular, IconSidebarBotsOutlineRegular, IconSidebarSearchOutlineRegular,
  IconUnarchiveOutlineRegular, IconUsersOutlineRegular, Input, Menu, MenuSurface, Modal, StateDot, Tag, Tooltip, connectedAppGlyph,
} from '@yharness/client-ui-primitives'
import type { PropsLocale } from '@yharness/client-ui-slots'
import { randomUUID } from '@yharness/util-crypto'
import { BotAvatar } from './BotAvatar.tsx'
import { BotAvatarEditor } from './BotAvatarEditor.tsx'
import { BotAppearancePicker } from './BotAppearancePicker.tsx'
import { BotShareDialog, SharedBotsDialog } from './BotSharing.tsx'
import type { BotShareActions } from './controller.ts'
import type { SharedBotsClient } from './shared-client.ts'
import { BotTemplatesPanel } from './BotTemplatesPanel.tsx'
import {
  BotGroupAttachments,
  BotGroupSentAttachments,
  createBotGroupAttachmentDraft,
  releaseBotGroupAttachment,
} from './BotGroupAttachments.tsx'
import { BotMemoryManager } from './BotMemoryManager.tsx'
import { BotRoutineManager } from './BotRoutineManager.tsx'
import css from './BotWorkspace.module.css'
import type {
  BotAccent, BotConnectedAppAccess, BotGroupAttachmentDraft, BotGroupCreation, BotGroupDeliverySummary,
  BotGroupDetailData, BotGroupMessageSummary, BotGroupSummary,
  BotIdentity, BotMemoryManagerActions, BotOrganizationPatch, BotProfileUpdate, BotRoutineManagerActions,
  BotStatus, BotSummary, BotWorkspaceProps,
} from './types.ts'

type BotWorkspaceViewProps = BotWorkspaceProps & PropsLocale<'bots'> & {
  children?: ReactNode
  share?: BotShareActions
  sharedClient?: SharedBotsClient
}

const MAX_SHARED_OWNER_CAPABILITY_FOCUS_RETRIES = 3

function connectedAppName(app: BotConnectedAppAccess, t: BotWorkspaceViewProps['t']): string {
  const name = app.name.trim()
  return name !== '' && name !== '-' ? name : t('connectedAppFallbackName', { id: app.id })
}

function connectedAppMonogram(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean)
  if (words.length > 1) return words.slice(0, 2).map(word => word.slice(0, 1)).join('').toLocaleUpperCase()
  return name.trim().slice(0, 2).toLocaleUpperCase()
}

function connectedAppMark(app: BotConnectedAppAccess, name: string): ReactNode {
  return connectedAppGlyph({ appId: app.id, size: 16 }) ?? connectedAppMonogram(name)
}

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

function orderedBots(bots: readonly BotSummary[]): readonly BotSummary[] {
  return [...bots].sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true))
}

function sectionItemId(index: number): string {
  return `section:existing:${String(index)}`
}

function statusLabel(status: BotStatus, t: BotWorkspaceViewProps['t']): string {
  return t(statusKey(status))
}

function BotActionsMenu({ bot, groups, onOrganize, onSetSection, t }: {
  bot: BotSummary
  groups: readonly string[]
  onOrganize: (id: string, patch: BotOrganizationPatch) => Promise<void>
  onSetSection: () => void
  t: BotWorkspaceViewProps['t']
}) {
  const [open, setOpen] = useState(false)
  const organize = (patch: BotOrganizationPatch): void => {
    setOpen(false)
    void onOrganize(bot.id, patch).catch(() => {})
  }
  const sectionChoices = groups.map((group, index) => ({ id: sectionItemId(index), group }))
  const sectionItems = sectionChoices.map(({ id, group }) => ({
    id,
    label: group,
    icon: <IconFolderOpenOutlineRegular size={14} />,
  }))
  const items = [
    {
      id: 'pin',
      label: bot.pinned === true ? t('unpinBot') : t('pinBot'),
      icon: bot.pinned === true ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} />,
    },
    {
      id: bot.hidden === true ? 'restore' : 'hide',
      label: bot.hidden === true ? t('restoreBot') : t('hideBot'),
      icon: bot.hidden === true ? <IconUnarchiveOutlineRegular size={14} /> : <IconArchiveOffOutlineRegular size={14} />,
    },
    { type: 'separator' as const, id: 'section-separator' },
    { id: 'section:none', label: t('noSection'), icon: <IconFolderOpenOutlineRegular size={14} /> },
    ...sectionItems,
    { id: 'section:custom', label: t('setSection'), icon: <IconFolderOpenOutlineRegular size={14} /> },
  ]
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={items}
      selectedId={bot.group === undefined ? 'section:none' : sectionChoices.find(choice => choice.group === bot.group)?.id}
      onSelect={(id) => {
        if (id === 'pin') organize({ pinned: bot.pinned !== true })
        else if (id === 'hide') organize({ hidden: true })
        else if (id === 'restore') organize({ hidden: false })
        else if (id === 'section:none') organize({ group: null })
        else if (id === 'section:custom') { setOpen(false); onSetSection() }
        else {
          const section = sectionChoices.find(choice => choice.id === id)
          if (section !== undefined) organize({ group: section.group })
        }
      }}
      align="end"
      dense
      portal
      anchor={(
        <Tooltip label={t('botActions', { name: bot.name })} side="bottom" portal>
          <button
            type="button"
            className={css.botActionButton}
            aria-label={t('botActions', { name: bot.name })}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={(event) => { event.stopPropagation(); setOpen(value => !value) }}
          >
            <IconEllipsisOutlineRegular size={15} />
          </button>
        </Tooltip>
      )}
    />
  )
}

function BotRow({ bot, selected, onSelect, t, loadAvatar, groups, onOrganize, onSetSection }: {
  bot: BotSummary
  selected: boolean
  onSelect: () => void
  t: BotWorkspaceViewProps['t']
  loadAvatar: BotWorkspaceViewProps['loadAvatar']
  groups: readonly string[]
  onOrganize?: BotWorkspaceProps['onOrganizeBot']
  onSetSection: () => void
}) {
  const unread = bot.unread !== undefined && bot.unread > 0
  const unreadCount = bot.unread ?? 0
  const summary = bot.preview ?? bot.description
  const status = bot.status
  return (
    <div className={clsx(css.botRow, selected && css.botRowSelected)}>
      <button
        type="button"
        className={css.botRowMain}
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
            {bot.pinned === true && <span className={css.pinIndicator} role="img" aria-label={t('pinnedBot')}><IconPinFillRegular size={12} /></span>}
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
      {onOrganize !== undefined && <BotActionsMenu bot={bot} groups={groups} onOrganize={onOrganize} onSetSection={onSetSection} t={t} />}
    </div>
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
      title={t('newBotGroupTitle')}
      description={t('newBotGroupDescription')}
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

/** Render a persistent workspace group transcript without creating a second Bot Session. */
export function BotGroupDetail({ group, bots, loading, error, onRetry, onUpdate, onSend, onSendWithAttachments, loadAvatar, t }: {
  group: BotGroupDetailData | undefined
  bots?: readonly BotSummary[]
  loading: boolean
  error: string | null
  onRetry: () => void
  onUpdate?: BotWorkspaceProps['onUpdateGroup']
  onSend: (text: string, messageId?: string, targetBotIds?: readonly string[]) => Promise<void>
  onSendWithAttachments?: (
    text: string,
    attachments: readonly BotGroupAttachmentDraft[],
    messageId?: string,
    targetBotIds?: readonly string[],
  ) => Promise<void>
  loadAvatar: BotWorkspaceProps['loadAvatar']
  t: BotWorkspaceViewProps['t']
}): ReactNode {
  const availableBots = bots ?? []
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<readonly BotGroupAttachmentDraft[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
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
  const attachmentsRef = useRef<readonly BotGroupAttachmentDraft[]>([])
  const attachmentMessageIdRef = useRef<string | null>(null)
  const attachmentDraftTextRef = useRef<string | null>(null)
  attachmentsRef.current = attachments
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
    for (const attachment of attachmentsRef.current) releaseBotGroupAttachment(attachment)
    attachmentsRef.current = []
    attachmentMessageIdRef.current = null
    attachmentDraftTextRef.current = null
    setAttachments([])
    setAttachmentError(null)
    setDraft('')
    setMentionQuery(null)
    setMentionIndex(0)
  }, [group?.id])
  useEffect(() => () => {
    for (const attachment of attachmentsRef.current) releaseBotGroupAttachment(attachment)
  }, [])
  const clearAttachments = (): void => {
    for (const attachment of attachmentsRef.current) releaseBotGroupAttachment(attachment)
    attachmentsRef.current = []
    attachmentMessageIdRef.current = null
    attachmentDraftTextRef.current = null
    setAttachments([])
  }
  const addAttachments = (files: readonly File[]): void => {
    setAttachmentError(null)
    attachmentMessageIdRef.current = null
    attachmentDraftTextRef.current = null
    setAttachments(current => [...current, ...files.map(createBotGroupAttachmentDraft)])
  }
  const removeAttachment = (id: string): void => {
    const removed = attachmentsRef.current.find(attachment => attachment.id === id)
    if (removed !== undefined) releaseBotGroupAttachment(removed)
    setAttachmentError(null)
    attachmentMessageIdRef.current = null
    attachmentDraftTextRef.current = null
    setAttachments(current => current.filter(attachment => attachment.id !== id))
  }
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
    if ((text === '' && attachments.length === 0) || sending) return
    const targets = group === undefined ? [] : mentionTargets(text, group.bots)
    setSending(true)
    setAttachmentError(null)
    try {
      if (attachments.length > 0) {
        if (onSendWithAttachments === undefined) throw new Error(t('groupAttachmentsUnavailable'))
        const messageId = attachmentMessageIdRef.current ?? `bot-group-message-${randomUUID()}`
        attachmentMessageIdRef.current = messageId
        attachmentDraftTextRef.current = text
        if (targets.length === 0) await onSendWithAttachments(text, attachments, messageId)
        else await onSendWithAttachments(text, attachments, messageId, targets)
        clearAttachments()
      } else if (targets.length === 0) await onSend(text)
      else await onSend(text, undefined, targets)
      setDraft('')
      setMentionQuery(null)
    } catch (cause: unknown) {
      if (attachments.length > 0) setAttachmentError(cause instanceof Error ? cause.message : t('groupDeliveryFailure'))
      // Keep the draft and attachments visible so the owner can retry safely.
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
                  <BotGroupSentAttachments attachments={message.attachments} fallbackName={t('groupAttachmentFile')} />
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
        <BotGroupAttachments
          attachments={attachments}
          disabled={sending}
          labels={{
            picker: t('groupAttachFiles'),
            input: t('groupChooseFiles'),
            attachments: t('groupAttachments'),
            file: t('groupAttachmentFile'),
            preview: name => t('groupPreviewAttachment', { name }),
            remove: name => t('groupRemoveAttachment', { name }),
            retry: name => t('groupRetryAttachment', { name }),
            failed: t('groupAttachmentFailed'),
            uploading: t('groupAttachmentPreparing'),
            lightbox: { dialog: t('groupAttachmentPreview'), close: t('groupAttachmentClosePreview') },
          }}
          onAddFiles={addAttachments}
          onRemove={removeAttachment}
        />
        {attachmentError !== null && (
          <div className={css.groupAttachmentNotice} role="alert">
            <span>{attachmentError}</span>
            {onSendWithAttachments !== undefined && (
              <Button variant="ghost" size="sm" disabled={sending} onClick={() => { void submit() }}>{t('retry')}</Button>
            )}
          </div>
        )}
        {mentionQuery !== null && mentionOptions.length > 0 && (
          <MenuSurface className={css.mentionMenu} role="listbox" aria-label={t('mentionBots')}>
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
                <BotAvatar name={bot.name} identity={bot.identity} accent={bot.accent} avatar={bot.avatar} botId={bot.id} loadAvatar={loadAvatar} size="small" />
                <span className={css.mentionOptionCopy}>
                  <span className={css.mentionOptionName}>{bot.name}</span>
                  <span className={css.mentionOptionHint}>{t('mentionBotHint')}</span>
                </span>
              </button>
            ))}
          </MenuSurface>
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
            if (attachmentMessageIdRef.current !== null && attachmentDraftTextRef.current !== null
              && value.trim() !== attachmentDraftTextRef.current) {
              attachmentMessageIdRef.current = null
              attachmentDraftTextRef.current = null
            }
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
        <Button variant="primary" size="sm" aria-label={t('groupSend')} icon={<IconPaperPlaneOutlineRegular size={15} />} disabled={(draft.trim() === '' && attachments.length === 0) || sending} onClick={() => { void submit() }} />
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

function profileCapabilityList(value: string): readonly string[] {
  return [...new Set(value.split(/[,\n]/u).map(item => item.trim()).filter(Boolean))]
}

function profileCapabilityText(values: readonly string[] | undefined): string {
  return values?.join(', ') ?? ''
}

function BotProfileFields({
  description, persona, capabilities, onDescriptionChange, onPersonaChange, onCapabilitiesChange, disabled, t,
}: {
  description: string
  persona: string
  capabilities: string
  onDescriptionChange: (value: string) => void
  onPersonaChange: (value: string) => void
  onCapabilitiesChange: (value: string) => void
  disabled: boolean
  t: BotWorkspaceViewProps['t']
}): ReactNode {
  return (
    <>
      <div className={css.dialogField}>
        <label className={css.dialogLabel} htmlFor="yharness-bot-profile-description">{t('botDescription')}</label>
        <textarea
          id="yharness-bot-profile-description"
          className={css.profileTextarea}
          value={description}
          maxLength={240}
          placeholder={t('botDescriptionPlaceholder')}
          onChange={(event) => { onDescriptionChange(event.currentTarget.value) }}
          disabled={disabled}
        />
        <span className={css.dialogHelper}>{t('botDescriptionHelp')}</span>
      </div>
      <div className={css.dialogField}>
        <label className={css.dialogLabel} htmlFor="yharness-bot-profile-persona">{t('botPersona')}</label>
        <textarea
          id="yharness-bot-profile-persona"
          className={css.profileTextarea}
          value={persona}
          maxLength={4000}
          placeholder={t('botPersonaPlaceholder')}
          onChange={(event) => { onPersonaChange(event.currentTarget.value) }}
          disabled={disabled}
        />
        <span className={css.dialogHelper}>{t('botPersonaHelp')}</span>
      </div>
      <div className={css.dialogField}>
        <label className={css.dialogLabel} htmlFor="yharness-bot-profile-capabilities">{t('botCapabilities')}</label>
        <Input
          id="yharness-bot-profile-capabilities"
          value={capabilities}
          placeholder={t('botCapabilitiesPlaceholder')}
          onChange={(event) => { onCapabilitiesChange(event.currentTarget.value) }}
          disabled={disabled}
        />
        <span className={css.dialogHelper}>{t('botCapabilitiesHelp')}</span>
      </div>
    </>
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
  const [description, setDescription] = useState('')
  const [persona, setPersona] = useState('')
  const [capabilities, setCapabilities] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submit = async () => {
    const next = name.trim()
    if (next === '' || submitting) return
    setSubmitting(true)
    try {
      const descriptionValue = description.trim()
      const personaValue = persona.trim()
      const capabilityValues = profileCapabilityList(capabilities)
      await onCreate({
        name: next, identity, accent,
        ...(descriptionValue === '' ? {} : { description: descriptionValue }),
        ...(personaValue === '' ? {} : { persona: personaValue }),
        ...(capabilityValues.length === 0 ? {} : { capabilities: capabilityValues }),
      })
      setName('')
      setIdentity('agent')
      setAccent('violet')
      setDescription('')
      setPersona('')
      setCapabilities('')
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
      <BotProfileFields
        description={description}
        persona={persona}
        capabilities={capabilities}
        onDescriptionChange={setDescription}
        onPersonaChange={setPersona}
        onCapabilitiesChange={setCapabilities}
        disabled={submitting}
        t={t}
      />
    </Modal>
  )
}

export function BotDetail({
  bot, children, t, loadAvatar, onEditAvatar, onRename, onUpdateProfile, share, memoryManager, routineManager, routineRevision = 0, loading,
}: {
  bot: BotSummary | undefined
  children: ReactNode
  t: BotWorkspaceViewProps['t']
  loadAvatar: BotWorkspaceViewProps['loadAvatar']
  onEditAvatar?: (() => void) | undefined
  onRename?: ((id: string, name: string) => Promise<void>) | undefined
  onUpdateProfile?: ((id: string, profile: BotProfileUpdate) => Promise<void>) | undefined
  share?: BotShareActions | undefined
  memoryManager?: BotMemoryManagerActions | undefined
  routineManager?: BotRoutineManagerActions | undefined
  routineRevision?: number
  loading: boolean
}) {
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [renameError, setRenameError] = useState(false)
  const [profileTarget, setProfileTarget] = useState<string | null>(null)
  const [profileName, setProfileName] = useState('')
  const [profileDescription, setProfileDescription] = useState('')
  const [profilePersona, setProfilePersona] = useState('')
  const [profileCapabilities, setProfileCapabilities] = useState('')
  const [profileError, setProfileError] = useState<'conflict' | 'failed' | null>(null)
  const [profileRevision, setProfileRevision] = useState<number | undefined>()
  const [profileSaving, setProfileSaving] = useState(false)
  const profileOperationGeneration = useRef(0)
  const profileBotIdRef = useRef<string | undefined>(bot?.id)
  profileBotIdRef.current = bot?.id
  const isCurrentProfileOperation = (target: string, generation: number): boolean => (
    profileBotIdRef.current === target && profileOperationGeneration.current === generation
  )
  const [memoryOpen, setMemoryOpen] = useState(false)
  useEffect(() => {
    if (profileTarget !== null && profileTarget !== bot?.id) {
      profileOperationGeneration.current += 1
      setProfileTarget(null)
      setProfileRevision(undefined)
      setProfileError(null)
      setProfileSaving(false)
    }
  }, [bot?.id, profileTarget])
  const [routineOpen, setRoutineOpen] = useState(false)
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
          {onUpdateProfile !== undefined && (
            <Tooltip label={t('editBotProfile')} side="bottom" portal>
              <Button variant="ghost" size="sm" aria-label={t('editBotProfile')} icon={<IconEditOutlineRegular size={14} />}
                onClick={() => {
                  profileOperationGeneration.current += 1
                  setProfileName(bot.name)
                  setProfileDescription(bot.description ?? '')
                  setProfilePersona(bot.persona ?? '')
                  setProfileCapabilities(profileCapabilityText(bot.capabilities))
                  setProfileError(null)
                  setProfileRevision(bot.updatedAt)
                  setProfileTarget(bot.id)
                }} />
            </Tooltip>
          )}
          {onUpdateProfile === undefined && onRename !== undefined && (
            <Tooltip label={t('renameBot')} side="bottom" portal>
              <Button variant="ghost" size="sm" aria-label={t('renameBot')} icon={<IconEditOutlineRegular size={14} />}
                onClick={() => { setName(bot.name); setRenameError(false); setRenameTarget(bot.id) }} />
            </Tooltip>
          )}
          {share !== undefined && <BotShareButton bot={bot} actions={share} t={t} />}
          {memoryManager !== undefined && (
            <Tooltip label={t('manageMemories')} side="bottom" portal>
              <Button variant="ghost" size="sm" aria-label={t('manageMemories')} icon={<IconContextInjectionOutlineRegular size={14} />} onClick={() => { setMemoryOpen(true) }} />
            </Tooltip>
          )}
          {routineManager !== undefined && (
            <Tooltip label={t('manageRoutines')} side="bottom" portal>
              <Button variant="ghost" size="sm" aria-label={t('manageRoutines')} icon={<IconClockOutlineRegular size={14} />} onClick={() => { setRoutineOpen(true) }} />
            </Tooltip>
          )}
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
      {onUpdateProfile !== undefined && <Modal
        open={profileTarget !== null}
        onClose={() => { if (!profileSaving) { setProfileTarget(null); setProfileRevision(undefined) } }}
        title={t('editBotProfile')}
        description={t('editBotProfileDescription')}
        closeLabel={t('cancel')}
        footer={(
          <>
            <Button variant="ghost" onClick={() => { setProfileTarget(null); setProfileRevision(undefined) }} disabled={profileSaving}>{t('cancel')}</Button>
            <Button
              variant="primary"
              disabled={profileSaving || profileName.trim() === ''}
              onClick={() => {
                if (profileTarget === null || profileTarget !== bot.id) return
                const target = profileTarget
                const operationGeneration = ++profileOperationGeneration.current
                setProfileSaving(true)
                setProfileError(null)
                const profile: BotProfileUpdate = {
                  ...(profileRevision === undefined ? {} : { expectedUpdatedAt: profileRevision }),
                  name: profileName.trim(),
                  description: profileDescription.trim(),
                  persona: profilePersona.trim(),
                  capabilities: profileCapabilityList(profileCapabilities),
                }
                void onUpdateProfile(target, profile).then(() => {
                  if (!isCurrentProfileOperation(target, operationGeneration)) return
                  setProfileTarget(null)
                  setProfileRevision(undefined)
                }, (cause: unknown) => {
                  if (!isCurrentProfileOperation(target, operationGeneration)) return
                  setProfileError(cause instanceof Error && cause.name === 'BotProfileConflictError' ? 'conflict' : 'failed')
                })
                  .finally(() => {
                    if (isCurrentProfileOperation(target, operationGeneration)) setProfileSaving(false)
                  })
              }}
            >{t(profileSaving ? 'savingProfile' : 'saveProfile')}</Button>
          </>
        )}
      >
        {profileError !== null && <div className={css.dialogNotice} role="alert">{t(profileError === 'conflict' ? 'profileConflict' : 'profileSaveFailed')}</div>}
        <div className={css.dialogField} aria-busy={profileSaving}>
          <label className={css.dialogLabel} htmlFor="yharness-bot-profile-name">{t('newBotName')}</label>
          <Input
            id="yharness-bot-profile-name"
            data-modal-autofocus
            value={profileName}
            disabled={profileSaving}
            onChange={(event) => { setProfileName(event.currentTarget.value) }}
          />
        </div>
        <BotProfileFields
          description={profileDescription}
          persona={profilePersona}
          capabilities={profileCapabilities}
          onDescriptionChange={setProfileDescription}
          onPersonaChange={setProfilePersona}
          onCapabilitiesChange={setProfileCapabilities}
          disabled={profileSaving}
          t={t}
        />
      </Modal>}
      {onRename !== undefined && <Modal open={renameTarget !== null} onClose={() => { if (!saving) setRenameTarget(null) }}
        title={t('renameBot')} description={t('renameDescription')} closeLabel={t('cancel')}
        footer={<><Button variant="ghost" onClick={() => { setRenameTarget(null) }} disabled={saving}>{t('cancel')}</Button>
          <Button variant="primary" disabled={saving || name.trim() === ''} onClick={() => {
            if (renameTarget === null) return
            setSaving(true)
            setRenameError(false)
            void onRename(renameTarget, name.trim()).then(() => { setRenameTarget(null) }, () => { setRenameError(true) })
              .finally(() => { setSaving(false) })
          }}>{t(saving ? 'savingName' : 'saveName')}</Button></>}>
        {renameError && <div className={css.dialogNotice} role="alert">{t('renameFailed')}</div>}
        <div className={css.dialogField}><label className={css.dialogLabel} htmlFor="yharness-bot-rename">{t('newBotName')}</label>
          <Input id="yharness-bot-rename" data-modal-autofocus value={name} disabled={saving}
            onChange={(event) => { setName(event.currentTarget.value) }} /></div>
      </Modal>}
      {memoryManager !== undefined && (
        <BotMemoryManager
          key={`memory-${bot.id}`}
          bot={bot}
          actions={memoryManager}
          loadAvatar={loadAvatar}
          open={memoryOpen}
          onClose={() => { setMemoryOpen(false) }}
          t={t}
        />
      )}
      {routineManager !== undefined && (
        <BotRoutineManager
          key={`routine-${bot.id}`}
          bot={bot}
          actions={routineManager}
          revision={routineRevision}
          loadAvatar={loadAvatar}
          open={routineOpen}
          onClose={() => { setRoutineOpen(false) }}
          t={t}
        />
      )}
    </section>
  )
}

function BotSectionDialog({ bot, onClose, onOrganize, t }: {
  bot: BotSummary | undefined
  onClose: () => void
  onOrganize: (id: string, patch: BotOrganizationPatch) => Promise<void>
  t: BotWorkspaceViewProps['t']
}) {
  const [name, setName] = useState(bot?.group ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setName(bot?.group ?? '')
    setError(null)
  }, [bot])
  if (bot === undefined) return null
  const submit = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const section = name.trim()
      await onOrganize(bot.id, { group: section === '' ? null : section })
      onClose()
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t('organizationSaveFailed'))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('sectionDialogTitle')}
      description={t('sectionDialogDescription')}
      closeLabel={t('cancel')}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" onClick={() => { void submit() }} disabled={saving}>{saving ? t('saving') : t('save')}</Button>
        </>
      )}
    >
      {error !== null && <div className={css.dialogNotice} role="alert">{error}</div>}
      <div className={css.dialogField} aria-busy={saving}>
        <label className={css.dialogLabel} htmlFor="yharness-bots-section-name">{t('sectionName')}</label>
        <Input
          id="yharness-bots-section-name"
          data-modal-autofocus
          value={name}
          placeholder={t('sectionNamePlaceholder')}
          onChange={(event) => { setName(event.currentTarget.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submit()
            }
          }}
        />
      </div>
    </Modal>
  )
}

function ConnectedAppsDialog({ bot, open, onClose, onLoad, onSet, t }: {
  bot: BotSummary | undefined
  open: boolean
  onClose: () => void
  onLoad: (botId: string) => Promise<readonly BotConnectedAppAccess[]>
  onSet: (botId: string, appId: string, allowed: boolean) => Promise<void>
  t: BotWorkspaceViewProps['t']
}) {
  type ConnectedAppCatalog = {
    readonly botId: string
    readonly requestId: number
    readonly apps: readonly BotConnectedAppAccess[]
    readonly error: string | null
  }
  type ConnectedAppSave = {
    readonly botId: string
    readonly requestId: number
    readonly appId: string
  }
  const [catalog, setCatalog] = useState<ConnectedAppCatalog | undefined>()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState<ConnectedAppSave | null>(null)
  const requestSequence = useRef(0)
  const botId = bot?.id
  useEffect(() => {
    if (!open || botId === undefined) {
      setCatalog(undefined)
      setLoading(false)
      setSaving(null)
      return
    }
    const requestId = requestSequence.current + 1
    requestSequence.current = requestId
    let active = true
    setCatalog({ botId, requestId, apps: [], error: null })
    setLoading(true)
    setSaving(null)
    void onLoad(botId).then((next) => {
      if (active) setCatalog({ botId, requestId, apps: next, error: null })
    }).catch((cause: unknown) => {
      if (active) setCatalog({
        botId,
        requestId,
        apps: [],
        error: cause instanceof Error ? cause.message : t('connectedAppsLoadFailed'),
      })
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [botId, open])
  if (bot === undefined) return null
  const currentCatalog = catalog?.botId === bot.id ? catalog : undefined
  const apps = currentCatalog?.apps ?? []
  const error = currentCatalog?.error ?? null
  const loadingCurrentCatalog = loading || (open && currentCatalog === undefined)
  const savingAppId = saving?.botId === bot.id ? saving.appId : null
  const toggle = async (app: BotConnectedAppAccess): Promise<void> => {
    if (savingAppId !== null || currentCatalog === undefined) return
    const allowed = !app.allowed
    const request = { botId: bot.id, requestId: currentCatalog.requestId, appId: app.id }
    setSaving(request)
    setCatalog(current => current?.botId === request.botId && current.requestId === request.requestId
      ? { ...current, error: null }
      : current)
    try {
      await onSet(request.botId, request.appId, allowed)
      setCatalog(current => current?.botId === request.botId && current.requestId === request.requestId
        ? {
          ...current,
          apps: current.apps.map(candidate => candidate.id === request.appId ? { ...candidate, allowed } : candidate),
        }
        : current)
    } catch (cause: unknown) {
      setCatalog(current => current?.botId === request.botId && current.requestId === request.requestId
        ? { ...current, error: cause instanceof Error ? cause.message : t('connectedAppsSaveFailed') }
        : current)
    } finally {
      setSaving(current => current?.botId === request.botId && current.requestId === request.requestId && current.appId === request.appId
        ? null
        : current)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('connectedAppsTitle')}
      description={t('connectedAppsDescription', { name: bot.name })}
      closeLabel={t('cancel')}
      footer={<Button variant="ghost" onClick={onClose} disabled={savingAppId !== null}>{t('done')}</Button>}
    >
      {error !== null && <div className={css.dialogNotice} role="alert">{error}</div>}
      {loadingCurrentCatalog && <div className={css.connectedAppsLoading} role="status">{t('connectedAppsLoading')}</div>}
      {!loadingCurrentCatalog && error === null && apps.length === 0 && <div className={css.connectedAppsEmpty}>{t('connectedAppsEmpty')}</div>}
      {!loadingCurrentCatalog && apps.length > 0 && (
        <div className={css.connectedAppsList} role="list" aria-label={t('connectedAppsTitle')}>
          {apps.map((app) => {
            const name = connectedAppName(app, t)
            return (
              <div className={css.connectedAppRow} key={app.id} role="listitem">
                <span className={css.connectedAppIcon} data-app-id={app.id} aria-hidden="true">{connectedAppMark(app, name)}</span>
                <span className={css.connectedAppCopy}>
                  <strong>{name}</strong>
                  <span>{app.description ?? t('connectedAppDescription', { name })}</span>
                  <span className={app.allowed ? css.connectedAppAllowed : css.connectedAppBlocked}>
                    {app.allowed ? t('connectedAppAllowed') : t('connectedAppBlocked')}
                  </span>
                </span>
                <Button
                  variant={app.allowed ? 'ghost' : 'outline'}
                  size="sm"
                  disabled={savingAppId !== null}
                  aria-pressed={app.allowed}
                  aria-label={t(app.allowed ? 'revokeConnectedApp' : 'grantConnectedApp', { name })}
                  icon={app.allowed ? <IconCheckOutlineRegular size={14} /> : undefined}
                  onClick={() => { void toggle(app) }}
                >
                  {app.allowed ? t('allowed') : t('grant')}
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </Modal>
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
  groups: localGroups = [], selectedGroupId = null, onSelectGroup, onCreateGroup, groupError = null,
  onLoadConnectedApps, onSetConnectedAppAccess,
  onOrganizeBot, templates, templateActions, onRetry, loadAvatar, avatarEditor, sharedClient,
  error = null, loading = false, wide = true, expandSidebar, t,
}: BotWorkspaceViewProps & BotRosterLayoutProps): ReactNode {
  const [query, setQuery] = useState('')
  const [newBotOpen, setNewBotOpen] = useState(false)
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [avatarEditorOpen, setAvatarEditorOpen] = useState(false)
  const [sectionBot, setSectionBot] = useState<BotSummary | undefined>()
  const [sharedBotsOpen, setSharedBotsOpen] = useState(false)
  const [sharedOwnerMode, setSharedOwnerMode] = useState(false)
  const [sharedOwnerCapability, setSharedOwnerCapability] = useState<'unknown' | 'available' | 'unavailable'>('unknown')
  const [connectedAppsOpen, setConnectedAppsOpen] = useState(false)
  const ownerCapabilityProbe = sharedClient?.getOwnerCapability
  const ownerEnrollment = sharedClient?.enrollOwner
  const ownerCapabilitySubscription = sharedClient?.subscribeOwnerCapability
  useEffect(() => {
    let active = true
    let retryOnFocus = true
    let focusRetryCount = 0
    let probeGeneration = 0
    if (sharedClient === undefined || ownerCapabilityProbe === undefined || ownerEnrollment === undefined) {
      setSharedOwnerCapability('unknown')
      return () => { active = false }
    }
    setSharedOwnerCapability('unknown')
    const probe = (): void => {
      const requestGeneration = probeGeneration
      void Promise.resolve().then(ownerCapabilityProbe).then((capability) => {
        if (!active || requestGeneration !== probeGeneration) return
        retryOnFocus = !capability.ownerBootstrap
        setSharedOwnerCapability(capability.ownerBootstrap ? 'available' : 'unavailable')
      }).catch(() => {
        if (!active || requestGeneration !== probeGeneration) return
        retryOnFocus = true
        setSharedOwnerCapability('unavailable')
      })
    }
    const onCapabilityInvalidated = (): void => {
      if (!active) return
      probeGeneration += 1
      retryOnFocus = true
      focusRetryCount = 0
      setSharedOwnerCapability('unknown')
      probe()
    }
    const onFocus = (): void => {
      if (!active || !retryOnFocus || focusRetryCount >= MAX_SHARED_OWNER_CAPABILITY_FOCUS_RETRIES) return
      focusRetryCount += 1
      probe()
    }
    const stopCapabilitySubscription = ownerCapabilitySubscription?.(onCapabilityInvalidated)
    probe()
    window.addEventListener('focus', onFocus)
    return () => {
      active = false
      stopCapabilitySubscription?.()
      window.removeEventListener('focus', onFocus)
    }
  }, [ownerCapabilityProbe, ownerCapabilitySubscription, ownerEnrollment, sharedClient])
  const sharedOwnerAvailable = ownerEnrollment !== undefined && ownerCapabilityProbe !== undefined && sharedOwnerCapability === 'available'
  const sharedOwnerUnsupported = ownerEnrollment !== undefined && ownerCapabilityProbe !== undefined && sharedOwnerCapability === 'unavailable'
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredBots = useMemo(() => {
    if (normalizedQuery === '') return bots
    return bots.filter(bot => [bot.name, bot.description, bot.group, bot.preview, bot.activity]
      .some(value => value?.toLocaleLowerCase().includes(normalizedQuery)))
  }, [bots, normalizedQuery])

  const visibleBots = useMemo(() => orderedBots(filteredBots.filter(bot => bot.hidden !== true)), [filteredBots])
  const hiddenBots = useMemo(() => orderedBots(filteredBots.filter(bot => bot.hidden === true)), [filteredBots])
  const groups = useMemo(() => {
    const pinned = visibleBots.filter(bot => bot.pinned === true)
    const unpinned = visibleBots.filter(bot => bot.pinned !== true)
    return [
      ...(pinned.length === 0 ? [] : [[t('pinnedGroup'), pinned] as const]),
      ...groupBots(unpinned, t('defaultGroup')),
    ]
  }, [t, visibleBots])
  const sectionNames = useMemo(() => [...new Set(bots.map(bot => bot.group?.trim()).filter((group): group is string => group !== undefined && group !== ''))], [bots])

  const filteredLocalGroups = useMemo(() => {
    if (normalizedQuery === '') return localGroups
    return localGroups.filter(group => [group.name, ...group.bots.map(bot => bot.name)]
      .some(value => value.toLocaleLowerCase().includes(normalizedQuery)))
  }, [localGroups, normalizedQuery])

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
  const openSharedBots = (): void => {
    if (!wide) expandSidebar?.()
    setSharedOwnerMode(false)
    setSharedBotsOpen(true)
  }
  const openSharedOwner = (): void => {
    if (!wide) expandSidebar?.()
    setSharedOwnerMode(true)
    setSharedBotsOpen(true)
  }
  const closeSharedBots = (): void => {
    setSharedOwnerMode(false)
    setSharedBotsOpen(false)
  }
  const openConnectedApps = (): void => {
    if (selectedBot === undefined || onLoadConnectedApps === undefined || onSetConnectedAppAccess === undefined) {
      onConnectApps?.()
      return
    }
    if (!wide) expandSidebar?.()
    setConnectedAppsOpen(true)
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
                {templates !== undefined && templateActions !== undefined && (
                  <Tooltip label={t('templates')} side="bottom" portal>
                    <Button variant="ghost" size="sm" aria-label={t('templates')} icon={<IconShareOutlineRegular size={15} />} onClick={() => { setTemplatesOpen(true) }} />
                  </Tooltip>
                )}
                <Button variant="ghost" size="sm" aria-label={t('newBot')} icon={<IconSidebarBotAddOutlineRegular size={16} />} onClick={openNewBot} />
                {sharedClient !== undefined && (
                  <>
                    <Tooltip label={t('joinBot')} side="bottom" portal>
                      <Button variant="ghost" size="sm" aria-label={t('joinBot')} icon={<IconShareOutlineRegular size={16} />} onClick={openSharedBots} />
                    </Tooltip>
                    {sharedOwnerAvailable && (
                      <Tooltip label={t('createSharedGroup')} side="bottom" portal>
                        <Button variant="ghost" size="sm" aria-label={t('createSharedGroup')} icon={<IconUsersOutlineRegular size={16} />} onClick={openSharedOwner} />
                      </Tooltip>
                    )}
                    {sharedOwnerUnsupported && (
                      <Tooltip label={t('sharedOwnerSetupUnavailable')} side="bottom" portal>
                        <span>
                          <Button variant="ghost" size="sm" aria-label={t('createSharedGroup')} title={t('sharedOwnerSetupUnavailable')} icon={<IconUsersOutlineRegular size={16} />} disabled />
                        </span>
                      </Tooltip>
                    )}
                  </>
                )}
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
              {!loading && groups.length > 0 && groups.map(([group, rows], index) => {
                const headingId = `yharness-bots-group-${String(index)}`
                return (
                  <section className={css.group} key={`group-${String(index)}`} aria-labelledby={headingId}>
                    <h2 id={headingId} className={css.groupLabel}>{group}</h2>
                    <div className={css.groupRows}>
                      {rows.map(bot => (
                        <BotRow
                          key={bot.id}
                          bot={bot}
                          selected={bot.id === selectedBotId}
                          onSelect={() => { onSelectBot(bot.id) }}
                          t={t}
                          loadAvatar={loadAvatar}
                          groups={sectionNames}
                          onOrganize={onOrganizeBot}
                          onSetSection={() => { setSectionBot(bot) }}
                        />
                      ))}
                    </div>
                  </section>
                )
              })}
              {!loading && hiddenBots.length > 0 && (
                <section className={css.group} aria-labelledby="yharness-bots-hidden-group">
                  <h2 id="yharness-bots-hidden-group" className={css.groupLabel}>{t('hiddenGroup')}</h2>
                  <div className={css.groupRows}>
                    {hiddenBots.map(bot => (
                      <BotRow
                        key={bot.id}
                        bot={bot}
                        selected={bot.id === selectedBotId}
                        onSelect={() => { onSelectBot(bot.id) }}
                        t={t}
                        loadAvatar={loadAvatar}
                        groups={sectionNames}
                        onOrganize={onOrganizeBot}
                        onSetSection={() => { setSectionBot(bot) }}
                      />
                    ))}
                  </div>
                </section>

              )}
              {onCreateGroup !== undefined && (
                <section className={css.group} aria-labelledby="yharness-bots-local-groups">
                  <div className={css.groupHeadingRow}>
                    <h2 id="yharness-bots-local-groups" className={css.groupLabel}>{t('botGroups')}</h2>
                    <Tooltip label={t('newBotGroup')} side="bottom" portal>
                      <Button variant="ghost" size="sm" aria-label={t('newBotGroup')} icon={<IconPlusOutlineRegular size={14} />} onClick={openNewGroup} />
                    </Tooltip>
                  </div>
                  {selectedGroupId === null && groupError !== null && (
                    <div className={css.groupNotice} role="alert">
                      <span>{groupError || t('groupLoadError')}</span>
                      {onRetry !== undefined && <Button variant="ghost" size="sm" onClick={onRetry}>{t('retry')}</Button>}
                    </div>
                  )}
                  {!loading && filteredLocalGroups.length > 0 && (
                    <div className={css.groupRows}>
                      {filteredLocalGroups.map(group => (
                        <GroupRow
                          key={group.id} group={group} selected={group.id === selectedGroupId}
                          onSelect={() => { onSelectGroup?.(group.id) }} loadAvatar={loadAvatar} t={t}
                        />
                      ))}
                    </div>
                  )}
                  {!loading && localGroups.length > 0 && filteredLocalGroups.length === 0 && <div className={css.groupNoResults}>{t('noSearchResults')}</div>}
                </section>
              )}
              {!loading && hasRows && groups.length === 0 && hiddenBots.length === 0 && <div className={css.rosterEmpty}><strong>{t('noSearchResults')}</strong><span>{t('noSearchResultsDescription')}</span></div>}

              {!loading && !hasRows && error === null && (
                <div className={css.rosterEmpty}><span className={css.emptyMarkSmall} aria-hidden="true"><IconSidebarBotsOutlineRegular size={20} /></span><strong>{t('noBotsTitle')}</strong><span>{t('noBotsDescription')}</span><Button variant="outline" size="sm" onClick={openNewBot} icon={<IconSidebarBotAddOutlineRegular size={14} />}>{t('newBot')}</Button></div>
              )}
            </div>
            {(onConnectApps !== undefined || (onLoadConnectedApps !== undefined && onSetConnectedAppAccess !== undefined && selectedBot !== undefined)) && <div className={css.rosterFooter}><Button variant="outline" className={css.connectButton} icon={<IconLinkOutlineRegular size={15} />} onClick={openConnectedApps}>{t('connectApps')}</Button></div>}
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
            {sharedClient !== undefined && (
              <>
                <Tooltip label={t('joinBot')} side="right" delayMs={500}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={css.botRailAction}
                    aria-label={t('joinBot')}
                    icon={<IconShareOutlineRegular size={18} />}
                    onClick={openSharedBots}
                  />
                </Tooltip>
                {sharedOwnerAvailable && (
                  <Tooltip label={t('createSharedGroup')} side="right" delayMs={500}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={css.botRailAction}
                      aria-label={t('createSharedGroup')}
                      icon={<IconUsersOutlineRegular size={18} />}
                      onClick={openSharedOwner}
                    />
                  </Tooltip>
                )}
                {sharedOwnerUnsupported && (
                  <Tooltip label={t('sharedOwnerSetupUnavailable')} side="right" delayMs={500}>
                    <span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={css.botRailAction}
                        aria-label={t('createSharedGroup')}
                        title={t('sharedOwnerSetupUnavailable')}
                        icon={<IconUsersOutlineRegular size={18} />}
                        disabled
                      />
                    </span>
                  </Tooltip>
                )}
              </>
            )}
            {templates !== undefined && templateActions !== undefined && (
              <Tooltip label={t('templates')} side="right" delayMs={500}>
                <Button variant="ghost" size="sm" className={css.botRailAction} aria-label={t('templates')} icon={<IconShareOutlineRegular size={17} />} onClick={() => { setTemplatesOpen(true) }} />
              </Tooltip>
            )}
            {visibleBots.map((bot) => {
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
                <Tooltip label={t('newBotGroup')} side="right" delayMs={500}>
                  <Button variant="ghost" size="sm" className={css.botRailAction} aria-label={t('newBotGroup')} icon={<IconPlusOutlineRegular size={18} />} onClick={openNewGroup} />
                </Tooltip>
                {localGroups.map(group => (
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
      {onOrganizeBot !== undefined && (
        <BotSectionDialog
          bot={sectionBot}
          onClose={() => { setSectionBot(undefined) }}
          onOrganize={onOrganizeBot}
          t={t}
        />
      )}
      {sharedClient !== undefined && (
        <SharedBotsDialog client={sharedClient} open={sharedBotsOpen} ownerMode={sharedOwnerMode} onClose={closeSharedBots} t={t} />
      )}
      {onLoadConnectedApps !== undefined && onSetConnectedAppAccess !== undefined && (
        <ConnectedAppsDialog
          bot={selectedBot}
          open={connectedAppsOpen}
          onClose={() => { setConnectedAppsOpen(false) }}
          onLoad={onLoadConnectedApps}
          onSet={onSetConnectedAppAccess}
          t={t}
        />
      )}
      {templates !== undefined && templateActions !== undefined && (
        <BotTemplatesPanel
          bots={bots}
          state={templates}
          actions={templateActions}
          t={t}
          open={templatesOpen}
          onClose={() => { setTemplatesOpen(false) }}
        />
      )}
    </aside>
  )
}

function BotShareButton({ bot, actions, t }: {
  readonly bot: BotSummary
  readonly actions: BotShareActions
  readonly t: BotWorkspaceViewProps['t']
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Tooltip label={t('shareBot')} side="bottom" portal>
        <Button variant="ghost" size="sm" aria-label={t('shareBot')} icon={<IconShareOutlineRegular size={15} />} onClick={() => { setOpen(true) }} />
      </Tooltip>
      <BotShareDialog bot={bot} actions={actions} open={open} onClose={() => { setOpen(false) }} t={t} />
    </>
  )
}
