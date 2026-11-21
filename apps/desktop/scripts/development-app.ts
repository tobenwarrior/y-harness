/** macOS development bundle that loads the current workspace through Electron. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readAppDisplayName } from '../../../scripts/app-branding.mjs'
import { DEVELOPMENT_ICON_SOURCE, ICNS_BITMAPS, writeDevelopmentIcon } from './development-icon.ts'

/** Icon resource of the copied bundle, replaced with the release artwork. */
const ICON_FILE = 'electron.icns'

/** Workspace locations and fallback debug settings captured for Launch Services cold starts. */
export interface DevelopmentAppOptions {
  readonly electron: string
  readonly appRoot: string
  readonly directory: string
  readonly home: string
  readonly userData: string
  /** Runtime directory prepared for this app's target, persisted for cold launches. */
  readonly primaryRuntime: string
  readonly mainPort: number
  readonly rendererPort: number
  readonly hostPort: number
  readonly openDevtools: string
  readonly disableInspectors?: boolean
  readonly managed?: boolean
  /** Managed installation identity retained when preparing a new carrier. */
  readonly bundleIdentifier?: string
  /** Test seam for the managed launch handoff command. */
  readonly managedOpenCommand?: string
  /** Test seam for the managed app path used by the launch handoff. */
  readonly managedAppPath?: string
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

function reusableBundle(bundle: string, stamp: string, identity: string): boolean {
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== identity) return false
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--deep', bundle], { stdio: 'pipe' })
    return true
  } catch (error) {
    // A previously interrupted signing attempt can leave a matching stamp.
    void error
    return false
  }
}

/**
 * Prepare and register a disposable .app without changing the installed Electron package.
 * The copy carries the release application icon, so the Dock, the application switcher,
 * and Finder show the product artwork instead of Electron's.
 * @param options - Current workspace, Electron binary, and private development locations.
 * @returns executable used by the supported desktop development launcher.
 */
export async function prepareDevelopmentApp(options: DevelopmentAppOptions): Promise<string> {
  const displayName = readAppDisplayName()
  const source = dirname(dirname(dirname(options.electron)))
  const bundle = join(options.directory, 'Y harness.app')
  const executable = join(bundle, 'Contents', 'MacOS', 'YHarness')
  const stamp = join(bundle, 'Contents', 'Resources', 'yharness-development.json')
  const launcher = developmentLauncher(options, bundle)
  const identity = JSON.stringify({ ...options, displayName, launcher,
    plist: readFileSync(join(source, 'Contents', 'Info.plist'), 'utf8'),
    icon: { artwork: createHash('sha256').update(readFileSync(DEVELOPMENT_ICON_SOURCE)).digest('hex'), bitmaps: ICNS_BITMAPS } })
  if (!reusableBundle(bundle, stamp, identity)) {
    mkdirSync(options.directory, { recursive: true })
    const work = mkdtempSync(join(options.directory, '.development-app-'))
    const prepared = join(work, 'Y harness.app')
    let backup: string | undefined
    try {
      execFileSync('/usr/bin/ditto', [source, prepared])
      const plist = join(prepared, 'Contents', 'Info.plist')
      const values = {
        CFBundleIdentifier: options.bundleIdentifier ?? `com.yharness.desktop.dev.${createHash('sha256').update(options.appRoot).digest('hex').slice(0, 12)}`,
        CFBundleName: 'Y harness',
        CFBundleDisplayName: displayName ?? 'Y Harness',
        CFBundleExecutable: 'YHarness',
        CFBundleIconFile: ICON_FILE,
        CFBundleURLTypes: options.managed === true ? [] : [{ CFBundleURLName: 'Y harness', CFBundleURLSchemes: ['dsh'], CFBundleTypeRole: 'Viewer' }],
      }
      for (const [key, value] of Object.entries(values)) {
        execFileSync('/usr/bin/plutil', ['-replace', key, '-json', JSON.stringify(value), plist])
      }
      await writeDevelopmentIcon(DEVELOPMENT_ICON_SOURCE, join(prepared, 'Contents', 'Resources', ICON_FILE))
      writeFileSync(join(prepared, 'Contents', 'MacOS', 'YHarness'), launcher, { mode: 0o755 })
      writeFileSync(join(prepared, 'Contents', 'Resources', 'yharness-development.json'), identity, { mode: 0o600 })
      execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', prepared], { stdio: 'pipe' })
      execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--deep', prepared], { stdio: 'pipe' })
      if (existsSync(bundle)) {
        const previous = join(work, 'previous.app')
        renameSync(bundle, previous)
        backup = previous
      }
      try {
        renameSync(prepared, bundle)
      } catch (error) {
        if (backup !== undefined) renameSync(backup, bundle)
        backup = undefined
        throw error
      }
      backup = undefined
    } finally {
      if (backup === undefined) rmSync(work, { recursive: true, force: true })
    }
  }
  execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', bundle])
  return executable
}

function managedLaunchHandoff(options: Pick<DevelopmentAppOptions, 'managedOpenCommand' | 'managedAppPath'>): string[] {
  return [
    'if [ "${DSH_DESKTOP_GITHUB_MANAGED-}" != "1" ]; then',
    `  ${quote(options.managedOpenCommand ?? '/usr/bin/open')} ${options.managedAppPath === undefined
      ? '"$HOME/Applications/Y Harness GitHub.app"'
      : quote(options.managedAppPath)}`,
    '  exit $?',
    'fi',
  ]
}

/**
 * Check whether Finder and Dock launches return to the installed supervisor.
 * @param launcher - Contents of the signed bundle's launcher.
 * @returns Whether it starts with the production handoff.
 */
export function hasManagedLaunchHandoff(launcher: string): boolean {
  return launcher.startsWith(['#!/bin/sh', ...managedLaunchHandoff({}), ''].join('\n'))
}

/**
 * Create the development executable used by both the CLI and Launch Services.
 * @param options - Persisted development locations and debugging settings.
 * @param bundle - Generated application bundle.
 * @returns shell program preserving literal paths and validating decimal debug port overrides.
 */
export function developmentLauncher(options: DevelopmentAppOptions, bundle: string): string {
  const environment = {
    DSH_HOME: options.home,
    DSH_DESKTOP_PRIMARY_RUNTIME_DIR: options.primaryRuntime,
    DSH_DESKTOP_DEV_APP: options.managed === true ? '0' : '1',
    ELECTRON_ENABLE_LOGGING: '1',
  }
  const args = [
    `--user-data-dir=${options.userData}`,
    options.appRoot,
  ]
  const managedHandoff = options.managed === true ? managedLaunchHandoff(options) : []
  if (options.disableInspectors === true) {
    return [
      '#!/bin/sh',
      ...managedHandoff,
      'unset DSH_DESKTOP_HOST_INSPECT_PORT',
      'export DSH_DESKTOP_OPEN_DEVTOOLS=0',
      ...Object.entries(environment).map(([key, value]) => `export ${key}=${quote(value)}`),
      `cd ${quote(options.appRoot)}`,
      `exec ${quote(join(bundle, 'Contents', 'MacOS', 'Electron'))} ${args.map(quote).join(' ')} "$@"`,
      '',
    ].join('\n')
  }
  return [
    '#!/bin/sh',
    ...managedHandoff,
    'debug_port_error() {',
    '  printf "desktop development: %s must be a decimal integer from 1 through 65535\\n" "$1" >&2',
    '  exit 1',
    '}',
    'debug_port() {',
    '  value="$2"',
    '  if [ -z "$value" ]; then printf "%s\\n" "$3"; return; fi',
    '  case "$value" in *[!0-9]*) debug_port_error "$1" ;; esac',
    '  while [ "${value#0}" != "$value" ]; do value="${value#0}"; done',
    '  case "$value" in \'\'|??????*) debug_port_error "$1" ;; esac',
    '  if [ "$value" -gt 65535 ]; then debug_port_error "$1"; fi',
    '  printf "%s\\n" "$value"',
    '}',
    `dsh_main_port=$(debug_port DSH_DESKTOP_MAIN_INSPECT_PORT "\${DSH_DESKTOP_MAIN_INSPECT_PORT-}" ${String(options.mainPort)}) || exit 1`,
    `dsh_renderer_port=$(debug_port DSH_DESKTOP_RENDERER_DEBUG_PORT "\${DSH_DESKTOP_RENDERER_DEBUG_PORT-}" ${String(options.rendererPort)}) || exit 1`,
    `DSH_DESKTOP_HOST_INSPECT_PORT=$(debug_port DSH_DESKTOP_HOST_INSPECT_PORT "\${DSH_DESKTOP_HOST_INSPECT_PORT-}" ${String(options.hostPort)}) || exit 1`,
    'export DSH_DESKTOP_HOST_INSPECT_PORT',
    `dsh_default_open_devtools=${quote(options.openDevtools)}`,
    'export DSH_DESKTOP_OPEN_DEVTOOLS="${DSH_DESKTOP_OPEN_DEVTOOLS-$dsh_default_open_devtools}"',
    ...Object.entries(environment).map(([key, value]) => `export ${key}=${quote(value)}`),
    `cd ${quote(options.appRoot)}`,
    `exec ${quote(join(bundle, 'Contents', 'MacOS', 'Electron'))} "--inspect=127.0.0.1:$dsh_main_port" "--remote-debugging-port=$dsh_renderer_port" ${args.map(quote).join(' ')} "$@"`,
    '',
  ].join('\n')
}
