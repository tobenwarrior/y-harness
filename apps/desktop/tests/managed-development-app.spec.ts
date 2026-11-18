/** Managed carrier migration through staging, activation, and successive source checkouts. */
import { execFileSync } from 'node:child_process'
import {
  cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { developmentLauncher, type DevelopmentAppOptions } from '../scripts/development-app.ts'
import { captureManagedMacCarrier, prepareManagedDevelopmentApp } from '../scripts/managed-development-app.ts'

const ORIGINAL = 'a'.repeat(40)
const UPDATED = 'b'.repeat(40)
const NEXT = 'c'.repeat(40)
const LEGACY_ID = 'com.yharness.desktop.dev.1234567890ab'
const LEGACY_CODE = '1'.repeat(40)
const NEW_CODE = '2'.repeat(40)
const STAMP = 'Contents/signature-fixture.json'
const EXECUTABLE = 'Contents/MacOS/Electron'
const LAUNCHER = 'Contents/MacOS/YHarness'
const RECORD = 'mac-carrier.json'

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, { mode: 0o600 })
}

function writeCarrier(bundle: string, bundleIdentifier: string, cdHash: string): void {
  write(join(bundle, STAMP), JSON.stringify({ bundleIdentifier, cdHash }))
  write(join(bundle, EXECUTABLE), 'fixture carrier')
}

function installation() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'yh-mac-carrier-')))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const managed = join(root, 'managed')
  mkdirSync(managed, { mode: 0o700 })
  write(join(managed, '.updater-owner'), 'github-source-updater-v1\n')
  const current = join(managed, 'current')
  const status = join(managed, 'update-status.json')
  const record = join(managed, RECORD)
  const inspect = vi.fn((bundle: string) =>
    JSON.parse(readFileSync(join(bundle, STAMP), 'utf8')) as { bundleIdentifier: string; cdHash: string })
  const copy = vi.fn((source: string, target: string) => {
    cpSync(source, target, { recursive: true, errorOnExist: true })
  })
  const prepare = vi.fn(async (options: DevelopmentAppOptions) => {
    const { directory, bundleIdentifier } = options
    if (bundleIdentifier === undefined) throw new Error('Expected a managed identity')
    const bundle = join(directory, 'Y harness.app')
    writeCarrier(bundle, bundleIdentifier, NEW_CODE)
    write(join(bundle, LAUNCHER), developmentLauncher(options, bundle))
    return join(bundle, 'Contents/MacOS/YHarness')
  })
  const operations = { inspect, copy, prepare }
  function version(ref: string, electron = '44.0.0', binary = 'arm64 Electron') {
    const checkout = join(managed, ref)
    const appRoot = join(checkout, 'apps/desktop')
    const native = join(appRoot, 'node_modules/electron/dist/Electron.app', EXECUTABLE)
    const build = join(appRoot, '.desktop-build')
    const directory = join(build, 'development')
    const bundle = join(directory, 'Y harness.app')
    write(join(appRoot, 'node_modules/electron/package.json'), JSON.stringify({ version: electron }))
    write(native, binary)
    mkdirSync(build)
    const options = {
      electron: native, appRoot, directory, home: join(root, 'data/home'), userData: join(root, 'data/electron-user-data'),
      primaryRuntime: join(build, 'runtime'), mainPort: 9229, rendererPort: 9222, hostPort: 9230,
      openDevtools: '0', disableInspectors: true, managed: true,
    }
    return { options, bundle, checkout, build, executable: join(bundle, EXECUTABLE) }
  }
  const activate = (commit: string) => {
    rmSync(current, { force: true })
    symlinkSync(`versions/${commit}`, current)
  }
  const prepareVersion = (target: ReturnType<typeof version>, commit: string) =>
    prepareManagedDevelopmentApp(target.options, status, commit, operations)
  const readRecord = () => JSON.parse(readFileSync(record, 'utf8')) as {
    readonly commit: string
    readonly bundleIdentifier: string
    readonly cdHash: string
  }
  return { managed, record, inspect, copy, prepare, version, activate, prepareVersion, readRecord }
}

describe.skipIf(process.platform === 'win32')('GitHub-managed Mac carrier', () => {
  it('captures the legacy carrier before activation and reuses its signed contents through two source updates', async () => {
    const h = installation()
    const original = h.version(`versions/${ORIGINAL}`)
    writeCarrier(original.bundle, LEGACY_ID, LEGACY_CODE)
    write(join(original.bundle, LAUNCHER), developmentLauncher(original.options, original.bundle))
    const staging = h.version(`staging/${'d'.repeat(32)}`)
    h.activate(ORIGINAL)
    captureManagedMacCarrier(staging.options.appRoot, h.managed, h.inspect)
    expect(() => readFileSync(h.record)).toThrow(/ENOENT/)
    expect(lstatSync(join(staging.build, RECORD)).mode & 0o777).toBe(0o600)

    renameSync(staging.checkout, join(h.managed, 'versions', UPDATED))
    h.activate(UPDATED)
    const updated = {
      options: {
        ...staging.options,
        appRoot: join(h.managed, 'versions', UPDATED, 'apps/desktop'),
        directory: join(h.managed, 'versions', UPDATED, 'apps/desktop/.desktop-build/development'),
      },
    }
    const executable = await prepareManagedDevelopmentApp(updated.options, join(h.managed, 'update-status.json'), UPDATED,
      { inspect: h.inspect, copy: h.copy, prepare: h.prepare })
    expect(executable).toBe(join(updated.options.directory, 'Y harness.app', EXECUTABLE))
    expect(readFileSync(executable)).toEqual(readFileSync(original.executable))
    expect(lstatSync(executable).ino).not.toBe(lstatSync(original.executable).ino)
    expect(h.readRecord()).toMatchObject({ commit: ORIGINAL, bundleIdentifier: LEGACY_ID, cdHash: LEGACY_CODE })

    const next = h.version(`versions/${NEXT}`)
    h.activate(NEXT)
    await expect(h.prepareVersion(next, NEXT)).resolves.toBe(next.executable)
    expect(h.copy).toHaveBeenLastCalledWith(original.bundle, expect.stringContaining('.mac-carrier-'))
    expect(h.prepare).not.toHaveBeenCalled()
    expect(h.readRecord().commit).toBe(ORIGINAL)
    expect(lstatSync(h.record).mode & 0o777).toBe(0o600)
  })

  it('replaces an old signed launcher that cold-starts an embedded checkout', async () => {
    const h = installation()
    const originalId = 'com.deepseek.harness.dev.1234567890ab'
    const original = h.version(`versions/${ORIGINAL}`)
    writeCarrier(original.bundle, originalId, LEGACY_CODE)
    const oldLauncher = ['#!/bin/sh', 'unset DSH_DESKTOP_HOST_INSPECT_PORT',
      'export DSH_DESKTOP_OPEN_DEVTOOLS=0', "export DSH_DESKTOP_DEV_APP='0'",
      `cd '${original.options.appRoot}'`,
      `exec '${original.executable}' '--user-data-dir=${original.options.userData}' '${original.options.appRoot}' "$@"`, ''].join('\n')
    write(join(original.bundle, LAUNCHER), oldLauncher)
    const staging = h.version(`staging/${'d'.repeat(32)}`)
    h.activate(ORIGINAL)
    captureManagedMacCarrier(staging.options.appRoot, h.managed, h.inspect)
    const updated = h.version(`versions/${UPDATED}`)
    renameSync(join(staging.build, RECORD), join(updated.build, RECORD))
    h.activate(UPDATED)

    await expect(h.prepareVersion(updated, UPDATED)).resolves.toBe(updated.executable)
    expect(h.copy).not.toHaveBeenCalled()
    expect(h.prepare).toHaveBeenCalledWith(expect.objectContaining({ bundleIdentifier: originalId }))
    const replacement = readFileSync(join(updated.bundle, LAUNCHER), 'utf8')
    const probe = join(h.managed, 'cold-launch')
    const open = join(h.managed, 'record-open')
    writeFileSync(open, '#!/bin/sh\nprintf "%s\\n" "$DSH_HOME" "$@"\n', { mode: 0o700 })
    write(probe, replacement.replace("'/usr/bin/open'", `'${open}'`))
    const home = join(h.managed, "Cold home ' $(false)")
    const state = 'inherited state'
    expect(execFileSync('/bin/sh', [probe], { env: { HOME: home, DSH_HOME: state }, encoding: 'utf8' }))
      .toBe(`${state}\n${home}/Applications/Y Harness GitHub.app\n`)
    expect(readFileSync(join(original.bundle, LAUNCHER), 'utf8')).toBe(oldLauncher)
    expect(h.readRecord()).toMatchObject({ commit: UPDATED, bundleIdentifier: originalId, cdHash: NEW_CODE })
  })

  it('uses a different stable identity for each fresh managed installation', async () => {
    const first = installation()
    const second = installation()
    const one = first.version(`versions/${ORIGINAL}`)
    const two = second.version(`versions/${ORIGINAL}`)
    first.activate(ORIGINAL)
    second.activate(ORIGINAL)
    await expect(first.prepareVersion(one, ORIGINAL)).resolves.toBe(one.executable)
    await expect(second.prepareVersion(two, ORIGINAL)).resolves.toBe(two.executable)
    const identity = first.readRecord().bundleIdentifier
    expect(identity).toMatch(/^com\.yharness\.desktop\.managed\./u)
    expect(second.readRecord().bundleIdentifier).not.toBe(identity)
    await expect(first.prepareVersion(one, ORIGINAL)).resolves.toBe(one.executable)
    expect(first.prepare).toHaveBeenCalledTimes(1)
    expect(first.readRecord().bundleIdentifier).toBe(identity)
  })

  it.each([{ version: '45.0.0', binary: 'arm64 Electron' }, { version: '44.0.0', binary: 'x64 Electron' }])(
    'prepares an incompatible Electron carrier for $version $binary under the existing bundle ID',
    async ({ version, binary }) => {
      const h = installation()
      const original = h.version(`versions/${ORIGINAL}`)
      h.activate(ORIGINAL)
      await h.prepareVersion(original, ORIGINAL)
      const previous = h.readRecord()
      const updated = h.version(`versions/${UPDATED}`, version, binary)
      h.activate(UPDATED)
      await expect(h.prepareVersion(updated, UPDATED)).resolves.toBe(updated.executable)
      expect(h.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ bundleIdentifier: previous.bundleIdentifier }))
      expect(h.readRecord()).toMatchObject({ commit: UPDATED, bundleIdentifier: previous.bundleIdentifier })
      expect(h.copy).not.toHaveBeenCalled()
    },
  )

  it('does not publish a changed copy or replace the private record if a compatible copy fails verification', async () => {
    const h = installation()
    const original = h.version(`versions/${ORIGINAL}`)
    const updated = h.version(`versions/${UPDATED}`)
    h.activate(ORIGINAL)
    await h.prepareVersion(original, ORIGINAL)
    const record = readFileSync(h.record)
    h.activate(UPDATED)
    h.copy.mockImplementationOnce((_, destination) => {
      writeCarrier(destination, h.readRecord().bundleIdentifier, '9'.repeat(40))
    })

    await expect(h.prepareVersion(updated, UPDATED)).rejects.toThrow('signed carrier changed')
    expect(readFileSync(h.record)).toEqual(record)
    expect(readdirSync(updated.options.directory)).toEqual([])
    expect(readFileSync(original.executable, 'utf8')).toBe('fixture carrier')
  })

  it('leaves non-managed staging and the installed record outside migration capture', async () => {
    const h = installation()
    const original = h.version(`versions/${ORIGINAL}`)
    const preview = h.version('preview/runtime')
    h.activate(ORIGINAL)
    captureManagedMacCarrier(preview.options.appRoot, h.managed, h.inspect)
    expect(h.inspect).not.toHaveBeenCalled()
    expect(() => readFileSync(join(preview.build, RECORD))).toThrow(/ENOENT/)

    await h.prepareVersion(original, ORIGINAL)
    h.inspect.mockClear()
    const next = h.version(`staging/${'d'.repeat(32)}`)
    captureManagedMacCarrier(next.options.appRoot, h.managed, h.inspect)
    expect(h.inspect).not.toHaveBeenCalled()
    expect(() => readFileSync(join(next.build, RECORD))).toThrow(/ENOENT/)
  })
})
