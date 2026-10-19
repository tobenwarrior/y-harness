/** Desktop-only update row for General Settings: status plus check and update actions. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { BUSY_PHASES, updateCopy } from './DesktopUpdateIndicator.tsx'
import type { DesktopUpdateView } from '../types.ts'
import css from './DesktopUpdateRow.module.css'

/** Update row bindings. */
export interface DesktopUpdateRowInjected {
  /** Update carrier status, bound as useDesktopUpdate. */
  readonly hooks: { readonly desktopUpdate: HostObservable<DesktopUpdateView> }
  /** Drive the shell-owned check, download, and install chain. */
  readonly openDesktopUpdate: () => void
  /** Whether the preload update bridge exists; false hides the row outside Desktop. */
  readonly hasUpdateBridge: boolean
}

/** Props of the Desktop update settings row. */
export type DesktopUpdateRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings'>
  & InjectFace<DesktopUpdateRowInjected>

/**
 * Render the Desktop update status with a check action beside the current release version.
 * The button drives the same shell-owned chain as the account-row control: checking
 * from idle, downloading an available update, and installing a ready one before restart.
 * @param props - bridge presence, carrier status, the shell action, and localized copy.
 * @returns the update row, or nothing outside Desktop.
 */
export function DesktopUpdateRow({ hasUpdateBridge, useDesktopUpdate, openDesktopUpdate, t }: DesktopUpdateRowProps) {
  if (!hasUpdateBridge) return null
  const view = useDesktopUpdate(value => value)
  const presentation = view.presentation
  const failed = view.failed || presentation?.phase === 'error'
  const busy = view.opening || (presentation !== undefined && BUSY_PHASES.has(presentation.phase))
  const copy = presentation === undefined || (!failed && presentation.phase === 'idle')
    ? { label: t('desktop.update.check'), detail: failed ? t('desktop.update.retry') : t('desktop.update.current') }
    : updateCopy(presentation, t)
  const advance = !failed && presentation !== undefined
    && (presentation.phase === 'available' || presentation.phase === 'ready')
  return (
    <div className={css.row}>
      <div className={css.text}>
        <div className={css.title}>{t('desktop.update.title')}</div>
        <div className={css.status}>{copy.detail}</div>
      </div>
      <Button variant={advance ? 'primary' : 'ghost'} disabled={busy} onClick={() => { openDesktopUpdate() }}>
        {copy.label}
      </Button>
    </div>
  )
}
