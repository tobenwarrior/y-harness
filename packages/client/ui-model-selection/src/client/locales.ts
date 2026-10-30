/**
 * `model` namespace dictionaries.
 * Session-lock application names follow the configured public display name.
 *
 * `trigger.selectAria` intentionally matches `trigger.fallback` but remains a
 * separate key: the visible fallback label and the accessible name of
 * an unset trigger are free to diverge per locale, and folding it into
 * `trigger.aria` would announce the degenerate "Select model, current Select
 * model".
 */

import { withProductDisplayName } from '@yharness/client-ui-slots'

/** English dictionary for this namespace. */

/** The model namespace key union. */
export type ModelKey = keyof typeof en

/** English dictionary for this namespace. */
export const en = {
  'provider.account': 'DeepSeek Account',
  'provider.select': 'Select provider',
  'provider.route': '{name} ({id})',
  'model.route': '{name} ({id})',
  'command.label': 'Model',
  'command.description': 'Select the model for this conversation',
  'option.loadError': 'Catalog failed to load: {message}',
  'trigger.fallback': 'Select model',
  'trigger.loading': 'Loading models…',
  'trigger.selectAria': 'Select model',
  'trigger.aria': 'Select model, current {model}',
  'trigger.ariaEffort': 'Select model, current {model}, reasoning effort {effort}',
  'trigger.ariaSpeed': 'Select model, current {model}, speed {speed}',
  'trigger.ariaEffortSpeed': 'Select model, current {model}, reasoning effort {effort}, speed {speed}',
  'menu.aria': 'Provider, model, reasoning effort, and speed',
  'menu.model': 'Model',
  'menu.provider': 'Provider',
  'menu.effort': 'Effort',
  'menu.speed': 'Speed',
  'effort.providerDefault': 'Default',
  'status.loading': 'Refreshing model list…',
  'error.action': 'Model operation failed: {message}',
  'error.sessionInUse': withProductDisplayName('This session is already in use, possibly by another running Y Harness instance (such as yharness web or the desktop app). Quit other running Y Harness instances and try again.'),
  'action.reload': 'Reload',
  'warning.groupLoad': '{name} failed to load: {message}',
  'search.placeholder': 'Search models…',
  'search.clear': 'Clear search',
  'search.empty': 'No matching models.',
  'empty.models': 'No models available.',
  'empty.providers': 'No providers configured.',
  'empty.provider': 'This provider is not configured.',
  'empty.efforts': 'This model provides no reasoning effort levels.',
  'empty.tiers': 'This model provides no speed choices.',
} satisfies Record<string, string>

/** Compatibility export for the retired locale name. */
export const zh = en
