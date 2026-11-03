import { useEffect, useState } from 'react'
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
import type { BotSummary } from './types.ts'
import type { SharedBotsClient } from './shared-client.ts'

type Translate = PropsLocale<'bots'>['t']

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

  const load = async (): Promise<void> => {
    setWorking('load')
    setError(null)
    try {
      const value = await actions.listMembers(bot.id)
      setMembers(value.members)
      if (actions.getMemoryPolicy !== undefined) setMemoryPolicy(await actions.getMemoryPolicy(bot.id))
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t('shareError'))
    } finally {
      setWorking(current => current === 'load' ? null : current)
    }
  }

  useEffect(() => {
    if (!open) return
    setInvite(null)
    setCopied(false)
    setMemoryPolicy(null)
    setMemoryTarget(null)
    setMemoryAcknowledged(false)
    void load()
  }, [bot.id, open])

  const createInvite = async (): Promise<void> => {
    if (working !== null) return
    setWorking('invite')
    setError(null)
    setCopied(false)
    try {
      setInvite(await actions.createInvite(bot.id, role))
      await load()
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t('shareError'))
    } finally {
      setWorking(null)
    }
  }

  const revoke = async (member: BotShareMember): Promise<void> => {
    if (member.role === 'owner' || working !== null) return
    setWorking('revoke')
    setError(null)
    try {
      await actions.revokeMember(bot.id, String(member.principalId))
      setMembers(current => current.filter(candidate => candidate.principalId !== member.principalId))
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t('shareError'))
    } finally {
      setWorking(null)
    }
  }

  const confirmMemoryPolicy = async (): Promise<void> => {
    if (memoryTarget === null || actions.setMemoryPolicy === undefined || memoryWorking) return
    setMemoryWorking(true)
    setError(null)
    try {
      setMemoryPolicy(await actions.setMemoryPolicy(bot.id, memoryTarget))
      setMemoryTarget(null)
      setMemoryAcknowledged(false)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : t('shareError'))
    } finally {
      setMemoryWorking(false)
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
        {error !== null && <div className={css.dialogNotice} role="alert">{error}</div>}
        <div className={css.dialogField}>
          <span className={css.dialogLabel}>{t('shareRoleLabel')}</span>
          <SegmentedControl
            id="yharness-bots-share-role"
            label={t('shareRoleLabel')}
            value={role}
            onChange={(value) => { setRole(value); setInvite(null) }}
            options={[
              { value: 'collaborator', label: t('shareRoleCollaborator') },
              { value: 'manager', label: t('shareRoleManager') },
              { value: 'owner', label: t('shareRoleOwner') },
            ]}
          />
        </div>
        <div className={css.shareInviteRow}>
          <Button variant="primary" onClick={() => { void createInvite() }} disabled={working !== null} icon={<IconLinkOutlineRegular size={14} />}>
            {working === 'invite' ? t('creatingInvite') : t('createInvite')}
          </Button>
          {invite !== null && (
            <div className={css.inviteCode}>
              <code aria-label={t('inviteCodeLabel')}>{invite.code}</code>
              <Tooltip label={copied ? t('copiedInvite') : t('copyInvite')} side="bottom" portal>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={copied ? t('copiedInvite') : t('copyInvite')}
                  icon={<IconCopyOutlineRegular size={14} />}
                  onClick={() => { void writeClipboard(invite.code).then((success) => { if (success) setCopied(true) }) }}
                />
              </Tooltip>
            </div>
          )}
        </div>
        {actions.getMemoryPolicy !== undefined && actions.setMemoryPolicy !== undefined && memoryPolicy !== null && (
          <section className={css.sharedMemoryCard} aria-labelledby="yharness-shared-memory-heading">
            <div className={css.sharedMemoryHeader}>
              <span className={css.sharedMemoryIcon} aria-hidden="true"><IconShieldOutlineRegular size={16} /></span>
              <div>
                <div className={css.shareSectionHeading} id="yharness-shared-memory-heading">{t('sharedMemoryLabel')}</div>
                <p className={css.sharedMemoryDescription}>{t('sharedMemoryDescription')}</p>
              </div>
              <Switch
                checked={memoryPolicy.enabled}
                disabled={memoryWorking || working === 'load'}
                label={t('sharedMemoryToggle')}
                onChange={(next) => { setMemoryTarget(next); setMemoryAcknowledged(false) }}
              />
            </div>
          </section>
        )}
        <div className={css.shareMembers}>
          <div className={css.shareSectionHeading}>{t('membersLabel')}</div>
          {working === 'load' && <div className={css.shareLoading} role="status"><StateDot state="ongoing" size={12} /></div>}
          {working !== 'load' && members.length === 0 && <div className={css.shareEmpty}>{t('noMembers')}</div>}
          {working !== 'load' && members.map(member => (
            <div className={css.shareMember} key={String(member.principalId)}>
              <span className={css.shareMemberIdentity}>
                <span className={css.shareMemberDot} aria-hidden="true" />
                <span className={css.shareMemberPrincipal}>{String(member.principalId)}</span>
                <Tag tone={member.role === 'owner' ? 'info' : 'neutral'}>{member.role}</Tag>
              </span>
              {member.role === 'owner'
                ? <span className={css.shareMemberHint}>{t('revokeOwnerDisabled')}</span>
                : (
                  <Tooltip label={t('revokeMember')} side="top" portal>
                    <Button variant="ghost" size="sm" aria-label={`${t('revokeMember')}: ${String(member.principalId)}`} icon={<IconTrashOutlineRegular size={14} />} disabled={working !== null} onClick={() => { void revoke(member) }} />
                  </Tooltip>
                )}
            </div>
          ))}
        </div>
      </Modal>
      <RiskConfirmation
        open={memoryTarget !== null}
        title={memoryTarget === true ? t('enableSharedMemoryTitle') : t('disableSharedMemoryTitle')}
        description={memoryTarget === true ? t('enableSharedMemoryDescription') : t('disableSharedMemoryDescription')}
        acknowledgeLabel={memoryTarget === true ? t('enableSharedMemoryAcknowledge') : t('disableSharedMemoryAcknowledge')}
        cancelLabel={t('cancel')}
        closeLabel={t('cancel')}
        confirmLabel={memoryTarget === true ? t('enableSharedMemory') : t('disableSharedMemory')}
        acknowledged={memoryAcknowledged}
        disabled={memoryWorking}
        onAcknowledgedChange={setMemoryAcknowledged}
        onCancel={() => { setMemoryTarget(null); setMemoryAcknowledged(false) }}
        onConfirm={() => { void confirmMemoryPolicy() }}
      />
    </>
  )
}
/** Collaborator discovery, enrollment, and private chat surface. */
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
  const [message, setMessage] = useState('')
  const [memoryDraft, setMemoryDraft] = useState('')
  const [memoryAcknowledged, setMemoryAcknowledged] = useState(false)
  const [memoryConfirmOpen, setMemoryConfirmOpen] = useState(false)
  const [working, setWorking] = useState<'list' | 'enroll' | 'chat' | null>(null)
  const [memoryWorking, setMemoryWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    setWorking('list')
    setError(null)
    const result = await client.list()
    if (result.ok) {
      setBots(result.value.bots)
      const selected = selectedBotId !== null && result.value.bots.some(bot => String(bot.id) === selectedBotId)
        ? selectedBotId
        : result.value.bots[0] === undefined ? null : String(result.value.bots[0].id)
      setSelectedBotId(selected)
      if (selected !== null) await readBot(selected)
    } else {
      setError(result.error.message)
    }
    setWorking(null)
  }

  const readBot = async (botId: string): Promise<void> => {
    setRecent([])
    setMemory(null)
    setMemoryConfirmOpen(false)
    const [privateResult, memoryResult] = await Promise.all([
      client.readPrivateChat(botId),
      client.readMemory(botId),
    ])
    if (privateResult.ok) setRecent(privateResult.value.recent)
    else setError(privateResult.error.message)
    if (memoryResult.ok) setMemory(memoryResult.value)
    else setError(memoryResult.error.message)
  }

  useEffect(() => {
    if (!open) return
    setError(null)
    void refresh()
  }, [open])

  const enroll = async (): Promise<void> => {
    const trimmed = code.trim()
    if (trimmed === '' || working !== null) return
    setWorking('enroll')
    setError(null)
    const result = await client.enroll(trimmed)
    if (result.ok) {
      setCode('')
      await refresh()
    } else {
      setError(result.error.message || t('sharedEnrollmentFailed'))
    }
    setWorking(null)
  }

  const send = async (): Promise<void> => {
    if (selectedBotId === null || message.trim() === '' || working !== null) return
    setWorking('chat')
    setError(null)
    const result = await client.chat(selectedBotId, message.trim())
    if (result.ok) {
      setMessage('')
      await readBot(selectedBotId)
    } else {
      setError(result.error.message || t('sharedChatFailed'))
    }
    setWorking(null)
  }

  const publishMemory = async (): Promise<void> => {
    if (selectedBotId === null || memoryDraft.trim() === '' || memoryWorking || memory?.enabled !== true) return
    setMemoryWorking(true)
    setError(null)
    const result = await client.writeMemory(selectedBotId, memoryDraft.trim())
    if (result.ok) {
      setMemoryDraft('')
      setMemoryAcknowledged(false)
      setMemoryConfirmOpen(false)
      await readBot(selectedBotId)
    } else {
      setError(result.error.message || t('sharedMemoryWriteFailed'))
    }
    setMemoryWorking(false)
  }

  const selected = bots.find(bot => String(bot.id) === selectedBotId)
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
          <Input value={code} placeholder={t('inviteCodePlaceholder')} aria-label={t('inviteCodeLabel')} onChange={(event) => { setCode(event.currentTarget.value) }} />
          <Button variant="primary" onClick={() => { void enroll() }} disabled={working !== null || code.trim() === ''}>{working === 'enroll' ? t('joining') : t('join')}</Button>
        </div>
        {working === 'list' && <div className={css.shareLoading} role="status"><StateDot state="ongoing" size={12} /></div>}
        {working !== 'list' && bots.length === 0 && <div className={css.shareEmpty}>{t('noSharedBots')}</div>}
        {working !== 'list' && bots.length > 0 && (
          <div className={css.sharedWorkspace}>
            <div className={css.sharedBotList} aria-label={t('sharedBotsTitle')}>
              {bots.map(bot => (
                <button type="button" className={bot.id === selectedBotId ? css.sharedBotSelected : css.sharedBot} key={String(bot.id)} onClick={() => { const id = String(bot.id); setSelectedBotId(id); void readBot(id) }}>
                  <BotAvatar name={bot.name} identity={bot.identity} accent={bot.accent} size="small" />
                  <span><strong>{bot.name}</strong><small>{bot.role}</small></span>
                </button>
              ))}
            </div>
            {selected !== undefined && (
              <section className={css.sharedConversation} aria-label={selected.name}>
                <header className={css.sharedConversationHeader}>
                  <BotAvatar name={selected.name} identity={selected.identity} accent={selected.accent} />
                  <div><strong>{selected.name}</strong><small>{selected.description ?? selected.role}</small></div>
                </header>
                <div className={css.sharedTranscript}>
                  <div className={css.sharedContextLabel}>{t('privateSessionLabel')}</div>
                  {recent.length === 0 && <span className={css.shareEmpty}>{t('sharedTranscriptEmpty')}</span>}
                  {recent.map((entry, index) => <p className={entry.role === 'user' ? css.sharedUserMessage : css.sharedBotMessage} key={`${entry.role}-${index}`}>{entry.text}</p>)}
                </div>
                <form className={css.sharedComposer} onSubmit={(event) => { event.preventDefault(); void send() }}>
                  <Input value={message} placeholder={t('sharedChatPlaceholder')} aria-label={t('sharedChatPlaceholder')} onChange={(event) => { setMessage(event.currentTarget.value) }} />
                  <Button variant="primary" type="submit" aria-label={t('sendMessage')} disabled={working !== null || message.trim() === ''} icon={<IconShareOutlineRegular size={14} />} />
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
                          onChange={(event) => { setMemoryDraft(event.currentTarget.value) }}
                        />
                        <Button
                          variant="outline"
                          disabled={memoryWorking || memoryDraft.trim() === ''}
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
      </Modal>
      <RiskConfirmation
        open={memoryConfirmOpen}
        title={t('publishSharedContextTitle')}
        description={t('publishSharedContextDescription')}
        acknowledgeLabel={t('publishSharedContextAcknowledge')}
        cancelLabel={t('cancel')}
        closeLabel={t('cancel')}
        confirmLabel={t('publishSharedContext')}
        acknowledged={memoryAcknowledged}
        disabled={memoryWorking}
        onAcknowledgedChange={setMemoryAcknowledged}
        onCancel={() => { setMemoryConfirmOpen(false); setMemoryAcknowledged(false) }}
        onConfirm={() => { void publishMemory() }}
      />
    </>
  )
}
