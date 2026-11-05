import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { brandString } from '@yharness/brand'
import { randomUUID } from '@yharness/util-crypto'
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
  BotSharedRosterFenceDiagnosticValue,
} from '@yharness/bots/client'
import { BotAvatar } from './BotAvatar.tsx'
import {
  BotGroupAttachments,
  BotGroupSentAttachments,
  createBotGroupAttachmentDraft,
  releaseBotGroupAttachment,
} from './BotGroupAttachments.tsx'
import css from './BotWorkspace.module.css'
import type { BotShareActions } from './controller.ts'
import {
  createSharedGroupPendingQueue,
  SharedGroupPendingQueueFullError,
} from './pending-group-queue.ts'
import type {
  SharedGroupPendingQueue,
  SharedPendingGroupMessage,
  SharedPendingGroupCreation,
} from './pending-group-queue.ts'
import type { BotGroupAttachmentDraft, BotSummary } from './types.ts'
import { broadcastSharedAuthChanged } from './shared-client.ts'
import type { SharedBotAuthChange, SharedBotGroupInviteValue, SharedBotsClient } from './shared-client.ts'

type Translate = PropsLocale<'bots'>['t']

interface SharedDialogAuthContext {
  readonly client: SharedBotsClient
  readonly clientGeneration: number
  readonly authGeneration: number
  readonly scope: string
}

class SharedDialogAuthChangedError extends Error {
  constructor() {
    super('Shared Bot authentication changed')
    this.name = 'SharedDialogAuthChangedError'
  }
}

function sharedGroupCreationKey(actionId: string, name: string, botIds: readonly string[]): string {
  return `${actionId}\u0000${name}\u0000${[...botIds].sort().join('\u0000')}`
}

function sharedGroupMessageKey(actionId: string, groupId: string, text: string): string {
  return `${actionId}\u0000${groupId}\u0000${text}`
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
  const [rosterFence, setRosterFence] = useState<BotSharedRosterFenceDiagnosticValue | null>(null)
  const [rosterFenceConfirmOpen, setRosterFenceConfirmOpen] = useState(false)
  const [rosterFenceAcknowledged, setRosterFenceAcknowledged] = useState(false)
  const [rosterFenceWorking, setRosterFenceWorking] = useState(false)
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
      if (actions.inspectRosterFence !== undefined) {
        const fence = await actions.inspectRosterFence()
        if (!isCurrentLoad()) return
        setRosterFence(fence)
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
      setRosterFence(null)
      setRosterFenceConfirmOpen(false)
      setRosterFenceAcknowledged(false)
      setRosterFenceWorking(false)
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
    setRosterFence(null)
    setRosterFenceConfirmOpen(false)
    setRosterFenceAcknowledged(false)
    setRosterFenceWorking(false)
    setError(null)
    void load(bot.id, viewGeneration)
  }, [bot.id, open])

  const recoverRosterFence = async (): Promise<void> => {
    const token = rosterFence?.status === 'held' ? rosterFence.token : undefined
    if (!stateMatchesBot || token === undefined || actions.recoverRosterFence === undefined
      || rosterFenceWorking || working !== null || memoryWorking) return
    const requestedBotId = bot.id
    const viewGeneration = viewGenerationRef.current
    setRosterFenceWorking(true)
    setError(null)
    try {
      const result = await actions.recoverRosterFence(token)
      if (!isCurrentView(requestedBotId, viewGeneration)) return
      if (result.status === 'released' || result.status === 'absent') {
        setRosterFence({ status: 'clear' })
        setRosterFenceConfirmOpen(false)
        setRosterFenceAcknowledged(false)
        return
      }
      setRosterFenceAcknowledged(false)
      setError(t('sharedRosterFenceBusy'))
      if (actions.inspectRosterFence !== undefined) {
        try {
          const current = await actions.inspectRosterFence()
          if (isCurrentView(requestedBotId, viewGeneration)) setRosterFence(current)
        } catch (refreshError: unknown) {
          if (isCurrentView(requestedBotId, viewGeneration)) {
            setError(refreshError instanceof Error ? refreshError.message : t('sharedRosterFenceRecoveryFailed'))
          }
        }
      }
    } catch (cause: unknown) {
      if (isCurrentView(requestedBotId, viewGeneration)) {
        setRosterFenceAcknowledged(false)
        setError(cause instanceof Error ? cause.message : t('sharedRosterFenceRecoveryFailed'))
      }
    } finally {
      if (isCurrentView(requestedBotId, viewGeneration)) setRosterFenceWorking(false)
    }
  }

  const createInvite = async (): Promise<void> => {
    if (!stateMatchesBot || working !== null || memoryWorking || rosterFenceWorking) return
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
    if (member.role === 'owner' || working !== null || memoryWorking || rosterFenceWorking) return
    const requestedBotId = bot.id
    const viewGeneration = viewGenerationRef.current
    const workingGeneration = workingGenerationRef.current + 1
    workingGenerationRef.current = workingGeneration
    setWorking('revoke')
    setError(null)
    try {
      broadcastSharedAuthChanged()
      await actions.revokeMember(requestedBotId, String(member.principalId))
      broadcastSharedAuthChanged()
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
    if (!openRef.current || !stateMatchesBot || memoryTarget === null || actions.setMemoryPolicy === undefined
      || memoryWorking || rosterFenceWorking) return
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

  const rosterFenceToken = rosterFence?.status === 'held' ? rosterFence.token : undefined

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
          <Button variant="primary" onClick={() => { void createInvite() }} disabled={!stateMatchesBot || working !== null || memoryWorking || rosterFenceWorking} icon={<IconLinkOutlineRegular size={14} />}>
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
                disabled={memoryWorking || working !== null || rosterFenceWorking}
                label={t('sharedMemoryToggle')}
                onChange={(next) => { setMemoryTarget(next); setMemoryAcknowledged(false) }}
              />
            </div>
          </section>
        )}
        {stateMatchesBot && actions.inspectRosterFence !== undefined && (
          <section className={css.sharedMemoryCard} aria-labelledby="yharness-shared-roster-fence-heading">
            <div className={css.sharedMemoryHeader}>
              <span className={css.sharedMemoryIcon} aria-hidden="true"><IconShieldOutlineRegular size={16} /></span>
              <div>
                <div className={css.shareSectionHeading} id="yharness-shared-roster-fence-heading">{t('sharedRosterFenceLabel')}</div>
                <p className={css.sharedMemoryDescription}>
                  {rosterFence === null
                    ? t('sharedRosterFenceLoading')
                    : rosterFence.status === 'held'
                      ? t('sharedRosterFenceHeld')
                      : t('sharedRosterFenceClear')}
                </p>
              </div>
            </div>
            {rosterFenceToken !== undefined && (
              <div className={css.shareInviteRow}>
                <div className={css.inviteCode}>
                  <code aria-label={t('sharedRosterFenceTokenLabel')}>{rosterFenceToken}</code>
                </div>
                {actions.recoverRosterFence !== undefined && (
                  <Button
                    variant="outline"
                    disabled={working !== null || memoryWorking || rosterFenceWorking}
                    onClick={() => { setRosterFenceAcknowledged(false); setRosterFenceConfirmOpen(true) }}
                  >
                    {rosterFenceWorking ? t('recoveringSharedRoster') : t('recoverSharedRoster')}
                  </Button>
                )}
              </div>
            )}
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
                    <Button variant="ghost" size="sm" aria-label={`${t('revokeMember')}: ${String(member.principalId)}`} icon={<IconTrashOutlineRegular size={14} />} disabled={working !== null || memoryWorking || rosterFenceWorking} onClick={() => { void revoke(member) }} />
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
        disabled={!stateMatchesBot || memoryWorking || rosterFenceWorking}
        onAcknowledgedChange={setMemoryAcknowledged}
        onCancel={() => { setMemoryTarget(null); setMemoryAcknowledged(false) }}
        onConfirm={() => { void confirmMemoryPolicy() }}
      />
      <RiskConfirmation
        open={stateMatchesBot && rosterFenceConfirmOpen && rosterFenceToken !== undefined}
        title={t('recoverSharedRosterTitle')}
        description={t('recoverSharedRosterDescription', { token: rosterFenceToken ?? '' })}
        acknowledgeLabel={t('recoverSharedRosterAcknowledge')}
        cancelLabel={t('cancel')}
        closeLabel={t('cancel')}
        confirmLabel={t('recoverRoster')}
        acknowledged={rosterFenceAcknowledged}
        disabled={!stateMatchesBot || rosterFenceWorking}
        onAcknowledgedChange={setRosterFenceAcknowledged}
        onCancel={() => { setRosterFenceConfirmOpen(false); setRosterFenceAcknowledged(false) }}
        onConfirm={() => { void recoverRosterFence() }}
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
  pendingCatalogReady,
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
  readonly pendingCatalogReady: boolean
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
    if (!pendingCatalogReady || recoveryWorking !== null || trimmed === '' || botIds.length < 2 || botIds.length > 6 || submitting) return
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
            disabled={!pendingCatalogReady || name.trim() === '' || selected.length < 2 || selected.length > 6 || submitting || recoveryWorking !== null}
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
                <Button variant="outline" size="sm" disabled={!pendingCatalogReady || recoveryWorking !== null || submitting} onClick={() => { void onRecover(creation) }}>
                  {working ? t('sharedGroupRecovering') : t('sharedGroupRecover')}
                </Button>
                <Button variant="ghost" size="sm" disabled={!pendingCatalogReady || recoveryWorking !== null || submitting} onClick={() => { onRequestDiscard(creation) }}>
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

export function SharedBotsDialog({ client, open, onClose, ownerMode = false, t }: {
  readonly client: SharedBotsClient
  readonly open: boolean
  readonly onClose: () => void
  /** Start the Host-authenticated owner bootstrap before loading the shared workspace. */
  readonly ownerMode?: boolean
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
  const [groupAttachments, setGroupAttachments] = useState<readonly BotGroupAttachmentDraft[]>([])
  const [groupAttachmentError, setGroupAttachmentError] = useState<string | null>(null)
  const [groupWorking, setGroupWorking] = useState<'load' | 'create' | 'send' | null>(null)
  const [createGroupOpen, setCreateGroupOpen] = useState(false)
  const [createGroupError, setCreateGroupError] = useState<string | null>(null)
  const [pendingCreations, setPendingCreations] = useState<readonly SharedPendingGroupCreation[]>([])
  const [pendingMessages, setPendingMessages] = useState<readonly SharedPendingGroupMessage[]>([])
  const [pendingCatalogReady, setPendingCatalogReady] = useState(false)
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
  const [working, setWorking] = useState<'list' | 'enroll' | 'owner' | null>(null)
  const [chatWorkingBotIds, setChatWorkingBotIds] = useState<ReadonlySet<string>>(new Set())
  const [memoryWorkingBotIds, setMemoryWorkingBotIds] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [, setAuthRevision] = useState(0)
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
  const groupAttachmentsRef = useRef<readonly BotGroupAttachmentDraft[]>([])
  const groupAttachmentMessageIdRef = useRef<string | null>(null)
  const groupAttachmentDraftTextRef = useRef<string | null>(null)
  const createGroupGenerationRef = useRef(0)
  const pendingRefreshGenerationRef = useRef(0)
  const recoveryWorkingRef = useRef<string | null>(null)
  const revalidationAttemptRef = useRef(0)
  const pendingMessageOperationRef = useRef<{ readonly id: string; readonly token: number } | null>(null)
  const pendingMessageOperationTokenRef = useRef(0)
  const chatOperationTokensRef = useRef<Record<string, number>>({})
  const memoryOperationTokensRef = useRef<Record<string, number>>({})
  const pendingGroupQueueRef = useRef<{ readonly scope: string; readonly queue: SharedGroupPendingQueue } | null>(null)
  const enrollmentOperationTokenRef = useRef(0)
  const enrollmentInFlightRef = useRef(false)
  const enrollmentSubmittedCodeRevisionRef = useRef<number | null>(null)
  const enrollmentClientRef = useRef<SharedBotsClient | null>(null)
  const deferredRevalidationRef = useRef(false)
  const clientIdentityRef = useRef(client)
  const clientGenerationRef = useRef(0)
  groupAttachmentsRef.current = groupAttachments
  if (clientIdentityRef.current !== client) {
    clientIdentityRef.current = client
    clientGenerationRef.current += 1
  }
  const observedClientRef = useRef(client)
  const observedScopeRef = useRef<string | undefined>(client.retryScope)
  const observedAuthGenerationRef = useRef<number | undefined>(client.authGeneration)
  const authGenerationRef = useRef(0)
  const beginPendingMessageOperation = (id: string): number => {
    const token = pendingMessageOperationTokenRef.current + 1
    pendingMessageOperationTokenRef.current = token
    pendingMessageOperationRef.current = { id, token }
    setPendingMessageWorking(id)
    return token
  }
  const finishPendingMessageOperation = (id: string, token: number): void => {
    if (pendingMessageOperationRef.current?.id === id && pendingMessageOperationRef.current.token === token) {
      pendingMessageOperationRef.current = null
      setPendingMessageWorking(null)
    }
  }
  const clearPendingRetryState = (): void => {
    setPendingCreations([])
    setPendingMessages([])
    if (recoveryWorkingRef.current === null) setRecoveryWorking(null)
    setDiscardTarget(null)
    setDiscardAcknowledged(false)
  }
  const invalidatePendingRetryState = (): void => {
    pendingRefreshGenerationRef.current += 1
    clearPendingRetryState()
  }
  const resetPendingScopeIfChanged = (scope: string | undefined): void => {
    if (pendingGroupQueueRef.current?.scope === scope) return
    if (pendingGroupQueueRef.current !== null) {
      pendingGroupQueueRef.current = null
      invalidatePendingRetryState()
    }
  }
  const getPendingGroupQueue = (expectedAuth?: SharedDialogAuthContext): SharedGroupPendingQueue => {
    const auth = requireCurrentAuth(expectedAuth)
    const scope = auth.scope
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
  const retryErrorMessage = (cause: unknown, fallback: string): string => (
    cause instanceof SharedGroupPendingQueueFullError
      ? t('sharedGroupRetryQuota')
      : cause instanceof Error ? cause.message : fallback
  )
  const message = selectedBotId === null ? '' : messageDrafts[selectedBotId] ?? ''
  const memoryDraft = selectedBotId === null ? '' : memoryDrafts[selectedBotId] ?? ''
  const hasPendingChat = chatWorkingBotIds.size > 0
  const hasPendingMemory = memoryWorkingBotIds.size > 0
  const pendingMessageBusy = pendingMessageWorking !== null || pendingMessageOperationRef.current !== null
  const recoveryBusy = recoveryWorking !== null || recoveryWorkingRef.current !== null
  const currentChatWorking = selectedBotId !== null && chatWorkingBotIds.has(selectedBotId)
  const currentMemoryWorking = selectedBotId !== null && memoryWorkingBotIds.has(selectedBotId)

  const isCurrentLifecycle = (generation: number): boolean => openRef.current && lifecycleGenerationRef.current === generation
  const isCurrentOperation = (lifecycleGeneration: number, operationGeneration: number): boolean => (
    isCurrentLifecycle(lifecycleGeneration) && operationGenerationRef.current === operationGeneration
  )
  const isCurrentSelection = (botId: string, selectionEpoch: number): boolean => (
    openRef.current && selectedBotIdRef.current === botId && selectionEpochRef.current === selectionEpoch
  )

  const clearGroupAttachments = (): void => {
    for (const attachment of groupAttachmentsRef.current) releaseBotGroupAttachment(attachment)
    groupAttachmentsRef.current = []
    groupAttachmentMessageIdRef.current = null
    groupAttachmentDraftTextRef.current = null
    setGroupAttachments([])
    setGroupAttachmentError(null)
  }

  const addGroupAttachments = (files: readonly File[]): void => {
    setGroupAttachmentError(null)
    groupAttachmentMessageIdRef.current = null
    groupAttachmentDraftTextRef.current = null
    setGroupAttachments(current => [...current, ...files.map(createBotGroupAttachmentDraft)])
  }

  const removeGroupAttachment = (id: string): void => {
    const removed = groupAttachmentsRef.current.find(attachment => attachment.id === id)
    if (removed !== undefined) releaseBotGroupAttachment(removed)
    setGroupAttachmentError(null)
    groupAttachmentMessageIdRef.current = null
    groupAttachmentDraftTextRef.current = null
    setGroupAttachments(current => current.filter(attachment => attachment.id !== id))
  }

  const setSelection = (botId: string | null): void => {
    if (selectedBotIdRef.current !== botId) selectionEpochRef.current += 1
    if (botId !== null && selectedGroupIdRef.current !== null) {
      groupOperationGenerationRef.current += 1
      groupDraftRevisionRef.current += 1
      groupInviteGenerationRef.current += 1
      setGroupWorking(null)
      setGroupInvite(null)
      setGroupInviteCopied(false)
      setGroupInviteWorking(false)
      setGroupInviteUnavailable(false)
    }
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
      clearGroupAttachments()
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

  const enrollmentCodeRevisionToPreserve = (): number | undefined => (
    enrollmentInFlightRef.current && enrollmentClientRef.current === clientIdentityRef.current
      ? enrollmentSubmittedCodeRevisionRef.current ?? undefined
      : undefined
  )

  const clearAuthenticatedState = (
    nextError: string | null = null,
    preserveCodeRevision?: number,
  ): void => {
    operationGenerationRef.current += 1
    groupOperationGenerationRef.current += 1
    createGroupGenerationRef.current += 1
    groupInviteGenerationRef.current += 1
    readGenerationRef.current += 1
    groupReadGenerationRef.current += 1
    pendingGroupQueueRef.current = null
    invalidatePendingRetryState()
    setBots([])
    setSelection(null)
    setGroups([])
    setGroupSelection(null)
    clearGroupAttachments()
    setGroupMessages([])
    setMessageDrafts({})
    setMemoryDrafts({})
    setGroupDraft('')
    if (preserveCodeRevision === undefined || codeRevisionRef.current <= preserveCodeRevision) {
      setCode('')
      codeRevisionRef.current += 1
    }
    messageDraftRevisionsRef.current = {}
    memoryDraftRevisionsRef.current = {}
    setRecent([])
    setMemory(null)
    setMemoryConfirmOpen(false)
    setMemoryAcknowledged(false)
    setCreateGroupOpen(false)
    setCreateGroupError(null)
    setPendingCatalogReady(false)
    setGroupInvite(null)
    setGroupInviteCopied(false)
    setGroupInviteWorking(false)
    setGroupInviteUnavailable(false)
    setWorking(null)
    setGroupWorking(null)
    setChatWorkingBotIds(new Set())
    setMemoryWorkingBotIds(new Set())
    setDiscardWorking(false)
    setError(nextError)
  }

  const syncAuthContext = (): SharedDialogAuthContext | undefined => {
    const currentClient = clientIdentityRef.current
    const scope = currentClient.retryScope
    const authGeneration = currentClient.authGeneration
    const changed = observedClientRef.current !== currentClient || observedScopeRef.current !== scope
      || observedAuthGenerationRef.current !== authGeneration
    if (changed) {
      observedClientRef.current = currentClient
      observedScopeRef.current = scope
      observedAuthGenerationRef.current = authGeneration
      authGenerationRef.current += 1
      clearAuthenticatedState(undefined, enrollmentCodeRevisionToPreserve())
    }
    if (scope === undefined) return undefined
    return {
      client: currentClient,
      clientGeneration: clientGenerationRef.current,
      authGeneration: authGenerationRef.current,
      scope,
    }
  }

  const isCurrentClient = (context: Pick<SharedDialogAuthContext, 'client' | 'clientGeneration'>): boolean => (
    clientIdentityRef.current === context.client && clientGenerationRef.current === context.clientGeneration
  )

  const hasCurrentAuth = (context: SharedDialogAuthContext): boolean => (
    isCurrentClient(context)
    && authGenerationRef.current === context.authGeneration
    && clientIdentityRef.current.retryScope === context.scope
  )

  const isSameAuthContext = (left: SharedDialogAuthContext | undefined, right: SharedDialogAuthContext): boolean => (
    left !== undefined
    && left.client === right.client
    && left.clientGeneration === right.clientGeneration
    && left.authGeneration === right.authGeneration
    && left.scope === right.scope
  )

  const isCurrentAuth = (context: SharedDialogAuthContext): boolean => isSameAuthContext(syncAuthContext(), context)

  const requireCurrentAuth = (expected?: SharedDialogAuthContext): SharedDialogAuthContext => {
    const current = syncAuthContext()
    if (current === undefined || (expected !== undefined && !isSameAuthContext(current, expected))) {
      throw new SharedDialogAuthChangedError()
    }
    return current
  }

  const readGroup = async (groupId: string): Promise<void> => {
    const auth = syncAuthContext()
    const inspect = auth?.client.inspectGroup
    if (auth === undefined || inspect === undefined) return
    const generation = groupReadGenerationRef.current + 1
    groupReadGenerationRef.current = generation
    selectedGroupIdRef.current = groupId
    setGroupMessages([])
    try {
      if (!isCurrentAuth(auth)) return
      const result = await inspect(groupId)
      if (!isCurrentAuth(auth) || !openRef.current || generation !== groupReadGenerationRef.current
        || selectedGroupIdRef.current !== groupId) return
      if (result.ok) setGroupMessages(result.value.messages)
      else if (result.error.code === 'gateway/forbidden') requestRevalidation(true, result.error.message)
      else setError(result.error.message || t('sharedGroupLoadFailed'))
    } catch (cause: unknown) {
      if (isCurrentAuth(auth) && openRef.current && generation === groupReadGenerationRef.current
        && selectedGroupIdRef.current === groupId) {
        setError(cause instanceof Error ? cause.message : t('sharedGroupLoadFailed'))
      }
    }
  }

  const refresh = async (): Promise<void> => {
    if (!openRef.current) return
    syncAuthContext()
    const admittedRevalidationAttempt = revalidationAttemptRef.current
    const lifecycleGeneration = lifecycleGenerationRef.current
    const clientContext = { client, clientGeneration: clientGenerationRef.current }
    const admissionAuthGeneration = clientIdentityRef.current.authGeneration
    const admissionScope = clientIdentityRef.current.retryScope
    const refreshGeneration = refreshGenerationRef.current + 1
    refreshGenerationRef.current = refreshGeneration
    let refreshAuth: SharedDialogAuthContext | undefined
    let refreshCompleted = false
    pendingGroupQueueRef.current = null
    invalidatePendingRetryState()
    setWorking(ownerMode ? 'owner' : 'list')
    setError(null)
    setGroups([])
    setGroupSelection(null)
    setGroupMessages([])
    try {
      if (ownerMode) {
        const enrollOwner = client.enrollOwner
        const getOwnerCapability = client.getOwnerCapability
        if (enrollOwner === undefined || getOwnerCapability === undefined) {
          setError(t('sharedOwnerSetupUnavailable'))
          return
        }
        const capability = await getOwnerCapability()
        if (!isCurrentClient(clientContext) || !isCurrentLifecycle(lifecycleGeneration)
          || refreshGenerationRef.current !== refreshGeneration) return
        if (!capability.ownerBootstrap) {
          setError(t('sharedOwnerSetupUnavailable'))
          return
        }
        const owner = await enrollOwner()
        if (!isCurrentClient(clientContext) || !isCurrentLifecycle(lifecycleGeneration)
          || refreshGenerationRef.current !== refreshGeneration) return
        if (!owner.ok) {
          setError(owner.error.message || t('sharedOwnerSetupFailed'))
          return
        }
        setWorking('list')
      }
      try {
        if (!isCurrentClient(clientContext)) return
        const restored = await client.restoreRetryScope()
        if (!isCurrentClient(clientContext) || !isCurrentLifecycle(lifecycleGeneration)
          || refreshGenerationRef.current !== refreshGeneration) return
        if (!restored.ok) {
          if (clientIdentityRef.current.authGeneration === admissionAuthGeneration
            && clientIdentityRef.current.retryScope === admissionScope) {
            clearAuthenticatedState(restored.error.message || t('sharedGroupRetryIdentityUnavailable'), enrollmentCodeRevisionToPreserve())
          } else if (restored.error.code === 'gateway/forbidden') {
            requestRevalidation(true, restored.error.message)
          } else {
            syncAuthContext()
          }
          return
        }
      } catch (cause: unknown) {
        if (isCurrentClient(clientContext) && clientIdentityRef.current.authGeneration === admissionAuthGeneration
          && clientIdentityRef.current.retryScope === admissionScope && isCurrentLifecycle(lifecycleGeneration)
          && refreshGenerationRef.current === refreshGeneration) {
          clearAuthenticatedState(cause instanceof Error ? cause.message : t('sharedGroupRetryIdentityUnavailable'), enrollmentCodeRevisionToPreserve())
        }
        return
      }
      const auth = syncAuthContext()
      refreshAuth = auth
      if (auth === undefined || !isCurrentClient(clientContext)) {
        clearAuthenticatedState(t('sharedGroupRetryIdentityUnavailable'), enrollmentCodeRevisionToPreserve())
        return
      }
      const result = await auth.client.list()
      if (!isCurrentAuth(auth) || !isCurrentLifecycle(lifecycleGeneration) || refreshGenerationRef.current !== refreshGeneration) return
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
        if (!isCurrentAuth(auth) || !isCurrentLifecycle(lifecycleGeneration) || refreshGenerationRef.current !== refreshGeneration) return
        const listGroups = auth.client.listGroups
        if (listGroups !== undefined) {
          setGroupWorking('load')
          try {
            const groupsResult = await listGroups()
            if (!isCurrentAuth(auth) || !isCurrentLifecycle(lifecycleGeneration)
              || refreshGenerationRef.current !== refreshGeneration) return
            if (groupsResult.ok) {
              setGroups(groupsResult.value.groups)
              const currentGroupId = selectedGroupIdRef.current
              const nextGroupId = currentGroupId !== null && groupsResult.value.groups.some(group => String(group.id) === currentGroupId)
                ? currentGroupId
                : groupsResult.value.groups[0] === undefined ? null : String(groupsResult.value.groups[0].id)
              setGroupSelection(nextGroupId)
              if (nextGroupId !== null) await readGroup(nextGroupId)
              await refreshPendingOperations()
            } else if (groupsResult.error.code === 'gateway/forbidden') {
              requestRevalidation(true, groupsResult.error.message)
            } else {
              setError(groupsResult.error.message || t('sharedGroupLoadFailed'))
            }
          } finally {
            if (isCurrentAuth(auth) && isCurrentLifecycle(lifecycleGeneration)
              && refreshGenerationRef.current === refreshGeneration) {
              setGroupWorking(current => current === 'load' ? null : current)
            }
          }
        }
        refreshCompleted = true
      } else {
        if (result.error.code === 'gateway/unauthorized') clearAuthenticatedState(result.error.message, enrollmentCodeRevisionToPreserve())
        else if (result.error.code === 'gateway/forbidden') requestRevalidation(true, result.error.message)
        else setError(result.error.message)
      }
    } catch (cause: unknown) {
      if (isCurrentClient(clientContext) && refreshAuth !== undefined && isCurrentAuth(refreshAuth)
        && isCurrentLifecycle(lifecycleGeneration) && refreshGenerationRef.current === refreshGeneration) {
        setError(cause instanceof Error ? cause.message : t('shareError'))
      }
    } finally {
      if (refreshCompleted && revalidationAttemptRef.current === admittedRevalidationAttempt) {
        revalidationAttemptRef.current = 0
      }
      if (isCurrentClient(clientContext) && (refreshAuth === undefined || isCurrentAuth(refreshAuth))
        && isCurrentLifecycle(lifecycleGeneration) && refreshGenerationRef.current === refreshGeneration) {
        setWorking(current => current === 'list' || current === 'owner' ? null : current)
      }
    }
  }

  const requestRevalidation = (
    immediate: boolean,
    nextError: string | null = null,
    resetAttempt = false,
    preserveCodeRevision?: number,
  ): void => {
    if (!openRef.current) return
    if (resetAttempt) revalidationAttemptRef.current = 0
    const attempt = revalidationAttemptRef.current + 1
    revalidationAttemptRef.current = attempt
    if (enrollmentInFlightRef.current) {
      deferredRevalidationRef.current = true
      if (immediate) {
        authGenerationRef.current += 1
        clearAuthenticatedState(nextError, preserveCodeRevision ?? enrollmentCodeRevisionToPreserve())
      }
      return
    }
    authGenerationRef.current += 1
    clearAuthenticatedState(nextError, preserveCodeRevision ?? enrollmentCodeRevisionToPreserve())
    if (attempt > 1) return
    void refresh()
  }

  const readBot = async (botId: string): Promise<void> => {
    const auth = syncAuthContext()
    if (auth === undefined) {
      clearAuthenticatedState(t('sharedGroupRetryIdentityUnavailable'))
      return
    }
    const generation = readGenerationRef.current + 1
    readGenerationRef.current = generation
    selectedBotIdRef.current = botId
    setRecent([])
    setMemory(null)
    setMemoryConfirmOpen(false)
    setMemoryAcknowledged(false)
    setError(null)
    try {
      if (!isCurrentAuth(auth)) return
      const [privateResult, memoryResult] = await Promise.all([
        auth.client.readPrivateChat(botId),
        auth.client.readMemory(botId),
      ])
      if (!isCurrentAuth(auth) || generation !== readGenerationRef.current || selectedBotIdRef.current !== botId) return
      const forbiddenError = !privateResult.ok && privateResult.error.code === 'gateway/forbidden'
        ? privateResult.error
        : !memoryResult.ok && memoryResult.error.code === 'gateway/forbidden' ? memoryResult.error : undefined
      if (forbiddenError !== undefined) {
        requestRevalidation(true, forbiddenError.message)
        return
      }
      if (privateResult.ok) setRecent(privateResult.value.recent)
      else setError(privateResult.error.message)
      if (memoryResult.ok) setMemory(memoryResult.value)
      else setError(memoryResult.error.message)
    } catch (cause: unknown) {
      if (isCurrentAuth(auth) && generation === readGenerationRef.current && selectedBotIdRef.current === botId) {
        setError(cause instanceof Error ? cause.message : t('sharedChatFailed'))
      }
    }
  }

  async function refreshPendingOperations(): Promise<void> {
    const lifecycleGeneration = lifecycleGenerationRef.current
    const refreshGeneration = pendingRefreshGenerationRef.current + 1
    pendingRefreshGenerationRef.current = refreshGeneration
    setPendingCatalogReady(false)
    const auth = syncAuthContext()
    if (auth === undefined) {
      clearPendingRetryState()
      return
    }
    try {
      const queue = getPendingGroupQueue(auth)
      const [creations, messages] = await Promise.all([queue.listCreations(), queue.listMessages()])
      if (!isCurrentLifecycle(lifecycleGeneration) || pendingRefreshGenerationRef.current !== refreshGeneration
        || !isCurrentAuth(auth) || pendingGroupQueueRef.current?.scope !== auth.scope) return
      setPendingCreations(creations)
      setPendingMessages(messages)
      setPendingCatalogReady(true)
    } catch (cause: unknown) {
      if (isCurrentLifecycle(lifecycleGeneration) && pendingRefreshGenerationRef.current === refreshGeneration
        && isCurrentAuth(auth) && createGroupOpen) {
        setCreateGroupError(retryErrorMessage(cause, t('sharedGroupRetryUnavailable')))
      }
    }
  }

  const openCreateGroup = (): void => {
    const createGeneration = createGroupGenerationRef.current + 1
    createGroupGenerationRef.current = createGeneration
    setCreateGroupError(null)
    setCreateGroupOpen(true)
  }

  const closeCreateGroup = (): void => {
    createGroupGenerationRef.current += 1
    groupReadGenerationRef.current += 1
    setCreateGroupOpen(false)
    setCreateGroupError(null)
    setRecoveryWorking(() => recoveryWorkingRef.current)
    setGroupWorking(current => current === 'create' ? null : current)
  }

  const reconcileGroupCreation = async (
    id: BotGroupIdType,
    name: string,
    botIds: readonly string[],
    auth: SharedDialogAuthContext,
  ): Promise<BotGroupView | undefined> => {
    const listGroups = auth.client.listGroups
    if (listGroups === undefined) throw new Error(t('sharedGroupRetryUnavailable'))
    if (!isCurrentAuth(auth)) throw new SharedDialogAuthChangedError()
    const result = await listGroups()
    if (!isCurrentAuth(auth)) throw new SharedDialogAuthChangedError()
    if (!result.ok) {
      if (result.error.code === 'gateway/forbidden') requestRevalidation(true, result.error.message)
      throw new SharedDialogAuthChangedError()
    }
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

  const reconcileGroupMessage = async (
    groupId: string,
    messageId: BotGroupMessageIdType,
    text: string,
    auth: SharedDialogAuthContext,
  ): Promise<void> => {
    const inspectGroup = auth.client.inspectGroup
    if (inspectGroup === undefined) throw new Error(t('sharedGroupRetryUnavailable'))
    if (!isCurrentAuth(auth)) throw new SharedDialogAuthChangedError()
    const result = await inspectGroup(groupId)
    if (!isCurrentAuth(auth)) throw new SharedDialogAuthChangedError()
    if (!result.ok) {
      if (result.error.code === 'gateway/forbidden') requestRevalidation(true, result.error.message)
      throw new SharedDialogAuthChangedError()
    }
    const existing = result.value.messages.find(messageRow => String(messageRow.id) === String(messageId))
    if (existing === undefined) return
    const principalId = auth.scope
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
      deferredRevalidationRef.current = false
      revalidationAttemptRef.current = 0
      clearAuthenticatedState()
      return
    }
    if (enrollmentInFlightRef.current) {
      deferredRevalidationRef.current = true
      return
    }
    setError(null)
    void refresh()
  }, [open, client, ownerMode])

  useEffect(() => () => {
    for (const attachment of groupAttachmentsRef.current) releaseBotGroupAttachment(attachment)
  }, [])

  useEffect(() => {
    const unsubscribe = client.subscribeAuth?.((change?: SharedBotAuthChange) => {
      if (change?.source === 'local' && enrollmentInFlightRef.current) return
      if (change?.source === 'local' && change.reason === 'authenticated') return
      if (change?.source === 'remote') {
        requestRevalidation(true, null, true)
        return
      }
      syncAuthContext()
      setAuthRevision(current => current + 1)
    })
    return unsubscribe
  }, [client])

  useEffect(() => {
    const revalidate = (): void => {
      if (!openRef.current) return
      requestRevalidation(false, null, true)
    }
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') revalidate()
    }
    window.addEventListener('focus', revalidate)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('focus', revalidate)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [client])

  const enroll = async (): Promise<void> => {
    const submittedCode = code
    const trimmed = submittedCode.trim()
    if (!openRef.current || trimmed === '' || working !== null || groupWorking !== null || hasPendingChat || hasPendingMemory
      || enrollmentInFlightRef.current) return
    const submittedCodeRevision = codeRevisionRef.current
    const lifecycleGeneration = lifecycleGenerationRef.current
    const clientContext = { client, clientGeneration: clientGenerationRef.current }
    const operationGeneration = operationGenerationRef.current + 1
    const enrollmentToken = enrollmentOperationTokenRef.current + 1
    enrollmentOperationTokenRef.current = enrollmentToken
    enrollmentInFlightRef.current = true
    enrollmentSubmittedCodeRevisionRef.current = submittedCodeRevision
    enrollmentClientRef.current = client
    operationGenerationRef.current = operationGeneration
    setWorking('enroll')
    setError(null)
    try {
      if (!isCurrentClient(clientContext)) return
      const result = await clientContext.client.enroll(trimmed)
      if (!isCurrentClient(clientContext) || !isCurrentOperation(lifecycleGeneration, operationGeneration)) return
      if (result.ok) {
        resetPendingScopeIfChanged(result.value.principalId)
        if (codeRevisionRef.current === submittedCodeRevision) setCode('')
        await refresh()
      } else {
        clearAuthenticatedState(result.error.message || t('sharedEnrollmentFailed'), enrollmentCodeRevisionToPreserve())
      }
    } catch (cause: unknown) {
      if (enrollmentOperationTokenRef.current === enrollmentToken
        && isCurrentClient(clientContext) && isCurrentOperation(lifecycleGeneration, operationGeneration)) {
        clearAuthenticatedState(cause instanceof Error ? cause.message : t('sharedEnrollmentFailed'), enrollmentCodeRevisionToPreserve())
      }
    } finally {
      if (enrollmentOperationTokenRef.current === enrollmentToken) {
        const preserveCodeRevision = enrollmentSubmittedCodeRevisionRef.current ?? undefined
        enrollmentInFlightRef.current = false
        enrollmentSubmittedCodeRevisionRef.current = null
        enrollmentClientRef.current = null
        setWorking(current => current === 'enroll' ? null : current)
        if (deferredRevalidationRef.current) {
          deferredRevalidationRef.current = false
          requestRevalidation(true, null, true, preserveCodeRevision)
        }
      }
    }
  }

  const send = async (): Promise<void> => {
    if (!openRef.current || selectedBotId === null || message.trim() === '' || working !== null || currentChatWorking || currentMemoryWorking) return
    const auth = syncAuthContext()
    if (auth === undefined) return
    const botId = selectedBotId
    const submittedMessageRevision = messageDraftRevisionsRef.current[botId] ?? 0
    const selectionEpoch = selectionEpochRef.current
    const lifecycleGeneration = lifecycleGenerationRef.current
    const chatOperationToken = (chatOperationTokensRef.current[botId] ?? 0) + 1
    chatOperationTokensRef.current[botId] = chatOperationToken
    const operationGeneration = operationGenerationRef.current + 1
    operationGenerationRef.current = operationGeneration
    setChatWorkingBotIds(current => updatePendingBotIds(current, botId, true))
    setError(null)
    try {
      if (!isCurrentAuth(auth)) return
      const result = await auth.client.chat(botId, message.trim())
      const currentSelection = isCurrentAuth(auth) && isCurrentSelection(botId, selectionEpoch)
      if (result.ok) {
        const canClearDraft = hasCurrentAuth(auth) && lifecycleGenerationRef.current === lifecycleGeneration
          && (selectedBotIdRef.current !== botId || selectionEpochRef.current === selectionEpoch)
        if (canClearDraft && (messageDraftRevisionsRef.current[botId] ?? 0) === submittedMessageRevision) {
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
      } else if (currentSelection && result.error.code === 'gateway/forbidden') {
        requestRevalidation(true, result.error.message)
      } else if (currentSelection) {
        setError(result.error.message || t('sharedChatFailed'))
      }
    } catch (cause: unknown) {
      if (isCurrentAuth(auth) && isCurrentSelection(botId, selectionEpoch)) {
        setError(cause instanceof Error ? cause.message : t('sharedChatFailed'))
      }
    } finally {
      if (hasCurrentAuth(auth) && chatOperationTokensRef.current[botId] === chatOperationToken) {
        setChatWorkingBotIds(current => updatePendingBotIds(current, botId, false))
      }
    }
  }

  const publishMemory = async (): Promise<void> => {
    if (!openRef.current || selectedBotId === null || !bots.some(bot => String(bot.id) === selectedBotId)
      || memoryDraft.trim() === '' || working !== null || currentChatWorking || currentMemoryWorking || memory?.enabled !== true) return
    const auth = syncAuthContext()
    if (auth === undefined) return
    const botId = selectedBotId
    const submittedDraftRevision = memoryDraftRevisionsRef.current[botId] ?? 0
    const selectionEpoch = selectionEpochRef.current
    const lifecycleGeneration = lifecycleGenerationRef.current
    const memoryOperationToken = (memoryOperationTokensRef.current[botId] ?? 0) + 1
    memoryOperationTokensRef.current[botId] = memoryOperationToken
    const operationGeneration = operationGenerationRef.current + 1
    operationGenerationRef.current = operationGeneration
    setMemoryWorkingBotIds(current => updatePendingBotIds(current, botId, true))
    setError(null)
    try {
      if (!isCurrentAuth(auth)) return
      const result = await auth.client.writeMemory(botId, memoryDraft.trim())
      const currentSelection = isCurrentAuth(auth) && isCurrentSelection(botId, selectionEpoch)
      if (result.ok) {
        const canClearDraft = hasCurrentAuth(auth) && lifecycleGenerationRef.current === lifecycleGeneration
          && (selectedBotIdRef.current !== botId || selectionEpochRef.current === selectionEpoch)
        if (canClearDraft && (memoryDraftRevisionsRef.current[botId] ?? 0) === submittedDraftRevision) {
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
      } else if (currentSelection && result.error.code === 'gateway/forbidden') {
        requestRevalidation(true, result.error.message)
      } else if (currentSelection) {
        setError(result.error.message || t('sharedMemoryWriteFailed'))
      }
    } catch (cause: unknown) {
      if (isCurrentAuth(auth) && isCurrentSelection(botId, selectionEpoch)) {
        setError(cause instanceof Error ? cause.message : t('sharedMemoryWriteFailed'))
      }
    } finally {
      if (hasCurrentAuth(auth) && memoryOperationTokensRef.current[botId] === memoryOperationToken) {
        setMemoryWorkingBotIds(current => updatePendingBotIds(current, botId, false))
      }
    }
  }

  const createSharedGroup = async (request: BotGroupCreateRequest): Promise<void> => {
    const auth = syncAuthContext()
    const create = auth?.client.createGroup
    const lifecycleGeneration = lifecycleGenerationRef.current
    if (auth === undefined || create === undefined || !isCurrentLifecycle(lifecycleGeneration)
      || !pendingCatalogReady || recoveryWorkingRef.current !== null) return
    const name = request.name.trim()
    const botIds = request.botIds.map(String)
    const pendingKey = sharedGroupCreationKey(randomUUID(), name, botIds)
    const createGeneration = createGroupGenerationRef.current
    const selectionGeneration = groupOperationGenerationRef.current
    const selectedGroupBeforeCreate = selectedGroupIdRef.current
    const isCurrentCreate = (): boolean => (
      isCurrentLifecycle(lifecycleGeneration)
      && createGroupGenerationRef.current === createGeneration
      && groupOperationGenerationRef.current === selectionGeneration
      && selectedGroupIdRef.current === selectedGroupBeforeCreate
      && hasCurrentAuth(auth)
    )
    setCreateGroupError(null)
    setGroupWorking('create')
    try {
      if (!isCurrentAuth(auth)) return
      const queue = getPendingGroupQueue(auth)
      const reservation = await queue.reserveCreation(pendingKey, name, botIds)
      if (!isCurrentCreate()) return
      if (reservation.recovered) {
        setPendingCreations(await queue.listCreations())
        throw new Error(t('sharedGroupPendingRecoveryRequired'))
      }
      const id = brandString<BotGroupIdType>(reservation.id)
      if (!isCurrentAuth(auth)) return
      const result = await create({ ...request, id, name, botIds: request.botIds })
      if (!isCurrentAuth(auth)) return
      if (!result.ok) {
        if (result.error.code === 'gateway/forbidden') requestRevalidation(true, result.error.message)
        throw new Error(result.error.message || t('sharedGroupCreateFailed'))
      }
      const created = result.value.group
      if (!isCurrentCreate()) {
        await refreshPendingOperations()
        return
      }
      if (!isCurrentAuth(auth)) return
      await queue.completeCreation(reservation.operationHash, reservation.id)
      if (!isCurrentCreate()) return
      setGroups(current => [
        ...current.filter(group => String(group.id) !== String(created.id)),
        created,
      ])
      setGroupSelection(String(created.id))
      await readGroup(String(created.id))
      if (!isCurrentCreate()) return
    } catch (cause: unknown) {
      if (isCurrentCreate()) {
        setCreateGroupError(retryErrorMessage(cause, t('sharedGroupCreateFailed')))
        await refreshPendingOperations()
      }
      throw cause
    } finally {
      if (isCurrentCreate()) setGroupWorking(current => current === 'create' ? null : current)
    }
  }

  const recoverPendingCreation = async (creation: SharedPendingGroupCreation): Promise<void> => {
    const auth = syncAuthContext()
    const create = auth?.client.createGroup
    const lifecycleGeneration = lifecycleGenerationRef.current
    const createGeneration = createGroupGenerationRef.current
    if (auth === undefined || create === undefined || !isCurrentLifecycle(lifecycleGeneration)
      || !pendingCatalogReady || recoveryBusy) return
    const isCurrentRecovery = (): boolean => (
      isCurrentLifecycle(lifecycleGeneration)
      && createGroupGenerationRef.current === createGeneration
      && recoveryWorkingRef.current === creation.id
      && hasCurrentAuth(auth)
    )
    recoveryWorkingRef.current = creation.id
    setRecoveryWorking(creation.id)
    setCreateGroupError(null)
    try {
      if (!isCurrentAuth(auth)) return
      const queue = getPendingGroupQueue(auth)
      let created = await reconcileGroupCreation(
        brandString<BotGroupIdType>(creation.id),
        creation.name,
        creation.botIds,
        auth,
      )
      if (created === undefined) {
        if (!isCurrentAuth(auth)) return
        const result = await create({
          id: brandString<BotGroupIdType>(creation.id),
          name: creation.name,
          botIds: creation.botIds.map(id => brandString<BotIdType>(id)),
        })
        if (!isCurrentAuth(auth)) return
        if (!result.ok) {
          if (result.error.code === 'gateway/forbidden') requestRevalidation(true, result.error.message)
          throw new Error(result.error.message || t('sharedGroupCreateFailed'))
        }
        created = result.value.group
      }
      if (!isCurrentAuth(auth)) return
      await queue.completeCreation(creation.operationHash, creation.id)
      if (!isCurrentRecovery()) return
      setPendingCreations(current => current.filter(candidate => candidate.id !== creation.id))
      setGroups(current => [
        ...current.filter(group => String(group.id) !== String(created.id)),
        created,
      ])
      setGroupSelection(String(created.id))
      await readGroup(String(created.id))
      if (!isCurrentRecovery()) return
      closeCreateGroup()
    } catch (cause: unknown) {
      if (isCurrentRecovery()) setCreateGroupError(retryErrorMessage(cause, t('sharedGroupCreateFailed')))
    } finally {
      const shouldClear = isCurrentRecovery()
      const ownsRecovery = recoveryWorkingRef.current === creation.id
      if (ownsRecovery) recoveryWorkingRef.current = null
      if (shouldClear || ownsRecovery) setRecoveryWorking(current => current === creation.id ? null : current)
    }
  }

  const discardPendingCreation = async (creation: SharedPendingGroupCreation): Promise<boolean> => {
    const auth = syncAuthContext()
    const lifecycleGeneration = lifecycleGenerationRef.current
    const createGeneration = createGroupGenerationRef.current
    if (auth === undefined || !isCurrentLifecycle(lifecycleGeneration)
      || !pendingCatalogReady || recoveryBusy) return false
    const isCurrentDiscard = (): boolean => (
      isCurrentLifecycle(lifecycleGeneration) && createGroupGenerationRef.current === createGeneration && hasCurrentAuth(auth)
    )
    recoveryWorkingRef.current = creation.id
    setRecoveryWorking(creation.id)
    let succeeded = false
    try {
      if (!isCurrentAuth(auth)) return false
      const queue = getPendingGroupQueue(auth)
      await queue.removeCreation(creation.operationHash, creation.id)
      if (isCurrentAuth(auth) && isCurrentDiscard()) {
        setPendingCreations(current => current.filter(candidate => candidate.id !== creation.id))
        succeeded = true
      }
    } catch (cause: unknown) {
      if (isCurrentDiscard()) setCreateGroupError(retryErrorMessage(cause, t('sharedGroupRetryUnavailable')))
    } finally {
      const shouldClear = isCurrentDiscard()
      const ownsRecovery = recoveryWorkingRef.current === creation.id
      if (ownsRecovery) recoveryWorkingRef.current = null
      if (shouldClear || ownsRecovery) setRecoveryWorking(current => current === creation.id ? null : current)
    }
    return succeeded
  }

  const requestDiscardCreation = (creation: SharedPendingGroupCreation): void => {
    setDiscardTarget({ kind: 'creation', value: creation })
    setDiscardAcknowledged(false)
  }

  const discardPendingMessage = async (messageRecord: SharedPendingGroupMessage): Promise<boolean> => {
    const auth = syncAuthContext()
    const lifecycleGeneration = lifecycleGenerationRef.current
    const groupGeneration = groupOperationGenerationRef.current
    if (auth === undefined || !isCurrentLifecycle(lifecycleGeneration) || !pendingCatalogReady || groupWorking !== null
      || pendingMessageBusy) return false
    const isCurrentDiscard = (): boolean => (
      isCurrentLifecycle(lifecycleGeneration) && groupOperationGenerationRef.current === groupGeneration && hasCurrentAuth(auth)
    )
    const operationToken = beginPendingMessageOperation(messageRecord.id)
    let succeeded = false
    try {
      if (!isCurrentAuth(auth)) return false
      const queue = getPendingGroupQueue(auth)
      await queue.removeMessage(messageRecord.operationHash, messageRecord.id)
      if (isCurrentAuth(auth) && isCurrentDiscard()) {
        setPendingMessages(current => current.filter(candidate => candidate.id !== messageRecord.id))
        succeeded = true
      }
    } catch (cause: unknown) {
      if (isCurrentDiscard()) setError(retryErrorMessage(cause, t('sharedGroupRetryUnavailable')))
    } finally {
      finishPendingMessageOperation(messageRecord.id, operationToken)
    }
    return succeeded
  }

  const requestDiscardMessage = (messageRecord: SharedPendingGroupMessage): void => {
    setDiscardTarget({ kind: 'message', value: messageRecord })
    setDiscardAcknowledged(false)
  }

  const confirmDiscard = async (): Promise<void> => {
    const target = discardTarget
    if (target === null || discardWorking || !pendingCatalogReady) return
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
    const auth = syncAuthContext()
    const createInvite = auth?.client.createGroupInvite
    const groupId = selectedGroupIdRef.current
    const lifecycleGeneration = lifecycleGenerationRef.current
    if (auth === undefined || createInvite === undefined || groupId === null
      || !isCurrentLifecycle(lifecycleGeneration) || groupInviteWorking) return
    const inviteGeneration = groupInviteGenerationRef.current + 1
    groupInviteGenerationRef.current = inviteGeneration
    const isCurrentInvite = (): boolean => (
      isCurrentLifecycle(lifecycleGeneration)
      && selectedGroupIdRef.current === groupId
      && groupInviteGenerationRef.current === inviteGeneration
      && hasCurrentAuth(auth)
    )
    setGroupInviteWorking(true)
    setGroupInvite(null)
    setGroupInviteCopied(false)
    setError(null)
    try {
      if (!isCurrentAuth(auth)) return
      const result = await createInvite(groupId)
      if (!isCurrentAuth(auth) || !isCurrentInvite()) return
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
    const auth = syncAuthContext()
    const send = auth?.client.sendGroupMessage
    const lifecycleGeneration = lifecycleGenerationRef.current
    if (auth === undefined || send === undefined || !isCurrentLifecycle(lifecycleGeneration)
      || !pendingCatalogReady || groupWorking !== null || pendingMessageBusy) return
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
      && hasCurrentAuth(auth)
    )
    const operationToken = beginPendingMessageOperation(pending.id)
    setGroupWorking('send')
    setError(null)
    try {
      if (!isCurrentAuth(auth)) return
      const messageId = brandString<BotGroupMessageIdType>(pending.id)
      await reconcileGroupMessage(pending.groupId, messageId, pending.text, auth)
      if (!isCurrentRecovery()) return
      if (!isCurrentAuth(auth)) return
      const result = await send({
        groupId: brandString<BotGroupIdType>(pending.groupId),
        text: pending.text,
        messageId,
      })
      if (!isCurrentAuth(auth) || !isCurrentRecovery()) return
      if (result.ok) {
        if (result.value.status === 'partial') {
          setError(t('sharedGroupSendFailed'))
          await refreshPendingOperations()
          return
        }
        if (!isCurrentAuth(auth)) return
        const queue = getPendingGroupQueue(auth)
        await queue.completeMessage(pending.operationHash, pending.id)
        if (!isCurrentRecovery()) return
        setPendingMessages(current => current.filter(candidate => candidate.id !== pending.id))
        if (groupDraftRevisionRef.current === submittedDraftRevision && submittedDraft.trim() === pending.text) setGroupDraft('')
        await readGroup(pending.groupId)
      } else if (result.error.code === 'gateway/forbidden') {
        requestRevalidation(true, result.error.message)
      } else {
        setError(result.error.message || t('sharedGroupSendFailed'))
      }
    } catch (cause: unknown) {
      if (isCurrentRecovery()) setError(retryErrorMessage(cause, t('sharedGroupSendFailed')))
    } finally {
      finishPendingMessageOperation(pending.id, operationToken)
      if (isCurrentRecovery()) {
        setGroupWorking(current => current === 'send' ? null : current)
      }
    }
  }

  const sendGroup = async (): Promise<void> => {
    const auth = syncAuthContext()
    const send = auth?.client.sendGroupMessage
    const sendWithAttachments = auth?.client.sendGroupMessageWithAttachments
    const groupId = selectedGroupIdRef.current
    const draft = groupDraft.trim()
    const attachments = groupAttachmentsRef.current
    if (auth === undefined || (send === undefined && attachments.length === 0) || !openRef.current || groupId === null
      || (draft === '' && attachments.length === 0) || working !== null
      || !pendingCatalogReady
      || groupWorking !== null || pendingMessageBusy || hasPendingChat || hasPendingMemory) return
    if (attachments.length > 0 && sendWithAttachments === undefined) {
      setGroupAttachmentError(t('sharedGroupAttachmentsUnavailable'))
      return
    }
    const submittedRevision = groupDraftRevisionRef.current
    const submittedGroupId = groupId
    const pendingMessageKey = attachments.length === 0 ? sharedGroupMessageKey(randomUUID(), submittedGroupId, draft) : undefined
    const operationGeneration = groupOperationGenerationRef.current + 1
    groupOperationGenerationRef.current = operationGeneration
    const isCurrentGroupOperation = (): boolean => (
      openRef.current
      && selectedGroupIdRef.current === submittedGroupId
      && groupOperationGenerationRef.current === operationGeneration
      && hasCurrentAuth(auth)
    )
    setGroupWorking('send')
    setError(null)
    setGroupAttachmentError(null)
    try {
      if (!isCurrentAuth(auth)) return
      let queue: SharedGroupPendingQueue | undefined
      let reservation: Awaited<ReturnType<SharedGroupPendingQueue['reserveMessage']>> | undefined
      let messageId: BotGroupMessageIdType
      if (attachments.length > 0) {
        const stableId = groupAttachmentMessageIdRef.current ?? `bot-group-message-${randomUUID()}`
        groupAttachmentMessageIdRef.current = stableId
        groupAttachmentDraftTextRef.current = draft
        messageId = brandString<BotGroupMessageIdType>(stableId)
      } else {
        queue = getPendingGroupQueue(auth)
        reservation = await queue.reserveMessage(pendingMessageKey ?? '', submittedGroupId, draft)
        if (!isCurrentGroupOperation()) return
        messageId = brandString<BotGroupMessageIdType>(reservation.id)
        if (reservation.recovered) {
          await reconcileGroupMessage(submittedGroupId, messageId, draft, auth)
          if (!isCurrentGroupOperation()) return
        }
      }
      if (!isCurrentAuth(auth)) return
      let result
      if (attachments.length > 0) {
        if (sendWithAttachments === undefined) throw new Error(t('sharedGroupAttachmentsUnavailable'))
        result = await sendWithAttachments({
          groupId: brandString<BotGroupIdType>(groupId), text: draft || t('groupAttachmentFile'), messageId, attachments,
        })
      } else {
        if (send === undefined) throw new Error(t('sharedGroupSendFailed'))
        result = await send({ groupId: brandString<BotGroupIdType>(groupId), text: draft, messageId })
      }
      if (!isCurrentAuth(auth) || selectedGroupIdRef.current !== submittedGroupId) return
      if (!isCurrentGroupOperation()) return
      if (result.ok) {
        if (result.value.status === 'partial') {
          if (attachments.length > 0) setGroupAttachmentError(t('sharedGroupSendFailed'))
          else {
            setError(t('sharedGroupSendFailed'))
            void refreshPendingOperations()
          }
          return
        }
        if (!isCurrentAuth(auth)) return
        if (queue !== undefined && reservation !== undefined) {
          await queue.completeMessage(reservation.operationHash, reservation.id)
          if (!isCurrentAuth(auth) || !isCurrentGroupOperation()) return
          setPendingMessages(current => current.filter(candidate => candidate.id !== reservation?.id))
        } else {
          clearGroupAttachments()
        }
        if (groupDraftRevisionRef.current === submittedRevision) setGroupDraft('')
        await readGroup(submittedGroupId)
      } else if (result.error.code === 'gateway/forbidden') {
        requestRevalidation(true, result.error.message)
      } else {
        if (attachments.length > 0) setGroupAttachmentError(result.error.message || t('sharedGroupSendFailed'))
        else {
          setError(result.error.message || t('sharedGroupSendFailed'))
          await refreshPendingOperations()
        }
      }
    } catch (cause: unknown) {
      if (isCurrentGroupOperation()) {
        const message = retryErrorMessage(cause, t('sharedGroupSendFailed'))
        if (attachments.length > 0) setGroupAttachmentError(message)
        else {
          setError(message)
          await refreshPendingOperations()
        }
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
        description={ownerMode ? t('sharedOwnerDescription') : t('sharedBotsDescription')}
        closeLabel={t('cancel')}
        className={css.shareDialog as string}
        contentClassName={css.shareDialogContent as string}
        footer={<Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>}
      >
        {error !== null && <div className={css.dialogNotice} role="alert">{error}</div>}
        {!ownerMode && (
          <>
            <div className={css.shareInviteRow}>
              <Input value={code} placeholder={t('inviteCodePlaceholder')} aria-label={t('inviteCodeLabel')} onChange={(event) => { codeRevisionRef.current += 1; setCode(event.currentTarget.value) }} />
              <Button variant="primary" onClick={() => { void enroll() }} disabled={working !== null || groupWorking !== null || hasPendingChat || hasPendingMemory || enrollmentInFlightRef.current || code.trim() === ''}>{working === 'enroll' ? t('joining') : t('join')}</Button>
            </div>
            <p className={css.sharedMemoryDescription}>{t('sharedInviteCodeHelp')}</p>
          </>
        )}
        {working === 'owner' && <div className={css.shareLoading} role="status">{t('sharedOwnerSettingUp')} <StateDot state="ongoing" size={12} /></div>}
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
                        disabled={!pendingCatalogReady || groupWorking !== null || pendingMessageBusy || discardTarget !== null}
                        onClick={() => { void recoverPendingMessage(pending) }}
                      >
                        {working ? t('sharedGroupSending') : t('sharedGroupRecover')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!pendingCatalogReady || groupWorking !== null || pendingMessageBusy || discardTarget !== null}
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
                    return <p className={messageRow.sender.kind === 'user' ? css.sharedUserMessage : css.sharedBotMessage} key={String(messageRow.id)}><strong>{sender}</strong> {messageRow.text}<BotGroupSentAttachments attachments={messageRow.attachments} fallbackName={t('groupAttachmentFile')} /></p>
                  })}
                </div>
                <form className={css.sharedComposer} onSubmit={(event) => { event.preventDefault(); void sendGroup() }}>
                  <BotGroupAttachments
                    attachments={groupAttachments}
                    disabled={groupWorking === 'send'}
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
                    onAddFiles={addGroupAttachments}
                    onRemove={removeGroupAttachment}
                  />
                  {groupAttachmentError !== null && (
                    <div className={css.groupAttachmentNotice} role="alert">
                      <span>{groupAttachmentError}</span>
                      {client.sendGroupMessageWithAttachments !== undefined && (
                        <Button variant="ghost" size="sm" disabled={groupWorking === 'send'} onClick={() => { void sendGroup() }}>{t('retry')}</Button>
                      )}
                    </div>
                  )}
                  <div className={css.sharedComposerTextRow}>
                    <Input
                      value={groupDraft}
                      placeholder={t('sharedGroupMessagePlaceholder', { name: selectedGroup.name })}
                      aria-label={t('sharedGroupMessagePlaceholder', { name: selectedGroup.name })}
                      onChange={(event) => {
                        groupDraftRevisionRef.current += 1
                        if (groupAttachmentMessageIdRef.current !== null && groupAttachmentDraftTextRef.current !== null
                          && event.currentTarget.value.trim() !== groupAttachmentDraftTextRef.current) {
                          groupAttachmentMessageIdRef.current = null
                          groupAttachmentDraftTextRef.current = null
                        }
                        setGroupAttachmentError(null)
                        setGroupDraft(event.currentTarget.value)
                      }}
                    />
                    <Button
                      variant="primary"
                      type="submit"
                      disabled={!pendingCatalogReady || groupWorking !== null || working !== null || pendingMessageBusy || (groupDraft.trim() === '' && groupAttachments.length === 0) || hasPendingChat || hasPendingMemory}
                      icon={<IconShareOutlineRegular size={14} />}
                    >
                      {groupWorking === 'send' ? t('sharedGroupSending') : t('sharedGroupSend')}
                    </Button>
                  </div>
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
          pendingCatalogReady={pendingCatalogReady}
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
        disabled={!pendingCatalogReady || discardWorking || recoveryWorking !== null || groupWorking !== null || pendingMessageBusy}
        onAcknowledgedChange={setDiscardAcknowledged}
        onCancel={() => { setDiscardTarget(null); setDiscardAcknowledged(false) }}
        onConfirm={() => { void confirmDiscard() }}
      />
    </>
  )
}
