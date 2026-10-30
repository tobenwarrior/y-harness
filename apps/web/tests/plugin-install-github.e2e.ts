// Real Git reaches a controlled proxy failure or stall; the browser
// offers a mirror for a replacement spec, or another way once the install
// already asks the mirror, without retrying the failed address.
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold, captureStableAria, compareOrRefreshGolden, webSnapshotMode, watchConsole } from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

it.each(['network', 'timeout'] as const)('offers a mirror after a GitHub %s, then another way on the mirror, and waits for replacement input', async (failure) => {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-install-github-'))
  onTestFinished(() => rm(scratch, { recursive: true, force: true }))
  const sockets = new Set<Socket>()
  let connections = 0
  const proxy = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => { sockets.delete(socket) })
    socket.once('data', () => { connections++; if (failure === 'network') socket.destroy() })
  })
  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => { proxy.close((error) => { if (error) reject(error); else resolve() }) })
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const address = proxy.address()
  if (address === null || typeof address === 'string') throw new Error('proxy did not bind a TCP port')
  const gitConfig = join(scratch, 'git.config')
  await writeFile(gitConfig, `[http "https://github.com/"]\n proxy = http://127.0.0.1:${String(address.port)}\n`)
  const overlay = join(scratch, 'cordis.patch.yml')
  await writeFile(overlay, '- id: ui-plugin-manager\n  config: { registryProbeEnabled: false }\n')
  const scaffold = await launchWebScaffold({
    profile: { packages: [], packageManager: { command: process.execPath, args: [], env: { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' } } },
    extraOverlayPath: overlay,
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const profile = join(scaffold.harnessHome, 'profiles', 'scaffold')
  const manifestPath = join(profile, 'package.json')
  const manifestBefore = await readFile(manifestPath, 'utf8')
  await writeFile(join(profile, 'config'), 'console.log("https://registry.npmjs.org/")\n')
  await writeFile(join(profile, '.attempts'), '')
  await writeFile(join(profile, 'add'), `
    const fs = require('node:fs');
    fs.appendFileSync('.attempts', JSON.stringify(process.argv) + '\\n');
    console.error('pnpm must not start after the GitHub connection check fails');
    process.exitCode = 1;
  `)
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: ZH_BROWSER_LOCALE })
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl)
  await page.waitForSelector('[class*="frame"]')
  if (await page.getByRole('dialog', { name: '\u{8BBE}\u{7F6E}' }).count() > 0) await page.keyboard.press('Escape')
  await page.getByRole('navigation', { name: '\u{5168}\u{5C40}\u{9762}\u{677F}' }).getByRole('button', { name: '\u{63D2}\u{4EF6}', exact: true }).click()
  await page.getByRole('button', { name: '\u{6DFB}\u{52A0}\u{63D2}\u{4EF6}', exact: true }).click()
  const spec = 'https://github.com/example/dsh-plugin.git'
  const title = failure === 'timeout' ? '\u{8FDE}\u{63A5} GitHub \u{8D85}\u{65F6}' : '\u{65E0}\u{6CD5}\u{8BBF}\u{95EE} GitHub'
  let dialog = page.getByRole('dialog', { name: '\u{6DFB}\u{52A0}\u{63D2}\u{4EF6}', exact: true })
  await dialog.getByRole('button', { name: '\u{5B89}\u{88C5}\u{6E90} npm \u{5B98}\u{65B9}\u{6E90}', exact: true }).waitFor()
  await dialog.getByRole('textbox', { name: '\u{5305}\u{540D}\u{6216}\u{5730}\u{5740}' }).fill(spec)
  expect(await page.getByText(title, { exact: true }).count()).toBe(0)
  await dialog.getByRole('button', { name: '\u{5B89}\u{88C5}', exact: true }).click()
  dialog = page.getByRole('dialog', { name: title, exact: true })
  await dialog.waitFor()
  expect(await page.getByRole('dialog').count()).toBe(1)
  expect(await dialog.getByText('\u{8BF7}\u{5C1D}\u{8BD5}\u{5176}\u{4ED6}\u{5B89}\u{88C5}\u{6765}\u{6E90}。', { exact: true }).count()).toBe(1)
  await compareOrRefreshGolden(
    fileURLToPath(new URL(`./expected/plugin-install-github/${failure === 'timeout' ? 'timeout' : 'failed'}.expected.md`, import.meta.url)),
    await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode(),
  )
  const attempts = await readFile(join(profile, '.attempts'), 'utf8')
  expect(attempts).toBe('')
  expect(connections).toBeGreaterThan(0)
  await expect.poll(() => sockets.size).toBe(0)
  const checked = connections
  await dialog.getByRole('button', { name: '\u{6539}\u{7528}\u{56FD}\u{5185}\u{955C}\u{50CF}', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '\u{6DFB}\u{52A0}\u{63D2}\u{4EF6}', exact: true })
  const input = dialog.getByRole('textbox', { name: '\u{63D2}\u{4EF6}\u{5305}\u{540D}', exact: true })
  await input.waitFor()
  expect(await input.inputValue()).toBe('')
  expect(await input.evaluate(element => element === document.activeElement)).toBe(true)
  expect(await dialog.getByRole('button', { name: '\u{5B89}\u{88C5}', exact: true }).isDisabled()).toBe(true)
  await dialog.getByRole('button', { name: '\u{5B89}\u{88C5}\u{6E90} \u{4E2D}\u{56FD}\u{5927}\u{9646}\u{955C}\u{50CF}\u{6E90}', exact: true }).waitFor()
  await compareOrRefreshGolden(
    fileURLToPath(new URL('./expected/plugin-install-github/mirror.expected.md', import.meta.url)),
    await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode(),
  )
  expect(await readFile(join(profile, '.attempts'), 'utf8')).toBe(attempts)
  expect(connections).toBe(checked)
  expect(await readFile(manifestPath, 'utf8')).toBe(manifestBefore)
  await input.fill(spec)
  await dialog.getByRole('button', { name: '\u{5B89}\u{88C5}', exact: true }).click()
  dialog = page.getByRole('dialog', { name: title, exact: true })
  await dialog.waitFor()
  await compareOrRefreshGolden(
    fileURLToPath(new URL(`./expected/plugin-install-github/${failure === 'timeout' ? 'timeout' : 'failed'}-on-mirror.expected.md`, import.meta.url)),
    await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode(),
  )
  await dialog.getByRole('button', { name: '\u{8BD5}\u{8BD5}\u{5176}\u{4ED6}\u{65B9}\u{5F0F}', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '\u{6DFB}\u{52A0}\u{63D2}\u{4EF6}', exact: true })
  await dialog.getByRole('button', { name: '\u{6536}\u{8D77}\u{5F15}\u{5BFC}', exact: true }).waitFor()
  expect(await input.inputValue()).toBe('')
  expect(await input.evaluate(element => element === document.activeElement)).toBe(true)
  await compareOrRefreshGolden(
    fileURLToPath(new URL('./expected/plugin-install-github/another-way.expected.md', import.meta.url)),
    await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode(),
  )
  await input.fill(spec)
  await dialog.getByRole('button', { name: '\u{5B89}\u{88C5}', exact: true }).click()
  dialog = page.getByRole('dialog', { name: title, exact: true })
  await dialog.getByRole('button', { name: '\u{53D6}\u{6D88}', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  expect(await readFile(join(profile, '.attempts'), 'utf8')).toBe('')
  expect(connections).toBeGreaterThan(checked)
  expect(tripwire.pageErrors).toEqual([])
})
