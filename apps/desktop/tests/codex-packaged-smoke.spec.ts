import { createInterface } from 'node:readline'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { runtimeArchivePath } from '../../desktop-host/src/office-engine.ts'
import { resolveDesktopCodexEnvironment } from '../src/codex-environment.ts'

interface AsarFileStat {
  readonly unpacked?: boolean
}

interface AsarTools {
  readonly createPackageWithOptions: (
    source: string,
    destination: string,
    options: { readonly unpack: string },
  ) => Promise<void>
  readonly listPackage: (archive: string) => string[]
  readonly statFile: (archive: string, path: string) => AsarFileStat
}

interface CodexNativeTarget {
  readonly packageName: string
  readonly triple: string
  readonly executable: string
}

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const roots: string[] = []
const targets: Readonly<Record<string, CodexNativeTarget>> = {
  'darwin-arm64': { packageName: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin', executable: 'codex' },
  'darwin-x64': { packageName: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin', executable: 'codex' },
  'linux-arm64': { packageName: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl', executable: 'codex' },
  'linux-x64': { packageName: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl', executable: 'codex' },
  'win32-arm64': { packageName: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc', executable: 'codex.exe' },
  'win32-x64': { packageName: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc', executable: 'codex.exe' },
}

const asarUnpackPatterns = [
  '**/node_modules/@yharness/llm-pi-ai/package.json',
  '**/node_modules/@openai/codex/**',
  '**/node_modules/@openai/codex-*/**',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asarTools(): AsarTools {
  const appBuilderManifest = realpathSync(join(repository, 'apps', 'desktop', 'node_modules', 'app-builder-lib', 'package.json'))
  return createRequire(appBuilderManifest)('@electron/asar') as AsarTools
}

async function copyExecutable(source: string, destination: string): Promise<void> {
  await copyFile(realpathSync(source), destination)
  if (process.platform !== 'win32') await chmod(destination, 0o755)
}

async function prepareCodexTree(root: string, target: CodexNativeTarget): Promise<{
  readonly runtime: string
  readonly wrapper: string
  readonly nativeExecutable: string
}> {
  const sourceRequire = createRequire(join(repository, 'packages', 'llm', 'llm-pi-ai', 'package.json'))
  const sourceManifest = sourceRequire.resolve('@openai/codex/package.json')
  const sourceRoot = dirname(sourceManifest)
  const sourceNativeManifest = createRequire(sourceManifest).resolve(`${target.packageName}/package.json`)
  const sourceNativeRoot = dirname(sourceNativeManifest)
  const runtime = join(root, 'dsh')
  const llmRoot = join(runtime, 'node_modules', '@yharness', 'llm-pi-ai')
  const wrapperRoot = join(llmRoot, 'node_modules', '@openai', 'codex')
  const nativeRoot = join(llmRoot, 'node_modules', '@openai', target.packageName.slice('@openai/'.length))
  const nativeExecutable = join(nativeRoot, 'vendor', target.triple, 'bin', target.executable)
  await mkdir(join(wrapperRoot, 'bin'), { recursive: true })
  await mkdir(join(nativeRoot, 'vendor', target.triple, 'bin'), { recursive: true })
  await writeFile(join(runtime, 'package.json'), '{"name":"@yharness/dsh-runtime","private":true}\n')
  await writeFile(join(llmRoot, 'package.json'), '{"name":"@yharness/llm-pi-ai","version":"0.2.1-rc.2"}\n')
  await copyFile(join(sourceRoot, 'package.json'), join(wrapperRoot, 'package.json'))
  await copyFile(join(sourceRoot, 'bin', 'codex.js'), join(wrapperRoot, 'bin', 'codex.js'))
  await copyFile(join(sourceNativeRoot, 'package.json'), join(nativeRoot, 'package.json'))
  await copyExecutable(
    join(sourceNativeRoot, 'vendor', target.triple, 'bin', target.executable),
    nativeExecutable,
  )
  return { runtime, wrapper: join(wrapperRoot, 'bin', 'codex.js'), nativeExecutable }
}

async function readRpcResponse(iterator: AsyncIterator<string>, id: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000
  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`Timed out waiting for Codex JSON-RPC response ${id}.`)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const next = iterator.next()
      const result = await Promise.race([
        next,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out waiting for Codex JSON-RPC response ${id}.`)), remaining)
        }),
      ])
      if (result.done) throw new Error('Codex app-server closed its protocol stream before replying.')
      let message: unknown
      try { message = JSON.parse(result.value) }
      catch { continue }
      if (isRecord(message) && message.id === id) return message
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

function sendRpcRequest(child: ChildProcess, id: number, method: string, params: Record<string, unknown>): void {
  child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  child.kill('SIGTERM')
  const timeout = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 2_000)
  try { await closed }
  finally { clearTimeout(timeout) }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('packaged Codex runtime', () => {
  const target = targets[`${process.platform}-${process.arch}`]
  const packagedSmoke = target === undefined ? it.skip : it
  if (target === undefined) console.info(`Skipping packaged Codex smoke on unsupported target ${process.platform}-${process.arch}.`)

  packagedSmoke('packs the wrapper into ASAR-unpacked resources and launches it with standalone Node', async () => {
    const root = await mkdtemp(join(tmpdir(), 'y-harness-codex-packaged-'))
    roots.push(root)
    const resources = join(root, 'resources')
    const archiveInput = join(root, 'asar-input')
    await mkdir(archiveInput, { recursive: true })
    await writeFile(join(archiveInput, 'package.json'), '{"name":"@yharness/desktop-artifact","private":true}\n')
    const prepared = await prepareCodexTree(archiveInput, target!)
    const archive = join(resources, 'app.asar')
    await mkdir(resources, { recursive: true })
    const unpack = `{${asarUnpackPatterns.join(',')}}`
    await asarTools().createPackageWithOptions(archiveInput, archive, { unpack })

    expect(runtimeArchivePath(join(archive, 'dsh'))).toBe(archive)
    const unpackedRuntime = join(`${archive}.unpacked`, 'dsh')
    const unpackedWrapper = join(unpackedRuntime, 'node_modules', '@yharness', 'llm-pi-ai', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    const unpackedNative = join(unpackedRuntime, 'node_modules', '@yharness', 'llm-pi-ai', 'node_modules', '@openai', target!.packageName.slice('@openai/'.length), 'vendor', target!.triple, 'bin', target!.executable)
    const archiveEntries = asarTools().listPackage(archive)
    expect(archiveEntries).toContain('/dsh/node_modules/@yharness/llm-pi-ai/node_modules/@openai/codex/bin/codex.js')
    expect(asarTools().statFile(archive, 'dsh/node_modules/@yharness/llm-pi-ai/node_modules/@openai/codex/bin/codex.js').unpacked).toBe(true)
    expect(asarTools().statFile(archive, `dsh/node_modules/@yharness/llm-pi-ai/node_modules/@openai/${target!.packageName.slice('@openai/'.length)}/vendor/${target!.triple}/bin/${target!.executable}`).unpacked).toBe(true)
    await expect(stat(unpackedWrapper)).resolves.toBeDefined()
    await expect(stat(unpackedNative)).resolves.toBeDefined()
    expect(prepared.wrapper).not.toBe(unpackedWrapper)
    expect(prepared.nativeExecutable).not.toBe(unpackedNative)

    const home = join(root, 'y-harness-home')
    const cwd = join(root, 'profile')
    await mkdir(cwd, { recursive: true })
    const result = resolveDesktopCodexEnvironment({
      runtimeDir: prepared.runtime,
      unpackedRuntimeDir: unpackedRuntime,
      dshHome: home,
      cwd,
      nodePath: process.execPath,
      targetPlatform: process.platform,
      targetArch: process.arch,
    })
    expect(result.reason).toBeUndefined()
    const binary = result.environment.DSH_CODEX_BINARY
    const codexHome = result.environment.DSH_CODEX_HOME
    const shellHome = result.environment.DSH_CODEX_SHELL_HOME
    if (binary === undefined || codexHome === undefined || shellHome === undefined) throw new Error('Packaged Codex environment did not resolve complete launch paths.')
    expect(binary).toBe(realpathSync(unpackedWrapper))
    await mkdir(codexHome, { recursive: true })
    await mkdir(join(shellHome, '.config'), { recursive: true })
    await mkdir(join(shellHome, '.cache'), { recursive: true })
    await mkdir(join(shellHome, 'tmp'), { recursive: true })
    const childPath = [dirname(process.execPath), '/usr/bin', '/bin'].join(process.platform === 'win32' ? ';' : ':')
    const child = spawn(process.execPath, [binary, 'app-server', '--listen', 'stdio://',
      '-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false', '-c', 'history.persistence="none"',
      '-c', 'shell_environment_policy.inherit="none"',
      '-c', `shell_environment_policy.set={HOME=${JSON.stringify(shellHome)},PATH=${JSON.stringify(childPath)}}`,
    ], {
      cwd,
      env: {
        PATH: childPath,
        HOME: shellHome,
        CODEX_HOME: codexHome,
        XDG_CONFIG_HOME: join(shellHome, '.config'),
        XDG_CACHE_HOME: join(shellHome, '.cache'),
        ZDOTDIR: shellHome,
        TMPDIR: join(shellHome, 'tmp'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.on('error', () => undefined)
    child.stderr?.resume()
    if (child.stdout === null || child.stdin === null) {
      await stopChild(child)
      throw new Error('The standalone Codex process did not expose protocol streams.')
    }
    const lines = createInterface({ input: child.stdout })
    try {
      sendRpcRequest(child, 1, 'initialize', {
        clientInfo: { name: 'y-harness-packaged-smoke', title: 'Y Harness packaged smoke', version: '0' },
        capabilities: { experimentalApi: false },
      })
      const initialized = await readRpcResponse(lines[Symbol.asyncIterator](), 1)
      expect(initialized.error).toBeUndefined()
      expect(initialized.result).toMatchObject({ codexHome: realpathSync(codexHome) })
      child.stdin.write('{"jsonrpc":"2.0","method":"initialized","params":{}}\n')
      sendRpcRequest(child, 2, 'account/read', { refreshToken: false })
      const account = await readRpcResponse(lines[Symbol.asyncIterator](), 2)
      expect(account.error).toBeUndefined()
      expect(account.result).toMatchObject({ account: null })
    } finally {
      lines.close()
      await stopChild(child)
    }
  })
})
