/** macOS development bundle that loads the current workspace through Electron. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readAppDisplayName } from '../../../scripts/app-branding.mjs'

/** Workspace locations and fallback debug settings captured for Launch Services cold starts. */
export interface DevelopmentAppOptions {
  readonly electron: string
  readonly appRoot: string
  readonly directory: string
  readonly home: string
  readonly userData: string
  readonly mainPort: number
  readonly rendererPort: number
  readonly hostPort: number
  readonly openDevtools: string
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

/**
 * Prepare and register a disposable .app without changing the installed Electron package.
 * @param options - Current workspace, Electron binary, and private development locations.
 * @returns executable used by the supported desktop development launcher.
 */
export function prepareDevelopmentApp(options: DevelopmentAppOptions): string {
  const displayName = readAppDisplayName()
  const source = dirname(dirname(dirname(options.electron)))
  const bundle = join(options.directory, 'Y harness.app')
  const executable = join(bundle, 'Contents', 'MacOS', 'YHarness')
  const stamp = join(bundle, 'Contents', 'Resources', 'dsh-development.json')
  const launcher = developmentLauncher(options, bundle)
  const identity = JSON.stringify({ ...options, displayName, launcher, plist: readFileSync(join(source, 'Contents', 'Info.plist'), 'utf8') })
  if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== identity) {
    rmSync(bundle, { recursive: true, force: true })
    execFileSync('/usr/bin/ditto', [source, bundle])
    const plist = join(bundle, 'Contents', 'Info.plist')
    const values = {
      CFBundleIdentifier: `com.deepseek.harness.dev.${createHash('sha256').update(options.appRoot).digest('hex').slice(0, 12)}`,
      CFBundleName: 'Y harness',
      CFBundleDisplayName: displayName ?? 'Y harness',
      CFBundleExecutable: 'YHarness',
      CFBundleURLTypes: [{ CFBundleURLName: 'Y harness', CFBundleURLSchemes: ['dsh'], CFBundleTypeRole: 'Viewer' }],
    }
    for (const [key, value] of Object.entries(values)) {
      execFileSync('/usr/bin/plutil', ['-replace', key, '-json', JSON.stringify(value), plist])
    }
    writeFileSync(executable, launcher, { mode: 0o755 })
    writeFileSync(stamp, identity, { mode: 0o600 })
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'pipe' })
  }
  execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', bundle])
  return executable
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
    DSH_DESKTOP_DEV_APP: '1',
    ELECTRON_ENABLE_LOGGING: '1',
  }
  const args = [
    `--user-data-dir=${options.userData}`,
    options.appRoot,
  ]
  return [
    '#!/bin/sh',
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
