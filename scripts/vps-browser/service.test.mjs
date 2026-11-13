/** Tests for the isolated browser's fixed Computer protocol. */

import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
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
const request = { bot: BOT, session: SESSION }

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

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'yh-isolated-browser-'))
  const control = join(root, 'control.sock')
  const vault = join(root, 'vault.sock')
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
  return { control, vault, root, servers }
}

test('checks the exact Bot and Session without launching a browser', async t => {
  const { control } = await setup(t)
  assert.deepEqual(await controlResponse(control, { ...request, action: 'status' }), { available: true })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'status', session: otherSession }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'status', bot: 'bot-other' }), { error: 'unavailable' })
  assert.throws(() => parseGrants([request, { bot: 'bot-duplicate', session: SESSION }]))
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
  assert.deepEqual(await controlResponse(control, { ...request, action: 'frame' }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(vault, { ...use, origin: 'https://different.example.test' }), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(vault, use), { state: 'submitted' })
  assert.deepEqual(await controlResponse(vault, use), { error: 'unavailable' })
  assert.deepEqual(await controlResponse(control, { ...request, action: 'login-status', id: pending.id }), { state: 'submitted' })
  assert.deepEqual(submitted, [{ document, username: use.username, password: use.password }])
  assert.deepEqual(await controlResponse(control, { ...request, action: 'frame' }), { jpeg: '/9j/2Q==', width: 1280, height: 800 })
})

test('opens a real browser through its pipe, renders a page, and sends typed input', {
  skip: process.env.YH_ISOLATED_TEST_CHROMIUM === undefined,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'yh-chromium-profile-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const received = Promise.withResolvers()
  const http = createHttpServer((incoming, reply) => {
    if (incoming.url === '/received') {
      received.resolve('keyboard input received')
      reply.end()
      return
    }
    reply.writeHead(200, { 'content-type': 'text/html' })
    reply.end(`<!doctype html><title>Isolated browser</title><input style="position:absolute;left:0;top:0;width:200px;height:40px"
      oninput="if (this.value === 'hello!') fetch('/received')">`)
  })
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections() }))
  const browser = await createBrowserPage(process.env.YH_ISOLATED_TEST_CHROMIUM, root).catch(error => {
    throw new Error('Could not start the browser page', { cause: error })
  })
  t.after(() => browser.close())
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
  const deadline = setTimeout(() => received.reject(new Error('Browser input did not reach the fixture')), 3000)
  try { await received.promise } finally { clearTimeout(deadline) }
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
