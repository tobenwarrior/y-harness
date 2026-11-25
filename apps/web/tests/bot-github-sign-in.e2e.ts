/** Device sign-in and Bot permissions through the shipped Web profile. */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@yharness/llm'
import { API_PATH, SHARED_BOTS_PATH } from '@yharness/client-connection'
import type {} from '@yharness/bots'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { expect, it, vi } from 'vitest'
import { startHttpMcpFixture } from '../../../packages/mcp/mcp-client/tests/http-fixture.ts'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const overlay = fileURLToPath(new URL('../../cli/config/examples/mcp-connectors/github-account.cordis.yml', import.meta.url))
const replayFixture = fileURLToPath(new URL('../../../snapshots/web/bot-workspace/session.v3.jsonl', import.meta.url))
const expectedCard = fileURLToPath(new URL('./expected/bot-github-sign-in/connect-card.expected.md', import.meta.url))
const mcpEndpoint = 'https://api.githubcopilot.com/mcp/'
const verificationPage = 'https://github.com/login/device'
const fakeAccessToken = 'github-access.e2e-only'
const reconnectedToken = 'github-reconnected.e2e-only'
const fakeRefreshToken = 'github-refresh.e2e-only'
const pingTool = 'mcp__github__ping'
const connectTool = 'request_app_connection'

it.skipIf(webSnapshotMode() === 'record')('signs in to GitHub without changing individual Bot grants', async () => {
  const mcp = await startHttpMcpFixture()
  const fetchLocal = globalThis.fetch
  let createdCodes = 0
  let approved = false
  const fixtureFetch = vi.spyOn(globalThis, 'fetch').mockImplementation((target, init) => {
    const url = typeof target === 'string' ? target : target instanceof URL ? target.href : target.url
    if (url === `${verificationPage}/code`) {
      const serial = ++createdCodes
      return Promise.resolve(Response.json({
        device_code: `private-device-${String(serial)}`,
        user_code: `TEST-000${String(serial)}`,
        verification_uri: verificationPage,
        expires_in: 60,
        interval: 1,
      }))
    }
    if (url === 'https://github.com/login/oauth/access_token') {
      const reply = approved
        ? { access_token: createdCodes === 3 ? reconnectedToken : fakeAccessToken, token_type: 'bearer', expires_in: 28_800,
          refresh_token: fakeRefreshToken, refresh_token_expires_in: 15_897_600 }
        : { error: 'authorization_pending' }
      return Promise.resolve(Response.json(reply))
    }
    if (url === mcpEndpoint) return fetchLocal(mcp.url, init)
    return fetchLocal(target, init)
  })
  vi.stubEnv('YH_GITHUB_APP_CLIENT_ID', 'Iv23SyntheticDeviceFixture')
  let web: WebScaffold | undefined
  let browser: Browser | undefined
  let failurePage: Page | undefined
  let tripwire: ReturnType<typeof watchConsole> | undefined
  try {
    web = await launchWebScaffold({ extraOverlayPath: overlay, replayFixture, replayProvidersOnly: true })
    const host = web.ctx
    const signInMethod = 'account/startGitHubAppSignIn'
    const origin = new URL(web.baseUrl).origin
    const call = (path: string, method: string, payload: object, cookie?: string) => fetch(new URL(`${path}/${method}`, origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: origin, ...(cookie === undefined ? {} : { Cookie: cookie }) },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
      signal: AbortSignal.timeout(10_000),
    })
    expect((await call(API_PATH, signInMethod, { args: {} })).status).toBe(401)
    const scout = (await host.bots.create({ name: 'Scout', identity: 'browse', accent: 'teal', cwd: web.workspaceCwd })).bot
    const orbit = (await host.bots.create({ name: 'Orbit', identity: 'goal', accent: 'violet', cwd: web.workspaceCwd })).bot
    const enroll = async (role: 'owner' | 'collaborator') => {
      const invite = await host.bots.createShareInvite({ botId: scout.id, role })
      const response = await call(SHARED_BOTS_PATH, 'bots/share/enroll', { code: invite.code })
      expect(await response.json()).toMatchObject({ result: { ok: true } })
      const cookie = response.headers.get('Set-Cookie')?.split(';', 1)[0]
      if (cookie === undefined) throw new Error('Missing fixture enrollment cookie')
      return cookie
    }
    await enroll('owner')
    const collaborator = await enroll('collaborator')
    expect((await call(API_PATH, signInMethod, { args: {} }, collaborator)).status).toBe(401)
    const sharedAttempt = await call(SHARED_BOTS_PATH, signInMethod, { args: {} }, collaborator)
    expect(await sharedAttempt.json()).toMatchObject({ result: { ok: false, error: { code: 'gateway/forbidden' } } })
    const owner = await host.sessionController.resolveAgent(scout.sessionId)
    if (!('agent' in owner)) throw owner.error
    const session = owner.agent.session
    const connectCall = ToolCallId('github-connection-request')
    const connectArgs = { appId: 'github' }
    const request = await host.tools.execute({
      name: connectTool, arguments: connectArgs, callId: connectCall,
      signal: AbortSignal.timeout(5_000), agent: owner.agent,
    })
    expect(request).toMatchObject({ isError: false, meta: { appId: 'github', status: 'sign-in-required' } })
    if (request.isError || request.meta === undefined) throw new Error('Missing GitHub connection presentation')
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Connect GitHub so I can check a repository.' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    const args = JSON.stringify(connectArgs)
    session.append('assistant/message', {
      stream: [], turn: 1, step: 1,
      message: createAssistantMessage({
        source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        content: [{ type: 'tool-call', name: connectTool, id: connectCall, arguments: args }],
      }),
    }, { surfaceOp: 'append' })
    const event = session.append('tool/call', { turn: 1, step: 1, callId: connectCall, name: connectTool, arguments: args })
    session.append('tool/result', {
      turn: 1, step: 1, meta: request.meta,
      message: createToolResultMessage({ callId: connectCall, content: request.content, isError: false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [event.seq] })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(createdCodes).toBe(0)
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    failurePage = page
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.route('**/api/skill-compound.update', route => route.fulfill({ json: {
      vendored: '0.11.0', upstream: '0.11.0', updateAvailable: false, repository: 'example/skills', checkedAt: 1, error: null,
    } }))
    tripwire = watchConsole(page)
    await page.goto(web.authenticatedUrl, { waitUntil: 'load' })
    const sidebar = page.locator('[data-yh-part="sidebar"]')
    await sidebar.getByRole('button', { name: 'Bots', exact: true }).click()
    const roster = sidebar.getByRole('complementary', { name: 'Bot workspace', exact: true })
    const card = page.getByRole('region', { name: 'GitHub access', exact: true })
    await roster.getByRole('button', { name: /^Orbit\b/ }).click()
    await page.getByRole('region', { name: 'Orbit', exact: true }).waitFor()
    expect(await card.count()).toBe(0)
    await roster.getByRole('button', { name: /^Scout\b/ }).click()
    const cardStart = card.getByRole('button', { name: 'Connect GitHub', exact: true })
    await cardStart.waitFor()
    expect(createdCodes).toBe(0)
    expect(mcp.authorization).toEqual([])
    expect(host.tools.get(pingTool)).toBeUndefined()
    await compareOrRefreshGolden(expectedCard, (await card.ariaSnapshot()).trimEnd(), webSnapshotMode())

    const screenshots = process.env.YHARNESS_GITHUB_SIGN_IN_SCREENSHOTS
    if (screenshots !== undefined) {
      await mkdir(screenshots, { recursive: true })
      await page.screenshot({ path: join(screenshots, 'github-connect-card-desktop-dark.png'), animations: 'disabled' })
    }
    await cardStart.click()
    const code = card.getByText('TEST-0001', { exact: true })
    await code.waitFor()
    const verification = card.getByRole('link', { name: /GitHub/ })
    expect(await verification.getAttribute('href')).toBe(verificationPage)
    if (screenshots !== undefined) {
      await page.screenshot({ path: join(screenshots, 'github-sign-in-desktop-dark.png'), animations: 'disabled' })
    }
    await page.setViewportSize({ width: 480, height: 900 })
    expect(await code.evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      return range.getClientRects().length
    })).toBe(1)
    expect(await card.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return bounds.x >= 0 && bounds.right <= window.innerWidth && bounds.height <= window.innerHeight
    })).toBe(true)
    if (screenshots !== undefined) {
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
      await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(false)
      await page.screenshot({ path: join(screenshots, 'github-sign-in-narrow-light.png'), animations: 'disabled' })
    }
    await card.getByRole('button', { name: 'Cancel sign-in', exact: true }).click()
    await cardStart.waitFor()
    expect(mcp.authorization).toEqual([])
    expect(await card.getByText('TEST-0001', { exact: true }).count()).toBe(0)

    await page.setViewportSize({ width: 1440, height: 960 })
    await cardStart.click()
    await card.getByText('TEST-0002', { exact: true }).waitFor()
    approved = true
    await card.getByText('Connected', { exact: true }).waitFor()
    if (screenshots !== undefined) {
      await page.screenshot({ path: join(screenshots, 'github-connected-desktop-light.png'), animations: 'disabled' })
    }
    await page.getByRole('button', { name: 'Bot actions for Scout', exact: true }).click()
    await page.getByRole('menuitem', { name: 'App access', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Connected apps', exact: true })
    const start = dialog.getByRole('button', { name: 'Connect GitHub', exact: true })
    const disconnect = dialog.getByRole('button', { name: 'Disconnect', exact: true })
    await disconnect.waitFor()
    await expect.poll(() => host.tools.get(pingTool)).toBeDefined()
    const ping = (id: string) => host.tools.execute({
      name: pingTool, arguments: {}, callId: ToolCallId(id), signal: AbortSignal.timeout(5_000), agent: owner.agent,
    })
    await expect(ping('github-before-bot-grant')).resolves.toMatchObject({ isError: true })
    expect(mcp.calls).toEqual([])
    await dialog.getByRole('button', { name: 'Grant access to GitHub', exact: true }).click()
    const revoke = dialog.getByRole('button', { name: 'Revoke access to GitHub', exact: true })
    await revoke.waitFor()
    await expect(ping('github-after-bot-grant')).resolves.toMatchObject({
      isError: false, content: [{ type: 'text', text: 'pong' }],
    })
    expect(mcp.authorization.at(-1)).toBe(`Bearer ${fakeAccessToken}`)
    expect((await host.bots.listConnectedApps({ botId: orbit.id })).apps).toContainEqual({ id: 'github', name: 'GitHub', allowed: false })
    const visible = await dialog.innerText()
    expect(visible).not.toContain(fakeAccessToken)
    expect(visible).not.toContain(fakeRefreshToken)
    expect(visible).not.toContain('private-device-')

    await disconnect.click()
    await start.waitFor()
    await expect.poll(() => host.tools.get(pingTool)).toBeUndefined()
    await revoke.waitFor()

    approved = false
    await start.click()
    await dialog.getByText('TEST-0003', { exact: true }).waitFor()
    approved = true
    await disconnect.waitFor()
    await expect.poll(() => host.tools.get(pingTool)).toBeDefined()
    await revoke.waitFor()
    await expect(ping('github-after-reconnect')).resolves.toMatchObject({ isError: false })
    expect(mcp.authorization.at(-1)).toBe(`Bearer ${reconnectedToken}`)
    expect(createdCodes).toBe(3)
    expect(mcp.calls).toEqual(['ping', 'ping'])
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'bot-github-sign-in').catch(() => undefined)
    if (tripwire !== undefined && tripwire.pageErrors.length > 0) {
      throw new Error(`GitHub sign-in preview page errors:\n${tripwire.pageErrors.join('\n')}`, { cause: error })
    }
    throw error
  } finally {
    try {
      await browser?.close()
    } finally {
      try {
        await web?.close()
      } finally {
        vi.unstubAllEnvs()
        fixtureFetch.mockRestore()
        await mcp.close()
      }
    }
  }
})
