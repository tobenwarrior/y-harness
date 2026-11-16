/** Replay a real login with fake credentials in an offline Chromium fixture. */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:https'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { browserServers, parseGrants } from './service.mjs'

const HOST = 'login.example.test'
const ALTERNATE = 'other.example.test'
const BOT = { bot: 'bot-fixture', session: 'bot-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
const SHARED = { bot: BOT.bot, session: 'shared-session-cccccccc-cccc-4ccc-8ccc-cccccccccccc' }
const CODE = '041235'
const CREDENTIAL = { username: 'vault-user@example.test', password: 'fixture-only-password' }
const form = (action, extra = '') => `<!doctype html><form method="post" action="${action}">
  <input name="account" type="email" autocomplete="username">
  <input name="pass" type="password" autocomplete="current-password">
  <input name="nonce" type="hidden" value="fixture"><button>Sign in</button></form>${extra}`

async function tls(root, profiles) {
  const key = join(root, 'fixture.key')
  const cert = join(root, 'fixture.crt')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${HOST}`,
    '-addext', `subjectAltName=DNS:${HOST},DNS:${ALTERNATE}`, '-out', cert, '-keyout', key], { stdio: 'ignore' })
  for (const profile of profiles) {
    const db = join(profile, '.pki', 'nssdb')
    await mkdir(db, { recursive: true, mode: 0o700 })
    for (const args of [['-N', '--empty-password'], ['-A', '-n', 'Fixture', '-t', 'C,,', '-i', cert]]) {
      execFileSync('certutil', ['-d', `sql:${db}`, ...args], { stdio: 'ignore' })
    }
  }
  return { key: await readFile(key), cert: await readFile(cert) }
}

function exchange(path, request) {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    let data = ''
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.end(JSON.stringify(request)))
    socket.on('data', chunk => { data += chunk })
    socket.once('error', reject)
    socket.once('end', () => {
      try { resolve(JSON.parse(data)) } catch (error) { reject(error) }
    })
  })
}

function listen(server, ...address) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(...address, resolve)
  })
}

test('submits a reviewed HTTPS form without typing credentials or forwarding the POST to another origin', {
  skip: process.env.YH_ISOLATED_TEST_CHROMIUM === undefined,
  timeout: 20_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'yh-vault-browser-'))
  let browser
  let server
  t.after(async () => {
    try { await browser?.close() }
    finally {
      if (server?.listening === true) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
      await rm(root, { recursive: true, force: true })
    }
  })
  const sharedProfile = 'shared-' + createHash('sha256').update(SHARED.bot + '\0' + SHARED.session).digest('hex')
  const security = await tls(root, [join(root, BOT.session), join(root, sharedProfile)])
  const changeForm = Promise.withResolvers()
  const changed = Promise.withResolvers()
  const workerReady = Promise.withResolvers()
  const posts = []
  let visibleValue = false
  let intercepted = false
  let port
  server = createServer(security, async (request, reply) => {
    if (request.method === 'POST') {
      let text = ''
      for await (const chunk of request) text += chunk
      const body = new URLSearchParams(text)
      posts.push({ host: request.headers.host, path: request.url,
        matches: request.url === '/check-code'
          ? body.get('code') === CODE && body.get('nonce') === 'fixture' && body.size === 2
          : body.get('account') === CREDENTIAL.username && body.get('pass') === CREDENTIAL.password
            && body.get('nonce') === 'fixture'
            && (request.url !== '/register' || body.get('confirm') === CREDENTIAL.password) })
      if (request.url === '/forward' || request.url === '/check-code') {
        reply.writeHead(307, { Location: `https://${ALTERNATE}:${port}/trap` })
      } else {
        reply.writeHead(303, { Location: '/signed-in', 'Set-Cookie': 'signed=1; Secure; HttpOnly; Path=/' })
      }
      reply.end()
      return
    }
    reply.setHeader('Content-Type', 'text/html')
    if (request.url === '/visible-value') visibleValue = true
    if (request.url === '/worker-ready') workerReady.resolve()
    if (request.url === '/worker-intercepted') intercepted = true
    if (request.url === '/change-observed') changed.resolve()
    if (request.url === '/signup') {
      reply.end(`<!doctype html><form method="post" action="/register">
        <input name="account" type="email" autocomplete="email">
        <input name="pass" type="password" autocomplete="new-password">
        <input name="confirm" type="password" autocomplete="new-password">
        <input name="nonce" type="hidden" value="fixture"><button>Register</button></form>`)
    } else if (request.url === '/code') {
      reply.end(`<!doctype html><form method="post" action="/check-code">
        <input name="code" type="text" autocomplete="one-time-code" maxlength="6">
        <input name="nonce" type="hidden" value="fixture"><button>Verify</button></form><script>
        document.addEventListener('input', () => navigator.sendBeacon('/visible-value'));
        setInterval(() => {
          if (document.querySelector('[name=code]').value) navigator.sendBeacon('/visible-value');
        }, 20);
      </script>`)
    } else if (request.url === '/other-origin') {
      reply.end(form(`https://${ALTERNATE}:${port}/trap`))
    } else if (request.url === '/forward-form') {
      reply.end(form('/forward'))
    } else if (request.url === '/changed') {
      reply.end(form('/session', `<script>
        const change = new EventSource('/change-form');
        change.onmessage = () => {
          document.querySelector('form').action = '/different';
          fetch('/change-observed');
          change.close();
        };
      </script>`))
    } else if (request.url === '/change-form') {
      reply.setHeader('Content-Type', 'text/event-stream')
      reply.flushHeaders()
      changeForm.resolve(reply)
    } else if (request.url === '/worker.js') {
      reply.setHeader('Content-Type', 'text/javascript')
      reply.end(`self.addEventListener('install', () => self.skipWaiting());
        self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
        self.addEventListener('fetch', event => {
          if (event.request.method === 'POST' && ['/session', '/check-code'].includes(new URL(event.request.url).pathname)) {
            event.respondWith(fetch('/worker-intercepted').then(() => new Response('intercepted', {status: 400})));
          }
        });`)
    } else if (request.headers.cookie?.includes('signed=1')) {
      reply.end('<h1>Signed in</h1>')
    } else {
      reply.end(form('/session', `<script>
        const request = window.fetch.bind(window);
        const ready = () => { if (navigator.serviceWorker.controller) request('/worker-ready'); };
        navigator.serviceWorker.addEventListener('controllerchange', ready);
        navigator.serviceWorker.register('/worker.js').then(ready);
        window.fetch = () => { throw new Error('Page fetch'); };
        document.addEventListener('input', () => { navigator.sendBeacon('/visible-value'); });
        const watch = setInterval(() => {
          if (Array.from(document.querySelectorAll('input:not([type=hidden])')).some(i => i.value)) navigator.sendBeacon('/visible-value');
        }, 20);
      </script>`))
    }
  })
  await listen(server, 0, '127.0.0.1')
  port = server.address().port
  const origin = `https://${HOST}:${port}`
  const controlPath = join(root, 'control.sock')
  const vaultPath = join(root, 'vault.sock')
  browser = browserServers({ root, executable: process.env.YH_ISOLATED_TEST_CHROMIUM,
    grants: parseGrants([{ ...BOT, shared: true }]), savedLogins: true })
  await Promise.all([listen(browser.control, controlPath), listen(browser.vault, vaultPath)])
  const control = (action, parameters) => exchange(controlPath, { ...BOT, action, ...parameters })
  const use = id => exchange(vaultPath, { action: 'use-login', id, origin, bot: BOT.bot, ...CREDENTIAL })

  assert.deepEqual(await control('navigate', { url: `${origin}/other-origin` }), { ok: true })
  assert.deepEqual(await control('request-login'), { error: 'unavailable' })
  assert.deepEqual(await control('navigate', { url: `${origin}/changed` }), { ok: true })
  const stale = await control('request-login')
  assert.equal(stale.destination, `${origin}/session`)
  const change = await changeForm.promise
  change.end('data: change\n\n')
  await changed.promise
  assert.deepEqual(await use(stale.id), { state: 'needs-owner' })
  assert.deepEqual(posts, [])

  assert.deepEqual(await control('navigate', { url: `${origin}/forward-form` }), { ok: true })
  const redirect = await control('request-login')
  assert.equal(redirect.destination, `${origin}/forward`)
  assert.deepEqual(await use(redirect.id), { state: 'submitted' })

  assert.deepEqual(await control('navigate', { url: `${origin}/login` }), { ok: true })
  await workerReady.promise
  const selected = await control('request-login')
  assert.equal(selected.destination, `${origin}/session`)
  assert.deepEqual(await exchange(vaultPath, { action: 'inspect-login-bot', id: selected.id }), { bot: BOT.bot })
  assert.deepEqual(await exchange(vaultPath, { action: 'inspect-login-automatic', id: selected.id }), { ...selected, ...BOT })
  assert.deepEqual(await exchange(vaultPath, {
    action: 'use-login', id: selected.id, origin, bot: 'bot-other', ...CREDENTIAL,
  }), { error: 'unavailable' })
  assert.deepEqual(await exchange(vaultPath, { action: 'use-login', id: selected.id, origin, ...BOT, ...CREDENTIAL }),
    { state: 'submitted' })
  assert.deepEqual(await use(selected.id), { error: 'unavailable' })
  assert.deepEqual(posts, [
    { host: `${HOST}:${port}`, path: '/forward', matches: true },
    { host: `${HOST}:${port}`, path: '/session', matches: true },
  ])
  assert.equal(visibleValue, false)
  assert.equal(intercepted, false)
  assert.deepEqual(await control('navigate', { url: `${origin}/signed-in` }), { ok: true })
  assert.deepEqual(await control('request-login'), { error: 'unavailable' })

  const shared = (action, parameters) => exchange(controlPath, { ...SHARED, action, ...parameters })
  assert.deepEqual(await shared('navigate', { url: `${origin}/signed-in` }), { ok: true })
  const team = await shared('request-login')
  assert.match(team.id, /^[a-f0-9]{32}$/u)
  assert.deepEqual(await exchange(vaultPath, { action: 'inspect-login', id: team.id }),
    { ...team, scope: 'shared', bot: BOT.bot })
  assert.deepEqual(await exchange(vaultPath, { action: 'use-login', id: team.id, origin, ...CREDENTIAL }),
    { error: 'unavailable' })
  const ownerApproval = use(team.id)
  let status
  for (let attempt = 0; attempt < 50; attempt++) {
    status = await shared('login-status', { id: team.id })
    if (status.state !== 'pending') break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(status.state, 'approval-pending')
  assert.equal(posts.length, 2)
  assert.deepEqual(await shared('authorize-login', { id: team.id, challenge: status.challenge }), { ok: true })
  assert.deepEqual(await ownerApproval, { state: 'submitted' })
  assert.deepEqual(await shared('navigate', { url: `${origin}/signed-in` }), { ok: true })
  assert.deepEqual(await shared('request-login'), { error: 'unavailable' })
  assert.equal(posts.length, 3)
  assert.equal(posts.at(-1).matches, true)
  assert.equal(visibleValue, false)
  assert.equal(intercepted, false)

  assert.deepEqual(await shared('navigate', { url: `${origin}/signup` }), { ok: true })
  assert.deepEqual(await shared('request-login'), { error: 'unavailable' })
  assert.deepEqual(await control('navigate', { url: `${origin}/signup` }), { ok: true })
  const signup = await control('request-login')
  assert.equal(signup.purpose, 'signup')
  assert.equal(signup.destination, `${origin}/register`)
  assert.deepEqual(await exchange(vaultPath, { action: 'inspect-login', id: signup.id }), { ...signup, ...BOT })
  assert.deepEqual(await exchange(vaultPath, { action: 'inspect-login-automatic', id: signup.id }), { error: 'unavailable' })
  assert.deepEqual(await use(signup.id), { error: 'unavailable' })
  assert.deepEqual(await exchange(vaultPath, { action: 'use-signup', id: signup.id, origin, bot: BOT.bot, ...CREDENTIAL }),
    { error: 'unavailable' })
  assert.deepEqual(await exchange(vaultPath, { action: 'use-signup', id: signup.id, origin, ...BOT, ...CREDENTIAL }),
    { state: 'submitted' })
  assert.deepEqual(posts.at(-1), { host: `${HOST}:${port}`, path: '/register', matches: true })
  assert.equal(posts.length, 4)

  assert.deepEqual(await control('navigate', { url: `${origin}/code` }), { ok: true })
  const verification = await control('request-login')
  assert.equal(verification.purpose, 'verification')
  assert.equal(verification.destination, `${origin}/check-code`)
  const verify = { action: 'use-verification', id: verification.id, origin, destination: verification.destination, ...BOT, code: CODE }
  assert.deepEqual(await exchange(vaultPath, verify), { state: 'submitted' })
  assert.deepEqual(await exchange(vaultPath, verify), { error: 'unavailable' })
  assert.deepEqual(posts.at(-1), { host: `${HOST}:${port}`, path: '/check-code', matches: true })
  assert.equal(posts.length, 5)
  assert.equal(visibleValue, false)
  assert.equal(intercepted, false)
})

test('hands the same HTTPS browser back after the owner completes verification', {
  skip: process.env.YH_ISOLATED_TEST_CHROMIUM === undefined,
  timeout: 30_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'yh-handoff-browser-'))
  let browser
  let server
  t.after(async () => {
    try { await browser?.close() }
    finally {
      if (server?.listening === true) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })
  const profile = 'shared-' + createHash('sha256').update(SHARED.bot + '\0' + SHARED.session).digest('hex')
  const security = await tls(root, [join(root, profile)])
  const submission = Promise.withResolvers()
  const authenticated = Promise.withResolvers()
  server = createServer(security, async (request, reply) => {
    if (request.method === 'POST' && request.url === '/verify') {
      let body = ''
      for await (const chunk of request) body += chunk
      submission.resolve(new URLSearchParams(body).get('code'))
      reply.writeHead(303, { Location: '/verified', 'Set-Cookie': 'verified=1; Secure; HttpOnly; Path=/' }).end()
    } else {
      if (request.url === '/ready' && request.headers.cookie?.includes('verified=1')) authenticated.resolve()
      reply.setHeader('Content-Type', 'text/html')
      if (request.url === '/verify') {
        reply.end('<form method="post"><label>Verification code<input name="code" autofocus></label><button>Verify</button></form>')
      } else if (request.url === '/verified') {
        reply.end('<h1>Verified</h1><script>requestAnimationFrame(() => fetch("/ready"))</script>')
      } else reply.end('<h1>Browser fixture</h1>')
    }
  })
  await listen(server, 0, '127.0.0.1')
  const port = server.address().port
  const origin = `https://${HOST}:${port}`
  const verification = `https://${ALTERNATE}:${port}`
  const controlPath = join(root, 'control.sock')
  browser = browserServers({ root, executable: process.env.YH_ISOLATED_TEST_CHROMIUM, grants: parseGrants([{ ...BOT, shared: true }]) })
  await Promise.all([listen(browser.control, controlPath), listen(browser.vault, join(root, 'vault.sock'))])
  const shared = (action, parameters) => exchange(controlPath, { ...SHARED, action, ...parameters })
  const lease = 'e'.repeat(32)
  assert.deepEqual(await shared('navigate', { url: `${origin}/start` }), { ok: true })
  assert.deepEqual(await shared('begin-handoff', { lease }), { origin })
  assert.deepEqual(await shared('frame'), { error: 'unavailable' })
  assert.deepEqual(await shared('navigate', { lease, url: `${verification}/verify` }), { ok: true })
  const frame = await shared('frame', { lease })
  assert.equal(frame.origin, verification)
  assert.match(frame.jpeg, /^\/9j\//u)
  const input = { kind: 'text', text: '314159' }
  assert.deepEqual(await shared('input', { lease, origin, input }), { error: 'unavailable' })
  assert.deepEqual(await shared('input', { lease, origin: verification, input }), { ok: true })
  assert.deepEqual(await shared('input', { lease, origin: verification, input: { kind: 'key', key: 'Return' } }), { ok: true })
  assert.equal(await submission.promise, '314159')
  await authenticated.promise
  assert.match((await shared('frame', { lease })).jpeg, /^\/9j\//u)
  assert.deepEqual(await shared('end-handoff', { lease, outcome: 'complete' }), { ok: true })
  const resumed = await shared('frame')
  assert.match(resumed.jpeg, /^\/9j\//u)
  assert.equal(resumed.origin, undefined)
  assert.deepEqual(await shared('frame', { lease }), { error: 'unavailable' })
})
