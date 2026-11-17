// Keyless assembled-browser coverage for owner-only Grok attachment downloads.
// The vault and archive are generated inside a temporary scaffold workspace.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Download, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { dump } from 'js-yaml'
import { entryListSchema } from '@yharness/cordis-plugin-include'
import { BotId, type BotView } from '@yharness/bots'
import {
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/grok-history-attachments', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/bot-workspace/session.v3.jsonl', import.meta.url))
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()
const SOURCE_ID = 'primary'
const SOURCE_SEQUENCE = 2
const ATTACHMENT_NAME = 'research-notes.txt'
const ATTACHMENT_TIMESTAMP = 3_000
const ATTACHMENT_SIZE_BYTES = 24 * 1024 * 1024
const ATTACHMENT_BYTES = Buffer.alloc(ATTACHMENT_SIZE_BYTES, 0x53)
const ATTACHMENT_DIGEST = createHash('sha256').update(ATTACHMENT_BYTES).digest('hex')
const OVERSIZED_ATTACHMENT_NAME = 'oversized-synthetic.bin'
const OVERSIZED_ATTACHMENT_TIMESTAMP = 4_000
const OVERSIZED_ATTACHMENT_SIZE_BYTES = ATTACHMENT_SIZE_BYTES + 1

async function summarizeDownload(download: Download): Promise<{ readonly size: number; readonly sha256: string }> {
  const path = await download.path()
  if (path === null) throw new Error('browser did not expose a downloaded file')
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer
    size += bytes.byteLength
    hash.update(bytes)
  }
  return { size, sha256: hash.digest('hex') }
}

describe('web e2e: owner-only Grok history attachments', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let workspaceRoot: string
  let vaultRoot: string
  let filePath: string
  let secondBot!: BotView

  beforeAll(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'dsh-web-grok-history-attachments-'))
    vaultRoot = join(workspaceRoot, 'attachment-vault')
    await mkdir(vaultRoot)
    filePath = join(vaultRoot, ATTACHMENT_DIGEST)
    await writeFile(filePath, ATTACHMENT_BYTES)
    const oversizedBytes = Buffer.alloc(OVERSIZED_ATTACHMENT_SIZE_BYTES, 0x4f)
    const oversizedDigest = createHash('sha256').update(oversizedBytes).digest('hex')
    await writeFile(join(vaultRoot, oversizedDigest), oversizedBytes)
    await writeFile(join(vaultRoot, 'manifest.json'), JSON.stringify({
      version: 1,
      entries: [{
        botId: 'bot-grok-downloads',
        sourceId: SOURCE_ID,
        sourceSequence: SOURCE_SEQUENCE,
        filename: ATTACHMENT_NAME,
        timestampMs: ATTACHMENT_TIMESTAMP,
        sha256: ATTACHMENT_DIGEST,
      }, {
        botId: 'bot-grok-downloads',
        sourceId: SOURCE_ID,
        sourceSequence: SOURCE_SEQUENCE + 1,
        filename: OVERSIZED_ATTACHMENT_NAME,
        timestampMs: OVERSIZED_ATTACHMENT_TIMESTAMP,
        sha256: oversizedDigest,
      }],
    }))
    const overlay = join(workspaceRoot, 'grok-history-attachments.patch.yml')
    await writeFile(overlay, dump([
      { id: 'agent-bots', config: { grokHistoryAttachmentVault: vaultRoot } },
    ], { schema: entryListSchema, noRefs: true, lineWidth: -1 }))

    // The scenario exercises real Bot, Host route, and Session services but never
    // sends a model request, so a header-only providers-only fixture is sufficient.
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE,
      replayProvidersOnly: true,
      workspaceCwd: workspaceRoot,
      extraOverlayPath: overlay,
    })
    const { bot: firstBot } = await scaffold.ctx.bots.create({
      id: BotId('bot-grok-scout'), name: 'Scout', identity: 'browse', accent: 'teal', cwd: scaffold.workspaceCwd,
    })
    secondBot = (await scaffold.ctx.bots.create({
      id: BotId('bot-grok-downloads'), name: 'Grok', identity: 'goal', accent: 'amber', cwd: scaffold.workspaceCwd,
    })).bot
    const document = JSON.stringify({
      source: 'grok-bot', version: 2, firstCachedSequence: 0, messages: [
        { sourceSequence: 0, role: 'user', text: 'Recovered question', timestampMs: null },
        { sourceSequence: 1, role: 'assistant', text: 'Recovered answer', timestampMs: 2_000 },
        { sourceSequence: SOURCE_SEQUENCE, role: 'attachment', text: ATTACHMENT_NAME, timestampMs: ATTACHMENT_TIMESTAMP },
        {
          sourceSequence: SOURCE_SEQUENCE + 1,
          role: 'attachment',
          text: OVERSIZED_ATTACHMENT_NAME,
          timestampMs: OVERSIZED_ATTACHMENT_TIMESTAMP,
        },
      ],
    })
    for (const bot of [firstBot, secondBot]) await scaffold.ctx.bots.importGrokHistory({ botId: bot.id, document })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (workspaceRoot !== undefined) await rm(workspaceRoot, { recursive: true, force: true })
  })

  it('downloads only the exact verified attachment and recovers after a vault reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-grok-history-attachments'))
    const openHistory = async () => {
      const sidebar = page.locator('[data-yh-part="sidebar"]')
      const botsMode = sidebar.getByRole('button', { name: 'Bots', exact: true })
      await botsMode.waitFor({ state: 'visible' })
      if (await botsMode.getAttribute('aria-pressed') !== 'true') await botsMode.click()
      const roster = sidebar.locator('aside[aria-label="Bot workspace"]')
      const row = roster.locator(`[data-bot-id="${secondBot.id}"]`)
      await row.click()
      const detail = page.locator(`section[aria-label="${secondBot.name}"]`)
      await detail.getByRole('button', { name: 'Imported Grok chat', exact: true }).click()
      return page.getByRole('dialog', { name: 'Imported Grok chat' })
    }
    const downloadName = `Download ${ATTACHMENT_NAME}`
    const dialog = await openHistory()
    const link = dialog.getByRole('link', { name: downloadName, exact: true })
    const href = await link.getAttribute('href')
    if (href === null) throw new Error('attachment download link has no href')
    const downloadUrl = new URL(href, scaffold.baseUrl)
    expect(downloadUrl.origin).toBe(new URL(scaffold.baseUrl).origin)
    expect(downloadUrl.pathname).toBe('/api/bots/grokHistory/downloadAttachment')
    expect(downloadUrl.searchParams.get('botId')).toBe(String(secondBot.id))
    expect(downloadUrl.searchParams.get('sourceId')).toBe(SOURCE_ID)
    expect(downloadUrl.searchParams.get('sourceSequence')).toBe(String(SOURCE_SEQUENCE))

    const downloadPromise = page.waitForEvent('download')
    await link.click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe(ATTACHMENT_NAME)
    await expect(summarizeDownload(download)).resolves.toEqual({ size: ATTACHMENT_SIZE_BYTES, sha256: ATTACHMENT_DIGEST })

    await dialog.getByText(OVERSIZED_ATTACHMENT_NAME, { exact: true }).waitFor()
    expect(await dialog.getByRole('link', { name: `Download ${OVERSIZED_ATTACHMENT_NAME}`, exact: true }).count()).toBe(0)

    const unauthenticated = await fetch(downloadUrl)
    expect(unauthenticated.status).toBe(401)
    await unauthenticated.body?.cancel()
    for (const query of [
      `botId=bot-grok-scout&sourceId=${SOURCE_ID}&sourceSequence=${SOURCE_SEQUENCE}`,
      `botId=${secondBot.id}&sourceId=missing&sourceSequence=${SOURCE_SEQUENCE}`,
      `botId=${secondBot.id}&sourceId=${SOURCE_ID}&sourceSequence=99`,
      `botId=${secondBot.id}&sourceId=${SOURCE_ID}&sourceSequence=${SOURCE_SEQUENCE + 1}`,
    ]) {
      const response = await scaffold.hostFetch(`/api/bots/grokHistory/downloadAttachment?${query}`)
      expect(response.status).toBe(404)
      await response.body?.cancel()
    }

    await rm(filePath)
    const unavailable = await scaffold.hostFetch(downloadUrl.pathname + downloadUrl.search)
    expect(unavailable.status).toBe(404)
    expect(unavailable.headers.get('cache-control')).toBe('no-store')
    await unavailable.body?.cancel()
    await page.reload({ waitUntil: 'load' })
    const unavailableDialog = await openHistory()
    await unavailableDialog.getByText(ATTACHMENT_NAME, { exact: true }).waitFor()
    expect(await unavailableDialog.getByRole('link', { name: downloadName, exact: true }).count()).toBe(0)
    await unavailableDialog.getByText(OVERSIZED_ATTACHMENT_NAME, { exact: true }).waitFor()
    expect(await unavailableDialog.getByRole('link', { name: `Download ${OVERSIZED_ATTACHMENT_NAME}`, exact: true }).count()).toBe(0)

    await writeFile(filePath, ATTACHMENT_BYTES)
    await page.reload({ waitUntil: 'load' })
    const reloadedDialog = await openHistory()
    const reloadedLink = reloadedDialog.getByRole('link', { name: downloadName, exact: true })
    const retryPromise = page.waitForEvent('download')
    await reloadedLink.click()
    const retry = await retryPromise
    expect(retry.suggestedFilename()).toBe(ATTACHMENT_NAME)
    await expect(summarizeDownload(retry)).resolves.toEqual({ size: ATTACHMENT_SIZE_BYTES, sha256: ATTACHMENT_DIGEST })

    await compareOrRefreshGolden(
      UI_EXPECTED,
      await captureStableAria(page, '[role="dialog"][aria-label="Imported Grok chat"]', scaffold.workspaceCwd),
      MODE,
    )
    for (const { width, zoom } of [{ width: 1440, zoom: 1 }, { width: 900, zoom: 1.25 }]) {
      await page.setViewportSize({ width, height: 850 })
      await page.evaluate((value) => { document.documentElement.style.zoom = String(value) }, zoom)
      await reloadedLink.hover()
      const tooltip = page.getByRole('tooltip', { name: 'Download attachment', exact: true })
      await tooltip.waitFor({ state: 'visible' })
      const lines = await tooltip.evaluate((element) => {
        const range = document.createRange()
        range.selectNodeContents(element)
        return new Set([...range.getClientRects()].map(rect => rect.top)).size
      })
      expect(lines).toBeGreaterThan(0)
      expect(lines).toBeLessThanOrEqual(2)
      await page.mouse.move(1, 1)
      await tooltip.waitFor({ state: 'hidden' })
    }
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)
})
