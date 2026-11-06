// Keyless assembled-Web coverage for shared group creation and isolated delivery.
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Browser, BrowserContext, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@yharness/llm'
import { LlmAdapter, ToolCallId } from '@yharness/llm'
import { defineTool } from '@yharness/tools'
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
const RENAMED_SHARED_GROUP_NAME = 'Release room shared renamed'
const OWNER_SHARED_MESSAGE = 'Owner shared readiness note.'
const COLLABORATOR_SHARED_MESSAGE = 'Collaborator shared follow-up.'
const OWNER_ATTACHMENT_MESSAGE = 'Owner shared release attachment.'
const SHARED_ATTACHMENT_NAME = 'release-notes.txt'
const SHARED_ATTACHMENT_BODY = 'shared attachment payload\n'
const SHARED_APP_TOOL = 'mcp__fixture__lookup'

/** Deterministic model response for the two shared-group recipients. */
class GroupReplyAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  searchNext = false
  appNext = false
  approvalNext = false

  override async listModels(provider: string) {
    return [{ provider, id: MODEL, name: `${provider}/${MODEL}` }]
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.appNext) {
      this.appNext = false
      const id = ToolCallId(`shared-group-connected-app-${this.requests.length}`)
      const args = '{}'
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: SHARED_APP_TOOL, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: SHARED_APP_TOOL, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (this.searchNext) {
      this.searchNext = false
      const id = ToolCallId('shared-group-web-search')
      const args = JSON.stringify({ queries: ['release checklist'] })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'web_search', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'web_search', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
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
  let approvalShotDir: string | undefined
  let ownsApprovalShotDir = false
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
    if (ownsApprovalShotDir && approvalShotDir !== undefined) {
      await rm(approvalShotDir, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
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

    const localInput = detail.locator('input[type="file"]')
    await expect.poll(() => localInput.isEnabled(), { timeout: 30_000 }).toBe(true)
    await localInput.setInputFiles({
      name: 'local-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('local file contents'),
    })
    await detail.getByRole('button', { name: 'Send message', exact: true }).click()
    const localDownload = detail.getByRole('link', { name: 'Download local-notes.txt', exact: true })
    await localDownload.waitFor({ state: 'visible', timeout: 30_000 })
    const localHref = await localDownload.getAttribute('href')
    if (localHref === null) throw new Error('local attachment download link is missing')
    const anonymousContext = await browser.newContext()
    try {
      const anonymousDownload = await anonymousContext.request.get(new URL(localHref, page.url()).toString())
      expect([401, 403, 404]).toContain(anonymousDownload.status())
    } finally {
      await anonymousContext.close()
    }
    const [download] = await Promise.all([page.waitForEvent('download'), localDownload.click()])
    const path = await download.path()
    if (path === null) throw new Error('local attachment download did not finish')
    expect(await readFile(path, 'utf8')).toBe('local file contents')

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
    onTestFailed(async () => {
      if (!page.isClosed()) await saveFailureShot(page, 'web-e2e-shared-bot-group')
      if (collaboratorPage === undefined || collaboratorPage.isClosed()) return
      await saveFailureShot(collaboratorPage, 'web-e2e-shared-bot-group-collaborator')
    })
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
      // An empty shared roster reports an alert, while an already-enrolled
      // collaborator can reopen with Bots visible and no alert at all.
      await expect.poll(
        async () => (await dialog.getByRole('alert').count())
          + await dialog.getByRole('button', { name: new RegExp(`^${firstBot.name}\\b`) }).count(),
        { timeout: 30_000 },
      ).toBeGreaterThan(0)
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

    let ownerGroupRow = ownerDialog.getByRole('button', { name: new RegExp(`^${SHARED_GROUP_NAME}`) })
    await ownerGroupRow.waitFor({ state: 'visible', timeout: 30_000 })
    await ownerGroupRow.click()
    let ownerGroupSection = ownerDialog.locator(`section[aria-label="${SHARED_GROUP_NAME}"]`)
    await ownerGroupSection.waitFor({ state: 'visible', timeout: 30_000 })
    await ownerGroupSection.getByRole('button', { name: 'Invite people', exact: true }).click()
    const groupInviteCode = ownerGroupSection.locator('code[aria-label="Group invite code"]')
    await groupInviteCode.waitFor({ state: 'visible', timeout: 30_000 })
    const groupInvite = await groupInviteCode.textContent()
    if (groupInvite === null || groupInvite.trim() === '') throw new Error('shared group UI did not render an invite code')

    let collaboratorDialog = await openSharedDialog(collaboratorPage)
    await redeemInvite(collaboratorDialog, collaboratorChiefInvite.code)
    await collaboratorDialog.getByRole('button', { name: new RegExp(`^${firstBot.name}\\b`) }).waitFor({ state: 'visible', timeout: 30_000 })
    await redeemInvite(collaboratorDialog, collaboratorOrbitInvite.code)
    await collaboratorDialog.getByRole('button', { name: new RegExp(`^${secondBot.name}\\b`) }).waitFor({ state: 'visible', timeout: 30_000 })
    await redeemInvite(collaboratorDialog, groupInvite)
    let collaboratorGroupRow = collaboratorDialog.getByRole('button', { name: new RegExp(`^${SHARED_GROUP_NAME}`) })
    await collaboratorGroupRow.waitFor({ state: 'visible', timeout: 30_000 })
    await collaboratorGroupRow.click()
    let collaboratorGroupSection = collaboratorDialog.locator(`section[aria-label="${SHARED_GROUP_NAME}"]`)
    await collaboratorGroupSection.waitFor({ state: 'visible', timeout: 30_000 })

    const ownerComposer = ownerGroupSection.getByRole('combobox', { name: 'Message Release room shared', exact: true })
    await ownerComposer.fill(OWNER_SHARED_MESSAGE)
    await ownerDialog.getByRole('button', { name: 'Send to group', exact: true }).click()
    await expect.poll(() => adapter.requests.length, { timeout: 30_000 }).toBe(2)
    const ownerTranscriptRows = ownerGroupSection.locator('p')
    await expect.poll(() => ownerTranscriptRows.filter({ hasText: OWNER_SHARED_MESSAGE }).count(), { timeout: 30_000 }).toBe(1)
    await expect.poll(() => ownerTranscriptRows.filter({ hasText: REPLY }).count(), { timeout: 30_000 }).toBe(2)

    const collaboratorComposer = collaboratorGroupSection.getByRole('combobox', { name: 'Message Release room shared', exact: true })
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

    const requestsBeforeMention = adapter.requests.length
    await collaboratorComposer.fill('@Sco')
    await expect.poll(() => collaboratorComposer.evaluate((element) => {
      const content = element.closest('[class*="shareDialogContent"]')
      if (content === null) return false
      const input = element.getBoundingClientRect()
      const bounds = content.getBoundingClientRect()
      return input.top >= bounds.top && input.bottom <= bounds.bottom
    })).toBe(true)
    await collaboratorGroupSection.getByRole('option', { name: /Scout/ }).click()
    await collaboratorComposer.fill('@Scout Please check the release.')
    const search = vi.spyOn(scaffold.ctx.web, 'search').mockResolvedValue({
      sources: [{ url: 'https://example.com/checklist', title: 'Release checklist' }], truncated: false,
    })
    onTestFinished(() => { search.mockRestore() })
    adapter.searchNext = true
    await collaboratorDialog.getByRole('button', { name: 'Send to group', exact: true }).click()
    await expect.poll(() => adapter.requests.length, { timeout: 30_000 }).toBe(6)
    const mentionedRequests = adapter.requests.slice(requestsBeforeMention)
    expect(mentionedRequests).toHaveLength(2)
    const scoutIdentity = String.raw`Your Bot name is \"Scout\"`
    expect(mentionedRequests.every(request => JSON.stringify(request).includes(scoutIdentity))).toBe(true)
    const searchRequest = mentionedRequests.find(request => request.tools?.some(tool => tool.name === 'web_search') === true)
    expect(searchRequest).toBeDefined()
    if (searchRequest === undefined) throw new Error('Scout mention did not expose web_search')
    const sharedToolNames = searchRequest.tools?.map(tool => tool.name) ?? []
    expect(sharedToolNames).toContain('web_search')
    expect(sharedToolNames).not.toContain('web_fetch')
    expect(sharedToolNames).not.toContain('bash')
    expect(search).toHaveBeenCalledOnce()
    const followupRequest = mentionedRequests.find(request => JSON.stringify(request).includes('https://example.com/checklist'))
    expect(followupRequest).toBeDefined()
    search.mockRestore()
    await expect.poll(() => collaboratorTranscriptRows.filter({ hasText: '@Scout Please check the release.' }).count(), { timeout: 30_000 }).toBe(1)

    const attachmentInput = ownerGroupSection.locator('input[type="file"]')
    await attachmentInput.setInputFiles({
      name: SHARED_ATTACHMENT_NAME,
      mimeType: 'text/plain',
      buffer: Buffer.from(SHARED_ATTACHMENT_BODY),
    })
    await expect.poll(() => ownerGroupSection.getByTitle(SHARED_ATTACHMENT_NAME, { exact: true }).count()).toBe(1)
    await ownerComposer.fill(OWNER_ATTACHMENT_MESSAGE)
    await ownerDialog.getByRole('button', { name: 'Send to group', exact: true }).click()
    await expect.poll(() => adapter.requests.length, { timeout: 30_000 }).toBe(8)
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
    const downloadLink = collaboratorGroupSection.getByRole('link', { name: `Download ${SHARED_ATTACHMENT_NAME}`, exact: true })
    const downloadHref = await downloadLink.getAttribute('href')
    if (downloadHref === null) throw new Error('shared attachment download link is missing')
    const [download] = await Promise.all([collaboratorPage.waitForEvent('download'), downloadLink.click()])
    const downloadPath = await download.path()
    if (downloadPath === null) throw new Error('shared attachment download did not finish')
    expect(await readFile(downloadPath, 'utf8')).toBe(SHARED_ATTACHMENT_BODY)

    await attachmentInput.setInputFiles({
      name: 'standalone.txt', mimeType: 'text/plain', buffer: Buffer.from('file without a typed message'),
    })
    await ownerDialog.getByRole('button', { name: 'Send to group', exact: true }).click()
    await expect.poll(() => adapter.requests.length, { timeout: 30_000 }).toBe(10)
    await expect.poll(() => ownerTranscriptRows.filter({ hasText: 'standalone.txt' }).count(), { timeout: 30_000 }).toBe(1)

    await ownerGroupRow.click()
    await expect.poll(() => ownerTranscriptRows.filter({ hasText: COLLABORATOR_SHARED_MESSAGE }).count(), { timeout: 30_000 }).toBe(1)

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

    const appCall = vi.fn(async () => 'Shared app result')
    scaffold.ctx.effect(() => scaffold.ctx.tools.register({
      ...defineTool({
        name: SHARED_APP_TOOL, description: 'Look up a shared fixture', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: appCall,
      }),
      source: { kind: 'mcp', serverName: 'fixture' },
    }), 'shared app browser fixture')
    const beforeGrant = await scaffold.ctx.bots.listSharedAppAccess({ botId: firstBot.id })
    expect(beforeGrant.apps.find(app => app.id === 'fixture')?.allowed).toBe(false)
    await scaffold.ctx.bots.setSharedAppAccess({
      botId: firstBot.id, appId: 'fixture', allowed: true, expectedRevision: beforeGrant.revision,
    })
    const previousRequests = adapter.requests.length
    adapter.appNext = true
    await collaboratorComposer.fill('@Scout Look up the shared fixture.')
    await collaboratorDialog.getByRole('button', { name: 'Send to group', exact: true }).click()
    await expect.poll(() => adapter.requests.length, { timeout: 30_000 }).toBe(previousRequests + 2)
    expect(adapter.requests[previousRequests]?.tools?.map(tool => tool.name)).toContain(SHARED_APP_TOOL)
    expect(appCall).toHaveBeenCalledOnce()
    expect(JSON.stringify(adapter.requests[previousRequests + 1])).toContain('Shared app result')

    // Register after the first shared call has composed the Bot-scoped policy
    // listeners. The root fixture gate must run after that listener records
    // the execution, otherwise it would short-circuit the shared approval
    // handoff instead of producing a pending mailbox record.
    const approvalGateFibers = scaffold.ctx.agents.list().map(agent => agent.ctx.inject(['tools'], (scope) => {
      scope.on('tools/pre-execute', async (exec, next) => {
        const decision = await next()
        if (exec.name === SHARED_APP_TOOL && adapter.approvalNext && decision.kind === 'allow') {
          adapter.approvalNext = false
          return Promise.resolve({ kind: 'ask' as const, reason: 'Approve this shared fixture lookup.' })
        }
        return decision
      })
    }))
    onTestFinished(async () => {
      await Promise.all(approvalGateFibers.map(fiber => fiber.dispose()))
    })
    // A connected app can still require an explicit approval for a particular
    // call. The request is visible to the principal that owns the shared
    // Session, while the owner workspace must not inherit that request.
    const approvalRegion = collaboratorDialog.getByRole('region', { name: 'Pending approvals', exact: true })
    const waitForPendingApproval = async (): Promise<void> => {
      await expect.poll(
        () => approvalRegion.getByText(SHARED_APP_TOOL, { exact: true }).count(),
        { timeout: 30_000 },
      ).toBe(1)
    }
    const approvalRequestsBeforeAllow = adapter.requests.length
    const appCallsBeforeAllow = appCall.mock.calls.length
    adapter.appNext = true
    adapter.approvalNext = true
    await collaboratorComposer.fill('@Scout Ask for a shared fixture approval.')
    await collaboratorDialog.getByRole('button', { name: 'Send to group', exact: true }).click()
    await expect.poll(() => adapter.requests.length, { timeout: 30_000 }).toBe(approvalRequestsBeforeAllow + 1)
    await expect.poll(() => adapter.approvalNext, { timeout: 30_000 }).toBe(false)
    await waitForPendingApproval()
    await approvalRegion.getByText('fixture', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
    await approvalRegion.getByText(SHARED_APP_TOOL, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
    await approvalRegion.getByText(`Action: Run connected app tool "${SHARED_APP_TOOL}"`, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
    await approvalRegion.getByText('Approve this shared fixture lookup.', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
    await approvalRegion.getByText('Argument preview is shown below.', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
    if (approvalShotDir === undefined) {
      const explicitArtifactRoot = process.env.DSH_WEB_E2E_ARTIFACT_DIR
      if (explicitArtifactRoot === undefined) {
        approvalShotDir = await mkdtemp(join(tmpdir(), 'dsh-web-e2e-shared-approval-'))
        ownsApprovalShotDir = true
      } else {
        approvalShotDir = join(explicitArtifactRoot, `shared-bot-connected-app-approval-${String(process.pid)}`)
        await mkdir(approvalShotDir, { recursive: true })
      }
    }
    const shotDir = approvalShotDir
    if (shotDir === undefined) throw new Error('shared approval screenshot directory was not created')
    const approvalPage = collaboratorPage
    if (approvalPage === undefined || approvalPage.isClosed()) throw new Error('shared approval page was not available')
    await approvalRegion.screenshot({ path: join(shotDir, 'shared-approval-light.png') })
    const wasDark = await approvalPage.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))
    await approvalPage.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
    await expect.poll(() => approvalPage.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(true)
    await approvalRegion.screenshot({ path: join(shotDir, 'shared-approval-dark.png') })
    await approvalPage.evaluate((dark) => { document.body.toggleAttribute('data-ds-dark-theme', dark) }, wasDark)
    await approvalRegion.getByText('View call details', { exact: true }).click()
    const argumentPreview = approvalRegion.getByLabel('Arguments', { exact: true })
    await argumentPreview.waitFor({ state: 'visible', timeout: 10_000 })
    expect(await argumentPreview.textContent()).toBe('{}')
    expect(await ownerDialog.getByText(SHARED_APP_TOOL, { exact: true }).count()).toBe(0)
    const approveButton = approvalRegion.getByRole('button', { name: /^Approve .*mcp__fixture__lookup$/ })
    await approveButton.click()
    await expect.poll(() => appCall.mock.calls.length, { timeout: 30_000 }).toBe(appCallsBeforeAllow + 1)
    await expect.poll(() => adapter.requests.length, { timeout: 30_000 }).toBe(approvalRequestsBeforeAllow + 2)
    await expect.poll(
      () => approvalRegion.getByText(SHARED_APP_TOOL, { exact: true }).count(),
      { timeout: 30_000 },
    ).toBe(0)

    const approvalRequestsBeforeReject = adapter.requests.length
    const appCallsBeforeReject = appCall.mock.calls.length
    adapter.appNext = true
    adapter.approvalNext = true
    await collaboratorComposer.fill('@Scout Reject the shared fixture approval.')
    await collaboratorDialog.getByRole('button', { name: 'Send to group', exact: true }).click()
    await expect.poll(() => adapter.requests.length, { timeout: 30_000 }).toBe(approvalRequestsBeforeReject + 1)
    await waitForPendingApproval()
    const denyButton = approvalRegion.getByRole('button', { name: /^Reject .*mcp__fixture__lookup$/ })
    await denyButton.click()
    await expect.poll(() => adapter.requests.length, { timeout: 30_000 }).toBe(approvalRequestsBeforeReject + 2)
    expect(appCall.mock.calls.length).toBe(appCallsBeforeReject)
    await expect.poll(
      () => approvalRegion.getByText(SHARED_APP_TOOL, { exact: true }).count(),
      { timeout: 30_000 },
    ).toBe(0)

    const ownerMembersBeforeSettings = await scaffold.ctx.bots.listShareMembers({ botId: firstBot.id })
    const ownerPrincipalBeforeSettings = ownerMembersBeforeSettings.members.find(member => member.role === 'owner')?.principalId
    const collaboratorPrincipalBeforeSettings = ownerMembersBeforeSettings.members.find(member => member.role === 'collaborator')?.principalId
    if (ownerPrincipalBeforeSettings === undefined || collaboratorPrincipalBeforeSettings === undefined) {
      throw new Error('shared group participants were not durable before settings opened')
    }

    // The owner and collaborator are already in the same room. Read the
    // settings from both views before changing the room name so the test also
    // proves that the participant projection is not owner-only.
    await ownerGroupSection.getByRole('button', { name: /group settings/i }).click()
    const ownerGroupSettings = page.getByRole('dialog', { name: 'Group settings', exact: true })
    await ownerGroupSettings.waitFor({ state: 'visible', timeout: 15_000 })
    await ownerGroupSettings.getByText(firstBot.name, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
    await ownerGroupSettings.getByText(secondBot.name, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
    await ownerGroupSettings.getByText(ownerPrincipalBeforeSettings, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
    await ownerGroupSettings.getByText(collaboratorPrincipalBeforeSettings, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
    const ownerGroupNameInput = ownerGroupSettings.getByRole('textbox', { name: 'Group name', exact: true })
    expect(await ownerGroupNameInput.isEnabled()).toBe(true)
    expect(await ownerGroupSettings.getByRole('button', { name: /remove.*member|remove.*principal/i }).count()).toBeGreaterThan(0)
    await ownerGroupNameInput.fill(RENAMED_SHARED_GROUP_NAME)
    await ownerGroupSettings.getByRole('button', { name: /save/i }).click()
    await expect.poll(() => ownerGroupNameInput.inputValue(), { timeout: 30_000 }).toBe(RENAMED_SHARED_GROUP_NAME)
    if (await ownerGroupSettings.count() > 0) {
      await ownerGroupSettings.getByRole('button', { name: 'Cancel', exact: true }).last().click()
    }
    ownerGroupRow = ownerDialog.getByRole('button', { name: new RegExp(`^${RENAMED_SHARED_GROUP_NAME}`) })
    ownerGroupSection = ownerDialog.locator(`section[aria-label="${RENAMED_SHARED_GROUP_NAME}"]`)
    await expect.poll(() => ownerGroupRow.count(), { timeout: 30_000 }).toBe(1)
    await expect.poll(
      () => ownerGroupSection.getByText(RENAMED_SHARED_GROUP_NAME, { exact: true }).count(),
      { timeout: 30_000 },
    ).toBeGreaterThan(0)

    const collaboratorSettingsDialog = collaboratorPage.getByRole('dialog', { name: 'Group settings', exact: true })
    if (await collaboratorSettingsDialog.count() > 0) {
      await collaboratorSettingsDialog.getByRole('button', { name: 'Cancel', exact: true }).last().click()
    }
    await collaboratorDialog.getByRole('button', { name: 'Cancel', exact: true }).last().click()
    collaboratorDialog = await openSharedDialog(collaboratorPage)
    collaboratorGroupRow = collaboratorDialog.getByRole('button', { name: new RegExp(`^${RENAMED_SHARED_GROUP_NAME}`) })
    await collaboratorGroupRow.waitFor({ state: 'visible', timeout: 30_000 })
    await collaboratorGroupRow.click()
    collaboratorGroupSection = collaboratorDialog.locator(`section[aria-label="${RENAMED_SHARED_GROUP_NAME}"]`)
    await collaboratorGroupSection.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(
      () => collaboratorGroupSection.getByText(RENAMED_SHARED_GROUP_NAME, { exact: true }).count(),
      { timeout: 30_000 },
    ).toBeGreaterThan(0)
    await collaboratorGroupSection.getByRole('button', { name: /group settings/i }).click()
    const collaboratorGroupSettings = collaboratorPage.getByRole('dialog', { name: 'Group settings', exact: true })
    await collaboratorGroupSettings.waitFor({ state: 'visible', timeout: 15_000 })
    await collaboratorGroupSettings.getByText(firstBot.name, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
    await collaboratorGroupSettings.getByText(secondBot.name, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
    await collaboratorGroupSettings.getByText(ownerPrincipalBeforeSettings, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
    await collaboratorGroupSettings.getByText(collaboratorPrincipalBeforeSettings, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
    const collaboratorGroupNameInput = collaboratorGroupSettings.getByRole('textbox', { name: 'Group name', exact: true })
    expect(await collaboratorGroupNameInput.isDisabled()).toBe(true)
    expect(await collaboratorGroupSettings.getByRole('button', { name: /save/i }).isDisabled()).toBe(true)
    expect(await collaboratorGroupSettings.getByRole('button', { name: /remove.*member|remove.*principal/i }).count()).toBe(0)
    await collaboratorGroupSettings.getByRole('button', { name: 'Cancel', exact: true }).last().click()

    await ownerGroupSection.getByRole('button', { name: /group settings/i }).click()
    const ownerRemovalSettings = page.getByRole('dialog', { name: 'Group settings', exact: true })
    await ownerRemovalSettings.waitFor({ state: 'visible', timeout: 15_000 })
    if (process.env.DSH_WEB_E2E_ARTIFACT_DIR !== undefined && shotDir !== undefined) {
      await ownerRemovalSettings.screenshot({
        path: join(shotDir, 'shared-group-settings-owner.png'),
        animations: 'disabled',
      })
    }
    await ownerRemovalSettings.getByRole('button', {
      name: `Remove ${collaboratorPrincipalBeforeSettings} from this group`, exact: true,
    }).click()
    const removeMemberConfirmation = page.getByRole('dialog', { name: 'Remove this person?', exact: true })
    await removeMemberConfirmation.getByRole('checkbox', { name: /I understand this removes their room access/i }).check()
    await removeMemberConfirmation.getByRole('button', { name: 'Remove from group', exact: true }).click()
    await expect.poll(
      () => ownerRemovalSettings.getByText(collaboratorPrincipalBeforeSettings, { exact: true }).count(),
      { timeout: 30_000 },
    ).toBe(0)
    await ownerRemovalSettings.getByRole('button', { name: 'Cancel', exact: true }).last().click()

    // Removing the room membership must not revoke the collaborator's Bot
    // memberships. Reopen the shared workspace before the existing Bot-level
    // revocation so the room ACL is tested on its own.
    await collaboratorDialog.getByRole('button', { name: 'Cancel', exact: true }).last().click()
    collaboratorDialog = await openSharedDialog(collaboratorPage)
    await collaboratorDialog.getByRole('button', { name: new RegExp(`^${firstBot.name}\\b`) }).waitFor({ state: 'visible', timeout: 30_000 })
    await collaboratorDialog.getByRole('button', { name: new RegExp(`^${secondBot.name}\\b`) }).waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(
      () => collaboratorDialog.getByRole('button', { name: new RegExp(`^${RENAMED_SHARED_GROUP_NAME}`) }).count(),
      { timeout: 30_000 },
    ).toBe(0)
    const removedGroupDownload = await collaboratorPage.request.get(new URL(downloadHref, collaboratorPage.url()).toString())
    expect([401, 403, 404]).toContain(removedGroupDownload.status())
    await collaboratorDialog.getByRole('button', { name: 'Cancel', exact: true }).last().click()

    const ownerMembersBeforeRestart = await scaffold.ctx.bots.listShareMembers({ botId: firstBot.id })
    const ownerMembershipsBeforeRestart = ownerMembersBeforeRestart.members.filter(member => member.role === 'owner')
    expect(ownerMembershipsBeforeRestart).toHaveLength(1)
    const ownerPrincipalBeforeRestart = ownerMembershipsBeforeRestart[0]?.principalId
    if (ownerPrincipalBeforeRestart === undefined) throw new Error('shared owner membership was not durable')
    const collaboratorMembershipsBeforeRestart = ownerMembersBeforeRestart.members.filter(member => member.role === 'collaborator')
    expect(collaboratorMembershipsBeforeRestart).toHaveLength(1)
    expect(collaboratorMembershipsBeforeRestart[0]?.principalId).not.toBe(ownerPrincipalBeforeRestart)

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
    await expect.poll(() => revokedDialog.getByRole('button', { name: new RegExp(`^${RENAMED_SHARED_GROUP_NAME}`) }).count(), { timeout: 30_000 }).toBe(0)
    const revokedDownload = await collaboratorPage.request.get(new URL(downloadHref, collaboratorPage.url()).toString())
    expect([401, 403, 404]).toContain(revokedDownload.status())


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
    await expect.poll(() => restartedDialog.getByRole('button', { name: new RegExp(`^${RENAMED_SHARED_GROUP_NAME}`) }).count(), {
      timeout: 30_000,
    }).toBe(1)
    await restartedDialog.getByRole('button', { name: new RegExp(`^${RENAMED_SHARED_GROUP_NAME}`) }).click()
    await expect.poll(() => restartedDialog.locator('p').filter({ hasText: '@Scout Please check the release.' }).count(), {
      timeout: 30_000,
    }).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 180_000)
})
