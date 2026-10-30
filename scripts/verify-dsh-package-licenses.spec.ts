import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectDshPackageLicenses } from './verify-dsh-package-licenses.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeManifest(root: string, file: string, manifest: Record<string, unknown>): void {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

function createWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-package-licenses-'))
  roots.push(root)
  writeManifest(root, 'package.json', {
    name: '@yharness/root',
    license: 'MIT',
    workspaces: ['apps/*', 'packages/*/*', 'vendor/*', 'native/system', 'native/system/packages/*'],
  })
  return root
}

describe('Y Harness package license gate', () => {
  it('checks first-party packages while ignoring vendored and native packages', () => {
    const root = createWorkspace()
    writeManifest(root, 'apps/cli/package.json', { name: '@yharness/cli', license: 'MIT' })
    writeManifest(root, 'packages/core/agent/package.json', {
      name: '@yharness/agent',
      license: 'BSD-3-Clause',
    })
    writeManifest(root, 'vendor/cordis/package.json', {
      name: '@yharness/cordis',
      license: 'BSD-3-Clause',
    })
    writeManifest(root, 'native/system/package.json', {
      name: '@yharness/node-addon-system-workspace',
      license: 'BSD-3-Clause',
    })

    expect(inspectDshPackageLicenses(root)).toEqual({
      packageCount: 3,
      failures: [
        'packages/core/agent/package.json: @yharness/agent must declare "license": "MIT"; found "BSD-3-Clause".',
      ],
    })
  })

  it('rejects a missing license declaration', () => {
    const root = createWorkspace()
    writeManifest(root, 'packages/core/agent/package.json', { name: '@yharness/agent' })

    expect(inspectDshPackageLicenses(root).failures).toEqual([
      'packages/core/agent/package.json: @yharness/agent must declare "license": "MIT"; found undefined.',
    ])
  })
})
