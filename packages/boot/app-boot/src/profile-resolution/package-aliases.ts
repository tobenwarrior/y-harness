/** Package-name compatibility for profiles created before the Y Harness namespace migration. */

const LEGACY_HARNESS_PACKAGE_PREFIX = '@deepseek-ai/dsh-'
const CANONICAL_HARNESS_PACKAGE_PREFIX = '@yharness/'
const LEGACY_CLI_PACKAGE_NAME = '@deepseek-ai/dsh'
const CANONICAL_CLI_PACKAGE_NAME = '@yharness/cli'

const CORDIS_PACKAGE_ALIASES = [
  ['@deepseek-ai/cordis', '@yharness/cordis'],
  ['@deepseek-ai/cosmokit', '@yharness/cosmokit'],
  ['@deepseek-ai/schemastery', '@yharness/schemastery'],
  ['@deepseek-ai/cordis-plugin-loader', '@yharness/cordis-plugin-loader'],
  ['@deepseek-ai/cordis-plugin-include', '@yharness/cordis-plugin-include'],
  ['@deepseek-ai/cordis-plugin-group', '@yharness/cordis-plugin-group'],
  ['@deepseek-ai/cordis-plugin-timer', '@yharness/cordis-plugin-timer'],
  ['@deepseek-ai/cordis-plugin-hmr', '@yharness/cordis-plugin-hmr'],
  ['@deepseek-ai/cordis-plugin-logger-console', '@yharness/cordis-plugin-logger-console'],
] as const

const CORDIS_CANONICAL_BY_LEGACY = new Map<string, string>(CORDIS_PACKAGE_ALIASES)
const CORDIS_LEGACY_BY_CANONICAL = new Map<string, string>(CORDIS_PACKAGE_ALIASES.map(([legacy, canonical]) => [canonical, legacy]))

interface PackageSpecifierParts {
  readonly name: string
  readonly suffix: string
}

function packageSpecifierParts(specifier: string): PackageSpecifierParts {
  const firstSlash = specifier.indexOf('/')
  if (firstSlash < 0) return { name: specifier, suffix: '' }
  if (specifier[0] !== '@') return { name: specifier.slice(0, firstSlash), suffix: specifier.slice(firstSlash) }
  const secondSlash = specifier.indexOf('/', firstSlash + 1)
  if (secondSlash < 0) return { name: specifier, suffix: '' }
  return { name: specifier.slice(0, secondSlash), suffix: specifier.slice(secondSlash) }
}

function cordisPackageNameCandidates(packageSpecifier: string): readonly string[] | undefined {
  const { name, suffix } = packageSpecifierParts(packageSpecifier)
  const canonical = CORDIS_CANONICAL_BY_LEGACY.get(name) ?? name
  const legacy = CORDIS_LEGACY_BY_CANONICAL.get(name) ?? CORDIS_LEGACY_BY_CANONICAL.get(canonical)
  return legacy === undefined ? undefined : [`${canonical}${suffix}`, `${legacy}${suffix}`]
}

/**
 * Return the package specifiers a rebranded profile may resolve, in preference order.
 *
 * The Harness namespace and the vendored Cordis namespace are translated by
 * exact package-name tables. A package such as `@yharness/llm-deepseek`
 * therefore keeps `deepseek` in its package name, while unrelated package
 * names remain unchanged. Both spellings are probed so profiles and
 * installations can be upgraded in either order without rewriting a user's
 * manifest first.
 * @param packageSpecifier - a persisted profile bundle or dependency specifier, optionally with a subpath.
 * @returns canonical-first aliases for the package, without duplicates.
 */
export function bundlePackageNameCandidates(packageSpecifier: string): readonly string[] {
  const cordisCandidates = cordisPackageNameCandidates(packageSpecifier)
  if (cordisCandidates !== undefined) return cordisCandidates
  const { name, suffix } = packageSpecifierParts(packageSpecifier)
  if (name === LEGACY_CLI_PACKAGE_NAME || name === CANONICAL_CLI_PACKAGE_NAME) {
    return [`${CANONICAL_CLI_PACKAGE_NAME}${suffix}`, `${LEGACY_CLI_PACKAGE_NAME}${suffix}`]
  }
  const candidates = new Set<string>()
  if (name.startsWith(LEGACY_HARNESS_PACKAGE_PREFIX)) {
    candidates.add(`${CANONICAL_HARNESS_PACKAGE_PREFIX}${name.slice(LEGACY_HARNESS_PACKAGE_PREFIX.length)}${suffix}`)
  } else if (name.startsWith(CANONICAL_HARNESS_PACKAGE_PREFIX)) {
    candidates.add(`${name}${suffix}`)
  }
  candidates.add(packageSpecifier)
  if (name.startsWith(CANONICAL_HARNESS_PACKAGE_PREFIX)) {
    candidates.add(`${LEGACY_HARNESS_PACKAGE_PREFIX}${name.slice(CANONICAL_HARNESS_PACKAGE_PREFIX.length)}${suffix}`)
  }
  return [...candidates]
}
