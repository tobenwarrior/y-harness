/** Browser-safe exact public SDK protocol records, separate from sanitized learning evidence. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SkillNativeConnectionId, SkillClaudeSessionId, SkillClaudeSendId } from '@deepseek-ai/dsh-skill-library/types'

/** Exact bounded owned request or public SDK frame; never a model conversation projection. */
export type ClaudeRootProtocolRecord = {
  readonly provider: 'claude-code'
  readonly connectionId: SkillNativeConnectionId
  readonly sessionId: SkillClaudeSessionId
  readonly sendId: SkillClaudeSendId
  /** Actual launched native profile paths; no account or external-session identity is inferred. */
  readonly profile: { readonly home: string; readonly configDirectory: string }
  readonly message: JsonValue
} & ({ readonly phase: 'request'; readonly system: string } | { readonly phase: 'frame' })

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Exact owned public SDK input/output, without any promise to restore hidden native context. */
    'claude-code/root-protocol': ClaudeRootProtocolRecord
  }
}
