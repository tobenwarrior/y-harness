/**
 * Host half of the y-session-tools bundle.
 *
 * One authenticated route on the shared API channel, addressed
 * document-relative by the browser half:
 *
 * - `GET  ?sessionId=&label=` reports the Session's stored artifact directory
 *   and its canonical `@[label](dsh-session:…)` reference mention.
 * - `POST {sessionId}` permanently deletes a non-live Session's stored
 *   artifacts, after hiding it from every browsing surface and publishing its
 *   removal from the Session list.
 *
 * The route exists because no shipped Host entry point deletes a Session:
 * `workspaceRegistry` owns archive/pin, and `sessionPersistence` is
 * append-only. Deletion therefore resolves the artifact directory itself,
 * removes it, and then publishes the Session's removal.
 */
import { readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'y-session-tools'

/**
 * Services the route needs. `sessions` and `dshHomePath` are read through
 * `ctx.get` instead, so a composition without them still mounts the route.
 */
export const inject = ['connection', 'workspaceRegistry', 'sessionPersistence']

/** Absolute path below `/api`; the browser addresses it as `api/…`. */
const ROUTE = '/api/y-session-tools.session'

/**
 * Session ids reach the filesystem as one path segment, so only the characters
 * the persistence backend leaves unescaped are accepted here. `.` and `..` are
 * refused on top of the character check: they are legal characters but not
 * legal path segments. Anything else is refused rather than encoded, because a
 * caller that needs an escaped id is a bug.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/

/**
 * Whether a request value can address one stored Session.
 * @param value - candidate session id.
 * @returns whether it is a usable id.
 */
function isSessionId(value) {
  return SESSION_ID_PATTERN.test(value) && value !== '.' && value !== '..'
}

/**
 * Register the Session route on the shared API channel.
 * @param ctx - Host context carrying the connection and Workspace registry.
 */
export function apply(ctx) {
  ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: request => handle(ctx, request),
  })
}

/**
 * Dispatch one route request.
 * @param ctx - Host context carrying the Workspace registry.
 * @param request - authenticated request on the shared API channel.
 * @returns the JSON response.
 */
async function handle(ctx, request) {
  if (request.method === 'POST') return deleteRequest(ctx, request)
  return infoRequest(ctx, request)
}

/**
 * Report one Session's artifact directory and reference mention.
 * @param ctx - Host context carrying the persistence service.
 * @param request - `GET` request carrying `sessionId` and an optional `label`.
 * @returns `{ sessionId, path, mention }`, or a failure with a stable code.
 */
async function infoRequest(ctx, request) {
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId') ?? ''
  if (!isSessionId(sessionId)) return failure(400, 'session/invalid-id', 'invalid session id')
  const snapshot = await ctx.sessionPersistence.stat(sessionId)
  if (snapshot === undefined) return failure(404, 'session/not-found', `session '${sessionId}' is not stored`)
  const label = url.searchParams.get('label') || sessionId
  const directory = await findSessionDirectory(sessionsRoot(ctx), sessionId)
  return json(200, { sessionId, path: directory ?? null, mention: sessionMention(sessionId, label) })
}

/**
 * Permanently delete one Session's stored artifacts.
 * @param ctx - Host context carrying the Workspace registry and persistence.
 * @param request - `POST` request whose JSON body carries `sessionId`.
 * @returns `{ sessionId, path }` on success, or a failure with a stable code.
 */
async function deleteRequest(ctx, request) {
  const body = await readJson(request)
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
  if (!isSessionId(sessionId)) return failure(400, 'session/invalid-id', 'invalid session id')
  // A live Session owns its log and its in-memory state: removing the file
  // under it would leave a running agent writing to a deleted directory.
  if (ctx.get('sessions')?.get(sessionId) !== undefined) {
    return failure(409, 'session/live', `session '${sessionId}' is live; stop it before deleting it`)
  }
  const snapshot = await ctx.sessionPersistence.stat(sessionId)
  if (snapshot === undefined) return failure(404, 'session/not-found', `session '${sessionId}' is not stored`)

  const directory = await findSessionDirectory(sessionsRoot(ctx), sessionId)
  // Hide it from every browsing surface first: the archive set is what the
  // sidebar's follow stream publishes, and removing the artifacts alone
  // notifies nothing. The set returns to its prior state below.
  await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
  try {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  } finally {
    await ctx.workspaceRegistry.unarchiveSession(sessionId)
  }
  // Workspace membership is durable and does not follow the artifacts, so the
  // row a deleted Session leaves behind survives the archive-set restore above.
  // Publish the removal exactly as a disposed Session does, which is what
  // drops the Session from the browser's list.
  ctx.emit('api-session/removed', sessionId)
  return json(200, { sessionId, path: directory ?? null })
}

/**
 * Read a buffered JSON request body.
 * @param request - request whose body carries the JSON document.
 * @returns the parsed value, or `undefined` when the body is absent or malformed.
 */
async function readJson(request) {
  try {
    const parsed = await request.json()
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the directory every Session artifact lives in.
 * @param ctx - Host context, whose launcher publishes the Harness home.
 * @returns the absolute sessions root.
 */
function sessionsRoot(ctx) {
  const homePath = ctx.get('dshHomePath')
  if (typeof homePath === 'function') return homePath('sessions')
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
}

/**
 * Find one Session's directory beneath the sessions root.
 *
 * The backend groups `<root>/<project>/<session>` and escapes unsafe path code
 * units as `~XXXX`. Reading the two directory levels keeps this bundle out of
 * the backend's private path helpers; only the escape codec is mirrored, and
 * a directory whose decoded name matches is that Session's own directory.
 * @param root - absolute sessions root.
 * @param sessionId - Session whose directory is wanted.
 * @returns the absolute directory, or `undefined` when nothing is materialized.
 */
async function findSessionDirectory(root, sessionId) {
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectPath = join(root, project.name)
    let entries
    try {
      entries = await readdir(projectPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() && decodeSegment(entry.name) === sessionId) return join(projectPath, entry.name)
    }
  }
  return undefined
}

/**
 * Decode one persistence path segment back to its raw value.
 * @param segment - directory name from the sessions root.
 * @returns the decoded name.
 */
function decodeSegment(segment) {
  return segment.replace(/~([0-9A-Fa-f]{4})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
}

/**
 * Render the canonical session-reference mention for one Session.
 * @param sessionId - Session the mention addresses.
 * @param label - display label shown in the composer.
 * @returns `@[label](dsh-session:<base64url>)`.
 */
function sessionMention(sessionId, label) {
  const payload = Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')
  return `@[${label.replace(/[\\\]]/g, match => `\\${match}`)}](dsh-session:${payload})`
}

/**
 * Build one JSON response.
 * @param status - HTTP status.
 * @param value - JSON-serializable body.
 * @returns the response.
 */
function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Build one failure response carrying a stable code the browser half localizes.
 * @param status - HTTP status.
 * @param code - stable failure code.
 * @param message - untranslated diagnostic.
 * @returns the response.
 */
function failure(status, code, message) {
  return json(status, { code, message })
}
