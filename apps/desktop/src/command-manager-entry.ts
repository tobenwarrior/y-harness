/** Private command-management worker; macOS mutation targets are fixed before elevation. */

import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CommandInstallationError, inspectFileCommand, installFileCommand, removeFileCommand } from './command-installation.ts'

const [operation, expected] = process.argv.slice(2)
const fingerprint = expected ?? ''
const resources = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// This dedicated worker writes public command ownership metadata, not user secrets.
if (process.platform === 'darwin') process.umask(0o022)

type MacCommandOptions = Parameters<typeof inspectFileCommand>[0]

function macCommandOptions(): { canonical: MacCommandOptions; legacy: MacCommandOptions } {
  const linkHelper = join(resources, 'runtime', 'cli', 'link-entry')
  return {
    canonical: { destination: '/usr/local/bin/yharness', launcher: join(resources, 'runtime', 'cli', 'bin', 'yharness'), linkHelper,
      receiptName: '.yharness-desktop-command.json' },
    legacy: { destination: '/usr/local/bin/dsh', launcher: join(resources, 'runtime', 'cli', 'bin', 'dsh'), linkHelper },
  }
}

async function selectMacCommand(operation: string, fingerprint: string): Promise<MacCommandOptions> {
  const { canonical, legacy } = macCommandOptions()
  const current = await inspectFileCommand(canonical)
  if (operation === 'inspect') {
    if (current.kind !== 'missing') return canonical
    const old = await inspectFileCommand(legacy)
    return old.kind === 'missing' ? canonical : legacy
  }
  if (current.fingerprint === fingerprint) return canonical
  const old = await inspectFileCommand(legacy)
  return old.fingerprint === fingerprint ? legacy : canonical
}

try {
  if (operation !== 'inspect' && operation !== 'install' && operation !== 'remove') {
    throw new CommandInstallationError('EINVAL', 'Invalid command-management operation.')
  }
  if (operation !== 'inspect' && !/^[a-f0-9]{64}$/u.test(fingerprint)) throw new CommandInstallationError('EINVAL', 'Missing command confirmation.')
  if (process.platform === 'darwin') {
    const options = await selectMacCommand(operation, fingerprint)
    const state = operation === 'inspect' ? await inspectFileCommand(options)
      : operation === 'install' ? await installFileCommand(options, fingerprint) : await removeFileCommand(options, fingerprint)
    process.stdout.write(JSON.stringify({ ok: true, state }) + '\n')
  } else if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
    if (systemRoot === undefined) throw new CommandInstallationError('ENOENT', 'Windows system directory is unavailable.')
    const child = spawn(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(resources, 'runtime', 'cli', 'command-path.ps1')],
      { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
    child.stdout.pipe(process.stdout)
    const exited = new Promise<number | null>((accept, reject) => {
      child.once('error', reject)
      child.once('close', accept)
    })
    child.stdin.end(JSON.stringify({ operation, expected, directory: join(resources, 'runtime', 'cli', 'bin') }))
    process.exitCode = await exited ?? 1
  } else {
    throw new CommandInstallationError('EUNSUPPORTED', 'Command installation is supported on macOS and Windows.')
  }
} catch (error) {
  // osascript preserves stdout only when the command exits successfully; the response owns operation failures.
  process.stdout.write(JSON.stringify({
    ok: false,
    code: error instanceof CommandInstallationError ? error.code : (error as NodeJS.ErrnoException).code ?? 'EIO',
    message: error instanceof Error ? error.message : 'Command management failed.',
  }) + '\n')
}
