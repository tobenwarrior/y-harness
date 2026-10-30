/** Repository owner for public Y Harness Desktop releases. */
export const DESKTOP_GITHUB_OWNER: 'tobenwarrior'

/** Repository name for public Y Harness Desktop releases. */
export const DESKTOP_GITHUB_REPOSITORY: 'y-harness'

/** Public channel used by electron-updater for production releases. */
export const DESKTOP_GITHUB_CHANNEL: 'latest'

/** GitHub provider used by electron-builder and electron-updater. */
export const DESKTOP_GITHUB_PROVIDER: 'github'

/** Production GitHub provider configuration for one target. */
export interface DesktopGitHubReleaseConfig {
  readonly environment: 'production'
  readonly target: 'mac-arm64' | 'mac-x64' | 'win-x64'
  readonly provider: 'github'
  readonly owner: string
  readonly repo: string
  readonly repository: string
  readonly channel: 'latest'
  readonly releaseType: 'release'
  readonly publicUrl: string
}

/** Resolve production GitHub Releases configuration for one target. */
export function resolveDesktopGitHubReleaseConfig(
  platform: NodeJS.Platform,
  arch: string,
): DesktopGitHubReleaseConfig

/** Return the metadata filename used by the GitHub updater channel. */
export function desktopGitHubMetadataFilename(
  platform: NodeJS.Platform,
  version: string,
): 'latest.yml' | 'latest-mac.yml'
