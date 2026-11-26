/**
 * Host state and persistence for bounded, reversible Live Edit previews.
 * @module @yharness/cordis-host-runner/live-edit
 */

import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { LiveEditAction, LiveEditOperation, LiveEditPatch, LiveEditState } from './types.ts'

const MAX_OPERATIONS = 32
const MAX_TITLE_LENGTH = 120
const MAX_TEXT_LENGTH = 500
const MAX_TARGET_LENGTH = 80
const MAX_ID_LENGTH = 64
const MAX_FILE_PATH_LENGTH = 4096
const TARGET_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const ID_PATTERN = /^[a-z][a-z0-9-]*$/
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i

/** Root and control targets are never valid destructive Live Edit targets. */
const PROTECTED_TARGETS = new Set([
  'app', 'center-column', 'composer', 'composer-controls', 'composer-draft', 'composer-editor',
  'composer-primary', 'controls', 'frame', 'main', 'main-column', 'rightbar', 'rightbar-column',
  'root', 'shell', 'sidebar', 'sidebar-column', 'sidebar-nav', 'toolbar',
])

interface LiveEditRecord {
  revision: string
  kept?: LiveEditPatch
  previous?: LiveEditPatch
  preview?: LiveEditPatch
  undoAvailable: boolean
}

interface PersistedLiveEditRecord {
  kept?: LiveEditPatch
  previous?: LiveEditPatch
  undoAvailable: boolean
}

interface PersistedLiveEditFile {
  version: 1
  record?: PersistedLiveEditRecord
}

/** Return true for a JSON object with string-keyed properties. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a Node error code without asserting an untrusted value. */
function errorCode(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.code !== 'string') return undefined
  return error.code
}

/** Clone a validated patch before retaining it outside the caller's stack. */
function clonePatch(patch: LiveEditPatch): LiveEditPatch {
  return {
    title: patch.title,
    operations: patch.operations.map(operation => ({ ...operation })),
  }
}

/** Validate one bounded plain-text field. */
function plainText(value: unknown, field: string, maximum: number, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string') throw new TypeError(`Live Edit ${field} must be plain text`)
  if (required && value.trim().length === 0) throw new TypeError(`Live Edit ${field} must not be empty`)
  if (value.length > maximum) throw new TypeError(`Live Edit ${field} must be at most ${maximum} characters`)
  // Renderer content is always text. Reject markup delimiters and controls so a
  // later renderer cannot accidentally turn this wire value into HTML or code.
  if (/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Live Edit ${field} must contain plain text only`)
  }
  return value
}

/** Validate and retain one exact data-yh-part token. */
function targetToken(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TARGET_LENGTH
    || !TARGET_PATTERN.test(value)) {
    throw new TypeError(`Live Edit ${field} must be a data-yh-part token`)
  }
  return value
}

/** Return whether a target names an app-wide shell or trusted control. */
function isProtectedTarget(target: string): boolean {
  return PROTECTED_TARGETS.has(target) || target.startsWith('shell-') || target.endsWith('-controls')
    || target.endsWith('-toolbar')
}

/** Reject unexpected fields at the JSON boundary. */
function exactFields(value: Record<string, unknown>, allowed: readonly string[], subject: string): void {
  const allowedSet = new Set(allowed)
  for (const field of Object.keys(value)) {
    if (!allowedSet.has(field)) throw new TypeError(`Live Edit ${subject} has unsupported field "${field}"`)
  }
}

/** Validate a literal bounded number. */
function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Live Edit ${field} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

/** Validate one Live Edit operation received from a tool or Remote boundary. */
function validateOperation(value: unknown, index: number): LiveEditOperation {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new TypeError(`Live Edit operation ${index} must be an object with a kind`)
  }
  const subject = `operation ${index}`
  const target = targetToken(value.target, `${subject} target`)
  switch (value.kind) {
    case 'hide':
      exactFields(value, ['kind', 'target'], subject)
      if (isProtectedTarget(target)) throw new TypeError(`Live Edit ${subject} cannot hide protected target "${target}"`)
      return { kind: 'hide', target }
    case 'add': {
      exactFields(value, ['kind', 'target', 'id', 'position', 'title', 'text'], subject)
      if (isProtectedTarget(target)) throw new TypeError(`Live Edit ${subject} cannot add to protected target "${target}"`)
      if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > MAX_ID_LENGTH
        || !ID_PATTERN.test(value.id)) {
        throw new TypeError(`Live Edit ${subject} id must be a lowercase token`)
      }
      if (value.position !== 'before' && value.position !== 'after'
        && value.position !== 'start' && value.position !== 'end') {
        throw new TypeError(`Live Edit ${subject} position is invalid`)
      }
      const title = plainText(value.title, `${subject} title`, MAX_TITLE_LENGTH, true)
      const text = plainText(value.text, `${subject} text`, MAX_TEXT_LENGTH, false)
      if (title === undefined) throw new TypeError(`Live Edit ${subject} title must not be empty`)
      return {
        kind: 'add', target, id: value.id, position: value.position, title,
        ...text === undefined ? {} : { text },
      }
    }
    case 'style': {
      exactFields(value, ['kind', 'target', 'color', 'background', 'radius', 'padding', 'order'], subject)
      const color = validateColor(value.color, `${subject} color`)
      const background = validateColor(value.background, `${subject} background`)
      const radius = boundedInteger(value.radius, `${subject} radius`, 0, 96)
      const padding = boundedInteger(value.padding, `${subject} padding`, 0, 96)
      const order = boundedInteger(value.order, `${subject} order`, -100, 100)
      if (color === undefined && background === undefined && radius === undefined
        && padding === undefined && order === undefined) {
        throw new TypeError(`Live Edit ${subject} must change at least one style value`)
      }
      return {
        kind: 'style', target,
        ...color === undefined ? {} : { color },
        ...background === undefined ? {} : { background },
        ...radius === undefined ? {} : { radius },
        ...padding === undefined ? {} : { padding },
        ...order === undefined ? {} : { order },
      }
    }
    default:
      throw new TypeError(`Live Edit ${subject} kind is unsupported`)
  }
}

/** Validate a CSS color literal accepted by the renderer. */
function validateColor(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !HEX_COLOR_PATTERN.test(value)) {
    throw new TypeError(`Live Edit ${field} must be a six-digit hex color literal`)
  }
  return value
}

/**
 * Validate a complete preview patch.
 * @param value - tool or profile JSON to validate.
 * @returns a structured patch with validated operations.
 */
export function validateLiveEditPatch(value: unknown): LiveEditPatch {
  if (!isRecord(value)) throw new TypeError('Live Edit patch must be an object')
  exactFields(value, ['title', 'operations'], 'patch')
  const title = plainText(value.title, 'patch title', MAX_TITLE_LENGTH, true)
  if (title === undefined) throw new TypeError('Live Edit patch title must not be empty')
  if (!Array.isArray(value.operations) || value.operations.length === 0 || value.operations.length > MAX_OPERATIONS) {
    throw new TypeError(`Live Edit patch operations must contain 1–${MAX_OPERATIONS} items`)
  }
  const operations = value.operations.map((operation, index) => validateOperation(operation, index))
  const ids = new Set<string>()
  for (const operation of operations) {
    if (operation.kind !== 'add') continue
    if (ids.has(operation.id)) throw new TypeError(`Live Edit patch repeats added id "${operation.id}"`)
    ids.add(operation.id)
  }
  return { title, operations }
}

/** Validate and normalize the optional private profile file path. */
function validateLiveEditFile(file: string | undefined): string | undefined {
  if (file === undefined) return undefined
  if (file.length === 0 || file.length > MAX_FILE_PATH_LENGTH || file.includes('\u0000') || !isAbsolute(file)) {
    throw new TypeError('liveEditFile must be an absolute path to a private profile file')
  }
  const name = basename(file)
  if (name.length === 0 || name === '.' || name === '..') {
    throw new TypeError('liveEditFile must name a file')
  }
  try {
    if (lstatSync(file).isSymbolicLink()) throw new TypeError('liveEditFile must not be a symbolic link')
  } catch (error) {
    if (error instanceof TypeError) throw error
    if (errorCode(error) !== 'ENOENT') throw new Error(`liveEditFile cannot be inspected: ${file}`, { cause: error })
  }
  return file
}

/** Validate a persisted record without exposing it as a public wire value. */
function persistedRecord(value: unknown, subject: string): PersistedLiveEditRecord {
  if (!isRecord(value)) throw new TypeError(`Live Edit persistence ${subject} must be an object`)
  exactFields(value, ['kept', 'previous', 'undoAvailable'], subject)
  const kept = value.kept === undefined ? undefined : validateLiveEditPatch(value.kept)
  const previous = value.previous === undefined ? undefined : validateLiveEditPatch(value.previous)
  const undoAvailable = value.undoAvailable === undefined
    ? previous !== undefined
    : value.undoAvailable
  if (typeof undoAvailable !== 'boolean') throw new TypeError(`Live Edit persistence ${subject}.undoAvailable must be boolean`)
  return {
    ...kept === undefined ? {} : { kept },
    ...previous === undefined ? {} : { previous },
    undoAvailable,
  }
}

/** Parse a private profile file, retaining only validated patches. */
function persistedFile(value: unknown): PersistedLiveEditRecord | undefined {
  if (!isRecord(value) || value.version !== 1) {
    throw new TypeError('Live Edit persistence has an unsupported format')
  }
  return value.record === undefined ? undefined : persistedRecord(value.record, 'record')
}

/** Return the state exposed to the owner window without exposing undo history. */
function publicState(record: LiveEditRecord): LiveEditState {
  return {
    revision: record.revision,
    ...record.kept === undefined ? {} : { kept: clonePatch(record.kept) },
    ...record.preview === undefined ? {} : { preview: clonePatch(record.preview) },
    canUndo: record.preview !== undefined || record.undoAvailable,
  }
}

/** Create a fresh in-memory record from a durable record. */
function recordFromPersisted(value: PersistedLiveEditRecord | undefined): LiveEditRecord {
  return {
    revision: randomUUID(),
    ...value?.kept === undefined ? {} : { kept: clonePatch(value.kept) },
    ...value?.previous === undefined ? {} : { previous: clonePatch(value.previous) },
    undoAvailable: value?.undoAvailable ?? false,
  }
}

/** Error emitted when a window acts on a state it no longer displays. */
export class LiveEditRevisionError extends Error {
  /** Stable error name for logs and Remote diagnostics. */
  override readonly name = 'LiveEditRevisionError'

  /**
   * @param expected - revision supplied by the owner window.
   * @param actual - revision currently held by the Host.
   */
  constructor(expected: string, actual: string) {
    super(`Live Edit revision is stale (expected ${expected}, current ${actual})`)
  }
}

/** Host-owned Live Edit store, optionally backed by one private profile file. */
export class LiveEditStore {
  private readonly file: string | undefined
  private recordState: LiveEditRecord = recordFromPersisted(undefined)
  private mutationTail: Promise<void> = Promise.resolve()
  private readonly changed: () => void

  /**
   * @param file - optional absolute private profile path.
   * @param changed - callback published after a visible state transition.
   */
  constructor(file?: string, changed: () => void = () => {}) {
    this.file = validateLiveEditFile(file)
    this.changed = changed
    if (this.file === undefined || !existsSync(this.file)) return
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch (error) {
      throw new Error(`Live Edit profile could not be read: ${this.file}`, { cause: error })
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch (error) {
      throw new Error(`Live Edit profile is not valid JSON: ${this.file}`, { cause: error })
    }
    const persisted = persistedFile(value)
    if (persisted !== undefined) this.recordState = recordFromPersisted(persisted)
  }

  /**
   * Stage a validated preview for the private profile.
   * @param patch - untrusted tool payload to validate.
   * @returns the owner-visible state with a new revision.
   */
  async stage(patch: unknown): Promise<LiveEditState> {
    const validated = validateLiveEditPatch(patch)
    return this.enqueue(() => {
      this.recordState = { ...this.recordState, revision: randomUUID(), preview: validated }
      this.changed()
      return publicState(this.recordState)
    })
  }

  /**
   * Read the private profile's current state.
   * @returns a defensive copy of the owner-visible state.
   */
  state(): LiveEditState {
    return publicState(this.recordState)
  }

  /**
   * Apply Keep or Undo against the exact displayed revision.
   * @param action - user-confirmed state transition.
   * @param revision - revision shown in the owner window.
   * @returns the resulting owner-visible state.
   */
  apply(action: LiveEditAction, revision: string): Promise<LiveEditState> {
    if (action !== 'keep' && action !== 'undo') return Promise.reject(new TypeError('Live Edit action is unsupported'))
    return this.enqueue(async () => {
      const fresh = this.recordState
      if (fresh.revision !== revision) throw new LiveEditRevisionError(revision, fresh.revision)
      const next = action === 'keep' ? keepRecord(fresh) : undoRecord(fresh)
      const durable = action === 'keep' || (fresh.preview === undefined && fresh.undoAvailable)
      if (durable && this.file !== undefined) await writePrivateProfile(this.file, next)
      this.recordState = { ...next, revision: randomUUID() }
      const result = publicState(this.recordState)
      this.changed()
      return result
    })
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation)
    this.mutationTail = run.then(() => undefined, () => undefined)
    return run
  }
}

/** Compute the state after Keep, retaining the prior kept patch for Undo. */
function keepRecord(record: LiveEditRecord): LiveEditRecord {
  if (record.preview === undefined) throw new Error('Live Edit has no preview to keep')
  return {
    revision: record.revision,
    kept: clonePatch(record.preview),
    ...record.kept === undefined ? {} : { previous: clonePatch(record.kept) },
    undoAvailable: true,
  }
}

/** Compute the state after Undo, first dropping a preview and then reverting Keep. */
function undoRecord(record: LiveEditRecord): LiveEditRecord {
  if (record.preview !== undefined) {
    return {
      revision: record.revision,
      ...record.kept === undefined ? {} : { kept: clonePatch(record.kept) },
      ...record.previous === undefined ? {} : { previous: clonePatch(record.previous) },
      undoAvailable: record.undoAvailable,
    }
  }
  if (!record.undoAvailable) throw new Error('Live Edit has no change to undo')
  return {
    revision: record.revision,
    ...record.previous === undefined ? {} : { kept: clonePatch(record.previous) },
    undoAvailable: false,
  }
}

/** Atomically write a private profile snapshot with owner-only file mode. */
async function writePrivateProfile(file: string, record: LiveEditRecord): Promise<void> {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const existing = await safeLstat(file)
  if (existing?.isSymbolicLink()) throw new Error('Live Edit profile must not be a symbolic link')
  const data: PersistedLiveEditFile = {
    version: 1,
    ...record.kept === undefined && record.previous === undefined && !record.undoAvailable
      ? {}
      : {
        record: {
          ...record.kept === undefined ? {} : { kept: clonePatch(record.kept) },
          ...record.previous === undefined ? {} : { previous: clonePatch(record.previous) },
          undoAvailable: record.undoAvailable,
        },
      },
  }
  const temporary = join(directory, `.${basename(file)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, file)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch (cleanupError) {
      if (errorCode(cleanupError) !== 'ENOENT') {
        throw new Error(`Live Edit profile cleanup failed: ${temporary}`, { cause: cleanupError })
      }
    }
    throw new Error(`Live Edit profile could not be written: ${file}`, { cause: error })
  }
}

/** Read a profile file's metadata while treating absence as normal. */
async function safeLstat(file: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(file)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw new Error(`Live Edit profile cannot be inspected: ${file}`, { cause: error })
  }
}
