/** `reference` namespace dictionaries for the unified `@` source. */

import type {} from '@yharness/client-ui-slots'

/** Dictionary namespace owned by this plugin. */
export const NS = 'reference'

/**
 * English dictionary for this namespace.
 *
 * The `time.*` bucket words are this namespace's own copy of the session-row
 * vocabulary: locale-owned copy keeps the words per plugin, while the
 * bucketing they name is the one shared {@link relativeTime} in ui-primitives.
 */

/** The reference namespace key union. */
export type ReferenceKey = keyof typeof en

declare module '@yharness/client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The unified `@` reference menu's copy. */
    reference: ReferenceKey
  }
}

/** English dictionary for this namespace. */
export const en = {
  'section.files': 'Files & folders',
  'section.bots': 'Bots',
  'section.subagents': 'Subagents',
  'section.sessions': 'Sessions',
  'bot.status.running': 'working',
  'bot.status.idle': 'idle',
  'bot.status.offline': 'offline',
  'candidate.noCwd': '(no cwd)',
  'crumb.root': 'Workspace',
  'time.now': 'now',
  'time.minutes': '{n}min',
  'time.hours': '{n}h',
  'time.days': '{n}d',
  'time.months': '{n}mo',
  'time.years': '{n}y',
} satisfies Record<string, string>

/** Compatibility export for the retired locale name. */
export const zh = en
