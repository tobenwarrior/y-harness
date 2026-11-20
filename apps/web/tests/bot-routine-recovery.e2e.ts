/** The assembled Bots workspace admits new message and signed GitHub routine events. */

import { createHmac } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { expect, it } from 'vitest'
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
