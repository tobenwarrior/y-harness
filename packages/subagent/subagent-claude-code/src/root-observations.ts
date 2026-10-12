/** Exact direct SDK identities and allowlisted project facts, without native-turn invention. */
import { isAbsolute, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SkillLearningNativeItem, SkillNativeConnectionId, SkillClaudeSessionId, SkillClaudeSendId, SkillClaudeMessageId, SkillClaudeToolUseId } from '@deepseek-ai/dsh-skill-library/types'

/**
 * Validate bounded native metadata before constructing opaque identities.
 * @param value - untrusted SDK or configured identity.
 * @returns whether the value contains only supported bounded identity characters.
 */
export function nativeIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value)
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function background(value: unknown): boolean {
  return record(value) && (value.run_in_background === true || value.backgroundTaskId !== undefined
    || value.backgroundedByUser === true || value.timedOutAfterMs !== undefined)
}
function procedure(name: string, input: unknown, root?: string): SkillLearningNativeItem['procedure'] {
  if (root === undefined || !record(input)) return undefined
  if (name === 'Bash' && typeof input.command === 'string' && input.command.length <= 256
    && /^(?:(?:pnpm|npm) run (?:test|lint|typecheck|build)|npm test|pnpm exec vitest run|(?:python -m )?pytest|cargo (?:test|check)|go test \.\/\.\.\.|git diff --check)$/.test(input.command)) return { kind: 'check', command: input.command }
  if (name !== 'Read' || typeof input.file_path !== 'string' || input.offset !== undefined || input.limit !== undefined) return undefined
  const path = relative(root, resolve(root, input.file_path)).replace(/\\/g, '/')
  if (isAbsolute(path) || path.length > 256
    || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|yml|yaml|toml)$/.test(path)
    || path.split('/').some(part => part.startsWith('.') || /secret|credential|password|token|auth/i.test(part))) return undefined
  return { kind: 'read', path }
}

/** One client send's direct root observations; an invalid batch cannot authorize learning. */
export class ClaudeRootObservations {
  /** Exact observed direct tool starts, retained within the configured item bound. */
  readonly starts = new Map<string, SkillLearningNativeItem>()
  private readonly settled = new Set<string>()
  private readonly foreground = new Map<string, string>()
  private readonly inputHashes = new Map<string, string>()
  private invalid = false
  constructor(private readonly connectionId: string, private readonly sessionId: string,
    private readonly sendId: string, private readonly maxItems: number, private readonly sink: (item: SkillLearningNativeItem) => void,
    private readonly projectRoot?: string) {}

  /** Whether attribution failed and the entire send can no longer authorize learning. */
  get isInvalid(): boolean { return this.invalid }

  /**
   * Correlate a permission callback with its actual assistant tool receipt.
   * @param toolUseId - actual SDK tool-use identifier.
   * @param name - exact native tool name.
   * @param input - callback input compared by transient hash without durable raw retention.
   * @returns whether a valid observed start matches all three facts.
   */
  matches(toolUseId: string, name: string, input: Record<string, unknown>): boolean {
    return !this.invalid && this.starts.get(toolUseId)?.name === name
      && this.inputHashes.get(toolUseId) === createHash('sha256').update(JSON.stringify(input)).digest('hex')
  }

  /** Invalidate all observed actions; publication errors propagate to the root owner for containment. */
  invalidate(): void {
    if (this.invalid) return
    this.invalid = true
    const first = this.starts.values().next().value
    if (first !== undefined) this.sink({ ...first, phase: 'invalidated' })
  }
  /**
   * Pair direct foreground SDK starts and results and publish sanitized ignorable items.
   * @param message - public SDK frame already bound to the exact live root send.
   */
  observe(message: SDKMessage): void {
    if (this.invalid) return
    if ('session_id' in message && message.session_id !== this.sessionId) { this.invalidate(); return }
    const replayed: unknown = 'isReplay' in message ? message.isReplay : false
    if ('parent_tool_use_id' in message && message.parent_tool_use_id !== null
      || 'isSynthetic' in message && message.isSynthetic || Boolean(replayed)) { this.invalidate(); return }
    if (message.type === 'system' && ['task_started', 'task_progress', 'task_notification', 'task_updated'].includes(message.subtype)) {
      if (message.subtype === 'task_started') {
        if (message.task_type !== 'local_bash' || message.is_backgrounded !== false || message.subagent_type !== undefined
          || message.ambient === true || message.skip_transcript === true || !nativeIdentity(message.task_id)
          || !nativeIdentity(message.tool_use_id) || this.starts.get(message.tool_use_id)?.name !== 'Bash'
          || this.foreground.has(message.task_id) || this.foreground.size >= this.maxItems) this.invalidate()
        else this.foreground.set(message.task_id, message.tool_use_id)
      } else if ('task_id' in message) {
        const tool = this.foreground.get(message.task_id)
        if (tool === undefined || 'tool_use_id' in message && message.tool_use_id !== tool
          || message.subtype === 'task_updated' && (message.patch.is_backgrounded === true || message.patch.status === 'paused')
          || message.subtype === 'task_progress' && message.subagent_type !== undefined
          || message.subtype === 'task_notification' && (message.ambient === true || message.skip_transcript === true)) this.invalidate()
      } else this.invalidate()
      return
    }
    if (message.type === 'assistant' && message.parent_tool_use_id === null) {
      if (!nativeIdentity(message.uuid)) { this.invalidate(); return }
      for (const block of message.message.content) {
        if (block.type !== 'tool_use') continue
        const kind = block.name === 'Read' || block.name === 'Glob' || block.name === 'Grep' ? 'read'
          : block.name === 'Bash' ? 'command' : block.name === 'Edit' || block.name === 'Write' ? 'file-change' : undefined
        if (kind === undefined || !nativeIdentity(block.id) || this.starts.has(block.id) || background(block.input)
          || this.starts.size >= this.maxItems) { this.invalidate(); return }
        const fact = procedure(block.name, block.input, this.projectRoot)
        const item: SkillLearningNativeItem = { provider: 'claude-code', connectionId: brandString<SkillNativeConnectionId>(this.connectionId),
          sessionId: brandString<SkillClaudeSessionId>(this.sessionId), sendId: brandString<SkillClaudeSendId>(this.sendId),
          itemId: brandString<SkillClaudeToolUseId>(block.id), sourceMessageId: brandString<SkillClaudeMessageId>(message.uuid),
          kind, name: block.name, phase: 'started', ...fact === undefined ? {} : { procedure: fact } }
        this.inputHashes.set(block.id, createHash('sha256').update(JSON.stringify(block.input)).digest('hex'))
        this.starts.set(block.id, item); this.sink(item)
      }
      return
    }
    if (message.type !== 'user' || message.parent_tool_use_id !== null || !Array.isArray(message.message.content)) return
    if (!nativeIdentity(message.uuid)) { this.invalidate(); return }
    for (const block of message.message.content) {
      if (block.type !== 'tool_result') continue
      const start = this.starts.get(block.tool_use_id)
      if (start === undefined || this.settled.has(block.tool_use_id) || background(message.tool_use_result)) { this.invalidate(); return }
      if (start.name === 'Bash' && (!record(message.tool_use_result) || message.tool_use_result.interrupted !== false
        || typeof message.tool_use_result.stdout !== 'string' || typeof message.tool_use_result.stderr !== 'string')) { this.invalidate(); return }
      this.settled.add(block.tool_use_id)
      this.sink({ ...start, phase: 'settled', resultMessageId: brandString<SkillClaudeMessageId>(message.uuid),
        outcome: block.is_error === true ? 'reported-error' : block.is_error === false ? 'reported-success' : 'unknown' })
    }
  }
}
