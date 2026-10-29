import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, IconSparkleRegular, IconTrashOutlineRegular, Modal, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { BotAvatar as SharedBotAvatar } from '@deepseek-ai/dsh-bots/client'
import type {
  AvatarGenerationStatus,
  AvatarGenerationValue,
} from '@deepseek-ai/dsh-avatar-generation/types'
import { BotAvatar } from './BotAvatar.tsx'
import css from './BotWorkspace.module.css'
import type { BotAvatarEditorActions, BotSummary, BotWorkspaceProps } from './types.ts'

type Translate = PropsLocale<'bots'>['t']

/** Props for the selected Bot's generated-avatar editor. */
export interface BotAvatarEditorProps {
  /** Selected Bot row whose avatar is being edited. */
  readonly bot: BotSummary
  /** Host-backed generation and Bot avatar persistence actions. */
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

/** Render generation status, prompt, preview, and commit controls for one Bot. */
export function BotAvatarEditor({ bot, actions, loadAvatar, open, onClose, onOpenSettings, t }: BotAvatarEditorProps) {
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<AvatarGenerationStatus | null>(null)
  const [statusError, setStatusError] = useState(false)
  const [statusAttempt, setStatusAttempt] = useState(0)
  const [generated, setGenerated] = useState<AvatarGenerationValue | null>(null)
  const [committed, setCommitted] = useState<SharedBotAvatar | null>(null)
  const [working, setWorking] = useState<'status' | 'generate' | 'update' | null>(null)
  const [error, setError] = useState<'generate' | 'update' | null>(null)
  const request = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open) return
    let live = true
    setDescription('')
    setStatus(null)
    setStatusError(false)
    setGenerated(null)
    setCommitted(null)
    setError(null)
    setWorking('status')
    void actions.status().then((value) => {
      if (!live) return
      setStatus(value)
      setWorking(null)
    }).catch(() => {
      if (!live) return
      setStatusError(true)
      setWorking(null)
    })
    return () => {
      live = false
      request.current?.abort()
      request.current = null
    }
  }, [actions, open, statusAttempt])

  const close = () => {
    request.current?.abort()
    request.current = null
    onClose()
  }

  const generate = async () => {
    const prompt = description.trim()
    if (prompt === '' || working !== null || status?.available !== true) return
    const controller = new AbortController()
    request.current = controller
    setWorking('generate')
    setError(null)
    try {
      const value = await actions.generate({ description: prompt }, controller.signal)
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
    if (working !== null) return
    setWorking('update')
    setError(null)
    try {
      await actions.update(bot.id, avatar)
      onClose()
    } catch {
      setError('update')
    } finally {
      setWorking(null)
    }
  }

  const commitGenerated = async () => {
    if (generated === null || working !== null) return
    setWorking('update')
    setError(null)
    try {
      const avatar = committed ?? (await actions.commit(generated)).attachment
      setCommitted(avatar)
      await actions.update(bot.id, avatar)
      onClose()
    } catch {
      setError('update')
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
  const canGenerate = status?.available === true && description.trim() !== '' && working === null

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
          <Button variant="ghost" onClick={close} disabled={working === 'update'}>{t('cancel')}</Button>
          {bot.avatar !== undefined && generated === null && (
            <Button
              variant="outline"
              onClick={() => { void update(null) }}
              disabled={working !== null}
              icon={<IconTrashOutlineRegular size={14} />}
            >
              {t('avatarUseCharacter')}
            </Button>
          )}
          {generated !== null && (
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
            data-modal-autofocus
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
          {error !== null && <div className={css.avatarNotice} role="alert">{error === 'generate' ? t('avatarGenerateFailed') : t('avatarSaveFailed')}</div>}
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
    </Modal>
  )
}
