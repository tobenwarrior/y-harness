/** Frame-wide Live Edit preview controls. */

import type { ReactNode } from 'react'
import {
  Button, IconCheckOutlineRegular, IconRefreshOutlineRegular, IconSparkleRegular, Tooltip,
} from '@yharness/client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@yharness/client-ui-slots'
import type { LiveEditAction } from '@yharness/api-remotes/client'
import type { LiveEditFace, LiveEditViewState } from './live-edit-controller.ts'
import css from './LiveEditOverlay.module.css'

/** Props for the frame-wide Keep/Undo overlay. */
export type LiveEditOverlayProps = PropsRuntime<'shell.overlay'>
  & PropsLocale<'cordis'>
  & InjectFace<LiveEditFace>

function actionLabel(action: LiveEditAction, t: LiveEditOverlayProps['t']): string {
  return action === 'keep' ? t('liveEdit.keep') : t('liveEdit.undo')
}

/**
 * Render the staged preview controls without remounting the active panel.
 *
 * The overlay is absent until the Host supplies a preview or an undoable kept
 * patch. It is a trusted product-owned surface, so only its two buttons can
 * call the revision-fenced Host action.
 *
 * @param props - state hook, localized copy, and the revision-fenced actions.
 * @returns the controls when a preview or undo is available.
 */
export function LiveEditOverlay({ useState, t, onAction }: LiveEditOverlayProps): ReactNode {
  const state = useState(snapshot => snapshot)
  const hasPreview = state.preview !== undefined
  const hasUndo = state.canUndo
  if (!hasPreview && !hasUndo) return null

  const title = state.preview?.title ?? state.kept?.title ?? t('liveEdit.title')
  const status = state.phase === 'applying'
    ? t('liveEdit.working')
    : hasPreview ? t('liveEdit.previewing') : t('liveEdit.kept')
  const keepLabel = actionLabel('keep', t)
  const undoLabel = actionLabel('undo', t)
  const busy = state.phase === 'applying'

  return (
    <section
      className={css.overlay}
      data-yh-live-edit-controls
      data-yh-live-edit-protected
      aria-label={t('liveEdit.title')}
      aria-live="polite"
    >
      <div className={css.card}>
        <div className={css.heading}>
          <span className={css.icon} aria-hidden="true"><IconSparkleRegular size={16} /></span>
          <div className={css.copy}>
            <strong className={css.title}>{title}</strong>
            <span className={css.status}>{status}</span>
          </div>
        </div>
        {state.error !== null && (
          <p className={css.error} role="alert">{t('liveEdit.failed', { message: state.error })}</p>
        )}
        <div className={css.actions}>
          {hasPreview && (
            <Tooltip label={keepLabel} delayMs={500}>
              <Button
                variant="primary"
                size="sm"
                icon={<IconCheckOutlineRegular size={14} />}
                disabled={busy}
                aria-label={keepLabel}
                aria-busy={busy}
                onClick={() => { void onAction('keep', state.revision) }}
              >
                {keepLabel}
              </Button>
            </Tooltip>
          )}
          {(hasPreview || hasUndo) && (
            <Tooltip label={undoLabel} delayMs={500}>
              <Button
                variant="outline"
                size="sm"
                icon={<IconRefreshOutlineRegular size={14} />}
                disabled={busy}
                aria-label={undoLabel}
                onClick={() => { void onAction('undo', state.revision) }}
              >
                {undoLabel}
              </Button>
            </Tooltip>
          )}
        </div>
      </div>
    </section>
  )
}

/** Props for the compact sidebar status control. */
export type LiveEditBadgeProps = PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<'cordis'>
  & InjectFace<LiveEditFace>

/**
 * Render the unobtrusive sidebar affordance while a patch is available.
 *
 * @param props - sidebar geometry, state hook, and focus action.
 * @returns an icon-only status button or nothing when no patch is active.
 */
export function LiveEditBadge({ wide, useState, t, focus }: LiveEditBadgeProps): ReactNode {
  const state: LiveEditViewState = useState(snapshot => snapshot)
  const available = state.preview !== undefined || state.canUndo
  if (!available) return null
  const label = state.preview !== undefined ? t('liveEdit.badge.preview') : t('liveEdit.badge.kept')
  return (
    <Tooltip label={label} side={wide ? 'top' : 'right'} delayMs={500}>
      <button type="button" className={css.badge} aria-label={label} onClick={focus}>
        <IconSparkleRegular size={14} />
      </button>
    </Tooltip>
  )
}
