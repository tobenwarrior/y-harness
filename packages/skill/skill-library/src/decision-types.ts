/** Separate optional response-only metadata advice; no source or execution authority. */
import type { LlmCallConfig, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { SkillLibraryId } from './types.ts'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Exact registered route; defaults from the conversation are never inherited. */
export type DecisionRoute = Readonly<Pick<LlmCallConfig, 'provider' | 'model' | 'reasoningEffort' | 'serviceTier'>>
/** Durable opt-in configuration, independent of the conversation model. */
export interface DecisionConfiguration {
  readonly revision: number
  readonly enabled: boolean
  readonly route?: DecisionRoute
}
/** Compare-and-set write; enabling requires a declared response-only API route. */
export interface DecisionConfigureRequest {
  readonly expectedRevision: number
  readonly enabled: boolean
  readonly route?: DecisionRoute
}
/** One provider model choice with explicit native or missing-capability refusal. */
export interface DecisionModel {
  readonly provider: string
  readonly model: string
  readonly name: string
  readonly available: boolean
  readonly reason: 'response-only' | 'native-tools' | 'undeclared' | 'unavailable'
}
/** Separate settings and current cached capability disclosure. */
export interface DecisionStatus {
  readonly configuration: DecisionConfiguration
  readonly models: readonly DecisionModel[]
  readonly maxInputBytes: number
  readonly maxInputTokens: number
  readonly maxOutputTokens: number
  readonly timeoutMs: number
  readonly maxCalls: 1
}
/** Exact-model controls read without performing generation. */
export interface DecisionCapabilities {
  readonly reasoning?: LlmResolvedModelInfo['reasoning']
  readonly serviceTiers?: LlmResolvedModelInfo['serviceTiers']
}
/** Reconstructable auxiliary input and settled advice; never records skill bodies or transcripts. */
export type DecisionRequestId = Branded<'SkillDecisionRequestId'>
/** Durable auxiliary call record; selected IDs carry no authority. */
export interface DecisionRecord {
  readonly id: DecisionRequestId
  readonly createdAt: string
  readonly configurationRevision: number
  readonly input: string
  readonly outcome: 'pending' | 'selected' | 'abstained'
  readonly reason?: string
  readonly output?: string
  readonly selectedIds?: readonly SkillLibraryId[]
}
