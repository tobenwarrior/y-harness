import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@yharness/cordis'
import {
  SubprocessExecutableNotFoundError,
  SubprocessRuntime,
  type SubprocessHandle,
  type SubprocessSpawnSpec,
  type SubprocessTerminalEnvironment,
  type SubprocessTerminalHandle,
  type SubprocessTerminalSpawnSpec,
} from '@yharness/subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VpsBotSubprocess } from '../src/vps-bot-process.ts'
import { VpsRuntime } from '../src/vps-runtime.ts'

interface ExecOptions {
  readonly signal?: AbortSignal
  readonly timeout?: number
  readonly maxBuffer?: number
}

interface ExecResult {
  readonly stdout: string
  readonly stderr: string
}

interface ExecCall {
  readonly program: string
  readonly argv: readonly string[]
  readonly options: ExecOptions
}

type ExecPromise = Promise<ExecResult> & { child: object }
type ExecHandler = (call: ExecCall) => ExecResult | Promise<ExecResult>

const execState = vi.hoisted(() => {
  const calls: ExecCall[] = []
  let handler: ExecHandler = () => ({ stdout: '', stderr: '' })
  const execFileMock = vi.fn()
  Object.defineProperty(execFileMock, Symbol.for('nodejs.util.promisify.custom'), {
    value: (program: string, argv: readonly string[], options: ExecOptions): ExecPromise => {
      const call: ExecCall = { program, argv: [...argv], options }
      calls.push(call)
      let onAbort: (() => void) | undefined
      let settled = false
      const promise = new Promise<ExecResult>((resolve, reject) => {
        const finish = (complete: () => void): void => {
          if (settled) return
          settled = true
          if (onAbort !== undefined) options.signal?.removeEventListener('abort', onAbort)
          complete()
        }
        onAbort = () => {
          finish(() => { reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })) })
        }
        if (options.signal?.aborted) onAbort()
        else options.signal?.addEventListener('abort', onAbort, { once: true })
        void Promise.resolve().then(() => handler(call)).then(
          (result) => {
            finish(() => { resolve(result) })
          },
          (error: unknown) => {
            const reason = error instanceof Error ? error : new Error(String(error))
            finish(() => { reject(reason) })
          },
        )
      }) as ExecPromise
      promise.child = {}
      return promise
    },
  })
  return {
    calls,
    execFileMock,
    setHandler(next: ExecHandler): void { handler = next },
    reset(): void {
      calls.length = 0
      handler = () => ({ stdout: '', stderr: '' })
      execFileMock.mockReset()
    },
  }
})

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: execState.execFileMock,
}))

const sessionId = 'bot-session-0e9beecd-b6f5-40b1-8d52-f97259bdcf76'
const roots: string[] = []
const contexts: Context[] = []

class HostRuntime extends SubprocessRuntime {
  readonly specs: SubprocessSpawnSpec[] = []
  readonly handles: SubprocessHandle[] = []

  override async resolveExecutable(): Promise<string> {
    throw new Error('The host fixture does not resolve executables.')
  }

  override terminalEnvironment(): Promise<SubprocessTerminalEnvironment> {
    return Promise.resolve({ platform: 'posix' })
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    const handle: SubprocessHandle = {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      control: undefined,
      collected: {},
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: () => {},
      waitForExit: async () => true,
    }
    this.handles.push(handle)
    return handle
  }

  override spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new Error('The host fixture does not open terminals.'))
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  execState.reset()
  vi.restoreAllMocks()
})

function stdout(value: string): ExecResult {
  return { stdout: value, stderr: '' }
}

async function fixture(): Promise<{
  root: string
  workspace: string
  runtime: VpsRuntime
  host: HostRuntime
  process: VpsBotSubprocess
}> {
  const root = await mkdtemp(join(tmpdir(), 'yh-bot-process-'))
  roots.push(root)
  const runtime = new VpsRuntime(root, 'localhost/test')
  const workspace = runtime.workspace(sessionId)
  vi.spyOn(runtime, 'ensure').mockResolvedValue()
  const execArgv = vi.spyOn(runtime, 'execArgv')
  const hostContext = new Context()
  const processContext = new Context()
  contexts.push(hostContext, processContext)
  const host = new HostRuntime(hostContext)
  const process = new VpsBotSubprocess(processContext, { runtime, sessionId, host })
  return { root, workspace, runtime, execArgv, host, process }
}

function spawnSpec(workspace: string, stdin: SubprocessSpawnSpec['stdio']['stdin'] = 'pipe'): SubprocessSpawnSpec {
  return {
    argv: ['node', '-e', 'process.stdout.write("safe; argv")'],
    cwd: join(workspace, 'nested'),
    stdio: { stdin, stdout: 'pipe', stderr: 'inherit' },
    graceMs: 250,
    env: { VPS_TEST_VALUE: 'explicit' },
  }
}

describe('VPS Bot subprocess provider', () => {
  it('resolves bare and absolute executables with the exact VPS lookup argv', async () => {
    const f = await fixture()
    execState.setHandler(() => stdout('/usr/bin/node\n'))
    await expect(f.process.resolveExecutable('node')).resolves.toBe('/usr/bin/node')
    expect(f.execArgv).toHaveBeenCalledWith(sessionId, [
      '/bin/bash', '-c', 'if [[ "$1" == /* ]]; then [[ -f "$1" && -x "$1" ]] && printf "%s\\n" "$1"; else type -P -- "$1"; fi', 'bash', 'node',
    ])
    const lookup = execState.calls[0]
    expect(lookup?.program).toBe('/usr/bin/env')
    expect(lookup?.argv).toContain('/bin/bash')
    expect(lookup?.argv).toContain('node')
    expect(lookup?.options.timeout).toBe(10_000)
    await expect(f.process.resolveExecutable('/usr/bin/node')).resolves.toBe('/usr/bin/node')
  })

  it('returns a safe not-found error for invalid, missing and malformed lookups', async () => {
    const f = await fixture()
    await expect(f.process.resolveExecutable('')).rejects.toBeInstanceOf(SubprocessExecutableNotFoundError)
    await expect(f.process.resolveExecutable('./relative')).rejects.toBeInstanceOf(SubprocessExecutableNotFoundError)
    await expect(f.process.resolveExecutable('node\u0000tool')).rejects.toBeInstanceOf(SubprocessExecutableNotFoundError)

    execState.setHandler(() => stdout('relative/path\n'))
    await expect(f.process.resolveExecutable('missing')).rejects.toBeInstanceOf(SubprocessExecutableNotFoundError)
    execState.setHandler(() => { throw new Error('host stderr with secret') })
    await expect(f.process.resolveExecutable('also-missing')).rejects.toBeInstanceOf(SubprocessExecutableNotFoundError)
  })

  it('honors abort before and during remote executable lookup', async () => {
    const f = await fixture()
    const before = new AbortController()
    before.abort(new Error('caller closed'))
    await expect(f.process.resolveExecutable('node', undefined, before.signal)).rejects.toThrow('caller closed')
    expect(execState.calls).toHaveLength(0)

    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { release = resolve })
    execState.setHandler(async () => {
      await blocked
      return stdout('/usr/bin/node\n')
    })
    const during = new AbortController()
    const lookup = f.process.resolveExecutable('node', undefined, during.signal)
    await Promise.resolve()
    during.abort(new Error('lookup cancelled'))
    await expect(lookup).rejects.toThrow('lookup cancelled')
    release?.()
    await new Promise<void>((resolve) => { queueMicrotask(resolve) })
  })

  it('reports terminal environment and checks cancellation before returning it', async () => {
    const f = await fixture()
    await expect(f.process.terminalEnvironment()).resolves.toEqual({ platform: 'posix', defaultShell: '/bin/bash' })
    const abort = new AbortController()
    abort.abort(new Error('terminal closed'))
    expect(() => f.process.terminalEnvironment(abort.signal)).toThrow('terminal closed')
  })

  it('wraps child argv, selected cwd and stdin mode for the host runtime', async () => {
    const f = await fixture()
    const spec = spawnSpec(f.workspace)
    const handle = f.process.spawn(spec)
    expect(handle).toBe(f.host.handles[0])
    expect(f.execArgv).toHaveBeenCalledWith(sessionId, spec.argv, { workdir: spec.cwd, stdin: true })
    expect(f.host.specs[0]).toMatchObject({ cwd: '/', env: undefined, stdio: spec.stdio, graceMs: spec.graceMs })
    expect(f.host.specs[0]?.argv).toEqual(expect.arrayContaining(['/usr/bin/podman', 'exec', '--workdir', spec.cwd, ...spec.argv]))

    f.process.spawn(spawnSpec(f.workspace, 'ignore'))
    expect(f.execArgv).toHaveBeenLastCalledWith(sessionId, spec.argv, { workdir: spec.cwd, stdin: false })
  })

  it('rejects host control descriptors and interactive terminals safely', async () => {
    const f = await fixture()
    const controlSpec: SubprocessSpawnSpec = { ...spawnSpec(f.workspace), stdio: { ...spawnSpec(f.workspace).stdio, control: 'pipe' } }
    expect(() => f.process.spawn(controlSpec)).toThrow('does not forward host control descriptors')
    expect(f.host.specs).toHaveLength(0)
    await expect(f.process.spawnTerminal({
      argv: ['bash'], cwd: f.workspace, rows: 24, cols: 80, terminalType: 'xterm-256color', graceMs: 100,
    })).rejects.toThrow('Computer panel')
  })
})
