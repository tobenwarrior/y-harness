/** Public display labels never rename native executables, bundles, or stored data. */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'

const { displayName } = vi.hoisted(() => ({ displayName: vi.fn<() => string | undefined>(() => undefined) }))
vi.mock('../../../scripts/app-branding.mjs', () => ({ readAppDisplayName: displayName }))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original, execFileSync: vi.fn((command: string, args: string[]) => {
    if (command === '/usr/bin/ditto') cpSync(args[0]!, args[1]!, { recursive: true })
    else if (command === '/usr/bin/plutil') {
      const path = args[4]!
      const plist = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      plist[args[1]!] = JSON.parse(args[3]!)
      writeFileSync(path, JSON.stringify(plist))
    } else if (command !== '/usr/bin/codesign'
      && !command.endsWith('/LaunchServices.framework/Support/lsregister')) {
      throw new Error(`Unexpected native command: ${command}`)
    }
    return Buffer.alloc(0)
  }) }
})

import { prepareDevelopmentApp } from '../scripts/development-app.ts'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'

afterEach(() => { displayName.mockReturnValue(undefined) })

it('refreshes only the development bundle display label when the configuration changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-display-name-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const source = join(root, 'Electron.app', 'Contents')
  mkdirSync(join(source, 'MacOS'), { recursive: true })
  mkdirSync(join(source, 'Resources'), { recursive: true })
  writeFileSync(join(source, 'Info.plist'), '{}')
  const electron = join(source, 'MacOS', 'Electron')
  writeFileSync(electron, '')
  const options = { electron, appRoot: '/workspace/y-harness', directory: join(root, 'development'),
    home: '/state/harness', userData: '/state/electron', mainPort: 9229, rendererPort: 9222,
    hostPort: 9230, openDevtools: '0' }
  const executable = prepareDevelopmentApp(options)
  const bundle = join(options.directory, 'Y harness.app', 'Contents')
  const original = JSON.parse(readFileSync(join(bundle, 'Info.plist'), 'utf8')) as Record<string, unknown>
  const launcher = readFileSync(executable, 'utf8')
  expect(executable).toBe(join(bundle, 'MacOS', 'YHarness'))
  expect(original).toMatchObject({ CFBundleIdentifier: 'com.deepseek.harness.dev.5b4a44c1d7c6',
    CFBundleName: 'Y harness', CFBundleDisplayName: 'Y harness',
    CFBundleExecutable: 'YHarness', CFBundleURLTypes: [{ CFBundleURLName: 'Y harness',
      CFBundleURLSchemes: ['dsh'], CFBundleTypeRole: 'Viewer' }] })
  expect(launcher).toContain("export DSH_HOME='/state/harness'")
  expect(launcher).toContain("'--user-data-dir=/state/electron'")

  displayName.mockReturnValue('Atlas')
  expect(prepareDevelopmentApp(options)).toBe(executable)
  const branded = JSON.parse(readFileSync(join(bundle, 'Info.plist'), 'utf8')) as Record<string, unknown>
  expect(branded).toEqual({ ...original, CFBundleDisplayName: 'Atlas' })
  expect(readFileSync(executable, 'utf8')).toBe(launcher)
  expect(JSON.parse(readFileSync(join(bundle, 'Resources', 'dsh-development.json'), 'utf8')))
    .toMatchObject({ displayName: 'Atlas' })
  displayName.mockReturnValue(undefined)
  expect(prepareDevelopmentApp(options)).toBe(executable)
  expect(JSON.parse(readFileSync(join(bundle, 'Info.plist'), 'utf8'))).toEqual(original)
  expect(readFileSync(executable, 'utf8')).toBe(launcher)
})

it('adds a release display label without changing product filenames or identity metadata', () => {
  const environment = { DSH_DESKTOP_APP_ID: 'com.example.desktop',
    DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
    DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
    DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
    DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234', APPLE_KEYCHAIN_PROFILE: 'display-name-test',
    DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com',
    DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef' }
  const original = createElectronBuilderConfig(environment, 'darwin', 'arm64')
  expect(original.mac.extendInfo).not.toHaveProperty('CFBundleDisplayName')
  displayName.mockReturnValue('Atlas')
  const branded = createElectronBuilderConfig(environment, 'darwin', 'arm64')
  expect(branded.mac.extendInfo).toEqual({ ...original.mac.extendInfo, CFBundleDisplayName: 'Atlas' })
  expect(branded.productName).toBe('Y harness')
  expect(branded.appId).toBe('com.example.desktop')
  expect(branded.protocols).toEqual([{ name: 'Y harness', schemes: ['dsh'] }])
  expect(branded.artifactName).toBe(original.artifactName)
  expect(branded.directories).toEqual(original.directories)
  expect(branded.extraMetadata).toEqual(original.extraMetadata)
  expect(branded.files).toEqual(original.files)
  expect(branded.mac.identity).toBe(original.mac.identity)
  expect(branded.mac.forceCodeSigning).toBe(original.mac.forceCodeSigning)
  expect(branded.mac.hardenedRuntime).toBe(original.mac.hardenedRuntime)
  expect(branded.mac.entitlements).toBe(original.mac.entitlements)
  expect(branded.mac.entitlementsInherit).toBe(original.mac.entitlementsInherit)
  expect(branded.mac.notarize).toBe(original.mac.notarize)
  expect(branded.win).toEqual(original.win)
  expect(branded.publish).toEqual(original.publish)
})
