/** Cold-start launcher preserves workspace paths without evaluating shell syntax. */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { developmentLauncher } from '../scripts/development-app.ts'

const portVariables = [
  'DSH_DESKTOP_MAIN_INSPECT_PORT',
  'DSH_DESKTOP_RENDERER_DEBUG_PORT',
  'DSH_DESKTOP_HOST_INSPECT_PORT',
] as const

function launcherFixture(openDevtools = '1') {
  const root = mkdtempSync(join(tmpdir(), 'dsh-development-app-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const bundle = join(root, "Harness ' $(false).app")
  const binary = join(bundle, 'Contents', 'MacOS', 'Electron')
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$DSH_HOME" "$DSH_DESKTOP_DEV_APP" "$DSH_DESKTOP_OPEN_DEVTOOLS" "$DSH_DESKTOP_HOST_INSPECT_PORT" "$@"\n', { mode: 0o755 })
  const launcher = join(root, 'launcher')
  const home = join(root, "home ' $(false)")
  const userData = join(root, 'browser data')
  writeFileSync(launcher, developmentLauncher({ electron: binary, appRoot: root, directory: root,
    home, userData, mainPort: 9229, rendererPort: 9222, hostPort: 9230, openDevtools }, bundle))
  const environment = { ...process.env }
  delete environment.DSH_DESKTOP_MAIN_INSPECT_PORT
  delete environment.DSH_DESKTOP_RENDERER_DEBUG_PORT
  delete environment.DSH_DESKTOP_HOST_INSPECT_PORT
  delete environment.DSH_DESKTOP_OPEN_DEVTOOLS
  delete environment.DSH_DESKTOP_USER_DATA_DIR
  return { launcher, home, userData, root, environment, binary, bundle }
}

describe.skipIf(process.platform === 'win32')('development bundle executable', () => {
  it('passes literal workspace paths and cold-start settings to Electron', () => {
    const fixture = launcherFixture('0')
    const result = execFileSync('/bin/sh', [fixture.launcher, '--test-launch-argument'],
      { encoding: 'utf8', env: fixture.environment })
    expect(result.trimEnd().split('\n')).toEqual([fixture.home, '1', '0', '9230', '--inspect=127.0.0.1:9229',
      '--remote-debugging-port=9222', `--user-data-dir=${fixture.userData}`, fixture.root, '--test-launch-argument'])
  })

  it('uses caller-selected inspector ports and keeps inherited DevTools closed', () => {
    const fixture = launcherFixture()
    const result = execFileSync('/bin/sh', [fixture.launcher, '--test-launch-argument'], {
      encoding: 'utf8',
      env: { ...fixture.environment, DSH_DESKTOP_MAIN_INSPECT_PORT: '19329',
        DSH_DESKTOP_RENDERER_DEBUG_PORT: '19322', DSH_DESKTOP_HOST_INSPECT_PORT: '19330',
        DSH_DESKTOP_OPEN_DEVTOOLS: '0' },
    })
    expect(result.trimEnd().split('\n')).toEqual([fixture.home, '1', '0', '19330', '--inspect=127.0.0.1:19329',
      '--remote-debugging-port=19322', `--user-data-dir=${fixture.userData}`, fixture.root, '--test-launch-argument'])
  })

  it.skipIf(process.platform !== 'darwin')('normalizes Number port syntax before invoking the generated bundle', () => {
    const fixture = launcherFixture()
    const appRoot = join(fixture.root, 'apps', 'desktop')
    const script = join(appRoot, 'scripts', 'dev.ts')
    const output = join(fixture.root, 'launch-output')
    // Execute the real launcher source; replace only native bundle preparation and runtime materialization.
    const files = {
      'package.json': '{"type":"module"}',
      'apps/desktop/package.json': '{"version":"1.0.0","type":"module"}',
      'apps/desktop/lib/main.js': '',
      'apps/desktop/src/host-protocol.ts': 'export const DESKTOP_HOST_PROTOCOL_VERSION = 1\n',
      'apps/desktop-host/lib/index.js': '',
      'apps/desktop/node_modules/pnpm/package.json': '{"version":"10.0.0"}',
      'apps/desktop/node_modules/electron/package.json': '{"main":"index.cjs"}',
      'apps/desktop/node_modules/electron/index.cjs': `module.exports = ${JSON.stringify(fixture.binary)}\n`,
      'apps/desktop/scripts/dev.ts': readFileSync(new URL('../scripts/dev.ts', import.meta.url), 'utf8'),
      'apps/desktop/scripts/desktop-build-paths.mjs':
        'export const developmentRuntimeDirectory = () => "test-runtime"\nexport const resolveDesktopBuildTarget = () => "mac-arm64"\n',
      'apps/desktop/scripts/development-project.ts': 'export const prepareDevelopmentProject = () => {}\n',
      'apps/desktop/scripts/prepare-primary-runtime.ts': 'export const preparePrimaryRuntime = async () => {}\n',
      'apps/desktop/scripts/development-app.ts': [
        'import { writeFileSync } from "node:fs"',
        `import { developmentLauncher } from ${JSON.stringify(new URL('../scripts/development-app.ts', import.meta.url).href)}`,
        'export function prepareDevelopmentApp(options) {',
        `  const launcher = ${JSON.stringify(fixture.launcher)}`,
        `  writeFileSync(launcher, developmentLauncher(options, ${JSON.stringify(fixture.bundle)}), { mode: 0o755 })`,
        '  return launcher',
        '}',
        '',
      ].join('\n'),
    }
    for (const [relative, contents] of Object.entries(files)) {
      const path = join(fixture.root, relative)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, contents)
    }
    writeFileSync(fixture.binary, [
      '#!/bin/sh',
      'if [ "$ELECTRON_RUN_AS_NODE" = 1 ]; then printf "26.0.0\\n"; exit 0; fi',
      'printf "%s\\n" "$DSH_DESKTOP_OPEN_DEVTOOLS" "$DSH_DESKTOP_HOST_INSPECT_PORT" "$@" > "$DSH_LAUNCHER_TEST_OUTPUT"',
      '',
    ].join('\n'), { mode: 0o755 })
    rmSync(fixture.launcher)
    const result = spawnSync(process.execPath, [script, '--skip-build'], {
      encoding: 'utf8',
      env: { ...fixture.environment, ELECTRON_RUN_AS_NODE: '', DSH_LAUNCHER_TEST_OUTPUT: output, DSH_HOME: fixture.home,
        DSH_DESKTOP_PRIMARY_RUNTIME_DIR: 'test-runtime',
        DSH_DESKTOP_MAIN_INSPECT_PORT: ' 19329 ', DSH_DESKTOP_RENDERER_DEBUG_PORT: '0x4b7a',
        DSH_DESKTOP_HOST_INSPECT_PORT: '1.9330e4', DSH_DESKTOP_OPEN_DEVTOOLS: '0' },
    })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const resolvedAppRoot = realpathSync(appRoot)
    expect(readFileSync(output, 'utf8').trimEnd().split('\n')).toEqual(['0', '19330',
      '--inspect=127.0.0.1:19329', '--remote-debugging-port=19322',
      `--user-data-dir=${join(resolvedAppRoot, '.desktop-build', 'development', 'electron-user-data')}`, resolvedAppRoot])
  })

  it('uses captured ports for empty overrides and preserves an empty DevTools override', () => {
    const fixture = launcherFixture()
    const result = execFileSync('/bin/sh', [fixture.launcher], {
      encoding: 'utf8',
      env: { ...fixture.environment, DSH_DESKTOP_MAIN_INSPECT_PORT: '', DSH_DESKTOP_RENDERER_DEBUG_PORT: '',
        DSH_DESKTOP_HOST_INSPECT_PORT: '', DSH_DESKTOP_OPEN_DEVTOOLS: '' },
    })
    expect(result.trimEnd().split('\n')).toEqual([fixture.home, '1', '', '9230', '--inspect=127.0.0.1:9229',
      '--remote-debugging-port=9222', `--user-data-dir=${fixture.userData}`, fixture.root])
  })

  it.each(['1', '65535', '00019329'])('passes normalized decimal override %s to all inspectors', (value) => {
    const fixture = launcherFixture()
    const result = execFileSync('/bin/sh', [fixture.launcher], {
      encoding: 'utf8',
      env: { ...fixture.environment, DSH_DESKTOP_MAIN_INSPECT_PORT: value,
        DSH_DESKTOP_RENDERER_DEBUG_PORT: value, DSH_DESKTOP_HOST_INSPECT_PORT: value },
    })
    const expected = value === '00019329' ? '19329' : value
    expect(result.trimEnd().split('\n')).toEqual([fixture.home, '1', '1', expected,
      `--inspect=127.0.0.1:${expected}`, `--remote-debugging-port=${expected}`,
      `--user-data-dir=${fixture.userData}`, fixture.root])
  })

  for (const name of portVariables) {
    it.each(['0', '0000', '-1', '65536', '999999999999999999999999999', '1.5', 'not-a-port', ' 19329 ', '$(false)'])(
      `rejects invalid ${name}=%s before executing Electron`, (value) => {
        const fixture = launcherFixture()
        const result = spawnSync('/bin/sh', [fixture.launcher], {
          encoding: 'utf8', env: { ...fixture.environment, [name]: value },
        })
        expect(result.status).toBe(1)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain(`${name} must be a decimal integer from 1 through 65535`)
      },
    )
  }
})
