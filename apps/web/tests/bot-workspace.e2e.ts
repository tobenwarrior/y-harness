// Keyless assembled-browser coverage for the Bot roster and its one-to-one
// embedded Conversation Sessions.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
// Type-only: makes the Bot service contribution visible on the assembled Host context.
import type { BotView } from '@yharness/bots'
import type {} from '@yharness/bots'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/bot-workspace', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v3.jsonl')
const UI_EXPECTED = fileURLToPath(new URL('./expected/bot-workspace/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()

describe('web e2e: Bot workspace retains one Conversation Session per Bot', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let firstBot!: BotView
  let secondBot!: BotView

  beforeAll(async () => {
    // The scenario exercises the real Bot and Session services but never sends
    // a model request, so a header-only providers-only fixture is sufficient.
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE, replayProvidersOnly: true })
    firstBot = (await scaffold.ctx.bots.create({
      name: 'Scout', identity: 'browse', accent: 'teal', cwd: scaffold.workspaceCwd,
    })).bot
    secondBot = (await scaffold.ctx.bots.create({
      name: 'Orbit', identity: 'goal', accent: 'amber', cwd: scaffold.workspaceCwd,
    })).bot
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

  it('switches the roster while preserving each Bot-owned Conversation binding', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bot-workspace'))
    const sidebar = page.locator('[data-yh-part="sidebar"]')
    await expect.poll(() => sidebar.count()).toBe(1)
    const codeMode = sidebar.getByRole('button', { name: 'Code', exact: true })
    const botsMode = sidebar.getByRole('button', { name: 'Bots', exact: true })
    await expect.poll(() => codeMode.getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => botsMode.getAttribute('aria-pressed')).toBe('false')
    await botsMode.click()
    await expect.poll(() => botsMode.getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => codeMode.getAttribute('aria-pressed')).toBe('false')

    const roster = sidebar.locator('aside[aria-label="Bot workspace"]')
    await roster.waitFor({ state: 'visible', timeout: 15_000 })
    await expect.poll(() => page.locator('section[aria-label="Bot workspace"]').count()).toBe(0)
    const firstRow = roster.locator(`[data-bot-id="${firstBot.id}"]`)
    const secondRow = roster.locator(`[data-bot-id="${secondBot.id}"]`)
    await firstRow.waitFor({ state: 'visible', timeout: 15_000 })
    await secondRow.waitFor({ state: 'visible', timeout: 15_000 })
    const firstPortrait = firstRow.locator('[data-character]')
    await expect.poll(() => firstPortrait.count()).toBe(1)
    await expect.poll(() => firstPortrait.isVisible()).toBe(true)
    expect(await firstPortrait.evaluate(element => getComputedStyle(element).animationName)).not.toBe('none')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(() => firstPortrait.evaluate(element => getComputedStyle(element).animationName)).toBe('none')
    await page.emulateMedia({ reducedMotion: 'no-preference' })

    const firstDetail = page.locator(`section[aria-label="${firstBot.name}"]`)
    await expect.poll(() => firstRow.getAttribute('aria-current')).toBe('page')
    await expect.poll(() => firstDetail.locator('[data-conversation-session]').getAttribute('data-conversation-session'))
      .toBe(firstBot.sessionId)
    await expect.poll(() => firstDetail.locator('[data-composer-placement="bottom"]').count()).toBe(1)
    await roster.getByRole('button', { name: 'Edit avatar' }).click()
    const editor = page.getByRole('dialog', { name: 'Customize avatar' })
    await editor.getByRole('tab', { name: 'Character' }).waitFor()
    await editor.getByRole('radio', { name: 'Amber' }).click()
    await expect.poll(() => editor.locator('[data-character][data-accent="amber"]').count()).toBeGreaterThan(1)
    await editor.getByRole('button', { name: 'Save character' }).click()
    await editor.waitFor({ state: 'hidden' })
    await expect.poll(async () => (await scaffold.ctx.bots.list({})).bots.find(bot => bot.id === firstBot.id)?.accent).toBe('amber')
    await expect.poll(() => firstDetail.locator('[data-conversation-session]').getAttribute('data-conversation-session'))
      .toBe(firstBot.sessionId)
    const composer = firstDetail.locator('[data-yh-part="composer-controls"]')
    await expect.poll(async () => {
      const bounds = await composer.boundingBox()
      return bounds === null ? null : page.viewportSize()!.height - (bounds.y + bounds.height)
    }).toBeLessThan(100)

    await secondRow.click()
    const secondDetail = page.locator(`section[aria-label="${secondBot.name}"]`)
    await expect.poll(() => secondRow.getAttribute('aria-current')).toBe('page')
    await expect.poll(() => firstRow.getAttribute('aria-current')).toBeNull()
    await expect.poll(() => secondDetail.locator('[data-conversation-session]').getAttribute('data-conversation-session'))
      .toBe(secondBot.sessionId)
    await expect.poll(() => secondDetail.locator('[data-composer-placement="bottom"]').count()).toBe(1)

    // Returning to the first row must reuse its original Session, not create
    // a new Conversation occurrence or move the roster selection elsewhere.
    await firstRow.click()
    await expect.poll(() => firstRow.getAttribute('aria-current')).toBe('page')
    await expect.poll(() => firstDetail.locator('[data-conversation-session]').getAttribute('data-conversation-session'))
      .toBe(firstBot.sessionId)

    await codeMode.click()
    await expect.poll(() => codeMode.getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => botsMode.getAttribute('aria-pressed')).toBe('false')
    await expect.poll(() => roster.count()).toBe(0)
    await expect.poll(() => page.locator('section[aria-label="Bot workspace"]').count()).toBe(0)
    await expect.poll(() => sidebar.locator('[data-yh-part="new-session"]').isVisible()).toBe(true)

    await botsMode.click()
    await expect.poll(() => botsMode.getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => roster.isVisible()).toBe(true)
    await expect.poll(() => firstRow.getAttribute('aria-current')).toBe('page')
    await expect.poll(() => firstDetail.locator('[data-conversation-session]').getAttribute('data-conversation-session'))
      .toBe(firstBot.sessionId)

    await compareOrRefreshGolden(
      UI_EXPECTED,
      [
        await captureStableAria(page, '[role="group"][aria-label="Workspace mode"]', scaffold.workspaceCwd),
        await captureStableAria(page, '[data-yh-part="sidebar"] aside[aria-label="Bot workspace"]', scaffold.workspaceCwd),
        await captureStableAria(page, `section[aria-label="${firstBot.name}"]`, scaffold.workspaceCwd),
      ].join('\n'),
      MODE,
    )
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it('keeps the scenario fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v3.jsonl'])
  })
})
