/** Compound code map: the vendored graph viewer, served by this Y Harness build. */
import { useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
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
  return <section className={css.root} aria-label={t('title')}>
    <header className={css.toolbar}>
      <span className={css.title}>{t('title')}</span>
      <Button variant="outline" size="sm" onClick={() => { setGeneration(value => value + 1) }}>{t('reload')}</Button>
    </header>
    <iframe
      key={generation}
      className={css.frame}
      title={t('frameTitle')}
      src={VIEWER_ROUTE}
    />
    <p className={css.hint}>{t('hint')}</p>
  </section>
}
