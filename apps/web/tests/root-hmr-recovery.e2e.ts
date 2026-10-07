/** Built client root and Session-service replacement through the real Host HMR transport. */
import { readFile, realpath, stat, utimes, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const SESSION_SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const SESSION_TITLE = 'Client HMR recovery'
const CLIENTS = [
  { id: '@deepseek-ai/dsh-client-ui-layout', file: 'packages/client/ui-layout/lib/client.js', key: 'hmrLayout' },
  { id: '@deepseek-ai/dsh-api-session-controller', file: 'packages/api/session-controller/lib/client.js', key: 'hmrSessions' },
] as const

/** Wrap the compiled apply function with counters and one event-released Cordis cleanup. */
async function instrumentClient(client: typeof CLIENTS[number]) {
  const file = await realpath(join(REPO_ROOT, client.file))
  expect(file.startsWith(`${await realpath(REPO_ROOT)}${sep}`)).toBe(true)
  const original = await readFile(file)
  const originalStat = await stat(file)
  // Finished hooks unwind in reverse order: the browser and Host close before restoration.
  onTestFinished(async () => {
    await writeFile(file, original)
    await utimes(file, originalStat.atime, originalStat.mtime)
  })
  const source = original.toString('utf8')
  const marker = '\t\treturn module.exports;'
  expect(source.indexOf(marker)).toBeGreaterThan(-1)
  expect(source.indexOf(marker)).toBe(source.lastIndexOf(marker))
  const wrapper = `
    const hmrTestOriginalApply = module.exports.apply;
    const hmrTestKey = ${JSON.stringify(client.key)};
    module.exports.apply = (ctx, ...args) => {
      const dataset = document.documentElement.dataset;
      dataset[hmrTestKey + 'Applies'] = String(Number(dataset[hmrTestKey + 'Applies'] || 0) + 1);
      ctx.effect(() => async () => {
        if (dataset.hmrHold !== hmrTestKey) return;
        dataset.hmrDisposing = hmrTestKey;
        await new Promise(resolve => window.addEventListener('dsh-test-release-hmr', resolve, { once: true }));
        delete dataset.hmrDisposing;
      }, 'browser test: held HMR cleanup');
      return hmrTestOriginalApply(ctx, ...args);
    };
    return module.exports;`
  await writeFile(file, source.replace(marker, wrapper))
  return { ...client, file }
}

async function openSeededSession(page: Page): Promise<void> {
  // Workspace rows own aria-expanded directly; Session rows do not.
  const group = page.locator('[role="treeitem"][aria-expanded]').first()
  await group.waitFor({ state: 'visible', timeout: 20_000 })
  if (await group.getAttribute('aria-expanded') === 'false') await group.click()
  const row = page.getByRole('treeitem').filter({ has: page.getByText(SESSION_TITLE, { exact: true }) })
  await row.click({ timeout: 20_000 })
  await page.getByText('DONE', { exact: true }).waitFor({ timeout: 20_000 })
  await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor()
}

it('shows recovery during root and foundational Session teardown and remounts a usable app without navigation', async () => {
  const clients: Awaited<ReturnType<typeof instrumentClient>>[] = []
  for (const client of CLIENTS) clients.push(await instrumentClient(client))
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const host = scaffold.ctx.loader.ctx.fiber.uid
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  const sessionId = await seedSession(scaffold, await readFile(SESSION_SEED, 'utf8'), 'client-root-hmr-recovery')
  await workspace.attachSession(sessionId)
  await scaffold.ctx.sessionController.rename({ sessionId, title: SESSION_TITLE })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const previewPath = process.env.DSH_TEST_PREVIEW_PATH
  if (previewPath !== undefined) await page.emulateMedia({ colorScheme: 'dark' })
  const tripwire = watchConsole(page)
  const lifecycleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' && /RootOutlet|root.*(?:missing|unregistered)|Session reference.*released/i.test(message.text())) {
      lifecycleErrors.push(message.text())
    }
  })
  onTestFailed(() => saveFailureShot(page, 'web-e2e-root-hmr-recovery'))
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await openSeededSession(page)
  const originalDocument = await page.evaluateHandle(() => document)
  let navigations = 0
  page.on('framenavigated', () => { navigations++ })

  for (const client of clients) {
    expect(await realpath(scaffold.ctx.clientModules.clientPath(client.id)!)).toBe(client.file)
    const previousRevision = scaffold.ctx.clientModules.graph().entries.find(row => row.id === client.id)!.rev
    const previousApplies = await page.evaluate(key => Number(document.documentElement.dataset[key + 'Applies']), client.key)
    const oldRoot = await page.locator('[data-shell-bottom]').locator('..').elementHandle()
    expect(oldRoot).not.toBeNull()
    await page.evaluate((key) => { document.documentElement.dataset.hmrHold = key }, client.key)
    try {
      const currentStat = await stat(client.file)
      await utimes(client.file, currentStat.atime, new Date(currentStat.mtimeMs + 1_000))
      scaffold.ctx.clientModules.rebuilt(client.id)
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.hmrDisposing), { timeout: 20_000 }).toBe(client.key)
      await page.locator('[data-dsh-boot]').waitFor({ state: 'visible' })
      expect(await page.locator('[data-shell-bottom]').count()).toBe(0)
      expect(await oldRoot!.evaluate(element => element.isConnected)).toBe(false)
      expect(tripwire.pageErrors).toEqual([])
      expect(lifecycleErrors).toEqual([])
    } finally {
      await page.evaluate(() => {
        delete document.documentElement.dataset.hmrHold
        window.dispatchEvent(new Event('dsh-test-release-hmr'))
      })
    }
    await expect.poll(() => page.evaluate(key => Number(document.documentElement.dataset[key + 'Applies']), client.key), { timeout: 20_000 }).toBe(previousApplies + 1)
    await page.locator('[data-shell-bottom]').waitFor({ state: 'attached' })
    await expect.poll(() => page.locator('[data-dsh-boot]').count()).toBe(0)
    expect(scaffold.ctx.clientModules.graph().entries.find(row => row.id === client.id)!.rev).not.toBe(previousRevision)
    await openSeededSession(page)
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    await input.fill(`draft after ${client.key}`)
    expect(await input.innerText()).toBe(`draft after ${client.key}`)
    expect(await originalDocument.evaluate(original => original === document)).toBe(true)
    expect(scaffold.ctx.loader.ctx.fiber.uid).toBe(host)
    expect(navigations).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(lifecycleErrors).toEqual([])
  }
  if (previewPath !== undefined) {
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(true)
    await page.screenshot({ path: previewPath })
  }
}, 120_000)
