/** Verify the Bot browser panel through the real Cloud Host and browser worker protocol. */

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BotId, BotPrincipalId } from '@yharness/bots'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@yharness/llm'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/bot-workspace/session.v3.jsonl', import.meta.url))
const GOLDEN = fileURLToPath(new URL('./expected/bot-isolated-browser/browser.expected.md', import.meta.url))
const RUNTIME_SOURCE = new URL('../../../packages/bundle/web-app/lib/types/vps-runtime.js', import.meta.url).href
const BOTS_SOURCE = new URL('../../../packages/bundle/web-app/lib/types/vps-bots.js', import.meta.url).href
const BROKER_SOURCE = new URL('../../../packages/bundle/web-app/lib/types/vps-isolated-browser.js', import.meta.url).href
const VAULT_SOURCE = new URL('../../../packages/bundle/web-app/lib/types/vps-vault-requests.js', import.meta.url).href
const MODE = webSnapshotMode()
const BOT = BotId('bot-browser-fixture')
const NEW_BOT = BotId('bot-new-browser-fixture')
const PROVIDER = 'browser-fixture'
const MODEL = 'reply'
const WEBSITE = 'https://example.test/'
const REPLY = 'I opened the website.'
const DESKTOP_REPLY = 'I sent the key to my Linux desktop.'
const LOGIN = { id: 'a'.repeat(32), origin: 'https://example.test', destination: 'https://example.test/session', state: 'pending' }
const SHARED_LOGIN = { ...LOGIN, id: 'b'.repeat(32) }
const SECURE_FORMS = [
  {
    request: { ...LOGIN, id: 'd'.repeat(32), destination: 'https://example.test/signup', purpose: 'signup' },
    cue: 'secure signup', title: 'Approve website signup', action: 'Review signup', section: 'Signup approval',
    result: 'signup form was submitted', reply: 'The signup form was submitted. I’ll check the site.',
  },
  {
    request: { ...LOGIN, id: 'e'.repeat(32), destination: 'https://example.test/verify', purpose: 'verification' },
    cue: 'secure verification', title: 'Website verification', action: 'Enter code', section: 'Verification code',
    result: 'verification code was submitted', reply: 'I sent the verification code. I’ll check the site.',
  },
] as const
const SHARED_CHALLENGE = 'c'.repeat(32)
const LOGIN_REPLY = 'The login was submitted. I’ll check the page.'
const ROUTINE_NEEDS_OWNER = 'The scheduled check needs the owner to sign in.'
const ROUTINE_REPLY = 'The scheduled check used the saved login.'
const HANDOFF_REPLY = 'Thanks. I have the shared browser again.'
const BROWSER_DISABLED = 'Shared browsing is off.'
const CONTEXT_SOURCES: readonly string[] = ['repeat-tool-reminder', 'runtime-context']

class BrowserAdapter extends LlmAdapter {
  override async listModels(provider: string) {
    return [{ provider, id: MODEL, name: `${provider}/${MODEL}` }]
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const latestUser = options.messages.findLastIndex(message =>
      message.role === 'user' && !CONTEXT_SOURCES.includes(message.source?.kind ?? ''))
    const input = options.messages[latestUser]?.content.filter(block => block.type === 'text').map(block => block.text).join(' ') ?? ''
    const desktop = input.includes('Use the Linux desktop')
    const secureForm = SECURE_FORMS.find(form => input.includes(form.cue))
    const savedLogin = secureForm !== undefined || input.includes('saved login')
    const routine = input.includes('scheduled check')
    const unapproved = input.includes('without a grant')
    const handoff = input.includes('take over')
    const shared = input.includes('shared chat')
    const result = options.messages.slice(latestUser + 1).findLast(message => message.role === 'tool')
    const checkSharing = input.includes('check the browser setting')
    if (result === undefined && !checkSharing) {
      const id = ToolCallId(desktop ? 'fixture-desktop-input'
        : routine ? (unapproved ? 'fixture-routine-unapproved' : 'fixture-routine-approved')
          : handoff ? 'fixture-browser-handoff' : secureForm !== undefined ? `fixture-browser-${secureForm.request.purpose}`
            : savedLogin ? 'fixture-browser-login' : 'fixture-browser-navigation')
      const name = shared ? 'shared_browser' : 'vps_computer'
      const args = JSON.stringify(desktop ? { action: 'key', key: 'Escape', surface: 'desktop' }
        : handoff ? { action: 'request_sign_in' }
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
    } else if (desktop) {
      expect(result.content).toEqual([expect.objectContaining({ type: 'text', text: 'Computer input sent.' })])
    } else if (handoff) {
      const returned: unknown = expect.stringContaining('returned the Computer')
      expect(result.content).toEqual([expect.objectContaining({ type: 'text', text: returned })])
      expect(JSON.stringify(options.messages.slice(latestUser))).not.toContain('fixture-input')
    } else if (savedLogin) {
      const resultText = secureForm?.result ?? (unapproved ? 'This routine needs the owner' : 'sign-in submission')
      expect(result.content.some(block => block.type === 'text' && block.text.includes(resultText))).toBe(true)
      expect(JSON.stringify(result)).not.toContain(LOGIN.destination)
      expect(JSON.stringify(result)).not.toContain(LOGIN.id)
      expect(JSON.stringify(result)).not.toContain(SHARED_LOGIN.id)
      for (const { request } of SECURE_FORMS) {
        expect(JSON.stringify(result)).not.toContain(request.id)
        expect(JSON.stringify(result)).not.toContain(request.destination)
      }
    } else {
      expect(result.content.some(block => block.type === 'text' && block.text.includes('Browser'))).toBe(true)
    }
    const text = desktop ? DESKTOP_REPLY : checkSharing ? BROWSER_DISABLED : handoff ? HANDOFF_REPLY
      : routine ? (unapproved ? ROUTINE_NEEDS_OWNER : ROUTINE_REPLY) : secureForm?.reply ?? (savedLogin ? LOGIN_REPLY : REPLY)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it.skipIf(MODE === 'record' || process.platform === 'win32')('opens websites for an owner or collaborator and approves the exact Bot sign-in in Cloud', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yh-browser-web-'))
  const runtimePath = join(root, 'browser.mjs')
  const overlay = join(root, 'browser.yml')
  const socketPath = join(root, 'browser.sock')
  const desktopInput = join(root, 'desktop-input')
  const rosterDirectory = join(root, 'cloud')
  const ownerRosterPath = join(rosterDirectory, 'active.json')
  const websites: string[] = []
  const sharedRequests: Array<{ readonly action: string; readonly session: string }> = []
  const handoffInputs: Array<{ readonly session: string; readonly origin: string }> = []
  let handoff: { readonly lease: string; readonly session: string } | undefined
  let handoffLease: string | undefined
  let loginApproved = false
  let currentForm: typeof SECURE_FORMS[number]['request'] | undefined
  const approvedForms = new Set<string>()
  let automaticAllowed = false
  let automaticAttempts = 0
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
    const { jpeg, desktopJpeg } = await page.evaluate(() => {
      const image = document.createElement('canvas')
      image.width = 1280
      image.height = 800
      const canvas = image.getContext('2d')!
      const screenshot = (label: string, background: string, ink: string) => {
        canvas.fillStyle = background
        canvas.fillRect(0, 0, image.width, image.height)
        canvas.font = '40px sans-serif'
        canvas.fillStyle = ink
        canvas.fillText(label, 100, 180)
        const data = image.toDataURL('image/jpeg')
        return data.slice(data.indexOf(',') + 1)
      }
      return {
        jpeg: screenshot('Example website', '#f1f4fa', '#1c2233'),
        desktopJpeg: screenshot('Linux desktop fixture', '#151c2a', '#eef2f8'),
      }
    })
    await writeFile(desktopInput, '')
    await mkdir(rosterDirectory)
    await chmod(rosterDirectory, 0o2750)
    socketServer = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket)
      socket.once('close', () => { sockets.delete(socket) })
      socket.on('error', () => socket.destroy())
      let body = ''
      socket.setEncoding('utf8')
      socket.on('data', (value) => { body += value.toString() })
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
        const rosterText = readFileSync(ownerRosterPath, 'utf8')
        const ownerPairs = JSON.parse(rosterText) as readonly { readonly bot: string; readonly session: string }[]
        if (!ownerPairs.some(pair => pair.bot === request.bot && (shared || pair.session === request.session))
          || (shared && sharingOverride !== true)) {
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
          case 'request-login': response = shared ? SHARED_LOGIN : currentForm ?? LOGIN; break
          case 'automatic-login':
            automaticAttempts++
            response = !shared && request.bot === BOT && request.session === ownerSession && request.id === LOGIN.id
              ? { state: automaticAllowed ? 'submitted' : 'approval-required' } : { state: 'unavailable' }
            break
          case 'login-status':
            response = shared && sharedApproved && !sharedAuthorized
              ? { state: 'approval-pending', challenge: SHARED_CHALLENGE }
              : { state: (shared ? sharedAuthorized : request.id === LOGIN.id ? loginApproved
                : approvedForms.has(request.id ?? '')) ? 'submitted' : 'pending' }
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
      import { appendFile } from 'node:fs/promises'
      import { VpsRuntime } from ${JSON.stringify(RUNTIME_SOURCE)}
      import { mountVpsBots } from ${JSON.stringify(BOTS_SOURCE)}
      import { VpsIsolatedBrowser } from ${JSON.stringify(BROKER_SOURCE)}
      import { submitAutomaticVpsLogin } from ${JSON.stringify(VAULT_SOURCE)}
      export const name = 'isolated-browser-fixture'
      export function apply(ctx, config) {
        // The fixture provides the installed worker protocol on a temporary socket.
        ctx.effect(() => {
          const original = VpsIsolatedBrowser.prototype.usesManagedSharing
          const ensure = VpsRuntime.prototype.ensure
          const command = VpsRuntime.prototype.desktopCommand
          const network = VpsRuntime.prototype.supportsNetworkControl
          VpsIsolatedBrowser.prototype.usesManagedSharing = () => true
          VpsRuntime.prototype.ensure = () => Promise.resolve()
          VpsRuntime.prototype.desktopCommand = async (sessionId, argv) => {
            if (argv[0] === '/usr/local/bin/yharness-vps-bot-capture') {
              return Buffer.from(${JSON.stringify(desktopJpeg)}, 'base64')
            }
            await appendFile(${JSON.stringify(desktopInput)}, JSON.stringify({ sessionId, argv }) + '\\n')
            return Buffer.alloc(0)
          }
          VpsRuntime.prototype.supportsNetworkControl = () => true
          return () => {
            VpsIsolatedBrowser.prototype.usesManagedSharing = original
            VpsRuntime.prototype.ensure = ensure
            VpsRuntime.prototype.desktopCommand = command
            VpsRuntime.prototype.supportsNetworkControl = network
          }
        })
        mountVpsBots(ctx, config, [], undefined, undefined, (bot, session, id, signal) =>
          submitAutomaticVpsLogin(config.isolatedBrowser.socketPath, bot, session, id, signal))
      }
    `)
    await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'isolated-browser-fixture', name: pathToFileURL(runtimePath).href,
      config: { root: join(root, 'bots'), image: 'localhost/yharness-test', bots: [BOT], desktopOnlyBots: [BOT],
        desktopForUnlistedBots: true,
        isolatedBrowser: { bots: [], ownerRosterPath, socketPath, savedLogins: true } },
    }] }]))
    const web = scaffold = await launchWebScaffold({ extraOverlayPath: overlay, replayFixture: FIXTURE, replayProvidersOnly: true, toolsMode: 'native' })
    const adapter = new BrowserAdapter()
    web.ctx.effect(() => web.ctx.llm.registerAdapter([PROVIDER], adapter), 'Isolated Browser fixture model')
    await web.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
    const { bot } = await web.ctx.bots.create({ id: BOT, name: 'Browser Scout', cwd: web.workspaceCwd })
    ownerSession = bot.sessionId
    await expect.poll(async () => {
      const roster: unknown = JSON.parse(await readFile(ownerRosterPath, 'utf8'))
      return roster
    }, { timeout: 5000 }).toEqual([
      { bot: BOT, session: bot.sessionId },
    ])
    await page.goto(web.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-yh-part="sidebar"]').getByRole('button', { name: 'Bots', exact: true }).click()
    await page.locator(`[data-bot-id="${BOT}"]`).click()
    const conversation = page.locator('[data-conversation-surface="bots"]')
    await conversation.locator('[data-composer-input][contenteditable="true"]').fill('Open the test site.')
    await conversation.getByRole('button', { name: 'Send message', exact: true }).click()
    await conversation.getByText(REPLY, { exact: true }).waitFor()
    expect(websites).toEqual([WEBSITE])
    const { bot: addedBot } = await web.ctx.bots.create({ id: NEW_BOT, name: 'New browser Bot', cwd: web.workspaceCwd })
    const newComputer = await web.hostFetch('/api/computer/status', {
      method: 'POST', headers: { 'content-type': 'application/json', Origin: new URL(web.baseUrl).origin },
      body: JSON.stringify({ sessionId: addedBot.sessionId }),
    })
    await expect(newComputer.json()).resolves.toMatchObject({
      available: true, computer: { id: NEW_BOT, browser: true, desktop: true, restart: true },
    })
    expect(JSON.parse(await readFile(ownerRosterPath, 'utf8'))).toEqual([
      { bot: BOT, session: bot.sessionId },
      { bot: NEW_BOT, session: addedBot.sessionId },
    ])
    await page.getByRole('button', { name: 'Open computer panel', exact: true }).click()
    const panelSelector = '[data-computer-panel]'
    const panel = page.locator(panelSelector)
    await panel.getByRole('img', { name: 'Live computer screen' }).waitFor()
    const networkSwitch = panel.getByRole('switch', { name: 'Allow Internet for Terminal & apps', exact: true })
    await networkSwitch.waitFor()
    expect(await networkSwitch.isVisible()).toBe(true)
    expect(await networkSwitch.isChecked()).toBe(false)
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
    const screenshot = panel.getByRole('img', { name: 'Live computer screen' })
    await expect.poll(() => screenshot.getAttribute('src')).toBe('data:image/jpeg;base64,' + jpeg)
    await panel.getByRole('button', { name: 'Desktop', exact: true }).click()
    await expect.poll(() => screenshot.getAttribute('src')).toBe('data:image/jpeg;base64,' + desktopJpeg)
    const desktopViewing = await captureStableAria(page, panelSelector, web.workspaceCwd)
    await panel.getByRole('button', { name: 'Take control', exact: true }).click()
    await panel.getByRole('button', { name: 'Hand back', exact: true }).waitFor()
    expect(await panel.getByRole('textbox', { name: 'Website address' }).count()).toBe(0)
    await screenshot.press('Escape')
    await expect.poll(() => readFile(desktopInput, 'utf8')).toContain('"Escape"')
    await panel.getByRole('button', { name: 'Hand back', exact: true }).click()
    await panel.getByRole('button', { name: 'Browser', exact: true }).click()
    await expect.poll(() => screenshot.getAttribute('src')).toBe('data:image/jpeg;base64,' + jpeg)
    await conversation.locator('[data-composer-input][contenteditable="true"]').fill('Use the Linux desktop and press Escape.')
    await conversation.getByRole('button', { name: 'Send message', exact: true }).click()
    await conversation.getByText(DESKTOP_REPLY, { exact: true }).waitFor()
    const desktopCommands = (await readFile(desktopInput, 'utf8')).trim().split('\n').map((line): unknown => JSON.parse(line))
    const keyCommand: unknown = expect.arrayContaining(['key', 'Escape'])
    expect(desktopCommands).toEqual(Array.from({ length: 2 }, () => ({ sessionId: bot.sessionId, argv: keyCommand })))
    const unauthorizedDesktop = await fetch(new URL('/api/computer/frame', web.baseUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: bot.sessionId, viewerId: randomUUID(), surface: 'desktop' }),
    })
    expect(unauthorizedDesktop.status).toBe(401)
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

    const secureFormSnapshots: string[] = []
    for (const { request, cue, title, action, section, reply } of SECURE_FORMS) {
      currentForm = request
      await conversation.locator('[data-composer-input][contenteditable="true"]').fill(`Use ${cue} on the test website.`)
      await conversation.getByRole('button', { name: 'Send message', exact: true }).click()
      const selector = `section[aria-label="${title}"]`
      const card = page.locator(selector)
      const openReview = card.getByRole('link', { name: action })
      await openReview.waitFor()
      expect(await card.locator('input').count()).toBe(0)
      expect(await openReview.getAttribute('href')).toBe(`/__yharness/vault-login-use/${request.id}`)
      expect(await (await web.hostFetch(loginRoute)).json()).toEqual({
        request: { id: request.id, origin: request.origin, destination: request.destination, purpose: request.purpose },
      })
      const review = await captureStableAria(page, selector, web.workspaceCwd, { replacements: [[request.id, '{{id}}']] })
      secureFormSnapshots.push(`## ${section}\n\n${review}`)
      approvedForms.add(request.id)
      await conversation.getByText(reply, { exact: true }).waitFor()
      await card.waitFor({ state: 'hidden' })
    }
    currentForm = undefined

    await web.ctx.schedule.create(bot.sessionId, {
      title: 'Website check without approval', prompt: 'Use the saved login for this scheduled check without a grant.', after_seconds: 1,
    })
    const needsOwner = conversation.getByText(ROUTINE_NEEDS_OWNER, { exact: true })
    await needsOwner.waitFor()
    expect(await (await web.hostFetch(loginRoute)).json()).toEqual({ request: null })
    const unapprovedReply = await needsOwner.innerText()
    automaticAllowed = true
    await page.goto('about:blank')
    await web.ctx.schedule.create(bot.sessionId, {
      title: 'Approved website check', prompt: 'Use the saved login for this scheduled check.', after_seconds: 1,
    })
    await expect.poll(async () => (await web.ctx.sessionController.inspect(bot.sessionId)).events.some(event =>
      event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text' && block.text === ROUTINE_REPLY),
    ), { timeout: 15_000 }).toBe(true)
    expect(await (await web.hostFetch(loginRoute)).json()).toEqual({ request: null })
    await page.goto(web.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-yh-part="sidebar"]').getByRole('button', { name: 'Bots', exact: true }).click()
    await page.locator(`[data-bot-id="${BOT}"]`).click()
    const routineReply = await conversation.getByText(ROUTINE_REPLY, { exact: true }).innerText()

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
    const access = async (): Promise<unknown> => {
      const reply: unknown = await (await web.hostFetch(browserAccessPath)).json()
      return reply
    }
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
    await expect.poll(async () => {
      const frame: unknown = await (await web.hostFetch('/api/computer/frame', otherViewer)).json()
      return frame !== null && typeof frame === 'object' && 'jpeg' in frame ? frame.jpeg : undefined
    }).toBe('')
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
    expect(automaticAttempts).toBe(3)
    expect(consoleLog.pageErrors).toEqual([])
    await compareOrRefreshGolden(GOLDEN,
      [`## In control\n\n${controlling}`, `## Watching\n\n${viewing}`, `## Linux desktop\n\n${desktopViewing}`,
        `## Saved login approval\n\n${review}`, ...secureFormSnapshots,
        `## Scheduled login\n\n${unapprovedReply}\n\n${routineReply}`, `## Shared login approval\n\n${sharedReview}`,
        `## Shared browser sign-in\n\n${handoffCardAria}`, `## Shared browser in control\n\n${handoffPanelAria}`].join('\n\n'),
      MODE)
  } finally {
    try { await browser?.close() }
    finally {
      try { await scaffold?.close() }
      finally {
        for (const socket of sockets) socket.destroy()
        if (socketServer?.listening === true) await new Promise<void>((resolve) => { socketServer!.close(() => { resolve() }) })
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})
