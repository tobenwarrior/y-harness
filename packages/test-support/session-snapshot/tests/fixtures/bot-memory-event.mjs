/** Add one active Bot memory after the SDK's deterministic file read. */

export const name = 'snapshot-bot-memory-event'
export const inject = ['agents']

/** Install a scoped tool listener for each live Agent. */
export function apply(ctx) {
  let appended = false
  const install = (agent) => {
    agent.ctx.on('tools/post-execute', async (exec, result, next) => {
      if (!appended && !result.isError && exec.name === 'read') {
        agent.session.append('bot/memory', {
          botId: 'bot-snapshot',
          memoryId: 'memory-sdk-snapshot',
          operation: 'remember',
          text: 'The SDK projection keeps this active Bot memory.',
        })
        appended = true
      }
      const downstream = await next()
      return downstream
    })
  }
  ctx.on('agent/created', ({ agent }) => {
    install(agent)
  })
  for (const agent of ctx.agents.list()) install(agent)
}
