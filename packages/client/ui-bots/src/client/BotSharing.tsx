import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { brandString } from '@yharness/brand'
import type { PropsLocale } from '@yharness/client-ui-slots'
import {
  Button,
  IconCopyOutlineRegular,
  IconLinkOutlineRegular,
  IconShieldOutlineRegular,
  IconShareOutlineRegular,
  IconTrashOutlineRegular,
  Input,
  Modal,
  RiskConfirmation,
  SegmentedControl,
  StateDot,
  Switch,
  Tag,
  Tooltip,
  writeClipboard,
} from '@yharness/client-ui-primitives'
import type {
  BotId as BotIdType,
  BotGroupCreateRequest,
  BotGroupMessageId as BotGroupMessageIdType,
  BotGroupMessageView,
  BotGroupView,
  BotGroupId as BotGroupIdType,
  BotShareInviteValue,
  BotShareMember,
  BotShareMemoryValue,
  BotShareMemoryPolicyValue,
  BotShareRole,
  BotShareRosterEntry,
  BotShareTranscriptEntry,
} from '@yharness/bots/client'
import { BotAvatar } from './BotAvatar.tsx'
import css from './BotWorkspace.module.css'
import type { BotShareActions } from './controller.ts'
import {
  createSharedGroupPendingQueue,
} from './pending-group-queue.ts'
import type {
  SharedGroupPendingQueue,
  SharedPendingGroupMessage,
  SharedPendingGroupCreation,
} from './pending-group-queue.ts'
import type { BotSummary } from './types.ts'
import type { SharedBotGroupInviteValue, SharedBotsClient } from './shared-client.ts'

type Translate = PropsLocale<'bots'>['t']

function sharedGroupCreationKey(name: string, botIds: readonly string[]): string {
  return `${name}\u0000${[...botIds].sort().join('\u0000')}`
}

function sharedGroupMessageKey(groupId: string, text: string): string {
  return `${groupId}\u0000${text}`
}

function shareRoleLabel(role: BotShareRole, t: Translate): string {
  switch (role) {
    case 'owner': return t('shareRoleOwner')
    case 'manager': return t('shareRoleManager')
    case 'collaborator': return t('shareRoleCollaborator')
    default: return t('sharedRole', { role })
  }
}

function updatePendingBotIds(current: ReadonlySet<string>, botId: string, pending: boolean): ReadonlySet<string> {
  if (pending) {
    if (current.has(botId)) return current
    const next = new Set(current)
    next.add(botId)
    return next
  }
  if (!current.has(botId)) return current
  const next = new Set(current)
  next.delete(botId)
  return next
}

/** Owner-facing invite and membership controls for one Bot. */
export function BotShareDialog({ bot, actions, open, onClose, t }: {
  readonly bot: BotSummary
  readonly actions: BotShareActions
  readonly open: boolean
  readonly onClose: () => void
  readonly t: Translate
}) {
  const [members, setMembers] = useState<readonly BotShareMember[]>([])
  const [role, setRole] = useState<BotShareRole>('collaborator')
  const [invite, setInvite] = useState<BotShareInviteValue | null>(null)
  const [working, setWorking] = useState<'load' | 'invite' | 'revoke' | null>(null)
  const [memoryPolicy, setMemoryPolicy] = useState<BotShareMemoryPolicyValue | null>(null)
  const [memoryTarget, setMemoryTarget] = useState<boolean | null>(null)
  const [memoryAcknowledged, setMemoryAcknowledged] = useState(false)
  const [memoryWorking, setMemoryWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [stateBotId, setStateBotId] = useState<string | null>(open ? bot.id : null)
  const botIdRef = useRef(bot.id)
  botIdRef.current = bot.id
  const openRef = useRef(open)
  openRef.current = open
  const viewGenerationRef = useRef(0)
  const loadGenerationRef = useRef(0)
  const workingGenerationRef = useRef(0)
  const memoryOperationGenerationRef = useRef(0)
  const inviteGenerationRef = useRef(0)
  const stateMatchesBot = open && stateBotId === bot.id

  const isCurrentView = (botId: string, generation: number): boolean => (
    openRef.current && botIdRef.current === botId && viewGenerationRef.current === generation
  )
  const isCurrentWorking = (botId: string, viewGeneration: number, workingGeneration: number): boolean => (
    isCurrentView(botId, viewGeneration) && workingGenerationRef.current === workingGeneration
  )
  const isCurrentMemoryOperation = (botId: string, viewGeneration: number, operationGeneration: number): boolean => (
    isCurrentView(botId, viewGeneration) && memoryOperationGenerationRef.current === operationGeneration
  )

  const load = async (requestedBotId: string, viewGeneration: number): Promise<void> => {
    if (!isCurrentView(requestedBotId, viewGeneration)) return
    const loadGeneration = loadGenerationRef.current + 1
    loadGenerationRef.current = loadGeneration
    const isCurrentLoad = (): boolean => (
      isCurrentView(requestedBotId, viewGeneration) && loadGenerationRef.current === loadGeneration
    )
    setWorking('load')
    setError(null)
    try {
      const value = await actions.listMembers(requestedBotId)
      if (!isCurrentLoad()) return
      setMembers(value.members)
      if (actions.getMemoryPolicy !== undefined) {
        const policy = await actions.getMemoryPolicy(requestedBotId)
        if (!isCurrentLoad()) return
        setMemoryPolicy(policy)
      }
    } catch (cause: unknown) {
      if (isCurrentLoad()) setError(cause instanceof Error ? cause.message : t('shareError'))
    } finally {
      if (isCurrentLoad()) setWorking(current => current === 'load' ? null : current)
    }
  }

  useEffect(() => {
    const viewGeneration = viewGenerationRef.current + 1
    viewGenerationRef.current = viewGeneration
    loadGenerationRef.current += 1
    workingGenerationRef.current += 1
    memoryOperationGenerationRef.current += 1
    inviteGenerationRef.current += 1
    if (!open) {
      setStateBotId(null)
      setWorking(null)
      setMemoryWorking(false)
      setMemoryTarget(null)
      setMemoryAcknowledged(false)
      return
    }
    setStateBotId(bot.id)
    setMembers([])
    setRole('collaborator')
    setInvite(null)
    setCopied(false)
    setMemoryPolicy(null)
    setMemoryTarget(null)
    setMemoryAcknowledged(false)
    setError(null)
    void load(bot.id, viewGeneration)
  }, [bot.id, open])

  const createInvite = async (): Promise<void> => {
    if (!stateMatchesBot || working !== null || memoryWorking) return
    const requestedBotId = bot.id
    const viewGeneration = viewGenerationRef.current
    const workingGeneration = workingGenerationRef.current + 1
    workingGenerationRef.current = workingGeneration
    inviteGenerationRef.current += 1
    setWorking('invite')
    setError(null)
    setCopied(false)
    try {
      const created = await actions.createInvite(requestedBotId, role)
      if (!isCurrentWorking(requestedBotId, viewGeneration, workingGeneration)) return
      inviteGenerationRef.current += 1
      setInvite(created)
      await load(requestedBotId, viewGeneration)
    } catch (cause: unknown) {
      if (isCurrentWorking(requestedBotId, viewGeneration, workingGeneration)) {
        setError(cause instanceof Error ? cause.message : t('shareError'))
      }
    } finally {
      if (isCurrentWorking(requestedBotId, viewGeneration, workingGeneration)) {
        setWorking(current => current === 'invite' ? null : current)
      }
    }
  }

  const revoke = async (member: BotShareMember): Promise<void> => {
    if (member.role === 'owner' || working !== null || memoryWorking) return
    const requestedBotId = bot.id
    const viewGeneration = viewGenerationRef.current
    const workingGeneration = workingGenerationRef.current + 1
    workingGenerationRef.current = workingGeneration
    setWorking('revoke')
    setError(null)
    try {
      await actions.revokeMember(requestedBotId, String(member.principalId))
      if (!isCurrentWorking(requestedBotId, viewGeneration, workingGeneration)) return
      setMembers(current => current.filter(candidate => candidate.principalId !== member.principalId))
    } catch (cause: unknown) {
      if (isCurrentWorking(requestedBotId, viewGeneration, workingGeneration)) {
        setError(cause instanceof Error ? cause.message : t('shareError'))
      }
    } finally {
      if (isCurrentWorking(requestedBotId, viewGeneration, workingGeneration)) {
        setWorking(current => current === 'revoke' ? null : current)
      }
    }
  }

  const confirmMemoryPolicy = async (): Promise<void> => {
    if (!openRef.current || !stateMatchesBot || memoryTarget === null || actions.setMemoryPolicy === undefined || memoryWorking) return
    const requestedBotId = bot.id
    const viewGeneration = viewGenerationRef.current
    const operationGeneration = memoryOperationGenerationRef.current + 1
    memoryOperationGenerationRef.current = operationGeneration
    const target = memoryTarget
    setMemoryWorking(true)
    setError(null)
    try {
      const policy = await actions.setMemoryPolicy(requestedBotId, target)
      if (!isCurrentMemoryOperation(requestedBotId, viewGeneration, operationGeneration)) return
      setMemoryPolicy(policy)
      setMemoryTarget(null)
      setMemoryAcknowledged(false)
    } catch (cause: unknown) {
      if (isCurrentMemoryOperation(requestedBotId, viewGeneration, operationGeneration)) {
        setError(cause instanceof Error ? cause.message : t('shareError'))
      }
    } finally {
      if (isCurrentMemoryOperation(requestedBotId, viewGeneration, operationGeneration)) setMemoryWorking(false)
    }
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={t('shareBotTitle')}
        description={t('shareBotDescription')}
        closeLabel={t('cancel')}
        className={css.shareDialog as string}
        contentClassName={css.shareDialogContent as string}
        footer={<Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>}
      >
        {stateMatchesBot && error !== null && <div className={css.dialogNotice} role="alert">{error}</div>}
        <div className={css.dialogField}>
          <span className={css.dialogLabel}>{t('shareRoleLabel')}</span>
          <SegmentedControl
            id="yharness-bots-share-role"
            label={t('shareRoleLabel')}
            value={stateMatchesBot ? role : 'collaborator'}
            disabled={!stateMatchesBot || working === 'invite'}
            onChange={(value) => { inviteGenerationRef.current += 1; setRole(value); setInvite(null) }}
            options={[
              { value: 'collaborator', label: t('shareRoleCollaborator') },
              { value: 'manager', label: t('shareRoleManager') },
              { value: 'owner', label: t('shareRoleOwner') },
            ]}
          />
        </div>
        <div className={css.shareInviteRow}>
          <Button variant="primary" onClick={() => { void createInvite() }} disabled={!stateMatchesBot || working !== null || memoryWorking} icon={<IconLinkOutlineRegular size={14} />}>
            {stateMatchesBot && working === 'invite' ? t('creatingInvite') : t('createInvite')}
          </Button>
          {stateMatchesBot && invite !== null && (
            <div className={css.inviteCode}>
              <code aria-label={t('inviteCodeLabel')}>{invite.code}</code>
              <Tooltip label={copied ? t('copiedInvite') : t('copyInvite')} side="bottom" portal>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={copied ? t('copiedInvite') : t('copyInvite')}
                  icon={<IconCopyOutlineRegular size={14} />}
                  onClick={() => {
                    const inviteCode = invite.code
                    const inviteBotId = bot.id
                    const viewGeneration = viewGenerationRef.current
                    const inviteGeneration = ++inviteGenerationRef.current
                    setCopied(false)
                    void writeClipboard(inviteCode).then((success) => {
                      if (
                        success &&
                        isCurrentView(inviteBotId, viewGeneration) &&
                        inviteGenerationRef.current === inviteGeneration
                      ) setCopied(true)
                    })
                  }}
                />
              </Tooltip>
            </div>
          )}
        </div>
        {stateMatchesBot && actions.getMemoryPolicy !== undefined && actions.setMemoryPolicy !== undefined && memoryPolicy !== null && (
          <section className={css.sharedMemoryCard} aria-labelledby="yharness-shared-memory-heading">
            <div className={css.sharedMemoryHeader}>
              <span className={css.sharedMemoryIcon} aria-hidden="true"><IconShieldOutlineRegular size={16} /></span>
              <div>
                <div className={css.shareSectionHeading} id="yharness-shared-memory-heading">{t('sharedMemoryLabel')}</div>
                <p className={css.sharedMemoryDescription}>{t('sharedMemoryDescription')}</p>
              </div>
              <Switch
                checked={memoryPolicy.enabled}
                disabled={memoryWorking || working !== null}
                label={t('sharedMemoryToggle')}
                onChange={(next) => { setMemoryTarget(next); setMemoryAcknowledged(false) }}
              />
            </div>
          </section>
        )}
        <div className={css.shareMembers}>
          <div className={css.shareSectionHeading}>{t('membersLabel')}</div>
          {stateMatchesBot && working === 'load' && <div className={css.shareLoading} role="status"><StateDot state="ongoing" size={12} /></div>}
          {stateMatchesBot && working !== 'load' && members.length === 0 && <div className={css.shareEmpty}>{t('noMembers')}</div>}
          {stateMatchesBot && working !== 'load' && members.map(member => (
            <div className={css.shareMember} key={String(member.principalId)}>
              <span className={css.shareMemberIdentity}>
                <span className={css.shareMemberDot} aria-hidden="true" />
                <span className={css.shareMemberPrincipal}>{String(member.principalId)}</span>
                <Tag tone={member.role === 'owner' ? 'info' : 'neutral'}>{shareRoleLabel(member.role, t)}</Tag>
              </span>
              {member.role === 'owner'
                ? <span className={css.shareMemberHint}>{t('revokeOwnerDisabled')}</span>
                : (
                  <Tooltip label={t('revokeMember')} side="top" portal>
                    <Button variant="ghost" size="sm" aria-label={`${t('revokeMember')}: ${String(member.principalId)}`} icon={<IconTrashOutlineRegular size={14} />} disabled={working !== null || memoryWorking} onClick={() => { void revoke(member) }} />
                  </Tooltip>
                )}
            </div>
          ))}
        </div>
      </Modal>
      <RiskConfirmation
        open={stateMatchesBot && memoryTarget !== null}
        title={memoryTarget === true ? t('enableSharedMemoryTitle') : t('disableSharedMemoryTitle')}
        description={memoryTarget === true ? t('enableSharedMemoryDescription') : t('disableSharedMemoryDescription')}
        acknowledgeLabel={memoryTarget === true ? t('enableSharedMemoryAcknowledge') : t('disableSharedMemoryAcknowledge')}
        cancelLabel={t('cancel')}
        closeLabel={t('cancel')}
        confirmLabel={memoryTarget === true ? t('enableSharedMemory') : t('disableSharedMemory')}
        acknowledged={memoryAcknowledged}
        disabled={!stateMatchesBot || memoryWorking}
        onAcknowledgedChange={setMemoryAcknowledged}
        onCancel={() => { setMemoryTarget(null); setMemoryAcknowledged(false) }}
        onConfirm={() => { void confirmMemoryPolicy() }}
      />
    </>
  )
}
/** Collaborator discovery, enrollment, and private chat surface. */
function SharedGroupCreateDialog({
  open,
  onClose,
  onCreate,
  onRecover,
  onRequestDiscard,
  bots,
  pendingCreations,
  recoveryWorking,
  error,
  t,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly onCreate: (request: BotGroupCreateRequest) => Promise<void>
  readonly onRecover: (creation: SharedPendingGroupCreation) => Promise<void>
  readonly onRequestDiscard: (creation: SharedPendingGroupCreation) => void
  readonly bots: readonly BotShareRosterEntry[]
  readonly pendingCreations: readonly SharedPendingGroupCreation[]
  readonly recoveryWorking: string | null
  readonly error: string | null
  readonly t: Translate
}) {
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<readonly string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const openRef = useRef(open)
  openRef.current = open
  const dialogGenerationRef = useRef(0)

  useEffect(() => {
    dialogGenerationRef.current += 1
    if (!open) return
    setName('')
    setSelected([])
    setSubmitting(false)
  }, [open])

  const close = (): void => {
    dialogGenerationRef.current += 1
    setSubmitting(false)
    onClose()
  }

  const toggle = (id: string, checked: boolean): void => {
    setSelected(current => checked ? [...current, id] : current.filter(value => value !== id))
  }

  const submit = async (): Promise<void> => {
    const trimmed = name.trim()
    const botIds = selected.flatMap((id) => {
      const bot = bots.find(candidate => String(candidate.id) === id)
      return bot === undefined ? [] : [bot.id]
    })
    if (trimmed === '' || botIds.length < 2 || botIds.length > 6 || submitting) return
    const dialogGeneration = dialogGenerationRef.current
    setSubmitting(true)
    try {
      await onCreate({ name: trimmed, botIds })
      if (openRef.current && dialogGenerationRef.current === dialogGeneration) close()
    } catch {
      // Keep the selection and draft in place so the owner can retry.
    } finally {
      if (openRef.current && dialogGenerationRef.current === dialogGeneration) setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('sharedGroupCreateTitle')}
      description={t('sharedGroupCreateDescription')}
      closeLabel={t('cancel')}
      footer={(
        <>
          <Button variant="ghost" onClick={close}>{t('cancel')}</Button>
          <Button
            variant="primary"
            onClick={() => { void submit() }}
            disabled={name.trim() === '' || selected.length < 2 || selected.length > 6 || submitting || recoveryWorking !== null}
          >
            {submitting ? t('sharedGroupCreating') : t('sharedGroupCreate')}
          </Button>
        </>
      )}
    >
      {error !== null && <div className={css.dialogNotice} role="alert">{error}</div>}
      {pendingCreations.length > 0 && (
        <div className={css.dialogNotice} role="status">
          <strong>{t('sharedGroupPendingRecoveryTitle')}</strong>
          <p>{t('sharedGroupPendingRecoveryDescription')}</p>
          {pendingCreations.map((creation) => {
            const memberNames = creation.botIds.map(id => bots.find(bot => String(bot.id) === id)?.name ?? id).join(', ')
            const working = recoveryWorking === creation.id
            return (
              <div className={css.shareInviteRow} key={creation.id}>
                <span>{creation.name} · {memberNames}{creation.expired ? ` · ${t('sharedGroupPendingExpired')}` : ''}</span>
                <Button variant="outline" size="sm" disabled={recoveryWorking !== null || submitting} onClick={() => { void onRecover(creation) }}>
                  {working ? t('sharedGroupRecovering') : t('sharedGroupRecover')}
                </Button>
                <Button variant="ghost" size="sm" disabled={recoveryWorking !== null || submitting} onClick={() => { onRequestDiscard(creation) }}>
                  {t('sharedGroupDiscardRecovery')}
                </Button>
              </div>
            )
          })}
        </div>
      )}
      <div className={css.dialogField} aria-busy={submitting}>
        <label className={css.dialogLabel} htmlFor="yharness-shared-group-name">{t('groupName')}</label>
        <Input
          id="yharness-shared-group-name"
          data-modal-autofocus
          value={name}
          placeholder={t('groupNamePlaceholder')}
          disabled={submitting}
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
          ? <div className={css.groupNoBots}>{t('noSharedBots')}</div>
          : <div className={css.groupMemberChoices}>
            {bots.map((bot) => {
              const id = String(bot.id)
              const checked = selected.includes(id)
              const disabled = !checked && selected.length >= 6
              return (
                <label className={clsx(css.groupMemberChoice, checked && css.groupMemberChoiceSelected)} key={id}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || submitting}
                    aria-label={bot.name}
                    onChange={(event) => { toggle(id, event.currentTarget.checked) }}
                  />
                  <BotAvatar name={bot.name} identity={bot.identity} accent={bot.accent} avatar={bot.avatar} />
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

export function SharedBotsDialog({ client, open, onClose, t }: {
  readonly client: SharedBotsClient
  readonly open: boolean
  readonly onClose: () => void
  readonly t: Translate
}) {
  const [code, setCode] = useState('')
  const [bots, setBots] = useState<readonly BotShareRosterEntry[]>([])
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null)
  const [recent, setRecent] = useState<readonly BotShareTranscriptEntry[]>([])
  const [memory, setMemory] = useState<BotShareMemoryValue | null>(null)
  const [messageDrafts, setMessageDrafts] = useState<Readonly<Record<string, string>>>({})
  const [memoryDrafts, setMemoryDrafts] = useState<Readonly<Record<string, string>>>({})
  const [memoryAcknowledged, setMemoryAcknowledged] = useState(false)
  const [memoryConfirmOpen, setMemoryConfirmOpen] = useState(false)
  const [groups, setGroups] = useState<readonly BotGroupView[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [groupMessages, setGroupMessages] = useState<readonly BotGroupMessageView[]>([])
  const [groupDraft, setGroupDraft] = useState('')
  const [groupWorking, setGroupWorking] = useState<'load' | 'create' | 'send' | null>(null)
  const [createGroupOpen, setCreateGroupOpen] = useState(false)
  const [createGroupError, setCreateGroupError] = useState<string | null>(null)
  const [pendingCreations, setPendingCreations] = useState<readonly SharedPendingGroupCreation[]>([])
  const [pendingMessages, setPendingMessages] = useState<readonly SharedPendingGroupMessage[]>([])
  const [recoveryWorking, setRecoveryWorking] = useState<string | null>(null)
  const [pendingMessageWorking, setPendingMessageWorking] = useState<string | null>(null)
  const [discardTarget, setDiscardTarget] = useState<
    | { readonly kind: 'creation'; readonly value: SharedPendingGroupCreation }
    | { readonly kind: 'message'; readonly value: SharedPendingGroupMessage }
    | null
  >(null)
  const [discardAcknowledged, setDiscardAcknowledged] = useState(false)
  const [discardWorking, setDiscardWorking] = useState(false)
  const [groupInvite, setGroupInvite] = useState<SharedBotGroupInviteValue | null>(null)
  const [groupInviteWorking, setGroupInviteWorking] = useState(false)
  const [groupInviteCopied, setGroupInviteCopied] = useState(false)
  const [groupInviteUnavailable, setGroupInviteUnavailable] = useState(false)
  const [working, setWorking] = useState<'list' | 'enroll' | null>(null)
  const [chatWorkingBotIds, setChatWorkingBotIds] = useState<ReadonlySet<string>>(new Set())
  const [memoryWorkingBotIds, setMemoryWorkingBotIds] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const openRef = useRef(open)
  openRef.current = open
  const selectedBotIdRef = useRef<string | null>(null)
  const selectedGroupIdRef = useRef<string | null>(null)
  const codeRevisionRef = useRef(0)
  const messageDraftRevisionsRef = useRef<Record<string, number>>({})
  const memoryDraftRevisionsRef = useRef<Record<string, number>>({})
  const readGenerationRef = useRef(0)
  const lifecycleGenerationRef = useRef(0)
  const refreshGenerationRef = useRef(0)
  const operationGenerationRef = useRef(0)
  const selectionEpochRef = useRef(0)
  const groupReadGenerationRef = useRef(0)
  const groupOperationGenerationRef = useRef(0)
  const groupDraftRevisionRef = useRef(0)
  const groupInviteGenerationRef = useRef(0)
  const createGroupGenerationRef = useRef(0)
  const pendingRefreshGenerationRef = useRef(0)
  const recoveryWorkingRef = useRef<string | null>(null)
  const pendingGroupQueueRef = useRef<{ readonly scope: string; readonly queue: SharedGroupPendingQueue } | null>(null)
  const clearPendingRetryState = (): void => {
    setPendingCreations([])
    setPendingMessages([])
    recoveryWorkingRef.current = null
    setRecoveryWorking(null)
    setPendingMessageWorking(null)
    setDiscardTarget(null)
    setDiscardAcknowledged(false)
  }
  const resetPendingScopeIfChanged = (scope: string | undefined): void => {
    if (pendingGroupQueueRef.current?.scope === scope) return
    if (pendingGroupQueueRef.current !== null) {
      pendingGroupQueueRef.current = null
      clearPendingRetryState()
    }
  }
  const getPendingGroupQueue = (): SharedGroupPendingQueue => {
    const scope = client.retryScope
    resetPendingScopeIfChanged(scope)
    if (scope === undefined) throw new Error(t('sharedGroupRetryIdentityUnavailable'))
    if (pendingGroupQueueRef.current?.scope === scope) {
      if (!pendingGroupQueueRef.current.queue.durable) throw new Error(t('sharedGroupRetryUnavailable'))
      return pendingGroupQueueRef.current.queue
    }
    const queue = createSharedGroupPendingQueue(scope)
    pendingGroupQueueRef.current = { scope, queue }
    if (!queue.durable) throw new Error(t('sharedGroupRetryUnavailable'))
    return queue
  }
  const message = selectedBotId === null ? '' : messageDrafts[selectedBotId] ?? ''
  const memoryDraft = selectedBotId === null ? '' : memoryDrafts[selectedBotId] ?? ''
  const hasPendingChat = chatWorkingBotIds.size > 0
  const hasPendingMemory = memoryWorkingBotIds.size > 0
  const currentChatWorking = selectedBotId !== null && chatWorkingBotIds.has(selectedBotId)
  const currentMemoryWorking = selectedBotId !== null && memoryWorkingBotIds.has(selectedBotId)

  const isCurrentLifecycle = (generation: number): boolean => openRef.current && lifecycleGenerationRef.current === generation
  const isCurrentOperation = (lifecycleGeneration: number, operationGeneration: number): boolean => (
    isCurrentLifecycle(lifecycleGeneration) && operationGenerationRef.current === operationGeneration
  )
  const isCurrentSelection = (botId: string, selectionEpoch: number): boolean => (
    openRef.current && selectedBotIdRef.current === botId && selectionEpochRef.current === selectionEpoch
  )

  const setSelection = (botId: string | null): void => {
    if (selectedBotIdRef.current !== botId) selectionEpochRef.current += 1
    selectedBotIdRef.current = botId
    setSelectedBotId(botId)
    if (botId !== null) {
      selectedGroupIdRef.current = null
      setSelectedGroupId(null)
      setGroupMessages([])
    }
  }

  const setGroupSelection = (groupId: string | null): void => {
    if (selectedGroupIdRef.current !== groupId) {
      groupOperationGenerationRef.current += 1
      groupDraftRevisionRef.current += 1
      groupInviteGenerationRef.current += 1
      setGroupDraft('')
      setGroupWorking(null)
      setGroupInvite(null)
      setGroupInviteCopied(false)
      setGroupInviteWorking(false)
      setGroupInviteUnavailable(false)
    }
    selectedGroupIdRef.current = groupId
    setSelectedGroupId(groupId)
    if (groupId !== null) {
      selectedBotIdRef.current = null
      setSelectedBotId(null)
      setRecent([])
      setMemory(null)
    }
  }

  const readGroup = async (groupId: string): Promise<void> => {
    const inspect = client.inspectGroup
    if (inspect === undefined) return
    const generation = groupReadGenerationRef.current + 1
    groupReadGenerationRef.current = generation
    selectedGroupIdRef.current = groupId
    setGroupMessages([])
    try {
      const result = await inspect(groupId)
      if (!openRef.current || generation !== groupReadGenerationRef.current || selectedGroupIdRef.current !== groupId) return
      if (result.ok) setGroupMessages(result.value.messages)
      else setError(result.error.message || t('sharedGroupLoadFailed'))
    } catch (cause: unknown) {
      if (openRef.current && generation === groupReadGenerationRef.current && selectedGroupIdRef.current === groupId) {
        setError(cause instanceof Error ? cause.message : t('sharedGroupLoadFailed'))
      }
    }
  }

  const refresh = async (): Promise<void> => {
    if (!openRef.current) return
    const lifecycleGeneration = lifecycleGenerationRef.current
    const refreshGeneration = refreshGenerationRef.current + 1
    refreshGenerationRef.current = refreshGeneration
    resetPendingScopeIfChanged(client.retryScope)
    setWorking('list')
    setError(null)
    setGroups([])
    setGroupSelection(null)
    setGroupMessages([])
    try {
      if (client.retryScope === undefined) {
        try {
          const restored = await client.restoreRetryScope()
          if (!isCurrentLifecycle(lifecycleGeneration) || refreshGenerationRef.current !== refreshGeneration) return
          if (!restored.ok && restored.error.code !== 'gateway/not-found' && restored.error.code !== 'gateway/unauthorized') {
            setError(restored.error.message || t('sharedGroupRetryIdentityUnavailable'))
          }
        } catch {
          // The roster remains usable when the optional reload-scope endpoint is unavailable.
        }
      }
      const result = await client.list()
      if (!isCurrentLifecycle(lifecycleGeneration) || refreshGenerationRef.current !== refreshGeneration) return
      if (result.ok) {
        setBots(result.value.bots)
        const currentSelectedBotId = selectedBotIdRef.current
        const selected = currentSelectedBotId !== null && result.value.bots.some(bot => String(bot.id) === currentSelectedBotId)
          ? currentSelectedBotId
          : result.value.bots[0] === undefined ? null : String(result.value.bots[0].id)
        setSelection(selected)
        if (selected !== null) await readBot(selected)
        else {
          setRecent([])
          setMemory(null)
          setMemoryConfirmOpen(false)
          setMemoryAcknowledged(false)
        }
        if (!isCurrentLifecycle(lifecycleGeneration) || refreshGenerationRef.current !== refreshGeneration) return
        const listGroups = client.listGroups
        if (listGroups !== undefined) {
          setGroupWorking('load')
          let groupsResult: Awaited<ReturnType<typeof listGroups>>
          try {
            groupsResult = await listGroups()
          } finally {
            if (isCurrentLifecycle(lifecycleGeneration) && refreshGenerationRef.current === refreshGeneration) {
              setGroupWorking(current => current === 'load' ? null : current)
            }
          }
          if (!isCurrentLifecycle(lifecycleGeneration) || refreshGenerationRef.current !== refreshGeneration) return
          if (groupsResult.ok) {
            setGroups(groupsResult.value.groups)
            const currentGroupId = selectedGroupIdRef.current
            const nextGroupId = currentGroupId !== null && groupsResult.value.groups.some(group => String(group.id) === currentGroupId)
              ? currentGroupId
              : groupsResult.value.groups[0] === undefined ? null : String(groupsResult.value.groups[0].id)
            setGroupSelection(nextGroupId)
            if (nextGroupId !== null) await readGroup(nextGroupId)
            void refreshPendingOperations()
          } else {
            setError(groupsResult.error.message || t('sharedGroupLoadFailed'))
          }
        }
      } else {
        setError(result.error.message)
      }
    } catch (cause: unknown) {
      if (isCurrentLifecycle(lifecycleGeneration) && refreshGenerationRef.current === refreshGeneration) {
        setError(cause instanceof Error ? cause.message : t('shareError'))
      }
    } finally {
      if (isCurrentLifecycle(lifecycleGeneration) && refreshGenerationRef.current === refreshGeneration) {
        setWorking(current => current === 'list' ? null : current)
      }
    }
  }

  const readBot = async (botId: string): Promise<void> => {
    const generation = readGenerationRef.current + 1
    readGenerationRef.current = generation
    selectedBotIdRef.current = botId
    setRecent([])
    setMemory(null)
    setMemoryConfirmOpen(false)
    setMemoryAcknowledged(false)
    setError(null)
    try {
      const [privateResult, memoryResult] = await Promise.all([
        client.readPrivateChat(botId),
        client.readMemory(botId),
      ])
      if (generation !== readGenerationRef.current || selectedBotIdRef.current !== botId) return
      if (privateResult.ok) setRecent(privateResult.value.recent)
      else setError(privateResult.error.message)
      if (memoryResult.ok) setMemory(memoryResult.value)
      else setError(memoryResult.error.message)
    } catch (cause: unknown) {
      if (generation === readGenerationRef.current && selectedBotIdRef.current === botId) {
        setError(cause instanceof Error ? cause.message : t('sharedChatFailed'))
      }
    }
  }

  async function refreshPendingOperations(): Promise<void> {
    const lifecycleGeneration = lifecycleGenerationRef.current
    const refreshGeneration = pendingRefreshGenerationRef.current + 1
    pendingRefreshGenerationRef.current = refreshGeneration
    const scope = client.retryScope
    if (scope === undefined) {
      clearPendingRetryState()
      return
    }
    try {
      const queue = getPendingGroupQueue()
      const [creations, messages] = await Promise.all([queue.listCreations(), queue.listMessages()])
      if (!isCurrentLifecycle(lifecycleGeneration) || pendingRefreshGenerationRef.current !== refreshGeneration
        || client.retryScope !== scope || pendingGroupQueueRef.current?.scope !== scope) return
      setPendingCreations(creations)
      setPendingMessages(messages)
    } catch (cause: unknown) {
      if (isCurrentLifecycle(lifecycleGeneration) && pendingRefreshGenerationRef.current === refreshGeneration
        && client.retryScope === scope && createGroupOpen) {
        setCreateGroupError(cause instanceof Error ? cause.message : t('sharedGroupRetryUnavailable'))
      }
    }
  }

  const openCreateGroup = (): void => {
    const createGeneration = createGroupGenerationRef.current + 1
    createGroupGenerationRef.current = createGeneration
    setCreateGroupError(null)
    setCreateGroupOpen(true)
    void refreshPendingOperations()
  }

  const closeCreateGroup = (): void => {
    createGroupGenerationRef.current += 1
    groupReadGenerationRef.current += 1
    setCreateGroupOpen(false)
    setCreateGroupError(null)
    recoveryWorkingRef.current = null
    setRecoveryWorking(null)
    setGroupWorking(current => current === 'create' ? null : current)
  }

  const reconcileGroupCreation = async (
    id: BotGroupIdType,
    name: string,
    botIds: readonly string[],
  ): Promise<BotGroupView | undefined> => {
    const listGroups = client.listGroups
    if (listGroups === undefined) throw new Error(t('sharedGroupRetryUnavailable'))
    const result = await listGroups()
    if (!result.ok) throw new Error(result.error.message || t('sharedGroupRetryUnavailable'))
    const existing = result.value.groups.find(group => String(group.id) === String(id))
    if (existing === undefined) return undefined
    const existingIds = existing.botIds.map(String).sort()
    const requestedIds = [...botIds].map(String).sort()
    if (existing.name !== name || existingIds.length !== requestedIds.length
      || !existingIds.every((botId, index) => botId === requestedIds[index])) {
      throw new Error(t('sharedGroupRetryConflict'))
    }
    return existing
  }

  const reconcileGroupMessage = async (groupId: string, messageId: BotGroupMessageIdType, text: string): Promise<void> => {
    const inspectGroup = client.inspectGroup
    if (inspectGroup === undefined) throw new Error(t('sharedGroupRetryUnavailable'))
    const result = await inspectGroup(groupId)
    if (!result.ok) throw new Error(result.error.message || t('sharedGroupRetryUnavailable'))
    const existing = result.value.messages.find(messageRow => String(messageRow.id) === String(messageId))
    if (existing === undefined) return
    const principalId = client.retryScope
    if (principalId === undefined || String(existing.groupId) !== groupId || existing.text !== text
      || existing.sender.kind !== 'user' || existing.sender.principalId === undefined
      || String(existing.sender.principalId) !== principalId) {
      throw new Error(t('sharedGroupRetryConflict'))
    }
  }

  useEffect(() => {
    lifecycleGenerationRef.current += 1
    readGenerationRef.current += 1
    groupReadGenerationRef.current += 1
    operationGenerationRef.current += 1
    if (!open) {
      createGroupGenerationRef.current += 1
      setWorking(null)
      setGroupWorking(null)
      setMemoryConfirmOpen(false)
      setMemoryAcknowledged(false)
      setGroupSelection(null)
      setGroupMessages([])
      setCreateGroupOpen(false)
      setCreateGroupError(null)
      setGroupInvite(null)
      setGroupInviteCopied(false)
      setGroupInviteWorking(false)
      setGroupInviteUnavailable(false)
      recoveryWorkingRef.current = null
      setRecoveryWorking(null)
      setPendingCreations([])
      setPendingMessages([])
      setPendingMessageWorking(null)
      setDiscardTarget(null)
      setDiscardAcknowledged(false)
      return
    }
    setError(null)
    void refresh()
  }, [open])

  const enroll = async (): Promise<void> => {
    const submittedCode = code
    const trimmed = submittedCode.trim()
    if (!openRef.current || trimmed === '' || working !== null || groupWorking !== null || hasPendingChat || hasPendingMemory) return
    const submittedCodeRevision = codeRevisionRef.current
    const lifecycleGeneration = lifecycleGenerationRef.current
    const operationGeneration = operationGenerationRef.current + 1
    operationGenerationRef.current = operationGeneration
    setWorking('enroll')
    setError(null)
    try {
      const result = await client.enroll(trimmed)
      if (!isCurrentOperation(lifecycleGeneration, operationGeneration)) return
      if (result.ok) {
        resetPendingScopeIfChanged(result.value.principalId)
        if (codeRevisionRef.current === submittedCodeRevision) setCode('')
        await refresh()
      } else {
        setError(result.error.message || t('sharedEnrollmentFailed'))
      }
    } catch (cause: unknown) {
      if (isCurrentOperation(lifecycleGeneration, operationGeneration)) {
        setError(cause instanceof Error ? cause.message : t('sharedEnrollmentFailed'))
      }
    } finally {
      if (isCurrentOperation(lifecycleGeneration, operationGeneration)) {
        setWorking(current => current === 'enroll' ? null : current)
      }
    }
  }

  const send = async (): Promise<void> => {
    if (!openRef.current || selectedBotId === null || message.trim() === '' || working !== null || currentChatWorking || currentMemoryWorking) return
    const botId = selectedBotId
    const submittedMessageRevision = messageDraftRevisionsRef.current[botId] ?? 0
    const selectionEpoch = selectionEpochRef.current
    operationGenerationRef.current += 1
    setChatWorkingBotIds(current => updatePendingBotIds(current, botId, true))
    setError(null)
    try {
      const result = await client.chat(botId, message.trim())
      const currentSelection = isCurrentSelection(botId, selectionEpoch)
      if (result.ok) {
        if ((messageDraftRevisionsRef.current[botId] ?? 0) === submittedMessageRevision) {
          setMessageDrafts((current) => {
            if ((messageDraftRevisionsRef.current[botId] ?? 0) !== submittedMessageRevision) return current
            if (!(botId in current)) return current
            const next = { ...current }
            Reflect.deleteProperty(next, botId)
            return next
          })
        }
        if (!currentSelection) return
        await readBot(botId)
      } else if (currentSelection) {
        setError(result.error.message || t('sharedChatFailed'))
      }
    } catch (cause: unknown) {
      if (isCurrentSelection(botId, selectionEpoch)) {
        setError(cause instanceof Error ? cause.message : t('sharedChatFailed'))
      }
    } finally {
      setChatWorkingBotIds(current => updatePendingBotIds(current, botId, false))
    }
  }

  const publishMemory = async (): Promise<void> => {
    if (!openRef.current || selectedBotId === null || !bots.some(bot => String(bot.id) === selectedBotId)
      || memoryDraft.trim() === '' || working !== null || currentChatWorking || currentMemoryWorking || memory?.enabled !== true) return
    const botId = selectedBotId
    const submittedDraftRevision = memoryDraftRevisionsRef.current[botId] ?? 0
    const selectionEpoch = selectionEpochRef.current
    operationGenerationRef.current += 1
    setMemoryWorkingBotIds(current => updatePendingBotIds(current, botId, true))
    setError(null)
    try {
      const result = await client.writeMemory(botId, memoryDraft.trim())
      const currentSelection = isCurrentSelection(botId, selectionEpoch)
      if (result.ok) {
        if ((memoryDraftRevisionsRef.current[botId] ?? 0) === submittedDraftRevision) {
          setMemoryDrafts((current) => {
            if ((memoryDraftRevisionsRef.current[botId] ?? 0) !== submittedDraftRevision) return current
            if (!(botId in current)) return current
            const next = { ...current }
            Reflect.deleteProperty(next, botId)
            return next
          })
        }
        if (!currentSelection) return
        setMemoryAcknowledged(false)
        setMemoryConfirmOpen(false)
        await readBot(botId)
      } else if (currentSelection) {
        setError(result.error.message || t('sharedMemoryWriteFailed'))
      }
    } catch (cause: unknown) {
      if (isCurrentSelection(botId, selectionEpoch)) {
        setError(cause instanceof Error ? cause.message : t('sharedMemoryWriteFailed'))
      }
    } finally {
      setMemoryWorkingBotIds(current => updatePendingBotIds(current, botId, false))
    }
  }

  const createSharedGroup = async (request: BotGroupCreateRequest): Promise<void> => {
    const create = client.createGroup
    const lifecycleGeneration = lifecycleGenerationRef.current
    if (create === undefined || !isCurrentLifecycle(lifecycleGeneration)) return
    const name = request.name.trim()
    const botIds = request.botIds.map(String)
    const pendingKey = sharedGroupCreationKey(name, botIds)
    const createGeneration = createGroupGenerationRef.current
    const selectionGeneration = groupOperationGenerationRef.current
    const selectedGroupBeforeCreate = selectedGroupIdRef.current
    const isCurrentCreate = (): boolean => (
      isCurrentLifecycle(lifecycleGeneration)
      && createGroupGenerationRef.current === createGeneration
      && groupOperationGenerationRef.current === selectionGeneration
      && selectedGroupIdRef.current === selectedGroupBeforeCreate
    )
    setCreateGroupError(null)
    setGroupWorking('create')
    try {
      const queue = getPendingGroupQueue()
      const reservation = await queue.reserveCreation(pendingKey, name, botIds)
      if (!isCurrentCreate()) return
      if (reservation.recovered) {
        setPendingCreations(await queue.listCreations())
        throw new Error(t('sharedGroupPendingRecoveryRequired'))
      }
      const id = brandString<BotGroupIdType>(reservation.id)
      const result = await create({ ...request, id, name, botIds: request.botIds })
      if (!result.ok) throw new Error(result.error.message || t('sharedGroupCreateFailed'))
      const created = result.value.group
      if (!isCurrentCreate()) return
      await queue.removeCreation(reservation.operationHash, reservation.id)
      if (!isCurrentCreate()) return
      setGroups(current => [
        ...current.filter(group => String(group.id) !== String(created.id)),
        created,
      ])
      setGroupSelection(String(created.id))
      await readGroup(String(created.id))
    } catch (cause: unknown) {
      if (isCurrentCreate()) {
        const error = cause instanceof Error ? cause : new Error(t('sharedGroupCreateFailed'))
        setCreateGroupError(error.message || t('sharedGroupCreateFailed'))
        void refreshPendingOperations()
      }
      throw cause
    } finally {
      if (isCurrentCreate()) setGroupWorking(current => current === 'create' ? null : current)
    }
  }

  const recoverPendingCreation = async (creation: SharedPendingGroupCreation): Promise<void> => {
    const create = client.createGroup
    const lifecycleGeneration = lifecycleGenerationRef.current
    const createGeneration = createGroupGenerationRef.current
    if (create === undefined || !isCurrentLifecycle(lifecycleGeneration) || recoveryWorking !== null) return
    const isCurrentRecovery = (): boolean => (
      isCurrentLifecycle(lifecycleGeneration)
      && createGroupGenerationRef.current === createGeneration
      && recoveryWorkingRef.current === creation.id
    )
    recoveryWorkingRef.current = creation.id
    setRecoveryWorking(creation.id)
    setCreateGroupError(null)
    try {
      const queue = getPendingGroupQueue()
      let created = await reconcileGroupCreation(
        brandString<BotGroupIdType>(creation.id),
        creation.name,
        creation.botIds,
      )
      if (created === undefined) {
        const result = await create({
          id: brandString<BotGroupIdType>(creation.id),
          name: creation.name,
          botIds: creation.botIds.map(id => brandString<BotIdType>(id)),
        })
        if (!result.ok) throw new Error(result.error.message || t('sharedGroupCreateFailed'))
        created = result.value.group
      }
      await queue.removeCreation(creation.operationHash, creation.id)
      if (!isCurrentRecovery()) return
      setPendingCreations(current => current.filter(candidate => candidate.id !== creation.id))
      setGroups(current => [
        ...current.filter(group => String(group.id) !== String(created.id)),
        created,
      ])
      setGroupSelection(String(created.id))
      await readGroup(String(created.id))
      closeCreateGroup()
    } catch (cause: unknown) {
      if (isCurrentRecovery()) setCreateGroupError(cause instanceof Error ? cause.message : t('sharedGroupCreateFailed'))
    } finally {
      const shouldClear = isCurrentRecovery()
      if (recoveryWorkingRef.current === creation.id) recoveryWorkingRef.current = null
      if (shouldClear) setRecoveryWorking(null)
    }
  }

  const discardPendingCreation = async (creation: SharedPendingGroupCreation): Promise<boolean> => {
    const lifecycleGeneration = lifecycleGenerationRef.current
    const createGeneration = createGroupGenerationRef.current
    if (!isCurrentLifecycle(lifecycleGeneration) || recoveryWorking !== null) return false
    const isCurrentDiscard = (): boolean => (
      isCurrentLifecycle(lifecycleGeneration) && createGroupGenerationRef.current === createGeneration
    )
    recoveryWorkingRef.current = creation.id
    setRecoveryWorking(creation.id)
    let succeeded = false
    try {
      const queue = getPendingGroupQueue()
      await queue.removeCreation(creation.operationHash, creation.id)
      if (isCurrentDiscard()) {
        setPendingCreations(current => current.filter(candidate => candidate.id !== creation.id))
        succeeded = true
      }
    } catch (cause: unknown) {
      if (isCurrentDiscard()) setCreateGroupError(cause instanceof Error ? cause.message : t('sharedGroupRetryUnavailable'))
    } finally {
      const shouldClear = isCurrentDiscard()
      if (recoveryWorkingRef.current === creation.id) recoveryWorkingRef.current = null
      if (shouldClear) setRecoveryWorking(null)
    }
    return succeeded
  }

  const requestDiscardCreation = (creation: SharedPendingGroupCreation): void => {
    setDiscardTarget({ kind: 'creation', value: creation })
    setDiscardAcknowledged(false)
  }

  const discardPendingMessage = async (messageRecord: SharedPendingGroupMessage): Promise<boolean> => {
    const lifecycleGeneration = lifecycleGenerationRef.current
    const groupGeneration = groupOperationGenerationRef.current
    if (!isCurrentLifecycle(lifecycleGeneration) || groupWorking !== null || pendingMessageWorking !== null) return false
    const isCurrentDiscard = (): boolean => (
      isCurrentLifecycle(lifecycleGeneration) && groupOperationGenerationRef.current === groupGeneration
    )
    setPendingMessageWorking(messageRecord.id)
    let succeeded = false
    try {
      const queue = getPendingGroupQueue()
      await queue.removeMessage(messageRecord.operationHash, messageRecord.id)
      if (isCurrentDiscard()) {
        setPendingMessages(current => current.filter(candidate => candidate.id !== messageRecord.id))
        succeeded = true
      }
    } catch (cause: unknown) {
      if (isCurrentDiscard()) setError(cause instanceof Error ? cause.message : t('sharedGroupRetryUnavailable'))
    } finally {
      if (isCurrentDiscard()) setPendingMessageWorking(null)
    }
    return succeeded
  }

  const requestDiscardMessage = (messageRecord: SharedPendingGroupMessage): void => {
    setDiscardTarget({ kind: 'message', value: messageRecord })
    setDiscardAcknowledged(false)
  }

  const confirmDiscard = async (): Promise<void> => {
    const target = discardTarget
    if (target === null || discardWorking) return
    setDiscardWorking(true)
    try {
      const succeeded = target.kind === 'creation'
        ? await discardPendingCreation(target.value)
        : await discardPendingMessage(target.value)
      if (succeeded) {
        setDiscardTarget(null)
        setDiscardAcknowledged(false)
      }
    } finally {
      setDiscardWorking(false)
    }
  }

  const createSharedGroupInvite = async (): Promise<void> => {
    const createInvite = client.createGroupInvite
    const groupId = selectedGroupIdRef.current
    const lifecycleGeneration = lifecycleGenerationRef.current
    if (createInvite === undefined || groupId === null || !isCurrentLifecycle(lifecycleGeneration) || groupInviteWorking) return
    const inviteGeneration = groupInviteGenerationRef.current + 1
    groupInviteGenerationRef.current = inviteGeneration
    const isCurrentInvite = (): boolean => (
      isCurrentLifecycle(lifecycleGeneration)
      && selectedGroupIdRef.current === groupId
      && groupInviteGenerationRef.current === inviteGeneration
    )
    setGroupInviteWorking(true)
    setGroupInvite(null)
    setGroupInviteCopied(false)
    setError(null)
    try {
      const result = await createInvite(groupId)
      if (!isCurrentInvite()) return
      if (result.ok) setGroupInvite(result.value)
      else {
        setGroupInviteUnavailable(result.error.code === 'gateway/forbidden')
        setError(result.error.message || t('sharedGroupInviteFailed'))
      }
    } catch (cause: unknown) {
      if (isCurrentInvite()) setError(cause instanceof Error ? cause.message : t('sharedGroupInviteFailed'))
    } finally {
      if (isCurrentInvite()) setGroupInviteWorking(false)
    }
  }

  const recoverPendingMessage = async (pending: SharedPendingGroupMessage): Promise<void> => {
    const send = client.sendGroupMessage
    const lifecycleGeneration = lifecycleGenerationRef.current
    if (send === undefined || !isCurrentLifecycle(lifecycleGeneration) || groupWorking !== null || pendingMessageWorking !== null) return
    const group = groups.find(candidate => String(candidate.id) === pending.groupId)
    if (group === undefined) {
      setError(t('sharedGroupRetryConflict'))
      return
    }
    const alreadySelected = selectedGroupIdRef.current === pending.groupId
    setGroupSelection(pending.groupId)
    if (!alreadySelected) void readGroup(pending.groupId)
    if (pending.text === undefined) {
      setError(t('sharedGroupPendingMessageReenter'))
      return
    }
    const operationGeneration = groupOperationGenerationRef.current + 1
    groupOperationGenerationRef.current = operationGeneration
    const submittedDraftRevision = groupDraftRevisionRef.current
    const submittedDraft = groupDraft
    const isCurrentRecovery = (): boolean => (
      isCurrentLifecycle(lifecycleGeneration)
      && selectedGroupIdRef.current === pending.groupId
      && groupOperationGenerationRef.current === operationGeneration
    )
    setPendingMessageWorking(pending.id)
    setGroupWorking('send')
    setError(null)
    try {
      const messageId = brandString<BotGroupMessageIdType>(pending.id)
      await reconcileGroupMessage(pending.groupId, messageId, pending.text)
      if (!isCurrentRecovery()) return
      const result = await send({
        groupId: brandString<BotGroupIdType>(pending.groupId),
        text: pending.text,
        messageId,
      })
      if (!isCurrentRecovery()) return
      if (result.ok) {
        if (result.value.status === 'partial') {
          setError(t('sharedGroupSendFailed'))
          void refreshPendingOperations()
          return
        }
        const queue = getPendingGroupQueue()
        await queue.removeMessage(pending.operationHash, pending.id)
        if (!isCurrentRecovery()) return
        setPendingMessages(current => current.filter(candidate => candidate.id !== pending.id))
        if (groupDraftRevisionRef.current === submittedDraftRevision && submittedDraft.trim() === pending.text) setGroupDraft('')
        await readGroup(pending.groupId)
      } else {
        setError(result.error.message || t('sharedGroupSendFailed'))
      }
    } catch (cause: unknown) {
      if (isCurrentRecovery()) setError(cause instanceof Error ? cause.message : t('sharedGroupSendFailed'))
    } finally {
      if (isCurrentRecovery()) {
        setPendingMessageWorking(null)
        setGroupWorking(current => current === 'send' ? null : current)
      }
    }
  }

  const sendGroup = async (): Promise<void> => {
    const send = client.sendGroupMessage
    const groupId = selectedGroupIdRef.current
    const draft = groupDraft.trim()
    if (send === undefined || !openRef.current || groupId === null || draft === '' || working !== null
      || groupWorking !== null || hasPendingChat || hasPendingMemory) return
    const submittedRevision = groupDraftRevisionRef.current
    const submittedGroupId = groupId
    const pendingMessageKey = sharedGroupMessageKey(submittedGroupId, draft)
    const operationGeneration = groupOperationGenerationRef.current + 1
    groupOperationGenerationRef.current = operationGeneration
    const isCurrentGroupOperation = (): boolean => (
      openRef.current
      && selectedGroupIdRef.current === submittedGroupId
      && groupOperationGenerationRef.current === operationGeneration
    )
    setGroupWorking('send')
    setError(null)
    try {
      const queue = getPendingGroupQueue()
      const reservation = await queue.reserveMessage(pendingMessageKey, submittedGroupId, draft)
      if (!isCurrentGroupOperation()) return
      const messageId = brandString<BotGroupMessageIdType>(reservation.id)
      if (reservation.recovered) {
        await reconcileGroupMessage(submittedGroupId, messageId, draft)
        if (!isCurrentGroupOperation()) return
      }
      const result = await send({
        groupId: brandString<BotGroupIdType>(groupId),
        text: draft,
        messageId,
      })
      if (!openRef.current || selectedGroupIdRef.current !== submittedGroupId) return
      if (!isCurrentGroupOperation()) return
      if (result.ok) {
        if (result.value.status === 'partial') {
          setError(t('sharedGroupSendFailed'))
          void refreshPendingOperations()
          return
        }
        await queue.removeMessage(reservation.operationHash, reservation.id)
        setPendingMessages(current => current.filter(candidate => candidate.id !== reservation.id))
        if (groupDraftRevisionRef.current === submittedRevision) setGroupDraft('')
        await readGroup(submittedGroupId)
      } else {
        setError(result.error.message || t('sharedGroupSendFailed'))
        void refreshPendingOperations()
      }
    } catch (cause: unknown) {
      if (isCurrentGroupOperation()) {
        setError(cause instanceof Error ? cause.message : t('sharedGroupSendFailed'))
        void refreshPendingOperations()
      }
    } finally {
      if (isCurrentGroupOperation()) setGroupWorking(null)
    }
  }

  const selected = bots.find(bot => String(bot.id) === selectedBotId)
  const selectedGroup = groups.find(group => String(group.id) === selectedGroupId)
  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={t('sharedBotsTitle')}
        description={t('sharedBotsDescription')}
        closeLabel={t('cancel')}
        className={css.shareDialog as string}
        contentClassName={css.shareDialogContent as string}
        footer={<Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>}
      >
        {error !== null && <div className={css.dialogNotice} role="alert">{error}</div>}
        <div className={css.shareInviteRow}>
          <Input value={code} placeholder={t('inviteCodePlaceholder')} aria-label={t('inviteCodeLabel')} onChange={(event) => { codeRevisionRef.current += 1; setCode(event.currentTarget.value) }} />
          <Button variant="primary" onClick={() => { void enroll() }} disabled={working !== null || groupWorking !== null || hasPendingChat || hasPendingMemory || code.trim() === ''}>{working === 'enroll' ? t('joining') : t('join')}</Button>
        </div>
        <p className={css.sharedMemoryDescription}>{t('sharedInviteCodeHelp')}</p>
        {working === 'list' && <div className={css.shareLoading} role="status"><StateDot state="ongoing" size={12} /></div>}
        {working !== 'list' && bots.length === 0 && <div className={css.shareEmpty}>{t('noSharedBots')}</div>}
        {working !== 'list' && bots.length > 0 && (
          <div className={css.sharedWorkspace}>
            <div className={css.sharedBotList} aria-label={t('sharedBotsTitle')}>
              {bots.map(bot => (
                <button type="button" className={bot.id === selectedBotId ? css.sharedBotSelected : css.sharedBot} key={String(bot.id)} onClick={() => { const id = String(bot.id); setSelection(id); void readBot(id) }}>
                  <BotAvatar name={bot.name} identity={bot.identity} accent={bot.accent} size="small" />
                  <span><strong>{bot.name}</strong><small>{shareRoleLabel(bot.role, t)}</small></span>
                </button>
              ))}
            </div>
            {selected !== undefined && (
              <section className={css.sharedConversation} aria-label={selected.name}>
                <header className={css.sharedConversationHeader}>
                  <BotAvatar name={selected.name} identity={selected.identity} accent={selected.accent} />
                  <div><strong>{selected.name}</strong><small>{selected.description ?? shareRoleLabel(selected.role, t)}</small></div>
                </header>
                <div className={css.sharedTranscript}>
                  <div className={css.sharedContextLabel}>{t('privateSessionLabel')}</div>
                  {recent.length === 0 && <span className={css.shareEmpty}>{t('sharedTranscriptEmpty')}</span>}
                  {recent.map((entry, index) => <p className={entry.role === 'user' ? css.sharedUserMessage : css.sharedBotMessage} key={`${entry.role}-${index}`}>{entry.text}</p>)}
                </div>
                <form className={css.sharedComposer} onSubmit={(event) => { event.preventDefault(); void send() }}>
                  <Input value={message} placeholder={t('sharedChatPlaceholder')} aria-label={t('sharedChatPlaceholder')} onChange={(event) => {
                    if (selectedBotId === null) return
                    const revision = (messageDraftRevisionsRef.current[selectedBotId] ?? 0) + 1
                    messageDraftRevisionsRef.current[selectedBotId] = revision
                    const value = event.currentTarget.value
                    setMessageDrafts(current => ({ ...current, [selectedBotId]: value }))
                  }} />
                  <Button variant="primary" type="submit" aria-label={t('sendMessage')} disabled={working !== null || currentChatWorking || currentMemoryWorking || message.trim() === ''} icon={<IconShareOutlineRegular size={14} />} />
                </form>
                <section className={css.sharedContext} aria-labelledby="yharness-shared-context-heading">
                  <div className={css.sharedContextHeader}>
                    <div>
                      <div className={css.sharedContextLabel} id="yharness-shared-context-heading">{t('sharedContextLabel')}</div>
                      <p className={css.sharedMemoryDescription}>{memory?.enabled === true ? t('sharedContextDescription') : t('sharedContextDisabled')}</p>
                    </div>
                    {memory?.enabled === true && <Tag tone="info">{t('sharedContextTag')}</Tag>}
                  </div>
                  {memory?.enabled === true && (
                    <>
                      <div className={css.sharedMemoryEntries}>
                        {memory.entries.length === 0 && <span className={css.shareEmpty}>{t('sharedContextEmpty')}</span>}
                        {memory.entries.map(entry => (
                          <p className={css.sharedMemoryEntry} key={entry.id}>{entry.text}</p>
                        ))}
                      </div>
                      <div className={css.sharedMemoryComposer}>
                        <Input
                          value={memoryDraft}
                          placeholder={t('sharedContextPlaceholder')}
                          aria-label={t('sharedContextPlaceholder')}
                          onChange={(event) => {
                            if (selectedBotId === null) return
                            const revision = (memoryDraftRevisionsRef.current[selectedBotId] ?? 0) + 1
                            memoryDraftRevisionsRef.current[selectedBotId] = revision
                            const value = event.currentTarget.value
                            setMemoryDrafts(current => ({ ...current, [selectedBotId]: value }))
                          }}
                        />
                        <Button
                          variant="outline"
                          disabled={working !== null || currentChatWorking || currentMemoryWorking || memoryDraft.trim() === ''}
                          onClick={() => { setMemoryAcknowledged(false); setMemoryConfirmOpen(true) }}
                          aria-label={t('publishSharedContext')}
                        >
                          {t('publishSharedContext')}
                        </Button>
                      </div>
                    </>
                  )}
                </section>
              </section>
            )}
          </div>
        )}
        {client.listGroups !== undefined && working !== 'list' && (
          <section className={css.sharedContext} aria-labelledby="yharness-shared-groups-heading">
            <div className={css.sharedContextHeader}>
              <div>
                <div className={css.sharedContextLabel} id="yharness-shared-groups-heading">{t('sharedGroupsTitle')}</div>
                <p className={css.sharedMemoryDescription}>{t('sharedGroupsDescription')}</p>
              </div>
              {groupWorking === 'load' && <span role="status" aria-label={t('sharedGroupLoading')}><StateDot state="ongoing" size={12} /></span>}
              {client.createGroup !== undefined && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={openCreateGroup}
                  disabled={groupWorking !== null || bots.length < 2}
                >
                  {t('sharedGroupCreate')}
                </Button>
              )}
            </div>
            {pendingMessages.length > 0 && (
              <div className={css.dialogNotice} role="status">
                <strong>{t('sharedGroupPendingMessagesTitle')}</strong>
                {pendingMessages.map((pending) => {
                  const pendingGroup = groups.find(group => String(group.id) === pending.groupId)
                  const label = pending.text ?? t('sharedGroupPendingMessageExpired')
                  const working = pendingMessageWorking === pending.id
                  return (
                    <div className={css.shareInviteRow} key={pending.id}>
                      <span>{pendingGroup?.name ?? pending.groupId}: {label}</span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={groupWorking !== null || pendingMessageWorking !== null || discardTarget !== null}
                        onClick={() => { void recoverPendingMessage(pending) }}
                      >
                        {working ? t('sharedGroupSending') : t('sharedGroupRecover')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={groupWorking !== null || pendingMessageWorking !== null || discardTarget !== null}
                        onClick={() => { requestDiscardMessage(pending) }}
                      >
                        {t('sharedGroupDiscardRecovery')}
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
            {groupWorking !== 'load' && groups.length === 0 && <div className={css.shareEmpty}>{t('sharedGroupsEmpty')}</div>}
            {groupWorking !== 'load' && groups.length > 0 && (
              <div className={css.sharedBotList} aria-label={t('sharedGroupsTitle')}>
                {groups.map(group => (
                  <button
                    type="button"
                    className={String(group.id) === selectedGroupId ? css.sharedBotSelected : css.sharedBot}
                    key={String(group.id)}
                    onClick={() => { setGroupSelection(String(group.id)); void readGroup(String(group.id)) }}
                  >
                    <span aria-hidden="true" className={css.shareMemberDot} />
                    <span><strong>{group.name}</strong><small>{group.bots.map(bot => bot.name).join(', ')}</small></span>
                  </button>
                ))}
              </div>
            )}
            {selectedGroup !== undefined && (
              <section className={css.sharedConversation} aria-label={selectedGroup.name}>
                <header className={css.sharedConversationHeader}>
                  <div><strong>{selectedGroup.name}</strong><small>{selectedGroup.bots.map(bot => bot.name).join(', ')}</small></div>
                  {client.createGroupInvite !== undefined && !groupInviteUnavailable && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { void createSharedGroupInvite() }}
                      disabled={groupInviteWorking || groupWorking !== null}
                    >
                      {groupInviteWorking ? t('sharedGroupInviteCreating') : t('sharedGroupInvite')}
                    </Button>
                  )}
                  {groupInviteUnavailable && <span className={css.shareMemberHint}>{t('sharedGroupInviteOwnerOnly')}</span>}
                </header>
                {groupInvite !== null && (
                  <div className={css.inviteCode}>
                    <code aria-label={t('sharedGroupInviteCodeLabel')}>{groupInvite.code}</code>
                    <Tooltip label={groupInviteCopied ? t('sharedGroupInviteCopied') : t('sharedGroupInviteCopy')} side="bottom" portal>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={groupInviteCopied ? t('sharedGroupInviteCopied') : t('sharedGroupInviteCopy')}
                        icon={<IconCopyOutlineRegular size={14} />}
                        onClick={() => {
                          const inviteCode = groupInvite.code
                          const inviteGeneration = groupInviteGenerationRef.current
                          setGroupInviteCopied(false)
                          void writeClipboard(inviteCode).then((success) => {
                            if (success && openRef.current && selectedGroupIdRef.current === String(selectedGroup.id)
                              && groupInviteGenerationRef.current === inviteGeneration) setGroupInviteCopied(true)
                          })
                        }}
                      />
                    </Tooltip>
                  </div>
                )}
                <div className={css.sharedTranscript}>
                  <div className={css.sharedContextLabel}>{t('sharedGroupsTitle')}</div>
                  {groupMessages.length === 0 && <span className={css.shareEmpty}>{t('sharedGroupTranscriptEmpty')}</span>}
                  {groupMessages.map((messageRow) => {
                    const sender = messageRow.sender.kind === 'bot'
                      ? t('sharedGroupBotAuthor', { name: messageRow.sender.name })
                      : messageRow.sender.principalId === undefined
                        ? t('you')
                        : t('sharedGroupAuthor', { id: String(messageRow.sender.principalId) })
                    return <p className={messageRow.sender.kind === 'user' ? css.sharedUserMessage : css.sharedBotMessage} key={String(messageRow.id)}><strong>{sender}</strong> {messageRow.text}</p>
                  })}
                </div>
                <form className={css.sharedComposer} onSubmit={(event) => { event.preventDefault(); void sendGroup() }}>
                  <Input
                    value={groupDraft}
                    placeholder={t('sharedGroupMessagePlaceholder', { name: selectedGroup.name })}
                    aria-label={t('sharedGroupMessagePlaceholder', { name: selectedGroup.name })}
                    onChange={(event) => { groupDraftRevisionRef.current += 1; setGroupDraft(event.currentTarget.value) }}
                  />
                  <Button
                    variant="primary"
                    type="submit"
                    disabled={groupWorking !== null || working !== null || groupDraft.trim() === '' || hasPendingChat || hasPendingMemory}
                    icon={<IconShareOutlineRegular size={14} />}
                  >
                    {groupWorking === 'send' ? t('sharedGroupSending') : t('sharedGroupSend')}
                  </Button>
                </form>
              </section>
            )}
          </section>
        )}
      </Modal>
      {client.createGroup !== undefined && (
        <SharedGroupCreateDialog
          open={open && createGroupOpen}
          onClose={closeCreateGroup}
          onCreate={createSharedGroup}
          onRecover={recoverPendingCreation}
          onRequestDiscard={requestDiscardCreation}
          bots={bots}
          pendingCreations={pendingCreations}
          recoveryWorking={recoveryWorking}
          error={createGroupError}
          t={t}
        />
      )}
      <RiskConfirmation
        open={open && memoryConfirmOpen && selected !== undefined}
        title={t('publishSharedContextTitle')}
        description={t('publishSharedContextDescription')}
        acknowledgeLabel={t('publishSharedContextAcknowledge')}
        cancelLabel={t('cancel')}
        closeLabel={t('cancel')}
        confirmLabel={t('publishSharedContext')}
        acknowledged={memoryAcknowledged}
        disabled={working !== null || currentChatWorking || currentMemoryWorking}
        onAcknowledgedChange={setMemoryAcknowledged}
        onCancel={() => { setMemoryConfirmOpen(false); setMemoryAcknowledged(false) }}
        onConfirm={() => { void publishMemory() }}
      />
      <RiskConfirmation
        open={open && discardTarget !== null}
        title={t('sharedGroupDiscardTitle')}
        description={t('sharedGroupDiscardDescription')}
        acknowledgeLabel={t('sharedGroupDiscardAcknowledge')}
        cancelLabel={t('cancel')}
        closeLabel={t('cancel')}
        confirmLabel={t('sharedGroupDiscardConfirm')}
        acknowledged={discardAcknowledged}
        disabled={discardWorking || recoveryWorking !== null || groupWorking !== null || pendingMessageWorking !== null}
        onAcknowledgedChange={setDiscardAcknowledged}
        onCancel={() => { setDiscardTarget(null); setDiscardAcknowledged(false) }}
        onConfirm={() => { void confirmDiscard() }}
      />
    </>
  )
}
