/** Exercise the secure request through the shipped Web Host and Bot composer. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BotId } from '@yharness/bots'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@yharness/llm'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/bot-workspace/session.v3.jsonl', import.meta.url))
const GOLDEN = fileURLToPath(new URL('./expected/bot-vault-request/request.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const BOT = BotId('bot-vault-fixture')
const SERVICE = 'example-worker.service'
const KEY = 'EXAMPLE_API_KEY'
const PROVIDER = 'vault-request-fixture'
const MODEL = 'reply'
const REPLY = 'The service key is saved.'

class RequestAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  sawReceipt = false

  override async listModels(provider: string) {
    return [{ provider, id: MODEL, name: `${provider}/${MODEL}` }]
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const result = options.messages.findLast(message => message.role === 'tool')
    if (result === undefined) {
      const id = ToolCallId('vault-request')
      const name = 'request_vps_secret'
      const args = JSON.stringify({ unit: SERVICE, name: KEY })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    this.sawReceipt = result.content.some(block => block.type === 'text' && block.text.includes('saved in the VPS Vault'))
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: REPLY }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it.skipIf(MODE === 'record' || process.platform === 'win32')('offers a secure key form handoff and returns only the owner receipt', async () => {
  const root = await mkdtemp('/tmp/yh-vault-web-')
  const socketPath = join(root, 'r')
  const overlay = join(root, 'vault.yml')
  let ownerSaved = false
  const commands: Array<Record<string, unknown>> = []
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let payload = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => { payload += chunk })
    socket.once('end', () => {
      const command = JSON.parse(payload) as Record<string, unknown>
      commands.push(command)
      const state = command.action === 'cancel' ? 'cancelled' : ownerSaved ? 'saved' : 'pending'
      socket.end(JSON.stringify({ state }))
    })
  })
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    const config = { vpsVaultRequests: { socketPath, grants: [{ bot: BOT, unit: SERVICE, name: KEY }] } }
    await writeFile(overlay, JSON.stringify([{ id: 'web-runtime', config }]))
    const web = scaffold = await launchWebScaffold({
      extraOverlayPath: overlay, replayFixture: FIXTURE, replayProvidersOnly: true, toolsMode: 'native',
    })
    const adapter = new RequestAdapter()
    web.ctx.effect(() => web.ctx.llm.registerAdapter([PROVIDER], adapter), 'Vault request fixture model')
    await web.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
    const { bot } = await web.ctx.bots.create({ id: BOT, name: 'Scout', cwd: web.workspaceCwd })
    const { bot: other } = await web.ctx.bots.create({ name: 'Orbit', cwd: web.workspaceCwd })
    const runtime = browser = await chromium.launch()
    const page = await runtime.newPage({
      locale: 'en-US', userAgent: 'YHarnessCloudDesktop/1', viewport: { width: 720, height: 900 },
    })
    const consoleLog = watchConsole(page)
    await page.goto(web.authenticatedUrl, { waitUntil: 'load' })
    const ownRoute = `/api/bot-vault-request?sessionId=${bot.sessionId}`
    const initial = await web.hostFetch(ownRoute)
    expect(initial.status).toBe(200)
    expect(await initial.json()).toEqual({ request: null })
    expect(await page.evaluate(() => Reflect.get(window, '__YH_BOT_VAULT_REQUESTS__'))).toBe(true)
    await page.locator('[data-yh-part="sidebar"]').getByRole('button', { name: 'Bots', exact: true }).click()
    await page.locator(`[data-bot-id="${BOT}"]`).click()
    const conversation = page.locator('[data-conversation-surface="bots"]')
    await conversation.locator('[data-composer-input][contenteditable="true"]').fill('Request the service key.')
    await conversation.getByRole('button', { name: 'Send message', exact: true }).click()
    const pendingSelector = '[data-bot-vault-request-state="pending"]'
    const pending = page.locator(pendingSelector)
    await expect.poll(() => adapter.requests.length, { timeout: 5_000 }).toBeGreaterThan(0)
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('request_vps_secret')
    await expect.poll(() => commands.length, { timeout: 5_000, message: 'the Bot reaches the Vault broker' }).toBeGreaterThan(0)
    await expect.poll(async () => {
      expect(consoleLog.pageErrors).toEqual([])
      return pending.isVisible()
    }, { timeout: 12_000 }).toBe(true)
    const handoff = await pending.getByRole('link', { name: 'Enter key securely' }).getAttribute('href')
    expect(handoff).toMatch(/^\/__yharness\/vault-request\/[0-9a-f]{32}$/u)
    const id = handoff?.split('/').at(-1)
    expect(commands[0]).toEqual({ action: 'create', id, unit: SERVICE, name: KEY })
    expect(await pending.locator('input').count()).toBe(0)
    expect((await fetch(new URL(ownRoute, web.baseUrl))).status).toBe(401)
    expect(await (await web.hostFetch(ownRoute)).json()).toEqual({
      request: { id, unit: SERVICE, name: KEY, state: 'pending' },
    })
    expect(await (await web.hostFetch(`/api/bot-vault-request?sessionId=${other.sessionId}`)).json()).toEqual({ request: null })
    const options = { replacements: [[String(id), '{{id}}']] as const }
    const pendingSnapshot = await captureStableAria(page, pendingSelector, web.workspaceCwd, options)
    ownerSaved = true
    const savedSelector = '[data-bot-vault-request-state="saved"]'
    await page.locator(savedSelector).waitFor({ state: 'visible', timeout: 12_000 })
    await conversation.getByText(REPLY, { exact: true }).waitFor()
    expect(adapter.sawReceipt).toBe(true)
    expect(commands.every(command => !Object.hasOwn(command, 'value'))).toBe(true)
    const savedSnapshot = await captureStableAria(page, savedSelector, web.workspaceCwd)
    await compareOrRefreshGolden(GOLDEN, `## Pending request\n\n${pendingSnapshot}\n\n## Saved receipt\n\n${savedSnapshot}`, MODE)
  } finally {
    try { await browser?.close() }
    finally {
      try { await scaffold?.close() }
      finally {
        if (server.listening) await new Promise<void>((resolve) => { server.close(() => resolve()) })
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})
