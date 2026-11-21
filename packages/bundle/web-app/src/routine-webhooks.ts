/** Mount authenticated Bot routine webhooks behind a deployment's HTTPS proxy. */

import type {} from '@yharness/bots'
import type { Context } from '@yharness/cordis'
import type {} from '@yharness/host-webserver'
import z from '@yharness/schemastery'
import { parsePublicUrl } from './public-url.ts'

/** Stable name of the optional webhook ingress plugin. */
export const name = 'bot-routine-webhooks'

/** Services needed to reserve requests in the correct Bot chat. */
export const inject = ['bots', 'webServer']

/** Deployment settings for the external webhook endpoint. */
export interface Config {
  /** Public HTTPS root for webhook callers, including any stripped proxy prefix. */
  publicUrl: string
  /** Maximum bytes accepted for an optional JSON body. */
  maxBodyBytes: number
}

export const Config: z<Config> = z.object({
  publicUrl: z.transform(z.string(), (value) => {
    const root = parsePublicUrl(value, 'publicUrl')
    if (root.protocol !== 'https:') throw new Error('Routine webhook publicUrl requires HTTPS')
    return root.href
  }).required(),
  maxBodyBytes: z.natural().min(1).max(65_536).default(16_384),
})

/**
 * Register the verified request receiver on the Web listener.
 * @param ctx - Context with the Bot service and Web listener.
 * @param config - Validated public HTTPS endpoint and body limit.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(function* () {
    const receiver = ctx.bots.registerRoutineWebhookReceiver(config.publicUrl, config.maxBodyBytes)
    yield receiver.dispose
    yield ctx.webServer.register(receiver.route)
  }, 'bot-routine-webhooks: authenticated ingress')
}
