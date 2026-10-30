/**
 * Shared filesystem path helpers for Y Harness user data.
 *
 * @module @yharness/home-paths
 */

import { copyFile, chmod, lstat, mkdir, opendir, readdir, readlink, realpath, symlink, utimes } from 'node:fs/promises'
import { createReadStream, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Legacy directory name for the pre-Y Harness home under the OS home. */
export const DSH_HOME_DIR_NAME = '.dsh'

/** Stable user-facing display form for the legacy default home. */
export const DEFAULT_DSH_HOME_DISPLAY = `~/${DSH_HOME_DIR_NAME}`

/** Legacy environment variable that overrides the harness home. */
export const DSH_HOME_ENV = 'DSH_HOME'

/** Directory name for the canonical Y Harness home under the OS home. */
export const YH_HOME_DIR_NAME = '.yharness'

/** Stable user-facing display form for the canonical Y Harness home. */
export const DEFAULT_YH_HOME_DISPLAY = `~/${YH_HOME_DIR_NAME}`

/** Environment variable that overrides the canonical Y Harness home. */
export const YH_HOME_ENV = 'YH_HOME'

/**
 * Give a native filesystem watcher one canonical spelling of a path, even
 * when its final components do not exist yet. The deepest existing ancestor
 * is resolved through {@link realpath}; when a suffix is missing, that
 * ancestor is also proved to be an enumerable directory before the suffix is
 * restored. This prevents Windows from treating a regular-file ancestor as
 * ordinary absence, and prevents short-name aliases from being mixed with
 * long paths emitted by the native watcher backend.
 * @param path - Watch target or root, resolved against the current directory.
 * @returns the target with its existing ancestor canonicalized.
 * @throws when ancestor traversal encounters an error other than absence, or
 * the existing ancestor of a missing suffix is not an enumerable directory.
 */
export async function canonicalizeWatchPath(path: string): Promise<string> {
  let current = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      const canonical = await realpath(current)
      if (missing.length > 0) {
        // A Windows file-as-parent probe reports ENOENT. Opening the resolved
        // ancestor preserves the cross-platform directory requirement.
        const directory = await opendir(canonical)
        await directory.close()
      }
      return join(canonical, ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      /* v8 ignore next -- a filesystem root exists, so traversal resolves before this guard */
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * Resolve the legacy harness home using Node's platform path rules.
 * @returns the absolute default harness home path.
 */
export function defaultDshHome(): string {
  return join(homedir(), DSH_HOME_DIR_NAME)
}

/**
 * Resolve the canonical Y Harness home under the operating-system home.
 * @returns the absolute canonical default home path.
 */
export function defaultYhHome(): string {
  return join(homedir(), YH_HOME_DIR_NAME)
}

/**
 * Expand supported tilde prefixes against the operating-system home.
 * @param path - configured path that may begin with `~`, `~/`, or `~\`.
 * @returns the expanded path, or the original value when no supported prefix is present.
 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the shared harness home through the canonical Y Harness rules.
 *
 * Precedence, highest first: an explicit configured path, `$YH_HOME`, `$DSH_HOME`,
 * then safe inspection of the canonical and legacy default roots. A populated
 * `~/.dsh` is retained until the caller explicitly selects or migrates
 * `~/.yharness`. Empty or whitespace-only environment values are treated as
 * unset. This legacy-named entry point delegates to the canonical resolver so
 * existing consumers do not silently create a second data root.
 * @param configured - explicit harness-home override, which has highest precedence.
 * @param env - environment mapping used to read canonical and legacy overrides.
 * @returns the normalized absolute harness home path.
 */
export function resolveDshHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  return resolveYhHome(configured, env)
}

/**
 * Resolve the canonical Y Harness home.
 *
 * Precedence, highest first: an explicit configured path, `$YH_HOME`, `$DSH_HOME`,
 * then safe inspection of the default roots. A populated legacy root wins when
 * the canonical root may be partial; use {@link migrateLegacyHome} and then an
 * explicit canonical override to switch roots.
 * @param configured - explicit harness-home override, which has highest precedence.
 * @param env - environment mapping used to read canonical and legacy overrides.
 * @returns the normalized absolute Y Harness home path.
 */
export function resolveYhHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  const canonical = env[YH_HOME_ENV]
  const legacy = env[DSH_HOME_ENV]
  let selected: string
  if (configured !== undefined) selected = configured
  else if (canonical !== undefined && canonical.trim().length > 0) selected = canonical
  else if (legacy !== undefined && legacy.trim().length > 0) selected = legacy
  else selected = defaultHomeWithoutOverride()
  return resolve(expandHomePath(selected))
}

type HomePresence = 'missing' | 'empty' | 'populated' | 'invalid'

function defaultHomeWithoutOverride(): string {
  const canonical = homePresence(defaultYhHome())
  const legacy = homePresence(defaultDshHome())
  // A populated legacy root is safer than selecting a canonical root that may
  // have been created by a partial first launch. An explicit YH_HOME or configured
  // path lets the caller select the canonical root deliberately.
  if (legacy === 'populated') return defaultDshHome()
  if (canonical === 'populated') return defaultYhHome()
  return defaultYhHome()
}

function homePresence(path: string): HomePresence {
  let stats
  try {
    // Follow an intentional home symlink while the migration helper itself
    // refuses symlink roots before writing through them.
    stats = statSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
  if (!stats.isDirectory()) return 'invalid'
  return readdirSync(path).length === 0 ? 'empty' : 'populated'
}

/**
 * Join path segments onto the resolved legacy home.
 * @param segments - path segments appended to the Harness home; an empty list returns the home itself.
 * @returns the normalized absolute joined path.
 */
export function dshHomePath(...segments: string[]): string {
  return join(resolveDshHome(), ...segments)
}

/**
 * Join path segments onto the canonical Y Harness home.
 * @param segments - path segments appended to the canonical home.
 * @returns the normalized absolute joined path.
 */
export function yhHomePath(...segments: string[]): string {
  return join(resolveYhHome(), ...segments)
}

/**
 * Join path segments onto the resolved Harness home's `cache` directory without creating it; no arguments returns the directory itself.
 * @param optionsOrSegment - explicit home override, or the first path segment; omission uses the default home resolution.
 * @param segments - additional path segments after the first child, if any.
 * @returns the normalized absolute cache path.
 */
export function dshCachePath(optionsOrSegment: { dshHome?: string } | string = {}, ...segments: string[]): string {
  if (typeof optionsOrSegment === 'string') return dshHomePath('cache', optionsOrSegment, ...segments)
  return join(resolveDshHome(optionsOrSegment.dshHome), 'cache', ...segments)
}

/** Options accepted by {@link yhCachePath}; `dshHome` keeps explicit legacy callers source-compatible. */
export interface YhCachePathOptions {
  /** Explicit canonical home override. */
  readonly yhHome?: string
  /** Explicit legacy home override, used only when `yhHome` is absent. */
  readonly dshHome?: string
}

/**
 * Join path segments onto the canonical Y Harness home's `cache` directory.
 * @param optionsOrSegment - explicit home override, or the first path segment.
 * @param segments - additional path segments after the first child.
 * @returns the normalized absolute cache path without creating directories.
 */
export function yhCachePath(optionsOrSegment: YhCachePathOptions | string = {}, ...segments: string[]): string {
  if (typeof optionsOrSegment === 'string') return yhHomePath('cache', optionsOrSegment, ...segments)
  return join(resolveYhHome(optionsOrSegment.yhHome ?? optionsOrSegment.dshHome), 'cache', ...segments)
}

/**
 * Describe a resolved home symbolically for user-facing display.
 *
 * It never returns an absolute machine path: the default home is labelled
 * `~/.yharness` or `~/.dsh`, and any configured home is labelled `$DSH_HOME`.
 * @param resolvedHome - the absolute path returned by {@link resolveDshHome}.
 * @returns `~/.dsh` for the default home, otherwise `$DSH_HOME`.
 */
export function dshHomeDisplay(resolvedHome: string): string {
  const normalized = resolve(resolvedHome)
  if (normalized === resolve(defaultYhHome())) return DEFAULT_YH_HOME_DISPLAY
  if (normalized === resolve(defaultDshHome())) return DEFAULT_DSH_HOME_DISPLAY
  return `$${DSH_HOME_ENV}`
}

/**
 * Describe a resolved Y Harness home symbolically without revealing an absolute path.
 * @param resolvedHome - the absolute path returned by {@link resolveYhHome}.
 * @returns the canonical or legacy default label, or `$YH_HOME` for a configured home.
 */
export function yhHomeDisplay(resolvedHome: string): string {
  const normalized = resolve(resolvedHome)
  if (normalized === resolve(defaultYhHome())) return DEFAULT_YH_HOME_DISPLAY
  if (normalized === resolve(defaultDshHome())) return DEFAULT_DSH_HOME_DISPLAY
  return `$${YH_HOME_ENV}`
}

/** Options for an explicit, non-destructive legacy-home migration. */
export interface LegacyHomeMigrationOptions {
  /** Existing legacy home to copy. Defaults to `~/.dsh`. */
  readonly source?: string
  /** Canonical destination to populate. Defaults to `~/.yharness`. */
  readonly target?: string
}

/** Result of one legacy-home migration attempt. */
export interface LegacyHomeMigrationResult {
  readonly source: string
  readonly target: string
  readonly status: 'not-found' | 'migrated' | 'already-current' | 'conflicts'
  readonly copied: number
  readonly unchanged: number
  readonly conflicts: readonly string[]
}

/**
 * Copy a legacy home into the canonical home without deleting or overwriting anything.
 * Existing directories are traversed, identical files are retained, and differing files
 * are reported as conflicts. The source remains available for rollback and old launchers.
 * The helper does not lock either root; callers must stop writers and own any application
 * lock before copying, and a failed copy may leave a partial destination that is safe to rerun.
 * @param options - optional source and destination overrides.
 * @returns counts and conflict paths from the copy operation.
 * @throws when the source is not a directory, the destination is the source, or a file cannot be read/copied.
 */
export async function migrateLegacyHome(options: LegacyHomeMigrationOptions = {}): Promise<LegacyHomeMigrationResult> {
  const source = resolve(expandHomePath(options.source ?? defaultDshHome()))
  const target = resolve(expandHomePath(options.target ?? defaultYhHome()))
  if (comparisonPath(source) === comparisonPath(target)) throw new Error('legacy home migration source and target must differ')
  if (isPathInside(target, source) || isPathInside(source, target)) {
    throw new Error('legacy home migration source and target must be separate directories')
  }
  let sourceStats
  try {
    sourceStats = await lstat(source)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { source, target, status: 'not-found', copied: 0, unchanged: 0, conflicts: [] }
    }
    throw error
  }
  if (!sourceStats.isDirectory()) throw new Error(`legacy home migration source is not a directory: ${source}`)
  await ensureMigrationTarget(target, sourceStats.mode & 0o777)
  const counters: MigrationCounters = { copied: 0, unchanged: 0, conflicts: [] }
  await copyDirectoryContents(source, target, counters)
  return {
    source,
    target,
    status: counters.conflicts.length > 0 ? 'conflicts' : counters.copied > 0 ? 'migrated' : 'already-current',
    copied: counters.copied,
    unchanged: counters.unchanged,
    conflicts: counters.conflicts,
  }
}

function isPathInside(candidate: string, parent: string): boolean {
  const suffix = relative(comparisonPath(parent), comparisonPath(candidate))
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

function comparisonPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

async function ensureMigrationTarget(target: string, mode: number): Promise<void> {
  let targetStats
  try {
    targetStats = await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (targetStats === undefined) {
    await mkdir(target, { recursive: true, mode })
    return
  }
  if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
    throw new Error(`legacy home migration target is not a directory: ${target}`)
  }
}

interface MigrationCounters {
  copied: number
  unchanged: number
  conflicts: string[]
}

async function copyDirectoryContents(source: string, target: string, counters: MigrationCounters): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name)
    const targetPath = join(target, entry.name)
    let targetStats
    try {
      targetStats = await lstat(targetPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (entry.isDirectory()) {
      if (targetStats === undefined) {
        await mkdir(targetPath, { mode: (await lstat(sourcePath)).mode & 0o777 })
        counters.copied += 1
      } else if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
        counters.conflicts.push(targetPath)
        continue
      } else {
        counters.unchanged += 1
      }
      await copyDirectoryContents(sourcePath, targetPath, counters)
      continue
    }
    if (entry.isSymbolicLink()) {
      const link = await readlink(sourcePath)
      if (targetStats === undefined) {
        await symlink(link, targetPath)
        counters.copied += 1
      } else if (targetStats.isSymbolicLink() && await readlink(targetPath) === link) {
        counters.unchanged += 1
      } else {
        counters.conflicts.push(targetPath)
      }
      continue
    }
    if (!entry.isFile()) throw new Error(`legacy home migration cannot copy ${sourcePath}`)
    if (targetStats === undefined) {
      const sourceStats = await lstat(sourcePath)
      await copyFile(sourcePath, targetPath)
      await chmod(targetPath, sourceStats.mode & 0o777)
      await utimes(targetPath, sourceStats.atime, sourceStats.mtime)
      counters.copied += 1
    } else if (targetStats.isFile() && await filesEqual(sourcePath, targetPath)) {
      counters.unchanged += 1
    } else {
      counters.conflicts.push(targetPath)
    }
  }
}

async function filesEqual(left: string, right: string): Promise<boolean> {
  const [leftStats, rightStats] = await Promise.all([lstat(left), lstat(right)])
  if (leftStats.size !== rightStats.size) return false
  const leftStream = createReadStream(left)
  const rightStream = createReadStream(right)
  try {
    const leftIterator = leftStream[Symbol.asyncIterator]()
    const rightIterator = rightStream[Symbol.asyncIterator]()
    while (true) {
      const [leftChunk, rightChunk] = await Promise.all([leftIterator.next(), rightIterator.next()])
      if (leftChunk.done || rightChunk.done) return leftChunk.done === rightChunk.done
      if (!leftChunk.value.equals(rightChunk.value)) return false
    }
  } finally {
    leftStream.destroy()
    rightStream.destroy()
  }
}
