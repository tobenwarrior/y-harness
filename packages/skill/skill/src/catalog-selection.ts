/** Pure relevance ranking over already-discovered skill metadata. */
import type { SkillSummary } from './index.ts'

/** Bounds apply to suggestions; explicitly requested skills remain discoverable. */
export interface SkillCatalogSelectionOptions {
  readonly query: string
  readonly limit: number
  readonly maxBytes: number
  readonly requestedNames?: readonly string[]
  /** Match exact names in a trusted task query; disable for model-supplied searches. */
  readonly preserveNamedSkills?: boolean
  readonly descriptionMaxLength?: number
}
/** Metadata suitable for the model-facing catalog, without provider bodies. */
export interface SkillCatalogSelection<T> {
  readonly skills: readonly T[]
  /** UTF-8 bytes of escaped rendered entry lines, including separating newlines. */
  readonly metadataBytes: number
  readonly omittedCount: number
  /** Explicit requests exceeded ordinary count or metadata bounds. */
  readonly explicitOverflow: boolean
}
type RoutingSummary = Pick<SkillSummary, 'name' | 'description' | 'whenToUse' | 'invocation'>
const STOP_WORDS = new Set('a an and are as at be by can do for from have help i in is it me of on or please task that the this to use want with you'.split(' '))

/**
 * Select metadata from the authoritative scoped winners, without reading instructions.
 * @param summaries - already-discovered metadata; input objects are never changed.
 * @param options - bounded task query, summary budgets and explicit names.
 * @returns deterministically ranked original summaries and rendered metadata accounting.
 */
export function selectSkillCatalog<T extends RoutingSummary>(
  summaries: readonly T[], options: SkillCatalogSelectionOptions,
): SkillCatalogSelection<T> {
  positiveInteger('limit', options.limit, 1)
  positiveInteger('maxBytes', options.maxBytes, 1)
  const descriptionMaxLength = options.descriptionMaxLength ?? 500
  positiveInteger('descriptionMaxLength', descriptionMaxLength, 3)
  const query = options.query.toLowerCase()
  const terms = new Set(tokens(query).filter(term => !STOP_WORDS.has(term)))
  const requested = new Set(options.requestedNames ?? [])
  const eligible = summaries.filter(skill => skill.invocation.modelInvocable)
  const ranked = eligible.map((skill) => {
    const nameTerms = new Set(tokens(skill.name))
    const descriptionTerms = new Set(tokens(skill.description.toLowerCase()))
    const guidanceTerms = new Set(tokens(skill.whenToUse?.toLowerCase() ?? ''))
    const explicit = requested.has(skill.name) || (options.preserveNamedSkills === true && namesSkill(query, skill.name))
    let score = 0
    for (const term of terms) {
      score += (nameTerms.has(term) ? 10 : 0) + (descriptionTerms.has(term) ? 4 : 0) + (guidanceTerms.has(term) ? 4 : 0)
    }
    return { skill, explicit, score }
  }).filter(entry => entry.explicit || entry.score > 0)
    .sort((a, b) => Number(b.explicit) - Number(a.explicit) || b.score - a.score || a.skill.name.localeCompare(b.skill.name))
  const skills: T[] = []
  let metadataBytes = 0
  for (const entry of ranked) {
    const bytes = lineBytes(entry.skill, descriptionMaxLength) + (skills.length === 0 ? 0 : 1)
    if (!entry.explicit && (skills.length >= options.limit || metadataBytes + bytes > options.maxBytes)) continue
    skills.push(entry.skill)
    metadataBytes += bytes
  }
  return {
    skills, metadataBytes, omittedCount: eligible.length - skills.length,
    explicitOverflow: skills.length > options.limit || metadataBytes > options.maxBytes,
  }
}

function tokens(value: string): string[] { return value.match(/[\p{L}\p{N}]+/gu) ?? [] }
function namesSkill(query: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Slashes followed by another path segment are not invocation gestures.
  return new RegExp(`(^|[\\s"'\x60(])(?:\\/|\\$)?${escaped}(?=$|[\\s"'\x60.,!?;:)])`, 'u').test(query)
}
function lineBytes(skill: RoutingSummary, maximum: number): number {
  const normalized = skill.description.replaceAll(/\s+/g, ' ').trim()
  const description = normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 3)}...`
  const escaped = description.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return new TextEncoder().encode(`- \`${skill.name}\`: ${escaped}`).length
}
function positiveInteger(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) throw new Error(`skill catalog ${name} must be an integer greater than or equal to ${minimum}`)
}
