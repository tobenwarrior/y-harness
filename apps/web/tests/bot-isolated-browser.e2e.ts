/** Verify the Bot browser panel through the real Cloud Host and browser worker protocol. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BotId, BotPrincipalId } from '@yharness/bots'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@yharness/llm'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/bot-workspace/session.v3.jsonl', import.meta.url))
const GOLDEN = fileURLToPath(new URL('./expected/bot-isolated-browser/browser.expected.md', import.meta.url))
const BOTS_SOURCE = new URL('../../../packages/bundle/web-app/lib/types/vps-bots.js', import.meta.url).href
const BROKER_SOURCE = new URL('../../../packages/bundle/web-app/lib/types/vps-isolated-browser.js', import.meta.url).href
const MODE = webSnapshotMode()
const BOT = BotId('bot-browser-fixture')
const PROVIDER = 'browser-fixture'
const MODEL = 'reply'
const WEBSITE = 'https://example.test/'
const REPLY = 'I opened the website.'
const LOGIN = { id: 'a'.repeat(32), origin: 'https://example.test', destination: 'https://example.test/session', state: 'pending' }
const SHARED_LOGIN = { ...LOGIN, id: 'b'.repeat(32) }
const SHARED_CHALLENGE = 'c'.repeat(32)
const LOGIN_REPLY = 'The login was submitted. I’ll check the page.'
const HANDOFF_REPLY = 'Thanks. I have the shared browser again.'
const BROWSER_DISABLED = 'Shared browsing is off.'

class BrowserAdapter extends LlmAdapter {
  override async listModels(provider: string) {
    return [{ provider, id: MODEL, name: `${provider}/${MODEL}` }]
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const latestUser = options.messages.findLastIndex(message => message.role === 'user')
    const input = options.messages[latestUser]?.content.filter(block => block.type === 'text').map(block => block.text).join(' ') ?? ''
    const savedLogin = input.includes('saved login')
    const handoff = input.includes('take over')
    const shared = input.includes('shared chat')
    const result = options.messages.slice(latestUser + 1).findLast(message => message.role === 'tool')
    const checkSharing = input.includes('check the browser setting')
    if (result === undefined && !checkSharing) {
      const id = ToolCallId(handoff ? 'fixture-browser-handoff' : savedLogin ? 'fixture-browser-login' : 'fixture-browser-navigation')
      const name = shared ? 'shared_browser' : 'vps_computer'
      const args = JSON.stringify(handoff ? { action: 'request_sign_in' }
        : savedLogin ? { action: 'request_saved_login' } : { action: 'navigate', url: WEBSITE })
      expect(options.tools?.some(tool => tool.name === name)).toBe(true)
      if (shared) {
        expect(options.tools?.some(tool => ['vps_computer', 'bash', 'request_vps_secret'].includes(tool.name))).toBe(false)
      }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (result === undefined) {
      expect(options.tools?.some(tool => tool.name === 'shared_browser') ?? false).toBe(false)
    } else if (handoff) {
      expect(result.content).toEqual([expect.objectContaining({ type: 'text', text: expect.stringContaining('returned the Computer') })])
      expect(JSON.stringify(options.messages.slice(latestUser))).not.toContain('fixture-input')
    } else if (savedLogin) {
      expect(result.content.some(block => block.type === 'text' && /sign-in submission/iu.test(block.text))).toBe(true)
      expect(JSON.stringify(result)).not.toContain(LOGIN.destination)
      expect(JSON.stringify(result)).not.toContain(LOGIN.id)
      expect(JSON.stringify(result)).not.toContain(SHARED_LOGIN.id)
    } else {
      expect(result.content.some(block => block.type === 'text' && block.text.includes('Browser'))).toBe(true)
    }
    const text = checkSharing ? BROWSER_DISABLED : handoff ? HANDOFF_REPLY : savedLogin ? LOGIN_REPLY : REPLY
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it.skipIf(MODE === 'record' || process.platform === 'win32')('opens websites for an owner or collaborator and approves the exact Bot sign-in in Cloud', async () => {
  const root = await mkdtemp('/tmp/yh-browser-web-')
  const runtimePath = join(root, 'browser.mjs')
  const overlay = join(root, 'browser.yml')
  const socketPath = join(root, 'browser.sock')
  const websites: string[] = []
  const sharedRequests: Array<{ readonly action: string; readonly session: string }> = []
  const handoffInputs: Array<{ readonly session: string; readonly origin: string }> = []
  let handoff: { readonly lease: string; readonly session: string } | undefined
  let handoffLease: string | undefined
  let loginApproved = false
  let sharedApproved = false
  let sharedAuthorized = false
  let sharingOverride: boolean | null = null
  let ownerSession: string | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  let socketServer: ReturnType<typeof createServer> | undefined
  const sockets = new Set<import('node:net').Socket>()
  try {
    const runtime = browser = await chromium.launch()
    const page = await runtime.newPage({ locale: 'en-US', userAgent: 'YHarnessCloudDesktop/1', viewport: { width: 1180, height: 900 } })
    const consoleLog = watchConsole(page)
    const jpeg = await page.evaluate(() => {
      const image = document.createElement('canvas')
      image.width = 1280
      image.height = 800
      const canvas = image.getContext('2d')!
      canvas.fillStyle = '#f1f4fa'
      canvas.fillRect(0, 0, image.width, image.height)
      canvas.font = '40px sans-serif'
      canvas.fillStyle = '#1c2233'
      canvas.fillText('Example workspace', 100, 180)
      return image.toDataURL('image/jpeg').split(',')[1]
    })
    socketServer = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket)
      socket.once('close', () => { sockets.delete(socket) })
      socket.on('error', () => socket.destroy())
      let body = ''
      socket.setEncoding('utf8')
      socket.on('data', (value) => { body += value })
      socket.once('end', () => {
        const request = JSON.parse(body) as {
          action: string
          bot: string
          session: string
          url?: string
          id?: string
          challenge?: string
          lease?: string
          origin?: string
          outcome?: string
          input?: { kind: string; text?: string }
        }
        const shared = request.session.startsWith('shared-session-')
        if (shared && sharingOverride !== true) {
          socket.end(JSON.stringify({ error: 'unavailable' }))
          return
        }
        if (shared) sharedRequests.push({ action: request.action, session: request.session })
        if (request.action === 'navigate' && request.url !== undefined) websites.push(request.url)
        const holding = handoff !== undefined && handoff.session === request.session
        const owner = holding && handoff?.lease === request.lease
        let response: object
        switch (request.action) {
          case 'status': response = { available: true }; break
          case 'sharing-status':
            response = request.bot === BOT && request.session === ownerSession
              ? { managed: true, legacy: false, override: sharingOverride } : { error: 'unavailable' }
            break
          case 'frame':
            response = holding && !owner ? { error: 'unavailable' } : {
              jpeg, width: 1280, height: 800, ...(owner ? { origin: LOGIN.origin } : {}),
            }
            break
          case 'begin-handoff':
            if (shared && !holding && request.lease !== undefined && /^[0-9a-f]{32}$/u.test(request.lease)) {
              handoff = { lease: request.lease, session: request.session }
              handoffLease = request.lease
              response = { origin: LOGIN.origin }
            } else response = { error: 'unavailable' }
            break
          case 'end-handoff':
            if (owner && request.outcome === 'complete') {
              handoff = undefined
              response = { ok: true }
            } else response = { error: 'unavailable' }
            break
          case 'input':
            if (owner && request.origin === LOGIN.origin && request.input?.text === 'fixture-input') {
              handoffInputs.push({ session: request.session, origin: request.origin })
            }
            response = holding && (!owner || request.origin !== LOGIN.origin) ? { error: 'unavailable' } : { ok: true }
            break
          case 'request-login': response = shared ? SHARED_LOGIN : LOGIN; break
          case 'login-status':
            response = shared && sharedApproved && !sharedAuthorized
              ? { state: 'approval-pending', challenge: SHARED_CHALLENGE }
              : { state: (shared ? sharedAuthorized : loginApproved) ? 'submitted' : 'pending' }
            break
          case 'authorize-login':
            sharedAuthorized = shared && sharedApproved && request.id === SHARED_LOGIN.id && request.challenge === SHARED_CHALLENGE
            response = sharedAuthorized ? { ok: true } : { error: 'unavailable' }
            break
          case 'cancel-login': response = { state: 'unavailable' }; break
          default: response = { ok: true }
        }
        socket.end(JSON.stringify(response))
      })
    })
    await new Promise<void>((resolve, reject) => { socketServer!.once('error', reject); socketServer!.listen(socketPath, resolve) })
    await writeFile(runtimePath, `
      import { mountVpsBots } from ${JSON.stringify(BOTS_SOURCE)}
      import { VpsIsolatedBrowser } from ${JSON.stringify(BROKER_SOURCE)}
      export const name = 'isolated-browser-fixture'
      export function apply(ctx, config) {
        // The fixture provides the installed worker protocol on a temporary socket.
        ctx.effect(() => {
          const original = VpsIsolatedBrowser.prototype.usesManagedSharing
          VpsIsolatedBrowser.prototype.usesManagedSharing = () => true
          return () => { VpsIsolatedBrowser.prototype.usesManagedSharing = original }
        })
        mountVpsBots(ctx, config, [])
      }
    `)
    await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'isolated-browser-fixture', name: pathToFileURL(runtimePath).href,
      config: { root: join(root, 'bots'), image: 'localhost/yharness-test', bots: [BOT], desktopOnlyBots: [BOT],
        isolatedBrowser: { bots: [BOT], socketPath, savedLogins: true } },
    }] }]))
    const web = scaffold = await launchWebScaffold({ extraOverlayPath: overlay, replayFixture: FIXTURE, replayProvidersOnly: true, toolsMode: 'native' })
    const adapter = new BrowserAdapter()
    web.ctx.effect(() => web.ctx.llm.registerAdapter([PROVIDER], adapter), 'Isolated Browser fixture model')
    await web.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
    const { bot } = await web.ctx.bots.create({ id: BOT, name: 'Browser Scout', cwd: web.workspaceCwd })
    ownerSession = bot.sessionId
    await page.goto(web.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-yh-part="sidebar"]').getByRole('button', { name: 'Bots', exact: true }).click()
    await page.locator(`[data-bot-id="${BOT}"]`).click()
    const conversation = page.locator('[data-conversation-surface="bots"]')
    await conversation.locator('[data-composer-input][contenteditable="true"]').fill('Open the test site.')
    await conversation.getByRole('button', { name: 'Send message', exact: true }).click()
    await conversation.getByText(REPLY, { exact: true }).waitFor()
    expect(websites).toEqual([WEBSITE])
    await page.getByRole('button', { name: 'Open computer panel', exact: true }).click()
    const panelSelector = '[data-computer-panel]'
    const panel = page.locator(panelSelector)
    await panel.getByRole('img', { name: 'Live computer screen' }).waitFor()
    expect(await panel.getByRole('textbox', { name: 'Website address' }).count()).toBe(0)
    await panel.getByRole('button', { name: 'Take control', exact: true }).click()
    const address = panel.getByRole('textbox', { name: 'Website address' })
    await address.fill('https://example.test/next')
    const controlling = await captureStableAria(page, panelSelector, web.workspaceCwd)
    await address.press('Enter')
    await expect.poll(() => websites).toEqual([WEBSITE, 'https://example.test/next'])
    await panel.getByRole('button', { name: 'Hand back', exact: true }).click()
    await address.waitFor({ state: 'hidden' })
    const viewing = await captureStableAria(page, panelSelector, web.workspaceCwd)
    const unauthorized = await fetch(new URL('/api/computer/navigate', web.baseUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: bot.sessionId, viewerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', url: WEBSITE }),
    })
    expect(unauthorized.status).toBe(401)
    await panel.getByRole('button', { name: 'Close computer panel' }).click()
    await conversation.locator('[data-composer-input][contenteditable="true"]').fill('Use my saved login.')
    await conversation.getByRole('button', { name: 'Send message', exact: true }).click()
    const loginSelector = 'section[aria-label="Approve website sign-in"]'
    const approval = page.locator(loginSelector)
    await approval.waitFor()
    expect(await approval.locator('input').count()).toBe(0)
    const approvalLink = await approval.getByRole('link', { name: 'Approve sign-in' }).getAttribute('href')
    expect(approvalLink).toBe(`/__yharness/vault-login-use/${LOGIN.id}`)
    const loginRoute = `/api/bot-website-login?sessionId=${bot.sessionId}`
    expect((await fetch(new URL(loginRoute, web.baseUrl))).status).toBe(401)
    const loginMetadata = { id: LOGIN.id, origin: LOGIN.origin, destination: LOGIN.destination }
    expect(await (await web.hostFetch(loginRoute)).json()).toEqual({ request: loginMetadata })
    const review = await captureStableAria(page, loginSelector, web.workspaceCwd, { replacements: [[LOGIN.id, '{{id}}']] })
    loginApproved = true
    await conversation.getByText(LOGIN_REPLY, { exact: true }).waitFor()
    await approval.waitFor({ state: 'hidden' })

    const origin = new URL(web.baseUrl).origin
    const sharedCall = async (operation: string, payload: object, cookie?: string) => {
      const method = `bots/share/${operation}`
      const response = await fetch(new URL(`/shared-bots/${method}`, origin), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie === undefined ? {} : { Cookie: cookie }) },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
        signal: AbortSignal.timeout(15_000),
      }).catch((error: unknown) => { throw new Error(`Shared fixture request failed: ${method}`, { cause: error }) })
      const result = (await response.json() as { result: { ok: boolean; value?: { principalId?: string; recent?: unknown } } }).result
      return { response, result }
    }
    const ownerInvite = await web.ctx.bots.createShareInvite({ botId: BOT, role: 'owner' })
    expect((await sharedCall('enroll', { code: ownerInvite.code })).result.ok).toBe(true)
    const invite = await web.ctx.bots.createShareInvite({ botId: BOT, role: 'collaborator' })
    const member = await sharedCall('enroll', { code: invite.code })
    const cookie = member.response.headers.get('Set-Cookie')?.split(';', 1)[0]
    const principalId = member.result.value?.principalId
    if (!member.result.ok || cookie === undefined || principalId === undefined) throw new Error('Could not enroll the test collaborator')
    const chat = (text: string) => sharedCall('chat', { botId: BOT, text }, cookie)
    const recent = async (): Promise<string> => {
      const view = await sharedCall('read-private-chat', { botId: BOT }, cookie)
      return JSON.stringify(view.result.value?.recent ?? [])
    }
    const browserAccessPath = '/api/bot-browser-access'
    const access = async () => (await web.hostFetch(browserAccessPath)).json()
    const guestAccess = await fetch(new URL(browserAccessPath, origin), { headers: { Cookie: cookie } })
    expect(guestAccess.status).toBe(401)
    await expect(access()).resolves.toEqual({
      mode: 'managed', bots: [{ id: BOT, name: 'Browser Scout', sessionId: ownerSession, enabled: false }],
    })
    expect((await chat('Please check the browser setting in this shared chat.')).result.ok).toBe(true)
    await expect.poll(recent, { timeout: 10_000 }).toContain(BROWSER_DISABLED)
    expect(sharedRequests).toEqual([])
    sharingOverride = true
    await expect(access()).resolves.toMatchObject({ bots: [{ id: BOT, enabled: true }] })
    expect((await chat('Open the test site in this shared chat.')).result.ok).toBe(true)
    await expect.poll(recent).toContain(REPLY)
    const sharedSession = sharedRequests.find(request => request.action === 'navigate')?.session
    expect(sharedSession).toMatch(/^shared-session-/u)
    expect(websites).toEqual([WEBSITE, 'https://example.test/next', WEBSITE])

    expect((await chat('Use the saved login in this shared chat.')).result.ok).toBe(true)
    const sharedSelector = 'section[aria-label="Approve shared website sign-in"]'
    const sharedApproval = page.locator(sharedSelector)
    await sharedApproval.waitFor({ timeout: 15_000 })
    expect(await sharedApproval.getByRole('link', { name: 'Approve sign-in' }).getAttribute('href'))
      .toBe(`/__yharness/vault-login-use/${SHARED_LOGIN.id}`)
    const guestApproval = await fetch(new URL(loginRoute, origin), { headers: { Cookie: cookie } })
    expect(guestApproval.status).toBe(401)
    expect(await (await web.hostFetch(`/api/bot-website-login?sessionId=${sharedSession}`)).json()).toEqual({ request: null })
    const sharedReview = await captureStableAria(page, sharedSelector, web.workspaceCwd,
      { replacements: [[SHARED_LOGIN.id, '{{id}}']] })
    sharedApproved = true
    await expect.poll(recent, { timeout: 10_000 }).toContain(LOGIN_REPLY)
    await sharedApproval.waitFor({ state: 'hidden', timeout: 15_000 })
    expect(await recent()).not.toContain(SHARED_LOGIN.id)
    expect(sharedRequests).toContainEqual({ action: 'authorize-login', session: sharedSession })

    expect((await chat('Please take over the browser in this shared chat.')).result.ok).toBe(true)
    const handoffSelector = 'section[aria-label="Sign in to the shared browser"]'
    const handoffCard = page.locator(handoffSelector)
    await handoffCard.waitFor({ timeout: 15_000 })
    const handoffCardAria = await captureStableAria(page, handoffSelector, web.workspaceCwd)
    const body = (value: object): RequestInit => ({
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(value),
    })
    const statusBody = body({ action: 'status', sessionId: bot.sessionId })
    const signIn = '/api/computer/sign-in'
    const ownerResponse = await web.hostFetch(signIn, statusBody)
    expect(ownerResponse.ok).toBe(true)
    const metadata = await ownerResponse.json() as { request: { targetSessionId: string; origin: string } }
    const target = metadata.request.targetSessionId
    expect(target).toMatch(/^handoff-/u)
    expect(metadata.request.origin).toBe(LOGIN.origin)
    expect(handoffLease).toMatch(/^[a-f0-9]{32}$/u)
    expect(JSON.stringify(metadata)).not.toContain(handoffLease)
    expect(JSON.stringify(metadata)).not.toContain(sharedSession)
    const otherViewer = body({ sessionId: target, viewerId: randomUUID() })
    for (const [path, init] of [[signIn, statusBody], ['/api/computer/frame', otherViewer]] as const) {
      const headers = new Headers(init.headers)
      headers.set('Cookie', cookie)
      expect((await fetch(new URL(path, origin), { ...init, headers })).status).toBe(401)
    }
    await handoffCard.getByRole('button', { name: 'Take over' }).click()
    const screen = panel.getByRole('img', { name: 'Live computer screen' })
    await screen.waitFor()
    await expect.poll(async () => (await (await web.hostFetch('/api/computer/frame', otherViewer)).json()).jpeg).toBe('')
    await panel.getByText(LOGIN.origin, { exact: true }).waitFor()
    const handoffPanelAria = await captureStableAria(page, panelSelector, web.workspaceCwd)
    await screen.evaluate((image) => {
      const contents = new DataTransfer()
      contents.setData('text/plain', 'fixture-input')
      image.dispatchEvent(new ClipboardEvent('paste', { clipboardData: contents, bubbles: true, cancelable: true }))
    })
    await expect.poll(() => handoffInputs).toEqual([{ session: sharedSession, origin: LOGIN.origin }])
    const release = page.waitForResponse(response => response.url().endsWith('/api/computer/release-control') && response.ok(),
      { timeout: 10_000 })
    await panel.getByRole('button', { name: 'Close computer panel' }).click()
    await release
    expect(handoff).toBeDefined()
    await handoffCard.getByRole('button', { name: 'Take over' }).click()
    await screen.waitFor()
    await panel.getByRole('button', { name: 'I’m done' }).click()
    await expect.poll(recent, { timeout: 10_000 }).toContain(HANDOFF_REPLY)
    expect(await recent()).not.toContain(target)
    expect(await recent()).not.toContain(handoffLease)
    await panel.waitFor({ state: 'hidden' })
    await handoffCard.waitFor({ state: 'hidden' })
    expect((await web.hostFetch('/api/computer/frame', otherViewer)).status).toBe(409)
    expect(sharedRequests).toContainEqual({ action: 'end-handoff', session: sharedSession })

    sharingOverride = false
    await expect(access()).resolves.toMatchObject({ bots: [{ id: BOT, enabled: false }] })
    sharingOverride = true
    sharedApproved = false
    sharedAuthorized = false
    expect((await chat('Request the saved login again in this shared chat.')).result.ok).toBe(true)
    await sharedApproval.waitFor({ timeout: 15_000 })
    await web.ctx.bots.revokeShareMember({ botId: BOT, principalId: BotPrincipalId(principalId) })
    await sharedApproval.waitFor({ state: 'hidden', timeout: 15_000 })
    await expect.poll(() => sharedRequests).toContainEqual({ action: 'cancel-login', session: sharedSession })
    expect(sharedRequests.filter(request => request.action === 'authorize-login')).toHaveLength(1)
    expect(consoleLog.pageErrors).toEqual([])
    await compareOrRefreshGolden(GOLDEN,
      `## In control\n\n${controlling}\n\n## Watching\n\n${viewing}\n\n## Saved login approval\n\n${review}\n\n## Shared login approval\n\n${sharedReview}\n\n## Shared browser sign-in\n\n${handoffCardAria}\n\n## Shared browser in control\n\n${handoffPanelAria}`,
      MODE)
  } finally {
    try { await browser?.close() }
    finally {
      try { await scaffold?.close() }
      finally {
        for (const socket of sockets) socket.destroy()
        if (socketServer?.listening === true) await new Promise<void>(resolve => socketServer!.close(() => resolve()))
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})
