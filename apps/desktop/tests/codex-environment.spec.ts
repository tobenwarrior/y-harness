import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyDesktopCodexEnvironment,
  DESKTOP_CODEX_ENVIRONMENT_NAMES,
  desktopCodexNodePath,
  resolveDesktopCodexEnvironment,
} from '../src/codex-environment.ts'

const roots: string[] = []

interface FixtureNativeTarget {
  readonly packageName: string
  readonly version: string
  readonly triple: string
  readonly executable: string
}

const ARM64_NATIVE_TARGET: FixtureNativeTarget = {
  packageName: '@openai/codex-darwin-arm64', version: '0.153.4-darwin-arm64',
  triple: 'aarch64-apple-darwin', executable: 'codex',
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'y-harness-codex-environment-'))
  roots.push(root)
  return root
}

function runtimeWithCodex(root: string, manifest: Record<string, unknown> = {
  name: '@openai/codex', version: '0.153.4', bin: { codex: 'bin/codex.js' },
}, nativeTarget: FixtureNativeTarget = ARM64_NATIVE_TARGET): string {
  const runtime = join(root, 'runtime')
  const packageRoot = join(runtime, 'node_modules', '@yharness', 'llm-pi-ai', 'node_modules', '@openai', 'codex')
  const nativeRoot = join(packageRoot, 'node_modules', '@openai', nativeTarget.packageName.slice('@openai/'.length))
  mkdirSync(join(packageRoot, 'bin'), { recursive: true })
  mkdirSync(join(nativeRoot, 'vendor', nativeTarget.triple, 'bin'), { recursive: true })
  const llmRoot = join(runtime, 'node_modules', '@yharness', 'llm-pi-ai')
  writeFileSync(join(runtime, 'package.json'), '{}\n')
  writeFileSync(join(llmRoot, 'package.json'), JSON.stringify({ name: '@yharness/llm-pi-ai', version: '0.2.1-rc.2' }))
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(packageRoot, 'bin', 'codex.js'), '#!/usr/bin/env node\n')
  writeFileSync(join(nativeRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', version: nativeTarget.version, os: ['darwin'], cpu: [nativeTarget.packageName.endsWith('-x64') ? 'x64' : 'arm64'] }))
  writeFileSync(join(nativeRoot, 'vendor', nativeTarget.triple, 'bin', nativeTarget.executable), '')
  chmodSync(join(packageRoot, 'bin', 'codex.js'), 0o755)
  chmodSync(join(nativeRoot, 'vendor', nativeTarget.triple, 'bin', nativeTarget.executable), 0o755)
  return runtime
}

function managedDevelopmentRuntime(root: string): { runtime: string; checkout: string } {
  const checkout = join(root, 'checkout')
  const runtime = join(checkout, 'apps', 'desktop', '.desktop-build', 'development', 'project')
  const llmRoot = join(checkout, 'packages', 'llm', 'llm-pi-ai')
  const packageRoot = join(checkout, 'node_modules', '.pnpm', '@openai+codex@0.153.4', 'node_modules', '@openai', 'codex')
  const nativeRoot = join(checkout, 'node_modules', '.pnpm', '@openai+codex@0.153.4-darwin-arm64', 'node_modules', '@openai', 'codex')
  mkdirSync(join(runtime, 'node_modules', '@yharness'), { recursive: true })
  mkdirSync(join(llmRoot, 'node_modules', '@openai'), { recursive: true })
  mkdirSync(join(packageRoot, 'bin'), { recursive: true })
  mkdirSync(join(packageRoot, 'node_modules', '@openai'), { recursive: true })
  mkdirSync(join(nativeRoot, 'vendor', 'aarch64-apple-darwin', 'bin'), { recursive: true })
  writeFileSync(join(runtime, 'package.json'), '{}\n')
  writeFileSync(join(checkout, 'package.json'), '{}\n')
  writeFileSync(join(llmRoot, 'package.json'), JSON.stringify({ name: '@yharness/llm-pi-ai', version: '0.2.1-rc.2' }))
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@openai/codex', version: '0.153.4', bin: { codex: 'bin/codex.js' },
  }))
  writeFileSync(join(packageRoot, 'bin', 'codex.js'), '#!/usr/bin/env node\n')
  writeFileSync(join(nativeRoot, 'package.json'), JSON.stringify({
    name: '@openai/codex', version: '0.153.4-darwin-arm64', os: ['darwin'], cpu: ['arm64'],
  }))
  writeFileSync(join(nativeRoot, 'vendor', 'aarch64-apple-darwin', 'bin', 'codex'), '')
  chmodSync(join(packageRoot, 'bin', 'codex.js'), 0o755)
  chmodSync(join(nativeRoot, 'vendor', 'aarch64-apple-darwin', 'bin', 'codex'), 0o755)
  symlinkSync(llmRoot, join(runtime, 'node_modules', '@yharness', 'llm-pi-ai'), 'dir')
  symlinkSync(packageRoot, join(llmRoot, 'node_modules', '@openai', 'codex'), 'dir')
  symlinkSync(nativeRoot, join(packageRoot, 'node_modules', '@openai', 'codex-darwin-arm64'), 'dir')
  return { runtime, checkout }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Desktop Codex environment', () => {
  it('resolves the pinned package-local wrapper and Y Harness-owned homes', () => {
    const root = temporaryRoot()
    const runtimeDir = runtimeWithCodex(root)
    const nodePath = desktopCodexNodePath(join(root, 'primary-runtime'))
    mkdirSync(join(root, 'primary-runtime', 'dependencies', 'node', 'bin'), { recursive: true })
    writeFileSync(nodePath, '')
    chmodSync(nodePath, 0o755)
    const result = resolveDesktopCodexEnvironment({
      runtimeDir, dshHome: join(root, 'home'), cwd: join(root, 'profile'), nodePath,
      targetPlatform: 'darwin', targetArch: 'arm64',
    })
    expect(result.reason).toBeUndefined()
    expect(result.environment).toEqual({
      DSH_CODEX_BINARY: realpathSync(join(runtimeDir, 'node_modules', '@yharness', 'llm-pi-ai', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')),
      DSH_CODEX_NODE: nodePath,
      DSH_CODEX_HOME: join(root, 'home', 'native-codex'),
      DSH_CODEX_SHELL_HOME: join(root, 'home', 'native-codex-shell'),
      DSH_CODEX_CWD: join(root, 'profile'),
    })
  })

  it('accepts the managed development symlink only under its trusted checkout root', () => {
    if (process.platform === 'win32') return
    const root = temporaryRoot()
    const { runtime, checkout } = managedDevelopmentRuntime(root)
    const nodePath = join(root, 'node')
    writeFileSync(nodePath, '')
    chmodSync(nodePath, 0o755)
    const request = {
      runtimeDir: runtime, dshHome: join(root, 'home'), cwd: join(root, 'profile'), nodePath,
      targetPlatform: 'darwin' as const, targetArch: 'arm64' as const,
    }
    const packaged = resolveDesktopCodexEnvironment(request)
    expect(packaged.environment).toEqual({})
    expect(packaged.reason).toContain('outside the packaged runtime')
    const development = resolveDesktopCodexEnvironment({ ...request, trustedDevelopmentRoot: checkout })
    expect(development.reason).toBeUndefined()
    expect(development.environment.DSH_CODEX_BINARY).toBe(
      realpathSync(join(runtime, 'node_modules', '@yharness', 'llm-pi-ai', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')),
    )
  })

  it('clears ambient paths when the official runtime package is absent', () => {
    const root = temporaryRoot()
    const nodePath = join(root, 'node')
    writeFileSync(nodePath, '')
    chmodSync(nodePath, 0o755)
    const result = resolveDesktopCodexEnvironment({
      runtimeDir: join(root, 'missing-runtime'), dshHome: join(root, 'home'), cwd: join(root, 'profile'), nodePath,
    })
    expect(result.environment).toEqual({})
    expect(result.reason).toContain('LLM runtime package is missing')
    const environment = applyDesktopCodexEnvironment({ PATH: '/user/bin' }, result)
    for (const name of DESKTOP_CODEX_ENVIRONMENT_NAMES) expect(environment[name]).toBeUndefined()
    expect(environment.PATH).toBe('/user/bin')
  })

  it('preserves a complete explicit Codex configuration from the launch environment', () => {
    const warning = vi.spyOn(console, 'warn')
    const base = {
      DSH_CODEX_BINARY: '/connected/codex.js',
      DSH_CODEX_NODE: '/connected/node',
      DSH_CODEX_HOME: '/connected/home',
      DSH_CODEX_SHELL_HOME: '/connected/shell-home',
      DSH_CODEX_CWD: '/connected/profile',
      PATH: '/user/bin',
    }
    const result = applyDesktopCodexEnvironment(base, {
      environment: {
        DSH_CODEX_BINARY: '/new/codex.js',
        DSH_CODEX_NODE: '/new/node',
        DSH_CODEX_HOME: '/new/home',
        DSH_CODEX_SHELL_HOME: '/new/shell-home',
        DSH_CODEX_CWD: '/new/profile',
      },
    })
    expect(result).toEqual(base)
    expect(warning).not.toHaveBeenCalled()
  })

  it('preserves and reports a partial explicit Codex configuration', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const base = { DSH_CODEX_BINARY: '/connected/codex.js', PATH: '/user/bin' }
    const result = applyDesktopCodexEnvironment(base, {
      environment: {
        DSH_CODEX_BINARY: '/new/codex.js',
        DSH_CODEX_NODE: '/new/node',
      },
    })
    expect(result).toEqual(base)
    expect(warning).toHaveBeenCalledWith(
      'desktop Codex backend: incomplete explicit configuration (DSH_CODEX_BINARY); preserving it.',
    )
  })

  it('rejects a package-local binary that escapes its package directory', () => {
    const root = temporaryRoot()
    const nodePath = join(root, 'node')
    writeFileSync(nodePath, '')
    chmodSync(nodePath, 0o755)
    const result = resolveDesktopCodexEnvironment({
      runtimeDir: runtimeWithCodex(root, {
        name: '@openai/codex', version: '0.153.4', bin: { codex: '../../outside.js' },
      }), dshHome: join(root, 'home'), cwd: join(root, 'profile'), nodePath,
      targetPlatform: 'darwin', targetArch: 'arm64',
    })
    expect(result.environment).toEqual({})
    expect(result.reason).toContain('package-local')
  })

  it('does not create or reuse a native profile while applying the same paths across Host restarts', () => {
    const root = temporaryRoot()
    const runtimeDir = runtimeWithCodex(root)
    const nodePath = join(root, 'node')
    writeFileSync(nodePath, '')
    chmodSync(nodePath, 0o755)
    const request = { runtimeDir, dshHome: join(root, 'home'), cwd: join(root, 'profile'), nodePath, targetPlatform: 'darwin' as const, targetArch: 'arm64' as const }
    const first = resolveDesktopCodexEnvironment(request)
    const second = resolveDesktopCodexEnvironment(request)
    expect(second).toEqual(first)
    expect(first.environment.DSH_CODEX_HOME).not.toBe(join(process.env.HOME ?? '', '.codex'))
    expect(existsSync(join(root, 'home', 'native-codex'))).toBe(false)
  })

  it('rejects an unpinned package release', () => {
    const root = temporaryRoot()
    const nodePath = join(root, 'node')
    writeFileSync(nodePath, '')
    chmodSync(nodePath, 0o755)
    const result = resolveDesktopCodexEnvironment({
      runtimeDir: runtimeWithCodex(root, { name: '@openai/codex', version: '0.160.0', bin: { codex: 'bin/codex.js' } }),
      dshHome: join(root, 'home'), cwd: join(root, 'profile'), nodePath,
      targetPlatform: 'darwin', targetArch: 'arm64',
    })
    expect(result.environment).toEqual({})
    expect(result.reason).toContain('pinned @openai/codex@0.153.4')
  })

  it('does not reuse a native package built for another architecture', () => {
    const root = temporaryRoot()
    const nodePath = join(root, 'node')
    writeFileSync(nodePath, '')
    chmodSync(nodePath, 0o755)
    const result = resolveDesktopCodexEnvironment({
      runtimeDir: runtimeWithCodex(root), dshHome: join(root, 'home'), cwd: join(root, 'profile'), nodePath,
      targetPlatform: 'darwin', targetArch: 'x64',
    })
    expect(result.environment).toEqual({})
    expect(result.reason).toContain('darwin-x64')
  })

  it('resolves the target x64 native package when it is installed', () => {
    const root = temporaryRoot()
    const nodePath = join(root, 'node')
    writeFileSync(nodePath, '')
    chmodSync(nodePath, 0o755)
    const result = resolveDesktopCodexEnvironment({
      runtimeDir: runtimeWithCodex(root, undefined, {
        packageName: '@openai/codex-darwin-x64', version: '0.153.4-darwin-x64',
        triple: 'x86_64-apple-darwin', executable: 'codex',
      }),
      dshHome: join(root, 'home'), cwd: join(root, 'profile'), nodePath,
      targetPlatform: 'darwin', targetArch: 'x64',
    })
    expect(result.reason).toBeUndefined()
    expect(result.environment.DSH_CODEX_BINARY).toContain('codex/bin/codex.js')
  })

  it('resolves the wrapper and native package from the physical runtime beside ASAR', () => {
    const root = temporaryRoot()
    const archivedRuntime = runtimeWithCodex(root)
    const unpackedRuntime = runtimeWithCodex(join(root, 'unpacked'))
    const nodePath = join(root, 'node')
    writeFileSync(nodePath, '')
    chmodSync(nodePath, 0o755)
    const result = resolveDesktopCodexEnvironment({
      runtimeDir: archivedRuntime, unpackedRuntimeDir: unpackedRuntime,
      dshHome: join(root, 'home'), cwd: join(root, 'profile'), nodePath,
      targetPlatform: 'darwin', targetArch: 'arm64',
    })
    expect(result.reason).toBeUndefined()
    expect(result.environment.DSH_CODEX_BINARY).toBe(
      realpathSync(join(unpackedRuntime, 'node_modules', '@yharness', 'llm-pi-ai', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')),
    )
    expect(result.environment.DSH_CODEX_BINARY).not.toContain(archivedRuntime)
  })

  it('allows an existing isolated home whose permissions are repaired before launch', () => {
    if (process.platform === 'win32') return
    const root = temporaryRoot()
    const runtimeDir = runtimeWithCodex(root)
    const nodePath = join(root, 'node')
    writeFileSync(nodePath, '')
    chmodSync(nodePath, 0o755)
    mkdirSync(join(root, 'home'), { recursive: true })
    mkdirSync(join(root, 'home', 'native-codex'), { recursive: true, mode: 0o755 })
    const result = resolveDesktopCodexEnvironment({
      runtimeDir, dshHome: join(root, 'home'), cwd: join(root, 'profile'), nodePath,
      targetPlatform: 'darwin', targetArch: 'arm64',
    })
    expect(result.reason).toBeUndefined()
    expect(result.environment.DSH_CODEX_HOME).toBe(join(root, 'home', 'native-codex'))
  })

  it('rejects an existing isolated home symlink', () => {
    if (process.platform === 'win32') return
    const root = temporaryRoot()
    const runtimeDir = runtimeWithCodex(root)
    const nodePath = join(root, 'node')
    writeFileSync(nodePath, '')
    chmodSync(nodePath, 0o755)
    mkdirSync(join(root, 'outside'), { recursive: true })
    mkdirSync(join(root, 'home'), { recursive: true })
    symlinkSync(join(root, 'outside'), join(root, 'home', 'native-codex'))
    const result = resolveDesktopCodexEnvironment({
      runtimeDir, dshHome: join(root, 'home'), cwd: join(root, 'profile'), nodePath,
      targetPlatform: 'darwin', targetArch: 'arm64',
    })
    expect(result.environment).toEqual({})
    expect(result.reason).toContain('symbolic link')
  })
})
