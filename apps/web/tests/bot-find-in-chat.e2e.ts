// Web e2e scenario: direct Bot search stays inside the selected Bot transcript
// and keeps the transient keyboard-first surface usable at desktop and narrow widths.
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createAssistantMessage, createUserMessage } from '@yharness/llm'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const SHOT_DIR = fileURLToPath(new URL('../../../.artifacts/screenshots/bot-find-in-chat', import.meta.url))

describe.skipIf(MODE === 'record')('web e2e: Find in this chat for a direct Bot', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let botId: string

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const bot = (await scaffold.ctx.bots.create({
      name: 'Find fixture', identity: 'round', accent: 'violet', cwd: scaffold.workspaceCwd,
    })).bot
    botId = String(bot.id)
    const session = scaffold.ctx.sessions.get(bot.sessionId)
    if (session === undefined) throw new Error('Find fixture Bot Session was not created')
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Find me in the direct chat.' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      stream: [], turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'The direct chat match is here.' }],
        source: { provider: 'fixture', model: 'fixture' },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(session)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('finds loaded messages without searching another workspace and adapts to narrow layout', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bot-find-in-chat'))
    const sidebar = page.locator('[data-yh-part="sidebar"]')
    await sidebar.getByRole('button', { name: 'Bots', exact: true }).click()
    const roster = sidebar.locator('aside[aria-label="Bot workspace"]')
    await roster.waitFor({ state: 'visible', timeout: 15_000 })
    await roster.locator(`[data-bot-id="${botId}"]`).click()
    const detail = page.locator('section[aria-label="Find fixture"]')
    await detail.waitFor({ state: 'visible', timeout: 15_000 })

    await page.keyboard.press('Control+f')
    const search = detail.getByRole('search', { name: 'Find in this chat' })
    await search.waitFor({ state: 'visible' })
    const input = search.getByRole('textbox', { name: 'Find in this chat' })
    await input.fill('direct chat')
    expect(await search.getByRole('status').textContent()).toBe('1 of 2')
    expect(await detail.locator('[data-chat-find-match]').count()).toBe(2)

    mkdirSync(SHOT_DIR, { recursive: true })
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe('')
    await page.screenshot({ path: `${SHOT_DIR}/desktop-dark.png`, fullPage: true, animations: 'disabled' })
    await page.setViewportSize({ width: 760, height: 900 })
    await page.screenshot({ path: `${SHOT_DIR}/narrow-dark.png`, fullPage: true, animations: 'disabled' })

    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBeNull()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.screenshot({ path: `${SHOT_DIR}/desktop-light.png`, fullPage: true, animations: 'disabled' })
    await page.setViewportSize({ width: 760, height: 900 })
    await page.screenshot({ path: `${SHOT_DIR}/narrow-light.png`, fullPage: true, animations: 'disabled' })

    await page.keyboard.press('Escape')
    expect(await search.count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)
})
