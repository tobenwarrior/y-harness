/** Locale bundles for the web-search provider's settings page. */

import type { SettingsFormLabels } from '@yharness/client-ui-primitives'

/** Locale keys the page renders. */
export type WebSearchSettingsLocaleKey =
  | 'title' | 'description' | 'useSearchApi' | 'useSearchApiHint' | 'searchGuide' | 'searchGuideUrl'
  | 'apiKey' | 'apiKeyHint' | 'apiKeySet' | 'apiKeyUnset'
  | 'baseUrl' | 'baseUrlHint' | 'searchApiBaseUrl' | 'searchApiBaseUrlHint' | 'maxUses' | 'maxUsesHint' | 'count' | 'countHint'
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed' | 'invalidNumber' | 'invalidCount'

/** English copy. */
export const en= {
  title: 'Web search',
  description: 'Set up the DeepSeek search provider.',
  useSearchApi: 'Use the new Web Search API',
  useSearchApiHint: 'Off by default: search runs through DeepSeek Messages. For the new Web Search API\'s features and pricing, see the ',
  searchGuide: 'Search & Fetch guide',
  searchGuideUrl: 'https://api-docs.deepseek.com/guides/search',
  apiKey: 'API key',
  apiKeyHint: 'Stored outside the settings file. Leave blank to keep the current key.',
  apiKeySet: 'A key is configured.',
  apiKeyUnset: 'No key is configured; only conversations using a DeepSeek Account model can search, through the default endpoint.',
  baseUrl: 'Messages API base URL',
  baseUrlHint: 'Include the API prefix, such as https://api.deepseek.com/anthropic/v1. The provider appends /messages. Leave blank to restore the default.',
  searchApiBaseUrl: 'Search / Fetch API base URL',
  searchApiBaseUrlHint: 'Include the API prefix, such as https://api.deepseek.com/v1/tools. The provider appends /search or /fetch. Leave blank to restore the default.',
  maxUses: 'Max searches per request',
  maxUsesHint: 'How many searches the auxiliary model may run within one Messages request. Applies only to the Messages API.',
  count: 'Results per search',
  countHint: 'Results returned per query: an integer from 1 to 50, default 10. This controls result count, not search calls. web_search keeps no more sources than its own result limit.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
  invalidCount: 'Enter an integer from 1 to 50, or leave blank to use the default.',
}

/** Compatibility export for the retired locale name. */
export const zh = en

/**
 * The form frame's copy, read from this page's dictionary.
 * @param t - the page's locale reader.
 * @returns the labels the shared settings form renders.
 */
export function formLabels(t: (key: WebSearchSettingsLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}
