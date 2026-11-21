/** Assembled Browser teaching and private Bot Chat admission with synthetic evidence. */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Page } from 'playwright'
import { expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@yharness/llm'
import type {} from '@yharness/bots'
import { assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const FIXTURE_DIR = fileURLToPath(new URL('../../../snapshots/web/bot-workspace', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/bot-computer-teaching/review.expected.md', import.meta.url))
const PROVIDER = 'bot-computer-teaching-fixture'
const TASK = 'Open the synthetic catalog and review the featured item.'
const UNSENT = 'Keep this existing chat draft.'
const TRACE = 'b023da7a-7004-4d17-b7a4-6f691d1d3fe0'
const EXPECTED_REPLY = 'I drafted the catalog review skill.'

interface ComputerFixtureRequest {
  readonly sessionId?: string
  readonly viewerId?: string
  readonly url?: string
  readonly action?: { readonly kind: string; readonly x: number; readonly y: number }
}

class DraftSkillAdapter extends LlmAdapter {
  readonly prompts: string[][] = []

  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: 'draft', name: 'Draft' }])
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.prompts.push(options.messages.filter(message => message.role === 'user')
      .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])))
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: EXPECTED_REPLY }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: EXPECTED_REPLY } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('reviews a browser demonstration before queuing a skill draft in the same Bot chat', async () => {
  await assertFixtureInventory(FIXTURE_DIR, ['session.v3.jsonl'])
  const scaffold = await launchWebScaffold({ replayFixture: join(FIXTURE_DIR, 'session.v3.jsonl'), replayProvidersOnly: true,
    profile: { hmr: false, packages: [] } })
  try {
    await scaffold.ctx.settings.update('ui-theme', { preference: 'system' })
    const adapter = new DraftSkillAdapter()
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter), 'Bot teaching fixture model')
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: 'draft' })
    const { bot } = await scaffold.ctx.bots.create({ name: 'Scout', identity: 'browse', accent: 'teal', cwd: scaffold.workspaceCwd })
    const browser = await chromium.launch()
    let page: Page | undefined
    try {
      const fixtureBrowser = await browser.newPage({ viewport: { width: 640, height: 400 } })
      await fixtureBrowser.setContent('<main style="padding:40px;font:20px system-ui"><h1>Sample catalog</h1><p>Featured item</p><button>View details</button></main>')
      const jpeg = (await fixtureBrowser.screenshot({ type: 'jpeg' })).toString('base64')
      await fixtureBrowser.close()
      page = await newEnglishPage(browser, 900)
      const tripwire = watchConsole(page)
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
      let viewer: string | undefined
      let recording = false
      const actions: Array<{ kind: 'navigate'; origin: string } | { kind: 'click'; x: number; y: number; button: 1 }> = []
      await page.route('**/api/computer/**', async (route) => {
        const endpoint = new URL(route.request().url()).pathname.split('/api/computer/').at(-1)
        const payload = route.request().postDataJSON() as ComputerFixtureRequest
        const mode = viewer === undefined ? 'watching' : 'controlling'
        const respond = (json: Record<string, unknown>) => route.fulfill({ json })
        if (endpoint === 'status') return respond({ available: true, kind: 'vps', computer: {
          id: bot.id, location: 'vps', permissionScope: 'bot', browser: true, teaching: true,
        } })
        expect(payload.sessionId).toBe(bot.sessionId)
        switch (endpoint) {
          case 'frame': return respond({ jpeg, width: 640, height: 400, mode, botActive: false })
          case 'take-control':
            viewer = payload.viewerId
            return respond({ mode: 'controlling' })
          case 'release-control':
            viewer = undefined
            return respond({ mode: 'watching' })
          case 'teach/start':
            expect(payload.viewerId).toBe(viewer)
            expect(recording).toBe(false)
            recording = true
            return respond({ active: true, traceId: TRACE, actionCount: 0, maxActions: 128 })
          case 'navigate':
            if (recording && payload.url !== undefined) actions.push({ kind: 'navigate', origin: new URL(payload.url).origin })
            return respond({ mode })
          case 'input':
            if (recording && payload.action?.kind === 'click') {
              actions.push({ kind: 'click', x: payload.action.x, y: payload.action.y, button: 1 })
            }
            return respond({ mode })
          case 'teach/stop':
            expect(payload.viewerId).toBe(viewer)
            expect(recording).toBe(true)
            recording = false
            return respond({ id: TRACE, status: 'review', reviewable: true, truncated: false, actions })
          default: return route.fulfill({ status: 404, json: { error: 'unknown-fixture-route' } })
        }
      })
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByRole('button', { name: 'Bots', exact: true }).click()
      await page.getByRole('complementary', { name: 'Bot workspace', exact: true }).getByRole('button', { name: 'Scout', exact: true }).click()
      const composer = page.getByRole('textbox', { name: 'Message Scout', exact: true })
      await writeComposerDraft(page, composer, UNSENT)
      await page.getByRole('button', { name: 'Open computer panel', exact: true }).click()
      const computer = page.getByRole('region', { name: 'Computer', exact: true })
      await computer.getByRole('img', { name: 'Live computer screen' }).waitFor()
      await computer.getByRole('button', { name: 'Take control', exact: true }).click()
      await computer.getByRole('button', { name: 'Teach a task', exact: true }).click()
      const setup = page.getByRole('dialog', { name: 'Teach a task' })
      const start = setup.getByRole('button', { name: 'Start recording' })
      expect(await start.isEnabled()).toBe(false)
      await setup.getByRole('textbox', { name: 'What should the Bot learn?' }).fill(TASK)
      const media = process.env.YH_BOT_TEACH_SCREENSHOTS
      if (media !== undefined) {
        await mkdir(media, { recursive: true })
        await page.screenshot({ path: join(media, 'setup-desktop-dark.png'), animations: 'disabled' })
      }
      await start.click()
      const stop = computer.getByRole('button', { name: 'Stop recording' })
      await stop.waitFor()
      await computer.getByRole('textbox', { name: 'Website address' }).fill('https://example.test/catalog')
      await computer.getByRole('button', { name: 'Open', exact: true }).click()
      await expect.poll(() => actions.length).toBe(1)
      await computer.getByRole('img', { name: 'Live computer screen' }).click()
      await expect.poll(() => actions.length).toBe(2)
      if (media !== undefined) {
        await page.mouse.move(30, 90)
        await page.screenshot({ path: join(media, 'recording-desktop-dark.png'), animations: 'disabled' })
      }
      await stop.click()
      const review = page.getByRole('dialog', { name: 'Review your demonstration' })
      await review.getByText('Opened https://example.test', { exact: true }).waitFor()
      expect(adapter.prompts).toEqual([])
      const click = actions.find(action => action.kind === 'click')
      if (click === undefined) throw new Error('The fixture did not receive a click.')
      await compareOrRefreshGolden(EXPECTED, await captureStableAria(
        page, '[role=dialog][aria-label="Review your demonstration"]', scaffold.workspaceCwd,
        { replacements: [[`Clicked at (${click.x}, ${click.y})`, 'Clicked at (x, y)']] },
      ), webSnapshotMode())
      if (media !== undefined) {
        for (const colorScheme of ['dark', 'light'] as const) {
          await page.emulateMedia({ colorScheme })
          await page.locator('body[data-ds-dark-theme]').waitFor({ state: colorScheme === 'dark' ? 'visible' : 'detached' })
          for (const [width, size] of [[1440, 'desktop'], [480, 'narrow']] as const) {
            await page.setViewportSize({ width, height: 900 })
            const box = await review.boundingBox()
            expect(box).not.toBeNull()
            if (box === null) throw new Error('Review dialog is unavailable.')
            expect(box.x).toBeGreaterThanOrEqual(0)
            expect(box.x + box.width).toBeLessThanOrEqual(width)
            await page.screenshot({ path: join(media, `review-${size}-${colorScheme}.png`), animations: 'disabled' })
          }
        }
      }
      const [settledSession] = await Promise.all([
        scaffold.whenTurnSettled(),
        review.getByRole('button', { name: 'Draft skill in chat' }).click(),
      ])
      expect(settledSession).toBe(bot.sessionId)
      await review.waitFor({ state: 'detached' })
      await page.getByText(EXPECTED_REPLY, { exact: true }).waitFor()
      expect(adapter.prompts).toHaveLength(1)
      const evidence = adapter.prompts[0]?.filter(text => text.startsWith('Draft a reusable skill for this goal')) ?? []
      expect(evidence).toHaveLength(1)
      expect(evidence[0]).toContain(TASK)
      expect(evidence[0]).toContain('Opened https://example.test')
      expect(evidence[0]).not.toContain('/catalog')
      expect(await composer.textContent()).toContain(UNSENT)
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    } catch (error) {
      if (page !== undefined) await saveFailureShot(page, 'web-e2e-bot-computer-teaching')
      throw error
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
}, 120_000)
