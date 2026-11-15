/** Open each Bot's own workspace files, Computer, and terminal through the Web sidebar. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BotId } from '@yharness/bots'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/bot-workspace/session.v3.jsonl', import.meta.url))
const GOLDEN = fileURLToPath(new URL('./expected/bot-terminal/action.expected.md', import.meta.url))
const FILES_GOLDEN = fileURLToPath(new URL('./expected/bot-terminal/files-action.expected.md', import.meta.url))
const RUNTIME = new URL('../../../packages/bundle/web-app/lib/types/vps-runtime.js', import.meta.url).href
const BOTS = new URL('../../../packages/bundle/web-app/lib/types/vps-bots.js', import.meta.url).href
const PROCESS = new URL('../../../packages/bundle/web-app/lib/types/vps-bot-process.js', import.meta.url).href
const FILE_WORKER = fileURLToPath(new URL('../../../scripts/vps-bot/files.py', import.meta.url))
const FIRST = BotId('bot-terminal-scout')
const SECOND = BotId('bot-terminal-orbit')
const LEGACY = BotId('bot-terminal-legacy')

it.skipIf(process.platform === 'win32')('switches between a Bot’s Computer and its existing terminal', async () => {
  const scope = await mkdtemp('/tmp/yh-bot-terminal-web-')
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let server: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  try {
    browser = await chromium.launch()
    const page = await browser.newPage({ locale: 'en-US', viewport: { width: 1500, height: 900 } })
    const consoleLog = watchConsole(page)
    const image = await page.evaluate(() => {
      const frame = document.createElement('canvas')
      frame.width = 640
      frame.height = 400
      const canvas = frame.getContext('2d')!
      canvas.fillStyle = '#161d2c'
      canvas.fillRect(0, 0, frame.width, frame.height)
      canvas.font = '22px sans-serif'
      canvas.fillStyle = '#f4f6fc'
      canvas.fillText('Private Computer', 220, 203)
      return frame.toDataURL('image/jpeg').split(',')[1]
    })
    const plugin = join(scope, 'terminal.mjs')
    const patch = join(scope, 'terminal.yml')
    await writeFile(plugin, `
      import { mkdir } from 'node:fs/promises'
      import { VpsRuntime } from ${JSON.stringify(RUNTIME)}
      import { mountVpsBots } from ${JSON.stringify(BOTS)}
      import { VpsBotSubprocess } from ${JSON.stringify(PROCESS)}

      export const name = 'bot-terminal-fixture'
      export const inject = ['subprocess']
      export function apply(ctx, config) {
        ctx.effect(() => {
          const original = {
            ensure: VpsRuntime.prototype.ensure, desktop: VpsRuntime.prototype.desktopCommand,
            execArgv: VpsRuntime.prototype.execArgv,
            resolve: VpsBotSubprocess.prototype.resolveExecutable, spawn: VpsBotSubprocess.prototype.spawnTerminal,
          }
          VpsRuntime.prototype.ensure = async function (sessionId) {
            await mkdir(this.workspace(sessionId), { mode: 0o700, recursive: true })
          }
          VpsRuntime.prototype.desktopCommand = async () => Buffer.from(${JSON.stringify(image)}, 'base64')
          VpsRuntime.prototype.execArgv = function (sessionId, argv, options) {
            return argv[2] === '/usr/local/lib/yharness/files.py'
              ? ['python3', argv[1], ${JSON.stringify(FILE_WORKER)}, ...argv.slice(3)]
              : original.execArgv.call(this, sessionId, argv, options)
          }
          VpsBotSubprocess.prototype.resolveExecutable = (command, env, signal) => ctx.subprocess.resolveExecutable(command, env, signal)
          VpsBotSubprocess.prototype.spawnTerminal = async (spec) => {
            await mkdir(spec.cwd, { mode: 0o700, recursive: true })
            return ctx.subprocess.spawnTerminal(spec)
          }
          return () => {
            VpsRuntime.prototype.ensure = original.ensure
            VpsRuntime.prototype.desktopCommand = original.desktop
            VpsRuntime.prototype.execArgv = original.execArgv
            VpsBotSubprocess.prototype.resolveExecutable = original.resolve
            VpsBotSubprocess.prototype.spawnTerminal = original.spawn
          }
        })
        mountVpsBots(ctx, config, [])
      }
    `)
    await writeFile(patch, JSON.stringify([{ insert: [{
      id: 'bot-terminal-fixture', name: pathToFileURL(plugin).href,
      config: {
        root: join(scope, 'bots'), image: 'localhost/yharness-test', bots: [FIRST, SECOND],
        desktopOnlyBots: [FIRST, SECOND],
      },
    }] }]))
    const web = server = await launchWebScaffold({ extraOverlayPath: patch, replayFixture: FIXTURE, replayProvidersOnly: true })
    const { bot: first } = await web.ctx.bots.create({ id: FIRST, name: 'Scout', cwd: web.workspaceCwd })
    const { bot: second } = await web.ctx.bots.create({ id: SECOND, name: 'Orbit', cwd: web.workspaceCwd })
    const { bot: legacy } = await web.ctx.bots.create({ id: LEGACY, name: 'Archive', cwd: web.workspaceCwd })
    for (const [root, content] of [
      [join(scope, 'bots', first.sessionId), 'Scout workspace'],
      [join(scope, 'bots', second.sessionId), 'Orbit workspace'],
      [web.workspaceCwd, 'Chat workspace'],
    ] as const) {
      const reports = join(root, 'reports')
      await mkdir(reports, { recursive: true })
      await writeFile(join(reports, 'Brief #1.txt'), content)
    }
    await page.goto(web.authenticatedUrl, { waitUntil: 'load' })

    const sidebar = page.locator('[data-yh-part="sidebar"]')
    await sidebar.getByRole('button', { name: 'Bots', exact: true }).click({ timeout: 10_000 }).catch(async (cause: unknown) => {
      const messages = { errors: consoleLog.pageErrors, warnings: consoleLog.warnings, body: (await page.locator('body').innerText()).slice(0, 650) }
      throw new Error(JSON.stringify(messages), { cause })
    })
    const select = (id: string) => sidebar.locator('[data-bot-id="' + id + '"]').click()
    const action = page.getByRole('button', { name: 'Open VPS terminal', exact: true })
    const filesAction = page.getByRole('button', { name: 'Open VPS files', exact: true })
    const fileTree = page.locator('[data-files-state="tree"]:visible')
    const preview = page.locator('[data-textpreview-body]:visible')
    const openBrief = async (): Promise<void> => {
      await filesAction.click()
      await fileTree.getByRole('button', { name: 'reports', exact: true }).click({ timeout: 6500 }).catch(async (cause: unknown) => {
        const tree = await page.locator('[data-files-state]').allTextContents()
        const dock = await page.locator('[data-sidebar-right-session]:visible').allTextContents()
        throw new Error(JSON.stringify({ tree, dock: dock.map(text => text.slice(0, 550)), errors: consoleLog.pageErrors }), { cause })
      })
      await fileTree.getByRole('button', { name: 'Brief #1.txt', exact: true }).click()
    }
    const computer = page.locator('[data-computer-panel]')
    const terminal = page.locator('[data-sidebar-terminal]:visible')
    const send = async (input: string): Promise<void> => {
      await terminal.locator('.xterm-helper-textarea').click()
      await page.keyboard.insertText(input)
      await page.keyboard.press('Enter')
    }
    const processId = (sessionId: string, file: string): Promise<string> => readFile(join(scope, 'bots', sessionId, file), 'utf8')
      .catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''
        throw error
      })
    const readPid = async (sessionId: string, file: string): Promise<string> => {
      await expect.poll(() => processId(sessionId, file)).toMatch(/^[1-9][0-9]*$/u)
      return processId(sessionId, file)
    }
    await select(FIRST)
    await action.waitFor()
    await compareOrRefreshGolden(GOLDEN, (await action.ariaSnapshot()).trimEnd(), webSnapshotMode())
    await action.click()
    await terminal.waitFor()
    await send('printf "%s" "$$" > first.pid')
    const firstPid = await readPid(first.sessionId, 'first.pid')
    await filesAction.waitFor()
    await compareOrRefreshGolden(FILES_GOLDEN, (await filesAction.ariaSnapshot()).trimEnd(), webSnapshotMode())
    await openBrief()
    await preview.getByText('Scout workspace', { exact: true }).waitFor()
    const downloadLink = page.getByRole('link', { name: 'Download file', exact: true })
    const href = await downloadLink.getAttribute('href')
    if (href === null) throw new Error('The Computer file download link has no destination')
    const [download] = await Promise.all([page.waitForEvent('download'), downloadLink.click()])
    expect(download.suggestedFilename()).toBe('Brief #1.txt')
    expect(await readFile(await download.path(), 'utf8')).toBe('Scout workspace')
    const url = new URL(href, web.authenticatedUrl)
    expect((await fetch(url)).status).toBe(401)
    url.searchParams.set('sessionId', legacy.sessionId)
    expect((await page.request.get(url.href)).status()).toBe(404)
    await page.getByRole('button', { name: 'Open computer panel', exact: true }).click()
    await computer.waitFor()
    await terminal.waitFor({ state: 'hidden' })
    await action.click()
    await computer.waitFor({ state: 'hidden' })
    await terminal.waitFor()
    await send('printf "%s" "$$" > reopened.pid')
    expect(await readPid(first.sessionId, 'reopened.pid')).toBe(firstPid)

    await select(SECOND)
    await terminal.waitFor({ state: 'hidden' })
    await action.click()
    await terminal.waitFor()
    await send('printf "%s" "$$" > second.pid')
    expect(await readPid(second.sessionId, 'second.pid')).not.toBe(firstPid)
    await openBrief()
    await preview.getByText('Orbit workspace', { exact: true }).waitFor()

    await select(LEGACY)
    await sidebar.locator('[data-bot-id="' + LEGACY + '"][aria-current="page"]').waitFor()
    await expect.poll(() => action.count()).toBe(0)
    await expect.poll(() => filesAction.count()).toBe(0)
    await terminal.waitFor({ state: 'hidden' })
    await select(FIRST)
    await action.waitFor()
    await terminal.waitFor()
    await send('printf "%s" "$$" > reselected.pid')
    expect(await readPid(first.sessionId, 'reselected.pid')).toBe(firstPid)
    await page.setViewportSize({ width: 1024, height: 760 })
    await expect.poll(() => filesAction.evaluate((button) => {
      const bounds = button.getBoundingClientRect()
      return bounds.width > 0 && bounds.left >= 0 && bounds.right <= window.innerWidth
    })).toBe(true)
    expect(consoleLog.pageErrors).toEqual([])
    expect(consoleLog.warnings).toEqual([])
  } finally {
    await browser?.close()
    await server?.close()
    await rm(scope, { force: true, recursive: true })
  }
})
