/** Locale dictionary for the Compound skills update indicator. */

export const en = {
  badge: 'Compound skills update available',
  badgeShort: 'Update available',
  badgeCurrent: 'Your Compound skills are up to date',
  badgeCurrentShort: 'Up to date',
  badgeError: 'Could not check for Compound skills updates',
  badgeErrorShort: 'Check failed',
  title: 'Compound skills update',
  checking: 'Checking for Compound skills updates…',
  available: 'Compound skills {upstream} are available; you have {vendored}.',
  current: 'Your Compound skills are up to date ({vendored}).',
  unavailable: 'Could not check for updates: {reason}',
  update: 'Update to {upstream}',
  updating: 'Updating…',
  updated: 'Updated — available on next load',
  updateFailed: 'The update did not apply: {reason}',
  restartHint: 'Updated skills are available on their next load; no restart is needed.',
  stepsTitle: 'To update',
  stepsBody: 'Y Harness verifies the update for you. The new skills are available the next time you load them; no restart is needed.',
  repository: 'Upstream repository',
  refresh: 'Check again',
  close: 'Close',
} as const

/** Compatibility export for the retired locale name. */
export const zh = en

/** Keys owned by the indicator's dictionary. */
export type CompoundUpdateKey = keyof typeof en

/** English dictionary for this namespace. */
