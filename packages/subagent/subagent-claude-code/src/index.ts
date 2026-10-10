/**
 * Profile-named Claude Code one-shot subagent provider. Every accepted run
 * invokes the official Agent SDK in the delegating Session's workspace and
 * places the SDK-spawned real CLI under the shared subprocess owner.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session } from '@deepseek-ai/dsh-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  CLAUDE_CODE_PERMISSION_MODES,
  DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
  DEFAULT_DISPOSE_GRACE_MS,
  claudeCodeStartupFailure,
  startClaudeCodeRun,
  type ClaudeCodePermissionMode,
  type ClaudeCodeRunSpec,
} from './run.ts'
import { MAX_CLAUDE_CODE_TOOL_OBSERVATIONS, type ClaudeCodeToolObservation } from './tool-observations.ts'
import * as Root from './root.ts'
import type { ClaudeCodeRootConfig } from './root.ts'

export type { ClaudeCodeToolObservation, ClaudeCodeToolObservationOptions } from './tool-observations.ts'
export type { ClaudeCodeRootConfig } from './root.ts'
export type { ClaudeRootProtocolRecord } from './root-types.ts'
export { createClaudeSequentialExecutor, claudeSequentialProjectDirectory } from './sequential.ts'
export type { ClaudeSequentialSelection, ClaudeSequentialSdk, ClaudeSequentialStartupPolicyReceipt, ClaudeSequentialTurnReceipt, ClaudeSequentialExecutor } from './sequential.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Observe-only direct native child receipts, separate from parent task evidence.
     * @mode emit
     * @param observations - frozen source-labelled metadata, without bodies or native turn claims.
     * @param parent - exact Session that initiated this one-shot child query.
     */
    'claude-code/tool-observations': (observations: readonly ClaudeCodeToolObservation[], parent: Session) => void
  }
}

export const name = 'subagent-claude-code'
export const inject = ['subagents', 'subprocess']

const DEFAULT_PROVIDER_NAME = 'claude-code'

/* jscpd:ignore-start -- sibling product providers intentionally expose
 * overlapping deployment-owned fields without adding a shared config owner. */
/** Deployment-owned model, permission, environment, and process-release settings. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `claude-code`). */
  providerName?: string
  /** Native Claude model fixed for this instance; omitted to inherit Claude settings. */
  model?: string
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment.
   */
  env?: Record<string, string>
  /**
   * Native non-interactive mode fixed for this Provider instance. Defaults to
   * `dontAsk`; `acceptEdits` accepts edits, `auto` uses the native classifier,
   * `plan` returns a plan without approving execution, and
   * `bypassPermissions` explicitly skips permission checks.
   */
  permissionMode?: ClaudeCodePermissionMode
  /** Grace in milliseconds between Claude Code managed-range termination tiers. */
  disposeGraceMs?: number
  /** Direct SDK tool identity collection bound; overflow discards the batch. Defaults to 64, maximum 256. */
  toolObservationMaxItems?: number
  /** Explicit opt-in normal root LLM route; absent means no native root adapter or process. */
  rootRoute?: ClaudeCodeRootConfig | undefined
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  model: z.string().min(1),
  env: z.dict(z.string()).default({}),
  permissionMode: z.union([...CLAUDE_CODE_PERMISSION_MODES])
    .default(DEFAULT_CLAUDE_CODE_PERMISSION_MODE),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  toolObservationMaxItems: z.number().default(64),
  rootRoute: z.union([Root.Config, z.const(undefined)]),
})

type ResolvedConfig = Omit<Required<Config>, 'model' | 'rootRoute'> & Pick<Config, 'model' | 'rootRoute'>
/* jscpd:ignore-end */

/* jscpd:ignore-start -- Cordis registration and shared-seam plumbing mirror
 * the Codex sibling; each product's lifecycle remains package-private. */
class ClaudeCodeProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  async start(request: ResolvedSubagentStartRequest) {
    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error(
        'subagent-claude-code: no working directory for the child — delegate from a parent session that has one',
      )
    }
    let cwd: string
    try {
      cwd = resolveChildCwd(
        'subagent-claude-code',
        undefined,
        parentCwd,
      )
    } catch (error: unknown) {
      if (request.signal.aborted) {
        throw new Error(
          'subagent-claude-code: request was aborted before SDK startup',
        )
      }
      const failure = claudeCodeStartupFailure(error)
      this.ctx.logger.warn(
        `subagent-claude-code "${this.name}": child start failed: %o`,
        failure,
      )
      throw failure
    }
    const spec: ClaudeCodeRunSpec = {
      cwd,
      ...this.config.model === undefined ? {} : { model: this.config.model },
      permissionMode: this.config.permissionMode,
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      toolObservations: {
        maxItems: this.config.toolObservationMaxItems,
        sink: (observations) => {
          for (const callback of this.ctx.events.dispatch('emit', [
            request.parent, 'claude-code/tool-observations', observations, request.parent.session,
          ])) {
            try {
              const returned: unknown = callback(observations, request.parent.session)
              void Promise.resolve(returned).catch((error: unknown) => {
                this.ctx.logger.warn('subagent-claude-code: tool observation listener rejected: %o', error)
              })
            } catch (error: unknown) {
              this.ctx.logger.warn('subagent-claude-code: tool observation listener threw: %o', error)
            }
          }
        },
      },
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-claude-code "${this.name}": child run failed (${stopReason}): %o`,
          error,
        )
      },
    }
    return startClaudeCodeRun(request, spec)
  }
}

/**
 * Register one Profile-named Claude Code provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - registry name, optional model, permission mode, child environment, and disposal grace.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    ...config.model === undefined ? {} : { model: config.model },
    env: config.env as Record<string, string>,
    permissionMode: config.permissionMode ?? DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
    disposeGraceMs: config.disposeGraceMs as number,
    toolObservationMaxItems: config.toolObservationMaxItems ?? 64,
    ...config.rootRoute === undefined ? {} : { rootRoute: config.rootRoute },
  }
  assertPositiveFinite(
    'subagent-claude-code',
    'disposeGraceMs',
    resolved.disposeGraceMs,
  )
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-claude-code: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  if (!Number.isSafeInteger(resolved.toolObservationMaxItems) || resolved.toolObservationMaxItems < 1
    || resolved.toolObservationMaxItems > MAX_CLAUDE_CODE_TOOL_OBSERVATIONS) {
    throw new Error('subagent-claude-code: tool observation bound must be an integer from 1 to 256')
  }
  ctx.subagents.registerProvider(new ClaudeCodeProvider(
    resolved.providerName,
    ctx,
    resolved,
  ))
  if (resolved.rootRoute !== undefined) ctx.plugin(Root, resolved.rootRoute)
}
/* jscpd:ignore-end */
