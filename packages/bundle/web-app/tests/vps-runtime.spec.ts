import { EventEmitter } from 'node:events'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { VpsRuntime, VpsRuntimeError, type VpsCommandResult } from '../src/vps-runtime.ts'

const sessions = {
  alice: 'bot-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  bob: 'bot-session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
} as const

const roots: string[] = []

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  spawnMock.mockReset()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Fixture {
  root: string
  calls: string[][]
  runtime: VpsRuntime
}

class FakeStream extends EventEmitter {
  readonly encodings: string[] = []

  setEncoding(encoding: string): void {
    this.encodings.push(encoding)
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()
  readonly killed: (NodeJS.Signals | number | undefined)[] = []

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed.push(signal)
    return true
  }
}

interface SpawnCall {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv | undefined
  stdio: unknown
  child: FakeChild
}

function result(code = 0, stdout = ''): VpsCommandResult {
  return { code, stdout, stderr: '' }
}

function fixture(
  run: (argv: readonly string[]) => Promise<VpsCommandResult> | VpsCommandResult = async (argv) => {
    if (argv[1] === 'container' && argv[2] === 'exists') return result(1)
    return result()
  },
  volumeRun?: (argv: readonly string[]) => Promise<VpsCommandResult> | VpsCommandResult,
): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-vps-runtime-'))
  roots.push(root)
  const calls: string[][] = []
  const defaultVolumeCommand = async (argv: readonly string[]): Promise<VpsCommandResult> => {
    if (argv[2] === 'exists') return result(1)
    if (argv[2] === 'create') return result(0, `${argv.at(-1) ?? ''}\n`)
    const volume = argv.at(-1) ?? ''
    const session = volume.includes('botsessionbbbb') ? sessions.bob : sessions.alice
    return result(0, JSON.stringify({
      Name: volume,
      Labels: {
        'io.yharness.vps.root': root,
        'io.yharness.vps.image': 'localhost/yharness-vps-bot:24.04',
        'io.yharness.vps.session': session,
        'io.yharness.vps.workspace': runtime.workspace(session),
      },
    }))
  }
  const runtime = new VpsRuntime(root, 'localhost/yharness-vps-bot:24.04', {
    run: async (argv) => {
      calls.push([...argv])
      if (argv[1] === 'volume') return await (volumeRun?.(argv) ?? defaultVolumeCommand(argv))
      return await run(argv)
    },
  })
  return { root, calls, runtime }
}

function bareFixture(): { root: string; runtime: VpsRuntime } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-vps-runtime-'))
  roots.push(root)
  return { root, runtime: new VpsRuntime(root, 'localhost/yharness-vps-bot:24.04') }
}

function podmanResult(root: string, runtime: VpsRuntime, argv: readonly string[]): VpsCommandResult {
  if (argv[1] === 'container' && argv[2] === 'exists') return result(1)
  if (argv[1] === 'volume' && argv[2] === 'exists') return result(1)
  if (argv[1] === 'volume' && argv[2] === 'create') return result(0, `${argv.at(-1) ?? ''}\n`)
  if (argv[1] === 'volume' && argv[2] === 'inspect') {
    const volume = argv.at(-1) ?? ''
    return result(0, JSON.stringify({
      Name: volume,
      Labels: {
        'io.yharness.vps.root': root,
        'io.yharness.vps.image': 'localhost/yharness-vps-bot:24.04',
        'io.yharness.vps.session': sessions.alice,
        'io.yharness.vps.workspace': runtime.workspace(sessions.alice),
      },
    }))
  }
  return result()
}

function installSpawn(
  respond: (argv: readonly string[], child: FakeChild) => void,
): SpawnCall[] {
  const calls: SpawnCall[] = []
  spawnMock.mockImplementation((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; stdio?: unknown }) => {
    const child = new FakeChild()
    calls.push({ command, args: [...args], env: options.env, stdio: options.stdio, child })
    respond([command, ...args], child)
    return child
  })
  return calls
}

function finishChild(child: FakeChild, code: number | null, stdout = '', stderr = ''): void {
  queueMicrotask(() => {
    if (stdout !== '') child.stdout.emit('data', stdout)
    if (stderr !== '') child.stderr.emit('data', stderr)
    child.emit('close', code)
  })
}

function volumeInspection(f: Fixture, argv: readonly string[], session = sessions.alice): VpsCommandResult {
  const volume = argv.at(-1) ?? ''
  return result(0, JSON.stringify({
    Name: volume,
    Labels: {
      'io.yharness.vps.root': f.root,
      'io.yharness.vps.image': 'localhost/yharness-vps-bot:24.04',
      'io.yharness.vps.session': session,
      'io.yharness.vps.workspace': f.runtime.workspace(session),
    },
  }))
}

function containerLabels(f: Fixture, argv: readonly string[]): Record<string, string> {
  const name = argv.at(-1) ?? ''
  const volume = `yharness-bot-volume-${name.replace(/^yharness-bot-/u, '')}`
  const workspace = f.runtime.workspace(sessions.alice)
  return {
    'io.yharness.vps.root': f.root,
    'io.yharness.vps.image': 'localhost/yharness-vps-bot:24.04',
    'io.yharness.vps.session': sessions.alice,
    'io.yharness.vps.workspace': workspace,
    'io.yharness.vps.volume': volume,
  }
}

interface ContainerInspectionOptions {
  readonly running?: boolean
  readonly useModeFields?: boolean
  readonly useMountForTmpfs?: boolean
  readonly userns?: string
}

function containerInspectionPayload(
  f: Fixture,
  argv: readonly string[],
  options: ContainerInspectionOptions = {},
): Record<string, unknown> {
  const name = argv.at(-1) ?? ''
  const volume = `yharness-bot-volume-${name.replace(/^yharness-bot-/u, '')}`
  const workspace = f.runtime.workspace(sessions.alice)
  const workspaceMount = options.useModeFields === true
    ? { Type: 'volume', Name: volume, Destination: workspace, RW: true, Mode: 'rw,nodev,nosuid,rbind' }
    : { Type: 'volume', Name: volume, Destination: workspace, RW: true, Options: ['nodev', 'nosuid', 'rbind'] }
  const mounts = options.useMountForTmpfs === true
    ? [workspaceMount, { Type: 'tmpfs', Destination: '/tmp', Mode: 'rw,noexec,nosuid,nodev,rprivate' }]
    : [workspaceMount]
  const hostConfig: Record<string, unknown> = {
    NetworkMode: 'none',
    Privileged: false,
    SecurityOpt: ['no-new-privileges'],
    CapDrop: ['ALL'],
    UsernsMode: options.userns ?? 'private',
  }
  if (options.useMountForTmpfs !== true) hostConfig.Tmpfs = { '/tmp': 'rw,noexec,nosuid,nodev,rprivate,tmpcopyup' }
  return {
    ...(options.useMountForTmpfs === true ? {} : { ImageName: 'localhost/yharness-vps-bot:24.04' }),
    Config: {
      Image: 'localhost/yharness-vps-bot:24.04',
      User: '1000:1000',
      Labels: containerLabels(f, argv),
    },
    State: { Running: options.running ?? true },
    Mounts: mounts,
    HostConfig: hostConfig,
  }
}

function containerInspection(
  f: Fixture,
  argv: readonly string[],
  options: ContainerInspectionOptions = {},
): VpsCommandResult {
  return result(0, JSON.stringify(containerInspectionPayload(f, argv, options)))
}

describe('VpsRuntime', () => {
  it('maps each roster UUID to a private deterministic workspace', () => {
    const f = fixture()
    const first = f.runtime.workspace(sessions.alice)
    expect(first).toBe(resolve(f.root, sessions.alice))
    expect(f.runtime.workspace(sessions.alice)).toBe(first)
    expect(f.runtime.workspace(sessions.bob)).not.toBe(first)
    expect(() => f.runtime.workspace('../outside')).toThrow(VpsRuntimeError)
    expect(() => f.runtime.workspace('not-a-roster-id')).toThrow('roster UUID')
  })

  it('creates one rootless, networkless container with only its own named workspace volume', async () => {
    const f = fixture()
    await f.runtime.ensure(sessions.alice)
    const workspace = f.runtime.workspace(sessions.alice)
    const run = f.calls.find(argv => argv[1] === 'run')
    expect(run).toBeDefined()
    expect(run).toContain('--userns=keep-id')
    expect(run).toContain('--user')
    expect(run).toContain('--network=none')
    expect(run).toContain('--http-proxy=false')
    expect(run).toContain('--image-volume=ignore')
    expect(run).toContain('--security-opt=no-new-privileges')
    expect(run).toContain('--cap-drop=ALL')
    expect(run).toContain('--tmpfs')
    expect(run).toContain('/tmp:rw,noexec,nosuid,nodev')
    expect(run).toContain('--volume')
    expect(run?.find(value => value.endsWith(`:${workspace}:rw,nodev,nosuid`))).toMatch(/^yharness-bot-volume-[0-9a-f]{16}-/u)
    expect(run?.some(value => value.includes(`:${workspace}:rw,nodev,nosuid`))).toBe(true)
    expect(run).not.toContain('--env-host')
    expect(run).not.toContain('--privileged')
    expect(run).not.toContain('--pid=host')
    expect(run).not.toContain('--ipc=host')
    expect(run).not.toContain('--mount')
    expect(run).not.toContain('--socket')
    expect(run?.at(-1)).toBe('localhost/yharness-vps-bot:24.04')
    expect(statSync(workspace).mode & 0o777).toBe(0o700)
  })

  it('reuses a short ready cache for repeated filesystem operations', async () => {
    const f = fixture()
    await f.runtime.ensure(sessions.alice)
    const firstCallCount = f.calls.length
    await f.runtime.ensure(sessions.alice)
    expect(f.calls).toHaveLength(firstCallCount)
  })

  it('shares a single launch across concurrent calls for one session and isolates another session', async () => {
    const entered: string[][] = []
    let release: (() => void) | undefined
    let signalLookup: (() => void) | undefined
    const lookupStarted = new Promise<void>((resolveLookup) => { signalLookup = resolveLookup })
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    const f = fixture(async (argv) => {
      entered.push([...argv])
      if (argv[1] === 'container' && argv[2] === 'exists') {
        signalLookup?.()
        await gate
        return result(1)
      }
      return result()
    })
    const first = f.runtime.ensure(sessions.alice)
    const second = f.runtime.ensure(sessions.alice)
    await lookupStarted
    expect(entered.filter(argv => argv[1] === 'container').length).toBe(1)
    release?.()
    await Promise.all([first, second])
    await f.runtime.ensure(sessions.bob)
    const mounts = f.calls
      .filter(argv => argv[1] === 'run')
      .map(argv => argv[argv.indexOf('--volume') + 1])
    expect(mounts).toHaveLength(2)
    expect(mounts[0]).toMatch(new RegExp(`^yharness-bot-volume-[0-9a-f]{16}-botsessiona+4aaa8a+:${f.runtime.workspace(sessions.alice)}:rw,nodev,nosuid$`, 'u'))
    expect(mounts[1]).toMatch(new RegExp(`^yharness-bot-volume-[0-9a-f]{16}-botsessionbbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb:${f.runtime.workspace(sessions.bob)}:rw,nodev,nosuid$`, 'u'))
  })

  it('adopts a running existing container with mode-based mount metadata', async () => {
    const f = fixture(async (argv) => {
      if (argv[1] === 'container' && argv[2] === 'exists') return result()
      if (argv[1] === 'inspect') return containerInspection(f, argv, {
        useModeFields: true,
        useMountForTmpfs: true,
        userns: 'keep-id:uid=1000,gid=1000',
      })
      return result()
    }, async (argv) => {
      if (argv[2] === 'exists') return result()
      if (argv[2] === 'inspect') return volumeInspection(f, argv)
      return result()
    })
    await f.runtime.ensure(sessions.alice)
    expect(f.calls.some(argv => argv[1] === 'start' || argv[1] === 'run')).toBe(false)
    expect(f.calls.filter(argv => argv[1] === 'exec')).toHaveLength(1)
  })

  it('retries a failed launch after clearing the pending operation', async () => {
    let launches = 0
    const f = fixture(async (argv) => {
      if (argv[1] === 'container' && argv[2] === 'exists') return result(1)
      if (argv[1] === 'run') {
        launches += 1
        return result(launches === 1 ? 125 : 0)
      }
      return result()
    })
    await expect(f.runtime.ensure(sessions.alice)).rejects.toThrow('could not be launched')
    await f.runtime.ensure(sessions.alice)
    expect(launches).toBe(2)
  })

  it.each([
    { report: 'a nonzero lookup status', code: 2, message: 'container lookup failed' },
    { report: 'invalid command facts', code: Number.NaN, message: 'returned invalid command facts' },
  ])('rejects when Podman returns $report', async ({ code, message }) => {
    const f = fixture(async (argv) => {
      if (argv[1] === 'container' && argv[2] === 'exists') return result(code)
      return result()
    })
    await expect(f.runtime.ensure(sessions.alice)).rejects.toThrow(message)
  })

  it.each([
    { report: 'container inspection', inspect: result(1), message: 'container inspection failed' },
    { report: 'container restart', inspect: undefined, message: 'could not be restarted' },
  ])('rejects a failed existing-container $report', async ({ inspect, message }) => {
    const f = fixture(async (argv) => {
      if (argv[1] === 'container' && argv[2] === 'exists') return result()
      if (argv[1] === 'inspect') return inspect ?? containerInspection(f, argv, { running: false })
      if (argv[1] === 'start') return result(1)
      return result()
    }, async (argv) => {
      if (argv[2] === 'exists') return result()
      if (argv[2] === 'inspect') return volumeInspection(f, argv)
      return result()
    })
    await expect(f.runtime.ensure(sessions.alice)).rejects.toThrow(message)
    expect(f.calls.some(argv => argv[1] === 'run')).toBe(false)
  })

  it.each([
    { report: 'volume creation', exists: 1, create: 1, inspect: undefined, message: 'volume could not be created' },
    { report: 'volume lookup', exists: 2, create: undefined, inspect: undefined, message: 'volume lookup failed' },
    { report: 'volume inspection status', exists: 0, create: undefined, inspect: result(1), message: 'volume ownership does not match' },
    { report: 'invalid volume metadata', exists: 0, create: undefined, inspect: result(0, 'not-json'), message: 'volume ownership does not match' },
    { report: 'volume ownership', exists: 0, create: undefined, inspect: result(0, '{}'), message: 'volume ownership does not match' },
  ])('rejects a failed $report', async ({ exists, create, inspect, message }) => {
    const f = fixture(async (argv) => {
      if (argv[1] === 'container' && argv[2] === 'exists') return result(1)
      return result()
    }, async (argv) => {
      if (argv[2] === 'exists') return result(exists)
      if (argv[2] === 'create') return result(create)
      if (argv[2] === 'inspect') return inspect ?? volumeInspection(f, argv)
      return result()
    })
    await expect(f.runtime.ensure(sessions.alice)).rejects.toThrow(message)
    expect(f.calls.some(argv => argv[1] === 'run' || argv[1] === 'exec')).toBe(false)
  })

  it('waits for the desktop and rejects after the readiness deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    let signalExec: (() => void) | undefined
    const execStarted = new Promise<void>((resolveExec) => { signalExec = resolveExec })
    const f = fixture(async (argv) => {
      if (argv[1] === 'container' && argv[2] === 'exists') return result(1)
      if (argv[1] === 'exec') {
        signalExec?.()
        return result(1)
      }
      return result()
    })
    const pending = f.runtime.ensure(sessions.alice)
    const failure = expect(pending).rejects.toThrow('desktop did not become ready')
    await execStarted
    vi.setSystemTime(new Date(Date.now() + 30_001))
    await vi.advanceTimersByTimeAsync(50)
    await failure
    expect(f.calls.filter(argv => argv[1] === 'exec')).not.toHaveLength(0)
  })

  it('rechecks a ready container after the short health cache expires', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const f = fixture()
    await f.runtime.ensure(sessions.alice)
    const firstCallCount = f.calls.length
    await vi.advanceTimersByTimeAsync(501)
    await f.runtime.ensure(sessions.alice)
    expect(f.calls.length).toBeGreaterThan(firstCallCount)
  })

  it('uses the argv-only child-process boundary with a scrubbed environment', async () => {
    const { root, runtime } = bareFixture()
    try {
      vi.stubEnv('HOME', '/private/tmp/yharness-home')
      vi.stubEnv('XDG_RUNTIME_DIR', '/private/tmp/yharness-runtime')
      const calls = installSpawn((argv, child) => {
        const response = podmanResult(root, runtime, argv)
        finishChild(child, response.code, response.stdout, response.stderr)
      })
      await runtime.ensure(sessions.alice)
      expect(calls).toHaveLength(6)
      expect(calls.every(call => call.command === '/usr/bin/podman')).toBe(true)
      expect(calls.map(call => call.args.slice(0, 2))).toEqual([
        ['container', 'exists'],
        ['volume', 'exists'],
        ['volume', 'create'],
        ['volume', 'inspect'],
        ['run', '--detach'],
        ['exec', '--workdir'],
      ])
      expect(calls[0]).toMatchObject({
        command: '/usr/bin/podman',
        args: ['container', 'exists', expect.stringMatching(/^yharness-bot-/u)],
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const expectedEnvironment = {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LC_ALL: 'C',
        HOME: '/private/tmp/yharness-home',
        XDG_RUNTIME_DIR: '/private/tmp/yharness-runtime',
      }
      expect(calls.map(call => call.env)).toEqual(calls.map(() => expectedEnvironment))
      expect(calls[0]?.child.stdout.encodings).toEqual(['utf8'])
      expect(calls[0]?.child.stderr.encodings).toEqual(['utf8'])
      expect(calls.find(call => call.args[0] === 'run')?.args.at(-1)).toBe('localhost/yharness-vps-bot:24.04')
      expect(calls.find(call => call.args[0] === 'exec')?.args).toContain('xdotool')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('surfaces a child-process start failure without leaking the child error', async () => {
    const { runtime } = bareFixture()
    const calls = installSpawn((_argv, child) => {
      queueMicrotask(() => {
        child.emit('error', new Error('private host detail'))
        child.emit('close', null)
      })
    })
    await expect(runtime.ensure(sessions.alice)).rejects.toThrow('Podman could not start')
    expect(calls[0]?.child.killed).toEqual([])
  })

  it('cancels forceful escalation when an overflowed child closes after termination', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { runtime } = bareFixture()
    const calls = installSpawn((_argv, child) => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'x'.repeat(64 * 1024 + 1))
        child.emit('close', 0)
      })
    })
    await expect(runtime.ensure(sessions.alice)).rejects.toThrow('output exceeded its limit')
    expect(calls[0]?.child.killed).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(calls[0]?.child.killed).toEqual(['SIGTERM'])
  })

  it.each(['stdout', 'stderr'] as const)('waits for close and escalates when %s exceeds the output limit', async (stream) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { runtime } = bareFixture()
    let signalOverflow: (() => void) | undefined
    const overflowStarted = new Promise<void>((resolveOverflow) => { signalOverflow = resolveOverflow })
    let releaseData: (() => void) | undefined
    const dataGate = new Promise<void>((resolveData) => { releaseData = resolveData })
    let signalOutput: (() => void) | undefined
    const outputStarted = new Promise<void>((resolveOutput) => { signalOutput = resolveOutput })
    let releaseClose: (() => void) | undefined
    const closeGate = new Promise<void>((resolveClose) => { releaseClose = resolveClose })
    let lateConversions = 0
    const calls = installSpawn((_argv, child) => {
      queueMicrotask(() => {
        void (async () => {
          const output = stream === 'stdout' ? child.stdout : child.stderr
          if (stream === 'stderr') output.emit('data', 'diagnostic')
          signalOverflow?.()
          await dataGate
          output.emit('data', 'x'.repeat(64 * 1024 + 1))
          signalOutput?.()
          await closeGate
          child.emit('close', 0)
        })()
      })
    })
    const pending = runtime.ensure(sessions.alice)
    let rejected = false
    let failureMessage: string | undefined
    void pending.catch((error: unknown) => {
      rejected = true
      failureMessage = error instanceof Error ? error.message : undefined
    })
    await overflowStarted
    releaseData?.()
    await outputStarted
    await Promise.resolve()
    expect(rejected).toBe(false)
    const lateChunk = { toString: () => { lateConversions += 1; return 'late output after the limit' } }
    const output = stream === 'stdout' ? calls[0]?.child.stdout : calls[0]?.child.stderr
    output?.emit('data', lateChunk)
    expect(lateConversions).toBe(0)
    expect(calls[0]?.child.killed).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(calls[0]?.child.killed).toEqual(['SIGTERM', 'SIGKILL'])
    releaseClose?.()
    await pending.catch(() => {})
    expect(rejected).toBe(true)
    expect(failureMessage).toBe('VPS Bot Podman output exceeded its limit')
    expect(calls[0]?.child.killed).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('accepts output exactly at the byte limit before handling the command status', async () => {
    const { runtime } = bareFixture()
    const calls = installSpawn((_argv, child) => {
      finishChild(child, 2, 'x'.repeat(64 * 1024))
    })
    await expect(runtime.ensure(sessions.alice)).rejects.toThrow('container lookup failed')
    expect(calls[0]?.child.killed).toEqual([])
  })

  it('waits for close and rejects when the Podman deadline expires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { runtime } = bareFixture()
    let signalSpawn: ((child: FakeChild) => void) | undefined
    const spawned = new Promise<FakeChild>((resolveSpawn) => { signalSpawn = resolveSpawn })
    const calls = installSpawn((_argv, child) => {
      child.kill = (signal?: NodeJS.Signals | number) => {
        child.killed.push(signal)
        return true
      }
      signalSpawn?.(child)
    })
    const pending = runtime.ensure(sessions.alice)
    let rejected = false
    let failureMessage: string | undefined
    void pending.catch((error: unknown) => {
      rejected = true
      failureMessage = error instanceof Error ? error.message : undefined
    })
    await spawned
    await vi.advanceTimersByTimeAsync(120_000)
    expect(rejected).toBe(false)
    expect(calls[0]?.child.killed).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(rejected).toBe(false)
    expect(calls[0]?.child.killed).toEqual(['SIGTERM', 'SIGKILL'])
    calls[0]?.child.emit('close', null)
    await pending.catch(() => {})
    expect(rejected).toBe(true)
    expect(failureMessage).toBe('VPS Bot Podman command timed out')
  })

  it('rejects when a child closes without an exit status', async () => {
    const { runtime } = bareFixture()
    installSpawn((_argv, child) => { finishChild(child, null) })
    await expect(runtime.ensure(sessions.alice)).rejects.toThrow('exited without a status')
  })

  it('ignores a late child error after close has settled the result', async () => {
    const { runtime } = bareFixture()
    installSpawn((_argv, child) => {
      queueMicrotask(() => {
        child.emit('close', 2)
        child.emit('error', new Error('late host detail'))
      })
    })
    await expect(runtime.ensure(sessions.alice)).rejects.toThrow('container lookup failed')
  })

  it.each([
    { report: 'literal ALL', capDrop: ['ALL'], effective: undefined, bounding: undefined, capAdd: [], allowed: true },
    { report: 'expanded empty capabilities', capDrop: ['CAP_CHOWN'], effective: null, bounding: null, capAdd: [], allowed: true },
    { report: 'nonempty bounding set', capDrop: ['CAP_CHOWN'], effective: null, bounding: ['CAP_KILL'], capAdd: [], allowed: false },
    { report: 'explicit additions', capDrop: ['ALL'], effective: null, bounding: null, capAdd: ['CAP_KILL'], allowed: false },
  ])('checks $report before restarting a stopped container', async ({ capDrop, effective, bounding, capAdd, allowed }) => {
    const f = fixture(async (argv) => {
      if (argv[1] === 'container' && argv[2] === 'exists') return result()
      if (argv[1] === 'inspect') return result(0, JSON.stringify({
        // The deterministic volume name mirrors the container name's suffix.
        // This models Podman's inspect response without exposing a test-only
        // production helper.
        ImageName: 'localhost/yharness-vps-bot:24.04',
        Config: { Image: 'localhost/yharness-vps-bot:24.04', User: '1000:1000', Labels: {
          'io.yharness.vps.root': f.root,
          'io.yharness.vps.image': 'localhost/yharness-vps-bot:24.04',
          'io.yharness.vps.session': sessions.alice,
          'io.yharness.vps.workspace': f.runtime.workspace(sessions.alice),
          'io.yharness.vps.volume': `yharness-bot-volume-${(argv.at(-1) ?? '').replace(/^yharness-bot-/u, '')}`,
        } },
        State: { Running: false },
        EffectiveCaps: effective,
        BoundingCaps: bounding,
        Mounts: [
          { Type: 'volume', Name: `yharness-bot-volume-${(argv.at(-1) ?? '').replace(/^yharness-bot-/u, '')}`, Destination: f.runtime.workspace(sessions.alice), RW: true, Options: ['nodev', 'nosuid', 'rbind'] },
        ],
        HostConfig: {
          NetworkMode: 'none', Privileged: false, SecurityOpt: ['no-new-privileges'], CapDrop: capDrop, CapAdd: capAdd, UsernsMode: 'private', Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,rprivate,tmpcopyup' },
        },
      }))
      return result()
    })
    const ready = f.runtime.ensure(sessions.alice)
    if (allowed) await ready
    else await expect(ready).rejects.toThrow('container privileges are invalid')
    expect(f.calls.some(argv => argv[1] === 'start')).toBe(allowed)
    expect(f.calls.some(argv => argv[1] === 'run')).toBe(false)
  })

  it('does not adopt an existing container whose image or host mount differ', async () => {
    const f = fixture(async (argv) => {
      if (argv[1] === 'container' && argv[2] === 'exists') return result()
      if (argv[1] === 'inspect') {
        const volume = `yharness-bot-volume-${(argv.at(-1) ?? '').replace(/^yharness-bot-/u, '')}`
        return result(0, JSON.stringify({
          Config: { User: '1000:1000', Labels: {
            'io.yharness.vps.root': f.root,
            'io.yharness.vps.image': 'localhost/yharness-vps-bot:24.04',
            'io.yharness.vps.session': sessions.alice,
            'io.yharness.vps.workspace': f.runtime.workspace(sessions.alice),
            'io.yharness.vps.volume': volume,
          }, Image: 'localhost/yharness-vps-bot:24.04' },
          State: { Running: true },
          Mounts: [
            { Type: 'bind', Source: '/tmp/other', Destination: f.runtime.workspace(sessions.alice), RW: true },
          ],
          HostConfig: {
            NetworkMode: 'none', Privileged: false, SecurityOpt: ['no-new-privileges'], CapDrop: ['ALL'], UsernsMode: 'private', Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,rprivate,tmpcopyup' },
          },
        }))
      }
      return result()
    })
    await expect(f.runtime.ensure(sessions.alice)).rejects.toThrow('workspace mount is invalid')
    expect(f.calls.some(argv => argv[1] === 'start' || argv[1] === 'run')).toBe(false)
  })

  it('does not adopt an existing container whose image differs despite matching labels', async () => {
    const f = fixture(async (argv) => {
      if (argv[1] === 'container' && argv[2] === 'exists') return result()
      if (argv[1] === 'inspect') {
        const volume = `yharness-bot-volume-${(argv.at(-1) ?? '').replace(/^yharness-bot-/u, '')}`
        return result(0, JSON.stringify({
          ImageName: 'localhost/another-image:24.04',
          Config: { Image: 'localhost/another-image:24.04', User: '1000:1000', Labels: {
            'io.yharness.vps.root': f.root,
            'io.yharness.vps.image': 'localhost/yharness-vps-bot:24.04',
            'io.yharness.vps.session': sessions.alice,
            'io.yharness.vps.workspace': f.runtime.workspace(sessions.alice),
            'io.yharness.vps.volume': volume,
          } },
          State: { Running: true },
          Mounts: [
            { Type: 'volume', Name: volume, Destination: f.runtime.workspace(sessions.alice), RW: true, Options: ['nodev', 'nosuid', 'rbind'] },
          ],
          HostConfig: {
            NetworkMode: 'none', Privileged: false, SecurityOpt: ['no-new-privileges'], CapDrop: ['ALL'], UsernsMode: 'private', Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,rprivate,tmpcopyup' },
          },
        }))
      }
      return result()
    })
    await expect(f.runtime.ensure(sessions.alice)).rejects.toThrow('image')
    expect(f.calls.some(argv => argv[1] === 'start' || argv[1] === 'run')).toBe(false)
  })

  it.each([
    {
      report: 'invalid JSON',
      message: 'container metadata is not valid JSON',
      build: () => 'not-json',
    },
    {
      report: 'non-object metadata',
      message: 'container metadata is invalid',
      build: () => 'null',
    },
    {
      report: 'ownership labels',
      message: 'container ownership does not match',
      build: (f: Fixture, argv: readonly string[]) => {
        const payload = containerInspectionPayload(f, argv)
        payload.Config = {}
        return JSON.stringify(payload)
      },
    },
    {
      report: 'state',
      message: 'container state is invalid',
      build: (f: Fixture, argv: readonly string[]) => {
        const payload = containerInspectionPayload(f, argv)
        payload.State = {}
        return JSON.stringify(payload)
      },
    },
    {
      report: 'image',
      message: 'container image is invalid',
      build: (f: Fixture, argv: readonly string[]) => {
        const payload = containerInspectionPayload(f, argv)
        payload.ImageName = undefined
        payload.Config = { Image: undefined, User: '1000:1000', Labels: containerLabels(f, argv) }
        return JSON.stringify(payload)
      },
    },
    {
      report: 'mount list',
      message: 'container mounts are invalid',
      build: (f: Fixture, argv: readonly string[]) => {
        const payload = containerInspectionPayload(f, argv)
        payload.Mounts = 'not-an-array'
        return JSON.stringify(payload)
      },
    },
    {
      report: 'unexpected host mount',
      message: 'unexpected host mount',
      build: (f: Fixture, argv: readonly string[]) => {
        const payload = containerInspectionPayload(f, argv)
        const labels = containerLabels(f, argv)
        payload.Mounts = [
          { Type: 'volume', Name: labels['io.yharness.vps.volume'], Destination: f.runtime.workspace(sessions.alice), RW: true, Options: ['nodev', 'nosuid'] },
          { Type: 'bind', Source: '/tmp/other', Destination: '/tmp', RW: true },
        ]
        return JSON.stringify(payload)
      },
    },
    {
      report: 'workspace mount identity',
      message: 'workspace mount is invalid',
      build: (f: Fixture, argv: readonly string[]) => {
        const payload = containerInspectionPayload(f, argv)
        const labels = containerLabels(f, argv)
        payload.Mounts = [{ Type: 'volume', Name: `${labels['io.yharness.vps.volume']}-other`, Destination: f.runtime.workspace(sessions.alice), RW: true, Options: ['nodev', 'nosuid'] }]
        return JSON.stringify(payload)
      },
    },
    {
      report: 'workspace volume options',
      message: 'workspace volume options are invalid',
      build: (f: Fixture, argv: readonly string[]) => {
        const payload = containerInspectionPayload(f, argv)
        const labels = containerLabels(f, argv)
        payload.Mounts = [{ Type: 'volume', Name: labels['io.yharness.vps.volume'], Destination: f.runtime.workspace(sessions.alice), RW: true, Options: ['rbind'] }]
        return JSON.stringify(payload)
      },
    },
    {
      report: 'malformed workspace mount options',
      message: 'workspace volume options are invalid',
      build: (f: Fixture, argv: readonly string[]) => {
        const payload = containerInspectionPayload(f, argv)
        const labels = containerLabels(f, argv)
        payload.Mounts = [{ Type: 'volume', Name: labels['io.yharness.vps.volume'], Destination: f.runtime.workspace(sessions.alice), RW: true, Options: [123] }]
        return JSON.stringify(payload)
      },
    },
    {
      report: 'temporary storage options',
      message: 'temporary storage is invalid',
      build: (f: Fixture, argv: readonly string[]) => {
        const payload = containerInspectionPayload(f, argv)
        payload.HostConfig = { NetworkMode: 'none', Privileged: false, SecurityOpt: ['no-new-privileges'], CapDrop: ['ALL'], UsernsMode: 'private', Tmpfs: { '/tmp': 'rw' } }
        return JSON.stringify(payload)
      },
    },
    {
      report: 'missing temporary storage metadata',
      message: 'temporary storage is invalid',
      build: (f: Fixture, argv: readonly string[]) => {
        const payload = containerInspectionPayload(f, argv)
        payload.HostConfig = { NetworkMode: 'none', Privileged: false, SecurityOpt: ['no-new-privileges'], CapDrop: ['ALL'], UsernsMode: 'private' }
        return JSON.stringify(payload)
      },
    },
    {
      report: 'container user',
      message: 'container user is invalid',
      build: (f: Fixture, argv: readonly string[]) => {
        const payload = containerInspectionPayload(f, argv)
        payload.Config = { Image: 'localhost/yharness-vps-bot:24.04', User: '0:0', Labels: containerLabels(f, argv) }
        return JSON.stringify(payload)
      },
    },
  ])('rejects unsafe existing-container $report metadata', async ({ build, message }) => {
    const f = fixture(async (argv) => {
      if (argv[1] === 'container' && argv[2] === 'exists') return result()
      if (argv[1] === 'inspect') return result(0, build(f, argv))
      return result()
    })
    await expect(f.runtime.ensure(sessions.alice)).rejects.toThrow(message)
  })

  it('returns argv-only exec commands and keeps workdir inside the private workspace', () => {
    const f = fixture()
    const workspace = f.runtime.workspace(sessions.alice)
    const command = f.runtime.execArgv(sessions.alice, ['xdotool', 'type', '--', 'hello; touch /outside'])
    expect(command.slice(0, 2)).toEqual(['/usr/bin/env', '-i'])
    expect(command.some(value => /^(?:CONTAINER|DOCKER|PODMAN)_/u.test(value))).toBe(false)
    const podman = command.indexOf('/usr/bin/podman')
    expect(podman).toBeGreaterThan(1)
    expect(command.slice(podman)).toEqual([
      '/usr/bin/podman', 'exec', '--workdir', workspace, expect.any(String), 'xdotool', 'type', '--', 'hello; touch /outside',
    ])
    const stdinCommand = f.runtime.execArgv(sessions.alice, ['bash', '-lc', 'printf safe'], {
      workdir: join(workspace, 'nested'), stdin: true,
    })
    const stdinPodman = stdinCommand.indexOf('/usr/bin/podman')
    expect(stdinCommand.slice(stdinPodman, stdinPodman + 6)).toEqual([
      '/usr/bin/podman', 'exec', '--interactive', '--workdir', join(workspace, 'nested'), expect.any(String),
    ])
    const ttyCommand = f.runtime.execArgv(sessions.alice, ['bash'], { interactive: true })
    const ttyPodman = ttyCommand.indexOf('/usr/bin/podman')
    expect(ttyCommand.slice(ttyPodman, ttyPodman + 5)).toEqual([
      '/usr/bin/podman', 'exec', '--interactive', '--tty', '--workdir',
    ])
    expect(() => f.runtime.execArgv(sessions.alice, ['echo'], { workdir: '/tmp' })).toThrow('inside its workspace')
    expect(() => f.runtime.execArgv(sessions.alice, ['echo', 'bad\u0000arg'])).toThrow('NUL')
  })

  it('copies only safe host environment values into exec argv', () => {
    const f = fixture()
    try {
      vi.stubEnv('HOME', '/private/tmp/yharness-home')
      vi.stubEnv('XDG_RUNTIME_DIR', '/private/tmp/yharness-runtime')
      const safe = f.runtime.execArgv(sessions.alice, ['echo'])
      expect(safe).toContain('HOME=/private/tmp/yharness-home')
      expect(safe).toContain('XDG_RUNTIME_DIR=/private/tmp/yharness-runtime')

      vi.stubEnv('HOME', 'unsafe\u0000home')
      vi.stubEnv('XDG_RUNTIME_DIR', 'unsafe\u0000runtime')
      const unsafe = f.runtime.execArgv(sessions.alice, ['echo'])
      expect(unsafe).not.toContain('HOME=unsafe\u0000home')
      expect(unsafe).not.toContain('XDG_RUNTIME_DIR=unsafe\u0000runtime')

      vi.stubEnv('HOME', undefined)
      const absentHome = f.runtime.execArgv(sessions.alice, ['echo'])
      expect(absentHome.some(value => value.startsWith('HOME='))).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('rejects unsafe roots, images, and workdir inputs before Podman access', () => {
    const f = fixture()
    expect(() => new VpsRuntime('relative', 'image')).toThrow('absolute path')
    expect(() => new VpsRuntime(`${f.root}\u0000`, 'image')).toThrow('control characters')
    expect(() => new VpsRuntime(f.root, '')).toThrow('safe local image reference')
    expect(() => new VpsRuntime(f.root, '-image')).toThrow('safe local image reference')
    expect(() => new VpsRuntime(f.root, 'image with spaces')).toThrow('safe local image reference')
    expect(() => new VpsRuntime(f.root, 'a'.repeat(257))).toThrow('safe local image reference')
    expect(() => f.runtime.execArgv(sessions.alice, ['echo'], { workdir: 'relative' })).toThrow('absolute path')
    expect(() => f.runtime.execArgv(sessions.alice, ['echo'], { workdir: `${f.runtime.workspace(sessions.alice)}\u0000` })).toThrow('absolute path')
  })

  it('rejects a workspace whose owner does not match the configured uid', async () => {
    const f = fixture()
    const runtime = new VpsRuntime(f.root, 'localhost/yharness-vps-bot:24.04', {
      uid: () => -1,
      run: async () => result(),
    })
    await expect(runtime.ensure(sessions.alice)).rejects.toThrow('owner-only directory')
  })

  it.each(['getuid', 'getgid'] as const)('leaves Podman user mapping to the platform without process.%s', async (method) => {
    const original = Object.getOwnPropertyDescriptor(process, method)
    const f = fixture()
    try {
      Object.defineProperty(process, method, { configurable: true, value: undefined })
      await f.runtime.ensure(sessions.alice)
      const run = f.calls.find(command => command[1] === 'run')
      expect(run).toBeDefined()
      expect(run).not.toContain('--user')
    } finally {
      if (original === undefined) Reflect.deleteProperty(process, method)
      else Object.defineProperty(process, method, original)
    }
  })

  it('rejects broad, shared, or symlinked private roots and workspaces', async () => {
    expect(() => new VpsRuntime('/', 'image')).toThrow('dedicated private directory')
    expect(() => new VpsRuntime('/tmp', 'image')).toThrow('dedicated private directory')
    const f = fixture()
    const workspace = f.runtime.workspace(sessions.alice)
    const elsewhere = join(f.root, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, workspace)
    await expect(f.runtime.ensure(sessions.alice)).rejects.toThrow('owner-only directory')
    const file = join(f.root, 'file')
    writeFileSync(file, 'not a directory')
    const other = new VpsRuntime(file, 'image')
    await expect(other.ensure(sessions.alice)).rejects.toThrow()
    expect(lstatSync(workspace).isSymbolicLink()).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('not a directory')
  })
})
