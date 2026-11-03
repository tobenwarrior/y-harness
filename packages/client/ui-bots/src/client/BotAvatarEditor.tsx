import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@yharness/client-ui-slots'
import {
  Button, IconSparkleRegular, IconTrashOutlineRegular, Modal, SegmentedTabs, StateDot,
} from '@yharness/client-ui-primitives'
import type { BotAvatar as SharedBotAvatar } from '@yharness/bots/client'
import type {
  AvatarGenerationStatus,
  AvatarGenerationValue,
} from '@yharness/avatar-generation/types'
import { BotAppearancePicker } from './BotAppearancePicker.tsx'
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

type AvatarEditorTab = 'character' | 'generate' | 'upload'
type AvatarCrop = { readonly x: number; readonly y: number; readonly zoom: number }
const DEFAULT_CROP: AvatarCrop = { x: 50, y: 50, zoom: 1 }

/** Render semantic character controls and the optional generated-avatar flow for one Bot. */
export function BotAvatarEditor({ bot, actions, loadAvatar, open, onClose, onOpenSettings, t }: BotAvatarEditorProps) {
  const appearanceEditingAvailable = actions.updateAppearance !== undefined
  const generationAvailable = actions.status !== undefined
    && actions.generate !== undefined
    && actions.commit !== undefined
    && actions.update !== undefined
  const uploadAvailable = actions.upload !== undefined
  const [tab, setTab] = useState<AvatarEditorTab>(() => appearanceEditingAvailable ? 'character' : generationAvailable ? 'generate' : 'upload')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<AvatarGenerationStatus | null>(null)
  const [statusError, setStatusError] = useState(false)
  const [statusAttempt, setStatusAttempt] = useState(0)
  const [generated, setGenerated] = useState<AvatarGenerationValue | null>(null)
  const [uploaded, setUploaded] = useState<AvatarGenerationValue | null>(null)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [crop, setCrop] = useState<AvatarCrop>(DEFAULT_CROP)
  const [committed, setCommitted] = useState<{ readonly preview: AvatarGenerationValue; readonly avatar: SharedBotAvatar } | null>(null)
  const [identity, setIdentity] = useState<BotIdentity>(bot.identity ?? 'agent')
  const [accent, setAccent] = useState<BotAccent>(bot.accent ?? 'violet')
  const [working, setWorking] = useState<'status' | 'generate' | 'update' | 'appearance' | 'upload' | null>(null)
  const [error, setError] = useState<'generate' | 'update' | 'appearance' | 'upload' | null>(null)
  const request = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open) return
    setTab(appearanceEditingAvailable ? 'character' : generationAvailable ? 'generate' : 'upload')
    setDescription('')
    setStatus(null)
    setStatusError(false)
    setGenerated(null)
    setUploaded(null)
    setUploadFile(null)
    setCrop(DEFAULT_CROP)
    setCommitted(null)
    setIdentity(bot.identity ?? 'agent')
    setAccent(bot.accent ?? 'violet')
    setError(null)
    setWorking(null)
    return () => {
      request.current?.abort()
      request.current = null
    }
  }, [appearanceEditingAvailable, generationAvailable, bot.id, open])

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

  const commitPreview = async (preview: AvatarGenerationValue | null) => {
    const commitPreview = actions.commit
    const updateAvatar = actions.update
    if (commitPreview === undefined || updateAvatar === undefined || preview === null || working !== null) return
    setWorking('update')
    setError(null)
    try {
      const avatar = committed?.preview === preview ? committed.avatar : (await commitPreview(preview)).attachment
      setCommitted({ preview, avatar })
      await updateAvatar(bot.id, avatar)
      onClose()
    } catch {
      setError('update')
    } finally {
      setWorking(null)
    }
  }

  const saveUpload = async () => {
    if (actions.upload === undefined || uploaded === null || working !== null) return
    setWorking('update')
    setError(null)
    try {
      await actions.upload(bot.id, uploaded)
      onClose()
    } catch {
      setError('update')
    } finally {
      setWorking(null)
    }
  }

  const upload = async (file: File | undefined, nextCrop: AvatarCrop) => {
    if (file === undefined || (working !== null && working !== 'upload')) return
    request.current?.abort()
    setCommitted(null)
    setError(null)
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 25 * 1024 * 1024) {
      setUploaded(null)
      setUploadFile(null)
      setError('upload')
      return
    }
    setUploadFile(file)
    const controller = new AbortController()
    request.current = controller
    setWorking('upload')
    try {
      const bitmap = await createImageBitmap(file)
      try {
        if (controller.signal.aborted) return
        const canvas = document.createElement('canvas')
        canvas.width = 512
        canvas.height = 512
        const context = canvas.getContext('2d')
        if (context === null || bitmap.width < 1 || bitmap.height < 1) throw new Error('Image is unavailable')
        const side = Math.min(bitmap.width, bitmap.height) / nextCrop.zoom
        const left = (bitmap.width - side) * nextCrop.x / 100
        const top = (bitmap.height - side) * nextCrop.y / 100
        context.drawImage(bitmap, left, top, side, side, 0, 0, 512, 512)
        const data = canvas.toDataURL('image/png').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/)?.[1]
        if (data === undefined) throw new Error('Image encoding failed')
        setUploaded({ data, mediaType: 'image/png' })
      } finally {
        bitmap.close()
      }
    } catch {
      if (!controller.signal.aborted) { setUploaded(null); setError('upload') }
    } finally {
      if (request.current === controller) {
        request.current = null
        setWorking(null)
      }
    }
  }

  const changeCrop = (next: AvatarCrop) => {
    setCrop(next)
    if (uploadFile !== null) void upload(uploadFile, next)
  }

  const saveAppearance = async () => {
    if (actions.updateAppearance === undefined || (working !== null && working !== 'status')) return
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
    && (working === null || working === 'status')
  const showLegacyCharacterAction = !appearanceEditingAvailable
    && generationAvailable
    && bot.avatar !== undefined
    && generated === null
  const editorTabs = [
    ...(appearanceEditingAvailable ? [{ value: 'character' as const, label: t('avatarCharacterTab'), id: 'yharness-bots-avatar-character-tab', panelId: 'yharness-bots-avatar-character-panel' }] : []),
    ...(generationAvailable ? [{ value: 'generate' as const, label: t('avatarGenerateTab'), id: 'yharness-bots-avatar-generate-tab', panelId: 'yharness-bots-avatar-generate-panel' }] : []),
    ...(uploadAvailable ? [{ value: 'upload' as const, label: t('avatarUploadTab'), id: 'yharness-bots-avatar-upload-tab', panelId: 'yharness-bots-avatar-upload-panel' }] : []),
  ]
  const firstTab = editorTabs[0] ?? {
    value: 'character' as const, label: t('avatarCharacterTab'),
    id: 'yharness-bots-avatar-character-tab', panelId: 'yharness-bots-avatar-character-panel',
  }
  const availableTabs: [typeof firstTab, ...typeof firstTab[]] = [firstTab, ...editorTabs.slice(1)]
  const activeTab: AvatarEditorTab = availableTabs.some(item => item.value === tab) ? tab : firstTab.value

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
              onClick={() => { void commitPreview(generated) }}
              disabled={working !== null}
            >
              {working === 'update' ? t('avatarSaving') : t('avatarUse')}
            </Button>
          )}
          {activeTab === 'upload' && uploaded !== null && (
            <Button variant="primary" onClick={() => { void saveUpload() }} disabled={working !== null}>
              {working === 'update' ? t('avatarSaving') : t('avatarUse')}
            </Button>
          )}
        </>
      )}
    >
      <SegmentedTabs<AvatarEditorTab>
        items={availableTabs}
        value={activeTab}
        onChange={(next) => { setTab(next); setError(null) }}
        label={t('avatarModeLabel')}
        className={css.avatarEditorTabs}
      />
      <div
        id="yharness-bots-avatar-character-panel"
        role="tabpanel"
        aria-labelledby="yharness-bots-avatar-character-tab"
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
            </div>
          </div>
          <div className={css.avatarEditorForm}>
            <BotAppearancePicker
              identity={identity}
              accent={accent}
              onIdentityChange={setIdentity}
              onAccentChange={setAccent}
              onAppearanceChange={() => { setError(null) }}
              disabled={working !== null && working !== 'status'}
              t={t}
            />
            {error !== null && <div className={css.avatarNotice} role="alert">
              {error === 'appearance' ? t('avatarAppearanceSaveFailed') : t('avatarSaveFailed')}
            </div>}
          </div>
        </div>
      </div>
      <div
        id="yharness-bots-avatar-upload-panel"
        role="tabpanel"
        aria-labelledby="yharness-bots-avatar-upload-tab"
        hidden={activeTab !== 'upload'}
        tabIndex={0}
      >
        <div className={css.avatarEditorLayout}>
          <div className={css.avatarEditorPreviewColumn}>
            {uploaded !== null && <div className={css.avatarPreviewCard}>
              <img className={css.avatarGeneratedPreview} src={previewURL(uploaded)} alt={t('avatarUploadPreviewAlt')} />
            </div>}
          </div>
          <div className={css.avatarEditorForm}>
            <label className={css.avatarEditorLabel} htmlFor="yharness-bots-avatar-upload">{t('avatarUploadLabel')}</label>
            <input id="yharness-bots-avatar-upload" type="file" accept="image/png,image/jpeg,image/webp,image/gif"
              className={css.avatarUploadInput}
              onClick={(event) => { if (error === 'upload') event.currentTarget.value = '' }}
              disabled={working !== null} onChange={(event) => {
                const file = event.currentTarget.files?.[0]
                setCrop(DEFAULT_CROP)
                void upload(file, DEFAULT_CROP)
              }} />
            <span className={css.avatarEditorLabel}>{t('avatarUploadHelp')}</span>
            {uploadFile !== null && <>
              <label className={css.avatarEditorLabel} htmlFor="yharness-avatar-crop-zoom">{t('avatarCropZoom')}</label>
              <input id="yharness-avatar-crop-zoom" type="range" min="1" max="3" step="0.1" value={crop.zoom}
                disabled={working !== null && working !== 'upload'} onChange={(event) => { changeCrop({ ...crop, zoom: Number(event.currentTarget.value) }) }} />
              <label className={css.avatarEditorLabel} htmlFor="yharness-avatar-crop-x">{t('avatarCropHorizontal')}</label>
              <input id="yharness-avatar-crop-x" type="range" min="0" max="100" value={crop.x}
                disabled={working !== null && working !== 'upload'} onChange={(event) => { changeCrop({ ...crop, x: Number(event.currentTarget.value) }) }} />
              <label className={css.avatarEditorLabel} htmlFor="yharness-avatar-crop-y">{t('avatarCropVertical')}</label>
              <input id="yharness-avatar-crop-y" type="range" min="0" max="100" value={crop.y}
                disabled={working !== null && working !== 'upload'} onChange={(event) => { changeCrop({ ...crop, y: Number(event.currentTarget.value) }) }} />
            </>}
            {error !== null && <div className={css.avatarNotice} role="alert">{t(error === 'upload' ? 'avatarUploadFailed' : 'avatarSaveFailed')}</div>}
          </div>
        </div>
      </div>
      <div
        id="yharness-bots-avatar-generate-panel"
        role="tabpanel"
        aria-labelledby="yharness-bots-avatar-generate-tab"
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
            <label className={css.avatarEditorLabel} htmlFor="yharness-bots-avatar-description">{t('avatarPromptLabel')}</label>
            <textarea
              id="yharness-bots-avatar-description"
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
