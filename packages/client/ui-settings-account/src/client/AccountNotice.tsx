/**
 * Provider bonus notice, with a legacy sidebar mode. The card reports display
 * once it is fully visible within Models or has a legacy anchor position, the
 * document is visible, and it has painted one frame. Closing counts as a display too,
 * because the user acted on it. An award that expired before a render is not
 * drawn at all.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BonusNotice } from './bonus-notices.ts'
import css from './AccountNotice.module.css'

/** @param expiresAt - server expiration timestamp. @returns whether the award can still be spent. */
function live(expiresAt: string): boolean {
  const expires = Date.parse(expiresAt)
  // An unparsable timestamp is not evidence of expiry, so the notice still shows.
  return Number.isNaN(expires) || expires > Date.now()
}

/**
 * @param run - callback to invoke once one presented frame has passed.
 * @returns a canceller for a card that unmounts or hides first.
 */
function afterPaint(run: () => void): () => void {
  if (typeof requestAnimationFrame !== 'function') {
    // Without a frame clock, the following task is the best available paint boundary.
    const timer = setTimeout(run, 0)
    return () => { clearTimeout(timer) }
  }
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const frame = requestAnimationFrame(() => {
    // The frame callback runs before its paint; the following task runs after it.
    timer = setTimeout(() => {
      if (!cancelled) run()
    }, 0)
  })
  return () => {
    cancelled = true
    cancelAnimationFrame(frame)
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** @param props - notice copy, inline presentation or legacy sidebar anchor, and display callbacks.
 * @returns a non-modal notice within its provider card or above its legacy anchor.
 */
export function AccountNoticeCard({ notice, anchor, inline = false, title, closeLabel, onShown, onDismiss }: {
  notice: BonusNotice
  title: string
  closeLabel: string
  /** Called once, after the visible card has passed a presented frame. */
  onShown: (orderId: BonusNotice['orderId']) => void
  /** Called when the user closes the card, which counts as having seen it. */
  onDismiss: (orderId: BonusNotice['orderId']) => void
} & ({ inline: true; anchor?: never } | { inline?: false; anchor: RefObject<HTMLElement> })) {
  const [position, setPosition] = useState<{ left: number; bottom: number }>()
  const cardElement = useRef<HTMLElement>(null)
  const reported = useRef(false)
  useLayoutEffect(() => {
    if (inline || !anchor?.current || !live(notice.expiresAt)) return
    const element = anchor.current
    const update = () => {
      const rect = element.getBoundingClientRect()
      // The launcher row starts one 10px inset inside the sidebar, which is the
      // card's fixed left inset; the width itself does not follow the sidebar.
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 268)),
        bottom: Math.max(8, window.innerHeight - rect.top + 4) })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchor, inline, notice.orderId, notice.expiresAt])
  useEffect(() => {
    if ((!inline && position === undefined) || reported.current || !live(notice.expiresAt)) return
    let cancel: (() => void) | undefined
    // Inline notices may be mounted below the Models scroll viewport, or under
    // a native Platform page. Mounting alone is not a display acknowledgment.
    let intersects = false
    const visible = () => {
      if (document.visibilityState === 'hidden') return false
      if (!inline) return true
      const element = cardElement.current
      if (!element || !intersects || element.closest('[inert], [hidden], [aria-hidden="true"]')) return false
      for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor)
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false
      }
      for (const dialog of document.querySelectorAll('[aria-modal="true"]')) {
        if (!dialog.contains(element)) return false
      }
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return hit !== null && element.contains(hit)
    }
    const attempt = () => {
      if (reported.current || cancel !== undefined || !live(notice.expiresAt)) return
      if (!visible()) return
      cancel = afterPaint(() => {
        cancel = undefined
        if (reported.current || !visible() || !live(notice.expiresAt)) return
        reported.current = true
        onShown(notice.orderId)
      })
    }
    const intersection = inline && typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
        for (const entry of entries) if (entry.target === cardElement.current) {
          intersects = entry.isIntersecting && entry.intersectionRatio >= 1
        }
        attempt()
      }, { threshold: 1 }) : undefined
    if (cardElement.current) intersection?.observe(cardElement.current)
    const changes = inline ? new MutationObserver(attempt) : undefined
    changes?.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['inert', 'hidden', 'aria-hidden', 'aria-modal', 'style', 'class'] })
    attempt()
    document.addEventListener('visibilitychange', attempt)
    if (inline) {
      window.addEventListener('scroll', attempt, true)
      window.addEventListener('resize', attempt)
    }
    return () => {
      document.removeEventListener('visibilitychange', attempt)
      window.removeEventListener('scroll', attempt, true)
      window.removeEventListener('resize', attempt)
      intersection?.disconnect()
      changes?.disconnect()
      cancel?.()
    }
  }, [position, inline, notice.orderId, notice.expiresAt, onShown])
  // Rendering nothing keeps an expired notice off screen without disturbing the
  // hook order above.
  if (!live(notice.expiresAt)) return null
  const card = <aside ref={cardElement} className={inline ? `${css.card} ${css.inline}` : css.card} style={inline ? undefined : position ?? { visibility: 'hidden' }}>
    <div role="status" className={css.copy}>
      <div className={css.title}><span className={css.icon} aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M3.6355 6.93969C3.6355 4.8398 5.33779 3.1375 7.43768 3.1375C9.53757 3.1375 11.23987 4.8398 11.23987 6.93968V11.363H3.6355V6.93969Z" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="0.875" />
          <path d="M1.641 11.3645H12.36M5.053 13.3095H8.9479M7.4375 4.27422V2.70137912" stroke="currentColor" strokeWidth="0.875" />
        </svg>
      </span><span>{title}</span></div>
      <p>{notice.message}</p>
    </div>
    <button type="button" className={css.close} aria-label={closeLabel} onClick={() => { onDismiss(notice.orderId) }}><IconCloseOutlineRegular size={10} /></button>
  </aside>
  return inline ? card : createPortal(card, document.body)
}
