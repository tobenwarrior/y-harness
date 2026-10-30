/** Bundled Compound engineering skills with their vendored Python analysis tooling. */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@yharness/cordis'
import type {} from '@yharness/client-connection'
import type {} from '@yharness/sandbox-policy'
import z from '@yharness/schemastery'
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillLookupOptions,
  type SkillProvider,
  type SkillProviderControl,
} from '@yharness/skill'
import { parse as parseYaml } from 'yaml'
import { MapServiceBridge, registerMapRoutes } from './map-service.ts'
import { activeOverlay, overlayRoot as defaultOverlayRoot } from './overlay.ts'
import {
  compareReleases,
  recordedCommit,
  registerUpdateRoute,
  runOverlayUpdate,
  UpstreamReleaseTracker,
  VENDORED_VERSION,
  type UpdateApplication,
} from './upstream.ts'
/** Vendored skill directories, each carrying its own `SKILL.md` and resources. */
const SKILL_NAMES = ['compound', 'map', 'setup', 'setup-global', 'status-global'] as const

/** Lowest interpreter release the vendored scripts accept; `repo_audit.py` refuses older. */
const MINIMUM_PYTHON_MAJOR = 3
const MINIMUM_PYTHON_MINOR = 11

/** Interpreters probed in order when the deployment names none. */
const PYTHON_CANDIDATES = ['python3.13', 'python3.12', 'python3.11', 'python3'] as const

/** Compound skill resource location. */
export interface Config {
  /** Absolute assets directory holding the vendored skill folders; defaults to the packaged assets. */
  assetRoot?: string
  /** Absolute Python 3.11+ interpreter; defaults to the newest qualifying interpreter on `PATH`. */
  python?: string
  /** Absolute cache directory for the code-map service; defaults outside the mapped repository. */
  mapStateDir?: string
  /** Absolute private directory where automatically downloaded revisions are published. */
  overlayRoot?: string
}

/** Validated resource configuration. */
export const Config: z<Config> = z.object({
  assetRoot: z.string().min(1),
  python: z.string().min(1),
  mapStateDir: z.string().min(1),
  overlayRoot: z.string().min(1),
})

/** Cordis plugin identity. */
export const name = 'skill-compound'
/** Registry used by the bundled provider. */
export const inject = ['skills']

/** Interval for host-side automatic Compound revision checks. */
export const AUTO_UPDATE_INTERVAL_MS = 60 * 60 * 1000

/** Package root carrying the recorded bundled release metadata. */
const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))

/**
 * Split one vendored skill file into its declared identity and body.
 * @param raw - complete `SKILL.md` text.
 * @param path - absolute file path, used in diagnostics.
 * @returns the frontmatter name and description with the body that follows.
 */
function parseSkill(raw: string, path: string): { name: string; description: string; content: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) throw new Error(`skill-compound: ${path} has no YAML frontmatter`)
  const metadata: unknown = parseYaml(frontmatter[1])
  if (typeof metadata !== 'object' || metadata === null) throw new Error(`skill-compound: ${path} has no YAML mapping`)
  const { name, description } = metadata as { name?: unknown; description?: unknown }
  if (typeof name !== 'string' || name.length === 0) throw new Error(`skill-compound: ${path} has no name`)
  if (typeof description !== 'string' || description.length === 0) throw new Error(`skill-compound: ${path} has no description`)
  return { name, description, content: raw.slice(frontmatter[0].length).trim() }
}

/**
 * Read one interpreter's reported release.
 * @param executable - interpreter name or absolute path to probe.
 * @returns the major and minor release, or `undefined` when the probe cannot run.
 */
function pythonRelease(executable: string): readonly [number, number] | undefined {
  const probe = spawnSync(executable, ['--version'], { encoding: 'utf8' })
  if (probe.error !== undefined || probe.status !== 0) return undefined
  const match = /Python (\d+)\.(\d+)/u.exec(`${probe.stdout}${probe.stderr}`)
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  return [Number(match[1]), Number(match[2])]
}

/**
 * Whether a probed release satisfies the vendored scripts.
 * @param release - probed major and minor release, when one was readable.
 * @returns whether the interpreter is new enough.
 */
function isSupportedPython(release: readonly [number, number] | undefined): boolean {
  if (release === undefined) return false
  const [major, minor] = release
  return major > MINIMUM_PYTHON_MAJOR || (major === MINIMUM_PYTHON_MAJOR && minor >= MINIMUM_PYTHON_MINOR)
}

/**
 * Choose the interpreter the skill instructions must call.
 *
 * An explicit `python` config wins even when it does not qualify: the runtime
 * section then reports the shortfall instead of silently probing past the
 * deployment's deliberate choice.
 * @param configured - absolute interpreter from the plugin config, when supplied.
 * @returns the interpreter to advertise and whether it satisfies the scripts.
 */
function resolvePython(configured: string | undefined): { python: string; supported: boolean } {
  if (configured !== undefined) {
    if (!isAbsolute(configured)) throw new Error('skill-compound: python must be an absolute interpreter path')
    return { python: configured, supported: isSupportedPython(pythonRelease(configured)) }
  }
  for (const candidate of PYTHON_CANDIDATES) {
    const release = pythonRelease(candidate)
    if (isSupportedPython(release)) return { python: candidate, supported: true }
  }
  return { python: 'python3', supported: false }
}

/**
 * Render the absolute paths one skill's commands must use.
 *
 * The vendored instructions address their resources as `<installed-skill-dir>`
 * and call a bare `python3`, which a deployment may route to an interpreter the
 * scripts refuse; this section supplies both values concretely.
 * @param directory - absolute directory holding the loaded `SKILL.md`.
 * @param python - interpreter to call instead of `python3`.
 * @param supported - whether that interpreter satisfies the scripts.
 * @returns the appended runtime section.
 */
function compoundRuntime(directory: string, python: string, supported: boolean): string {
  const shortfall = supported ? '' : `\n\nThe resolved interpreter is older than the required Python ${MINIMUM_PYTHON_MAJOR}.${MINIMUM_PYTHON_MINOR}; the bundled scripts refuse it. Set this plugin's \`python\` config to an absolute Python ${MINIMUM_PYTHON_MAJOR}.${MINIMUM_PYTHON_MINOR}+ interpreter before running them.`
  return `\n\n## Compound runtime\n\nReplace \`<installed-skill-dir>\` in the commands above with \`skillDir\`, and a bare \`python3\` with \`python\`, before running them.\n\n\`\`\`json\n${JSON.stringify({ compoundSkills: { skillDir: directory, python } }, undefined, 2)}\n\`\`\`${shortfall}`
}

/**
 * Render the deployment note that replaces the upstream per-host activation model.
 *
 * The vendored activation instructions cover Codex, Claude Code, and Cursor,
 * which enable Compound by writing each host's own configuration files. Y
 * Harness registers the same skills for every session, so those steps neither
 * apply nor have a file to write.
 * @returns the appended activation section.
 */
function harnessActivation(): string {
  return '\n\n## Y Harness activation\n\nThis deployment registers Compound as bundled skills for every session, so the upstream global and per-project setup steps are unnecessary. The `setup-global` and `status-global` instructions manage Codex, Claude Code, and Cursor configuration files, which do not exist here: do not create or edit them, and report that activation is already in force instead. Load this skill directly whenever the task calls for it.'
}

/**
 * Register the vendored Compound skills with their resource directories.
 * @param ctx - Context carrying the skill registry.
 * @param config - Optional external assets directory and interpreter override.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const assetRoot = config.assetRoot ?? fileURLToPath(new URL('../assets/', import.meta.url))
  if (!isAbsolute(assetRoot)) throw new Error('skill-compound: assetRoot must be an absolute directory')
  const updateRoot = config.overlayRoot ?? defaultOverlayRoot()
  if (!isAbsolute(updateRoot)) throw new Error('skill-compound: overlayRoot must be an absolute directory')
  const { python, supported } = resolvePython(config.python)
  const bundledCommit = recordedCommit(readFileSync(join(PACKAGE_ROOT, 'UPSTREAM.md'), 'utf8'))
  const bundledBaseline = { version: VENDORED_VERSION, commit: bundledCommit }
  const activeRevision = () => {
    const overlay = activeOverlay(updateRoot)
    if (overlay === undefined) return undefined
    const order = compareReleases(overlay.version, VENDORED_VERSION)
    return order !== undefined && order >= 0 ? overlay : undefined
  }
  const baseline = (): { version: string; commit: string } => {
    return activeRevision() ?? bundledBaseline
  }
  const currentAssetRoot = (): string => activeRevision()?.assetRoot ?? assetRoot
  // Keep the original load-time contract for the bundled package: malformed shipped
  // assets fail plugin activation instead of surfacing later during discovery.
  for (const skillName of SKILL_NAMES) {
    const directory = join(assetRoot, skillName)
    const path = join(directory, 'SKILL.md')
    const { name: declared } = parseSkill(readFileSync(path, 'utf8'), path)
    if (declared !== skillName) {
      throw new Error(`skill-compound: ${path} declares "${declared}" but its directory is "${skillName}"`)
    }
  }
  const provider: SkillProvider = {
    name: 'dsh-compound',
    list: () => {
      const root = currentAssetRoot()
      return Promise.resolve(SKILL_NAMES.map((skillName) => {
        const directory = join(root, skillName)
        const path = join(directory, 'SKILL.md')
        const { name: declared, description } = parseSkill(readFileSync(path, 'utf8'), path)
        if (declared !== skillName) {
          throw new Error(`skill-compound: ${path} declares "${declared}" but its directory is "${skillName}"`)
        }
        return {
          name: skillName,
          description,
          path,
          invocation: { modelInvocable: true, userInvocable: true },
          provider: 'dsh-compound',
          source: 'bundled',
          rank: BUNDLED_SKILL_RANK,
          resourceBase: { kind: 'directory', path: directory },
          locator: { skillName },
        }
      }))
    },
    async get(candidate: SkillCandidate, options: SkillLookupOptions) {
      const { rank: _rank, locator, ...summary } = candidate
      const skillName = (locator as { skillName?: unknown }).skillName
      if (typeof skillName !== 'string' || !SKILL_NAMES.includes(skillName as typeof SKILL_NAMES[number])) return undefined
      const directory = join(currentAssetRoot(), skillName)
      const path = join(directory, 'SKILL.md')
      const raw = await readFile(path, { encoding: 'utf8', signal: options.signal })
      const body = parseSkill(raw, path).content
      return {
        ...summary,
        path,
        resourceBase: { kind: 'directory', path: directory },
        content: body + compoundRuntime(directory, python, supported) + harnessActivation(),
      }
    },
  }
  let invalidateCatalog = (): void => {}
  ctx.skills.registerProvider((control: SkillProviderControl) => {
    invalidateCatalog = control.invalidate
    return provider
  })
  const tracker = new UpstreamReleaseTracker(undefined, baseline)
  // Optional: a composition without the shared API channel still gets the
  // skills, it just cannot report upstream releases or serve the code map.
  ctx.inject(['connection'], (scope) => {
    let disposed = false
    const lifetime = new AbortController()
    let runningUpdate: Promise<UpdateApplication> | undefined
    const updateOperations = new Set<Promise<UpdateApplication>>()
    const mapBridge = new MapServiceBridge({
      python,
      assetRoot,
      assetRootFor: currentAssetRoot,
      workspaceRoot: ctx.get('sandboxPolicy')?.workspaceRoot ?? process.cwd(),
      ...(config.mapStateDir === undefined ? {} : { stateDir: config.mapStateDir }),
    })
    const applyUpdate = (): Promise<UpdateApplication> => {
      if (disposed) return Promise.resolve({ status: 'failed', upstream: null, error: 'skill-compound is disposing' })
      if (runningUpdate !== undefined) return runningUpdate
      const operation = (async (): Promise<UpdateApplication> => {
        const outcome = await runOverlayUpdate(updateRoot, baseline, lifetime.signal)
        if (outcome.status === 'updated' || outcome.status === 'up-to-date') {
          invalidateCatalog()
          tracker.invalidate()
          if (outcome.status === 'updated') mapBridge.invalidate()
        }
        return outcome
      })()
      runningUpdate = operation
      updateOperations.add(operation)
      void operation.then(
        () => {
          updateOperations.delete(operation)
          if (runningUpdate === operation) runningUpdate = undefined
        },
        () => {
          updateOperations.delete(operation)
          if (runningUpdate === operation) runningUpdate = undefined
        },
      )
      return operation
    }
    registerUpdateRoute(scope, tracker, applyUpdate)
    registerMapRoutes(scope, mapBridge)
    scope.effect(() => {
      const pendingChecks = new Set<Promise<void>>()
      const synchronize = async (): Promise<void> => {
        if (disposed) return
        tracker.invalidate()
        const status = await tracker.status(lifetime.signal)
        if (status.error !== null || !status.updateAvailable) return
        await applyUpdate()
      }
      const schedule = (): void => {
        const operation = synchronize().catch(() => {})
        pendingChecks.add(operation)
        void operation.then(() => { pendingChecks.delete(operation) }, () => { pendingChecks.delete(operation) })
      }
      schedule()
      const timer = setInterval(schedule, AUTO_UPDATE_INTERVAL_MS)
      return async () => {
        disposed = true
        lifetime.abort()
        clearInterval(timer)
        while (pendingChecks.size > 0 || updateOperations.size > 0) {
          await Promise.all([...pendingChecks, ...updateOperations])
        }
      }
    }, 'skill-compound: automatic upstream updates')
  })
}
