/** Tests for the isolated browser's fixed Computer protocol. */

import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBrowserPage } from './page.mjs'
import { browserServers, parseGrants } from './service.mjs'

const BOT = 'bot-example'
const SESSION = 'bot-session-a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1'
const otherSession = 'bot-session-b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2'
const sharedSession = 'shared-session-c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3'
const anotherSharedSession = 'shared-session-d4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4'
const request = { bot: BOT, session: SESSION }
const BOT2 = 'bot-second'
const SESSION2 = 'bot-session-b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2'
const REVISION = '1'.repeat(32)
const REVISION2 = '2'.repeat(32)

const controlResponse = (socketPath, data) => new Promise((resolve, reject) => {
  const socket = connect(socketPath)
  let reply = ''
  socket.setEncoding('utf8')
  socket.on('data', part => { reply += part })
  socket.once('connect', () => socket.end(JSON.stringify(data)))
  socket.once('error', reject)
  socket.once('end', () => {
    try { resolve(JSON.parse(reply)) } catch (error) { reject(error) }
  })
})

async function approvalStatus(control, chat, id) {
  let status
  for (let attempt = 0; attempt < 50; attempt++) {
    status = await controlResponse(control, { ...chat, action: 'login-status', id })
    if (status.state !== 'pending') return status
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return status
}

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'yh-isolated-browser-'))
  const control = join(root, 'control.sock')
  const vault = join(root, 'vault.sock')
  let sharingFile = options.sharingFile ?? join(root, 'shared-grants.json')
  if (options.policy !== undefined) {
    await writeFile(sharingFile, JSON.stringify(options.policy))
    await chmod(sharingFile, 0o640)
    options = { ...options, sharingFile }
  }
  const servers = browserServers({
    grants: parseGrants([request]), root, executable: '/usr/bin/chromium',
    createPage: async () => { throw new Error('The status check must be lazy.') },
    ...options,
  })
  t.after(async () => {
    try { await servers.close() } finally { await rm(root, { recursive: true, force: true }) }
  })
  await Promise.all([[servers.control, control], [servers.vault, vault]].map(([server, path]) => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, resolve)
  })))
  return { control, vault, root, sharingFile, servers }
}

test('checks the exact Bot and Session without launching a browser', async t => {
  const { control } = await setup(t)
  assert.deepEqual(await controlResponse(control, { ...request, action: 'status' }), { available: true })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'status', capability: 'restart' }), {
    available: true,
  })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'status', capability: 'other' }), {
    error: 'unavailable',
  })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'status', session: otherSession }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'status', bot: 'bot-other' }), { error: 'unavailable' })
  assert.throws(() => parseGrants([request, { bot: 'bot-duplicate', session: SESSION }]))
})

test('restarts only the exact private owner browser and preserves the profile', async t => {
  const profiles = []
  const closeCalls = []
  const { control } = await setup(t, {
    createPage: async (_executable, profile) => {
      profiles.push(profile)
      return {
        frame: async () => '/9j/2Q==',
        close: async () => { closeCalls.push(profile) },
        closed: new Promise(() => {}),
      }
    },
  })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'restart' }), { status: 'restarted' })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'status' }), { available: true })
  assert.deepEqual(await controlResponse(control, { bot: BOT, session: sharedSession, action: 'restart' }), {
    error: 'unavailable',
  })
  assert.deepEqual(await controlResponse(control, {
    bot: BOT, session: 'shared-session-group-c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3', action: 'restart',
  }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(control, { bot: BOT, session: otherSession, action: 'restart' }), {
    error: 'unavailable',
  })
  await controlResponse(control, { ...request, action: 'frame' })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'restart' }), { status: 'restarted' })
  await controlResponse(control, { ...request, action: 'frame' })
  assert.equal(profiles.length, 2)
  assert.equal(profiles[0], profiles[1])
  assert.deepEqual(closeCalls, [profiles[0]])
})

test('reports restart busy during an operation, browser start, and disposal', async t => {
  const operationStarted = Promise.withResolvers()
  const operationRelease = Promise.withResolvers()
  const createStarted = Promise.withResolvers()
  const createRelease = Promise.withResolvers()
  const closeStarted = Promise.withResolvers()
  const closeRelease = Promise.withResolvers()
  let pageNumber = 0
  const { control } = await setup(t, {
    createPage: async () => {
      const currentPage = ++pageNumber
      if (currentPage === 2) {
        createStarted.resolve()
        await createRelease.promise
      }
      return {
        frame: async () => {
          if (currentPage === 1) {
            operationStarted.resolve()
            await operationRelease.promise
          }
          return '/9j/2Q=='
        },
        close: async () => {
          if (currentPage === 2) {
            closeStarted.resolve()
            await closeRelease.promise
          }
        },
        closed: new Promise(() => {}),
      }
    },
  })
  const frame = controlResponse(control, { ...request, action: 'frame' })
  await operationStarted.promise
  assert.deepEqual(await controlResponse(control, { ...request, action: 'restart' }), { status: 'busy' })
  operationRelease.resolve()
  assert.deepEqual(await frame, { jpeg: '/9j/2Q==', width: 1280, height: 800 })

  assert.deepEqual(await controlResponse(control, { ...request, action: 'restart' }), { status: 'restarted' })
  const starting = controlResponse(control, { ...request, action: 'frame' })
  await createStarted.promise
  assert.deepEqual(await controlResponse(control, { ...request, action: 'restart' }), { status: 'busy' })
  createRelease.resolve()
  assert.deepEqual(await starting, { jpeg: '/9j/2Q==', width: 1280, height: 800 })

  const firstRestart = controlResponse(control, { ...request, action: 'restart' })
  await closeStarted.promise
  assert.deepEqual(await controlResponse(control, { ...request, action: 'restart' }), { status: 'busy' })
  closeRelease.resolve()
  assert.deepEqual(await firstRestart, { status: 'restarted' })
})

test('reports restart busy while the exact owner saved login is reserved', async t => {
  const origin = 'https://login.example.test'
  const destination = origin + '/session'
  const { control } = await setup(t, {
    savedLogins: true,
    createPage: async () => ({
      captureLogin: async () => ({ origin, destination }),
      frame: async () => '/9j/2Q==',
      close: async () => {},
      closed: new Promise(() => {}),
    }),
  })
  const pending = await controlResponse(control, { ...request, action: 'request-login' })
  assert.match(pending.id, /^[a-f0-9]{32}$/u)
  assert.deepEqual(await controlResponse(control, { ...request, action: 'restart' }), { status: 'busy' })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'cancel-login', id: pending.id }), {
    state: 'unavailable',
  })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'restart' }), { status: 'restarted' })
})

test('opens only explicitly enabled shared chats in their own browser profiles', async t => {
  const profiles = []
  const { control } = await setup(t, {
    grants: parseGrants([{ ...request, shared: true }, { bot: 'bot-other', session: otherSession }]),
    createPage: async (_executable, profile) => {
      profiles.push(profile)
      const closing = Promise.withResolvers()
      return { frame: async () => '/9j/2Q==', close: async () => closing.resolve(), closed: closing.promise }
    },
  })
  for (const session of [SESSION, sharedSession, anotherSharedSession, sharedSession]) {
    const frame = await controlResponse(control, { bot: BOT, session, action: 'frame' })
    assert.equal(frame.jpeg, '/9j/2Q==')
  }
  assert.equal(new Set(profiles).size, 3)
  assert.equal(profiles.filter(profile => profile.endsWith('/' + SESSION)).length, 1)
  assert.equal(profiles.some(profile => profile.includes(sharedSession)), false)
  assert.deepEqual(await controlResponse(control, { bot: BOT, session: sharedSession, action: 'status' }), {
    available: true,
  })
  assert.deepEqual(await controlResponse(control, {
    bot: BOT, session: sharedSession, action: 'status', capability: 'restart',
  }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(control, { bot: 'bot-other', session: sharedSession, action: 'status' }),
    { error: 'unavailable' })
  assert.deepEqual(await controlResponse(control, { bot: BOT, session: 'shared-session-incorrect', action: 'status' }),
    { error: 'unavailable' })
  assert.throws(() => parseGrants([{ ...request, shared: 'true' }]))
})

test('uses an exact owner pair override and gives its managed generation a fresh profile', async t => {
  const profiles = []
  const { control } = await setup(t, {
    policy: { version: 1, bots: [{ bot: BOT, session: SESSION, enabled: true, revision: REVISION }] },
    createPage: async (_executable, profile) => {
      profiles.push(profile)
      return { frame: async () => '/9j/2Q==', close: async () => {}, closed: new Promise(() => {}) }
    },
  })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'sharing-status' }), {
    managed: true, legacy: false, override: true,
  })
  assert.deepEqual(await controlResponse(control, {
    bot: BOT, session: sharedSession, action: 'frame',
  }), { jpeg: '/9j/2Q==', width: 1280, height: 800 })
  assert.equal(profiles.length, 1)
  assert.equal(profiles[0].endsWith('/' + SESSION), false)
  assert.deepEqual(await controlResponse(control, {
    bot: BOT, session: otherSession, action: 'sharing-status',
  }), { error: 'unavailable' })
})

test('lets an explicit disabled override supersede a legacy shared grant', async t => {
  let pages = 0
  const { control } = await setup(t, {
    grants: parseGrants([{ ...request, shared: true }]),
    policy: { version: 1, bots: [{ bot: BOT, session: SESSION, enabled: false, revision: REVISION }] },
    createPage: async () => { pages++; throw new Error('disabled shared access must not launch') },
  })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'sharing-status' }), {
    managed: true, legacy: true, override: false,
  })
  assert.deepEqual(await controlResponse(control, { bot: BOT, session: sharedSession, action: 'frame' }), {
    error: 'unavailable',
  })
  assert.equal(pages, 0)
})

test('keeps legacy shared access when the owner policy is absent', async t => {
  const { control } = await setup(t, {
    grants: parseGrants([{ ...request, shared: true }]),
    createPage: async () => ({ frame: async () => '/9j/2Q==', close: async () => {}, closed: new Promise(() => {}) }),
  })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'sharing-status' }), {
    managed: false, legacy: true, override: null,
  })
  assert.deepEqual(await controlResponse(control, { bot: BOT, session: sharedSession, action: 'frame' }), {
    jpeg: '/9j/2Q==', width: 1280, height: 800,
  })
})

test('exposes a managed empty policy before the first owner opt-in', async t => {
  let pages = 0
  const { control } = await setup(t, {
    policy: { version: 1, bots: [] },
    createPage: async () => { pages++; throw new Error('empty policy must deny shared access') },
  })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'sharing-status' }), {
    managed: true, legacy: false, override: null,
  })
  assert.deepEqual(await controlResponse(control, { bot: BOT, session: sharedSession, action: 'frame' }), {
    error: 'unavailable',
  })
  assert.equal(pages, 0)
})

test('fails closed for a corrupt policy without advertising legacy access', async t => {
  let pages = 0
  const { control } = await setup(t, {
    grants: parseGrants([{ ...request, shared: true }]),
    policy: { version: 1, bots: [{ bot: BOT, session: SESSION, enabled: 'yes', revision: REVISION }] },
    createPage: async () => { pages++; throw new Error('corrupt policy must deny shared access') },
  })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'sharing-status' }), {
    managed: false, legacy: false, override: null,
  })
  assert.deepEqual(await controlResponse(control, { bot: BOT, session: sharedSession, action: 'frame' }), {
    error: 'unavailable',
  })
  assert.equal(pages, 0)
})

test('refresh-sharing revokes only the changed Bot shared profile', async t => {
  const closeCalls = []
  const grants = parseGrants([
    { ...request, shared: true },
    { bot: BOT2, session: SESSION2, shared: true },
  ])
  const chat = { bot: BOT, session: sharedSession }
  const otherChat = { bot: BOT2, session: anotherSharedSession }
  const policy = {
    version: 1,
    bots: [
      { bot: BOT, session: SESSION, enabled: true, revision: REVISION },
      { bot: BOT2, session: SESSION2, enabled: true, revision: REVISION2 },
    ],
  }
  const { control, vault, sharingFile } = await setup(t, {
    grants,
    policy,
    createPage: async (_executable, profile) => {
      const done = Promise.withResolvers()
      return {
        frame: async () => '/9j/2Q==',
        close: async () => { closeCalls.push(profile); done.resolve() },
        closed: done.promise,
      }
    },
  })
  await controlResponse(control, { ...request, action: 'frame' })
  await controlResponse(control, { ...chat, action: 'frame' })
  await controlResponse(control, { ...otherChat, action: 'frame' })
  const next = { ...policy, bots: policy.bots.map(entry => entry.bot === BOT ? { ...entry, enabled: false, revision: '3'.repeat(32) } : entry) }
  await writeFile(sharingFile, JSON.stringify(next))
  assert.deepEqual(await controlResponse(vault, { action: 'refresh-sharing' }), { ok: true })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'sharing-status' }), {
    managed: true, legacy: true, override: false,
  })
  assert.deepEqual(await controlResponse(control, { ...chat, action: 'frame' }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(control, { ...otherChat, action: 'frame' }), {
    jpeg: '/9j/2Q==', width: 1280, height: 800,
  })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'frame' }), {
    jpeg: '/9j/2Q==', width: 1280, height: 800,
  })
  assert.equal(closeCalls.length, 1)
})

test('rechecks a durable shared policy before releasing a queued frame', async t => {
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  const policy = {
    version: 1,
    bots: [{ bot: BOT, session: SESSION, enabled: true, revision: REVISION }],
  }
  const { control, vault, sharingFile } = await setup(t, {
    policy,
    createPage: async () => ({
      frame: async () => {
        started.resolve()
        await release.promise
        return '/9j/2Q=='
      },
      close: async () => {},
      closed: new Promise(() => {}),
    }),
  })
  const frame = controlResponse(control, { bot: BOT, session: sharedSession, action: 'frame' })
  await started.promise
  await writeFile(sharingFile, JSON.stringify({
    version: 1,
    bots: [{ bot: BOT, session: SESSION, enabled: false, revision: REVISION2 }],
  }))
  const refreshed = controlResponse(vault, { action: 'refresh-sharing' })
  await new Promise(resolve => setTimeout(resolve, 10))
  release.resolve()
  assert.deepEqual(await frame, { error: 'unavailable' })
  assert.deepEqual(await refreshed, { ok: true })
})

test('rechecks a policy changed on disk even without a refresh command', async t => {
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  const { control, sharingFile } = await setup(t, {
    policy: { version: 1, bots: [{ bot: BOT, session: SESSION, enabled: true, revision: REVISION }] },
    createPage: async () => ({
      frame: async () => {
        started.resolve()
        await release.promise
        return '/9j/2Q=='
      },
      close: async () => {},
      closed: new Promise(() => {}),
    }),
  })
  const frame = controlResponse(control, { bot: BOT, session: sharedSession, action: 'frame' })
  await started.promise
  await writeFile(sharingFile, JSON.stringify({
    version: 1,
    bots: [{ bot: BOT, session: SESSION, enabled: false, revision: REVISION2 }],
  }))
  release.resolve()
  assert.deepEqual(await frame, { error: 'unavailable' })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'sharing-status' }), {
    managed: true, legacy: false, override: false,
  })
})

test('admits only screen input and web navigation, and keeps the Vault endpoint closed to requests', async t => {
  const inputs = []
  const events = []
  const done = Promise.withResolvers()
  const { control, vault } = await setup(t, { createPage: async (_binary, profile) => {
    events.push(profile.endsWith('/' + SESSION))
    return {
      input: async data => { inputs.push(data) }, frame: async () => '/9j/2Q==',
      navigate: async url => { inputs.push(url) }, close: async () => { done.resolve() }, closed: done.promise,
    }
  } })
  for (const data of [
    { action: 'exec', argv: ['test'] }, { action: 'frame', extra: true },
    { action: 'input', input: { kind: 'move', x: -1, y: 1 } },
    { action: 'input', input: { kind: 'key', key: 'ctrl+alt+F2' } },
    { action: 'navigate', url: 'file:///var/lib/' }, { action: 'navigate', url: 'https://test:test@example.test/' },
  ]) assert.deepEqual(await controlResponse(control, { ...request, ...data }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(vault, { ...request, action: 'status' }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'frame' }), { jpeg: '/9j/2Q==', width: 1280, height: 800 })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'navigate', url: 'https://example.test' }), { ok: true })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'input', input: { kind: 'text', text: 'fixture' } }), { ok: true })
  assert.deepEqual(inputs, ['https://example.test/', { kind: 'text', text: 'fixture' }])
  assert.deepEqual(events, [true])
})

test('reserves an existing page for an exact owner lease and checks the live origin before input', async t => {
  const inputs = []
  const navigations = []
  const origin = 'https://example.test'
  const lease = 'a'.repeat(32)
  const chat = { bot: BOT, session: sharedSession }
  const { control } = await setup(t, { grants: parseGrants([{ ...request, shared: true }]), createPage: async () => ({
    origin: async () => origin,
    frame: async () => '/9j/2Q==',
    input: async data => { inputs.push(data) },
    navigate: async url => { navigations.push(url) },
    close: async () => {},
    closed: new Promise(() => {}),
  }) })
  assert.deepEqual(await controlResponse(control, { ...chat, action: 'frame' }), {
    jpeg: '/9j/2Q==', width: 1280, height: 800,
  })
  assert.deepEqual(await controlResponse(control, { ...chat, action: 'begin-handoff', lease: 'b'.repeat(31) }),
    { error: 'unavailable' })
  const begin = await controlResponse(control, { ...chat, action: 'begin-handoff', lease })
  assert.deepEqual(begin, { origin })
  assert.equal(JSON.stringify(begin).includes(lease), false)
  for (const action of [
    { action: 'frame' },
    { action: 'input', input: { kind: 'text', text: 'ordinary' } },
    { action: 'navigate', url: 'https://ordinary.example.test/' },
  ]) assert.deepEqual(await controlResponse(control, { ...chat, ...action }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(control, { ...chat, action: 'frame', lease }), {
    jpeg: '/9j/2Q==', width: 1280, height: 800, origin,
  })
  assert.deepEqual(await controlResponse(control, {
    ...chat, action: 'input', lease, origin: 'https://changed.example.test',
    input: { kind: 'text', text: 'owner' },
  }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(control, {
    ...chat, action: 'input', lease, origin, input: { kind: 'text', text: 'owner' },
  }), { ok: true })
  assert.deepEqual(await controlResponse(control, {
    ...chat, action: 'navigate', lease, url: 'http://example.test/',
  }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(control, {
    ...chat, action: 'navigate', lease, url: 'https://owner.example.test/',
  }), { ok: true })
  assert.deepEqual(await controlResponse(control, { ...chat, action: 'end-handoff', lease: 'c'.repeat(32), outcome: 'complete' }),
    { error: 'unavailable' })
  assert.deepEqual(await controlResponse(control, { ...chat, action: 'end-handoff', lease, outcome: 'complete' }), { ok: true })
  assert.deepEqual(await controlResponse(control, { ...chat, action: 'frame', lease }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(control, { ...chat, action: 'frame' }), {
    jpeg: '/9j/2Q==', width: 1280, height: 800,
  })
  assert.deepEqual(inputs, [{ kind: 'text', text: 'owner' }])
  assert.deepEqual(navigations, ['https://owner.example.test/'])
})

test('returns a null owner-frame origin when navigation changes during capture', async t => {
  const origins = ['https://before.example.test', 'https://after.example.test']
  const lease = '3'.repeat(32)
  const chat = { bot: BOT, session: sharedSession }
  const { control } = await setup(t, { grants: parseGrants([{ ...request, shared: true }]), createPage: async () => ({
    origin: async () => origins.shift() ?? 'https://after.example.test',
    frame: async () => '/9j/2Q==',
    close: async () => {},
    closed: new Promise(() => {}),
  }) })
  await controlResponse(control, { ...chat, action: 'frame' })
  assert.deepEqual(await controlResponse(control, { ...chat, action: 'begin-handoff', lease }), {
    origin: 'https://before.example.test',
  })
  origins.push('https://before.example.test', 'https://after.example.test')
  assert.deepEqual(await controlResponse(control, { ...chat, action: 'frame', lease }), {
    jpeg: '/9j/2Q==', width: 1280, height: 800, origin: null,
  })
})

test('rejects private lease forms and never launches a page for stale or scope-crossing leases', async t => {
  const lease = '4'.repeat(32)
  const privatePages = []
  const privateControl = await setup(t, {
    createPage: async () => { privatePages.push(true); throw new Error('must not launch') },
  })
  assert.deepEqual(await controlResponse(privateControl.control, { ...request, action: 'begin-handoff', lease }), {
    error: 'unavailable',
  })
  assert.equal(privatePages.length, 0)

  const sharedPages = []
  const chat = { bot: BOT, session: sharedSession }
  const otherChat = { bot: BOT, session: anotherSharedSession }
  const sharedControl = await setup(t, {
    grants: parseGrants([{ ...request, shared: true }]),
    createPage: async () => { sharedPages.push(true); throw new Error('must not launch') },
  })
  for (const action of [
    { action: 'begin-handoff', lease },
    { action: 'frame', lease },
    { action: 'input', lease, origin: null, input: { kind: 'text', text: 'stale' } },
    { action: 'navigate', lease, url: 'https://example.test/' },
  ]) assert.deepEqual(await controlResponse(sharedControl.control, { ...chat, ...action }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(sharedControl.control, { ...otherChat, action: 'frame', lease }), {
    error: 'unavailable',
  })
  assert.equal(sharedPages.length, 0)
})

test('refuses handoff for a blank or non-HTTPS page and while a saved login is pending', async t => {
  const chat = { bot: BOT, session: sharedSession }
  for (const pageOrigin of [null, 'http://example.test']) {
    const { control } = await setup(t, { grants: parseGrants([{ ...request, shared: true }]), createPage: async () => ({
      origin: async () => pageOrigin,
      frame: async () => '/9j/2Q==',
      close: async () => {},
      closed: new Promise(() => {}),
    }) })
    await controlResponse(control, { ...chat, action: 'frame' })
    assert.deepEqual(await controlResponse(control, {
      ...chat, action: 'begin-handoff', lease: 'd'.repeat(32),
    }), { error: 'unavailable' })
  }

  const origin = 'https://login.example.test'
  const destination = `${origin}/session`
  const { control } = await setup(t, {
    grants: parseGrants([{ ...request, shared: true }]),
    savedLogins: true,
    createPage: async () => ({
      origin: async () => origin,
      captureLogin: async () => ({ origin, destination }),
      frame: async () => '/9j/2Q==',
      close: async () => {},
      closed: new Promise(() => {}),
    }),
  })
  const pending = await controlResponse(control, { ...chat, action: 'request-login' })
  assert.match(pending.id, /^[a-f0-9]{32}$/u)
  assert.deepEqual(await controlResponse(control, {
    ...chat, action: 'begin-handoff', lease: 'e'.repeat(32),
  }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(control, { ...chat, action: 'cancel-login', id: pending.id }), { state: 'unavailable' })
  assert.deepEqual(await controlResponse(control, {
    ...chat, action: 'begin-handoff', lease: 'e'.repeat(32),
  }), { origin })
})

test('discards a handed-off page before reopening the same persistent profile', async t => {
  const profiles = []
  const closed = []
  const lease = 'f'.repeat(32)
  const chat = { bot: BOT, session: sharedSession }
  const { control } = await setup(t, {
    grants: parseGrants([{ ...request, shared: true }]),
    createPage: async (_executable, profile) => {
      profiles.push(profile)
      const done = Promise.withResolvers()
      closed.push(done)
      return {
        origin: async () => 'https://example.test',
        frame: async () => '/9j/2Q==',
        close: async () => done.resolve(),
        closed: done.promise,
      }
    },
  })
  await controlResponse(control, { ...chat, action: 'frame' })
  assert.deepEqual(await controlResponse(control, { ...chat, action: 'begin-handoff', lease }), {
    origin: 'https://example.test',
  })
  assert.deepEqual(await controlResponse(control, { ...chat, action: 'end-handoff', lease, outcome: 'discard' }), { ok: true })
  assert.deepEqual(await controlResponse(control, { ...chat, action: 'frame' }), {
    jpeg: '/9j/2Q==', width: 1280, height: 800,
  })
  assert.equal(profiles.length, 2)
  assert.equal(profiles[0], profiles[1])
  assert.equal(closed.length, 2)
})

test('keeps a failed discard fail-closed until the page reports closed', async t => {
  const firstClosed = Promise.withResolvers()
  let closeFailure = true
  let pages = 0
  const chat = { bot: BOT, session: sharedSession }
  const { control } = await setup(t, {
    grants: parseGrants([{ ...request, shared: true }]),
    createPage: async () => {
      pages++
      if (pages > 1) return {
        origin: async () => 'https://example.test', frame: async () => '/9j/2Q==',
        close: async () => {}, closed: new Promise(() => {}),
      }
      return {
        origin: async () => 'https://example.test', frame: async () => '/9j/2Q==',
        close: async () => { if (closeFailure) throw new Error('fixture close failure'); firstClosed.resolve() },
        closed: firstClosed.promise,
      }
    },
  })
  const lease = '1'.repeat(32)
  await controlResponse(control, { ...chat, action: 'frame' })
  await controlResponse(control, { ...chat, action: 'begin-handoff', lease })
  assert.deepEqual(await controlResponse(control, { ...chat, action: 'end-handoff', lease, outcome: 'discard' }), {
    error: 'unavailable',
  })
  assert.deepEqual(await controlResponse(control, { ...chat, action: 'frame' }), { error: 'unavailable' })
  closeFailure = false
  firstClosed.resolve()
  assert.deepEqual(await controlResponse(control, { ...chat, action: 'frame' }), {
    jpeg: '/9j/2Q==', width: 1280, height: 800,
  })
  assert.equal(pages, 2)
})

test('expires a handoff lease and closes the page through the per-page queue', async t => {
  let now = 0
  const timers = []
  let pages = 0
  let closed = false
  const chat = { bot: BOT, session: sharedSession }
  const { control } = await setup(t, {
    grants: parseGrants([{ ...request, shared: true }]),
    handoffNow: () => now,
    handoffSchedule: callback => { timers.push(callback); return { unref() {} } },
    createPage: async () => {
      pages++
      const pageClosed = new Promise(() => {})
      return {
        origin: async () => 'https://example.test',
        frame: async () => '/9j/2Q==',
        close: async () => { closed = true },
        closed: pageClosed,
      }
    },
  })
  await controlResponse(control, { ...chat, action: 'frame' })
  assert.deepEqual(await controlResponse(control, { ...chat, action: 'begin-handoff', lease: '2'.repeat(32) }), {
    origin: 'https://example.test',
  })
  now = 10 * 60_000
  timers[0]()
  assert.deepEqual(await controlResponse(control, { ...chat, action: 'frame' }), {
    jpeg: '/9j/2Q==', width: 1280, height: 800,
  })
  assert.equal(closed, true)
  assert.equal(pages, 2)
})

test('refuses profiles that point outside the browser account directory', async t => {
  const { root, control } = await setup(t)
  await symlink(tmpdir(), join(root, SESSION), 'dir')
  assert.deepEqual(await controlResponse(control, { ...request, action: 'frame' }), { error: 'unavailable' })
})

test('reserves the exact browser for one owner-approved login and consumes it once', async t => {
  const origin = 'https://login.example.test'
  const destination = `${origin}/session`
  const document = Symbol('fixture document')
  const finished = Promise.withResolvers()
  const submitted = []
  const { control, vault } = await setup(t, {
    savedLogins: true,
    createPage: async () => ({
      captureLogin: async () => ({ origin, destination, document }),
      submitLogin: async (selected, username, password) => {
        submitted.push({ document: selected.document, username, password })
        return 'submitted'
      },
      frame: async () => '/9j/2Q==',
      close: async () => { finished.resolve() }, closed: finished.promise,
    }),
  })
  const pending = await controlResponse(control, { ...request, action: 'request-login' })
  assert.match(pending.id, /^[a-f0-9]{32}$/u)
  assert.deepEqual(pending, { id: pending.id, origin, destination, state: 'pending' })
  const use = { action: 'use-login', id: pending.id, origin, username: 'fixture-user', password: 'fixture-password' }
  assert.deepEqual(await controlResponse(control, { ...request, ...use }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(vault, { action: 'inspect-login', id: pending.id }), pending)
  assert.deepEqual(await controlResponse(vault, { action: 'inspect-login-bot', id: pending.id }), { bot: request.bot })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'inspect-login-bot', id: pending.id }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'frame' }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(vault, { ...use, origin: 'https://different.example.test' }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(vault, { ...use, bot: 'bot-other' }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(vault, { ...use, bot: request.bot }), { state: 'submitted' })
  assert.deepEqual(await controlResponse(vault, use), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'login-status', id: pending.id }), { state: 'submitted' })
  assert.deepEqual(submitted, [{ document, username: use.username, password: use.password }])
  assert.deepEqual(await controlResponse(control, { ...request, action: 'frame' }), { jpeg: '/9j/2Q==', width: 1280, height: 800 })
})

test('exposes and consumes only the exact private automatic login form', async t => {
  const origin = 'https://login.example.test'
  const destination = `${origin}/session`
  const document = Symbol('fixture document')
  const submitted = []
  const { control, vault } = await setup(t, {
    savedLogins: true,
    createPage: async () => ({
      captureLogin: async () => ({ origin, destination, document }),
      submitLogin: async (selected, username, password) => {
        submitted.push({ document: selected.document, username, password })
        return 'submitted'
      },
      close: async () => {}, closed: new Promise(() => {}),
    }),
  })
  const pending = await controlResponse(control, { ...request, action: 'request-login' })
  const inspect = { action: 'inspect-login-automatic', id: pending.id }
  assert.deepEqual(await controlResponse(vault, { ...inspect, bot: BOT, session: SESSION }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(vault, inspect), {
    id: pending.id, origin, destination, state: 'pending', bot: BOT, session: SESSION,
  })
  const use = {
    action: 'use-login', id: pending.id, origin, username: 'fixture-user', password: 'fixture-password',
    bot: BOT, session: SESSION,
  }
  assert.deepEqual(await controlResponse(vault, { ...use, bot: 'bot-other' }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(vault, { ...use, session: otherSession }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(vault, { ...use, origin: 'https://different.example.test' }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(vault, use), { state: 'submitted' })
  assert.deepEqual(await controlResponse(vault, inspect), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(vault, use), { error: 'unavailable' })
  assert.deepEqual(submitted, [{ document, username: use.username, password: use.password }])
})

test('allows a shared login only for the requesting chat and its assigned Bot account', async t => {
  const origin = 'https://login.example.test'
  const destination = `${origin}/session`
  const closed = Promise.withResolvers()
  let submissions = 0
  const { control, vault } = await setup(t, {
    grants: parseGrants([{ ...request, shared: true }]),
    savedLogins: true,
    createPage: async () => ({
      captureLogin: async () => ({ origin, destination }),
      submitLogin: async () => { submissions++; return 'submitted' },
      close: async () => closed.resolve(), closed: closed.promise,
    }),
  })
  const chat = { bot: BOT, session: sharedSession }
  const pending = await controlResponse(control, { ...chat, action: 'request-login' })
  assert.match(pending.id, /^[a-f0-9]{32}$/u)
  assert.deepEqual(pending, { id: pending.id, origin, destination, state: 'pending' })
  const inspect = { action: 'inspect-login', id: pending.id }
  assert.deepEqual(await controlResponse(control, { ...chat, ...inspect }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(vault, inspect), { ...pending, scope: 'shared', bot: BOT })
  assert.deepEqual(await controlResponse(vault, { action: 'inspect-login-automatic', id: pending.id }), {
    error: 'unavailable',
  })
  const use = { action: 'use-login', id: pending.id, origin, username: 'fixture-team', password: 'fixture-password' }
  assert.deepEqual(await controlResponse(vault, use), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(vault, { ...use, bot: 'bot-other' }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(vault, { ...use, bot: BOT, session: sharedSession }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'cancel-login', id: pending.id }), { state: 'unavailable' })
  assert.deepEqual(await controlResponse(control, { ...chat, session: anotherSharedSession, action: 'login-status', id: pending.id }),
    { state: 'unavailable' })
  assert.equal(submissions, 0)
  const approval = controlResponse(vault, { ...use, bot: BOT })
  const status = await approvalStatus(control, chat, pending.id)
  assert.equal(status.state, 'approval-pending')
  assert.match(status.challenge, /^[a-f0-9]{32}$/u)
  assert.equal(submissions, 0)
  const authorize = { ...chat, action: 'authorize-login', id: pending.id, challenge: status.challenge }
  assert.deepEqual(await controlResponse(vault, authorize), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(control, { ...authorize, session: anotherSharedSession }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(control, { ...authorize, challenge: 'b'.repeat(32) }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(control, authorize), { ok: true })
  assert.deepEqual(await approval, { state: 'submitted' })
  assert.deepEqual(await controlResponse(control, authorize), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(control, { ...chat, action: 'login-status', id: pending.id }), { state: 'submitted' })
  assert.equal(submissions, 1)

  const next = await controlResponse(control, { ...chat, action: 'request-login' })
  const rejected = controlResponse(vault, { ...use, id: next.id, bot: BOT })
  const nextStatus = await approvalStatus(control, chat, next.id)
  assert.equal(nextStatus.state, 'approval-pending')
  assert.deepEqual(await controlResponse(control, { ...chat, action: 'cancel-login', id: next.id }), { state: 'unavailable' })
  assert.deepEqual(await rejected, { state: 'unavailable' })
  assert.deepEqual(await controlResponse(control, { ...authorize, id: next.id, challenge: nextStatus.challenge }), { error: 'unavailable' })
  assert.equal(submissions, 1)
})

test('does not submit an old shared login approval after a disk-only disable', async t => {
  const origin = 'https://login.example.test'
  const destination = origin + '/session'
  let submissions = 0
  const chat = { bot: BOT, session: sharedSession }
  const { control, vault, sharingFile } = await setup(t, {
    grants: parseGrants([{ ...request, shared: true }]),
    savedLogins: true,
    policy: { version: 1, bots: [{ bot: BOT, session: SESSION, enabled: true, revision: REVISION }] },
    createPage: async () => ({
      captureLogin: async () => ({ origin, destination }),
      submitLogin: async () => { submissions++; return 'submitted' },
      close: async () => {},
      closed: new Promise(() => {}),
    }),
  })
  const pending = await controlResponse(control, { ...chat, action: 'request-login' })
  const approval = controlResponse(vault, {
    action: 'use-login', id: pending.id, origin, username: 'fixture-user', password: 'fixture-password', bot: BOT,
  })
  const status = await approvalStatus(control, chat, pending.id)
  assert.equal(status.state, 'approval-pending')
  await writeFile(sharingFile, JSON.stringify({
    version: 1,
    bots: [{ bot: BOT, session: SESSION, enabled: false, revision: REVISION2 }],
  }))
  assert.deepEqual(await controlResponse(control, {
    ...chat, action: 'authorize-login', id: pending.id, challenge: status.challenge,
  }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(vault, { action: 'cancel-login', id: pending.id }), { state: 'unavailable' })
  assert.deepEqual(await approval, { error: 'unavailable' })
  assert.equal(submissions, 0)
})

test('opens a real browser through its pipe and submits keyboard input with Enter', {
  skip: process.env.YH_ISOLATED_TEST_CHROMIUM === undefined,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'yh-chromium-profile-'))
  const received = Promise.withResolvers()
  let browser
  const http = createHttpServer((incoming, reply) => {
    if (incoming.method === 'POST') {
      let body = ''
      incoming.setEncoding('utf8')
      incoming.on('data', chunk => { body += chunk })
      incoming.once('end', () => {
        received.resolve(new URLSearchParams(body).get('code'))
        reply.end()
      })
      return
    }
    reply.writeHead(200, { 'content-type': 'text/html' })
    reply.end('<!doctype html><title>Isolated browser</title><form method="post">'
      + '<input name="code" style="position:absolute;left:0;top:0;width:200px;height:40px"><button>Submit</button></form>')
  })
  t.after(async () => {
    try { await browser?.close() }
    finally {
      if (http.listening) await new Promise(resolve => { http.close(resolve); http.closeAllConnections() })
      await rm(root, { recursive: true, force: true })
    }
  })
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve) })
  browser = await createBrowserPage(process.env.YH_ISOLATED_TEST_CHROMIUM, root).catch(error => {
    throw new Error('Could not start the browser page', { cause: error })
  })
  await browser.navigate(`http://127.0.0.1:${http.address().port}/`).catch(error => {
    throw new Error('Could not navigate to the fixture', { cause: error })
  })
  const frame = Buffer.from(await browser.frame().catch(error => {
    throw new Error('Could not capture the fixture page', { cause: error })
  }), 'base64')
  assert.ok(frame.length > 1_000 && frame[0] === 0xff && frame[1] === 0xd8)
  await browser.input({ kind: 'click', x: 10, y: 10, button: 1 })
  await browser.input({ kind: 'text', text: 'hello' })
  await browser.input({ kind: 'key', key: '!' })
  await browser.input({ kind: 'key', key: 'Return' })
  const deadline = setTimeout(() => received.reject(new Error('Browser input did not reach the fixture')), 3000)
  try { assert.equal(await received.promise, 'hello!') } finally { clearTimeout(deadline) }
  await browser.close()
  await browser.closed
})

test('reuses one browser per Session and serializes its admitted operations', async t => {
  const opened = Promise.withResolvers()
  const first = Promise.withResolvers()
  const release = Promise.withResolvers()
  const closed = Promise.withResolvers()
  const events = []
  const { control } = await setup(t, { createPage: async () => {
    opened.resolve()
    events.push('open')
    return {
      async navigate() { first.resolve(); await release.promise; events.push('navigated') },
      async frame() { events.push('frame'); return '/9j/2Q==' },
      close: async () => { closed.resolve() }, closed: closed.promise,
    }
  } })
  const navigation = controlResponse(control, { ...request, action: 'navigate', url: 'https://example.test/' })
  await opened.promise
  await first.promise
  const capture = controlResponse(control, { ...request, action: 'frame' })
  release.resolve()
  await Promise.all([navigation, capture])
  assert.deepEqual(events, ['open', 'navigated', 'frame'])
})
