import { createRequire } from 'node:module'

const CANONICAL_PREFIX = '@yharness/node-addon-system-'
const LEGACY_PREFIX = '@deepseek-ai/node-addon-system-'

/**
 * The platform package names in resolution order. The canonical YHarness
 * family is preferred, while the legacy family remains readable for installs
 * created before the package rename.
 * @param platform - Node platform identifier.
 * @param architecture - Node architecture identifier.
 * @returns canonical and legacy package names in lookup order.
 */
export function platformPackageNames(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): readonly [string, string] {
  return [
    `${CANONICAL_PREFIX}${platform}-${architecture}`,
    `${LEGACY_PREFIX}${platform}-${architecture}`,
  ]
}

/**
 * Resolve the host platform package, retaining compatibility with legacy
 * installs while new packages use the canonical YHarness scope.
 * @param resolvePackageJson - test hook over `require.resolve`.
 * @returns the selected package name and its manifest path.
 * @throws the last package-resolution error when neither family is installed.
 */
export function resolvePlatformPackageJson(
  resolvePackageJson: (specifier: string) => string = createRequire(import.meta.url).resolve,
): { packageName: string; manifest: string } {
  let lastError: unknown
  for (const packageName of platformPackageNames()) {
    try {
      return {
        packageName,
        manifest: resolvePackageJson(`${packageName}/package.json`),
      }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('no platform package is installed')
}
