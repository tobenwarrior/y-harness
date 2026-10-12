/** Real browser coverage for the independent style, palette, and content-size preferences. */
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandTurnProcesses, newEnglishPage, openSettings, REPO_ROOT, saveFailureShot, writeComposerDraft } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/terminal-appearance', import.meta.url))
const RECORDED = new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url)
const LONG_LINE = 'appearance_source_columns_'.repeat(70)
const SAMPLE_TITLE = 'Appearance code sample'
const SAMPLE_TEXT = 'Readable conversation prose remains separate from source code.'
const DRAFT = 'Unsubmitted appearance draft'

/** Durable source output gives narrow layouts a long line without a model request or large file. */
function codeFixture(sourceLine = LONG_LINE, title = SAMPLE_TITLE, prompt = 'Inspect the long source line.'): string {
  const session = Session.create(SessionId('appearance-code-source'))
  const callId = ToolCallId('appearance-read')
  const argumentsText = JSON.stringify({ file_path: 'appearance.ts' })
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: prompt }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', { title, messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createAssistantMessage({
      content: [{ type: 'tool-call', id: callId, name: 'read', arguments: argumentsText }],
      source: { provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'read', arguments: argumentsText })
  session.append('tool/result', {
    turn: 1, step: 1,
    meta: { path: 'appearance.ts', offset: 1, lines: [{ number: 1, text: sourceLine }], totalLines: 1 },
    message: createToolResultMessage({
      callId, content: [{ type: 'text', text: `<path>appearance.ts</path>\n<type>file</type>\n<content>\n1: ${sourceLine}\n</content>` }],
      isError: false,
    }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  session.append('assistant/message', {
    stream: [], turn: 1, step: 2,
    message: createAssistantMessage({ content: [{ type: 'text', text: SAMPLE_TEXT }], source: { provider: 'fixture', model: 'fixture' } }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 2 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [JSON.stringify({
    type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0,
    cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0,
  }), ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
}

describe('web e2e: terminal appearance', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ developerTools: true })
    // The recording remains read-only; a second synthetic Session owns only long-line stress.
    await seedSession(scaffold, await readFile(RECORDED, 'utf8'), 'appearance-recorded')
    await seedSession(scaffold, codeFixture(), 'appearance-code')
    await seedSession(scaffold, codeFixture("const appearance = { style: 'terminal', palette: 'dark', fontSize: 14 }", 'Terminal appearance', 'Inspect the appearance configuration.'), 'appearance-preview')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('tree', { name: 'Sessions', exact: true }).waitFor()
    const group = page.getByText('Ungrouped', { exact: true }).locator('xpath=ancestor::*[@aria-expanded][1]')
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
    await page.locator('[data-row-key="session:appearance-code"][role="treeitem"]').click()
    await page.getByText(SAMPLE_TEXT, { exact: true }).waitFor()
    await expandTurnProcesses(page)
    await page.locator('[data-variant="read"] [data-expandable]').click()
    await page.locator('[data-read]').waitFor()
  })

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  async function appearanceDialog(target: Page = page, locale: 'en' | 'zh' = 'en'): Promise<Locator> {
    await openSettings(target, locale)
    const dialog = target.getByRole('dialog', { name: locale === 'en' ? 'Settings' : '设置', exact: true })
    await dialog.getByRole('button', { name: locale === 'en' ? 'Appearance' : '外观', exact: true }).click()
    await dialog.getByRole('group', { name: locale === 'en' ? 'Style' : '风格', exact: true }).waitFor()
    return dialog
  }

  /** Wait for the Host acknowledgement rather than the optimistic pressed state. */
  async function selectSetting(button: Locator, field: 'style' | 'preference' | 'fontSize', value: string | number): Promise<void> {
    const [response] = await Promise.all([
      page.waitForResponse((reply) => {
        if (reply.request().method() !== 'POST' || new URL(reply.url()).pathname !== '/api/settings/mutate') return false
        const request = reply.request().postDataJSON() as {
          payload: { args: { ns: string; ops: { op: string; path: string[]; value?: unknown }[] } }
        }
        return request.payload.args.ns === 'ui-theme' && request.payload.args.ops.some(op =>
          op.op === 'set' && op.path.length === 1 && op.path[0] === field && op.value === value)
      }),
      button.click(),
    ])
    expect(await response.json()).toMatchObject({ result: { ok: true, value: { ns: 'ui-theme', value: { [field]: value } } } })
  }

  it('keeps both styles readable in both palettes, including narrow code and menus', async () => {
    onTestFailed(() => saveFailureShot(page, 'terminal-appearance-matrix'))
    expect(await page.evaluate(() => document.body.getAttribute('data-yh-style'))).toBe('default')
    await writeComposerDraft(page, page.locator('[data-composer-input]'), DRAFT)
    const observations: Array<Record<string, unknown>> = []
    const artifacts = join(REPO_ROOT, '.artifacts', 'terminal-appearance')
    await mkdir(artifacts, { recursive: true })
    for (const style of ['default', 'terminal'] as const) {
      for (const palette of ['light', 'dark'] as const) {
        await page.setViewportSize({ width: 1440, height: 1000 })
        const dialog = await appearanceDialog()
        const styleButton = dialog.getByRole('button', { name: style === 'default' ? 'Default' : 'Terminal', exact: true })
        if (await styleButton.getAttribute('aria-pressed') !== 'true') await selectSetting(styleButton, 'style', style)
        const paletteButton = dialog.getByRole('button', { name: palette === 'light' ? 'Light' : 'Dark', exact: true })
        if (await paletteButton.getAttribute('aria-pressed') !== 'true') await selectSetting(paletteButton, 'preference', palette)
        await expect.poll(() => page.evaluate(() => document.body.getAttribute('data-yh-style'))).toBe(style)
        await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(palette === 'dark')
        if (style === 'default' && palette === 'light') {
          await compareOrRefreshGolden(join(EXPECTED, 'appearance-en.expected.md'),
            await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
        }
        await page.screenshot({ path: join(artifacts, `appearance-${style}-${palette}.png`), fullPage: true })
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'hidden' })
        expect(await page.locator('[data-composer-input]').textContent()).toBe(DRAFT)
        for (const width of [1440, 720]) {
          await page.setViewportSize({ width, height: 1000 })
          await page.evaluate(async () => { await document.fonts.ready })
          const geometry = await page.evaluate(() => {
            const requireElement = (selector: string): HTMLElement => {
              const element = document.querySelector<HTMLElement>(selector)
              if (element === null) throw new Error(`Missing appearance surface: ${selector}`)
              return element
            }
            const card = requireElement('[data-composer-card]')
            const prose = requireElement('[data-yh-part="assistant-prose"]')
            const header = requireElement('[data-yh-part="conversation-breadcrumbs"]')
            const prompt = requireElement('[data-yh-part="session-prompt"]')
            const code = requireElement('[data-read] > div:last-child')
            const viewport = document.documentElement.clientWidth
            code.scrollLeft = code.scrollWidth
            const codeActuallyScrolls = code.scrollLeft > 100
            code.scrollLeft = 0
            return {
              viewportFits: document.documentElement.scrollWidth <= viewport + 1,
              composerFits: card.getBoundingClientRect().right <= viewport + 1,
              proseIsSans: !getComputedStyle(prose).fontFamily.includes('JetBrains Mono'),
              headerIsMono: getComputedStyle(header).fontFamily.includes('JetBrains Mono'),
              sessionPromptVisible: getComputedStyle(prompt).display !== 'none',
              composerRadius: getComputedStyle(card).borderRadius,
              contentSize: document.body.style.getPropertyValue('--dsh-content-font-size'),
              codeScrollsInternally: code.scrollWidth > code.clientWidth + 100 && ['auto', 'scroll'].includes(getComputedStyle(code).overflowX),
              codeActuallyScrolls,
            }
          })
          expect(geometry).toMatchObject({ viewportFits: true, composerFits: true, proseIsSans: true, contentSize: '14px', codeScrollsInternally: true, codeActuallyScrolls: true })
          expect(geometry.sessionPromptVisible).toBe(style === 'terminal')
          const composerPrompt = page.locator('[data-yh-terminal="prompt"]')
          expect(await composerPrompt.getAttribute('aria-hidden')).toBe('true')
          expect(await composerPrompt.evaluate(element => getComputedStyle(element).display !== 'none')).toBe(style === 'terminal')
          if (style === 'terminal') expect(geometry).toMatchObject({ headerIsMono: true, composerRadius: '7px' })
          if (style === 'terminal') {
            const operationalChrome = await page.evaluate(() =>
              ['[data-turn-process]', '[data-process-activity]', '[data-code-block-banner]'].map((selector) => {
                const element = document.querySelector(selector)
                if (element === null) throw new Error(`Missing Terminal operational surface: ${selector}`)
                return getComputedStyle(element).fontFamily.includes('JetBrains Mono')
              }))
            expect(operationalChrome).toEqual([true, true, true])
          }
          await page.getByRole('button', { name: 'More actions', exact: true }).click()
          const menu = page.locator('[data-menu-material]').last()
          await menu.waitFor()
          const menuGeometry = await menu.evaluate((element) => {
            const bounds = element.getBoundingClientRect()
            const material = element.querySelector(':scope > [aria-hidden="true"]')
            if (material === null) throw new Error('Menu material is missing')
            const foreground = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
            return {
              fits: bounds.left >= -1 && bounds.right <= innerWidth + 1 && bounds.top >= -1 && bounds.bottom <= innerHeight + 1,
              visibleMaterial: getComputedStyle(material).backgroundColor !== 'rgba(0, 0, 0, 0)',
              paintsAboveContent: foreground !== null && element.contains(foreground),
              radius: getComputedStyle(element).borderRadius,
            }
          })
          expect(menuGeometry).toMatchObject({ fits: true, visibleMaterial: true, paintsAboveContent: true })
          if (style === 'terminal') expect(menuGeometry.radius).toBe('5px')
          observations.push({ style, palette, width, ...geometry, menu: menuGeometry })
          await page.screenshot({ path: join(artifacts, `${style}-${palette}-${width}.png`), fullPage: true })
          await page.keyboard.press('Escape')
          await menu.waitFor({ state: 'hidden' })
          await page.screenshot({ path: join(artifacts, `${style}-${palette}-${width}-app.png`), fullPage: true })
        }
      }
    }
    await compareOrRefreshGolden(join(EXPECTED, 'geometry.expected.md'), JSON.stringify(observations, null, 2), webSnapshotMode())
    expect(tripwire.pageErrors).toEqual([])
  })

  it('keeps the narrow composer usable at both content-size limits', async () => {
    await page.setViewportSize({ width: 720, height: 1000 })
    for (const fontSize of [10, 22]) {
      await scaffold.ctx.settings.mutate('ui-theme', [{ op: 'set', path: ['fontSize'], value: fontSize }])
      await expect.poll(() => page.evaluate(() => document.body.style.getPropertyValue('--dsh-content-font-size'))).toBe(`${fontSize}px`)
      const input = page.locator('[data-composer-input]')
      await writeComposerDraft(page, input, DRAFT)
      expect(await input.textContent()).toBe(DRAFT)
      const geometry = await input.evaluate((element) => {
        const card = element.closest('[data-composer-card]')
        if (card === null) throw new Error('Composer card is missing')
        const inputBounds = element.getBoundingClientRect()
        const cardBounds = card.getBoundingClientRect()
        const hit = document.elementFromPoint(inputBounds.left + 3, inputBounds.top + inputBounds.height / 2)
        return {
          pageFits: document.documentElement.scrollWidth <= innerWidth + 1,
          inputFits: inputBounds.left >= cardBounds.left && inputBounds.right <= cardBounds.right,
          editorReceivesPointer: hit !== null && element.contains(hit),
          editorReceivesFocus: element.contains(document.activeElement),
        }
      })
      expect(geometry).toEqual({ pageFits: true, inputFits: true, editorReceivesPointer: true, editorReceivesFocus: true })
    }
    await scaffold.ctx.settings.mutate('ui-theme', [{ op: 'set', path: ['fontSize'], value: 14 }])
    await expect.poll(() => page.evaluate(() => document.body.style.getPropertyValue('--dsh-content-font-size'))).toBe('14px')
  })

  it('persists style independently of color mode and font size across reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'terminal-appearance-persistence'))
    await page.setViewportSize({ width: 1440, height: 1000 })
    await writeComposerDraft(page, page.locator('[data-composer-input]'), DRAFT)
    const dialog = await appearanceDialog()
    const dark = dialog.getByRole('button', { name: 'Dark', exact: true })
    if (await dark.getAttribute('aria-pressed') !== 'true') await selectSetting(dark, 'preference', 'dark')
    const terminal = dialog.getByRole('button', { name: 'Terminal', exact: true })
    if (await terminal.getAttribute('aria-pressed') !== 'true') await selectSetting(terminal, 'style', 'terminal')
    await dialog.getByText('14', { exact: true }).hover()
    await selectSetting(dialog.getByRole('button', { name: 'Increase font size', exact: true }), 'fontSize', 15)
    await selectSetting(dialog.getByRole('button', { name: 'Default', exact: true }), 'style', 'default')
    await expect.poll(() => page.locator('[data-composer-input]').textContent()).toBe(DRAFT)
    await expect.poll(() => readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8'))
      .toContain('style: default')
    expect(await page.evaluate(() => ({
      dark: document.body.hasAttribute('data-ds-dark-theme'), source: document.documentElement.dataset.dsThemeSource,
      size: document.body.style.getPropertyValue('--dsh-content-font-size'),
    }))).toEqual({ dark: true, source: 'dark', size: '15px' })
    await selectSetting(dialog.getByRole('button', { name: 'Terminal', exact: true }), 'style', 'terminal')
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.locator('[data-yh-part="frame"]').waitFor()
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await expect.poll(() => page.evaluate(() => ({
      style: document.body.getAttribute('data-yh-style'), dark: document.body.hasAttribute('data-ds-dark-theme'),
      source: document.documentElement.dataset.dsThemeSource, size: document.body.style.getPropertyValue('--dsh-content-font-size'),
    }))).toEqual({ style: 'terminal', dark: true, source: 'dark', size: '15px' })
    await expect.poll(() => page.locator('[data-composer-input]').textContent()).toBe(DRAFT)
    const restored = await appearanceDialog()
    expect(await restored.getByRole('button', { name: 'Terminal', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await page.keyboard.press('Escape')
    await restored.waitFor({ state: 'hidden' })
    await page.locator('[data-row-key="session:appearance-recorded"][role="treeitem"]').click()
    await page.getByText('DONE', { exact: true }).waitFor()
    await expandTurnProcesses(page)
    expect(await page.locator('[data-tool="read"] [data-disclosure-row]').first()
      .evaluate(element => getComputedStyle(element).fontFamily)).toContain('JetBrains Mono')
    expect(tripwire.pageErrors).toEqual([])
  })

  it('shows the same Terminal chrome on the conversation, plugin and automation pages', async () => {
    await scaffold.ctx.settings.mutate('ui-theme', [
      { op: 'set', path: ['style'], value: 'terminal' },
      { op: 'set', path: ['preference'], value: 'dark' },
      { op: 'set', path: ['fontSize'], value: 14 },
    ])
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.locator('[data-row-key="session:appearance-preview"][role="treeitem"]').click()
    await page.getByText(SAMPLE_TEXT, { exact: true }).waitFor()
    await expandTurnProcesses(page)
    await page.locator('[data-variant="read"] [data-expandable]').click()
    await writeComposerDraft(page, page.locator('[data-composer-input]'), 'Describe the next change…')
    const artifacts = join(REPO_ROOT, '.artifacts', 'terminal-appearance')
    for (const palette of ['dark', 'light'] as const) {
      const dialog = await appearanceDialog()
      const button = dialog.getByRole('button', { name: palette === 'dark' ? 'Dark' : 'Light', exact: true })
      if (await button.getAttribute('aria-pressed') !== 'true') await selectSetting(button, 'preference', palette)
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      await page.evaluate(async () => { await document.fonts.ready })
      await page.screenshot({ path: join(artifacts, `terminal-${palette}-1440-preview.png`), fullPage: true })
    }
    await scaffold.ctx.settings.mutate('ui-theme', [{ op: 'set', path: ['preference'], value: 'dark' }])
    for (const route of [
      { name: 'Plugins', selector: '[data-plugin-panel]', file: 'terminal-plugins-dark.png' },
      { name: 'Automation tasks', selector: '[data-testid="task-manager-page"]', file: 'terminal-automations-dark.png' },
    ]) {
      await page.getByRole('button', { name: route.name, exact: true }).click()
      const panel = page.locator(route.selector)
      await panel.waitFor()
      expect(await panel.locator('[data-yh-terminal="toolbar"]').first()
        .evaluate(element => getComputedStyle(element).fontFamily)).toContain('JetBrains Mono')
      if (route.name === 'Plugins') {
        const card = panel.locator('[data-plugin-package]').first()
        await card.waitFor()
        const restingFill = await card.evaluate(element => getComputedStyle(element).backgroundColor)
        await card.hover()
        await expect.poll(() => card.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(restingFill)
        await page.getByRole('button', { name: route.name, exact: true }).hover()
      }
      await page.screenshot({ path: join(artifacts, route.file), fullPage: true })
    }
    expect(tripwire.pageErrors).toEqual([])
  })

  it('exposes localized Appearance controls on a narrow viewport', async () => {
    await scaffold.ctx.settings.mutate('ui-theme', [
      { op: 'set', path: ['style'], value: 'terminal' },
      { op: 'set', path: ['preference'], value: 'dark' },
      { op: 'set', path: ['fontSize'], value: 15 },
    ])
    const target = await browser.newPage({ viewport: { width: 720, height: 1000 }, locale: 'zh-CN' })
    const localTripwire = watchConsole(target)
    try {
      await target.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      const dialog = await appearanceDialog(target, 'zh')
      expect(await dialog.getByRole('button', { name: '外观', exact: true }).getAttribute('aria-current')).toBe('true')
      await compareOrRefreshGolden(join(EXPECTED, 'appearance-zh.expected.md'),
        await captureStableAria(target, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
      expect(await dialog.evaluate(element => element.getBoundingClientRect().right <= innerWidth + 1)).toBe(true)
      await target.screenshot({ path: join(REPO_ROOT, '.artifacts', 'terminal-appearance', 'appearance-zh-narrow.png'), fullPage: true })
      expect(localTripwire.pageErrors).toEqual([])
    } finally { await target.close() }
  })
})
