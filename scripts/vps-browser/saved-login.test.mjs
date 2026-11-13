/** Replay a real login with fake credentials in an offline Chromium fixture. */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
const CREDENTIAL = { username: 'vault-user@example.test', password: 'fixture-only-password' }
const form = (action, extra = '') => `<!doctype html><form method="post" action="${action}">
  <input name="account" type="email" autocomplete="username">
  <input name="pass" type="password" autocomplete="current-password">
  <input name="nonce" type="hidden" value="fixture"><button>Sign in</button></form>${extra}`

async function tls(root, profile) {
  const key = join(root, 'fixture.key')
  const cert = join(root, 'fixture.crt')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${HOST}`,
    '-addext', `subjectAltName=DNS:${HOST},DNS:${ALTERNATE}`, '-out', cert, '-keyout', key], { stdio: 'ignore' })
  const db = join(profile, '.pki', 'nssdb')
  await mkdir(db, { recursive: true, mode: 0o700 })
  for (const args of [['-N', '--empty-password'], ['-A', '-n', 'Fixture', '-t', 'C,,', '-i', cert]]) {
    execFileSync('certutil', ['-d', `sql:${db}`, ...args], { stdio: 'ignore' })
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
  const security = await tls(root, join(root, BOT.session))
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
        matches: body.get('account') === CREDENTIAL.username && body.get('pass') === CREDENTIAL.password
          && body.get('nonce') === 'fixture' })
      if (request.url === '/forward') {
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
    if (request.url === '/other-origin') {
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
          if (event.request.method === 'POST' && new URL(event.request.url).pathname === '/session') {
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
  browser = browserServers({ root, executable: process.env.YH_ISOLATED_TEST_CHROMIUM, grants: parseGrants([BOT]), savedLogins: true })
  await Promise.all([listen(browser.control, controlPath), listen(browser.vault, vaultPath)])
  const control = (action, parameters) => exchange(controlPath, { ...BOT, action, ...parameters })
  const use = id => exchange(vaultPath, { action: 'use-login', id, origin, ...CREDENTIAL })

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
  assert.deepEqual(await use(selected.id), { state: 'submitted' })
  assert.deepEqual(await use(selected.id), { error: 'unavailable' })
  assert.deepEqual(posts, [
    { host: `${HOST}:${port}`, path: '/forward', matches: true },
    { host: `${HOST}:${port}`, path: '/session', matches: true },
  ])
  assert.equal(visibleValue, false)
  assert.equal(intercepted, false)
  assert.deepEqual(await control('navigate', { url: `${origin}/signed-in` }), { ok: true })
  assert.deepEqual(await control('request-login'), { error: 'unavailable' })
})
