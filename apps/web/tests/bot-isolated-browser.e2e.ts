/** Verify the Bot browser panel through the real Cloud Host and browser worker protocol. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BotId } from '@yharness/bots'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@yharness/llm'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/bot-workspace/session.v3.jsonl', import.meta.url))
const GOLDEN = fileURLToPath(new URL('./expected/bot-isolated-browser/browser.expected.md', import.meta.url))
const BOTS_SOURCE = new URL('../../../packages/bundle/web-app/lib/types/vps-bots.js', import.meta.url).href
const MODE = webSnapshotMode()
const BOT = BotId('bot-browser-fixture')
const PROVIDER = 'browser-fixture'
const MODEL = 'reply'
const WEBSITE = 'https://example.test/'
const REPLY = 'I opened the website.'

class BrowserAdapter extends LlmAdapter {
  override async listModels(provider: string) {
    return [{ provider, id: MODEL, name: `${provider}/${MODEL}` }]
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const result = options.messages.findLast(message => message.role === 'tool')
    if (result === undefined) {
      const id = ToolCallId('fixture-browser-navigation')
      const name = 'vps_computer'
      const args = JSON.stringify({ action: 'navigate', url: WEBSITE })
      expect(options.tools?.some(tool => tool.name === name)).toBe(true)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    expect(result.content.some(block => block.type === 'text' && block.text.includes('Browser'))).toBe(true)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: REPLY }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it.skipIf(MODE === 'record' || process.platform === 'win32')('opens websites for a Bot and its controlling viewer in Cloud', async () => {
  const root = await mkdtemp('/tmp/yh-browser-web-')
  const runtimePath = join(root, 'browser.mjs')
  const overlay = join(root, 'browser.yml')
  const socketPath = join(root, 'browser.sock')
  const websites: string[] = []
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  let socketServer: ReturnType<typeof createServer> | undefined
  const sockets = new Set<import('node:net').Socket>()
  try {
    const runtime = browser = await chromium.launch()
    const page = await runtime.newPage({ locale: 'en-US', viewport: { width: 1180, height: 900 } })
    const consoleLog = watchConsole(page)
    const jpeg = await page.evaluate(() => {
      const image = document.createElement('canvas')
      image.width = 1280
      image.height = 800
      const canvas = image.getContext('2d')!
      canvas.fillStyle = '#f1f4fa'
      canvas.fillRect(0, 0, image.width, image.height)
      canvas.font = '40px sans-serif'
      canvas.fillStyle = '#1c2233'
      canvas.fillText('Example workspace', 100, 180)
      return image.toDataURL('image/jpeg').split(',')[1]
    })
    socketServer = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket)
      socket.once('close', () => { sockets.delete(socket) })
      socket.on('error', () => socket.destroy())
      let body = ''
      socket.setEncoding('utf8')
      socket.on('data', (value) => { body += value })
      socket.once('end', () => {
        const request = JSON.parse(body) as { action: string; url?: string }
        if (request.action === 'navigate' && request.url !== undefined) websites.push(request.url)
        const response = request.action === 'status' ? { available: true }
          : request.action === 'frame' ? { jpeg, width: 1280, height: 800 } : { ok: true }
        socket.end(JSON.stringify(response))
      })
    })
    await new Promise<void>((resolve, reject) => { socketServer!.once('error', reject); socketServer!.listen(socketPath, resolve) })
    await writeFile(runtimePath, `
      import { mountVpsBots } from ${JSON.stringify(BOTS_SOURCE)}
      export const name = 'isolated-browser-fixture'
      export function apply(ctx, config) { mountVpsBots(ctx, config, []) }
    `)
    await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'isolated-browser-fixture', name: pathToFileURL(runtimePath).href,
      config: { root: join(root, 'bots'), image: 'localhost/yharness-test', bots: [BOT], desktopOnlyBots: [BOT],
        isolatedBrowser: { bots: [BOT], socketPath } },
    }] }]))
    const web = scaffold = await launchWebScaffold({ extraOverlayPath: overlay, replayFixture: FIXTURE, replayProvidersOnly: true, toolsMode: 'native' })
    const adapter = new BrowserAdapter()
    web.ctx.effect(() => web.ctx.llm.registerAdapter([PROVIDER], adapter), 'Isolated Browser fixture model')
    await web.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
    const { bot } = await web.ctx.bots.create({ id: BOT, name: 'Browser Scout', cwd: web.workspaceCwd })
    await page.goto(web.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-yh-part="sidebar"]').getByRole('button', { name: 'Bots', exact: true }).click()
    await page.locator(`[data-bot-id="${BOT}"]`).click()
    const conversation = page.locator('[data-conversation-surface="bots"]')
    await conversation.locator('[data-composer-input][contenteditable="true"]').fill('Open the test site.')
    await conversation.getByRole('button', { name: 'Send message', exact: true }).click()
    await conversation.getByText(REPLY, { exact: true }).waitFor()
    expect(websites).toEqual([WEBSITE])
    await page.getByRole('button', { name: 'Open computer panel', exact: true }).click()
    const panelSelector = '[data-computer-panel]'
    const panel = page.locator(panelSelector)
    await panel.getByRole('img', { name: 'Live computer screen' }).waitFor()
    expect(await panel.getByRole('textbox', { name: 'Website address' }).count()).toBe(0)
    await panel.getByRole('button', { name: 'Take control', exact: true }).click()
    const address = panel.getByRole('textbox', { name: 'Website address' })
    await address.fill('https://example.test/next')
    const controlling = await captureStableAria(page, panelSelector, web.workspaceCwd)
    await address.press('Enter')
    await expect.poll(() => websites).toEqual([WEBSITE, 'https://example.test/next'])
    await panel.getByRole('button', { name: 'Hand back', exact: true }).click()
    await address.waitFor({ state: 'hidden' })
    const viewing = await captureStableAria(page, panelSelector, web.workspaceCwd)
    const unauthorized = await fetch(new URL('/api/computer/navigate', web.baseUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: bot.sessionId, viewerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', url: WEBSITE }),
    })
    expect(unauthorized.status).toBe(401)
    expect(consoleLog.pageErrors).toEqual([])
    await compareOrRefreshGolden(GOLDEN, `## In control\n\n${controlling}\n\n## Watching\n\n${viewing}`, MODE)
  } finally {
    try { await browser?.close() }
    finally {
      try { await scaffold?.close() }
      finally {
        for (const socket of sockets) socket.destroy()
        if (socketServer?.listening === true) await new Promise<void>(resolve => socketServer!.close(() => resolve()))
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})
