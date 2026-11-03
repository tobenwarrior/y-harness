/** Append one active Bot memory while the Python SDK run is subscribed. */

export const name = 'python-sdk-bot-memory'
export const inject = ['agents', 'tools']

export function apply(ctx) {
  let appended = false
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (appended || result.isError || exec.name !== 'read') return downstream
    const agent = ctx.agents.currentInitiator()
    if (agent === undefined || agent.session.header.parentSession !== undefined) return downstream
    appended = true
    agent.session.append('bot/memory', {
      botId: 'bot-python-snapshot',
      memoryId: 'memory-python-snapshot',
      operation: 'remember',
      text: 'The Python SDK projection keeps this active Bot memory.',
    })
    return downstream
  })
}
