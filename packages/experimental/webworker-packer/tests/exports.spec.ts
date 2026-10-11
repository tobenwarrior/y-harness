/** Runtime reachability ignores declaration-only export roots, not runtime requests. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, type TestContext } from 'vitest'
import { packVfsImage, type PackOptions } from '../src/pack.ts'
import { MemoryVfs, WorkerModuleLoader } from '@deepseek-ai/dsh-experimental-webworker-runtime'

const SUBJECT = '@deepseek-ai/dsh-image-export-fixture'

function fixture(test: TestContext, face: unknown, source = 'export const value = 1'): PackOptions {
  const root = mkdtempSync(join(tmpdir(), 'dsh-image-exports-'))
  test.onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  mkdirSync(join(root, 'lib'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: SUBJECT,
    type: 'module',
    files: ['lib'],
    exports: {
      '.': { types: './lib/index.d.ts', default: './lib/index.js' },
      './contract': face,
    },
  }))
  writeFileSync(join(root, 'lib/index.js'), source)
  writeFileSync(join(root, 'lib/index.d.ts'), 'export declare const value: number')
  writeFileSync(join(root, 'lib/contract.js'), 'export const value = 2')
  return {
    config: `- id: subject\n  name: '${SUBJECT}'\n`,
    profile: 'export-check',
    workspaces: new Map([[SUBJECT, root]]),
    resolveFrom: root,
    entries: [],
  }
}

it.for([
  { types: './lib/index.d.ts' },
  { 'types@>=5.2': './lib/index.d.ts' },
  { browser: { types: './lib/index.d.ts' } },
  [{ types: './lib/index.d.ts' }],
])('packs a declaration-only export without requesting a runtime entry: %j', (face, test) => {
  const result = packVfsImage(fixture(test, face))
  expect(result.missing).toEqual([])
  expect(Object.keys(result.files)).toContain(`node_modules/${SUBJECT}/lib/index.js`)
  expect(Object.keys(result.files)).not.toContain(`node_modules/${SUBJECT}/lib/index.d.ts`)
  expect(Object.keys(result.files)).not.toContain(`node_modules/${SUBJECT}/lib/contract.js`)
})

it.for([
  { types: './lib/index.d.ts', default: './lib/contract.js' },
  [{ types: './lib/index.d.ts' }, './lib/contract.js'],
])('retains the runtime target beside a types condition: %j', (face, test) => {
  const result = packVfsImage(fixture(test, face))
  expect(Object.keys(result.files)).toContain(`node_modules/${SUBJECT}/lib/contract.js`)
})

it('rejects a runtime import of a declaration-only export', (test) => {
  const options = fixture(test, { types: './lib/index.d.ts' }, `export { value } from '${SUBJECT}/contract'`)
  expect(() => packVfsImage(options)).toThrow('does not export "./contract"')
})

it('rejects an assembly entry that requests a declaration-only export', (test) => {
  const options = fixture(test, { types: './lib/index.d.ts' })
  expect(() => packVfsImage({ ...options, entries: [`${SUBJECT}/contract`] })).toThrow('worker assembly entry')
})

it('rejects a missing runtime target beside a types condition', (test) => {
  const options = fixture(test, { types: './lib/index.d.ts', default: './lib/missing.js' })
  expect(() => packVfsImage(options)).toThrow('cannot resolve')
})

function loadedValue(result: ReturnType<typeof packVfsImage>): unknown {
  const vfs = new MemoryVfs()
  for (const [name, bytes] of Object.entries(result.files)) {
    if (name.endsWith('/')) vfs.seedDirectory(`/dsh/${name}`)
    else vfs.seed(`/dsh/${name}`, bytes)
  }
  const loader = new WorkerModuleLoader({ vfs, root: '/dsh', staticModules: {} })
  return (loader.createRequire('/dsh/')(SUBJECT) as { value: unknown }).value
}

it('loads a runtime export whose file starts with a shebang', (test) => {
  const options = fixture(test, { types: './lib/index.d.ts' }, '#!/usr/bin/env node\nexport const value = 3')
  const result = packVfsImage(options)
  expect(loadedValue(result)).toBe(3)
  expect(result.executables).not.toContain(`node_modules/${SUBJECT}/lib/index.js`)
})

it('loads a shebang module reached by a runtime import', (test) => {
  const options = fixture(test, { types: './lib/index.d.ts' }, "export { value } from './reader.mjs'")
  writeFileSync(join(options.resolveFrom, 'lib/reader.mjs'), '#!/usr/bin/env node\nexport const value = 7')
  const result = packVfsImage(options)
  expect(loadedValue(result)).toBe(7)
  expect(result.files[`node_modules/${SUBJECT}/lib/reader.mjs`]).toBeDefined()
  expect(result.executables).not.toContain(`node_modules/${SUBJECT}/lib/reader.mjs`)
})

it('omits an unreachable launcher with top-level await', (test) => {
  const options = fixture(test, { types: './lib/index.d.ts' })
  writeFileSync(join(options.resolveFrom, 'lib/launcher.mjs'), '#!/usr/bin/env node\nawait Promise.resolve()')
  const result = packVfsImage(options)
  expect(loadedValue(result)).toBe(1)
  expect(result.files[`node_modules/${SUBJECT}/lib/launcher.mjs`]).toBeUndefined()
  expect(result.executables).toContain(`node_modules/${SUBJECT}/lib/launcher.mjs`)
})
