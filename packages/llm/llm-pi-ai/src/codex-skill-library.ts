/** Metadata-only observations of the pinned native Codex skill catalog. */
import { isAbsolute, normalize } from 'node:path'
import { z } from 'zod'
import type { NativeSkillLibraryEntry, NativeSkillLibraryObservation, NativeSkillLibraryProvider, SkillLibraryProject } from '@deepseek-ai/dsh-skill-library/types'
import type { CodexBackendRuntime } from './codex-backend.ts'

/**
 * Refresh manager inventory through an already connected runtime.
 * @param resolveRuntime - existing runtime reader; this callback must not construct or launch one.
 * @returns the metadata provider registered by the native connection plugin.
 */
export function createCodexSkillLibraryProvider(resolveRuntime: () => CodexBackendRuntime | undefined): NativeSkillLibraryProvider {
  return { name: 'codex-backend', list: (projects, request) => resolveRuntime()?.listSkills(projects, request?.forceReload ?? false) ?? Promise.resolve({ entries: [], status: {
    provider: 'codex-backend', state: 'disconnected', message: 'Native skill inventory requires an already connected Codex backend. Usage is unknown.',
  } }) }
}

const responseSchema = z.object({ data: z.array(z.object({
  cwd: z.string(),
  skills: z.array(z.object({
    name: z.string().min(1), description: z.string(), path: z.string(),
    scope: z.enum(['user', 'repo', 'system', 'admin']), enabled: z.boolean(),
    pluginId: z.string().nullable(),
  })),
  errors: z.array(z.unknown()),
})) })

/**
 * Project metadata maps native repository scope without importing instruction bodies.
 * @param value - the pinned app-server `skills/list` response.
 * @param projects - registered projects supplied in the native request.
 * @returns protected catalog entries and honest availability; parser errors carry no native diagnostics.
 */
export function parseCodexSkills(value: unknown, projects: readonly SkillLibraryProject[]): NativeSkillLibraryObservation {
  const response = responseSchema.parse(value)
  const entries = new Map<string, NativeSkillLibraryEntry>()
  let hasErrors = projects.some(project => !response.data.some(row => normalize(row.cwd) === normalize(project.path)))
  for (const row of response.data) {
    const rowProjects = projects.filter(project => normalize(project.path) === normalize(row.cwd))
    if (!isAbsolute(row.cwd) || rowProjects.length === 0) throw new Error('Codex returned an unrequested skill directory.')
    hasErrors ||= row.errors.length > 0
    for (const skill of row.skills) {
      if (!isAbsolute(skill.path)) throw new Error('Codex returned a relative skill path.')
      const path = normalize(skill.path)
      const previous = entries.get(path)
      const projectIds = skill.scope === 'repo'
        ? [...new Set([...(previous?.projectIds ?? []), ...rowProjects.map(project => project.id)])]
        : []
      entries.set(path, { path, name: skill.name, description: skill.description,
        source: `codex:${skill.scope}${skill.pluginId === null ? '' : `:${skill.pluginId}`}`,
        projectIds, enabled: skill.enabled })
    }
  }
  return { entries: [...entries.values()], status: { provider: 'codex-backend',
    state: hasErrors ? 'unavailable' : 'connected',
    ...hasErrors ? { message: 'Some native skills could not be indexed. Usage remains unknown.' } : {} } }
}
