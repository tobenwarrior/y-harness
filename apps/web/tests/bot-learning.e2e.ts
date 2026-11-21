// Shared context authorship through the assembled owner and collaborator views.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import type {} from '@yharness/bots'
import { launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/bot-workspace/session.v3.jsonl', import.meta.url))
const SHOTS = fileURLToPath(new URL('../../../.artifacts/screenshots/bot-learning', import.meta.url))
const BOT = 'Launch Desk'
const NOTE = 'Share the launch checklist in the weekly brief.'

async function openSharedBots(page: Page, action: 'owner' | 'join') {
  await page.getByRole('button', { name: 'Bots', exact: true }).click()
  await page.getByRole('button', { name: 'Bot workspace options' }).click()
  await page.getByRole('menuitem', { name: action === 'owner' ? 'Create a shared group' : 'Join a shared bot' }).click()
  const dialog = page.getByRole('dialog', { name: 'Shared with you' })
  await dialog.waitFor()
  return dialog
}

describe.skipIf(webSnapshotMode() === 'record')('web e2e: shared Bot learning', () => {
  it('queues a collaborator note and shares it only after the owner approves it', async () => {
    const scaffold = await launchWebScaffold({ replayFixture: FIXTURE, replayProvidersOnly: true, profile: { hmr: false, packages: [] } })
    try {
      const browser = await chromium.launch()
      try {
        const owner = await newEnglishPage(browser)
        await owner.goto(scaffold.authenticatedUrl)
        await owner.waitForSelector('[class*="frame"]')
        const memberContext = await browser.newContext({
          storageState: await owner.context().storageState(), locale: 'en-US', viewport: { width: 480, height: 900 },
        })
        const member = await memberContext.newPage()
        await member.goto(scaffold.baseUrl)
        await member.waitForSelector('[class*="frame"]')
        const { bot } = await scaffold.ctx.bots.create({ name: BOT, identity: 'agent', accent: 'teal', cwd: scaffold.workspaceCwd })
        const ownerDialog = await openSharedBots(owner, 'owner')
        await ownerDialog.getByRole('button', { name: /^Launch Desk/ }).waitFor()
        await scaffold.ctx.bots.setShareMemoryPolicy({ botId: bot.id, enabled: true })
        const invite = await scaffold.ctx.bots.createShareInvite({ botId: bot.id, role: 'collaborator' })

        const memberDialog = await openSharedBots(member, 'join')
        await memberDialog.getByRole('textbox', { name: 'Invite code' }).fill(invite.code)
        const approvalInbox = member.waitForResponse(response => new URL(response.url()).pathname === '/shared-bots/bots/share/list-approvals')
        await memberDialog.getByRole('button', { name: 'Join bot' }).click()
        const memberRow = memberDialog.getByRole('button', { name: /^Launch Desk/ })
        await memberRow.waitFor()
        const approvals = await approvalInbox
        expect(approvals.status()).toBe(200)
        expect(await approvals.json()).toMatchObject({ result: { ok: true } })
        await memberDialog.getByRole('textbox', { name: 'Add a note for the shared context' }).fill(NOTE)
        await memberDialog.getByRole('button', { name: 'Suggest', exact: true }).click()
        const confirm = member.getByRole('dialog', { name: 'Suggest a note for this Bot?' })
        await confirm.getByRole('checkbox').check()
        await confirm.getByRole('button', { name: 'Suggest', exact: true }).click()
        await memberDialog.getByText('Sent for review.').waitFor()
        expect(await memberDialog.getByText(NOTE, { exact: true }).count()).toBe(0)
        expect(await memberDialog.getByRole('button', { name: 'Review suggestions' }).count()).toBe(0)
        await mkdir(SHOTS, { recursive: true })
        await member.screenshot({ path: join(SHOTS, 'collaborator-480.png') })

        await ownerDialog.getByRole('button', { name: /^Launch Desk/ }).click()
        await ownerDialog.getByRole('button', { name: 'Review suggestions' }).click()
        await ownerDialog.getByText(NOTE, { exact: true }).waitFor()
        await owner.emulateMedia({ colorScheme: 'dark' })
        await owner.screenshot({ path: join(SHOTS, 'owner-desktop-dark.png') })
        await owner.setViewportSize({ width: 480, height: 900 })
        await owner.emulateMedia({ colorScheme: 'light' })
        const roster = await ownerDialog.getByRole('button', { name: /^Launch Desk/ }).boundingBox()
        const conversation = await ownerDialog.getByRole('region', { name: BOT }).boundingBox()
        const message = await ownerDialog.getByRole('textbox', { name: 'Message this shared bot' }).boundingBox()
        const send = await ownerDialog.getByRole('button', { name: 'Send message', exact: true }).boundingBox()
        if (roster === null || conversation === null || message === null || send === null) throw new Error('shared Bot controls did not lay out')
        expect(roster.y + roster.height).toBeLessThan(conversation.y)
        expect(Math.abs(message.y + message.height / 2 - send.y - send.height / 2)).toBeLessThan(4)
        expect(message.x + message.width).toBeLessThan(send.x)
        await owner.screenshot({ path: join(SHOTS, 'owner-narrow-light.png') })
        await ownerDialog.getByRole('button', { name: 'Approve', exact: true }).click()
        await ownerDialog.getByText('No suggestions to review.').waitFor()
        await memberRow.click()
        await memberDialog.getByText(NOTE, { exact: true }).waitFor()
      } finally {
        await browser.close()
      }
    } finally {
      await scaffold.close()
    }
  }, 120_000)
})
