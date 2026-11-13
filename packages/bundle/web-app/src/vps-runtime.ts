/**
 * Rootless Podman runtime for one private desktop per Web Bot session.
 *
 * A runtime owns only the workspaces below its configured private root. Each
 * session receives one long-lived container with one named Podman volume
 * mounted at that same absolute workspace path, an ephemeral private `/tmp`,
 * no network, no inherited container environment, and no host sockets.
 * Commands are returned as argv so callers can route shell and Computer
 * operations through the container without a shell interpolation step.
 * @module @yharness/web-app/vps-runtime
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, lstat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const PODMAN = '/usr/bin/podman'
const SESSION_ID_PATTERN = /^bot-session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@:-]*$/u
const PRIVATE_MODE_MASK = 0o077
const PODMAN_TIMEOUT_MS = 120_000
const PODMAN_KILL_GRACE_MS = 2_000
const PODMAN_OUTPUT_LIMIT = 64 * 1024
const DESKTOP_READY_TIMEOUT_MS = 30_000
const DESKTOP_HEALTH_CACHE_MS = 500

/** Exit facts returned by the Podman command seam. */
export interface VpsCommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Injectable Podman seam used by unit tests. Production uses argv-only
 * `spawn`; no command is interpreted by a shell.
 */
export type VpsCommandRunner = (argv: readonly string[]) => Promise<VpsCommandResult>

/** Test-only hooks for the local Podman process and filesystem clock. */
export interface VpsRuntimeInternals {
  readonly run?: VpsCommandRunner
  readonly uid?: () => number | undefined
}

/** Runtime options for one `podman exec` operation. */
export interface VpsExecOptions {
  /** Absolute directory below this session's workspace. */
  readonly workdir?: string
  /** Keep stdin open without allocating a pseudo-terminal. */
  readonly stdin?: boolean
  /** Allocate stdin and a pseudo-terminal for an interactive command. */
  readonly interactive?: boolean
}

/** Safe failure raised before a Podman command can cross the runtime's scope. */
export class VpsRuntimeError extends Error {
  /**
   * @param message - Safe diagnostic for the Web host; Podman output is not included.
   */
  constructor(message: string) {
    super(message)
    this.name = 'VpsRuntimeError'
  }
}

/**
 * One rootless Podman container and named volume per validated Bot session.
 *
 * The constructor is intentionally side-effect free. `ensure()` creates the
 * private root and host placeholder workspace lazily, then creates and starts
 * the session's named volume/container. Concurrent calls for one session share
 * one promise; different sessions retain distinct container and volume names.
 */
export class VpsRuntime {
  private readonly rootPath: string
  private readonly imageName: string
  private readonly internals: VpsRuntimeInternals
  private readonly pending = new Map<string, Promise<void>>()
  private readonly healthyUntil = new Map<string, number>()

  /**
   * @param root - Absolute owner-only directory containing all Bot workspaces.
   * @param image - Audited local Podman image reference.
   * @param internals - Optional command seam used by tests.
   */
  constructor(root: string, image: string, internals: VpsRuntimeInternals = {}) {
    this.rootPath = privatePath(root, 'VPS Bot root')
    this.imageName = imageReference(image)
    this.internals = internals
  }

  /**
   * Return the deterministic private workspace for a roster session.
   * @param sessionId - Roster UUID for the Bot session.
   * @returns The absolute workspace path, also used inside its container.
   */
  workspace(sessionId: string): string {
    validateSessionId(sessionId)
    return resolve(this.rootPath, sessionId)
  }

  /**
   * Create and start one session container if it is not already running.
   * @param sessionId - Roster UUID for the Bot session.
   * @returns A promise settled after the container is running.
   */
  async ensure(sessionId: string): Promise<void> {
    validateSessionId(sessionId)
    const existing = this.pending.get(sessionId)
    if (existing !== undefined) return existing
    const now = Date.now()
    if ((this.healthyUntil.get(sessionId) ?? 0) > now) return
    const task = Promise.resolve().then(async () => {
      await this.ensureOne(sessionId)
      this.healthyUntil.set(sessionId, Date.now() + DESKTOP_HEALTH_CACHE_MS)
    })
    this.pending.set(sessionId, task)
    const clear = (): void => {
      this.pending.delete(sessionId)
      if ((this.healthyUntil.get(sessionId) ?? 0) <= Date.now()) {
        this.healthyUntil.delete(sessionId)
      }
    }
    void task.then(clear, clear)
    return task
  }

  /**
   * Build an argv-only `podman exec` invocation for one session.
   *
   * The command is not run by this method. Callers must await `ensure()` and
   * then pass this argv to their process provider. `workdir` may not escape
   * the session workspace, and command arguments are never parsed as a shell.
   * @param sessionId - Roster UUID for the Bot session.
   * @param argv - Non-empty executable and positional arguments.
   * @param options - Optional scoped working directory and terminal mode.
   * @returns A fresh immutable argv array suitable for an argv-only spawner.
   */
  execArgv(sessionId: string, argv: readonly string[], options: VpsExecOptions = {}): readonly [string, ...string[]] {
    validateSessionId(sessionId)
    if (argv.some(argument => argument.includes('\u0000'))) {
      throw new VpsRuntimeError('VPS Bot command arguments must not contain NUL bytes')
    }
    const workspace = this.workspace(sessionId)
    const workdir = options.workdir === undefined ? workspace : scopedWorkdir(workspace, options.workdir)
    const command: [string, ...string[]] = ['/usr/bin/env', '-i', ...podmanEnvironmentArgs(), PODMAN, 'exec']
    if (options.stdin === true || options.interactive === true) command.push('--interactive')
    if (options.interactive === true) command.push('--tty')
    command.push('--workdir', workdir, containerName(this.rootPath, sessionId), ...argv)
    return Object.freeze(command)
  }

  private async ensureOne(sessionId: string): Promise<void> {
    await ensurePrivateDirectory(this.rootPath, this.internals.uid)
    const workspace = this.workspace(sessionId)
    await ensurePrivateDirectory(workspace, this.internals.uid)
    const name = containerName(this.rootPath, sessionId)
    const volume = volumeName(this.rootPath, sessionId)
    const exists = await this.runPodman(['container', 'exists', name])
    if (exists.code === 0) {
      await this.ensureVolume(volume, sessionId, workspace)
      const inspected = await this.runPodman(['inspect', '--format', '{{json .}}', name])
      if (inspected.code !== 0) throw new VpsRuntimeError('VPS Bot container inspection failed')
      const metadata = inspectContainer(inspected.stdout, this.rootPath, this.imageName, sessionId, workspace, volume)
      if (!metadata.running) {
        const started = await this.runPodman(['start', name])
        if (started.code !== 0) throw new VpsRuntimeError('VPS Bot container could not be restarted')
      }
      await this.waitForDesktop(name, workspace)
      return
    }
    if (exists.code !== 1) throw new VpsRuntimeError('VPS Bot container lookup failed')
    await this.ensureVolume(volume, sessionId, workspace)
    const launched = await this.runPodman([
      'run',
      '--detach',
      '--name', name,
      '--userns=keep-id',
      ...runtimeUserArgs(),
      '--network=none',
      '--no-hosts',
      '--http-proxy=false',
      '--image-volume=ignore',
      '--security-opt=no-new-privileges',
      '--cap-drop=ALL',
      '--volume', `${volume}:${workspace}:rw,nodev,nosuid`,
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev',
      '--workdir', workspace,
      '--label', `io.yharness.vps.root=${this.rootPath}`,
      '--label', `io.yharness.vps.session=${sessionId}`,
      '--label', `io.yharness.vps.workspace=${workspace}`,
      '--label', `io.yharness.vps.volume=${volume}`,
      '--label', `io.yharness.vps.image=${this.imageName}`,
      '--pull=never',
      this.imageName,
    ])
    if (launched.code !== 0) throw new VpsRuntimeError('VPS Bot container could not be launched')
    await this.waitForDesktop(name, workspace)
  }

  private async ensureVolume(volume: string, sessionId: string, workspace: string): Promise<void> {
    const exists = await this.runPodman(['volume', 'exists', volume])
    if (exists.code === 1) {
      const created = await this.runPodman([
        'volume', 'create',
        '--label', `io.yharness.vps.root=${this.rootPath}`,
        '--label', `io.yharness.vps.session=${sessionId}`,
        '--label', `io.yharness.vps.workspace=${workspace}`,
        '--label', `io.yharness.vps.image=${this.imageName}`,
        volume,
      ])
      if (created.code !== 0) throw new VpsRuntimeError('VPS Bot workspace volume could not be created')
    } else if (exists.code !== 0) {
      throw new VpsRuntimeError('VPS Bot workspace volume lookup failed')
    }
    const inspected = await this.runPodman(['volume', 'inspect', '--format', '{{json .}}', volume])
    if (inspected.code !== 0 || !inspectVolume(inspected.stdout, this.rootPath, this.imageName, sessionId, workspace, volume)) {
      throw new VpsRuntimeError('VPS Bot workspace volume ownership does not match this runtime')
    }
  }

  private async waitForDesktop(name: string, workspace: string): Promise<void> {
    const deadline = Date.now() + DESKTOP_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      const ready = await this.runPodman(['exec', '--workdir', workspace, name, 'xdotool', 'getdisplaygeometry'])
      if (ready.code === 0) return
      await new Promise<void>((resolveReady) => { setTimeout(resolveReady, 50) })
    }
    throw new VpsRuntimeError('VPS Bot desktop did not become ready')
  }

  private async runPodman(args: readonly string[]): Promise<VpsCommandResult> {
    const argv: readonly [string, ...string[]] = [PODMAN, ...args]
    const result = this.internals.run === undefined
      ? await runPodmanProcess(argv)
      : await this.internals.run(argv)
    if (!Number.isInteger(result.code) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
      throw new VpsRuntimeError('VPS Bot Podman returned invalid command facts')
    }
    return result
  }
}

function validateSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new VpsRuntimeError('VPS Bot session id must be a roster UUID')
  }
}

function privatePath(value: string, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new VpsRuntimeError(`${label} must be an absolute path without control characters`)
  }
  const normalized = resolve(value)
  if (normalized === sep || normalized === '/tmp') {
    throw new VpsRuntimeError(`${label} must name a dedicated private directory`)
  }
  return normalized
}

function imageReference(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.startsWith('-') || !IMAGE_PATTERN.test(value)) {
    throw new VpsRuntimeError('VPS Bot image must be a safe local image reference')
  }
  return value
}

function scopedWorkdir(workspace: string, requested: string): string {
  if (typeof requested !== 'string' || !isAbsolute(requested) || /[\u0000-\u001f\u007f]/u.test(requested)) {
    throw new VpsRuntimeError('VPS Bot workdir must be an absolute path in its workspace')
  }
  const normalized = resolve(requested)
  const child = relative(workspace, normalized)
  if (child !== '' && (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))) {
    throw new VpsRuntimeError('VPS Bot workdir must remain inside its workspace')
  }
  return normalized
}

function containerName(root: string, sessionId: string): string {
  const rootDigest = createHash('sha256').update(root).digest('hex').slice(0, 16)
  return `yharness-bot-${rootDigest}-${sessionId.replaceAll('-', '')}`
}

function volumeName(root: string, sessionId: string): string {
  const rootDigest = createHash('sha256').update(root).digest('hex').slice(0, 16)
  return `yharness-bot-volume-${rootDigest}-${sessionId.replaceAll('-', '')}`
}

interface ContainerMetadata {
  readonly running: boolean
}

function inspectVolume(
  serialized: string,
  root: string,
  image: string,
  sessionId: string,
  workspace: string,
  volume: string,
): boolean {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    return false
  }
  if (!isRecord(value) || value.Name !== volume || !isRecord(value.Labels)
    || value.Labels['io.yharness.vps.root'] !== root
    || value.Labels['io.yharness.vps.image'] !== image
    || value.Labels['io.yharness.vps.session'] !== sessionId
    || value.Labels['io.yharness.vps.workspace'] !== workspace) {
    return false
  }
  return true
}

function inspectContainer(
  serialized: string,
  root: string,
  image: string,
  sessionId: string,
  workspace: string,
  volume: string,
): ContainerMetadata {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new VpsRuntimeError('VPS Bot container metadata is not valid JSON')
  }
  if (!isRecord(value)) throw new VpsRuntimeError('VPS Bot container metadata is invalid')
  const labels = value.Config
  if (!isRecord(labels) || !isRecord(labels.Labels)
    || labels.Labels['io.yharness.vps.root'] !== root
    || labels.Labels['io.yharness.vps.image'] !== image
    || labels.Labels['io.yharness.vps.session'] !== sessionId
    || labels.Labels['io.yharness.vps.workspace'] !== workspace
    || labels.Labels['io.yharness.vps.volume'] !== volume) {
    throw new VpsRuntimeError('VPS Bot container ownership does not match this runtime')
  }
  if (!isRecord(value.State) || typeof value.State.Running !== 'boolean') {
    throw new VpsRuntimeError('VPS Bot container state is invalid')
  }
  const imageNames = [
    typeof value.ImageName === 'string' ? value.ImageName : undefined,
    typeof labels.Image === 'string' ? labels.Image : undefined,
  ].filter((name): name is string => name !== undefined)
  if (imageNames.length === 0 || imageNames.some(name => name !== image)) {
    throw new VpsRuntimeError('VPS Bot container image is invalid')
  }
  if (!recordArray(value.Mounts)) {
    throw new VpsRuntimeError('VPS Bot container mounts are invalid')
  }
  const workspaceMounts = value.Mounts.filter(mount => mount.Type === 'volume' && mount.Destination === workspace)
  if (!exactlyOne(workspaceMounts)) {
    throw new VpsRuntimeError('VPS Bot container workspace mount is invalid')
  }
  const [workspaceMount] = workspaceMounts
  if (workspaceMount.Name !== volume || workspaceMount.RW !== true) {
    throw new VpsRuntimeError('VPS Bot container workspace mount is invalid')
  }
  if (value.Mounts.some(mount => mount.Type === 'bind' || (mount.Type === 'volume' && mount.Destination !== workspace))) {
    throw new VpsRuntimeError('VPS Bot container has an unexpected host mount')
  }
  const volumeMode = mountOptions(workspaceMount)
  if (!volumeMode.includes('nodev') || !volumeMode.includes('nosuid')) {
    throw new VpsRuntimeError('VPS Bot workspace volume options are invalid')
  }
  const hostConfig = value.HostConfig
  const tmpfs = isRecord(hostConfig) && isRecord(hostConfig.Tmpfs) ? hostConfig.Tmpfs['/tmp'] : undefined
  const tmpfsMount = value.Mounts.find(mount => mount.Type === 'tmpfs' && mount.Destination === '/tmp')
  const tmpfsOptions = typeof tmpfs === 'string' ? tmpfs.split(',') : tmpfsMount === undefined ? [] : mountOptions(tmpfsMount)
  if (!tmpfsOptions.includes('noexec') || !tmpfsOptions.includes('nosuid') || !tmpfsOptions.includes('nodev')) {
    throw new VpsRuntimeError('VPS Bot container temporary storage is invalid')
  }
  if (!isRecord(hostConfig) || hostConfig.NetworkMode !== 'none' || hostConfig.Privileged === true
    || !stringArray(hostConfig.SecurityOpt, 'no-new-privileges')
    || !capabilitiesDropped(value, hostConfig)
    || (typeof hostConfig.UsernsMode !== 'string'
      || (hostConfig.UsernsMode !== 'private' && !hostConfig.UsernsMode.startsWith('keep-id')))) {
    throw new VpsRuntimeError('VPS Bot container privileges are invalid')
  }
  const containerConfig = value.Config
  if (!isRecord(containerConfig) || typeof containerConfig.User !== 'string' || /^0(?::0)?$/u.test(containerConfig.User)) {
    throw new VpsRuntimeError('VPS Bot container user is invalid')
  }
  return { running: value.State.Running }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord)
}

function exactlyOne<T>(values: readonly T[]): values is readonly [T] {
  return values.length === 1
}

function stringArray(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.includes(expected)
}

function capabilitiesDropped(container: Record<string, unknown>, hostConfig: Record<string, unknown>): boolean {
  const { EffectiveCaps: effective, BoundingCaps: bounding } = container
  const empty = (value: unknown): boolean => value === null || (Array.isArray(value) && value.length === 0)
  for (const caps of [hostConfig.CapAdd, effective, bounding]) {
    if (caps !== undefined && !empty(caps)) return false
  }
  // Podman can report the expanded CapDrop list instead of the original flag.
  return (effective !== undefined && bounding !== undefined) || stringArray(hostConfig.CapDrop, 'ALL')
}

function mountOptions(mount: Record<string, unknown>): string[] {
  if (Array.isArray(mount.Options) && mount.Options.every((option): option is string => typeof option === 'string')) {
    return mount.Options
  }
  if (typeof mount.Mode === 'string') return mount.Mode.split(',')
  return []
}

async function ensurePrivateDirectory(path: string, uidHook?: () => number | undefined): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: true })
  const info = await lstat(path)
  // Windows Node does not expose process.getuid, so ownership cannot be compared there.
  const uid = uidHook?.() ?? (typeof process.getuid === 'function' ? process.getuid() : undefined)
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid) || (info.mode & PRIVATE_MODE_MASK) !== 0) {
    throw new VpsRuntimeError('VPS Bot workspace must be an owner-only directory')
  }
}

async function runPodmanProcess(argv: readonly [string, ...string[]]): Promise<VpsCommandResult> {
  const [command, ...args] = argv
  return await new Promise<VpsCommandResult>((resolveResult, reject) => {
    const child = spawn(command, args, {
      env: podmanEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let failure: VpsRuntimeError | undefined
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    const clearTimers = (): void => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer)
        timeoutTimer = undefined
      }
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer)
        forceKillTimer = undefined
      }
    }
    const terminateAfterFailure = (error: VpsRuntimeError): void => {
      failure = error
      clearTimers()
      forceKillTimer = setTimeout(() => {
        forceKillTimer = undefined
        child.kill('SIGKILL')
      }, PODMAN_KILL_GRACE_MS)
      child.kill('SIGTERM')
    }
    timeoutTimer = setTimeout(() => {
      terminateAfterFailure(new VpsRuntimeError('VPS Bot Podman command timed out'))
    }, PODMAN_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (failure !== undefined) return
      stdout += chunk
      if (Buffer.byteLength(stdout, 'utf8') > PODMAN_OUTPUT_LIMIT) {
        terminateAfterFailure(new VpsRuntimeError('VPS Bot Podman output exceeded its limit'))
      }
    })
    child.stderr.on('data', (chunk: string) => {
      if (failure !== undefined) return
      stderr += chunk
      if (Buffer.byteLength(stderr, 'utf8') > PODMAN_OUTPUT_LIMIT) {
        terminateAfterFailure(new VpsRuntimeError('VPS Bot Podman output exceeded its limit'))
      }
    })
    child.once('error', (error) => {
      void error
      if (settled || failure !== undefined) return
      settled = true
      clearTimers()
      reject(new VpsRuntimeError('VPS Bot Podman could not start'))
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimers()
      if (failure !== undefined) {
        reject(failure)
      } else if (code === null) {
        reject(new VpsRuntimeError('VPS Bot Podman exited without a status'))
      } else {
        resolveResult({ code, stdout, stderr })
      }
    })
  })
}

function podmanEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LC_ALL: 'C',
  }
  const home = process.env.HOME
  if (home !== undefined && isSafeEnvironmentValue(home)) environment.HOME = home
  const runtime = process.env.XDG_RUNTIME_DIR
  if (runtime !== undefined && isSafeEnvironmentValue(runtime)) environment.XDG_RUNTIME_DIR = runtime
  return environment
}

function podmanEnvironmentArgs(): string[] {
  const environment = podmanEnvironment()
  return Object.entries(environment).map(([key, value]) => `${key}=${value}`)
}

function runtimeUserArgs(): string[] {
  // Windows Node has no numeric host IDs; retain Podman's default user mapping there.
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') return []
  return ['--user', `${String(process.getuid())}:${String(process.getgid())}`]
}

function isSafeEnvironmentValue(value: string): boolean {
  return !/[\u0000-\u001f\u007f]/u.test(value)
}
