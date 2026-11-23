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
    await openWorkspacePage()
  }, 120_000)

  async function openWorkspacePage(): Promise<void> {
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }

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
    await historyDialog.getByText('Some messages could not be recovered.', { exact: true }).waitFor()
    await historyDialog.getByText('Unknown time', { exact: true }).first().waitFor()
    await historyDialog.getByText('Incomplete source record', { exact: true }).waitFor()
    await expect.poll(() => historyDialog.locator('time').count()).toBe(1)
    await sourceSelect.selectOption('supplement')
    await historyDialog.getByText('Supplemental record', { exact: true }).waitFor()
    await historyDialog.getByText('Recovered collaborator', { exact: true }).waitFor()
    await historyDialog.getByText('Unknown time', { exact: true }).waitFor()
    await expect.poll(() => historyDialog.getByText('Recovered question', { exact: true }).count()).toBe(0)
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

  it('opens previous agent work beside the Bot and keeps its conversation selected', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bot-agent-chat'))
    await page.context().close()
    await openWorkspacePage()
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

  it('keeps the scenario fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v3.jsonl'])
  })
})
