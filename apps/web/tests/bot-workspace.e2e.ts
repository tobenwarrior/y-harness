// Keyless assembled-browser coverage for the Bot roster and its one-to-one
// embedded Conversation Sessions.
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
// Type-only: makes the Bot service contribution visible on the assembled Host context.
import type { BotView } from '@yharness/bots'
import type {} from '@yharness/bots'
import { createAssistantMessage, createUserMessage } from '@yharness/llm'
import type {} from '@yharness/schedule'
import { SessionId } from '@yharness/session'
import { snapshotSubagentDescriptor } from '@yharness/subagent'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/bot-workspace', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v3.jsonl')
const UI_EXPECTED = fileURLToPath(new URL('./expected/bot-workspace/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const CAPTURE_HISTORY = process.env.DSH_GROK_HISTORY_MEDIA === '1'
const INLINE_VISUAL_DIR = process.env.DSH_GROK_INLINE_VISUAL_DIR
const DUPLICATE_VISUAL_DIR = process.env.DSH_BOT_DUPLICATE_VISUAL_DIR
const PRIMARY_VISUAL_DIR = process.env.DSH_PRIMARY_BOT_VISUAL_DIR
const PROMPT_VISUAL_DIR = process.env.DSH_BOT_PROMPT_LINK_VISUAL_DIR
const CHAT_LINK_VISUAL_DIR = process.env.DSH_BOT_CHAT_LINK_VISUAL_DIR

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
    if (CAPTURE_HISTORY || DUPLICATE_VISUAL_DIR !== undefined || PRIMARY_VISUAL_DIR !== undefined
      || PROMPT_VISUAL_DIR !== undefined || CHAT_LINK_VISUAL_DIR !== undefined) {
      await scaffold.ctx.settings.update('ui-theme', { preference: 'system' })
    }
    firstBot = (await scaffold.ctx.bots.create({
      name: 'Scout', identity: 'browse', accent: 'teal', cwd: scaffold.workspaceCwd,
    })).bot
    secondBot = (await scaffold.ctx.bots.create({
      name: 'Orbit', identity: 'goal', accent: 'amber', cwd: scaffold.workspaceCwd,
    })).bot
    await scaffold.ctx.bots.importGrokHistory({ botId: secondBot.id, document: JSON.stringify({
      source: 'grok-bot', version: 2, firstCachedSequence: 0, complete: false, messages: [
        { sourceSequence: 0, role: 'user', author: 'Archive owner', text: 'Recovered question', timestampMs: null },
        { sourceSequence: 1, role: 'assistant', author: 'Original author', fromBot: 'Orbit historian', text: 'Recovered answer', timestampMs: 2000 },
        { sourceSequence: 2, role: 'tool', author: 'Archive tool', text: 'Recovered tool record', timestampMs: null, incomplete: true },
      ],
      sources: [{
        id: 'supplement', label: 'Recovered supplement', firstCachedSequence: 3, complete: false, messages: [
          { sourceSequence: 3, role: 'agent', author: 'Recovered collaborator', text: 'Supplemental record', timestampMs: null },
        ],
      }],
    }) })
    await scaffold.ctx.schedule.create(firstBot.sessionId, {
      title: 'Morning check-in', prompt: 'Review the project.', every_seconds: 86400,
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.route('**/api/skill-compound.update', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          vendored: '0.17.2', upstream: '0.17.2', updateAvailable: false,
          repository: 'tobenwarrior/compound-skills', checkedAt: null, error: null,
        }),
      })
    })
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
    const firstPortrait = firstRow.locator('[data-character] > span')
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
    const folder = roster.getByRole('button', { name: 'General', exact: true })
    const search = roster.getByRole('textbox', { name: 'Search bots' })
    await folder.click()
    await expect.poll(() => folder.getAttribute('aria-expanded')).toBe('false')
    await folder.getByText('2', { exact: true }).waitFor({ state: 'visible' })
    await expect.poll(() => firstRow.count()).toBe(0)
    await expect.poll(() => firstDetail.locator('[data-conversation-session]').getAttribute('data-conversation-session'))
      .toBe(firstBot.sessionId)
    const collapsedFolderSnapshot = await captureStableAria(
      page, '[data-yh-part="sidebar"] [aria-labelledby="yharness-bots-group-0"]', scaffold.workspaceCwd,
    )
    await codeMode.click()
    await expect.poll(() => roster.count()).toBe(0)
    await botsMode.click()
    await expect.poll(() => folder.getAttribute('aria-expanded')).toBe('false')
    await search.fill(firstBot.name)
    await expect.poll(() => folder.getAttribute('aria-expanded')).toBe('true')
    await firstRow.waitFor({ state: 'visible' })
    await search.clear()
    await expect.poll(() => folder.getAttribute('aria-expanded')).toBe('false')
    await folder.focus()
    await folder.press('Space')
    await firstRow.waitFor({ state: 'visible' })
    await expect.poll(() => folder.getAttribute('aria-expanded')).toBe('true')
    await roster.getByRole('button', { name: 'Bot workspace options', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Edit avatar', exact: true }).click()
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

    await firstDetail.getByRole('button', { name: 'Bot options', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Edit bot profile', exact: true }).click()
    const profileDialog = page.getByRole('dialog', { name: 'Edit bot profile', exact: true })
    await profileDialog.getByLabel('What it does').fill('Keeps the team informed')
    await profileDialog.getByLabel('Instructions').fill('Give clear, concise updates.')
    await profileDialog.getByLabel('Specialties').fill('research, updates')
    const profileDialogSnapshot = await captureStableAria(
      page, '[role="dialog"][aria-label="Edit bot profile"]', scaffold.workspaceCwd,
    )
    await profileDialog.getByRole('button', { name: 'Save profile', exact: true }).click()
    await profileDialog.waitFor({ state: 'hidden' })
    await expect.poll(async () => (await scaffold.ctx.bots.list({})).bots.find(bot => bot.id === firstBot.id)?.description)
      .toBe('Keeps the team informed')
    await expect.poll(() => firstDetail.locator('[data-conversation-session]').getAttribute('data-conversation-session'))
      .toBe(firstBot.sessionId)

    await firstDetail.getByRole('button', { name: 'Bot options', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Duplicate bot', exact: true }).click()
    const duplicateDialog = page.getByRole('dialog', { name: 'Duplicate bot', exact: true })
    const duplicateDialogSnapshot = await captureStableAria(
      page, '[role="dialog"][aria-label="Duplicate bot"]', scaffold.workspaceCwd,
    )
    await duplicateDialog.getByRole('button', { name: 'Cancel', exact: true }).last().click()
    await duplicateDialog.waitFor({ state: 'hidden' })

    await firstDetail.getByRole('button', { name: 'Bot options', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Make primary bot', exact: true }).click()
    const primaryDialog = page.getByRole('dialog', { name: 'Make primary bot', exact: true })
    const primaryDialogSnapshot = await captureStableAria(
      page, '[role="dialog"][aria-label="Make primary bot"]', scaffold.workspaceCwd,
    )
    await primaryDialog.getByRole('button', { name: 'Cancel', exact: true }).last().click()
    await primaryDialog.waitFor({ state: 'hidden' })

    await roster.getByRole('button', { name: 'New bot', exact: true }).click()
    const createDialog = page.getByRole('dialog', { name: 'Create a bot', exact: true })
    await createDialog.getByLabel('Bot name').fill('Verifier')
    await createDialog.getByLabel('What it does').fill('Checks releases')
    await createDialog.getByLabel('Instructions').fill('Be thorough and concise.')
    await createDialog.getByLabel('Specialties').fill('review')
    const createDialogSnapshot = await captureStableAria(
      page, '[role="dialog"][aria-label="Create a bot"]', scaffold.workspaceCwd,
    )
    await createDialog.getByRole('button', { name: 'Cancel', exact: true }).last().click()
    await createDialog.waitFor({ state: 'hidden' })

    await roster.getByRole('button', { name: 'Bot workspace options', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Bot templates', exact: true }).click()
    const templateDialog = page.getByRole('dialog', { name: 'Bot templates', exact: true })
    await templateDialog.getByText('No shared templates yet.', { exact: true }).waitFor({ state: 'visible' })
    const templateDialogSnapshot = await captureStableAria(
      page, '[role="dialog"][aria-label="Bot templates"]', scaffold.workspaceCwd,
    )
    await templateDialog.getByRole('button', { name: 'Cancel', exact: true }).last().click()
    await templateDialog.waitFor({ state: 'hidden' })

    await firstDetail.getByRole('button', { name: 'Bot options', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Manage memories', exact: true }).click()
    const memoryDialog = page.getByRole('dialog', { name: 'Bot memory', exact: true })
    await memoryDialog.getByText('No saved memories', { exact: true }).waitFor({ state: 'visible' })
    const memoryDialogSnapshot = await captureStableAria(
      page, '[role="dialog"][aria-label="Bot memory"]', scaffold.workspaceCwd,
    )
    await memoryDialog.getByRole('button', { name: 'Close', exact: true }).last().click()
    await memoryDialog.waitFor({ state: 'hidden' })

    await firstDetail.getByRole('button', { name: 'Bot options', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Manage routines', exact: true }).click()
    const routineDialog = page.getByRole('dialog', { name: 'Bot routines', exact: true })
    await routineDialog.getByText('Morning check-in', { exact: true }).first().waitFor({ state: 'visible' })
    const routineDialogSnapshot = await captureStableAria(
      page, '[role="dialog"][aria-label="Bot routines"]', scaffold.workspaceCwd,
    )
    await routineDialog.getByRole('button', { name: 'Close', exact: true }).last().click()
    await routineDialog.waitFor({ state: 'hidden' })

    await firstDetail.getByRole('button', { name: 'Bot options', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Manage skills', exact: true }).click()
    const skillsDialog = page.getByRole('dialog', { name: 'Bot skills', exact: true })
    const selectedSkills = skillsDialog.getByRole('radio', { name: 'Only selected skills', exact: true })
    await selectedSkills.check()
    await skillsDialog.getByRole('button', { name: 'Save skills', exact: true }).click()
    await skillsDialog.waitFor({ state: 'hidden' })
    await firstDetail.getByRole('button', { name: 'Bot options', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Manage skills', exact: true }).click()
    await expect.poll(() => selectedSkills.isChecked()).toBe(true)
    await skillsDialog.getByRole('button', { name: 'Close', exact: true }).last().click()
    await skillsDialog.waitFor({ state: 'hidden' })

    await secondRow.click()
    const secondDetail = page.locator(`section[aria-label="${secondBot.name}"]`)
    await expect.poll(() => secondRow.getAttribute('aria-current')).toBe('page')
    await expect.poll(() => firstRow.getAttribute('aria-current')).toBeNull()
    await expect.poll(() => secondDetail.locator('[data-conversation-session]').getAttribute('data-conversation-session'))
      .toBe(secondBot.sessionId)
    await expect.poll(() => secondDetail.locator('[data-composer-placement="bottom"]').count()).toBe(1)
    await secondDetail.getByRole('textbox', { name: 'Message ' + secondBot.name, exact: true }).waitFor()
    await secondDetail.getByRole('button', { name: 'Bot options', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Imported Grok chat', exact: true }).click()
    const historyDialog = page.getByRole('dialog', { name: 'Imported Grok chat' })
    const sourceSelect = historyDialog.getByLabel('History source')
    await expect.poll(() => sourceSelect.inputValue()).toBe('primary')
    await historyDialog.getByText('Recovered question', { exact: true }).waitFor()
    await historyDialog.getByText('Recovered answer', { exact: true }).waitFor()
    await historyDialog.getByText('Recovered tool record', { exact: true }).waitFor()
    await historyDialog.getByText('Archive owner', { exact: true }).waitFor()
    await historyDialog.getByText('Orbit historian', { exact: true }).waitFor()
    await historyDialog.getByText('Author Original author', { exact: true }).waitFor()
    await historyDialog.getByText('Archive tool', { exact: true }).waitFor()
    await historyDialog.getByText('Some records could not be recovered from this source.').waitFor()
    await historyDialog.getByText('Unknown time', { exact: true }).first().waitFor()
    await historyDialog.getByText('Incomplete source record', { exact: true }).waitFor()
    await expect.poll(() => historyDialog.locator('time').count()).toBe(1)
    await sourceSelect.selectOption('supplement')
    await historyDialog.getByText('Supplemental record', { exact: true }).waitFor()
    await historyDialog.getByText('Recovered collaborator', { exact: true }).waitFor()
    await historyDialog.getByText('Unknown time', { exact: true }).waitFor()
    await expect.poll(() => historyDialog.getByText('Recovered question', { exact: true }).count()).toBe(0)
    await sourceSelect.selectOption('primary')
    const archiveSearch = historyDialog.getByRole('searchbox', { name: 'Search imported messages', exact: true })
    await archiveSearch.fill('archive')
    await historyDialog.getByRole('status').getByText('2 of 3 messages').waitFor()
    await expect.poll(() => historyDialog.getByText('Recovered answer', { exact: true }).count()).toBe(0)
    if (CAPTURE_HISTORY) {
      const media = await mkdtemp(join(tmpdir(), 'dsh-bot-history-media-'))
      const viewport = page.viewportSize()
      for (const theme of ['dark', 'light'] as const) {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
        await page.locator('body[data-ds-dark-theme]').waitFor({ state: theme === 'dark' ? 'visible' : 'detached' })
        for (const width of [1440, 480]) {
          await page.setViewportSize({ width, height: 900 })
          await page.screenshot({ path: join(media, `imported-chat-${width}-${theme}.png`), animations: 'disabled' })
        }
      }
      if (viewport !== null) await page.setViewportSize(viewport)
      console.log(`Imported Bot chat media: ${media}`)
    }
    await sourceSelect.selectOption('supplement')
    await historyDialog.getByRole('status').getByText('No matches in this source.').waitFor()
    await archiveSearch.clear()
    await historyDialog.getByText('Supplemental record', { exact: true }).waitFor()
    await sourceSelect.selectOption('primary')
    const historyDialogSnapshot = await captureStableAria(
      page, '[role="dialog"][aria-label="Imported Grok chat"]', scaffold.workspaceCwd,
    )
    await historyDialog.getByRole('button', { name: 'Close', exact: true }).last().click()
    await historyDialog.waitFor({ state: 'hidden' })
    await expect.poll(() => secondDetail.locator('[data-conversation-session]').getAttribute('data-conversation-session'))
      .toBe(secondBot.sessionId)

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
        collapsedFolderSnapshot,
        await captureStableAria(page, `section[aria-label="${firstBot.name}"]`, scaffold.workspaceCwd),
        templateDialogSnapshot,
        memoryDialogSnapshot,
        profileDialogSnapshot,
        duplicateDialogSnapshot,
        primaryDialogSnapshot,
        createDialogSnapshot,
        routineDialogSnapshot,
        historyDialogSnapshot,
      ].join('\n'),
      MODE,
    )
    await roster.getByRole('button', { name: 'New bot', exact: true }).click()
    await createDialog.getByLabel('Bot name').fill('Verifier')
    await createDialog.getByLabel('What it does').fill('Checks releases')
    await createDialog.getByLabel('Instructions').fill('Be thorough and concise.')
    await createDialog.getByLabel('Specialties').fill('review')
    await createDialog.getByRole('button', { name: 'Create bot', exact: true }).click()
    await createDialog.waitFor({ state: 'hidden' })
    await expect.poll(async () => (await scaffold.ctx.bots.list({})).bots.find(bot => bot.name === 'Verifier')?.description)
      .toBe('Checks releases')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it('renders the recovered Grok chat inline without replacing the live Bot conversation', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-grok-history-inline'))
    const botsMode = page.getByRole('button', { name: 'Bots', exact: true })
    if (await botsMode.getAttribute('aria-pressed') !== 'true') await botsMode.click()
    const roster = page.locator('[data-yh-part="sidebar"] aside[aria-label="Bot workspace"]')
    const firstRow = roster.locator(`[data-bot-id="${firstBot.id}"]`)
    const secondRow = roster.locator(`[data-bot-id="${secondBot.id}"]`)
    await secondRow.click()
    const secondDetail = page.locator(`section[aria-label="${secondBot.name}"]`)
    await expect.poll(() => secondDetail.locator('[data-conversation-session]').getAttribute('data-conversation-session'))
      .toBe(secondBot.sessionId)
    const composer = secondDetail.getByRole('textbox', { name: 'Message ' + secondBot.name, exact: true })
    await composer.waitFor()
    const inline = secondDetail.locator('section[aria-label="Imported Grok chat"]')
    await inline.getByRole('button', { name: 'Show history', exact: true }).waitFor()
    expect(await inline.getByText('Recovered question', { exact: true }).count()).toBe(0)

    await composer.fill('Keep this draft while I inspect the recovery.')
    await inline.getByRole('button', { name: 'Show history', exact: true }).click()
    await inline.getByText('Recovered question', { exact: true }).waitFor()
    await inline.getByText('Recovered answer', { exact: true }).waitFor()
    const sourceSelect = inline.getByRole('combobox', { name: 'History source' })
    await sourceSelect.selectOption('supplement')
    await inline.getByText('Supplemental record', { exact: true }).waitFor()
    await inline.getByText('Some records could not be recovered from this source.', { exact: true }).waitFor()
    expect(await composer.textContent()).toContain('Keep this draft while I inspect the recovery.')
    await sourceSelect.selectOption('primary')
    await inline.getByText('Recovered question', { exact: true }).waitFor()
    await expect.poll(() => secondDetail.locator('[data-composer-placement="bottom"]').count()).toBe(1)

    if (INLINE_VISUAL_DIR !== undefined) {
      await mkdir(INLINE_VISUAL_DIR, { recursive: true })
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
      await page.locator('body[data-ds-dark-theme]').waitFor({ state: 'visible' })
      await page.screenshot({
        path: join(INLINE_VISUAL_DIR, 'desktop-dark.png'), fullPage: true, animations: 'disabled',
      })
      await page.setViewportSize({ width: 480, height: 900 })
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
      await page.locator('body[data-ds-dark-theme]').waitFor({ state: 'detached' })
      await page.screenshot({
        path: join(INLINE_VISUAL_DIR, 'narrow-light.png'), fullPage: true, animations: 'disabled',
      })
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
      await page.locator('body[data-ds-dark-theme]').waitFor({ state: 'visible' })
    }

    await firstRow.click()
    await expect.poll(() => page.locator(`section[aria-label="${firstBot.name}"] [data-conversation-session]`)
      .getAttribute('data-conversation-session')).toBe(firstBot.sessionId)
    await secondRow.click()
    await expect.poll(() => page.locator(`section[aria-label="${secondBot.name}"] [data-conversation-session]`)
      .getAttribute('data-conversation-session')).toBe(secondBot.sessionId)
    const returnedDetail = page.locator(`section[aria-label="${secondBot.name}"]`)
    expect(await returnedDetail.getByRole('textbox', { name: 'Message ' + secondBot.name, exact: true }).textContent())
      .toContain('Keep this draft while I inspect the recovery.')
    expect(await returnedDetail.locator('section[aria-label="Imported Grok chat"]')
      .getByText('Recovered question', { exact: true }).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it('opens previous agent work beside the Bot and keeps its conversation selected', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bot-agent-chat'))
    const mode = page.getByRole('button', { name: 'Bots', exact: true })
    if (await mode.getAttribute('aria-pressed') !== 'true') await mode.click()
    await page.locator(`[data-bot-id="${firstBot.id}"]`).click()
    const parent = scaffold.ctx.sessions.get(firstBot.sessionId)
    if (parent === undefined) throw new Error('The Bot session is unavailable.')
    const detail = page.getByRole('region', { name: firstBot.name, exact: true })
    await detail.waitFor()
    const agents = detail.getByRole('button', { name: /^Agents, /u })
    expect(await agents.count()).toBe(0)

    const createdAt = Date.now()
    const child = scaffold.ctx.sessions.create(SessionId('bot-workspace-reviewer'), {
      meta: { cwd: scaffold.workspaceCwd, parentSession: parent.id, createdAt, origin: 'subagent', delegationDepth: 1 },
    })
    const answer = 'All three settings views fit at the narrow window size.'
    child.append('turn/start', { turn: 1 })
    child.append('subagent/descriptor', snapshotSubagentDescriptor({
      mode: 'one-shot', provider: 'spawn', label: 'Review settings layout',
    }))
    child.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'Review the settings layouts.' }],
    }), { surfaceOp: 'append' })
    child.append('step/start', { turn: 1, step: 1 })
    child.append('assistant/message', {
      stream: [], turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: answer }], source: { provider: 'fixture', model: 'review' },
      }),
    }, { surfaceOp: 'append' })
    child.append('step/end', { turn: 1, step: 1 })
    child.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(child)
    parent.append('subagent/catalog', {
      version: 0, childId: child.id, childCreatedAt: createdAt, mode: 'one-shot', label: 'Review settings layout',
    })
    await scaffold.ctx.sessions.flush(parent)

    await agents.click()
    expect(await page.getByRole('treeitem', { name: /^Review settings layout/u }).count()).toBe(0)
    await page.getByRole('button', { name: 'Previous agents (1)', exact: true }).click()
    const reviewer = page.getByRole('treeitem', { name: /^Review settings layout/u })
    await reviewer.click()
    const sidebarChat = page.locator('[data-sidebar-chat]')
    await sidebarChat.getByText(answer, { exact: true }).waitFor()
    await expect.poll(() => detail.locator('[data-conversation-session]').getAttribute('data-conversation-session'))
      .toBe(firstBot.sessionId)
    expect(scaffold.ctx.agents.get(child.id)).toBeUndefined()
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('duplicates a Bot into a fresh chat with its selected model and paused routines', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bot-duplicate'))
    const mode = page.getByRole('button', { name: 'Bots', exact: true })
    if (await mode.getAttribute('aria-pressed') !== 'true') await mode.click()
    const sourceModel = {
      provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp', reasoningEffort: 'low',
    }
    const fallbackModel = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
    await scaffold.ctx.sessionController.selectModel({ sessionId: secondBot.sessionId, ...sourceModel })
    await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection()).toMatchObject(sourceModel)
    await scaffold.ctx.sessionController.selectModel({ sessionId: firstBot.sessionId, ...fallbackModel })
    await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection()).toMatchObject(fallbackModel)
    const sourceRoutine = await scaffold.ctx.schedule.create(secondBot.sessionId, {
      title: 'Review releases', prompt: 'Check the release notes.', every_seconds: 86400,
    })
    await page.locator(`[data-bot-id="${secondBot.id}"]`).click()
    const detail = page.getByRole('region', { name: secondBot.name, exact: true })
    await detail.getByRole('button', { name: 'Bot options', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Duplicate bot', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Duplicate bot', exact: true })
    const name = dialog.getByLabel('Bot name')
    await expect.poll(() => name.inputValue()).toBe('Orbit copy')
    await name.fill('Release reviewer')

    if (DUPLICATE_VISUAL_DIR !== undefined) {
      await mkdir(DUPLICATE_VISUAL_DIR, { recursive: true })
      for (const [width, theme, filename] of [
        [1440, 'dark', 'desktop-dark.png'], [480, 'light', 'narrow-light.png'],
      ] as const) {
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
        await page.locator('body[data-ds-dark-theme]').waitFor({ state: theme === 'dark' ? 'visible' : 'detached' })
        await expect.poll(async () => {
          const bounds = await dialog.boundingBox()
          return bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= width
        }).toBe(true)
        await page.screenshot({ path: join(DUPLICATE_VISUAL_DIR, filename), animations: 'disabled' })
      }
    }

    await dialog.getByRole('button', { name: 'Duplicate', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const copyDetail = page.getByRole('region', { name: 'Release reviewer', exact: true })
    const copyComposer = copyDetail.getByRole('textbox', { name: 'Message Release reviewer', exact: true })
    await copyComposer.waitFor()
    expect(await copyComposer.textContent()).toBe('')
    const copies = (await scaffold.ctx.bots.list({})).bots.filter(bot => bot.name === 'Release reviewer')
    expect(copies).toHaveLength(1)
    const copy = copies[0]!
    expect(copy.id).not.toBe(secondBot.id)
    expect(copy.sessionId).not.toBe(secondBot.sessionId)
    expect(copy.accent).toBe(secondBot.accent)
    expect(copy.identity).toBe(secondBot.identity)
    await expect.poll(() => copyDetail.locator('[data-conversation-session]').getAttribute('data-conversation-session'))
      .toBe(copy.sessionId)
    const copyModelPicker = copyDetail.getByRole('button', { name: /^Select model, current/u })
    await expect.poll(() => copyModelPicker.textContent()).toContain('DeepSeek-V4-Flash-Vision-Exp')
    expect(await scaffold.ctx.sessionController.snapshotModelSelection(copy.sessionId)).toMatchObject(sourceModel)
    expect(scaffold.ctx.agentDefaultModel.currentSelection()).toMatchObject(fallbackModel)
    expect(await scaffold.ctx.bots.readGrokHistory({ botId: copy.id })).toBeNull()
    expect((await scaffold.ctx.bots.readGrokHistory({ botId: secondBot.id }))?.messages[0]?.text).toBe('Recovered question')
    const catalog = await scaffold.ctx.schedule.catalog()
    expect(catalog.find(entry => entry.id === sourceRoutine.id)?.status).toBe('active')
    expect(catalog.filter(entry => entry.sessionId === copy.sessionId)).toMatchObject([
      { title: 'Review releases', status: 'paused' },
    ])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('retains a primary Bot across browser sessions and replaces it without disturbing the current chat', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-primary-bot'))
    const mode = page.getByRole('button', { name: 'Bots', exact: true })
    if (await mode.getAttribute('aria-pressed') !== 'true') await mode.click()
    const firstRow = page.locator(`[data-bot-id="${firstBot.id}"]`)
    const secondRow = page.locator(`[data-bot-id="${secondBot.id}"]`)
    const confirmPrimary = async (name: string) => {
      const detail = page.getByRole('region', { name, exact: true })
      await detail.getByRole('button', { name: 'Bot options', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Make primary bot', exact: true }).click()
      return page.getByRole('dialog', { name: 'Make primary bot', exact: true })
    }
    await firstRow.click()
    const firstDialog = await confirmPrimary(firstBot.name)
    await firstDialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    await firstDialog.waitFor({ state: 'hidden' })
    await firstRow.getByText('Primary bot', { exact: true }).waitFor()
    expect(await scaffold.ctx.bots.readPrimary({})).toEqual({ primaryBotId: firstBot.id, revision: 1 })

    await secondRow.click()
    const secondDetail = page.getByRole('region', { name: secondBot.name, exact: true })
    const composer = secondDetail.getByRole('textbox', { name: 'Message ' + secondBot.name, exact: true })
    await composer.fill('Keep this draft when I change the primary bot.')
    const secondDialog = await confirmPrimary(secondBot.name)
    if (PRIMARY_VISUAL_DIR !== undefined) {
      await mkdir(PRIMARY_VISUAL_DIR, { recursive: true })
      for (const [width, theme, filename] of [
        [1440, 'dark', 'desktop-dark.png'], [480, 'light', 'narrow-light.png'],
      ] as const) {
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
        await page.locator('body[data-ds-dark-theme]').waitFor({ state: theme === 'dark' ? 'visible' : 'detached' })
        await expect.poll(async () => {
          const bounds = await secondDialog.boundingBox()
          return bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= width
        }).toBe(true)
        await page.screenshot({ path: join(PRIMARY_VISUAL_DIR, filename), animations: 'disabled' })
      }
    }
    await secondDialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    await secondDialog.waitFor({ state: 'hidden' })
    expect(await composer.getAttribute('contenteditable')).toBe('true')
    expect(await composer.textContent()).toBe('Keep this draft when I change the primary bot.')
    expect(await scaffold.ctx.bots.readPrimary({})).toEqual({ primaryBotId: secondBot.id, revision: 2 })
    await expect.poll(() => secondDetail.locator('[data-conversation-session]').getAttribute('data-conversation-session'))
      .toBe(secondBot.sessionId)

    const reopened = await newEnglishPage(browser)
    try {
      await reopened.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await reopened.getByRole('button', { name: 'Bots', exact: true }).click()
      const reopenedBot = reopened.getByRole('region', { name: secondBot.name, exact: true })
      await reopenedBot.getByText('Primary bot', { exact: true }).waitFor()
      await expect.poll(() => reopenedBot.locator('[data-conversation-session]').getAttribute('data-conversation-session'))
        .toBe(secondBot.sessionId)
    } finally {
      await reopened.close()
    }

    await secondDetail.getByRole('button', { name: 'Bot options', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Remove as primary bot', exact: true }).click()
    const removeDialog = page.getByRole('dialog', { name: 'Remove as primary bot', exact: true })
    await removeDialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    await removeDialog.waitFor({ state: 'hidden' })
    expect(await scaffold.ctx.bots.readPrimary({})).toEqual({ primaryBotId: null, revision: 3 })
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('opens named and primary Bot links as unsent drafts and preserves existing work', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bot-prompt-deep-link'))
    const primary = await scaffold.ctx.bots.readPrimary({})
    await scaffold.ctx.bots.setPrimary({ botId: firstBot.id, expectedRevision: primary.revision })
    const relay = (await scaffold.ctx.bots.create({
      name: 'Relay', identity: 'agent', accent: 'teal', cwd: scaffold.workspaceCwd,
    })).bot

    const prompt = 'Review the latest recovery report ☕'
    const link = (text: string, id?: string): URL => {
      const target = new URL(scaffold.baseUrl)
      const params = new URLSearchParams({ text })
      if (id !== undefined) params.set('id', id)
      target.hash = `/bots/prompt?${params.toString()}`
      return target
    }
    await page.goto('about:blank')
    await page.goto(link(prompt, relay.id).href, { waitUntil: 'load' })
    const detail = page.getByRole('region', { name: relay.name, exact: true })
    const composer = detail.locator('[data-composer-input][contenteditable="true"]')
    await composer.waitFor()
    await expect.poll(() => composer.textContent()).toBe(prompt)
    expect(new URL(page.url()).hash).toBe('')

    if (PROMPT_VISUAL_DIR !== undefined) {
      await mkdir(PROMPT_VISUAL_DIR, { recursive: true })
      for (const [width, theme, filename] of [
        [1440, 'dark', 'desktop-dark.png'], [480, 'light', 'narrow-light.png'],
      ] as const) {
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
        await page.locator('body[data-ds-dark-theme]').waitFor({ state: theme === 'dark' ? 'visible' : 'detached' })
        await page.screenshot({ path: join(PROMPT_VISUAL_DIR, filename), animations: 'disabled' })
      }
      await page.setViewportSize({ width: 1440, height: 900 })
    }

    const openLink = async (text: string, id?: string): Promise<void> => {
      await page.evaluate((fragment) => { window.location.hash = fragment }, link(text, id).hash)
      await expect.poll(() => new URL(page.url()).hash).toBe('')
    }
    await openLink('Check the team queue')
    const primaryComposer = page.getByRole('region', { name: firstBot.name, exact: true })
      .locator('[data-composer-input][contenteditable="true"]')
    await primaryComposer.waitFor()
    await expect.poll(() => primaryComposer.textContent()).toBe('Check the team queue')
    await openLink('Keep the original draft', relay.id)
    await composer.waitFor()
    await expect.poll(() => composer.textContent()).toBe(prompt)

    await composer.fill('')
    await detail.locator('input[type="file"]').setInputFiles({
      name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic outline.'),
    })
    await detail.getByTitle('notes.txt').waitFor()
    await page.getByRole('button', { name: 'Code', exact: true }).click()
    await composer.waitFor({ state: 'hidden' })
    await openLink('Leave the attachment alone', relay.id)
    await composer.waitFor()
    expect(await composer.textContent()).toBe('')
    expect(await detail.getByTitle('notes.txt').count()).toBe(1)

    using observed = await scaffold.ctx.sessionQuery.observeSession(relay.sessionId)
    expect(observed.events.some(event => event.type === 'user/message')).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('copies a Bot chat link and reopens the same chat without writing to the composer', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bot-chat-link'))
    const bot = (await scaffold.ctx.bots.create({
      name: 'Sage', identity: 'browse', accent: 'teal', cwd: scaffold.workspaceCwd,
    })).bot
    const address = new URL(scaffold.baseUrl)
    const parameters = new URLSearchParams({ id: bot.id })
    address.hash = `/bots/open?${parameters.toString()}`
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: address.origin })
    await page.goto('about:blank')
    await page.goto(address.href, { waitUntil: 'load' })
    const detail = page.getByRole('region', { name: bot.name, exact: true })
    const composer = detail.locator('[data-composer-input][contenteditable="true"]')
    await composer.waitFor()
    expect(new URL(page.url()).hash).toBe('')
    expect(await composer.textContent()).toBe('')
    await composer.fill('Keep the existing unsent draft')

    const options = detail.getByRole('button', { name: 'Bot options', exact: true })
    const copy = page.getByRole('menuitem', { name: 'Copy chat link', exact: true })
    if (CHAT_LINK_VISUAL_DIR !== undefined) {
      await mkdir(CHAT_LINK_VISUAL_DIR, { recursive: true })
      for (const [width, theme, filename] of [
        [1440, 'dark', 'desktop-dark.png'], [480, 'light', 'narrow-light.png'],
      ] as const) {
        await page.setViewportSize({ width, height: 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
        await page.locator('body[data-ds-dark-theme]').waitFor({ state: theme === 'dark' ? 'visible' : 'detached' })
        await options.click()
        await copy.waitFor()
        const bounds = await copy.boundingBox()
        expect(bounds).not.toBeNull()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
        await page.screenshot({ path: join(CHAT_LINK_VISUAL_DIR, filename), animations: 'disabled' })
        await page.keyboard.press('Escape')
        await copy.waitFor({ state: 'hidden' })
      }
      await page.setViewportSize({ width: 1440, height: 900 })
    }
    await options.click()
    await copy.click()
    await page.getByText('Chat link copied.', { exact: true }).waitFor()
    const copied = await page.evaluate(() => navigator.clipboard.readText())
    expect(copied).toBe(address.href)

    await page.getByRole('button', { name: 'Code', exact: true }).click()
    await composer.waitFor({ state: 'hidden' })
    await page.evaluate((fragment) => { window.location.hash = fragment }, new URL(copied).hash)
    await composer.waitFor()
    expect(await composer.textContent()).toBe('Keep the existing unsent draft')
    using observed = await scaffold.ctx.sessionQuery.observeSession(bot.sessionId)
    expect(observed.events.some(event => event.type === 'user/message')).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('keeps the scenario fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v3.jsonl'])
  })
})
