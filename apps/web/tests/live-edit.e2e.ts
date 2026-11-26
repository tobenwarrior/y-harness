/** Standard preset tool, owner controls, and the running renderer's Live Edit lifecycle. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ToolCallId } from '@yharness/llm'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, seedSession } from './scaffold.ts'
import { writeComposerDraft } from './support.ts'

it.each(['no-preference', 'reduce'] as const)('previews, undoes, and keeps a chat-requested edit with motion set to %s', async (reducedMotion) => {
  const scaffold = await launchWebScaffold({})
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const signal = new AbortController().signal
    const fixture = new URL('../../../snapshots/web/fresh-round-trip/session.v2.jsonl', import.meta.url)
    const sessionId = await seedSession(scaffold, await readFile(fixture, 'utf8'), 'live-edit-web-e2e', 'standard')
    await workspace.attachSession(sessionId)
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ locale: 'en-US', reducedMotion, viewport: { width: 1280, height: 820 } })
      page.setDefaultTimeout(15_000)
      await page.goto(scaffold.authenticatedUrl)
      const composer = page.locator('[data-composer-input][contenteditable="true"]').first()
      const skillButton = page.locator('[data-yh-live-target="sidebar-panel-skills"]:not([data-yh-live-edit-exit])')
      await skillButton.waitFor({ timeout: 15_000 })
      const workspaceRow = page.locator(`[data-row-key="workspace:${workspace.id}"]`)
      if (await workspaceRow.getAttribute('aria-expanded') === 'false') await workspaceRow.click()
      await page.locator(`[data-row-key="session:${sessionId}"]`).click()
      await writeComposerDraft(page, composer, 'Keep this unsent draft')
      await expect.poll(() => scaffold.ctx.agents.get(sessionId)).toBeDefined()
      const agent = scaffold.ctx.agents.get(sessionId)
      if (agent === undefined) throw new Error('The Standard session did not register its agent')
      expect(scaffold.ctx.tools.get('live_edit_ui', agent)).toBeDefined()
      let navigations = 0
      page.on('framenavigated', () => { navigations++ })
      const note = page.getByText('Release checklist', { exact: true })
      const undo = page.getByRole('button', { name: 'Undo', exact: true })
      const preview = async (callId: string): Promise<void> => {
        const result = await scaffold.ctx.tools.execute({
          name: 'live_edit_ui', agent, signal,
          callId: ToolCallId(callId),
          arguments: { action: 'preview', patch: {
            title: 'Simplify the sidebar',
            operations: [
              { kind: 'hide', target: 'sidebar-panel-skills' },
              { kind: 'add', target: 'sidebar-brand', id: 'release-note', position: 'after', title: 'Release checklist' },
            ],
          } },
        })
        expect(result.isError, JSON.stringify(result.content)).toBe(false)
        await note.waitFor()
        await skillButton.waitFor({ state: 'hidden' })
      }

      await preview('live-edit-review')
      expect(await composer.textContent()).toBe('Keep this unsent draft')
      await undo.click()
      await note.waitFor({ state: 'hidden' })
      await skillButton.waitFor()
      expect(await composer.textContent()).toBe('Keep this unsent draft')

      await preview('live-edit-keep')
      await page.getByRole('button', { name: 'Keep', exact: true }).click()
      const file = join(scaffold.ctx.profileContext.dir, 'live-ui.json')
      await expect.poll(() => readFile(file, 'utf8').catch(() => '')).toContain('Release checklist')
      expect(await composer.textContent()).toBe('Keep this unsent draft')
      expect(navigations).toBe(0)
      await page.reload()
      await note.waitFor()
      await skillButton.waitFor({ state: 'hidden' })
      await undo.click()
      await note.waitFor({ state: 'hidden' })
      await skillButton.waitFor()
    } finally { await browser.close() }
  } finally { await scaffold.close() }
})
