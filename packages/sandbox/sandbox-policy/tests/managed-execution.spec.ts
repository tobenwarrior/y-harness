import { describe, expect, it } from 'vitest'
import { Context } from '@yharness/cordis'
import type { DshEnvironment } from '@yharness/shell'
import type { SandboxPolicyService } from '../src/index.ts'
import {
  bindManagedBotExecution,
  createManagedBotExecution,
  managedBotExecutionFor,
  resolveManagedWorkdir,
} from '../src/managed-execution.ts'
import type { ManagedBotExecution } from '../src/managed-execution.ts'

const WORKSPACE = '/managed/workspace'

function policy(): Pick<SandboxPolicyService, 'defaultMode' | 'resolve'> {
  return {
    defaultMode: 'workspace-write',
    resolve: () => ({ mode: 'workspace-write', workspaceRoot: WORKSPACE }),
  }
}

function options(context: Context, shellEnv?: DshEnvironment): ManagedBotExecution {
  return {
    context,
    shell: {} as ManagedBotExecution['shell'],
    fs: {} as ManagedBotExecution['fs'],
    subprocess: {} as ManagedBotExecution['subprocess'],
    sandboxPolicy: policy(),
    workspaceRoot: WORKSPACE,
    ...(shellEnv === undefined ? {} : { shellEnv }),
  }
}

describe('managed Bot execution capability', () => {
  it('freezes provider references and clones an optional managed environment', () => {
    const context = new Context()
    const withoutEnvironment = createManagedBotExecution(options(context))
    expect(Object.isFrozen(withoutEnvironment)).toBe(true)
    expect(withoutEnvironment).not.toHaveProperty('shellEnv')

    const shellEnv: DshEnvironment = { DSH_BOT_WORKSPACE: WORKSPACE }
    const withEnvironment = createManagedBotExecution(options(new Context(), shellEnv))
    expect(Object.isFrozen(withEnvironment)).toBe(true)
    expect(withEnvironment.shellEnv).toEqual(shellEnv)
    expect(withEnvironment.shellEnv).not.toBe(shellEnv)
    expect(Object.isFrozen(withEnvironment.shellEnv)).toBe(true)
  })

  it('rejects a relative execution-world workspace', () => {
    const context = new Context()
    expect(() => createManagedBotExecution({ ...options(context), workspaceRoot: 'relative/workspace' }))
      .toThrow('workspaceRoot must be an absolute execution-world path')
  })

  it('binds by exact context and leaves newer bindings intact during stale disposal', () => {
    const context = new Context()
    const first = createManagedBotExecution(options(context))
    const second = createManagedBotExecution({ ...first, workspaceRoot: '/managed/other' })

    expect(managedBotExecutionFor({})).toBeUndefined()
    expect(managedBotExecutionFor({ agent: {} })).toBeUndefined()
    expect(managedBotExecutionFor({ agent: { ctx: context } })).toBeUndefined()
    expect(() => bindManagedBotExecution(new Context(), first)).toThrow('context must match')

    const stopFirst = bindManagedBotExecution(context, first)
    const stopSame = bindManagedBotExecution(context, first)
    expect(managedBotExecutionFor({ agent: { ctx: context } })).toBe(first)
    expect(() => bindManagedBotExecution(context, second)).toThrow('already bound')

    stopFirst()
    expect(managedBotExecutionFor({ agent: { ctx: context } })).toBeUndefined()
    const stopSecond = bindManagedBotExecution(context, second)
    stopSame()
    expect(managedBotExecutionFor({ agent: { ctx: context } })).toBe(second)
    stopSecond()
    expect(managedBotExecutionFor({ agent: { ctx: context } })).toBeUndefined()
  })

  it('resolves relative and contained absolute workdirs while refusing empty and escaping paths', () => {
    const execution = createManagedBotExecution(options(new Context()))

    expect(resolveManagedWorkdir(execution)).toBe(WORKSPACE)
    expect(resolveManagedWorkdir(execution, 'nested/./child')).toBe(`${WORKSPACE}/nested/child`)
    expect(resolveManagedWorkdir(execution, `${WORKSPACE}/nested`)).toBe(`${WORKSPACE}/nested`)
    expect(() => resolveManagedWorkdir(execution, '   ')).toThrow('non-empty path')
    expect(() => resolveManagedWorkdir(execution, '../outside')).toThrow('stay inside')
    expect(() => resolveManagedWorkdir(execution, '/etc')).toThrow('stay inside')
  })
})
