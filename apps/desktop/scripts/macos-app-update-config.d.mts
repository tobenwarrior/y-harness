/** Resolved fields required to embed a macOS updater feed. */
export interface MacOSAppUpdateFeed {
  readonly provider?: 'generic'
  readonly publicUrl: string
  readonly channel?: 'nightly'
}

/** GitHub Releases provider fields embedded in a production macOS application. */
export interface MacOSGitHubAppUpdateFeed {
  readonly provider: 'github'
  readonly owner: string
  readonly repo: string
  readonly channel: 'latest'
  readonly releaseType: 'release'
}

/** Packaged electron-updater configuration for macOS. */
export interface MacOSAppUpdateConfig {
  readonly provider: 'generic' | 'github'
  readonly url?: string
  readonly owner?: string
  readonly repo?: string
  readonly releaseType?: 'release'
  readonly channel: 'nightly' | 'latest'
  readonly updaterCacheDirName: string
}

/** Resolve the one generic macOS feed from the final electron-builder configuration. */
export function resolveMacOSAppUpdateFeed(publish: unknown): MacOSAppUpdateFeed | MacOSGitHubAppUpdateFeed

/** Create the electron-updater configuration embedded before code signing. */
export function createMacOSAppUpdateConfig(
  update: MacOSAppUpdateFeed | MacOSGitHubAppUpdateFeed,
  updaterCacheDirName: string,
): MacOSAppUpdateConfig

/** Write the updater configuration into an assembled App before signing. */
export function writeMacOSAppUpdateConfig(
  resourcesDir: string,
  update: MacOSAppUpdateFeed | MacOSGitHubAppUpdateFeed,
  updaterCacheDirName: string,
): Promise<void>

/** Verify the updater configuration inside an assembled macOS App. */
export function verifyMacOSAppUpdateConfig(
  appPath: string,
  update: MacOSAppUpdateFeed | MacOSGitHubAppUpdateFeed,
  updaterCacheDirName?: string,
): Promise<void>
