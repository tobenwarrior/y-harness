// Keyless assembled-Web coverage for shared group creation and isolated delivery.
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@yharness/llm'
import { LlmAdapter } from '@yharness/llm'
// Type-only: makes the Bot service contribution visible on the assembled Host context.
import type { BotView } from '@yharness/bots'
import type {} from '@yharness/bots'
import {
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/bot-workspace', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v3.jsonl')
const MODE = webSnapshotMode()
const PROVIDER = 'bot-group-browser-test'
const MODEL = 'reply'
const USER_MESSAGE = 'Discuss the release readiness.'
const REPLY = 'Group reply from the fixture adapter.'
const PRIVATE_SCOUT_PERSONA = 'PRIVATE_SCOUT_PERSONA'
const PRIVATE_ORBIT_PERSONA = 'PRIVATE_ORBIT_PERSONA'
const SHARED_GROUP_NAME = 'Release room shared'
const OWNER_SHARED_MESSAGE = 'Owner shared readiness note.'
const COLLABORATOR_SHARED_MESSAGE = 'Collaborator shared follow-up.'
const OWNER_ATTACHMENT_MESSAGE = 'Owner shared release attachment.'
const SHARED_ATTACHMENT_NAME = 'release-notes.txt'
const SHARED_ATTACHMENT_BODY = 'shared attachment payload\n'

/** Deterministic model response for the two shared-group recipients. */
class GroupReplyAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async listModels(provider: string) {
    return [{ provider, id: MODEL, name: `${provider}/${MODEL}` }]
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe.skipIf(MODE === 'record')('web e2e: shared Bot group workspace', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let collaboratorContext: BrowserContext | undefined
  let collaboratorPage: Page | undefined
  let tripwire: ReturnType<typeof watchConsole>
  let firstBot!: BotView
  let secondBot!: BotView
  let retainedWorkspaceCwd: string | undefined
  let retainedPersistenceRoot: string | undefined
  const adapter = new GroupReplyAdapter()

  beforeAll(async () => {
    // The model route is deterministic and local to this scaffold. The fixture
    // supplies only the header/catalog surface; no network model request is made.
    retainedWorkspaceCwd = await mkdtemp(join(tmpdir(), 'dsh-web-e2e-shared-owner-ws-'))
    retainedPersistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-web-e2e-shared-owner-sessions-'))
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE,
      replayProvidersOnly: true,
      profile: { hmr: false, packages: [] },
      workspaceCwd: retainedWorkspaceCwd,
      persistenceRoot: retainedPersistenceRoot,
    })
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter),
      'shared group browser fixture adapter',
    )
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
    firstBot = (await scaffold.ctx.bots.create({
      name: 'Scout',
      identity: 'browse',
      accent: 'teal',
      description: 'Public research role',
      persona: PRIVATE_SCOUT_PERSONA,
      capabilities: ['private.scout'],
      cwd: scaffold.workspaceCwd,
    })).bot
    secondBot = (await scaffold.ctx.bots.create({
      name: 'Orbit',
      identity: 'goal',
      accent: 'amber',
      description: 'Public planning role',
      persona: PRIVATE_ORBIT_PERSONA,
      capabilities: ['private.orbit'],
      cwd: scaffold.workspaceCwd,
    })).bot
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    if (collaboratorContext !== undefined) {
      await collaboratorContext.close().catch((error: unknown) => failures.push(error))
    }
    if (browser !== undefined) {
      await browser.close().catch((error: unknown) => failures.push(error))
    }
    if (scaffold !== undefined) {
      await scaffold.close().catch((error: unknown) => failures.push(error))
    }
    if (retainedWorkspaceCwd !== undefined) {
      await rm(retainedWorkspaceCwd, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    }
    if (retainedPersistenceRoot !== undefined) {
      await rm(retainedPersistenceRoot, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    }
    if (failures.length > 0) throw new AggregateError(failures, 'shared-owner browser test teardown failed')
  })

  it('creates an operator-local Bot group and keeps its private profile local to model input', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bot-group'))
    const sidebar = page.locator('[data-yh-part="sidebar"]')
    const botsMode = sidebar.getByRole('button', { name: 'Bots', exact: true })
    await botsMode.click()
    await expect.poll(() => botsMode.getAttribute('aria-pressed')).toBe('true')

    const roster = sidebar.locator('aside[aria-label="Bot workspace"]')
    await roster.waitFor({ state: 'visible', timeout: 15_000 })
    await roster.getByRole('button', { name: 'New bot group', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Create a bot group', exact: true })
    await dialog.getByLabel('Group name', { exact: true }).fill('Release room')
    await dialog.getByRole('checkbox', { name: firstBot.name, exact: true }).check()
    await dialog.getByRole('checkbox', { name: secondBot.name, exact: true }).check()
    await dialog.getByRole('button', { name: 'Create group', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })

    await expect.poll(async () => {
      const groups = await scaffold.ctx.bots.listGroups({})
      return groups.groups.some(group => group.name === 'Release room')
    }).toBe(true)

    const groupRow = roster.getByRole('button', { name: 'Release room, 2 Bots', exact: true })
    await groupRow.waitFor({ state: 'visible', timeout: 15_000 })
    await groupRow.click()
    const detail = page.locator('section[aria-label="Release room"]')
    await detail.waitFor({ state: 'visible', timeout: 15_000 })
    const composer = detail.getByRole('textbox', { name: 'Message Release room', exact: true })
    await composer.fill(USER_MESSAGE)
    await detail.getByRole('button', { name: 'Send message', exact: true }).click()

    await expect.poll(() => adapter.requests.length, { timeout: 30_000 }).toBe(2)
    await expect.poll(() => detail.getByText(USER_MESSAGE, { exact: true }).count(), { timeout: 30_000 }).toBe(1)
    await expect.poll(() => detail.getByText(REPLY, { exact: true }).count(), { timeout: 30_000 }).toBe(2)
    await expect.poll(() => detail.getByText(firstBot.name, { exact: true }).count()).toBeGreaterThan(0)
    await expect.poll(() => detail.getByText(secondBot.name, { exact: true }).count()).toBeGreaterThan(0)

    const visibleText = await detail.textContent()
    expect(visibleText).not.toContain(PRIVATE_SCOUT_PERSONA)
    expect(visibleText).not.toContain(PRIVATE_ORBIT_PERSONA)
    const requestText = JSON.stringify(adapter.requests)
    expect(requestText).toContain(USER_MESSAGE)
    // The owner workspace's "Create a shared group" action is the ordinary
    // BotGroupService path. It is shared between the operator's own Bots, not
    // the collaborator-only /shared-bots route covered below.
    expect(requestText).toContain(PRIVATE_SCOUT_PERSONA)
    expect(requestText).toContain(PRIVATE_ORBIT_PERSONA)
    expect(requestText).toContain('private.scout')
    expect(requestText).toContain('private.orbit')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it('sends through one isolated shared group for its owner and collaborator, then reuses the owner after restart', async () => {
    onTestFailed(() => page.isClosed() ? undefined : saveFailureShot(page, 'web-e2e-shared-bot-group'))
    adapter.requests.splice(0)

    // Clone only the operator session before either browser receives a shared
    // HttpOnly cookie. Each context then gets an independent shared principal.
    collaboratorContext = await browser.newContext({
      storageState: await page.context().storageState(),
      viewport: { width: 1680, height: 1000 },
      locale: 'en-US',
      timezoneId: 'Asia/Shanghai',
    })
    collaboratorPage = await collaboratorContext.newPage()
    await collaboratorPage.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await collaboratorPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await expect.poll(async () => {
      const bots = (await scaffold.ctx.bots.list({})).bots
      return bots.filter(bot => bot.id === firstBot.id || bot.id === secondBot.id).every(bot => bot.state === 'active')
    }, { timeout: 30_000 }).toBe(true)

    const openSharedDialog = async (target: Page): Promise<import('playwright').Locator> => {
      await target.getByRole('button', { name: 'Bots', exact: true }).click()
      const join = target.getByRole('button', { name: 'Join a shared bot', exact: true })
      await join.click()
      const dialog = target.getByRole('dialog', { name: 'Shared with you', exact: true })
      await dialog.waitFor({ state: 'visible', timeout: 15_000 })
      await dialog.getByRole('textbox', { name: 'Invite code', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
      await expect.poll(() => dialog.getByRole('status').count(), { timeout: 30_000 }).toBe(0)
      await dialog.getByRole('alert').waitFor({ state: 'visible', timeout: 30_000 })
      return dialog
    }

    const openOwnerDialog = async (): Promise<import('playwright').Locator> => {
      await page.getByRole('button', { name: 'Bots', exact: true }).click()
      await page.getByRole('button', { name: 'Create a shared group', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Shared with you', exact: true })
      await dialog.waitFor({ state: 'visible', timeout: 15_000 })
      // The owner bootstrap status is transient. The Bot buttons are the
      // durable readiness signal needed by the next create/invite actions.
      await dialog.getByRole('button', { name: new RegExp(`^${firstBot.name}\\b`) }).waitFor({ state: 'visible', timeout: 30_000 })
      await dialog.getByRole('button', { name: new RegExp(`^${secondBot.name}\\b`) }).waitFor({ state: 'visible', timeout: 30_000 })
      return dialog
    }

    const redeemInvite = async (dialog: import('playwright').Locator, code: string): Promise<void> => {
      const input = dialog.getByRole('textbox', { name: 'Invite code', exact: true })
      const join = dialog.getByRole('button', { name: 'Join bot', exact: true })
      await input.fill(code)
      await join.click()
      await expect.poll(() => input.inputValue(), { timeout: 30_000 }).toBe('')
    }

    const ownerDialog = await openOwnerDialog()

    const collaboratorChiefInvite = await scaffold.ctx.bots.createShareInvite({ botId: firstBot.id, role: 'collaborator' })
    const collaboratorOrbitInvite = await scaffold.ctx.bots.createShareInvite({ botId: secondBot.id, role: 'collaborator' })

    const createSharedGroupButton = ownerDialog.locator('section[aria-labelledby="yharness-shared-groups-heading"]')
      .getByRole('button', { name: 'Create shared group', exact: true })
    await expect.poll(() => createSharedGroupButton.isEnabled(), { timeout: 30_000 }).toBe(true)
    await createSharedGroupButton.click()
    const createSharedGroupDialog = page.getByRole('dialog', { name: 'Create a shared group', exact: true })
    await createSharedGroupDialog.getByLabel('Group name', { exact: true }).fill(SHARED_GROUP_NAME)
    await createSharedGroupDialog.getByRole('checkbox', { name: firstBot.name, exact: true }).check()
    await createSharedGroupDialog.getByRole('checkbox', { name: secondBot.name, exact: true }).check()
    await createSharedGroupDialog.getByRole('button', { name: 'Create shared group', exact: true }).click()
    await createSharedGroupDialog.waitFor({ state: 'hidden' })

    const ownerGroupRow = ownerDialog.getByRole('button', { name: new RegExp(`^${SHARED_GROUP_NAME}`) })
    await ownerGroupRow.waitFor({ state: 'visible', timeout: 30_000 })
    await ownerGroupRow.click()
    const ownerGroupSection = ownerDialog.locator(`section[aria-label="${SHARED_GROUP_NAME}"]`)
    await ownerGroupSection.waitFor({ state: 'visible', timeout: 30_000 })
    await ownerGroupSection.getByRole('button', { name: 'Invite people', exact: true }).click()
    const groupInviteCode = ownerGroupSection.locator('code[aria-label="Group invite code"]')
    await groupInviteCode.waitFor({ state: 'visible', timeout: 30_000 })
    const groupInvite = await groupInviteCode.textContent()
    if (groupInvite === null || groupInvite.trim() === '') throw new Error('shared group UI did not render an invite code')

    const collaboratorDialog = await openSharedDialog(collaboratorPage)
    await redeemInvite(collaboratorDialog, collaboratorChiefInvite.code)
    await collaboratorDialog.getByRole('button', { name: new RegExp(`^${firstBot.name}\\b`) }).waitFor({ state: 'visible', timeout: 30_000 })
    await redeemInvite(collaboratorDialog, collaboratorOrbitInvite.code)
    await collaboratorDialog.getByRole('button', { name: new RegExp(`^${secondBot.name}\\b`) }).waitFor({ state: 'visible', timeout: 30_000 })
    await redeemInvite(collaboratorDialog, groupInvite)
    const collaboratorGroupRow = collaboratorDialog.getByRole('button', { name: new RegExp(`^${SHARED_GROUP_NAME}`) })
    await collaboratorGroupRow.waitFor({ state: 'visible', timeout: 30_000 })
    await collaboratorGroupRow.click()
    const collaboratorGroupSection = collaboratorDialog.locator(`section[aria-label="${SHARED_GROUP_NAME}"]`)
    await collaboratorGroupSection.waitFor({ state: 'visible', timeout: 30_000 })

    const ownerComposer = ownerGroupSection.getByRole('textbox', { name: 'Message Release room shared', exact: true })
    await ownerComposer.fill(OWNER_SHARED_MESSAGE)
    await ownerDialog.getByRole('button', { name: 'Send to group', exact: true }).click()
    await expect.poll(() => adapter.requests.length, { timeout: 30_000 }).toBe(2)
    const ownerTranscriptRows = ownerGroupSection.locator('p')
    await expect.poll(() => ownerTranscriptRows.filter({ hasText: OWNER_SHARED_MESSAGE }).count(), { timeout: 30_000 }).toBe(1)
    await expect.poll(() => ownerTranscriptRows.filter({ hasText: REPLY }).count(), { timeout: 30_000 }).toBe(2)

    const collaboratorComposer = collaboratorGroupSection.getByRole('textbox', { name: 'Message Release room shared', exact: true })
    await collaboratorComposer.fill(COLLABORATOR_SHARED_MESSAGE)
    await collaboratorDialog.getByRole('button', { name: 'Send to group', exact: true }).click()
    await expect.poll(() => adapter.requests.length, { timeout: 30_000 }).toBe(4)
    const collaboratorTranscriptRows = collaboratorGroupSection.locator('p')
    await expect.poll(
      () => collaboratorTranscriptRows.filter({ hasText: COLLABORATOR_SHARED_MESSAGE }).count(),
      { timeout: 30_000 },
    ).toBe(1)
    await expect.poll(() => collaboratorTranscriptRows.filter({ hasText: OWNER_SHARED_MESSAGE }).count(), { timeout: 30_000 }).toBe(1)
    await expect.poll(() => collaboratorTranscriptRows.filter({ hasText: REPLY }).count(), { timeout: 30_000 }).toBe(4)

    const attachmentInput = ownerGroupSection.locator('input[type="file"]')
    await attachmentInput.setInputFiles({
      name: SHARED_ATTACHMENT_NAME,
      mimeType: 'text/plain',
      buffer: Buffer.from(SHARED_ATTACHMENT_BODY),
    })
    await expect.poll(() => ownerGroupSection.getByTitle(SHARED_ATTACHMENT_NAME, { exact: true }).count()).toBe(1)
    await ownerComposer.fill(OWNER_ATTACHMENT_MESSAGE)
    await ownerDialog.getByRole('button', { name: 'Send to group', exact: true }).click()
    await expect.poll(() => adapter.requests.length, { timeout: 30_000 }).toBe(6)
    await expect.poll(() => ownerTranscriptRows.filter({ hasText: OWNER_ATTACHMENT_MESSAGE }).count(), { timeout: 30_000 }).toBe(1)
    await expect.poll(() => ownerGroupSection.getByTitle(SHARED_ATTACHMENT_NAME, { exact: true }).count(), { timeout: 30_000 }).toBe(0)

    await expect.poll(
      () => ownerTranscriptRows.filter({ hasText: OWNER_ATTACHMENT_MESSAGE }).filter({ hasText: SHARED_ATTACHMENT_NAME }).count(),
      { timeout: 30_000 },
    ).toBe(1)
    expect(JSON.stringify(adapter.requests.slice(-2))).toContain(SHARED_ATTACHMENT_NAME)

    await collaboratorGroupRow.click()
    await expect.poll(() => collaboratorTranscriptRows.filter({ hasText: OWNER_ATTACHMENT_MESSAGE }).count(), { timeout: 30_000 }).toBe(1)
    await expect.poll(
      () => collaboratorTranscriptRows.filter({ hasText: OWNER_ATTACHMENT_MESSAGE }).filter({ hasText: SHARED_ATTACHMENT_NAME }).count(),
      { timeout: 30_000 },
    ).toBe(1)

    await ownerGroupRow.click()
    await expect.poll(() => ownerTranscriptRows.filter({ hasText: COLLABORATOR_SHARED_MESSAGE }).count(), { timeout: 30_000 }).toBe(1)

    const ownerMembers = await scaffold.ctx.bots.listShareMembers({ botId: firstBot.id })
    const collaborator = ownerMembers.members.find(member => member.role === 'collaborator')
    if (collaborator === undefined) throw new Error('collaborator membership did not appear in the owner roster')
    const collaboratorPrincipalId = collaborator.principalId
    await scaffold.ctx.bots.revokeShareMember({ botId: firstBot.id, principalId: collaboratorPrincipalId })
    await scaffold.ctx.bots.revokeShareMember({ botId: secondBot.id, principalId: collaboratorPrincipalId })

    await collaboratorPage.reload({ waitUntil: 'load' })
    await collaboratorPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await collaboratorPage.getByRole('button', { name: 'Bots', exact: true }).click()
    await collaboratorPage.getByRole('button', { name: 'Join a shared bot', exact: true }).click()
    const revokedDialog = collaboratorPage.getByRole('dialog', { name: 'Shared with you', exact: true })
    await revokedDialog.waitFor({ state: 'visible', timeout: 15_000 })
    await expect.poll(() => revokedDialog.getByRole('button', { name: new RegExp(`^${SHARED_GROUP_NAME}`) }).count(), { timeout: 30_000 }).toBe(0)

    const visibleText = `${await ownerDialog.textContent()}\n${await collaboratorDialog.textContent()}`
    expect(visibleText).not.toContain(PRIVATE_SCOUT_PERSONA)
    expect(visibleText).not.toContain(PRIVATE_ORBIT_PERSONA)
    const requestText = JSON.stringify(adapter.requests)
    expect(requestText).toContain(OWNER_SHARED_MESSAGE)
    expect(requestText).toContain(COLLABORATOR_SHARED_MESSAGE)
    expect(requestText).not.toContain(PRIVATE_SCOUT_PERSONA)
    expect(requestText).not.toContain(PRIVATE_ORBIT_PERSONA)
    expect(requestText).not.toContain('private.scout')
    expect(requestText).not.toContain('private.orbit')

    const ownerMembersBeforeRestart = await scaffold.ctx.bots.listShareMembers({ botId: firstBot.id })
    const ownerMembershipsBeforeRestart = ownerMembersBeforeRestart.members.filter(member => member.role === 'owner')
    expect(ownerMembershipsBeforeRestart).toHaveLength(1)
    const ownerPrincipalBeforeRestart = ownerMembershipsBeforeRestart[0]?.principalId
    if (ownerPrincipalBeforeRestart === undefined) throw new Error('shared owner membership was not durable')
    const collaboratorMembershipsBeforeRestart = ownerMembersBeforeRestart.members.filter(member => member.role === 'collaborator')
    expect(collaboratorMembershipsBeforeRestart).toHaveLength(1)
    expect(collaboratorMembershipsBeforeRestart[0]?.principalId).not.toBe(ownerPrincipalBeforeRestart)

    // Close the first Host while retaining its isolated workspace, credentials,
    // storage, and Session roots. A new assembled Host and browser must recover
    // the same owner instead of minting a second principal.
    await collaboratorContext.close()
    collaboratorContext = undefined
    await page.close()
    await scaffold.close()
    if (retainedWorkspaceCwd === undefined || retainedPersistenceRoot === undefined) {
      throw new Error('shared-owner browser test did not retain its temporary roots')
    }
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE,
      replayProvidersOnly: true,
      profile: { hmr: false, packages: [] },
      workspaceCwd: retainedWorkspaceCwd,
      persistenceRoot: retainedPersistenceRoot,
      harnessHome: join(retainedWorkspaceCwd, '.dsh-home'),
    })
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter),
      'shared group browser fixture adapter after restart',
    )
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })

    const ownerMembersAfterRestart = await scaffold.ctx.bots.listShareMembers({ botId: firstBot.id })
    const ownerMembershipsAfterRestart = ownerMembersAfterRestart.members.filter(member => member.role === 'owner')
    expect(ownerMembershipsAfterRestart).toHaveLength(1)
    expect(ownerMembershipsAfterRestart[0]?.principalId).toBe(ownerPrincipalBeforeRestart)

    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Bots', exact: true }).click()
    const reopenedOwnerDialog = page.getByRole('button', { name: 'Create a shared group', exact: true })
    await expect.poll(() => reopenedOwnerDialog.isEnabled(), { timeout: 30_000 }).toBe(true)
    await reopenedOwnerDialog.click()
    const restartedDialog = page.getByRole('dialog', { name: 'Shared with you', exact: true })
    await restartedDialog.waitFor({ state: 'visible', timeout: 15_000 })
    await expect.poll(() => restartedDialog.getByRole('button', { name: new RegExp(`^${SHARED_GROUP_NAME}`) }).count(), {
      timeout: 30_000,
    }).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 180_000)
})
