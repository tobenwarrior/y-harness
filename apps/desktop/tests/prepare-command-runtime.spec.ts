import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { prepareCommandRuntime } from '../scripts/prepare-command-runtime.ts'

it.each([
  ['darwin', 'arm64', '@yharness/node-addon-system-darwin-arm64'],
  ['win32', 'x64', '@koromix/koffi-win32-x64'],
] as const)('ships command helper dependencies for %s-%s', (platform, arch, nativePackage) => {
  const root = mkdtempSync(join(tmpdir(), 'yh-command-runtime-'))
  try {
    const modules = join(root, 'dsh', 'node_modules')
    for (const name of ['@yharness/node-addon-system', 'koffi', nativePackage]) {
      const directory = join(modules, name)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ name }))
    }
    const destination = join(root, 'runtime', 'cli')
    prepareCommandRuntime(modules, destination, { platform, arch })
    for (const name of ['@yharness/node-addon-system', 'koffi', nativePackage]) {
      expect(JSON.parse(readFileSync(join(destination, 'node_modules', name, 'package.json'), 'utf8'))).toEqual({ name })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
