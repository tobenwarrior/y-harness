/** Locale bundles for the agent loop's settings page. */

import type { SettingsFormLabels } from '@yharness/client-ui-primitives'

/** Locale keys the page renders. */
export type AgentLoopSettingsLocaleKey =
  | 'title' | 'description' | 'maxParallel' | 'maxParallelHint'
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed' | 'invalidNumber'

/** English copy. */
export const en= {
  title: 'Agent loop',
  description: 'Control how the Agent dispatches tool calls.',
  maxParallel: 'Parallel tool calls',
  maxParallelHint: 'Upper bound on parallel-safe calls running at once within one step.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
}

/** Compatibility export for the retired locale name. */
export const zh = en

/**
 * The form frame's copy, read from this page's dictionary.
 * @param t - the page's locale reader.
 * @returns the labels the shared settings form renders.
 */
export function formLabels(t: (key: AgentLoopSettingsLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}
