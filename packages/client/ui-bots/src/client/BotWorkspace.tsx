import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconArchiveOffOutlineRegular, IconEditOutlineRegular, IconEllipsisOutlineRegular,
  IconFolderOpenOutlineRegular, IconLinkOutlineRegular, IconShareOutlineRegular,
  IconPinFillRegular, IconPinOutlineRegular,
  IconSidebarBotAddOutlineRegular, IconSidebarBotsOutlineRegular, IconSidebarSearchOutlineRegular,
  IconUnarchiveOutlineRegular, Input, Menu, Modal, StateDot, Tag, Tooltip,
} from '@yharness/client-ui-primitives'
import type { PropsLocale } from '@yharness/client-ui-slots'
import { BotAvatar } from './BotAvatar.tsx'
import { BotAvatarEditor } from './BotAvatarEditor.tsx'
import { BotAppearancePicker } from './BotAppearancePicker.tsx'
import { BotShareDialog, SharedBotsDialog } from './BotSharing.tsx'
import css from './BotWorkspace.module.css'
import type { BotShareActions } from './controller.ts'
import type { SharedBotsClient } from './shared-client.ts'
import type { BotAccent, BotIdentity, BotOrganizationPatch, BotStatus, BotSummary, BotWorkspaceProps } from './types.ts'

type BotWorkspaceViewProps = BotWorkspaceProps & PropsLocale<'bots'> & {
  children?: ReactNode
  share?: BotShareActions
  sharedClient?: SharedBotsClient
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

export function BotDetail({ bot, children, t, loadAvatar, onEditAvatar, onRename, share, loading }: {
  bot: BotSummary | undefined
  children: ReactNode
  t: BotWorkspaceViewProps['t']
  loadAvatar: BotWorkspaceViewProps['loadAvatar']
  onEditAvatar?: (() => void) | undefined
  onRename?: ((id: string, name: string) => Promise<void>) | undefined
  share?: BotShareActions | undefined
  loading: boolean
}) {
  const [renameTarget, setRenameTarget] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [renameError, setRenameError] = useState(false)
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
          {onRename !== undefined && (
            <Tooltip label={t('renameBot')} side="bottom" portal>
              <Button variant="ghost" size="sm" aria-label={t('renameBot')} icon={<IconEditOutlineRegular size={14} />}
                onClick={() => { setName(bot.name); setRenameError(false); setRenameTarget(bot.id) }} />
            </Tooltip>
          )}
          {share !== undefined && <BotShareButton bot={bot} actions={share} t={t} />}
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
  onOrganizeBot, onRetry, loadAvatar, avatarEditor, sharedClient, error = null, loading = false, wide = true, expandSidebar, t,
}: BotWorkspaceViewProps & BotRosterLayoutProps): ReactNode {
  const [query, setQuery] = useState('')
  const [newBotOpen, setNewBotOpen] = useState(false)
  const [avatarEditorOpen, setAvatarEditorOpen] = useState(false)
  const [sectionBot, setSectionBot] = useState<BotSummary | undefined>()
  const [sharedBotsOpen, setSharedBotsOpen] = useState(false)
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
                {sharedClient !== undefined && (
                  <Tooltip label={t('joinBot')} side="bottom" portal>
                    <Button variant="ghost" size="sm" aria-label={t('joinBot')} icon={<IconShareOutlineRegular size={16} />} onClick={() => { setSharedBotsOpen(true) }} />
                  </Tooltip>
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
              {!loading && hasRows && groups.length === 0 && hiddenBots.length === 0 && <div className={css.rosterEmpty}><strong>{t('noSearchResults')}</strong><span>{t('noSearchResultsDescription')}</span></div>}
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
          </div>
        )}
      <NewBotDialog open={newBotOpen} onClose={() => { setNewBotOpen(false) }} onCreate={onCreateBot} error={error} t={t} />
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
        <SharedBotsDialog client={sharedClient} open={sharedBotsOpen} onClose={() => { setSharedBotsOpen(false) }} t={t} />
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
