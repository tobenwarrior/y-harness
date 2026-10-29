import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, IconSparkleRegular, IconTrashOutlineRegular, Modal, SegmentedTabs, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { BotAvatar as SharedBotAvatar } from '@deepseek-ai/dsh-bots/client'
import type {
  AvatarGenerationStatus,
  AvatarGenerationValue,
} from '@deepseek-ai/dsh-avatar-generation/types'
import { BotAppearancePicker, botIdentityLabelKey } from './BotAppearancePicker.tsx'
import { BotAvatar } from './BotAvatar.tsx'
import css from './BotWorkspace.module.css'
import type { BotAccent, BotAvatarEditorActions, BotIdentity, BotSummary, BotWorkspaceProps } from './types.ts'

type Translate = PropsLocale<'bots'>['t']

/** Props for the selected Bot's generated-avatar editor. */
export interface BotAvatarEditorProps {
  /** Selected Bot row whose avatar is being edited. */
  readonly bot: BotSummary
  /** Host-backed character and generated-avatar actions; generation is optional. */
  readonly actions: BotAvatarEditorActions
  /** Existing Bot-owned image loader used by the current-avatar preview. */
  readonly loadAvatar?: BotWorkspaceProps['loadAvatar']
  /** Whether the editor modal is visible. */
  readonly open: boolean
  /** Close the editor without changing the current avatar. */
  readonly onClose: () => void
  /** Optional settings deep-link supplied by the surrounding composition. */
  readonly onOpenSettings?: (() => void) | undefined
  /** Locale-owned Bot workspace translator. */
  readonly t: Translate
}

const DESCRIPTION_LIMIT = 800

function availabilityMessage(status: Extract<AvatarGenerationStatus, { available: false }>, t: Translate): string {
  switch (status.reason) {
    case 'openai-provider-not-configured': return t('avatarUnavailableProvider')
    case 'openai-credential-not-configured': return t('avatarUnavailableCredential')
    case 'credential-store-unavailable': return t('avatarUnavailableCredentialStore')
    case 'invalid-credential-reference': return t('avatarUnavailableCredential')
    case 'attachments-unavailable': return t('avatarUnavailableStorage')
    default: return t('avatarUnavailableStorage')
  }
}

function previewURL(value: AvatarGenerationValue): string {
  return `data:${value.mediaType};base64,${value.data}`
}

type AvatarEditorTab = 'character' | 'generate'

/** Render semantic character controls and the optional generated-avatar flow for one Bot. */
export function BotAvatarEditor({ bot, actions, loadAvatar, open, onClose, onOpenSettings, t }: BotAvatarEditorProps) {
  const appearanceEditingAvailable = actions.updateAppearance !== undefined
  const generationAvailable = actions.status !== undefined
    && actions.generate !== undefined
    && actions.commit !== undefined
    && actions.update !== undefined
  const [tab, setTab] = useState<AvatarEditorTab>(() => appearanceEditingAvailable ? 'character' : 'generate')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<AvatarGenerationStatus | null>(null)
  const [statusError, setStatusError] = useState(false)
  const [statusAttempt, setStatusAttempt] = useState(0)
  const [generated, setGenerated] = useState<AvatarGenerationValue | null>(null)
  const [committed, setCommitted] = useState<SharedBotAvatar | null>(null)
  const [identity, setIdentity] = useState<BotIdentity>(bot.identity ?? 'agent')
  const [accent, setAccent] = useState<BotAccent>(bot.accent ?? 'violet')
  const [working, setWorking] = useState<'status' | 'generate' | 'update' | 'appearance' | null>(null)
  const [error, setError] = useState<'generate' | 'update' | 'appearance' | null>(null)
  const request = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open) return
    setTab(appearanceEditingAvailable ? 'character' : 'generate')
    setDescription('')
    setStatus(null)
    setStatusError(false)
    setGenerated(null)
    setCommitted(null)
    setIdentity(bot.identity ?? 'agent')
    setAccent(bot.accent ?? 'violet')
    setError(null)
    setWorking(null)
    return () => {
      request.current?.abort()
      request.current = null
    }
  }, [appearanceEditingAvailable, bot.id, open])

  useEffect(() => {
    const checkStatus = actions.status
    if (!open || !generationAvailable || tab !== 'generate' || checkStatus === undefined) return
    let live = true
    setStatus(null)
    setStatusError(false)
    setWorking(current => current === null || current === 'status' ? 'status' : current)
    void checkStatus().then((value) => {
      if (!live) return
      setStatus(value)
      setWorking(current => current === 'status' ? null : current)
    }).catch(() => {
      if (!live) return
      setStatusError(true)
      setWorking(current => current === 'status' ? null : current)
    })
    return () => {
      live = false
      setWorking(current => current === 'status' ? null : current)
    }
  }, [actions, generationAvailable, open, statusAttempt, tab])

  const close = () => {
    request.current?.abort()
    request.current = null
    onClose()
  }

  const generate = async () => {
    const generateAvatar = actions.generate
    const prompt = description.trim()
    if (generateAvatar === undefined || prompt === '' || working !== null || status?.available !== true) return
    const controller = new AbortController()
    request.current = controller
    setWorking('generate')
    setError(null)
    try {
      const value = await generateAvatar({ description: prompt }, controller.signal)
      if (!controller.signal.aborted) {
        setGenerated(value)
        setCommitted(null)
      }
    } catch {
      if (!controller.signal.aborted) setError('generate')
    } finally {
      if (request.current === controller) {
        request.current = null
        setWorking(null)
      }
    }
  }

  const update = async (avatar: SharedBotAvatar | null) => {
    const updateAvatar = actions.update
    if (updateAvatar === undefined || working !== null) return
    setWorking('update')
    setError(null)
    try {
      await updateAvatar(bot.id, avatar)
      onClose()
    } catch {
      setError('update')
    } finally {
      setWorking(null)
    }
  }

  const commitGenerated = async () => {
    const commitPreview = actions.commit
    const updateAvatar = actions.update
    if (commitPreview === undefined || updateAvatar === undefined || generated === null || working !== null) return
    setWorking('update')
    setError(null)
    try {
      const avatar = committed ?? (await commitPreview(generated)).attachment
      setCommitted(avatar)
      await updateAvatar(bot.id, avatar)
      onClose()
    } catch {
      setError('update')
    } finally {
      setWorking(null)
    }
  }

  const saveAppearance = async () => {
    if (actions.updateAppearance === undefined || working === 'appearance' || working === 'generate' || working === 'update') return
    setWorking('appearance')
    setError(null)
    try {
      await actions.updateAppearance(bot.id, { identity, accent, clearAvatar: true })
      onClose()
    } catch {
      setError('appearance')
    } finally {
      setWorking(null)
    }
  }

  const unavailable = status !== null && !status.available
  const statusMessage = statusError
    ? t('avatarStatusFailed')
    : unavailable
      ? availabilityMessage(status, t)
      : undefined
  const canGenerate = generationAvailable && status?.available === true && description.trim() !== '' && working === null
  const currentIdentity = bot.identity ?? 'agent'
  const currentAccent = bot.accent ?? 'violet'
  const appearanceChanged = identity !== currentIdentity || accent !== currentAccent || bot.avatar !== undefined
  const canSaveAppearance = actions.updateAppearance !== undefined
    && appearanceChanged
    && working !== 'appearance'
    && working !== 'generate'
    && working !== 'update'
  const showLegacyCharacterAction = !appearanceEditingAvailable
    && generationAvailable
    && bot.avatar !== undefined
    && generated === null
  const editorTabs = appearanceEditingAvailable && generationAvailable
    ? [
      { value: 'character' as const, label: t('avatarCharacterTab'), id: 'dsh-bots-avatar-character-tab', panelId: 'dsh-bots-avatar-character-panel' },
      { value: 'generate' as const, label: t('avatarGenerateTab'), id: 'dsh-bots-avatar-generate-tab', panelId: 'dsh-bots-avatar-generate-panel' },
    ] as const
    : appearanceEditingAvailable
      ? [
        { value: 'character' as const, label: t('avatarCharacterTab'), id: 'dsh-bots-avatar-character-tab', panelId: 'dsh-bots-avatar-character-panel' },
      ] as const
      : [
        { value: 'generate' as const, label: t('avatarGenerateTab'), id: 'dsh-bots-avatar-generate-tab', panelId: 'dsh-bots-avatar-generate-panel' },
      ] as const
  const activeTab: AvatarEditorTab = appearanceEditingAvailable
    ? tab === 'generate' && generationAvailable ? 'generate' : 'character'
    : 'generate'

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('avatarEditorTitle')}
      description={t('avatarEditorDescription')}
      closeLabel={t('cancel')}
      className={css.avatarEditorModal as string}
      contentClassName={css.avatarEditorModalContent as string}
      footer={(
        <>
          <Button variant="ghost" onClick={close} disabled={working === 'update' || working === 'appearance'}>{t('cancel')}</Button>
          {showLegacyCharacterAction && (
            <Button
              variant="outline"
              onClick={() => { void update(null) }}
              disabled={working !== null}
              icon={<IconTrashOutlineRegular size={14} />}
            >
              {t('avatarUseCharacter')}
            </Button>
          )}
          {activeTab === 'character' && actions.updateAppearance !== undefined && (
            <Button
              variant="outline"
              onClick={() => { void saveAppearance() }}
              disabled={!canSaveAppearance}
            >
              {working === 'appearance' ? t('avatarSavingCharacter') : t('avatarSaveCharacter')}
            </Button>
          )}
          {activeTab === 'generate' && generated !== null && (
            <Button
              variant="primary"
              onClick={() => { void commitGenerated() }}
              disabled={working !== null}
            >
              {working === 'update' ? t('avatarSaving') : t('avatarUse')}
            </Button>
          )}
        </>
      )}
    >
      <SegmentedTabs<AvatarEditorTab>
        items={editorTabs}
        value={activeTab}
        onChange={(next) => { setTab(next); setError(null) }}
        label={t('avatarModeLabel')}
        className={css.avatarEditorTabs}
      />
      <div
        id="dsh-bots-avatar-character-panel"
        role="tabpanel"
        aria-labelledby="dsh-bots-avatar-character-tab"
        hidden={activeTab !== 'character'}
        tabIndex={0}
      >
        <div className={css.avatarEditorLayout}>
          <div className={css.avatarEditorPreviewColumn}>
            <span className={css.avatarEditorLabel}>{t('avatarCurrentLabel')}</span>
            <div className={css.avatarPreviewCard}>
              <BotAvatar
                name={bot.name}
                identity={bot.identity}
                accent={bot.accent}
                avatar={bot.avatar}
                botId={bot.id}
                loadAvatar={loadAvatar}
                size="large"
              />
              <span className={css.avatarPreviewName}>{bot.name}</span>
            </div>
            <span className={css.avatarEditorLabel}>{t('avatarCharacterPreviewLabel')}</span>
            <div className={css.avatarPreviewCard} data-preview="character">
              <BotAvatar name={bot.name} identity={identity} accent={accent} size="large" />
              <span className={css.avatarPreviewName}>{t(botIdentityLabelKey(identity))}</span>
            </div>
          </div>
          <div className={css.avatarEditorForm}>
            <BotAppearancePicker
              identity={identity}
              accent={accent}
              onIdentityChange={setIdentity}
              onAccentChange={setAccent}
              onAppearanceChange={() => { setError(null) }}
              disabled={working === 'appearance' || working === 'generate' || working === 'update'}
              t={t}
            />
            {error !== null && <div className={css.avatarNotice} role="alert">
              {error === 'appearance' ? t('avatarAppearanceSaveFailed') : t('avatarSaveFailed')}
            </div>}
          </div>
        </div>
      </div>
      <div
        id="dsh-bots-avatar-generate-panel"
        role="tabpanel"
        aria-labelledby="dsh-bots-avatar-generate-tab"
        hidden={activeTab !== 'generate'}
        tabIndex={0}
      >
        <div className={css.avatarEditorLayout}>
          <div className={css.avatarEditorPreviewColumn}>
            <span className={css.avatarEditorLabel}>{t('avatarCurrentLabel')}</span>
            <div className={css.avatarPreviewCard}>
              <BotAvatar
                name={bot.name}
                identity={bot.identity}
                accent={bot.accent}
                avatar={bot.avatar}
                botId={bot.id}
                loadAvatar={loadAvatar}
                size="large"
              />
              <span className={css.avatarPreviewName}>{bot.name}</span>
            </div>
            {generated !== null && (
              <div className={css.avatarPreviewCard} data-preview="generated">
                <span className={css.avatarEditorLabel}>{t('avatarGeneratedLabel')}</span>
                <img className={css.avatarGeneratedPreview} src={previewURL(generated)} alt={t('avatarGeneratedPreviewAlt')} />
              </div>
            )}
          </div>
          <div className={css.avatarEditorForm}>
            <label className={css.avatarEditorLabel} htmlFor="dsh-bots-avatar-description">{t('avatarPromptLabel')}</label>
            <textarea
              id="dsh-bots-avatar-description"
              className={css.avatarPrompt}
              value={description}
              maxLength={DESCRIPTION_LIMIT}
              placeholder={t('avatarPromptPlaceholder')}
              onChange={(event) => { setDescription(event.currentTarget.value) }}
              disabled={working !== null}
            />
            <span className={css.avatarPromptCount}>{description.length}/{DESCRIPTION_LIMIT}</span>
            {working === 'status' && <div className={css.avatarStatus} role="status"><StateDot state="ongoing" size={13} />{t('avatarChecking')}</div>}
            {statusMessage !== undefined && (
              <div className={css.avatarNotice} role={statusError || unavailable ? 'alert' : 'status'}>
                <span>{statusMessage}</span>
                {statusError
                  ? <Button variant="ghost" size="sm" onClick={() => { setStatusAttempt(attempt => attempt + 1) }}>{t('retry')}</Button>
                  : unavailable && onOpenSettings !== undefined && <Button variant="ghost" size="sm" onClick={onOpenSettings}>{t('avatarOpenSettings')}</Button>}
              </div>
            )}
            {error !== null && <div className={css.avatarNotice} role="alert">
              {error === 'generate' ? t('avatarGenerateFailed') : t('avatarSaveFailed')}
            </div>}
            <Button
              variant="primary"
              onClick={() => { void generate() }}
              disabled={!canGenerate}
              icon={working === 'generate' ? <StateDot state="ongoing" size={14} /> : <IconSparkleRegular size={14} />}
            >
              {working === 'generate' ? t('avatarGenerating') : t('avatarGenerate')}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
