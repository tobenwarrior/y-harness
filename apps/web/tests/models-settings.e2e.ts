// Web e2e scenario: the Models settings page end to end through the real
// wire — the one add card offers the dormant pi-ai catalog on its third-party
// mode and the create form on its custom-API mode, a blank key saves a
// reference-free profile for provider-native auth, and typing an API key later
// stores it write-only under the derived reference (`MINIMAX_CN_API_KEY`)
// while the settings document records only that reference. Each saved row
// appears after route topology invalidation without presenting liveness as
// provider status. The customized-settings fold writes its curated fields —
// the endpoint, and a declared route's own name and protocol — as merge
// patches against the stored profile. Zero model calls: configuration is pure
// settings/credentials/llm-domain traffic, so there is no fixture and a
// stray stream would fail loud because the adapter registry is empty. The provider under test is
// minimax-cn so a developer's real ANTHROPIC/OPENAI environment keys can
// never shadow the derived reference. The deletion dialog distinguishes a
// reference-free profile from a page-managed key before the credential and
// settings unsets reach the wire.
import { assertModelInputLayout } from './model-input-layout.ts'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { openSettings, ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/models-settings', import.meta.url))
const EMPTY_EXPECTED = join(SNAPSHOT_DIR, 'empty.expected.md')
const CONFIGURED_EXPECTED = join(SNAPSHOT_DIR, 'configured.expected.md')
const DECLARED_EXPECTED = join(SNAPSHOT_DIR, 'declared.expected.md')
const DECLARED_EDIT_EXPECTED = join(SNAPSHOT_DIR, 'declared-edit.expected.md')
const MODEL_PICKER_EXPECTED = join(SNAPSHOT_DIR, 'model-picker.expected.md')
const NATIVE_DELETE_EXPECTED = join(SNAPSHOT_DIR, 'native-delete.expected.md')
const DELETE_EXPECTED = join(SNAPSHOT_DIR, 'delete.expected.md')
const MODE = webSnapshotMode()

describe('web e2e: Models settings page configures a dormant provider', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    // The scenario asserts the shipped Chinese copy, so the browser asks for it.
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('rejects layout checks without an explicit viewport before resizing the page', async () => {
    const context = await browser.newContext({ viewport: null })
    try {
      const unsized = await context.newPage()
      await expect(assertModelInputLayout(unsized, unsized.locator('body')))
        .rejects.toThrow('Model input layout checks require an explicit viewport')
      expect(unsized.viewportSize()).toBeNull()
    } finally {
      await context.close()
    }
  })

  it('opens the add card over the dormant directory vocabulary', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-empty'))
    await openSettings(page, 'zh')
    const dialog = page.getByRole('dialog', { name: '\u{8BBE}\u{7F6E}' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '\u{6A21}\u{578B}', exact: true }).click()
    await dialog.getByText('\u{586B}\u{5165}\u{5404}\u{63D0}\u{4F9B}\u{5546}\u{7684} API \u{5BC6}\u{94A5}\u{5373}\u{53EF}\u{4F7F}\u{7528}\u{5176}\u{6A21}\u{578B}。').waitFor({ timeout: 10_000 })
    // The dormant pi-ai adapter contributes its whole installed catalog; no
    // provider is configured yet, so the page is one add button.
    const add = dialog.getByRole('button', { name: '\u{6DFB}\u{52A0}\u{6A21}\u{578B}\u{63D0}\u{4F9B}\u{5546}' })
    await add.waitFor({ timeout: 10_000 })
    // The button enables once the dormant catalog lands in the join.
    await expect.poll(async () => add.isEnabled(), { timeout: 10_000 }).toBe(true)
    await add.click()
    // The card opens on the third-party mode, whose panel carries the select.
    const modes = dialog.getByRole('tablist', { name: '\u{6DFB}\u{52A0}\u{65B9}\u{5F0F}' })
    await modes.waitFor({ timeout: 10_000 })
    expect(await modes.getByRole('tab', { name: '\u{7B2C}\u{4E09}\u{65B9}\u{6A21}\u{578B}\u{63D0}\u{4F9B}\u{5546}' }).getAttribute('aria-selected')).toBe('true')
    const pick = dialog.getByLabel('\u{63D0}\u{4F9B}\u{5546}', { exact: true })
    await pick.waitFor({ timeout: 10_000 })
    await expect.poll(async () => pick.locator('option').count(), { timeout: 10_000 }).toBeGreaterThan(30)
    const options = await pick.locator('option').allTextContents()
    expect(options).toContain('anthropic')
    expect(options).toContain('minimax-cn')
    await pick.selectOption('minimax-cn')
    await dialog.getByRole('textbox', { name: 'API \u{5BC6}\u{94A5}', exact: true }).waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(EMPTY_EXPECTED, snapshot, MODE)
  }, 60_000)

  it('refuses a key no HTTP header can carry before anything is written', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-illegal-key'))
    const dialog = page.getByRole('dialog', { name: '\u{8BBE}\u{7F6E}' })
    const key = dialog.getByLabel('API \u{5BC6}\u{94A5}')
    const save = dialog.getByRole('button', { name: '\u{4FDD}\u{5B58}', exact: true })

    // A key no HTTP header can carry would save cleanly and fail the first
    // turn with a ByteString TypeError; the form names the offending field
    // instead.
    await key.fill('sk-\u{1F600}minimax')
    await dialog.getByText('\u{8BE5} API \u{5BC6}\u{94A5}\u{683C}\u{5F0F}\u{9519}\u{8BEF}，\u{8BF7}\u{68C0}\u{67E5}。').waitFor({ timeout: 10_000 })
    await expect.poll(async () => save.isEnabled(), { timeout: 10_000 }).toBe(false)

    // Clearing it restores submit: an empty field means "keep what is stored",
    // never a refusal, or editing any other setting would demand the key.
    await key.fill('')
    await expect.poll(async () => save.isEnabled(), { timeout: 10_000 }).toBe(true)
    expect(await dialog.getByText('\u{8BE5} API \u{5BC6}\u{94A5}\u{683C}\u{5F0F}\u{9519}\u{8BEF}，\u{8BF7}\u{68C0}\u{67E5}。').count()).toBe(0)
  }, 60_000)

  it('saves a blank key as a reference-free provider-native profile', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-native-auth'))
    const dialog = page.getByRole('dialog', { name: '\u{8BBE}\u{7F6E}' })
    await dialog.getByRole('button', { name: '\u{4FDD}\u{5B58}', exact: true }).click()
    const row = dialog.getByText('minimax-cn', { exact: true }).first()
    await row.waitFor({ timeout: 10_000 })
    await dialog.getByText('\u{5DF2}\u{4FDD}\u{5B58} minimax-cn。', { exact: true }).waitFor({ timeout: 10_000 })
    expect(await dialog.getByRole('img', { name: 'API \u{5BC6}\u{94A5}\u{5DF2}\u{914D}\u{7F6E}' }).count()).toBe(0)
    expect(await dialog.getByRole('img', { name: 'API \u{5BC6}\u{94A5}\u{7F3A}\u{5931}' }).count()).toBe(0)
    const document = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(document).toContain('minimax-cn: {}')
    expect(document).not.toContain('MINIMAX_CN_API_KEY')
  }, 60_000)

  it('describes reference-free deletion without claiming a credential exists', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-native-delete'))
    const settingsDialog = page.getByRole('dialog', { name: '\u{8BBE}\u{7F6E}' })
    await settingsDialog.getByRole('button', { name: '\u{5220}\u{9664} minimax-cn', exact: true }).click()
    const deleteDialog = page.getByRole('dialog', { name: '\u{5220}\u{9664} minimax-cn？' })
    await deleteDialog.waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(
      page,
      '[role="dialog"][aria-label="\u{5220}\u{9664} minimax-cn？"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(NATIVE_DELETE_EXPECTED, snapshot, MODE)
    await deleteDialog.getByRole('button', { name: '\u{53D6}\u{6D88}', exact: true }).click()
  }, 60_000)

  it('stores the key under the derived reference and keeps the route live', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-add'))
    const dialog = page.getByRole('dialog', { name: '\u{8BBE}\u{7F6E}' })
    await dialog.getByRole('button', { name: '\u{7F16}\u{8F91} minimax-cn' }).click()
    await dialog.getByRole('textbox', { name: 'API \u{5BC6}\u{94A5}', exact: true }).fill('sk-e2e-minimax')
    await dialog.getByRole('button', { name: '\u{4FDD}\u{5B58}', exact: true }).click()
    // The profile lands in cordis.patch.yml with only the derived reference, the
    // key value lands in the harness home's .credentials.yaml, the dormant route
    // registers, and the topology frame invalidates the page into the row.
    await expect.poll(
      async () => dialog.getByRole('textbox', { name: 'API \u{5BC6}\u{94A5}', exact: true }).count(),
      { timeout: 10_000 },
    ).toBe(0)
    await dialog.getByRole('img', { name: 'API \u{5BC6}\u{94A5}\u{5DF2}\u{914D}\u{7F6E}' }).waitFor({ timeout: 10_000 })
    await dialog.getByText('\u{5DF2}\u{4FDD}\u{5B58} minimax-cn。', { exact: true }).waitFor({ timeout: 10_000 })
    const document = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(document).toContain('minimax-cn:')
    expect(document).toContain('apiKeyEnv: MINIMAX_CN_API_KEY')
    expect(document).not.toContain('sk-e2e-minimax')
    const credentialFile = join(scaffold.harnessHome, '.credentials.yaml')
    await expect.poll(
      async () => readFile(credentialFile, 'utf8').catch(() => ''),
      { timeout: 10_000 },
    ).toContain('MINIMAX_CN_API_KEY: sk-e2e-minimax')
    expect(await page.content()).not.toContain('sk-e2e-minimax')
  }, 60_000)

  it('applies a customized-settings field as a merge patch', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-customized'))
    const dialog = page.getByRole('dialog', { name: '\u{8BBE}\u{7F6E}' })
    await dialog.getByRole('button', { name: '\u{7F16}\u{8F91} minimax-cn' }).click()
    await dialog.getByText('\u{81EA}\u{5B9A}\u{4E49}\u{8BBE}\u{7F6E}').click()
    const url = dialog.getByLabel('API \u{5730}\u{5740}')
    await url.waitFor({ timeout: 10_000 })
    await url.fill('https://gateway.minimax.example/v1')
    await dialog.getByRole('button', { name: '\u{4FDD}\u{5B58}', exact: true }).click()
    // The editor closes back to the row; the fold's write merged into the
    // stored profile beside the reference.
    await expect.poll(async () => dialog.getByLabel('API \u{5730}\u{5740}').count(), { timeout: 10_000 }).toBe(0)
    await dialog.getByText('\u{5DF2}\u{4FDD}\u{5B58} minimax-cn。', { exact: true }).waitFor({ timeout: 10_000 })
    const document = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(document).toContain('baseURL: https://gateway.minimax.example/v1')
    expect(document).toContain('apiKeyEnv: MINIMAX_CN_API_KEY')
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(CONFIGURED_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('filters the discovered model catalog and clears hidden selections', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-picker'))
    const settingsDialog = page.getByRole('dialog', { name: '\u{8BBE}\u{7F6E}' })
    await settingsDialog.getByRole('button', { name: '\u{7F16}\u{8F91} minimax-cn' }).click()
    await settingsDialog.getByText('\u{81EA}\u{5B9A}\u{4E49}\u{8BBE}\u{7F6E}').click()
    await settingsDialog.getByRole('button', { name: '\u{83B7}\u{53D6}\u{53EF}\u{7528}\u{6A21}\u{578B}' }).click()

    const picker = page.getByRole('dialog', { name: '\u{9009}\u{62E9}\u{8981}\u{6DFB}\u{52A0}\u{7684}\u{6A21}\u{578B}' })
    await picker.waitFor({ timeout: 10_000 })
    const boxes = picker.getByRole('checkbox')
    const count = await boxes.count()
    expect(count).toBeGreaterThan(0)
    expect(await boxes.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).checked))).toEqual(
      Array.from({ length: count }, () => true),
    )

    const search = picker.getByRole('searchbox', { name: '\u{641C}\u{7D22}\u{6A21}\u{578B}' })
    await search.fill('highspeed')
    await expect.poll(async () => boxes.count()).toBe(1)
    await picker.getByRole('button', { name: '\u{53D6}\u{6D88}\u{5168}\u{9009}' }).click()
    expect(await boxes.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).checked))).toEqual(
      [false],
    )

    await search.fill('')
    await expect.poll(async () => boxes.count()).toBe(count)
    const restored = await boxes.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).checked))
    expect(restored).toEqual(Array.from({ length: count }, () => false))
    await picker.getByRole('button', { name: '\u{5168}\u{9009}' }).waitFor()
    await picker.getByRole('button', { name: '\u{5168}\u{9009}' }).click()
    const snapshot = await captureStableAria(
      page,
      '[role="dialog"][aria-label="\u{9009}\u{62E9}\u{8981}\u{6DFB}\u{52A0}\u{7684}\u{6A21}\u{578B}"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(MODEL_PICKER_EXPECTED, snapshot, MODE)

    expect(await boxes.evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).checked))).toEqual(
      Array.from({ length: count }, () => true),
    )
    await picker.getByRole('button', { name: '\u{53D6}\u{6D88}', exact: true }).click()
    await settingsDialog.getByRole('button', { name: '\u{53D6}\u{6D88}', exact: true }).click()
  }, 60_000)

  it('declares a route the adapter does not ship', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-declare'))
    const dialog = page.getByRole('dialog', { name: '\u{8BBE}\u{7F6E}' })
    const add = dialog.getByRole('button', { name: '\u{6DFB}\u{52A0}\u{6A21}\u{578B}\u{63D0}\u{4F9B}\u{5546}' })
    await expect.poll(async () => add.isEnabled(), { timeout: 10_000 }).toBe(true)
    await add.click()
    // The custom-API mode is the second segment of the one add card; its
    // purpose line replaces the catalog one.
    await dialog.getByRole('tab', { name: '\u{81EA}\u{5B9A}\u{4E49}\u{6A21}\u{578B} API' }).click()
    await dialog.getByText('\u{8FDE}\u{63A5}\u{4E2D}\u{8F6C}\u{7AD9}、\u{81EA}\u{90E8}\u{7F72}\u{670D}\u{52A1}\u{6216}\u{5176}\u{4ED6}\u{517C}\u{5BB9} OpenAI / Anthropic \u{534F}\u{8BAE}\u{7684}\u{63A5}\u{53E3}，\u{9700}\u{586B}\u{5199} API \u{5730}\u{5740}、\u{534F}\u{8BAE}\u{548C}\u{6A21}\u{578B}。').waitFor({ timeout: 10_000 })
    // The third-party panel stays mounted, hidden, beside this one, so the
    // form is addressed through its own panel.
    const custom = dialog.getByRole('tabpanel', { name: '\u{81EA}\u{5B9A}\u{4E49}\u{6A21}\u{578B} API' })
    await custom.getByLabel('Provider ID').fill('acme-gateway')
    await custom.getByLabel('\u{663E}\u{793A}\u{540D}\u{79F0}').fill('Acme Gateway')
    await custom.getByLabel('API \u{5730}\u{5740}').fill('https://gateway.acme.example/v1')
    // No reasoning effort on a provider card at all: effort is a per-model
    // capability, the models under one provider disagree about it, and a
    // switch in the composer already records provider+model+effort together.
    expect(await dialog.getByLabel('\u{63A8}\u{7406}\u{5F3A}\u{5EA6}').count()).toBe(0)
    await custom.getByRole('button', { name: '\u{6DFB}\u{52A0}\u{6A21}\u{578B}', exact: true }).click()
    await custom.getByLabel('\u{6A21}\u{578B} ID 1').fill('acme-large')
    await custom.getByRole('button', { name: '\u{6A21}\u{578B}\u{9009}\u{9879} 1' }).click()
    expect(await custom.getByRole('group', { name: '\u{8F93}\u{5165}\u{7C7B}\u{578B} 1' }).getByRole('checkbox', { name: '\u{56FE}\u{7247}' }).isChecked()).toBe(false)
    await custom.getByRole('group', { name: '\u{8F93}\u{5165}\u{7C7B}\u{578B} 1' }).getByRole('checkbox', { name: '\u{56FE}\u{7247}' }).check()
    await custom.getByRole('button', { name: '\u{521B}\u{5EFA}\u{63D0}\u{4F9B}\u{5546}', exact: true }).click()

    const row = dialog.getByText('Acme Gateway', { exact: true }).first()
    await row.waitFor({ timeout: 10_000 })
    const document = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(document).toContain('acme-gateway:')
    await expect(scaffold.ctx.llm.resolveModelInfo('acme-gateway', 'acme-large')).resolves.toMatchObject({
      inputModalities: ['text', 'image'],
    })

    // The tag follows the adapter's installed catalog: this route is in no
    // catalog, while minimax-cn is — even though both now have profiles.
    const rowCard = (name: string) => dialog.locator('li').filter({ hasText: name }).first()
    await expect.poll(async () => rowCard('Acme Gateway').getByText('\u{81EA}\u{5B9A}\u{4E49}').count(), { timeout: 10_000 }).toBe(1)
    expect(await rowCard('minimax-cn').getByText('\u{81EA}\u{5B9A}\u{4E49}').count()).toBe(0)

    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DECLARED_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('reopens the name and protocol a declared route was created with', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-declared-identity'))
    const dialog = page.getByRole('dialog', { name: '\u{8BBE}\u{7F6E}' })
    await dialog.getByRole('button', { name: '\u{7F16}\u{8F91} Acme Gateway (acme-gateway)' }).click()
    await dialog.getByText('\u{81EA}\u{5B9A}\u{4E49}\u{8BBE}\u{7F6E}').click()
    // The create card asked this route for a name and a protocol because
    // nothing can default them; the editor reaches the same two fields rather
    // than sending the user to cordis.patch.yml for what only this route names.
    const protocol = dialog.getByLabel('API \u{534F}\u{8BAE}')
    await protocol.waitFor({ timeout: 10_000 })
    expect(await protocol.inputValue()).toBe('openai-completions')
    const name = dialog.getByLabel('\u{663E}\u{793A}\u{540D}\u{79F0}', { exact: true })
    expect(await name.inputValue()).toBe('Acme Gateway')
    await dialog.getByRole('button', { name: '\u{6A21}\u{578B}\u{9009}\u{9879} 1' }).click()
    expect(await dialog.getByRole('group', { name: '\u{8F93}\u{5165}\u{7C7B}\u{578B} 1' }).getByRole('checkbox', { name: '\u{56FE}\u{7247}' }).isChecked()).toBe(true)
    await assertModelInputLayout(page, dialog)
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DECLARED_EDIT_EXPECTED, snapshot, MODE)

    await protocol.selectOption('anthropic-messages')
    await name.fill('Acme \u{7F51}\u{5173}')
    await dialog.getByRole('group', { name: '\u{8F93}\u{5165}\u{7C7B}\u{578B} 1' }).getByRole('checkbox', { name: '\u{56FE}\u{7247}' }).uncheck()
    await dialog.getByRole('button', { name: '\u{4FDD}\u{5B58}', exact: true }).click()
    await expect.poll(async () => dialog.getByLabel('API \u{534F}\u{8BAE}').count(), { timeout: 10_000 }).toBe(0)
    // The adapter re-resolved the route under the new protocol and re-registered
    // it under the new name: an unserviceable profile would have been refused
    // at the write instead, and a rename that did not re-register would leave
    // the old label on the row.
    await dialog.getByText('Acme \u{7F51}\u{5173}', { exact: true }).first().waitFor({ timeout: 10_000 })
    // The status line names the route as the refreshed directory reports it;
    // the target captured when the card opened still carries the old name.
    await dialog.getByText('\u{5DF2}\u{4FDD}\u{5B58} Acme \u{7F51}\u{5173} (acme-gateway)。', { exact: true }).waitFor({ timeout: 10_000 })
    const document = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
    expect(document).toContain('api: anthropic-messages')
    expect(document).toContain('displayName: Acme \u{7F51}\u{5173}')
    await expect(scaffold.ctx.llm.resolveModelInfo('acme-gateway', 'acme-large')).resolves.toMatchObject({
      inputModalities: ['text'],
    })
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('saves image-only input and reopens the same selection', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-input-types'))
    const dialog = page.getByRole('dialog', { name: '\u{8BBE}\u{7F6E}' })
    await dialog.getByRole('button', { name: '\u{7F16}\u{8F91} Acme \u{7F51}\u{5173} (acme-gateway)' }).click()
    await dialog.getByText('\u{81EA}\u{5B9A}\u{4E49}\u{8BBE}\u{7F6E}').click()
    await dialog.getByRole('button', { name: '\u{6A21}\u{578B}\u{9009}\u{9879} 1' }).click()
    expect(await dialog.getByRole('group', { name: '\u{8F93}\u{5165}\u{7C7B}\u{578B} 1' }).getByRole('checkbox', { name: '\u{56FE}\u{7247}' }).isChecked()).toBe(false)
    const inputs = dialog.getByRole('group', { name: '\u{8F93}\u{5165}\u{7C7B}\u{578B} 1' })
    expect(await inputs.getByRole('checkbox', { name: '\u{6587}\u{672C}' }).isChecked()).toBe(true)
    expect(await inputs.getByRole('checkbox', { name: '\u{6587}\u{672C}' }).isDisabled()).toBe(true)
    await inputs.getByRole('checkbox', { name: '\u{56FE}\u{7247}' }).check()
    await inputs.getByRole('checkbox', { name: '\u{6587}\u{672C}' }).uncheck()
    await dialog.getByRole('button', { name: '\u{4FDD}\u{5B58}', exact: true }).click()
    await dialog.getByLabel('\u{6A21}\u{578B} ID 1').waitFor({ state: 'detached', timeout: 10_000 })
    await expect(scaffold.ctx.llm.resolveModelInfo('acme-gateway', 'acme-large')).resolves.toMatchObject({
      inputModalities: ['image'],
    })
    // The saved notice confirms the browser directory refresh after the editor closes.
    await dialog.getByText('\u{5DF2}\u{4FDD}\u{5B58} Acme \u{7F51}\u{5173} (acme-gateway)。', { exact: true }).waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '\u{7F16}\u{8F91} Acme \u{7F51}\u{5173} (acme-gateway)' }).click()
    await dialog.getByText('\u{81EA}\u{5B9A}\u{4E49}\u{8BBE}\u{7F6E}').click()
    await dialog.getByRole('button', { name: '\u{6A21}\u{578B}\u{9009}\u{9879} 1' }).click()
    expect(await dialog.getByRole('group', { name: '\u{8F93}\u{5165}\u{7C7B}\u{578B} 1' }).getByRole('checkbox', { name: '\u{56FE}\u{7247}' }).isChecked()).toBe(true)
    expect(await inputs.getByRole('checkbox', { name: '\u{6587}\u{672C}' }).isChecked()).toBe(false)
    expect(await inputs.getByRole('checkbox', { name: '\u{56FE}\u{7247}' }).isDisabled()).toBe(true)
    await dialog.getByRole('button', { name: '\u{53D6}\u{6D88}', exact: true }).click()
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('inherits installed vision input and retains it when adopting a discovered model', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-catalog-inputs'))
    await scaffold.ctx.settings.mutate('llm-pi-ai', [{
      op: 'set', path: ['providers', 'openai'],
      value: { models: [{ id: 'gpt-6-astra', name: 'GPT-6 Astra', contextWindow: 272000, maxTokens: 128000 }] },
    }])
    const dialog = page.getByRole('dialog', { name: '\u{8BBE}\u{7F6E}' })
    const edit = dialog.getByRole('button', { name: '\u{7F16}\u{8F91} openai', exact: true })
    try {
      await edit.click()
      await dialog.getByText('\u{81EA}\u{5B9A}\u{4E49}\u{8BBE}\u{7F6E}').click()
      await dialog.getByRole('button', { name: '\u{6A21}\u{578B}\u{9009}\u{9879} 1' }).click()
      const types = dialog.getByRole('group', { name: '\u{8F93}\u{5165}\u{7C7B}\u{578B} 1' })
      const image = types.getByRole('checkbox', { name: '\u{56FE}\u{7247}', exact: true })
      await expect.poll(() => image.isChecked()).toBe(true)
      expect(await types.getByRole('checkbox', { name: '\u{6587}\u{672C}', exact: true }).isChecked()).toBe(true)
      const before = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'catalog-inputs.expected.md'),
        await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), MODE)
      await dialog.getByRole('button', { name: '\u{4FDD}\u{5B58}', exact: true }).click()
      await types.waitFor({ state: 'detached' })
      expect(await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')).toBe(before)

      await edit.click()
      await dialog.getByText('\u{81EA}\u{5B9A}\u{4E49}\u{8BBE}\u{7F6E}').click()
      await dialog.getByRole('button', { name: '\u{6A21}\u{578B}\u{9009}\u{9879} 1' }).click()
      await expect.poll(() => image.isEnabled()).toBe(true)
      await image.uncheck()
      await dialog.getByRole('button', { name: '\u{4FDD}\u{5B58}', exact: true }).click()
      await types.waitFor({ state: 'detached' })
      await expect(scaffold.ctx.llm.resolveModelInfo('openai', 'gpt-6-astra')).resolves.toMatchObject({ inputModalities: ['text'] })
      // The saved notice confirms the browser directory refresh after the editor closes.
      // Reopening before it copies the previous selection into a new draft, which
      // checkbox polling cannot correct.
      await dialog.getByText('\u{5DF2}\u{4FDD}\u{5B58} openai。', { exact: true }).waitFor({ timeout: 10_000 })
      await edit.click()
      await dialog.getByText('\u{81EA}\u{5B9A}\u{4E49}\u{8BBE}\u{7F6E}').click()
      await dialog.getByRole('button', { name: '\u{6A21}\u{578B}\u{9009}\u{9879} 1' }).click()
      await expect.poll(() => image.isEnabled()).toBe(true)
      expect(await image.isChecked()).toBe(false)

      await dialog.getByRole('button', { name: '\u{5220}\u{9664}\u{6A21}\u{578B} 1' }).click()
      await dialog.getByRole('button', { name: '\u{83B7}\u{53D6}\u{53EF}\u{7528}\u{6A21}\u{578B}' }).click()
      const picker = page.getByRole('dialog', { name: '\u{9009}\u{62E9}\u{8981}\u{6DFB}\u{52A0}\u{7684}\u{6A21}\u{578B}' })
      await picker.getByRole('button', { name: '\u{53D6}\u{6D88}\u{5168}\u{9009}' }).click()
      await picker.getByRole('searchbox', { name: '\u{641C}\u{7D22}\u{6A21}\u{578B}' }).fill('gpt-6-astra')
      await picker.getByRole('checkbox', { name: 'gpt-6-astra', exact: true }).check()
      await picker.getByRole('button', { name: '\u{6DFB}\u{52A0}\u{6240}\u{9009}' }).click()
      await dialog.getByRole('button', { name: '\u{6A21}\u{578B}\u{9009}\u{9879} 1' }).click()
      expect(await image.isChecked()).toBe(true)
      await dialog.getByRole('button', { name: '\u{4FDD}\u{5B58}', exact: true }).click()
      await types.waitFor({ state: 'detached' })
      await expect(scaffold.ctx.llm.resolveModelInfo('openai', 'gpt-6-astra')).resolves.toMatchObject({ inputModalities: ['text', 'image'] })
    } finally {
      await scaffold.ctx.settings.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', 'openai'] }])
      await edit.waitFor({ state: 'detached' })
      await page.getByRole('dialog', { name: '\u{9009}\u{62E9}\u{8981}\u{6DFB}\u{52A0}\u{7684}\u{6A21}\u{578B}' }).waitFor({ state: 'detached' })
    }
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('confirms an identified provider deletion before removing its profile and key', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-models-delete'))
    expect(await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')).not.toContain('openai:')
    const settingsDialog = page.getByRole('dialog', { name: '\u{8BBE}\u{7F6E}' })
    await settingsDialog.getByRole('button', { name: '\u{5220}\u{9664} minimax-cn', exact: true }).click()
    const deleteDialog = page.getByRole('dialog', { name: '\u{5220}\u{9664} minimax-cn？' })
    await deleteDialog.waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(
      page,
      '[role="dialog"][aria-label="\u{5220}\u{9664} minimax-cn？"]',
      scaffold.workspaceCwd,
    )
    await compareOrRefreshGolden(DELETE_EXPECTED, snapshot, MODE)

    await deleteDialog.getByRole('button', { name: '\u{53D6}\u{6D88}', exact: true }).click()
    expect(await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8')).toContain('minimax-cn:')
    await settingsDialog.getByRole('button', { name: '\u{5220}\u{9664} minimax-cn', exact: true }).click()
    await page.getByRole('dialog', { name: '\u{5220}\u{9664} minimax-cn？' })
      .getByRole('button', { name: '\u{5220}\u{9664} minimax-cn', exact: true }).click()
    await expect.poll(
      async () => readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'cordis.patch.yml'), 'utf8'),
      { timeout: 10_000 },
    ).not.toContain('minimax-cn:')
    expect(await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8'))
      .not.toContain('MINIMAX_CN_API_KEY')
    await expect.poll(
      async () => page.getByRole('dialog', { name: '\u{5220}\u{9664} minimax-cn？' }).count(),
      { timeout: 10_000 },
    ).toBe(0)
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'configured.expected.md', 'declared-edit.expected.md', 'declared.expected.md',
      'delete.expected.md', 'empty.expected.md', 'model-picker.expected.md',
      'native-delete.expected.md', 'catalog-inputs.expected.md',
    ])
  })
})
