// Keyless assembled-Web coverage for explicit Everyone recipients in private
// and shared Bot groups. The test sends only synthetic fixture messages.
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@yharness/llm'
import { LlmAdapter } from '@yharness/llm'
import type { BotView } from '@yharness/bots'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/bot-workspace', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v3.jsonl')
const MODE = webSnapshotMode()
const PRIVATE_GROUP_NAME = 'Everyone private browser room'
const SHARED_GROUP_NAME = 'Everyone shared browser room'
const PRIVATE_MESSAGE = '@everyone Verify private fanout.'
const SHARED_MESSAGE = '@everyone Verify shared fanout.'
const PROVIDER = 'bot-everyone-browser-test'
const MODEL = 'reply'
let rpcSequence = 0

async function capture(page: Page, name: string): Promise<void> {
  const directory = process.env.YH_BOT_EVERYONE_SCREENSHOTS
  if (directory === undefined) return
  await mkdir(directory, { recursive: true })
  await page.screenshot({ path: join(directory, name + '.png'), animations: 'disabled' })
}

function newestUserText(options: GenerateOptions): string {
  const message = options.messages.filter(item => item.role === 'user').at(-1)
  return message?.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
}

/** Deterministic local adapter that prevents the test from reaching a real provider. */
class EveryoneAdapter extends LlmAdapter {
  override async listModels(provider: string) {
    return [{ provider, id: MODEL, name: `${provider}/${MODEL}` }]
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = newestUserText(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: `Fixture reply for ${text}` } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function sharedRpc(page: Page, endpoint: string, payload: object): Promise<{
  readonly ok: boolean
  readonly value?: {
    readonly groups?: readonly { readonly id: string; readonly name: string }[]
    readonly messages?: readonly { readonly text: string; readonly targetBotIds?: readonly string[] }[]
  }
}> {
  const rpcId = `bot-everyone-e2e-${++rpcSequence}`
  return page.evaluate(async ({ endpoint: routeEndpoint, payload: requestPayload, rpcId }) => {
    const response = await fetch(`shared-bots/${routeEndpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: routeEndpoint, payload: requestPayload }),
    })
    const body = await response.json() as {
      readonly result?: {
        readonly ok?: boolean
        readonly value?: {
          readonly groups?: readonly { readonly id: string; readonly name: string }[]
          readonly messages?: readonly { readonly text: string; readonly targetBotIds?: readonly string[] }[]
        }
      }
    }
    const value = body.result?.value
    return value === undefined
      ? { ok: body.result?.ok === true }
      : { ok: body.result?.ok === true, value }
  }, { endpoint, payload, rpcId })
}

describe.skipIf(MODE === 'record')('web e2e: explicit Everyone group recipients', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let firstBot!: BotView
  let secondBot!: BotView
  let workspaceCwd: string | undefined
  let persistenceRoot: string | undefined

  beforeAll(async () => {
    workspaceCwd = await mkdtemp(join(tmpdir(), 'dsh-web-e2e-everyone-ws-'))
    persistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-web-e2e-everyone-sessions-'))
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE,
      replayProvidersOnly: true,
      profile: { hmr: false, packages: [] },
      workspaceCwd,
      persistenceRoot,
    })
    scaffold.ctx.effect(
      () => scaffold.ctx.llm.registerAdapter([PROVIDER], new EveryoneAdapter()),
      'Everyone browser fixture adapter',
    )
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
    firstBot = (await scaffold.ctx.bots.create({
      name: 'Scout', identity: 'browse', accent: 'teal', cwd: scaffold.workspaceCwd,
    })).bot
    secondBot = (await scaffold.ctx.bots.create({
      name: 'Orbit', identity: 'goal', accent: 'amber', cwd: scaffold.workspaceCwd,
    })).bot
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (workspaceCwd !== undefined) await rm(workspaceCwd, { recursive: true, force: true })
    if (persistenceRoot !== undefined) await rm(persistenceRoot, { recursive: true, force: true })
  })

  it('selects, removes, and persists Everyone for a private and shared group', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bot-everyone'))
    const sidebar = page.locator('[data-yh-part="sidebar"]')
    const botsMode = sidebar.getByRole('button', { name: 'Bots', exact: true })
    await botsMode.click()
    const roster = sidebar.locator('aside[aria-label="Bot workspace"]')
    await roster.waitFor({ state: 'visible', timeout: 15_000 })

    await roster.getByRole('button', { name: 'New bot group', exact: true }).click()
    const createDialog = page.getByRole('dialog', { name: 'Create a bot group', exact: true })
    await createDialog.getByLabel('Group name', { exact: true }).fill(PRIVATE_GROUP_NAME)
    await createDialog.getByRole('checkbox', { name: firstBot.name, exact: true }).check()
    await createDialog.getByRole('checkbox', { name: secondBot.name, exact: true }).check()
    await createDialog.getByRole('button', { name: 'Create group', exact: true }).click()
    await createDialog.waitFor({ state: 'hidden' })

    const privateRow = roster.getByRole('button', { name: `${PRIVATE_GROUP_NAME}, 2 Bots`, exact: true })
    await privateRow.waitFor({ state: 'visible', timeout: 15_000 })
    await privateRow.click()
    const privateDetail = page.locator(`section[aria-label="${PRIVATE_GROUP_NAME}"]`)
    await privateDetail.waitFor({ state: 'visible', timeout: 15_000 })
    const privateComposer = privateDetail.getByRole('textbox', { name: `Message ${PRIVATE_GROUP_NAME}`, exact: true })

    await page.setViewportSize({ width: 1440, height: 900 })
    await privateComposer.fill('@e')
    const privateEveryoneOption = privateDetail.getByRole('option', { name: /Everyone.*Every Bot in this group/u })
    await expect.poll(() => privateEveryoneOption.count(), { timeout: 15_000 }).toBe(1)
    await capture(page, 'private-desktop-everyone-menu')
    await privateEveryoneOption.click()
    await expect.poll(() => privateDetail.getByRole('button', { name: 'Remove Everyone mention', exact: true }).count()).toBe(1)
    await capture(page, 'private-desktop-everyone-selected')
    await privateDetail.getByRole('button', { name: 'Remove Everyone mention', exact: true }).click()
    await expect.poll(() => privateDetail.getByRole('button', { name: 'Remove Everyone mention', exact: true }).count()).toBe(0)
    await privateComposer.fill('@e')
    await privateDetail.getByRole('option', { name: /Everyone.*Every Bot in this group/u }).click()
    await privateComposer.fill(PRIVATE_MESSAGE)
    await privateDetail.getByRole('button', { name: 'Send message', exact: true }).click()

    const privateGroup = (await scaffold.ctx.bots.listGroups({})).groups.find(item => item.name === PRIVATE_GROUP_NAME)
    if (privateGroup === undefined) throw new Error('private Everyone group was not created')
    const expectedTargets = [String(firstBot.id), String(secondBot.id)].sort()
    await expect.poll(async () => {
      const inspected = await scaffold.ctx.bots.inspectGroup({ groupId: privateGroup.id })
      const message = inspected.messages.find(item => item.text === PRIVATE_MESSAGE)
      return message?.targetBotIds?.map(String).sort() ?? []
    }, { timeout: 30_000 }).toEqual(expectedTargets)

    await page.setViewportSize({ width: 480, height: 900 })
    await privateComposer.fill('@e')
    await expect.poll(() => privateDetail.getByRole('option', { name: /Everyone.*Every Bot in this group/u }).count()).toBe(1)
    await capture(page, 'private-narrow-everyone-menu')
    await privateDetail.getByRole('option', { name: /Everyone.*Every Bot in this group/u }).click()
    await expect.poll(() => privateDetail.getByRole('button', { name: 'Remove Everyone mention', exact: true }).count()).toBe(1)
    await capture(page, 'private-narrow-everyone-selected')

    await page.setViewportSize({ width: 1440, height: 900 })
    await sidebar.getByRole('button', { name: 'Bot workspace options', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Create a shared group', exact: true }).click()
    const sharedDialog = page.getByRole('dialog', { name: 'Shared with you', exact: true })
    await sharedDialog.getByRole('button', { name: new RegExp(`^${firstBot.name}\\b`) }).waitFor({ timeout: 30_000 })
    await sharedDialog.getByRole('button', { name: new RegExp(`^${secondBot.name}\\b`) }).waitFor({ timeout: 30_000 })
    const createShared = sharedDialog.locator('section[aria-labelledby="yharness-shared-groups-heading"]')
      .getByRole('button', { name: 'Create shared group', exact: true })
    await createShared.click()
    const sharedCreateDialog = page.getByRole('dialog', { name: 'Create a shared group', exact: true })
    await sharedCreateDialog.getByLabel('Group name', { exact: true }).fill(SHARED_GROUP_NAME)
    await sharedCreateDialog.getByRole('checkbox', { name: firstBot.name, exact: true }).check()
    await sharedCreateDialog.getByRole('checkbox', { name: secondBot.name, exact: true }).check()
    await sharedCreateDialog.getByRole('button', { name: 'Create shared group', exact: true }).click()
    await sharedCreateDialog.waitFor({ state: 'hidden' })
    const sharedRow = sharedDialog.getByRole('button', { name: new RegExp(`^${SHARED_GROUP_NAME}`) })
    await sharedRow.waitFor({ timeout: 30_000 })
    await sharedRow.click()
    const sharedSection = sharedDialog.locator(`section[aria-label="${SHARED_GROUP_NAME}"]`)
    await sharedSection.waitFor({ timeout: 30_000 })
    const sharedComposer = sharedSection.getByRole('combobox', { name: `Message ${SHARED_GROUP_NAME}`, exact: true })
    await sharedComposer.fill('@e')
    const sharedEveryoneOption = sharedSection.getByRole('option', { name: /Everyone.*Every Bot in this group/u })
    await expect.poll(() => sharedEveryoneOption.count(), { timeout: 15_000 }).toBe(1)
    await sharedEveryoneOption.click()
    await expect.poll(() => sharedSection.getByRole('button', { name: 'Remove Everyone mention', exact: true }).count()).toBe(1)
    await capture(page, 'shared-desktop-everyone-selected')
    await sharedComposer.fill(SHARED_MESSAGE)
    await sharedDialog.getByRole('button', { name: 'Send to group', exact: true }).click()
    await expect.poll(() => sharedSection.getByText(SHARED_MESSAGE, { exact: true }).count(), { timeout: 30_000 }).toBe(1)

    const sharedList = await sharedRpc(page, 'bots/share/list-groups', {})
    const sharedGroup = sharedList.value?.groups?.find(item => item.name === SHARED_GROUP_NAME)
    if (sharedGroup === undefined) throw new Error('shared Everyone group was not created')
    await expect.poll(async () => {
      const inspected = await sharedRpc(page, 'bots/share/inspect-group', { groupId: sharedGroup.id })
      const message = inspected.value?.messages?.find(item => item.text === SHARED_MESSAGE)
      return message?.targetBotIds?.map(String).sort() ?? []
    }, { timeout: 30_000 }).toEqual(expectedTargets)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 180_000)
})
