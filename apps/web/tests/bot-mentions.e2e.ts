// Web e2e scenario: the real Bot workspace discovers an authorized Bot,
// carries its stable identity through send, and renders the inline avatar in
// the resulting transcript while a read-only inspection leaves the target log
// untouched.
import type { GenerateOptions, StreamChunk } from '@yharness/llm'
import { LlmAdapter, ToolCallId, createAssistantMessage, createUserMessage } from '@yharness/llm'
import { SessionId } from '@yharness/session'
import type { Browser, Page } from 'playwright'
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
const PROMPT = 'Read the Atlas status.'
const REPLY = 'Atlas inspection completed from the read-only fixture.'

function userTexts(options: GenerateOptions): string[] {
  return options.messages
    .filter(item => item.role === 'user')
    .map(message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
}

/** Deterministic model round that reads one Bot through the existing tool. */
class InspectionAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private inspected = false

  constructor(private readonly targetBotId: string) {
    super()
  }

  override async listModels(provider: string) {
    return [{ provider, id: MODEL, name: `${provider}/${MODEL}` }]
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const userText = userTexts(options).find(text => text.includes(PROMPT)) ?? ''
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
  let adapter: InspectionAdapter

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const orbit = (await scaffold.ctx.bots.create({
      name: 'Orbit', identity: 'agent', accent: 'teal', cwd: scaffold.workspaceCwd,
    })).bot
    const atlas = (await scaffold.ctx.bots.create({
      name: 'Atlas', identity: 'sparkle', accent: 'violet',
      description: 'Read-only browser fixture Bot', cwd: scaffold.workspaceCwd,
    })).bot
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
    adapter = new InspectionAdapter(targetBotId)
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

  it('selects a Bot without sending, then inspects it through the read-only tool', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bot-mentions'))
    const sidebar = page.locator('[data-yh-part="sidebar"]')
    await sidebar.getByRole('button', { name: 'Bots', exact: true }).click()
    const roster = sidebar.locator('aside[aria-label="Bot workspace"]')
    await roster.waitFor({ state: 'visible', timeout: 15_000 })
    const orbit = roster.locator(`[data-bot-id="${orbitBotId}"]`)
    await orbit.waitFor({ state: 'visible', timeout: 15_000 })
    await orbit.click()
    const detail = page.locator('section[aria-label="Orbit"]')
    await detail.waitFor({ state: 'visible', timeout: 15_000 })
    const input = detail.locator('[data-composer-input]').first()
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })
    await writeComposerDraft(page, input, '@atlas')
    const option = menu.getByRole('option', { name: /Atlas.*Bot/u })
    await expect.poll(() => option.count(), { timeout: 15_000 }).toBe(1)
    await expect.poll(() => option.locator('[data-avatar-loaded][data-identity="sparkle"]').count()).toBe(1)
    await option.click()
    const chip = input.locator('[data-composer-chip="bot"]')
    await expect.poll(() => chip.count()).toBe(1)
    await expect.poll(() => chip.textContent()).toBe('Atlas')
    await expect.poll(() => chip.locator('[data-avatar-loaded][data-identity="sparkle"]').count()).toBe(1)
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
    await expect.poll(() => userRow.locator('[data-avatar-loaded][data-identity="sparkle"]').count()).toBe(1)
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
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)
})
