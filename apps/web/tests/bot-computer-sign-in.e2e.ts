/** Replay a Bot's Computer handoff in the real authenticated Cloud interface. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BotId } from '@yharness/bots'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@yharness/llm'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/bot-workspace/session.v3.jsonl', import.meta.url))
const GOLDEN = fileURLToPath(new URL('./expected/bot-computer-sign-in/sign-in.expected.md', import.meta.url))
const RUNTIME_SOURCE = new URL('../../../packages/bundle/web-app/lib/types/vps-runtime.js', import.meta.url).href
const BOTS_SOURCE = new URL('../../../packages/bundle/web-app/lib/types/vps-bots.js', import.meta.url).href
const MODE = webSnapshotMode()
const BOT = BotId('bot-sign-in-fixture')
const PROVIDER = 'sign-in-fixture'
const MODEL = 'reply'
const REPLY = 'I’m back on the Computer.'

class HandoffAdapter extends LlmAdapter {
  sawReceipt = false
  requestCount = 0

  override async listModels(provider: string) {
    return [{ provider, id: MODEL, name: `${provider}/${MODEL}` }]
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requestCount++
    const result = options.messages.findLast(message => message.role === 'tool')
    if (result === undefined) {
      const id = ToolCallId('sign-in-request')
      const name = 'vps_computer'
      const args = JSON.stringify({ action: 'request_sign_in' })
      expect(options.tools?.some(tool => tool.name === name)).toBe(true)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    this.sawReceipt = result.content.some(block => block.type === 'text' && block.text.includes('The owner returned the Computer.'))
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: REPLY }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it.skipIf(MODE === 'record' || process.platform === 'win32')('returns a private Computer to the Bot in the same chat turn', async () => {
  const root = await mkdtemp('/tmp/yh-sign-in-web-')
  const runtimePath = join(root, 'computer.mjs')
  const overlay = join(root, 'computer.yml')
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  try {
    const runtime = browser = await chromium.launch()
    const page = await runtime.newPage({ locale: 'en-US', viewport: { width: 1180, height: 900 } })
    const consoleLog = watchConsole(page)
    const jpeg = await page.evaluate(() => {
      const image = document.createElement('canvas')
      image.width = 1280
      image.height = 800
      const canvas = image.getContext('2d')!
      canvas.fillStyle = '#151c2a'
      canvas.fillRect(0, 0, image.width, image.height)
      canvas.font = '32px sans-serif'
      canvas.fillStyle = '#eef2f8'
      canvas.fillText('Browser sign-in fixture', 450, 400)
      return image.toDataURL('image/jpeg').split(',')[1]
    })
    await writeFile(runtimePath, `
      import { VpsRuntime } from ${JSON.stringify(RUNTIME_SOURCE)}
      import { mountVpsBots } from ${JSON.stringify(BOTS_SOURCE)}
      export const name = 'computer-sign-in-fixture'
      export function apply(ctx, config) {
        const ensure = VpsRuntime.prototype.ensure
        const desktopCommand = VpsRuntime.prototype.desktopCommand
        ctx.effect(() => {
          VpsRuntime.prototype.ensure = async () => {}
          VpsRuntime.prototype.desktopCommand = async () => Buffer.from(${JSON.stringify(jpeg)}, 'base64')
          return () => {
            VpsRuntime.prototype.ensure = ensure
            VpsRuntime.prototype.desktopCommand = desktopCommand
          }
        })
        mountVpsBots(ctx, config, [])
      }
    `)
    await writeFile(overlay, JSON.stringify([{ insert: [{
      id: 'computer-sign-in-fixture', name: pathToFileURL(runtimePath).href,
      config: {
        root: join(root, 'bots'), image: 'localhost/yharness-test', bots: [BOT], desktopOnlyBots: [BOT],
        browser: { bots: [BOT], image: 'localhost/yharness-browser', seccompProfile: join(root, 'browser.json') },
      },
    }] }]))
    const web = scaffold = await launchWebScaffold({
      extraOverlayPath: overlay, replayFixture: FIXTURE, replayProvidersOnly: true, toolsMode: 'native',
    })
    const adapter = new HandoffAdapter()
    web.ctx.effect(() => web.ctx.llm.registerAdapter([PROVIDER], adapter), 'Computer sign-in fixture model')
    await web.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
    const { bot } = await web.ctx.bots.create({ id: BOT, name: 'Scout', cwd: web.workspaceCwd })
    await page.goto(web.authenticatedUrl, { waitUntil: 'load' })
    expect(await page.evaluate(() => Reflect.get(window, '__YH_BOT_COMPUTER_SIGN_IN__'))).toBe(true)
    await page.locator('[data-yh-part="sidebar"]').getByRole('button', { name: 'Bots', exact: true }).click()
    await page.locator(`[data-bot-id="${BOT}"]`).click()
    const conversation = page.locator('[data-conversation-surface="bots"]')
    await conversation.locator('[data-composer-input][contenteditable="true"]').fill('Ask me to sign in on your Computer.')
    await conversation.getByRole('button', { name: 'Send message', exact: true }).click()
    const cardSelector = '[data-computer-sign-in-card]'
    const card = page.locator(cardSelector)
    const panelSelector = '[data-computer-panel]'
    const panel = page.locator(panelSelector)
    const api = { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'status', sessionId: bot.sessionId }) }
    await expect.poll(() => adapter.requestCount, { timeout: 5_000 }).toBeGreaterThan(0)
    await expect.poll(async () => (await web.hostFetch('/api/computer/sign-in', api)).json(), { timeout: 5_000 })
      .toMatchObject({ request: { id: expect.any(String), canCancel: true } })
    await card.waitFor({ state: 'visible', timeout: 12_000 })
    expect(adapter.sawReceipt).toBe(false)
    expect((await fetch(new URL('/api/computer/sign-in', web.baseUrl), api)).status).toBe(401)
    expect((await web.hostFetch('/api/computer/sign-in', api)).status).toBe(200)
    const pending = await captureStableAria(page, cardSelector, web.workspaceCwd)
    await card.getByRole('button', { name: 'Take over', exact: true }).click()
    await panel.getByRole('img', { name: 'Live computer screen' }).waitFor()
    const privateView = await captureStableAria(page, panelSelector, web.workspaceCwd)
    const passiveViewer = await web.hostFetch('/api/computer/frame', { ...api,
      body: JSON.stringify({ sessionId: bot.sessionId, viewerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }) })
    expect(await passiveViewer.json()).toMatchObject({ jpeg: '', mode: 'other' })
    await panel.getByRole('button', { name: 'I’m done', exact: true }).click()
    await conversation.getByText(REPLY, { exact: true }).waitFor()
    expect(adapter.sawReceipt).toBe(true)
    await card.waitFor({ state: 'hidden' })
    expect(consoleLog.pageErrors).toEqual([])
    await compareOrRefreshGolden(GOLDEN, `## Waiting in chat\n\n${pending}\n\n## In control\n\n${privateView}`, MODE)
  } finally {
    try { await browser?.close() }
    finally {
      try { await scaffold?.close() }
      finally { await rm(root, { recursive: true, force: true }) }
    }
  }
})
