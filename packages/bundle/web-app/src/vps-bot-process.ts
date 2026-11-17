/** Subprocess adapter for the managed Bot computer. */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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
import { VpsRuntimeError, type VpsRuntime } from './vps-runtime.ts'
import { scopedBotTerminal, TERMINAL_SCOPE_SCRIPT } from './vps-bot-terminal.ts'

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
    const finished = runtime.beginUse(sessionId)
    try {
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
    } finally {
      finished()
    }
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
    const finished = runtime.beginUse(sessionId)
    try {
      const child = host.spawn({ ...spec, argv, cwd: '/', env: undefined })
      void child.done.then(finished, finished)
      return child
    } catch (error) {
      finished()
      throw error
    }
  }

  /** @inheritdoc */
  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    spec.signal?.throwIfAborted()
    const { runtime, sessionId, host } = this.config
    const scope = randomUUID().replaceAll('-', '')
    const control = ['/usr/bin/python3', '-I', '-c', TERMINAL_SCOPE_SCRIPT]
    const stop = async (): Promise<void> => {
      try {
        await runtime.desktopCommand(sessionId, [...control, 'stop', scope, String(spec.graceMs)], new AbortController().signal)
      } catch (error) {
        void error
        throw new VpsRuntimeError('The VPS Bot terminal session could not be closed.')
      }
    }
    const finished = runtime.beginUse(sessionId)
    try {
      await runtime.ensure(sessionId)
      spec.signal?.throwIfAborted()
      const argv = runtime.execArgv(sessionId, [...control, 'start', scope, spec.terminalType, ...spec.argv], {
        workdir: spec.cwd, interactive: true,
      })
      try {
        const terminal = scopedBotTerminal(await host.spawnTerminal({ ...spec, argv, cwd: '/', env: undefined }), stop)
        void terminal.done.then(finished, finished)
        return terminal
      } catch (error) {
        try {
          await stop()
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'The VPS Bot terminal could not be opened or cleaned up.')
        }
        throw error
      }
    } catch (error) {
      finished()
      throw error
    }
  }
}
