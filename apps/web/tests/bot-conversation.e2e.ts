/** Keyless assembled-Web coverage for the Bot conversation presentation. */

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@yharness/llm'
import { LlmAdapter } from '@yharness/llm'
import type { BotView } from '@yharness/bots'
import type {} from '@yharness/bots'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/bot-workspace', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v3.jsonl')
const UI_EXPECTED = fileURLToPath(new URL('./expected/bot-conversation/conversation.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const PROVIDER = 'bot-conversation-browser-test'
const MODEL = 'reply'
const USER_PROMPT = 'Summarize the release checklist.'
const USER_REPLY = 'The release checklist is ready for review.'
const SCHEDULE_PROMPT = 'Review the release checklist again.'
const SCHEDULE_REPLY = 'Scheduled check: the release checklist is still ready.'
const CAPTURE_MEDIA = process.env.DSH_BOT_CONVERSATION_MEDIA === '1'

function latestUserText(options: GenerateOptions): string {
  const latest = options.messages.findLast(message => message.role === 'user')
  return latest?.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n') ?? ''
}

function response(text: string): StreamChunk[] {
  const splitAt = Math.max(1, Math.floor(text.length / 2))
  return [
    // Keep one non-empty process block so the Bot Activity disclosure has
    // real work to fold while the answer remains the primary transcript row.
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'Checking the release checklist.' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Checking the release checklist.' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: text.slice(0, splitAt) },
    { type: 'text-delta', index: 1, text: text.slice(splitAt) },
    { type: 'block-end', index: 1, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 640, cacheReadTokens: 128, cacheWriteTokens: 0, outputTokens: 34, totalTokens: 802 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Keep opt-in Bot UI evidence outside the repository for local review. */
async function captureMedia(page: Page, root: string | undefined, name: string): Promise<void> {
  if (root === undefined) return
  await page.screenshot({ path: join(root, `${name}.png`), fullPage: true, animations: 'disabled' })
}

/** Deterministic Bot model seam. It handles both a human send and one due reminder. */
class BotConversationAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly firstReply = Promise.withResolvers<undefined>()

  finishFirstReply(): void {
    this.firstReply.resolve(undefined)
  }

  override async listModels(provider: string) {
    return [{ provider, id: MODEL, name: `${provider}/${MODEL}` }]
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const scheduled = latestUserText(options).includes(SCHEDULE_PROMPT)
    for (const chunk of response(scheduled ? SCHEDULE_REPLY : USER_REPLY)) {
      yield chunk
      if (!scheduled && chunk.type === 'text-delta') await this.firstReply.promise
    }
  }
}

describe.skipIf(MODE === 'record')('web e2e: Bot conversation presentation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let workspaceRoot: string | undefined
  let bot!: BotView
  let adapter: BotConversationAdapter
  let tripwire: ReturnType<typeof watchConsole>
  let mediaRoot: string | undefined

  beforeAll(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-web-e2e-bot-conversation-'))
    if (CAPTURE_MEDIA) mediaRoot = await mkdtemp(join(tmpdir(), 'dsh-web-e2e-bot-conversation-media-'))
    adapter = new BotConversationAdapter()
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE,
      replayProvidersOnly: true,
      profile: { hmr: false, packages: [] },
      workspaceCwd: workspaceRoot,
    })
    await scaffold.ctx.settings.update('ui-chat', { performanceUsage: 'compact' })
    await scaffold.ctx.settings.update('ui-theme', { preference: 'dark' })
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter),
      'Bot conversation browser fixture adapter',
    )
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
    bot = (await scaffold.ctx.bots.create({
      name: 'Scout', identity: 'browse', accent: 'teal', cwd: scaffold.workspaceCwd,
    })).bot
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.route('**/api/computer/status', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ available: true }),
    }))
    await page.route('**/api/computer/frame', route => route.fulfill({
      status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic-frame' }),
    }))
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.locator('body[data-ds-dark-theme]').waitFor({ state: 'visible', timeout: 15_000 })
    const sidebar = page.locator('[data-yh-part="sidebar"]')
    const botsMode = sidebar.getByRole('button', { name: 'Bots', exact: true })
    await botsMode.click()
    await sidebar.getByRole('button', { name: 'Bots', exact: true, pressed: true }).waitFor({ state: 'visible', timeout: 15_000 })

    const roster = sidebar.locator('aside[aria-label="Bot workspace"]')
    await roster.waitFor({ state: 'visible', timeout: 15_000 })
    await roster.locator(`[data-bot-id="${bot.id}"]`).click()
    if (mediaRoot !== undefined) console.log(`Bot conversation media: ${mediaRoot}`)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (workspaceRoot !== undefined) await rm(workspaceRoot, { recursive: true, force: true })
  })

  it('keeps the Bot transcript message-first while exposing activity, usage, and schedule origin', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bot-conversation'))
    const surface = page.locator('[data-conversation-surface="bots"]')
    await surface.waitFor({ state: 'visible', timeout: 15_000 })
    await page.setViewportSize({ width: 480, height: 1000 })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(480)
    const composer = surface.locator('[data-composer-input][contenteditable="true"]')
    await composer.fill(USER_PROMPT)
    await surface.getByRole('button', { name: 'Send message', exact: true }).click()

    try {
      const streaming = surface.locator('[data-yh-part="assistant-prose"][data-streaming]:visible')
        .filter({ hasText: /The release/u })
      await expect.poll(() => streaming.count(), { timeout: 15_000 }).toBe(1)
      await captureMedia(page, mediaRoot, 'streaming')
    } finally {
      adapter.finishFirstReply()
    }
    await expect.poll(() => adapter.requests.length, { timeout: 30_000 }).toBe(1)
    await expect.poll(() => surface.getByText(USER_PROMPT, { exact: true }).count(), { timeout: 30_000 }).toBe(1)
    await expect.poll(() => surface.getByText(USER_REPLY, { exact: true }).count(), { timeout: 30_000 }).toBe(1)

    const userRow = surface.locator('[data-chat-flow-kind="user"]').filter({ hasText: USER_PROMPT }).last()
    const assistantRow = surface.locator('[data-chat-flow-kind="assistant-step"]').filter({ hasText: USER_REPLY }).last()
    await expect.poll(() => userRow.count()).toBe(1)
    await expect.poll(() => assistantRow.count()).toBe(1)
    expect(await userRow.getAttribute('data-chat-flow-kind')).toBe('user')
    expect(await assistantRow.getAttribute('data-chat-flow-kind')).toBe('assistant-step')
    const speaker = assistantRow.locator('[data-bot-reply-speaker]')
    await expect.poll(() => speaker.textContent()).toBe(bot.name)
    await expect.poll(() => speaker.locator('[data-avatar-loaded]').count()).toBe(1)
    const sent = await userRow.locator('[data-yh-part="user-bubble"]').boundingBox()
    const received = await speaker.boundingBox()
    expect(sent).not.toBeNull()
    expect(received).not.toBeNull()
    if (sent !== null && received !== null) expect(sent.x).toBeGreaterThan(received.x)

    const activity = surface.locator('[data-composer-stat="activity"] button').first()
    const usage = surface.locator('[data-composer-stat="usage"] button').first()
    await expect.poll(() => surface.locator('[data-composer-stat="activity"]').count()).toBe(1)
    await expect.poll(() => surface.locator('[data-composer-stat="usage"]').count()).toBe(1)
    await expect.poll(() => activity.count()).toBe(1)
    await expect.poll(() => usage.count()).toBe(1)
    await expect.poll(() => activity.getAttribute('aria-label')).toBe('Activity')
    await expect.poll(() => usage.getAttribute('aria-label')).toBe('Token usage')

    // The per-turn process toggle starts as Activity and only exposes its
    // duration after the user opens it; no hidden-until-found text is queried.
    const turnActivity = surface.locator('[data-turn-process]').first()
    await expect.poll(() => turnActivity.getAttribute('aria-expanded')).toBe('false')
    await expect.poll(() => turnActivity.textContent()).toBe('Activity')
    const settledSnapshot = await captureStableAria(page, '[data-conversation-surface="bots"]', scaffold.workspaceCwd)
    await captureMedia(page, mediaRoot, 'settled')

    await turnActivity.click()
    await expect.poll(() => turnActivity.getAttribute('aria-expanded')).toBe('true')
    expect(await turnActivity.textContent()).toContain('Completed in')
    const turnActivitySnapshot = await captureStableAria(page, '[data-conversation-surface="bots"]', scaffold.workspaceCwd)

    await activity.click()
    const activityDialog = page.getByRole('dialog', { name: 'Session statistics', exact: true })
    await expect.poll(() => activityDialog.count()).toBe(1)
    const activitySnapshot = await captureStableAria(page, '[role="dialog"][aria-label="Session statistics"]', scaffold.workspaceCwd)
    await captureMedia(page, mediaRoot, 'activity')
    await usage.click()
    const usageDialog = page.getByRole('dialog', { name: 'Token usage', exact: true })
    await expect.poll(() => usageDialog.count()).toBe(1)
    expect(await usageDialog.textContent()).toContain('802 tok')
    const usageSnapshot = await captureStableAria(page, '[role="dialog"][aria-label="Token usage"]', scaffold.workspaceCwd)
    await page.keyboard.press('Escape')
    await expect.poll(() => usageDialog.count()).toBe(0)

    // The per-turn Usage action retains its own exact dialog and accounting.
    const turnUsage = surface.locator('[data-turn-usage-trigger]').first()
    await expect.poll(() => turnUsage.getAttribute('aria-label')).toBe('Token usage')
    await turnUsage.click()
    const turnUsageDialog = page.getByRole('dialog', { name: 'Turn usage', exact: true })
    await expect.poll(() => turnUsageDialog.count()).toBe(1)
    expect(await turnUsageDialog.textContent()).toContain('802 tok')
    const turnUsageSnapshot = await captureStableAria(page, '[role="dialog"][aria-label="Turn usage"]', scaffold.workspaceCwd)
    await page.keyboard.press('Escape')
    await expect.poll(() => turnUsageDialog.count()).toBe(0)

    // A due reminder enters the same Bot Session and remains attributable to its origin.
    await scaffold.ctx.schedule.create(bot.sessionId, {
      title: 'Release checklist reminder', prompt: SCHEDULE_PROMPT, after_seconds: 1,
    })
    await expect.poll(() => adapter.requests.length, { timeout: 30_000 }).toBe(2)
    await expect.poll(() => surface.getByText(SCHEDULE_REPLY, { exact: true }).count(), { timeout: 30_000 }).toBe(1)
    const trigger = surface.locator('[data-turn-trigger]').filter({ hasText: 'Automation task' }).last()
    await expect.poll(() => trigger.count(), { timeout: 30_000 }).toBe(1)
    await expect.poll(() => trigger.getByRole('button').count()).toBeGreaterThan(0)
    expect(await trigger.textContent()).toContain('Automation task')
    const origin = trigger.getByRole('button')
    expect(await origin.getAttribute('aria-expanded')).toBe('false')
    await origin.click()
    expect(await origin.getAttribute('aria-expanded')).toBe('true')
    expect(await trigger.textContent()).toContain(SCHEDULE_PROMPT)
    expect(await surface.evaluate(element => element.scrollWidth)).toBe(await surface.evaluate(element => element.clientWidth))
    await origin.click()
    const scheduledSnapshot = await captureStableAria(page, '[data-conversation-surface="bots"]', scaffold.workspaceCwd)
    await captureMedia(page, mediaRoot, 'scheduled')
    if (mediaRoot !== undefined) {
      await page.setViewportSize({ width: 1280, height: 740 })
      await captureMedia(page, mediaRoot, 'scheduled-wide')
    }

    await compareOrRefreshGolden(
      UI_EXPECTED,
      [settledSnapshot, turnActivitySnapshot, activitySnapshot, usageSnapshot, turnUsageSnapshot, scheduledSnapshot].join('\n'),
      MODE,
    )

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('keeps the synthetic Computer panel beside or over the Bot transcript and restores the draft', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bot-computer-layout'))
    await page.setViewportSize({ width: 1680, height: 1000 })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1680)

    const surface = page.locator('[data-conversation-surface="bots"]')
    await surface.waitFor({ state: 'visible', timeout: 15_000 })
    const composer = surface.locator('[data-composer-input][contenteditable="true"]')
    const draft = 'Keep this draft while I inspect the Computer panel.'
    await composer.fill(draft)
    await expect.poll(() => composer.textContent()).toContain(draft)

    const openComputer = page.getByRole('button', { name: 'Open computer panel', exact: true }).first()
    await openComputer.waitFor({ state: 'visible', timeout: 15_000 })
    await openComputer.click()
    const computer = page.locator('[data-computer-panel]')
    await computer.waitFor({ state: 'visible', timeout: 15_000 })
    await expect.poll(() => computer.getByRole('status').filter({ hasText: 'Computer control is unavailable' }).count()).toBe(1)

    const wideSurfaceBox = await surface.boundingBox()
    const wideComputerBox = await computer.boundingBox()
    expect(wideSurfaceBox).not.toBeNull()
    expect(wideComputerBox).not.toBeNull()
    if (wideSurfaceBox === null || wideComputerBox === null) throw new Error('wide Computer geometry is unavailable')
    expect(wideComputerBox.x).toBeGreaterThanOrEqual(wideSurfaceBox.x + wideSurfaceBox.width - 2)
    expect(wideComputerBox.width).toBeGreaterThan(300)

    await page.setViewportSize({ width: 480, height: 1000 })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(480)
    const narrowSurfaceBox = await surface.boundingBox()
    const narrowComputerBox = await computer.boundingBox()
    expect(narrowSurfaceBox).not.toBeNull()
    expect(narrowComputerBox).not.toBeNull()
    if (narrowSurfaceBox === null || narrowComputerBox === null) throw new Error('narrow Computer geometry is unavailable')
    const horizontalOverlap = Math.min(
      narrowSurfaceBox.x + narrowSurfaceBox.width,
      narrowComputerBox.x + narrowComputerBox.width,
    ) - Math.max(narrowSurfaceBox.x, narrowComputerBox.x)
    expect(horizontalOverlap).toBeGreaterThan(0)

    await computer.getByRole('button', { name: 'Close computer panel', exact: true }).click()
    await computer.waitFor({ state: 'detached', timeout: 15_000 })
    await expect.poll(() => page.getByRole('button', { name: 'Open computer panel', exact: true }).count()).toBe(1)
    await expect.poll(() => composer.getAttribute('contenteditable')).toBe('true')
    expect(await composer.textContent()).toContain(draft)
  })
})
