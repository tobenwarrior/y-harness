/** Installed profile dependencies and their bundle activation after package-manager operations. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  bundlePackageNameCandidates, readProfileManifest, resolveBundleDir, writeProfileManifest, type ProfileManifest,
} from './profile.ts'

/** Profile directory and installation used by the shared bundle resolver. */
export interface ProfilePluginLocation {
  /** Diagnostic prefix for profile manifest failures. */
  readonly binName: string
  /** Profile package directory managed by pnpm. */
  readonly profileDir: string
  /** Absolute package.json path of the owning dsh installation. */
  readonly installAnchor: string
}

/** One dependency under its package-manager key, including npm aliases. */
export interface ProfilePluginDependency {
  /** Dependency key used in package.json and the bundle list. */
  readonly name: string
  /** Installed version, or the dependency spec when installed metadata is unavailable. */
  readonly version: string
  /** Whether the package selected by the bundle resolver declares a patch. */
  readonly bundle: boolean
  /** Whether the dependency appears in the profile's active bundle list. */
  readonly enabled: boolean
}

/** Profile manifest and dependencies in manifest order. */
export interface ProfilePluginInventory {
  readonly manifest: ProfileManifest
  readonly dependencies: readonly ProfilePluginDependency[]
}

/** Result of reconciling bundle activation after a successful package operation. */
export interface ProfilePluginReconciliation {
  readonly plugins: ProfilePluginInventory
  /** Newly added ordinary dependencies, for optional caller-owned diagnostics. */
  readonly addedPlainDependencies: readonly string[]
}

/** Unavailable installed metadata must not prevent listing or removing dependencies. */
function optionalManifest(binName: string, packageDir: string): ProfileManifest | undefined {
  try { return readProfileManifest(binName, packageDir) } catch { return undefined }
}

/**
 * Find a profile-local package under either namespace without changing package.json or pnpm-lock.yaml.
 * @param profileDir - profile directory containing the managed node_modules tree.
 * @param name - package name as written in the profile manifest.
 * @returns the installed package directory, or undefined when no candidate is installed.
 */
export function installedProfilePackageDir(profileDir: string, name: string): string | undefined {
  for (const candidate of bundlePackageNameCandidates(name)) {
    const packageDir = join(profileDir, 'node_modules', candidate)
    if (existsSync(join(packageDir, 'package.json'))) return packageDir
  }
  return undefined
}

function samePackageName(left: string, right: string): boolean {
  return bundlePackageNameCandidates(left).includes(right)
}

function hasPackageName(names: ReadonlySet<string>, name: string): boolean {
  return [...names].some(candidate => samePackageName(candidate, name))
}

/** Resolve activation metadata with the same installation precedence as profile loading. */
function bundleManifest(location: ProfilePluginLocation, name: string): ProfileManifest | undefined {
  let packageDir: string
  try {
    packageDir = resolveBundleDir(location.binName, name, location.installAnchor, location.profileDir)
  } catch {
    // An unresolved dependency remains visible as an ordinary package.
    return undefined
  }
  return optionalManifest(location.binName, packageDir)
}

/**
 * Read installed versions and bundle declarations without requiring loadable plugin code.
 * Missing or unreadable installed metadata leaves the dependency visible for repair or removal.
 * @param location - profile and installation resolution inputs.
 * @returns dependency records in package.json order and the profile manifest.
 */
export function readProfilePlugins(location: ProfilePluginLocation): ProfilePluginInventory {
  const manifest = readProfileManifest(location.binName, location.profileDir)
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const dependencies = Object.entries(manifest.dependencies ?? {}).map(([name, spec]) => {
    const installedDir = installedProfilePackageDir(location.profileDir, name)
    const installed = installedDir === undefined ? undefined : optionalManifest(location.binName, installedDir)
    return {
      name,
      version: typeof installed?.version === 'string' ? installed.version : spec,
      bundle: bundleManifest(location, name)?.dsh?.bundle?.patch !== undefined,
      enabled: bundles.some(bundle => samePackageName(bundle, name)),
    }
  })
  return { manifest, dependencies }
}

/**
 * Write a bundle list while preserving the supplied profile's other metadata.
 * @param profileDir - directory whose package.json is updated.
 * @param manifest - current profile manifest, read after the package operation when applicable.
 * @param bundles - ordered active bundle names, including any template entries.
 * @returns the written manifest.
 */
export function writeProfileBundles(
  profileDir: string, manifest: ProfileManifest, bundles: readonly string[],
): ProfileManifest {
  const updated = { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles] } } }
  writeProfileManifest(profileDir, updated)
  return updated
}

/**
 * Reconcile installed bundle declarations after a successful package-manager operation.
 * Dependency-managed entries disappear when removed or when their package loses its declaration;
 * template entries retain their order and duplicates. New bundle dependencies activate automatically.
 * @param options - location, inventory captured before pnpm, and whether explicitly disabled bundles remain disabled.
 * @returns updated inventory and newly added ordinary dependencies for caller-owned warnings.
 */
export function reconcileProfilePlugins(options: ProfilePluginLocation & {
  readonly before: ProfilePluginInventory
  readonly preserveDisabled: boolean
}): ProfilePluginReconciliation {
  const after = readProfilePlugins(options)
  const beforeNames = new Set(options.before.dependencies.map(dependency => dependency.name))
  const afterNames = new Set(after.dependencies.map(dependency => dependency.name))
  const bundleNames = new Set(after.dependencies.filter(dependency => dependency.bundle).map(dependency => dependency.name))
  const disabled = new Set(options.preserveDisabled
    ? options.before.dependencies.filter(dependency => dependency.bundle && !dependency.enabled).map(dependency => dependency.name)
    : [])
  const previous = after.manifest.dsh?.profile?.bundles ?? []
  const bundles = previous.filter(name => (!hasPackageName(beforeNames, name) && !hasPackageName(afterNames, name)) || hasPackageName(bundleNames, name))
  for (const dependency of after.dependencies) {
    if (dependency.bundle && !hasPackageName(disabled, dependency.name) && !bundles.some(name => samePackageName(name, dependency.name))) {
      bundles.push(dependency.name)
    }
  }
  const changed = bundles.length !== previous.length || bundles.some((name, index) => name !== previous[index])
  const manifest = changed ? writeProfileBundles(options.profileDir, after.manifest, bundles) : after.manifest
  return {
    plugins: {
      manifest,
      dependencies: after.dependencies.map(dependency => ({
        ...dependency, enabled: bundles.some(name => samePackageName(name, dependency.name)),
      })),
    },
    addedPlainDependencies: after.dependencies.filter(dependency => !dependency.bundle && !hasPackageName(beforeNames, dependency.name))
      .map(dependency => dependency.name),
  }
}
