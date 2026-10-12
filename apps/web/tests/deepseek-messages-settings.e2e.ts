/** Web DeepSeek configuration, credential reuse, and saved model selection. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { openSettings, connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/deepseek-messages-settings/', import.meta.url))

describe.skipIf(webSnapshotMode() === 'record')('web e2e: DeepSeek Messages settings', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ deepSeekMissingCredential: true })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      await scaffold?.close()
    }
  })

  it('offers one DeepSeek card and saves Messages settings using the existing credential reference', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-deepseek-messages-settings'))
    expect(scaffold.ctx.llm.listProviders()).toContainEqual(expect.objectContaining({ id: 'deepseek-official', name: 'DeepSeek' }))
    expect(scaffold.ctx.llm.listProviders().filter(provider => provider.id === 'deepseek-official')).toHaveLength(1)
    expect(scaffold.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
    const advisory = page.getByRole('dialog', { name: '连接 DeepSeek API', exact: true })
    await advisory.getByRole('button', { name: '稍后配置', exact: true }).click()
    await advisory.waitFor({ state: 'detached' })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'messages-settings-e2e')
    expect(await page.locator('[data-composer-input]').first().getAttribute('contenteditable')).toBe('true')
    await openSettings(page, 'zh')
    const dialog = page.getByRole('dialog', { name: '设置', exact: true })
    await dialog.getByRole('button', { name: '模型', exact: true }).click()
    await dialog.getByText('DeepSeek', { exact: true }).waitFor()
    expect(await dialog.getByText('DeepSeek', { exact: true }).count()).toBe(1)
    const edit = dialog.getByText('DeepSeek', { exact: true }).locator('xpath=ancestor::li').getByRole('button', { name: '编辑' })
    await dialog.getByLabel('API 密钥', { exact: true }).fill('sk-messages-initial')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => dialog.getByLabel('API 密钥', { exact: true }).count()).toBe(0)
    await dialog.getByRole('img', { name: 'API 密钥已配置' }).waitFor()
    const credentialFile = join(scaffold.harnessHome, '.credentials.yaml')
    expect(await readFile(credentialFile, 'utf8')).toContain('DEEPSEEK_API_KEY: sk-messages-initial')
    await edit.click()
    expect(await dialog.getByLabel('API 密钥', { exact: true }).inputValue()).toBe('')
    expect(await dialog.getByLabel('API 密钥', { exact: true }).getAttribute('placeholder')).toBe('已配置——输入新值可替换')
    const messages = dialog
    await messages.getByText('自定义设置', { exact: true }).click()
    expect(await messages.getByLabel('API 地址', { exact: true }).getAttribute('placeholder'))
      .toBe('https://api.deepseek.com/anthropic')
    await compareOrRefreshGolden(join(EXPECTED, 'cards.expected.md'),
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
    await messages.getByLabel('API 密钥', { exact: true }).fill('sk-e2e-messages')
    await messages.getByLabel('API 地址', { exact: true }).fill('https://messages.example/anthropic')
    expect(await messages.getByLabel('模型 ID 1').inputValue()).toBe('deepseek-flash')
    await messages.getByLabel('显示名称 1', { exact: true }).fill('Messages Flash')
    await messages.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.getByText('已保存 DeepSeek (deepseek-official)。', { exact: true }).waitFor()

    const settings = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(settings).toContain('https://messages.example/anthropic')
    expect(settings).toContain('id: llm-deepseek')
    await expect(scaffold.ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash')).resolves.toMatchObject({
      name: 'Messages Flash', inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history',
    })
    expect(scaffold.ctx.settings.describe().find(row => row.ns === 'llm-deepseek')?.value).not.toHaveProperty('protocol')
    expect(settings).not.toContain('sk-e2e-')
    const credentials = await readFile(credentialFile, 'utf8')
    expect(credentials).toContain('DEEPSEEK_API_KEY: sk-e2e-messages')
    expect(credentials).not.toContain('sk-messages-initial')
    expect(credentials).not.toContain('DEEPSEEK_MESSAGES_API_KEY')
    expect(await page.locator('body').innerText()).not.toContain('sk-e2e-')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: /^选择模型/ }).click()
    await page.getByRole('menuitem', { name: /模型/ }).click()
    await page.getByRole('menuitemradio', { name: 'Messages Flash', exact: true }).waitFor()
    await compareOrRefreshGolden(join(EXPECTED, 'picker.expected.md'),
      await captureStableAria(page, '[role="group"][aria-label="提供方、模型、推理等级与速度"]', scaffold.workspaceCwd), webSnapshotMode())
    await page.keyboard.press('Escape')
    await page.getByRole('menuitem', { name: /推理等级/ }).click()
    const effortWeights = await page.getByRole('menuitemradio').evaluateAll(rows => rows.map(row =>
      getComputedStyle(row.querySelector('span span')!).fontWeight,
    ))
    expect(new Set(effortWeights)).toEqual(new Set(['400']))
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('selects an available DeepSeek model after provider settings remove the default', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-deepseek-messages-default'))
    await page.keyboard.press('Escape')
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    await page.reload({ waitUntil: 'load' })
    const input = page.locator('[data-composer-input]').first()
    const trigger = page.getByRole('button', { name: /^选择模型.*deepseek-v4-flash/ })
    await trigger.waitFor()
    await expect.poll(() => input.getAttribute('contenteditable')).toBe('true')
    await trigger.click()
    await page.getByRole('menuitem', { name: /模型/ }).click()
    await page.getByRole('menuitemradio', { name: 'Messages Flash', exact: true }).click()
    await expect.poll(() => input.getAttribute('contenteditable')).toBe('true')
    await expect.poll(() => scaffold.ctx.agentDefaultModel.currentSelection().provider).toBe('deepseek-official')
    const settings = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(settings).toContain('provider: deepseek-official')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
