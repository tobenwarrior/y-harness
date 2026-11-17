/** Exercise the secure request through the shipped Web Host and Bot composer. */

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BotId, BotPrincipalId } from '@yharness/bots'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@yharness/llm'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/bot-workspace/session.v3.jsonl', import.meta.url))
const GOLDEN = fileURLToPath(new URL('./expected/bot-vault-request/request.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SHARED_GOLDEN = fileURLToPath(new URL('./expected/bot-vault-request/shared.expected.md', import.meta.url))
const CHALLENGE = 'd'.repeat(32)
const BOT = BotId('bot-vault-fixture')
const SERVICE = 'example-worker.service'
const KEY = 'EXAMPLE_API_KEY'
const PROVIDER = 'vault-request-fixture'
const MODEL = 'reply'
const REPLY = 'The service key is saved.'
const NO_GRANTS = 'This Bot has no VPS Vault grants.'

class RequestAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  sawReceipt = false
  sawNoGrants = false

  constructor(private readonly managed: boolean) { super() }

  override async listModels(provider: string) {
    return [{ provider, id: MODEL, name: `${provider}/${MODEL}` }]
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const input = options.messages.findLastIndex(message => message.role === 'user')
    const result = options.messages.slice(input + 1).findLast(message => message.role === 'tool')
    const discover = this.managed && result === undefined
    const allowed = result?.content.some(block => block.type === 'text'
      && block.text === `Allowed service and key pairs:\n${SERVICE} / ${KEY}`) === true
    if (result === undefined || allowed) {
      const id = ToolCallId(discover ? 'vault-discovery' : 'vault-request')
      const name = 'request_vps_secret'
      const args = JSON.stringify(discover ? {} : { unit: SERVICE, name: KEY })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    this.sawReceipt = result.content.some(block => block.type === 'text' && block.text.includes('saved in the VPS Vault'))
    this.sawNoGrants = result.content.some(block => block.type === 'text' && block.text === NO_GRANTS)
    const reply = this.sawReceipt ? REPLY : this.sawNoGrants ? NO_GRANTS : 'The request failed.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it.skipIf(MODE === 'record' || process.platform === 'win32').each([
  { mode: 'managed', vpsVaultRequests: { socketPath: '/run/yharness-vault/cloud-requests.sock' } },
  { mode: 'disabled', vpsVaultRequests: null },
])('reports the configured $mode Bot access policy to the owner', async ({ mode, vpsVaultRequests }) => {
  const root = await mkdtemp('/tmp/yh-vault-policy-')
  const overlay = join(root, 'vault.yml')
  try {
    await writeFile(overlay, JSON.stringify([{ id: 'web-runtime', config: { vpsVaultRequests } }]))
    const web = await launchWebScaffold({ extraOverlayPath: overlay, replayFixture: FIXTURE, replayProvidersOnly: true })
    try {
      const response = await web.hostFetch('/api/bot-vault-access')
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('X-YH-Vault-Grant-Scopes')).toBe(mode === 'managed' ? '1' : null)
      expect(await response.json()).toEqual({ mode })
      expect((await fetch(new URL('/api/bot-vault-access', web.baseUrl))).status).toBe(401)
    } finally { await web.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.skipIf(MODE === 'record' || process.platform === 'win32').each([
  { policy: 'Web profile', managed: false, scope: 'owner' },
  { policy: 'live Vault', managed: true, scope: 'owner' },
  { policy: 'shared Vault', managed: true, scope: 'shared' },
  { policy: 'shared group Vault', managed: true, scope: 'group' },
])('offers a secure handoff and returns a receipt with $policy grants', async ({ managed, scope }) => {
  const shared = scope !== 'owner'
  const root = await mkdtemp('/tmp/yh-vault-web-')
  const socketPath = join(root, 'r')
  const overlay = join(root, 'vault.yml')
  let ownerSaved = false
  let allowed = !managed
  let ownerConsent: string | undefined
  let sharedAuthorized: string | undefined
  const commands: Array<Record<string, unknown>> = []
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let payload = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => { payload += chunk })
    socket.once('end', () => {
      const command = JSON.parse(payload) as Record<string, unknown>
      commands.push(command)
      if (command.action === 'list') {
        const scoped = shared ? command.scope === 'shared' : command.scope === undefined
        const credentials = allowed && scoped && command.bot === BOT ? [{ unit: SERVICE, name: KEY }] : []
        socket.end(JSON.stringify({ credentials }))
        return
      }
      if (command.scope === 'shared' && typeof command.id === 'string' && command.id === ownerConsent) {
        if (command.action === 'authorize' && command.challenge === CHALLENGE) {
          sharedAuthorized = command.id
        } else if (command.action === 'status') {
          socket.end(JSON.stringify(sharedAuthorized === command.id ? { state: 'saved' }
            : { state: 'awaiting-authorization', challenge: CHALLENGE }))
          return
        }
      }
      const state = command.action === 'cancel' ? 'cancelled' : ownerSaved ? 'saved' : 'pending'
      socket.end(JSON.stringify({ state }))
    })
  })
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    const vpsVaultRequests = managed
      ? { socketPath, ...(shared ? { sharedRequests: true } : {}) }
      : { socketPath, grants: [{ bot: BOT, unit: SERVICE, name: KEY }] }
    await writeFile(overlay, JSON.stringify([{ id: 'web-runtime', config: { vpsVaultRequests } }]))
    const web = scaffold = await launchWebScaffold({
      extraOverlayPath: overlay, replayFixture: FIXTURE, replayProvidersOnly: true, toolsMode: 'native',
    })
    const access = await web.hostFetch('/api/bot-vault-access')
    expect(access.status).toBe(200)
    expect(await access.json()).toEqual({ mode: 'external' })
    expect((await fetch(new URL('/api/bot-vault-access', web.baseUrl))).status).toBe(401)
    const adapter = new RequestAdapter(managed)
    web.ctx.effect(() => web.ctx.llm.registerAdapter([PROVIDER], adapter), 'Vault request fixture model')
    await web.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
    const { bot } = await web.ctx.bots.create({ id: BOT, name: 'Scout', cwd: web.workspaceCwd })
    const { bot: other } = await web.ctx.bots.create({ name: 'Orbit', cwd: web.workspaceCwd })
    const runtime = browser = await chromium.launch()
    const page = await runtime.newPage({
      locale: 'en-US', userAgent: 'YHarnessCloudDesktop/1', viewport: { width: 720, height: 900 },
    })
    const consoleLog = watchConsole(page)
    await page.goto(web.authenticatedUrl, { waitUntil: 'load' })
    const ownRoute = `/api/bot-vault-request?sessionId=${bot.sessionId}`
    const initial = await web.hostFetch(ownRoute)
    expect(initial.status).toBe(200)
    expect(await initial.json()).toEqual({ request: null })
    expect(await page.evaluate(() => Reflect.get(window, '__YH_BOT_VAULT_REQUESTS__'))).toBe(true)
    await page.locator('[data-yh-part="sidebar"]').getByRole('button', { name: 'Bots', exact: true }).click()
    await page.locator(`[data-bot-id="${BOT}"]`).click()
    const conversation = page.locator('[data-conversation-surface="bots"]')
    const send = async (text: string) => {
      await conversation.locator('[data-composer-input][contenteditable="true"]').fill(text)
      await conversation.getByRole('button', { name: 'Send message', exact: true }).click()
    }
    if (shared) {
      allowed = true
      const origin = new URL(web.baseUrl).origin
      const sharedCall = async (operation: string, payload: object, cookie?: string) => {
        const method = `bots/share/${operation}`
        const response = await fetch(new URL(`/shared-bots/${method}`, origin), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie === undefined ? {} : { Cookie: cookie }) },
          body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
          signal: AbortSignal.timeout(15_000),
        })
        const { result } = await response.json() as {
          result: {
            ok: boolean
            value?: { principalId?: string; recent?: unknown; messages?: unknown; group?: { id: string }; code?: string }
          }
        }
        return { response, result }
      }
      const owner = await web.ctx.bots.createShareInvite({ botId: BOT, role: 'owner' })
      const ownerEnrollment = await sharedCall('enroll', { code: owner.code })
      const ownerCookie = ownerEnrollment.response.headers.get('Set-Cookie')?.split(';', 1)[0]
      if (!ownerEnrollment.result.ok || ownerCookie === undefined) throw new Error('Could not enroll the owner')
      const invite = await web.ctx.bots.createShareInvite({ botId: BOT, role: 'collaborator' })
      const member = await sharedCall('enroll', { code: invite.code })
      const cookie = member.response.headers.get('Set-Cookie')?.split(';', 1)[0]
      const principalId = member.result.value?.principalId
      if (!member.result.ok || cookie === undefined || principalId === undefined) throw new Error('Could not enroll the collaborator')
      let groupId: string | undefined
      if (scope === 'group') {
        const secondOwner = await web.ctx.bots.createShareInvite({ botId: other.id, role: 'owner' })
        expect((await sharedCall('enroll', { code: secondOwner.code }, ownerCookie)).result.ok).toBe(true)
        const secondInvite = await web.ctx.bots.createShareInvite({ botId: other.id, role: 'collaborator' })
        expect((await sharedCall('enroll', { code: secondInvite.code }, cookie)).result.ok).toBe(true)
        const created = await sharedCall('create-group', { name: 'Shared Vault group', botIds: [BOT, other.id] }, ownerCookie)
        groupId = created.result.value?.group?.id
        if (!created.result.ok || groupId === undefined) throw new Error('Could not create the shared group')
        const groupInvite = await sharedCall('manage-group-members', { groupId, action: 'create-invite' }, ownerCookie)
        const code = groupInvite.result.value?.code
        if (!groupInvite.result.ok || code === undefined) throw new Error('Could not invite the collaborator to the group')
        expect((await sharedCall('enroll', { code }, cookie)).result.ok).toBe(true)
      }
      const chat = (text: string) => groupId === undefined
        ? sharedCall('chat', { botId: BOT, text }, cookie)
        : sharedCall('send-group-message', {
          groupId, text, targetBotIds: [BOT], messageId: `bot-group-message-${randomUUID()}`,
        }, cookie)
      const recent = async () => {
        if (groupId === undefined) {
          const view = await sharedCall('read-private-chat', { botId: BOT }, cookie)
          return JSON.stringify(view.result.value?.recent ?? [])
        }
        const view = await sharedCall('inspect-group', { groupId }, cookie)
        return JSON.stringify(view.result.value?.messages ?? [])
      }

      expect(await page.evaluate(() => Reflect.get(window, '__YH_BOT_SHARED_VAULT_REQUESTS__'))).toBe(true)
      expect((await chat('Request the shared service key.')).result.ok).toBe(true)
      const selector = 'section[aria-label="Shared secure request"][data-bot-vault-request-state="pending"]'
      const pending = page.locator(selector)
      await pending.waitFor({ timeout: 12_000 })
      const handoff = await pending.getByRole('link', { name: 'Enter key securely' }).getAttribute('href')
      const id = handoff?.split('/').at(-1)
      if (id === undefined) throw new Error('The shared Vault request is missing its owner handoff.')
      expect(handoff).toMatch(/^\/__yharness\/vault-request\/[0-9a-f]{32}$/u)
      expect(commands).toContainEqual({ action: 'list', bot: BOT, scope: 'shared' })
      expect(commands).toContainEqual({ action: 'create', bot: BOT, scope: 'shared', unit: SERVICE, name: KEY, id })
      expect(await (await web.hostFetch(ownRoute)).json()).toEqual({
        request: { scope: 'shared', id, unit: SERVICE, name: KEY, state: 'pending' },
      })
      expect((await fetch(new URL(ownRoute, web.baseUrl), { headers: { Cookie: cookie } })).status).toBe(401)
      const snapshot = await captureStableAria(page, selector, web.workspaceCwd, { replacements: [[id, '{{id}}']] })
      ownerConsent = id
      await expect.poll(recent, { timeout: 12_000 }).toContain(REPLY)
      expect(await recent()).not.toContain(id)
      expect(await recent()).not.toContain(CHALLENGE)
      expect(commands).toContainEqual({ action: 'authorize', bot: BOT, scope: 'shared', id, challenge: CHALLENGE })
      await page.locator('[data-bot-vault-request-state="saved"]').waitFor({ timeout: 12_000 })

      expect((await chat('Request the key again.')).result.ok).toBe(true)
      await pending.waitFor({ timeout: 12_000 })
      const newHandoff = await pending.getByRole('link', { name: 'Enter key securely' }).getAttribute('href')
      const newId = newHandoff?.split('/').at(-1)
      expect(newId).toMatch(/^[a-f0-9]{32}$/u)
      expect(newId).not.toBe(id)
      if (groupId === undefined) {
        await web.ctx.bots.revokeShareMember({ botId: BOT, principalId: BotPrincipalId(principalId) })
      } else {
        const revoked = await sharedCall('manage-group-members', { groupId, action: 'revoke', principalId }, ownerCookie)
        expect(revoked.result.ok).toBe(true)
      }
      ownerConsent = newId
      await pending.waitFor({ state: 'hidden', timeout: 12_000 })
      await expect.poll(() => commands).toContainEqual({ action: 'cancel', bot: BOT, scope: 'shared', id: newId })
      expect(commands.filter(command => command.action === 'authorize')).toHaveLength(1)
      expect(commands.every(command => !Object.hasOwn(command, 'value'))).toBe(true)
      expect(consoleLog.pageErrors).toEqual([])
      await compareOrRefreshGolden(SHARED_GOLDEN, snapshot, MODE)
      return
    }
    if (managed) {
      await send('Check my Vault permissions.')
      await conversation.getByText(NO_GRANTS, { exact: true }).waitFor()
      expect(adapter.sawNoGrants).toBe(true)
      expect(commands).toEqual([{ action: 'list', bot: BOT }])
      allowed = true
    }
    await send('Request the service key.')
    const pendingSelector = '[data-bot-vault-request-state="pending"]'
    const pending = page.locator(pendingSelector)
    await expect.poll(() => adapter.requests.length, { timeout: 5_000 }).toBeGreaterThan(0)
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('request_vps_secret')
    await expect.poll(() => commands.length, { timeout: 5_000, message: 'the Bot reaches the Vault broker' }).toBeGreaterThan(0)
    await expect.poll(async () => {
      expect(consoleLog.pageErrors).toEqual([])
      return pending.isVisible()
    }, { timeout: 12_000 }).toBe(true)
    const handoff = await pending.getByRole('link', { name: 'Enter key securely' }).getAttribute('href')
    expect(handoff).toMatch(/^\/__yharness\/vault-request\/[0-9a-f]{32}$/u)
    const id = handoff?.split('/').at(-1)
    if (managed) expect(commands.slice(0, 2)).toEqual([{ action: 'list', bot: BOT }, { action: 'list', bot: BOT }])
    expect(commands.find(command => command.action === 'create')).toEqual({
      action: 'create', id, unit: SERVICE, name: KEY, ...(managed ? { bot: BOT } : {}),
    })
    expect(await pending.locator('input').count()).toBe(0)
    expect((await fetch(new URL(ownRoute, web.baseUrl))).status).toBe(401)
    expect(await (await web.hostFetch(ownRoute)).json()).toEqual({
      request: { id, unit: SERVICE, name: KEY, state: 'pending' },
    })
    expect(await (await web.hostFetch(`/api/bot-vault-request?sessionId=${other.sessionId}`)).json()).toEqual({ request: null })
    const options = { replacements: [[String(id), '{{id}}']] as const }
    const pendingSnapshot = await captureStableAria(page, pendingSelector, web.workspaceCwd, options)
    ownerSaved = true
    const savedSelector = '[data-bot-vault-request-state="saved"]'
    await page.locator(savedSelector).waitFor({ state: 'visible', timeout: 12_000 })
    await conversation.getByText(REPLY, { exact: true }).waitFor()
    expect(adapter.sawReceipt).toBe(true)
    expect(commands.every(command => !Object.hasOwn(command, 'value'))).toBe(true)
    const savedSnapshot = await captureStableAria(page, savedSelector, web.workspaceCwd)
    await compareOrRefreshGolden(GOLDEN, `## Pending request\n\n${pendingSnapshot}\n\n## Saved receipt\n\n${savedSnapshot}`, MODE)
  } finally {
    try { await browser?.close() }
    finally {
      try { await scaffold?.close() }
      finally {
        if (server.listening) await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})
