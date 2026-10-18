#!/usr/bin/env node
/**
 * Scoped upstream sync for the Y Harness fork.
 *
 * The fork's `master` is a squashed import with no ancestry shared with
 * `deepseek-ai/deepseek-harness`, so a normal merge cannot express "take the
 * official changes, but only the ones this fork wants". This tool expresses
 * that policy instead: `config.json` names the upstream paths this fork tracks
 * and the upstream commit whose content it has already ingested. The tool
 * diffs `baseline..target` over those paths, applies the result with git's
 * three-way patch machinery against the fetched upstream blobs, and reports
 * exactly what landed, what conflicted, and which new packages need bundle
 * wiring.
 *
 * The tool never merges, commits, or pushes. It prepares a branch (or only a
 * patch, with the default plan mode) so a human reviews the result; merging
 * that branch is what advances the recorded baseline.
 *
 * @module scripts/upstream-sync/sync
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

const USAGE = `Usage: node scripts/upstream-sync/sync.mjs [options]

Plans (default) or applies the scoped upstream delta declared by
scripts/upstream-sync/config.json.

Options:
  --to <ref>        upstream ref to sync to (default: config target)
  --baseline <ref>  override the recorded baseline
  --apply           create the sync branch and apply the delta
  --check           run the configured checks against the current tree
  --branch <name>   branch to create with --apply (default: derived)
  --no-align-version  skip the release version alignment after applying
  --no-fetch        do not fetch the upstream remote first
  --allow-dirty     apply on a tree with uncommitted changes (not recommended)
  --pnpm <command>  pnpm executable for checks and the version bump
  --json <path>     write the machine-readable report to this path
  --help            print this text

Exit codes: 0 clean or nothing to do, 2 applied with conflicts,
3 applied but a check failed, 1 error.`

const ALWAYS_EXCLUDED = ['**/lib/**', '**/dist/**', '**/node_modules/**']

/**
 * Run one command in the repository, capturing both streams.
 * @param command Executable name.
 * @param args Argument vector, passed without a shell.
 * @param options.cwd Working directory; defaults to the repository root.
 * @param options.allowFailure Return the result instead of throwing on a non-zero exit.
 * @returns Exit status, stdout, and stderr.
 */
function run(command, args, { cwd = root(), allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stderr || result.stdout}`)
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Repository root, resolved once from git. */
let rootCache
function root() {
  if (rootCache === undefined) {
    rootCache = run('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd() }).stdout.trim()
  }
  return rootCache
}

/**
 * Translate one glob into a regular expression over repository-relative POSIX paths.
 * Supports `**` (any depth), `*` (within one segment), and `?`.
 * @param pattern Glob pattern using `/` separators.
 * @returns A matcher for normalized repository-relative paths.
 */
function globMatcher(pattern) {
  let out = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '*') {
      const doubled = pattern[i + 1] === '*'
      if (doubled) {
        const slash = pattern[i + 2] === '/'
        out += slash ? '(?:.*/)?' : '.*'
        i += slash ? 2 : 1
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

/**
 * Normalize a repository-relative path to `/` separators.
 * @param path Platform path.
 * @returns The same path with `/` separators.
 */
function toPosix(path) {
  return sep === '/' ? path : path.split(sep).join('/')
}

/**
 * Read `name` from a repository-relative manifest at one upstream revision.
 * @param target Upstream revision.
 * @param path Repository-relative manifest path.
 * @returns The declared package name, or undefined when unreadable.
 */
function packageNameAt(target, path) {
  const result = run('git', ['show', `${target}:${path}`], { allowFailure: true })
  if (result.status !== 0) return undefined
  try {
    return JSON.parse(result.stdout).name
  } catch {
    return undefined
  }
}

/**
 * The version this fork advertises after syncing to `target`: the `dsh-v*` tag
 * naming the target when one exists, otherwise the target's root manifest.
 * @param target Upstream revision that was resolved.
 * @param targetRef The ref the caller asked for.
 * @returns A semver string, or undefined when neither source declares one.
 */
function targetVersion(target, targetRef) {
  const tagged = run('git', ['tag', '--points-at', target, '--list', 'dsh-v*'], { allowFailure: true })
  const tag = tagged.stdout.split('\n').map(line => line.trim()).filter(Boolean)[0]
    ?? (/^dsh-v\d/.test(targetRef) ? targetRef : '')
  if (tag !== '') return tag.replace(/^dsh-v/, '')
  const manifest = run('git', ['show', `${target}:package.json`], { allowFailure: true })
  if (manifest.status !== 0) return undefined
  try {
    return JSON.parse(manifest.stdout).version
  } catch {
    return undefined
  }
}

/**
 * Run the configured checks sequentially.
 * @param checks Shell-free command strings, split on spaces.
 * @param pnpm pnpm executable used when a check starts with `pnpm`.
 * @returns One result per check, with the tail of its output.
 */
function runChecks(checks, pnpm) {
  return checks.map(command => {
    const parts = command.split(' ').filter(Boolean)
    const argv = parts[0] === 'pnpm' ? [pnpm, ...parts.slice(1)] : parts
    const result = run(argv[0], argv.slice(1), { allowFailure: true })
    return {
      command,
      status: result.status === 0 ? 'passed' : 'failed',
      output: `${result.stdout}${result.stderr}`.split('\n').slice(-40).join('\n'),
    }
  })
}

/**
 * Collect the upstream commits and files the allowlist selects.
 * @param inputs Resolved revisions, config, and normalized matchers.
 * @returns The selected paths, excluded paths, and commit subjects.
 */
function selectDelta({ baseline, target, include, excludeMatchers }) {
  const listed = run('git', ['diff', '--name-only', `${baseline}..${target}`, '--', ...include]).stdout
  const changed = listed.split('\n').map(line => line.trim()).filter(Boolean).map(toPosix)
  const files = []
  const excluded = []
  for (const path of changed) {
    if (excludeMatchers.some(match => match.test(path))) excluded.push(path)
    else files.push(path)
  }
  const log = run('git', ['log', '--no-merges', '--format=%h %s', `${baseline}..${target}`, '--', ...include]).stdout
  const commits = log.split('\n').map(line => line.trim()).filter(Boolean)
  return { files, excluded, commits }
}

/**
 * Report the delta, optionally prepare a branch, and write the patch.
 * @returns The process exit code.
 */
function main() {
  const { values } = parseArgs({
    options: {
      to: { type: 'string' },
      baseline: { type: 'string' },
      branch: { type: 'string' },
      json: { type: 'string' },
      pnpm: { type: 'string' },
      apply: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      'align-version': { type: 'boolean', default: true },
      'no-fetch': { type: 'boolean', default: false },
      'allow-dirty': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowNegative: true,
  })
  if (values.help === true) {
    console.log(USAGE)
    return 0
  }

  const configPath = join(root(), 'scripts/upstream-sync/config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const pnpm = values.pnpm ?? 'pnpm'
  const include = config.include ?? []
  const excludeMatchers = [...(config.exclude ?? []), ...ALWAYS_EXCLUDED].map(globMatcher)
  const report = { generatedAt: new Date().toISOString(), remote: config.remote, target: {}, files: {}, commits: [], conflicts: [], newPackages: [], checks: [], applied: false }

  const baseline = values.baseline ?? config.baseline
  const targetRef = values.to ?? config.target
  if (values['no-fetch'] !== true) run('git', ['fetch', config.remote, '--tags'])
  const target = run('git', ['rev-parse', `${targetRef}^{commit}`]).stdout.trim()
  const baselineSha = run('git', ['rev-parse', `${baseline}^{commit}`]).stdout.trim()
  report.baseline = baselineSha
  report.target = { ref: targetRef, sha: target, version: targetVersion(target, targetRef) }

  if (values.check === true) {
    report.checks = runChecks(config.checks ?? [], pnpm)
    writeReport(report, values.json)
    for (const check of report.checks) console.log(`check ${check.status}: ${check.command}`)
    return report.checks.every(check => check.status === 'passed') ? 0 : 3
  }

  if (baselineSha === target) {
    report.upToDate = true
    writeReport(report, values.json)
    console.log(`upstream sync: up to date at ${target.slice(0, 10)}`)
    return 0
  }

  const { files, excluded, commits } = selectDelta({ baseline: baselineSha, target, include, excludeMatchers })
  report.files = { total: files.length, excluded: excluded.length, added: [], modified: [], deleted: [] }
  report.commits = commits
  report.excluded = excluded

  const nameStatus = run('git', ['diff', '--name-status', `${baselineSha}..${target}`, '--', ...files]).stdout
  for (const line of nameStatus.split('\n').filter(Boolean)) {
    const [status, ...rest] = line.split('\t')
    const path = toPosix(rest[rest.length - 1])
    if (status === 'A') report.files.added.push(path)
    else if (status === 'D') report.files.deleted.push(path)
    else report.files.modified.push(path)
  }
  report.newPackages = report.files.added
    .filter(path => /(^|\/)package\.json$/.test(path))
    .map(path => ({ path, name: packageNameAt(target, path) }))
    .filter(entry => entry.name !== undefined)

  if (files.length === 0) {
    report.upToDate = true
    writeReport(report, values.json)
    console.log(`upstream sync: no in-scope changes between ${baselineSha.slice(0, 10)} and ${target.slice(0, 10)}`)
    return 0
  }

  const artifactDir = join(root(), '.artifacts/upstream-sync')
  mkdirSync(artifactDir, { recursive: true })
  const patchPath = join(artifactDir, `${baselineSha.slice(0, 10)}-${target.slice(0, 10)}.patch`)
  const patch = run('git', ['diff', '--binary', `${baselineSha}..${target}`, '--', ...files]).stdout
  writeFileSync(patchPath, patch)
  report.patch = relative(root(), patchPath)

  console.log(`upstream sync: ${baselineSha.slice(0, 10)} -> ${target.slice(0, 10)} (${targetRef})`)
  console.log(`  commits in scope: ${commits.length}`)
  console.log(`  files: ${report.files.added.length} added, ${report.files.modified.length} modified, ${report.files.deleted.length} deleted, ${excluded.length} excluded`)
  console.log(`  patch: ${report.patch}`)
  for (const entry of report.newPackages) console.log(`  new package: ${entry.name} (${entry.path})`)

  if (values.apply !== true) {
    writeReport(report, values.json)
    console.log('plan only: pass --apply to prepare the sync branch')
    return 0
  }

  if (values['allow-dirty'] !== true) {
    const dirty = run('git', ['status', '--porcelain']).stdout.trim()
    if (dirty !== '') throw new Error(`working tree is not clean:\n${dirty}`)
  }

  const branch = values.branch ?? `upstream-sync/${target.slice(0, 10)}`
  run('git', ['switch', '-C', branch])
  const applied = run('git', ['apply', '--3way', '--index', '--whitespace=nowarn', patchPath], { allowFailure: true })
  const conflicts = run('git', ['diff', '--name-only', '--diff-filter=U'], { allowFailure: true }).stdout
    .split('\n').map(line => line.trim()).filter(Boolean).map(toPosix)
  report.applied = true
  report.branch = branch
  report.conflicts = conflicts
  if (applied.status !== 0 && conflicts.length === 0) {
    throw new Error(`git apply failed without conflicts:\n${applied.stdout}${applied.stderr}`)
  }

  config.baseline = target
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  console.log(`  branch: ${branch}`)
  console.log(`  conflicts: ${conflicts.length === 0 ? 'none' : conflicts.join(', ')}`)

  const alreadyAligned = run('git', ['show', 'HEAD:package.json'], { allowFailure: true }).stdout
  const currentVersion = (() => {
    try {
      return JSON.parse(alreadyAligned).version
    } catch {
      return undefined
    }
  })()
  const version = report.target.version
  if (values['align-version'] !== false && version !== undefined && version !== currentVersion) {
    const bump = run(pnpm, ['run', 'release:dsh', '--', version], { allowFailure: true })
    report.versionAlignment = { version, status: bump.status === 0 ? 'aligned' : 'failed', output: `${bump.stdout}${bump.stderr}`.slice(-2000) }
    console.log(`  version alignment -> ${version}: ${report.versionAlignment.status}`)
    if (bump.status !== 0) console.log(report.versionAlignment.output)
  }

  writeReport(report, values.json)
  return conflicts.length === 0 ? 0 : 2
}

/**
 * Write the machine-readable report when a path was requested.
 * @param report Report object.
 * @param path Destination path, or undefined to skip.
 */
function writeReport(report, path) {
  if (path === undefined) return
  const destination = resolve(root(), path)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(`upstream sync: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
} else if (!existsSync(join(root(), 'scripts/upstream-sync/config.json'))) {
  throw new Error('scripts/upstream-sync/config.json is missing')
}
