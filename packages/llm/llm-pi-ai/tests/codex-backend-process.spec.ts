import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { JsonRpcResponseError } from '@yharness/sdk-protocol'
import type { SubprocessHandle, SubprocessOutcome } from '@yharness/subprocess'
import { spawnSubprocess } from '../../../subprocess/subprocess-local/src/spawn.ts'
import { boundedCodexInput, codexChildPath, codexProcessArguments, codexRequestFailure, prepareCodexHomeDirectories, startCodexProcess } from '../src/codex-backend-process.ts'
import { parseCodexModels } from '../src/codex-backend.ts'
it('preserves method-not-found support information without native diagnostic text or data', () => {
  const missing = codexRequestFailure('skills/list', new JsonRpcResponseError(-32601, 'sensitive diagnostic', { secret: 'hidden' }))
  expect(missing).toBeInstanceOf(JsonRpcResponseError)
  expect((missing as JsonRpcResponseError).code).toBe(-32601)
  expect((missing as JsonRpcResponseError).data).toBeUndefined()
  expect(missing.message).not.toContain('sensitive')
  const other = codexRequestFailure('skills/list', new JsonRpcResponseError(-32000, 'sensitive diagnostic', { secret: 'hidden' }))
  expect(other).not.toBeInstanceOf(JsonRpcResponseError)
  expect(other.message).not.toContain('sensitive')
})
it('closes before a native JSON line exceeds the buffer limit', async () => {
  const input = boundedCodexInput(4); input.on('error', () => {}); const error = once(input, 'error'); input.write(Buffer.from('12345')); expect(((await error)[0] as Error).message).toContain('size limit')
})
it('counts frame sizes across chunks and resets after each newline', () => {
  const input = boundedCodexInput(4); const errors: Error[] = []; input.on('error', e => errors.push(e)); input.resume(); input.write(Buffer.from('12')); input.write(Buffer.from('34\n1234\n')); expect(errors).toEqual([]); input.end()
})
it('leaves execution policy to the Harness turn, disables analytics and inherits no shell environment', () => {
  const args = codexProcessArguments({ binary: '/binary', nodePath: '/node', home: '/codex', shellHome: '/fresh', cwd: '/workspace' }); expect(args.slice(0, 3)).toEqual(['app-server', '--listen', 'stdio://']); expect(codexChildPath('C:\\Program Files\\node\\node.exe', 'win32', 'C:\\Windows')).toBe('C:\\Program Files\\node;C:\\Windows\\System32;C:\\Windows'); expect(args.join(' ')).not.toContain('sandbox_mode'); expect(args.join(' ')).not.toContain('approval_policy'); expect(args).toContain('shell_environment_policy.inherit="none"'); expect(args).toContain('analytics.enabled=false'); expect(args.join(' ')).not.toContain('web_search'); expect(args.join(' ')).not.toContain('danger-full-access')
})
it('creates isolated native and shell homes before a child starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'y-harness-codex-process-'))
  try {
    const home = join(root, 'native')
    const shellHome = join(root, 'shell')
    await prepareCodexHomeDirectories({ binary: join(root, 'codex.js'), nodePath: join(root, 'node'), home, shellHome, cwd: root })
    for (const path of [home, shellHome, join(shellHome, '.config'), join(shellHome, '.cache'), join(shellHome, 'tmp')]) {
      expect((await stat(path)).isDirectory()).toBe(true)
    }
    if (process.platform !== 'win32') expect((await stat(home)).mode & 0o777).toBe(0o700)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
it('rejects a symlinked private native home', async () => {
  if (process.platform === 'win32') return
  const root = await mkdtemp(join(tmpdir(), 'y-harness-codex-process-'))
  try {
    await mkdir(join(root, 'outside'))
    await symlink(join(root, 'outside'), join(root, 'native'))
    await expect(prepareCodexHomeDirectories({
      binary: join(root, 'codex.js'), nodePath: join(root, 'node'), home: join(root, 'native'),
      shellHome: join(root, 'shell'), cwd: root,
    })).rejects.toThrow('real directories')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
it('preserves existing private-home permissions without replacing auth data', async () => {
  if (process.platform === 'win32') return
  const root = await mkdtemp(join(tmpdir(), 'y-harness-codex-process-'))
  try {
    const home = join(root, 'native')
    const shellHome = join(root, 'shell')
    await mkdir(home)
    await mkdir(shellHome)
    await chmod(home, 0o755)
    await chmod(shellHome, 0o755)
    const authFile = join(home, 'auth.json')
    await writeFile(authFile, '{"account":"connected"}', { mode: 0o600 })
    await prepareCodexHomeDirectories({ binary: join(root, 'codex.js'), nodePath: join(root, 'node'), home, shellHome, cwd: root })
    expect((await stat(home)).mode & 0o777).toBe(0o755)
    expect((await stat(shellHome)).mode & 0o777).toBe(0o755)
    expect(await readFile(authFile, 'utf8')).toBe('{"account":"connected"}')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
it('terminates a wrapper and its native child as one process tree', async () => {
  if (process.platform === 'win32') return
  const root = await mkdtemp(join(tmpdir(), 'y-harness-codex-process-'))
  const pidFile = join(root, 'native.pid')
  const readyFile = join(root, 'native.ready')
  let nativePid: number | undefined
  try {
    const wrapper = join(root, 'wrapper.cjs')
    await writeFile(wrapper, [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(`process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(readyFile)}, String(process.pid)); setInterval(() => {}, 1000)`)}], { stdio: 'ignore' })`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`,
      'setInterval(() => {}, 1000)',
    ].join('\n'))
    const peer = await startCodexProcess(
      { binary: wrapper, nodePath: process.execPath, home: root, shellHome: root, cwd: root },
      async () => undefined, spawnSubprocess,
    )
    const started = Date.now()
    while (true) {
      try { nativePid = Number(await readFile(pidFile, 'utf8')); break }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() - started > 1_000) throw error
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
    expect(Number.isInteger(nativePid)).toBe(true)
    const ready = Date.now()
    while (true) {
      try { await readFile(readyFile); break }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() - ready > 1_000) throw error
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
    peer.close()
    const stopped = Date.now()
    while (Date.now() - stopped < 4_000) {
      try { process.kill(nativePid, 0) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('The native Codex child remained alive after closing its peer.')
  } finally {
    if (nativePid !== undefined) {
      try { process.kill(nativePid, 'SIGKILL') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
    await rm(root, { recursive: true, force: true })
  }
})
it('waits for managed quiescence before replacing the same Codex identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'y-harness-codex-process-'))
  const options = { binary: join(root, 'codex.js'), nodePath: '/node', home: join(root, 'native'), shellHome: join(root, 'shell'), cwd: root }
  const handles: Array<{ handle: SubprocessHandle; release: () => void }> = []
  const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((value) => { resolve = value })
    return { promise, resolve }
  }
  const spawnProcess = (): SubprocessHandle => {
    const done = deferred<SubprocessOutcome>()
    const quiescence = deferred<boolean>()
    const handle: SubprocessHandle = {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), control: undefined, collected: {},
      done: done.promise, terminate: () => {}, waitForExit: () => quiescence.promise,
    }
    const entry = { handle, release: () => { done.resolve({ exitCode: null, signal: 'SIGTERM' }); quiescence.resolve(true) } }
    handles.push(entry)
    return handle
  }
  try {
    const first = await startCodexProcess(options, async () => undefined, spawnProcess)
    first.close()
    let secondStarted = false
    let second: { close: () => void } | undefined
    const secondOpening = startCodexProcess(options, async () => undefined, spawnProcess).then((peer) => {
      second = peer
      secondStarted = true
    })
    await Promise.resolve()
    expect(secondStarted).toBe(false)
    expect(handles).toHaveLength(1)
    handles[0]!.release()
    await secondOpening
    expect(handles).toHaveLength(2)
    second!.close()
    handles[1]!.release()
  } finally {
    for (const entry of handles) entry.release()
    await rm(root, { recursive: true, force: true })
  }
})
const codexTarget = `${process.platform}-${process.arch}`
const supportedCodexTargets = new Set([
  'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64',
])
const actualCodexSmoke = supportedCodexTargets.has(codexTarget) ? it : it.skip
if (!supportedCodexTargets.has(codexTarget)) console.info(`Skipping Codex CLI smoke on unsupported target ${codexTarget}.`)
actualCodexSmoke('initializes the pinned package-local Codex CLI with an isolated empty account', async () => {
  const packageManifest = createRequire(import.meta.url).resolve('@openai/codex/package.json')
  const manifest = JSON.parse(await readFile(packageManifest, 'utf8')) as { version: string; bin: { codex: string } }
  expect(manifest.version).toBe('0.166.0')
  const root = await mkdtemp(join(tmpdir(), 'y-harness-codex-cli-'))
  const packageRoot = dirname(packageManifest)
  const nativePackageName = `@openai/codex-${process.platform}-${process.arch}`
  const nativeManifest = createRequire(packageManifest).resolve(`${nativePackageName}/package.json`)
  const physicalPackageRoot = join(root, 'runtime', 'node_modules', '@openai', 'codex')
  const physicalNativeRoot = join(physicalPackageRoot, 'node_modules', nativePackageName)
  await cp(packageRoot, physicalPackageRoot, { recursive: true, dereference: true })
  await cp(dirname(nativeManifest), physicalNativeRoot, { recursive: true, dereference: true })
  const options = { binary: resolve(physicalPackageRoot, manifest.bin.codex), nodePath: process.execPath, home: join(root, 'native'), shellHome: join(root, 'shell'), cwd: root }
  expect(options.binary).not.toBe(resolve(packageRoot, manifest.bin.codex))
  await prepareCodexHomeDirectories(options)
  let handle: SubprocessHandle | undefined
  const peer = await startCodexProcess(options, async () => { throw new Error('Native requests are not allowed in this smoke.') }, (spec) => {
    const child = spawnSubprocess(spec)
    handle = child
    return child
  })
  try {
    const initialized = await peer.request('initialize', { clientInfo: { name: 'y-harness-smoke', title: 'Y Harness smoke', version: '0' }, capabilities: { experimentalApi: false } })
    expect(initialized).toMatchObject({ codexHome: await realpath(options.home) })
    peer.notify('initialized')
    const models = parseCodexModels(await peer.request('model/list', { limit: 100, includeHidden: false }))
    expect(models.map(model => model.id)).toEqual(expect.arrayContaining(['gpt-6.1-sol', 'gpt-6.1-terra']))
    const account = await peer.request('account/read', { refreshToken: false })
    expect(account).toMatchObject({ account: null })
  } finally {
    peer.close()
    if (handle !== undefined) await expect(handle.waitForExit()).resolves.toBe(true)
    await rm(root, { recursive: true, force: true })
  }
})
