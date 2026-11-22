/** Built workspace chrome with a controlled Desktop carrier; no Electron or installer is exercised. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator, type Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { presentDesktopUpdate } from '../../desktop/src/update-presentation.ts'
import { en } from '../../desktop/src/locale.ts'
import { launchWebScaffold, watchConsole } from './scaffold.ts'

// Mirrors the preload's presentation-only API; importing Client projects would mix compiler faces.
type Presentation = ReturnType<typeof presentDesktopUpdate>
interface CarrierFixture {
  publish(state: Presentation): void
  opens: number
  listeners: Set<(state: Presentation) => void>
}
type FixtureWindow = Window & typeof globalThis & { updateFixture: CarrierFixture }

const PREVIEWS = process.env.YH_SIDEBAR_STATUS_SCREENSHOTS

async function alignment(axis: 'x' | 'y', controls: readonly Locator[]): Promise<number> {
  const sizes = await Promise.all(controls.map(async (control) => {
    const box = await control.boundingBox()
    if (box === null) throw new Error('Sidebar footer control did not render')
    return axis === 'x' ? box.x + box.width / 2 : box.y + box.height / 2
  }))
  return Math.max(...sizes) - Math.min(...sizes)
}

async function captureFooter(page: Page, name: string): Promise<void> {
  if (PREVIEWS === undefined) return
  await mkdir(PREVIEWS, { recursive: true })
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme'))
      .toBe(colorScheme === 'dark' ? '' : null)
    await page.screenshot({ path: join(PREVIEWS, `${name}-${colorScheme}.png`), animations: 'disabled' })
  }
}

describe('web e2e: Desktop update workspace chrome', () => {
  it.each(['zh-CN', 'en-US'])('renders update states and routes explicit actions in %s', async (locale) => {
    const scaffold = await launchWebScaffold({})
    try {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale })
        await page.route('**/api/skill-compound.update', route => route.fulfill({ json: {
          vendored: '0.11.0', upstream: null, updateAvailable: false, repository: 'example/skills',
          checkedAt: 1, error: 'The update check timed out.',
        } }))
        await page.addInitScript(() => {
          let current: Presentation = { phase: 'idle' }
          const listeners = new Set<(state: Presentation) => void>()
          const fixture: CarrierFixture = {
            opens: 0, listeners,
            publish(state) { current = state; for (const listener of listeners) listener(state) },
          }
          Object.assign(window, {
            updateFixture: fixture,
            dshDesktop: { protocolVersion: 1, updates: {
              status: async () => current,
              open: async () => { fixture.opens += 1 },
              subscribe(listener: (state: Presentation) => void) { listeners.add(listener); return () => listeners.delete(listener) },
            } },
          })
        })
        const tripwire = watchConsole(page)
        const evidenceRoot = fileURLToPath(new URL('../../desktop/.desktop-build/qualification/', import.meta.url))
        await mkdir(evidenceRoot, { recursive: true })
        const evidence = await mkdtemp(join(evidenceRoot, `workspace-updates-${locale}-`))
        try {
          await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
          await page.waitForSelector('[class*="frame"]')
          await expect.poll(() => page.evaluate(() => (window as FixtureWindow).updateFixture.listeners.size)).toBe(1)
          // The current Web bundle has English-only update copy, so unsupported
          // browser locales use the English fallback for every update control.
          const availableLabel = 'Update'
          const retryLabel = 'Retry update'
          const errorDetail = 'Could not download the update. Please try again.'
          const readyLabel = 'Install and Restart'
          const version = '0.1.5-nightly.20260911'
          // The carrier classification deliberately uses English shell copy; Web copy follows its own locale.
          const available = presentDesktopUpdate({ phase: 'available', version }, en)
          const publish = async (state: Presentation) => page.evaluate((value) => {
            (window as FixtureWindow).updateFixture.publish(value)
          }, state)
          const opens = async () => page.evaluate(() => (window as FixtureWindow).updateFixture.opens)
          await publish(available)
          const update = page.getByRole('button', { name: availableLabel, exact: true })
          await update.waitFor()
          const settings = page.getByRole('button', { name: /^(Account menu|Settings)$/ })
          const warningName = 'Could not check for Compound skills updates'
          const warning = page.getByRole('button', { name: warningName, exact: true })
          await warning.waitFor()
          await expect.poll(() => alignment('y', [settings, update, warning])).toBeLessThan(2)
          const footer = page.locator('[data-yh-part="sidebar-footer"]')
          await expect.poll(() => footer.getByRole('button').count()).toBe(3)
          for (const control of [update, warning]) {
            expect(await control.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
          }
          if (locale === 'en-US') await captureFooter(page, 'desktop')
          expect(await opens()).toBe(0)
          const geometry = await update.boundingBox()
          expect(geometry).not.toBeNull()
          expect(geometry!.x).toBeLessThan(350)
          expect(geometry!.y).toBeGreaterThan(650)
          await page.screenshot({ path: join(evidence, 'available.png') })
          await update.click()
          await expect.poll(opens).toBe(1)
          await update.focus()
          await page.keyboard.press('Tab')
          expect(await warning.evaluate(element => document.activeElement === element)).toBe(true)
          const warningTip = page.getByRole('tooltip', { name: warningName, exact: true })
          await warningTip.waitFor({ timeout: 5_000 })
          expect(await warningTip.evaluate((element) => {
            const { top, left, bottom, right, height } = element.getBoundingClientRect()
            const style = getComputedStyle(element)
            const blockPadding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
            return top >= 0 && left >= 0 && bottom <= innerHeight && right <= innerWidth
              && height - blockPadding <= 2 * parseFloat(style.lineHeight)
          })).toBe(true)
          await warning.press('Enter')
          const skillDialog = page.getByRole('dialog', { name: 'Compound skills update', exact: true })
          await skillDialog.getByText('Could not check for updates: The update check timed out.', { exact: true })
            .waitFor({ timeout: 5_000 })
          await skillDialog.getByRole('button', { name: 'Close', exact: true }).click()
          await skillDialog.waitFor({ state: 'hidden' })

          const progress = presentDesktopUpdate({ phase: 'downloading', version, percent: 58 }, en)
          await publish(progress)
          const wideDownloading = page.locator('[class*="triggerRow"]').getByRole('button', { name: '58%', exact: true })
          await wideDownloading.waitFor()
          expect(await wideDownloading.getAttribute('aria-disabled')).toBe('true')
          expect(await wideDownloading.locator('svg').count()).toBe(1)
          // Force dispatch past Playwright's aria-disabled guard to verify the product's click guard.
          await wideDownloading.click({ force: true })
          expect(await opens()).toBe(1)
          await page.screenshot({ path: join(evidence, 'downloading.png') })

          const collapse = 'Collapse sidebar'
          const expand = 'Open sidebar'
          await page.getByRole('button', { name: collapse, exact: true }).click()
          const toggle = page.getByRole('button', { name: expand, exact: true })
          const badge = page.getByRole('button', { name: '58%', exact: true })
          await badge.waitFor()
          await expect.poll(() => wideDownloading.count()).toBe(0)
          expect(await page.getByRole('button', { name: '58%', exact: true }).count()).toBe(1)
          const updateBackground = await badge.evaluate(element => getComputedStyle(element).backgroundColor)
          await page.setViewportSize({ width: 480, height: 800 })
          await expect.poll(() => alignment('x', [settings, badge, warning])).toBeLessThan(2)
          if (locale === 'en-US') await captureFooter(page, 'narrow')
          await page.setViewportSize({ width: 1280, height: 800 })
          await page.screenshot({ path: join(evidence, 'collapsed.png') })

          const error = presentDesktopUpdate({ phase: 'error', version, failedOperation: 'download', message: 'HTTP 503' }, en)
          await publish(error)
          // Keep the collapsed action scoped to its rail slot. After expanding,
          // the same retry label is rendered by the wide account-row control.
          const errorBadge = page.locator('[class*="footerActions"]').getByRole('button', { name: retryLabel, exact: true })
          await errorBadge.waitFor()
          // A failure keeps the update palette; only the label distinguishes it.
          const failedBackground = await errorBadge.evaluate(element => getComputedStyle(element).backgroundColor)
          expect(failedBackground).toBe(updateBackground)
          await errorBadge.hover()
          const tooltip = page.getByRole('tooltip', { name: errorDetail, exact: true })
          await expect.poll(() => tooltip.evaluateAll(elements => elements.map(element => getComputedStyle(element).opacity))).toEqual(['1'])
          await page.screenshot({ path: join(evidence, 'collapsed-error.png') })
          await toggle.click()
          const retry = page.getByRole('button', { name: retryLabel, exact: true })
          await retry.waitFor()
          await expect.poll(() => errorBadge.count()).toBe(0)
          // The expanding ancestor can move the button after hover's element-only stability check.
          await retry.evaluate(async (element) => {
            const movements = document.getAnimations().filter(animation => animation.effect instanceof KeyframeEffect
              && animation.effect.target instanceof Element && animation.effect.target.contains(element)
              && animation.effect.getComputedTiming().endTime !== Infinity)
            await Promise.all(movements.map(animation => animation.finished))
          })
          await retry.hover()
          await expect.poll(() => tooltip.evaluateAll(elements => elements.map(element => getComputedStyle(element).opacity))).toEqual(['1'])
          await page.screenshot({ path: join(evidence, 'retry.png') })
          await retry.click()
          await expect.poll(opens).toBe(2)

          await publish(presentDesktopUpdate({ phase: 'ready', version }, en))
          const ready = page.getByRole('button', { name: readyLabel, exact: true })
          await ready.waitFor()
          expect(await ready.getAttribute('aria-disabled')).toBe('false')
          expect(await opens()).toBe(2)
          await page.screenshot({ path: join(evidence, 'ready.png') })
          await ready.click()
          await expect.poll(opens).toBe(3)
          await page.context().setOffline(true)
          const reconnect = footer.getByRole('button', { name: 'Disconnected, reconnect now', exact: true })
          await reconnect.waitFor()
          await expect.poll(() => alignment('y', [settings, reconnect, warning])).toBeLessThan(2)
          expect(await ready.count()).toBe(0)
          if (locale === 'en-US') await captureFooter(page, 'disconnected')
          await page.context().setOffline(false)
          await ready.waitFor()
          expect(tripwire.pageErrors).toEqual([])
          expect(tripwire.warnings.filter(warning => warning !== '[connection] connection lost, retry #1')).toEqual([])
          expect(await page.evaluate(() => (window as FixtureWindow).updateFixture.listeners.size)).toBe(1)
          await writeFile(join(evidence, 'result.json'), JSON.stringify({ locale, geometry, updateBackground, failedBackground,
            passed: true, explicitActions: 3, carrier: 'substituted', host: 'real Web composition',
            electron: false, installerExecuted: false }, null, 2) + '\n')
          console.log(`Desktop workspace chrome evidence: ${evidence}`)
        } catch (error) {
          await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => undefined)
          throw error
        }
      } finally { await browser.close() }
    } finally { await scaffold.close() }
  })
})
