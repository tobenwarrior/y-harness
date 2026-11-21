/** Owner inventory of installed isolated browsers with editable shared access. */

import type {} from '@yharness/bots'
import type { ConnectionFetchRoute } from '@yharness/client-connection'
import type { Context } from '@yharness/cordis'
import type { VpsIsolatedBrowser } from './vps-isolated-browser.ts'

/** Build a read-only route for the native Vault's shared browser settings.
 * @param ctx - Context carrying the owner Bot roster.
 * @param browser - The Cloud profile's isolated browser provider.
 * @returns An authenticated inventory. The owner applies changes through the VPS Vault.
 */
export function vpsBrowserAccessRoute(ctx: Context, browser: VpsIsolatedBrowser): ConnectionFetchRoute {
  return {
    path: '/api/bot-browser-access',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const headers = { 'Cache-Control': 'no-store' }
      if (new URL(request.url).search !== '') return Response.json({ error: 'invalid-request' }, { headers, status: 400 })
      const bots = []
      for (const row of (await ctx.bots.list({ includeHidden: true })).bots) {
        if (request.signal.aborted || bots.length >= 64) break
        if (row.state !== 'active' || !browser.authorized(row.id)) continue
        const owner = await ctx.bots.ownerBotForSession(row.sessionId)
        if (owner?.state !== 'active' || owner.id !== row.id || owner.sessionId !== row.sessionId) continue
        try {
          const policy = await browser.sharingPolicy(owner.id, owner.sessionId, request.signal)
          if (policy.managed) bots.push({ id: owner.id, name: row.name, sessionId: owner.sessionId, enabled: policy.enabled })
        } catch (error) {
          // Unavailable or separately configured browser grants cannot be edited from Vault.
          void error
        }
      }
      return Response.json({ mode: bots.length > 0 ? 'managed' : 'unavailable', bots }, { headers })
    },
  }
}
