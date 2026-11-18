/**
 * Per-agent execution capability for managed Bot workspaces. The capability
 * carries the complete provider set for one isolated execution world so a
 * tool cannot accidentally fall back to the host services in its parent
 * context.
 *
 * @module @yharness/sandbox-policy/managed-execution
 */

import { isAbsolute } from 'node:path'
import { posix } from 'node:path'
import type { Context } from '@yharness/cordis'
import type { FileSystem } from '@yharness/fs'
import type { DshEnvironment, ShellExecutor } from '@yharness/shell'
import type { SubprocessRuntime } from '@yharness/subprocess'
import type { SandboxPolicyService } from './index.ts'

/**
 * The provider set and immutable execution facts for one managed Bot scope.
 * Providers MUST belong to the same isolated execution world: `shell`, `fs`,
 * and `subprocess` address the workspace named by `workspaceRoot`.
 */
export interface ManagedBotExecution {
  /** Context that owns the managed provider lifetimes. */
  readonly context: Context
  /** Shell provider for this managed execution world. */
  readonly shell: ShellExecutor
  /** Filesystem provider for this managed execution world. */
  readonly fs: FileSystem
  /** Subprocess provider used by filesystem discovery tools. */
  readonly subprocess: SubprocessRuntime
  /** Policy resolver whose workspace root is in the managed execution world. */
  readonly sandboxPolicy: Pick<SandboxPolicyService, 'defaultMode' | 'resolve'>
  /** Immutable absolute path in the managed execution world. */
  readonly workspaceRoot: string
  /** Optional managed environment overlay; omits host profile paths by default. */
  readonly shellEnv?: DshEnvironment
}

/** Contexts accepted by {@link managedBotExecutionFor}. */
interface AgentContextCarrier {
  readonly agent?: { readonly ctx?: Context }
}

const managedExecutionByContext = new WeakMap<Context, ManagedBotExecution>()

/**
 * Create the capability installed on a managed Bot's agent context.
 *
 * The path is validated as an execution-world absolute path. No host filesystem operation is used;
 * the managed filesystem provider remains authoritative for symlink and
 * target identity checks inside its own world.
 *
 * @param options - managed providers and immutable execution facts.
 * @returns a frozen capability whose provider references cannot be replaced.
 */
export function createManagedBotExecution(options: ManagedBotExecution): ManagedBotExecution {
  if (!posix.isAbsolute(options.workspaceRoot)) {
    throw new Error('managed Bot execution workspaceRoot must be an absolute execution-world path')
  }
  return Object.freeze({
    context: options.context,
    shell: options.shell,
    fs: options.fs,
    subprocess: options.subprocess,
    sandboxPolicy: options.sandboxPolicy,
    workspaceRoot: options.workspaceRoot,
    ...options.shellEnv === undefined ? {} : { shellEnv: Object.freeze({ ...options.shellEnv }) },
  })
}

/**
 * Bind one managed capability to exactly one agent context.
 *
 * This is deliberately separate from Cordis service lookup: an agent context
 * inherits the host service registry, while a managed capability must never be
 * selected through inheritance or an isolation label. The returned disposer is
 * suitable for `ctx.effect` and removes only this exact binding.
 *
 * @param context - the exact agent context used by tool executions.
 * @param execution - capability whose `context` must be the same object.
 * @returns a disposer that removes the binding when the agent scope ends.
 */
export function bindManagedBotExecution(context: Context, execution: ManagedBotExecution): () => void {
  if (execution.context !== context) throw new Error('managed Bot execution context must match its binding context')
  const existing = managedExecutionByContext.get(context)
  if (existing !== undefined && existing !== execution) throw new Error('managed Bot execution is already bound to this context')
  managedExecutionByContext.set(context, execution)
  return () => {
    if (managedExecutionByContext.get(context) === execution) managedExecutionByContext.delete(context)
  }
}

/**
 * Resolve the capability for one tool call, if the call belongs to a managed
 * Bot scope. The lookup uses an exact agent-context binding; ordinary Chat and Mac calls return
 * `undefined` and retain their existing provider path.
 *
 * @param execution - a tool execution carrying its optional Agent.
 * @returns the managed capability, or undefined for an ordinary scope.
 */
export function managedBotExecutionFor(execution: AgentContextCarrier): ManagedBotExecution | undefined {
  const context = execution.agent?.ctx
  return context === undefined ? undefined : managedExecutionByContext.get(context)
}

/**
 * Resolve a model-supplied workdir within a managed execution workspace.
 * Managed calls accept relative paths and absolute paths already inside the
 * managed root, so an old Chat session's host cwd cannot become an authority
 * or be sent to a container provider. The check is lexical by design; the
 * managed filesystem/subprocess provider performs execution-world identity and
 * symlink checks.
 *
 * @param execution - managed Bot capability.
 * @param requested - optional model-supplied directory inside the managed root.
 * @returns an absolute path in the managed execution world.
 * @throws when the requested path escapes the workspace.
 */
export function resolveManagedWorkdir(execution: ManagedBotExecution, requested?: string): string {
  if (requested === undefined) return execution.workspaceRoot
  if (requested.trim().length === 0) throw new Error('managed Bot workdir must be a non-empty path')
  const candidate = posix.isAbsolute(requested) || isAbsolute(requested)
    ? posix.resolve(requested)
    : posix.resolve(execution.workspaceRoot, requested)
  const root = posix.resolve(execution.workspaceRoot)
  const remainder = posix.relative(root, candidate)
  if (remainder === '..' || remainder.startsWith('../') || posix.isAbsolute(remainder)) {
    throw new Error('managed Bot workdir must stay inside the managed execution workspace')
  }
  return candidate
}
