/** Public prefix used for newly packaged Y Harness installers and update archives. */
export const DESKTOP_ARTIFACT_PREFIX = 'y-harness'

/** Prefix used by releases produced before the Y Harness application rebrand. */
export const LEGACY_DESKTOP_ARTIFACT_PREFIX = 'deepseek-harness'

/**
 * Build the shared installer stem for one target.
 * @param {string} version - Validated application build version.
 * @param {string} os - Electron-builder operating-system segment.
 * @param {string} arch - Electron-builder architecture segment.
 * @returns {string} Lowercase artifact stem used by release files.
 */
export function desktopArtifactBase(version, os, arch) {
  return `${DESKTOP_ARTIFACT_PREFIX}-${version}-${os}-${arch}`
}

/**
 * Build one packaged installer or update archive name.
 * @param {string} version - Validated application build version.
 * @param {string} os - Electron-builder operating-system segment.
 * @param {string} arch - Electron-builder architecture segment.
 * @param {string} extension - Artifact extension without a leading dot.
 * @param {boolean} unsigned - Whether to mark a local unsigned Windows artifact.
 * @returns {string} Publicly branded artifact filename.
 */
export function desktopArtifactFilename(version, os, arch, extension, unsigned = false) {
  return `${desktopArtifactBase(version, os, arch)}${unsigned ? '-unsigned' : ''}.${extension}`
}

/**
 * Match both current and pre-rebrand artifact names while reading existing feeds.
 * @returns {RegExp} A non-global matcher whose `version` group contains the build version.
 */
export function desktopArtifactPattern() {
  return new RegExp(`(?:^|/)(?:${DESKTOP_ARTIFACT_PREFIX}|${LEGACY_DESKTOP_ARTIFACT_PREFIX})-(?<version>.+)-(?:mac|win)-(?:arm64|x64)(?:-unsigned)?\\.(?:exe|dmg|zip)$`, 'u')
}
