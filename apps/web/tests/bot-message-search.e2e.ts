// Web e2e scenario: the owner-scoped Bot chat search uses the real Session
// query index, excludes an unrelated Session, and opens the exact matching
// event in the selected Bot conversation.
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PAGE_MESSAGES } from '../../../packages/api/session-controller/src/client/sessions/session.ts'
import { createAssistantMessage, createUserMessage } from '@yharness/llm'
import { SessionId } from '@yharness/session'
import type { Session } from '@yharness/session'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const SEARCH_TERM = 'search-amber-quasar'
const SCOUT_REPLY = `Search Scout found the ${SEARCH_TERM} message.`
const ORBIT_REPLY = `Search Orbit found the ${SEARCH_TERM} message.`
const ORBIT_RECENT_REPLY = 'Search Orbit recent message stays visible while the target is unloaded.'
const PRIVATE_REPLY = `Private session contains ${SEARCH_TERM} but must not appear.`
const TAKE_SCREENSHOTS = process.env.YH_BOT_SEARCH_SCREENSHOTS === '1'
const SHOT_DIR = fileURLToPath(new URL('../../../.artifacts/screenshots/bot-message-search', import.meta.url))

interface BotFixture {
  readonly botId: string
  readonly sessionId: string
  readonly assistantSeq: string
}

/** Append one visible user/assistant turn and return the exact assistant seq. */
async function seedVisibleTurn(session: Session, reply: string, label: string, turn = 1): Promise<string> {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `${label} context.` }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: reply }],
      source: { provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  const assistant = [...session.snapshotEvents()].reverse().find(event => event.type === 'assistant/message')
  if (assistant === undefined) throw new Error(`Missing seeded assistant event for ${label}`)
  return String(assistant.seq)
}

describe.skipIf(MODE === 'record')('web e2e: owner-scoped Bot message search', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let scout: BotFixture
  let orbit: BotFixture

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const scoutBot = (await scaffold.ctx.bots.create({
      name: 'Search Scout', identity: 'browse', accent: 'teal', cwd: scaffold.workspaceCwd,
    })).bot
    const orbitBot = (await scaffold.ctx.bots.create({
      name: 'Search Orbit', identity: 'goal', accent: 'violet', cwd: scaffold.workspaceCwd,
    })).bot
    const scoutSession = scaffold.ctx.sessions.get(scoutBot.sessionId)
    const orbitSession = scaffold.ctx.sessions.get(orbitBot.sessionId)
    if (scoutSession === undefined || orbitSession === undefined) {
      throw new Error('Bot fixture Session was not created')
    }
    const scoutSeq = await seedVisibleTurn(scoutSession, SCOUT_REPLY, 'Search Scout')
    await scaffold.ctx.sessions.flush(scoutSession)
    const orbitSeq = await seedVisibleTurn(orbitSession, ORBIT_REPLY, 'Search Orbit')
    // PAGE_MESSAGES is the Client Session's minimum ordinary history window.
    // Keep the target before a full page of later turns so the opening window
    // contains a recent unrelated message but not the search target.
    for (let turn = 2; turn <= PAGE_MESSAGES + 1; turn++) {
      await seedVisibleTurn(
        orbitSession,
        turn === PAGE_MESSAGES + 1 ? ORBIT_RECENT_REPLY : `Search Orbit recent turn ${turn}.`,
        `Search Orbit recent ${turn}`,
        turn,
      )
    }
    await scaffold.ctx.sessions.flush(orbitSession)
    scout = { botId: String(scoutBot.id), sessionId: String(scoutBot.sessionId), assistantSeq: scoutSeq }
    orbit = { botId: String(orbitBot.id), sessionId: String(orbitBot.sessionId), assistantSeq: orbitSeq }

    // This Session shares the literal query but is not bound to a Bot. The
    // unrestricted index assertion below proves SQLite saw it before the Bot
    // service applies its roster-derived authorization filter.
    const privateSession = scaffold.ctx.sessions.create(SessionId('bot-message-search-private'), {
      meta: { cwd: scaffold.workspaceCwd },
    })
    await seedVisibleTurn(privateSession, PRIVATE_REPLY, 'Private search fixture')
    await scaffold.ctx.sessions.flush(privateSession)

    const indexed = await scaffold.ctx.sessionQuery.searchSessions({
      query: SEARCH_TERM,
      eventFilters: [
        { kind: 'type', values: ['user/message', 'assistant/message'] },
        { kind: 'surface', values: ['current'] },
      ],
      limit: 20,
    })
    expect(indexed.items).toHaveLength(3)
    expect(indexed.items.map(hit => String(hit.header.id))).toEqual(expect.arrayContaining([
      scout.sessionId, orbit.sessionId, String(privateSession.id),
    ]))

    const scoped = await scaffold.ctx.bots.searchMessages({ query: SEARCH_TERM })
    expect(scoped.hasMore).toBe(false)
    expect(scoped.items).toHaveLength(2)
    expect(scoped.items.map(item => String(item.sessionId))).toEqual(expect.arrayContaining([
      scout.sessionId, orbit.sessionId,
    ]))
    expect(scoped.items.map(item => String(item.sessionId))).not.toContain(String(privateSession.id))
    expect(String(scoped.items.find(item => String(item.sessionId) === scout.sessionId)?.seq)).toBe(scout.assistantSeq)
    expect(String(scoped.items.find(item => String(item.sessionId) === orbit.sessionId)?.seq)).toBe(orbit.assistantSeq)

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

  it('searches Bot chats, omits private Sessions, and reveals the exact earlier message', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bot-message-search'))
    const sidebar = page.locator('[data-yh-part="sidebar"]')
    await sidebar.getByRole('button', { name: 'Bots', exact: true }).click()
    const roster = sidebar.locator('aside[aria-label="Bot workspace"]')
    await roster.waitFor({ state: 'visible', timeout: 15_000 })

    // Prove the target is genuinely outside the opening history page before
    // the search flow asks the Client to jump back to it.
    await roster.locator(`[data-bot-id="${orbit.botId}"]`).click()
    const orbitInitialDetail = page.locator('section[aria-label="Search Orbit"]')
    await orbitInitialDetail.waitFor({ state: 'visible', timeout: 15_000 })
    await orbitInitialDetail.getByText(ORBIT_RECENT_REPLY, { exact: true }).waitFor({ state: 'visible' })
    await expect.poll(() => orbitInitialDetail.locator(`[data-chat-anchor-seq="${orbit.assistantSeq}"]`).count())
      .toBe(0)

    await roster.locator(`[data-bot-id="${scout.botId}"]`).click()
    const scoutDetail = page.locator('section[aria-label="Search Scout"]')
    await scoutDetail.waitFor({ state: 'visible', timeout: 15_000 })

    await roster.getByRole('button', { name: 'Bot workspace options', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Search Bot chats', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Search Bot chats', exact: true })
    await dialog.waitFor({ state: 'visible', timeout: 15_000 })
    const input = dialog.getByLabel('Search messages', { exact: true })
    await input.fill(SEARCH_TERM)
    const results = dialog.getByRole('list', { name: 'Search messages', exact: true })
    await expect.poll(() => results.getByRole('button').count(), { timeout: 15_000 }).toBe(2)
    await results.getByText('Search Scout', { exact: true }).waitFor({ state: 'visible' })
    await results.getByText('Search Orbit', { exact: true }).waitFor({ state: 'visible' })
    await expect.poll(() => dialog.getByText(PRIVATE_REPLY, { exact: true }).count()).toBe(0)

    if (TAKE_SCREENSHOTS) {
      mkdirSync(SHOT_DIR, { recursive: true })
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
      await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe('')
      await page.screenshot({ path: `${SHOT_DIR}/desktop-dark.png`, fullPage: true, animations: 'disabled' })
      await page.setViewportSize({ width: 480, height: 900 })
      await page.screenshot({ path: `${SHOT_DIR}/narrow-dark.png`, fullPage: true, animations: 'disabled' })
      await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
      await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBeNull()
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.screenshot({ path: `${SHOT_DIR}/desktop-light.png`, fullPage: true, animations: 'disabled' })
      await page.setViewportSize({ width: 480, height: 900 })
      await page.screenshot({ path: `${SHOT_DIR}/narrow-light.png`, fullPage: true, animations: 'disabled' })
      await page.setViewportSize({ width: 1440, height: 1000 })
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
      await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe('')
    }

    await results.getByRole('button').filter({ hasText: 'Search Orbit' }).click()
    await dialog.waitFor({ state: 'hidden' })
    const orbitDetail = page.locator('section[aria-label="Search Orbit"]')
    await orbitDetail.waitFor({ state: 'visible', timeout: 15_000 })
    const revealed = orbitDetail.locator(`[data-chat-anchor-seq="${orbit.assistantSeq}"]`)
    await expect.poll(() => revealed.filter({ hasText: ORBIT_REPLY }).count(), { timeout: 15_000 }).toBe(1)
    const revealedBox = await revealed.filter({ hasText: ORBIT_REPLY }).boundingBox()
    const viewport = page.viewportSize()
    if (revealedBox === null || viewport === null) throw new Error('Revealed message did not have a viewport box')
    expect(revealedBox.y).toBeGreaterThanOrEqual(0)
    expect(revealedBox.y + revealedBox.height).toBeLessThanOrEqual(viewport.height)
    expect(await orbitDetail.locator('[data-conversation-session]').getAttribute('data-conversation-session'))
      .toBe(orbit.sessionId)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)
})
