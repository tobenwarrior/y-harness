// Keyless assembled-Web coverage for shared-group message search. The fixture
// uses only the local shared-Bot route and synthetic Bots; no external account
// or live workspace is involved.
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@yharness/llm'
import { LlmAdapter } from '@yharness/llm'
// Type-only: makes the Bot service contribution visible on the assembled Host context.
import type { BotView } from '@yharness/bots'
import type {} from '@yharness/bots'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const PROVIDER = 'shared-group-search-browser-test'
const MODEL = 'reply'
const SEARCH_TOKEN = 'shared-room-search-token'
const ALPHA_ROOM = 'Search room Alpha'
const BETA_ROOM = 'Search room Beta'
const UNRELATED_ROOM = 'Unrelated room'
const ALPHA_MESSAGE = `Alpha ${SEARCH_TOKEN} result.`
const BETA_MESSAGE = `Beta ${SEARCH_TOKEN} result.`
const UNRELATED_MESSAGE = 'This unrelated room must not appear in the search results.'

/** Complete shared-group deliveries locally without contacting a model service. */
class SharedSearchAdapter extends LlmAdapter {
  override async listModels(provider: string) {
    return [{ provider, id: MODEL, name: `${provider}/${MODEL}` }]
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Keep the adapter deterministic while still allowing the real shared
    // delivery path to settle each synthetic recipient.
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Shared search fixture reply.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function screenshotDirectory(): string | undefined {
  const configured = process.env.YH_SHARED_GROUP_SEARCH_SCREENSHOTS
  if (configured === undefined || configured.trim() === '') return undefined
  const directory = resolve(configured)
  mkdirSync(directory, { recursive: true })
  return directory
}

async function capture(page: Page, directory: string | undefined, name: string): Promise<void> {
  if (directory === undefined) return
  await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true, animations: 'disabled' })
}

async function openOwnerSharedDialog(page: Page): Promise<Locator> {
  const sidebar = page.locator('[data-yh-part="sidebar"]')
  await sidebar.getByRole('button', { name: 'Bots', exact: true }).click()
  const roster = sidebar.locator('aside[aria-label="Bot workspace"]')
  await roster.waitFor({ state: 'visible', timeout: 15_000 })
  await roster.getByRole('button', { name: 'Bot workspace options', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Create a shared group', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Shared with you', exact: true })
  await dialog.waitFor({ state: 'visible', timeout: 15_000 })
  await dialog.getByRole('button', { name: /^Scout\b/ }).waitFor({ state: 'visible', timeout: 30_000 })
  await dialog.getByRole('button', { name: /^Orbit\b/ }).waitFor({ state: 'visible', timeout: 30_000 })
  return dialog
}

async function createRoom(dialog: Locator, page: Page, name: string): Promise<void> {
  const groups = dialog.locator('section[aria-labelledby="yharness-shared-groups-heading"]')
  await groups.getByRole('button', { name: 'Create shared group', exact: true }).click()
  const createDialog = page.getByRole('dialog', { name: 'Create a shared group', exact: true })
  const groupName = createDialog.getByLabel('Group name', { exact: true })
  const scout = createDialog.getByRole('checkbox', { name: 'Scout', exact: true })
  const orbit = createDialog.getByRole('checkbox', { name: 'Orbit', exact: true })
  await expect.poll(() => groupName.inputValue()).toBe('')
  await expect.poll(() => scout.isChecked()).toBe(false)
  await expect.poll(() => orbit.isChecked()).toBe(false)
  await groupName.fill(name)
  await scout.check()
  await orbit.check()
  await createDialog.getByRole('button', { name: 'Create shared group', exact: true }).click()
  await createDialog.waitFor({ state: 'hidden' })
  await dialog.getByRole('button', { name: new RegExp(`^${name}`) }).waitFor({ state: 'visible', timeout: 30_000 })
}

async function selectRoom(dialog: Locator, name: string): Promise<Locator> {
  const row = dialog.getByRole('button', { name: new RegExp(`^${name}`) })
  await row.waitFor({ state: 'visible', timeout: 30_000 })
  await row.click()
  const section = dialog.locator(`section[aria-label="${name}"]`)
  await section.waitFor({ state: 'visible', timeout: 30_000 })
  return section
}

async function sendRoomMessage(dialog: Locator, section: Locator, room: string, text: string): Promise<string> {
  const composer = section.getByRole('combobox', { name: `Message ${room}`, exact: true })
  await composer.fill(text)
  await dialog.getByRole('button', { name: 'Send to group', exact: true }).click()
  const rows = section.locator('[data-shared-group-message-id]')
  await expect.poll(
    () => rows.count(),
    { timeout: 30_000 },
  ).toBeGreaterThan(0)
  const row = rows.filter({ hasText: text })
  await expect.poll(() => row.count(), { timeout: 30_000 }).toBe(1)
  const messageId = await row.getAttribute('data-shared-group-message-id')
  if (messageId === null || messageId === '') throw new Error(`shared message row for ${room} did not expose its durable id`)
  return messageId
}

async function expectSearchResultVisible(dialog: Locator, room: string, message: string): Promise<Locator> {
  const result = dialog.getByRole('button', { name: new RegExp(`${room}.*${message}`, 's') })
  await result.waitFor({ state: 'visible', timeout: 15_000 })
  return result
}

async function expectVisibleMessageRow(dialog: Locator, messageId: string, text: string): Promise<void> {
  const row = dialog.locator(`[data-shared-group-message-id="${messageId}"]`).filter({ hasText: text })
  await row.waitFor({ state: 'visible', timeout: 30_000 })
  const rowBox = await row.boundingBox()
  const viewport = dialog.page().viewportSize()
  if (rowBox === null || viewport === null) throw new Error('selected shared message row has no viewport box')
  expect(rowBox.y).toBeGreaterThanOrEqual(0)
  expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(viewport.height)
  await expect.poll(() => row.evaluate(element => element.ownerDocument.activeElement === element)).toBe(true)
}

describe.skipIf(MODE === 'record')('web e2e: shared-group message search', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const adapter = new SharedSearchAdapter()
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter),
      'shared group search browser fixture adapter',
    )
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
    const scout: BotView = (await scaffold.ctx.bots.create({ name: 'Scout', identity: 'browse', accent: 'teal', cwd: scaffold.workspaceCwd })).bot
    const orbit: BotView = (await scaffold.ctx.bots.create({ name: 'Orbit', identity: 'goal', accent: 'violet', cwd: scaffold.workspaceCwd })).bot
    if (scout.name !== 'Scout' || orbit.name !== 'Orbit') throw new Error('shared search fixture Bots were not created')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('searches accessible shared rooms and opens the exact matching message', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-shared-group-search'))
    const directory = screenshotDirectory()
    const dialog = await openOwnerSharedDialog(page)
    await createRoom(dialog, page, ALPHA_ROOM)
    await createRoom(dialog, page, BETA_ROOM)
    await createRoom(dialog, page, UNRELATED_ROOM)
    const alpha = await selectRoom(dialog, ALPHA_ROOM)
    await sendRoomMessage(dialog, alpha, ALPHA_ROOM, ALPHA_MESSAGE)
    const beta = await selectRoom(dialog, BETA_ROOM)
    const betaMessageId = await sendRoomMessage(dialog, beta, BETA_ROOM, BETA_MESSAGE)
    const unrelated = await selectRoom(dialog, UNRELATED_ROOM)
    await sendRoomMessage(dialog, unrelated, UNRELATED_ROOM, UNRELATED_MESSAGE)

    const searchButton = dialog.getByRole('button', { name: 'Search shared group messages', exact: true })
    await searchButton.click()
    const search = dialog.getByRole('searchbox', { name: 'Search shared group messages', exact: true })
    await search.fill(SEARCH_TOKEN)
    const alphaResult = await expectSearchResultVisible(dialog, ALPHA_ROOM, ALPHA_MESSAGE)
    const betaResult = await expectSearchResultVisible(dialog, BETA_ROOM, BETA_MESSAGE)
    const resultButtons = dialog.getByRole('button').filter({ hasText: SEARCH_TOKEN })
    await expect.poll(() => resultButtons.count(), { timeout: 15_000 }).toBe(2)
    expect(await alphaResult.textContent()).toContain(ALPHA_ROOM)
    expect(await betaResult.textContent()).toContain(BETA_ROOM)
    expect(await dialog.getByRole('button', { name: new RegExp(`${UNRELATED_ROOM}.*${SEARCH_TOKEN}`, 's') }).count()).toBe(0)

    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe('')
    await page.setViewportSize({ width: 1440, height: 1000 })
    await capture(page, directory, 'desktop-dark')
    await page.setViewportSize({ width: 480, height: 900 })
    await capture(page, directory, 'narrow-dark')
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
    await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBeNull()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await capture(page, directory, 'desktop-light')
    await page.setViewportSize({ width: 480, height: 900 })
    await capture(page, directory, 'narrow-light')

    await page.setViewportSize({ width: 1440, height: 1000 })
    await betaResult.click()
    await expectVisibleMessageRow(dialog, betaMessageId, BETA_MESSAGE)
    expect(await dialog.getByRole('button', { name: 'Search shared group messages', exact: true }).count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 180_000)
})
