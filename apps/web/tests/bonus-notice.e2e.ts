// Real-composition acceptance for the user-side bonus notice. The scaffold boots the
// shipped Web Loader tree, so the real account provider issues the bonus HTTP requests
// and the real client renders the card in a real Chromium. The loopback Platform double
// is the observation point: the scenario asserts what the product sent and what the user
// could read on screen.
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  launchWebScaffold, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { openSettings, saveFailureShot } from './support.ts'
import { webProductCopy } from './branding.ts'

const OVERLAY_TEMPLATE = fileURLToPath(new URL('./fixtures/bonus-notice/cordis.patch.yml', import.meta.url))
const MODE = webSnapshotMode()

const TOKEN = 'dsh_bonus_notice_test'
const ACCOUNT_ID = 'bonus-user'
const ORDER_STALE_STARTUP = '11111111-1111-4111-8111-111111111111'
const ORDER_FIRST = '22222222-2222-4222-8222-222222222222'
const ORDER_LATER = '33333333-3333-4333-8333-333333333333'
const ORDER_EN = '44444444-4444-4444-8444-444444444444'
const ORDER_RETRY = '55555555-5555-4555-8555-555555555555'
const ORDER_REPEAT = '66666666-6666-4666-8666-666666666666'
const ORDER_TOPUP = '77777777-7777-4777-8777-777777777777'
const ORDER_HELD = '88888888-8888-4888-8888-888888888888'

const CLAIM_DAYS = 30

/** Eligibility window the double reports; the card renders no date. */
function expiresAt(): string {
  return new Date(Date.now() + CLAIM_DAYS * 86_400_000).toISOString()
}

interface Granted {
  readonly orderId: string
  readonly amount: string
  readonly zh_CN: string
  readonly en_US: string
}

interface GetRecord {
  readonly locale: string | undefined
  readonly query: string
}

interface AckRecord {
  readonly method: string
  readonly path: string
  readonly locale: string | undefined
  readonly orderId: string | null
  readonly body: string
  readonly query: string
  readonly contentType: string | undefined
  /** Monotonic arrival time, so the backoff gap cannot be distorted by a wall-clock jump. */
  readonly at: number
}

/** Loopback Platform double: auth gate, profile, wallets, unnotified bonuses, and the acknowledgement. */
async function mockPlatform() {
  const unnotified: Granted[] = []
  const gets: GetRecord[] = []
  /** Reads already answered; a request the client is still awaiting is not evidence of a delivered response. */
  const served: GetRecord[] = []
  const acks: AckRecord[] = []
  /** Wallet reads, one per balance refresh the settings panel performs. */
  const summaries: GetRecord[] = []
  let normalBalance = '12.34'
  let bonusBalance = '5.00'
  /** Order whose acknowledgement attempts the double fails, and how many failures it still owes. */
  let ackFailure: { orderId: string; remaining: number } | undefined
  /** Whether an acknowledged order stays unnotified, as a backend that has not applied the acknowledgement would serve it. */
  let keepUnnotified = false
  /** Refuse the wallet read, which is how a Platform outage or an unparsable payload reaches the client. */
  let failSummary = false
  /** Replies held back while the test controls when reads can answer. */
  const heldReplies: (() => void)[] = []
  let holdNextRead = false
  const grant = (orderId: string, amount: string): void => {
    unnotified.unshift({
      orderId, amount,
      zh_CN: `已赠送您 ${amount} 元 DSH 体验赠金。`,
      en_US: `You received a CNY ${amount} DSH trial credit.`,
    })
  }
  /** @param value - granted bonus. @param locale - request language. @returns its wire fields. */
  const wire = (value: Granted, locale: string | undefined): unknown => ({
    order_id: value.orderId, campaign: 'dsh_login_bonus', amount: value.amount, currency: 'CNY',
    granted_at: new Date().toISOString(), expires_at: expiresAt(),
    msg: locale === 'en_US' ? value.en_US : value.zh_CN,
  })
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const header = req.headers['x-client-locale']
    const locale = typeof header === 'string' ? header : undefined
    const reply = (payload: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (req.headers['x-dsh-auth-token'] !== TOKEN) { res.writeHead(401).end(); return }
    if (url.pathname === '/auth-api/v0/users/current') {
      // `email` is required by the provider's profile schema even when the account has none.
      reply({ code: 0, data: { biz_code: 0, biz_data: {
        id: ACCOUNT_ID, email: '', id_profile: { name: 'Bonus User', picture: null },
      } } })
      return
    }
    if (url.pathname === '/api/v0/users/get_user_summary') {
      summaries.push({ locale, query: url.search })
      if (failSummary) { res.writeHead(500, { 'content-type': 'text/plain' }).end('Internal Server Error'); return }
      reply({ code: 0, data: { biz_code: 0, biz_data: {
        normal_wallets: [{ currency: 'CNY', balance: normalBalance }],
        bonus_wallets: [{ currency: 'CNY', balance: bonusBalance }],
      } } })
      return
    }
    if (url.pathname === '/api/v0/users/get_unnotified_bonuses') {
      const record = { locale, query: url.search }
      gets.push(record)
      const payload = { code: 0, data: { biz_code: 0, biz_data: unnotified.map(value => wire(value, locale)) } }
      const answer = (): void => { served.push(record); reply(payload) }
      if (holdNextRead) {
        holdNextRead = false
        heldReplies.push(answer)
      } else answer()
      return
    }
    if (url.pathname === '/api/v0/users/ack_bonus_notified' && req.method === 'POST') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        const payload: unknown = JSON.parse(body)
        const orderId = typeof payload === 'object' && payload !== null && 'order_id' in payload
          && typeof payload.order_id === 'string' ? payload.order_id : null
        acks.push({ method: req.method ?? '', path: url.pathname, locale, orderId, body,
          query: url.search, contentType: req.headers['content-type'], at: performance.now() })
        if (ackFailure !== undefined && ackFailure.orderId === orderId && ackFailure.remaining > 0) {
          ackFailure.remaining--
          // A transient gateway failure: the client retries it after its backoff.
          res.writeHead(502, { 'content-type': 'text/plain' }).end('Internal Server Error')
          return
        }
        if (orderId === null) {
          reply({ code: 0, msg: '', data: { biz_code: 1, biz_msg: 'BONUS_ORDER_NOT_FOUND', biz_data: null } }); return
        }
        const index = unnotified.findIndex(value => value.orderId === orderId)
        if (index >= 0 && !keepUnnotified) unnotified.splice(index, 1)
        reply({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: null } })
      })
      return
    }
    if (url.pathname === '/auth-api/v0/users/logout') { reply({ code: 0, data: { biz_code: 0, biz_data: null } }); return }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('bonus notice: missing mock listener')
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    grant, gets, served, acks, summaries,
    /** @param value - recharge balance the settings page reads next. */
    setNormalBalance: (value: string): void => { normalBalance = value },
    /** @param value - bonus balance the settings page reads next. */
    setBonusBalance: (value: string): void => { bonusBalance = value },
    /** @param value - whether the wallet read fails. */
    setFailSummary: (value: boolean): void => { failSummary = value },
    /** Drop every unnotified grant, so a later scenario starts from a server with nothing to show. */
    clearUnnotified: (): void => { unnotified.length = 0 },
    /** @param value - whether acknowledged orders keep arriving in the unnotified read. */
    setKeepUnnotified: (value: boolean): void => { keepUnnotified = value },
    /** @param orderId - order to refuse. @param count - its acknowledgement attempts that fail before one succeeds. */
    failNextAcks: (orderId: string, count: number): void => { ackFailure = { orderId, remaining: count } },
    /** Hold the next unnotified-bonus read so the test can observe the in-flight state. */
    holdNextGet: (): void => { holdNextRead = true },
    /** @param index - held reply to release, allowing a newer read to answer before a stale one. */
    releaseGet: (index = 0): void => {
      const held = heldReplies.splice(index, 1)[0]
      if (held === undefined) holdNextRead = false
      held?.()
    },
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }),
  }
}

/** @param page - page under test. @param locale - GUI language. @returns the Models provider connection region. */
function connectionCard(page: Page, locale: 'en' | 'zh' = 'zh'): Locator {
  return page.getByRole('region', { name: locale === 'zh' ? 'DeepSeek 连接' : 'DeepSeek connection', exact: true })
}

/** @param page - page under test. @param locale - GUI language. @returns rendered notices inside the provider connection. */
function noticeCards(page: Page, locale: 'en' | 'zh' = 'zh'): Locator {
  return connectionCard(page, locale).locator('aside').filter({ hasText: locale === 'zh' ? '赠金已到账' : 'Bonus credited' })
}

/** @param page - page under test. @returns every rendered notice, including any unintended global card. */
function allNoticeCards(page: Page): Locator {
  return page.locator('aside').filter({ hasText: /赠金已到账|Bonus credited/ })
}

/**
 * @param page - page under test. @param settings - open Settings panel.
 * @param locale - GUI language. @returns after the provider card mounts.
 */
async function selectModels(page: Page, settings: Locator, locale: 'en' | 'zh' = 'zh'): Promise<void> {
  const models = settings.locator('nav').getByRole('button', { name: locale === 'zh' ? '模型' : 'Models', exact: true })
  await models.click()
  await expect.poll(() => models.getAttribute('aria-current'), { timeout: 30_000 }).toBe('true')
  await connectionCard(page, locale).waitFor({ state: 'visible', timeout: 30_000 })
}

/** @param page - page under test. @param locale - GUI language. @returns Settings with the Models provider card mounted. */
async function openModels(page: Page, locale: 'en' | 'zh' = 'zh'): Promise<Locator> {
  await openSettings(page, locale)
  const settings = page.getByRole('dialog', { name: locale === 'zh' ? '设置' : 'Settings', exact: true })
  await settings.waitFor()
  await selectModels(page, settings, locale)
  return settings
}

/**
 * @param page - page under test. @param settings - open Settings panel.
 * @param locale - GUI language. @returns after provider notices unmount.
 */
async function closeSettings(page: Page, settings: Locator, locale: 'en' | 'zh' = 'zh'): Promise<void> {
  await page.keyboard.press('Escape')
  await settings.waitFor({ state: 'detached', timeout: 30_000 })
  expect(await allNoticeCards(page).count()).toBe(0)
  const trigger = page.getByRole('button', { name: locale === 'zh' ? '设置' : 'Settings', exact: true })
  await expect.poll(() => trigger.evaluate(element => element === document.activeElement), { timeout: 30_000 }).toBe(true)
}

/** @param card - a rendered notice card. @returns its non-empty visible lines. */
async function cardText(card: Locator): Promise<string> {
  return (await card.innerText()).split('\n').map(line => line.trim()).filter(line => line !== '').join(' / ')
}

/** Wait for the card carrying this copy, then return the text the user could read from it. */
async function shownNotice(page: Page, copy: string): Promise<string> {
  const card = noticeCards(page).filter({ hasText: copy })
  await card.waitFor({ state: 'visible', timeout: 30_000 })
  await card.scrollIntoViewIfNeeded()
  return cardText(card)
}

/**
 * @param page - renderer receiving a bonus read. @param response - delivered read.
 * @returns after RPC delivery and its next presented frame's task.
 */
async function settleBonusResponse(page: Page, response: Awaited<ReturnType<Page['waitForResponse']>>): Promise<void> {
  expect(response.status()).toBe(200)
  expect(await response.finished()).toBeNull()
  // Network completion alone does not prove that the response's callbacks have
  // published the notice or that its display effect had a chance to run.
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { setTimeout(resolve, 0) })
    })
  }))
}

/** @param page - renderer receiving the read. @returns the next bonus RPC response, registered before its release. */
function nextBonusResponse(page: Page): ReturnType<Page['waitForResponse']> {
  return page.waitForResponse(response => new URL(response.url()).pathname === '/api/account/getUnnotifiedBonuses')
}

/** @param page - renderer under test. @returns after Models returns to the beginning of its scroll viewport. */
async function scrollModelsToStart(page: Page): Promise<void> {
  await connectionCard(page).evaluate((element) => {
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
      if (['auto', 'scroll'].includes(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) {
        parent.scrollTop = 0
        return
      }
    }
    throw new Error('bonus notice: Models has no scrolling viewport')
  })
}

/** @param card - mounted notice. @returns the browser's measured fraction within all scroll clips. */
async function intersectionRatio(card: Locator): Promise<number> {
  return card.evaluate(element => new Promise<number>((resolve) => {
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.find(value => value.target === element)
      if (entry === undefined) return
      observer.disconnect()
      resolve(entry.intersectionRatio)
    }, { threshold: 1 })
    observer.observe(element)
  }))
}

/** Wait for the double to answer this many acknowledgements, then return the order ids in arrival order. */
async function acked(platform: { acks: AckRecord[] }, count: number): Promise<string> {
  await expect.poll(() => platform.acks.length, { timeout: 30_000 }).toBe(count)
  return platform.acks.map(item => String(item.orderId)).join(',')
}

/**
 * Native Platform bridge calls recorded in one page. `setBounds` is resize-driven and is
 * deliberately not recorded, so the calls here are the opens and closes a user caused.
 * @param page - page under test.
 * @returns the recorded call log in order.
 */
async function platformCalls(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => (globalThis as typeof globalThis & { __bonusPlatformCalls?: readonly string[] })
    .__bonusPlatformCalls ?? [])
}

describe.skipIf(MODE === 'record')('web e2e: bonus notice', () => {
  let root: string | undefined
  let scaffold: WebScaffold
  let browser: Browser
  let platform: Awaited<ReturnType<typeof mockPlatform>>
  const tripwires: ReturnType<typeof watchConsole>[] = []

  /** @param locale - browser language driving the requested notice locale. @returns a desktop-renderer page. */
  const openDesktopPage = async (locale: string): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale })
    const opened = await context.newPage()
    tripwires.push(watchConsole(opened))
    await opened.addInitScript(() => {
      Object.defineProperty(globalThis, 'dshDesktop', { value: { protocolVersion: 1 } })
      // The embedded Platform view is a native child window owned by the Desktop shell.
      // The double answers immediately and records the calls, so the scenario observes
      // which page was opened and that returning destroyed the view.
      const calls: string[] = []
      Object.defineProperty(globalThis, '__bonusPlatformCalls', { value: calls })
      Object.defineProperty(globalThis, 'dshPlatform', {
        value: {
          open: (page: string) => { calls.push(`open:${page}`); return Promise.resolve() },
          setBounds: () => Promise.resolve(),
          close: () => { calls.push('close'); return Promise.resolve() },
        },
      })
    })
    return opened
  }

  beforeAll(async () => {
    platform = await mockPlatform()
    platform.grant(ORDER_STALE_STARTUP, '3.00')
    root = await mkdtemp(join(tmpdir(), 'dsh-bonus-notice-'))
    const home = join(root, 'home')
    await mkdir(home, { recursive: true })
    // A stored grant bound to the double's origin starts the account credential-stored
    // without driving the browser sign-in flow.
    await writeFile(join(home, '.credentials.yaml'),
      `version: 1\nrefs: {}\nrecords:\n  deepseek-account-platform/default:\n    kind: grant\n    payload:\n      version: 1\n      token: ${TOKEN}\n      issuer: ${platform.origin}\n`,
      { mode: 0o600 })
    const overlay = join(root, 'bonus-notice.overlay.yml')
    await writeFile(overlay, (await readFile(OVERLAY_TEMPLATE, 'utf8')).replaceAll('{{origin}}', platform.origin))
    scaffold = await launchWebScaffold({ harnessHome: home, extraOverlayPath: overlay })
    // Resolve the signed-in identity before opening the renderer. First profile discovery
    // emits another account frame, which would supersede the held startup bonus read.
    expect(await scaffold.ctx.deepseekAccount.getProfile({
      version: 'test', locale: 'zh-CN', timezoneOffsetSeconds: 28_800,
    })).toMatchObject({ status: 'ready', value: { id: ACCOUNT_ID } })
    browser = await chromium.launch()
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await platform?.close()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })

  it('acknowledges only notices displayed in Models, refreshes on provider entry, and localizes the request', async () => {
    const zhFirst = '已赠送您 5.00 元 DSH 体验赠金。'
    const zhLater = '已赠送您 8.00 元 DSH 体验赠金。'
    const enBonus = 'You received a CNY 9.00 DSH trial credit.'
    const page = await openDesktopPage('zh-CN')
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bonus-notice'))
    // Observe initiation as well as Platform arrival: a queued network request
    // must not make an unseen acknowledgment pass the negative assertions.
    const ackRequests: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/account/ackBonusNotified') ackRequests.push(request.postData() ?? '')
    })
    /** @returns every browser storage key, so a baseline can be taken before a notice shows. */
    const storageKeys = (): Promise<string[]> => page.evaluate(() => Object.keys(localStorage).sort())

    // Startup may read a stored grant's notice, but no provider card has displayed it.
    platform.holdNextGet()
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await expect.poll(() => platform.gets.length, { timeout: 30_000 }).toBe(1)
    await expect.poll(() => platform.summaries.length, { timeout: 30_000 }).toBe(1)
    expect(await allNoticeCards(page).count()).toBe(0)
    expect(platform.acks).toEqual([])
    expect(await page.getByRole('button', { name: '账号菜单', exact: true }).count()).toBe(0)

    // An ordinary Settings entry mounts no provider and performs no account refresh.
    const ordinaryGetsBefore = platform.gets.length
    const ordinarySummariesBefore = platform.summaries.length
    await openSettings(page, 'zh')
    const initialSettings = page.getByRole('dialog', { name: '设置', exact: true })
    await initialSettings.waitFor()
    expect(await initialSettings.locator('nav').getByRole('button', { name: '账号与余额', exact: true }).count()).toBe(0)
    expect(await connectionCard(page).count()).toBe(0)
    expect(platform.gets.length).toBe(ordinaryGetsBefore)
    expect(platform.summaries.length).toBe(ordinarySummariesBefore)
    expect(await allNoticeCards(page).count()).toBe(0)
    expect(platform.acks).toEqual([])

    // A newer provider read replaces the stale startup batch, even when it answers first.
    platform.clearUnnotified()
    platform.grant(ORDER_FIRST, '5.00')
    await page.setViewportSize({ width: 1440, height: 480 })
    platform.holdNextGet()
    await selectModels(page, initialSettings)
    await expect.poll(() => platform.gets.length, { timeout: 30_000 }).toBe(2)
    await scrollModelsToStart(page)
    expect(await allNoticeCards(page).count()).toBe(0)
    expect(platform.acks).toEqual([])
    const firstDelivered = nextBonusResponse(page)
    platform.releaseGet(1)
    await settleBonusResponse(page, await firstDelivered)
    const firstCard = noticeCards(page).filter({ hasText: zhFirst })
    await firstCard.waitFor({ state: 'visible', timeout: 30_000 })
    // Mounting below the Models viewport does not constitute a display.
    expect(await intersectionRatio(firstCard)).toBe(0)
    expect(platform.acks).toEqual([])
    expect(ackRequests).toEqual([])
    expect(await shownNotice(page, zhFirst)).toBe(`赠金已到账 / ${zhFirst}`)
    expect(await acked(platform, 1)).toBe(ORDER_FIRST)
    const get = platform.gets[1]!
    const ack = platform.acks[0]!
    expect(get.locale).toBe('zh_CN')
    expect(get.query).toBe('')
    expect(ack).toMatchObject({
      method: 'POST', path: '/api/v0/users/ack_bonus_notified', locale: 'zh_CN', orderId: ORDER_FIRST,
      body: JSON.stringify({ order_id: ORDER_FIRST }), query: '', contentType: 'application/json',
    })
    const staleDelivered = nextBonusResponse(page)
    platform.releaseGet()
    await settleBonusResponse(page, await staleDelivered)
    await expect.poll(() => platform.served.length, { timeout: 30_000 }).toBe(2)
    expect(await allNoticeCards(page).count()).toBe(1)
    expect(await cardText(noticeCards(page))).toBe(`赠金已到账 / ${zhFirst}`)
    expect(await allNoticeCards(page).filter({ hasText: '已赠送您 3.00 元 DSH 体验赠金。' }).count()).toBe(0)
    expect(platform.acks.filter(item => item.orderId === ORDER_STALE_STARTUP)).toEqual([])
    expect(ackRequests.filter(body => body.includes(ORDER_STALE_STARTUP))).toEqual([])
    expect(platform.acks).toHaveLength(1)
    await page.setViewportSize({ width: 1440, height: 960 })
    await noticeCards(page).getByRole('button', { name: '关闭', exact: true }).click()
    expect(await allNoticeCards(page).count()).toBe(0)
    expect(platform.acks).toHaveLength(1)
    await closeSettings(page, initialSettings)

    // A new grant is refreshed once when the provider card mounts, not when Settings opens.
    platform.grant(ORDER_LATER, '8.00')
    platform.setBonusBalance('13.00')
    const getsBefore = platform.gets.length
    const summariesBefore = platform.summaries.length
    platform.holdNextGet()
    await openSettings(page, 'zh')
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.waitFor()
    expect(platform.gets.length).toBe(getsBefore)
    expect(platform.summaries.length).toBe(summariesBefore)
    expect(await allNoticeCards(page).count()).toBe(0)
    expect(platform.acks).toHaveLength(1)
    await selectModels(page, settings)
    await expect.poll(() => platform.gets.length, { timeout: 30_000 }).toBe(getsBefore + 1)
    await expect.poll(() => platform.summaries.length, { timeout: 30_000 }).toBe(summariesBefore + 1)
    expect(await connectionCard(page).getByRole('button', { name: '刷新余额', exact: true }).count()).toBe(0)
    expect(await allNoticeCards(page).count()).toBe(0)
    platform.releaseGet()
    expect(await shownNotice(page, zhLater)).toBe(`赠金已到账 / ${zhLater}`)
    expect(await acked(platform, 2)).toBe([ORDER_FIRST, ORDER_LATER].join(','))
    const notice = noticeCards(page).filter({ hasText: zhLater })
    await notice.scrollIntoViewIfNeeded()
    const paintedInProvider = await notice.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return hit !== null && element.contains(hit) && element.closest('[role="dialog"]') !== null
    })
    expect(paintedInProvider).toBe(true)
    await expect.poll(async () => (await connectionCard(page).textContent()) ?? '', { timeout: 30_000 }).toContain('¥13.00')
    expect(platform.gets.length).toBe(getsBefore + 1)
    const openGet = platform.served.at(-1)!
    const panel = (await connectionCard(page).textContent()) ?? ''
    const usage = await connectionCard(page).getByRole('link', { name: '查询用量', exact: true }).getAttribute('href')
    expect(openGet.locale).toBe('zh_CN')
    expect(openGet.query).toBe('')
    expect(panel).toContain('赠金余额')
    expect(panel).toContain('¥13.00')
    expect(panel).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(usage).toBe(`${platform.origin}/usage`)
    expect(await allNoticeCards(page).count()).toBe(1)
    await noticeCards(page).getByRole('button', { name: '关闭', exact: true }).click()
    expect(await allNoticeCards(page).count()).toBe(0)
    expect(platform.acks).toHaveLength(2)
    await closeSettings(page, settings)

    // Provider re-entry refreshes once. General entry and navigation perform no account reads.
    const reopenGetsBefore = platform.gets.length
    const reopenSummariesBefore = platform.summaries.length
    await openSettings(page, 'zh')
    const reopened = page.getByRole('dialog', { name: '设置', exact: true })
    await reopened.waitFor()
    expect(platform.gets.length).toBe(reopenGetsBefore)
    expect(platform.summaries.length).toBe(reopenSummariesBefore)
    await selectModels(page, reopened)
    await expect.poll(() => platform.gets.length, { timeout: 30_000 }).toBe(reopenGetsBefore + 1)
    await expect.poll(() => platform.summaries.length, { timeout: 30_000 }).toBe(reopenSummariesBefore + 1)
    const sectionGetsBefore = platform.gets.length
    const sectionSummariesBefore = platform.summaries.length
    const nav = reopened.locator('nav')
    await nav.getByRole('button', { name: '通用设置', exact: true }).click()
    await expect.poll(() => nav.getByRole('button', { name: '通用设置', exact: true }).getAttribute('aria-current'), { timeout: 30_000 }).toBe('true')
    expect(await connectionCard(page).count()).toBe(0)
    expect(await allNoticeCards(page).count()).toBe(0)
    expect(platform.gets.length).toBe(sectionGetsBefore)
    expect(platform.summaries.length).toBe(sectionSummariesBefore)
    platform.holdNextGet()
    await selectModels(page, reopened)
    await expect.poll(() => platform.gets.length, { timeout: 30_000 }).toBe(sectionGetsBefore + 1)
    await expect.poll(() => platform.summaries.length, { timeout: 30_000 }).toBe(sectionSummariesBefore + 1)
    platform.releaseGet()
    await expect.poll(async () => (await connectionCard(page).textContent()) ?? '', { timeout: 30_000 }).toContain('¥13.00')
    expect(platform.acks).toHaveLength(2)
    await closeSettings(page, reopened)

    // A response arriving after the provider closes cannot acknowledge an unseen notice.
    const zhHeld = '已赠送您 4.00 元 DSH 体验赠金。'
    platform.grant(ORDER_HELD, '4.00')
    const heldGetsBefore = platform.gets.length
    const heldServedBefore = platform.served.length
    const heldAttempts = (): AckRecord[] => platform.acks.filter(item => item.orderId === ORDER_HELD)
    platform.holdNextGet()
    const heldSettings = await openModels(page)
    await expect.poll(() => platform.gets.length, { timeout: 30_000 }).toBe(heldGetsBefore + 1)
    expect(await allNoticeCards(page).count()).toBe(0)
    await closeSettings(page, heldSettings)
    const hiddenDelivered = nextBonusResponse(page)
    platform.releaseGet()
    await settleBonusResponse(page, await hiddenDelivered)
    await expect.poll(() => platform.served.length, { timeout: 30_000 }).toBe(heldServedBefore + 1)
    expect(heldAttempts()).toEqual([])
    expect(ackRequests.filter(body => body.includes(ORDER_HELD))).toEqual([])
    expect(await allNoticeCards(page).count()).toBe(0)
    const heldReturnSettings = await openModels(page)
    expect(await shownNotice(page, zhHeld)).toBe(`赠金已到账 / ${zhHeld}`)
    await expect.poll(() => heldAttempts().length, { timeout: 30_000 }).toBe(1)
    await noticeCards(page).getByRole('button', { name: '关闭', exact: true }).click()
    await closeSettings(page, heldReturnSettings)

    // Returning from the native top-up view refreshes both wallets and notice once.
    const zhTopUp = '已赠送您 11.00 元 DSH 体验赠金。'
    const topUpGetsBefore = platform.gets.length
    const topUpSummariesBefore = platform.summaries.length
    const topUpSettings = await openModels(page)
    await expect.poll(() => platform.gets.length, { timeout: 30_000 }).toBe(topUpGetsBefore + 1)
    await expect.poll(() => platform.summaries.length, { timeout: 30_000 }).toBe(topUpSummariesBefore + 1)
    const callsBefore = (await platformCalls(page)).length
    const topUpLink = connectionCard(page).getByRole('link', { name: '充值', exact: true })
    expect(await topUpLink.getAttribute('href')).toBe(`${platform.origin}/top_up`)
    await topUpLink.click()
    const topUpOverlay = page.getByRole('dialog', { name: webProductCopy('返回 Y Harness'), exact: true })
    await topUpOverlay.waitFor()
    expect(platform.gets.length).toBe(topUpGetsBefore + 1)
    expect(platform.summaries.length).toBe(topUpSummariesBefore + 1)
    platform.setNormalBalance('0E-16')
    platform.setBonusBalance('2.4E+1')
    platform.grant(ORDER_TOPUP, '11.00')
    platform.holdNextGet()
    await topUpOverlay.getByRole('button', { name: webProductCopy('返回 Y Harness'), exact: true }).click()
    await topUpOverlay.waitFor({ state: 'detached', timeout: 30_000 })
    await expect.poll(() => platform.gets.length, { timeout: 30_000 }).toBe(topUpGetsBefore + 2)
    const topUpCalls = (await platformCalls(page)).slice(callsBefore).join(',')
    expect(topUpCalls).toBe('open:top-up,close')
    expect(await allNoticeCards(page).count()).toBe(0)
    platform.releaseGet()
    expect(await shownNotice(page, zhTopUp)).toBe(`赠金已到账 / ${zhTopUp}`)
    const topUpAttempts = (): AckRecord[] => platform.acks.filter(item => item.orderId === ORDER_TOPUP)
    await expect.poll(() => topUpAttempts().length, { timeout: 30_000 }).toBe(1)
    await expect.poll(() => platform.gets.length, { timeout: 30_000 }).toBe(topUpGetsBefore + 2)
    await expect.poll(() => platform.summaries.length, { timeout: 30_000 }).toBe(topUpSummariesBefore + 2)
    await expect.poll(async () => (await connectionCard(page).textContent()) ?? '', { timeout: 30_000 }).toContain('¥0.00')
    await expect.poll(async () => (await connectionCard(page).textContent()) ?? '', { timeout: 30_000 }).toContain('¥24.00')
    const topUpPanel = (await connectionCard(page).textContent()) ?? ''
    const topUpAmounts = { recharge: topUpPanel.includes('¥0.00'), bonus: topUpPanel.includes('¥24.00') }
    expect(topUpAmounts).toEqual({ recharge: true, bonus: true })
    expect(await connectionCard(page).getByRole('button', { name: '刷新余额', exact: true }).count()).toBe(0)
    await closeSettings(page, topUpSettings)
    expect(topUpAttempts()).toHaveLength(1)

    // A transient acknowledgement failure retries the same displayed order after backoff.
    const zhRetry = '已赠送您 6.00 元 DSH 体验赠金。'
    platform.grant(ORDER_RETRY, '6.00')
    platform.failNextAcks(ORDER_RETRY, 1)
    const retryDialog = await openModels(page)
    expect(await shownNotice(page, zhRetry)).toBe(`赠金已到账 / ${zhRetry}`)
    const retryAttempts = (): AckRecord[] => platform.acks.filter(item => item.orderId === ORDER_RETRY)
    await expect.poll(() => retryAttempts().length, { timeout: 30_000 }).toBe(1)
    expect(await allNoticeCards(page).count()).toBe(1)
    await expect.poll(() => retryAttempts().length, { timeout: 30_000 }).toBe(2)
    const attempts = retryAttempts()
    const retryGapMs = attempts[1]!.at - attempts[0]!.at
    const retryBodyKept = attempts.every(item => item.body === JSON.stringify({ order_id: ORDER_RETRY })
      && item.query === '' && item.contentType === 'application/json')
    expect(retryGapMs).toBeGreaterThanOrEqual(900)
    expect(retryBodyKept).toBe(true)
    await noticeCards(page).getByRole('button', { name: '关闭', exact: true }).click()
    await closeSettings(page, retryDialog)

    // Server-offered orders may display again, but restart alone never displays or acknowledges.
    const zhRepeat = '已赠送您 7.00 元 DSH 体验赠金。'
    const storedBeforeShown = await storageKeys()
    platform.setKeepUnnotified(true)
    platform.grant(ORDER_REPEAT, '7.00')
    const repeatAttempts = (): AckRecord[] => platform.acks.filter(item => item.orderId === ORDER_REPEAT)
    const repeatDialog = await openModels(page)
    expect(await shownNotice(page, zhRepeat)).toBe(`赠金已到账 / ${zhRepeat}`)
    await expect.poll(() => repeatAttempts().length, { timeout: 30_000 }).toBe(1)
    await noticeCards(page).getByRole('button', { name: '关闭', exact: true }).click()
    await closeSettings(page, repeatDialog)
    const shownAdded = (await storageKeys()).filter(key => !storedBeforeShown.includes(key))
    expect(shownAdded).toEqual([])
    const reloadServedBefore = platform.served.length
    const reloadDelivered = nextBonusResponse(page)
    await page.reload({ waitUntil: 'load' })
    await settleBonusResponse(page, await reloadDelivered)
    await expect.poll(() => platform.served.length, { timeout: 30_000 }).toBe(reloadServedBefore + 1)
    expect(await allNoticeCards(page).count()).toBe(0)
    expect(repeatAttempts()).toHaveLength(1)
    const repeatReloadDialog = await openModels(page)
    expect(await shownNotice(page, zhRepeat)).toBe(`赠金已到账 / ${zhRepeat}`)
    await expect.poll(() => repeatAttempts().length, { timeout: 30_000 }).toBe(2)
    const reloadAdded = (await storageKeys()).filter(key => !storedBeforeShown.includes(key))
    expect(reloadAdded).toEqual([])
    await noticeCards(page).getByRole('button', { name: '关闭', exact: true }).click()
    await closeSettings(page, repeatReloadDialog)

    // Failed wallet reads retain both links to the configured Platform origin.
    platform.setKeepUnnotified(false)
    platform.clearUnnotified()
    platform.setFailSummary(true)
    const failedGetsBefore = platform.gets.length
    const failedSummariesBefore = platform.summaries.length
    const failedUsagesBefore = (await platformCalls(page)).filter(call => call === 'open:usage').length
    const failedSettings = await openModels(page)
    const failedLinks = connectionCard(page).getByRole('link', { name: '前往开放平台查看', exact: true })
    await expect.poll(() => failedLinks.count(), { timeout: 30_000 }).toBe(2)
    await expect.poll(() => platform.summaries.length, { timeout: 30_000 }).toBe(failedSummariesBefore + 1)
    const failedHrefs = (await failedLinks.evaluateAll(nodes => nodes.map(node => node.getAttribute('href'))))
      .map(href => String(href).replace(platform.origin, '{{origin}}'))
    expect(failedHrefs).toEqual(['{{origin}}/usage', '{{origin}}/usage'])
    for (const index of [0, 1]) {
      await failedLinks.nth(index).click()
      const usageOverlay = page.getByRole('dialog', { name: webProductCopy('返回 Y Harness'), exact: true })
      await usageOverlay.waitFor()
      await usageOverlay.getByRole('button', { name: webProductCopy('返回 Y Harness'), exact: true }).click()
      await usageOverlay.waitFor({ state: 'detached', timeout: 30_000 })
    }
    const failedUsages = (await platformCalls(page)).filter(call => call === 'open:usage').length - failedUsagesBefore
    expect(failedUsages).toBe(2)
    expect(platform.gets.length).toBe(failedGetsBefore + 1)
    expect(platform.summaries.length).toBe(failedSummariesBefore + 1)
    platform.setFailSummary(false)
    await closeSettings(page, failedSettings)
    await page.close()

    // Another language receives server-localized copy only after opening the provider.
    platform.grant(ORDER_EN, '9.00')
    const enPage = await openDesktopPage('en-US')
    const enStartupDelivered = nextBonusResponse(enPage)
    await enPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await settleBonusResponse(enPage, await enStartupDelivered)
    await expect.poll(() => platform.served.some(entry => entry.locale === 'en_US'), { timeout: 30_000 }).toBe(true)
    expect(await allNoticeCards(enPage).count()).toBe(0)
    expect(platform.acks.filter(item => item.orderId === ORDER_EN)).toEqual([])
    await openModels(enPage, 'en')
    const enCard = noticeCards(enPage, 'en').filter({ hasText: enBonus })
    await enCard.waitFor({ state: 'visible', timeout: 30_000 })
    await enCard.scrollIntoViewIfNeeded()
    expect(await cardText(enCard)).toBe(`Bonus credited / ${enBonus}`)
    await expect.poll(() => platform.acks.filter(item => item.orderId === ORDER_EN).length, { timeout: 30_000 }).toBe(1)
    const enGet = platform.gets.find(entry => entry.locale === 'en_US')!
    expect(enGet.locale).toBe('en_US')
    expect(enGet.query).toBe('')

    for (const tripwire of tripwires) {
      expect(tripwire.warnings).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
    }
  }, 180_000)
})
