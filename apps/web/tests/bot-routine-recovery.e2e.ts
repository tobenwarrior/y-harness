/** The assembled Bots workspace delivers routine events in the original Bot chat. */

import { createHmac } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import type { BotView } from '@yharness/bots'
import { credentialRef } from '@yharness/credentials'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@yharness/llm'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, writeComposerDraft } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/bot-workspace/session.v3.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/bot-routine-recovery/results.expected.md', import.meta.url))
const PROVIDER = 'bot-routine-recovery-test'
const MODEL = 'reply'
const TITLE = 'Review new messages'
const RESULT = 'The routine handled the new message.'
const MANUAL_RESULT = 'The example report is ready.'

class RoutineReplyAdapter extends LlmAdapter {
  readonly inputs: string[] = []

  constructor(private readonly releaseTest?: Promise<void>) { super() }

  override async listModels(provider: string) {
    return [{ provider, id: MODEL, name: 'Routine test model' }]
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const input = options.messages.flatMap(message =>
      message.role === 'user' ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [],
    ).join('\n')
    this.inputs.push(input)
    const manual = input.includes('[BOT ROUTINE TEST]')
    if (manual) await this.releaseTest
    const text = manual ? MANUAL_RESULT : input.includes('[BOT EVENT ROUTINE]') ? RESULT : 'Message received.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 6 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function configureModel(web: WebScaffold, releaseTest?: Promise<void>): Promise<RoutineReplyAdapter> {
  const adapter = new RoutineReplyAdapter(releaseTest)
  web.ctx.effect(() => web.ctx.llm.registerAdapter([PROVIDER], adapter), 'routine recovery fixture')
  await web.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
  return adapter
}

async function selectBot(page: Page, web: WebScaffold, bot: BotView): Promise<Locator> {
  await page.goto(web.authenticatedUrl, { waitUntil: 'load' })
  const sidebar = page.locator('[data-yh-part="sidebar"]')
  const mode = sidebar.getByRole('button', { name: 'Bots', exact: true })
  await mode.waitFor()
  if (await mode.getAttribute('aria-pressed') !== 'true') await mode.click()
  await sidebar.locator('[data-bot-id="' + String(bot.id) + '"]').click()
  const conversation = page.locator('[data-conversation-session="' + String(bot.sessionId) + '"]')
  await conversation.waitFor()
  return conversation
}

async function openRoutines(page: Page) {
  await page.getByRole('button', { name: 'Bot options', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Manage routines', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Bot routines', exact: true })
  await dialog.getByRole('list', { name: 'Bot routines', exact: true }).waitFor()
  return dialog
}

async function sendMessage(page: Page, conversation: Locator, text: string): Promise<void> {
  await writeComposerDraft(page, conversation.locator('[data-composer-input]'), text)
  await conversation.getByRole('button', { name: 'Send message', exact: true }).click()
}

async function createRoutine(
  web: WebScaffold, bot: BotView, title: string, event: Record<string, string>, approved = true,
) {
  const provider = web.ctx.get('codexDynamicTools')
  const tools = await provider?.resolve({ sessionId: bot.sessionId, provider: PROVIDER, model: MODEL, messages: [] })
  const create = tools?.find(tool => tool.name === 'schedule_create')
  if (create === undefined) throw new Error('Routine tool unavailable in the assembled Host')
  const result = await create.execute({ title, prompt: 'Summarize the new event.', event }, {
    callId: 'recovery-browser-' + title + '-' + String(approved), threadId: 'recovery-browser-thread', turnId: 'recovery-browser-turn',
    sessionId: bot.sessionId, signal: new AbortController().signal, approvalPolicy: 'on-request',
    requestApproval: async () => approved,
  })
  expect(result.success).toBe(approved)
  if (!approved) return undefined
  const [routine] = (await web.ctx.bots.listRoutines({ botId: bot.id })).routines
  if (routine?.kind !== 'event') throw new Error('Event routine was not created')
  return { botId: bot.id, routineId: routine.id, limit: 10 }
}

it.skipIf(webSnapshotMode() === 'record')('keeps a paused message out of Results and runs once for a fresh message', async () => {
  const workspaceCwd = await mkdtemp(join(tmpdir(), 'yh-routine-recovery-'))
  const persistenceRoot = join(workspaceCwd, 'sessions')
  const options = { workspaceCwd, persistenceRoot, replayFixture: FIXTURE, replayProvidersOnly: true }
  let web: WebScaffold | undefined
  let browser: Browser | undefined
  try {
    await mkdir(persistenceRoot)
    browser = await chromium.launch()
    web = await launchWebScaffold(options)
    await configureModel(web)
    const { bot } = await web.ctx.bots.create({ name: 'Scout', cwd: workspaceCwd, identity: 'browse', accent: 'teal' })
    const request = await createRoutine(web, bot, TITLE, { type: 'message', source: 'user' })
    if (request === undefined) throw new Error('Message routine was not created')

    const firstPage = await newEnglishPage(browser)
    const firstConversation = await selectBot(firstPage, web, bot)
    let dialog = await openRoutines(firstPage)
    await dialog.getByRole('button', { name: 'Pause ' + TITLE, exact: true }).click()
    await dialog.getByRole('button', { name: 'Resume ' + TITLE, exact: true }).waitFor()
    await firstPage.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await Promise.all([web.whenTurnSettled(), sendMessage(firstPage, firstConversation, 'This message arrived while paused.')])
    dialog = await openRoutines(firstPage)
    await dialog.getByRole('button', { name: 'Resume ' + TITLE, exact: true }).click()
    await dialog.getByRole('button', { name: 'Pause ' + TITLE, exact: true }).waitFor()
    await firstPage.close()
    const firstHost = web
    web = undefined
    await firstHost.close()

    web = await launchWebScaffold(options)
    const reopened = web
    await configureModel(reopened)
    expect(await reopened.ctx.bots.routineHistory(request)).toMatchObject({ kind: 'event', deliveries: [], results: [] })
    const page = await newEnglishPage(browser)
    const screenshots = process.env.DSH_BOT_ROUTINE_SCREENSHOTS
    if (screenshots !== undefined) {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    }
    const tripwire = watchConsole(page)
    const conversation = await selectBot(page, reopened, bot)
    dialog = await openRoutines(page)
    await dialog.getByRole('tab', { name: 'Results', exact: true }).click()
    const empty = dialog.getByText('No deliveries recorded yet.', { exact: true })
    await empty.waitFor()
    const afterRestart = await empty.ariaSnapshot()
    if (screenshots !== undefined) {
      await page.screenshot({ path: join(screenshots, 'bot-routine-after-restart.png'), animations: 'disabled' })
    }
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })

    await sendMessage(page, conversation, 'This is the first new message after resume.')
    await expect.poll(async () => await reopened.ctx.bots.routineHistory(request), { timeout: 20_000 }).toMatchObject({
      kind: 'event', deliveries: [{ status: 'delivered' }], results: [{ status: 'completed', output: RESULT }],
    })
    dialog = await openRoutines(page)
    await dialog.getByRole('tab', { name: 'Results', exact: true }).click()
    const deliveries = dialog.getByRole('list', { name: 'Deliveries', exact: true })
    const results = dialog.getByRole('list', { name: 'Runs', exact: true })
    await results.getByText(RESULT, { exact: true }).waitFor()
    expect(await deliveries.getByRole('listitem').count()).toBe(1)
    expect(await results.getByRole('listitem').count()).toBe(1)
    await compareOrRefreshGolden(EXPECTED, [
      afterRestart,
      await deliveries.getByText('Delivered', { exact: true }).ariaSnapshot(),
      await results.getByText(RESULT, { exact: true }).ariaSnapshot(),
    ].join('\n'), webSnapshotMode())
    if (screenshots !== undefined) {
      for (const width of [1440, 480]) {
        await page.setViewportSize({ width, height: 900 })
        const bounds = await dialog.boundingBox()
        if (bounds === null) throw new Error('Routines dialog is unavailable')
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
        await page.screenshot({ path: join(screenshots, 'bot-routine-results-' + String(width) + '.png'), animations: 'disabled' })
      }
    }
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    try {
      await browser?.close()
    } finally {
      try {
        await web?.close()
      } finally {
        await rm(workspaceCwd, { recursive: true, force: true })
      }
    }
  }
}, 120_000)

const GITHUB_OVERLAY = fileURLToPath(new URL(
  '../../../apps/cli/config/examples/github-bot-routines/cordis.yml', import.meta.url,
))
const GITHUB_EXPECTED = fileURLToPath(new URL('./expected/bot-routine-recovery/github.expected.md', import.meta.url))
const GITHUB_REF = credentialRef('DSH_GITHUB_BOT_WEBHOOK_SECRET')
const GITHUB_SECRET = 'synthetic-routine-test-secret'
const GITHUB_TITLE = 'Summarize new pull requests'
const REPOSITORY = 'example/workbench'

type SignedRequestOptions = {
  readonly repository?: string
  readonly key?: string
  readonly action?: string
  readonly openedAt?: string
}

async function sendGitHubPullRequest(
  web: WebScaffold, subject: number, delivery: string, options: SignedRequestOptions = {},
): Promise<number> {
  const server = [...web.ctx.loader.entries()].find(entry => entry.options.id === 'github-bot-webhook-server')
  const port = server?.fiber?.ctx.get('webServer')?.port
  if (port === undefined || port === 0) throw new Error('The isolated signed GitHub listener did not bind')
  expect(port).not.toBe(web.ctx.webServer.port)
  const body = JSON.stringify({
    action: options.action ?? 'opened',
    repository: { full_name: options.repository ?? REPOSITORY },
    pull_request: { number: subject, created_at: options.openedAt ?? new Date().toISOString(), body: 'Untrusted fixture description' },
  })
  const signature = 'sha256=' + createHmac('sha256', options.key ?? GITHUB_SECRET).update(body).digest('hex')
  const response = await fetch('http://127.0.0.1:' + String(port) + '/github', {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-hub-signature-256': signature,
      'x-github-event': 'pull_request', 'x-github-delivery': delivery,
    },
    body,
  })
  return response.status
}

it.skipIf(webSnapshotMode() === 'record')('runs a signed GitHub trigger once in the same Bot chat across Host restart', async () => {
  const workspaceCwd = await mkdtemp(join(tmpdir(), 'yh-github-routine-'))
  const persistenceRoot = join(workspaceCwd, 'sessions')
  const overlay = join(workspaceCwd, 'github-routines.yml')
  const options = { workspaceCwd, persistenceRoot, extraOverlayPath: overlay, replayFixture: FIXTURE, replayProvidersOnly: true }
  let web: WebScaffold | undefined
  let browser: Browser | undefined
  try {
    const source = await readFile(GITHUB_OVERLAY, 'utf8')
    const ephemeralPort = source.replace('port: !!js Number(process.env.DSH_GITHUB_BOT_WEBHOOK_PORT ?? 3082)', 'port: 0')
    expect(ephemeralPort).not.toBe(source)
    await writeFile(overlay, ephemeralPort)
    await mkdir(persistenceRoot)
    web = await launchWebScaffold(options)
    const adapter = await configureModel(web)
    await web.ctx.credentials.set(GITHUB_REF, GITHUB_SECRET)
    const { bot } = await web.ctx.bots.create({ name: 'Release watch', cwd: workspaceCwd, identity: 'browse', accent: 'teal' })
    const event = { type: 'github', source: 'bot-github', repository: REPOSITORY, event: 'pull_request.opened' }
    await createRoutine(web, bot, GITHUB_TITLE, event, false)
    expect(await web.ctx.bots.listRoutines({ botId: bot.id })).toEqual({ routines: [] })
    const request = await createRoutine(web, bot, GITHUB_TITLE, event)
    if (request === undefined) throw new Error('GitHub routine was not created')
    expect(await sendGitHubPullRequest(web, 16, 'invalid-signature', { key: 'invalid-test-secret' })).toBe(401)
    expect(await sendGitHubPullRequest(web, 16, 'other-repository', { repository: 'example/unselected' })).toBe(202)
    expect(await sendGitHubPullRequest(web, 16, 'wrong-action', { action: 'closed' })).toBe(202)
    expect(await web.ctx.bots.routineHistory(request)).toMatchObject({ deliveries: [], results: [] })

    browser = await chromium.launch()
    const firstPage = await newEnglishPage(browser)
    await selectBot(firstPage, web, bot)
    let dialog = await openRoutines(firstPage)
    await dialog.getByText('GitHub trigger', { exact: true }).waitFor()
    await dialog.getByText('Runs when a pull request opens in ' + REPOSITORY, { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Pause ' + GITHUB_TITLE, exact: true }).click()
    await dialog.getByRole('button', { name: 'Resume ' + GITHUB_TITLE, exact: true }).waitFor()
    const pausedAt = new Date().toISOString()
    expect(await sendGitHubPullRequest(web, 16, 'during-pause', { openedAt: pausedAt })).toBe(202)
    await dialog.getByRole('button', { name: 'Resume ' + GITHUB_TITLE, exact: true }).click()
    await dialog.getByRole('button', { name: 'Pause ' + GITHUB_TITLE, exact: true }).waitFor()
    expect(await sendGitHubPullRequest(web, 16, 'during-pause', { openedAt: pausedAt })).toBe(202)
    expect(await web.ctx.bots.routineHistory(request)).toMatchObject({ deliveries: [], results: [] })
    await firstPage.context().close()

    const active = web
    const openedAt = new Date().toISOString()
    expect(await sendGitHubPullRequest(active, 17, 'signed-first', { openedAt })).toBe(202)
    const expected = {
      deliveries: [{ github: { repository: REPOSITORY, subject: 17 }, status: 'delivered' }],
      results: [{ status: 'completed', output: RESULT }],
    }
    await expect.poll(() => adapter.inputs.length, { timeout: 20_000 }).toBe(1)
    const [input] = adapter.inputs
    expect(input).toContain('Summarize the new event.')
    expect(input).toContain('https://github.com/example/workbench/pull/17')
    expect(input).not.toContain('Untrusted fixture description')
    await expect.poll(() => active.ctx.bots.routineHistory(request), { timeout: 20_000 }).toMatchObject(expected)
    web = undefined
    await active.close()

    web = await launchWebScaffold(options)
    await configureModel(web)
    await web.ctx.credentials.set(GITHUB_REF, GITHUB_SECRET)
    expect(await sendGitHubPullRequest(web, 17, 'signed-redelivery', { openedAt })).toBe(202)
    expect(await web.ctx.bots.routineHistory(request)).toMatchObject(expected)
    const { events } = await web.ctx.sessionController.inspect(bot.sessionId)
    const webhookMessages = events.flatMap(value => value.type === 'user/message' && value.data.source.kind === 'webhook' ? [value.data] : [])
    expect(webhookMessages).toHaveLength(1)
    const webhookText = webhookMessages[0]?.content[0]
    expect(webhookText?.type === 'text' ? webhookText.text : undefined).toContain('https://github.com/example/workbench/pull/17')
    expect(JSON.stringify(webhookMessages)).not.toContain('Untrusted fixture description')

    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    const conversation = await selectBot(page, web, bot)
    await conversation.getByText(RESULT, { exact: true }).waitFor()
    dialog = await openRoutines(page)
    await dialog.getByRole('tab', { name: 'Results', exact: true }).click()
    const receipt = dialog.getByText(REPOSITORY + ' #17', { exact: true })
    const result = dialog.getByText(RESULT, { exact: true })
    await result.waitFor()
    await compareOrRefreshGolden(GITHUB_EXPECTED, [
      await dialog.getByText('GitHub trigger', { exact: true }).ariaSnapshot(),
      await receipt.ariaSnapshot(),
      await result.ariaSnapshot(),
    ].join('\n'), webSnapshotMode())
    const screenshots = process.env.DSH_BOT_ROUTINE_SCREENSHOTS
    if (screenshots !== undefined) {
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
      for (const width of [1440, 480]) {
        await page.setViewportSize({ width, height: 900 })
        const bounds = await dialog.boundingBox()
        if (bounds === null) throw new Error('GitHub Results panel is unavailable')
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
        await page.screenshot({ path: join(screenshots, 'github-routine-' + String(width) + '.png'), animations: 'disabled' })
      }
    }
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    try {
      await browser?.close()
    } finally {
      try {
        await web?.close()
      } finally {
        await rm(workspaceCwd, { recursive: true, force: true })
      }
    }
  }
}, 120_000)

const MANUAL_EXPECTED = fileURLToPath(new URL('./expected/bot-routine-recovery/test-run.expected.md', import.meta.url))

async function captureRoutineTest(page: Page, name: string, dialog?: Locator): Promise<void> {
  const screenshots = process.env.DSH_BOT_ROUTINE_TEST_SCREENSHOTS
  if (screenshots === undefined) return
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  for (const width of [1440, 480]) {
    await page.setViewportSize({ width, height: 900 })
    if (dialog !== undefined) {
      const bounds = await dialog.boundingBox()
      expect(bounds).not.toBeNull()
      if (bounds !== null) {
        expect(bounds.x).toBeGreaterThanOrEqual(0)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(900)
      }
    }
    await page.screenshot({ path: join(screenshots, name + '-' + String(width) + '.png'), animations: 'disabled' })
  }
}

it.skipIf(webSnapshotMode() === 'record')('tests a paused routine in the same chat while its browser is closed', async () => {
  const workspaceCwd = await mkdtemp(join(tmpdir(), 'yh-manual-bot-routine-'))
  const persistenceRoot = join(workspaceCwd, 'sessions')
  const options = { workspaceCwd, persistenceRoot, replayFixture: FIXTURE, replayProvidersOnly: true }
  const release = Promise.withResolvers<undefined>()
  const title = 'Review the daily report'
  let web: WebScaffold | undefined
  let browser: Browser | undefined
  try {
    await mkdir(persistenceRoot)
    web = await launchWebScaffold(options)
    const firstHost = web
    const adapter = await configureModel(firstHost, release.promise)
    const { bot } = await firstHost.ctx.bots.create({ name: 'Scout', cwd: workspaceCwd, identity: 'browse', accent: 'teal' })
    const schedule = firstHost.ctx.get('schedule')
    if (schedule === undefined) throw new Error('Schedule service is unavailable')
    const task = await schedule.create(bot.sessionId, {
      title, prompt: 'Read the example report and summarize the highlights.', every_seconds: 86_400,
    })
    const query = { botId: bot.id, routineId: String(task.id) }
    await firstHost.ctx.bots.pauseRoutine(query)
    const scheduleBefore = await schedule.catalog()
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    await selectBot(page, firstHost, bot)
    let dialog = await openRoutines(page)
    const start = dialog.getByRole('button', { name: 'Run test', exact: true })
    await start.waitFor()
    await expect.poll(async () => start.isEnabled()).toBe(true)
    const buttonSnapshot = await start.ariaSnapshot()
    await captureRoutineTest(page, 'test-action', dialog)
    await start.click()
    const running = dialog.getByRole('button', { name: 'Running…', exact: true })
    await running.waitFor()
    expect(await running.isDisabled()).toBe(true)
    const runningSnapshot = await running.ariaSnapshot()
    await captureRoutineTest(page, 'test-running', dialog)
    await page.close()
    release.resolve(undefined)
    await expect.poll(async () => (await firstHost.ctx.bots.routineTestStatus(query)).run?.status).toBe('completed')
    expect(adapter.inputs.filter(input => input.includes('[BOT ROUTINE TEST]'))).toHaveLength(1)
    expect(await schedule.catalog()).toEqual(scheduleBefore)
    expect(await firstHost.ctx.bots.routineHistory({ ...query, limit: 10 })).toMatchObject({ records: [] })
    web = undefined
    await firstHost.close()

    web = await launchWebScaffold(options)
    await configureModel(web)
    const reopened = await newEnglishPage(browser)
    const conversation = await selectBot(reopened, web, bot)
    const trigger = conversation.getByText('Routine test', { exact: true })
    const result = conversation.getByText(MANUAL_RESULT, { exact: true })
    await result.waitFor()
    await trigger.waitFor()
    expect(await result.count()).toBe(1)
    await captureRoutineTest(reopened, 'test-chat-result')
    dialog = await openRoutines(reopened)
    const completed = dialog.getByText('Test completed', { exact: true })
    await completed.waitFor()
    const completionColors = await completed.evaluate((element) => {
      const controls = element.parentElement
      if (controls === null) throw new Error('The routine test controls are missing')
      return { rendered: getComputedStyle(element).color, label: getComputedStyle(controls).color }
    })
    expect(completionColors.rendered).toBe(completionColors.label)
    await dialog.getByRole('button', { name: 'Resume ' + title, exact: true }).waitFor()
    await captureRoutineTest(reopened, 'test-completed', dialog)
    await compareOrRefreshGolden(MANUAL_EXPECTED, [
      buttonSnapshot,
      runningSnapshot,
      await trigger.ariaSnapshot(),
      await result.ariaSnapshot(),
      await completed.ariaSnapshot(),
    ].join('\n'), webSnapshotMode())
    await dialog.getByRole('button', { name: 'Back to chat', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    expect(await result.isVisible()).toBe(true)
  } finally {
    release.resolve(undefined)
    try {
      await browser?.close()
    } finally {
      try {
        await web?.close()
      } finally {
        await rm(workspaceCwd, { recursive: true, force: true })
      }
    }
  }
}, 120_000)

const WEBHOOK_OVERLAY = fileURLToPath(new URL(
  '../../../apps/cli/config/examples/bot-routine-webhooks/cordis.yml', import.meta.url,
))
const WEBHOOK_EXPECTED = fileURLToPath(new URL('./expected/bot-routine-recovery/webhook.expected.md', import.meta.url))
const WEBHOOK_TITLE = 'Review incoming reports'
const WEBHOOK_HOST = 'hooks.example.invalid'

async function captureExternalRoutine(
  page: Page, screenshots: string | undefined, name: string, dialog?: Locator,
): Promise<void> {
  if (screenshots === undefined) return
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    for (const width of [1440, 480]) {
      await page.setViewportSize({ width, height: 900 })
      const sidebar = page.locator('[data-yh-part="sidebar"]')
      await expect.poll(() => sidebar.evaluate(element => element.getBoundingClientRect().width < 100))
        .toBe(width === 480)
      if (dialog !== undefined) {
        const bounds = await dialog.boundingBox()
        if (bounds === null) throw new Error('Routines dialog is unavailable')
        expect(bounds.x).toBeGreaterThanOrEqual(0)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(900)
      }
      await page.screenshot({ path: join(screenshots, name + '-' + colorScheme + '-' + String(width) + '.png'), animations: 'disabled' })
    }
  }
}

it.skipIf(webSnapshotMode() === 'record')('accepts a private keyed routine webhook once and keeps the reply in the same Bot chat', async () => {
  const workspaceCwd = await mkdtemp(join(tmpdir(), 'yh-webhook-routine-'))
  const persistenceRoot = join(workspaceCwd, 'sessions')
  const overlay = join(workspaceCwd, 'webhook-routines.yml')
  const options = { workspaceCwd, persistenceRoot, extraOverlayPath: overlay, replayFixture: FIXTURE, replayProvidersOnly: true }
  let web: WebScaffold | undefined
  let browser: Browser | undefined
  try {
    await mkdir(persistenceRoot)
    const example = await readFile(WEBHOOK_OVERLAY, 'utf8')
    await writeFile(overlay, example.replace('https://hooks.example/', 'https://' + WEBHOOK_HOST + '/workbench/'))
    web = await launchWebScaffold(options)
    const firstHost = web
    const adapter = await configureModel(firstHost)
    const { bot } = await firstHost.ctx.bots.create({ name: 'Report Scout', cwd: workspaceCwd, identity: 'browse', accent: 'teal' })
    await createRoutine(firstHost, bot, WEBHOOK_TITLE, { type: 'webhook' }, false)
    expect(await firstHost.ctx.bots.listRoutines({ botId: bot.id })).toEqual({ routines: [] })
    const entry = await createRoutine(firstHost, bot, WEBHOOK_TITLE, { type: 'webhook' })
    if (entry === undefined) throw new Error('The webhook routine was not created')
    const query = { botId: entry.botId, routineId: entry.routineId }
    const setup = await firstHost.ctx.bots.routineWebhookSetup(query)
    const route = '/bot-hooks/' + String(bot.id) + '/' + query.routineId
    expect(setup.postUrl).toBe('https://' + WEBHOOK_HOST + '/workbench' + route)
    const caller = (host: WebScaffold) => 'http://127.0.0.1:' + String(host.ctx.webServer.port) + route
    const send = async (host: WebScaffold, key: string, id: string, body?: string): Promise<number> => {
      const response = await fetch(caller(host), {
        method: 'POST',
        headers: { authorization: 'Bearer ' + key, 'idempotency-key': id, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body }),
      })
      await response.body?.cancel()
      return response.status
    }
    expect((await fetch(caller(firstHost) + '?key=ignored', { method: 'POST' })).status).toBe(404)
    expect((await fetch(caller(firstHost), { method: 'POST' })).status).toBe(404)
    expect((await fetch(caller(firstHost))).status).toBe(405)
    expect(await send(firstHost, 'A'.repeat(43), 'wrong-key')).toBe(404)
    expect(await send(firstHost, setup.key, 'bad/json', '{}')).toBe(400)
    expect(await send(firstHost, setup.key, 'invalid-json', '{')).toBe(400)
    expect(await send(firstHost, setup.key, 'oversize', JSON.stringify('x'.repeat(16_384)))).toBe(413)

    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    await page.addInitScript(() => {
      let clipboardText = ''
      Object.defineProperty(navigator, 'clipboard', { value: {
        writeText: async (text: string) => { clipboardText = text },
        readText: async () => clipboardText,
      } })
    })
    const tripwire = watchConsole(page)
    await selectBot(page, firstHost, bot)
    const dialog = await openRoutines(page)
    const connection = dialog.getByRole('group', { name: 'Webhook connection', exact: true })
    const copyURL = connection.getByRole('button', { name: 'Copy URL', exact: true })
    const copyKey = connection.getByRole('button', { name: 'Copy key', exact: true })
    const copyHeader = connection.getByRole('button', { name: 'Copy authorization header', exact: true })
    await copyURL.waitFor()
    const setupSnapshot = await connection.ariaSnapshot()
    expect((await connection.innerText()).includes(setup.key)).toBe(false)
    await captureExternalRoutine(page, process.env.DSH_BOT_ROUTINE_WEBHOOK_SCREENSHOTS, 'webhook-setup', dialog)
    await copyURL.click()
    await expect.poll(() => page.evaluate(async () => await navigator.clipboard.readText())).toBe(setup.postUrl)
    await copyKey.click()
    await expect.poll(async () => (await page.evaluate(async () => await navigator.clipboard.readText())) === setup.key).toBe(true)
    await copyHeader.click()
    await expect.poll(async () => (await page.evaluate(async () => await navigator.clipboard.readText())) === 'Authorization: Bearer ' + setup.key).toBe(true)
    await dialog.getByRole('button', { name: 'Pause ' + WEBHOOK_TITLE, exact: true }).click()
    const resume = dialog.getByRole('button', { name: 'Resume ' + WEBHOOK_TITLE, exact: true })
    await resume.waitFor()
    expect(await send(firstHost, setup.key, 'while-paused', '{"title":"Paused"}')).toBe(409)
    expect(await firstHost.ctx.bots.routineHistory(entry)).toMatchObject({ deliveries: [], results: [] })
    await resume.click()
    await dialog.getByRole('button', { name: 'Pause ' + WEBHOOK_TITLE, exact: true }).waitFor()

    await connection.getByRole('button', { name: 'Rotate key', exact: true }).click()
    const replace = connection.getByRole('button', { name: 'Replace key', exact: true })
    await replace.waitFor()
    const rotationSnapshot = await replace.ariaSnapshot()
    await captureExternalRoutine(page, process.env.DSH_BOT_ROUTINE_WEBHOOK_SCREENSHOTS, 'webhook-rotate', dialog)
    await replace.click()
    await connection.getByText('Key replaced. Copy the new key or authorization header.', { exact: true }).waitFor()
    const rotated = await firstHost.ctx.bots.routineWebhookSetup(query)
    expect(rotated.key !== setup.key).toBe(true)
    expect(rotated.postUrl).toBe(setup.postUrl)
    expect(await send(firstHost, setup.key, 'revoked-key')).toBe(404)
    await page.evaluate(async () => { await navigator.clipboard.writeText('') })
    expect(tripwire.pageErrors).toEqual([])
    await page.context().close()

    const body = '{"title":"Sample report","status":"ready"}'
    expect(await Promise.all([
      send(firstHost, rotated.key, 'fresh-report', body),
      send(firstHost, rotated.key, 'fresh-report', body),
    ])).toEqual([200, 200])
    await expect.poll(async () => await firstHost.ctx.bots.routineHistory(entry), { timeout: 20_000 }).toMatchObject({
      deliveries: [{ status: 'delivered', webhook: {} }],
      results: [{ status: 'completed', output: RESULT }],
    })
    expect(adapter.inputs.filter(input => input.includes('Webhook payload from an external sender.'))).toHaveLength(1)
    expect(adapter.inputs.some(input => input.includes(JSON.stringify(body)))).toBe(true)
    expect(JSON.stringify(await firstHost.ctx.bots.routineHistory(entry))).not.toContain(body)

    web = undefined
    await firstHost.close()
    web = await launchWebScaffold(options)
    const reopened = web
    await configureModel(reopened)
    const reopenedSetup = await reopened.ctx.bots.routineWebhookSetup(query)
    expect(reopenedSetup.key === rotated.key).toBe(true)
    expect(await send(reopened, reopenedSetup.key, 'fresh-report', body)).toBe(200)
    const reopenedPage = await newEnglishPage(browser)
    const conversation = await selectBot(reopenedPage, reopened, bot)
    const notice = conversation.getByText('External event received', { exact: true })
    const output = conversation.getByText(RESULT, { exact: true })
    await output.waitFor()
    expect(await output.count()).toBe(1)
    await notice.waitFor()
    await captureExternalRoutine(reopenedPage, process.env.DSH_BOT_ROUTINE_WEBHOOK_SCREENSHOTS, 'webhook-chat')
    const resultsDialog = await openRoutines(reopenedPage)
    await resultsDialog.getByRole('tab', { name: 'Results', exact: true }).click()
    const deliveries = resultsDialog.getByRole('list', { name: 'Deliveries', exact: true })
    const results = resultsDialog.getByRole('list', { name: 'Runs', exact: true })
    await results.getByText(RESULT, { exact: true }).waitFor()
    expect(await deliveries.getByRole('listitem').count()).toBe(1)
    expect(await results.getByRole('listitem').count()).toBe(1)
    await captureExternalRoutine(reopenedPage, process.env.DSH_BOT_ROUTINE_WEBHOOK_SCREENSHOTS, 'webhook-result', resultsDialog)
    await compareOrRefreshGolden(WEBHOOK_EXPECTED, [
      setupSnapshot, rotationSnapshot, await notice.ariaSnapshot(), await output.ariaSnapshot(),
      await deliveries.getByText('Delivered', { exact: true }).ariaSnapshot(),
    ].join('\n'), webSnapshotMode())
  } finally {
    try {
      await browser?.close()
    } finally {
      try {
        await web?.close()
      } finally {
        await rm(workspaceCwd, { recursive: true, force: true })
      }
    }
  }
}, 120_000)

const SLACK_EXPECTED = fileURLToPath(new URL('./expected/bot-routine-recovery/slack.expected.md', import.meta.url))
const SLACK_TITLE = 'Review release updates'
const SLACK_SOURCE = 'example-slack'
const SLACK_WORKSPACE = 'TWORKBENCH'
const SLACK_APP = 'AEXAMPLEAPP'
const SLACK_CHANNEL = 'CRELEASES'
const SLACK_TOKEN_REF = credentialRef('DSH_TEST_SLACK_APP_TOKEN')
const SLACK_TOKEN = 'xapp-fixture-for-local-test'
const SLACK_MESSAGE = 'The release ready checklist is attached.'

function newSlackMessage(eventId: string, time: number, text = SLACK_MESSAGE) {
  const timestamp = (time / 1000).toFixed(6)
  return {
    type: 'event_callback', team_id: SLACK_WORKSPACE, api_app_id: SLACK_APP, event_id: eventId,
    event: { type: 'message', channel: SLACK_CHANNEL, user: 'UEXAMPLE', ts: timestamp, event_ts: timestamp, text },
  }
}

async function sendSlackEnvelope(peer: WebSocket, envelopeId: string, payload: object): Promise<void> {
  const acknowledgement = once(peer, 'message', { signal: AbortSignal.timeout(10_000) })
  peer.send(JSON.stringify({ type: 'events_api', envelope_id: envelopeId, accepts_response_payload: false, payload }))
  const frames: unknown[] = await acknowledgement
  const result = frames[0]
  if (!Buffer.isBuffer(result)) throw new Error('The Socket Mode acknowledgement was not a text frame')
  expect(JSON.parse(result.toString())).toEqual({ envelope_id: envelopeId })
}

async function mountSlackFixture(web: WebScaffold, server: WebSocketServer): Promise<WebSocket> {
  const entry = new URL('../../../packages/bundle/web-app/lib/routine-slack.js', import.meta.url).href
  const plugin = await import(entry) as typeof import('../../../packages/bundle/web-app/src/routine-slack.ts')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The local Slack fixture did not bind')
  const config = plugin.Config({
    source: SLACK_SOURCE, workspaceId: SLACK_WORKSPACE, appId: SLACK_APP, appTokenEnv: SLACK_TOKEN_REF,
  })
  await web.ctx.credentials.set(SLACK_TOKEN_REF, SLACK_TOKEN)
  const connected = once(server, 'connection', { signal: AbortSignal.timeout(10_000) })
  web.ctx.effect(() => plugin.mountSlackRoutineSource(web.ctx, config, options =>
    plugin.createSlackSocketTransport({
      ...options,
      fetch: async (url, init) => {
        expect(url).toBe('https://slack.com/api/apps.connections.open')
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + SLACK_TOKEN)
        return Response.json({ ok: true, url: 'wss://wss.slack.com/link/?ticket=demo' })
      },
      openSocket: () => {
        const socket = new WebSocket('ws://127.0.0.1:' + String(address.port))
        return {
          onOpen: (listener) => { socket.on('open', listener) },
          onMessage: (listener) => { socket.on('message', (data) => { if (Buffer.isBuffer(data)) listener(data.toString()) }) },
          onClose: (listener) => { socket.on('close', listener) },
          onError: (listener) => { socket.on('error', listener) },
          send: (data) => { socket.send(data) },
          close: (code, reason) => { socket.close(code, reason) },
        }
      },
    })), 'local Slack Socket Mode fixture')
  const peers: unknown[] = await connected
  const peer = peers[0]
  if (!(peer instanceof WebSocket)) throw new Error('Expected a local Slack fixture connection')
  return peer
}

it.skipIf(webSnapshotMode() === 'record')('acknowledges Slack activity once and keeps its reply in the same Bot chat after restart', async () => {
  const workspaceCwd = await mkdtemp(join(tmpdir(), 'yh-slack-routine-'))
  const persistenceRoot = join(workspaceCwd, 'sessions')
  const options = { workspaceCwd, persistenceRoot, replayFixture: FIXTURE, replayProvidersOnly: true }
  const socketServer = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  let web: WebScaffold | undefined
  let browser: Browser | undefined
  try {
    await once(socketServer, 'listening')
    await mkdir(persistenceRoot)
    web = await launchWebScaffold(options)
    const firstHost = web
    const adapter = await configureModel(firstHost)
    const firstPeer = await mountSlackFixture(firstHost, socketServer)
    const { bot } = await firstHost.ctx.bots.create({
      name: 'Release Scout', cwd: workspaceCwd, identity: 'sparkle', accent: 'violet',
    })
    const filter = {
      type: 'slack', source: SLACK_SOURCE, workspaceId: SLACK_WORKSPACE, event: 'message',
      channelId: SLACK_CHANNEL, textIncludes: 'release ready',
    }
    await createRoutine(firstHost, bot, SLACK_TITLE, filter, false)
    expect(await firstHost.ctx.bots.listRoutines({ botId: bot.id })).toEqual({ routines: [] })
    const request = await createRoutine(firstHost, bot, SLACK_TITLE, filter)
    if (request === undefined) throw new Error('Slack routine was not created')

    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    await selectBot(page, firstHost, bot)
    let dialog = await openRoutines(page)
    const scope = dialog.locator('dl[aria-label="Slack filters"]')
    await scope.getByText('release ready', { exact: true }).waitFor()
    const ruleSnapshot = [
      await dialog.getByText('Slack trigger', { exact: true }).ariaSnapshot(),
      await dialog.getByText('Runs when someone posts a message in Slack', { exact: true }).ariaSnapshot(),
      await scope.ariaSnapshot(),
    ].join('\n')
    await captureExternalRoutine(page, process.env.DSH_BOT_ROUTINE_SLACK_SCREENSHOTS, 'slack-rule', dialog)

    const pause = dialog.getByRole('button', { name: 'Pause ' + SLACK_TITLE, exact: true })
    const resume = dialog.getByRole('button', { name: 'Resume ' + SLACK_TITLE, exact: true })
    await pause.click()
    await resume.waitFor()
    const pausedEvent = newSlackMessage('EvPAUSEDFIXTURE', Date.now())
    await sendSlackEnvelope(firstPeer, 'paused-event', pausedEvent)
    await resume.click()
    await pause.waitFor()
    await sendSlackEnvelope(firstPeer, 'paused-event-retry', pausedEvent)
    await sendSlackEnvelope(firstPeer, 'irrelevant-event', newSlackMessage('EvOTHER', Date.now(), 'Weekly office hours'))
    expect(await firstHost.ctx.bots.routineHistory(request)).toMatchObject({ deliveries: [], results: [] })

    const afterResume = Date.now()
    await expect.poll(() => Date.now()).toBeGreaterThan(afterResume)
    const freshEvent = newSlackMessage('EvNEWRELEASE', Date.now())
    await sendSlackEnvelope(firstPeer, 'fresh-event', freshEvent)
    const expected = {
      deliveries: [{ slack: { deliveryId: 'EvNEWRELEASE', channelId: SLACK_CHANNEL }, status: 'delivered' }],
      results: [{ status: 'completed', output: RESULT }],
    }
    await expect.poll(() => firstHost.ctx.bots.routineHistory(request), { timeout: 20_000 }).toMatchObject(expected)
    expect(adapter.inputs).toHaveLength(1)
    expect(adapter.inputs[0]).toContain('Summarize the new event.')
    expect(adapter.inputs[0]).toContain('untrusted data')
    expect(adapter.inputs[0]).toContain(SLACK_MESSAGE)
    expect(JSON.stringify(await firstHost.ctx.bots.routineHistory(request))).not.toContain(SLACK_MESSAGE)
    await page.close()
    web = undefined
    await firstHost.close()

    web = await launchWebScaffold(options)
    const nextModel = await configureModel(web)
    const secondPeer = await mountSlackFixture(web, socketServer)
    await sendSlackEnvelope(secondPeer, 'fresh-event-retry', freshEvent)
    expect(await web.ctx.bots.routineHistory(request)).toMatchObject(expected)
    expect(nextModel.inputs).toEqual([])
    const { events } = await web.ctx.sessionController.inspect(bot.sessionId)
    expect(events.filter(item => item.type === 'user/message' && item.data.source.kind === 'webhook'
      && item.data.source.provider === 'slack')).toHaveLength(1)

    const restored = await newEnglishPage(browser)
    const tripwire = watchConsole(restored)
    const conversation = await selectBot(restored, web, bot)
    await conversation.getByText(RESULT, { exact: true }).waitFor()
    await conversation.getByText('Slack event received', { exact: true }).waitFor()
    await captureExternalRoutine(restored, process.env.DSH_BOT_ROUTINE_SLACK_SCREENSHOTS, 'slack-chat')
    dialog = await openRoutines(restored)
    await dialog.getByRole('tab', { name: 'Results', exact: true }).click()
    const receipt = dialog.getByText('Slack · ' + SLACK_CHANNEL, { exact: true })
    const outcome = dialog.getByText(RESULT, { exact: true })
    await outcome.waitFor()
    await compareOrRefreshGolden(SLACK_EXPECTED, [
      ruleSnapshot, await receipt.ariaSnapshot(), await outcome.ariaSnapshot(),
    ].join('\n'), webSnapshotMode())
    await captureExternalRoutine(restored, process.env.DSH_BOT_ROUTINE_SLACK_SCREENSHOTS, 'slack-result', dialog)
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    try {
      await browser?.close()
    } finally {
      try {
        await web?.close()
      } finally {
        for (const socket of socketServer.clients) socket.terminate()
        await new Promise<void>((resolve, reject) => {
          socketServer.close((error) => { if (error === undefined) resolve(); else reject(error) })
        })
        await rm(workspaceCwd, { recursive: true, force: true })
      }
    }
  }
}, 120_000)
