/** Workspace dependency ranges and package publication constraints. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  isPublicExperimentalPackageDirectory,
  PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES,
} from './experimental-package-policy.ts'
import {
  checkDshFamilyVersion,
  checkWorkspaceManifest,
  checkWorkspaceProtocol,
  checkExperimentalDependencyIsolation,
  checkExperimentalManifest,
  expectedDshPackageFiles,
  readWorkspaceManifests,
  type WorkspaceManifest,
} from './check-workspace-constraints.ts'

const experimental = {
  dir: 'packages/experimental/prototype',
  manifest: {
    name: '@yharness/experimental-prototype',
    publishConfig: { access: 'public' },
  },
} satisfies WorkspaceManifest

const VENDORED_RELEASE_DIRECTORIES = [
  'vendor/cordis',
  'vendor/cosmokit',
  'vendor/group',
  'vendor/hmr',
  'vendor/include',
  'vendor/loader',
  'vendor/logger-console',
  'vendor/schemastery',
  'vendor/timer',
] as const

describe('workspace dependency ranges', () => {
  const dependency = { dir: 'packages/core/runtime', manifest: { name: '@yharness/runtime' } }
  const cli = { dir: 'apps/cli', manifest: { name: '@yharness/cli' } }
  const legacyDependency = { dir: 'packages/core/legacy-runtime', manifest: { name: '@deepseek-ai/dsh-runtime' } }
  const legacyCli = { dir: 'apps/legacy-cli', manifest: { name: '@deepseek-ai/dsh' } }
  const vendor = { dir: 'vendor/cordis', manifest: { name: '@yharness/cordis' } }
  const native = { dir: 'native/system', manifest: { name: '@yharness/node-addon-system' } }
  const platform = { dir: 'native/system/packages/darwin-arm64', manifest: { name: '@yharness/node-addon-system-darwin-arm64' } }
  const unrelated = { dir: 'tools/helper', manifest: { name: '@other/helper' } }

  describe.each([
    '.', 'packages/core/probe', 'packages/experimental/probe', 'apps/cli', 'apps/web',
    'apps/desktop', 'apps/desktop-host', 'benchmarks', 'website', 'python/sdk-runtime', 'tools/probe',
    'vendor/loader', 'native/system', 'native/system/packages/entry',
  ])('consumer %s', (dir) => {
    it.each(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const)(
      'requires exact DSH and tilde vendor/native %s independently of the consumer name',
      (section) => {
        const consumer = (name: string, range: string): WorkspaceManifest => ({
          dir, manifest: { name: 'consumer', [section]: { [name]: range } },
        })
        const check = (name: string, range: string): string[] =>
          checkWorkspaceProtocol([
            dependency, cli, legacyDependency, legacyCli,
            vendor, native, platform, unrelated, consumer(name, range),
          ])
        for (const name of ['@yharness/cli', '@yharness/runtime', '@deepseek-ai/dsh', '@deepseek-ai/dsh-runtime']) {
          expect(check(name, 'workspace:*')).toEqual([])
          for (const range of ['workspace:^', 'workspace:~', 'workspace:^0.1.7', '^0.1.7', '*']) {
            expect(check(name, range)).toEqual([
              `consumer: ${section}.${name} must use workspace:*, got ${range}`,
            ])
          }
        }
        for (const name of ['@yharness/cordis', '@yharness/node-addon-system', '@yharness/node-addon-system-darwin-arm64']) {
          expect(check(name, 'workspace:~')).toEqual([])
          for (const range of ['workspace:*', 'workspace:^', '^4.0.3', '~4.0.3']) {
            expect(check(name, range)).toEqual([
              `consumer: ${section}.${name} must use workspace:~, got ${range}`,
            ])
          }
        }
        for (const range of ['workspace:*', 'workspace:^']) {
          expect(check('@other/helper', range)).toEqual([])
        }
        expect(check('@other/helper', '^0.1.0')).toEqual([
          `consumer: ${section}.@other/helper must use the workspace: protocol, got ^0.1.0`,
        ])
        expect(check('external', '^1.2.3')).toEqual([])
      },
    )
  })
})

describe('workspace manifest discovery', () => {
  it('checks root, app, runtime, tooling, and newly declared members while honoring exclusions', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-workspace-ranges-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const consumers = ['.', 'apps/cli', 'apps/web', 'apps/desktop', 'apps/desktop-host', 'benchmarks', 'website', 'python/sdk-runtime', 'tools/probe']
    writeFileSync(join(root, 'pnpm-workspace.yaml'), [
      'packages:', '  - packages/*/*', '  - apps/*', '  - apps/cli', '  - benchmarks',
      '  - website', '  - python/sdk-runtime', '  - tools/*', '  - "!tools/excluded"',
    ].join('\n'))
    for (const dir of [...consumers, 'tools/excluded', 'unlisted/probe', 'packages/core/runtime']) {
      mkdirSync(join(root, dir), { recursive: true })
      writeFileSync(join(root, dir, 'package.json'), JSON.stringify(dir === 'packages/core/runtime'
        ? { name: '@yharness/runtime' }
        : { dependencies: { '@yharness/runtime': 'workspace:^' } }))
    }
    const manifests = readWorkspaceManifests(root)
    expect(manifests.map(entry => entry.dir).sort()).toEqual([...consumers, 'packages/core/runtime'].sort())
    expect(checkWorkspaceProtocol(manifests).sort()).toEqual(consumers.map(dir =>
      `${dir}: dependencies.@yharness/runtime must use workspace:*, got workspace:^`).sort())
  })

  it.each(['', 'null', '{}', 'packages: []', 'packages: [false]', 'packages: [""]', 'packages: wrong'])(
    'rejects an invalid workspace declaration: %s', (contents) => {
      const root = mkdtempSync(join(tmpdir(), 'dsh-workspace-ranges-'))
      onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
      writeFileSync(join(root, 'pnpm-workspace.yaml'), contents)
      expect(() => readWorkspaceManifests(root)).toThrow('packages must be a non-empty list of workspace patterns')
    },
  )

  it('rejects a declaration that matches no workspace members', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-workspace-ranges-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: [missing/*]')
    expect(() => readWorkspaceManifests(root)).toThrow('packages matched no workspace manifests')
  })
})

describe('experimental workspace constraints', () => {
  it('requires the experimental package-name prefix', () => {
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, name: '@yharness/prototype' },
    })).toEqual([
      '@yharness/prototype: experimental package name must start with "@yharness/experimental-"',
    ])
  })

  it('requires public metadata for unlisted experimental packages', () => {
    expect(checkExperimentalManifest(experimental)).toEqual([])
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { name: experimental.manifest.name, private: true },
    })).toEqual([
      '@yharness/experimental-prototype: public experimental package must not set "private": true',
      '@yharness/experimental-prototype: public experimental package must set publishConfig.access to "public"',
    ])
  })

  it('requires private metadata for an explicitly excluded prototype', () => {
    const { dir, manifest: { name } } = experimental
    const privateDirectories = [dir]
    expect(isPublicExperimentalPackageDirectory(dir, privateDirectories)).toBe(false)
    expect(checkExperimentalManifest({ dir, manifest: { name, private: true } }, privateDirectories)).toEqual([])
    expect(checkExperimentalManifest(experimental, privateDirectories)).toEqual([
      `${name}: experimental package must set "private": true`,
      `${name}: experimental package must omit publishConfig`,
    ])
  })

  it('keeps the current experimental publication set unrestricted', () => {
    expect(PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES).toEqual([])
  })

  it('limits the public default to experimental package directories', () => {
    expect(isPublicExperimentalPackageDirectory(experimental.dir)).toBe(true)
    for (const dir of [
      'packages/core/session',
      'apps/cli',
      'vendor/cordis',
      'packages/experimental',
      'packages/experimental/prototype/src',
      ...PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES,
    ]) {
      expect(isPublicExperimentalPackageDirectory(dir)).toBe(false)
    }
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'] as const)(
    'rejects release %s on an experimental package',
    (section) => {
      expect(checkExperimentalDependencyIsolation([experimental, {
        dir: 'packages/core/consumer',
        manifest: {
          name: '@yharness/consumer',
          [section]: { '@yharness/experimental-prototype': 'workspace:^' },
        },
      }])).toEqual([
        `@yharness/consumer: ${section}.@yharness/experimental-prototype must not reference an experimental package`,
      ])
    },
  )

  it('allows the dsh installation to ship the optional bundles the launcher names, and nothing else experimental', () => {
    const listed = { '@yharness/experimental-prototype': 'workspace:^' }
    const installation = { dir: 'apps/cli', manifest: { name: '@yharness/cli', dependencies: listed } } satisfies WorkspaceManifest
    expect(checkExperimentalDependencyIsolation([experimental, installation], ['@yharness/experimental-prototype'])).toEqual([])
    expect(checkExperimentalDependencyIsolation([experimental, installation], [])).toEqual([
      '@yharness/cli: dependencies.@yharness/experimental-prototype must not reference an experimental package',
    ])
    // Only a plain dependency edge is offered; a peer would make the bundle a requirement of every consumer.
    expect(checkExperimentalDependencyIsolation([experimental, {
      dir: 'apps/cli',
      manifest: { name: '@yharness/cli', peerDependencies: listed },
    }], ['@yharness/experimental-prototype'])).toEqual([
      '@yharness/cli: peerDependencies.@yharness/experimental-prototype must not reference an experimental package',
    ])
  })

  it('allows development and experimental consumers but rejects the Python release runtime', () => {
    const manifests: WorkspaceManifest[] = [experimental, {
      dir: 'packages/core/test-only',
      manifest: {
        name: '@yharness/test-only',
        devDependencies: { '@yharness/experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'packages/experimental/consumer',
      manifest: {
        name: '@yharness/experimental-consumer',
        dependencies: { '@yharness/experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'python/sdk-runtime',
      manifest: {
        name: '@yharness/python-runtime',
        dependencies: { '@yharness/experimental-prototype': 'workspace:^' },
      },
    }]

    expect(checkExperimentalDependencyIsolation(manifests)).toEqual([
      '@yharness/python-runtime: dependencies.@yharness/experimental-prototype must not reference an experimental package',
    ])
  })
})

describe('dsh family version coherence', () => {
  it('rejects a package carrying a stale shared version', () => {
    expect(checkDshFamilyVersion(
      { name: '@yharness/http-proxy', version: '0.1.2-alpha.5' },
      '0.1.2-rc.1',
    )).toBe('@yharness/http-proxy: package.json version must match root version 0.1.2-rc.1')
  })

  it('rejects the root-named CLI app on a stale shared version', () => {
    expect(checkDshFamilyVersion(
      { name: '@yharness/cli', version: '0.1.2-alpha.5' },
      '0.1.2-rc.1',
    )).toBe('@yharness/cli: package.json version must match root version 0.1.2-rc.1')
  })

  it('accepts a manifest carrying the shared version', () => {
    expect(checkDshFamilyVersion(
      { name: '@yharness/http-proxy', version: '0.1.2-rc.1' },
      '0.1.2-rc.1',
    )).toBeUndefined()
    expect(checkDshFamilyVersion(
      { name: '@yharness/http-proxy', version: '0.1.2-alpha.5' },
      '0.1.2-rc.1',
    )).toBe('@yharness/http-proxy: package.json version must match root version 0.1.2-rc.1')
  })

  it('leaves other sequences to their own version lines', () => {
    expect(checkDshFamilyVersion({ name: '@yharness/cordis', version: '4.0.1' }, '0.1.2-rc.1')).toBeUndefined()
    expect(checkDshFamilyVersion({ name: '@yharness/cordis-plugin-loader', version: '1.0.6-alpha.1' }, '0.1.2-rc.1')).toBeUndefined()
    expect(checkDshFamilyVersion(
      { name: '@deepseek-ai/node-addon-system', version: '0.1.1' },
      '0.1.2-rc.1',
    )).toBeUndefined()
    expect(checkDshFamilyVersion({ version: '0.1.2-alpha.5' }, '0.1.2-rc.1')).toBeUndefined()
  })
})

describe('package payload constraints', () => {
  it('includes the Compound skill source record in its published payload', () => {
    expect(expectedDshPackageFiles({ name: '@yharness/skill-compound' })).toEqual([
      'lib/index.js', 'assets', 'UPSTREAM.md', 'lib/types/**/*.d.ts',
    ])
  })

  it.each([
    ['./art/icon.svg', ['art/icon.svg']],
    [{ import: './art/icon.svg', default: './art/fallback.svg' }, ['art/icon.svg', 'art/fallback.svg']],
    [['./art/icon.svg', './art/icon.svg'], ['art/icon.svg']],
  ] as const)('includes exported icon targets in the canonical payload: %j', (icon, expected) => {
    expect(expectedDshPackageFiles({ exports: { './icon': icon } })).toEqual([...expected, 'lib/index.js', 'lib/types/**/*.d.ts'])
  })

  it.each(['icon.svg', './icon.svg'])('includes and deduplicates manifest icon %s', (icon) => {
    expect(expectedDshPackageFiles({ icon, exports: { './icon': './icon.svg' } })).toEqual(['icon.svg', 'lib/index.js', 'lib/types/**/*.d.ts'])
  })

  it('includes manifest, root, and subpath icon targets', () => {
    expect(expectedDshPackageFiles({ icon: './legacy.svg', exports: { './icon': './fallback.svg', './search/icon': './search.svg' } })).toEqual([
      'legacy.svg', 'fallback.svg', 'search.svg', 'lib/index.js', 'lib/types/**/*.d.ts',
    ])
  })

  it('accepts the Agent Team icon payload and rejects its omission', () => {
    const dir = 'packages/experimental/agent-team-profile'
    const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
    expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
    expect(checkWorkspaceManifest({ dir, manifest: { ...manifest, files: manifest.files!.filter(file => file !== 'icon.svg') } }))
      .toEqual([expect.stringContaining('package.json files must be')])
  })

  it.each([
    { exports: { './locale/*.json': './locale/*.json' }, resources: ['locale/*.json'] },
    { exports: { './search/locale/*.json': './resources/search/*.json' }, resources: ['resources/search/*.json'] },
    { exports: { './locale/en.json': './locale/en.json', './locale/zh.json': './locale/zh.json' }, resources: ['locale/en.json', 'locale/zh.json'] },
    { exports: { './locale/*.json': { default: './locale/*.json' } }, resources: ['locale/*.json'] },
    { exports: { './locale/*.json': './locale/*.json', './search/locale/*.json': './locale/*.json' }, resources: ['locale/*.json'] },
    { exports: { './search/locale/*.json': './z/*.json', './locale/*.json': './a/*.json' }, resources: ['a/*.json', 'z/*.json'] },
  ])('includes declared locale resources in the canonical payload: $exports', ({ exports, resources }) => {
    expect(expectedDshPackageFiles({ name: '@yharness/localized', exports })).toEqual([
      ...resources, 'lib/index.js', 'lib/types/**/*.d.ts',
    ])
  })

  it('does not infer locale payloads from unrelated or non-JSON exports', () => {
    expect(expectedDshPackageFiles({
      exports: {
        './config.json': './config.json',
        './locale/README.md': './locale/README.md',
        './locale/en.json': './metadata.js',
        './locale/zh.json': null,
        './locale/fr.json': { types: './locale/fr.d.ts' },
      },
    })).toEqual(['lib/index.js', 'lib/types/**/*.d.ts'])
  })

  it.each(['agent-team', 'agent-team-profile', 'auto-review', 'client-ui-agent-team', 'tool-agent-team'])(
    'accepts the published locale files for %s and rejects their omission', (name) => {
      const dir = `packages/experimental/${name}`
      const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
      expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
      expect(checkWorkspaceManifest({ dir, manifest: {
        ...manifest, files: manifest.files!.filter(file => file !== 'locale/*.json'),
      } })).toEqual([expect.stringContaining('package.json files must be')])
    },
  )

  it('rejects locale publication entries without their resource exports', () => {
    const dir = 'packages/experimental/auto-review'
    const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
    const exports = { ...manifest.exports }
    delete exports['./locale/*.json']
    expect(checkWorkspaceManifest({ dir, manifest: { ...manifest, exports } }))
      .toEqual([expect.stringContaining('package.json files must be')])
  })

  it('includes a declared profile patch without a package-name allowlist', () => {
    expect(expectedDshPackageFiles({
      name: '@yharness/private-profile',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })).toEqual([
      'lib/index.js',
      'cordis.patch.yml',
      'lib/types/**/*.d.ts',
    ])
    expect(expectedDshPackageFiles({
      name: '@yharness/private-profile',
      dsh: { bundle: { patch: ['./cordis.patch.yml', './layers/web.patch.yml'] } },
    })).toEqual([
      'lib/index.js',
      'cordis.patch.yml',
      'layers/web.patch.yml',
      'lib/types/**/*.d.ts',
    ])
  })

  it.each([
    'packages/client/ui-sidebar-documentpreview',
    'packages/client/ui-sidebar-terminal',
  ])('accepts package-local Client chunks from %s', (dir) => {
    const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
    expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
  })
})

it('publishes CLI runtime declarations and rejects a payload that omits them', () => {
  const manifest = JSON.parse(readFileSync(new URL('../apps/cli/package.json', import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
  expect(checkWorkspaceManifest({ dir: 'apps/cli', manifest })).toEqual([])
  expect(checkWorkspaceManifest({ dir: 'apps/cli', manifest: { ...manifest, files: ['lib/*.js'] } }))
    .toEqual([expect.stringContaining('@yharness/cli: package.json files must be ["lib/*.js","lib/types/*.d.ts"]')])
})

it('keeps the private desktop updater alias outside the publication checks', () => {
  const dir = 'apps/desktop-legacy-compat'
  const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
  expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
})

it('publishes rescoped vendored packages from the Y Harness repository while retaining upstream metadata', () => {
  for (const dir of VENDORED_RELEASE_DIRECTORIES) {
    const rawManifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as Record<string, unknown>
    const manifest = rawManifest as WorkspaceManifest['manifest']
    expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
    expect(rawManifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/tobenwarrior/y-harness.git',
      directory: dir,
    })
    expect(rawManifest.author).toBe('Shigma <shigma10826@gmail.com>')
    expect(rawManifest.license).toBe('MIT')
    expect(rawManifest.files).toEqual(expect.arrayContaining(['src']))
  }
})

it('requires the shared Web injection entry in the published payload', () => {
  const manifest = JSON.parse(readFileSync(new URL('../packages/client/web/package.json', import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
  expect(checkWorkspaceManifest({ dir: 'packages/client/web', manifest })).toEqual([])
  expect(checkWorkspaceManifest({ dir: 'packages/client/web', manifest: {
    ...manifest, files: ['lib/index.js', 'lib/**/*.css', 'lib/types/**/*.d.ts'],
  } })).toEqual([expect.stringContaining('package.json files must be')])
})

it('requires Office skill bodies and helpers in the published payload', () => {
  const manifest = JSON.parse(readFileSync(new URL('../packages/skill/skill-office/package.json', import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
  expect(checkWorkspaceManifest({ dir: 'packages/skill/skill-office', manifest })).toEqual([])
  expect(checkWorkspaceManifest({ dir: 'packages/skill/skill-office', manifest: {
    ...manifest, files: ['lib/index.js', 'lib/types/**/*.d.ts'],
  } })).toEqual([expect.stringContaining('package.json files must be')])
})

it('requires the Nous license and emitted JavaScript in the pi-ai publication payload', () => {
  const dir = 'packages/llm/llm-pi-ai'
  const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
  expect(expectedDshPackageFiles(manifest)).toContain('NOUS-LICENSE.txt')
  expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
  for (const omitted of ['NOUS-LICENSE.txt', 'lib/types/**/*.js']) {
    expect(checkWorkspaceManifest({ dir, manifest: { ...manifest, files: manifest.files!.filter(file => file !== omitted) } }))
      .toEqual([expect.stringContaining('package.json files must be')])
  }
  expect(expectedDshPackageFiles({ ...manifest, name: '@yharness/other-provider' }))
    .not.toContain('NOUS-LICENSE.txt')
})

it('requires the local speech worker and locked runtime in the published payload', () => {
  const dir = 'packages/experimental/speech-to-text-sensevoice'
  const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
  expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
  for (const omitted of ['lib/worker.js', 'runtime/assets.json']) {
    expect(checkWorkspaceManifest({ dir, manifest: { ...manifest, files: manifest.files!.filter(file => file !== omitted) } }))
      .toEqual([expect.stringContaining('package.json files must be')])
  }
})

it('requires the Inspector Worker, Client chunks, and mirrored DevTools resources in the published payload', () => {
  const dir = 'packages/experimental/inspector'
  const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
  expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
  for (const omitted of ['lib/client.*.js', 'lib/worker.js', 'lib/devtools/**']) {
    expect(checkWorkspaceManifest({ dir, manifest: { ...manifest, files: manifest.files!.filter(file => file !== omitted) } }))
      .toEqual([expect.stringContaining('package.json files must be')])
  }
})

it('requires the standalone shortcut protocol and rejects unrelated runtime files', () => {
  const dir = 'packages/client/shortcuts'
  const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
  expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
  for (const files of [
    ['lib/index.js', 'lib/client.js', 'lib/types/**/*.d.ts'],
    ['lib/index.js', 'lib/client.js', 'lib/protocol.js', 'lib/extra.js', 'lib/types/**/*.d.ts'],
  ]) {
    expect(checkWorkspaceManifest({ dir, manifest: { ...manifest, files } }))
      .toEqual([expect.stringContaining('package.json files must be')])
  }
})
