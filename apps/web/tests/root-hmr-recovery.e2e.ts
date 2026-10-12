/** Built client root and Session-service replacement through the real Host HMR transport. */
import { mkdir, readFile, realpath, stat, utimes, writeFile } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
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

async function openSeededSession(page: Page, workspaceId: string, sessionId: string, workspaceTitle: string): Promise<void> {
  const rowKey = `workspace:${workspaceId}`
  const group = page.locator(`[data-row-key="${rowKey}"][role="treeitem"]`)
  await group.waitFor({ state: 'visible', timeout: 20_000 })
  expect(await group.getByText(workspaceTitle, { exact: true }).count()).toBe(1)
  // Startup may auto-expand after the initial state sample but before a delivered click.
  // Observe this exact real header; preserve a bounded trace without changing its state.
  await page.evaluate((key) => {
    type Event = { time: number; kind: string; oldValue?: string | null | undefined; expanded: string | null }
    const observed = globalThis as typeof globalThis & { __rootHmrExpansion?: { rowKey: string; events: Event[] } }
    if (observed.__rootHmrExpansion !== undefined) return
    const trace: { rowKey: string; events: Event[] } = { rowKey: key, events: [] }
    observed.__rootHmrExpansion = trace
    const record = (kind: string, element: Element, oldValue?: string | null) => {
      if (trace.events.length < 100) trace.events.push({ time: performance.now(), kind, oldValue, expanded: element.getAttribute('aria-expanded') })
    }
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const element = mutation.target as Element
        if (element.getAttribute('data-row-key') === key) record('mutation', element, mutation.oldValue)
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['aria-expanded'], attributeOldValue: true })
    for (const kind of ['pointerdown', 'click']) document.addEventListener(kind, (event) => {
      const element = (event.target as Element | null)?.closest('[data-row-key]')
      if (element?.getAttribute('data-row-key') === key) record(kind, element)
    }, { capture: true })
  }, rowKey)
  await expect.poll(async () => {
    const expanded = await group.evaluate((element) => {
      type Trace = { events: { time: number; kind: string; expanded: string | null }[] }
      const observed = globalThis as typeof globalThis & { __rootHmrExpansion?: Trace }
      const expanded = element.getAttribute('aria-expanded')
      const trace = observed.__rootHmrExpansion
      if (trace !== undefined && trace.events.length < 100) trace.events.push({ time: performance.now(), kind: 'sample', expanded })
      return expanded
    })
    if (expanded === 'false') await group.click({ timeout: 5_000 })
    return group.getAttribute('aria-expanded')
  }, { timeout: 20_000 }).toBe('true')
  const row = page.locator(`[data-row-key="session:${sessionId}"][role="treeitem"]`)
  await row.waitFor({ state: 'visible', timeout: 20_000 })
  expect(await row.getByText(SESSION_TITLE, { exact: true }).count()).toBe(1)
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
  expect(scaffold.ctx.sessions.get(sessionId)?.id).toBe(sessionId)
  // Materialize the renamed live Session's public projection baseline before the sidebar list reads cached cells.
  const signal = new AbortController().signal
  const projection = await scaffold.ctx.sessionController.projections({ sessionId }, signal)
  expect(projection?.values.title).toBe(SESSION_TITLE)
  expect(projection?.values.sessionListMetadata?.blank).toBe(false)
  const listed = (await scaffold.ctx.sessionController.list({}, signal)).items.find(row => row.sessionId === sessionId)
  expect(listed).toMatchObject({ sessionId, cwd: scaffold.workspaceCwd, blank: false })
  expect(listed?.projections?.values.title).toBe(SESSION_TITLE)
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
  // Finished hooks unwind in reverse order; capture failure before browser/Host cleanup closes the page.
  onTestFinished(async ({ task }) => {
    const trace = await page.evaluate(() => (globalThis as typeof globalThis & { __rootHmrExpansion?: unknown }).__rootHmrExpansion)
      .catch((error: unknown) => ({ captureError: error instanceof Error ? error.message : String(error) }))
    await mkdir(join(REPO_ROOT, '.artifacts'), { recursive: true })
    await writeFile(join(REPO_ROOT, '.artifacts', 'root-hmr-expansion-trace.json'), JSON.stringify(trace ?? null, null, 2) + '\n')
    if (task.result?.state === 'fail') await saveFailureShot(page, 'web-e2e-root-hmr-recovery')
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await openSeededSession(page, workspace.id, sessionId, basename(scaffold.workspaceCwd))
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
    await openSeededSession(page, workspace.id, sessionId, basename(scaffold.workspaceCwd))
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
