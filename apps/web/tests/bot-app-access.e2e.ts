/** Assembled browser acceptance for Bot grants on newly configured MCP apps. */
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { defineTool } from '@yharness/tools'
import type {} from '@yharness/bots'
import {
  compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const expected = new URL('./expected/bot-app-access/connected.expected.md', import.meta.url).pathname

function registerApp(web: WebScaffold, id: 'cloudflare' | 'github'): void {
  web.ctx.effect(() => web.ctx.tools.register({
    ...defineTool({
      name: 'mcp__' + id + '__fixture_read',
      description: 'Read an item from the test connector.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_arguments, value) => [{ type: 'text', text: value }] },
      execute: async () => 'Fixture result',
    }),
    source: { kind: 'mcp', serverName: id },
  }), 'test app connection')
}

async function openAppAccess(page: Page, name: string): Promise<Locator> {
  await page.getByRole('button', { name: 'Bot actions for ' + name, exact: true }).click()
  await page.getByRole('menuitem', { name: 'App access', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Connected apps', exact: true })
  await dialog.getByRole('button', { name: 'Revoke access to Cloudflare', exact: true }).waitFor()
  return dialog
}

it('shows a new GitHub connector and saves access independently for each Bot', async () => {
  const web = await launchWebScaffold({})
  let browser: Browser | undefined
  try {
    const scout = (await web.ctx.bots.create({
      name: 'Scout', identity: 'browse', accent: 'teal', cwd: web.workspaceCwd,
    })).bot
    const reviewer = (await web.ctx.bots.create({
      name: 'Reviewer', identity: 'goal', accent: 'amber', cwd: web.workspaceCwd,
    })).bot
    registerApp(web, 'cloudflare')
    await web.ctx.bots.setConnectedAppAccess({ botId: scout.id, appId: 'cloudflare', allowed: true })
    await web.ctx.bots.setConnectedAppAccess({ botId: reviewer.id, appId: 'cloudflare', allowed: true })
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 1440, height: 960 })
    const tripwire = watchConsole(page)
    await page.goto(web.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-yh-part="sidebar"]').getByRole('button', { name: 'Bots', exact: true }).click()
    const initial = await openAppAccess(page, scout.name)
    const initialApps = initial.getByRole('list', { name: 'Connected apps', exact: true })
    expect(await initialApps.getByRole('listitem').count()).toBe(1)
    expect(await initial.getByText('Available on this Host', { exact: true }).count()).toBe(1)
    const screenshots = process.env.YHARNESS_CONNECTOR_SCREENSHOTS
    await initial.getByRole('button', { name: 'Done', exact: true }).click()

    registerApp(web, 'github')
    const apps = await openAppAccess(page, scout.name)
    const grant = apps.getByRole('button', { name: 'Grant access to GitHub', exact: true })
    await grant.waitFor()
    const appList = apps.getByRole('list', { name: 'Connected apps', exact: true })
    expect(await appList.locator('[data-app-id="github"] svg').count()).toBe(1)
    expect(await appList.getByRole('listitem').count()).toBe(2)
    expect(await apps.getByText('Available on this Host', { exact: true }).count()).toBe(2)
    expect(await apps.getByRole('button', { name: 'Connect GitHub', exact: true }).count()).toBe(0)
    expect(await apps.getByText('Host connection', { exact: true }).count()).toBe(1)
    expect(await apps.getByText('Bot access', { exact: true }).count()).toBe(1)
    await grant.click()
    await apps.getByRole('button', { name: 'Revoke access to GitHub', exact: true }).waitFor()
    const policy = await web.ctx.bots.listConnectedApps({ botId: scout.id })
    expect(policy.apps.map(app => [app.name, app.allowed])).toEqual([
      ['Cloudflare', true], ['GitHub', true],
    ])
    await compareOrRefreshGolden(expected, (await apps.ariaSnapshot()).trimEnd(), webSnapshotMode())
    if (screenshots !== undefined) {
      await page.screenshot({ path: join(screenshots, 'apps-desktop-dark.png'), animations: 'disabled' })
      await page.emulateMedia({ colorScheme: 'light' })
      await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(false)
      await page.screenshot({ path: join(screenshots, 'apps-desktop-light.png'), animations: 'disabled' })
      await page.emulateMedia({ colorScheme: 'dark' })
      await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(true)
    }

    await apps.getByRole('button', { name: 'Done', exact: true }).click()
    const independent = await openAppAccess(page, reviewer.name)
    expect(await independent.getByRole('button', { name: 'Grant access to GitHub', exact: true }).count()).toBe(1)
    await independent.getByRole('button', { name: 'Done', exact: true }).click()

    const reopened = await openAppAccess(page, scout.name)
    await reopened.getByRole('button', { name: 'Revoke access to GitHub', exact: true }).waitFor()
    await page.setViewportSize({ width: 480, height: 900 })
    const bounds = await reopened.boundingBox()
    expect(bounds).not.toBeNull()
    if (bounds === null) throw new Error('Bot app access dialog is not visible')
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(480)
    const accessHeading = reopened.getByText('Bot access', { exact: true })
    const accessButton = reopened.getByRole('button', { name: 'Revoke access to GitHub', exact: true })
    const accessHeadingBox = await accessHeading.boundingBox()
    const accessButtonBox = await accessButton.boundingBox()
    expect(accessHeadingBox).not.toBeNull()
    expect(accessButtonBox).not.toBeNull()
    if (accessHeadingBox === null || accessButtonBox === null) throw new Error('Bot access controls are not visible')
    expect(Math.abs(accessHeadingBox.x - accessButtonBox.x)).toBeLessThanOrEqual(1)
    if (screenshots !== undefined) {
      await page.screenshot({ path: join(screenshots, 'apps-480-dark.png'), animations: 'disabled' })
      await page.emulateMedia({ colorScheme: 'light' })
      await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(false)
      await page.screenshot({ path: join(screenshots, 'apps-480-light.png'), animations: 'disabled' })
    }
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser?.close()
    await web.close()
  }
})
