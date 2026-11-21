import type { SessionEventLikeEntry } from '@yharness/api-session-controller/client'

/** One safe, user-visible activity item from a child Session tail. */
export interface SubagentActivityItem {
  readonly kind: 'action' | 'result'
  /** Product tool name only; call arguments and result payloads stay private. */
  readonly name: string
  readonly status: 'running' | 'completed' | 'failed'
}

/**
 * Project a bounded child-session tail into activity labels for the roster.
 *
 * The preview intentionally keeps only tool names and result status. It does
 * not copy prompts, model output, raw arguments, tool payloads, or provider
 * metadata into the compact Code surface.
 *
 * @param entries - A read-only child event window already opened by the
 *   Session Controller.
 * @returns The last four tool actions/results in event order.
 */
export function summarizeSubagentActivity(
  entries: readonly SessionEventLikeEntry[],
): readonly SubagentActivityItem[] {
  const toolNames = new Map<string, string>()
  const items: SubagentActivityItem[] = []
  for (const entry of entries) {
    if (entry.type !== 'event') continue
    if (entry.event.type === 'tool/call') {
      const name = entry.event.data.name
      toolNames.set(String(entry.event.data.callId), name)
      items.push({ kind: 'action', name, status: 'running' })
      continue
    }
    if (entry.event.type !== 'tool/result') continue
    const callId = String(entry.event.data.message.source.callId)
    items.push({
      kind: 'result',
      name: toolNames.get(callId) ?? 'tool',
      status: entry.event.data.message.isError ? 'failed' : 'completed',
    })
  }
  return items.slice(-4)
}
