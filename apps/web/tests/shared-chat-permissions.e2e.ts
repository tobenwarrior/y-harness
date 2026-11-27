/** A permission change in one client applies to private chats open in other windows. */
import { readFile } from 'node:fs/promises'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, seedSession } from './scaffold.ts'

it('uses the approved shared mode in both open chats', async () => {
  const scaffold = await launchWebScaffold({})
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const fixture = await readFile(new URL('../../../snapshots/web/fresh-round-trip/session.v2.jsonl', import.meta.url), 'utf8')
    const firstId = await seedSession(scaffold, fixture, 'session-shared-permissions-first', 'standard')
    const secondId = await seedSession(scaffold, fixture, 'session-shared-permissions-second', 'standard')
    await workspace.attachSession(firstId)
    await workspace.attachSession(secondId)
    const browser = await chromium.launch()
    try {
      const context = await browser.newContext({ locale: 'en-US' })
      const openChat = async (id: string): Promise<Page> => {
        const page = await context.newPage()
        page.setDefaultTimeout(15_000)
        await page.goto(scaffold.authenticatedUrl)
        const group = page.locator(`[data-row-key="workspace:${workspace.id}"]`)
        if (await group.getAttribute('aria-expanded') === 'false') await group.click()
        await page.locator(`[data-row-key="session:${id}"]`).click()
        await expect.poll(() => scaffold.ctx.agents.list().some(agent => agent.id === id)).toBe(true)
        return page
      }
      const firstPage = await openChat(firstId)
      const secondPage = await openChat(secondId)
      const first = scaffold.ctx.agents.get(firstId)?.session
      const second = scaffold.ctx.agents.get(secondId)?.session
      if (first === undefined || second === undefined) throw new Error('Both private chats must be open')
      scaffold.ctx.permissionPresets.set(first, 'approve-for-me')
      scaffold.ctx.permissionPresets.set(second, 'danger-full-access')
      await secondPage.getByRole('button', { name: 'Access mode, current: Full access' }).waitFor()
      await scaffold.ctx.settings.update('permission', { sharedPreset: 'approve-for-me' })
      await secondPage.getByRole('button', { name: 'Access mode, current: Approve for me' }).waitFor()
      await firstPage.getByRole('button', { name: 'Access mode, current: Approve for me' }).click()
      await firstPage.getByRole('menuitem', { name: /Ask for approval/u }).click()

      for (const page of [firstPage, secondPage]) {
        await page.getByRole('button', { name: 'Access mode, current: Ask for approval' }).waitFor()
      }
      expect(scaffold.ctx.permissionPresets.catalog().sharedPreset).toBe('workspace-write')
      for (const session of [first, second]) {
        expect(scaffold.ctx.sandboxPolicy.resolve({ session }).mode).toBe('workspace-write')
        expect(session.snapshotEvents().findLast(event => event.type === 'approval/policy')?.data.policy).toBe('ask')
      }
    } finally { await browser.close() }
  } finally { await scaffold.close() }
})
