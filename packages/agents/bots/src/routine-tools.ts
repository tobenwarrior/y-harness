/** Bot-scoped routine tools backed by the Host Schedule service. */

import type { Context } from '@yharness/cordis'
import { scopeOf } from '@yharness/scope'
import type { PreToolDecision, ToolExecution } from '@yharness/tools'

const ROUTINE_MUTATIONS = new Set(['schedule_create', 'schedule_update', 'schedule_delete'])

/**
 * Add durable routine management to one Bot Agent scope.
 *
 * The Schedule tools already bind every operation to `exec.agent.session.id`.
 * This helper only adds the Bot-specific approval policy; the selected Agent
 * preset owns the tool registration. That keeps `minimal` capability-poor and
 * avoids shadowing the shipped `standard` Schedule registration.
 *
 * @param scope - Agent scope owned by one Bot.
 * @returns The scope injection fiber, which resolves after the policy is attached.
 */
export function installBotRoutineTools(scope: Context): ReturnType<Context['inject']> {
  return scope.inject(['tools'], (scheduleScope: Context) => {
    const key = scopeOf(scheduleScope)
    if (key === undefined || scheduleScope.tools.get('schedule_create', key) === undefined) return
    scheduleScope.on('tools/pre-execute', (exec: ToolExecution, next: () => Promise<PreToolDecision>) => ROUTINE_MUTATIONS.has(exec.name)
      ? Promise.resolve({ kind: 'ask', reason: 'This action changes the Bot routine schedule.' as const })
      : next())
  })
}
