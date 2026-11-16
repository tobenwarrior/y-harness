/** Open each Bot's own workspace files, Computer, and terminal through the Web sidebar. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BotId } from '@yharness/bots'
import { ToolCallId } from '@yharness/llm'
import { chromium } from 'playwright'
import { expect, it, vi } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/bot-workspace/session.v3.jsonl', import.meta.url))
const GOLDEN = fileURLToPath(new URL('./expected/bot-terminal/action.expected.md', import.meta.url))
const FILES_GOLDEN = fileURLToPath(new URL('./expected/bot-terminal/files-action.expected.md', import.meta.url))
const SHARED_GOLDEN = fileURLToPath(new URL('./expected/bot-terminal/shared-workspaces.expected.md', import.meta.url))
const UPLOAD_GOLDEN = fileURLToPath(new URL('./expected/bot-terminal/upload-action.expected.md', import.meta.url))
const COPY_GOLDEN = fileURLToPath(new URL('./expected/bot-terminal/copy-action.expected.md', import.meta.url))
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
    const project = join(scope, 'project')
    await mkdir(project, { mode: 0o700 })
    await mkdir(join(scope, 'bots'), { mode: 0o700 })
    const projectWorkerHarness = [
      'import json, subprocess, sys',
      'script, root = sys.argv[1:3]',
      'request = json.load(sys.stdin)',
      'request["path"] = root + request["path"][len("/workspace"):]',
      'r = subprocess.run([sys.executable, "-I", "-c", script, root], input=json.dumps(request), text=True, capture_output=True, check=True)',
      'data = json.loads(r.stdout)',
      'if request["operation"] == "resolve" and "value" in data:',
      '    data["value"] = "/workspace" + data["value"][len(root):]',
      'if request["operation"] == "list" and "value" in data:',
      '    for item in data["value"]:',
      '        item["path"] = "/workspace" + item["path"][len(root):]',
      'print(json.dumps(data))',
    ].join('\n')
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
            if (argv[2] === '/usr/local/lib/yharness/files.py') {
              return ['python3', argv[1], ${JSON.stringify(FILE_WORKER)}, ...argv.slice(3)]
            }
            if (argv[0] === '/usr/bin/python3' && argv[2] === '-c') {
              if (argv[4] !== '/workspace') return ['python3', ...argv.slice(1)]
              const root = ${JSON.stringify(project)}
              if (argv.length === 5) {
                return ['python3', '-I', '-c', ${JSON.stringify(projectWorkerHarness)}, argv[3], root]
              }
              return ['python3', ...argv.slice(1, 4), root, ...argv.slice(5)]
            }
            return original.execArgv.call(this, sessionId, argv, options)
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
        desktopOnlyBots: [FIRST, SECOND], sharedWorkspace: { bots: [FIRST, SECOND] },
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
    const fileMenu = page.getByRole('menu').filter({ has: page.getByRole('menuitem', { name: 'Shared workspace', exact: true }) })
    const openFiles = async (kind: 'Private workspace' | 'Shared workspace'): Promise<void> => {
      await filesAction.click()
      await fileMenu.getByRole('menuitem', { name: kind, exact: true }).click()
    }
    const openBrief = async (): Promise<void> => {
      await openFiles('Private workspace')
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
    const uploadUrl = new URL('/api/computer/files/upload', web.authenticatedUrl)
    const uploadBytes = Buffer.from('Bot work only')
    uploadUrl.search = new URLSearchParams({
      sessionId: first.sessionId, directory: 'reports', name: 'Source #2.txt', bytes: String(uploadBytes.length),
    }).toString()
    const uploadInit = { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: uploadBytes }
    expect((await fetch(uploadUrl, uploadInit)).status).toBe(401)
    expect((await page.request.post(uploadUrl.href, { data: uploadBytes })).status()).toBe(201)
    expect(await readFile(join(scope, 'bots', first.sessionId, 'reports', 'Source #2.txt'), 'utf8')).toBe('Bot work only')
    expect((await page.request.post(uploadUrl.href, { data: uploadBytes })).status()).toBe(409)
    uploadUrl.searchParams.set('sessionId', legacy.sessionId)
    expect((await page.request.post(uploadUrl.href, { data: uploadBytes })).status()).toBe(404)

    await openFiles('Private workspace')
    const upload = fileTree.getByRole('button', { name: 'Upload files', exact: true })
    await compareOrRefreshGolden(UPLOAD_GOLDEN, (await upload.ariaSnapshot()).trimEnd(), webSnapshotMode())
    const [folderPicker] = await Promise.all([
      page.waitForEvent('filechooser'), fileTree.getByRole('button', { name: 'Upload files to reports' }).click(),
    ])
    const planned = 'Screenshot notes from the owner'
    await folderPicker.setFiles({ name: 'Owner Report.txt', mimeType: 'text/plain', buffer: Buffer.from(planned) })
    await fileTree.getByRole('button', { name: 'Owner Report.txt', exact: true }).waitFor()
    await fileTree.getByRole('button', { name: 'Owner Report.txt', exact: true }).click()
    await preview.getByText(planned, { exact: true }).waitFor()
    expect(await readFile(join(scope, 'bots', first.sessionId, 'reports', 'Owner Report.txt'), 'utf8')).toBe(planned)
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
    expect(await processId(second.sessionId, 'reports/Owner Report.txt')).toBe('')
    expect(await processId(second.sessionId, 'reports/Source #2.txt')).toBe('')
    const copyPath = new URL('/api/computer/files/copy', web.authenticatedUrl)
    const copy = { sessionId: first.sessionId, path: 'reports/Owner Report.txt', targetBotId: second.id }
    expect((await fetch(copyPath, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(copy),
    })).status).toBe(401)
    expect((await page.request.post(copyPath.href, { data: { ...copy, version: 'older-revision' } })).status()).toBe(409)
    expect((await page.request.post(copyPath.href, { data: { ...copy, targetBotId: LEGACY } })).status()).toBe(404)

    await select(FIRST)
    await openFiles('Private workspace')
    const reportsFolder = fileTree.getByRole('button', { name: 'reports', exact: true })
    await reportsFolder.waitFor()
    if (await reportsFolder.getAttribute('aria-expanded') !== 'true') await reportsFolder.click()
    await fileTree.getByRole('button', { name: 'Owner Report.txt', exact: true }).click()
    const copyButton = page.getByRole('button', { name: 'Copy to bot', exact: true })
    await compareOrRefreshGolden(COPY_GOLDEN, (await copyButton.ariaSnapshot()).trimEnd(), webSnapshotMode())
    await copyButton.click()
    const picker = page.getByRole('dialog', { name: 'Copy to bot', exact: true })
    await expect.poll(async () => picker.getByRole('radio').allTextContents()).toHaveLength(1)
    await picker.getByRole('radio', { name: 'Orbit', exact: true }).check()
    await picker.getByRole('button', { name: 'Copy file', exact: true }).click()
    await picker.getByText('Copied to Orbit’s VPS workspace.', { exact: true }).waitFor()
    await picker.getByRole('button', { name: 'Done', exact: true }).click()
    expect(await readFile(join(scope, 'bots', second.sessionId, 'Owner Report.txt'), 'utf8')).toBe(planned)
    expect(await readFile(join(scope, 'bots', first.sessionId, 'reports', 'Owner Report.txt'), 'utf8')).toBe(planned)
    expect((await page.request.post(copyPath.href, { data: copy })).status()).toBe(409)

    const sender = web.ctx.agents.get(first.sessionId)
    const receiver = web.ctx.agents.get(second.sessionId)
    if (sender === undefined || receiver === undefined) throw new Error('A test Bot Agent is unavailable')
    expect(web.ctx.tools.get('copy_vps_file', sender)).toBeDefined()
    expect(web.ctx.tools.get('read_vps_file', receiver)).toBeDefined()
    const readCopy = await web.ctx.tools.execute({
      name: 'read_vps_file', callId: ToolCallId('read-forwarded-file'), agent: receiver, signal: AbortSignal.timeout(5000),
      arguments: { path: 'Owner Report.txt' },
    })
    expect(readCopy).toMatchObject({ isError: false, content: [{ type: 'text', text: planned }] })
    const approval = vi.spyOn(web.ctx.approval, 'request').mockResolvedValueOnce('rejected').mockResolvedValueOnce('allowed-once')
    const toolCopy = (id: string) => web.ctx.tools.execute({
      name: 'copy_vps_file', callId: ToolCallId(id), agent: sender, signal: AbortSignal.timeout(5000),
      arguments: { path: 'reports/Source #2.txt', targetBotId: SECOND },
    })
    try {
      await expect(toolCopy('reject-file-copy')).resolves.toMatchObject({ isError: true })
      expect(await processId(second.sessionId, 'Source #2.txt')).toBe('')
      await expect(toolCopy('approve-file-copy')).resolves.toMatchObject({ isError: false })
      expect(await readFile(join(scope, 'bots', second.sessionId, 'Source #2.txt'), 'utf8')).toBe('Bot work only')
      expect(approval).toHaveBeenCalledTimes(2)
    } finally {
      approval.mockRestore()
    }

    await filesAction.click()
    await compareOrRefreshGolden(SHARED_GOLDEN, (await fileMenu.ariaSnapshot()).trimEnd(), webSnapshotMode())
    await fileMenu.getByRole('menuitem', { name: 'Shared workspace', exact: true }).click()
    const projectTree = page.locator('[data-files-root="/workspace"]:visible')
    const [projectPicker] = await Promise.all([
      page.waitForEvent('filechooser'), projectTree.getByRole('button', { name: 'Upload files', exact: true }).click(),
    ])
    const projectBytes = Buffer.from('Shared research note')
    await projectPicker.setFiles({ name: 'Desk Notes.txt', mimeType: 'text/plain', buffer: projectBytes })
    await projectTree.getByRole('button', { name: 'Desk Notes.txt', exact: true }).waitFor()
    expect(await readFile(join(project, 'Desk Notes.txt'))).toEqual(projectBytes)

    await select(SECOND)
    await openFiles('Shared workspace')
    await projectTree.getByRole('button', { name: 'Desk Notes.txt', exact: true }).click()
    await preview.getByText(projectBytes.toString(), { exact: true }).waitFor()
    await expect.poll(() => page.getByRole('button', { name: 'Copy to bot', exact: true }).count()).toBe(0)
    const sharedDownload = page.getByRole('link', { name: 'Download file', exact: true })
    const [sharedFile] = await Promise.all([page.waitForEvent('download'), sharedDownload.click()])
    expect(await readFile(await sharedFile.path())).toEqual(projectBytes)

    await select(LEGACY)
    await sidebar.locator('[data-bot-id="' + LEGACY + '"][aria-current="page"]').waitFor()
    await expect.poll(() => action.count()).toBe(0)
    await expect.poll(() => filesAction.count()).toBe(0)
    await terminal.waitFor({ state: 'hidden' })
    await select(FIRST)
    await action.waitFor()
    if (!await terminal.isVisible()) await action.click()
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
