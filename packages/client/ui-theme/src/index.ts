/** Host registration for the browser theme preference and pre-plugin palette. */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile } from '@deepseek-ai/cordis'
import type { ThemePreference, ThemeStyle } from './theme-settings.ts'
import z from '@deepseek-ai/schemastery'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { bootThemeInjections } from './boot-theme.ts'
import {
  DEFAULT_FONT_SIZE, DEFAULT_PREFERENCE, DEFAULT_STYLE, FONT_SIZE_MIN, FONT_SIZE_MAX, THEME_PREFERENCES, THEME_STYLES,
} from './theme-settings.ts'

export {
  DEFAULT_FONT_SIZE, DEFAULT_PREFERENCE, DEFAULT_STYLE, FONT_SIZE_FIELD, FONT_SIZE_MAX, FONT_SIZE_MIN,
  THEME_PREFERENCE_FIELD, THEME_PREFERENCES, THEME_SETTINGS_NAMESPACE, THEME_STYLE_FIELD, THEME_STYLES,
  type ThemePreference, type ThemeSettings, type ThemeStyle,
} from './theme-settings.ts'

/** Runtime preferences projected to the browser. */
export interface Config {
  /** Browser appearance style, independent of color mode. */
  style: Volatile<ThemeStyle>
  /** Browser palette preference. */
  preference: Volatile<ThemePreference>
  /** Browser font size in pixels. */
  fontSize: Volatile<number>
}

/** Live theme and typography preferences. */
export const Config = z.object({
  style: z.union([...THEME_STYLES]).default(DEFAULT_STYLE).volatile(),
  preference: z.union([...THEME_PREFERENCES]).default(DEFAULT_PREFERENCE).volatile(),
  fontSize: z.number().step(1).min(FONT_SIZE_MIN).max(FONT_SIZE_MAX).default(DEFAULT_FONT_SIZE).volatile(),
})

/** Supply the current palette before browser plugins start.
 * @param ctx Host plugin context.
 * @param config Validated live theme preferences.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  ctx.on('webserver/index-inject', (table) => {
    table.push(...bootThemeInjections(config.preference.get(), config.fontSize.get(), config.style.get()))
  }, { prepend: true })
}
