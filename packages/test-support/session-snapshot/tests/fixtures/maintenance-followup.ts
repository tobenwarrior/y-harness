/** Keep a follow-up turn after maintenance at the projected Session boundary. */

import type { Context } from '@yharness/cordis'
import type {} from '@yharness/agent-loop'

/** Snapshot fixture plugin name. */
export const name = 'maintenance-followup'

/**
 * Append a completed maintenance-only turn after the first user turn.
 *
 * The next SDK request is deliberately driven as turn 3. A stale loop phase
 * would reuse turn 2, while the maintenance reconciliation projects the
 * appended boundary and starts the follow-up at turn 3.
 *
 * @param ctx - assembled agent context.
 */
export function apply(ctx: Context): void {
  let firstTurnEnded = false
  let maintenance: Promise<void> | undefined

  ctx.effect(() => {
    const disposeSession = ctx.root.on('session/event', (session, event) => {
      if (session.header.parentSession !== undefined || event.type !== 'turn/end' || event.data.turn !== 1) return
      firstTurnEnded = true
    })
    const disposeStatus = ctx.root.on('agent/status', ({ agent, status }) => {
      if (
        agent.session.header.parentSession === undefined
        && status === 'idle'
        && firstTurnEnded
        && maintenance === undefined
      ) {
        maintenance = agent.runMaintenance(async () => {
          agent.session.append('turn/start', { turn: 2 })
          agent.session.append('step/start', { turn: 2, step: 1 })
          agent.session.append('step/end', { turn: 2, step: 1 })
          agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
        })
      }
    })
    return () => {
      disposeStatus()
      disposeSession()
    }
  }, 'maintenance-followup.listeners')
}
