import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconAgentPresetOutlineRegular, IconEditOutlineRegular, IconLinkOutlineRegular,
  IconPlusOutlineRegular, IconSearchOutlineRegular, Input, Modal, StateDot, Tag, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { BotAvatar } from './BotAvatar.tsx'
import { BotAvatarEditor } from './BotAvatarEditor.tsx'
import css from './BotWorkspace.module.css'
import type { BotAccent, BotIdentity, BotStatus, BotSummary, BotWorkspaceProps } from './types.ts'

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

type IdentityLabelKey = 'identity.agent' | 'identity.sparkle' | 'identity.goal' | 'identity.browse' | 'identity.skill' | 'identity.workspace'
type AccentLabelKey = 'accent.blue' | 'accent.teal' | 'accent.amber' | 'accent.violet' | 'accent.rose' | 'accent.lime'

const identityLabels: Readonly<Record<BotIdentity, IdentityLabelKey>> = {
  agent: 'identity.agent',
  sparkle: 'identity.sparkle',
  goal: 'identity.goal',
  browse: 'identity.browse',
  skill: 'identity.skill',
  workspace: 'identity.workspace',
}

function identityLabelKey(identity: BotIdentity): IdentityLabelKey {
  return identityLabels[identity]
}

const accentLabels: Readonly<Record<BotAccent, AccentLabelKey>> = {
  blue: 'accent.blue',
  teal: 'accent.teal',
  amber: 'accent.amber',
  violet: 'accent.violet',
  rose: 'accent.rose',
  lime: 'accent.lime',
}

function accentLabelKey(accent: BotAccent): AccentLabelKey {
  return accentLabels[accent]
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
      <BotAvatar name={bot.name} identity={bot.identity} accent={bot.accent} avatar={bot.avatar} botId={bot.id} loadAvatar={loadAvatar} />
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
const identityChoices: readonly [BotIdentity, BotAccent][] = [
  ['agent', 'violet'],
  ['sparkle', 'blue'],
  ['goal', 'amber'],
  ['browse', 'teal'],
  ['skill', 'rose'],
  ['workspace', 'lime'],
]

const accentChoices: readonly BotAccent[] = ['blue', 'teal', 'amber', 'violet', 'rose', 'lime']

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
        <label className={css.dialogLabel} htmlFor="dsh-bots-new-name">{t('newBotName')}</label>
        <Input
          id="dsh-bots-new-name"
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
      <div className={css.dialogField}>
        <span className={css.dialogLabel}>{t('identityLabel')}</span>
        <div className={css.identityChoices} role="radiogroup" aria-label={t('identityLabel')}>
          {identityChoices.map(([choice, choiceAccent]) => (
            <button
              key={choice}
              type="button"
              className={clsx(css.identityChoice, identity === choice && css.identityChoiceSelected)}
              data-accent={choiceAccent}
              role="radio"
              aria-checked={identity === choice}
              aria-label={t(identityLabelKey(choice))}
              onClick={() => { setIdentity(choice); setAccent(choiceAccent) }}
            >
              <BotAvatar name={t(identityLabelKey(choice))} identity={choice} accent={choiceAccent} />
            </button>
          ))}
        </div>
      </div>
      <div className={css.dialogField}>
        <span className={css.dialogLabel}>{t('accentLabel')}</span>
        <div className={css.accentChoices} role="radiogroup" aria-label={t('accentLabel')}>
          {accentChoices.map(choice => (
            <button
              key={choice}
              type="button"
              className={clsx(css.accentChoice, accent === choice && css.accentChoiceSelected)}
              role="radio"
              aria-checked={accent === choice}
              aria-label={t(accentLabelKey(choice))}
              onClick={() => { setAccent(choice) }}
            >
              <span className={css.accentSwatch} data-accent={choice} aria-hidden="true" />
              <span>{t(accentLabelKey(choice))}</span>
            </button>
          ))}
        </div>
      </div>
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
        <section className={css.detailEmpty} aria-labelledby="dsh-bots-loading-title">
          <span className={css.emptyMark} aria-hidden="true"><StateDot state="ongoing" size={16} /></span>
          <h2 id="dsh-bots-loading-title" className={css.emptyTitle}>{t('loadingTitle')}</h2>
          <p className={css.emptyDescription}>{t('loadingDescription')}</p>
        </section>
      )
    }
    return (
      <section className={css.detailEmpty} aria-labelledby="dsh-bots-empty-title">
        <span className={css.emptyMark} aria-hidden="true"><IconAgentPresetOutlineRegular size={24} /></span>
        <h2 id="dsh-bots-empty-title" className={css.emptyTitle}>{t('chooseBotTitle')}</h2>
        <p className={css.emptyDescription}>{t('chooseBotDescription')}</p>
      </section>
    )
  }
  return (
    <section className={css.detail} aria-label={bot.name}>
      <header className={css.detailHeader}>
        <span className={css.detailIdentity}>
          <BotAvatar name={bot.name} identity={bot.identity} accent={bot.accent} avatar={bot.avatar} botId={bot.id} loadAvatar={loadAvatar} size="large" />
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
  onRetry, loadAvatar, avatarEditor, error = null, loading = false, wide = true, expandSidebar, t,
}: BotWorkspaceViewProps & BotRosterLayoutProps): ReactNode {
  const [query, setQuery] = useState('')
  const [newBotOpen, setNewBotOpen] = useState(false)
  const [avatarEditorOpen, setAvatarEditorOpen] = useState(false)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredBots = useMemo(() => {
    if (normalizedQuery === '') return bots
    return bots.filter(bot => [bot.name, bot.description, bot.group, bot.preview, bot.activity]
      .some(value => value?.toLocaleLowerCase().includes(normalizedQuery)))
  }, [bots, normalizedQuery])
  const groups = useMemo(() => groupBots(filteredBots, t('defaultGroup')), [filteredBots, t])
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
                <Button variant="ghost" size="sm" aria-label={t('newBot')} icon={<IconPlusOutlineRegular size={16} />} onClick={openNewBot} />
              </div>
              <Input
                className={css.search ?? ''}
                icon={<IconSearchOutlineRegular size={16} />}
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
                <section className={css.group} key={group} aria-labelledby={`dsh-bots-group-${group}`}>
                  <h2 id={`dsh-bots-group-${group}`} className={css.groupLabel}>{group}</h2>
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
              {!loading && hasRows && groups.length === 0 && <div className={css.rosterEmpty}><strong>{t('noSearchResults')}</strong><span>{t('noSearchResultsDescription')}</span></div>}
              {!loading && !hasRows && error === null && (
                <div className={css.rosterEmpty}><span className={css.emptyMarkSmall} aria-hidden="true"><IconAgentPresetOutlineRegular size={20} /></span><strong>{t('noBotsTitle')}</strong><span>{t('noBotsDescription')}</span><Button variant="outline" size="sm" onClick={openNewBot} icon={<IconPlusOutlineRegular size={14} />}>{t('newBot')}</Button></div>
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
                icon={<IconPlusOutlineRegular size={18} />}
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
    </aside>
  )
}
