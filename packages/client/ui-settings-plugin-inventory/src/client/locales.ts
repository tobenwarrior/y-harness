/** Copy dictionaries for the plugin inventory Settings section. */

/** English dictionary for this namespace. */

/** Plugin inventory locale key union. */
export type PluginInventoryLocaleKey = keyof typeof en

/** English dictionary for this namespace. */
export const en = {
  tab: 'Plugin list',
  loading: 'Reading plugins…',
  clientSyncing: 'Syncing plugins on this page…',
  clientSyncFailed: 'Some plugins could not sync on this page. Host enablement is unchanged.',
  clientSyncRetry: 'Retry this page',
  error: 'Plugins are temporarily unavailable.',
  metadataError: 'Package metadata error: {error}',
  retry: 'Retry',
  search: 'Search plugins',
  empty: 'No plugins are available.',
  emptySearch: 'No matching plugins.',
  presetTitle: 'Session plugins',
  presetSubtitle: 'Composed per session by agent presets',
  countUnit: 'plugins',
  switcherLabel: 'Choose the agent preset to inspect',
  presetOptionDefault: '{name} (default)',
  presetOptionBroken: '{name} (failed to load)',
  globalTitle: 'Global plugins',
  globalSubtitle: 'Shared by the system and every session',
  presetProvidedDetail: 'Disabled globally; agent presets provide it per session',
  enabledIn: 'Enabled in',
  viewInPreset: 'View in the preset group',
  matchesInOtherPresets: '{count} more matches in other presets: ',
  failedCountLabel: 'failed',
  enabledTag: 'Enabled',
  disabledTag: 'Disabled',
  conditionalTag: 'Conditional',
  presetEnabledTag: 'Via presets',
  failedTag: 'Failed',
  moduleLabel: 'Module',
  fromPreset: 'From',
  condition: 'Disabled when',
  configuration: 'Configuration',
  runtime: 'Status',
  unobserved: 'Not running',
  pending: 'Waiting for dependencies',
  loadingPhase: 'Loading',
  active: 'Running',
  failed: 'Failed to start',
  unloading: 'Unloading',
} satisfies Record<string, string>

/** Compatibility export for the retired locale name. */
export const zh = en
