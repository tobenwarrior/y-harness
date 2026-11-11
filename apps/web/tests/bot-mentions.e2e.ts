// Web e2e scenario: the real Bot workspace discovers an authorized Bot,
// carries its stable identity through send, and renders the inline avatar in
// the resulting transcript while a read-only inspection leaves the target log
// untouched.
import type { GenerateOptions, StreamChunk } from '@yharness/llm'
import { LlmAdapter, ToolCallId, createAssistantMessage, createUserMessage } from '@yharness/llm'
import { SessionId } from '@yharness/session'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const MODE = webSnapshotMode()
const PROVIDER = 'bot-mention-browser-test'
const MODEL = 'reply'
const ATLAS_AVATAR = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const PROMPT = 'Read the Atlas status.'
const SEND_PROMPT = 'Please send the handoff note to Atlas.'
const SEND_TEXT = 'The Atlas handoff is ready for review.'
const BARE_PROMPT = '@Atlas is context only.'
const BARE_REPLY = 'The bare Atlas mention stayed local.'
const REPLY = 'Atlas inspection completed from the read-only fixture.'

function userTexts(options: GenerateOptions): string[] {
  return options.messages
    .filter(item => item.role === 'user')
    .map(message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
}

async function openBotWorkspace(page: Page, botId: string, name: string): Promise<Locator> {
  const sidebar = page.locator('[data-yh-part="sidebar"]')
  await sidebar.getByRole('button', { name: 'Bots', exact: true }).click()
  const roster = sidebar.locator('aside[aria-label="Bot workspace"]')
  await roster.waitFor({ state: 'visible', timeout: 15_000 })
  await roster.locator(`[data-bot-id="${botId}"]`).click()
  const detail = page.locator(`section[aria-label="${name}"]`)
  await detail.waitFor({ state: 'visible', timeout: 15_000 })
  return detail
}

async function reloadAndOpenBot(page: Page, botId: string, name: string): Promise<Locator> {
  await page.reload({ waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  return openBotWorkspace(page, botId, name)
}

/** Deterministic inspection and delivery through the Bot tools. */
class BotMentionAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private inspected = false
  private sent = false

  constructor(private readonly targetBotId: string) {
    super()
  }

  override async listModels(provider: string) {
    return [{ provider, id: MODEL, name: `${provider}/${MODEL}` }]
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const userText = userTexts(options).findLast(text =>
      text.includes(PROMPT) || text.includes(SEND_PROMPT) || text.includes(BARE_PROMPT)) ?? ''
    const mentionId = /dsh-bot:(bot-[A-Za-z0-9][A-Za-z0-9-]*)/u.exec(userText)?.[1]
    if (!this.inspected && userText.includes(PROMPT) && mentionId === this.targetBotId) {
      this.inspected = true
      const callId = ToolCallId('bot-mention-inspection')
      const argumentsText = JSON.stringify({ botId: mentionId })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: callId, name: 'inspect_bot', argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'inspect_bot', arguments: argumentsText } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (!this.sent && userText.includes(SEND_PROMPT) && mentionId === this.targetBotId) {
      this.sent = true
      const callId = ToolCallId('bot-mention-explicit-send')
      const argumentsText = JSON.stringify({ targetBotId: mentionId, text: SEND_TEXT })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: callId, name: 'send_bot_message', argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'send_bot_message', arguments: argumentsText } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (userText.includes(BARE_PROMPT)) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: BARE_REPLY } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe.skipIf(MODE === 'record')('web e2e: Bot mentions in the shared Bot composer', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let orbitBotId: string
  let targetBotId: string
  let orbitSessionId: string
  let targetSessionId: string
  let atlasImage: string
  let adapter: BotMentionAdapter

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const orbit = (await scaffold.ctx.bots.create({
      name: 'Orbit', identity: 'agent', accent: 'teal', cwd: scaffold.workspaceCwd,
    })).bot
    const atlas = (await scaffold.ctx.bots.create({
      name: 'Atlas', identity: 'sparkle', accent: 'violet',
      description: 'Browser fixture Bot', cwd: scaffold.workspaceCwd,
    })).bot
    await scaffold.ctx.bots.uploadAvatar({ botId: atlas.id, data: ATLAS_AVATAR, mediaType: 'image/png' })
    const storedAvatar = await scaffold.ctx.bots.readAvatar({ botId: atlas.id })
    atlasImage = `[data-avatar-loaded="true"][data-identity="sparkle"] img[src="data:${storedAvatar.avatar.mediaType};base64,${storedAvatar.data}"]`
    const orbitSession = scaffold.ctx.sessions.get(orbit.sessionId)
    if (orbitSession === undefined) throw new Error('Orbit Bot Session was not created')
    // Bot Sessions default to their owner policy. Pin this synthetic sender to
    // the normal approval preset so the explicit send reaches the real UI gate.
    scaffold.ctx.permissionPresets.set(orbitSession, 'workspace-write')
    orbitBotId = String(orbit.id)
    targetBotId = String(atlas.id)
    orbitSessionId = String(orbit.sessionId)
    targetSessionId = String(atlas.sessionId)
    const targetSession = scaffold.ctx.sessions.get(atlas.sessionId)
    if (targetSession === undefined) throw new Error('Atlas Bot Session was not created')
    targetSession.append('turn/start', { turn: 1 })
    targetSession.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Atlas fixture context.' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    targetSession.append('step/start', { turn: 1, step: 1 })
    targetSession.append('assistant/message', {
      stream: [], turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'Atlas fixture answer.' }],
        source: { provider: 'fixture', model: 'fixture' },
      }),
    }, { surfaceOp: 'append' })
    targetSession.append('step/end', { turn: 1, step: 1 })
    targetSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(targetSession)
    adapter = new BotMentionAdapter(targetBotId)
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter),
      'Bot mention browser fixture adapter',
    )
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
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

  it('reopens Bot mentions, inspects context, and delivers only after approval', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bot-mentions'))
    const detail = await openBotWorkspace(page, orbitBotId, 'Orbit')
    const input = detail.locator('[data-composer-input]').first()
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })
    await writeComposerDraft(page, input, '@')
    const allBotOption = menu.getByRole('option', { name: /Atlas.*Bot/u })
    await expect.poll(() => allBotOption.count(), { timeout: 15_000 }).toBe(1)
    await expect.poll(() => allBotOption.locator(atlasImage).count(), { timeout: 5_000 }).toBe(1)
    await writeComposerDraft(page, input, '@atlas')
    const option = menu.getByRole('option', { name: /Atlas.*Bot/u })
    await expect.poll(() => option.count(), { timeout: 15_000 }).toBe(1)
    await expect.poll(() => option.locator(atlasImage).count()).toBe(1)
    await option.click()
    const chip = input.locator('[data-composer-chip="bot"]')
    await expect.poll(() => chip.count()).toBe(1)
    await expect.poll(() => chip.textContent()).toBe('Atlas')
    await expect.poll(() => chip.locator(atlasImage).count()).toBe(1)
    await expect.poll(() => menu.count()).toBe(0)
    expect(adapter.requests).toHaveLength(0)
    await input.click()
    await page.keyboard.press('End')
    await page.keyboard.type(` ${PROMPT}`)
    await detail.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(() => adapter.requests.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
    const firstRequest = adapter.requests.find(request => userTexts(request).some(text => text.includes(PROMPT)))
    if (firstRequest === undefined) throw new Error('Bot mention request was not captured')
    expect(userTexts(firstRequest).join('\n')).toContain(`dsh-bot:${encodeURIComponent(targetBotId)}`)
    await expect.poll(() => detail.getByText(REPLY, { exact: true }).count(), { timeout: 30_000 }).toBe(1)
    const userRow = detail.locator('[data-chat-flow-kind="user"]').filter({ hasText: 'Atlas' }).last()
    await expect.poll(() => userRow.count(), { timeout: 30_000 }).toBe(1)
    await expect.poll(() => userRow.locator(atlasImage).count()).toBe(1)
    await expect.poll(() => userRow.locator('[data-ref-chip="bot"]').count()).toBe(1)
    expect(await userRow.locator('[data-ref-chip="bot"]').textContent()).toBe('Atlas')
    const orbitSession = scaffold.ctx.sessions.get(SessionId(orbitSessionId))
    if (orbitSession === undefined) throw new Error('Orbit Bot Session disappeared')
    expect(orbitSession.snapshotEvents().filter(event => event.type === 'tool/call').map(event => event.data.name))
      .toContain('inspect_bot')
    expect(JSON.stringify(orbitSession.snapshotEvents().filter(event => event.type === 'tool/result')))
      .toContain('Atlas fixture context.')
    expect(orbitSession.snapshotEvents().filter(event => event.type === 'tool/call').map(event => event.data.name))
      .not.toContain('send_bot_message')
    const atlasSession = scaffold.ctx.sessions.get(SessionId(targetSessionId))
    if (atlasSession === undefined) throw new Error('Atlas Bot Session disappeared')
    expect(atlasSession.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(1)

    // A reload must reconstruct the sent Bot chip from the durable message.
    const reopenedDetail = await reloadAndOpenBot(page, orbitBotId, 'Orbit')
    const reopenedUserRow = reopenedDetail.locator('[data-chat-flow-kind="user"]').filter({ hasText: 'Atlas' }).last()
    await expect.poll(() => reopenedUserRow.locator('[data-ref-chip="bot"]').count(), { timeout: 15_000 }).toBe(1)
    await expect.poll(() => reopenedUserRow.locator(atlasImage).count(), { timeout: 5_000 }).toBe(1)

    // Selecting a Bot is context only. An explicit send request is the sole
    // path that may deliver a message to the target Bot.
    const explicitInput = reopenedDetail.locator('[data-composer-input]').first()
    const explicitMenu = page.getByRole('listbox', { name: 'Trigger suggestions' })
    await writeComposerDraft(page, explicitInput, '@atlas')
    const explicitOption = explicitMenu.getByRole('option', { name: /Atlas.*Bot/u })
    await expect.poll(() => explicitOption.count(), { timeout: 15_000 }).toBe(1)
    await explicitOption.click()
    await explicitInput.click()
    await page.keyboard.press('End')
    await page.keyboard.type(` ${SEND_PROMPT}`)
    const targetAgentMessagesBeforeApproval = atlasSession.snapshotEvents().filter(
      event => event.type === 'user/message' && event.data.source.kind === 'agent-message',
    )
    await reopenedDetail.getByRole('button', { name: 'Send message', exact: true }).click()
    const approvalPanel = page.locator('[data-approval-key]')
    await approvalPanel.waitFor({ state: 'visible', timeout: 30_000 })
    expect(atlasSession.snapshotEvents().filter(
      event => event.type === 'user/message' && event.data.source.kind === 'agent-message',
    )).toHaveLength(targetAgentMessagesBeforeApproval.length)
    await approvalPanel.getByRole('button', { name: 'Allow once', exact: true }).click()
    await expect.poll(() => page.locator('[data-approval-key]').count(), { timeout: 30_000 }).toBe(0)
    await expect.poll(() => orbitSession.snapshotEvents().filter(
      event => event.type === 'tool/call' && event.data.name === 'send_bot_message',
    ).length, { timeout: 30_000 }).toBe(1)
    const sendCall = orbitSession.snapshotEvents().find(
      (event): event is Extract<typeof event, { type: 'tool/call' }> =>
        event.type === 'tool/call' && event.data.name === 'send_bot_message',
    )
    if (sendCall === undefined) throw new Error('Explicit Bot send call was not recorded')
    expect(JSON.parse(sendCall.data.arguments) as Record<string, unknown>).toMatchObject({
      targetBotId, text: SEND_TEXT,
    })
    await expect.poll(() => atlasSession.snapshotEvents().filter(
      event => event.type === 'user/message' && event.data.source.kind === 'agent-message',
    ).length, { timeout: 30_000 }).toBe(targetAgentMessagesBeforeApproval.length + 1)
    const deliveredMessage = atlasSession.snapshotEvents().find(
      (event): event is Extract<typeof event, { type: 'user/message' }> =>
        event.type === 'user/message' && event.data.source.kind === 'agent-message',
    )
    if (deliveredMessage === undefined) throw new Error('Explicit Bot delivery was not recorded')
    expect(deliveredMessage.data.content.filter(block => block.type === 'text').map(block => block.text).join(''))
      .toContain(`Message from Orbit:\n${SEND_TEXT}`)

    // Reopen once more and prove both canonical mentions remain rendered.
    const finalDetail = await reloadAndOpenBot(page, orbitBotId, 'Orbit')
    await expect.poll(() => finalDetail.locator('[data-chat-flow-kind="user"] [data-ref-chip="bot"]').count(), { timeout: 15_000 }).toBe(2)

    // A bare display-name mention remains ordinary text and cannot deliver.
    const bareInput = finalDetail.locator('[data-composer-input]').first()
    await writeComposerDraft(page, bareInput, BARE_PROMPT)
    await page.keyboard.press('Escape')
    const orbitTurnEndsBeforeBare = orbitSession.snapshotEvents().filter(event => event.type === 'turn/end').length
    await finalDetail.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect.poll(() => finalDetail.getByText(BARE_REPLY, { exact: true }).count(), { timeout: 30_000 }).toBe(1)
    expect(orbitSession.snapshotEvents().filter(event => (
      event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text.includes(BARE_PROMPT))
    ))).toHaveLength(1)
    await expect.poll(() => orbitSession.snapshotEvents().filter(event => event.type === 'turn/end').length, { timeout: 30_000 })
      .toBe(orbitTurnEndsBeforeBare + 1)
    expect(await page.locator('[data-approval-key]').count()).toBe(0)
    await expect.poll(() => orbitSession.snapshotEvents().filter(
      event => event.type === 'tool/call' && event.data.name === 'send_bot_message',
    ).length, { timeout: 30_000 }).toBe(1)
    await expect.poll(() => atlasSession.snapshotEvents().filter(
      event => event.type === 'user/message' && event.data.source.kind === 'agent-message',
    ).length, { timeout: 30_000 }).toBe(targetAgentMessagesBeforeApproval.length + 1)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)
})
