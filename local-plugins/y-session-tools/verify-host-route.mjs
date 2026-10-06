/**
 * Standalone check of the Host route in `index.js`, runnable without a
 * Harness: a fake Cordis context drives the registered fetch handler against a
 * real temporary session tree.
 *
 *   node local-plugins/y-session-tools/verify-host-route.mjs
 *
 * When the checkout has been built, the reference mention is also compared
 * with the shipped `formatSessionReferenceMention`.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from './index.js'

const referenceLib = fileURLToPath(new URL('../../packages/context/session-reference/lib/index.js', import.meta.url))
const canonicalMention = existsSync(referenceLib)
  ? (await import(referenceLib)).formatSessionReferenceMention
  : undefined

const root = await mkdtemp(join(tmpdir(), 'yst-verify-'))
const project = join(root, 'sessions', '--tmp-fake-project--')
const liveId = 'session-live-1'
const deadId = 'session-dead-2'
const missingId = 'session-missing-3'
await mkdir(join(project, deadId), { recursive: true })
await writeFile(join(project, deadId, 'session.v4.jsonl.zstd'), 'payload')
await mkdir(join(project, liveId), { recursive: true })

let route
const calls = []
const live = new Map([[liveId, {}]])
const stored = new Set([liveId, deadId])
const ctx = {
  connection: { fetch: { register: (registered) => { route = registered; return Promise.resolve(() => {}) } } },
  workspaceRegistry: {
    archiveSession: async (id, options) => { calls.push(`archive:${id}:${String(options?.stopActivity)}`) },
    unarchiveSession: async (id) => { calls.push(`unarchive:${id}`) },
  },
  sessionPersistence: { stat: async (id) => (stored.has(id) ? { header: { id } } : undefined) },
  get(name) {
    if (name === 'sessions') return { get: (id) => live.get(id) }
    if (name === 'dshHomePath') return (...segments) => join(root, ...segments)
    return undefined
  },
}
apply(ctx)
assert.equal(route.path, '/api/y-session-tools.session')
assert.deepEqual(route.methods, ['GET', 'POST'])
assert.equal(route.requestBody, 'buffered')

const base = `http://127.0.0.1:1${route.path}`
const get = (query) => route.fetch(new Request(`${base}?${query}`))
const post = (body) => route.fetch(new Request(base, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}))

// Stored directory and canonical mention.
const info = await get(`sessionId=${deadId}&label=${encodeURIComponent('My “title”')}`)
assert.equal(info.status, 200)
const infoBody = await info.json()
assert.equal(infoBody.path, join(project, deadId))
if (canonicalMention !== undefined) {
  assert.equal(infoBody.mention, canonicalMention({ sessionId: deadId, label: 'My “title”' }))
}
console.log(`mention: ${infoBody.mention}`)

// Unknown Session, and ids that could escape the sessions root.
assert.equal((await get(`sessionId=${missingId}`)).status, 404)
for (const bad of ['..', '.', 'a/b', 'a~002Fb', '']) {
  assert.equal((await get(`sessionId=${encodeURIComponent(bad)}`)).status, 400, `expected 400 for ${JSON.stringify(bad)}`)
}

// A live Session is refused and nothing is touched.
const liveResponse = await post({ sessionId: liveId })
assert.equal(liveResponse.status, 409)
assert.equal((await liveResponse.json()).code, 'session/live')
assert.deepEqual(calls, [])
await stat(join(project, liveId))

// Deleting hides the Session, removes it, and restores the archive set.
const deleted = await post({ sessionId: deadId })
assert.equal(deleted.status, 200)
assert.equal((await deleted.json()).path, join(project, deadId))
assert.deepEqual(calls, [`archive:${deadId}:true`, `unarchive:${deadId}`])
await assert.rejects(stat(join(project, deadId)), 'session directory should be gone')

// Unknown Session and malformed bodies.
assert.equal((await post({ sessionId: missingId })).status, 404)
assert.equal((await post({})).status, 400)
assert.equal((await route.fetch(new Request(base, { method: 'POST', body: 'not json' }))).status, 400)

await rm(root, { recursive: true, force: true })
console.log('all host-route checks passed')
