import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const script = resolve(root, 'scripts/build-exe-for-python-sdk.ts')

describe('Python runtime executable assets', () => {
  it('packages the dynamically resolved web frontend distribution', () => {
    const result = spawnSync(process.execPath, [
      '--import',
      'tsx/esm',
      script,
      '--skip-build',
      '--dry-run',
      '--targets=node24-macos-arm64',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, npm_execpath: 'C:\\tools\\pnpm.cjs' },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('node_modules/@yharness/web-frontend/dist/**/*')
    expect(result.stdout).toContain('node_modules/@yharness/skill-badge/assets/**/*')
    expect(result.stdout).toContain('node_modules/@yharness/sandbox-windows-acl/assets/**/*')
    expect(result.stdout).not.toContain('node_modules/**/*.py')
  })

  it('copies the Linux Landlock launcher into the existing resource directory', () => {
    const result = spawnSync(process.execPath, [
      '--import',
      'tsx/esm',
      script,
      '--skip-build',
      '--dry-run',
      '--targets=node24-linux-arm64',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, npm_execpath: 'C:\\tools\\pnpm.cjs' },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('native/system run build:native --landlock-only')
    expect(result.stdout).toContain('node_modules/@yharness/node-addon-system-linux-arm64/bin/landlock-run')
    expect(result.stdout).toContain('dist-exe/linux-arm64/landlock-run')
  })
})
