/** Append a completed maintenance-only turn before the next Python SDK run. */
export const name = 'python-sdk-maintenance-followup'

export function apply(ctx) {
  let firstTurnEnded = false
  let maintenance

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
  }, 'python-sdk-maintenance-followup.listeners')
}
