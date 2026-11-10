/** Install exported skill bodies through the Bot workspace's ordinary skill discovery. */

import { randomUUID } from 'node:crypto'
import { lstat, link, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, parse } from 'node:path'
import { isSkillName } from '@yharness/skill'

interface GrokImportedSkill {
  readonly name: string
  readonly description: string
  readonly instructions: string
}

interface GrokSkillImportResult {
  readonly created: readonly string[]
  readonly skipped: readonly string[]
  readonly namesBySourceName: Readonly<Record<string, string>>
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

async function statIfPresent(path: string) {
  try {
    return await lstat(path)
  } catch (error: unknown) {
    if (!hasCode(error, 'ENOENT')) throw error
    return undefined
  }
}

async function checkDirectory(path: string, create: boolean): Promise<void> {
  let info = await statIfPresent(path)
  if (info === undefined && create) {
    try {
      await mkdir(path, { mode: 0o700 })
    } catch (error: unknown) {
      if (!hasCode(error, 'EEXIST')) throw error
    }
    info = await lstat(path)
  }
  if (info?.isSymbolicLink()) throw new Error('Grok skill import refuses a symbolic link directory.')
  if (info !== undefined && !info.isDirectory()) throw new Error('The Grok skill destination must be a directory.')
}

async function alreadyInstalled(path: string, content: string): Promise<boolean> {
  const info = await statIfPresent(path)
  if (info === undefined) return false
  if (info.isSymbolicLink()) throw new Error('Grok skill import refuses a symbolic link file.')
  if (!info.isFile() || info.size !== Buffer.byteLength(content) || await readFile(path, 'utf8') !== content) {
    throw new Error('A Grok skill file already exists with different content.')
  }
  return true
}

async function installSkill(path: string, content: string): Promise<boolean> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600, flush: true })
    try {
      await link(temporary, path)
      return true
    } catch (error: unknown) {
      if (!hasCode(error, 'EEXIST') || !await alreadyInstalled(path, content)) throw error
      return false
    }
  } finally {
    await rm(temporary, { force: true })
  }
}

/** Convert an export's display name to the workspace skill identifier.
 * @param sourceName - Grok skill display name.
 * @returns A kebab-case identifier, or throws when it cannot be represented.
 */
export function canonicalGrokSkillName(sourceName: string): string {
  const name = sourceName.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '')
  if (!isSkillName(name) || name.length > 128) throw new Error('A Grok skill name cannot be used as a workspace identifier.')
  return name
}

/** Validate or install skill files in an existing Bot working directory.
 * Identical files are reused. A different file or a symlink blocks the import.
 * @param botCwd - Existing absolute working directory used by skill discovery.
 * @param skills - Validated export skill definitions.
 * @param options - Set preview to check files without writing to the workspace.
 * @returns The canonical name mapping and per-batch creation outcomes.
 */
export async function importGrokBotSkills(
  botCwd: string,
  skills: readonly GrokImportedSkill[],
  options: { readonly preview?: boolean } = {},
): Promise<GrokSkillImportResult> {
  if (!isAbsolute(botCwd) || !(await lstat(botCwd)).isDirectory()) {
    throw new Error('The destination Bot needs an existing absolute working directory.')
  }
  const cwd = await realpath(botCwd)
  if (cwd === parse(cwd).root) throw new Error('The Bot working directory must not be a filesystem root.')
  const agentsRoot = join(cwd, '.agents')
  const skillRoot = join(agentsRoot, 'skills')
  const names = new Map<string, string>()
  const files = new Map<string, string>()
  for (const skill of skills) {
    const name = canonicalGrokSkillName(skill.name)
    const description = skill.description || 'Imported Grok Bot skill.'
    const content = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${skill.instructions}\n`
    const previous = files.get(name)
    if (previous !== undefined && previous !== content) throw new Error('Two Grok skills map to the same workspace name.')
    names.set(skill.name, name)
    files.set(name, content)
  }
  await checkDirectory(agentsRoot, false)
  await checkDirectory(skillRoot, false)
  const created: string[] = []
  const skipped: string[] = []
  const pending = new Map<string, string>()
  for (const [name, content] of files) {
    const directory = join(skillRoot, name)
    await checkDirectory(directory, false)
    if (await alreadyInstalled(join(directory, 'SKILL.md'), content)) skipped.push(name)
    else pending.set(name, content)
  }
  if (options.preview === true) created.push(...pending.keys())
  else if (pending.size > 0) {
    await checkDirectory(agentsRoot, true)
    await checkDirectory(skillRoot, true)
    for (const [name, content] of pending) {
      const directory = join(skillRoot, name)
      await checkDirectory(directory, true)
      if (await installSkill(join(directory, 'SKILL.md'), content)) created.push(name)
      else skipped.push(name)
    }
  }
  return { created, skipped, namesBySourceName: Object.fromEntries(names) }
}
