/** Optional Electron status presentation; the native shell owns actions and Web owns visible copy. */
import { IconDownloadOutlineRegular, IconLoadingOutlineRegular, IconWarningTriangleOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './DesktopUpdateIndicator.module.css'
import type { DesktopUpdateFailureKind, DesktopUpdatePresentation, DesktopUpdateView } from '../types.ts'
import type { SettingsRootInjected } from './shell-contract.ts'

export type SettingsTranslate = PropsLocale<'settings'>['t']

export const BUSY_PHASES: ReadonlySet<DesktopUpdatePresentation['phase']> = new Set([
  'checking', 'downloading', 'verifying', 'installing',
])

export function updateCopy(state: DesktopUpdatePresentation, t: SettingsTranslate): { label: string; detail: string } {
  const labels: Readonly<Record<DesktopUpdatePresentation['phase'], string>> = {
    idle: '',
    checking: t('desktop.update.checking'),
    available: t('desktop.update.available'),
    downloading: t('desktop.update.progress', { percent: state.percent ?? 0 }),
    verifying: t('desktop.update.verifying'),
    installing: t('desktop.update.installing'),
    ready: t('desktop.update.ready'),
    unavailable: t('desktop.update.unavailable'),
    error: t('desktop.update.retry'),
  }
  const label = labels[state.phase]
  if (state.phase === 'unavailable') return { label, detail: label }
  if (state.phase === 'checking' || state.phase === 'verifying' || state.phase === 'installing') {
    return { label, detail: state.version ?? label }
  }
  if (state.phase === 'error') {
    const failures: Readonly<Record<DesktopUpdateFailureKind, string>> = {
      check: t('desktop.update.checkFailed'),
      'check-network': t('desktop.update.checkNetworkFailed'),
      download: t('desktop.update.downloadFailed'),
      'download-network': t('desktop.update.downloadNetworkFailed'),
      install: t('desktop.update.installFailed'),
      'install-network': t('desktop.update.installNetworkFailed'),
      'stop-failed': t('desktop.update.stopFailed'),
      'tasks-changed': t('desktop.update.tasksChanged'),
      'tasks-unavailable': t('desktop.update.tasksUnavailable'),
    }
    return { label, detail: failures[state.failure ?? 'install'] }
  }
  if (state.phase === 'downloading' && state.version !== undefined) {
    return { label, detail: t('desktop.update.downloadDetail', { percent: state.percent ?? 0, version: state.version }) }
  }
  return { label, detail: state.version === undefined
    ? label
    : t('desktop.update.versionDetail', { label, version: state.version }) }
}

/**
 * Render update status as a compact circular icon with brand-blue ink, including retries.
 * State labels and detail live in the tooltip and accessible name in every phase.
 * @param props - Connection priority, sidebar width, and localized bridge-failure copy.
 * @returns Desktop-only status beside the account button, or nothing in browsers.
 */
export function DesktopUpdateIndicator({ wide, hidden, t, view, onOpen }: {
  wide: boolean
  hidden: boolean
  t: SettingsTranslate
  view: DesktopUpdateView
  onOpen: () => void
}) {
  const { presentation: state, failed } = view
  if (!wide || hidden || (!failed && (state === undefined || state.phase === 'idle' || state.phase === 'unavailable'))) return null
  return <DesktopUpdateControl t={t} view={view} onOpen={onOpen} side="top" />
}

type DesktopUpdateControlProps = {
  t: SettingsTranslate
  view: DesktopUpdateView
  onOpen: () => void
  side: 'right' | 'top'
}

/** Render one updater control after its owner has decided that it belongs in the chrome. */
function DesktopUpdateControl({ t, view, onOpen, side }: DesktopUpdateControlProps) {
  const { presentation: state, failed, opening } = view
  const retryLabel = t('desktop.update.retry')
  const copy = state === undefined ? { label: retryLabel, detail: retryLabel } : updateCopy(state, t)
  const label = failed ? retryLabel : copy.label
  const error = failed || state?.phase === 'error'
  const busy = opening || (state !== undefined && BUSY_PHASES.has(state.phase))
  const updateAvailable = state?.phase === 'available' || state?.phase === 'ready'
  const tooltip = updateAvailable ? t('desktop.update.availableTooltip') : failed ? retryLabel : copy.detail
  return <Tooltip label={tooltip} side={side}>
    <button type="button" className={css.indicator}
      aria-label={label} aria-disabled={busy} onClick={() => { if (!busy) onOpen() }}>
      <span className={css.icon} aria-hidden="true">
        {error ? <IconWarningTriangleOutlineRegular size={14} />
          : busy ? <IconLoadingOutlineRegular className={css.spinner} size={14} /> : <IconDownloadOutlineRegular size={14} />}
      </span>
    </button>
  </Tooltip>
}

type FooterActionProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'settings'>
  & Pick<InjectFace<SettingsRootInjected>, 'useDesktopUpdate' | 'openDesktopUpdate'>

/**
 * Render the collapsed-rail update action in the footer, outside the sidebar toggle button.
 * @param props - Framework-bound carrier, column geometry, and shell action.
 * @returns A proper update button when an app update is available, or nothing otherwise.
 */
export function DesktopUpdateFooterAction({ wide, useDesktopUpdate, openDesktopUpdate, t }: FooterActionProps) {
  const view = useDesktopUpdate(value => value)
  const phase = view.presentation?.phase
  const visible = view.failed || (phase !== undefined && phase !== 'idle' && phase !== 'unavailable')
  if (wide || !visible) return null
  return <DesktopUpdateControl t={t} view={view} onOpen={openDesktopUpdate} side="right" />
}

type WindowsBadgeProps = PropsRuntime<'sidebar.toggle.badge'> & PropsLocale<'settings'>
  & Pick<InjectFace<SettingsRootInjected>, 'useDesktopUpdate' | 'useConnectionState'>

/**
 * Keep the legacy Windows caption marker in the zero-width collapse.
 * The Windows sidebar has no rail footer track; the marker remains inside the
 * fixed caption toggle until a dedicated caption action seat exists.
 * @param props - Framework-bound carrier and connection state.
 * @returns A non-interactive notification marker on Windows, or nothing elsewhere.
 */
export function DesktopUpdateBadge({ useDesktopUpdate, useConnectionState, t }: WindowsBadgeProps) {
  const { presentation: state, failed } = useDesktopUpdate(value => value)
  const connection = useConnectionState(value => value)
  if (!document.documentElement.hasAttribute('data-windows-titlebar')) return null
  if (((connection === 'disconnected' || connection === 'connecting') && state?.phase !== 'installing')
    || (!failed && (state === undefined || state.phase === 'idle' || state.phase === 'unavailable'))) return null
  const retryLabel = t('desktop.update.retry')
  const copy = state === undefined ? { label: retryLabel, detail: retryLabel } : updateCopy(state, t)
  const label = failed ? retryLabel : copy.label
  return <Tooltip label={failed ? label : copy.detail} side="right">
    <span role="img" aria-label={label} className={css.badge} />
  </Tooltip>
}
