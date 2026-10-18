import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { clearBuildStateCaches, mergeManifestFields, selectPrerequisites } from './sync.mjs'

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'upstream-sync-'))
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })
  return root
}

describe('prerequisite selection', () => {
  const patterns = ['package.json', 'packages/util/**/package.json']

  it('selects only the declared manifests and nothing at the same depth', () => {
    const changed = [
      'package.json',
      'packages/util/http-proxy/package.json',
      'packages/util/public-http/package.json',
      'packages/web/web-fetch-http/package.json',
      'packages/util/http-proxy/src/index.ts',
      'packages/util/package.json.bak',
    ]
    expect(selectPrerequisites(changed, patterns)).toEqual([
      'package.json',
      'packages/util/http-proxy/package.json',
      'packages/util/public-http/package.json',
    ])
  })

  it('never selects a path an exclusion matches', () => {
    const changed = ['package.json', 'packages/util/http-proxy/package.json']
    const excluded = selectPrerequisites(changed, patterns, [/^packages\/util\//])
    expect(excluded).toEqual(['package.json'])
  })
})

describe('dependency merge', () => {
  it('adds and re-ranges upstream entries while keeping local ones', () => {
    const ours = {
      name: 'root',
      version: '0.2.1-rc.2',
      scripts: { build: 'tsc -b' },
      devDependencies: { '@types/node': '^22.20.0', 'left-pad': '1.0.0' },
      dependencies: { undici: '^8.10.0' },
    }
    const theirs = {
      name: 'root',
      version: '0.2.1-rc.3',
      scripts: { build: 'tsc -b --clean' },
      devDependencies: { '@types/node': '^22.20.0', '@types/react': '~18.3.1' },
      dependencies: { undici: '8.11.2' },
      engines: { node: '>=24' },
    }
    const { merged, changes, kept, untouchedFields } = mergeManifestFields(ours, theirs)
    expect(merged['devDependencies']).toEqual({ '@types/node': '^22.20.0', 'left-pad': '1.0.0', '@types/react': '~18.3.1' })
    expect(merged['dependencies']).toEqual({ undici: '8.11.2' })
    expect(merged['version']).toBe('0.2.1-rc.2')
    expect(merged['scripts']).toEqual({ build: 'tsc -b' })
    expect(changes).toEqual([
      { field: 'dependencies', name: 'undici', from: '^8.10.0', to: '8.11.2' },
      { field: 'devDependencies', name: '@types/react', from: undefined, to: '~18.3.1' },
    ])
    expect(kept).toEqual([{ field: 'devDependencies', name: 'left-pad', spec: '1.0.0' }])
    expect(untouchedFields).toEqual(['scripts', 'engines'])
  })

  it('keeps a dependency pinned ahead of upstream and reports the lower range', () => {
    const ours = { devDependencies: { typescript: '^7.0.0', zod: '4.4.3' } }
    const theirs = { devDependencies: { typescript: '^6.0.3', zod: '4.4.3' } }
    const { merged, changes, skipped } = mergeManifestFields(ours, theirs)
    expect(merged['devDependencies']).toEqual({ typescript: '^7.0.0', zod: '4.4.3' })
    expect(changes).toEqual([])
    expect(skipped).toEqual([{ field: 'devDependencies', name: 'typescript', from: '^7.0.0', to: '^6.0.3' }])
  })

  it('changes nothing when the manifests already agree', () => {
    const manifest = { version: '1.0.0', dependencies: { undici: '8.11.2' } }
    const first = mergeManifestFields(manifest, manifest)
    expect(first.changes).toEqual([])
    expect(first.merged).toEqual(manifest)
    const second = mergeManifestFields(first.merged, manifest)
    expect(second.changes).toEqual([])
    expect(second.merged).toEqual(first.merged)
  })

  it('ignores a manifest upstream cannot be read for', () => {
    const { changes, merged, kept } = mergeManifestFields({ version: '1.0.0' }, undefined)
    expect(changes).toEqual([])
    expect(kept).toEqual([])
    expect(merged).toEqual({ version: '1.0.0' })
  })
})

describe('build-state caches', () => {
  it('removes package and root caches but never touches node_modules', () => {
    const root = scratch()
    const caches = [
      'packages/util/http-proxy/lib/tsconfig.tsbuildinfo',
      'packages/client/ui-model-selection/lib/tsconfig.host.tsbuildinfo',
      'apps/desktop/lib/tsconfig.tsbuildinfo',
      'node_modules/kept/lib/tsconfig.tsbuildinfo',
    ]
    for (const path of caches) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), '{}')
    }
    writeFileSync(join(root, 'tsconfig.host.tsbuildinfo'), '{}')
    writeFileSync(join(root, 'tsconfig.client.tsbuildinfo'), '{}')

    const cleared = clearBuildStateCaches(root)

    expect(cleared).toHaveLength(5)
    expect(cleared).toContain('packages/util/http-proxy/lib/tsconfig.tsbuildinfo')
    expect(cleared).toContain('apps/desktop/lib/tsconfig.tsbuildinfo')
    expect(cleared).toContain('tsconfig.client.tsbuildinfo')
    expect(clearBuildStateCaches(root)).toEqual([])
  })
})
