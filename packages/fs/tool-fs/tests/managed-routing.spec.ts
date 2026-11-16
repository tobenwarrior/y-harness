import { describe, expect, it } from 'vitest'
import { Context } from '@yharness/cordis'
import SystemPrompt from '@yharness/system-prompt'
import ToolRuntime from '@yharness/tools'
import { ToolCallId } from '@yharness/llm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import LocalFileSystem from '@yharness/fs-local'
import { ShellExecutor } from '@yharness/shell'
import type { ShellExecRequest, ShellExecSpec, ShellExecution } from '@yharness/shell'
import { SubprocessRuntime } from '@yharness/subprocess'
import type { SubprocessTerminalEnvironment, SubprocessTerminalSpawnSpec } from '@yharness/subprocess'
import * as ToolFs from '@yharness/tool-fs'
import { bindManagedBotExecution, createManagedBotExecution, managedBotExecutionFor, resolveManagedWorkdir } from '@yharness/sandbox-policy'
import type { SandboxPolicyService } from '@yharness/sandbox-policy'

class UnusedShell extends ShellExecutor {
  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 1_000,
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes: request.stdoutMaxBytes ?? 1_024,
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  execute(_spec: ShellExecSpec): Promise<ShellExecution> {
    return Promise.reject(new Error('unused managed shell fixture'))
  }
}

class UnusedSubprocess extends SubprocessRuntime {
  resolveExecutable(command: string): Promise<string> { return Promise.resolve(command) }
  terminalEnvironment(): Promise<SubprocessTerminalEnvironment> { return Promise.resolve({ platform: 'posix' }) }
  spawn(): never { throw new Error('unused managed subprocess fixture') }
  spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<never> { return Promise.reject(new Error('unused managed subprocess fixture')) }
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

describe('managed Bot filesystem routing', () => {
  it('uses the scoped filesystem even when the session header points at the host workspace', async () => {
    const hostRoot = mkdtempSync(join(tmpdir(), 'dsh-managed-host-'))
    const managedRoot = mkdtempSync(join(tmpdir(), 'dsh-managed-workspace-'))
    try {
      mkdirSync(join(hostRoot, 'nested'))
      writeFileSync(join(hostRoot, 'nested', 'note.txt'), 'host\n')
      writeFileSync(join(managedRoot, 'note.txt'), 'managed\n')
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(LocalFileSystem, { cwd: hostRoot })
      await ctx.plugin(ToolFs)

      const agentFiber = ctx.plugin(() => {})
      const managedContext = agentFiber.ctx
      const managedFs = new LocalFileSystem(new Context(), { cwd: managedRoot, diffBasisMaxBytes: 10 * 1024 * 1024 })
      const policy: Pick<SandboxPolicyService, 'defaultMode' | 'resolve'> = {
        defaultMode: 'danger-full-access',
        resolve: () => ({ mode: 'danger-full-access', workspaceRoot: managedRoot }),
      }
      const capability = createManagedBotExecution({
        context: managedContext,
        shell: new UnusedShell(managedContext),
        fs: managedFs,
        subprocess: new UnusedSubprocess(managedContext),
        sandboxPolicy: policy,
        workspaceRoot: managedRoot,
      })
      bindManagedBotExecution(managedContext, capability)
      const agent = {
        ctx: managedContext,
        session: { header: { cwd: join(hostRoot, 'nested') } },
      }
      expect(managedBotExecutionFor({ agent })).toBeDefined()
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('managed-read'),
        name: 'read',
        arguments: { file_path: 'note.txt' },
        agent: agent as never,
      })
      expect(result.isError).toBe(false)
      expect(text(result)).toContain('managed')
      expect(text(result)).not.toContain('host')
    } finally {
      rmSync(hostRoot, { recursive: true, force: true })
      rmSync(managedRoot, { recursive: true, force: true })
    }
  })

  it('rejects an absolute managed workdir before a provider call', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-managed-workdir-'))
    try {
      const ctx = new Context()
      const agentFiber = ctx.plugin(() => {})
      const managedContext = agentFiber.ctx
      const policy: Pick<SandboxPolicyService, 'defaultMode' | 'resolve'> = {
        defaultMode: 'danger-full-access',
        resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }),
      }
      const capability = createManagedBotExecution({
        context: managedContext,
        shell: new UnusedShell(managedContext),
        fs: new LocalFileSystem(new Context(), { cwd: root, diffBasisMaxBytes: 10 * 1024 * 1024 }),
        subprocess: new UnusedSubprocess(managedContext),
        sandboxPolicy: policy,
        workspaceRoot: root,
      })
      expect(resolveManagedWorkdir(capability, 'nested')).toBe(join(root, 'nested'))
      expect(() => resolveManagedWorkdir(capability, '/etc')).toThrow('stay inside')
      expect(() => resolveManagedWorkdir(capability, '../outside')).toThrow('stay inside')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
