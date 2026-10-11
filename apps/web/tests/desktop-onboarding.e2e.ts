// Shipped Loader composition, real account/settings APIs, and an isolated external Platform fixture.
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterEach, beforeEach, describe, expect, it, onTestFailed } from 'vitest'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type {} from '@deepseek-ai/dsh-settings'
import {
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { openSettings, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const MODE = webSnapshotMode()
const NS = 'ui-settings-account'
const INITIAL = { version: 1, step: 'welcome', purpose: null, process: null, completion: null, usage: 'compact', developerTools: false }

describe.skipIf(MODE === 'record')('web e2e: provider-only Desktop connection', () => {
  let root: string
  let server: Server
  let origin: string
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let walletBalance = '0E-16'
  let bonusBalance = '0'
  let accountOffline = false
  let authorizationOffline = false
  let authorization: { redirect_uri: string; state: string } | undefined
  let authorizationStarts = 0
  let authorizationCancels = 0
  let revocations = 0
  let welcomeReads = 0
  let welcomeActivations: boolean[] = []

  beforeEach(async () => {
    walletBalance = '0E-16'
    bonusBalance = '0'
    accountOffline = false
    authorizationOffline = false
    authorization = undefined
    authorizationStarts = 0
    authorizationCancels = 0
    revocations = 0
    welcomeReads = 0
    welcomeActivations = []
    root = await mkdtemp(join(tmpdir(), 'dsh-desktop-onboarding-'))
    server = createServer((request, response) => {
      const respond = (value: unknown): void => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: value } }))
      }
      if (request.url === '/auth-api/v0/dsh/auth_init') {
        authorizationStarts++
        if (authorizationOffline) { response.writeHead(503).end(); return }
        request.setEncoding('utf8')
        let body = ''
        request.on('data', (chunk: string) => { body += chunk })
        request.on('end', () => {
          authorization = JSON.parse(body) as { redirect_uri: string; state: string }
          respond({ authorize_url: `${origin}/dsh/authorize`, authorize_id: 'onboarding-fixture-authorization', expires_in: 600 })
        })
        return
      }
      if (request.url === '/auth-api/v0/dsh/auth_cancel') {
        authorizationCancels++
        respond(null)
        return
      }
      if (request.url === '/auth-api/v0/users/logout') {
        revocations++
        respond(null)
        return
      }
      if (request.url === '/auth-api/v0/dsh/auth_exchange') {
        respond({ token: 'onboarding-fixture-token', authorized_url: `${origin}/dsh/authorized` })
        return
      }
      if (request.url !== '/auth-api/v0/users/current' && request.url !== '/api/v0/users/get_user_summary') {
        response.writeHead(404).end()
        return
      }
      const balance = request.url === '/api/v0/users/get_user_summary'
      if (accountOffline) { response.writeHead(503).end(); return }
      const value = balance
        ? { bonus_wallets: [{ currency: 'CNY', balance: bonusBalance }], normal_wallets: [{ currency: 'CNY', balance: walletBalance }] }
        : { id: 'onboarding-fixture-user', email: 'f***@example.invalid', id_profile: { name: 'Onboarding Fixture' } }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: value } }))
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture server address unavailable')
    origin = `http://127.0.0.1:${address.port}`
    const overlay = join(root, 'account.patch.yml')
    await writeFile(overlay, `- id: deepseek-account\n  config:\n    platformOrigin: ${origin}\n    allowLoopbackHttp: true\n`)
    scaffold = await launchWebScaffold({ deepSeekMissingCredential: true, extraOverlayPath: overlay })
    await scaffold.ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), async () => ({
      kind: 'grant', payload: { version: 1, issuer: origin, token: 'onboarding-fixture-token' },
    }))
    browser = await chromium.launch()
  })

  afterEach(async () => {
    try { await browser?.close() } finally {
      try { await scaffold?.close() } finally {
        try {
          if (server?.listening) await new Promise<void>((resolve, reject) => {
            server.close((error) => { if (error) reject(error); else resolve() })
          })
        } finally {
          if (root !== undefined) await rm(root, { recursive: true, force: true })
        }
      }
    }
  })

  async function desktopPage(locale = ZH_BROWSER_LOCALE): Promise<Page> {
    const opened = await browser.newPage({ viewport: { width: 1280, height: 840 }, locale, reducedMotion: 'reduce' })
    await opened.exposeFunction('__onboardingHasApiKey', () => { welcomeReads++; return false })
    await opened.exposeFunction('__onboardingSetActive', (active: boolean) => { welcomeActivations.push(active) })
    await opened.addInitScript(() => {
      Object.defineProperty(globalThis, 'dshOnboarding', { value: {
        hasApiKey: () => (globalThis as typeof globalThis & { __onboardingHasApiKey(): Promise<boolean> }).__onboardingHasApiKey(),
        setActive: (active: boolean) => {
          void (globalThis as typeof globalThis & {
            __onboardingSetActive(active: boolean): Promise<void>
          }).__onboardingSetActive(active)
        },
      } })
      Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } })
      Object.defineProperty(globalThis, 'dshPlatform', { value: {
        open: async () => {}, setBounds: async () => {}, close: async () => {},
      } })
    })
    return opened
  }

  async function saveProgress(step: 'credit' | 'purpose' | 'process' | 'done'): Promise<void> {
    await scaffold.ctx.settings.mutate(NS, Object.entries({ ...INITIAL, step, purpose: 'both', process: 'detailed', usage: 'detailed', developerTools: true,
      completion: step === 'done' ? 'completed' : null })
      .map(([field, value]) => ({ op: 'set', path: [field], value })))
  }

  function preferences() {
    return structuredClone(scaffold.ctx.settings.describe()
      .map(row => ({ ns: row.ns, value: row.value })))
  }

  async function profileFiles() {
    const read = async (path: string): Promise<string | null> => readFile(path, 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    })
    return {
      settings: await read(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml')),
      credentials: await read(join(scaffold.harnessHome, '.credentials.yaml')),
      sessions: await sessionFiles(scaffold.persistenceRoot),
    }
  }

  async function sessionFiles(directory: string, prefix = ''): Promise<{ path: string; digest: string }[]> {
    const files: { path: string; digest: string }[] = []
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      const relative = prefix.length ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) files.push(...await sessionFiles(path, relative))
      else if (entry.isFile()) files.push({ path: relative, digest: createHash('sha256').update(await readFile(path)).digest('hex') })
    }
    return files
  }

  async function accountFreeApp(locale: 'en' | 'zh' = 'zh'): Promise<void> {
    await page.locator('[data-desktop-onboarding]').waitFor({ state: 'detached' })
    await page.getByText(locale === 'zh' ? '选择一个工作区开始' : 'Choose a workspace to start', { exact: true }).waitFor()
    expect(await page.locator('[data-desktop-onboarding]').count()).toBe(0)
    expect(await page.getByRole('dialog').count()).toBe(0)
    expect(await page.getByRole('button', { name: /^(Account menu|账号菜单)$/ }).count()).toBe(0)
    expect(await page.getByText('Onboarding Fixture', { exact: true }).count()).toBe(0)
    expect(welcomeReads).toBe(0)
    expect(welcomeActivations).toEqual([])
    expect(await page.locator('#root').evaluate(element => ({ inert: (element as HTMLElement).inert, opacity: getComputedStyle(element).opacity })))
      .toEqual({ inert: false, opacity: '1' })
  }

  async function settingsModels(): Promise<{ settings: Locator; connection: Locator }> {
    await openSettings(page, 'zh')
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    expect(await settings.locator('nav').getByRole('button', { name: '账号与余额', exact: true }).count()).toBe(0)
    await settings.locator('nav').getByRole('button', { name: '模型', exact: true }).click()
    const connection = settings.getByRole('region', { name: 'DeepSeek 连接', exact: true })
    await connection.waitFor()
    return { settings, connection }
  }

  async function closeSettings(settings: Locator): Promise<void> {
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'detached' })
    await accountFreeApp()
  }

  it.each(['signed-out', 'signed-in', 'api-key'] as const)('opens a fresh %s profile with neutral Settings and unchanged stored data', async (account) => {
    if (account !== 'signed-in') await scaffold.ctx.credentials.deleteRecord(credentialKey('deepseek-account-platform', 'default'))
    if (account === 'api-key') await scaffold.ctx.credentials.set(credentialRef('DEEPSEEK_API_KEY'), 'fixture-api-key')
    await scaffold.ctx.settings.mutate('ui-chat', [
      { op: 'set', path: ['transcriptView'], value: 'detailed' },
      { op: 'set', path: ['performanceUsage'], value: 'compact' },
    ])
    await scaffold.ctx.settings.mutate('ui-settings', [{ op: 'set', path: ['enabled'], value: true }])
    await scaffold.ctx.settings.mutate('ui-theme', [{ op: 'set', path: ['preference'], value: 'dark' }])
    const savedPreferences = preferences()
    const savedFiles = await profileFiles()
    for (let launch = 0; launch < 2; launch++) {
      page = await desktopPage()
      tripwire = watchConsole(page)
      onTestFailed(() => saveFailureShot(page, `desktop-provider-fresh-${account}`))
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await accountFreeApp()
      await openSettings(page, 'zh')
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      expect(await settings.locator('nav').getByRole('button', { name: '账号与余额', exact: true }).count()).toBe(0)
      await settings.locator('nav').getByRole('button', { name: '通用设置', exact: true }).click()
      expect(await settings.getByRole('region', { name: 'DeepSeek 连接', exact: true }).count()).toBe(0)
      await settings.locator('nav').getByRole('button', { name: '模型', exact: true }).click()
      const connection = settings.getByRole('region', { name: 'DeepSeek 连接', exact: true })
      await connection.waitFor()
      if (account === 'signed-in') await connection.getByText('Onboarding Fixture', { exact: true }).waitFor()
      else await expect.poll(() => connection.getByRole('button', { name: '连接 DeepSeek', exact: true }).isEnabled()).toBe(true)
      expect(await settings.locator('nav').getByRole('button', { name: '账号与余额', exact: true }).count()).toBe(0)
      expect(await page.getByRole('button', { name: /^(Account menu|账号菜单)$/ }).count()).toBe(0)
      await closeSettings(settings)
      expect(preferences()).toEqual(savedPreferences)
      expect(await profileFiles()).toEqual(savedFiles)
      expect(await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(true)
      expect(tripwire.pageErrors).toEqual([])
      expect(authorizationStarts).toBe(0)
      await page.close()
    }
  })

  it('keeps the English launcher neutral and provider identity inside Models', async () => {
    const savedPreferences = preferences()
    const savedFiles = await profileFiles()
    page = await desktopPage('en-US')
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await accountFreeApp('en')
    await openSettings(page, 'en')
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    expect(await settings.locator('nav').getByRole('button', { name: 'Account', exact: true }).count()).toBe(0)
    await settings.locator('nav').getByRole('button', { name: 'Models', exact: true }).click()
    await settings.getByRole('region', { name: 'DeepSeek connection', exact: true })
      .getByText('Onboarding Fixture', { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'detached' })
    await accountFreeApp('en')
    expect(preferences()).toEqual(savedPreferences)
    expect(await profileFiles()).toEqual(savedFiles)
    expect(authorizationStarts).toBe(0)
    await page.close()
  })

  it.each((['credit', 'purpose', 'process', 'done'] as const).flatMap(step =>
    [false, true].map(signedIn => ({ step, signedIn }))))('preserves saved $step progress across launches (connected=$signedIn)', async ({ step, signedIn }) => {
    if (!signedIn) await scaffold.ctx.credentials.deleteRecord(credentialKey('deepseek-account-platform', 'default'))
    await saveProgress(step)
    const savedPreferences = preferences()
    const savedFiles = await profileFiles()
    for (let launch = 0; launch < 2; launch++) {
      page = await desktopPage()
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await accountFreeApp()
      const { settings, connection } = await settingsModels()
      if (signedIn) await connection.getByText('Onboarding Fixture', { exact: true }).waitFor()
      else await connection.getByRole('button', { name: '连接 DeepSeek', exact: true }).waitFor()
      await closeSettings(settings)
      expect(preferences()).toEqual(savedPreferences)
      expect(await profileFiles()).toEqual(savedFiles)
      expect(authorizationStarts).toBe(0)
      await page.close()
    }
  })

  it('keeps local navigation and other provider setup available when DeepSeek is offline', async () => {
    accountOffline = true
    const savedPreferences = preferences()
    const savedFiles = await profileFiles()
    page = await desktopPage()
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await accountFreeApp()
    const { settings, connection } = await settingsModels()
    await connection.getByText('账号资料暂不可用', { exact: true }).waitFor()
    await expect.poll(() => settings.getByRole('button', { name: '添加模型提供商', exact: true }).isEnabled()).toBe(true)
    await closeSettings(settings)
    expect(preferences()).toEqual(savedPreferences)
    expect(await profileFiles()).toEqual(savedFiles)
    expect(tripwire.pageErrors).toEqual([])
    expect(authorizationStarts).toBe(0)
    await page.close()
  })

  it('opens unrelated provider setup only on request and cancels without profile writes', async () => {
    await scaffold.ctx.credentials.deleteRecord(credentialKey('deepseek-account-platform', 'default'))
    const savedPreferences = preferences()
    const savedFiles = await profileFiles()
    page = await desktopPage()
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await accountFreeApp()
    const { settings } = await settingsModels()
    const add = settings.getByRole('button', { name: '添加模型提供商', exact: true })
    await expect.poll(() => add.isEnabled()).toBe(true)
    await add.click()
    const editor = settings.getByRole('tabpanel', { name: '第三方模型提供商', exact: true })
    await editor.getByLabel('提供商', { exact: true }).waitFor()
    await editor.getByRole('button', { name: '取消', exact: true }).click()
    await editor.waitFor({ state: 'detached' })
    expect(await settings.getByLabel('提供商', { exact: true }).count()).toBe(0)
    await closeSettings(settings)
    expect(preferences()).toEqual(savedPreferences)
    expect(await profileFiles()).toEqual(savedFiles)
    expect(authorizationStarts).toBe(0)
    await page.close()
  })

  it('cancels optional connection and returns from fixture authorization to Models without reviving onboarding', async () => {
    await scaffold.ctx.credentials.deleteRecord(credentialKey('deepseek-account-platform', 'default'))
    await scaffold.ctx.settings.mutate('agent-default-model', [
      { op: 'set', path: ['provider'], value: 'deepseek-official' },
      { op: 'set', path: ['model'], value: 'deepseek-v4-pro' },
    ])
    const savedPreferences = preferences()
    const signedOutFiles = await profileFiles()
    page = await desktopPage()
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await accountFreeApp()
    const { settings, connection } = await settingsModels()
    const openSignIn = async (): Promise<void> => {
      await connection.getByRole('button', { name: '连接 DeepSeek', exact: true }).click()
      await page.getByRole('dialog', { name: '等待登录', exact: true }).waitFor()
      await expect.poll(async () => (await scaffold.ctx.deepseekAccount.getState()).attempt?.phase).toBe('waiting-browser')
    }
    await openSignIn()
    const waiting = page.getByRole('dialog', { name: '等待登录', exact: true })
    await waiting.getByRole('button', { name: '取消', exact: true }).click()
    await expect.poll(() => authorizationCancels).toBe(1)
    await waiting.waitFor({ state: 'detached' })
    expect(preferences()).toEqual(savedPreferences)
    expect(await profileFiles()).toEqual(signedOutFiles)
    await openSignIn()
    const pending = authorization
    if (pending === undefined) throw new Error('fixture authorization callback unavailable')
    const callback = new URL(pending.redirect_uri)
    callback.searchParams.set('code', 'onboarding-fixture-code')
    callback.searchParams.set('state', pending.state)
    expect((await fetch(callback, { redirect: 'manual' })).status).toBe(302)
    await expect.poll(async () => (await scaffold.ctx.deepseekAccount.getState()).status).toBe('credential-stored')
    await waiting.waitFor({ state: 'detached' })
    await connection.getByText('Onboarding Fixture', { exact: true }).waitFor()
    expect(await settings.locator('nav').getByRole('button', { name: '账号与余额', exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: /^(Account menu|账号菜单)$/ }).count()).toBe(0)
    expect(await settings.locator('nav').getByRole('button', { name: '模型', exact: true }).getAttribute('aria-current')).toBe('true')
    expect(preferences()).toEqual(savedPreferences)
    await closeSettings(settings)
    const signedInFiles = await profileFiles()
    await page.close()
    page = await desktopPage()
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await accountFreeApp()
    const reopened = await settingsModels()
    await reopened.connection.getByText('Onboarding Fixture', { exact: true }).waitFor()
    await closeSettings(reopened.settings)
    expect(preferences()).toEqual(savedPreferences)
    expect(await profileFiles()).toEqual(signedInFiles)
    expect(authorizationStarts).toBe(2)
    await page.close()
  })

  it('cancels disconnect and then removes only the explicitly disconnected provider grant', async () => {
    walletBalance = '12.50'
    bonusBalance = '3.00'
    await saveProgress('purpose')
    await seedSession(scaffold, await readFile(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url), 'utf8'),
      'provider-disconnect-preserved-session')
    const apiKeyRef = credentialRef('DSH_E2E_PROVIDER_DISCONNECT_FIXTURE_KEY')
    const deviceKey = credentialKey('deepseek-account-platform', 'device')
    const otherKey = credentialKey('fixture-provider', 'default')
    const device = { kind: 'grant' as const, payload: { id: 'bdf792d7-ffcb-4d8b-8f44-f2f6f06c2342' } }
    const other = { kind: 'grant' as const, payload: { token: 'other-provider-fixture' } }
    await scaffold.ctx.credentials.set(apiKeyRef, 'unrelated-fixture-api-key')
    await scaffold.ctx.credentials.modifyRecord(deviceKey, async () => device)
    await scaffold.ctx.credentials.modifyRecord(otherKey, async () => other)
    const savedPreferences = preferences()
    const savedFiles = await profileFiles()
    const savedApiKeyInfo = await scaffold.ctx.credentials.describe(apiKeyRef)
    page = await desktopPage()
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await accountFreeApp()
    const { settings, connection } = await settingsModels()
    await connection.getByText('Onboarding Fixture', { exact: true }).waitFor()
    await connection.getByText('¥12.50', { exact: true }).waitFor()
    await connection.getByRole('button', { name: '断开 DeepSeek', exact: true }).click()
    const disconnect = page.getByRole('dialog', { name: '断开 DeepSeek', exact: true })
    await disconnect.getByRole('button', { name: '取消', exact: true }).click()
    await disconnect.waitFor({ state: 'detached' })
    expect(await profileFiles()).toEqual(savedFiles)
    expect(revocations).toBe(0)
    await connection.getByRole('button', { name: '断开 DeepSeek', exact: true }).click()
    await disconnect.getByRole('button', { name: '断开 DeepSeek', exact: true }).click()
    await disconnect.waitFor({ state: 'detached' })
    await expect.poll(async () => (await scaffold.ctx.deepseekAccount.getState()).status).toBe('signed-out')
    await connection.getByRole('button', { name: '连接 DeepSeek', exact: true }).waitFor()
    await expect.poll(() => revocations).toBe(1)
    expect(await scaffold.ctx.credentials.readRecord(credentialKey('deepseek-account-platform', 'default'))).toBeUndefined()
    expect(await scaffold.ctx.credentials.readRecord(deviceKey)).toEqual(device)
    expect(await scaffold.ctx.credentials.readRecord(otherKey)).toEqual(other)
    expect(await scaffold.ctx.credentials.describe(apiKeyRef)).toEqual(savedApiKeyInfo)
    expect((await scaffold.ctx.credentials.resolve(apiKeyRef))?.value).toBe('unrelated-fixture-api-key')
    expect(preferences()).toEqual(savedPreferences)
    const remainingFiles = await profileFiles()
    expect(remainingFiles.settings).toBe(savedFiles.settings)
    expect(remainingFiles.sessions).toEqual(savedFiles.sessions)
    await closeSettings(settings)
    const disconnectedFiles = await profileFiles()
    await page.close()
    page = await desktopPage()
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await accountFreeApp()
    expect(preferences()).toEqual(savedPreferences)
    expect(await profileFiles()).toEqual(disconnectedFiles)
    expect(authorizationStarts).toBe(0)
    await page.close()
  })

  it('returns from an optional connection failure to the existing API-key editor without writes', async () => {
    await scaffold.ctx.credentials.deleteRecord(credentialKey('deepseek-account-platform', 'default'))
    authorizationOffline = true
    const savedPreferences = preferences()
    const savedFiles = await profileFiles()
    page = await desktopPage()
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await accountFreeApp()
    const { settings, connection } = await settingsModels()
    await connection.getByRole('button', { name: '连接 DeepSeek', exact: true }).click()
    const failed = page.getByRole('dialog', { name: '登录失败', exact: true })
    await failed.waitFor()
    await failed.getByRole('button', { name: '关闭', exact: true }).click()
    await failed.waitFor({ state: 'detached' })
    const apiKey = settings.getByLabel('API 密钥', { exact: true })
    await apiKey.waitFor()
    await apiKey.fill('cancelled-fixture-api-key')
    const editor = apiKey.locator('xpath=ancestor::li[1]')
    await editor.getByRole('button', { name: '取消', exact: true }).click()
    expect(authorizationStarts).toBe(1)
    await closeSettings(settings)
    expect(preferences()).toEqual(savedPreferences)
    expect(await profileFiles()).toEqual(savedFiles)
    expect(tripwire.pageErrors).toEqual([])
    await page.close()
  })
})
