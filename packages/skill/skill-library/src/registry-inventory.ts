/** Read-only metadata observations from already registered skill views. */
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { SkillRegistry, SkillSummary, SkillViewOptions } from '@deepseek-ai/dsh-skill'
import type { SkillLibraryProject, SkillLibraryProviderStatus } from './types.ts'

/** Registry reads admitted by the existing composition. */
export type RegistryInventoryReader = Pick<SkillRegistry, 'list' | 'get'>
/** One currently live Agent's existing registry view. */
export interface RegistryInventoryView {
  readonly key: string
  readonly cwd?: string
  readonly scope?: SkillViewOptions['scope']
  readonly registry: RegistryInventoryReader
}
/** Sources are observed lazily; reading them never mounts a new composition. */
export interface RegistryInventoryOptions {
  readonly global: () => RegistryInventoryReader | undefined
  readonly views: () => readonly RegistryInventoryView[]
}
/** Metadata from an existing registry; source mutation is unavailable. */
export interface RegistryInventoryEntry {
  readonly provider: string
  readonly path: string
  readonly name: string
  readonly description: string
  readonly source: string
  readonly projectIds: readonly string[]
  readonly enabled: boolean
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  readonly native: false
}
/** Coverage is explicit when inactive presets are outside the observation. */
export interface RegistryInventoryObservation {
  readonly entries: readonly RegistryInventoryEntry[]
  readonly statuses: readonly SkillLibraryProviderStatus[]
}
/** Registry inventory and separately selected instruction loading. */
export interface RegistryInventory {
  /** Observe existing views without loading instruction bodies. */
  list(projects: readonly SkillLibraryProject[]): Promise<RegistryInventoryObservation>
  /** Load selected instructions; a provider disambiguates identical file locations. */
  detail(locator: string, provider?: string): Promise<string>
}

/**
 * Create an observer over existing global and live-scope registry views.
 * @param options - existing registry readers and live views.
 * @returns read-only metadata inventory and lazy instruction loading.
 */
export function createRegistryInventory(options: RegistryInventoryOptions): RegistryInventory {
  let selected = new Map<string, {
    entry: RegistryInventoryEntry
    load: () => Promise<string>
  }>()
  return {
    async list(projects) {
      const entries = new Map<string, RegistryInventoryEntry>()
      const loaders = new Map<string, {
        entry: RegistryInventoryEntry
        load: () => Promise<string>
      }>()
      const statuses = new Map<string, SkillLibraryProviderStatus>()
      const observe = async (view: RegistryInventoryView, projectIds: readonly string[]): Promise<void> => {
        const lookup: SkillViewOptions = {
          ...view.cwd === undefined ? {} : { cwd: view.cwd },
          ...view.scope === undefined ? {} : { scope: view.scope },
        }
        const statusProvider = `registry:${view.key}`
        let summaries: SkillSummary[]
        try { summaries = await view.registry.list(lookup) } catch {
          statuses.set(
            statusProvider,
            { provider: statusProvider, state: 'unavailable', message: 'An existing registry view could not be read.' },
          )
          return
        }
        if (!statuses.has(statusProvider)) statuses.set(statusProvider, { provider: statusProvider, state: 'connected' })
        for (const summary of summaries) {
          const path = summary.path ?? virtualLocator(summary, view.key)
          const key = `${summary.provider}\0${path}`
          const contextual = summary.source === 'project-dsh' || summary.source === 'project-agents'
            || summary.source === 'runtime' && view.key !== 'global'
          const previous = entries.get(key)
          const entry: RegistryInventoryEntry = {
            provider: summary.provider, path, name: summary.name, description: summary.description, source: summary.source,
            projectIds: [...new Set([...(previous?.projectIds ?? []), ...(contextual ? projectIds : [])])],
            enabled: summary.invocation.modelInvocable || summary.invocation.userInvocable,
            modelInvocable: summary.invocation.modelInvocable, userInvocable: summary.invocation.userInvocable, native: false,
          }
          entries.set(key, entry)
          if (!loaders.has(key)) loaders.set(
            key,
            {
              entry,
              load: async () => {
                const skill = await view.registry.get(summary.name, lookup)
                if (skill === undefined || skill.provider !== summary.provider || skill.path !== summary.path
                  || resourceKey(skill.resourceBase) !== resourceKey(summary.resourceBase)) throw new Error('registry skill is no longer available from its observed provider')
                return skill.content
              },
            },
          )
        }
      }
      const global = options.global()
      if (global !== undefined) {
        await observe({ key: 'global', registry: global }, [])
        for (const project of projects) await observe({ key: 'global', cwd: project.path, registry: global }, [project.id])
      }
      for (const view of options.views()) await observe(view, matchingProjects(view.cwd, projects))
      if (statuses.size === 0) statuses.set(
        'registry',
        {
          provider: 'registry',
          state: 'unavailable',
          message: 'No existing skill registry view is available.',
        },
      )
      statuses.set('registry-coverage', {
        provider: 'registry-coverage',
        state: 'unsupported',
        message: 'Global and live Agent views only; inactive preset skills are not inventoried.',
      })
      selected = loaders
      return { entries: [...entries.values()], statuses: [...statuses.values()] }
    },
    async detail(locator, provider) {
      const matches = [...selected.values()].filter(value => value.entry.path === locator
        && (provider === undefined
          || value.entry.provider === provider))
      const [match] = matches
      if (match === undefined) throw new Error('unknown registry skill')
      if (matches.length > 1) throw new Error('ambiguous registry skill: select its provider')
      return match.load()
    },
  }
}

function virtualLocator(summary: SkillSummary, view: string): string {
  const scope = summary.source === 'bundled'
    ? `bundle-${createHash('sha256').update(resourceKey(summary.resourceBase)).digest('hex')}`
    : view
  return `skill://registry/${encodeURIComponent(summary.provider)}/${encodeURIComponent(scope)}/${encodeURIComponent(summary.name)}`
}

function resourceKey(base: SkillSummary['resourceBase']): string {
  if (base === undefined) return ''
  switch (base.kind) {
    case 'directory': return `directory\0${base.path}`
    case 'url': return `url\0${base.url}`
    case 'opaque': return `opaque\0${base.description}`
  }
}

function matchingProjects(cwd: string | undefined, projects: readonly SkillLibraryProject[]): string[] {
  if (cwd === undefined) return []
  return projects.filter((project) => {
    const child = relative(resolve(project.path), resolve(cwd))
    return child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
  }).map(project => project.id)
}
