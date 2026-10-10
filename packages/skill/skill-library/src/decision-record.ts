/** Validated durable Decision settings and reconstructable auxiliary calls. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ReasoningEffortId, ServiceTierId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SkillLibraryId } from './types.ts'
import type { DecisionConfiguration, DecisionConfigureRequest, DecisionRecord, DecisionRequestId, DecisionRoute } from './decision-types.ts'

/** Exact auxiliary route parser, with no endpoint or credential fields. */
export const decisionRouteSchema = z.object({
  provider: z.string().min(1).max(256), model: z.string().min(1).max(256),
  reasoningEffort: z.string().min(1).max(64).transform(brandString<ReasoningEffortId>).optional(),
  serviceTier: z.string().min(1).max(64).transform(brandString<ServiceTierId>).optional(),
}).strict().transform((value): DecisionRoute => ({
  provider: value.provider, model: value.model,
  ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
  ...(value.serviceTier === undefined ? {} : { serviceTier: value.serviceTier }),
}))
/** Wire compare-and-set settings parser. */
export const decisionConfigureSchema = z.object({
  expectedRevision: z.number().int().nonnegative(), enabled: z.boolean(), route: decisionRouteSchema.optional(),
}).strict().transform((value): DecisionConfigureRequest => ({
  expectedRevision: value.expectedRevision, enabled: value.enabled,
  ...(value.route === undefined ? {} : { route: value.route }),
}))
const configuration = z.object({
  revision: z.number().int().nonnegative(), enabled: z.boolean(), route: decisionRouteSchema.optional(),
}).strict().transform((value): DecisionConfiguration => ({
  revision: value.revision, enabled: value.enabled,
  ...(value.route === undefined ? {} : { route: value.route }),
}))
const record = z.object({
  id: z.string().transform(value => brandString<DecisionRequestId>(value)),
  createdAt: z.string(), configurationRevision: z.number().int().nonnegative(), input: z.string(),
  outcome: z.enum(['pending', 'selected', 'abstained']), reason: z.string().optional(), output: z.string().optional(),
  selectedIds: z.array(z.string().transform(value => brandString<SkillLibraryId>(value))).optional(),
}).strict().transform((value): DecisionRecord => ({
  id: value.id, createdAt: value.createdAt, configurationRevision: value.configurationRevision, input: value.input, outcome: value.outcome,
  ...(value.reason === undefined ? {} : { reason: value.reason }), ...(value.output === undefined ? {} : { output: value.output }),
  ...(value.selectedIds === undefined ? {} : { selectedIds: value.selectedIds }),
}))
/** Independent configuration and capped auxiliary log; no permission or verification records. */
export const decisionDomain = defineDomain({
  name: 'skill_decision', version: 1,
  global: { schema: configuration, initial: { revision: 0, enabled: false } },
  tables: { requests: domainTable<string, DecisionRecord>(record) },
})
