/** Immutable Markdown children; root replacement and rollback remain library.revise's responsibility. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import fs from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { MARKDOWN_BYTE_CAP, markdownWithinLimit } from './markdown-size.ts'
import { planMarkdownSplit } from './markdown-split.ts'

const HEX = /^[0-9a-f]{64}$/
const MANIFEST = '.manifest.json'
const RESERVATION_PREFIX = '.reservation-'
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const RESERVATION_NAME = new RegExp(`^\\.reservation-([0-9a-f]{64})\\.([1-9][0-9]{0,9})\\.(${UUID})\\.(${UUID})\\.json$`)
const MAX_FILES = 64
const MAX_GENERATIONS = 8
const MAX_PATH_BYTES = 1024
const MAX_DEPTH = 16
const MAX_MANIFEST_BYTES = 128 * 1024
const FENCE_MARKER = /^ {0,3}(`{3,}|~{3,})(.*?)(?:\r?\n)?$/
const PROCESS_OWNER = randomUUID()
const activeStages = new Set<string>()

interface FileRecord { path: string; bytes: number; hash: string }
interface Manifest { version: 1; source: string; generation: string; files: FileRecord[] }
interface Reservation { manifest: Manifest; stage: string; pid: number; owner: string }
interface Prepared { manifest: Manifest; contents: Map<string, Buffer> }

function fail(path: string, reason: string): never {
  throw new Error(`Markdown generation ${path}: ${reason}`)
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function hash(content: Buffer): string { return createHash('sha256').update(content).digest('hex') }
function serialized(value: Manifest | Reservation): string { return `${JSON.stringify(value)}\n` }

function withoutLiteralCode(raw: string): string {
  let fence: { character: string; length: number } | undefined
  const visible = raw.split(/(?<=\n)/).map((line) => {
    let text = line
    let container: RegExpExecArray | null
    while ((container = /^ {0,3}(?:>[\t ]?|(?:[-+*]|\d{1,9}[.)])[\t ]+)/.exec(text))) {
      text = text.slice(container[0].length)
    }
    const marker = FENCE_MARKER.exec(text)
    if (fence) {
      if (marker && marker[0].replace(FENCE_MARKER, '$1').charAt(0) === fence.character
        && marker[0].replace(FENCE_MARKER, '$1').length >= fence.length
        && !marker[0].replace(FENCE_MARKER, '$2').trim()) fence = undefined
      return line.replace(/[^\r\n]/g, ' ')
    }
    if (marker) {
      fence = { character: marker[0].replace(FENCE_MARKER, '$1').charAt(0), length: marker[0].replace(FENCE_MARKER, '$1').length }
      return line.replace(/[^\r\n]/g, ' ')
    }
    return /^(?: {4}| {0,3}\t)/.test(text) ? line.replace(/[^\r\n]/g, ' ') : line
  }).join('')
  const result = visible.split('')
  for (let at = 0; at < visible.length; at++) {
    if (visible[at] === '\\') { at++; continue }
    if (visible[at] !== '`') continue
    let end = at + 1
    while (visible[end] === '`') end++
    const length = end - at
    let cursor = end
    while (cursor < visible.length) {
      const next = visible.indexOf('`', cursor)
      if (next < 0 || /\n[\t \r]*\n/.test(visible.slice(end, next))) break
      let close = next + 1
      while (visible[close] === '`') close++
      if (close - next === length) {
        for (let index = at; index < close; index++) if (result[index] !== '\n' && result[index] !== '\r') result[index] = ' '
        end = close
        break
      }
      cursor = close
    }
    at = end - 1
  }
  return result.join('')
}

function inlineLinkEnd(text: string, opening: number): number | undefined {
  let at = opening + 1
  while (at < text.length && /[\t ]/.test(text.charAt(at))) at++
  if (text[at] === '<') {
    at++
    while (at < text.length && text[at] !== '>') {
      if (text[at] === '\\' && /[!-/:-@[-`{-~]/.test(text[at + 1] ?? '')) at += 2
      else at++
    }
    if (at === text.length) return undefined
    at++
  } else {
    let depth = 0
    while (at < text.length) {
      const character = text.charAt(at)
      if (character === '\\' && /[!-/:-@[-`{-~]/.test(text[at + 1] ?? '')) { at += 2; continue }
      if (/\s/.test(character) || (character === ')' && depth === 0)) break
      if (character === '(') depth++
      if (character === ')') depth--
      at++
    }
    if (depth !== 0) return undefined
  }
  if (text[at] === ')') return at + 1
  const suffix = /^[\t ]+(?:(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\((?:[^)\\\n]|\\.)*\))[\t ]*)?\)/.exec(text.slice(at))
  return suffix ? at + suffix[0].length : undefined
}

function* markdownGenerationClaims(raw: string): Generator<string> {
  const opening = /^---\r?\n/.exec(raw)
  if (opening) {
    const closing = /^---(?:\r?\n|$)/m.exec(raw.slice(opening[0].length))
    if (closing) raw = raw.slice(opening[0].length + closing.index + closing[0].length)
  }
  const visible = withoutLiteralCode(raw)
  const destination = /\]\(\s*<?(?:\.\/)?\.y-topics\/([^/\s)>#]*)(?=[/\s)>#]|$)/y
  let depth = 0
  for (let at = 0; at < visible.length; at++) {
    if (visible[at] === '\\') { at++; continue }
    if (visible[at] === '<') {
      const autolink = /^<(?:https?:\/\/[^\s<>]+|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/.exec(visible.slice(at))
      if (autolink) { at += autolink[0].length - 1; continue }
    }
    if (visible[at] === '\n' && /^\n[\t \r]*\n/.test(visible.slice(at))) depth = 0
    if (visible[at] === '[') { depth++; continue }
    if (visible[at] !== ']' || depth === 0) continue
    depth--
    destination.lastIndex = at
    const match = destination.exec(visible)
    if (match) yield match[0].slice(match[0].indexOf('.y-topics/') + '.y-topics/'.length)
    if (visible[at + 1] === '(') {
      const end = inlineLinkEnd(visible, at + 1)
      if (end !== undefined) at = end - 1
    }
  }
}

/**
 * Identify actual relative generation claims for inventory hints without validation or I/O.
 * Closed frontmatter, code, autolinks, link titles and escaped or unmatched brackets are ignored.
 * @param raw - complete Markdown entry text.
 * @returns whether an inline link claims the .y-topics namespace, including malformed identifiers.
 */
export function hasMarkdownGenerationLinks(raw: string): boolean {
  return !markdownGenerationClaims(raw).next().done
}

function validatePaths(paths: readonly string[]): void {
  const seen = new Set<string>()
  const directoryCases = new Map<string, string>()
  for (const path of paths) {
    const parts = path.split('/')
    if (!path || Buffer.byteLength(path) > MAX_PATH_BYTES || parts.length > MAX_DEPTH
      || parts.some(part => !part || part === '.' || part === '..' || /[\\\x00<>:"|?*]/.test(part)
        || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
      || parts[0]?.toLowerCase() === MANIFEST) fail(path, 'invalid relative child path')
    const folded = path.toLowerCase()
    if (seen.has(folded)) fail(path, 'duplicate child path')
    seen.add(folded)
    for (let depth = 1; depth < parts.length; depth++) {
      const directory = parts.slice(0, depth).join('/')
      const previous = directoryCases.get(directory.toLowerCase())
      if (previous !== undefined && previous !== directory) fail(path, 'directory paths differ only by case')
      directoryCases.set(directory.toLowerCase(), directory)
    }
  }
  for (const path of seen) {
    const parts = path.split('/')
    while (parts.length > 1) {
      parts.pop()
      if (seen.has(parts.join('/'))) fail(path, 'child file collides with a directory')
    }
  }
}

function prepare(source: string, generation: string, files: readonly { path: string; content: string }[]): Prepared {
  if (!HEX.test(generation)) fail(generation, 'generation must be a lowercase SHA256')
  if (files.length > MAX_FILES) fail(generation, 'at most 64 child files are allowed')
  validatePaths(files.map(file => file.path))
  const contents = new Map<string, Buffer>()
  const records = [...files].sort((left, right) => left.path < right.path ? -1 : 1).map((file) => {
    if (!markdownWithinLimit(file.content)) fail(file.path, 'complete Markdown exceeds the file limits')
    const bytes = Buffer.from(file.content, 'utf8')
    contents.set(file.path, bytes)
    return { path: file.path, bytes: bytes.length, hash: hash(bytes) }
  })
  return { manifest: { version: 1, source, generation, files: records }, contents }
}

function parseManifest(value: unknown, path: string): Manifest {
  if (!object(value) || value.version !== 1 || typeof value.source !== 'string'
    || !value.source || value.source === '.' || value.source === '..' || /[/\\\x00]/.test(value.source)
    || typeof value.generation !== 'string' || !HEX.test(value.generation)
    || !Array.isArray(value.files) || value.files.length > MAX_FILES) fail(path, 'invalid generation manifest')
  const files = value.files.map((file: unknown): FileRecord => {
    if (!object(file) || typeof file.path !== 'string' || typeof file.hash !== 'string' || !HEX.test(file.hash)
      || typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || file.bytes > MARKDOWN_BYTE_CAP) fail(path, 'invalid child manifest record')
    return { path: file.path, bytes: file.bytes, hash: file.hash }
  })
  validatePaths(files.map(file => file.path))
  let previousPath = ''
  for (const file of files) {
    if (previousPath > file.path) fail(path, 'generation manifest records are not in canonical path order')
    previousPath = file.path
  }
  return { version: 1, source: value.source, generation: value.generation, files }
}

function assertOwned(info: Stats, path: string, kind: 'file' | 'directory', privateMode = true): void {
  if (info.isSymbolicLink() || (kind === 'directory' ? !info.isDirectory() : !info.isFile())) {
    fail(path, `expected an owned ${kind}, refusing links and other file types`)
  }
  if (process.getuid && info.uid !== process.getuid()) fail(path, 'wrong file owner')
  if (privateMode && process.platform !== 'win32' && (info.mode & 0o077) !== 0) fail(path, 'permissions must be owner-only')
  if (kind === 'file' && privateMode && info.nlink !== 1) fail(path, 'refusing linked metadata or child files')
}

async function infoAt(path: string): Promise<Stats | undefined> {
  try { return await fs.lstat(path) } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined
    throw error
  }
}

async function assertSource(path: string, newEntry: boolean): Promise<void> {
  const info = await infoAt(path)
  if (newEntry) {
    if (info) fail(path, 'new source entry already exists')
  } else {
    if (!info) fail(path, 'source entry is missing')
    assertOwned(info, path, 'file', false)
  }
}

async function readOwned(path: string, limit: number): Promise<Buffer> {
  const before = await fs.lstat(path)
  assertOwned(before, path, 'file')
  if (before.size > limit) fail(path, 'stored file exceeds its byte limit')
  // An unavailable platform flag contributes zero bits; owner and inode checks still apply.
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    assertOwned(opened, path, 'file')
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > limit) fail(path, 'file changed during verification')
    // Allocate and read at most the bound plus one overflow byte, including concurrent growth.
    const bytes = Buffer.alloc(limit + 1)
    let length = 0
    while (length <= limit) {
      const read = await handle.read(bytes, length, bytes.length - length, null)
      if (read.bytesRead === 0) return bytes.subarray(0, length)
      length += read.bytesRead
    }
    fail(path, 'stored file exceeds its byte limit')
  } finally { await handle.close() }
}

async function readManifest(path: string): Promise<Manifest> {
  const raw = (await readOwned(path, MAX_MANIFEST_BYTES)).toString('utf8')
  const manifest = parseManifest(JSON.parse(raw), path)
  if (raw !== serialized(manifest)) fail(path, 'generation manifest was changed')
  return manifest
}

function directories(manifest: Manifest): Set<string> {
  const result = new Set<string>()
  for (const file of manifest.files) {
    const parts = file.path.split('/')
    while (parts.length > 1) { parts.pop(); result.add(parts.join('/')) }
  }
  return result
}

async function inspectTree(
  directory: string,
  manifest: Manifest,
  contents?: Map<string, Buffer>,
  allowPartial = false,
  verifiedFiles?: Map<string, Buffer>,
): Promise<string[]> {
  assertOwned(await fs.lstat(directory), directory, 'directory')
  const expectedDirs = directories(manifest)
  const expectedFiles = new Map(manifest.files.map(file => [file.path, file]))
  const found = new Set<string>()
  const removable: string[] = []
  const visit = async (relative: string): Promise<void> => {
    for await (const child of await fs.opendir(join(directory, relative))) {
      const name = child.name
      const path = relative ? `${relative}/${name}` : name
      const absolute = join(directory, path)
      const info = await fs.lstat(absolute)
      if (path === MANIFEST) {
        if (allowPartial) {
          const expected = Buffer.from(serialized(manifest))
          const bytes = await readOwned(absolute, expected.length)
          if (!bytes.equals(expected.subarray(0, bytes.length))) fail(absolute, 'manifest differs from expected children')
        } else if (serialized(await readManifest(absolute)) !== serialized(manifest)) fail(absolute, 'manifest differs from expected children')
      } else if (expectedDirs.has(path)) {
        assertOwned(info, absolute, 'directory')
        await visit(path)
      } else {
        const expected = expectedFiles.get(path)
        if (!expected) fail(absolute, 'unexpected generation resource')
        const bytes = await readOwned(absolute, expected.bytes)
        const expectedBytes = contents?.get(path)
        if (expectedBytes ? !bytes.equals(allowPartial ? expectedBytes.subarray(0, bytes.length) : expectedBytes)
          : bytes.length !== expected.bytes || hash(bytes) !== expected.hash) {
          fail(absolute, 'child bytes or hash differ from the manifest')
        }
        if (!allowPartial && (!Buffer.from(bytes.toString('utf8')).equals(bytes) || !markdownWithinLimit(bytes.toString('utf8')))) {
          fail(absolute, 'stored complete Markdown exceeds the file limits')
        }
        verifiedFiles?.set(path, bytes)
      }
      found.add(path)
      removable.push(absolute)
    }
  }
  await visit('')
  if (!allowPartial && (!found.has(MANIFEST) || manifest.files.some(file => !found.has(file.path)))) {
    fail(directory, 'partially published generation')
  }
  if (allowPartial && !found.has(MANIFEST) && found.size !== 0) fail(directory, 'stage has resources without its manifest')
  return removable
}

async function removeStage(root: string, reservation: Reservation, prepared: Prepared): Promise<void> {
  assertOwned(await fs.lstat(root), root, 'directory')
  const marker = join(root, reservationName(reservation))
  const assertReservation = async (): Promise<void> => {
    const expected = Buffer.from(serialized(reservation))
    const bytes = await readOwned(marker, expected.length)
    if (!bytes.equals(expected.subarray(0, bytes.length))) {
      fail(marker, 'staging reservation was changed')
    }
  }
  await assertReservation()
  const stage = join(root, reservation.stage)
  if (await infoAt(stage)) {
    const paths = await inspectTree(stage, prepared.manifest, prepared.contents, true)
    paths.sort((left, right) => Number(basename(left) === MANIFEST) - Number(basename(right) === MANIFEST))
    for (const path of paths) {
      const info = await fs.lstat(path)
      assertOwned(info, path, info.isDirectory() ? 'directory' : 'file')
      if (info.isDirectory()) await fs.rmdir(path)
      else await fs.unlink(path)
    }
    await fs.rmdir(stage)
  }
  await assertReservation()
  await fs.unlink(marker)
}

function reservationName(reservation: Reservation): string {
  return `${RESERVATION_PREFIX}${reservation.manifest.generation}.${reservation.pid}.${reservation.owner}.${reservation.stage.slice(7)}.json`
}

async function reservationNames(root: string): Promise<string[]> {
  const names: string[] = []
  for await (const child of await fs.opendir(root)) {
    if (!child.name.startsWith(RESERVATION_PREFIX)) continue
    if (names.length === MAX_GENERATIONS) fail(root, 'more than eight outstanding staging reservations')
    names.push(child.name)
  }
  return names
}

function stopped(reservation: Reservation): boolean {
  if (reservation.pid === process.pid && reservation.owner === PROCESS_OWNER) return !activeStages.has(reservation.stage)
  try { process.kill(reservation.pid, 0); return false } catch (error) {
    if (hasCode(error, 'ESRCH')) return true
    throw error
  }
}

async function recover(root: string, prepared: Prepared): Promise<void> {
  for (const name of await reservationNames(root)) {
    const marker = join(root, name)
    const match = RESERVATION_NAME.exec(name)
    if (!match || Number(match[2]) > 2147483647) fail(marker, 'invalid staging reservation name')
    if (match[1] !== prepared.manifest.generation) fail(marker, 'interrupted stage differs from the requested generation')
    const reservation: Reservation = { manifest: prepared.manifest, stage: `.stage-${match[4]}`, pid: Number(match[2]), owner: name.replace(RESERVATION_NAME, '$3') }
    // The never-reused name carries ownership even when interruption leaves zero metadata bytes.
    const expected = Buffer.from(serialized(reservation))
    const bytes = await readOwned(marker, expected.length)
    if (!bytes.equals(expected.subarray(0, bytes.length))) fail(marker, 'interrupted stage differs from the requested generation')
    if (!stopped(reservation)) fail(marker, 'another publisher still owns the stage')
    await removeStage(root, reservation, prepared)
  }
}

async function inspectStore(root: string, expected: Manifest, marker: string): Promise<boolean> {
  let retained = 0
  let present = false
  for await (const child of await fs.opendir(root)) {
    const name = child.name
    if (name === marker) continue
    if (!HEX.test(name)) fail(join(root, name), 'unexpected resource in the generation store')
    const directory = join(root, name)
    assertOwned(await fs.lstat(directory), directory, 'directory')
    const manifest = await readManifest(join(directory, MANIFEST))
    if (manifest.generation !== name) fail(directory, 'generation identity differs from its manifest')
    await inspectTree(directory, manifest)
    if (manifest.source === expected.source && ++retained > MAX_GENERATIONS) {
      fail(root, 'more than eight generations are retained for this source')
    }
    if (name === expected.generation) {
      if (serialized(manifest) !== serialized(expected)) fail(directory, 'existing generation differs from expected children')
      present = true
    }
  }
  if (!present && retained >= MAX_GENERATIONS) fail(root, 'eight generations are already retained for this source')
  return present
}

/**
 * Publish complete immutable children without creating or changing the root entry.
 * Eight generations per entry basename are retained; a ninth is refused, never pruned.
 * Paths allow at most 16 components and 1024 UTF-8 bytes. Retries verify all retained
 * resources and recover only unchanged owned stages for this exact plan. Publication
 * serializes cooperating callers; standard Node path APIs cannot exclude concurrent
 * changes by another process with access to the directory.
 * @param entryPath - regular source entry, or absent leaf with newEntry; its parent is resolved canonically.
 * @param generation - original source's lowercase SHA256 supplied and validated by the split planner.
 * @param files - at most 64 complete bounded Markdown files with relative paths.
 * @param options - newEntry requires an absent entry in a caller-owned new bundle; the caller commits or rolls back root creation.
 * @returns after atomic directory publication or byte-verified reuse; rejects edits and collisions.
 */
export async function ensureMarkdownGeneration(
  entryPath: string,
  generation: string,
  files: readonly { path: string; content: string }[],
  options: { newEntry?: boolean } = {},
): Promise<void> {
  const prepared = prepare(basename(entryPath), generation, files)
  const parent = await fs.realpath(dirname(entryPath))
  const source = join(parent, basename(entryPath))
  assertOwned(await fs.lstat(parent), parent, 'directory', false)
  await assertSource(source, options.newEntry === true)
  const root = join(parent, '.y-topics')
  try { await fs.mkdir(root, { mode: 0o700 }) } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error
  }
  const rootInfo = await fs.lstat(root)
  assertOwned(rootInfo, root, 'directory')
  await recover(root, prepared)
  const reservation: Reservation = { manifest: prepared.manifest, stage: `.stage-${randomUUID()}`, pid: process.pid, owner: PROCESS_OWNER }
  const marker = join(root, reservationName(reservation))
  activeStages.add(reservation.stage)
  let operationError: unknown
  let failed = false
  try {
    await fs.writeFile(marker, serialized(reservation), { flag: 'wx', mode: 0o600 })
    if ((await reservationNames(root)).some(name => name !== basename(marker))) fail(root, 'another publisher still owns a staging reservation')
    if (await inspectStore(root, prepared.manifest, basename(marker))) {
      await inspectTree(join(root, generation), prepared.manifest, prepared.contents)
      return
    }
    const stage = join(root, reservation.stage)
    await fs.mkdir(stage, { mode: 0o700 })
    await fs.writeFile(join(stage, MANIFEST), serialized(prepared.manifest), { flag: 'wx', mode: 0o600 })
    for (const relative of [...directories(prepared.manifest)].sort()) await fs.mkdir(join(stage, relative), { mode: 0o700 })
    for (const [path, bytes] of prepared.contents) {
      await fs.writeFile(join(stage, path), bytes, { flag: 'wx', mode: 0o600 })
    }
    await inspectTree(stage, prepared.manifest)
    const checkedRoot = await fs.lstat(root)
    assertOwned(checkedRoot, root, 'directory')
    if (checkedRoot.dev !== rootInfo.dev || checkedRoot.ino !== rootInfo.ino) fail(root, 'generation store changed during publication')
    await assertSource(source, options.newEntry === true)
    const destination = join(root, generation)
    if (await infoAt(destination)) fail(destination, 'publication destination already exists')
    await fs.rename(stage, destination)
  } catch (error) {
    operationError = error
    failed = true
    throw error
  } finally {
    try { if (await infoAt(marker)) await removeStage(root, reservation, prepared) } catch (cleanupError) {
      if (failed) throw new AggregateError([operationError, cleanupError], 'Markdown generation publication and owned-stage cleanup failed')
      throw cleanupError
    } finally { activeStages.delete(reservation.stage) }
  }
}

/**
 * Recover exact source text for a selected generated entry without loading its graph.
 * Every linked generation is confined, owned and fully verified, with at most eight
 * candidates. Exactly one stored entry.txt must equal raw; its contiguous source
 * fragments must reconstruct the planner's original SHA256. Replanning that source
 * must reproduce the root and every stored file exactly. No files are changed.
 * @param entryPath - selected existing regular entry; the parent is resolved canonically.
 * @param raw - complete selected entry text, including frontmatter and terminal newline.
 * @returns exact original source, or undefined when raw contains no generated links; rejects missing, edited or ambiguous resources.
 */
export async function readMarkdownSource(entryPath: string, raw: string): Promise<string | undefined> {
  const candidates = new Set<string>()
  for (const generation of markdownGenerationClaims(raw)) {
    if (!HEX.test(generation)) fail(entryPath, 'generated link has an invalid SHA256; restore or split the entry again')
    candidates.add(generation)
    if (candidates.size > MAX_GENERATIONS) fail(entryPath, 'generated links exceed the eight-generation read limit')
  }
  if (candidates.size === 0) return undefined
  if (Buffer.byteLength(raw, 'utf8') > MARKDOWN_BYTE_CAP || !markdownWithinLimit(raw)) {
    fail(entryPath, 'generated entry exceeds the file limits; restore or split the entry again')
  }
  const selectedBytes = Buffer.from(raw, 'utf8')
  const parent = await fs.realpath(dirname(entryPath))
  const source = join(parent, basename(entryPath))
  assertOwned(await fs.lstat(parent), parent, 'directory', false)
  await assertSource(source, false)
  const root = join(parent, '.y-topics')
  const rootInfo = await infoAt(root)
  if (!rootInfo) fail(root, 'generated resources are missing; restore or split the entry again')
  assertOwned(rootInfo, root, 'directory')
  let original: string | undefined
  let selected: { generation: string; verified: Map<string, Buffer> } | undefined
  for (const generation of candidates) {
    const directory = join(root, generation)
    const info = await infoAt(directory)
    if (!info) fail(directory, 'linked generation is missing; restore or split the entry again')
    assertOwned(info, directory, 'directory')
    const manifest = await readManifest(join(directory, MANIFEST))
    if (manifest.generation !== generation || manifest.source !== basename(entryPath)) {
      fail(directory, 'linked generation belongs to a different entry or identity')
    }
    const verified = new Map<string, Buffer>()
    await inspectTree(directory, manifest, undefined, false, verified)
    const entry = verified.get('entry.txt')
    if (!entry) fail(directory, 'exact generated entry.txt is missing; restore or split the entry again')
    const fragments = manifest.files.filter(file => file.path.startsWith('source/'))
    if (fragments.length === 0 || fragments.some((file, index) => file.path !== `source/${String(index).padStart(4, '0')}.txt`)) {
      fail(directory, 'original source fragments must be contiguous source/0000.txt files')
    }
    const sourceBytes = fragments.reduce((total, file) => total + file.bytes, 0)
    const bytes = Buffer.concat([...verified].filter(([path]) => path.startsWith('source/'))
      .sort(([left], [right]) => left.localeCompare(right)).map(([, content]) => content), sourceBytes)
    if (hash(bytes) !== generation) fail(directory, 'original source SHA256 differs from its generation; restore the unchanged fragments')
    if (entry.equals(selectedBytes)) {
      if (original !== undefined) fail(entryPath, 'generated entry matches multiple source generations')
      original = bytes.toString('utf8')
      selected = { generation, verified }
    }
  }
  if (original === undefined || selected === undefined) fail(entryPath, 'generated entry differs from stored entry.txt; restore or split the changed entry again')
  const planned = planMarkdownSplit(original, basename(entryPath))
  if (planned.kind !== 'split' || planned.generation !== selected.generation || planned.after !== raw) {
    fail(entryPath, 'generated entry differs from the deterministic source split; restore or split the original again')
  }
  if (planned.files.length !== selected.verified.size || planned.files.some(file => !selected.verified.get(file.path)?.equals(Buffer.from(file.content, 'utf8')))) {
    fail(join(root, selected.generation), 'generated resources differ from the deterministic source split; restore the unchanged generation')
  }
  const checkedRoot = await fs.lstat(root)
  assertOwned(checkedRoot, root, 'directory')
  if (checkedRoot.dev !== rootInfo.dev || checkedRoot.ino !== rootInfo.ino) fail(root, 'generation store changed during source verification')
  return original
}
