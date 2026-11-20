/** The assembled Bots workspace preserves a routine's pause across a Host restart. */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type { BotView } from '@yharness/bots'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@yharness/llm'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, writeComposerDraft } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/bot-workspace/session.v3.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/bot-routine-recovery/results.expected.md', import.meta.url))
const PROVIDER = 'bot-routine-recovery-test'
const MODEL = 'reply'
const TITLE = 'Review new messages'
const RESULT = 'The routine handled the new message.'

class RoutineReplyAdapter extends LlmAdapter {
  override async listModels(provider: string) {
    return [{ provider, id: MODEL, name: 'Routine test model' }]
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const user = options.messages.findLast(message => message.role === 'user')
    const fromRoutine = user?.content.some(block => block.type === 'text' && block.text.startsWith('[BOT EVENT ROUTINE]'))
    const text = fromRoutine === true ? RESULT : 'Message received.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 6 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function configureModel(web: WebScaffold): Promise<void> {
  web.ctx.effect(() => web.ctx.llm.registerAdapter([PROVIDER], new RoutineReplyAdapter()), 'routine recovery fixture')
  await web.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
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
  await page.getByRole('button', { name: 'Manage routines', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Bot routines', exact: true })
  await dialog.getByRole('list', { name: 'Bot routines', exact: true }).waitFor()
  return dialog
}

async function sendMessage(page: Page, conversation: Locator, text: string): Promise<void> {
  await writeComposerDraft(page, conversation.locator('[data-composer-input]'), text)
  await conversation.getByRole('button', { name: 'Send message', exact: true }).click()
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
    const provider = web.ctx.get('codexDynamicTools')
    const tools = await provider?.resolve({ sessionId: bot.sessionId, provider: PROVIDER, model: MODEL, messages: [] })
    const create = tools?.find(tool => tool.name === 'schedule_create')
    if (create === undefined) throw new Error('Routine tool unavailable in the assembled Host')
    const result = await create.execute({
      title: TITLE, prompt: 'Record a result for the new message.', event: { type: 'message', source: 'user' },
    }, {
      callId: 'recovery-browser-create', threadId: 'recovery-browser-thread', turnId: 'recovery-browser-turn',
      sessionId: bot.sessionId, signal: new AbortController().signal, approvalPolicy: 'on-request',
      requestApproval: async () => true,
    })
    expect(result.success).toBe(true)
    const [routine] = (await web.ctx.bots.listRoutines({ botId: bot.id })).routines
    if (routine?.kind !== 'event') throw new Error('Message routine was not created')
    const request = { botId: bot.id, routineId: routine.id, limit: 10 }

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
    const results = dialog.getByRole('list', { name: 'Results', exact: true })
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
