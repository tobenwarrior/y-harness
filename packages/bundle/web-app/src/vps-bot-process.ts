/** Subprocess adapter for the managed Bot computer. */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isAbsolute } from 'node:path/posix'
import type { Context } from '@yharness/cordis'
import {
  SubprocessExecutableNotFoundError,
  SubprocessRuntime,
  type SubprocessHandle,
  type SubprocessSpawnSpec,
  type SubprocessTerminalEnvironment,
  type SubprocessTerminalHandle,
  type SubprocessTerminalSpawnSpec,
} from '@yharness/subprocess'
import type { VpsRuntime } from './vps-runtime.ts'

const exec = promisify(execFile)

/** Provider instance bound to exactly one computer. */
export interface VpsBotProcessConfig {
  readonly runtime: VpsRuntime
  readonly sessionId: string
  readonly host: SubprocessRuntime
}

/** Runs scoped subprocess calls via the existing host process lifecycle. */
export class VpsBotSubprocess extends SubprocessRuntime {
  constructor(ctx: Context, private readonly config: VpsBotProcessConfig) {
    super(ctx)
  }

  /** @inheritdoc */
  override async resolveExecutable(command: string, _env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    if (command === '' || command.includes('\0') || (command.includes('/') && !isAbsolute(command))) {
      throw new SubprocessExecutableNotFoundError(command)
    }
    const { runtime, sessionId } = this.config
    await runtime.ensure(sessionId)
    signal?.throwIfAborted()
    const [program, ...argv] = runtime.execArgv(sessionId, [
      '/bin/bash', '-c', 'if [[ "$1" == /* ]]; then [[ -f "$1" && -x "$1" ]] && printf "%s\\n" "$1"; else type -P -- "$1"; fi', 'bash', command,
    ])
    try {
      const { stdout } = await exec(program, argv, { signal, timeout: 10_000, maxBuffer: 4096 })
      const path = stdout.trim()
      if (isAbsolute(path)) return path
    } catch (error) {
      void error
      signal?.throwIfAborted()
    }
    throw new SubprocessExecutableNotFoundError(command)
  }

  /** @inheritdoc */
  override terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    signal?.throwIfAborted()
    return Promise.resolve({ platform: 'posix', defaultShell: '/bin/bash' })
  }

  /** @inheritdoc */
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const { runtime, sessionId, host } = this.config
    if (spec.stdio.control !== undefined) throw new Error('The VPS Bot process provider does not forward host control descriptors.')
    const argv = runtime.execArgv(sessionId, spec.argv, { workdir: spec.cwd, stdin: spec.stdio.stdin !== 'ignore' })
    return host.spawn({ ...spec, argv, cwd: '/', env: undefined })
  }

  /** @inheritdoc */
  override spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new Error('Open the VPS Bot’s Computer panel to use an interactive terminal.'))
  }
}
