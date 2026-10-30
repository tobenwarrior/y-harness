/** Write and verify the updater configuration sealed into a macOS application. */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'

const CONFIG_FILENAME = 'app-update.yml'
const CHANNEL = 'nightly'

function object(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`desktop macOS update config: ${label} must be an object`)
  }
  return value
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`desktop macOS update config: ${label} must be a non-empty string`)
  }
  return value
}

/**
 * Resolve the one macOS feed from the final electron-builder configuration.
 * @param {unknown} publish - Final electron-builder publish setting.
 * @returns {{ provider: 'generic', publicUrl: string, channel: 'nightly' } | { provider: 'github', owner: string, repo: string, channel: 'latest', releaseType: 'release' }} Resolved feed used by the packaged App.
 */
export function resolveMacOSAppUpdateFeed(publish) {
  if (!Array.isArray(publish) || publish.length !== 1) {
    throw new Error('desktop macOS update config: publish must contain exactly one provider')
  }
  const provider = object(publish[0], 'publish provider')
  if (provider.provider === 'github') {
    if (provider.channel !== 'latest' || provider.releaseType !== 'release') {
      throw new Error('desktop macOS update config: GitHub provider must use the latest release channel')
    }
    return {
      provider: 'github',
      owner: nonEmptyString(provider.owner, 'GitHub owner'),
      repo: nonEmptyString(provider.repo, 'GitHub repository'),
      channel: 'latest',
      releaseType: 'release',
    }
  }
  if (provider.provider !== 'generic' || provider.channel !== CHANNEL) {
    throw new Error('desktop macOS update config: publish provider must be generic Nightly or GitHub latest')
  }
  // Keep the generic return shape stable for the local qualification helpers.
  return { publicUrl: nonEmptyString(provider.url, 'publish provider URL') }
}

/**
 * Create the electron-updater configuration embedded before code signing.
 * @param {{ provider: 'generic', publicUrl: string, channel: 'nightly' } | { provider: 'github', owner: string, repo: string, channel: 'latest', releaseType: 'release' }} update - Resolved update feed.
 * @param {string} updaterCacheDirName - electron-builder application cache directory.
 * @returns {{ provider: 'generic', url: string, channel: 'nightly', updaterCacheDirName: string } | { provider: 'github', owner: string, repo: string, releaseType: 'release', channel: 'latest', updaterCacheDirName: string }} Packaged updater fields.
 */
export function createMacOSAppUpdateConfig(update, updaterCacheDirName) {
  const updaterCache = nonEmptyString(updaterCacheDirName, 'updater cache directory')
  if (update.provider === 'github') {
    return { provider: 'github', owner: update.owner, repo: update.repo, releaseType: update.releaseType,
      channel: update.channel, updaterCacheDirName: updaterCache }
  }
  return { provider: 'generic', url: nonEmptyString(update.publicUrl, 'public URL'), channel: CHANNEL,
    updaterCacheDirName: updaterCache }
}

/**
 * Write the updater configuration into an assembled App before signing.
 * @param {string} resourcesDir - App Contents/Resources directory.
 * @param {{ publicUrl: string }} update - Resolved update feed.
 * @param {string} updaterCacheDirName - electron-builder application cache directory.
 * @returns {Promise<void>} Resolves after the configuration is durable.
 */
export async function writeMacOSAppUpdateConfig(resourcesDir, update, updaterCacheDirName) {
  const config = createMacOSAppUpdateConfig(update, updaterCacheDirName)
  await writeFile(join(resourcesDir, CONFIG_FILENAME), dump(config, { lineWidth: -1, noRefs: true }))
}

/**
 * Verify the updater configuration inside an assembled macOS App.
 * @param {string} appPath - Application bundle path.
 * @param {{ provider: 'generic', publicUrl: string, channel: 'nightly' } | { provider: 'github', owner: string, repo: string, channel: 'latest', releaseType: 'release' }} update - Expected update feed.
 * @param {string | undefined} updaterCacheDirName - Exact cache directory when known.
 * @returns {Promise<void>} Resolves when the packaged configuration matches the release destination.
 */
export async function verifyMacOSAppUpdateConfig(appPath, update, updaterCacheDirName = undefined) {
  const path = join(appPath, 'Contents', 'Resources', CONFIG_FILENAME)
  let parsed
  try {
    parsed = load(await readFile(path, 'utf8'))
  }
  catch (error) {
    throw new Error(`desktop macOS update config: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const config = object(parsed, CONFIG_FILENAME)
  if (update.provider === 'github') {
    if (config.provider !== 'github' || config.owner !== update.owner || config.repo !== update.repo
      || config.releaseType !== update.releaseType || config.channel !== update.channel) {
      throw new Error(`desktop macOS update config: ${path} does not match GitHub ${update.owner}/${update.repo}`)
    }
  }
  else if (config.provider !== 'generic' || config.url !== update.publicUrl || config.channel !== CHANNEL) {
    throw new Error(`desktop macOS update config: ${path} does not match ${update.publicUrl}`)
  }
  const actualCacheDirName = nonEmptyString(config.updaterCacheDirName, `${CONFIG_FILENAME}.updaterCacheDirName`)
  if (updaterCacheDirName !== undefined && actualCacheDirName !== updaterCacheDirName) {
    throw new Error(`desktop macOS update config: ${path} has updater cache directory ${actualCacheDirName}; expected ${updaterCacheDirName}`)
  }
}
