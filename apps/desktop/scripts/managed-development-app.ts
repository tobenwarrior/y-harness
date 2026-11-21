/** Keep the GitHub-managed Mac carrier's signed contents separate from its selected source version. */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync,
  realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { hasManagedLaunchHandoff, prepareDevelopmentApp, type DevelopmentAppOptions } from './development-app.ts'

const OWNER_MARKER = 'github-source-updater-v1\n'
const RECORD = 'mac-carrier.json'
const COMMIT = /^[a-f0-9]{40}$/u
const STAGING = /^[a-f0-9]{32}$/u
const IDENTIFIER = /^com\.(?:yharness\.desktop\.(?:dev|managed)|deepseek\.harness\.dev)\.[a-f0-9]{12}$/u
const ELECTRON_VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u
const CD_HASH = /^[a-f0-9]{40}$/u
const BINARY_DIGEST = /^[a-f0-9]{64}$/u
const BUNDLE = 'Y harness.app'
const BUILD = '.desktop-build'
const ELECTRON = 'Contents/MacOS/Electron'
const LAUNCHER = 'Contents/MacOS/YHarness'

interface CarrierIdentity {
  readonly bundleIdentifier: string
  readonly cdHash: string
}

interface CarrierRecord extends CarrierIdentity {
  readonly schemaVersion: 1
  readonly commit: string
  readonly electronVersion: string
  readonly electronExecutableDigest: string
}

interface CarrierOperations {
  readonly inspect: (bundle: string) => CarrierIdentity
  readonly copy: (source: string, destination: string) => void
  readonly prepare: (options: DevelopmentAppOptions) => Promise<string>
}

function inspectCarrier(bundle: string): CarrierIdentity {
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--deep', bundle], { stdio: 'pipe' })
  const executable = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', bundle], { encoding: 'utf8' })
  if (executable.error !== undefined) throw executable.error
  if (executable.status !== 0) throw new Error('managed desktop: cannot inspect the signed carrier')
  const bundleIdentifier = /^Identifier=(.+)$/mu.exec(executable.stderr)?.[1]
  const cdHash = /^CDHash=(.+)$/mu.exec(executable.stderr)?.[1]
  if (bundleIdentifier === undefined || !IDENTIFIER.test(bundleIdentifier) || cdHash === undefined || !CD_HASH.test(cdHash)) {
    throw new Error('managed desktop: invalid carrier signature')
  }
  return { bundleIdentifier, cdHash }
}

const nativeOperations: CarrierOperations = {
  inspect: inspectCarrier,
  copy: (source, destination) => { execFileSync('/usr/bin/ditto', [source, destination], { stdio: 'pipe' }) },
  prepare: prepareDevelopmentApp,
}

function verifyDirectory(path: string): void {
  if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) {
    throw new Error('managed desktop: invalid carrier directory')
  }
}

function absent(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) === undefined
}

function verifyManagedRoot(root: string): void {
  verifyDirectory(root)
  const info = lstatSync(root)
  const marker = join(root, '.updater-owner')
  if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || !lstatSync(marker).isFile()
    || readFileSync(marker, 'utf8') !== OWNER_MARKER) {
    throw new Error('managed desktop: updater directory is not private')
  }
}

function readRecord(path: string): CarrierRecord | undefined {
  if (absent(path)) return undefined
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 2048) {
      throw new Error('managed desktop: invalid carrier record file')
    }
    const data: unknown = JSON.parse(readFileSync(fd, 'utf8'))
    if (typeof data !== 'object' || data === null
      || !('schemaVersion' in data) || data.schemaVersion !== 1
      || !('commit' in data) || typeof data.commit !== 'string' || !COMMIT.test(data.commit)
      || !('electronVersion' in data) || typeof data.electronVersion !== 'string' || !ELECTRON_VERSION.test(data.electronVersion)
      || !('electronExecutableDigest' in data) || typeof data.electronExecutableDigest !== 'string'
      || !BINARY_DIGEST.test(data.electronExecutableDigest)
      || !('bundleIdentifier' in data) || typeof data.bundleIdentifier !== 'string' || !IDENTIFIER.test(data.bundleIdentifier)
      || !('cdHash' in data) || typeof data.cdHash !== 'string' || !CD_HASH.test(data.cdHash)) {
      throw new Error('managed desktop: invalid carrier record')
    }
    return {
      schemaVersion: 1, commit: data.commit, electronVersion: data.electronVersion,
      electronExecutableDigest: data.electronExecutableDigest, bundleIdentifier: data.bundleIdentifier, cdHash: data.cdHash,
    }
  } finally {
    closeSync(fd)
  }
}

function publishRecord(path: string, record: CarrierRecord): void {
  const parent = dirname(path)
  verifyDirectory(parent)
  const directory = mkdtempSync(join(parent, '.mac-carrier-'))
  try {
    const candidate = join(directory, RECORD)
    writeFileSync(candidate, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(candidate, path)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function electronBuild(appRoot: string): Pick<CarrierRecord, 'electronVersion' | 'electronExecutableDigest'> {
  const manifest: { readonly version?: string } = JSON.parse(
    readFileSync(join(appRoot, 'node_modules/electron/package.json'), 'utf8'),
  )
  if (typeof manifest.version !== 'string' || !ELECTRON_VERSION.test(manifest.version)) {
    throw new Error('managed desktop: invalid Electron version')
  }
  const binary = join(appRoot, 'node_modules/electron/dist/Electron.app', ELECTRON)
  const electronExecutableDigest = createHash('sha256').update(readFileSync(binary)).digest('hex')
  return { electronVersion: manifest.version, electronExecutableDigest }
}

function carrierLocation(managed: string, commit: string): string {
  return join(managed, 'versions', commit, 'apps/desktop', BUILD, 'development', BUNDLE)
}

function examine(bundle: string, inspect: CarrierOperations['inspect']): CarrierIdentity {
  verifyDirectory(bundle)
  const executable = join(bundle, ELECTRON)
  if (!lstatSync(executable).isFile() || realpathSync(executable) !== executable) {
    throw new Error('managed desktop: invalid carrier executable')
  }
  return inspect(bundle)
}

function checkPinnedCarrier(bundle: string, pin: CarrierRecord, inspect: CarrierOperations['inspect']): void {
  const identity = examine(bundle, inspect)
  if (identity.cdHash !== pin.cdHash || identity.bundleIdentifier !== pin.bundleIdentifier) {
    throw new Error('managed desktop: signed carrier changed')
  }
}

function copyPinnedCarrier(source: string, destination: string, pin: CarrierRecord, operations: CarrierOperations): void {
  if (!absent(destination)) {
    checkPinnedCarrier(destination, pin, operations.inspect)
    return
  }
  const parent = dirname(destination)
  verifyDirectory(dirname(parent))
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  verifyDirectory(parent)
  const staging = mkdtempSync(join(parent, '.mac-carrier-'))
  try {
    const copy = join(staging, BUNDLE)
    operations.copy(source, copy)
    checkPinnedCarrier(copy, pin, operations.inspect)
    renameSync(copy, destination)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * Snapshot the current carrier while the supervisor stages its first compatible update.
 * The supervisor installed before this change already runs primary-runtime preparation in
 * the staging checkout while its update lock holds the old current link in place.
 * @param appRoot - Desktop directory of the source build.
 * @param managed - Private source updater directory.
 * @param inspect - Verifies signed bundle bytes and returns the code identity.
 */
export function captureManagedMacCarrier(
  appRoot: string,
  managed = join(homedir(), 'Library/Application Support/Y Harness GitHub/managed'),
  inspect: CarrierOperations['inspect'] = inspectCarrier,
): void {
  const checkout = dirname(dirname(appRoot))
  if (dirname(checkout) !== join(managed, 'staging') || !STAGING.test(basename(checkout))) return
  verifyManagedRoot(managed)
  verifyDirectory(checkout)
  if (readRecord(join(managed, RECORD)) !== undefined) return
  const current = join(managed, 'current')
  if (absent(current)) return
  const previous = /^versions\/([a-f0-9]{40})$/u.exec(readlinkSync(current))?.[1]
  if (previous === undefined) throw new Error('managed desktop: invalid active version')
  const bundle = carrierLocation(managed, previous)
  if (absent(bundle)) return
  const identity = examine(bundle, inspect)
  publishRecord(join(appRoot, BUILD, RECORD), {
    schemaVersion: 1, commit: previous, ...electronBuild(join(managed, 'versions', previous, 'apps/desktop')), ...identity,
  })
}

/**
 * Return the managed Electron executable, preserving a compatible signed carrier.
 * A real copy in the active version keeps the installed supervisor's focus lookup valid.
 * Only a successfully prepared carrier is recorded; version-specific argv and env are supplied by the caller.
 * @param options - Current version's development application inputs.
 * @param status - Managed updater status path supplied by the supervisor.
 * @param commit - Exact managed checkout commit supplied by the supervisor.
 * @param operations - Signing and materialization operations.
 * @returns The Electron executable to invoke directly.
 */
export async function prepareManagedDevelopmentApp(
  options: DevelopmentAppOptions,
  status: string | undefined,
  commit: string | undefined,
  operations: CarrierOperations = nativeOperations,
): Promise<string> {
  if (status === undefined || basename(status) !== 'update-status.json' || commit === undefined || !COMMIT.test(commit)) {
    throw new Error('managed desktop: missing managed version location')
  }
  const managed = dirname(status)
  verifyManagedRoot(managed)
  if (options.appRoot !== join(managed, 'versions', commit, 'apps/desktop')
    || readlinkSync(join(managed, 'current')) !== `versions/${commit}`) {
    throw new Error('managed desktop: source does not match the active version')
  }
  verifyDirectory(options.appRoot)
  verifyDirectory(join(options.appRoot, BUILD))
  const recordPath = join(managed, RECORD)
  const installed = readRecord(recordPath)
  const previous = installed ?? readRecord(join(options.appRoot, BUILD, RECORD))
  const build = electronBuild(options.appRoot)
  const bundle = join(options.directory, BUNDLE)
  if (previous !== undefined && previous.electronVersion === build.electronVersion
    && previous.electronExecutableDigest === build.electronExecutableDigest) {
    const source = carrierLocation(managed, previous.commit)
    checkPinnedCarrier(source, previous, operations.inspect)
    if (hasManagedLaunchHandoff(readFileSync(join(source, LAUNCHER), 'utf8'))) {
      if (source !== bundle) copyPinnedCarrier(source, bundle, previous, operations)
      if (installed === undefined) publishRecord(recordPath, previous)
      return join(bundle, ELECTRON)
    }
  }
  const bundleIdentifier = previous?.bundleIdentifier
    ?? `com.yharness.desktop.managed.${createHash('sha256').update(managed).digest('hex').slice(0, 12)}`
  await operations.prepare({ ...options, bundleIdentifier })
  const identity = examine(bundle, operations.inspect)
  if (identity.bundleIdentifier !== bundleIdentifier) throw new Error('managed desktop: prepared carrier identity changed')
  publishRecord(recordPath, { schemaVersion: 1, commit, ...build, ...identity })
  return join(bundle, ELECTRON)
}
