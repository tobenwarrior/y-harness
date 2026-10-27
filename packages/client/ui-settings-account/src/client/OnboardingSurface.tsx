/** Body-portaled introduction with shared background interaction ownership. */
import { acquireOverlayInert } from './overlay-inert.ts'
import { useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import css from './OnboardingSurface.module.css'
import { useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Render a body-portaled onboarding stage and keep the application root inert
 * while mounted. A previously open Settings panel is hidden and retains its draft.
 * Native titlebar controls and dialogs opened by onboarding remain above the stage.
 * @param props.children - the step's page content, centered on the stage.
 * @param props.exiting - reveal the application while the owner retains the stage for its 180ms exit.
 * @param props.label - accessible name for a stage without a heading.
 * @param props.labelledBy - id of the current stage heading.
 * @returns the body-portaled overlay tree.
 */
export function OnboardingSurface({ children, exiting = false, label, labelledBy }: {
  children: ReactNode
  exiting?: boolean
  label?: string
  labelledBy?: string
}) {
  const rootState = useRef<{ element: HTMLElement; opacity: string } | null>(null)
  const overlay = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const appRoot = document.getElementById('root')
    if (appRoot === null) return
    const releaseInert = acquireOverlayInert(appRoot)
    const previousOpacity = appRoot.style.opacity
    rootState.current = { element: appRoot, opacity: previousOpacity }
    appRoot.style.opacity = '0'
    return () => {
      releaseInert()
      appRoot.style.opacity = previousOpacity
      rootState.current = null
    }
  }, [])
  useLayoutEffect(() => {
    const settings = document.querySelector<HTMLElement>('[role="dialog"][data-shortcut-modal="settings"]')
    if (settings === null) return
    const portal = settings.parentElement
    if (portal === null) return
    const release = acquireOverlayInert(settings)
    const visibility = portal.style.visibility
    portal.style.visibility = 'hidden'
    return () => {
      release()
      portal.style.visibility = visibility
    }
  }, [])
  useModalLayer(overlay, true, () => {})
  useLayoutEffect(() => {
    const root = rootState.current
    if (root !== null) root.element.style.opacity = exiting ? root.opacity : '0'
  }, [exiting])

  return createPortal((
    <div ref={overlay} tabIndex={-1} className={css.onboardingOverlay} data-exiting={exiting || undefined}
      role="dialog" aria-modal="true" aria-label={label} aria-labelledby={labelledBy}>
      <div className={css.dragBand} data-window-drag aria-hidden="true" />
      <div className={css.onboardingStage}>{children}</div>
    </div>
  ), document.body)
}
