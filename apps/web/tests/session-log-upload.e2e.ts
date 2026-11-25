/** A saved legacy upload setting cannot add reporting to a browser model request. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { credentialRef } from '@yharness/credentials'
import { startMockLlmServer } from '@yharness/llm-mock-server'
import { launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, openSettings } from './support.ts'

it.skipIf(webSnapshotMode() === 'record')('keeps reporting off the wire even with a legacy enabled profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-upload-browser-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const server = await startMockLlmServer({ sequence: ['success', 'success'], successText: 'PRIVACY_REQUEST_DONE' })
  onTestFinished(() => server.close())
  const key = credentialRef('DSH_UPLOAD_BROWSER_KEY')
  const overlay = join(root, 'upload.yml')
  await writeFile(overlay, JSON.stringify([
    { id: 'llm-deepseek', config: { baseURL: server.baseURL, apiKeyEnv: key } },
    { id: 'session-log-deepseek', disabled: false, config: { enabled: true } },
    { id: 'plugin-package-inventory-deepseek', disabled: false, config: { enabled: true } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
  ]))
  const scaffold = await launchWebScaffold({ deepSeekMissingCredential: true, extraOverlayPath: overlay })
  onTestFinished(() => scaffold.close())
  await scaffold.ctx.credentials.set(key, 'upload-browser-test-key')
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspace(page, scaffold.workspaceCwd)
  const input = page.locator('[data-composer-input]').first()
  const send = async (text: string) => {
    const settled = scaffold.whenTurnSettled()
    await input.fill(text)
    await input.press('Enter')
    return settled
  }
  const sessionId = await send('first model prompt')
  await openSettings(page, 'en')
  await expect.poll(() => page.getByRole('switch', { name: 'Upload Session Log when using the official model API' }).count())
    .toBe(0)
  await page.keyboard.press('Escape')
  expect(await send('follow-up model prompt')).toBe(sessionId)
  expect(server.requests).toHaveLength(2)
  for (const request of server.requests) {
    expect(request.body).not.toHaveProperty('dsh_session_log')
    expect(request.body).not.toHaveProperty('dsh_plugin_packages')
    expect(request.outcome).toBe('completed')
  }
  expect(JSON.stringify(server.requests[1]?.body)).toContain('follow-up model prompt')
})
