/** Complete managed bundles are staged outside discovery and published by one directory rename. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import fs from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { ensureMarkdownGeneration, readMarkdownSource } from './markdown-generation.ts'
import { MARKDOWN_BYTE_CAP, markdownWithinLimit } from './markdown-size.ts'

const METADATA = '.creation.json'
const PUBLISHER_NAME = /^\.publisher-([1-9][0-9]{0,9})-([0-9a-f-]{36})-([0-9a-f-]{36})\.json$/
const HEX = /^[0-9a-f]{64}$/
const MAX_STAGES = 8
const MAX_PUBLISHERS = 8
const MAX_METADATA_BYTES = 128 * 1024
const PROCESS_OWNER = randomUUID()
const activeStores = new Set<string>()

interface Generation { id: string; files: readonly { path: string; content: string }[] }
interface Publisher { version: 1; pid: number; owner: string }
interface Reservation { path: string; bytes: Buffer }

function fail(path: string, reason: string): never { throw new Error(`Markdown creation ${path}: ${reason}`) }
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function serialize(value: object): string { return `${JSON.stringify(value)}\n` }
function owned(info: Stats, path: string, kind: 'file' | 'directory', privateMode = true): void {
  if (info.isSymbolicLink() || (kind === 'file' ? !info.isFile() : !info.isDirectory())) {
    fail(path, `expected an owned ${kind}, refusing links and other file types`)
  }
  if (process.getuid && info.uid !== process.getuid()) fail(path, 'wrong file owner')
  if (privateMode && process.platform !== 'win32' && (info.mode & 0o077) !== 0) fail(path, 'permissions must be owner-only')
  if (kind === 'file' && info.nlink !== 1) fail(path, 'refusing linked files')
}
async function infoAt(path: string): Promise<Stats | undefined> {
  try { return await fs.lstat(path) } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined
    throw error
  }
}
async function readOwned(path: string, limit: number): Promise<Buffer> {
  const before = await fs.lstat(path)
  owned(before, path, 'file')
  if (before.size > limit) fail(path, 'stored file exceeds its byte limit')
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    owned(opened, path, 'file')
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > limit) fail(path, 'file changed during verification')
    const bytes = Buffer.alloc(limit + 1)
    let size = 0
    while (size < bytes.length) {
      const read = await handle.read({ buffer: bytes, offset: size, length: bytes.length - size, position: size })
      if (read.bytesRead === 0) break
      size += read.bytesRead
    }
    if (size > limit) fail(path, 'stored file exceeds its byte limit')
    return bytes.subarray(0, size)
  } finally { await handle.close() }
}
async function exact(path: string, expected: Buffer): Promise<void> {
  if (!(await readOwned(path, expected.length)).equals(expected)) fail(path, 'stored bytes differ from the creation plan')
}
async function privateDirectory(path: string): Promise<Stats> {
  try { await fs.mkdir(path, { mode: 0o700 }) } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error
  }
  const info = await fs.lstat(path)
  owned(info, path, 'directory')
  return info
}
async function unchangedDirectory(path: string, previous: Stats, privateMode = false): Promise<void> {
  const info = await fs.lstat(path)
  owned(info, path, 'directory', privateMode)
  if (info.dev !== previous.dev || info.ino !== previous.ino) fail(path, 'parent directory changed during publication')
}
function stopped(publisher: Publisher): boolean {
  if (publisher.pid === process.pid && publisher.owner === PROCESS_OWNER) return true
  try { process.kill(publisher.pid, 0); return false } catch (error) {
    if (hasCode(error, 'ESRCH')) return true
    throw error
  }
}
async function removeReservation(reservation: Reservation, partial = false): Promise<void> {
  const bytes = await readOwned(reservation.path, reservation.bytes.length)
  if (!bytes.equals(partial ? reservation.bytes.subarray(0, bytes.length) : reservation.bytes)) {
    fail(reservation.path, 'publisher reservation was changed')
  }
  await fs.unlink(reservation.path)
}
async function storeNames(store: string, ownPublisher: string): Promise<string[]> {
  const names: string[] = []
  let stages = 0
  let publishers = 0
  for await (const child of await fs.opendir(store)) {
    const name = child.name
    if (HEX.test(name)) {
      if (++stages > MAX_STAGES) fail(store, 'eight creation stages are already retained')
    } else if (join(store, name) !== ownPublisher) {
      if (!PUBLISHER_NAME.test(name)) fail(join(store, name), 'unexpected resource in the creation store')
      if (++publishers > MAX_PUBLISHERS) fail(store, 'more than eight outstanding publisher reservations')
    }
    names.push(name)
  }
  return names
}
async function inventory(directory: string, allowed: ReadonlySet<string>, reason: string): Promise<Set<string>> {
  const names = new Set<string>()
  let count = 0
  for await (const child of await fs.opendir(directory)) {
    if (++count > allowed.size || !allowed.has(child.name)) fail(join(directory, child.name), reason)
    names.add(child.name)
  }
  return names
}
async function acquire(store: string): Promise<Reservation> {
  if (activeStores.has(store)) fail(store, 'another publisher still owns the creation store')
  activeStores.add(store)
  const publisher: Publisher = { version: 1, pid: process.pid, owner: PROCESS_OWNER }
  const reservation = {
    path: join(store, `.publisher-${process.pid}-${PROCESS_OWNER}-${randomUUID()}.json`),
    bytes: Buffer.from(serialize(publisher)),
  }
  let created = false
  try {
    const handle = await fs.open(reservation.path, 'wx', 0o600)
    created = true
    try { await handle.writeFile(reservation.bytes) } finally { await handle.close() }
    // Reservation paths are never reused, so reclaiming a stopped publisher cannot unlink a successor.
    for (const name of await storeNames(store, reservation.path)) {
      const path = join(store, name)
      if (path === reservation.path || HEX.test(name)) continue
      const pid = Number(name.replace(PUBLISHER_NAME, '$1'))
      if (pid > 2147483647) fail(path, 'invalid publisher reservation')
      const previous: Publisher = { version: 1, pid, owner: name.replace(PUBLISHER_NAME, '$2') }
      const expected = Buffer.from(serialize(previous))
      const bytes = await readOwned(path, expected.length)
      if (!bytes.equals(expected.subarray(0, bytes.length))) fail(path, 'publisher reservation was changed')
      if (!stopped(previous)) fail(path, 'another publisher still owns the creation store')
      await removeReservation({ path, bytes: expected }, true)
    }
    return reservation
  } catch (error) {
    try {
      if (created) await removeReservation(reservation, true)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Markdown publisher acquisition and cleanup failed')
    } finally { activeStores.delete(store) }
    throw error
  }
}
function childRecords(generation: Generation) {
  return generation.files.map((file) => {
    const bytes = Buffer.from(file.content)
    return { path: file.path, bytes: bytes.length, hash: hash(bytes) }
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}
function bundleFiles(entryName: string, raw: Buffer, generation: Generation | undefined): Map<string, Buffer> {
  const files = new Map([[entryName, raw]])
  if (generation) {
    const prefix = `.y-topics/${generation.id}`
    files.set(`${prefix}/.manifest.json`, Buffer.from(serialize({
      version: 1, source: entryName, generation: generation.id, files: childRecords(generation),
    })))
    for (const file of generation.files) files.set(`${prefix}/${file.path}`, Buffer.from(file.content))
  }
  return files
}
interface BundleDirectory {
  names: Set<string>
  directories: Map<string, BundleDirectory>
  files: Map<string, Buffer>
}
function bundleDirectory(): BundleDirectory {
  return { names: new Set(), directories: new Map(), files: new Map() }
}
async function inspectBundle(bundle: string, entryName: string, files: Map<string, Buffer>, partialRoot: boolean): Promise<void> {
  owned(await fs.lstat(bundle), bundle, 'directory')
  const root = bundleDirectory()
  for (const [path, content] of files) {
    const parts = path.split('/')
    let directory = root
    for (const [depth, name] of parts.entries()) {
      directory.names.add(name)
      if (depth === parts.length - 1) {
        directory.files.set(name, content)
      } else {
        let child = directory.directories.get(name)
        if (!child) {
          child = bundleDirectory()
          directory.directories.set(name, child)
        }
        directory = child
      }
    }
  }
  const found = new Set<string>()
  const visit = async (relative: string, directory: BundleDirectory): Promise<void> => {
    const names = await inventory(join(bundle, relative), directory.names, 'unexpected staged resource')
    for (const [name, child] of directory.directories) {
      if (!names.has(name)) continue
      const path = relative ? `${relative}/${name}` : name
      const absolute = join(bundle, path)
      owned(await fs.lstat(absolute), absolute, 'directory')
      await visit(path, child)
    }
    for (const [name, expected] of directory.files) {
      if (!names.has(name)) continue
      const path = relative ? `${relative}/${name}` : name
      const absolute = join(bundle, path)
      const bytes = await readOwned(absolute, expected.length)
      if (!bytes.equals(partialRoot && path === entryName ? expected.subarray(0, bytes.length) : expected)) {
        fail(absolute, 'stored bytes differ from the creation plan')
      }
      found.add(path)
    }
  }
  await visit('', root)
  for (const path of files.keys()) {
    if (!found.has(path) && !(partialRoot && path === entryName)) fail(bundle, 'staged bundle is incomplete')
  }
}

async function inspectStage(stage: string, metadata: Buffer, bundlePresent: boolean): Promise<void> {
  owned(await fs.lstat(stage), stage, 'directory')
  await exact(join(stage, METADATA), metadata)
  const names = await inventory(stage, new Set([METADATA, 'bundle']), 'unexpected or missing creation stage resource')
  if (bundlePresent && !names.has('bundle')) {
    fail(stage, 'unexpected or missing creation stage resource')
  }
  if (names.has('bundle')) owned(await fs.lstat(join(stage, 'bundle')), join(stage, 'bundle'), 'directory')
}
async function prepareStage(stage: string, metadata: Buffer): Promise<void> {
  await privateDirectory(stage)
  const names = await inventory(stage, new Set([METADATA, 'bundle']), 'unexpected creation stage resource')
  const path = join(stage, METADATA)
  if (!names.has(METADATA)) {
    if (names.size !== 0) fail(stage, 'stage has resources without its creation metadata')
  } else {
    const bytes = await readOwned(path, metadata.length)
    if (bytes.equals(metadata)) return
    if (!bytes.equals(metadata.subarray(0, bytes.length)) || names.size !== 1) {
      fail(path, 'stored bytes differ from the creation plan')
    }
    await fs.unlink(path)
  }
  await fs.writeFile(path, metadata, { flag: 'wx', mode: 0o600 })
}

/**
 * Publish an absent managed bundle only after its capped root and immutable children are complete.
 * Exact interrupted plans reuse a private stage beside the discovery root; edits, foreign resources,
 * links and existing destinations are refused. Namespace scans refuse more than eight stages or eight
 * other publisher reservations; bundle inventories are limited to the planned files and directories. The caller
 * owns project/name authorization and its pending-creation journal. Cooperating callers serialize;
 * standard Node path APIs cannot exclude hostile concurrent changes by another process with the same uid.
 * @param entryPath - authorized absent entry under an existing managed discovery directory.
 * @param raw - complete capped root Markdown, including any terminal newline.
 * @param generation - optional exact immutable child plan produced by the Markdown splitter.
 * @param beforePublish - writes the caller's journal after staging; failure retains the verified stage.
 * @returns after complete directory publication and owned metadata cleanup; pre-commit failures never create the destination.
 */
export async function publishMarkdownCreation(
  entryPath: string,
  raw: string,
  generation: Generation | undefined,
  beforePublish: () => Promise<void>,
): Promise<void> {
  if (!markdownWithinLimit(raw)) fail(entryPath, 'complete root Markdown exceeds the file limits')
  if (generation && (!HEX.test(generation.id) || generation.files.length > 64)) fail(entryPath, 'invalid bounded generation plan')
  const discoveryPath = dirname(dirname(entryPath))
  const discovery = await fs.realpath(discoveryPath)
  const discoveryInfo = await fs.lstat(discoveryPath)
  owned(discoveryInfo, discoveryPath, 'directory', false)
  const parent = dirname(discovery)
  owned(await fs.lstat(dirname(discoveryPath)), dirname(discoveryPath), 'directory', false)
  const destination = join(discovery, basename(dirname(entryPath)))
  const source = join(destination, basename(entryPath))
  if (await infoAt(destination)) fail(destination, 'publication destination already exists')
  const bytes = Buffer.from(raw)
  const id = createHash('sha256').update(source).update('\0').update(bytes).digest('hex')
  const metadata = Buffer.from(serialize({
    version: 1, destination: source, raw: { bytes: bytes.length, hash: hash(bytes) },
    generation: generation ? { id: generation.id, files: childRecords(generation) } : null,
  }))
  if (metadata.length > MAX_METADATA_BYTES) fail(entryPath, 'creation metadata exceeds its byte limit')
  const store = join(parent, '.y-markdown-create')
  const storeInfo = await privateDirectory(store)
  const reservation = await acquire(store)
  let failure: unknown
  let failed = false
  try {
    const names = await storeNames(store, reservation.path)
    for (const name of names) {
      if (PUBLISHER_NAME.test(name)) continue
      owned(await fs.lstat(join(store, name)), join(store, name), 'directory')
    }
    const retained = names.filter(name => !PUBLISHER_NAME.test(name))
    if (!retained.includes(id) && retained.length >= MAX_STAGES) {
      fail(store, 'eight creation stages are already retained')
    }
    const stage = join(store, id)
    await prepareStage(stage, metadata)
    await inspectStage(stage, metadata, false)
    const bundle = join(stage, 'bundle')
    await privateDirectory(bundle)
    const stagedEntry = join(bundle, basename(entryPath))
    const expected = bundleFiles(basename(entryPath), bytes, generation)
    const rootInfo = await infoAt(stagedEntry)
    if (rootInfo) {
      await inspectBundle(bundle, basename(entryPath), expected, true)
      const existing = await readOwned(stagedEntry, MARKDOWN_BYTE_CAP)
      if (existing.length < bytes.length) await fs.unlink(stagedEntry)
    } else {
      await inventory(bundle, new Set(generation ? ['.y-topics'] : []), 'unexpected staged resource')
    }
    if (!await infoAt(stagedEntry)) {
      if (generation) await ensureMarkdownGeneration(stagedEntry, generation.id, generation.files, { newEntry: true })
      await inspectBundle(bundle, basename(entryPath), expected, true)
      await fs.writeFile(stagedEntry, bytes, { flag: 'wx', mode: 0o600 })
    }
    await inspectBundle(bundle, basename(entryPath), expected, false)
    await readMarkdownSource(stagedEntry, raw)
    await beforePublish()
    await inspectStage(stage, metadata, true)
    await inspectBundle(bundle, basename(entryPath), expected, false)
    if (await fs.realpath(discoveryPath) !== discovery) fail(discoveryPath, 'canonical publication parent changed')
    await unchangedDirectory(discoveryPath, discoveryInfo)
    await unchangedDirectory(store, storeInfo, true)
    await exact(reservation.path, reservation.bytes)
    if (await infoAt(destination)) fail(destination, 'publication destination already exists')
    await fs.rename(bundle, destination)
    await inspectStage(stage, metadata, false)
    await inventory(stage, new Set([METADATA]), 'unexpected resource after publication')
    await exact(join(stage, METADATA), metadata)
    await fs.unlink(join(stage, METADATA))
    await fs.rmdir(stage)
  } catch (error) {
    failure = error
    failed = true
    throw error
  } finally {
    try {
      await removeReservation(reservation)
    } catch (cleanupError) {
      if (failed) throw new AggregateError([failure, cleanupError], 'Markdown creation and publisher cleanup failed')
      throw cleanupError
    } finally { activeStores.delete(store) }
  }
}
