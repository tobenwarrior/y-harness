// Keyless assembled-Web coverage for shared group creation and isolated delivery.
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
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

type SharedRpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

interface SharedEnrollmentValue {
  readonly principalId: string
  readonly groupId?: string
}

interface SharedGroupValue {
  readonly id: string
  readonly name: string
}

interface SharedGroupInviteValue {
  readonly code: string
}

interface SharedGroupInspectValue {
  readonly messages: readonly { readonly text: string }[]
}

/** POST one browser RPC through the collaborator-only route. */
async function sharedBrowserRpc<T>(page: Page, endpoint: string, payload: unknown): Promise<T> {
  const rpcId = `shared-browser-${endpoint}-${randomUUID()}`
  return await page.evaluate(async ({ endpoint, payload, rpcId }) => {
    const response = await fetch(`shared-bots/${endpoint}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId,
        method: endpoint,
        payload,
      }),
    })
    if (!response.ok) throw new Error(`shared ${endpoint} failed over HTTP ${String(response.status)}`)
    const result = (await response.json() as { readonly result: SharedRpcResult<T> }).result
    if (!result.ok) throw new Error(`shared ${endpoint} failed: ${result.error.code}: ${result.error.message}`)
    return result.value
  }, { endpoint, payload, rpcId })
}

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
  const adapter = new GroupReplyAdapter()

  beforeAll(async () => {
    // The model route is deterministic and local to this scaffold. The fixture
    // supplies only the header/catalog surface; no network model request is made.
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE,
      replayProvidersOnly: true,
      profile: { hmr: false, packages: [] },
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
    await collaboratorContext?.close()
    await browser?.close()
    await scaffold?.close()
  })

  it('creates an operator-local Bot group and keeps its private profile local to model input', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bot-group'))
    const sidebar = page.locator('[data-yh-part="sidebar"]')
    const botsMode = sidebar.getByRole('button', { name: 'Bots', exact: true })
    await botsMode.click()
    await expect.poll(() => botsMode.getAttribute('aria-pressed')).toBe('true')

    const roster = sidebar.locator('aside[aria-label="Bot workspace"]')
    await roster.waitFor({ state: 'visible', timeout: 15_000 })
    await roster.getByRole('button', { name: 'New group', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Create a shared group', exact: true })
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

  it('sends through one isolated shared group for its owner and collaborator without private profile data', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-shared-bot-group'))
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

    const ownerChiefInvite = await scaffold.ctx.bots.createShareInvite({ botId: firstBot.id, role: 'owner' })
    const ownerOrbitInvite = await scaffold.ctx.bots.createShareInvite({ botId: secondBot.id, role: 'owner' })
    const owner = await sharedBrowserRpc<SharedEnrollmentValue>(page, 'bots/share/enroll', { code: ownerChiefInvite.code })
    const ownerAgain = await sharedBrowserRpc<SharedEnrollmentValue>(page, 'bots/share/enroll', { code: ownerOrbitInvite.code })
    expect(ownerAgain.principalId).toBe(owner.principalId)

    const collaboratorChiefInvite = await scaffold.ctx.bots.createShareInvite({ botId: firstBot.id, role: 'collaborator' })
    const collaboratorOrbitInvite = await scaffold.ctx.bots.createShareInvite({ botId: secondBot.id, role: 'collaborator' })
    const collaborator = await sharedBrowserRpc<SharedEnrollmentValue>(collaboratorPage, 'bots/share/enroll', { code: collaboratorChiefInvite.code })
    const collaboratorAgain = await sharedBrowserRpc<SharedEnrollmentValue>(collaboratorPage, 'bots/share/enroll', { code: collaboratorOrbitInvite.code })
    expect(collaboratorAgain.principalId).toBe(collaborator.principalId)
    expect(collaborator.principalId).not.toBe(owner.principalId)

    const created = await sharedBrowserRpc<{ readonly group: SharedGroupValue }>(page, 'bots/share/create-group', {
      name: SHARED_GROUP_NAME,
      botIds: [firstBot.id, secondBot.id],
    })
    expect(created.group.name).toBe(SHARED_GROUP_NAME)
    const groupInvite = await sharedBrowserRpc<SharedGroupInviteValue>(page, 'bots/share/manage-group-members', {
      groupId: created.group.id,
      action: 'create-invite',
    })
    const groupEnrollment = await sharedBrowserRpc<SharedEnrollmentValue>(collaboratorPage, 'bots/share/enroll', { code: groupInvite.code })
    expect(groupEnrollment.groupId).toBe(created.group.id)

    const openSharedDialog = async (target: Page): Promise<import('playwright').Locator> => {
      await target.getByRole('button', { name: 'Bots', exact: true }).click()
      const join = target.getByRole('button', { name: 'Join a shared bot', exact: true })
      await join.click()
      const dialog = target.getByRole('dialog', { name: 'Shared with you', exact: true })
      await dialog.waitFor({ state: 'visible', timeout: 15_000 })
      await dialog.getByRole('textbox', { name: 'Message Release room shared', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
      return dialog
    }
    const ownerDialog = await openSharedDialog(page)
    const collaboratorDialog = await openSharedDialog(collaboratorPage)

    const ownerComposer = ownerDialog.getByRole('textbox', { name: 'Message Release room shared', exact: true })
    await ownerComposer.fill(OWNER_SHARED_MESSAGE)
    await ownerDialog.getByRole('button', { name: 'Send to group', exact: true }).click()
    await expect.poll(() => adapter.requests.length, { timeout: 30_000 }).toBe(2)
    const ownerTranscriptRows = ownerDialog.locator('section[aria-label="Release room shared"] p')
    await expect.poll(() => ownerTranscriptRows.filter({ hasText: OWNER_SHARED_MESSAGE }).count(), { timeout: 30_000 }).toBe(1)
    await expect.poll(() => ownerTranscriptRows.filter({ hasText: REPLY }).count(), { timeout: 30_000 }).toBe(2)

    const collaboratorComposer = collaboratorDialog.getByRole('textbox', { name: 'Message Release room shared', exact: true })
    await collaboratorComposer.fill(COLLABORATOR_SHARED_MESSAGE)
    await collaboratorDialog.getByRole('button', { name: 'Send to group', exact: true }).click()
    await expect.poll(() => adapter.requests.length, { timeout: 30_000 }).toBe(4)
    const collaboratorTranscriptRows = collaboratorDialog.locator('section[aria-label="Release room shared"] p')
    await expect.poll(
      () => collaboratorTranscriptRows.filter({ hasText: COLLABORATOR_SHARED_MESSAGE }).count(),
      { timeout: 30_000 },
    ).toBe(1)
    await expect.poll(() => collaboratorTranscriptRows.filter({ hasText: OWNER_SHARED_MESSAGE }).count(), { timeout: 30_000 }).toBe(1)
    await expect.poll(() => collaboratorTranscriptRows.filter({ hasText: REPLY }).count(), { timeout: 30_000 }).toBe(4)

    const ownerTranscript = await sharedBrowserRpc<SharedGroupInspectValue>(page, 'bots/share/inspect-group', { groupId: created.group.id })
    const collaboratorTranscript = await sharedBrowserRpc<SharedGroupInspectValue>(collaboratorPage, 'bots/share/inspect-group', { groupId: created.group.id })
    const transcriptText = JSON.stringify({ ownerTranscript, collaboratorTranscript })
    expect(transcriptText).toContain(OWNER_SHARED_MESSAGE)
    expect(transcriptText).toContain(COLLABORATOR_SHARED_MESSAGE)
    expect(transcriptText).not.toContain(PRIVATE_SCOUT_PERSONA)
    expect(transcriptText).not.toContain(PRIVATE_ORBIT_PERSONA)
    expect(transcriptText).not.toContain('private.scout')
    expect(transcriptText).not.toContain('private.orbit')

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
  }, 180_000)
})
