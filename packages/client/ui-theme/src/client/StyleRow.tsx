/** Persisted app-style choices with equivalent decorative application previews. */
import clsx from 'clsx'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeStyle } from '../theme-settings.ts'
import type { ThemeKey } from './locales.ts'
import type { createStyleRowStore } from './settings-store.ts'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import css from './StyleRow.module.css'

/** Writes app style through the theme service. */
export interface StyleRowInjected {
  /** Change the persisted app style. */
  setStyle: (style: ThemeStyle) => void
}

/** Runtime, store, locale, and injected values supplied by the row registration. */
export type StyleRowComponentProps =
  PropsRuntime<'settings.appearance.item'> & PropsStore<ReturnType<typeof createStyleRowStore>>
  & PropsLocale<'settings.theme'> & StyleRowInjected

const STYLES: readonly { id: ThemeStyle; labelKey: ThemeKey }[] = [
  { id: 'default', labelKey: 'style.default' },
  { id: 'terminal', labelKey: 'style.terminal' },
]

/**
 * Render the style choices; selection follows the theme service mirror.
 * @param props - Composed row props.
 * @returns Style choice buttons and their previews.
 */
export function StyleRow({ t, setStyle, useStore }: StyleRowComponentProps) {
  const style = useStore(s => s.style)
  return (
    <div className={css.group}>
      <div className={css.title}>{t('style.title')}</div>
      <div className={css.choices} role="group" aria-label={t('style.title')}>
        {STYLES.map(({ id, labelKey }) => (
          <button
            key={id}
            type="button"
            className={clsx(css.card, style === id && css.selected)}
            aria-pressed={style === id}
            onClick={() => { setStyle(id) }}
          >
            <span className={clsx(css.preview, id === 'terminal' && css.terminal)} data-yh-style-preview={id} aria-hidden="true">
              <span className={css.sidebar}>
                <span className={css.workspace}>{t('style.preview.workspace')}</span>
                <span className={css.navLine} />
                <span className={css.navLine} />
                <span className={css.navLine} />
              </span>
              <span className={css.content}>
                <span className={css.header}>{t('style.preview.conversation')}</span>
                <span className={css.transcript}>
                  <span className={css.textLine} />
                  <span className={css.textLine} />
                  <span className={css.tool}>{t('style.preview.ready')}</span>
                </span>
                <span className={css.composer}>
                  <span>{t('style.preview.composer')}</span>
                  <span className={css.send} />
                </span>
              </span>
            </span>
            <span className={css.label}>{t(labelKey)}</span>
          </button>
        ))}
      </div>
      <div className={css.description}>{t('style.description')}</div>
    </div>
  )
}
