/** Bounded direct SDK tool receipts, without tool bodies or task verification. */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

/** Source-labelled child metadata; the source message UUID is not a native turn id. */
export interface ClaudeCodeToolObservation {
  readonly provider: 'claude-code'
  readonly sessionId: string
  readonly sourceMessageId: string
  readonly resultMessageId?: string
  readonly itemId: string
  readonly kind: 'read' | 'command' | 'file-change' | 'web'
  readonly name: string
  readonly outcome: 'reported-success' | 'reported-error' | 'unknown'
}

/** Explicit collection bound and synchronous observe-only consumer for one SDK query. */
export interface ClaudeCodeToolObservationOptions {
  readonly maxItems: number
  /** @param observations - frozen correlated direct tool metadata, never verification. */
  readonly sink: (observations: readonly ClaudeCodeToolObservation[]) => void
}

/** Fixed safety ceiling for SDK identity collection. */
export const MAX_CLAUDE_CODE_TOOL_OBSERVATIONS = 256

const tools: Readonly<Record<string, ClaudeCodeToolObservation['kind']>> = {
  Read: 'read', Glob: 'read', Grep: 'read',
  Bash: 'command', Edit: 'file-change', MultiEdit: 'file-change', Write: 'file-change',
  WebFetch: 'web', WebSearch: 'web',
}
interface CapturedTool {
  readonly metadata: Omit<ClaudeCodeToolObservation, 'outcome'>
  invalid: boolean
  outcome?: ClaudeCodeToolObservation['outcome']
  resultMessageId?: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function identity(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && /^[a-zA-Z0-9_-]+$/.test(value)
}

function background(value: unknown): boolean {
  return record(value) && (value['run_in_background'] === true
    || value['backgroundTaskId'] !== undefined || value['backgroundedByUser'] === true
    || value['timedOutAfterMs'] !== undefined)
}

function foregroundBash(value: unknown): boolean {
  return record(value) && typeof value['stdout'] === 'string' && typeof value['stderr'] === 'string'
    && value['interrupted'] === false && !background(value)
}

/**
 * Collect one owned SDK stream; overflow invalidates the complete batch.
 * @param options - explicit item bound and synchronous observation sink.
 * @returns stream observer and normal-iterator-completion publisher.
 */
export function createClaudeCodeToolObserver(options: ClaudeCodeToolObservationOptions): {
  observe(message: SDKMessage): void
  publish(): void
} {
  if (!Number.isSafeInteger(options.maxItems) || options.maxItems < 1
    || options.maxItems > MAX_CLAUDE_CODE_TOOL_OBSERVATIONS) {
    throw new Error('subagent-claude-code: tool observation bound must be an integer from 1 to 256')
  }
  const captured = new Map<string, CapturedTool>()
  const excluded = new Set<string>()
  let overflow = false
  const observe = (message: SDKMessage): void => {
    if (overflow) return
    if (message.type === 'system' && (message.subtype === 'task_started'
      || message.subtype === 'task_progress' || message.subtype === 'task_notification'
      || message.subtype === 'task_updated')) {
      if ('tool_use_id' in message) {
        const tool = captured.get(message.tool_use_id)
        if (tool !== undefined) tool.invalid = true
        else if (identity(message.tool_use_id) && !excluded.has(message.tool_use_id)) {
          if (captured.size + excluded.size >= options.maxItems) { overflow = true; captured.clear(); excluded.clear(); return }
          excluded.add(message.tool_use_id)
        }
      }
      return
    }
    if (message.type === 'assistant' && message.parent_tool_use_id === null) {
      if (!identity(message.session_id) || !identity(message.uuid)) return
      for (const block of message.message.content) {
        if (block.type !== 'tool_use' || !identity(block.id) || excluded.has(block.id)) continue
        const kind = Object.hasOwn(tools, block.name) ? tools[block.name] : undefined
        if (kind === undefined) continue
        const prior = captured.get(block.id)
        if (prior !== undefined) { prior.invalid = true; continue }
        if (captured.size + excluded.size >= options.maxItems) { overflow = true; captured.clear(); excluded.clear(); return }
        captured.set(block.id, {
          metadata: {
            provider: 'claude-code', sessionId: message.session_id,
            sourceMessageId: message.uuid, itemId: block.id, kind, name: block.name,
          },
          invalid: background(block.input),
        })
      }
      return
    }
    const replayed: unknown = 'isReplay' in message ? message.isReplay : false
    if (message.type !== 'user' || message.parent_tool_use_id !== null
      || Boolean(replayed) || !Array.isArray(message.message.content)) return
    for (const block of message.message.content) {
      if (block.type !== 'tool_result') continue
      const tool = captured.get(block.tool_use_id)
      if (tool === undefined) continue
      if (tool.outcome !== undefined || background(message.tool_use_result)
        || tool.metadata.name === 'Bash' && !foregroundBash(message.tool_use_result)
        || message.session_id !== tool.metadata.sessionId) {
        tool.invalid = true
        continue
      }
      tool.outcome = block.is_error === true ? 'reported-error'
        : block.is_error === false ? 'reported-success' : 'unknown'
      if (identity(message.uuid)) tool.resultMessageId = message.uuid
    }
  }
  return {
    observe,
    publish: () => {
      if (overflow) return
      const observations = Object.freeze([...captured.values()].flatMap(tool =>
        tool.invalid || tool.outcome === undefined ? [] : [Object.freeze({
          ...tool.metadata, outcome: tool.outcome,
          ...tool.resultMessageId === undefined ? {} : { resultMessageId: tool.resultMessageId },
        })]))
      if (observations.length === 0) return
      try { options.sink(observations) }
      catch (_error: unknown) { /* Observe-only consumers cannot change the native query outcome. */ }
    },
  }
}
