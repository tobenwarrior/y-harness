/** Provide a deterministic VPS computer service and mount the real operator tool. */

export const name = 'vps-computer-fixture'

export async function apply(ctx) {
  ctx.provide('vpsComputer', {
    observe: async () => ({
      jpeg: '/9j/2Q==',
      width: 1280,
      height: 720,
    }),
    actAsBot: async (action) => {
      if (action?.kind !== 'text' || action.text !== 'Hello from the Computer panel') {
        throw new Error(`unexpected VPS computer action: ${JSON.stringify(action)}`)
      }
      return { accepted: true }
    },
  })
  const tool = await import('../../../packages/bundle/web-app/src/computer-tool.ts')
  await ctx.plugin(tool)
}
