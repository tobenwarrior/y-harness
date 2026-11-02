/** Bot-scoped routine tools backed by the Host Schedule service. */

import type { Context } from '@yharness/cordis'
import { registerScheduleTools } from '@yharness/tool-schedule'
import type { PreToolDecision, ToolExecution } from '@yharness/tools'

const ROUTINE_MUTATIONS = new Set(['schedule_create', 'schedule_update', 'schedule_delete'])

/**
 * Add durable routine management to one Bot Agent scope.
 *
 * The Schedule tools already bind every operation to `exec.agent.session.id`.
 * Keeping their registrations inside the Bot scope therefore preserves the
 * Bot's single Session while this local policy asks before a routine changes
 * Host storage. A missing Schedule service leaves the optional injection
 * pending, so compositions without scheduling keep the Bot roster usable.
 *
 * @param scope - Agent scope owned by one Bot.
 * @returns The optional dependency fiber, which resolves after registration.
 */
export function installBotRoutineTools(scope: Context): ReturnType<Context['inject']> {
  return scope.inject(['schedule', 'tools'], (scheduleScope: Context) => {
    registerScheduleTools(scheduleScope)
    scheduleScope.on('tools/pre-execute', (exec: ToolExecution, next: () => Promise<PreToolDecision>) => ROUTINE_MUTATIONS.has(exec.name)
      ? Promise.resolve({ kind: 'ask', reason: 'This action changes the Bot routine schedule.' as const })
      : next())
  })
}
