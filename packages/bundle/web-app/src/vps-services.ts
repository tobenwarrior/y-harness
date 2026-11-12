/** Explicit Bot access to systemd service state and owner-approved restarts. */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Context } from '@yharness/cordis'
import { defineTool } from '@yharness/tools'
import { scrubbedParentEnv } from '@yharness/subprocess'

/** One exact Linux service and the Bots allowed to inspect it. */
export interface VpsServiceAccess {
  /** Exact systemd service name. */
  readonly unit: string
  /** System manager or the Web service account's user manager. */
  readonly scope: 'system' | 'user'
  /** Bot roster IDs with this grant. */
  readonly bots: string[]
  /** Allow a single restart after the owner accepts the request. */
  readonly restart?: boolean
}

type Systemctl = (args: readonly string[], signal: AbortSignal) => Promise<string>

const UNIT = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,229}\.service$/u
const STATE = /^[a-z][a-z0-9-]{0,39}$/u
const PROPERTIES = 'Id,LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,NRestarts'
const exec = promisify(execFile)
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args: unknown, text: string) => [{ type: 'text' as const, text }],
} as const

const runSystemctl: Systemctl = async (args, signal) => {
  const { stdout } = await exec('/usr/bin/systemctl', [...args], {
    signal, timeout: 15_000, maxBuffer: 16_384,
    env: { ...scrubbedParentEnv(), LC_ALL: 'C', SYSTEMD_PAGER: '', SYSTEMD_COLORS: '0' },
  })
  return stdout
}

function state(value: string | undefined): string | null {
  return value !== undefined && STATE.test(value) ? value : null
}

function count(value: string | undefined): number | null {
  if (value === undefined || !/^[0-9]{1,10}$/u.test(value)) return null
  return Number(value)
}

/** Allowlisted service operations under the Web service's Linux identity. */
export class VpsServices {
  private readonly access = new Map<string, VpsServiceAccess>()

  /**
   * @param access - Owner-provided, exact service grants.
   * @param run - Optional systemctl runner for tests.
   */
  constructor(access: readonly VpsServiceAccess[], private readonly run: Systemctl = runSystemctl) {
    for (const grant of access) {
      if (!UNIT.test(grant.unit) || grant.unit.endsWith('@.service') || this.access.has(grant.unit)
        || grant.bots.length === 0 || grant.bots.some(bot => bot.trim() === '')) {
        throw new Error('Invalid or duplicate VPS service grant.')
      }
      this.access.set(grant.unit, { ...grant, bots: [...grant.bots] })
    }
  }

  /**
   * List service grants for a Bot without querying the host.
   * @param bot - Calling Bot id from its roster binding.
   * @returns Exact unit names and whether a restart can be requested.
   */
  list(bot: string): { unit: string; restart: boolean }[] {
    return [...this.access.values()].filter(grant => grant.bots.includes(bot))
      .map(grant => ({ unit: grant.unit, restart: grant.restart === true }))
  }

  /**
   * Read fixed service health and exit fields.
   * @param bot - Calling Bot id from its roster binding.
   * @param unit - Exact configured unit.
   * @param signal - Calling turn cancellation.
   * @returns Structured service state with no arbitrary systemctl output.
   */
  async status(bot: string, unit: string, signal: AbortSignal): Promise<{
    unit: string
    load: string | null
    active: string | null
    sub: string | null
    result: string | null
    mainCode: number | null
    mainStatus: number | null
    restarts: number | null
  }> {
    const grant = this.authorize(bot, unit)
    const response = await this.command(grant, ['show', '--property=' + PROPERTIES], signal)
    const fields = new Map(response.split('\n').filter(line => line.includes('=')).map((line) => {
      const separator = line.indexOf('=')
      return [line.slice(0, separator), line.slice(separator + 1)] as const
    }))
    if (fields.get('Id') !== grant.unit || !fields.has('ActiveState')) throw new Error('VPS service status is unavailable.')
    return {
      unit: grant.unit,
      load: state(fields.get('LoadState')),
      active: state(fields.get('ActiveState')),
      sub: state(fields.get('SubState')),
      result: state(fields.get('Result')),
      mainCode: count(fields.get('ExecMainCode')),
      mainStatus: count(fields.get('ExecMainStatus')),
      restarts: count(fields.get('NRestarts')),
    }
  }

  /**
   * Request a one-time owner decision and submit one systemd restart.
   * @param bot - Calling Bot id from its roster binding.
   * @param unit - Exact configured unit.
   * @param approve - Explicit owner approval of the restart.
   * @param signal - Cancellation before systemd accepts the operation.
   */
  async restart(bot: string, unit: string, approve: () => Promise<boolean>, signal: AbortSignal): Promise<void> {
    const grant = this.authorize(bot, unit)
    if (grant.restart !== true) throw new Error('VPS service restart is not authorized.')
    signal.throwIfAborted()
    if (!await approve()) throw new Error('VPS service restart requires owner approval.')
    signal.throwIfAborted()
    await this.command(grant, ['restart'], signal)
  }

  private authorize(bot: string, unit: string): VpsServiceAccess {
    const grant = this.access.get(unit)
    if (grant === undefined || !grant.bots.includes(bot)) throw new Error('This Bot is not authorized for that VPS service.')
    return grant
  }

  private async command(grant: VpsServiceAccess, args: readonly string[], signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    try {
      return await this.run([
        ...(grant.scope === 'user' ? ['--user'] : []),
        '--no-pager', '--no-ask-password', ...args, '--', grant.unit,
      ], signal)
    } catch (error) {
      void error
      signal.throwIfAborted()
      throw new Error('VPS service operation is unavailable under the server’s Linux permissions.')
    }
  }
}

/**
 * Register service diagnostics and, where allowed, the approval-gated restart tool.
 * @param ctx - The owner Bot's tool scope.
 * @param bot - Bot id from the server roster.
 * @param services - Validated operator service grants.
 */
export function registerVpsServiceTools(ctx: Context, bot: string, services: VpsServices): void {
  const grants = services.list(bot)
  if (grants.length === 0) return
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'vps_service_status',
    description: 'Read service state, restart count and last exit details for an authorized VPS service. Omit unit to list available services.',
    parameters: { unit: { type: 'string', description: 'An exact unit from the authorized service list.' } },
    output: TEXT_OUTPUT,
    execute: async ({ unit }, call) => JSON.stringify(unit === undefined ? grants : await services.status(bot, unit, call.signal)),
  })), 'vps-services: diagnostics')
  const approval = ctx.get('approval')
  if (approval === undefined || !grants.some(grant => grant.restart)) return
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'vps_service_restart',
    description: 'Request the owner’s one-time approval to restart an explicitly enabled VPS service.',
    parameters: { unit: { type: 'string', required: true, description: 'An exact unit with restart permission.' } },
    output: TEXT_OUTPUT,
    async execute({ unit }, call) {
      const agent = call.agent
      if (agent === undefined) throw new Error('VPS service restart requires an owner Bot Session.')
      await services.restart(bot, unit, async () => await approval.request({
        agent, toolName: call.name, callId: call.callId, reason: 'Restart VPS service ' + unit, signal: call.signal,
      }) === 'allowed-once', call.signal)
      return 'Restart completed for ' + unit + '.'
    },
  })), 'vps-services: owner-approved restart')
}
