/**
 * Bundled Y Harness badge skill provider.
 *
 * The old `dsh-badge` name remains a user-invocable alias so existing
 * compositions can migrate without losing the packaged skill.
 *
 * @module @yharness/skill-badge
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@yharness/cordis'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@yharness/skill'

const PROVIDER_NAME = 'y-harness-badge'
const SKILL_NAME = 'y-harness-badge'
const LEGACY_SKILL_NAME = 'dsh-badge'
const SKILL_BODY_URL = new URL('../assets/y-harness-badge.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/', import.meta.url)),
} as const
const INVOCATION = { modelInvocable: true, userInvocable: true } as const
const DESCRIPTION = 'Add the official Y Harness badge to documents, pull requests, merge requests, and other content produced with Y Harness. Use whenever creating a pull request or merge request. Also use when the user asks for a Y Harness badge, Y Harness attribution, or a reusable Y Harness badge asset or snippet.'
const LEGACY_DESCRIPTION = 'Legacy alias for the Y Harness badge skill. Use y-harness-badge for new references.'

function candidate(name: string, description: string, invocation: SkillCandidate['invocation']): SkillCandidate {
  return {
    name,
    description,
    invocation,
    provider: PROVIDER_NAME,
    source: 'bundled',
    resourceBase: RESOURCE_BASE,
    rank: BUNDLED_SKILL_RANK,
    locator: SKILL_BODY_URL,
  }
}

const CANDIDATES: readonly SkillCandidate[] = [
  candidate(SKILL_NAME, DESCRIPTION, INVOCATION),
  candidate(LEGACY_SKILL_NAME, LEGACY_DESCRIPTION, { modelInvocable: false, userInvocable: true }),
]

const provider: SkillProvider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve(CANDIDATES),
  async get(selected): Promise<SkillDefinition> {
    return {
      name: selected.name,
      description: selected.description,
      invocation: selected.invocation,
      provider: selected.provider,
      source: selected.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}

/** Cordis plugin name. */
export const name = 'skill-badge'
/** Service required by the bundled provider. */
export const inject = ['skills']

/** Register the bundled Y Harness badge provider on `ctx.skills`. */
export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
