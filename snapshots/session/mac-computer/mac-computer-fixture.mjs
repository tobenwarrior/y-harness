/** Mount the real Mac Computer tool with a deterministic reply from the native bridge. */

export const name = 'mac-computer-fixture'

export async function apply(ctx) {
  const { applyMacComputer } = await import('../../../packages/bundle/web-app/src/computer-tool.ts')
  await ctx.plugin({
    name: 'mac-computer-tool-fixture',
    inject: ['tools', 'attachments', 'llm'],
    apply(scope) {
      applyMacComputer(scope, {
        observe() {
          throw new Error('This fixture exercises input only.')
        },
        async request(sessionId, action) {
          if (sessionId === '' || action.kind !== 'text' || action.text !== 'Hello from the Computer panel') {
            throw new Error('Unexpected Mac Computer input.')
          }
        },
      })
    },
  })
}
