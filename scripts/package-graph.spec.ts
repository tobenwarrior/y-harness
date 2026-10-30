import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderModuleGraph } from './gen-module-graph.ts'
import { collectPackageGraph } from './package-graph.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(packages: Readonly<Record<string, readonly string[]>>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-package-graph-'))
  roots.push(root)
  for (const [name, dependencies] of Object.entries(packages)) {
    const directory = join(root, 'packages', 'client', name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), `${JSON.stringify({
      name: `@yharness/${name}`,
      peerDependencies: Object.fromEntries(dependencies.map(dependency => [
        `@yharness/${dependency}`,
        'workspace:^',
      ])),
    }, null, 2)}\n`)
  }
  return root
}

describe('collectPackageGraph', () => {
  it('orders packages after their dependencies', () => {
    const root = fixture({ application: ['feature'], feature: ['foundation'], foundation: [] })

    expect(collectPackageGraph(root, ['client'], 'fixture').map(pkg => pkg.short))
      .toEqual(['foundation', 'feature', 'application'])
  })

  it('keeps a dependency cycle together and before its consumers', () => {
    const root = fixture({ consumer: ['left'], left: ['right'], right: ['left'], foundation: [] })

    expect(collectPackageGraph(root, ['client'], 'fixture').map(pkg => pkg.short))
      .toEqual(['foundation', 'left', 'right', 'consumer'])
  })

  it('rejects a missing in-repo peer', () => {
    const root = fixture({ consumer: ['missing'] })

    expect(() => collectPackageGraph(root, ['client'], 'fixture'))
      .toThrow('fixture: @yharness/consumer references missing in-repo peer @yharness/missing')
  })
})

describe('renderModuleGraph', () => {
  it('renders the same peer edge in both generated languages', () => {
    const packages = [
      { short: 'provider', name: '@yharness/provider', group: 'core', rel: 'packages/core/provider', deps: [] },
      { short: 'consumer', name: '@yharness/consumer', group: 'core', rel: 'packages/core/consumer', deps: ['provider'] },
    ]

    const english = renderModuleGraph(packages, 'en')
    const chinese = renderModuleGraph(packages, 'zh')

    expect(english).toContain('# Shared-instance dependency graph')
    expect(chinese).toContain('# \u5171\u4eab\u5b9e\u4f8b\u4f9d\u8d56\u5173\u7cfb\u56fe')
    expect(chinese).toContain('[English](module-graph.md) | \u4e2d\u6587')
    for (const output of [english, chinese]) {
      expect(output).toContain('pkg_consumer --> pkg_provider')
      expect(output).toContain('| [`consumer`](../packages/core/consumer) | `core` | [`provider`](../packages/core/provider) |')
    }
  })
})
