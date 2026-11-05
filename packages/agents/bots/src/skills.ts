import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
  SkillRegistry,
  SkillSummary,
  SkillViewOptions,
} from '@yharness/skill'
import { isSkillName } from '@yharness/skill'
import type { ScopeKey } from '@yharness/scope'
import type { BotSkillPolicy } from './types.ts'

/** Maximum number of skill names retained in one Bot policy. */
export const BOT_SKILL_NAME_LIMIT = 256

/** Maximum length of one skill name retained in a Bot policy. */
export const BOT_SKILL_NAME_MAX_LENGTH = 128

/** Default policy for legacy Bot rows and new Bots without an explicit policy. */
export const DEFAULT_BOT_SKILL_POLICY: BotSkillPolicy = {
  mode: 'all',
  enabled: [],
  disabled: [],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sortedUniqueNames(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Bot skill policy ${label} must be an array`)
  if (value.length > BOT_SKILL_NAME_LIMIT) {
    throw new Error(`Bot skill policy ${label} must contain at most ${String(BOT_SKILL_NAME_LIMIT)} entries`)
  }
  const names: string[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'string' || candidate.length > BOT_SKILL_NAME_MAX_LENGTH || !isSkillName(candidate)) {
      throw new Error(`Bot skill name in ${label} is invalid`)
    }
    names.push(candidate)
  }
  return [...new Set(names)].sort(compareNames)
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Validate and canonicalize a Bot's host-local skill policy.
 * @param value - untrusted durable or remote policy value.
 * @returns a fresh canonical policy; omitted values default to all skills.
 */
export function normalizeBotSkillPolicy(value?: unknown): BotSkillPolicy {
  if (value === undefined) return { ...DEFAULT_BOT_SKILL_POLICY }
  if (!isRecord(value) || (value.mode !== 'all' && value.mode !== 'selected')) {
    throw new Error('Bot skill policy mode is invalid')
  }
  return {
    mode: value.mode,
    enabled: sortedUniqueNames(value.enabled, 'enabled'),
    disabled: sortedUniqueNames(value.disabled, 'disabled'),
  }
}

/**
 * Check whether one skill is admitted by a canonical Bot policy.
 * @param policy - canonical Bot skill policy.
 * @param name - skill name to check.
 * @returns whether the skill may be discovered and loaded for the Bot.
 */
export function botSkillPolicyAllows(policy: BotSkillPolicy, name: string): boolean {
  if (policy.disabled.includes(name)) return false
  return policy.mode === 'all' || policy.enabled.includes(name)
}

type SkillRegistryRead = Pick<SkillRegistry, 'list' | 'get'>

function candidateFromSummary(summary: SkillSummary, index: number): SkillCandidate {
  const rank = 'rank' in summary && typeof summary.rank === 'number' ? summary.rank : 1_000_000 + index
  return {
    name: summary.name,
    description: summary.description,
    ...(summary.whenToUse === undefined ? {} : { whenToUse: summary.whenToUse }),
    invocation: summary.invocation,
    source: summary.source,
    provider: summary.provider,
    rank,
    locator: summary.name,
  }
}

function projectedCandidate(candidate: SkillCandidate, allowed: boolean): SkillCandidate {
  return {
    name: candidate.name,
    description: candidate.description,
    ...(candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse }),
    invocation: allowed
      ? candidate.invocation
      : { modelInvocable: false, userInvocable: false },
    source: 'runtime',
    provider: 'bot-skill-policy',
    rank: 1_000_000,
    locator: candidate,
  }
}

function deniedDefinition(candidate: Pick<SkillCandidate, 'name' | 'description' | 'whenToUse'>): SkillDefinition {
  return {
    name: candidate.name,
    description: candidate.description,
    ...(candidate.whenToUse === undefined ? {} : { whenToUse: candidate.whenToUse }),
    invocation: { modelInvocable: false, userInvocable: false },
    source: 'runtime',
    provider: 'bot-skill-policy',
    content: '',
  }
}

const DENY_ALL_BOT_SKILLS: BotSkillPolicy = { mode: 'selected', enabled: [], disabled: [] }

async function readPolicy(source: () => BotSkillPolicy | Promise<BotSkillPolicy>): Promise<BotSkillPolicy> {
  try {
    return await source()
  } catch {
    // A durable policy read that cannot be refreshed must not fall back to a
    // cached allow decision while another Host may have revoked the skill.
    return DENY_ALL_BOT_SKILLS
  }
}

/**
 * Build a scoped provider that enforces one Bot's skill policy before bodies load.
 * @param registry - registry used to read inherited host and preset skills.
 * @param parentScope - nearest inherited scope, excluding the Bot policy layer.
 * @param policy - current policy callback, read for every discovery/load.
 * @returns a provider suitable for registration in the Bot scope.
 */
export function createBotSkillPolicyProvider(
  registry: SkillRegistryRead,
  parentScope: ScopeKey | undefined,
  policy: () => BotSkillPolicy | Promise<BotSkillPolicy>,
): SkillProvider {
  const parentOptions = (options: SkillLookupOptions): SkillViewOptions => ({ ...options, scope: parentScope })
  return {
    name: 'bot-skill-policy',
    async list(options) {
      const summaries = await registry.list(parentOptions(options))
      const currentPolicy = await readPolicy(policy)
      // The policy is durable and may be changed by another Host. Do not let
      // SkillRegistry retain this projection in its local catalog cache: each
      // discovery must read the current policy before exposing model-visible
      // invocation flags.
      return {
        candidates: summaries.map((summary, index) => {
          const candidate = candidateFromSummary(summary, index)
          return projectedCandidate(candidate, botSkillPolicyAllows(currentPolicy, candidate.name))
        }),
        complete: false,
      }
    },
    async get(candidate, options) {
      const currentPolicy = await readPolicy(policy)
      if (!botSkillPolicyAllows(currentPolicy, candidate.name)) {
        return deniedDefinition(candidate)
      }
      const definition = await registry.get(candidate.name, parentOptions(options))
      return botSkillPolicyAllows(await readPolicy(policy), candidate.name)
        ? definition
        : deniedDefinition(candidate)
    },
  }
}

/** Keep a summary projection free of provider paths and handles for Bot clients.
 * @param skill - host-local skill metadata to project.
 * @param policy - canonical policy used to compute the Bot's grant decision.
 * @returns browser-safe skill metadata and the current Bot grant decision.
 */
export function projectBotSkillSummary(skill: SkillSummary, policy: BotSkillPolicy): {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly enabled: boolean
  readonly available: boolean
} {
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    enabled: botSkillPolicyAllows(policy, skill.name),
    available: true,
  }
}
