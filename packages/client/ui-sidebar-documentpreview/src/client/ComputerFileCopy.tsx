/** Owner file copy and recipient selection for a private Computer preview. */

import { useEffect, useId, useRef, useState } from 'react'
import type { TranslateNS } from '@yharness/client-ui-slots'
import { Button, IconShareOutlineRegular, Modal, Tooltip } from '@yharness/client-ui-primitives'
import type {} from './locales.ts'
import css from './ComputerFileCopy.module.css'

interface Recipient {
  readonly id: string
  readonly name: string
}

const copyErrors = {
  'source-unavailable': 'copy.sourceUnavailable',
  'source-changed': 'copy.sourceChanged',
  'target-unavailable': 'copy.targetUnavailable',
  exists: 'copy.exists',
  'too-large': 'copy.tooLarge',
  'no-space': 'copy.noSpace',
} as const

type CopyError = typeof copyErrors[keyof typeof copyErrors] | 'copy.unavailable'

type Picker =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | {
    readonly kind: 'ready'
    readonly bots: readonly Recipient[]
    readonly selected: string
    readonly filter: string
    readonly copying: boolean
    readonly error?: CopyError
  }
  | { readonly kind: 'copied'; readonly name: string }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function recipient(value: unknown): value is Recipient {
  return record(value) && typeof value.id === 'string' && typeof value.name === 'string'
}

function copyError(value: unknown): CopyError {
  const status = record(value) ? value.status : undefined
  return typeof status === 'string' && Object.hasOwn(copyErrors, status)
    ? copyErrors[status as keyof typeof copyErrors] : 'copy.unavailable'
}

/** File and tab state authorizing one copy picker. */
export interface ComputerFileCopyProps {
  /** Source owner Bot Session. */
  readonly sessionId: string
  /** Computer file being previewed. */
  readonly path: string
  /** File version selected by the owner. */
  readonly version: string
  /** Preview record lifetime. */
  readonly lifetime: AbortSignal
  /** Localized picker controls. */
  readonly t: TranslateNS<'sidebarDocumentPreview'>
  /** Class shared by preview toolbar buttons. */
  readonly className?: string | undefined
}

/**
 * Render an owner file copy control and picker.
 * @param props - exact source and preview lifetime.
 * @returns the toolbar button and recipient dialog.
 */
export function ComputerFileCopy({ sessionId, path, version, lifetime, t, className }: ComputerFileCopyProps) {
  const [picker, setPicker] = useState<Picker>()
  const operation = useRef<{ readonly controller: AbortController; readonly version: string }>()
  const radioName = useId()
  const stop = (): void => {
    operation.current?.controller.abort()
    operation.current = undefined
  }
  useEffect(() => () => { operation.current?.controller.abort() }, [])
  const close = (): void => {
    stop()
    setPicker(undefined)
  }
  const open = async (): Promise<void> => {
    stop()
    const job = { controller: new AbortController(), version }
    operation.current = job
    const signal = AbortSignal.any([lifetime, job.controller.signal])
    setPicker({ kind: 'loading' })
    try {
      const response = await fetch('api/computer/files/recipients?' + new URLSearchParams({ sessionId }),
        { credentials: 'same-origin', signal })
      const value: unknown = await response.json()
      if (!response.ok || !record(value) || !Array.isArray(value.recipients) || !value.recipients.every(recipient)) {
        throw new Error('Recipients unavailable')
      }
      if (!signal.aborted) setPicker({ kind: 'ready', bots: value.recipients, selected: '', filter: '', copying: false })
    } catch (error) {
      void error
      if (!signal.aborted) setPicker({ kind: 'failed' })
    }
  }
  const copy = async (): Promise<void> => {
    const job = operation.current
    if (job === undefined || picker?.kind !== 'ready' || picker.copying) return
    const target = picker.bots.find(bot => bot.id === picker.selected)
    if (target === undefined) return
    setPicker({ kind: 'ready', bots: picker.bots, selected: target.id, filter: picker.filter, copying: true })
    const signal = AbortSignal.any([lifetime, job.controller.signal])
    try {
      const result = await fetch('api/computer/files/copy', {
        method: 'POST', credentials: 'same-origin', signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, path, version: job.version, targetBotId: target.id }),
      })
      if (signal.aborted) return
      if (result.status === 201) {
        setPicker({ kind: 'copied', name: target.name })
        return
      }
      const reason = copyError(await result.json())
      if (!signal.aborted) setPicker({ ...picker, copying: false, error: reason })
    } catch (error) {
      void error
      if (!signal.aborted) setPicker({ ...picker, copying: false, error: 'copy.unavailable' })
    }
  }
  const name = path.slice(path.lastIndexOf('/') + 1)
  const matches = picker?.kind === 'ready'
    ? picker.bots.filter(bot => bot.name.toLocaleLowerCase().includes(picker.filter.trim().toLocaleLowerCase()))
    : []
  return (
    <>
      <Tooltip label={t('copy.label')} side="bottom" delayMs={500}>
        <button type="button" className={className} aria-label={t('copy.label')} onClick={() => { void open() }}>
          <IconShareOutlineRegular />
        </button>
      </Tooltip>
      <Modal open={picker !== undefined} onClose={close} title={t('copy.label')} closeLabel={t('copy.close')}
        footer={picker?.kind === 'ready' ? (
          <>
            <Button variant="ghost" onClick={close}>{t('copy.cancel')}</Button>
            <Button variant="primary" disabled={picker.copying || picker.selected === ''} onClick={() => { void copy() }}>
              {t(picker.copying ? 'copy.copying' : 'copy.confirm')}
            </Button>
          </>
        ) : picker?.kind === 'copied' ? (
          <Button variant="primary" onClick={close}>{t('copy.done')}</Button>
        ) : undefined}>
        <p className={css.file}>{name}</p>
        {picker?.kind === 'ready' && picker.bots.length > 0 && (
          <>
            <input className={css.search} type="search" data-modal-autofocus aria-label={t('copy.search')}
              placeholder={t('copy.search')} value={picker.filter} disabled={picker.copying}
              onChange={(event) => { setPicker({ ...picker, selected: '', filter: event.currentTarget.value }) }} />
            <div className={css.recipients} role="group" aria-label={t('copy.recipient')}>
              {matches.map(bot => (
                <label key={bot.id} className={css.recipient}>
                  <input type="radio" name={radioName} checked={picker.selected === bot.id} disabled={picker.copying}
                    onChange={() => { setPicker({ kind: 'ready', bots: picker.bots, selected: bot.id, filter: picker.filter, copying: false }) }} />
                  <span>{bot.name}</span>
                </label>
              ))}
              {matches.length === 0 && <p className={css.notice}>{t('copy.noMatch')}</p>}
            </div>
          </>
        )}
        {picker?.kind === 'loading' && <p className={css.notice} role="status">{t('copy.loading')}</p>}
        {picker?.kind === 'failed' && (
          <>
            <p className={css.notice} role="alert">{t('copy.rosterUnavailable')}</p>
            <Button variant="ghost" onClick={() => { void open() }}>{t('retry')}</Button>
          </>
        )}
        {picker?.kind === 'ready' && picker.bots.length === 0 && <p className={css.notice}>{t('copy.noRecipients')}</p>}
        {picker?.kind === 'ready' && picker.error !== undefined && <p className={css.notice} role="alert">{t(picker.error)}</p>}
        {picker?.kind === 'copied' && <p className={css.notice} role="status">{t('copy.success', { name: picker.name })}</p>}
      </Modal>
    </>
  )
}
