import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, ReactNode } from 'react'
import {
  Button,
  fileSizeText,
  FileTypeIcon,
  IconCloseFillRegular,
  IconPaperclipOutlineRegular,
  IconRefreshOutlineRegular,
  ImageLightbox,
} from '@yharness/client-ui-primitives'
import { randomUUID } from '@yharness/util-crypto'
import type { BotGroupAttachmentDraft } from './types.ts'
import css from './BotWorkspace.module.css'

/**
 * Display saved attachment metadata in a group transcript.
 * @param props - Saved attachments and the localized fallback name.
 * @returns Attachment cards, or null when the message has none.
 */
export function BotGroupSentAttachments({ attachments, fallbackName }: {
  readonly attachments: readonly { readonly name?: string; readonly bytes: number }[] | undefined
  readonly fallbackName: string
}): ReactNode {
  if (attachments === undefined || attachments.length === 0) return null
  return <span className={css.groupSentAttachments}>{attachments.map((attachment, index) => {
    const name = attachment.name ?? fallbackName
    return <span className={css.groupAttachmentCard} key={`${name}-${index}`}>
      <span className={css.groupAttachmentIcon} aria-hidden="true"><FileTypeIcon path={name} /></span>
      <span className={css.groupAttachmentCopy}>
        <span className={css.groupAttachmentName}>{name}</span>
        <span className={css.groupAttachmentMeta}>{fileSizeText(attachment.bytes)}</span>
      </span>
    </span>
  })}</span>
}

/** Localized labels for the Bot-group attachment picker and draft rail. */
export interface BotGroupAttachmentLabels {
  /** Picker action label. */
  readonly picker: string
  /** Hidden file-input label. */
  readonly input: string
  /** Attachment rail group label. */
  readonly attachments: string
  /** Fallback name for an unnamed browser file. */
  readonly file: string
  /** Preview-button label for one image. */
  readonly preview: (name: string) => string
  /** Remove-button label for one draft. */
  readonly remove: (name: string) => string
  /** Retry-button label for one failed draft. */
  readonly retry: (name: string) => string
  /** Fallback status for an attachment that failed preparation. */
  readonly failed: string
  /** Status shown while a future preparation callback is working. */
  readonly uploading: string
  /** Image-lightbox labels. */
  readonly lightbox: { readonly dialog: string; readonly close: string }
}

/** Create one local draft without retaining a filesystem path. */
export function createBotGroupAttachmentDraft(file: File): BotGroupAttachmentDraft {
  const previewUrl = file.type.startsWith('image/') && typeof URL.createObjectURL === 'function'
    ? URL.createObjectURL(file)
    : undefined
  return {
    id: `bot-group-attachment-${randomUUID()}`,
    file,
    ...(previewUrl === undefined ? {} : { previewUrl }),
    state: 'ready',
  }
}

/** Release the object URL owned by one local image draft. */
export function releaseBotGroupAttachment(draft: BotGroupAttachmentDraft): void {
  if (draft.previewUrl !== undefined && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(draft.previewUrl)
}

/**
 * Render a browser-owned attachment picker and draft rail for one Bot group.
 * Files remain in memory and are never rendered as filesystem paths; an
 * attachment-aware owner decides how the drafts cross the Host boundary.
 *
 * @param props.attachments - ordered browser drafts retained by the composer.
 * @param props.disabled - whether picking and removal are temporarily blocked.
 * @param props.labels - locale-owned control and status copy.
 * @param props.onAddFiles - receives browser files in picker or drop order.
 * @param props.onRemove - removes one draft from the owner.
 * @param props.onRetry - retries one failed draft when preparation can resume.
 * @returns the picker and, when non-empty, its attachment rail.
 */
export function BotGroupAttachments({
  attachments, disabled, labels, onAddFiles, onRemove, onRetry,
}: {
  readonly attachments: readonly BotGroupAttachmentDraft[]
  readonly disabled: boolean
  readonly labels: BotGroupAttachmentLabels
  readonly onAddFiles: (files: readonly File[]) => void
  readonly onRemove: (id: string) => void
  readonly onRetry?: ((id: string) => void) | undefined
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [preview, setPreview] = useState<BotGroupAttachmentDraft | null>(null)

  useEffect(() => {
    if (preview !== null && !attachments.some(attachment => attachment.id === preview.id)) setPreview(null)
  }, [attachments, preview])

  const addFiles = (files: readonly File[]): void => {
    if (!disabled && files.length > 0) onAddFiles(files)
  }
  const onInputChange = (event: ChangeEvent<HTMLInputElement>): void => {
    addFiles(Array.from(event.currentTarget.files ?? []))
    event.currentTarget.value = ''
  }
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    addFiles(Array.from(event.dataTransfer.files))
  }
  const displayName = (attachment: BotGroupAttachmentDraft): string => attachment.file.name || labels.file

  return (
    <div className={css.groupAttachments} onDragOver={(event) => { event.preventDefault() }} onDrop={onDrop}>
      <input
        ref={inputRef}
        className={css.groupAttachmentInput}
        type="file"
        multiple
        aria-label={labels.input}
        disabled={disabled}
        onChange={onInputChange}
      />
      <Button
        variant="ghost"
        size="sm"
        icon={<IconPaperclipOutlineRegular size={15} />}
        aria-label={labels.picker}
        disabled={disabled}
        onClick={() => { inputRef.current?.click() }}
      >
        {labels.picker}
      </Button>
      {attachments.length > 0 && (
        <div className={css.groupAttachmentRail} role="group" aria-label={labels.attachments}>
          {attachments.map((attachment) => {
            const name = displayName(attachment)
            const failed = attachment.state === 'error'
            const image = attachment.previewUrl !== undefined && attachment.file.type.startsWith('image/')
            return (
              <div className={css.groupAttachmentCard} data-state={failed ? 'error' : 'ready'} key={attachment.id} title={name}>
                {image
                  ? (
                    <button
                      type="button"
                      className={css.groupAttachmentPreview}
                      aria-label={labels.preview(name)}
                      onClick={() => { setPreview(attachment) }}
                    >
                      <img src={attachment.previewUrl} alt={name} />
                    </button>
                  )
                  : <span className={css.groupAttachmentIcon} aria-hidden="true"><FileTypeIcon path={name} /></span>}
                <span className={css.groupAttachmentCopy}>
                  <span className={css.groupAttachmentName}>{name}</span>
                  <span className={css.groupAttachmentMeta}>
                    {failed ? attachment.error ?? labels.failed : fileSizeText(attachment.file.size) || labels.uploading}
                  </span>
                </span>
                {failed && onRetry !== undefined && (
                  <button
                    type="button"
                    className={css.groupAttachmentAction}
                    aria-label={labels.retry(name)}
                    disabled={disabled}
                    onClick={() => { onRetry(attachment.id) }}
                  >
                    <IconRefreshOutlineRegular size={14} />
                  </button>
                )}
                <button
                  type="button"
                  className={css.groupAttachmentAction}
                  aria-label={labels.remove(name)}
                  disabled={disabled}
                  onClick={() => { onRemove(attachment.id) }}
                >
                  <IconCloseFillRegular size={12} />
                </button>
              </div>
            )
          })}
        </div>
      )}
      {preview !== null && preview.previewUrl !== undefined && (
        <ImageLightbox
          src={preview.previewUrl}
          alt={displayName(preview)}
          labels={labels.lightbox}
          onClose={() => { setPreview(null) }}
        />
      )}
    </div>
  )
}
