/** Keyless owner Bot Library and authenticated download through the assembled Web app. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BotId } from '@yharness/bots'
import { createAssistantMessage, ToolCallId } from '@yharness/llm'
import type {} from '@yharness/tool-present/types'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const fixture = fileURLToPath(new URL('../../../snapshots/web/bot-workspace/session.v3.jsonl', import.meta.url))
const images = process.env.DSH_BOT_LIBRARY_VISUAL_DIR

it('opens current and imported items for just the selected Bot', async () => {
  const botId = BotId('bot-library-scout-fixture')
  const root = await mkdtemp(join(tmpdir(), 'dsh-bot-library-archive-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const vault = join(root, 'vault')
  await mkdir(vault)
  const recovered = 'Checklist recovered from the example archive.\n'
  const filename = 'Archived checklist.md'
  const timestampMs = Date.parse('2025-08-18T12:00:00Z')
  const sha256 = createHash('sha256').update(recovered).digest('hex')
  const archiveUrl = 'https://docs.example.com/archive'
  const overlay = join(root, 'library-archive.patch.yml')
  await writeFile(join(vault, sha256), recovered)
  await writeFile(join(vault, 'manifest.json'), JSON.stringify({
    version: 1,
    entries: [{ botId, sourceId: 'primary', sourceSequence: 2, filename, timestampMs, sha256 }],
  }))
  await writeFile(overlay, JSON.stringify([{ id: 'agent-bots', config: { grokHistoryAttachmentVault: vault } }]))
  const scaffold = await launchWebScaffold({ replayFixture: fixture, replayProvidersOnly: true, extraOverlayPath: overlay })
  const browser = await chromium.launch()
  try {
    const page = await newEnglishPage(browser)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bot-library'))
    const scout = (await scaffold.ctx.bots.create({ id: botId, name: 'Scout', identity: 'browse', accent: 'teal', cwd: scaffold.workspaceCwd })).bot
    const orbit = (await scaffold.ctx.bots.create({ name: 'Orbit', identity: 'goal', accent: 'amber', cwd: scaffold.workspaceCwd })).bot
    await scaffold.ctx.bots.importGrokHistory({ botId, document: JSON.stringify({
      source: 'grok-bot', version: 2, firstCachedSequence: 1, messages: [
        { sourceSequence: 1, role: 'assistant', text: `[Archived runbook](${archiveUrl})`, timestampMs },
        { sourceSequence: 2, role: 'attachment', text: filename, timestampMs },
        { sourceSequence: 3, role: 'attachment', text: 'Missing file.md', timestampMs },
      ],
    }) })
    const delivered = scaffold.ctx.sessions.get(scout.sessionId)
    if (delivered === undefined) throw new Error('The fixture’s delivery Session is unavailable.')
    const report = 'Release checklist\n\n- Verify the narrow window\n'
    await writeFile(join(scaffold.workspaceCwd, 'Release checklist.md'), report)
    await writeFile(join(scaffold.workspaceCwd, 'Window layout.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==', 'base64'))
    await writeFile(join(scaffold.workspaceCwd, 'Verification results.csv'), 'check,status\nlayout,passed\n')
    delivered.append('deliverables/presented', { turn: 1, callId: ToolCallId('fixture-delivery'), files: [
      { path: 'Release checklist.md' }, { path: 'Window layout.png' }, { path: 'Verification results.csv' },
    ] })
    const url = 'https://docs.example.com/release'
    delivered.append('assistant/message', {
      turn: 1,
      step: 0,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `[Release notes](${url})` }],
        source: { provider: 'fixture', model: 'fixture' },
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    await scaffold.ctx.sessions.flush(delivered)
    const projected = await scaffold.ctx.bots.readLibrary({ botId: scout.id })
    expect(projected.items.map(item => item.label)).toContain('Release checklist.md')

    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Bots', exact: true }).click()
    const openLibrary = async (id: string): Promise<void> => {
      await page.locator(`[data-bot-id="${id}"]`).click()
      await page.getByRole('button', { name: 'Bot options', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Library', exact: true }).click()
    }
    await openLibrary(scout.id)
    const dialog = page.getByRole('dialog', { name: 'Library', exact: true })
    const reportLink = dialog.getByRole('link', { name: 'Download Release checklist.md', exact: true })
    await expect.poll(() => dialog.innerText({ timeout: 5_000 }), { timeout: 7_000 }).toContain('Release checklist.md')
    const archiveFile = dialog.getByRole('link', { name: 'Download Archived checklist.md', exact: true })
    await archiveFile.waitFor()
    expect(await archiveFile.textContent()).toContain('Imported from Grok')
    expect(await dialog.getByRole('link', { name: 'Download Missing file.md', exact: true }).count()).toBe(0)
    const archiveDownload = page.waitForEvent('download')
    await archiveFile.click()
    const saved = await archiveDownload
    const savedPath = await saved.path()
    expect(saved.suggestedFilename()).toBe(filename)
    expect(savedPath === null ? null : await readFile(savedPath, 'utf8')).toBe(recovered)
    await dialog.getByRole('button', { name: 'Media', exact: true }).click()
    await dialog.getByRole('link', { name: 'Download Window layout.png', exact: true }).waitFor()
    expect(await reportLink.count()).toBe(0)
    const opened: string[] = []
    await page.context().route(candidate => [url, archiveUrl].includes(candidate.href), async (route) => {
      opened.push(route.request().url())
      await route.fulfill({ contentType: 'text/html', body: '<title>Fixture release notes</title>' })
    })
    await dialog.getByRole('button', { name: 'Links', exact: true }).click()
    const external = dialog.getByRole('link', { name: 'Open Release notes', exact: true })
    const archivedLink = dialog.getByRole('link', { name: 'Open Archived runbook', exact: true })
    await external.waitFor()
    await archivedLink.waitFor()
    expect(await archivedLink.getAttribute('href')).toBe(archiveUrl)
    expect(await archivedLink.textContent()).toContain('Imported from Grok')
    expect(await external.getAttribute('href')).toBe(url)
    expect(await reportLink.count()).toBe(0)
    expect(opened).toEqual([])
    const opening = page.waitForEvent('popup')
    await external.click()
    const popup = await opening
    await popup.waitForLoadState()
    expect(await popup.title()).toBe('Fixture release notes')
    await popup.close()
    expect(opened).toEqual([url])
    const openingArchive = page.waitForEvent('popup')
    await archivedLink.click()
    const archivePopup = await openingArchive
    await archivePopup.waitForLoadState()
    expect(await archivePopup.title()).toBe('Fixture release notes')
    await archivePopup.close()
    expect(opened).toEqual([url, archiveUrl])
    await dialog.getByRole('button', { name: 'All', exact: true }).click()
    const downloaded = page.waitForEvent('download')
    await reportLink.click()
    const download = await downloaded
    const path = await download.path()
    expect(download.suggestedFilename()).toBe('Release checklist.md')
    expect(path === null ? null : await readFile(path, 'utf8')).toBe(report)

    if (images !== undefined) {
      await mkdir(images, { recursive: true })
      for (const [width, colorScheme, filename] of [
        [1440, 'dark', 'desktop-dark.png'], [480, 'light', 'narrow-light.png'],
      ] as const) {
        await page.setViewportSize({ width, height: 920 })
        await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
        await page.locator('body[data-ds-dark-theme]').waitFor({ state: colorScheme === 'dark' ? 'visible' : 'detached' })
        const bounds = await dialog.boundingBox()
        expect(bounds === null || bounds.x < 0 || bounds.x + bounds.width > width).toBe(false)
        await dialog.getByRole('button', { name: 'Links', exact: true }).click()
        await external.waitFor()
        await page.screenshot({ path: join(images, filename), animations: 'disabled' })
        await dialog.getByRole('button', { name: 'Files', exact: true }).click()
        await archiveFile.waitFor()
        await page.screenshot({ path: join(images, `files-${filename}`), animations: 'disabled' })
      }
      await page.setViewportSize({ width: 1440, height: 920 })
    }
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    await openLibrary(orbit.id)
    await dialog.getByText('This bot hasn’t sent any files or links yet.').waitFor()
    expect(await dialog.getByRole('link').count()).toBe(0)
  } finally {
    await browser.close()
    await scaffold.close()
  }
}, 90_000)
