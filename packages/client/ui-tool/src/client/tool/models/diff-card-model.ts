/** Pure diff-card derivation from raw file-mutation calls and result metadata. @module */
import type { DiffBlockProps, DiffHunk } from '@yharness/client-ui-primitives'
import type { ToolCallBlock } from './tool-call-model.ts'
import { parsedToolCall } from './raw-tool-call.ts'

/** Room for a path, one removed/added pair, and three context lines on each side. */
export const CHAT_DIFF_MAX_LINES = 9

/**
 * The {@link DiffBlock} props this derivation owns. Picked off the primitive's
 * props so the two stay in step; `maxLines`/`className` belong to each render
 * site.
 */
export interface DiffCardModel {
  /**
   * The props {@link DiffBlock} draws. Held as a nested object so a render site
   * spreads exactly the primitive's own surface and can never leak a
   * neighbouring field into it.
   */
  card: Pick<DiffBlockProps, 'diffs'>
  /** File locations affected by a mutation even when no bounded diff text exists. */
  locations?: readonly DiffLocation[]
}

/** A file location surfaced by a mutation card. */
export interface DiffLocation {
  path: string
}

/**
 * Narrow opaque result metadata's `diffs` to well-formed hunks.
 * @param diffs - the metadata field to validate.
 * @returns the validated hunks, or null when the payload is not usable.
 */
function narrowDiffs(diffs: unknown): DiffHunk[] | null {
  if (!Array.isArray(diffs) || diffs.length === 0) return null
  const out: DiffHunk[] = []
  for (const hunk of diffs) {
    if (typeof hunk !== 'object' || hunk === null) return null
    const { path, oldText, newText } = hunk as Record<string, unknown>
    if (typeof path !== 'string') return null
    if (oldText !== null && typeof oldText !== 'string') return null
    if (typeof newText !== 'string') return null
    out.push({ path, oldText, newText })
  }
  return out
}

/** Narrow a patch result's diff array while preserving an empty, valid array. */
function narrowPatchDiffs(diffs: unknown): DiffHunk[] | null {
  if (!Array.isArray(diffs)) return null
  if (diffs.length === 0) return []
  return narrowDiffs(diffs)
}

/** Narrow patch locations retained for effects without a bounded before-image. */
function narrowLocations(locations: unknown): DiffLocation[] | null {
  if (!Array.isArray(locations)) return null
  if (!locations.every((location) => {
    if (typeof location !== 'object' || location === null || Array.isArray(location)) return false
    const { path } = location as Record<string, unknown>
    return typeof path === 'string' && path.trim() !== ''
  })) return null
  return locations as DiffLocation[]
}

function locationsFromDiffs(diffs: readonly DiffHunk[]): DiffLocation[] {
  const paths = new Set<string>()
  const locations: DiffLocation[] = []
  for (const diff of diffs) {
    if (paths.has(diff.path)) continue
    paths.add(diff.path)
    locations.push({ path: diff.path })
  }
  return locations
}

interface PatchPreview {
  diffs: DiffHunk[]
  locations: DiffLocation[]
}

interface PatchOperationPreview {
  kind: 'add' | 'update' | 'delete'
  path: string
  destination?: string
  oldLines: string[]
  newLines: string[]
}

/**
 * Parse the small presentation subset of Codex patch syntax needed by the
 * browser card. The filesystem tool remains authoritative for validation and
 * execution; this parser only builds a best-effort preview from call text.
 * @param input - raw apply_patch input.
 * @returns preview diffs and affected locations, or null for malformed input.
 */
function patchPreview(input: string): PatchPreview | null {
  const lines = input.split(/\r?\n/u)
  if (lines[0] !== '*** Begin Patch' || !lines.includes('*** End Patch')) return null
  const operations: PatchOperationPreview[] = []
  let current: PatchOperationPreview | undefined
  const finish = () => {
    if (current !== undefined) operations.push(current)
    current = undefined
  }
  for (const line of lines.slice(1)) {
    if (line === '*** End Patch') break
    const add = /^\*\*\* Add File: (.+)$/u.exec(line)
    if (add !== null) {
      finish()
      const path = add[1]
      if (path === undefined) return null
      current = { kind: 'add', path, oldLines: [], newLines: [] }
      continue
    }
    const update = /^\*\*\* Update File: (.+)$/u.exec(line)
    if (update !== null) {
      finish()
      const path = update[1]
      if (path === undefined) return null
      current = { kind: 'update', path, oldLines: [], newLines: [] }
      continue
    }
    const remove = /^\*\*\* Delete File: (.+)$/u.exec(line)
    if (remove !== null) {
      finish()
      const path = remove[1]
      if (path === undefined) return null
      current = { kind: 'delete', path, oldLines: [], newLines: [] }
      continue
    }
    const move = /^\*\*\* Move to: (.+)$/u.exec(line)
    if (move !== null) {
      if (current?.kind !== 'update') return null
      const destination = move[1]
      if (destination === undefined) return null
      current.destination = destination
      continue
    }
    if (current === undefined || current.kind === 'delete' || line.startsWith('@@') || line === '*** End of File') continue
    if (current.kind === 'add') {
      if (!line.startsWith('+')) return null
      current.newLines.push(line.slice(1))
      continue
    }
    if (line.startsWith('-')) current.oldLines.push(line.slice(1))
    else if (line.startsWith('+')) current.newLines.push(line.slice(1))
    else if (line.startsWith(' ')) {
      const context = line.slice(1)
      current.oldLines.push(context)
      current.newLines.push(context)
    }
    else return null
  }
  finish()
  if (operations.length === 0) return null
  const locations: DiffLocation[] = []
  const seen = new Set<string>()
  const addLocation = (path: string) => {
    if (!seen.has(path)) {
      seen.add(path)
      locations.push({ path })
    }
  }
  const diffs = operations.flatMap((operation): DiffHunk[] => {
    addLocation(operation.path)
    if (operation.destination !== undefined) addLocation(operation.destination)
    if (operation.kind === 'delete') return []
    if (operation.kind === 'add') return [{ path: operation.path, oldText: null, newText: `${operation.newLines.join('\n')}\n` }]
    return [{ path: operation.path, oldText: operation.oldLines.length === 0 ? null : operation.oldLines.join('\n'), newText: operation.newLines.join('\n') }]
  })
  return { diffs, locations }
}

function applyPatchResult(meta: unknown): PatchPreview | null {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  const record = meta as Record<string, unknown>
  const diffs = narrowPatchDiffs(record.diffs)
  if (diffs === null) return null
  const locations = record.locations === undefined ? locationsFromDiffs(diffs) : narrowLocations(record.locations)
  if (locations === null || (diffs.length === 0 && locations.length === 0)) return null
  return { diffs, locations }
}

/**
 * Return a compact path summary for a mutation's affected locations.
 * @param model - derived diff card.
 * @returns comma-separated paths, or undefined when no locations were retained.
 */
export function diffLocationsSummary(model: DiffCardModel | null): string | undefined {
  const locations = model?.locations
  return locations === undefined || locations.length === 0 ? undefined : locations.map(location => location.path).join(', ')
}

type IntendedDiff = { tool: 'write' | 'edit' | 'str_replace_editor'; diff: DiffHunk }

function intendedDiff(block: ToolCallBlock): IntendedDiff | null {
  const parsed = parsedToolCall(block)
  if (parsed === null) return null
  if (parsed.name === 'str_replace_editor') {
    const { command, path, file_text: fileText, old_str: oldText, new_str: newText } = parsed.args
    if (typeof path !== 'string' || path.trim() === '') return null
    if (command === 'create') {
      if (fileText !== undefined && typeof fileText !== 'string') return null
      return {
        tool: 'str_replace_editor',
        diff: { path, oldText: null, newText: fileText ?? '' },
      }
    }
    if (command === 'str_replace') {
      if (oldText !== undefined && typeof oldText !== 'string') return null
      if (newText !== undefined && typeof newText !== 'string') return null
      return {
        tool: 'str_replace_editor',
        diff: { path, oldText: oldText ?? null, newText: newText ?? '' },
      }
    }
    return null
  }
  const { file_path: path } = parsed.args
  if (typeof path !== 'string' || path.trim() === '') return null
  if (parsed.name === 'write') {
    const { content } = parsed.args
    return typeof content === 'string'
      ? { tool: 'write', diff: { path, oldText: null, newText: content } }
      : null
  }
  if (parsed.name !== 'edit') return null
  const { old_string: oldText, new_string: newText, replace_all: replaceAll } = parsed.args
  if (typeof oldText !== 'string' || typeof newText !== 'string') return null
  if (replaceAll !== undefined && typeof replaceAll !== 'boolean') return null
  return { tool: 'edit', diff: { path, oldText: oldText || null, newText } }
}

function appliedDiffs(meta: unknown): DiffHunk[] | 'empty' | null {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  const diffs = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(diffs)) return null
  if (diffs.length === 0) return 'empty'
  return narrowDiffs(diffs)
}

/**
 * Derive running diffs for root write/edit and `str_replace_editor`
 * create/replace calls, plus applied settled diffs for root write/edit calls.
 * A successful write with valid empty metadata uses its argument-derived
 * whole-file diff, matching create and identical-overwrite presentation;
 * `str_replace_editor` settles through Generic because it has no result view.
 * @param block - running or settled Tool block.
 * @returns the diff-card props, or null for the generic path.
 */
export function diffCardModel(block: ToolCallBlock): DiffCardModel | null {
  if (block.parentCallId !== undefined) return null
  const parsed = parsedToolCall(block)
  if (parsed?.name === 'apply_patch') {
    const input = parsed.args.input
    if (typeof input !== 'string') return null
    if (!('kind' in block)) {
      const preview = patchPreview(input)
      return preview === null ? null : { card: { diffs: preview.diffs }, locations: preview.locations }
    }
    if (block.isError) return null
    const applied = applyPatchResult(block.meta)
    return applied === null ? null : { card: { diffs: applied.diffs }, locations: applied.locations }
  }
  const intended = intendedDiff(block)
  if (intended === null) return null
  if (!('kind' in block)) return { card: { diffs: [intended.diff] } }
  if (intended.tool === 'str_replace_editor') return null
  if (block.isError) return null
  const applied = appliedDiffs(block.meta)
  if (applied === null || applied === 'empty') {
    return intended.tool === 'write' ? { card: { diffs: [intended.diff] } } : null
  }
  return { card: { diffs: applied } }
}
