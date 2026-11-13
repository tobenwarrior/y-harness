/** Seed one Bot and mount the real scoped VPS Computer tool. */

import { fileURLToPath } from 'node:url'

export const name = 'vps-bot-computer-fixture'
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'storageDomain']

export async function apply(ctx) {
  const built = process.env.DSH_EXAMPLE_MODE === 'lib'
  const { BotId, botDomain } = built
    ? await import('../../../packages/agents/bots/lib/index.js')
    : await import('../../../packages/agents/bots/src/index.ts')
  const { SessionId } = built
    ? await import('../../../packages/core/session/lib/index.js')
    : await import('../../../packages/core/session/src/index.ts')
  const selection = ctx.agentDefaultModel.currentSelection()
  const sessionId = SessionId('bot-session-sender')
  const handle = await ctx.agents.create({
    sessionId,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
  })
  const domain = await ctx.storageDomain.open(botDomain)
  await domain.table('bots').put(BotId('bot-sender'), {
    id: BotId('bot-sender'),
    sessionId,
    ownerId: 'local-owner',
    name: 'Computer Bot',
    description: 'Uses a private computer for visual work.',
    identity: 'agent',
    accent: 'violet',
    cwd: process.cwd(),
    state: 'active',
    createdAt: 0,
    updatedAt: 0,
  })
  await domain.close()
  await handle.dispose()
  ctx.provide('sessionController', {
    create: async (request) => {
      if (request.sessionId === undefined) throw new Error('VPS Bot snapshot Session ids must be explicit')
      return { sessionId: request.sessionId }
    },
    inspect: async () => ({ events: [] }),
  })

  const { VpsRuntime } = built
    ? await import('../../../packages/bundle/web-app/lib/types/vps-runtime.js')
    : await import('../../../packages/bundle/web-app/src/vps-runtime.ts')
  const desktop = fileURLToPath(new URL('./vps-bot-computer-desktop.mjs', import.meta.url))
  VpsRuntime.prototype.ensure = async function ensureFixture() {}
  VpsRuntime.prototype.execArgv = function execArgvFixture(session, argv) {
    return Object.freeze([process.execPath, desktop, String(session), ...argv])
  }
  const { mountVpsBots } = built
    ? await import('../../../packages/bundle/web-app/lib/types/vps-bots.js')
    : await import('../../../packages/bundle/web-app/src/vps-bots.ts')
  mountVpsBots(ctx, {
    root: '/tmp/yharness-vps-bot-computer',
    image: 'fixture-image',
    bots: ['bot-sender'],
    desktopOnlyBots: ['bot-sender'],
  }, [])
}
