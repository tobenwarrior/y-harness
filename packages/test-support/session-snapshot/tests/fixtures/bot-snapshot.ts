/** Release fixed Bot-owned Sessions so the headless runner can adopt them. */

import type { Context } from '@yharness/cordis'
import type { AgentHandle } from '@yharness/agent'

export const name = 'snapshot-bots'
export const inject = ['bots']

/** Release the setup-owned Agents; the runner then adopts their persisted Session ids. */
export async function apply(ctx: Context): Promise<void> {
  const handles = ctx.get('snapshotBotAgents') as readonly AgentHandle[]
  await Promise.all(handles.map(handle => handle.dispose()))
}
