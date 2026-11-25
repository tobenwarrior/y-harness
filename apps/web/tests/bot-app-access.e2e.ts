/** Assembled browser acceptance for Bot grants on newly configured MCP apps. */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { expect, it, vi } from 'vitest'
import { credentialRef } from '@yharness/credentials'
import { ToolCallId } from '@yharness/llm'
import { defineTool } from '@yharness/tools'
import type {} from '@yharness/bots'
import { startHttpMcpFixture } from '../../../packages/mcp/mcp-client/tests/http-fixture.ts'
import {
  compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const expected = new URL('./expected/bot-app-access/connected.expected.md', import.meta.url).pathname
const overlay = fileURLToPath(new URL('./fixtures/bot-app-reference.patch.yml', import.meta.url))
const replayFixture = fileURLToPath(new URL('../../../snapshots/web/bot-workspace/session.v3.jsonl', import.meta.url))
const endpoint = 'https://bot-app-fixture.example.test/mcp'
const reference = credentialRef('DSH_BOT_APP_E2E_KEY')
const toolName = 'mcp__github__ping'
const originalKey = 'initial-bot-app.fixture'
const rotatedKey = 'rotated-bot-app.fixture'
const reconnectedKey = 'reconnected-bot-app.fixture'

function registerCloudflareApp(web: WebScaffold): void {
  web.ctx.effect(() => web.ctx.tools.register({
    ...defineTool({
      name: 'mcp__cloudflare__fixture_read',
      description: 'Read an item from the test connector.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_arguments, value) => [{ type: 'text', text: value }] },
      execute: async () => 'Fixture result',
    }),
    source: { kind: 'mcp', serverName: 'cloudflare' },
  }), 'test app connection')
}

async function openAppAccess(page: Page, name: string): Promise<Locator> {
  await page.getByRole('button', { name: 'Bot actions for ' + name, exact: true }).click()
  await page.getByRole('menuitem', { name: 'App access', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connected apps', exact: true })
  await dialog.getByRole('button', { name: 'Revoke access to Cloudflare', exact: true }).waitFor()
  return dialog
}

it.skipIf(webSnapshotMode() === 'record')('connects, replaces, and removes a GitHub credential without losing Bot app access settings', async () => {
  const server = await startHttpMcpFixture()
  const fetchLocal = globalThis.fetch
  const fixtureFetch = vi.spyOn(globalThis, 'fetch').mockImplementation((target, init) => {
    const url = target instanceof URL ? target.href : target
    return fetchLocal(url === endpoint ? server.url : target, init)
  })
  let web: WebScaffold | undefined
  let browser: Browser | undefined
  try {
    web = await launchWebScaffold({ extraOverlayPath: overlay, replayFixture, replayProvidersOnly: true })
    const host = web.ctx
    const scout = (await web.ctx.bots.create({
      name: 'Scout', identity: 'browse', accent: 'teal', cwd: web.workspaceCwd,
    })).bot
    const reviewer = (await web.ctx.bots.create({
      name: 'Reviewer', identity: 'goal', accent: 'amber', cwd: web.workspaceCwd,
    })).bot
    registerCloudflareApp(web)
    await web.ctx.bots.setConnectedAppAccess({ botId: scout.id, appId: 'cloudflare', allowed: true })
    await web.ctx.bots.setConnectedAppAccess({ botId: reviewer.id, appId: 'cloudflare', allowed: true })
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.route('**/api/skill-compound.update', route => route.fulfill({ json: {
      vendored: '0.11.0', upstream: '0.11.0', updateAvailable: false, repository: 'example/skills',
      checkedAt: 1, error: null,
    } }))
    const tripwire = watchConsole(page)
    await page.goto(web.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-yh-part="sidebar"]').getByRole('button', { name: 'Bots', exact: true }).click()
    const initial = await openAppAccess(page, scout.name)
    await initial.getByRole('button', { name: 'Grant access to GitHub', exact: true }).waitFor()
    const screenshots = process.env.YHARNESS_CONNECTOR_SCREENSHOTS
    if (screenshots !== undefined) {
      await page.screenshot({ path: join(screenshots, 'apps-existing.png'), animations: 'disabled' })
    }
    await initial.getByRole('button', { name: 'Done', exact: true }).click()

    expect(host.tools.get(toolName)).toBeUndefined()
    expect(server.authorization).toEqual([])
    const connect = async (key: string): Promise<void> => {
      const before = server.authorization.length
      await host.credentials.set(reference, key)
      await expect.poll(() => host.tools.get(toolName) && server.authorization.length > before).toBe(true)
      expect([...new Set(server.authorization.slice(before))]).toEqual([`Bearer ${key}`])
    }
    await connect(originalKey)
    const apps = await openAppAccess(page, scout.name)
    const grant = apps.getByRole('button', { name: 'Grant access to GitHub', exact: true })
    await grant.waitFor()
    expect(await apps.locator('[data-app-id="github"] svg').count()).toBe(1)
    const owner = await host.sessionController.resolveAgent(scout.sessionId)
    if (!('agent' in owner)) throw owner.error
    const ping = (id: string) => host.tools.execute({
      name: toolName, arguments: {}, callId: ToolCallId(id), signal: AbortSignal.timeout(5_000), agent: owner.agent,
    })
    await expect(ping('ungranted-bot-app')).resolves.toMatchObject({ isError: true })
    expect(server.calls).toEqual([])
    await grant.click()
    await apps.getByRole('button', { name: 'Revoke access to GitHub', exact: true }).waitFor()
    const policy = await web.ctx.bots.listConnectedApps({ botId: scout.id })
    expect(policy.apps.map(app => [app.name, app.allowed])).toEqual([
      ['Cloudflare', true], ['GitHub', true],
    ])
    await expect(ping('initial-bot-app')).resolves.toMatchObject({
      isError: false, content: [{ type: 'text', text: 'pong' }],
    })
    await connect(rotatedKey)
    await expect(ping('rotated-bot-app')).resolves.toMatchObject({
      isError: false, content: [{ type: 'text', text: 'pong' }],
    })
    expect(server.authorization.at(-1)).toBe(`Bearer ${rotatedKey}`)

    await host.credentials.unset(reference)
    await expect.poll(() => host.tools.get(toolName)).toBeUndefined()
    const disconnectedRequests = server.authorization.length
    await expect(ping('disconnected-bot-app')).resolves.toMatchObject({ isError: true })
    expect(server.authorization).toHaveLength(disconnectedRequests)
    await connect(reconnectedKey)
    await expect(ping('reconnected-bot-app')).resolves.toMatchObject({
      isError: false, content: [{ type: 'text', text: 'pong' }],
    })
    expect(server.authorization.at(-1)).toBe(`Bearer ${reconnectedKey}`)
    expect(server.calls).toEqual(['ping', 'ping', 'ping'])
    await compareOrRefreshGolden(expected, (await apps.ariaSnapshot()).trimEnd(), webSnapshotMode())
    if (screenshots !== undefined) {
      await page.screenshot({ path: join(screenshots, 'apps-desktop.png'), animations: 'disabled' })
    }

    await apps.getByRole('button', { name: 'Done', exact: true }).click()
    const independent = await openAppAccess(page, reviewer.name)
    expect(await independent.getByRole('button', { name: 'Grant access to GitHub', exact: true }).count()).toBe(1)
    await independent.getByRole('button', { name: 'Done', exact: true }).click()

    const reopened = await openAppAccess(page, scout.name)
    await reopened.getByRole('button', { name: 'Revoke access to GitHub', exact: true }).waitFor()
    await page.setViewportSize({ width: 720, height: 900 })
    const bounds = await reopened.boundingBox()
    expect(bounds).not.toBeNull()
    if (bounds === null) throw new Error('Bot app access dialog is not visible')
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(720)
    if (screenshots !== undefined) {
      await page.screenshot({ path: join(screenshots, 'apps-narrow.png'), animations: 'disabled' })
      await page.emulateMedia({ colorScheme: 'light' })
      await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(false)
      await page.screenshot({ path: join(screenshots, 'apps-light.png'), animations: 'disabled' })
    }
    expect(await reopened.innerText()).not.toContain('.fixture')
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    try {
      await browser?.close()
    } finally {
      try {
        await web?.close()
      } finally {
        fixtureFetch.mockRestore()
        await server.close()
      }
    }
  }
})
