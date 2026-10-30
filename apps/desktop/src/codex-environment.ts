/** Resolve the Desktop-owned Codex runtime without inheriting a native user profile. */

import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Exact native package release carried by the LLM adapter. */
export const DESKTOP_CODEX_VERSION = '0.153.4'

/** Names the Host passes to the isolated Codex backend. */
export const DESKTOP_CODEX_ENVIRONMENT_NAMES = [
  'DSH_CODEX_BINARY',
  'DSH_CODEX_NODE',
  'DSH_CODEX_HOME',
  'DSH_CODEX_SHELL_HOME',
  'DSH_CODEX_CWD',
] as const

type DesktopCodexEnvironmentName = typeof DESKTOP_CODEX_ENVIRONMENT_NAMES[number]

/** Explicit launch paths consumed by the Codex backend connection. */
export type DesktopCodexEnvironment = Readonly<Partial<Record<DesktopCodexEnvironmentName, string>>>

/** Inputs owned by the packaged Desktop shell. */
export interface DesktopCodexEnvironmentRequest {
  /** Runtime project whose local dependencies supply the LLM adapter and official Codex package. */
  readonly runtimeDir: string
  /** Physical runtime tree used by standalone Node when the packaged runtime lives in ASAR. */
  readonly unpackedRuntimeDir?: string
  /** Unpackaged checkout root that may own linked runtime packages; omitted for installed builds. */
  readonly trustedDevelopmentRoot?: string
  /** Y Harness data root; native credentials stay below this directory. */
  readonly dshHome: string
  /** Desktop profile used as the native app-server launch directory. */
  readonly cwd: string
  /** Bundled absolute Node executable used for the package wrapper. */
  readonly nodePath: string
  /** Runtime target whose optional Codex native package must be present. */
  readonly targetPlatform?: NodeJS.Platform
  /** Runtime target whose optional Codex native package must be present. */
  readonly targetArch?: NodeJS.Architecture
}

/** Result of resolving the optional package-local Codex backend. */
export interface DesktopCodexEnvironmentResult {
  /** Explicit paths; empty when the runtime cannot provide the official package. */
  readonly environment: DesktopCodexEnvironment
  /** Fixed diagnostic safe to write to the Desktop log. */
  readonly reason?: string
}

interface PackageManifest {
  readonly name: string
  readonly version: string
  readonly bin: { readonly codex: string }
}

interface CodexNativeTarget {
  readonly packageName: string
  readonly triple: string
  readonly executable: string
}

const CODEX_NATIVE_TARGETS: Readonly<Record<string, Readonly<Record<string, CodexNativeTarget>>>> = {
  darwin: {
    arm64: { packageName: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin', executable: 'codex' },
    x64: { packageName: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin', executable: 'codex' },
  },
  linux: {
    arm64: { packageName: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl', executable: 'codex' },
    x64: { packageName: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl', executable: 'codex' },
  },
  win32: {
    arm64: { packageName: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc', executable: 'codex.exe' },
    x64: { packageName: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc', executable: 'codex.exe' },
  },
}

/**
 * Resolve the Node executable bundled with a Desktop primary runtime.
 * @param primaryRuntime - absolute `primary-runtime` payload directory.
 * @param platform - target platform represented by the payload.
 * @returns the platform-specific bundled Node path.
 */
export function desktopCodexNodePath(
  primaryRuntime: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(primaryRuntime, 'dependencies', 'node', 'bin', platform === 'win32' ? 'node.exe' : 'node')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readPackageManifest(path: string): PackageManifest | undefined {
  if (!isRegularFile(path)) return undefined
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(value) || value.name !== '@openai/codex' || value.version !== DESKTOP_CODEX_VERSION
    || !isRecord(value.bin) || typeof value.bin.codex !== 'string' || value.bin.codex === '') return undefined
  return { name: value.name, version: value.version, bin: { codex: value.bin.codex } }
}

function isRegularFile(path: string): boolean {
  try {
    const stats = lstatSync(path)
    return stats.isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    const stats = lstatSync(path)
    return stats.isFile() && (platform === 'win32' || (stats.mode & 0o111) !== 0)
  } catch {
    return false
  }
}

function isRegularPackageFile(root: string, path: string): boolean {
  return isRegularFileWithinRoots([root], path)
}

function pathWithinRoot(root: string, path: string): string | undefined {
  let canonicalRoot: string
  let canonicalPath: string
  try {
    canonicalRoot = realpathSync(root)
    canonicalPath = realpathSync(path)
  } catch {
    return undefined
  }
  const relativePath = relative(canonicalRoot, canonicalPath)
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
    ? relativePath
    : undefined
}

function isRegularFileWithinRoots(roots: readonly string[], path: string): boolean {
  try {
    const file = realpathSync(path)
    if (!isRegularFile(path)) return false
    return roots.some((root) => {
      const canonicalRoot = realpathSync(root)
      const prefix = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`
      return file.startsWith(prefix)
    })
  } catch {
    return false
  }
}

function isExecutablePackageFile(root: string, path: string, platform: NodeJS.Platform): boolean {
  try {
    const packageRoot = realpathSync(root)
    const file = realpathSync(path)
    const prefix = packageRoot.endsWith(sep) ? packageRoot : `${packageRoot}${sep}`
    return file.startsWith(prefix) && isExecutableFile(path, platform)
  } catch {
    return false
  }
}

function privateDirectoryReason(path: string, label: string): string | undefined {
  try {
    const stats = lstatSync(path)
    if (stats.isSymbolicLink()) return `${label} must not be a symbolic link.`
    if (!stats.isDirectory()) return `${label} is not a directory.`
    return undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return `${label} could not be inspected.`
  }
}

function nativePackageIsUsable(
  codexManifestPath: string,
  trustedRoots: readonly string[],
  target: CodexNativeTarget,
  platform: NodeJS.Platform,
): boolean {
  let packageManifestPath: string
  try {
    packageManifestPath = createRequire(codexManifestPath).resolve(`${target.packageName}/package.json`)
  } catch {
    return false
  }
  if (!isRegularFileWithinRoots(trustedRoots, packageManifestPath)) return false
  let value: unknown
  try {
    value = JSON.parse(readFileSync(packageManifestPath, 'utf8'))
  } catch {
    return false
  }
  if (!isRecord(value) || value.name !== '@openai/codex'
    || value.version !== `${DESKTOP_CODEX_VERSION}-${target.packageName.slice('@openai/codex-'.length)}`) return false
  const packageRoot = dirname(packageManifestPath)
  return isExecutablePackageFile(packageRoot, join(packageRoot, 'vendor', target.triple, 'bin', target.executable), platform)
}

function unavailable(reason: string): DesktopCodexEnvironmentResult {
  return { environment: {}, reason }
}

/**
 * Resolve the exact `bin.codex` wrapper from the Desktop runtime's package graph.
 * The resolver never consults `PATH`, `~/.codex`, or another native Codex profile.
 * @param request - runtime and Y Harness-owned paths.
 * @returns explicit backend paths, or a safe diagnostic when the package is absent or invalid.
 */
export function resolveDesktopCodexEnvironment(
  request: DesktopCodexEnvironmentRequest,
): DesktopCodexEnvironmentResult {
  if (![request.runtimeDir, request.dshHome, request.cwd, request.nodePath].every(isAbsolute)) {
    return unavailable('Desktop Codex paths are not absolute.')
  }
  if (request.unpackedRuntimeDir !== undefined && !isAbsolute(request.unpackedRuntimeDir)) {
    return unavailable('The physical Desktop Codex runtime path is not absolute.')
  }
  if (!isDirectory(request.runtimeDir) || !isRegularFile(join(request.runtimeDir, 'package.json'))) {
    return unavailable('The Desktop LLM runtime package is missing.')
  }
  const trustedDevelopmentRoot = request.trustedDevelopmentRoot
  if (trustedDevelopmentRoot !== undefined
    && (!isAbsolute(trustedDevelopmentRoot) || !isDirectory(trustedDevelopmentRoot)
      || !isRegularFile(join(trustedDevelopmentRoot, 'package.json')))) {
    return unavailable('The Desktop development checkout root is missing.')
  }
  if (request.unpackedRuntimeDir !== undefined
    && !isDirectory(request.unpackedRuntimeDir)) {
    return unavailable('The physical Desktop Codex runtime is missing.')
  }
  const trustedRoots = trustedDevelopmentRoot === undefined
    ? [request.runtimeDir]
    : [request.runtimeDir, trustedDevelopmentRoot]
  const targetPlatform = request.targetPlatform ?? process.platform
  const targetArch = request.targetArch ?? process.arch
  const target = CODEX_NATIVE_TARGETS[targetPlatform]?.[targetArch]
  if (target === undefined) return unavailable(`The Desktop runtime has no Codex package for ${targetPlatform}-${targetArch}.`)
  if (!isExecutableFile(request.nodePath, targetPlatform)) return unavailable('The Desktop primary runtime has no regular bundled Node executable.')

  let llmManifestPath: string
  let manifestPath: string
  try {
    const runtimeRequire = createRequire(join(request.runtimeDir, 'package.json'))
    llmManifestPath = runtimeRequire.resolve('@yharness/llm-pi-ai/package.json')
    manifestPath = createRequire(llmManifestPath).resolve('@openai/codex/package.json')
  } catch {
    return unavailable('The official @openai/codex package is missing from the Desktop LLM adapter.')
  }
  if (!isRegularFileWithinRoots(trustedRoots, llmManifestPath)) {
    return unavailable('The Desktop LLM adapter is outside the packaged runtime.')
  }
  const manifest = readPackageManifest(manifestPath)
  if (manifest === undefined) {
    return unavailable(`The Desktop runtime does not carry the pinned @openai/codex@${DESKTOP_CODEX_VERSION} package.`)
  }
  if (!isRegularFileWithinRoots(trustedRoots, manifestPath)) {
    return unavailable('The Desktop Codex package is outside the trusted runtime.')
  }
  if (!nativePackageIsUsable(manifestPath, trustedRoots, target, targetPlatform)) {
    return unavailable(`The Desktop runtime has no usable @openai/codex native package for ${targetPlatform}-${targetArch}.`)
  }

  const physicalManifestPath = request.unpackedRuntimeDir === undefined
    ? manifestPath
    : (() => {
      const relativeManifestPath = pathWithinRoot(request.runtimeDir, manifestPath)
      return relativeManifestPath === undefined ? undefined : join(request.unpackedRuntimeDir, relativeManifestPath)
    })()
  if (physicalManifestPath === undefined || !isRegularFileWithinRoots(
    request.unpackedRuntimeDir === undefined ? trustedRoots : [request.unpackedRuntimeDir], physicalManifestPath,
  )) return unavailable('The physical Desktop Codex package is missing.')
  let canonicalPhysicalManifestPath: string
  try { canonicalPhysicalManifestPath = realpathSync(physicalManifestPath) }
  catch { return unavailable('The physical Desktop Codex package is missing.') }
  if (request.unpackedRuntimeDir !== undefined && readPackageManifest(canonicalPhysicalManifestPath) === undefined) {
    return unavailable(`The physical Desktop runtime does not carry the pinned @openai/codex@${DESKTOP_CODEX_VERSION} package.`)
  }
  if (!nativePackageIsUsable(
    canonicalPhysicalManifestPath,
    request.unpackedRuntimeDir === undefined ? trustedRoots : [request.unpackedRuntimeDir],
    target,
    targetPlatform,
  )) {
    return unavailable(`The physical Desktop runtime has no usable @openai/codex native package for ${targetPlatform}-${targetArch}.`)
  }
  const packageRoot = dirname(canonicalPhysicalManifestPath)
  const binary = resolve(packageRoot, manifest.bin.codex)
  const packagePrefix = packageRoot.endsWith(sep) ? packageRoot : `${packageRoot}${sep}`
  if (!binary.startsWith(packagePrefix) || !isRegularPackageFile(packageRoot, binary)) {
    return unavailable('The Desktop runtime has no package-local @openai/codex wrapper.')
  }

  const dshHome = resolve(request.dshHome)
  const home = join(dshHome, 'native-codex')
  const shellHome = join(dshHome, 'native-codex-shell')
  const homeReason = privateDirectoryReason(home, 'The Desktop Codex profile')
  const shellHomeReason = privateDirectoryReason(shellHome, 'The Desktop Codex shell home')
  if (homeReason !== undefined) return unavailable(homeReason)
  if (shellHomeReason !== undefined) return unavailable(shellHomeReason)
  return {
    environment: {
      DSH_CODEX_BINARY: binary,
      DSH_CODEX_NODE: resolve(request.nodePath),
      DSH_CODEX_HOME: home,
      DSH_CODEX_SHELL_HOME: shellHome,
      DSH_CODEX_CWD: resolve(request.cwd),
    },
  }
}

/**
 * Apply the resolved Desktop-owned values when the launch environment has no
 * explicit Codex configuration. A complete explicit configuration remains
 * unchanged; partial configuration is preserved and reported instead of being
 * combined with paths from another profile.
 * @param base - login-shell environment inherited by the Desktop Host.
 * @param result - package-local resolution result.
 * @returns a copy with one complete configuration, or the unchanged explicit configuration.
 */
export function applyDesktopCodexEnvironment(
  base: NodeJS.ProcessEnv,
  result: DesktopCodexEnvironmentResult,
): NodeJS.ProcessEnv {
  const environment = { ...base }
  const explicit = DESKTOP_CODEX_ENVIRONMENT_NAMES.filter((name) => {
    const value = environment[name]
    return value !== undefined && value !== ''
  })
  if (explicit.length === DESKTOP_CODEX_ENVIRONMENT_NAMES.length) return environment
  if (explicit.length > 0) {
    console.warn(`desktop Codex backend: incomplete explicit configuration (${explicit.join(', ')}); preserving it.`)
    return environment
  }
  const {
    DSH_CODEX_BINARY: _binary,
    DSH_CODEX_NODE: _node,
    DSH_CODEX_HOME: _home,
    DSH_CODEX_SHELL_HOME: _shellHome,
    DSH_CODEX_CWD: _cwd,
    ...clearedEnvironment
  } = environment
  Object.assign(clearedEnvironment, result.environment)
  return clearedEnvironment
}
