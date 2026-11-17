import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { Context } from '@yharness/cordis'
import type { SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@yharness/subprocess'
import LocalSubprocessRuntime from '@yharness/subprocess-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VpsBotSubprocess } from '../src/vps-bot-process.ts'
import { VpsRuntime, VpsRuntimeError, type VpsCommandResult } from '../src/vps-runtime.ts'

const sessions = {
  alice: 'bot-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  bob: 'bot-session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
} as const

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Fixture {
  root: string
  calls: string[][]
  runtime: VpsRuntime
}

function result(code = 0, stdout = ''): VpsCommandResult {
  return { code, stdout, stderr: '' }
}

function fixture(run: (argv: readonly string[]) => Promise<VpsCommandResult> | VpsCommandResult = async (argv) => {
  if (argv[1] === 'container' && argv[2] === 'exists') return result(1)
  return result()
}, {
  browser = false, sharedWorkspace = false, hostileSharedVolume = false, internet,
  userService = false, networkPolicy, sharedWorkspacePolicy,
}: {
  browser?: boolean
  sharedWorkspace?: boolean
  hostileSharedVolume?: boolean
  internet?: boolean
  userService?: boolean
  networkPolicy?: { get(session: string): Promise<boolean | undefined>; set(session: string, enabled: boolean): Promise<void> }
  sharedWorkspacePolicy?: { get(session: string): Promise<boolean | undefined>; set(session: string, enabled: boolean): Promise<void> }
} = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-vps-runtime-'))
  roots.push(root)
  const calls: string[][] = []
  const seccompProfile = join(root, 'browser-seccomp.json')
  if (browser) writeFileSync(seccompProfile, '{}', { mode: 0o600 })
  const defaultVolumeCommand = async (argv: readonly string[]): Promise<VpsCommandResult> => {
    const volume = argv.at(-1) ?? ''
    const profile = volume.endsWith('-browser')
    if (volume.startsWith('yharness-bot-project-')) {
      if (argv[2] === 'exists') return result(hostileSharedVolume ? 0 : 1)
      if (argv[2] === 'create') return result()
      return result(0, JSON.stringify({
        Name: volume,
        Driver: 'local',
        Options: hostileSharedVolume ? { device: '/srv/other-project', o: 'bind' } : {},
        Labels: {
          'io.yharness.vps.root': root,
          'io.yharness.vps.purpose': 'shared-project',
        },
      }))
    }
    if (argv[2] === 'exists') return result(browser && !profile ? 0 : 1)
    if (argv[2] === 'create') return result(0, `${argv.at(-1) ?? ''}\n`)
    const session = volume.includes('botsessionbbbb') ? sessions.bob : sessions.alice
    return result(0, JSON.stringify({
      Name: volume,
      Labels: {
        'io.yharness.vps.root': root,
        'io.yharness.vps.image': 'localhost/yharness-vps-bot:24.04',
        'io.yharness.vps.session': session,
        'io.yharness.vps.workspace': runtime.workspace(session),
        ...(profile ? { 'io.yharness.vps.purpose': 'browser' } : {}),
      },
    }))
  }
  const runtime = new VpsRuntime(root, 'localhost/yharness-vps-bot:24.04', {
    userService,
    networkHelperAvailable: () => true,
    run: async (argv) => {
      calls.push([...argv])
      const podman = argv.slice(argv.indexOf('/usr/bin/podman'))
      if (podman[1] === 'volume') return await defaultVolumeCommand(podman)
      return await run(podman)
    },
  }, {
    ...(browser ? { browser: { image: 'localhost/yharness-vps-bot-browser:24.04-v1', seccompProfile } } : {}),
    sharedWorkspace,
    ...(internet === undefined ? {} : { internet }),
    ...(networkPolicy === undefined ? {} : { networkPolicy }),
    ...(sharedWorkspacePolicy === undefined ? {} : { sharedWorkspacePolicy }),
  })
  return { root, calls, runtime }
}

describe('VpsRuntime', () => {
  it('sets one cold Computer’s network policy without starting it or enrolling another Bot', async () => {
    const values = new Map<string, boolean>()
    const f = fixture(undefined, { networkPolicy: {
      get: async id => values.get(id), set: async (id, enabled) => { values.set(id, enabled) },
    } })
    const signal = new AbortController().signal
    await expect(f.runtime.setInternetAccess(sessions.alice, true, signal)).resolves.toBe('applied')
    expect(f.calls.some(argv => argv[1] === 'run')).toBe(false)
    await expect(f.runtime.internetFor(sessions.alice)).resolves.toBe(true)
    await expect(f.runtime.internetFor(sessions.bob)).resolves.toBe(false)
    await f.runtime.ensure(sessions.alice)
    await f.runtime.ensure(sessions.bob)
    expect(f.calls.filter(argv => argv[1] === 'run').map(argv => argv.find(value => value.startsWith('--network='))))
      .toEqual(['--network=slirp4netns:allow_host_loopback=false', '--network=none'])
  })

  it('preserves the current Computer while a command is in progress', async () => {
    const set = vi.fn(async (_id: string, _enabled: boolean) => {})
    const f = fixture(undefined, { networkPolicy: { get: async () => undefined, set } })
    const finish = f.runtime.beginUse(sessions.alice)
    try {
      await expect(f.runtime.setInternetAccess(sessions.alice, true, new AbortController().signal)).resolves.toBe('busy')
      expect(f.calls).toEqual([])
      expect(set).not.toHaveBeenCalled()
    } finally {
      finish()
    }
  })

  it.each([
    { action: 'network', state: 'idle' }, { action: 'network', state: 'busy' }, { action: 'network', state: 'stop failed' },
    { action: 'restart', state: 'idle' }, { action: 'restart', state: 'busy' }, { action: 'restart', state: 'stop failed' },
  ])('protects the existing Computer during $action when it is $state', async ({ action, state }) => {
    const saved = new Map<string, boolean>()
    const processes = [
      'PID   PPID  COMMAND     COMMAND',
      '1     0     bash        bash /usr/local/bin/yharness-vps-bot-start',
      '24    1     Xvfb        Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -auth /tmp/yharness-xauthority',
      '144   1     sleep       sleep 1',
    ]
    if (action === 'network') processes.push('28    1     openbox     openbox')
    if (state === 'busy') processes.push('145   1     sleep       sleep 300')
    let present = false
    const f = fixture(async (argv) => {
      const command = argv[1]
      if (command === 'container' && argv[2] === 'exists') return result(present ? 0 : 1)
      if (command === 'run') present = true
      if (command === 'inspect') {
        const volume = `yharness-bot-volume-${(argv.at(-1) ?? '').replace(/^yharness-bot-/u, '')}`
        const image = 'localhost/yharness-vps-bot:24.04'
        const workspace = f.runtime.workspace(sessions.alice)
        return result(0, JSON.stringify({
          ImageName: image,
          Config: { User: '1000:1000', Labels: {
            'io.yharness.vps.root': f.root,
            'io.yharness.vps.image': image,
            'io.yharness.vps.session': sessions.alice,
            'io.yharness.vps.workspace': workspace,
            'io.yharness.vps.volume': volume,
          } },
          State: { Running: true },
          Mounts: [{ Type: 'volume', Name: volume, Destination: workspace, RW: true, Options: ['nodev', 'nosuid'] }],
          HostConfig: { NetworkMode: 'none', SecurityOpt: ['no-new-privileges'], CapDrop: ['ALL'],
            UsernsMode: 'keep-id', Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev' } },
        }))
      }
      if (command === 'top') return result(0, processes.join('\n'))
      if (command === 'stop' && state === 'stop failed') return result(125)
      if (command === 'rm') present = false
      return result()
    }, { networkPolicy: {
      get: async id => saved.get(id), set: async (id, enabled) => { saved.set(id, enabled) },
    } })
    await f.runtime.ensure(sessions.alice)
    const signal = new AbortController().signal
    const change = action === 'network'
      ? f.runtime.setInternetAccess(sessions.alice, true, signal)
      : f.runtime.restart(sessions.alice, signal)
    if (state === 'stop failed') await expect(change).rejects.toThrow('could not stop')
    else await expect(change).resolves.toBe(state === 'busy' ? 'busy' : action === 'network' ? 'applied' : 'restarted')
    expect(f.calls.some(argv => argv[1] === 'stop')).toBe(state !== 'busy')
    expect(f.calls.some(argv => argv[1] === 'rm')).toBe(state === 'idle')
    expect(saved.has(sessions.alice)).toBe(state === 'idle' && action === 'network')
    if (state === 'idle') {
      const removed = f.calls.find(argv => argv[1] === 'rm')
      expect(removed).toHaveLength(3)
      if (action === 'network') await f.runtime.ensure(sessions.alice)
      const launches = f.calls.filter(argv => argv[1] === 'run')
      expect(launches[0]).toContain('--network=none')
      expect(launches[1]).toContain(action === 'network' ? '--network=slirp4netns:allow_host_loopback=false' : '--network=none')
      expect(launches[0]?.find(arg => arg.includes(':rw,nodev,nosuid')))
        .toBe(launches[1]?.find(arg => arg.includes(':rw,nodev,nosuid')))
    }
  })

  it('starts a desktop in a separate user scope while keeping inspection in the Web service', async () => {
    const f = fixture(undefined, { userService: true, internet: true })
    await f.runtime.ensure(sessions.alice)
    const launch = f.calls.find(argv => argv.includes('--detach'))
    expect(launch?.slice(0, launch.indexOf('/usr/bin/podman'))).toEqual([
      '/usr/bin/systemd-run', '--user', '--scope', '--quiet', '--collect', '--no-ask-password',
      '--description=Y Harness Bot Computer', '--',
    ])
    expect(f.calls.filter(argv => argv[0] === '/usr/bin/systemd-run')).toEqual([launch])
    expect(f.calls.some(argv => argv[0] === '/usr/bin/podman' && argv[1] === 'container')).toBe(true)
    expect(f.calls.some(argv => argv[0] === '/usr/bin/podman' && argv[1] === 'exec')).toBe(true)
  })

  it('gives a standard desktop outbound internet independently of Firefox', async () => {
    const f = fixture(undefined, { internet: true })
    await f.runtime.ensure(sessions.alice)
    const launch = f.calls.find(argv => argv[1] === 'run')
    expect(launch).toContain('--network=slirp4netns:allow_host_loopback=false')
    expect(launch).not.toContain('--publish')
    expect(launch?.at(-1)).toBe('localhost/yharness-vps-bot:24.04')
    expect(launch?.some(arg => arg.includes(':/var/lib/yharness-browser-profile:'))).toBe(false)
  })

  it('can keep a Firefox profile on an offline desktop', async () => {
    const f = fixture(undefined, { browser: true, internet: false })
    await f.runtime.ensure(sessions.alice)
    const launch = f.calls.find(argv => argv[1] === 'run')
    expect(launch).toContain('--network=none')
    expect(launch?.some(arg => arg.endsWith(':/var/lib/yharness-browser-profile:rw,nodev,nosuid,nocopy'))).toBe(true)
  })

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
    expect(run).toContain('--pid=private')
    expect(run).toContain('--ipc=private')
    expect(run).toContain('--uts=private')
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

  it('keeps the existing workspace and mounts a separate browser profile for each session', async () => {
    const f = fixture(undefined, { browser: true })
    await f.runtime.ensure(sessions.alice)
    await f.runtime.ensure(sessions.bob)
    const launches = f.calls.filter(argv => argv[1] === 'run')
    expect(launches).toHaveLength(2)
    const profiles: string[] = []
    for (const launch of launches) {
      expect(launch).toContain('--network=slirp4netns:allow_host_loopback=false')
      expect(launch).toContain(`--security-opt=seccomp=${join(f.root, 'browser-seccomp.json')}`)
      expect(launch).toContain('--cap-drop=ALL')
      expect(launch).not.toContain('--publish')
      expect(launch.at(-1)).toBe('localhost/yharness-vps-bot-browser:24.04-v1')
      const profile = launch.find(arg => arg.endsWith(':/var/lib/yharness-browser-profile:rw,nodev,nosuid,nocopy'))
      expect(profile).toBeDefined()
      if (profile !== undefined) profiles.push(profile.split(':')[0] ?? '')
    }
    expect(new Set(profiles).size).toBe(2)
    expect(f.calls.filter(argv => argv[1] === 'volume' && argv[2] === 'create').map(argv => argv.at(-1)))
      .toEqual(profiles)
  })

  it('gives two selected Bots the same project volume alongside distinct private workspaces', async () => {
    const f = fixture(undefined, { sharedWorkspace: true })
    await Promise.all([f.runtime.ensure(sessions.alice), f.runtime.ensure(sessions.bob)])
    const runs = f.calls.filter(argv => argv[1] === 'run')
    const project = runs.map(argv => argv.find(arg => arg.endsWith(':/workspace:rw,nodev,nosuid,nocopy')))
    expect(project[0]).toMatch(/^yharness-bot-project-[0-9a-f]{16}:\/workspace:/u)
    expect(project).toEqual([project[0], project[0]])
    expect(f.runtime.execArgv(sessions.alice, ['pwd'], { workdir: '/workspace/research' }))
      .toContain('/workspace/research')
    expect(() => f.runtime.execArgv(sessions.bob, ['pwd'], { workdir: '/workspace/../outside' }))
      .toThrow('workspace')
    expect(() => fixture().runtime.execArgv(sessions.alice, ['pwd'], { workdir: '/workspace' }))
      .toThrow('workspace')
    const privateMounts = runs.map(argv => argv[argv.indexOf('--volume') + 1])
    expect(new Set(privateMounts).size).toBe(2)
  })

  it('grants and revokes the shared mount for one Bot while preserving both volumes', async () => {
    const saved = new Map<string, boolean>()
    let launch: readonly string[] | undefined
    const f = fixture((argv) => {
      if (argv[1] === 'run') launch = argv
      if (argv[1] === 'container' && argv[2] === 'exists') return result(launch === undefined ? 1 : 0)
      if (argv[1] === 'rm') launch = undefined
      if (argv[1] !== 'inspect' || launch === undefined) return result()
      const workspace = f.runtime.workspace(sessions.alice)
      const image = 'localhost/yharness-vps-bot:24.04'
      const mounts = launch.filter((_, index) => launch?.[index - 1] === '--volume').map((mount) => {
        const [Name, Destination, mode] = mount.split(':')
        return { Name, Destination, Type: 'volume', RW: true, Options: mode?.split(',') }
      })
      return result(0, JSON.stringify({
        ImageName: image,
        Config: { User: '1000:1000', Labels: {
          'io.yharness.vps.root': f.root,
          'io.yharness.vps.image': image,
          'io.yharness.vps.session': sessions.alice,
          'io.yharness.vps.workspace': workspace,
          'io.yharness.vps.volume': mounts[0]?.Name,
        } },
        State: { Running: false }, Mounts: mounts,
        HostConfig: { NetworkMode: 'none', SecurityOpt: ['no-new-privileges'], CapDrop: ['ALL'],
          UsernsMode: 'keep-id', Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev' } },
      }))
    }, { sharedWorkspacePolicy: {
      get: async id => saved.get(id), set: async (id, enabled) => { saved.set(id, enabled) },
    } })
    const signal = new AbortController().signal
    expect(await f.runtime.sharedWorkspaceFor(sessions.alice)).toBeUndefined()
    await expect(f.runtime.setSharedWorkspaceAccess(sessions.alice, true, signal)).resolves.toBe('applied')
    expect(await f.runtime.sharedWorkspaceFor(sessions.alice)).toBe('/workspace')
    expect(await f.runtime.sharedWorkspaceFor(sessions.bob)).toBeUndefined()
    await f.runtime.ensure(sessions.alice)
    expect(f.runtime.execArgv(sessions.alice, ['pwd'], { workdir: '/workspace' })).toContain('/workspace')
    const finish = f.runtime.beginUse(sessions.alice)
    try {
      await expect(f.runtime.setSharedWorkspaceAccess(sessions.alice, false, signal)).resolves.toBe('busy')
    } finally {
      finish()
    }
    await expect(f.runtime.setSharedWorkspaceAccess(sessions.alice, false, signal)).resolves.toBe('applied')
    expect(await f.runtime.sharedWorkspaceFor(sessions.alice)).toBeUndefined()
    await f.runtime.ensure(sessions.alice)
    expect(() => f.runtime.execArgv(sessions.alice, ['pwd'], { workdir: '/workspace' })).toThrow('workspace')
    const runs = f.calls.filter(argv => argv[1] === 'run')
    expect(runs.map(argv => argv.some(argument => argument.endsWith(':/workspace:rw,nodev,nosuid,nocopy')))).toEqual([true, false])
    expect(runs[0]?.[runs[0].indexOf('--volume') + 1]).toBe(runs[1]?.[runs[1].indexOf('--volume') + 1])
    expect(f.calls.filter(argv => argv.includes('rm')).map(argv => argv.slice(1, -1))).toEqual([['rm']])
  })

  it('refuses a pre-existing project volume backed by a host path', async () => {
    const f = fixture(undefined, { sharedWorkspace: true, hostileSharedVolume: true })
    await expect(f.runtime.ensure(sessions.alice)).rejects.toThrow('Shared project volume')
    expect(f.calls.some(argv => argv[1] === 'run')).toBe(false)
  })

  it('reuses a short ready cache for repeated filesystem operations', async () => {
    const f = fixture()
    await f.runtime.ensure(sessions.alice)
    const firstCallCount = f.calls.length
    await f.runtime.ensure(sessions.alice)
    expect(f.calls).toHaveLength(firstCallCount)
  })

  it.each([
    { description: 'the existing matching rootless network', internet: true, mode: 'slirp4netns', partialArgv: ['--network=slirp4netns:allow_host_loopback=false'], published: {}, allowed: true },
    { description: 'an existing connected container after revocation', internet: false, mode: 'slirp4netns', partialArgv: ['--network=slirp4netns:allow_host_loopback=false'], published: {}, allowed: false },
    { description: 'a rootless network with host loopback access', internet: true, mode: 'slirp4netns', partialArgv: ['--network=slirp4netns:allow_host_loopback=true'], published: {}, allowed: false },
    { description: 'a container with a published port', internet: true, mode: 'slirp4netns', partialArgv: ['--network=slirp4netns:allow_host_loopback=false'], published: { '443/tcp': [{ HostPort: '8443' }] }, allowed: false },
  ])('validates $description before reuse', async ({ internet, mode, partialArgv, published, allowed }) => {
    const f = fixture(async (argv) => {
      if (argv[1] !== 'inspect') return result()
      const volume = `yharness-bot-volume-${(argv.at(-1) ?? '').replace(/^yharness-bot-/u, '')}`
      const workspace = f.runtime.workspace(sessions.alice)
      return result(0, JSON.stringify({
        ImageName: 'localhost/yharness-vps-bot:24.04',
        Config: { User: '1000:1000', CreateCommand: ['podman', 'run', ...partialArgv], Labels: {
          'io.yharness.vps.root': f.root,
          'io.yharness.vps.image': 'localhost/yharness-vps-bot:24.04',
          'io.yharness.vps.session': sessions.alice,
          'io.yharness.vps.workspace': workspace,
          'io.yharness.vps.volume': volume,
        } },
        State: { Running: false },
        Mounts: [{ Type: 'volume', Name: volume, Destination: workspace, RW: true, Options: ['nodev', 'nosuid'] }],
        HostConfig: {
          NetworkMode: mode, PortBindings: published, SecurityOpt: ['no-new-privileges'], CapDrop: ['ALL'],
          UsernsMode: 'private', Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev' },
        },
      }))
    }, { internet, userService: true })
    const ready = f.runtime.ensure(sessions.alice)
    if (allowed) await ready
    else await expect(ready).rejects.toThrow('network does not match its settings')
    const launches = f.calls.filter(argv => argv[0] === '/usr/bin/systemd-run')
    expect(launches.map(argv => argv.slice(argv.indexOf('/usr/bin/podman') + 1)[0])).toEqual(allowed ? ['start'] : [])
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

  it.each([
    { report: 'literal ALL', capDrop: ['ALL'], effective: undefined, bounding: undefined, capAdd: [], namespaces: {}, allowed: true },
    { report: 'expanded empty capabilities', capDrop: ['CAP_CHOWN'], effective: null, bounding: null, capAdd: [], namespaces: {}, allowed: true },
    { report: 'nonempty bounding set', capDrop: ['CAP_CHOWN'], effective: null, bounding: ['CAP_KILL'], capAdd: [], namespaces: {}, allowed: false },
    { report: 'explicit additions', capDrop: ['ALL'], effective: null, bounding: null, capAdd: ['CAP_KILL'], namespaces: {}, allowed: false },
    { report: 'a host PID namespace', capDrop: ['ALL'], effective: null, bounding: null, capAdd: [], namespaces: { PidMode: 'host' }, allowed: false },
    { report: 'a borrowed IPC namespace', capDrop: ['ALL'], effective: null, bounding: null, capAdd: [], namespaces: { IpcMode: 'container:other' }, allowed: false },
    { report: 'a host UTS namespace', capDrop: ['ALL'], effective: null, bounding: null, capAdd: [], namespaces: { UTSMode: 'host' }, allowed: false },
  ])('checks $report before restarting a stopped container', async ({ capDrop, effective, bounding, capAdd, namespaces, allowed }) => {
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
          ...namespaces,
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
    expect(() => f.runtime.execArgv(sessions.alice, [])).toThrow('non-empty argv')
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

describe('VpsBotSubprocess terminal', () => {
  it('starts the selected container shell through a scrubbed attached PTY', async () => {
    const { runtime } = fixture()
    const ctx = new Context()
    try {
      const host = new LocalSubprocessRuntime(ctx)
      const exit = Promise.withResolvers<{ exitCode: number; signal: null }>()
      const stopLocal = vi.fn(async () => { exit.resolve({ exitCode: 0, signal: null }) })
      const terminal: SubprocessTerminalHandle = {
        pid: 123, output: new PassThrough(), done: exit.promise,
        write: async () => {}, resize: async () => {}, terminate: stopLocal,
        inspectForeground: async () => undefined, signalForeground: async () => 123,
        inspectActivity: async () => ({ state: 'unknown', revision: 0 }),
      }
      const start = vi.spyOn(host, 'spawnTerminal').mockResolvedValue(terminal)
      const stopContainer = vi.spyOn(runtime, 'desktopCommand').mockResolvedValue(Buffer.alloc(0))
      const ensure = vi.spyOn(runtime, 'ensure')
      const provider = new VpsBotSubprocess(ctx.isolate('subprocess'), { runtime, sessionId: sessions.alice, host })
      const cwd = runtime.workspace(sessions.alice)
      const spec: SubprocessTerminalSpawnSpec = {
        argv: ['/bin/bash', '-i'], cwd, env: { PRIVATE_API_KEY: 'fixture-value' },
        cols: 80, rows: 25, terminalType: 'xterm-256color', shellActivity: true, graceMs: 1000,
      }
      const scoped = await provider.spawnTerminal(spec)
      expect(scoped.output).toBe(terminal.output)
      expect(ensure).toHaveBeenCalledWith(sessions.alice)
      const passed = start.mock.calls[0]?.[0]
      expect(passed).toMatchObject({ cwd: '/', env: undefined, cols: 80, rows: 25 })
      expect(passed?.argv).toEqual(expect.arrayContaining([
        '/usr/bin/env', '-i', '/usr/bin/podman', 'exec', '--interactive', '--tty', '--workdir', cwd, '/bin/bash',
      ]))
      expect(passed?.argv).not.toContain('PRIVATE_API_KEY')
      const protocol = passed?.argv.slice(-5)
      expect(protocol).toEqual(['start', expect.stringMatching(/^[a-f0-9]{32}$/u), 'xterm-256color', '/bin/bash', '-i'])
      await Promise.all([scoped.terminate(), scoped.terminate()])
      expect(stopContainer).toHaveBeenCalledOnce()
      expect(stopContainer.mock.calls[0]?.[0]).toBe(sessions.alice)
      expect(stopContainer.mock.calls[0]?.[1].slice(-3)).toEqual(['stop', protocol?.[1], '1000'])
      expect(stopLocal).toHaveBeenCalledOnce()
      await expect(provider.spawnTerminal({ ...spec, cwd: runtime.workspace(sessions.bob) })).rejects.toThrow('workspace')
      expect(start).toHaveBeenCalledOnce()

      const initializing = Promise.withResolvers<undefined>()
      ensure.mockReturnValueOnce(initializing.promise)
      const abort = new AbortController()
      const pending = provider.spawnTerminal({ ...spec, signal: abort.signal })
      const cancelled = expect(pending).rejects.toThrow('fixture allocation cancelled')
      abort.abort(new Error('fixture allocation cancelled'))
      initializing.resolve(undefined)
      await cancelled
      expect(start).toHaveBeenCalledOnce()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
