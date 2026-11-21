/** Browser coverage for a Bot approval surfaced in the sidebar. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import type { Page } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import type {} from '@yharness/bots'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@yharness/llm'
import { defineTool } from '@yharness/tools'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/bot-workspace/session.v3.jsonl', import.meta.url))
const PERMISSION_PRESETS = fileURLToPath(new URL('./fixtures/permission-presets.patch.yml', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/bot-roster-approval/sidebar.expected.md', import.meta.url))
const PROVIDER = 'bot-roster-attention'
const MODEL = 'reply'
const TOOL = 'mcp__fixture__lookup'
const TRIGGER = 'Check the synthetic research file.'
const WARMUP = 'Get ready for a check.'
const REPLY = 'The check is finished.'

class PendingRosterAdapter extends LlmAdapter {
  private requested = false

  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: MODEL, name: `${provider}/${MODEL}` }])
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const message = options.messages.filter(candidate => candidate.role === 'user').at(-1)
    const requestsTool = message?.content.some(block => block.type === 'text' && block.text.includes(TRIGGER)) === true
    if (requestsTool && !this.requested) {
      this.requested = true
      const id = ToolCallId('bot-roster-approval')
      const args = '{}'
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: TOOL, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: TOOL, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: REPLY }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: REPLY } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function captureMedia(page: Page, name: string): Promise<void> {
  const directory = process.env.YH_BOT_ATTENTION_SCREENSHOTS
  if (directory === undefined) return
  await mkdir(directory, { recursive: true })
  const viewport = page.viewportSize()
  if (viewport !== null) await page.mouse.move(viewport.width - 4, 96)
  await page.getByRole('tooltip').first().waitFor({ state: 'hidden' })
  await page.screenshot({ path: join(directory, name + '.png'), animations: 'disabled' })
}

it('marks a Bot awaiting approval in its row, collapsed folder, and compact sidebar', async () => {
  const scaffold = await launchWebScaffold({
    replayFixture: FIXTURE,
    replayProvidersOnly: true,
    profile: { hmr: false, packages: [] },
    extraOverlayPath: PERMISSION_PRESETS,
  })
  try {
    let executions = 0
    await scaffold.ctx.settings.update('ui-theme', { preference: 'system' })
    const adapter = new PendingRosterAdapter()
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter), 'Bot roster fixture model')
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
    scaffold.ctx.effect(() => scaffold.ctx.tools.register({
      ...defineTool({
        name: TOOL,
        description: 'Read a sample record.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: () => {
          executions += 1
          return Promise.resolve('Sample record')
        },
      }),
      source: { kind: 'mcp', serverName: 'fixture' },
    }), 'Bot roster fixture tool')
    const { bot } = await scaffold.ctx.bots.create({
      name: 'Scout', identity: 'browse', accent: 'teal', cwd: scaffold.workspaceCwd,
    })
    const { bot: analyst } = await scaffold.ctx.bots.create({
      name: 'Analyst', identity: 'goal', accent: 'amber', cwd: scaffold.workspaceCwd,
    })
    await scaffold.ctx.bots.setConnectedAppAccess({ botId: bot.id, appId: 'fixture', allowed: true })
    await scaffold.ctx.bots.updateOrganization({ botId: bot.id, group: 'Research' })
    await scaffold.ctx.bots.updateOrganization({ botId: analyst.id, group: 'Research' })

    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser, 900)
      onTestFailed(() => saveFailureShot(page, 'web-e2e-bot-roster-approval'))
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByRole('button', { name: 'Bots', exact: true }).click()
      const roster = page.getByRole('complementary', { name: 'Bot workspace', exact: true })
      await roster.getByRole('button', { name: 'Scout', exact: true }).click()
      const composer = page.getByRole('textbox', { name: 'Message Scout', exact: true })
      await writeComposerDraft(page, composer, WARMUP)
      await composer.press('Enter')
      await page.getByText(REPLY, { exact: true }).waitFor()
      const agent = scaffold.ctx.agents.get(bot.sessionId)
      if (agent === undefined) throw new Error('The fixture Bot has no Agent.')

      const gate = agent.ctx.inject(['tools'], (scope) => {
        scope.on('tools/pre-execute', async (exec, next) => {
          const decision = await next()
          if (exec.name === TOOL && decision.kind === 'allow') return { kind: 'ask' as const, reason: 'Review the sample lookup.' }
          return decision
        })
      })
      try {
        await writeComposerDraft(page, composer, TRIGGER)
        await composer.press('Enter')
        const approval = page.locator('[data-approval-key]')
        await approval.waitFor()
        const pendingBot = roster.getByRole('button', { name: 'Scout, Needs you', exact: true })
        const folder = roster.getByRole('button', { name: /^Research/ })
        await pendingBot.waitFor()
        await folder.click()
        await expect.poll(() => folder.getAttribute('aria-expanded')).toBe('false')
        await roster.getByRole('img', { name: 'Needs you (1)', exact: true }).waitFor()
        expect(await pendingBot.isVisible()).toBe(false)
        expect(await approval.isVisible()).toBe(true)

        const snapshot = await captureStableAria(
          page, 'aside[aria-label="Bot workspace"] button[aria-expanded="false"][aria-controls]', scaffold.workspaceCwd,
        )
        await compareOrRefreshGolden(EXPECTED, snapshot, webSnapshotMode())

        for (const colorScheme of ['dark', 'light'] as const) {
          await page.emulateMedia({ colorScheme })
          const darkBody = page.locator('body[data-ds-dark-theme]')
          await darkBody.waitFor({ state: colorScheme === 'dark' ? 'visible' : 'detached' })
          await page.setViewportSize({ width: 1440, height: 900 })
          await folder.waitFor()
          if (await folder.getAttribute('aria-expanded') === 'true') await folder.click()
          await roster.getByRole('img', { name: 'Needs you (1)', exact: true }).waitFor()
          await captureMedia(page, 'folder-' + colorScheme)
          await folder.click()
          await pendingBot.waitFor()
          await captureMedia(page, 'roster-1440-' + colorScheme)

          await page.setViewportSize({ width: 480, height: 900 })
          await folder.waitFor({ state: 'detached' })
          await pendingBot.locator('[data-state="warning"]').waitFor()
          await captureMedia(page, 'roster-480-' + colorScheme)
        }

        const [settled] = await Promise.all([
          scaffold.whenTurnSettled(),
          approval.getByRole('button', { name: 'Reject', exact: true }).click(),
        ])
        expect(settled).toBe(bot.sessionId)
        await approval.waitFor({ state: 'detached' })
        await pendingBot.waitFor({ state: 'detached' })
        await page.setViewportSize({ width: 1440, height: 900 })
        await folder.click()
        await expect.poll(() => folder.getAttribute('aria-expanded')).toBe('false')
        expect(await roster.getByRole('img', { name: /^Needs you/ }).count()).toBe(0)
        expect(executions).toBe(0)
      } finally {
        await gate.dispose()
      }
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
}, 120_000)
