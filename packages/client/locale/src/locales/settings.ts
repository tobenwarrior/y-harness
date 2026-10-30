/** `settings.locale` namespace dictionaries (the Language row's copy). */

/** English dictionary for the locale settings row. */
export const en = {
  'language.title': 'Language',
} satisfies Record<string, string>

/** The settings.locale namespace key union. */
export type SettingsLocaleKey = keyof typeof en

/** Compatibility export for callers that still import the retired locale name. */
export const zh = en
