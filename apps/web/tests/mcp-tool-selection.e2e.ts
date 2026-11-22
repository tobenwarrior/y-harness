/** Verify configured MCP tool restrictions through the Bot workspace and Host dispatch. */
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ToolCallId } from '@yharness/llm'
import type {} from '@yharness/bots'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it, vi } from 'vitest'
import { startHttpMcpFixture } from '../../../packages/mcp/mcp-client/tests/http-fixture.ts'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const bundle = fileURLToPath(new URL('./fixtures/plugins/fixture-mcp-actions', import.meta.url))
const expected = fileURLToPath(new URL('./expected/mcp-tool-selection/actions.expected.md', import.meta.url))
const replayFixture = fileURLToPath(new URL('../../../snapshots/web/bot-workspace/session.v3.jsonl', import.meta.url))
const endpoint = 'https://tool-selection.example.test/mcp'

it.skipIf(webSnapshotMode() === 'record')('manages individual MCP actions without changing a Bot’s app grant', async () => {
  const mcp = await startHttpMcpFixture(['ping', 'inspect_record'])
  const fetchLocal = globalThis.fetch
  const fetchFixture = vi.spyOn(globalThis, 'fetch').mockImplementation((target, init) => {
    const url = typeof target === 'string' ? target : target instanceof URL ? target.href : target.url
    return fetchLocal(url === endpoint ? mcp.url : target, init)
  })
  let web: WebScaffold | undefined
  let browser: Browser | undefined
  let failurePage: Page | undefined
  try {
    web = await launchWebScaffold({
      profile: { packages: [{ dir: bundle, enabled: true }] },
      replayFixture,
      replayProvidersOnly: true,
    })
    const host = web.ctx
    const scout = (await host.bots.create({ name: 'Scout', identity: 'browse', accent: 'teal', cwd: web.workspaceCwd })).bot
    const owner = await host.sessionController.resolveAgent(scout.sessionId)
    if (!('agent' in owner)) throw owner.error
    const run = (name: string) => host.tools.execute({
      name, arguments: {}, callId: ToolCallId(randomUUID()), signal: AbortSignal.timeout(5_000), agent: owner.agent,
    })
    const retained = 'mcp__workspace-fixture__ping'
    const blocked = 'mcp__workspace-fixture__inspect_record'
    const independent = 'mcp__review-fixture__inspect_record'
    expect(host.tools.get(retained)).toBeDefined()
    expect(host.tools.get(blocked)).toBeUndefined()
    expect(host.tools.get(independent)).toBeDefined()
    await expect(run(retained)).resolves.toMatchObject({ isError: true })
    expect(mcp.calls).toEqual([])

    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    failurePage = page
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.route('**/api/skill-compound.update', route => route.fulfill({ json: {
      vendored: '0.11.0', upstream: '0.11.0', updateAvailable: false, repository: 'example/skills', checkedAt: 1, error: null,
    } }))
    const tripwire = watchConsole(page)
    await page.goto(web.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-yh-part="sidebar"]').getByRole('button', { name: 'Bots', exact: true }).click()
    await page.getByRole('button', { name: 'Bot actions for Scout', exact: true }).click()
    await page.getByRole('menuitem', { name: 'App access', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Connected apps', exact: true })
    for (const name of ['workspace-fixture', 'review-fixture']) {
      const row = dialog.getByRole('listitem').filter({ has: page.locator(`[data-app-id="${name}"]`) })
      await row.getByRole('button', { name: /^Grant access to / }).click()
      await row.getByRole('button', { name: /^Revoke access to / }).waitFor()
    }
    await expect(run(retained)).resolves.toMatchObject({ isError: false })
    await expect(run(blocked)).resolves.toMatchObject({ isError: true })
    await expect(run(independent)).resolves.toMatchObject({ isError: false })
    expect(mcp.calls).toEqual(['ping', 'inspect_record'])

    await dialog.getByRole('button', { name: 'Manage actions', exact: true }).click()
    const actions = page.getByRole('dialog')
    const workspace = actions.getByRole('group', { name: /^(Workspace Fixture|workspace-fixture)$/u })
    const inspect = workspace.getByRole('switch', { name: 'inspect_record', exact: true })
    const ping = workspace.getByRole('switch', { name: 'ping', exact: true })
    await expect.poll(() => inspect.getAttribute('aria-checked')).toBe('false')
    await inspect.click()
    await expect.poll(() => inspect.getAttribute('aria-checked')).toBe('true')
    await expect(run(blocked)).resolves.toMatchObject({ isError: false })
    await inspect.click()
    await expect.poll(() => inspect.getAttribute('aria-checked')).toBe('false')
    await ping.click()
    await expect.poll(() => ping.getAttribute('aria-checked')).toBe('false')
    await expect(run(retained)).resolves.toMatchObject({ isError: true })
    await expect(run(blocked)).resolves.toMatchObject({ isError: true })
    await ping.click()
    await expect.poll(() => ping.getAttribute('aria-checked')).toBe('true')
    await expect(run(retained)).resolves.toMatchObject({ isError: false })
    expect(mcp.calls).toEqual(['ping', 'inspect_record', 'inspect_record', 'ping'])
    await compareOrRefreshGolden(expected, (await workspace.ariaSnapshot()).trimEnd(), webSnapshotMode())

    const output = process.env.YHARNESS_MCP_TOOL_SELECTION_SCREENSHOTS
    if (output !== undefined) {
      await mkdir(output, { recursive: true })
      await page.screenshot({ path: join(output, 'bots-app-actions-desktop-dark.png'), animations: 'disabled' })
      await page.setViewportSize({ width: 480, height: 900 })
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
      await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(false)
      await page.screenshot({ path: join(output, 'bots-app-actions-narrow-light.png'), animations: 'disabled' })
    }
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (failurePage !== undefined) await saveFailureShot(failurePage, 'mcp-tool-selection').catch(() => undefined)
    throw error
  } finally {
    try {
      await browser?.close()
    } finally {
      try {
        await web?.close()
      } finally {
        fetchFixture.mockRestore()
        await mcp.close()
      }
    }
  }
})
