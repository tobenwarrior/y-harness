import { PassThrough } from 'node:stream'
import { Context } from '@yharness/cordis'
import { SubprocessExecutableNotFoundError } from '@yharness/subprocess'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@yharness/subprocess'
import LocalSubprocessRuntime from '@yharness/subprocess-local'
import { describe, expect, it, vi } from 'vitest'
import { VpsBotSubprocess } from '../src/vps-bot-process.ts'
import { VpsRuntime, type VpsExecOptions } from '../src/vps-runtime.ts'

type ExecFileCallback = (error: Error | null, result: { readonly stdout: string; readonly stderr: string }) => void
type ExecFileMock = (
  command: string,
  args: readonly string[],
  options: { readonly signal: AbortSignal; readonly timeout: number; readonly maxBuffer: number },
  callback: ExecFileCallback,
) => void

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn<ExecFileMock>() }))

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: execFileMock,
}))

const SESSION = 'bot-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const outcome: SubprocessOutcome = { exitCode: 0, signal: null }

interface ExecArgvCall {
  readonly sessionId: string
  readonly argv: readonly string[]
  readonly options: VpsExecOptions
}

interface TerminalStopCall {
  readonly sessionId: string
  readonly scope: string
  readonly graceMs: number
}

class FixtureRuntime extends VpsRuntime {
  readonly defaultSignal = new AbortController().signal
  readonly ensureCalls: string[] = []
  readonly execArgvCalls: ExecArgvCall[] = []
  readonly beginUseCalls: string[] = []
  readonly releases: Array<ReturnType<typeof vi.fn<() => void>>> = []
  readonly terminalStops: TerminalStopCall[] = []
  ensureGate: Promise<void> | undefined
  stopFailure: Error | undefined

  constructor() {
    super('/private/tmp/yh-vps-bot-process-fixture', 'fixture-image', { userService: false })
  }

  override operationSignal(signal?: AbortSignal): AbortSignal {
    return signal ?? this.defaultSignal
  }

  override async ensure(sessionId: string): Promise<void> {
    this.ensureCalls.push(sessionId)
    await this.ensureGate
  }

  override beginUse(sessionId: string): () => void {
    this.beginUseCalls.push(sessionId)
    const release = vi.fn<() => void>()
    this.releases.push(release)
    return release
  }

  override execArgv(sessionId: string, argv: readonly string[], options: VpsExecOptions = {}): readonly [string, ...string[]] {
    this.execArgvCalls.push({ sessionId, argv: [...argv], options: { ...options } })
    return ['fixture-runtime', ...argv]
  }

  override async stopTerminal(sessionId: string, scope: string, graceMs: number): Promise<void> {
    this.terminalStops.push({ sessionId, scope, graceMs })
    if (this.stopFailure !== undefined) throw this.stopFailure
  }
}

function processHandle(done: Promise<SubprocessOutcome>): SubprocessHandle {
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: {},
    done,
    terminate: vi.fn<() => void>(),
    waitForExit: vi.fn<(signal?: AbortSignal) => Promise<boolean>>().mockResolvedValue(true),
  }
}

function terminalHandle(done: Promise<SubprocessOutcome>): {
  readonly handle: SubprocessTerminalHandle
  readonly terminate: ReturnType<typeof vi.fn>
} {
  const terminate = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  return {
    handle: {
      pid: 42,
      output: new PassThrough(),
      done,
      write: vi.fn<(data: string) => Promise<void>>().mockResolvedValue(undefined),
      resize: vi.fn<(cols: number, rows: number) => Promise<void>>().mockResolvedValue(undefined),
      inspectActivity: vi.fn<() => Promise<{ readonly state: 'unknown'; readonly revision: number }>>()
        .mockResolvedValue({ state: 'unknown', revision: 0 }),
      inspectForeground: vi.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
      signalForeground: vi.fn<() => Promise<number>>().mockResolvedValue(42),
      terminate,
    },
    terminate,
  }
}

function processSpec(): SubprocessSpawnSpec {
  return {
    argv: ['/bin/echo', 'fixture'],
    cwd: '/workspace',
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 250,
  }
}

function terminalSpec(): SubprocessTerminalSpawnSpec {
  return {
    argv: ['/bin/bash', '-i'],
    cwd: '/workspace',
    rows: 24,
    cols: 80,
    terminalType: 'xterm-256color',
    graceMs: 250,
  }
}

function providerFixture(): {
  readonly runtime: FixtureRuntime
  readonly host: LocalSubprocessRuntime
  readonly provider: VpsBotSubprocess
} {
  const ctx = new Context()
  const runtime = new FixtureRuntime()
  const host = new LocalSubprocessRuntime(ctx)
  const provider = new VpsBotSubprocess(ctx.isolate('subprocess'), { runtime, sessionId: SESSION, host })
  return { runtime, host, provider }
}

describe('VpsBotSubprocess executable resolution', () => {
  it('rejects unsafe commands, resolves absolute output, and cleans up failed lookups', async () => {
    const { runtime, provider } = providerFixture()
    execFileMock.mockReset()
    await expect(provider.resolveExecutable('')).rejects.toBeInstanceOf(SubprocessExecutableNotFoundError)
    await expect(provider.resolveExecutable('bad\u0000command')).rejects.toBeInstanceOf(SubprocessExecutableNotFoundError)
    await expect(provider.resolveExecutable('./relative')).rejects.toBeInstanceOf(SubprocessExecutableNotFoundError)

    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null, { stdout: '/usr/bin/bash\n', stderr: '' })
    })
    const signal = new AbortController().signal
    await expect(provider.resolveExecutable('bash', { PATH: '/fixture' }, signal)).resolves.toBe('/usr/bin/bash')
    expect(runtime.ensureCalls).toEqual([SESSION])
    expect(runtime.execArgvCalls[0]).toEqual({
      sessionId: SESSION,
      argv: [
        '/bin/bash', '-c',
        'if [[ "$1" == /* ]]; then [[ -f "$1" && -x "$1" ]] && printf "%s\\n" "$1"; else type -P -- "$1"; fi',
        'bash', 'bash',
      ],
      options: {},
    })
    const execCall = execFileMock.mock.calls[0]
    if (execCall === undefined) throw new Error('executable lookup was not attempted')
    expect(execCall[0]).toBe('fixture-runtime')
    expect(execCall[1]).toEqual(runtime.execArgvCalls[0]?.argv)
    expect(execCall[2].signal).toBe(signal)
    expect(execCall[2].timeout).toBe(10_000)
    expect(execCall[2].maxBuffer).toBe(4096)
    expect(runtime.releases.at(-1)).toHaveBeenCalledOnce()

    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null, { stdout: 'bash\n', stderr: '' })
    })
    await expect(provider.resolveExecutable('bash')).rejects.toBeInstanceOf(SubprocessExecutableNotFoundError)
    expect(runtime.releases.at(-1)).toHaveBeenCalledOnce()

    const lookupFailure = new Error('lookup failed')
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(lookupFailure, { stdout: '', stderr: '' })
    })
    await expect(provider.resolveExecutable('bash')).rejects.toBeInstanceOf(SubprocessExecutableNotFoundError)
    expect(runtime.releases.at(-1)).toHaveBeenCalledOnce()

    const aborted = new AbortController()
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      aborted.abort(new Error('lookup cancelled'))
      callback(lookupFailure, { stdout: '', stderr: '' })
    })
    await expect(provider.resolveExecutable('bash', {}, aborted.signal)).rejects.toThrow('lookup cancelled')
  })

  it('reports the fixed terminal environment and refuses an aborted lookup', async () => {
    const { provider } = providerFixture()
    await expect(provider.terminalEnvironment()).resolves.toEqual({ platform: 'posix', defaultShell: '/bin/bash' })
    const controller = new AbortController()
    controller.abort(new Error('environment cancelled'))
    expect(() => provider.terminalEnvironment(controller.signal)).toThrow('environment cancelled')
  })
})

describe('VpsBotSubprocess process spawning', () => {
  it('rejects control descriptors, forwards argv-only process specs, and releases failed hosts', async () => {
    const { runtime, host, provider } = providerFixture()
    const spawn = vi.spyOn(host, 'spawn')
    const spec = processSpec()
    expect(() => provider.spawn({ ...spec, stdio: { ...spec.stdio, control: 'pipe' } })).toThrow('control descriptors')
    expect(spawn).not.toHaveBeenCalled()

    const firstDone = Promise.withResolvers<SubprocessOutcome>()
    spawn.mockReturnValueOnce(processHandle(firstDone.promise))
    const first = provider.spawn(spec)
    const passed = spawn.mock.calls[0]?.[0]
    if (passed === undefined) throw new Error('host process was not spawned')
    expect(passed).toMatchObject({ cwd: '/', env: undefined, stdio: spec.stdio, signal: runtime.defaultSignal })
    expect(passed.argv).toEqual(['fixture-runtime', ...spec.argv])
    expect(runtime.execArgvCalls.at(-1)).toEqual({
      sessionId: SESSION, argv: spec.argv, options: { workdir: spec.cwd, stdin: false },
    })
    firstDone.resolve(outcome)
    await expect(first.done).resolves.toBe(outcome)
    await Promise.resolve()
    expect(runtime.releases.at(-1)).toHaveBeenCalledOnce()

    const pipeSpec: SubprocessSpawnSpec = {
      ...spec, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
    }
    const secondDone = Promise.withResolvers<SubprocessOutcome>()
    spawn.mockReturnValueOnce(processHandle(secondDone.promise))
    const second = provider.spawn(pipeSpec)
    expect(runtime.execArgvCalls.at(-1)?.options).toEqual({ workdir: pipeSpec.cwd, stdin: true })
    secondDone.reject(new Error('child failed'))
    await expect(second.done).rejects.toThrow('child failed')
    await Promise.resolve()
    expect(runtime.releases.at(-1)).toHaveBeenCalledOnce()

    const hostFailure = new Error('host spawn failed')
    spawn.mockImplementationOnce(() => { throw hostFailure })
    expect(() => provider.spawn(spec)).toThrow(hostFailure)
    expect(runtime.releases.at(-1)).toHaveBeenCalledOnce()

    const aborted = new AbortController()
    aborted.abort(new Error('process cancelled'))
    expect(() => provider.spawn({ ...spec, signal: aborted.signal })).toThrow('process cancelled')
  })
})

describe('VpsBotSubprocess terminal spawning', () => {
  it('starts and closes a scoped terminal, including automatic process cleanup', async () => {
    const { runtime, host, provider } = providerFixture()
    const spawnTerminal = vi.spyOn(host, 'spawnTerminal')
    const hostDone = Promise.withResolvers<SubprocessOutcome>()
    const fixture = terminalHandle(hostDone.promise)
    spawnTerminal.mockResolvedValue(fixture.handle)
    const scoped = await provider.spawnTerminal(terminalSpec())
    const passed = spawnTerminal.mock.calls[0]?.[0]
    if (passed === undefined) throw new Error('host terminal was not spawned')
    expect(passed).toMatchObject({ cwd: '/', env: undefined, rows: 24, cols: 80, signal: runtime.defaultSignal })
    expect(passed.argv.slice(0, 4)).toEqual(['fixture-runtime', '/usr/bin/python3', '-I', '-c'])
    expect(passed.argv.at(-5)).toBe('start')
    expect(passed.argv.at(-4)).toMatch(/^[0-9a-f]{32}$/u)
    expect(runtime.ensureCalls).toEqual([SESSION])
    expect(runtime.execArgvCalls.at(-1)?.options).toEqual({ workdir: '/workspace', interactive: true })

    await expect(scoped.terminate()).resolves.toBeUndefined()
    expect(runtime.terminalStops).toEqual([{ sessionId: SESSION, scope: passed.argv.at(-4), graceMs: 250 }])
    expect(fixture.terminate).toHaveBeenCalledOnce()

    hostDone.resolve(outcome)
    await expect(scoped.done).resolves.toBe(outcome)
    await Promise.resolve()
    expect(runtime.releases.at(-1)).toHaveBeenCalledOnce()
  })

  it('aborts before allocation and preserves launch errors after successful cleanup', async () => {
    const { host, provider, runtime } = providerFixture()
    const spawnTerminal = vi.spyOn(host, 'spawnTerminal')
    const spec = terminalSpec()
    const aborted = new AbortController()
    aborted.abort(new Error('terminal allocation cancelled'))
    await expect(provider.spawnTerminal({ ...spec, signal: aborted.signal })).rejects.toThrow('terminal allocation cancelled')
    expect(spawnTerminal).not.toHaveBeenCalled()

    const launchFailure = new Error('terminal launch failed')
    spawnTerminal.mockRejectedValueOnce(launchFailure)
    await expect(provider.spawnTerminal(spec)).rejects.toBe(launchFailure)
    expect(runtime.terminalStops).toHaveLength(1)
    expect(runtime.releases.at(-1)).toHaveBeenCalledOnce()
  })

  it('reports both launch and terminal cleanup failures', async () => {
    const { host, provider, runtime } = providerFixture()
    vi.spyOn(host, 'spawnTerminal').mockRejectedValue(new Error('terminal launch failed'))
    runtime.stopFailure = new Error('container stop failed')
    const failure = await provider.spawnTerminal(terminalSpec()).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error('expected aggregate launch cleanup failure')
    expect(failure.errors).toHaveLength(2)
    expect(runtime.terminalStops).toHaveLength(1)
    expect(runtime.releases.at(-1)).toHaveBeenCalledOnce()
  })
})
