import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconCheckOutlineRegular, IconCopyOutlineRegular, IconDownloadOutlineRegular, IconLinkOutlineRegular, IconShareOutlineRegular,
  IconTrashOutlineRegular, Input, Modal, Tag, writeClipboard,
} from '@yharness/client-ui-primitives'
import type { PropsLocale } from '@yharness/client-ui-slots'
import { BotAvatar } from './BotAvatar.tsx'
import css from './BotWorkspace.module.css'
import type { BotSummary, BotTemplateActions, BotTemplateState } from './types.ts'

type Translate = PropsLocale<'bots'>['t']

function templateAvatarURL(data: string, mediaType: string): string {
  const base64 = data.replaceAll('-', '+').replaceAll('_', '/')
  return `data:${mediaType};base64,${base64}${'='.repeat((4 - base64.length % 4) % 4)}`
}

/** Reusable Bot template catalog and share/import flow. */
export function BotTemplatesPanel({ bots, state, actions, t, open, onClose }: {
  /** Existing Bots whose safe configuration can be published. */
  readonly bots: readonly BotSummary[]
  /** Controller-owned catalog, preview, and error state. */
  readonly state: BotTemplateState
  /** Controller-owned template operations. */
  readonly actions: BotTemplateActions
  /** Locale-owned workspace translator. */
  readonly t: Translate
  /** Whether the modal is open. */
  readonly open: boolean
  /** Close the modal without changing durable template data. */
  readonly onClose: () => void
}): ReactNode {
  const [importName, setImportName] = useState('')
  const [copiedCode, setCopiedCode] = useState<string | null>(null)
  const [publishingBotId, setPublishingBotId] = useState<string | null>(null)

  useEffect(() => {
    if (open) return
    setImportName('')
    setCopiedCode(null)
    setPublishingBotId(null)
  }, [open])

  const copy = async (code: string): Promise<void> => {
    if (await writeClipboard(code)) setCopiedCode(code)
  }

  const publish = async (bot: BotSummary): Promise<void> => {
    if (publishingBotId !== null || state.busy) return
    setPublishingBotId(bot.id)
    try {
      await actions.publishTemplate({ botId: bot.id })
    } catch {
      // The controller retains the failure beside the form for a retry.
    } finally {
      setPublishingBotId(null)
    }
  }

  const preview = async (): Promise<void> => {
    try {
      await actions.previewTemplate()
    } catch {
      // The controller keeps the entered code and publishes the failure.
    }
  }

  const importBot = async (): Promise<void> => {
    try {
      await actions.importTemplate(importName)
      setImportName('')
    } catch {
      // Keep the code and preview visible so the user can retry safely.
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('templatesTitle')}
      description={t('templatesDescription')}
      closeLabel={t('cancel')}
      className={css.templatesModal as string}
      contentClassName={css.templatesModalContent as string}
      footer={<Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>}
    >
      {state.error !== null && <div className={css.dialogNotice} role="alert">{state.error}</div>}
      <section className={css.templateSection} aria-labelledby="yharness-bots-publish-title">
        <div className={css.templateSectionHeader}>
          <span className={css.templateSectionTitle} id="yharness-bots-publish-title">{t('templatesPublishTitle')}</span>
          <span className={css.templateSectionHint}>{t('templatesPublishDescription')}</span>
        </div>
        {bots.length === 0
          ? <div className={css.templateEmpty}>{t('templatesNoBots')}</div>
          : <div className={css.templateBotList}>
            {bots.map(bot => (
              <div className={css.templateBotRow} key={bot.id}>
                <BotAvatar name={bot.name} identity={bot.identity} accent={bot.accent} botId={bot.id} loadAvatar={undefined} />
                <span className={css.templateBotCopy}>
                  <span className={css.templateBotName}>{bot.name}</span>
                  {bot.description !== undefined && <span className={css.templateBotDescription}>{bot.description}</span>}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  icon={<IconShareOutlineRegular size={14} />}
                  disabled={state.busy || publishingBotId !== null}
                  onClick={() => { void publish(bot) }}
                >
                  {publishingBotId === bot.id ? t('templatesPublishing') : t('templatesPublish')}
                </Button>
              </div>
            ))}
          </div>}
      </section>

      <section className={css.templateSection} aria-labelledby="yharness-bots-import-title">
        <div className={css.templateSectionHeader}>
          <span className={css.templateSectionTitle} id="yharness-bots-import-title">{t('templatesImportTitle')}</span>
          <span className={css.templateSectionHint}>{t('templatesImportDescription')}</span>
        </div>
        <div className={css.templateCodeRow}>
          <Input
            value={state.code}
            placeholder={t('templatesCodePlaceholder')}
            aria-label={t('templatesCodeLabel')}
            onChange={(event) => { actions.setTemplateCode(event.currentTarget.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void preview()
              }
            }}
          />
          <Button variant="outline" icon={<IconLinkOutlineRegular size={14} />} disabled={state.busy || state.code.trim() === ''} onClick={() => { void preview() }}>
            {state.busy ? t('templatesWorking') : t('templatesPreview')}
          </Button>
        </div>
        {state.preview !== null && (
          <div className={css.templatePreview}>
            {state.preview.avatar === undefined
              ? <BotAvatar name={state.preview.name} identity={state.preview.identity} accent={state.preview.accent} botId={state.preview.id} loadAvatar={undefined} size="large" />
              : <img
                className={css.templatePreviewAvatar}
                src={templateAvatarURL(state.preview.avatar.data, state.preview.avatar.mediaType)}
                alt={t('templatesAvatarPreviewAlt')}
              />}
            <div className={css.templatePreviewCopy}>
              <strong>{state.preview.name}</strong>
              {state.preview.description !== undefined && <span>{state.preview.description}</span>}
              <span>{t('templatesPreviewSafe')}</span>
            </div>
            <dl className={css.templatePreviewDetails}>
              <dt>{t('templatesSignedIssuer')}</dt>
              <dd>{state.preview.issuerFingerprint ?? t('templatesNotIncluded')}</dd>
              <dt>{t('templatesSignedFingerprint')}</dt>
              <dd>{state.preview.fingerprint ?? t('templatesNotIncluded')}</dd>
              <dt>{t('templatesSignedPersona')}</dt>
              <dd>{state.preview.persona ?? t('templatesNotIncluded')}</dd>
              <dt>{t('templatesSignedCapabilities')}</dt>
              <dd>{state.preview.capabilities === undefined || state.preview.capabilities.length === 0
                ? t('templatesNotIncluded')
                : state.preview.capabilities.join(', ')}</dd>
              <dt>{t('templatesSignedPreset')}</dt>
              <dd>{state.preview.agentPreset ?? t('templatesNotIncluded')}</dd>
              <dt>{t('templatesLocalPreset')}</dt>
              <dd>{state.preview.localPermissions?.preset ?? t('templatesLocalToolsUnavailable')}</dd>
              <dt>{t('templatesLocalTools')}</dt>
              <dd>{state.preview.localPermissions?.status !== 'resolved'
                ? t('templatesLocalToolsUnavailable')
                : state.preview.localPermissions.tools.length === 0
                  ? t('templatesLocalToolsNone')
                  : state.preview.localPermissions.tools.join(', ')}</dd>
            </dl>
            <div className={css.templateImportControls}>
              <Input
                value={importName}
                placeholder={t('templatesImportNamePlaceholder')}
                aria-label={t('templatesImportNameLabel')}
                onChange={(event) => { setImportName(event.currentTarget.value) }}
              />
              <Button
                variant="primary"
                icon={<IconDownloadOutlineRegular size={14} />}
                disabled={state.busy || state.preview === null || state.preview.localPermissions?.status !== 'resolved'}
                onClick={() => { void importBot() }}
              >
                {state.busy ? t('templatesImporting') : t('templatesImport')}
              </Button>
            </div>
          </div>
        )}
      </section>

      <section className={css.templateSection} aria-labelledby="yharness-bots-shared-title">
        <div className={css.templateSectionHeader}>
          <span className={css.templateSectionTitle} id="yharness-bots-shared-title">{t('templatesPublishedTitle')}</span>
          <span className={css.templateSectionHint}>{t('templatesPublishedDescription')}</span>
        </div>
        {state.phase === 'loading' && <div className={css.templateEmpty}>{t('templatesLoading')}</div>}
        {state.phase !== 'loading' && state.templates.length === 0 && <div className={css.templateEmpty}>{t('templatesEmpty')}</div>}
        {state.templates.length > 0 && (
          <div className={css.templateCatalog}>
            {state.templates.map(template => (
              <div className={css.templateCatalogRow} key={template.id}>
                <BotAvatar
                  name={template.name} identity={template.identity} accent={template.accent}
                  botId={template.id} loadAvatar={undefined}
                />
                <span className={css.templateBotCopy}>
                  <span className={css.templateBotName}>{template.name}</span>
                  <span className={css.templateCode}>{template.shareCode}</span>
                </span>
                {template.revokedAt === undefined
                  ? <Tag tone="info">{t('templatesActive')}</Tag>
                  : <Tag tone="neutral">{t('templatesRevoked')}</Tag>}
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={copiedCode === template.shareCode ? t('templatesCopied') : t('templatesCopy')}
                  icon={copiedCode === template.shareCode ? <IconCheckOutlineRegular size={14} /> : <IconCopyOutlineRegular size={14} />}
                  onClick={() => { void copy(template.shareCode) }}
                />
                {template.revokedAt === undefined && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('templatesRevoke')}
                    icon={<IconTrashOutlineRegular size={14} />}
                    disabled={state.busy}
                    onClick={() => { void actions.revokeTemplate(template.id).catch(() => {}) }}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </Modal>
  )
}
