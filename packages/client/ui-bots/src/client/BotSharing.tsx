import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { brandString } from '@yharness/brand'
import { randomUUID } from '@yharness/util-crypto'
import type { PropsLocale } from '@yharness/client-ui-slots'
import {
  Button,
  IconCopyOutlineRegular,
  IconLinkOutlineRegular,
  IconSettingsOutlineRegular,
  IconShieldOutlineRegular,
  IconShareOutlineRegular,
  IconTrashOutlineRegular,
  Input,
  Modal,
  MenuSurface,
  RiskConfirmation,
  SegmentedControl,
  StateDot,
  Switch,
  Tag,
  Tooltip,
  connectedAppGlyph,
  writeClipboard,
} from '@yharness/client-ui-primitives'
import type {
  BotId as BotIdType,
  BotGroupCreateRequest,
  BotGroupMessageId as BotGroupMessageIdType,
  BotGroupMessageSenderView,
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
  BotSharedGroupDeliveryFenceView,
  BotSharedRosterFenceDiagnosticValue,
} from '@yharness/bots/client'
import { BotAvatar } from './BotAvatar.tsx'
import { mentionQueryAt, resolveMentionTargets } from './bot-mentions.ts'
import { compactGroupQuote, GROUP_REACTION_OPTIONS, readGroupReplyToMessageId } from './group-interactions.ts'
import {
  BotGroupAttachments,
  BotGroupSentAttachments,
  createBotGroupAttachmentDraft,
  releaseBotGroupAttachment,
} from './BotGroupAttachments.tsx'
import css from './BotWorkspace.module.css'
import type { BotShareActions, SharedBotAppAccessValue } from './controller.ts'
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
import type { BotGroupReactionSummary } from './types.ts'
import { broadcastSharedAuthChanged } from './shared-client.ts'
import type {
  SharedBotApprovalRequest,
  SharedBotApprovalGrant,
  SharedBotAuthChange,
  SharedBotGroupInviteValue,
  SharedBotGroupSettingsValue,
  SharedBotsClient,
} from './shared-client.ts'

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

function sharedGroupMessageKey(actionId: string, groupId: string, text: string, replyToMessageId?: string): string {
  const base = `${actionId}\u0000${groupId}\u0000${text}`
  return replyToMessageId === undefined ? base : `${base}\u0000${replyToMessageId}`
}

function approvalArgumentsNotice(approval: SharedBotApprovalRequest, t: Translate): string {
  const hasArguments = approval.arguments !== undefined
  const redacted = approval.argumentsRedacted === true
  const truncated = approval.argumentsTruncated === true
  if (redacted && truncated) {
    return t(hasArguments
      ? 'sharedApprovalArgumentsRedactedAndTruncated'
      : 'sharedApprovalArgumentsRedactedAndTruncatedUnavailable')
  }
  if (redacted) {
    return t(hasArguments ? 'sharedApprovalArgumentsRedacted' : 'sharedApprovalArgumentsRedactedUnavailable')
  }
  if (truncated) {
    return t(hasArguments ? 'sharedApprovalArgumentsTruncated' : 'sharedApprovalArgumentsTruncatedUnavailable')
  }
  return t(hasArguments ? 'sharedApprovalArgumentsAvailable' : 'sharedApprovalArgumentsUnavailable')
}

function shareRoleLabel(role: BotShareRole, t: Translate): string {
  switch (role) {
    case 'owner': return t('shareRoleOwner')
    case 'manager': return t('shareRoleManager')
    case 'collaborator': return t('shareRoleCollaborator')
    default: return t('sharedRole', { role })
  }
}

function sharedGroupAuthorLabel(sender: BotGroupMessageSenderView, selfPrincipalId: string | undefined, t: Translate): string {
  if (sender.kind === 'bot') return t('sharedGroupBotAuthor', { name: sender.name })
  if (sender.principalId === undefined || String(sender.principalId) === selfPrincipalId) return t('you')
  return t('shareRoleCollaborator')
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

function SharedAppsCard({ botId, list, set, t }: {
  readonly botId: string
  readonly list: NonNullable<BotShareActions['listSharedAppAccess']>
  readonly set: NonNullable<BotShareActions['setSharedAppAccess']>
  readonly t: Translate
}) {
  const [catalog, setCatalog] = useState<SharedBotAppAccessValue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const generation = useRef(0)
  const pendingRef = useRef(false)
  useEffect(() => {
    const current = ++generation.current
    setCatalog(null)
    setError(null)
    setPending(null)
    pendingRef.current = false
    void list(botId).then((value) => {
      if (generation.current !== current) return
      if (value.botId !== botId) setError(t('sharedAppsLoadFailed'))
      else setCatalog(value)
    }).catch(() => {
      if (generation.current === current) setError(t('sharedAppsLoadFailed'))
    })
    return () => { generation.current += 1 }
  }, [botId, list, reload, t])

  const toggle = async (appId: string, allowed: boolean): Promise<void> => {
    if (catalog === null || pendingRef.current) return
    const current = generation.current
    pendingRef.current = true
    setPending(appId)
    setError(null)
    try {
      const result = await set(botId, appId, allowed, catalog.revision)
      if (generation.current === current) {
        if (result.botId === botId) setCatalog(result)
        else setError(t('sharedAppsSaveFailed'))
      }
    } catch (cause: unknown) {
      if (generation.current === current) {
        setError(t(cause instanceof Error && cause.name === 'SharedBotAppsConflictError' ? 'sharedAppsConflict' : 'sharedAppsSaveFailed'))
      }
    } finally {
      if (generation.current === current) {
        pendingRef.current = false
        setPending(null)
      }
    }
  }

  return (
    <section className={css.sharedMemoryCard} aria-label={t('sharedAppsLabel')} aria-busy={(catalog === null && error === null) || pending !== null}>
      <div className={css.sharedMemoryHeader}>
        <span className={css.sharedMemoryIcon} aria-hidden="true"><IconLinkOutlineRegular size={16} /></span>
        <div>
          <div className={css.shareSectionHeading}>{t('sharedAppsLabel')}</div>
          <p className={css.sharedMemoryDescription}>{t('sharedAppsDescription')}</p>
        </div>
      </div>
      {error !== null && <div className={css.dialogNotice} role="alert">{error} <Button variant="ghost" size="sm" onClick={() => { setReload(value => value + 1) }}>{t('retry')}</Button></div>}
      {catalog === null && error === null && <div className={css.connectedAppsLoading} role="status">{t('sharedAppsLoading')}</div>}
      {catalog !== null && catalog.apps.length === 0 && <div className={css.connectedAppsEmpty}>{t('sharedAppsEmpty')}</div>}
      {catalog !== null && catalog.apps.length > 0 && <div className={css.connectedAppsList} role="list" aria-label={t('sharedAppsLabel')}>
        {catalog.apps.map((app) => {
          const label = app.name?.trim() ?? ''
          const name = label !== '' && label !== '-' ? label : t('connectedAppFallbackName', { id: app.id })
          return <div className={css.connectedAppRow} role="listitem" key={app.id}>
            <span className={css.connectedAppIcon} aria-hidden="true">{connectedAppGlyph({ appId: app.id, size: 16 }) ?? name.slice(0, 2)}</span>
            <span className={css.connectedAppCopy}>
              <strong>{name}</strong>
              {app.description !== undefined && <span>{app.description}</span>}
              <span className={app.allowed ? css.connectedAppAllowed : css.connectedAppBlocked}>{t(app.allowed ? 'sharedAppsAllowed' : 'sharedAppsBlocked')}</span>
            </span>
            <Button variant={app.allowed ? 'ghost' : 'outline'} size="sm" disabled={pending !== null}
              aria-pressed={app.allowed} aria-label={t(app.allowed ? 'sharedAppsRevoke' : 'sharedAppsGrant', { name })}
              onClick={() => { void toggle(app.id, !app.allowed) }}>
              {t(app.allowed ? 'sharedAppsBlockAction' : 'sharedAppsAllowAction')}
            </Button>
          </div>
        })}
      </div>}
    </section>
  )
}

type SharedApprovalScope =
  | { readonly botId: string; readonly groupId?: never }
  | { readonly groupId: string; readonly botId?: never }

type SharedApprovalDecision = 'allow' | 'always-allow' | 'reject'

/** Show connected-app approvals in the private or group conversation currently open. */
function SharedApprovalsCard({ client, scope, botName, groupName, resolveBotName, t }: {
  readonly client: SharedBotsClient
  readonly scope: SharedApprovalScope
  readonly botName?: string
  readonly groupName?: string
  readonly resolveBotName?: (botId: string) => string | undefined
  readonly t: Translate
}) {
  const listApprovals = client.listApprovals
  const decideApproval = client.decideApproval
  const revokeApprovalGrant = client.revokeApprovalGrant
  const [approvals, setApprovals] = useState<readonly SharedBotApprovalRequest[] | null>(null)
  const [grants, setGrants] = useState<readonly SharedBotApprovalGrant[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState<{ readonly id: string; readonly decision: SharedApprovalDecision } | null>(null)
  const [grantWorking, setGrantWorking] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const generation = useRef(0)
  const requestGeneration = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>()
  const workingRef = useRef<{ readonly id: string; readonly decision: SharedApprovalDecision } | null>(null)

  useEffect(() => {
    if (listApprovals === undefined) return
    const current = ++generation.current
    const currentRequest = ++requestGeneration.current
    const requestAuthGeneration = client.authGeneration
    const requestScope = client.retryScope

    const load = async (): Promise<void> => {
      if (generation.current !== current) return
      try {
        const result = await listApprovals(scope)
        if (generation.current !== current || requestGeneration.current !== currentRequest
          || client.authGeneration !== requestAuthGeneration || client.retryScope !== requestScope) return
        if (!result.ok) {
          setError(t('sharedApprovalsLoadFailed'))
          return
        }
        const matchesScope = (item: SharedBotApprovalRequest | SharedBotApprovalGrant): boolean => (
          'groupId' in scope
            ? item.groupId === scope.groupId
            : item.botId === scope.botId && item.groupId === undefined
        )
        setApprovals(result.value.approvals.filter(matchesScope))
        setGrants(result.value.grants?.filter(matchesScope) ?? [])
        setError(null)
      } catch {
        if (generation.current === current && requestGeneration.current === currentRequest
          && client.authGeneration === requestAuthGeneration && client.retryScope === requestScope) {
          setError(t('sharedApprovalsLoadFailed'))
        }
      } finally {
        if (generation.current === current && requestGeneration.current === currentRequest
          && client.authGeneration === requestAuthGeneration && client.retryScope === requestScope) {
          setLoading(false)
          timerRef.current = setTimeout(() => {
            timerRef.current = undefined
            void load()
          }, 5_000)
        }
      }
    }

    setLoading(true)
    setError(null)
    setApprovals(null)
    setGrants(null)
    workingRef.current = null
    setWorking(null)
    setGrantWorking(null)
    void load()
    return () => {
      generation.current += 1
      requestGeneration.current += 1
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current)
        timerRef.current = undefined
      }
    }
  }, [client, listApprovals, reload, scope.botId, scope.groupId, t, client.authGeneration, client.retryScope])

  const decide = async (approval: SharedBotApprovalRequest, decision: SharedApprovalDecision): Promise<void> => {
    if (decideApproval === undefined || workingRef.current !== null) return
    const current = generation.current
    const requestAuthGeneration = client.authGeneration
    const requestScope = client.retryScope
    const pending = { id: approval.id, decision } as const
    workingRef.current = pending
    setWorking(pending)
    setError(null)
    try {
      const result = await decideApproval(approval.id, decision)
      if (generation.current !== current || client.authGeneration !== requestAuthGeneration || client.retryScope !== requestScope) return
      if (result.ok && result.value.accepted !== false) {
        requestGeneration.current += 1
        if (timerRef.current !== undefined) {
          clearTimeout(timerRef.current)
          timerRef.current = undefined
        }
        setApprovals(value => value?.filter(item => item.id !== approval.id) ?? value)
        setReload(value => value + 1)
      }
      else if (!result.ok) setError(t('sharedApprovalDecisionFailed'))
      else setError(t('sharedApprovalDecisionFailed'))
    } catch {
      if (generation.current === current && client.authGeneration === requestAuthGeneration && client.retryScope === requestScope) {
        setError(t('sharedApprovalDecisionFailed'))
      }
    } finally {
      if (generation.current === current && client.authGeneration === requestAuthGeneration && client.retryScope === requestScope) {
        workingRef.current = null
        setWorking(null)
      }
    }
  }

  const revokeGrant = async (grant: SharedBotApprovalGrant): Promise<void> => {
    if (revokeApprovalGrant === undefined || grantWorking !== null) return
    const current = generation.current
    const requestAuthGeneration = client.authGeneration
    const requestScope = client.retryScope
    setGrantWorking(grant.id)
    setError(null)
    try {
      const result = await revokeApprovalGrant(grant.id)
      if (generation.current !== current || client.authGeneration !== requestAuthGeneration || client.retryScope !== requestScope) return
      if (result.ok) {
        requestGeneration.current += 1
        if (timerRef.current !== undefined) {
          clearTimeout(timerRef.current)
          timerRef.current = undefined
        }
        setGrants(value => value?.filter(item => item.id !== grant.id) ?? value)
        setReload(value => value + 1)
      } else {
        setError(t('sharedApprovalGrantRevokeFailed'))
      }
    } catch {
      if (generation.current === current && client.authGeneration === requestAuthGeneration && client.retryScope === requestScope) {
        setError(t('sharedApprovalGrantRevokeFailed'))
      }
    } finally {
      if (generation.current === current && client.authGeneration === requestAuthGeneration && client.retryScope === requestScope) {
        setGrantWorking(null)
      }
    }
  }

  if (listApprovals === undefined || (decideApproval === undefined && revokeApprovalGrant === undefined)) return null
  if (!loading && error === null && approvals !== null && approvals.length === 0 && grants !== null && grants.length === 0) return null

  const targetLabel = (approval: SharedBotApprovalRequest): string => {
    if (groupName !== undefined) {
      return t('sharedApprovalTarget', {
        bot: resolveBotName?.(approval.botId) ?? approval.botId,
        group: groupName,
      })
    }
    return t('sharedApprovalBotTarget', { bot: botName ?? approval.botId })
  }

  const appLabel = (approval: SharedBotApprovalRequest): string => (
    approval.appId === '' ? t('connectedAppFallbackName', { id: approval.appId }) : approval.appId
  )

  const argumentText = (approval: SharedBotApprovalRequest): string | undefined => {
    if (approval.arguments === undefined) return undefined
    if (typeof approval.arguments === 'string') return approval.arguments
    return JSON.stringify(approval.arguments, null, 2)
  }

  return (
    <section className={css.sharedMemoryCard} aria-label={t('sharedApprovalsTitle')} aria-busy={loading || working !== null || grantWorking !== null}>
      <div className={css.sharedMemoryHeader}>
        <span className={css.sharedMemoryIcon} aria-hidden="true"><IconShieldOutlineRegular size={16} /></span>
        <div>
          <div className={css.shareSectionHeading}>{t('sharedApprovalsTitle')}</div>
          <p className={css.sharedMemoryDescription}>{t('sharedApprovalsDescription')}</p>
        </div>
      </div>
      {error !== null && (
        <div className={css.dialogNotice} role="alert">
          <span>{error}</span>
          <Button variant="ghost" size="sm" onClick={() => { setReload(value => value + 1) }}>{t('sharedApprovalRetry')}</Button>
        </div>
      )}
      {loading && approvals === null && <div className={css.connectedAppsLoading} role="status">{t('sharedApprovalsLoading')}</div>}
      {!loading && approvals !== null && approvals.length === 0 && (grants === null || grants.length === 0) && <div className={css.connectedAppsEmpty}>{t('sharedApprovalsEmpty')}</div>}
      {approvals !== null && approvals.length > 0 && (
        <div className={css.sharedApprovalsList} role="list" aria-label={t('sharedApprovalsTitle')}>
          {approvals.map((approval) => {
            const app = appLabel(approval)
            const details = argumentText(approval)
            const pendingDecision = working?.id === approval.id ? working.decision : undefined
            return (
              <div className={css.sharedApprovalRow} role="listitem" key={approval.id}>
                <div className={css.sharedApprovalHeader}>
                  <span className={css.connectedAppIcon} aria-hidden="true">
                    {connectedAppGlyph({ appId: approval.appId, size: 16 }) ?? app.slice(0, 2)}
                  </span>
                  <div className={css.sharedApprovalTitle}>
                    <strong>{app}</strong>
                    <span>{approval.toolName}</span>
                  </div>
                </div>
                <div className={css.sharedApprovalTarget}>{targetLabel(approval)}</div>
                <div className={css.sharedApprovalAction}>{t('sharedApprovalAction', { action: approval.action })}</div>
                <p className={css.sharedApprovalReason}>{t('sharedApprovalAlwaysAllowHint')}</p>
                <p className={css.sharedApprovalReason}>{approval.reason ?? t('sharedApprovalNoReason')}</p>
                <div className={css.sharedApprovalSafePreview}>
                  {approvalArgumentsNotice(approval, t)}
                </div>
                {details !== undefined && (
                  <details className={css.sharedApprovalDetails}>
                    <summary>{t('sharedApprovalDetails')}</summary>
                    <pre className={css.sharedApprovalArguments} aria-label={t('sharedApprovalArguments')}>{details}</pre>
                  </details>
                )}
                <div className={css.sharedApprovalActions}>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={working !== null}
                    aria-label={t('sharedApprovalDeny', { app, tool: approval.toolName })}
                    onClick={() => { void decide(approval, 'reject') }}
                  >
                    {pendingDecision === 'reject' ? t('sharedApprovalDenying') : t('sharedApprovalDenyAction')}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={working !== null}
                    aria-label={t('sharedApprovalApprove', { app, tool: approval.toolName })}
                    onClick={() => { void decide(approval, 'allow') }}
                  >
                    {pendingDecision === 'allow' ? t('sharedApprovalApproving') : t('sharedApprovalApproveAction')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={working !== null}
                    aria-label={t('sharedApprovalAlwaysAllow', { app, tool: approval.toolName })}
                    onClick={() => { void decide(approval, 'always-allow') }}
                  >
                    {pendingDecision === 'always-allow' ? t('sharedApprovalAlwaysAllowing') : t('sharedApprovalAlwaysAllowAction')}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}
      {grants !== null && grants.length > 0 && (
        <div className={css.sharedApprovalsList} role="list" aria-label={t('sharedApprovalRememberedTitle')}>
          <div className={css.shareSectionHeading}>{t('sharedApprovalRememberedTitle')}</div>
          <p className={css.sharedMemoryDescription}>{t('sharedApprovalRememberedDescription')}</p>
          {grants.map(grant => (
            <div className={css.sharedApprovalRow} role="listitem" key={grant.id}>
              <div className={css.sharedApprovalHeader}>
                <span className={css.connectedAppIcon} aria-hidden="true">
                  {connectedAppGlyph({ appId: grant.appId, size: 16 }) ?? grant.appId.slice(0, 2)}
                </span>
                <div className={css.sharedApprovalTitle}>
                  <strong>{grant.appId === '' ? t('connectedAppFallbackName', { id: grant.appId }) : grant.appId}</strong>
                  <span>{grant.toolName}</span>
                </div>
              </div>
              <div className={css.sharedApprovalActions}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={grantWorking !== null}
                  aria-label={t('sharedApprovalRevoke', { tool: grant.toolName })}
                  onClick={() => { void revokeGrant(grant) }}
                >
                  {grantWorking === grant.id ? t('sharedApprovalRevoking') : t('sharedApprovalRevokeAction')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
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
  const [deliveryFences, setDeliveryFences] = useState<readonly BotSharedGroupDeliveryFenceView[]>([])
  const [deliveryFenceStatus, setDeliveryFenceStatus] = useState<'unknown' | 'ready' | 'error'>('unknown')
  const [deliveryFenceTarget, setDeliveryFenceTarget] = useState<BotSharedGroupDeliveryFenceView | null>(null)
  const [deliveryFenceAcknowledged, setDeliveryFenceAcknowledged] = useState(false)
  const [deliveryFenceWorking, setDeliveryFenceWorking] = useState(false)
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
      if (actions.inspectDeliveryFences !== undefined) {
        try {
          const fences = await actions.inspectDeliveryFences(requestedBotId)
          if (!isCurrentLoad()) return
          setDeliveryFences(fences.fences)
          setDeliveryFenceStatus('ready')
        } catch {
          if (!isCurrentLoad()) return
          setDeliveryFences([])
          setDeliveryFenceStatus('error')
          setError(t('sharedGroupDeliveryFenceUnavailable'))
        }
      }
    } catch (cause: unknown) {
      if (isCurrentLoad()) {
        if (actions.inspectDeliveryFences !== undefined) setDeliveryFenceStatus('error')
        setError(cause instanceof Error ? cause.message : t('shareError'))
      }
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
      setDeliveryFences([])
      setDeliveryFenceStatus('unknown')
      setDeliveryFenceTarget(null)
      setDeliveryFenceAcknowledged(false)
      setDeliveryFenceWorking(false)
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
    setDeliveryFences([])
    setDeliveryFenceStatus('unknown')
    setDeliveryFenceTarget(null)
    setDeliveryFenceAcknowledged(false)
    setDeliveryFenceWorking(false)
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

  const recoverDeliveryFence = async (): Promise<void> => {
    const target = deliveryFenceTarget
    if (!stateMatchesBot || target === null || target.botId !== bot.id
      || actions.recoverDeliveryFence === undefined || deliveryFenceWorking
      || working !== null || memoryWorking || rosterFenceWorking) return
    const stillListed = deliveryFences.some(fence => (
      fence.groupId === target.groupId
      && fence.botId === target.botId
      && fence.sessionId === target.sessionId
      && fence.messageId === target.messageId
    ))
    if (!stillListed) {
      setDeliveryFenceTarget(null)
      setDeliveryFenceAcknowledged(false)
      setError(t('sharedGroupDeliveryFenceChanged'))
      return
    }
    const requestedBotId = bot.id
    const viewGeneration = viewGenerationRef.current
    setDeliveryFenceWorking(true)
    setError(null)
    try {
      const result = await actions.recoverDeliveryFence(target)
      if (!isCurrentView(requestedBotId, viewGeneration)) return
      if (result.status === 'accepted' || result.status === 'released') {
        setDeliveryFences(current => current.filter(fence => (
          fence.groupId !== target.groupId
          || fence.botId !== target.botId
          || fence.sessionId !== target.sessionId
          || fence.messageId !== target.messageId
        )))
        setDeliveryFenceTarget(null)
        setDeliveryFenceAcknowledged(false)
        return
      }
      setDeliveryFenceAcknowledged(false)
      setError(result.status === 'busy'
        ? t('sharedGroupDeliveryFenceBusy')
        : t('sharedGroupDeliveryFenceRecoveryFailed'))
      try {
        const fences = await actions.inspectDeliveryFences?.(requestedBotId)
        if (fences !== undefined && isCurrentView(requestedBotId, viewGeneration)) {
          setDeliveryFences(fences.fences)
          setDeliveryFenceStatus('ready')
        }
      } catch {
        if (isCurrentView(requestedBotId, viewGeneration)) {
          setDeliveryFences([])
          setDeliveryFenceStatus('error')
          setDeliveryFenceTarget(null)
          setDeliveryFenceAcknowledged(false)
          setError(t('sharedGroupDeliveryFenceUnavailable'))
        }
      }
    } catch (cause: unknown) {
      if (isCurrentView(requestedBotId, viewGeneration)) {
        setDeliveryFenceAcknowledged(false)
        setError(cause instanceof Error ? cause.message : t('sharedGroupDeliveryFenceRecoveryFailed'))
      }
    } finally {
      if (isCurrentView(requestedBotId, viewGeneration)) setDeliveryFenceWorking(false)
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
        {stateMatchesBot && actions.listSharedAppAccess !== undefined && actions.setSharedAppAccess !== undefined && (
          <SharedAppsCard botId={bot.id} list={actions.listSharedAppAccess} set={actions.setSharedAppAccess} t={t} />
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
        {stateMatchesBot && actions.inspectDeliveryFences !== undefined && (
          <section className={css.sharedMemoryCard} aria-labelledby="yharness-shared-delivery-fence-heading">
            <div className={css.sharedMemoryHeader}>
              <span className={css.sharedMemoryIcon} aria-hidden="true"><IconShieldOutlineRegular size={16} /></span>
              <div>
                <div className={css.shareSectionHeading} id="yharness-shared-delivery-fence-heading">{t('sharedGroupDeliveryFenceLabel')}</div>
                <p className={css.sharedMemoryDescription}>
                  {working === 'load'
                    ? t('sharedGroupDeliveryFenceLoading')
                    : deliveryFenceStatus === 'error'
                      ? t('sharedGroupDeliveryFenceUnavailable')
                      : deliveryFences.length === 0
                        ? t('sharedGroupDeliveryFenceClear')
                        : t('sharedGroupDeliveryFenceHeld', { count: deliveryFences.length })}
                </p>
              </div>
            </div>
            {deliveryFences.map(fence => (
              <div className={css.shareInviteRow} key={`${fence.groupId}-${fence.sessionId}-${fence.messageId}`}>
                <span className={css.inviteCode}>
                  <code aria-label={t('sharedGroupDeliveryFenceIdLabel')}>{String(fence.groupId)} · {String(fence.messageId)}</code>
                </span>
                {actions.recoverDeliveryFence !== undefined && (
                  <Button
                    variant="outline"
                    disabled={working !== null || memoryWorking || rosterFenceWorking || deliveryFenceWorking}
                    onClick={() => { setDeliveryFenceTarget(fence); setDeliveryFenceAcknowledged(false) }}
                  >
                    {deliveryFenceWorking && deliveryFenceTarget?.messageId === fence.messageId
                      ? t('recoveringSharedGroupDeliveryFence')
                      : t('recoverSharedGroupDeliveryFence')}
                  </Button>
                )}
              </div>
            ))}
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
      <RiskConfirmation
        open={stateMatchesBot && deliveryFenceTarget !== null}
        title={t('recoverSharedGroupDeliveryFenceTitle')}
        description={t('recoverSharedGroupDeliveryFenceDescription', {
          groupId: deliveryFenceTarget === null ? '' : String(deliveryFenceTarget.groupId),
          messageId: deliveryFenceTarget === null ? '' : String(deliveryFenceTarget.messageId),
        })}
        acknowledgeLabel={t('recoverSharedGroupDeliveryFenceAcknowledge')}
        cancelLabel={t('cancel')}
        closeLabel={t('cancel')}
        confirmLabel={t('recoverSharedGroupDeliveryFence')}
        acknowledged={deliveryFenceAcknowledged}
        disabled={!stateMatchesBot || deliveryFenceWorking}
        onAcknowledgedChange={setDeliveryFenceAcknowledged}
        onCancel={() => { setDeliveryFenceTarget(null); setDeliveryFenceAcknowledged(false) }}
        onConfirm={() => { void recoverDeliveryFence() }}
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

function SharedGroupSettingsDialog({
  open,
  onClose,
  group,
  settings,
  working,
  error,
  onRename,
  onRequestRemove,
  selfPrincipalId,
  t,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly group: BotGroupView
  readonly settings: SharedBotGroupSettingsValue | null
  readonly working: 'load' | 'rename' | 'remove' | null
  readonly error: string | null
  readonly onRename: (name: string) => Promise<SharedBotGroupSettingsValue | undefined>
  readonly onRequestRemove: (principalId: string) => void
  readonly selfPrincipalId: string | undefined
  readonly t: Translate
}) {
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const initializedGroupRef = useRef<string | null>(null)
  useEffect(() => {
    if (!open) {
      initializedGroupRef.current = null
      setNameDraft(null)
      return
    }
    const groupId = String(group.id)
    if (initializedGroupRef.current === groupId) return
    initializedGroupRef.current = groupId
    setNameDraft(null)
  }, [group.id, open])

  const canManage = settings?.canManage === true
  const name = nameDraft ?? settings?.name ?? group.name
  const trimmedName = name.trim()
  const saveDisabled = !canManage || working !== null || trimmedName === '' || trimmedName === settings.name
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('sharedGroupSettingsTitle')}
      description={t('sharedGroupSettingsDescription')}
      closeLabel={t('cancel')}
      className={css.shareDialog as string}
      contentClassName={css.shareDialogContent as string}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={working !== null}>{t('cancel')}</Button>
          <Button
            variant="primary"
            disabled={saveDisabled}
            onClick={() => {
              void onRename(trimmedName).then((updated) => {
                if (updated !== undefined) setNameDraft(null)
              })
            }}
          >
            {working === 'rename' ? t('sharedGroupRenaming') : t('sharedGroupSettingsSaveName')}
          </Button>
        </>
      )}
    >
      {error !== null && <div className={css.dialogNotice} role="alert">{error}</div>}
      <div className={css.dialogField} aria-busy={working === 'rename'}>
        <label className={css.dialogLabel} htmlFor="yharness-shared-group-settings-name">{t('groupName')}</label>
        <Input
          id="yharness-shared-group-settings-name"
          data-testid="shared-group-settings-name"
          maxLength={80}
          value={name}
          disabled={!canManage || working !== null}
          onChange={(event) => { setNameDraft(event.currentTarget.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !saveDisabled) {
              event.preventDefault()
              void onRename(trimmedName).then((updated) => {
                if (updated !== undefined) setNameDraft(null)
              })
            }
          }}
        />
        {!canManage && <span className={css.groupHelper}>{t('sharedGroupSettingsMemberHint')}</span>}
      </div>
      <div className={css.shareMembers} aria-busy={working === 'load'}>
        <div className={css.shareSectionHeading}>{t('sharedGroupSettingsBots')}</div>
        <div className={css.sharedGroupSettingsList} role="list" aria-label={t('sharedGroupSettingsBots')}>
          {group.bots.map(bot => (
            <div className={css.sharedGroupSettingsRow} role="listitem" key={String(bot.id)}>
              <span className={css.shareMemberIdentity}>
                <BotAvatar name={bot.name} identity={bot.identity} accent={bot.accent} avatar={bot.avatar} size="small" />
                <span className={css.shareMemberPrincipal}>{bot.name}</span>
              </span>
              <Tag tone="neutral">{t('sharedGroupSettingsBot')}</Tag>
            </div>
          ))}
        </div>
      </div>
      <div className={css.shareMembers}>
        <div className={css.shareSectionHeading}>{t('sharedGroupSettingsPeople')}</div>
        {working === 'load' && <div className={css.shareLoading} role="status"><StateDot state="ongoing" size={12} /></div>}
        {working !== 'load' && settings?.members.length === 0 && <div className={css.shareEmpty}>{t('sharedGroupSettingsNoPeople')}</div>}
        {working !== 'load' && <div className={css.sharedGroupSettingsList} role="list" aria-label={t('sharedGroupSettingsPeople')}>
          {settings?.members.map(member => (
            <div className={css.sharedGroupSettingsRow} role="listitem" key={member.principalId}>
              <span className={css.shareMemberIdentity}>
                <span className={css.shareMemberDot} aria-hidden="true" />
                <span className={css.shareMemberPrincipal}>{member.principalId}</span>
                {member.principalId === selfPrincipalId && <span className={css.shareMemberHint}>{t('you')}</span>}
              </span>
              <span className={css.sharedGroupSettingsMemberActions}>
                <Tag tone={member.role === 'owner' ? 'info' : 'neutral'}>
                  {member.role === 'owner' ? t('sharedGroupSettingsOwner') : t('sharedGroupSettingsMember')}
                </Tag>
                {canManage && member.role !== 'owner' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid={`shared-group-settings-remove-${member.principalId}`}
                    aria-label={t('sharedGroupSettingsRemove', { id: member.principalId })}
                    disabled={working !== null}
                    icon={<IconTrashOutlineRegular size={14} />}
                    onClick={() => { onRequestRemove(member.principalId) }}
                  />
                )}
              </span>
            </div>
          ))}
        </div>}
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
  const [groupReplyingTo, setGroupReplyingTo] = useState<BotGroupMessageView | null>(null)
  const [groupReactionMenuMessageId, setGroupReactionMenuMessageId] = useState<string | null>(null)
  const [groupReactionWorkingMessageId, setGroupReactionWorkingMessageId] = useState<string | null>(null)
  const [groupMentionQuery, setGroupMentionQuery] = useState<string | null>(null)
  const [groupMentionIndex, setGroupMentionIndex] = useState(0)
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
  const [groupSettingsOpen, setGroupSettingsOpen] = useState(false)
  const [groupSettings, setGroupSettings] = useState<SharedBotGroupSettingsValue | null>(null)
  const [groupSettingsWorking, setGroupSettingsWorking] = useState<'load' | 'rename' | 'remove' | null>(null)
  const [groupSettingsError, setGroupSettingsError] = useState<string | null>(null)
  const [groupMemberRemoveTarget, setGroupMemberRemoveTarget] = useState<string | null>(null)
  const [groupMemberRemoveAcknowledged, setGroupMemberRemoveAcknowledged] = useState(false)
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
  const groupInputRef = useRef<HTMLInputElement | null>(null)
  const groupMentionSelectionsRef = useRef<readonly { readonly id: string; readonly name: string }[]>([])
  const groupInviteGenerationRef = useRef(0)
  const groupSettingsGenerationRef = useRef(0)
  const groupAttachmentsRef = useRef<readonly BotGroupAttachmentDraft[]>([])
  const groupAttachmentMessageIdRef = useRef<string | null>(null)
  const groupAttachmentDraftTextRef = useRef<string | null>(null)
  const groupAttachmentTargetsRef = useRef<readonly string[] | undefined>(undefined)
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
    groupAttachmentTargetsRef.current = undefined
    setGroupAttachments([])
    setGroupAttachmentError(null)
  }

  const addGroupAttachments = (files: readonly File[]): void => {
    setGroupAttachmentError(null)
    groupAttachmentMessageIdRef.current = null
    groupAttachmentDraftTextRef.current = null
    groupAttachmentTargetsRef.current = undefined
    setGroupAttachments(current => [...current, ...files.map(createBotGroupAttachmentDraft)])
  }

  const removeGroupAttachment = (id: string): void => {
    const removed = groupAttachmentsRef.current.find(attachment => attachment.id === id)
    if (removed !== undefined) releaseBotGroupAttachment(removed)
    setGroupAttachmentError(null)
    groupAttachmentMessageIdRef.current = null
    groupAttachmentDraftTextRef.current = null
    groupAttachmentTargetsRef.current = undefined
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
      groupSettingsGenerationRef.current += 1
      setGroupSettingsOpen(false)
      setGroupSettings(null)
      setGroupSettingsWorking(null)
      setGroupSettingsError(null)
      setGroupMemberRemoveTarget(null)
      setGroupMemberRemoveAcknowledged(false)
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
      setGroupReplyingTo(null)
      setGroupReactionMenuMessageId(null)
      setGroupReactionWorkingMessageId(null)
      setGroupMentionQuery(null)
      setGroupMentionIndex(0)
      groupMentionSelectionsRef.current = []
      setGroupWorking(null)
      setGroupInvite(null)
      setGroupInviteCopied(false)
      setGroupInviteWorking(false)
      setGroupInviteUnavailable(false)
      groupSettingsGenerationRef.current += 1
      setGroupSettingsOpen(false)
      setGroupSettings(null)
      setGroupSettingsWorking(null)
      setGroupSettingsError(null)
      setGroupMemberRemoveTarget(null)
      setGroupMemberRemoveAcknowledged(false)
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
    setGroupReplyingTo(null)
    setGroupReactionMenuMessageId(null)
    setGroupReactionWorkingMessageId(null)
    setGroupMentionQuery(null)
    setGroupMentionIndex(0)
    groupMentionSelectionsRef.current = []
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
    groupSettingsGenerationRef.current += 1
    setGroupSettingsOpen(false)
    setGroupSettings(null)
    setGroupSettingsWorking(null)
    setGroupSettingsError(null)
    setGroupMemberRemoveTarget(null)
    setGroupMemberRemoveAcknowledged(false)
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

  const mergeGroupName = (groupId: string, name: string, updatedAt: number): void => {
    setGroups(current => current.map(group => String(group.id) !== groupId || updatedAt < group.updatedAt
      ? group
      : { ...group, name, updatedAt }))
  }

  const readGroupSettings = async (
    groupId: string,
    showError = false,
    preserveError = false,
  ): Promise<SharedBotGroupSettingsValue | undefined> => {
    const auth = syncAuthContext()
    const read = auth?.client.readGroupSettings
    if (auth === undefined || read === undefined) return undefined
    const generation = groupSettingsGenerationRef.current + 1
    groupSettingsGenerationRef.current = generation
    if (showError) {
      setGroupSettingsWorking('load')
      if (!preserveError) setGroupSettingsError(null)
    }
    try {
      if (!isCurrentAuth(auth)) return undefined
      const result = await read(groupId)
      if (!isCurrentAuth(auth) || !openRef.current || generation !== groupSettingsGenerationRef.current
        || selectedGroupIdRef.current !== groupId) return undefined
      if (!result.ok) {
        if (result.error.code === 'gateway/forbidden') requestRevalidation(true, result.error.message)
        else if (showError) setGroupSettingsError(result.error.message || t('sharedGroupSettingsLoadFailed'))
        return undefined
      }
      setGroupSettings(result.value)
      mergeGroupName(groupId, result.value.name, result.value.updatedAt)
      return result.value
    } catch (cause: unknown) {
      if (isCurrentAuth(auth) && openRef.current && generation === groupSettingsGenerationRef.current
        && selectedGroupIdRef.current === groupId && showError) {
        setGroupSettingsError(cause instanceof Error ? cause.message : t('sharedGroupSettingsLoadFailed'))
      }
      return undefined
    } finally {
      if (showError && isCurrentAuth(auth) && generation === groupSettingsGenerationRef.current
        && selectedGroupIdRef.current === groupId) setGroupSettingsWorking(null)
    }
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
      if (result.ok) {
        setGroupMessages(result.value.messages)
        mergeGroupName(groupId, result.value.group.name, result.value.group.updatedAt)
      }
      else if (result.error.code === 'gateway/forbidden') requestRevalidation(true, result.error.message)
      else setError(result.error.message || t('sharedGroupLoadFailed'))
    } catch (cause: unknown) {
      if (isCurrentAuth(auth) && openRef.current && generation === groupReadGenerationRef.current
        && selectedGroupIdRef.current === groupId) {
        setError(cause instanceof Error ? cause.message : t('sharedGroupLoadFailed'))
      }
    }
  }

  const openGroupSettings = (): void => {
    const groupId = selectedGroupIdRef.current
    if (groupId === null || client.readGroupSettings === undefined) return
    setGroupSettingsOpen(true)
    void readGroupSettings(groupId, true)
  }

  const renameSharedGroup = async (name: string): Promise<SharedBotGroupSettingsValue | undefined> => {
    const auth = syncAuthContext()
    const rename = auth?.client.renameGroup
    const groupId = selectedGroupIdRef.current
    const currentSettings = groupSettings
    if (auth === undefined || rename === undefined || groupId === null || currentSettings === null || !currentSettings.canManage) {
      return undefined
    }
    const generation = groupSettingsGenerationRef.current + 1
    groupSettingsGenerationRef.current = generation
    setGroupSettingsWorking('rename')
    setGroupSettingsError(null)
    try {
      if (!isCurrentAuth(auth)) return undefined
      const result = await rename({ groupId, name, expectedUpdatedAt: currentSettings.updatedAt })
      if (!isCurrentAuth(auth) || !openRef.current || generation !== groupSettingsGenerationRef.current
        || selectedGroupIdRef.current !== groupId) return undefined
      if (!result.ok) {
        if (result.error.code === 'gateway/forbidden') requestRevalidation(true, result.error.message)
        else if (result.error.code === 'gateway/conflict') {
          setGroupSettingsError(t('sharedGroupSettingsConflict'))
          return await readGroupSettings(groupId, true, true)
        } else setGroupSettingsError(result.error.message || t('sharedGroupSettingsSaveFailed'))
        return undefined
      }
      setGroupSettings(result.value)
      mergeGroupName(groupId, result.value.name, result.value.updatedAt)
      return result.value
    } catch (cause: unknown) {
      if (isCurrentAuth(auth) && openRef.current && generation === groupSettingsGenerationRef.current
        && selectedGroupIdRef.current === groupId) setGroupSettingsError(cause instanceof Error ? cause.message : t('sharedGroupSettingsSaveFailed'))
      return undefined
    } finally {
      if (isCurrentAuth(auth) && generation === groupSettingsGenerationRef.current
        && selectedGroupIdRef.current === groupId) setGroupSettingsWorking(null)
    }
  }

  const removeSharedGroupMember = async (): Promise<void> => {
    const auth = syncAuthContext()
    const revoke = auth?.client.revokeGroupMember
    const groupId = selectedGroupIdRef.current
    const principalId = groupMemberRemoveTarget
    const currentSettings = groupSettings
    if (auth === undefined || revoke === undefined || groupId === null || principalId === null
      || currentSettings === null || !currentSettings.canManage) return
    const generation = groupSettingsGenerationRef.current + 1
    groupSettingsGenerationRef.current = generation
    setGroupSettingsWorking('remove')
    setGroupSettingsError(null)
    try {
      if (!isCurrentAuth(auth)) return
      const result = await revoke(groupId, principalId)
      if (!isCurrentAuth(auth) || !openRef.current || generation !== groupSettingsGenerationRef.current
        || selectedGroupIdRef.current !== groupId) return
      if (!result.ok) {
        if (result.error.code === 'gateway/forbidden') requestRevalidation(true, result.error.message)
        else setGroupSettingsError(result.error.message || t('sharedGroupSettingsRemoveFailed'))
        return
      }
      setGroupSettings(current => current === null ? current : {
        ...current,
        members: current.members.filter(member => member.principalId !== principalId),
      })
      setGroupMemberRemoveTarget(null)
      setGroupMemberRemoveAcknowledged(false)
      await readGroupSettings(groupId, true)
    } catch (cause: unknown) {
      if (isCurrentAuth(auth) && openRef.current && generation === groupSettingsGenerationRef.current
        && selectedGroupIdRef.current === groupId) setGroupSettingsError(cause instanceof Error ? cause.message : t('sharedGroupSettingsRemoveFailed'))
    } finally {
      if (isCurrentAuth(auth) && generation === groupSettingsGenerationRef.current
        && selectedGroupIdRef.current === groupId) setGroupSettingsWorking(null)
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
    targetBotIds?: readonly string[],
    replyToMessageId?: string,
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
      || String(existing.sender.principalId) !== principalId
      || (targetBotIds !== undefined && JSON.stringify([...(existing.targetBotIds ?? [])].map(String).sort())
        !== JSON.stringify([...targetBotIds].sort()))
      || readGroupReplyToMessageId(existing) !== replyToMessageId) {
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
      await reconcileGroupMessage(pending.groupId, messageId, pending.text, auth, pending.targetBotIds, pending.replyToMessageId)
      if (!isCurrentRecovery()) return
      if (!isCurrentAuth(auth)) return
      const result = await send({
        groupId: brandString<BotGroupIdType>(pending.groupId),
        text: pending.text,
        messageId,
        ...(pending.targetBotIds === undefined ? {} : { targetBotIds: pending.targetBotIds.map(brandString<BotIdType>) }),
        ...(pending.replyToMessageId === undefined
          ? {}
          : { replyToMessageId: brandString<BotGroupMessageIdType>(pending.replyToMessageId) }),
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
    const replyToMessageId = groupReplyingTo === null ? undefined : String(groupReplyingTo.id)
    const group = groups.find(candidate => String(candidate.id) === groupId)
    if (group === undefined) return
    if (replyToMessageId !== undefined && !groupMessages.some(message => String(message.id) === replyToMessageId)) {
      setGroupReplyingTo(null)
      setError(t('sharedGroupReplyChanged'))
      return
    }
    const mentioned = resolveMentionTargets(draft, group.bots, groupMentionSelectionsRef.current)
    if (mentioned === undefined) {
      setError(t('sharedGroupMentionAmbiguous'))
      return
    }
    const computedTargets = mentioned.length === 0 ? undefined : mentioned
    const targetBotIds = groupAttachmentMessageIdRef.current === null
      ? computedTargets : groupAttachmentTargetsRef.current
    const pendingMessageKey = attachments.length === 0
      ? sharedGroupMessageKey(randomUUID(), submittedGroupId, draft, replyToMessageId)
      : undefined
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
        groupAttachmentTargetsRef.current = targetBotIds
        messageId = brandString<BotGroupMessageIdType>(stableId)
      } else {
        queue = getPendingGroupQueue(auth)
        reservation = await queue.reserveMessage(pendingMessageKey ?? '', submittedGroupId, draft, targetBotIds, replyToMessageId)
        if (!isCurrentGroupOperation()) return
        messageId = brandString<BotGroupMessageIdType>(reservation.id)
        if (reservation.recovered) {
          await reconcileGroupMessage(submittedGroupId, messageId, draft, auth, targetBotIds, replyToMessageId)
          if (!isCurrentGroupOperation()) return
        }
      }
      if (!isCurrentAuth(auth)) return
      let result
      if (attachments.length > 0) {
        if (sendWithAttachments === undefined) throw new Error(t('sharedGroupAttachmentsUnavailable'))
        result = await sendWithAttachments({
          groupId: brandString<BotGroupIdType>(groupId), text: draft || t('groupAttachmentFile'), messageId, attachments,
          ...(targetBotIds === undefined ? {} : { targetBotIds: targetBotIds.map(brandString<BotIdType>) }),
          ...(replyToMessageId === undefined ? {} : { replyToMessageId: brandString<BotGroupMessageIdType>(replyToMessageId) }),
        })
      } else {
        if (send === undefined) throw new Error(t('sharedGroupSendFailed'))
        result = await send({ groupId: brandString<BotGroupIdType>(groupId), text: draft, messageId,
          ...(targetBotIds === undefined ? {} : { targetBotIds: targetBotIds.map(brandString<BotIdType>) }),
          ...(replyToMessageId === undefined ? {} : { replyToMessageId: brandString<BotGroupMessageIdType>(replyToMessageId) }) })
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
        if (groupDraftRevisionRef.current === submittedRevision) {
          setGroupDraft('')
          setGroupReplyingTo(null)
          groupMentionSelectionsRef.current = []
        }
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

  const reactSharedGroupMessage = async (
    messageId: string,
    emoji: BotGroupReactionSummary['emoji'],
    action: 'add' | 'remove',
  ): Promise<void> => {
    const auth = syncAuthContext()
    const react = auth?.client.reactGroupMessage
    const groupId = selectedGroupIdRef.current
    const lifecycleGeneration = lifecycleGenerationRef.current
    if (auth === undefined || react === undefined || groupId === null || !isCurrentLifecycle(lifecycleGeneration)) return
    const operationGeneration = groupOperationGenerationRef.current + 1
    groupOperationGenerationRef.current = operationGeneration
    setGroupReactionWorkingMessageId(messageId)
    const isCurrentReaction = (): boolean => (
      isCurrentLifecycle(lifecycleGeneration)
      && selectedGroupIdRef.current === groupId
      && groupOperationGenerationRef.current === operationGeneration
      && hasCurrentAuth(auth)
    )
    try {
      const result = await react({
        groupId,
        messageId,
        emoji,
        action,
      })
      if (!isCurrentReaction()) return
      if (!result.ok) {
        if (result.error.code === 'gateway/forbidden') requestRevalidation(true, result.error.message)
        else setError(result.error.message || t('sharedGroupReactionFailed'))
        return
      }
      await readGroup(groupId)
    } catch (cause: unknown) {
      if (isCurrentReaction()) setError(cause instanceof Error ? cause.message : t('sharedGroupReactionFailed'))
    } finally {
      if (isCurrentReaction()) setGroupReactionWorkingMessageId(null)
    }
  }

  const selected = bots.find(bot => String(bot.id) === selectedBotId)
  const selectedGroup = groups.find(group => String(group.id) === selectedGroupId)
  const mentionOptions = groupMentionQuery === null ? [] : (selectedGroup?.bots ?? [])
    .filter(candidate => candidate.name.toLocaleLowerCase().includes(groupMentionQuery.toLocaleLowerCase()))
  const activeMention = mentionOptions[groupMentionIndex]
  const selectGroupMention = (candidate: BotGroupView['bots'][number]): void => {
    const cursor = groupInputRef.current?.selectionStart ?? groupDraft.length
    const match = /(?:^|\s)@([^\s@]*)$/.exec(groupDraft.slice(0, cursor))
    const start = match === null ? cursor : cursor - (match[1]?.length ?? 0) - 1
    const next = `${groupDraft.slice(0, start)}@${candidate.name} ${groupDraft.slice(cursor)}`
    groupDraftRevisionRef.current += 1
    groupAttachmentMessageIdRef.current = null
    groupAttachmentDraftTextRef.current = null
    groupAttachmentTargetsRef.current = undefined
    groupMentionSelectionsRef.current = [
      ...groupMentionSelectionsRef.current.filter(item => item.name.toLocaleLowerCase() !== candidate.name.toLocaleLowerCase()),
      { id: String(candidate.id), name: candidate.name },
    ]
    setGroupDraft(next)
    setGroupMentionQuery(null)
    setGroupMentionIndex(0)
    requestAnimationFrame(() => {
      groupInputRef.current?.focus()
      groupInputRef.current?.setSelectionRange(start + candidate.name.length + 2, start + candidate.name.length + 2)
    })
  }
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
                {(client.listApprovals !== undefined
                  && (client.decideApproval !== undefined || client.revokeApprovalGrant !== undefined)) && (
                  <SharedApprovalsCard
                    client={client}
                    scope={{ botId: String(selected.id) }}
                    botName={selected.name}
                    t={t}
                  />
                )}
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
                  {client.readGroupSettings !== undefined && (
                    <Tooltip label={t('sharedGroupSettingsOpen')} side="bottom" portal>
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid="shared-group-settings-open"
                        aria-label={t('sharedGroupSettingsOpen')}
                        icon={<IconSettingsOutlineRegular size={14} />}
                        disabled={groupWorking !== null || groupSettingsWorking !== null}
                        onClick={openGroupSettings}
                      />
                    </Tooltip>
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
                {(client.listApprovals !== undefined
                  && (client.decideApproval !== undefined || client.revokeApprovalGrant !== undefined)) && (
                  <SharedApprovalsCard
                    client={client}
                    scope={{ groupId: String(selectedGroup.id) }}
                    groupName={selectedGroup.name}
                    resolveBotName={botId => selectedGroup.bots.find(bot => String(bot.id) === botId)?.name}
                    t={t}
                  />
                )}
                <div className={css.sharedTranscript}>
                  <div className={css.sharedContextLabel}>{t('sharedGroupsTitle')}</div>
                  {groupMessages.length === 0 && <span className={css.shareEmpty}>{t('sharedGroupTranscriptEmpty')}</span>}
                  {groupMessages.map((messageRow) => {
                    const sender = sharedGroupAuthorLabel(messageRow.sender, client.retryScope, t)
                    const replyToMessageId = readGroupReplyToMessageId(messageRow)
                    const replyParentFromTranscript = replyToMessageId === undefined
                      ? undefined
                      : groupMessages.find(candidate => String(candidate.id) === replyToMessageId)
                    const replyParent = replyParentFromTranscript ?? messageRow.replyTo
                    const replyParentId = replyParent === undefined ? undefined
                      : 'messageId' in replyParent ? String(replyParent.messageId) : String(replyParent.id)
                    const reactions = messageRow.reactions ?? []
                    return (
                      <article
                        id={`yharness-shared-group-message-${String(messageRow.id)}`}
                        className={messageRow.sender.kind === 'user' ? css.sharedUserMessage : css.sharedBotMessage}
                        key={String(messageRow.id)}
                      >
                        <strong>{sender}</strong>
                        {replyParent !== undefined && (
                          <button type="button" className={css.groupReplyQuote} onClick={() => {
                            document.getElementById(`yharness-shared-group-message-${replyParentId}`)
                              ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                          }} aria-label={t('groupJumpToReply', { name: sharedGroupAuthorLabel(replyParent.sender, client.retryScope, t) })}>
                            <span className={css.groupReplyQuoteAuthor}>
                              {sharedGroupAuthorLabel(replyParent.sender, client.retryScope, t)}
                            </span>
                            <span>{compactGroupQuote(replyParent.text)}</span>
                          </button>
                        )}
                        <span className={css.sharedMessageText}>{messageRow.text}</span>
                        <BotGroupSentAttachments
                          attachments={messageRow.attachments}
                          fallbackName={t('groupAttachmentFile')}
                          downloadLabel={name => t('groupDownloadAttachment', { name })}
                          downloadUrl={attachmentId => `/shared-bots/bots/share/downloadAttachment?${new URLSearchParams({
                            groupId: String(selectedGroup.id), messageId: String(messageRow.id), attachmentId,
                          })}`}
                        />
                        <div className={css.groupMessageActions}>
                          <Button
                            variant="ghost"
                            size="sm"
                            className={css.groupMessageAction}
                            aria-label={t('groupReplyTo', { name: sender })}
                            onClick={() => { setGroupReplyingTo(messageRow); groupInputRef.current?.focus() }}
                          >
                            <span aria-hidden="true">↩</span>{t('reply')}
                          </Button>
                          {client.reactGroupMessage !== undefined && (
                            <span className={css.groupReactionTools}>
                              <Button
                                variant="ghost"
                                size="sm"
                                className={css.groupMessageAction}
                                aria-label={t('groupReactTo', { name: sender })}
                                aria-expanded={groupReactionMenuMessageId === String(messageRow.id)}
                                onClick={() => {
                                  setGroupReactionMenuMessageId(current => current === String(messageRow.id) ? null : String(messageRow.id))
                                }}
                              >
                                <span aria-hidden="true">＋</span>{t('react')}
                              </Button>
                              {groupReactionMenuMessageId === String(messageRow.id) && (
                                <MenuSurface className={css.groupReactionMenu} role="menu" aria-label={t('groupReactionPicker')}>
                                  {GROUP_REACTION_OPTIONS.map(emoji => (
                                    <button
                                      key={emoji}
                                      type="button"
                                      role="menuitem"
                                      className={css.groupReactionOption}
                                      aria-label={t('groupReactWith', { emoji })}
                                      onClick={() => {
                                        const current = reactions.find(reaction => reaction.emoji === emoji)
                                        void reactSharedGroupMessage(String(messageRow.id), emoji, current?.viewerReacted === true ? 'remove' : 'add')
                                        setGroupReactionMenuMessageId(null)
                                      }}
                                    >{emoji}</button>
                                  ))}
                                </MenuSurface>
                              )}
                            </span>
                          )}
                        </div>
                        {reactions.length > 0 && (
                          <div className={css.groupReactions} aria-label={t('groupReactions')}>
                            {reactions.map(reaction => (
                              <button
                                key={reaction.emoji}
                                type="button"
                                className={clsx(css.groupReactionChip, reaction.viewerReacted === true && css.groupReactionChipSelected)}
                                aria-pressed={reaction.viewerReacted === true}
                                aria-label={t('groupReactWithCount', { emoji: reaction.emoji, count: reaction.count })}
                                disabled={groupReactionWorkingMessageId === String(messageRow.id)}
                                onClick={() => { void reactSharedGroupMessage(String(messageRow.id), reaction.emoji, reaction.viewerReacted === true ? 'remove' : 'add') }}
                              >
                                <span aria-hidden="true">{reaction.emoji}</span><span>{reaction.count}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </article>
                    )
                  })}
                </div>
                <form className={css.sharedComposer} onSubmit={(event) => { event.preventDefault(); void sendGroup() }}>
                  {groupReplyingTo !== null && (
                    <div className={css.groupReplyComposerPreview} role="status">
                      <span className={css.groupReplyComposerCopy}>
                        <strong>{t('groupReplyingTo', { name: sharedGroupAuthorLabel(groupReplyingTo.sender, client.retryScope, t) })}</strong>
                        <span>{compactGroupQuote(groupReplyingTo.text)}</span>
                      </span>
                      <Button variant="ghost" size="sm" aria-label={t('clearReply')} onClick={() => { setGroupReplyingTo(null) }}>
                        <span aria-hidden="true">×</span>{t('clear')}
                      </Button>
                    </div>
                  )}
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
                  {groupMentionQuery !== null && mentionOptions.length > 0 && (
                    <MenuSurface className={css.mentionMenu} role="listbox" id={`${selectedGroup.id}-mentions`} aria-label={t('mentionBots')}>
                      {mentionOptions.map((candidate, index) => (
                        <button type="button" role="option" key={candidate.id}
                          id={`${selectedGroup.id}-mention-${candidate.id}`}
                          aria-selected={index === groupMentionIndex}
                          className={clsx(css.mentionOption, index === groupMentionIndex && css.mentionOptionSelected)}
                          onMouseDown={(event) => { event.preventDefault() }}
                          onClick={() => { selectGroupMention(candidate) }}>
                          <BotAvatar name={candidate.name} identity={candidate.identity} accent={candidate.accent}
                            botId={String(candidate.id)} loadAvatar={undefined} size="small" />
                          <span className={css.mentionOptionCopy}>
                            <span className={css.mentionOptionName}>{candidate.name}</span>
                            <span className={css.mentionOptionHint}>{t('mentionBotHint')}</span>
                          </span>
                        </button>
                      ))}
                    </MenuSurface>
                  )}
                  <div className={css.sharedComposerTextRow}>
                    <Input
                      ref={groupInputRef}
                      role="combobox"
                      aria-autocomplete="list"
                      aria-expanded={groupMentionQuery !== null && mentionOptions.length > 0}
                      aria-controls={groupMentionQuery !== null && mentionOptions.length > 0 ? `${selectedGroup.id}-mentions` : undefined}
                      aria-activedescendant={groupMentionQuery !== null && activeMention !== undefined
                        ? `${selectedGroup.id}-mention-${activeMention.id}` : undefined}
                      value={groupDraft}
                      placeholder={t('sharedGroupMessagePlaceholder', { name: selectedGroup.name })}
                      aria-label={t('sharedGroupMessagePlaceholder', { name: selectedGroup.name })}
                      onFocus={(event) => { event.currentTarget.scrollIntoView?.({ block: 'nearest' }) }}
                      onChange={(event) => {
                        groupDraftRevisionRef.current += 1
                        if (groupAttachmentMessageIdRef.current !== null && groupAttachmentDraftTextRef.current !== null
                          && event.currentTarget.value.trim() !== groupAttachmentDraftTextRef.current) {
                          groupAttachmentMessageIdRef.current = null
                          groupAttachmentDraftTextRef.current = null
                          groupAttachmentTargetsRef.current = undefined
                        }
                        setGroupAttachmentError(null)
                        setGroupDraft(event.currentTarget.value)
                        setGroupMentionQuery(mentionQueryAt(
                          event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length,
                        ))
                        setGroupMentionIndex(0)
                      }}
                      onBlur={() => { setGroupMentionQuery(null) }}
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing) {
                          event.preventDefault()
                          return
                        }
                        if (groupMentionQuery !== null && mentionOptions.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                          event.preventDefault()
                          setGroupMentionIndex(current => event.key === 'ArrowDown'
                            ? (current + 1) % mentionOptions.length : (current - 1 + mentionOptions.length) % mentionOptions.length)
                        } else if (groupMentionQuery !== null && mentionOptions.length > 0 && (event.key === 'Enter' || event.key === 'Tab')) {
                          event.preventDefault()
                          const candidate = mentionOptions[groupMentionIndex]
                          if (candidate !== undefined) selectGroupMention(candidate)
                        } else if (event.key === 'Escape' && groupMentionQuery !== null) {
                          event.preventDefault()
                          setGroupMentionQuery(null)
                        }
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
      {selectedGroup !== undefined && client.readGroupSettings !== undefined && (
        <SharedGroupSettingsDialog
          open={open && groupSettingsOpen}
          onClose={() => { if (groupSettingsWorking === null) setGroupSettingsOpen(false) }}
          group={selectedGroup}
          settings={groupSettings}
          working={groupSettingsWorking}
          error={groupSettingsError}
          onRename={renameSharedGroup}
          onRequestRemove={(principalId) => {
            setGroupMemberRemoveTarget(principalId)
            setGroupMemberRemoveAcknowledged(false)
          }}
          selfPrincipalId={client.retryScope}
          t={t}
        />
      )}
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
      <RiskConfirmation
        open={open && groupMemberRemoveTarget !== null}
        title={t('sharedGroupSettingsRemoveTitle')}
        description={t('sharedGroupSettingsRemoveDescription', { id: groupMemberRemoveTarget ?? '' })}
        acknowledgeLabel={t('sharedGroupSettingsRemoveAcknowledge')}
        cancelLabel={t('cancel')}
        closeLabel={t('cancel')}
        confirmLabel={t('sharedGroupSettingsRemoveConfirm')}
        acknowledged={groupMemberRemoveAcknowledged}
        disabled={groupSettingsWorking !== null}
        onAcknowledgedChange={setGroupMemberRemoveAcknowledged}
        onCancel={() => { setGroupMemberRemoveTarget(null); setGroupMemberRemoveAcknowledged(false) }}
        onConfirm={() => { void removeSharedGroupMember() }}
      />
    </>
  )
}
