/**
 * Derive the working directory a filesystem tool resolves relative paths against: the calling
 * agent's per-session workspace (`exec.agent.session.header.cwd`), so each session's
 * `read`/`write`/`edit` act on its workspace, not the server's launch directory.
 * Non-agent calls return `undefined`, leaving the fallback in the provider rather than reading
 * `process.cwd()` at the tool boundary.
 * @module @yharness/tool-fs/session-cwd
 */

import type { Context } from '@yharness/cordis'
import type { FileSystem } from '@yharness/fs'
import type { ToolExecution } from '@yharness/tools'
import { managedBotExecutionFor, resolveManagedWorkdir } from '@yharness/sandbox-policy'

/**
 * Select the filesystem for one tool call. Managed Bot calls carry an
 * execution-world provider; ordinary calls retain the context provider.
 * @param ctx - the plugin context with the host provider fallback.
 * @param exec - the current tool execution.
 * @returns the provider that owns this call's path identities and effects.
 */
export function fileSystemForExecution(ctx: Context, exec: ToolExecution): FileSystem {
  return managedBotExecutionFor(exec)?.fs ?? ctx.fs
}

/**
 * The session workspace cwd for this call, or `undefined` when none applies.
 * @param exec - the tool-execution context; only its optional `agent` is read.
 * @returns the calling agent's session cwd, or undefined for a non-agent caller (the backend then applies its own default).
 */
export function sessionCwd(exec: ToolExecution): string | undefined {
  return exec.agent?.session.header.cwd
}

/**
 * Resolution options shared by all model-facing filesystem tools.
 * @param exec - the tool-execution context supplying session cwd and cancellation.
 * @param policyWorkspaceRoot - resolved per-call root, when a mutation carries sandbox policy.
 * @returns provider resolution options for the current tool call.
 */
export function sessionResolveOptions(
  exec: ToolExecution,
  policyWorkspaceRoot?: string,
): { cwd?: string; signal?: AbortSignal } {
  const managed = managedBotExecutionFor(exec)
  const cwd = managed === undefined
    ? policyWorkspaceRoot ?? sessionCwd(exec)
    : resolveManagedWorkdir(managed)
  return {
    ...cwd !== undefined ? { cwd } : {},
    signal: exec.signal,
  }
}
