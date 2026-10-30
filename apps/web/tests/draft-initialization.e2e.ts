/** Unsubmitted drafts initialized through the shipped Workspace API and restored by the real Web profile. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import type { SessionId } from '@yharness/session'
import type { ClientModuleLoaderTarget } from '@yharness/client-modules/client'
import { formatSessionReferenceMention } from '@yharness/session-reference'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const SCREENSHOTS = fileURLToPath(new URL('../../../.artifacts/screenshots', import.meta.url))
const FILE_NAME = 'notes \u{96EA}.md'
const FILE_BODY = '# Draft reference preview\n\nUnsubmitted file reference: \u{96EA} 🧭.\n'
const SETTLE = { timeout: 20_000 }

// This Host-plane spec cannot import the Client program's Cordis declarations.
interface DraftSnapshot {
  text: string
  references: {
    offset: number
    length: number
    source: 'reference'
    ref: string
    label: string
    appearance: 'file' | 'folder' | 'session'
    clipboardText: string
    invalid?: boolean
  }[]
}

const EMPTY: DraftSnapshot = { text: '', references: [] }

interface DraftOptions {
  prompt?: string
  clearPreviousDraft?: boolean
}

interface DraftApiObservation {
  startSession?: (workspaceId: string | undefined, options: DraftOptions) => void
}

interface WorkspaceApplyContext {
  get(name: 'uiWorkspace'): { startSession: NonNullable<DraftApiObservation['startSession']> } | undefined
}

async function observeDraftApi(page: Page): Promise<void> {
  // Observe one shipped module's apply, using the page-owned loader interception from default-product-isolation.e2e.ts.
  await page.addInitScript(() => {
    const observation: DraftApiObservation = {}
    Reflect.set(globalThis, '__dshDraftApiObservation', observation)
    Object.defineProperty(globalThis, '__ModuleLoader__', {
      configurable: true,
      set(target: ClientModuleLoaderTarget) {
        Object.defineProperty(globalThis, '__ModuleLoader__', { configurable: true, writable: true, value: target })
        let load = target.load.bind(target)
        const observeLoad: ClientModuleLoaderTarget['load'] = (registration) => {
          if (registration.id !== '@yharness/client-ui-workspace' || registration.chunk !== undefined) {
            load(registration)
            return
          }
          load({
            ...registration,
            factory(require) {
              const exports = registration.factory(require)
              if (typeof exports.apply !== 'function') {
                throw new Error(`ui-workspace factory returned keys ${Object.keys(exports).join(',')}; apply is ${typeof exports.apply}`)
              }
              const originalApply = exports.apply as (ctx: WorkspaceApplyContext) => unknown
              return {
                ...exports,
                apply(ctx: WorkspaceApplyContext) {
                  const result = originalApply.call(exports, ctx)
                  observation.startSession = (workspaceId, options) => {
                    const workspace = ctx.get('uiWorkspace')
                    if (workspace === undefined) throw new Error('The shipped uiWorkspace service is unavailable')
                    workspace.startSession(workspaceId, options)
                  }
                  return result
                },
              }
            },
          })
        }
        // The facade replaces load when its pending registration queue becomes live.
        Object.defineProperty(target, 'load', {
          configurable: true,
          get: () => observeLoad,
          set(next: ClientModuleLoaderTarget['load']) { load = next.bind(target) },
        })
      },
    })
  })
}

async function startSession(page: Page, workspaceId: string | undefined, options: DraftOptions): Promise<void> {
  await page.evaluate(({ workspaceId, options }) => {
    const observation = Reflect.get(globalThis, '__dshDraftApiObservation') as DraftApiObservation | undefined
    if (observation?.startSession === undefined) throw new Error('The shipped Workspace apply has not been observed')
    observation.startSession(workspaceId, options)
  }, { workspaceId, options })
}

function composer(page: Page) {
  return page.locator('[data-composer-input][contenteditable="true"]').first()
}

function selectedSession(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('dsh.sessions.current')
    const value: unknown = raw === null ? null : JSON.parse(raw)
    return typeof value === 'object' && value !== null && 'sessionId' in value
      && typeof value.sessionId === 'string' ? value.sessionId : null
  })
}

function storedDraft(page: Page, sessionId: SessionId): Promise<unknown> {
  return page.evaluate((id) => {
    const raw = localStorage.getItem(`dsh.conversation.${id}`)
    const value: unknown = raw === null ? null : JSON.parse(raw)
    return typeof value === 'object' && value !== null && 'draft' in value ? value.draft : null
  }, sessionId)
}

async function writeStoredDrafts(page: Page, drafts: readonly { sessionId: SessionId; draft: string | DraftSnapshot }[]): Promise<void> {
  await page.evaluate((drafts) => {
    for (const { sessionId, draft } of drafts) {
      const key = `dsh.conversation.${sessionId}`
      const raw = localStorage.getItem(key)
      const saved: unknown = raw === null ? { view: null, viewRequest: null } : JSON.parse(raw)
      if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) {
        throw new Error(`Unexpected conversation record for ${sessionId}`)
      }
      localStorage.setItem(key, JSON.stringify({ ...saved, draft }))
    }
  }, drafts)
}

async function restoreStoredDrafts(page: Page, drafts: readonly { sessionId: SessionId; draft: string | DraftSnapshot }[]): Promise<void> {
  await writeStoredDrafts(page, drafts)
  await page.reload({ waitUntil: 'load' })
}

function editorSelection(page: Page) {
  return composer(page).evaluate((element) => {
    const selection = element.ownerDocument.getSelection()
    if (selection?.anchorNode === null || selection?.focusNode === null || selection === null
      || !element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) {
      throw new Error('The selection is outside the draft editor')
    }
    const offset = (node: Node, position: number): number => {
      const range = element.ownerDocument.createRange()
      range.selectNodeContents(element)
      range.setEnd(node, position)
      return range.toString().length
    }
    return {
      anchor: offset(selection.anchorNode, selection.anchorOffset),
      focus: offset(selection.focusNode, selection.focusOffset),
      text: selection.toString(),
    }
  })
}

async function assertDraft(page: Page, sessionId: SessionId, expected: DraftSnapshot, message = 'persisted draft'): Promise<void> {
  await expect.poll(() => selectedSession(page), SETTLE).toBe(sessionId)
  await composer(page).waitFor()
  await expect.poll(() => storedDraft(page, sessionId), { ...SETTLE, message }).toEqual(expected)
  const chips = composer(page).locator('[data-composer-chip]')
  await expect.poll(() => chips.allTextContents(), SETTLE).toEqual(expected.references.map(reference => reference.label))
  expect(await chips.evaluateAll(elements => elements.map(element => ({
    source: element.getAttribute('data-composer-chip'), editable: element.getAttribute('contenteditable'),
  })))).toEqual(expected.references.map(() => ({ source: 'reference', editable: 'false' })))
  let displayed = expected.text
  for (const reference of [...expected.references].reverse()) {
    displayed = displayed.slice(0, reference.offset) + reference.label
      + displayed.slice(reference.offset + reference.length)
  }
  await expect.poll(() => composer(page).evaluate(element =>
    [...element.children].map(paragraph => paragraph.textContent).join('\n')), SETTLE).toBe(displayed)
}

async function initialize(page: Page, prompt: string, workspaceId?: string, clearPreviousDraft = false) {
  await startSession(page, workspaceId, { prompt, clearPreviousDraft })
}

async function openWorkspaceSession(page: Page, workspace: { readonly title: string }, sessionId: SessionId) {
  const row = page.getByRole('tree', { name: 'Sessions' }).getByText(workspace.title, { exact: true })
    .locator('xpath=ancestor::*[@role="treeitem"][1]')
  await row.hover()
  await row.getByRole('button', { name: `New session in ${workspace.title}`, exact: true }).click()
  await expect.poll(() => selectedSession(page), SETTLE).toBe(sessionId)
}

async function assertUnsubmitted(scaffold: WebScaffold, ids: readonly SessionId[]): Promise<void> {
  expect(ids.length).toBeGreaterThan(0)
  await scaffold.ctx.sessionPersistence.flush()
  for (const id of ids) {
    const handle = await scaffold.ctx.sessionPersistence.open(id, 'read')
    try {
      const { events } = await handle.read()
      expect(events.filter(event => event.type === 'user/message' || event.type === 'turn/start'), id).toEqual([])
    } finally {
      await handle.close()
    }
  }
}

async function launchDraftFixture(beforeBrowserOpen?: (page: Page, scaffold: WebScaffold) => Promise<void>) {
  const scaffold = await launchWebScaffold()
  onTestFinished(() => scaffold.close())
  const first = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd, 'Draft origin')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const console = watchConsole(page)
  page.on('pageerror', (error) => { globalThis.console.error(error.stack ?? error.message) })
  await observeDraftApi(page)
  onTestFinished(async ({ task }) => {
    if (task.result?.state !== 'fail') return
    await mkdir(SCREENSHOTS, { recursive: true })
    const directory = await mkdtemp(join(SCREENSHOTS, 'draft-initialization-'))
    try {
      await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true })
    } catch (error: unknown) {
      // A closed browser must not replace the test's original failure.
      globalThis.console.warn('Draft initialization failure screenshot unavailable:', error)
    }
  })
  await beforeBrowserOpen?.(page, scaffold)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await expect.poll(() => page.evaluate(() => {
    const observation = Reflect.get(globalThis, '__dshDraftApiObservation') as DraftApiObservation | undefined
    return typeof observation?.startSession
  }), SETTLE).toBe('function')
  await composer(page).waitFor()
  await expect.poll(() => first.sessionIds.length, SETTLE).toBe(1)
  const firstId = first.sessionIds[0]!
  await expect.poll(() => selectedSession(page), SETTLE).toBe(firstId)
  const secondPath = await mkdtemp(join(scaffold.workspaceCwd, 'draft-target-'))
  const second = await scaffold.ctx.workspaceRegistry.create(secondPath, 'Draft target')
  await page.getByText('Draft target', { exact: true }).first().waitFor()
  expect(second.sessionIds).toEqual([])
  return { scaffold, page, console, first, firstId, second }
}

function structuredDraft(sessionId: SessionId, title: string): DraftSnapshot {
  const file = `@"${FILE_NAME}"`
  const folder = '@"\u{76EE}\u{5F55}/"'
  const session = formatSessionReferenceMention({ sessionId, label: '\u{5173}\u{8054}\u{4F1A}\u{8BDD} 🧩' })
  const references: DraftSnapshot['references'] = []
  let text = `${title} 🧭 e\u0301 \u{96EA}\n`
  for (let repeat = 0; repeat < 2; repeat++) {
    for (const item of [
      { ref: file, label: FILE_NAME, appearance: 'file' },
      { ref: folder, label: '\u{76EE}\u{5F55}/', appearance: 'folder' },
      { ref: session, label: '\u{5173}\u{8054}\u{4F1A}\u{8BDD} 🧩', appearance: 'session' },
    ] as const) {
      references.push({
        ...item, offset: text.length, length: item.ref.length,
        source: 'reference', clipboardText: item.ref,
      })
      text += `${item.ref} `
    }
    text += '\n'
  }
  // Equal mention text without a reference entry remains ordinary text.
  text += `\u{666E}\u{901A}\u{6587}\u{5B57} ${file}，\u{672B}\u{5C3E} 🦉`
  return { text, references }
}

it('preserves drafts through real New Session navigation and treats empty prompts according to clearPreviousDraft', async () => {
  const { scaffold, page, console, first, firstId, second } = await launchDraftFixture()
  const initial = { text: '\u{7EAF}\u{6587}\u{5B57} 🧭\n\u{7B2C}\u{4E8C}\u{884C} e\u0301', references: [] }
  await initialize(page, initial.text, second.id)
  await expect.poll(() => second.sessionIds.length, SETTLE).toBe(1)
  const secondId = second.sessionIds[0]!
  expect(secondId).not.toBe(firstId)
  await assertDraft(page, secondId, initial)

  await openWorkspaceSession(page, first, firstId)
  await openWorkspaceSession(page, second, secondId)
  await assertDraft(page, secondId, initial)
  await openWorkspaceSession(page, first, firstId)
  await initialize(page, '\u{5DF2}\u{6709}\u{8349}\u{7A3F}\u{4E0D}\u{80FD}\u{88AB}\u{8986}\u{76D6}', second.id)
  await assertDraft(page, secondId, initial)
  expect(second.sessionIds).toEqual([secondId])
  await openWorkspaceSession(page, first, firstId)
  await initialize(page, '', second.id, false)
  await assertDraft(page, secondId, initial)
  await initialize(page, '', undefined, true)
  await assertDraft(page, secondId, EMPTY)
  await openWorkspaceSession(page, first, firstId)
  await initialize(page, '', second.id, false)
  await assertDraft(page, secondId, EMPTY)
  const replacement = { text: '\u{663E}\u{5F0F}\u{66FF}\u{6362} 🧪', references: [] }
  await initialize(page, replacement.text, undefined, true)
  await assertDraft(page, secondId, replacement)
  expect(second.sessionIds).toEqual([secondId])

  await startSession(page, undefined, { clearPreviousDraft: true })
  await assertDraft(page, secondId, EMPTY)
  for (let round = 0; round < 2; round++) {
    await openWorkspaceSession(page, first, firstId)
    await openWorkspaceSession(page, second, secondId)
    await assertDraft(page, secondId, EMPTY)
  }
  await page.reload({ waitUntil: 'load' })
  await assertDraft(page, secondId, EMPTY)
  await assertUnsubmitted(scaffold, [firstId, secondId])
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('restores repeated file, folder and Session capsules across edits, Workspace switches and reload without submitting', async () => {
  const { scaffold, page, console, first, firstId, second } = await launchDraftFixture()
  for (const workspace of [first, second]) {
    await mkdir(join(workspace.path, '\u{76EE}\u{5F55}'))
    await writeFile(join(workspace.path, FILE_NAME), FILE_BODY)
  }
  await initialize(page, '', second.id)
  await expect.poll(() => second.sessionIds.length, SETTLE).toBe(1)
  const secondId = second.sessionIds[0]!
  await assertDraft(page, secondId, EMPTY)
  const firstDraft = structuredDraft(secondId, '\u{5DE5}\u{4F5C}\u{533A}\u{7532}')
  const secondDraft = structuredDraft(firstId, '\u{5DE5}\u{4F5C}\u{533A}\u{4E59}')
  await restoreStoredDrafts(page, [
    { sessionId: firstId, draft: firstDraft },
    { sessionId: secondId, draft: secondDraft },
  ])
  await assertDraft(page, secondId, secondDraft)
  expect(await composer(page).evaluate(element => ({
    paragraphs: [...element.children].map(paragraph => paragraph.textContent),
    capsules: [...element.querySelectorAll('[data-composer-chip]')].map(chip => ({
      source: chip.getAttribute('data-composer-chip'),
      editable: chip.getAttribute('contenteditable'),
      label: chip.textContent,
    })),
  }))).toMatchInlineSnapshot(`
    {
      "capsules": [
        {
          "editable": "false",
          "label": "notes \u{96EA}.md",
          "source": "reference",
        },
        {
          "editable": "false",
          "label": "\u{76EE}\u{5F55}/",
          "source": "reference",
        },
        {
          "editable": "false",
          "label": "\u{5173}\u{8054}\u{4F1A}\u{8BDD} 🧩",
          "source": "reference",
        },
        {
          "editable": "false",
          "label": "notes \u{96EA}.md",
          "source": "reference",
        },
        {
          "editable": "false",
          "label": "\u{76EE}\u{5F55}/",
          "source": "reference",
        },
        {
          "editable": "false",
          "label": "\u{5173}\u{8054}\u{4F1A}\u{8BDD} 🧩",
          "source": "reference",
        },
      ],
      "paragraphs": [
        "\u{5DE5}\u{4F5C}\u{533A}\u{4E59} 🧭 é \u{96EA}",
        "notes \u{96EA}.md \u{76EE}\u{5F55}/ \u{5173}\u{8054}\u{4F1A}\u{8BDD} 🧩 ",
        "notes \u{96EA}.md \u{76EE}\u{5F55}/ \u{5173}\u{8054}\u{4F1A}\u{8BDD} 🧩 ",
        "\u{666E}\u{901A}\u{6587}\u{5B57} @\"notes \u{96EA}.md\"，\u{672B}\u{5C3E} 🦉",
      ],
    }
  `)
  await openWorkspaceSession(page, first, firstId)
  await assertDraft(page, firstId, firstDraft)

  const drafts = [
    { id: firstId, workspace: first, draft: firstDraft },
    { id: secondId, workspace: second, draft: secondDraft },
  ]
  for (let round = 0; round < 3; round++) {
    for (const item of drafts) {
      await openWorkspaceSession(page, item.workspace, item.id)
      await assertDraft(page, item.id, item.draft)
      await composer(page).click()
      await page.keyboard.press('ControlOrMeta+End')
      const suffix = ` · \u{7F16}\u{8F91}${round} 🧪`
      await page.keyboard.insertText(suffix)
      item.draft = { ...item.draft, text: item.draft.text + suffix }
      await assertDraft(page, item.id, item.draft)
    }
  }
  await page.reload({ waitUntil: 'load' })
  await assertDraft(page, secondId, drafts[1]!.draft)
  for (const item of drafts) {
    await openWorkspaceSession(page, item.workspace, item.id)
    await assertDraft(page, item.id, item.draft)
  }
  await composer(page).locator('[data-composer-chip]').first().click()
  await expect.poll(() => page.locator('[data-document-markdown]').textContent(), SETTLE)
    .toContain('Unsubmitted file reference: \u{96EA} 🧭.')
  await assertDraft(page, secondId, drafts[1]!.draft)
  await startSession(page, undefined, { clearPreviousDraft: true })
  await assertDraft(page, secondId, EMPTY)
  for (let round = 0; round < 2; round++) {
    await openWorkspaceSession(page, first, firstId)
    await assertDraft(page, firstId, drafts[0]!.draft)
    await openWorkspaceSession(page, second, secondId)
    await assertDraft(page, secondId, EMPTY)
  }
  await page.reload({ waitUntil: 'load' })
  await assertDraft(page, secondId, EMPTY)
  expect(first.sessionIds).toEqual([firstId])
  expect(second.sessionIds).toEqual([secondId])
  await assertUnsubmitted(scaffold, [firstId, secondId])
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('reads a legacy string from the existing conversation key and saves ordinary edits as a structured draft', async () => {
  const { scaffold, page, console, firstId } = await launchDraftFixture()
  const legacy = '\u{65E7}\u{5B57}\u{7B26}\u{4E32}\u{8349}\u{7A3F} 🧭\n\u{666E}\u{901A} @notes，\u{4E0D}\u{662F}\u{80F6}\u{56CA}'
  await restoreStoredDrafts(page, [{ sessionId: firstId, draft: legacy }])
  await expect.poll(() => selectedSession(page), SETTLE).toBe(firstId)
  await composer(page).waitFor()
  await expect.poll(() => composer(page).evaluate(element =>
    [...element.children].map(paragraph => paragraph.textContent).join('\n')), SETTLE).toBe(legacy)
  expect(await composer(page).locator('[data-composer-chip]').count()).toBe(0)
  await composer(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('，\u{7EE7}\u{7EED}\u{7F16}\u{8F91}')
  await assertDraft(page, firstId, { text: `${legacy}，\u{7EE7}\u{7EED}\u{7F16}\u{8F91}`, references: [] })
  await assertUnsubmitted(scaffold, [firstId])
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('rematches the current draft after a delayed real skills catalog without replacing text, selection or undo history', async () => {
  const releaseCatalog = Promise.withResolvers<undefined>()
  let captured: { status: number; body: string; request: string | null } | undefined
  let catalogRequests = 0
  const { scaffold, page, console, firstId } = await launchDraftFixture(async (_page, scaffold) => {
    for (const name of ['draft-late-original', 'draft-late-current']) {
      const directory = join(scaffold.workspaceCwd, '.agents', 'skills', name)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'SKILL.md'), [
        '---', `name: ${name}`, `description: Draft catalog fixture ${name}`, '---',
        '', `# ${name}`, '', 'Keep the supplied draft unchanged.', '',
      ].join('\n'))
    }
    await writeFile(join(scaffold.workspaceCwd, FILE_NAME), FILE_BODY)
  })
  const file = `@"${FILE_NAME}"`
  const originalPrefix = '/draft-late-original\n'
  const currentPrefix = '/draft-late-current /draft-late-missing\n'
  const initial: DraftSnapshot = {
    text: `${originalPrefix}${file} abcdef`,
    references: [{
      offset: originalPrefix.length, length: file.length, source: 'reference', ref: file,
      label: FILE_NAME, appearance: 'file', clipboardText: file,
    }],
  }
  await writeStoredDrafts(page, [{ sessionId: firstId, draft: initial }])
  // Only the new document's catalog may wait on this gate; the preceding page has no held routes.
  await page.goto('about:blank', { waitUntil: 'load' })
  let intercepted = false
  await page.route(url => url.pathname === '/api/skills/list', async (route) => {
    catalogRequests++
    if (intercepted) {
      await route.continue()
      return
    }
    intercepted = true
    const response = await route.fetch()
    try {
      captured = { status: response.status(), body: await response.text(), request: route.request().postData() }
      await releaseCatalog.promise
      await route.fulfill({ response })
    } finally {
      await response.dispose()
    }
  })
  onTestFinished(async () => {
    releaseCatalog.resolve(undefined)
    await page.unrouteAll({ behavior: 'wait' })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await assertDraft(page, firstId, initial)
  expect(await composer(page).locator('[data-composer-text-ref]').count()).toBe(0)
  await composer(page).click()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('End')
  await expect.poll(() => captured?.request ?? '', SETTLE).toContain(firstId)
  expect(captured?.status).toBe(200)
  expect(captured?.body).toContain('draft-late-original')
  expect(captured?.body).toContain('draft-late-current')
  await page.keyboard.press('Escape')
  const chip = await composer(page).locator('[data-composer-chip]').elementHandle()
  if (chip === null) throw new Error('The initialized file capsule is missing')
  await composer(page).click()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('Shift+End')
  await page.keyboard.insertText(currentPrefix.trimEnd())
  const edited: DraftSnapshot = {
    text: `${currentPrefix}${file} abcdef`,
    references: [{ ...initial.references[0]!, offset: currentPrefix.length }],
  }
  await assertDraft(page, firstId, edited)
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  const selection = await editorSelection(page)
  expect(selection.text).toBe('cd')
  expect(catalogRequests).toBe(1)
  await expect.poll(() => composer(page).locator('[data-composer-text-ref]').allTextContents(), SETTLE)
    .toEqual([])

  const delivered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/skills/list')
  releaseCatalog.resolve(undefined)
  expect((await delivered).status()).toBe(200)
  await expect.poll(() => composer(page).locator('[data-composer-text-ref]').allTextContents(), SETTLE)
    .toEqual(['/draft-late-current'])
  await assertDraft(page, firstId, edited)
  expect(await editorSelection(page)).toEqual(selection)
  expect(await chip.evaluate(element => element.isConnected)).toBe(true)

  await page.keyboard.press('ControlOrMeta+z')
  await assertDraft(page, firstId, initial)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await assertDraft(page, firstId, edited)
  await assertUnsubmitted(scaffold, [firstId])
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('carries all reference capsules through the real Workspace picker and leaves the source draft empty', async () => {
  const { scaffold, page, console, first, firstId, second } = await launchDraftFixture()
  for (const workspace of [first, second]) {
    await mkdir(join(workspace.path, '\u{76EE}\u{5F55}'))
    await writeFile(join(workspace.path, FILE_NAME), FILE_BODY)
  }
  const draft = structuredDraft(firstId, '\u{5207}\u{6362}\u{5DE5}\u{4F5C}\u{533A}\u{643A}\u{5E26}')
  await restoreStoredDrafts(page, [{ sessionId: firstId, draft }])
  await assertDraft(page, firstId, draft)
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).click()
  await page.getByRole('menuitem', { name: second.title, exact: true }).click()
  await expect.poll(() => second.sessionIds.length, SETTLE).toBe(1)
  const secondId = second.sessionIds[0]!
  await assertDraft(page, secondId, draft)
  await expect.poll(() => storedDraft(page, firstId), SETTLE).toEqual(EMPTY)

  await openWorkspaceSession(page, first, firstId)
  await assertDraft(page, firstId, EMPTY)
  await openWorkspaceSession(page, second, secondId)
  await assertDraft(page, secondId, draft)
  await page.reload({ waitUntil: 'load' })
  await assertDraft(page, secondId, draft)
  await composer(page).locator('[data-composer-chip]').first().click()
  await expect.poll(() => page.locator('[data-document-markdown]').textContent(), SETTLE)
    .toContain('Unsubmitted file reference: \u{96EA} 🧭.')
  await assertUnsubmitted(scaffold, [firstId, secondId])
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it('applies a parameter transition matrix to one reusable target without changing another Workspace draft', async () => {
  const { scaffold, page, console, first, firstId, second } = await launchDraftFixture()
  const source = structuredDraft(firstId, '\u{6E90}\u{8349}\u{7A3F}\u{4FDD}\u{6301}\u{4E0D}\u{53D8}')
  const structured = structuredDraft(firstId, '\u{76EE}\u{6807}\u{7ED3}\u{6784}\u{8349}\u{7A3F}')
  const restored = structuredDraft(firstId, '\u{76EE}\u{6807}\u{6062}\u{590D}\u{8349}\u{7A3F}')
  const replacement = { text: '\u{76EE}\u{6807}\u{66FF}\u{6362}\u{6587}\u{5B57} 🧭', references: [] }
  const plain = { text: '\u{5DF2}\u{6709}\u{76EE}\u{6807}\u{6587}\u{5B57} 🧭', references: [] }
  const literalReferences = { text: structured.text, references: [] }
  await initialize(page, '', second.id, true)
  await expect.poll(() => second.sessionIds.length, SETTLE).toBe(1)
  const secondId = second.sessionIds[0]!
  await assertDraft(page, secondId, EMPTY)
  await restoreStoredDrafts(page, [
    { sessionId: firstId, draft: source },
    { sessionId: secondId, draft: structured },
  ])
  await assertDraft(page, secondId, structured)

  const transitions: {
    name: string
    target: 'explicit' | 'current'
    options: DraftOptions
    expected: DraftSnapshot
    restore?: DraftSnapshot
    reload?: boolean
  }[] = [
    { name: 'nonempty text preserves existing capsules', target: 'current', options: { prompt: 'ignored', clearPreviousDraft: false }, expected: structured },
    { name: 'empty text preserves existing capsules', target: 'explicit', options: { prompt: '', clearPreviousDraft: false }, expected: structured },
    { name: 'text replaces a nonempty structured draft', target: 'current', options: { prompt: plain.text, clearPreviousDraft: true }, expected: plain, reload: true },
    { name: 'nonempty text preserves existing text', target: 'explicit', options: { prompt: structured.text, clearPreviousDraft: false }, expected: plain },
    { name: 'empty text explicitly clears existing text', target: 'current', options: { prompt: '', clearPreviousDraft: true }, expected: EMPTY },
    { name: 'reference-like text fills an empty target without creating capsules', target: 'explicit', options: { prompt: structured.text, clearPreviousDraft: false }, expected: literalReferences },
    { name: 'nonempty text explicitly replaces existing text', target: 'current', options: { prompt: replacement.text, clearPreviousDraft: true }, expected: replacement, reload: true },
    { name: 'absent prompt and false clear preserve restored capsules', target: 'explicit', options: { clearPreviousDraft: false }, expected: restored, restore: restored },
    { name: 'empty text explicitly clears capsules', target: 'current', options: { prompt: '', clearPreviousDraft: true }, expected: EMPTY, reload: true },
  ]
  for (const transition of transitions) {
    if (transition.restore !== undefined) {
      await restoreStoredDrafts(page, [{ sessionId: secondId, draft: transition.restore }])
      await assertDraft(page, secondId, transition.restore)
    }
    if (transition.target === 'explicit') {
      await openWorkspaceSession(page, first, firstId)
      await assertDraft(page, firstId, source)
    }
    await startSession(page, transition.target === 'explicit' ? second.id : undefined, transition.options)
    await assertDraft(page, secondId, transition.expected, transition.name)
    expect(await storedDraft(page, firstId), transition.name).toEqual(source)
    expect(second.sessionIds, transition.name).toEqual([secondId])
    if (transition.reload) {
      await page.reload({ waitUntil: 'load' })
      await assertDraft(page, secondId, transition.expected, transition.name)
    }
  }
  await openWorkspaceSession(page, first, firstId)
  await assertDraft(page, firstId, source)
  await openWorkspaceSession(page, second, secondId)
  await assertDraft(page, secondId, EMPTY)
  await assertUnsubmitted(scaffold, [firstId, secondId])
  expect(console.pageErrors).toEqual([])
  expect(console.warnings).toEqual([])
})

it.each(['older-first', 'newer-first'] as const)(
  'initializes only the latest target when two real Session creations overlap (%s)', async (completionOrder) => {
    const { scaffold, page, console, first, firstId, second } = await launchDraftFixture()
    const thirdPath = await mkdtemp(join(scaffold.workspaceCwd, 'draft-latest-'))
    const third = await scaffold.ctx.workspaceRegistry.create(thirdPath, 'Draft latest')
    await page.getByText(third.title, { exact: true }).first().waitFor()
    const source = structuredDraft(firstId, '\u{4EA4}\u{9519}\u{8BF7}\u{6C42}\u{7684}\u{6E90}\u{8349}\u{7A3F}')
    const latest = { text: '\u{53EA}\u{6709}\u{6700}\u{540E}\u{76EE}\u{6807}\u{6536}\u{5230}\u{6587}\u{5B57}\u{8349}\u{7A3F} 🧭', references: [] }
    await restoreStoredDrafts(page, [{ sessionId: firstId, draft: source }])
    await assertDraft(page, firstId, source)

    interface HeldCreation {
      workspaceId: string
      release: ReturnType<typeof Promise.withResolvers<undefined>>
      response?: { status: number; body: string }
    }
    const older: HeldCreation = { workspaceId: second.id, release: Promise.withResolvers<undefined>() }
    const newer: HeldCreation = { workspaceId: third.id, release: Promise.withResolvers<undefined>() }
    await page.route(url => url.pathname === '/api/session/create', async (route) => {
      const request = route.request().postData() ?? ''
      const held = [older, newer].find(candidate => request.includes(candidate.workspaceId))
      if (held === undefined) {
        await route.continue()
        return
      }
      const response = await route.fetch()
      try {
        held.response = { status: response.status(), body: await response.text() }
        await held.release.promise
        await route.fulfill({ response })
      } finally {
        await response.dispose()
      }
    })
    onTestFinished(async () => {
      older.release.resolve(undefined)
      newer.release.resolve(undefined)
      await page.unrouteAll({ behavior: 'wait' })
    })
    const deliver = async (held: HeldCreation): Promise<void> => {
      const delivered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/create'
        && (response.request().postData() ?? '').includes(held.workspaceId))
      held.release.resolve(undefined)
      const response = await delivered
      expect(response.status()).toBe(200)
      await response.finished()
      // Observe rendered navigation after the received RPC body's promise callbacks.
      await page.evaluate(() => new Promise<undefined>(resolve => requestAnimationFrame(() => { resolve(undefined) })))
    }

    await startSession(page, second.id, { prompt: '\u{8FC7}\u{671F}\u{8BF7}\u{6C42}\u{4E0D}\u{5F97}\u{5199}\u{5165}\u{4EFB}\u{4F55}\u{8349}\u{7A3F}', clearPreviousDraft: true })
    await expect.poll(() => older.response?.status, SETTLE).toBe(200)
    await expect.poll(() => second.sessionIds.length, SETTLE).toBe(1)
    const secondId = second.sessionIds[0]!
    expect(older.response?.body).toContain(secondId)
    await assertDraft(page, firstId, source)
    await startSession(page, third.id, { prompt: latest.text, clearPreviousDraft: true })
    await expect.poll(() => newer.response?.status, SETTLE).toBe(200)
    await expect.poll(() => third.sessionIds.length, SETTLE).toBe(1)
    const thirdId = third.sessionIds[0]!
    expect(newer.response?.body).toContain(thirdId)
    await assertDraft(page, firstId, source)

    if (completionOrder === 'older-first') {
      await deliver(older)
      await assertDraft(page, firstId, source)
      expect(await storedDraft(page, secondId)).toBeNull()
      await deliver(newer)
    } else {
      await deliver(newer)
      await assertDraft(page, thirdId, latest)
      await deliver(older)
    }
    await assertDraft(page, thirdId, latest)
    expect(await storedDraft(page, secondId)).toBeNull()
    expect(await storedDraft(page, firstId)).toEqual(source)

    await openWorkspaceSession(page, second, secondId)
    await expect.poll(() => composer(page).textContent(), SETTLE).toBe('')
    expect(await composer(page).locator('[data-composer-chip]').count()).toBe(0)
    await openWorkspaceSession(page, third, thirdId)
    await assertDraft(page, thirdId, latest)
    await openWorkspaceSession(page, first, firstId)
    await assertDraft(page, firstId, source)
    await page.reload({ waitUntil: 'load' })
    await assertDraft(page, firstId, source)
    await openWorkspaceSession(page, third, thirdId)
    await assertDraft(page, thirdId, latest)
    await assertUnsubmitted(scaffold, [firstId, secondId, thirdId])
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  },
)
