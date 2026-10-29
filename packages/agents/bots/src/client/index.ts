/** Browser-safe Bot vocabulary. @module @deepseek-ai/dsh-bots/client */

export type * from '../types.ts'
export { BOT_ACCENTS, BOT_IDENTITIES, BotId } from '../types.ts'

/** The Host Bot service has no independent Client lifecycle; API remotes own its calls. */
export const inject: readonly string[] = []

/** Keep the package's Client face inert while exposing browser-safe Bot vocabulary. */
export function apply(): void {}
