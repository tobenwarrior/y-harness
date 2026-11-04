// Keyless assembled-Web coverage for shared group creation and isolated delivery.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@yharness/llm'
import { LlmAdapter } from '@yharness/llm'
// Type-only: makes the Bot service contribution visible on the assembled Host context.
import type { BotView } from '@yharness/bots'
import type {} from '@yharness/bots'
import {
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/bot-workspace', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v3.jsonl')
const MODE = webSnapshotMode()
const PROVIDER = 'bot-group-browser-test'
const MODEL = 'reply'
const USER_MESSAGE = 'Discuss the release readiness.'
const REPLY = 'Group reply from the fixture adapter.'
const PRIVATE_SCOUT_PERSONA = 'PRIVATE_SCOUT_PERSONA'
const PRIVATE_ORBIT_PERSONA = 'PRIVATE_ORBIT_PERSONA'

/** Deterministic model response for the two shared-group recipients. */
class GroupReplyAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async listModels(provider: string) {
    return [{ provider, id: MODEL, name: `${provider}/${MODEL}` }]
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe.skipIf(MODE === 'record')('web e2e: shared Bot group workspace', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let firstBot!: BotView
  let secondBot!: BotView
  const adapter = new GroupReplyAdapter()

  beforeAll(async () => {
    // The model route is deterministic and local to this scaffold. The fixture
    // supplies only the header/catalog surface; no network model request is made.
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE,
      replayProvidersOnly: true,
      profile: { hmr: false, packages: [] },
    })
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter),
      'shared group browser fixture adapter',
    )
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
    firstBot = (await scaffold.ctx.bots.create({
      name: 'Scout',
      identity: 'browse',
      accent: 'teal',
      description: 'Public research role',
      persona: PRIVATE_SCOUT_PERSONA,
      capabilities: ['private.scout'],
      cwd: scaffold.workspaceCwd,
    })).bot
    secondBot = (await scaffold.ctx.bots.create({
      name: 'Orbit',
      identity: 'goal',
      accent: 'amber',
      description: 'Public planning role',
      persona: PRIVATE_ORBIT_PERSONA,
      capabilities: ['private.orbit'],
      cwd: scaffold.workspaceCwd,
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

  it('creates a collaborator group, sends a message, and hides private Bot profile fields', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bot-group'))
    const sidebar = page.locator('[data-yh-part="sidebar"]')
    const botsMode = sidebar.getByRole('button', { name: 'Bots', exact: true })
    await botsMode.click()
    await expect.poll(() => botsMode.getAttribute('aria-pressed')).toBe('true')

    const roster = sidebar.locator('aside[aria-label="Bot workspace"]')
    await roster.waitFor({ state: 'visible', timeout: 15_000 })
    await roster.getByRole('button', { name: 'New group', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Create a shared group', exact: true })
    await dialog.getByLabel('Group name', { exact: true }).fill('Release room')
    await dialog.getByRole('checkbox', { name: firstBot.name, exact: true }).check()
    await dialog.getByRole('checkbox', { name: secondBot.name, exact: true }).check()
    await dialog.getByRole('button', { name: 'Create group', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })

    await expect.poll(async () => {
      const groups = await scaffold.ctx.bots.listGroups({})
      return groups.groups.some(group => group.name === 'Release room')
    }).toBe(true)

    const groupRow = roster.getByRole('button', { name: 'Release room, 2 Bots', exact: true })
    await groupRow.waitFor({ state: 'visible', timeout: 15_000 })
    await groupRow.click()
    const detail = page.locator('section[aria-label="Release room"]')
    await detail.waitFor({ state: 'visible', timeout: 15_000 })
    const composer = detail.getByRole('textbox', { name: 'Message Release room', exact: true })
    await composer.fill(USER_MESSAGE)
    await detail.getByRole('button', { name: 'Send message', exact: true }).click()

    await expect.poll(() => adapter.requests.length, { timeout: 30_000 }).toBe(2)
    await expect.poll(() => detail.getByText(USER_MESSAGE, { exact: true }).count(), { timeout: 30_000 }).toBe(1)
    await expect.poll(() => detail.getByText(REPLY, { exact: true }).count(), { timeout: 30_000 }).toBe(2)
    await expect.poll(() => detail.getByText(firstBot.name, { exact: true }).count()).toBeGreaterThan(0)
    await expect.poll(() => detail.getByText(secondBot.name, { exact: true }).count()).toBeGreaterThan(0)

    const visibleText = await detail.textContent()
    expect(visibleText).not.toContain(PRIVATE_SCOUT_PERSONA)
    expect(visibleText).not.toContain(PRIVATE_ORBIT_PERSONA)
    const requestText = JSON.stringify(adapter.requests)
    expect(requestText).toContain(USER_MESSAGE)
    expect(requestText).not.toContain(PRIVATE_SCOUT_PERSONA)
    expect(requestText).not.toContain(PRIVATE_ORBIT_PERSONA)
    expect(requestText).not.toContain('private.scout')
    expect(requestText).not.toContain('private.orbit')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)
})
