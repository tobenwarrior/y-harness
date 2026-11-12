import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
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
}, browser = false): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-vps-runtime-'))
  roots.push(root)
  const calls: string[][] = []
  const seccompProfile = join(root, 'browser-seccomp.json')
  if (browser) writeFileSync(seccompProfile, '{}', { mode: 0o600 })
  const defaultVolumeCommand = async (argv: readonly string[]): Promise<VpsCommandResult> => {
    const volume = argv.at(-1) ?? ''
    const profile = volume.endsWith('-browser')
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
    run: async (argv) => {
      calls.push([...argv])
      if (argv[1] === 'volume') return await defaultVolumeCommand(argv)
      return await run(argv)
    },
  }, browser ? { image: 'localhost/yharness-vps-bot-browser:24.04-v1', seccompProfile } : undefined)
  return { root, calls, runtime }
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
    const f = fixture(undefined, true)
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
