/** Shell chrome and General-nav dictionaries; feature rows own their copy. */

/** English dictionary for this namespace. */

/** The settings namespace key union. */
export type SettingsKey = keyof typeof en

/** English dictionary for this namespace. */
export const en = {
  'trigger': 'Settings',
  'shortcut.open': 'Open settings',
  'desktop.update.available': 'Update',
  'desktop.update.availableTooltip': 'Update available',
  'desktop.update.checking': 'Checking for updates…',
  'desktop.update.progress': '{percent}%',
  'desktop.update.verifying': 'Verifying update files…',
  'desktop.update.installing': 'Preparing to restart…',
  'desktop.update.ready': 'Install and Restart',
  'desktop.update.retry': 'Retry update',
  'desktop.update.title': 'Software Update',
  'desktop.update.check': 'Check for Updates',
  'desktop.update.current': 'You are up to date',
  'desktop.update.managed': 'Updates are managed automatically',
  'desktop.update.unavailable': 'Updates are not available in this build',
  'desktop.update.versionDetail': '{label}: {version}',
  'desktop.update.downloadDetail': 'Downloading update: {percent}%\nTarget version: {version}',
  'desktop.update.checkFailed': 'Could not check for updates. Please try again later.',
  'desktop.update.downloadFailed': 'Could not download the update. Please try again.',
  'desktop.update.installFailed': 'Could not install the update. Please try again later.',
  'desktop.update.checkNetworkFailed': 'Could not check for updates. Check your connection and try again.',
  'desktop.update.downloadNetworkFailed': 'Could not download the update. Check your connection and try again.',
  'desktop.update.installNetworkFailed': 'Could not install the update. Check your connection and try again.',
  'desktop.update.stopFailed': 'Could not safely stop the tasks. The update has not been installed. Please try again later.',
  'desktop.update.tasksChanged': 'New tasks have started. Confirm again to stop the tasks and update.',
  'desktop.update.tasksUnavailable': 'Task status is unavailable. Try updating again when the workspace is ready.',
  'title': 'Settings',
  'close': 'Close',
  'openDocument': 'Open configuration file',
  'openDocument.error': 'Could not open configuration file',
  'general.nav': 'General',
  'general.currentVersion': 'Current version: {version}',
  'developerTools.title': 'Show coding view',
  'developerTools.error': 'Could not save. Please try again.',
  'developerTools.description': 'Shows trajectory, code diffs, and all Agent presets',
  'connection.error': 'Disconnected',
  'connection.connecting': 'Reconnecting',
  'connection.connected': 'Connected',
  'connection.reconnect': 'Disconnected, reconnect now',
  'connection.restart': 'Reconnecting, reconnect now',
} satisfies Record<string, string>

/** Compatibility export for the retired locale name. */
export const zh = en
