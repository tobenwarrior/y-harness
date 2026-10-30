/** Compound code map: the vendored graph viewer, served by this Y Harness build. */
import { useState, type ReactNode, useEffect, useRef } from 'react'
import { Button } from '@yharness/client-ui-primitives'
import type { PropsLocale } from '@yharness/client-ui-slots'
import css from './MapPanel.module.css'

/** Browser-relative route `dsh-skill-compound` serves the viewer under. */
export const VIEWER_ROUTE = 'api/skill-compound.map/viewer'

/**
 * Render the code map the Host serves.
 *
 * The viewer is framed rather than reimplemented: it stays the vendored
 * application, while the Host serves it from this origin (the vendored service
 * itself refuses framing and foreign origins). Guarantees live in the served
 * copy; the frame needs the same origin for its own `connect-src 'self'` calls.
 * @param props - locale copy for the panel chrome.
 * @returns the toolbar, the viewer frame, and the local-processing note.
 */
export function MapPanel({ t }: PropsLocale<'compoundMap'>): ReactNode {
  const [generation, setGeneration] = useState(0)
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    const update = () => { syncMapTheme(frame.current) }
    const observer = new MutationObserver(update)
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'data-yh-style', 'style'] })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    update()
    return () => { observer.disconnect() }
  }, [generation])
  return <section className={css.root} aria-label={t('title')}>
    <header className={css.toolbar}>
      <span className={css.title}>{t('title')}</span>
      <Button variant="outline" size="sm" onClick={() => { setGeneration(value => value + 1) }}>{t('reload')}</Button>
    </header>
    <iframe
      key={generation}
      ref={frame}
      onLoad={() => { syncMapTheme(frame.current) }}
      className={css.frame}
      title={t('frameTitle')}
      src={VIEWER_ROUTE}
    />
    <p className={css.hint}>{t('hint')}</p>
  </section>
}
/** Mirror the resolved host palette into the same-origin viewer. */
function syncMapTheme(frame: HTMLIFrameElement | null): void {
  try {
    const root = frame?.contentDocument?.documentElement
    if (!root) return
    root.toggleAttribute('data-ds-dark-theme', document.body.hasAttribute('data-ds-dark-theme'))
    root.setAttribute('data-yh-style', document.body.getAttribute('data-yh-style') ?? 'default')
    for (const name of Array.from(root.style)) {
      if (name.startsWith('--yh-')) root.style.removeProperty(name)
    }
    const styles = getComputedStyle(document.body)
    for (const name of Array.from(styles)) {
      if (name.startsWith('--yh-')) root.style.setProperty(name, styles.getPropertyValue(name))
    }
  } catch {
    // The viewer may have navigated away from this origin.
  }
}
