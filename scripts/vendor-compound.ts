/**
 * Re-vendor the Compound skills from their upstream repository.
 *
 * `packages/skill/skill-compound/assets` is a byte-identical copy of upstream `skills/`, and
 * `UPSTREAM.md` records which release it came from. This script performs that copy documented
 * procedure mechanically: clone upstream at its release commit, mirror the tree, record the
 * version and commit, run the package tests, and commit only when they pass. It never pushes.
 *
 * `--check` reports the difference and changes nothing; `--apply` prepares a branch, and on
 * success fast-forwards `master` so the build that follows picks the new content up.
 *
 * @module scripts/vendor-compound
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { hasUpdate, recordedCommit, UPSTREAM_REPOSITORY, VENDORED_VERSION } from '../packages/skill/skill-compound/src/upstream.ts'

const REPOSITORY_URL = `https://github.com/${UPSTREAM_REPOSITORY}`
const BRANCH = 'main'
const PACKAGE = 'packages/skill/skill-compound'
const RECORD = `${PACKAGE}/UPSTREAM.md`
const VERSION_SOURCE = `${PACKAGE}/src/upstream.ts`
const MIRRORED_FILES = ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'SOURCES.md'] as const

/** One upstream release and the state this checkout ships. */
export interface VendorReport {
  /** Release recorded in this checkout. */
  readonly vendored: string
  /** Release upstream publishes. */
  readonly upstream: string
  /** Commit upstream's branch points at. */
  readonly commit: string
  /** Whether upstream publishes a different release than the recorded one. */
  readonly updateAvailable: boolean
  /** What `--apply` did, when it ran. */
  readonly applied: 'no' | 'committed' | 'failed'
  /** Branch the update landed on, when it committed. */
  readonly branch: string | null
  /** Why an applied update failed, when it failed. */
  readonly error: string | null
}

/**
 * Compare two release strings numerically per dot-separated part.
 * @param left - first release.
 * @param right - second release.
 * @returns negative when `left` precedes `right`, zero when equal, positive otherwise.
 */
export function compareReleases(left: string, right: string): number {
  const parts = (value: string): number[] => value.split('.').map(part => Number.parseInt(part, 10) || 0)
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Rewrite the vendored-release row of `UPSTREAM.md`.
 * @param source - current document text.
 * @param release - release to record.
 * @param commit - upstream commit to record.
 * @param day - date to record, as `YYYY-MM-DD`.
 * @returns the updated document.
 */
export function recordVendoredRelease(source: string, release: string, commit: string, day: string): string {
  return source
    .replace(/^\| Vendored version \| .*$/m, `| Vendored version | \`${release}\` (upstream \`plugin.json\`) |`)
    .replace(/^\| Vendored commit \| .*$/m, `| Vendored commit | \`${commit}\` (${day}) |`)
    .replace(/^\| Vendored on \| .*$/m, `| Vendored on | ${day} |`)
}

/**
 * Rewrite the version this package declares for its vendored content.
 * @param source - current module text.
 * @param release - release to declare.
 * @returns the updated module.
 */
export function recordVendoredVersion(source: string, release: string): string {
  return source.replace(/^export const VENDORED_VERSION = '[^']*'$/m, `export const VENDORED_VERSION = '${release}'`)
}

/** Run one command in the repository, returning its stdout. */
function run(command: string, args: readonly string[], cwd: string, allowFailure = false): string {
  try {
    return execFileSync(command, [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 })
  } catch (error) {
    if (allowFailure) return ''
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`)
  }
}

/** Print one progress line to stderr, keeping stdout for the report. */
function note(message: string): void {
  process.stderr.write(`vendor-compound: ${message}\n`)
}

/** Clone upstream's branch into a fresh temporary directory. */
function cloneUpstream(): { directory: string; release: string; commit: string } {
  const directory = mkdtempSync(join(tmpdir(), 'compound-skills-'))
  note(`cloning ${REPOSITORY_URL} (${BRANCH})`)
  run('git', ['clone', '--quiet', '--depth', '1', '--branch', BRANCH, REPOSITORY_URL, directory], process.cwd())
  const manifest = JSON.parse(readFileSync(join(directory, 'plugin.json'), 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error('upstream plugin.json declares no version')
  }
  const commit = run('git', ['rev-parse', 'HEAD'], directory).trim()
  return { directory, release: manifest.version, commit }
}

/** Mirror upstream's skill tree and record files into this package. */
function mirror(upstream: string, root: string): void {
  const assets = join(root, PACKAGE, 'assets')
  note(`mirroring ${upstream}/skills -> ${PACKAGE}/assets`)
  run('rsync', ['-a', '--delete', '--exclude', '__pycache__', '--exclude', '.DS_Store',
    `${join(upstream, 'skills')}/`, `${assets}/`], root)
  for (const file of MIRRORED_FILES) {
    if (!existsSync(join(upstream, file))) throw new Error(`upstream publishes no ${file}`)
    cpSync(join(upstream, file), join(root, PACKAGE, file))
  }
}

/** Run the package tests with the repository's own vitest, without relying on PATH. */
function packageTests(root: string): boolean {
  note('running the package tests')
  const result = execFileSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=2', PACKAGE], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  process.stderr.write(result)
  return true
}

/** Read the release this checkout records. */
function recordedRelease(root: string): string {
  return readFileSync(join(root, VERSION_SOURCE), 'utf8').match(/VENDORED_VERSION = '([^']*)'/)?.[1] ?? VENDORED_VERSION
}

/** Prepare the branch, mirror the release, record it, test it, and commit. */
function apply(upstream: { directory: string; release: string; commit: string }, root: string, branch: string): void {
  const dirty = run('git', ['status', '--porcelain'], root).trim()
  if (dirty !== '') throw new Error(`working tree is not clean:\n${dirty}`)
  const previous = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root).trim()
  run('git', ['switch', '-c', branch], root)
  const touched = [PACKAGE]
  try {
    mirror(upstream.directory, root)
    const day = new Date().toISOString().slice(0, 10)
    writeFileSync(join(root, RECORD), recordVendoredRelease(readFileSync(join(root, RECORD), 'utf8'), upstream.release, upstream.commit, day))
    writeFileSync(join(root, VERSION_SOURCE), recordVendoredVersion(readFileSync(join(root, VERSION_SOURCE), 'utf8'), upstream.release))
    packageTests(root)
  } catch (error) {
    note(`update failed: ${error instanceof Error ? error.message : String(error)}`)
    run('git', ['restore', '--staged', '--worktree', '--', ...touched], root, true)
    run('git', ['switch', previous], root, true)
    throw error
  }
  run('git', ['add', ...touched], root)
  run('git', ['commit', '--quiet', '-m', `skill-compound: vendor upstream ${upstream.release}`, '--', ...touched], root)
  note(`committed on ${branch}`)
  run('git', ['switch', previous], root)
  run('git', ['merge', '--ff-only', branch], root)
  run('git', ['branch', '--delete', branch], root)
  note(`${previous} is now at the vendored release`)
}

/** Report the difference, and apply it when asked. */
function main(): number {
  const { values } = parseArgs({
    options: {
      check: { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      branch: { type: 'string' },
      'keep-temp': { type: 'boolean', default: false },
    },
  })
  const root = resolve(import.meta.dirname, '..')
  const vendored = recordedRelease(root)
  const upstream = cloneUpstream()
  try {
    const commit = recordedCommit(readFileSync(join(root, RECORD), 'utf8'))
    const updateAvailable = hasUpdate(upstream.release, vendored, upstream.commit, commit)
    if (values.check && values.apply) throw new Error('--check and --apply are exclusive')
    let applied: VendorReport['applied'] = 'no'
    let branch: string | null = null
    let failure: string | null = null
    if (!updateAvailable) {
      note(`already at upstream ${upstream.release}`)
    } else if (values.apply) {
      branch = values.branch ?? `compound/${upstream.release}-${upstream.commit.slice(0, 12)}`
      try {
        apply(upstream, root, branch)
        applied = 'committed'
      } catch (error) {
        applied = 'failed'
        failure = error instanceof Error ? error.message : String(error)
      }
    } else {
      note(`upstream publishes ${upstream.release}; this checkout records ${vendored} (pass --apply)`)
    }
    const report: VendorReport = {
      vendored, upstream: upstream.release, commit: upstream.commit, updateAvailable, applied, branch, error: failure,
    }
    process.stdout.write(`${JSON.stringify(report)}\n`)
    return failure === null ? 0 : 1
  } finally {
    if (!values['keep-temp']) rmSync(upstream.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main()
  } catch (error) {
    process.stderr.write(`vendor-compound: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
