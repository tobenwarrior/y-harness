/** Resolve the public GitHub Releases deployment used by production Desktop builds. */

import { valid } from 'semver'

/** Repository owner for public Y Harness Desktop releases. */
export const DESKTOP_GITHUB_OWNER = 'tobenwarrior'

/** Repository name for public Y Harness Desktop releases. */
export const DESKTOP_GITHUB_REPOSITORY = 'y-harness'

/** Public channel used by electron-updater for production releases. */
export const DESKTOP_GITHUB_CHANNEL = 'latest'

/** GitHub provider configuration used by electron-builder and electron-updater. */
export const DESKTOP_GITHUB_PROVIDER = 'github'

/**
 * Resolve the production GitHub Releases updater configuration for one target.
 *
 * The provider metadata is embedded in the packaged app; it contains no token
 * or write credential. Release publication is performed separately by CI.
 * @param {NodeJS.Platform} platform - Target Node.js platform.
 * @param {string} arch - Target architecture.
 * @returns {{ environment: 'production', target: 'mac-arm64' | 'mac-x64' | 'win-x64', provider: 'github', owner: string, repo: string, repository: string, channel: 'latest', releaseType: 'release', publicUrl: string }} Public provider configuration.
 */
export function resolveDesktopGitHubReleaseConfig(platform, arch) {
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform
  const target = `${os}-${arch}`
  if (!['mac-arm64', 'mac-x64', 'win-x64'].includes(target)) {
    throw new Error(`desktop GitHub release: unsupported target ${target}`)
  }
  return {
    environment: 'production',
    target,
    provider: DESKTOP_GITHUB_PROVIDER,
    owner: DESKTOP_GITHUB_OWNER,
    repo: DESKTOP_GITHUB_REPOSITORY,
    repository: DESKTOP_GITHUB_REPOSITORY,
    channel: DESKTOP_GITHUB_CHANNEL,
    releaseType: 'release',
    publicUrl: `https://github.com/${DESKTOP_GITHUB_OWNER}/${DESKTOP_GITHUB_REPOSITORY}/releases/latest/download/`,
  }
}

/**
 * Return the metadata filename used for a GitHub Release channel.
 * @param {NodeJS.Platform} platform - Target Node.js platform.
 * @param {string} version - Published semantic version, used to reject invalid input.
 * @returns {'latest.yml' | 'latest-mac.yml'} GitHub updater metadata filename.
 */
export function desktopGitHubMetadataFilename(platform, version) {
  if (valid(version) === null) throw new Error(`desktop GitHub release: invalid Desktop version ${JSON.stringify(version)}`)
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`desktop GitHub release: unsupported metadata platform ${platform}`)
  }
  return platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml'
}
