/** Appearance section containing feature-owned style, color mode, and font-size rows. */
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './AppearanceSection.module.css'

/** Section owner values and its declared item renderer. */
export type AppearanceSectionComponentProps =
  PropsRuntime<'settings.section'> & PropsRenderSlots<'settings.appearance.item'>

/**
 * Render the Appearance settings content column.
 * @param props - Composed section props.
 * @returns The Appearance item contributions.
 */
export function AppearanceSection({ renderSlot }: AppearanceSectionComponentProps) {
  return (
    <div className={css.section}>
      {renderSlot('settings.appearance.item', {})}
    </div>
  )
}
