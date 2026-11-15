/**
 * `sidebarDocumentPreview` namespace dictionaries.
 *
 * The failure lines are the point of this file: a preview that cannot show a
 * page has to say which of several different things went wrong, and each one
 * suggests a different next step for the reader.
 */

/** English dictionary for this namespace. */

/** Text-preview dictionary key union. */
export type SidebarDocumentPreviewKey = keyof typeof en

/** English dictionary for this namespace. */
export const en = {
  loading: 'Rendering document...',
  loadMore: 'Load more',
  changed: 'The file has changed, showing the previous content.',
  reloadNow: 'Reload',
  reload: 'Read the file again',
  download: 'Download file',
  'copy.label': 'Copy to bot',
  'copy.close': 'Close file copy',
  'copy.cancel': 'Cancel',
  'copy.confirm': 'Copy file',
  'copy.copying': 'Copying…',
  'copy.done': 'Done',
  'copy.search': 'Find a bot',
  'copy.recipient': 'Receiving bot',
  'copy.loading': 'Finding bots…',
  'copy.noMatch': 'No matching bots.',
  'copy.noRecipients': 'No other bots have a private VPS workspace.',
  'copy.rosterUnavailable': 'The bot list could not be loaded.',
  'copy.success': 'Copied to {name}’s VPS workspace.',
  'copy.sourceUnavailable': 'The source file is unavailable.',
  'copy.sourceChanged': 'The file changed. Reopen its preview to try again.',
  'copy.targetUnavailable': 'The selected bot’s workspace is unavailable.',
  'copy.exists': 'A file with this name already exists there.',
  'copy.tooLarge': 'This file exceeds the VPS transfer limit.',
  'copy.noSpace': 'The VPS does not have enough space for another copy.',
  'copy.unavailable': 'The file could not be copied. Try again.',
  autoRefresh: 'Auto refresh',
  'autoRefresh.enable': 'Enable auto refresh',
  'autoRefresh.disable': 'Disable auto refresh',
  'wrap.enable': 'Turn on line wrap',
  'wrap.disable': 'Turn off line wrap',
  'wrap.aria': 'Line wrap',
  openWith: 'Open with',
  'viewer.text': 'Plain text',
  resourceUnavailable: 'The file resource service is unavailable.',
  rendererUnavailable: 'The {name} preview is unavailable.',
  unsupportedFile: 'Preview is not available for this file type yet.',
  'error.notFound': 'File not found. It may have been moved or deleted.',
  'error.tooLarge': 'This page exceeds the {limit} limit and cannot be read.',
  'error.notText': 'Preview is not available for this file type yet.',
  'error.notRegularFile': 'Not a regular file, nothing to display.',
  'error.unavailable': 'Read failed: {message}',
  retry: 'Retry',
} satisfies Record<string, string>

/** Compatibility export for the retired locale name. */
export const zh = en
