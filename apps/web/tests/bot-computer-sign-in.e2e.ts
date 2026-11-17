/** Replay a Bot's Computer handoff in the real authenticated Cloud interface. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
const IMPORTED_BOT = BotId('bot-imported-desktop-fixture')
const PROVIDER = 'sign-in-fixture'
const MODEL = 'reply'
const REPLY = 'I’m back on the Computer.'
const PROJECT_PROMPT = 'Check access to the shared workspace.'
const PROJECT_AVAILABLE = 'I can use the shared workspace.'
const PROJECT_UNAVAILABLE = 'My shared workspace access is off.'

class HandoffAdapter extends LlmAdapter {
  sawReceipt = false
  requestCount = 0

  override async listModels(provider: string) {
    return [{ provider, id: MODEL, name: `${provider}/${MODEL}` }]
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requestCount++
    if (options.messages.some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text === PROJECT_PROMPT))) {
      const text = options.tools?.some(tool => tool.name === 'vps_project_files') ? PROJECT_AVAILABLE : PROJECT_UNAVAILABLE
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
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

it.skipIf(MODE === 'record' || process.platform === 'win32')('changes a private Computer’s workspace access and preserves Internet and sign-in handback', async () => {
  const root = await mkdtemp('/tmp/yh-sign-in-web-')
  const runtimePath = join(root, 'computer.mjs')
  const overlay = join(root, 'computer.yml')
  const startedComputers = join(root, 'started-computers')
  const restartedComputers = join(root, 'restarted-computers')
  const disconnectedComputer = join(root, 'disconnected-computer')
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
    await Promise.all([startedComputers, restartedComputers, disconnectedComputer].map(path => writeFile(path, '')))
    await writeFile(runtimePath, `
      import { appendFile, readFile, writeFile } from 'node:fs/promises'
      import { VpsRuntime } from ${JSON.stringify(RUNTIME_SOURCE)}
      import { mountVpsBots } from ${JSON.stringify(BOTS_SOURCE)}
      export const name = 'computer-sign-in-fixture'
      export function apply(ctx, config) {
        const ensure = VpsRuntime.prototype.ensure
        const ensureOne = VpsRuntime.prototype.ensureOne
        const desktopCommand = VpsRuntime.prototype.desktopCommand
        const runPodman = VpsRuntime.prototype.runPodman
        const supportsNetworkControl = VpsRuntime.prototype.supportsNetworkControl
        ctx.effect(() => {
          VpsRuntime.prototype.ensure = sessionId => appendFile(${JSON.stringify(startedComputers)}, sessionId + '\\n')
          VpsRuntime.prototype.ensureOne = async sessionId => {
            await appendFile(${JSON.stringify(restartedComputers)}, sessionId + '\\n')
            await writeFile(${JSON.stringify(disconnectedComputer)}, '')
          }
          VpsRuntime.prototype.desktopCommand = async sessionId => {
            if (await readFile(${JSON.stringify(disconnectedComputer)}, 'utf8') === sessionId) throw new Error('Fixture display failed.')
            return Buffer.from(${JSON.stringify(jpeg)}, 'base64')
          }
          VpsRuntime.prototype.supportsNetworkControl = () => true
          VpsRuntime.prototype.runPodman = async args => {
            if (args[0] === 'container' && args[1] === 'exists') return { code: 1, stdout: '', stderr: '' }
            if (args[0] === 'volume' && args[1] === 'exists') return { code: 0, stdout: '', stderr: '' }
            if (args[0] === 'volume' && args[1] === 'inspect') return { code: 0, stderr: '', stdout: JSON.stringify({
              Name: args.at(-1), Driver: 'local', Options: {},
              Labels: { 'io.yharness.vps.root': config.root, 'io.yharness.vps.purpose': 'shared-project' },
            }) }
            throw new Error('Unexpected Podman command in Computer fixture.')
          }
          return () => {
            VpsRuntime.prototype.ensure = ensure
            VpsRuntime.prototype.ensureOne = ensureOne
            VpsRuntime.prototype.desktopCommand = desktopCommand
            VpsRuntime.prototype.runPodman = runPodman
            VpsRuntime.prototype.supportsNetworkControl = supportsNetworkControl
          }
        })
        mountVpsBots(ctx, config, [])
      }
    `)
    await writeFile(overlay, JSON.stringify([{ insert: [{
      id: 'computer-sign-in-fixture', name: pathToFileURL(runtimePath).href,
      config: {
        root: join(root, 'bots'), image: 'localhost/yharness-test', bots: [BOT], desktopOnlyBots: [BOT], desktopForUnlistedBots: true,
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
    const { bot: imported } = await web.ctx.bots.create({ id: IMPORTED_BOT, name: 'Imported Scout', cwd: web.workspaceCwd })
    expect(imported.cwd).toBe(web.workspaceCwd)
    await page.goto(web.authenticatedUrl, { waitUntil: 'load' })
    expect(await page.evaluate(() => {
      const value: unknown = Reflect.get(window, '__YH_BOT_COMPUTER_SIGN_IN__')
      if (typeof value !== 'boolean') throw new Error('The Bot Computer sign-in flag is missing.')
      return value
    })).toBe(true)
    await page.locator('[data-yh-part="sidebar"]').getByRole('button', { name: 'Bots', exact: true }).click()
    const panelSelector = '[data-computer-panel]'
    const panel = page.locator(panelSelector)
    await page.locator(`[data-bot-id="${IMPORTED_BOT}"]`).click()
    const computer = page.getByRole('button', { name: 'Open computer panel', exact: true })
    await computer.waitFor({ state: 'visible' })
    expect(await readFile(startedComputers, 'utf8')).toBe('')
    await computer.click()
    await panel.getByRole('img', { name: 'Live computer screen' }).waitFor()
    const opened = (await readFile(startedComputers, 'utf8')).trim().split('\n')
    expect(new Set(opened)).toEqual(new Set([imported.sessionId]))
    const network = panel.locator('[data-computer-network-control]').getByRole('switch')
    const sharedWorkspace = panel.getByRole('switch', { name: 'Allow access to common project files', exact: true })
    await expect.poll(() => network.getAttribute('aria-checked')).toBe('false')
    await expect.poll(() => sharedWorkspace.getAttribute('aria-checked')).toBe('false')
    const request = (payload: object) => ({ method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload) })
    const target = { sessionId: imported.sessionId }
    const enable = request({ ...target, enabled: true })
    const restart = request(target)
    expect((await fetch(new URL('/api/computer/network', web.baseUrl), enable)).status).toBe(401)
    expect((await fetch(new URL('/api/computer/restart', web.baseUrl), restart)).status).toBe(401)
    expect((await fetch(new URL('/api/computer/shared-workspace', web.baseUrl), enable)).status).toBe(401)
    const other = await web.hostFetch('/api/computer/network', request({ ...target, sessionId: 'bot-session-11111111-1111-4111-8111-111111111111', enabled: true }))
    expect(other.status).toBe(404)
    const invalid = await web.hostFetch('/api/computer/network', request({ ...target, enabled: 'true' }))
    expect(invalid.status).toBe(400)
    await panel.getByRole('button', { name: 'Take control', exact: true }).click()
    await panel.getByRole('button', { name: 'Hand back', exact: true }).waitFor()
    expect((await web.hostFetch('/api/computer/network', enable)).status).toBe(409)
    expect((await web.hostFetch('/api/computer/restart', restart)).status).toBe(409)
    expect((await web.hostFetch('/api/computer/shared-workspace', enable)).status).toBe(409)
    expect(await network.getAttribute('aria-checked')).toBe('false')
    await panel.getByRole('button', { name: 'Hand back', exact: true }).click()
    await panel.getByRole('button', { name: 'Take control', exact: true }).waitFor()
    await network.click()
    await expect.poll(() => network.getAttribute('aria-checked')).toBe('true')
    const status = await web.hostFetch('/api/computer/status', request(target))
    expect(await status.json()).toMatchObject({
      computer: { id: imported.id, terminalInternet: true, networkControl: true, restart: true, sharedWorkspaceControl: true },
    })
    const conversation = page.locator('[data-conversation-surface="bots"]')
    const checkProjectAccess = async (reply: string, count: number): Promise<void> => {
      await conversation.locator('[data-composer-input][contenteditable="true"]').fill(PROJECT_PROMPT)
      await conversation.getByRole('button', { name: 'Send message', exact: true }).click()
      await expect.poll(() => conversation.getByText(reply, { exact: true }).count()).toBe(count)
      await expect.poll(() => sharedWorkspace.isEnabled()).toBe(true)
    }
    await checkProjectAccess(PROJECT_UNAVAILABLE, 1)
    await sharedWorkspace.click()
    await expect.poll(() => sharedWorkspace.getAttribute('aria-checked')).toBe('true')
    const files = page.getByRole('button', { name: 'Open VPS files', exact: true })
    await expect.poll(() => files.getAttribute('aria-haspopup')).toBe('menu')
    await files.click()
    await page.getByRole('menuitem', { name: 'Shared workspace', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    const workspaceView = await captureStableAria(page, panelSelector, web.workspaceCwd)
    await checkProjectAccess(PROJECT_AVAILABLE, 1)
    await sharedWorkspace.click()
    await expect.poll(() => sharedWorkspace.getAttribute('aria-checked')).toBe('false')
    await expect.poll(() => files.getAttribute('aria-haspopup')).toBeNull()
    await checkProjectAccess(PROJECT_UNAVAILABLE, 2)
    await writeFile(disconnectedComputer, imported.sessionId)
    await panel.getByRole('status').getByText('Computer connection lost', { exact: true }).waitFor()
    await panel.getByRole('button', { name: 'Restart computer', exact: true }).click()
    const confirmation = await captureStableAria(page, panelSelector, web.workspaceCwd)
    await panel.getByRole('button', { name: 'Restart', exact: true }).click()
    await panel.getByRole('status').getByText('Watching', { exact: true }).waitFor()
    expect(await readFile(restartedComputers, 'utf8')).toBe(`${imported.sessionId}\n`)
    expect(await network.getAttribute('aria-checked')).toBe('true')
    await panel.getByRole('button', { name: 'Close computer panel' }).click()
    await page.locator(`[data-bot-id="${BOT}"]`).click()
    await conversation.locator('[data-composer-input][contenteditable="true"]').fill('Ask me to sign in on your Computer.')
    await conversation.getByRole('button', { name: 'Send message', exact: true }).click()
    const cardSelector = '[data-computer-sign-in-card]'
    const card = page.locator(cardSelector)
    const api = { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'status', sessionId: bot.sessionId }) }
    await expect.poll(() => adapter.requestCount, { timeout: 5_000 }).toBeGreaterThan(0)
    await expect.poll(async () => {
      const response = await web.hostFetch('/api/computer/sign-in', api)
      const result: unknown = await response.json()
      if (typeof result !== 'object' || result === null || !('request' in result)) return undefined
      const request = result.request
      if (typeof request !== 'object' || request === null || !('id' in request) || !('canCancel' in request)
        || request.canCancel !== true || typeof request.id !== 'string') return undefined
      return request.id
    }, { timeout: 5_000 }).toBeTypeOf('string')
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
    await compareOrRefreshGolden(GOLDEN, [
      `## Shared workspace and Internet enabled\n\n${workspaceView}`, `## Restart confirmation\n\n${confirmation}`,
      `## Waiting in chat\n\n${pending}`, `## In control\n\n${privateView}`,
    ].join('\n\n'), MODE)
  } finally {
    try { await browser?.close() }
    finally {
      try { await scaffold?.close() }
      finally { await rm(root, { recursive: true, force: true }) }
    }
  }
})
