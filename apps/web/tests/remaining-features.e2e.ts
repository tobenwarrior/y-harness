/** Built web acceptance for explicit native learning, exact maintenance, source mirrors and separate Decision advice. */
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page, type Request } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { LlmAdapter, ReasoningEffortId, ServiceTierId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SkillLearningNativeItem, SkillLibraryItem } from '@deepseek-ai/dsh-skill-library/types'
import type { CodingSessionClaimAcknowledgement, CodingSessionNativeTurnId, CodingSessionProvider, CodingSessionReadRequest, CodingSessionSequentialReleaseReceipt, CodingSessionSnapshot, CodingSessionSource } from '@deepseek-ai/dsh-coding-session'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-llm-pi-ai'
import { launchWebScaffold, readPersistedEvents, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, openSettings, saveFailureShot } from './support.ts'

const ARTIFACT_ROOT = process.env.DSH_REMAINING_ARTIFACT_DIR
  ?? fileURLToPath(new URL('../../../.artifacts/screenshots/remaining-features/', import.meta.url))
const FIXTURE_PROJECT = 'Sample data · Remaining features'
const NATIVE_FIXTURE_PROVIDER = 'remaining-native-observation-fixture'
const DECISION_FIXTURE_PROVIDER = 'remaining-response-only-fixture'
const NATIVE_UNAVAILABLE_PROVIDER = 'remaining-native-capability-fixture'

interface World {
  scaffold: WebScaffold
  page: Page
  shots: string
  /** Browser-originated wire requests, without ambient account traffic. */
  remoteRequests: string[]
  /** Fixture-owned external cleanup precedes the production Host drain. */
  cleanups: (() => Promise<void>)[]
}

/** Each scenario owns a complete temporary Loader world and its browser context. */
async function inWorld(
  name: string, run: (world: World) => Promise<void>, options: { enableSequentialHandoff?: boolean } = {},
): Promise<void> {
  expect(webSnapshotMode(), 'This acceptance lane is fixture-only').not.toBe('record')
  const patchRoot = await mkdtemp(join(tmpdir(), `dsh-remaining-${name}-`))
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  const cleanups: (() => Promise<void>)[] = []
  try {
    const overlay = join(patchRoot, 'remaining.patch.yml')
    await writeFile(overlay, [
      '- id: skill-library', '  config:', '    automaticMaintenanceIntervalMs: 0',
      '- id: coding-sessions', '  config:', '    enableClaudeDiscovery: false',
      `    enableSequentialHandoff: ${options.enableSequentialHandoff === true}`, '',
    ].join('\n'))
    const nativeInputs = {
      DSH_CODEX_BINARY: join(patchRoot, 'absent-fixture-codex'),
      DSH_CODEX_HOME: join(patchRoot, 'absent-fixture-codex-home'),
      DSH_CODEX_SHELL_HOME: join(patchRoot, 'absent-fixture-shell-home'),
      DSH_CODEX_CWD: patchRoot,
      DSH_CODEX_NODE: process.execPath,
      DSH_CLAUDE_BINARY: join(patchRoot, 'absent-fixture-claude'),
      CLAUDE_CONFIG_DIR: join(patchRoot, 'absent-fixture-claude-home'),
    }
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay,
      launchEnvironment: createLaunchEnvironmentSnapshot([{ source: 'process', values: nativeInputs }]),
    })
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    const consoleProblems: string[] = []
    const remoteRequests: string[] = []
    const observeRequest = (request: Request): void => {
      if (request.method() === 'POST' && request.url().startsWith(scaffold!.baseUrl)) {
        remoteRequests.push(`${request.url()} ${request.postData() ?? ''}`)
      }
    }
    page.on('request', observeRequest)
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') consoleProblems.push(message.text())
    })
    onTestFailed(() => saveFailureShot(page, `web-e2e-remaining-${name}`))
    await mkdir(ARTIFACT_ROOT, { recursive: true })
    const shots = await mkdtemp(join(ARTIFACT_ROOT, `${name}-`))
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const mainSelection = scaffold.ctx.agentDefaultModel.currentSelection()
    const nativeControls = await scaffold.ctx.codexBackendConnection.getState()
    expect(nativeControls).toMatchObject({ enabled: false, connected: false, running: 0, tiers: {} })
    await run({ scaffold, page, shots, remoteRequests, cleanups })
    expect(scaffold.ctx.agentDefaultModel.currentSelection()).toEqual(mainSelection)
    expect(await scaffold.ctx.codexBackendConnection.getState()).toEqual(nativeControls)
    for (const path of Object.values(nativeInputs).filter(value => value !== patchRoot && value !== process.execPath)) {
      expect(existsSync(path), 'Acceptance never starts or writes a native profile').toBe(false)
    }
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    expect(consoleProblems).toEqual([])
    page.off('request', observeRequest)
    console.log(`Remaining feature screenshots: ${shots}`)
  } finally {
    const failures: unknown[] = []
    for (const cleanup of cleanups.toReversed()) await cleanup().catch((error: unknown) => { failures.push(error) })
    if (browser !== undefined) await browser.close().catch((error: unknown) => { failures.push(error) })
    if (scaffold !== undefined) await scaffold.close().catch((error: unknown) => { failures.push(error) })
    await rm(patchRoot, { recursive: true, force: true }).catch((error: unknown) => { failures.push(error) })
    if (failures.length > 0) throw new AggregateError(failures, 'Remaining feature fixture teardown failed')
  }
}

/** Capture settled product content in both palettes; no screenshot is treated as a passing assertion. */
async function capturePalettes(world: World, name: string): Promise<void> {
  for (const theme of ['dark', 'light'] as const) {
    await world.page.emulateMedia({ colorScheme: theme })
    await expect.poll(() => world.page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme')))
      .toBe(theme === 'dark')
    await world.page.screenshot({ path: join(world.shots, `remaining-${name}-en-${theme}.png`), animations: 'disabled' })
  }
  await world.page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => world.page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(true)
}

/** Change language through the stored Settings control, then return to the previous product surface. */
async function changeLanguage(page: Page, language: 'en' | 'zh', settingsOpen = false): Promise<void> {
  const previous = language === 'zh' ? 'en' : 'zh'
  if (!settingsOpen) await openSettings(page, previous)
  const dialog = page.getByRole('dialog', { name: previous === 'en' ? 'Settings' : '设置', exact: true })
  await dialog.getByRole('button', { name: previous === 'en' ? 'General' : '通用设置', exact: true }).click()
  await dialog.getByRole('button', { name: previous === 'en' ? 'English' : '中文', exact: true }).click()
  await page.getByRole('menuitem', { name: language === 'en' ? 'English' : '中文', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe(language === 'en' ? 'en' : 'zh-CN')
  if (!settingsOpen) {
    await page.getByRole('dialog', { name: language === 'en' ? 'Settings' : '设置', exact: true })
      .getByRole('button', { name: language === 'en' ? 'Close' : '关闭', exact: true }).click()
  }
}

async function fixtureProject(world: World): Promise<{ id: string; path: string }> {
  const path = join(world.scaffold.workspaceCwd, 'workspace')
  await mkdir(join(path, '.git'), { recursive: true })
  await connectFreshWorkspace(world.page, world.scaffold.workspaceCwd)
  const project = world.scaffold.ctx.workspaceRegistry.list().find(value => value.path === path)
  if (project === undefined) throw new Error('The browser workspace was not registered')
  await project.setTitle(FIXTURE_PROJECT)
  return { id: project.id, path }
}

async function openSkills(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Skills', exact: true }).click()
  await page.getByRole('heading', { name: 'Skills', exact: true }).waitFor()
}

async function chooseProject(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Project', exact: true }).click()
  await page.getByRole('menuitem', { name: FIXTURE_PROJECT, exact: true }).click()
}

/** Inspect one fixture through the ordinary generated detail Remote. */
async function inspectSkill(page: Page, name: string): Promise<Locator> {
  await page.getByRole('button', { name: `Inspect ${name}`, exact: true }).click()
  const detail = page.getByRole('complementary', { name: 'Details', exact: true })
  await detail.getByRole('heading', { name, exact: true }).waitFor()
  return detail
}

function assertRemote(world: World, method: string): void {
  expect(world.remoteRequests.some(request => request.includes(method)), `Browser sent ${method} through the generated Remote`).toBe(true)
}

/** Fixture-native actions are emitted only while this adapter owns the exact initiating root turn. */
class NativeObservationFixture extends LlmAdapter {
  calls = 0
  constructor(private readonly scaffold: WebScaffold) { super() }
  override providerInfo(provider: string) {
    return { id: provider, name: 'Sample data · Native observation fixture', auxiliaryGeneration: 'native' as const }
  }
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'recorded-facts', name: 'Fixture recorded facts', contextWindow: 128_000 }])
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: 'Fixture recorded facts', context: { contextWindow: 128_000 } })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    if (options.purpose !== undefined || options.provider !== NATIVE_FIXTURE_PROVIDER) throw new Error('Unexpected fixture-native inference route')
    const agents = this.scaffold.ctx.agents
    const agent = agents.currentInitiator()
    if (agent === undefined || agents.get(agent.id) !== agent || agent.session.id !== options.sessionId
      || agent.session.header.parentSession !== undefined || agent.session.header.isSeeded) {
      throw new Error('Fixture-native facts require the exact live root initiator')
    }
    const turnId = `fixture-native-turn-${++this.calls}`
    const sequence = this.calls < 3 ? ['read', 'check'] as const : ['check', 'read'] as const
    for (const [index, action] of sequence.entries()) {
      const item: SkillLearningNativeItem = {
        provider: 'codex', connectionId: brandString<SkillLearningNativeItem['connectionId']>(createHash('sha256').update('remaining-fixture-profile').digest('hex')),
        sessionId: brandString<Extract<SkillLearningNativeItem, { provider: 'codex' }>['sessionId']>('fixture-native-original-thread'), turnId: brandString<Extract<SkillLearningNativeItem, { provider: 'codex' }>['turnId']>(turnId),
        itemId: brandString<Extract<SkillLearningNativeItem, { provider: 'codex' }>['itemId']>(`${turnId}-item-${index}`), kind: action === 'read' ? 'read' : 'command',
        name: `Fixture recorded ${action}`, phase: 'started',
        procedure: action === 'read' ? { kind: 'read', path: 'src/source.ts' } : { kind: 'check', command: 'pnpm run test' },
      }
      agent.session.append('skill/native-item', item, { ignorable: true })
      agent.session.append('skill/native-item', { ...item, phase: 'settled', outcome: 'reported-success' }, { ignorable: true })
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Fixture native results were delivered. Task quality and successful Skill use are unverified.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('approves an empty native project, records fixture facts and updates one reversible Y workflow', async () => {
  await inWorld('native-learning', async (world) => {
    const { scaffold, page } = world
    const project = await fixtureProject(world)
    const library = scaffold.ctx.skillLibrary
    expect((await library.list({ projectId: project.id })).items).toEqual([])
    await openSkills(page)
    await chooseProject(page)
    await page.getByRole('button', { name: 'Project learning', exact: true }).click()
    const consent = page.getByRole('dialog', { name: 'Project learning', exact: true })
    await consent.getByRole('button', { name: 'Learning project', exact: true }).waitFor()
    expect(await consent.getByRole('button', { name: 'Approve project learning', exact: true }).isEnabled()).toBe(false)
    await consent.getByRole('checkbox', { name: 'Allow new skills from native work', exact: true }).click()
    await capturePalettes(world, 'native-project-policy')
    await consent.getByRole('button', { name: 'Approve project learning', exact: true }).click()
    await consent.waitFor({ state: 'hidden' })
    await expect.poll(() => library.learningStatus({}).policies.filter(policy => policy.projectId === project.id).length).toBe(1)
    expect((await library.list({ projectId: project.id })).items).toEqual([])
    const adapter = new NativeObservationFixture(scaffold)
    const registration = scaffold.ctx.llm.registerAdapter([NATIVE_FIXTURE_PROVIDER], adapter)
    const { agent } = await scaffold.ctx.agents.create({
      sessionId: SessionId('remaining-live-native-fixture'),
      agentOptions: { provider: NATIVE_FIXTURE_PROVIDER, model: 'recorded-facts' },
      meta: { cwd: project.path },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx).then(() => undefined),
    })
    const run = async (expectedCalls: number): Promise<void> => {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Fixture task: inspect the project source and record the check sequence.' }] }))
      await agent.whenIdle()
      expect(adapter.calls).toBe(expectedCalls)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end' && event.data.reason.kind === 'error')).toEqual([])
      await expect.poll(() => library.listLearningEvidence({ projectId: project.id }).length).toBe(expectedCalls)
    }
    await run(1)
    await expect.poll(() => library.listProposals({ projectId: project.id })
      .filter(proposal => proposal.operation === 'learn' && proposal.state === 'applied')).toHaveLength(1)
    await expect.poll(async () => (await library.list({ projectId: project.id })).items.length).toBe(1)
    const created = (await library.list({ projectId: project.id })).items[0]!
    expect(created).toMatchObject({ scope: 'project', ownership: 'y-managed', usage: { coverage: 'unknown', loadCount: 0 } })
    const first = await library.detail({ id: created.id })
    const registry = scaffold.ctx.get('agentPresets')?.serviceFor(agent, 'skills') ?? scaffold.ctx.get('skills')
    if (registry === undefined) throw new Error('The initiating agent has no invocation registry')
    const lookup = { cwd: project.path, scope: agent }
    const assertInvocable = async (content: string): Promise<void> => {
      await expect.poll(async () => (await registry.snapshot(lookup)).skills.find(skill => skill.name === created.name))
        .toMatchObject({ name: created.name, path: created.path, invocation: { modelInvocable: true } })
      await expect.poll(async () => (await registry.get(created.name, lookup))?.content).toBe(content.trim())
      expect(await registry.get(created.name, lookup))
        .toMatchObject({ name: created.name, path: created.path, invocation: { modelInvocable: true } })
    }
    await assertInvocable(first.content)
    expect(first.content).toContain('1. Read `src/source.ts`')
    expect(first.content).toContain('2. Run `pnpm run test`')
    await run(2)
    expect((await library.list({ projectId: project.id })).items.map(item => item.id)).toEqual([created.id])
    expect((await library.detail({ id: created.id })).content).toBe(first.content)
    await run(3)
    await expect.poll(() => library.listProposals({ projectId: project.id })
      .filter(proposal => proposal.operation === 'learn' && proposal.state === 'applied')).toHaveLength(2)
    await expect.poll(async () => (await library.detail({ id: created.id })).revisions.length).toBe(1)
    const updated = await library.detail({ id: created.id })
    expect(updated.content.match(/## Observed procedure/g)).toHaveLength(2)
    expect(updated.content).toContain('1. Run `pnpm run test`')
    await assertInvocable(updated.content)
    expect((await library.list({ projectId: project.id })).items.map(item => item.id)).toEqual([created.id])
    const evidence = library.listLearningEvidence({ projectId: project.id })
    expect(evidence.every(row => row.checks.length === 0 && row.native?.actions.length === 2)).toBe(true)
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    const detail = await inspectSkill(page, created.name)
    await expect.poll(() => detail.locator('pre').textContent()).toBe(updated.content)
    await detail.getByText('Usage unknown', { exact: true }).waitFor()
    await capturePalettes(world, 'native-managed-history')
    await detail.getByRole('button', { name: 'Restore content from before this revision', exact: true }).first().click()
    await expect.poll(async () => (await library.detail({ id: created.id })).content).toBe(first.content)
    await assertInvocable(first.content)
    const events = await readPersistedEvents(scaffold, agent.session.id)
    expect(events.filter(event => event.type === 'skill/native-item')).toHaveLength(12)
    expect(events.filter(event => event.type === 'skill/native-item').every(event => event.ignorable === true)).toBe(true)
    const durable = await readFile(join(scaffold.workspaceCwd, '.dsh-storages', 'skill_learning.json'), 'utf8')
    expect(durable).toContain('fixture-native-original-thread')
    expect(durable).toContain('fixture-native-turn-3')
    expect(durable).toContain('native-observation-v1')
    assertRemote(world, 'approveLearningPolicy')
    assertRemote(world, 'rollback')
    await changeLanguage(page, 'zh')
    await page.getByRole('button', { name: '项目学习', exact: true }).click()
    await page.getByRole('dialog', { name: '项目学习', exact: true }).getByRole('button', { name: '撤销项目学习', exact: true }).waitFor()
    await page.screenshot({ path: join(world.shots, 'remaining-native-project-policy-zh-dark.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    registration()
  })
})

interface SkillFixture { name: string; directory: string; path: string; original: string; reduced: string; resource: Uint8Array }

/** Reference-only duplication is the sole permitted edit; every action and resource stays exact. */
async function writeMaintenanceFixture(project: string, name: string): Promise<SkillFixture> {
  const directory = join(project, '.dsh', 'skills', name)
  await mkdir(directory, { recursive: true })
  const header = `---\nname: ${name}\ndescription: Sample data — reversible reference maintenance\n---\n\n`
  const body = [
    `# ${name}`, '', 'Never publish without approval.', '',
    '- Press the pump button.', '- Press the pump button.', '',
    '1. Run the migration.', '2. Run the migration.', '',
    '```md', '- Keep this literal line.', '- Keep this literal line.', '```', '',
    '- [Outside references](resource.md)', '- [Outside references](resource.md)', '',
    '## References', '- [Guide](resource.md)', '- [Guide](resource.md)', '- [Runbook](runbook.md)', '',
  ].join('\n')
  const original = header + body
  const reduced = original.replace('- [Guide](resource.md)\n- [Guide](resource.md)', '- [Guide](resource.md)')
  const resource = Uint8Array.from([0, 255, 10, 128, 42, 0])
  const path = join(directory, 'SKILL.md')
  await Promise.all([
    writeFile(path, original), writeFile(join(directory, 'resource.md'), 'Supporting guide stays byte-for-byte intact.\n'),
    writeFile(join(directory, 'runbook.md'), 'Runbook stays byte-for-byte intact.\n'), writeFile(join(directory, 'fixture.bin'), resource),
  ])
  return { name, directory, path, original, reduced, resource }
}

async function adoptFixture(page: Page, name: string): Promise<Locator> {
  const detail = await inspectSkill(page, name)
  await detail.getByRole('button', { name: 'Manage with Y', exact: true }).click()
  const adoption = page.getByRole('dialog', { name: 'Manage this skill with Y', exact: true })
  await adoption.getByRole('button', { name: 'Manage with Y', exact: true }).click()
  await adoption.waitFor({ state: 'hidden' })
  await detail.getByText('Y managed', { exact: true }).waitFor()
  return detail
}

it('forces only consented reference reduction, protects pinned and edited bundles, and restores deleted bytes with consent off', async () => {
  await inWorld('semantic-maintenance', async (world) => {
    const { scaffold, page } = world
    const projectPath = join(scaffold.workspaceCwd, 'workspace')
    const fixtures = await Promise.all(['fixture-reference-cleanup', 'fixture-pinned-reference', 'fixture-edited-reference']
      .map(name => writeMaintenanceFixture(projectPath, name)))
    const project = await fixtureProject(world)
    const library = scaffold.ctx.skillLibrary
    await openSkills(page)
    await chooseProject(page)
    const first = fixtures[0]!
    const detail = await adoptFixture(page, first.name)
    expect(await detail.getByRole('switch', { name: 'Automatic learning', exact: true }).isChecked()).toBe(false)
    expect(await readFile(first.path, 'utf8')).toBe(first.original)
    await detail.getByRole('button', { name: 'Approve a policy', exact: true }).click()
    const approval = page.getByRole('dialog', { name: 'Approve automatic maintenance policy', exact: true })
    await approval.getByRole('button', { name: 'Validator', exact: true }).click()
    await page.getByRole('menuitem', { name: 'instruction-redundancy-validator', exact: true }).click()
    await approval.getByRole('checkbox', { name: 'Compress', exact: true }).click()
    await capturePalettes(world, 'maintenance-policy')
    await approval.getByRole('button', { name: 'Approve policy', exact: true }).click()
    await approval.waitFor({ state: 'hidden' })
    await expect.poll(() => library.learningStatus({}).policies.filter(policy => policy.validatorId === 'instruction-redundancy-validator').length).toBe(1)
    const policyLabel = 'instruction-redundancy-validator · Compress'
    const items: SkillLibraryItem[] = []
    for (const [index, fixture] of fixtures.entries()) {
      const selected = index === 0 ? detail : await adoptFixture(page, fixture.name)
      await selected.getByRole('button', { name: 'Policy', exact: true }).click()
      await page.getByRole('menuitem', { name: policyLabel, exact: true }).click()
      const automatic = selected.getByRole('switch', { name: 'Automatic learning', exact: true })
      await expect.poll(() => automatic.isEnabled()).toBe(true)
      expect(await automatic.isChecked()).toBe(false)
      await automatic.click()
      await expect.poll(() => automatic.isChecked()).toBe(true)
      const item = (await library.list({ projectId: project.id })).items.find(row => row.name === fixture.name)!
      items.push(item)
      await expect.poll(() => library.learningStatus({}).optIns.find(row => row.id === item.id)?.enabled).toBe(true)
      expect(await readFile(fixture.path, 'utf8')).toBe(fixture.original)
    }
    const pinned = fixtures[1]!
    let protectedDetail = await inspectSkill(page, pinned.name)
    await protectedDetail.getByRole('button', { name: 'Pin', exact: true }).click()
    await protectedDetail.getByRole('button', { name: 'Unpin', exact: true }).waitFor()
    expect(await protectedDetail.getByRole('button', { name: 'Force cleanup', exact: true }).isEnabled()).toBe(false)
    const edited = fixtures[2]!
    const editedContent = edited.original + '\nHuman fixture edit must remain.\n'
    await writeFile(edited.path, editedContent)
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    protectedDetail = await inspectSkill(page, edited.name)
    await protectedDetail.getByText('The source changed. Previous automatic consent no longer applies.', { exact: true }).waitFor()
    expect(await protectedDetail.getByRole('button', { name: 'Force cleanup', exact: true }).isEnabled()).toBe(false)
    const cleanupDetail = await inspectSkill(page, first.name)
    await cleanupDetail.getByRole('button', { name: 'Force cleanup', exact: true }).click()
    await expect.poll(() => readFile(first.path, 'utf8')).toBe(first.reduced)
    const appliedReductions = async () => {
      const summaries = library.listProposals({ projectId: project.id })
        .filter(proposal => proposal.operation === 'compress' && proposal.state === 'applied')
      const proposals = await Promise.all(summaries.map(proposal => library.detailProposal({ proposalId: proposal.id })))
      return proposals.filter(proposal => proposal.changes.length === 1 && proposal.changes[0]?.id === items[0]!.id)
    }
    await expect.poll(appliedReductions).toHaveLength(1)
    const reduction = (await appliedReductions())[0]!
    expect(reduction).toMatchObject({ operation: 'compress', changes: [{ kind: 'compress', id: items[0]!.id }], applicationMode: 'automatic', validation: { validatorId: 'instruction-redundancy-validator', receipt: { scope: 'instruction-redundancy-v1' } } })
    await expect.poll(() => cleanupDetail.getByRole('button', { name: 'Delete', exact: true }).isEnabled()).toBe(true)
    // Direct Host force admission cannot bypass the disabled UI protections.
    await library.cleanupSemantic({ projectId: project.id, ids: items.slice(1).map(item => item.id), force: true })
    expect(await readFile(pinned.path, 'utf8')).toBe(pinned.original)
    expect(await readFile(edited.path, 'utf8')).toBe(editedContent)
    expect(await readFile(join(first.directory, 'fixture.bin'))).toEqual(Buffer.from(first.resource))
    expect(await readFile(join(first.directory, 'resource.md'), 'utf8')).toBe('Supporting guide stays byte-for-byte intact.\n')
    expect(await readFile(join(first.directory, 'runbook.md'), 'utf8')).toBe('Runbook stays byte-for-byte intact.\n')
    await capturePalettes(world, 'maintenance-reference-history')
    await cleanupDetail.getByRole('button', { name: 'Delete', exact: true }).click()
    const deletion = page.getByRole('dialog', { name: 'Delete skill', exact: true })
    await deletion.getByRole('button', { name: 'Delete', exact: true }).click()
    await deletion.waitFor({ state: 'hidden' })
    await expect.poll(() => existsSync(first.directory)).toBe(false)
    await page.getByRole('button', { name: 'Deleted skills', exact: true }).click()
    const deleted = await inspectSkill(page, first.name)
    await deleted.getByRole('button', { name: 'Restore', exact: true }).waitFor()
    await capturePalettes(world, 'deleted-skill-recovery')
    await deleted.getByRole('button', { name: 'Restore', exact: true }).click()
    await expect.poll(() => readFile(first.path, 'utf8')).toBe(first.reduced)
    expect(await readFile(join(first.directory, 'fixture.bin'))).toEqual(Buffer.from(first.resource))
    const restored = (await library.detail({ id: items[0]!.id })).item
    expect(restored).toMatchObject({ status: 'active', automaticCleanup: false })
    expect(library.learningStatus({}).optIns.find(row => row.id === restored.id)?.enabled).toBe(false)
    await page.getByRole('button', { name: 'Deleted skills', exact: true }).click()
    const restoredDetail = await inspectSkill(page, first.name)
    expect(await restoredDetail.getByRole('switch', { name: 'Automatic learning', exact: true }).isChecked()).toBe(false)
    assertRemote(world, 'approveLearningPolicy')
    assertRemote(world, 'setAutomaticLearning')
    assertRemote(world, 'cleanupSemantic')
    assertRemote(world, 'archive')
    assertRemote(world, 'restore')
    await changeLanguage(page, 'zh')
    await page.getByRole('button', { name: '已删除技能', exact: true }).waitFor()
    await page.screenshot({ path: join(world.shots, 'remaining-maintenance-restored-zh-dark.png'), animations: 'disabled' })
  })
})

/** Enforce fixture bounds at the source seam as well as in the real mirror service. */
function boundedHistory(history: CodingSessionSnapshot, request: CodingSessionReadRequest): CodingSessionSnapshot {
  request.signal.throwIfAborted()
  if (history.events.length > request.maxEvents || Buffer.byteLength(JSON.stringify(history)) > request.maxBytes) {
    throw new Error('Fixture history exceeds the admitted source request')
  }
  return structuredClone(history)
}

/** Add unrelated fixture history under the public cold write owner, without creating an Agent. */
async function appendColdFixtureHuman(scaffold: WebScaffold, id: SessionId, text: string): Promise<void> {
  const handle = await scaffold.ctx.sessionPersistence.open(id, 'write')
  try {
    const read = await handle.read()
    const session = Session.fromRestore(
      id, read.events, handle.header, handle.inheritedEventCount, read.eventState, scaffold.ctx.sessions.messageProjections,
    )
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
    await handle.append(session.snapshotEvents().slice(read.events.length))
    await handle.flush()
  } finally { await handle.close() }
}

/** Derive effective context from a fresh public persistence read; the detached restore marker is not written. */
async function coldFixtureMessages(scaffold: WebScaffold, id: SessionId) {
  const handle = await scaffold.ctx.sessionPersistence.open(id, 'read')
  try {
    const read = await handle.read()
    return Session.fromRestore(
      id, read.events, handle.header, handle.inheritedEventCount, read.eventState, scaffold.ctx.sessions.messageProjections,
    ).deriveMessages()
  } finally { await handle.close() }
}

it('imports original fixture identities, refreshes append-only history idempotently and retains divergent mirrors without continuation', async () => {
  await inWorld('coding-sessions', async (world) => {
    const { scaffold, page } = world
    await fixtureProject(world)
    const source: CodingSessionSource = {
      provider: 'codex', profileId: brandString<CodingSessionSource['profileId']>('fixture-authorized-native-profile'), nativeSessionId: brandString<CodingSessionSource['nativeSessionId']>('fixture-original-native-id'),
    }
    let history: CodingSessionSnapshot = {
      source, title: 'Sample data · Native parser history', cwd: join(scaffold.workspaceCwd, 'workspace'), writerState: 'idle', cursor: 'fixture-cursor-1',
      events: [
        { id: brandString<CodingSessionSnapshot['events'][number]['id']>('fixture-original-user-1'), role: 'user', text: 'Fixture history: inspect the parser and preserve approval rules.', digest: 'fixture-digest-1' },
        { id: brandString<CodingSessionSnapshot['events'][number]['id']>('fixture-original-tool-2'), role: 'tool', text: 'Fixture native item: source file read; reported outcome only.', digest: 'fixture-digest-2' },
        { id: brandString<CodingSessionSnapshot['events'][number]['id']>('fixture-original-assistant-3'), role: 'assistant', text: 'Fixture history: the parser change still requires independent verification.', digest: 'fixture-digest-3' },
      ],
    }
    const reads: CodingSessionSource['nativeSessionId'][] = []
    let discoveries = 0
    const unregister = scaffold.ctx.codingSessions.registerProvider({
      provider: source.provider, profileId: source.profileId, label: 'Sample data · Read-only Codex fixture', connected: () => true,
      discover: async (request) => {
        request.signal.throwIfAborted()
        if (request.limit < 1) throw new Error('Fixture discovery requires one admitted item')
        discoveries++
        return { items: [{ source, title: history.title, cwd: history.cwd, writerState: history.writerState }] }
      },
      read: async (nativeId, request) => {
        if (nativeId !== source.nativeSessionId) throw new Error('Fixture received a replacement native ID')
        reads.push(nativeId)
        return boundedHistory(history, request)
      },
    })
    expect((await scaffold.ctx.codingSessions.getState()).sources).toContainEqual({
      provider: source.provider, profileId: source.profileId, label: 'Sample data · Read-only Codex fixture', connected: true,
      capabilities: { discover: true, read: true, refresh: true, continue: false, reason: 'native-writer-handoff-unavailable' },
    })
    await openSettings(page, 'en')
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Coding sessions', exact: true }).click()
    const reloadSources = settings.getByRole('button', { name: 'Reload sources', exact: true })
    await expect.poll(() => reloadSources.isEnabled()).toBe(true)
    await reloadSources.click()
    const sourceLabel = settings.getByText('Sample data · Read-only Codex fixture', { exact: true })
    await sourceLabel.waitFor()
    await sourceLabel.locator('xpath=ancestor::div[button][1]').getByRole('button', { name: 'Browse sessions', exact: true }).click()
    await settings.getByText(source.nativeSessionId, { exact: true }).waitFor()
    await settings.getByRole('button', { name: 'Import', exact: true }).click()
    const session = settings.getByRole('region', { name: 'Session history', exact: true })
    await session.getByText(history.events[0]!.text, { exact: true }).waitFor()
    for (const event of history.events) await session.getByText(event.text, { exact: true }).waitFor()
    await session.getByText(source.profileId, { exact: true }).waitFor()
    await session.getByRole('button', { name: 'Continue original session', exact: true }).waitFor()
    expect(await session.getByRole('button', { name: 'Continue original session', exact: true }).isEnabled()).toBe(false)
    await session.getByText('This connection cannot safely hand off native writer ownership. Continue in the native app, then refresh here.', { exact: true }).waitFor()
    const initial = (await scaffold.ctx.codingSessions.getState()).mirrors[0]!
    expect(initial.source).toEqual(source)
    expect(initial.capabilities).toMatchObject({ continue: false, reason: 'native-writer-handoff-unavailable' })
    await capturePalettes(world, 'coding-original-history')
    const appended = { id: brandString<CodingSessionSnapshot['events'][number]['id']>('fixture-original-assistant-4'), role: 'assistant' as const, text: 'Fixture native append: preserve the original session and inspect the focused check.', digest: 'fixture-digest-4' }
    history = { ...history, cursor: 'fixture-cursor-2', events: [...history.events, appended] }
    await session.getByRole('button', { name: 'Refresh source', exact: true }).click()
    await session.getByText(appended.text, { exact: true }).waitFor()
    const refreshed = await scaffold.ctx.codingSessions.detail(initial.id)
    expect(refreshed.events.map(event => event.id)).toEqual(history.events.map(event => event.id))
    expect(refreshed.revision).toBe(initial.revision + 1)
    await session.getByRole('button', { name: 'Refresh source', exact: true }).click()
    await expect.poll(() => reads.length).toBe(3)
    await expect.poll(() => session.getByRole('button', { name: 'Refresh source', exact: true }).isEnabled()).toBe(true)
    expect((await scaffold.ctx.codingSessions.detail(initial.id)).revision).toBe(refreshed.revision)

    // The browser explicitly creates, reviews and imports into an ordinary cold Y destination.
    const destinationSelect = session.getByRole('combobox', { name: 'Y import destination', exact: true })
    await session.getByRole('button', { name: 'Create cold Y destination', exact: true }).click()
    await expect.poll(() => destinationSelect.inputValue()).not.toBe('')
    const destinationId = SessionId(await destinationSelect.inputValue())
    expect((await scaffold.ctx.codingSessions.getState()).importDestinations)
      .toContainEqual({ id: destinationId, project: history.cwd, live: false })
    expect(scaffold.ctx.sessions.get(destinationId)).toBeUndefined()
    const reviewDestination = session.getByRole('button', { name: 'Review destination revision', exact: true })
    await expect.poll(() => reviewDestination.isEnabled()).toBe(true)
    await reviewDestination.click()
    await expect.poll(() => reviewDestination.isEnabled()).toBe(true)
    const emptyReview = await scaffold.ctx.codingSessions.inspectImportDestination(destinationId)
    expect(emptyReview.revision.eventCount).toBe(0)
    await session.getByText(emptyReview.revision.digest, { exact: true }).waitFor()
    const displayedCount = session.getByText('Canonical destination event count', { exact: true }).locator('xpath=following-sibling::dd[1]')
    await expect.poll(() => displayedCount.textContent()).toBe(String(emptyReview.revision.eventCount))
    await session.getByRole('button', { name: 'Import quoted history into Y', exact: true }).click()
    await session.getByText('Active quoted history', { exact: true }).waitFor()
    const linkSummary = (await scaffold.ctx.codingSessions.getState()).links?.find(link => link.destinationSessionId === destinationId)
    if (linkSummary === undefined) throw new Error('Browser import did not retain its exact destination mapping')
    const linked = await scaffold.ctx.codingSessions.linkedDetail(linkSummary.id)
    expect(linked).toMatchObject({ mirrorId: initial.id, source, destinationSessionId: destinationId, project: history.cwd, status: 'active' })
    expect(linked.generations).toHaveLength(1)
    const generation = linked.generations[0]!
    expect(generation.rawEvents).toEqual(refreshed.events)
    expect(generation.message).toMatchObject({ role: 'user', source: { kind: 'coding-session-import', ...source, mirrorId: initial.id, linkId: linked.id, disposition: 'active' } })
    expect(generation.mappings.map(mapping => [mapping.nativeEventId, mapping.nativeDigest]))
      .toEqual(refreshed.events.map(event => [event.id, event.digest]))
    const quoted = generation.message.content[0]
    if (quoted?.type !== 'text') throw new Error('Imported fixture context must remain quoted text')
    for (const [index, mapping] of generation.mappings.entries()) {
      const native = refreshed.events[index]!
      expect(JSON.parse(quoted.text.slice(mapping.textStart, mapping.textEnd)))
        .toEqual({ nativeEventId: native.id, nativeDigest: native.digest, role: native.role, text: native.text })
    }
    const importedRaw = await readPersistedEvents(scaffold, destinationId)
    expect(importedRaw).toContainEqual(generation.event)
    expect(importedRaw.some(event => ['request/header', 'request/context', 'assistant/message', 'tool/call'].includes(event.type))).toBe(false)
    expect(scaffold.ctx.sessions.get(destinationId)).toBeUndefined()
    await session.getByText('Active quoted history', { exact: true }).scrollIntoViewIfNeeded()
    await capturePalettes(world, 'coding-linked-quoted-context')

    // Compensation must retain the complete prior canonical log and a later unrelated human message.
    const humanText = 'Fixture unrelated Y history: retain this exact human message after compensation.'
    await appendColdFixtureHuman(scaffold, destinationId, humanText)
    const beforeCompensation = await readPersistedEvents(scaffold, destinationId)
    const human = beforeCompensation.find(event => event.type === 'user/message' && event.data.source.kind === 'user'
      && event.data.content.some(block => block.type === 'text' && block.text === humanText))
    if (human?.type !== 'user/message') throw new Error('Unrelated fixture human history was not persisted')
    await reviewDestination.click()
    await expect.poll(() => reviewDestination.isEnabled()).toBe(true)
    const rollbackReview = await scaffold.ctx.codingSessions.inspectImportDestination(destinationId)
    expect(rollbackReview.revision.eventCount).toBe(beforeCompensation.length)
    expect(rollbackReview.revision.digest).not.toBe(emptyReview.revision.digest)
    await session.getByText(rollbackReview.revision.digest, { exact: true }).waitFor()
    await expect.poll(() => displayedCount.textContent()).toBe(String(rollbackReview.revision.eventCount))
    const compensate = session.getByRole('button', { name: 'Compensate linked import', exact: true })
    expect(await compensate.isEnabled()).toBe(false)
    await session.getByRole('checkbox', { name: 'I understand compensation preserves the original raw event log', exact: true }).click()
    await expect.poll(() => compensate.isEnabled()).toBe(true)
    await compensate.click()
    await session.getByText('Compensated quoted history', { exact: true }).waitFor()
    const rolled = await scaffold.ctx.codingSessions.linkedDetail(linked.id)
    expect(rolled).toMatchObject({ status: 'rolled-back', destinationSessionId: destinationId })
    expect(rolled.generations[0]).toMatchObject({ status: 'rolled-back', rawEvents: generation.rawEvents, event: generation.event, message: generation.message, mappings: generation.mappings })
    const afterCompensation = await readPersistedEvents(scaffold, destinationId)
    expect(afterCompensation.slice(0, beforeCompensation.length)).toEqual(beforeCompensation)
    expect(afterCompensation.length).toBeGreaterThan(beforeCompensation.length)
    expect(afterCompensation).toContainEqual(human)
    const withdrawal = afterCompensation.slice(beforeCompensation.length).find(event => event.type === 'user/message')
    expect(withdrawal).toMatchObject({ type: 'user/message', surfaceOp: { op: 'replace', startSeq: generation.destinationSeq, endSeq: generation.destinationSeq }, sourceEventSeqs: [generation.destinationSeq],
      data: { source: { kind: 'coding-session-import', disposition: 'rolled-back', linkId: linked.id } } })
    const effective = await coldFixtureMessages(scaffold, destinationId)
    expect(effective).toContainEqual(human.data)
    const importedContext = effective.filter(message => message.source.kind === 'coding-session-import')
    expect(importedContext).toHaveLength(1)
    expect(importedContext[0]).toMatchObject({ role: 'user', source: { disposition: 'rolled-back', linkId: linked.id } })
    expect(JSON.stringify(importedContext)).toContain('Imported native context withdrawn.')
    expect(JSON.stringify(importedContext)).not.toContain(refreshed.events[0]!.text)
    await session.getByText('Compensated quoted history', { exact: true }).scrollIntoViewIfNeeded()
    await capturePalettes(world, 'coding-linked-withdrawn-context')
    assertRemote(world, 'createImportDestination')
    assertRemote(world, 'inspectImportDestination')
    assertRemote(world, 'importIntoSession')
    assertRemote(world, 'rollbackImport')

    for (const divergent of [
      { ...history, cursor: 'fixture-edited-cursor', events: history.events.map((event, index) => index === 0 ? { ...event, text: 'Fixture native edited earlier history', digest: 'fixture-changed-digest' } : event) },
      { ...history, cursor: 'fixture-truncated-cursor', events: history.events.slice(0, 2) },
    ]) {
      history = divergent
      const expectedReads = reads.length + 1
      await session.getByRole('button', { name: 'Refresh source', exact: true }).click()
      await expect.poll(() => reads.length).toBe(expectedReads)
      await expect.poll(() => session.getByRole('button', { name: 'Refresh source', exact: true }).isEnabled()).toBe(true)
      await session.getByText('The source history changed. Your existing mirror is retained. Refresh after reviewing the native session.', { exact: true }).waitFor()
      const retained = await scaffold.ctx.codingSessions.detail(initial.id)
      expect(retained.status).toBe('conflict')
      expect(retained.events).toEqual(refreshed.events)
      expect(retained.source).toEqual(source)
      expect(await session.getByRole('button', { name: 'Continue original session', exact: true }).isEnabled()).toBe(false)
      await session.getByText(appended.text, { exact: true }).waitFor()
    }
    await capturePalettes(world, 'coding-divergence-retained')
    expect(discoveries).toBe(1)
    expect(reads).toHaveLength(5)
    expect(reads.every(id => id === source.nativeSessionId)).toBe(true)
    await expect(scaffold.ctx.codingSessions.continueSession(initial.id, 'Fixture unsupported continuation', refreshed.revision)).rejects.toThrow()
    const durable = await readFile(join(scaffold.workspaceCwd, '.dsh-storages', 'coding_sessions.json'), 'utf8')
    expect(durable).toContain(source.profileId)
    expect(durable).toContain(source.nativeSessionId)
    expect(durable).toContain(appended.id)
    expect(durable).not.toContain('Fixture native edited earlier history')
    assertRemote(world, 'discover')
    assertRemote(world, 'importSession')
    assertRemote(world, 'refreshMirror')
    await changeLanguage(page, 'zh', true)
    const chinese = page.getByRole('dialog', { name: '设置', exact: true })
    await chinese.getByRole('button', { name: '编程会话', exact: true }).click()
    await chinese.getByRole('region', { name: '会话记录', exact: true }).getByText(appended.text, { exact: true }).waitFor()
    await page.screenshot({ path: join(world.shots, 'remaining-coding-mirror-zh-dark.png'), animations: 'disabled' })
    await unregister()
    expect((await scaffold.ctx.codingSessions.getState()).sources.some(candidate => candidate.profileId === source.profileId)).toBe(false)
    expect((await scaffold.ctx.codingSessions.detail(initial.id)).events).toEqual(refreshed.events)
  })
})

/** Deterministic API replies exercise advice validation without real inference or tools. */
class DecisionResponseFixture extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  reply: 'selected' | 'unknown-id' | 'tool' | 'abstain' = 'selected'
  selectedId = ''
  override providerInfo(provider: string) {
    return { id: provider, name: 'Sample data · Response-only fixture', auxiliaryGeneration: 'api' as const }
  }
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'fixture-small', name: 'Fixture response-only small', contextWindow: 128_000 }])
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: 'Fixture response-only small', context: { contextWindow: 128_000 },
      reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Fixture low' }, { id: ReasoningEffortId('high'), name: 'Fixture high' }] },
      serviceTiers: { tiers: [{ id: ServiceTierId('default'), name: 'Fixture standard' }, { id: ServiceTierId('priority'), name: 'Fixture priority' }] },
    })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    if (options.purpose !== 'skill-decision' || options.provider !== DECISION_FIXTURE_PROVIDER) throw new Error('Fixture API received a conversation or learning call')
    this.calls.push(options)
    if (this.reply === 'tool') {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      return
    }
    const text = JSON.stringify(this.reply === 'abstain' ? { state: 'abstain', ids: [] }
      : { state: 'selected', ids: [this.reply === 'unknown-id' ? 'fixture-not-admitted' : this.selectedId] })
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** A declared native capability refusal does not launch or configure a native provider. */
class NativeUnavailableFixture extends LlmAdapter {
  calls = 0
  metadataQueries = 0
  override providerInfo(provider: string) { return { id: provider, name: 'Sample data · Native gpt-6-luna capability fixture', auxiliaryGeneration: 'native' as const } }
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.metadataQueries++
    return Promise.resolve([{ provider, id: 'gpt-6-luna', name: 'Fixture native gpt-6-luna' }])
  }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++
    throw new Error('Native capability fixture must never stream')
  }
}

it('saves independent Decision controls, previews admitted order and falls back without changing the chat model or enabling native inference', async () => {
  await inWorld('decision-advice', async (world) => {
    const { scaffold, page } = world
    const projectPath = join(scaffold.workspaceCwd, 'workspace')
    for (const name of ['fixture-release-alpha', 'fixture-release-beta']) {
      const directory = join(projectPath, '.dsh', 'skills', name)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Sample data — release checklist\n---\n\nRead the reviewed release evidence.\n`)
    }
    const project = await fixtureProject(world)
    const library = scaffold.ctx.skillLibrary
    const mainSelection = scaffold.ctx.agentDefaultModel.currentSelection()
    const api = new DecisionResponseFixture()
    const native = new NativeUnavailableFixture()
    const apiRegistration = scaffold.ctx.llm.registerAdapter([DECISION_FIXTURE_PROVIDER], api)
    const nativeRegistration = scaffold.ctx.llm.registerAdapter([NATIVE_UNAVAILABLE_PROVIDER], native)
    const baseline = await library.retrieve({ projectId: project.id, query: 'release' })
    expect(baseline).toHaveLength(2)
    api.selectedId = baseline[1]!.id
    expect(api.calls).toHaveLength(0)
    await openSettings(page, 'en')
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Models', exact: true }).click()
    const decision = settings.getByRole('region', { name: 'Decision advice', exact: true })
    await decision.waitFor()
    expect(await decision.getByRole('switch', { name: 'Enable skill candidate advice', exact: true }).isChecked()).toBe(false)
    const nativeOption = decision.getByRole('option', { name: /Native gpt-6-luna capability fixture.*Native tools unavailable/ })
    await nativeOption.waitFor({ state: 'attached' })
    expect(await nativeOption.evaluate(element => element instanceof HTMLOptionElement && element.disabled)).toBe(true)
    await decision.getByRole('combobox', { name: 'Decision model', exact: true })
      .selectOption(JSON.stringify([DECISION_FIXTURE_PROVIDER, 'fixture-small']))
    await decision.getByRole('combobox', { name: 'Reasoning effort', exact: true }).selectOption('high')
    await decision.getByRole('combobox', { name: 'Processing tier', exact: true }).selectOption('priority')
    await decision.getByRole('switch', { name: 'Enable skill candidate advice', exact: true }).click()
    await decision.getByRole('button', { name: 'Save Decision settings', exact: true }).click()
    await expect.poll(async () => (await library.decisionStatus()).configuration.revision).toBe(1)
    expect((await library.decisionStatus()).configuration).toEqual({ revision: 1, enabled: true,
      route: { provider: DECISION_FIXTURE_PROVIDER, model: 'fixture-small', reasoningEffort: 'high', serviceTier: 'priority' } })
    expect(api.calls).toHaveLength(0)
    expect(scaffold.ctx.agentDefaultModel.currentSelection()).toEqual(mainSelection)
    expect(await decision.getByRole('combobox', { name: 'Reasoning effort', exact: true }).inputValue()).toBe('high')
    expect(await decision.getByRole('combobox', { name: 'Processing tier', exact: true }).inputValue()).toBe('priority')
    await decision.getByRole('heading', { name: 'Decision advice', exact: true }).scrollIntoViewIfNeeded()
    await capturePalettes(world, 'decision-saved-controls')
    await decision.getByRole('combobox', { name: 'Preview project', exact: true }).selectOption(project.id)
    await decision.getByRole('textbox', { name: 'Enter a skill candidate query', exact: true }).fill('release')
    const preview = decision.locator('[aria-label="Skill candidate preview"]')
    const previewOrder = async (): Promise<string[]> => await preview.locator('li').allTextContents()
    const previewButton = decision.getByRole('button', { name: 'Preview candidate order', exact: true })
    await previewButton.click()
    await expect.poll(previewOrder).toEqual([baseline[1]!.name, baseline[0]!.name])
    expect(api.calls).toHaveLength(1)
    expect(api.calls[0]).toMatchObject({ purpose: 'skill-decision', provider: DECISION_FIXTURE_PROVIDER, model: 'fixture-small', reasoningEffort: 'high', serviceTier: 'priority', tools: [] })
    expect(JSON.stringify(api.calls[0]!.messages)).not.toContain('Read the reviewed release evidence.')
    expect(scaffold.ctx.agentDefaultModel.currentSelection()).toEqual(mainSelection)
    await preview.scrollIntoViewIfNeeded()
    await capturePalettes(world, 'decision-preview-order')
    for (const reply of ['unknown-id', 'tool', 'abstain'] as const) {
      api.reply = reply
      const expected = api.calls.length + 1
      await previewButton.click()
      await expect.poll(() => api.calls.length).toBe(expected)
      await expect.poll(previewOrder).toEqual(baseline.map(item => item.name))
      await expect.poll(() => previewButton.isEnabled()).toBe(true)
    }
    const beforeNativeRejection = (await library.decisionStatus()).configuration
    // Models settings may list cached metadata; Decision rejection must add no native lookup.
    const metadataBeforeNativeRejection = native.metadataQueries
    await expect(library.configureDecision({ expectedRevision: beforeNativeRejection.revision, enabled: true,
      route: { provider: NATIVE_UNAVAILABLE_PROVIDER, model: 'gpt-6-luna' } })).rejects.toThrow(/response-only|native/i)
    await expect(library.configureDecision({ expectedRevision: beforeNativeRejection.revision, enabled: true,
      route: { provider: 'codex-backend', model: 'gpt-6-luna' } })).rejects.toThrow(/response-only|native/i)
    expect((await library.decisionStatus()).configuration).toEqual(beforeNativeRejection)
    expect(native.calls).toBe(0)
    expect(native.metadataQueries).toBe(metadataBeforeNativeRejection)
    await decision.getByRole('switch', { name: 'Enable skill candidate advice', exact: true }).click()
    await decision.getByRole('button', { name: 'Save Decision settings', exact: true }).click()
    await expect.poll(async () => (await library.decisionStatus()).configuration).toMatchObject({ revision: 2, enabled: false })
    await decision.getByRole('combobox', { name: 'Preview project', exact: true }).selectOption(project.id)
    await decision.getByRole('textbox', { name: 'Enter a skill candidate query', exact: true }).fill('release')
    const callsBeforeDisabledPreview = api.calls.length
    await previewButton.click()
    await expect.poll(previewOrder).toEqual(baseline.map(item => item.name))
    expect(api.calls).toHaveLength(callsBeforeDisabledPreview)
    expect(native.calls).toBe(0)
    expect(scaffold.ctx.agentDefaultModel.currentSelection()).toEqual(mainSelection)
    const durable = await readFile(join(scaffold.workspaceCwd, '.dsh-storages', 'skill_decision.json'), 'utf8')
    expect(durable).toContain('skill-decision')
    expect(durable).toContain(api.selectedId)
    expect(durable).toContain('abstained')
    assertRemote(world, 'decisionCapabilities')
    assertRemote(world, 'configureDecision')
    assertRemote(world, 'retrieve')
    await changeLanguage(page, 'zh', true)
    const chinese = page.getByRole('dialog', { name: '设置', exact: true })
    await chinese.getByRole('button', { name: '模型', exact: true }).click()
    const chineseDecision = chinese.getByRole('region', { name: 'Decision 建议', exact: true })
    await chineseDecision.waitFor()
    await chineseDecision.getByRole('heading', { name: 'Decision 建议', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(world.shots, 'remaining-decision-footer-zh-dark.png'), animations: 'disabled' })
    apiRegistration()
    nativeRegistration()
  })
})

/** Deterministic external seam; real ownership persistence, Remote actions and UI remain composed. */
function sequentialConversationFixture(world: World, project: string, executionSessionId: SessionId, name: string) {
  const source: CodingSessionSource = {
    provider: 'codex', profileId: brandString<CodingSessionSource['profileId']>(`fixture-sequential-profile-${name}`),
    nativeSessionId: brandString<CodingSessionSource['nativeSessionId']>(`fixture-original-native-${name}`),
  }
  let history: CodingSessionSnapshot = {
    source, title: `Sample data · Sequential ${name}`, cwd: project, writerState: 'unknown', cursor: `${name}-cursor-1`,
    events: [{ id: brandString<CodingSessionSnapshot['events'][number]['id']>(`${name}-original-user`), role: 'user',
      text: 'Fixture original history: preserve this conversation and its original identity.', digest: `${name}-original-digest` }],
  }
  let cleanupHistory = structuredClone(history)
  const nativeTurnIds: CodingSessionNativeTurnId[] = []
  const dispatches: { source: CodingSessionSource; text: string; executionSessionId: SessionId }[] = []
  let acquisitions = 0
  let releases = 0
  let releaseFailure = false
  let releaseGate: ReturnType<typeof Promise.withResolvers<undefined>> | undefined
  const provider: CodingSessionProvider = {
    provider: source.provider, profileId: source.profileId, label: `Sample data · Sequential fixture ${name}`, connected: () => true,
    discover: async (request) => {
      request.signal.throwIfAborted()
      return { items: [{ source, title: history.title, cwd: project, writerState: history.writerState }] }
    },
    read: async (id, request) => {
      if (id !== source.nativeSessionId) throw new Error('Fixture read received a replacement original ID')
      return boundedHistory(history, request)
    },
    sequentialWriter: {
      authority: 'user-acknowledged-sequential', toolMode: 'conversation',
      acquire: async (selected, request) => {
        request.signal.throwIfAborted()
        if (!Object.is(request.nativeProfileUnchanged, true)) throw new Error('Fixture claim lost the native-profile freeze acknowledgement')
        if (selected.provider !== source.provider || selected.profileId !== source.profileId || selected.nativeSessionId !== source.nativeSessionId) throw new Error('Fixture claim changed the original source')
        const agent = world.scaffold.ctx.agents.currentInitiator()
        if (agent?.session.id !== executionSessionId || world.scaffold.ctx.agents.get(agent.id) !== agent) {
          throw new Error('Fixture claim lacks the exact selected live Y root')
        }
        acquisitions++
        return {
          source,
          read: async request => boundedHistory(history, request),
          resumeOriginal: async (request) => {
            request.signal.throwIfAborted()
            if (request.source.provider !== source.provider || request.source.profileId !== source.profileId || request.source.nativeSessionId !== source.nativeSessionId) throw new Error('Fixture resume changed the original source')
            const current = world.scaffold.ctx.agents.currentInitiator()
            if (current !== agent) throw new Error('Fixture continuation lost the captured live Y root')
            const nativeTurnId = brandString<CodingSessionNativeTurnId>(`${name}-native-turn-${dispatches.length + 1}`)
            await request.beforeDispatch()
            dispatches.push({ source: structuredClone(request.source), text: request.text, executionSessionId: current.session.id })
            nativeTurnIds.push(nativeTurnId)
            history = { ...history, cursor: `${name}-cursor-${dispatches.length + 1}`, events: [...history.events,
              { id: brandString<CodingSessionSnapshot['events'][number]['id']>(`${nativeTurnId}-user`), role: 'user', text: request.text, digest: `${nativeTurnId}-user-digest` },
              { id: brandString<CodingSessionSnapshot['events'][number]['id']>(`${nativeTurnId}-assistant`), role: 'assistant',
                text: 'Fixture native conversation reply. Project tools were disabled; task completion is unverified.', digest: `${nativeTurnId}-assistant-digest` },
            ] }
            cleanupHistory = structuredClone(history)
            return { nativeTurnId }
          },
          release: async (): Promise<CodingSessionSequentialReleaseReceipt> => {
            releases++
            if (releaseGate !== undefined) {
              await releaseGate.promise
            }
            if (releaseFailure) throw new Error('Fixture native persistence and closure remain unconfirmed')
            return { source, snapshot: structuredClone(history), processExited: true, streamsDrained: true,
              expectedPrefixPersisted: true, completedTurnPersisted: nativeTurnIds.length > 0,
              nativeTurnIds: [...nativeTurnIds], noObservedPersistenceErrors: true }
          },
        }
      },
    },
  }
  const unregister = world.scaffold.ctx.codingSessions.registerProvider(provider)
  world.cleanups.push(async () => {
    // Restore only this external double after its assertions; production teardown still owns the drain.
    releaseGate?.resolve(undefined)
    releaseFailure = false
    history = structuredClone(cleanupHistory)
    try { await world.scaffold.ctx.codingSessions.cancelPending() } finally { await unregister() }
  })
  return {
    source, title: history.title, unregister, dispatches, snapshot: () => structuredClone(history),
    counts: () => ({ acquisitions, releases }), failRelease: () => { releaseFailure = true },
    diverge: () => { history = { ...history, cursor: `${name}-outside-change`, events: history.events.map((event, index) =>
      index === 0 ? { ...event, text: 'Fixture external writer changed the reviewed prefix.', digest: `${name}-outside-digest` } : event) } },
    holdRelease: () => {
      const settled = Promise.withResolvers<undefined>()
      releaseGate = settled
      return { settle: () => { settled.resolve(undefined) } }
    },
  }
}

async function importSequentialFixture(world: World, name: string, nativeId: string): Promise<Locator> {
  await openSettings(world.page, 'en')
  const settings = world.page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('button', { name: 'Coding sessions', exact: true }).click()
  const reload = settings.getByRole('button', { name: 'Reload sources', exact: true })
  await expect.poll(() => reload.isEnabled()).toBe(true)
  await reload.click()
  const label = settings.getByText(`Sample data · Sequential fixture ${name}`, { exact: true })
  await label.waitFor()
  await label.locator('xpath=ancestor::div[button][1]').getByRole('button', { name: 'Browse sessions', exact: true }).click()
  await settings.getByText(nativeId, { exact: true }).waitFor()
  await settings.getByRole('button', { name: 'Import', exact: true }).click()
  const history = settings.getByRole('region', { name: 'Session history', exact: true })
  await history.getByText(nativeId, { exact: true }).waitFor()
  return history
}

it('hands the exact original fixture conversation to Y and waits for release evidence before native readiness', async () => {
  await inWorld('sequential-success', async (world) => {
    const project = await fixtureProject(world)
    const executionSessionId = SessionId('fixture-sequential-live-root')
    await world.scaffold.ctx.agents.create({ sessionId: executionSessionId, meta: { cwd: project.path },
      setup: agentCtx => world.scaffold.ctx.agentPresets.mount(agentCtx).then(() => undefined) })
    const fixture = sequentialConversationFixture(world, project.path, executionSessionId, 'success')
    const session = await importSequentialFixture(world, 'success', fixture.source.nativeSessionId)
    const inventory = await world.scaffold.ctx.codingSessions.getState()
    const mirror = inventory.mirrors.find(value => value.source.nativeSessionId === fixture.source.nativeSessionId)
    if (mirror === undefined) throw new Error('Fixture original mirror was not imported')
    const claim = session.getByRole('button', { name: 'Claim for Y', exact: true })
    const execution = session.getByRole('combobox', { name: 'Y execution session', exact: true })
    await execution.selectOption(executionSessionId)
    expect(await claim.isEnabled()).toBe(false)
    expect(fixture.counts().acquisitions).toBe(0)
    const acknowledgement: CodingSessionClaimAcknowledgement = { source: fixture.source, project: project.path,
      executionSessionId, expectedRevision: mirror.revision, externalWritersClosed: true, nativeProfileUnchanged: true }
    await expect(world.scaffold.ctx.codingSessions.claimSequential(mirror.id, {
      ...acknowledgement, expectedRevision: mirror.revision + 1,
    })).rejects.toThrow()
    await expect(world.scaffold.ctx.codingSessions.claimSequential(mirror.id, {
      ...acknowledgement, externalWritersClosed: false,
    })).rejects.toThrow()
    await expect(world.scaffold.ctx.codingSessions.claimSequential(mirror.id, {
      ...acknowledgement, nativeProfileUnchanged: false,
    })).rejects.toThrow()
    await expect(world.scaffold.ctx.codingSessions.claimSequential(mirror.id, {
      ...acknowledgement, executionSessionId: SessionId('fixture-not-live'),
    })).rejects.toThrow()
    await expect(world.scaffold.ctx.codingSessions.claimSequential(mirror.id, {
      ...acknowledgement, project: join(project.path, 'different-project'),
    })).rejects.toThrow()
    expect(fixture.counts().acquisitions).toBe(0)
    await session.getByRole('checkbox', { name: 'I have closed the previous native writer for this session', exact: true }).check()
    expect(await session.getByRole('button', { name: 'Claim for Y', exact: true }).isEnabled()).toBe(false)
    await session.getByRole('checkbox', { name: 'I will keep the native profile unchanged until release', exact: true }).check()
    await claim.scrollIntoViewIfNeeded()
    await capturePalettes(world, 'sequential-reviewed-claim')
    await claim.click()
    await session.getByText('Y owns this native session', { exact: true }).waitFor()
    const owned = await world.scaffold.ctx.codingSessions.detail(mirror.id)
    expect(owned.handoff).toMatchObject({ phase: 'y-owned', source: fixture.source, project: project.path, executionSessionId, toolMode: 'conversation' })
    expect(owned.capabilities.continue).toBe(false)
    expect(owned.sequentialReleaseAvailable).toBe(true)
    await session.getByText('Native conversation continuation. Project tools are disabled.', { exact: true }).waitFor()
    expect(owned.source).toEqual(fixture.source)
    await session.getByRole('button', { name: 'Release to native app', exact: true }).scrollIntoViewIfNeeded()
    await capturePalettes(world, 'sequential-y-owned')
    const message = 'Fixture follow-up: explain the retained plan without running project tools.'
    await session.getByRole('textbox', { name: 'Continuation message', exact: true }).fill(message)
    await session.getByRole('button', { name: 'Continue native conversation', exact: true }).click()
    await session.getByText('Fixture native conversation reply. Project tools were disabled; task completion is unverified.', { exact: true }).waitFor()
    const continued = await world.scaffold.ctx.codingSessions.detail(mirror.id)
    expect(continued.events.map(event => event.id)).toEqual(['success-original-user', 'success-native-turn-1-user', 'success-native-turn-1-assistant'])
    expect(continued.events[0]!.text).toBe('Fixture original history: preserve this conversation and its original identity.')
    expect(continued.handoff).toMatchObject({ phase: 'y-owned', dispatchedTurnCount: 1, nativeTurnIds: ['success-native-turn-1'] })
    expect(fixture.dispatches).toEqual([{ source: fixture.source, text: message, executionSessionId }])
    const barrier = fixture.holdRelease()
    try {
      await session.getByRole('button', { name: 'Release to native app', exact: true }).click()
      await expect.poll(() => fixture.counts().releases).toBe(1)
      expect((await world.scaffold.ctx.codingSessions.getState()).mirrors.find(value => value.id === mirror.id)?.handoff?.phase).toBe('releasing')
      expect(await session.getByRole('button', { name: 'Continue native conversation', exact: true }).isEnabled()).toBe(false)
      expect(await session.getByRole('button', { name: 'Claim for Y', exact: true }).count()).toBe(0)
      barrier.settle()
      await expect.poll(async () => (await world.scaffold.ctx.codingSessions.detail(mirror.id)).handoff?.phase).toBe('external-ready')
    } finally { barrier.settle() }
    await session.getByRole('button', { name: 'Claim for Y', exact: true }).waitFor()
    const released = await world.scaffold.ctx.codingSessions.detail(mirror.id)
    expect(released.events).toEqual(continued.events)
    expect(released.source).toEqual(fixture.source)
    expect(released.sequentialReleaseAvailable).toBe(false)
    expect(fixture.counts()).toEqual({ acquisitions: 1, releases: 1 })
    const durable = await readFile(join(world.scaffold.workspaceCwd, '.dsh-storages', 'coding_session_handoffs.json'), 'utf8')
    expect(durable).toContain('external-ready')
    expect(durable).toContain(fixture.source.nativeSessionId)
    expect(durable).toContain(executionSessionId)
    expect(durable).toContain('success-native-turn-1')
    await claim.scrollIntoViewIfNeeded()
    await capturePalettes(world, 'sequential-external-ready')
    assertRemote(world, 'claimSequential')
    assertRemote(world, 'continueSequential')
    assertRemote(world, 'releaseSequential')
    await changeLanguage(world.page, 'zh', true)
    const chinese = world.page.getByRole('dialog', { name: '设置', exact: true })
    await chinese.getByRole('button', { name: '编程会话', exact: true }).click()
    await chinese.getByRole('region', { name: '会话记录', exact: true }).getByText(fixture.source.nativeSessionId, { exact: true }).waitFor()
    await chinese.getByRole('button', { name: '交给 Y 继续', exact: true }).scrollIntoViewIfNeeded()
    await world.page.screenshot({ path: join(world.shots, 'remaining-sequential-external-ready-zh-dark.png'), animations: 'disabled' })
    await fixture.unregister()
  }, { enableSequentialHandoff: true })
})

it('keeps sequential native handoff unavailable in the shipped opted-out composition', async () => {
  await inWorld('sequential-opted-out', async (world) => {
    const project = await fixtureProject(world)
    const executionSessionId = SessionId('fixture-sequential-opted-out-root')
    await world.scaffold.ctx.agents.create({ sessionId: executionSessionId, meta: { cwd: project.path },
      setup: agentCtx => world.scaffold.ctx.agentPresets.mount(agentCtx).then(() => undefined) })
    const fixture = sequentialConversationFixture(world, project.path, executionSessionId, 'opted-out')
    const session = await importSequentialFixture(world, 'opted-out', fixture.source.nativeSessionId)
    const inventory = await world.scaffold.ctx.codingSessions.getState()
    const mirror = inventory.mirrors.find(value => value.source.nativeSessionId === fixture.source.nativeSessionId)
    if (mirror === undefined) throw new Error('Fixture original mirror was not imported')
    expect(mirror.sequentialAvailable).toBe(false)
    expect(mirror.handoff).toBeUndefined()
    expect(await session.getByRole('button', { name: 'Claim for Y', exact: true }).count()).toBe(0)
    expect(await session.getByRole('button', { name: 'Continue original session', exact: true }).isEnabled()).toBe(false)
    await expect(world.scaffold.ctx.codingSessions.claimSequential(mirror.id, { source: fixture.source, project: project.path,
      executionSessionId, expectedRevision: mirror.revision, externalWritersClosed: true, nativeProfileUnchanged: true })).rejects.toThrow()
    expect(fixture.counts()).toEqual({ acquisitions: 0, releases: 0 })
    expect(fixture.dispatches).toEqual([])
    expect((await world.scaffold.ctx.codingSessions.detail(mirror.id)).source).toEqual(fixture.source)
    await fixture.unregister()
  })
})

it('retains original history and blocked ownership after conflicting native changes and an uncertain release', async () => {
  await inWorld('sequential-uncertain', async (world) => {
    const project = await fixtureProject(world)
    const executionSessionId = SessionId('fixture-sequential-uncertain-root')
    await world.scaffold.ctx.agents.create({ sessionId: executionSessionId, meta: { cwd: project.path },
      setup: agentCtx => world.scaffold.ctx.agentPresets.mount(agentCtx).then(() => undefined) })
    const fixture = sequentialConversationFixture(world, project.path, executionSessionId, 'uncertain')
    const session = await importSequentialFixture(world, 'uncertain', fixture.source.nativeSessionId)
    await session.getByRole('combobox', { name: 'Y execution session', exact: true }).selectOption(executionSessionId)
    await session.getByRole('checkbox', { name: 'I have closed the previous native writer for this session', exact: true }).check()
    expect(await session.getByRole('button', { name: 'Claim for Y', exact: true }).isEnabled()).toBe(false)
    await session.getByRole('checkbox', { name: 'I will keep the native profile unchanged until release', exact: true }).check()
    await session.getByRole('button', { name: 'Claim for Y', exact: true }).click()
    await session.getByText('Y owns this native session', { exact: true }).waitFor()
    const inventory = await world.scaffold.ctx.codingSessions.getState()
    const mirror = inventory.mirrors.find(value => value.source.nativeSessionId === fixture.source.nativeSessionId)
    if (mirror === undefined) throw new Error('Fixture original mirror was not imported')
    const retained = await world.scaffold.ctx.codingSessions.detail(mirror.id)
    fixture.diverge()
    await session.getByRole('textbox', { name: 'Continuation message', exact: true }).fill('Fixture message must never dispatch after the prefix changed.')
    await session.getByRole('button', { name: 'Continue native conversation', exact: true }).click()
    await expect.poll(async () => (await world.scaffold.ctx.codingSessions.detail(mirror.id)).handoff?.phase).toBe('blocked-uncertain')
    expect(fixture.dispatches).toEqual([])
    expect((await world.scaffold.ctx.codingSessions.detail(mirror.id)).events).toEqual(retained.events)
    fixture.failRelease()
    await session.getByRole('button', { name: 'Release to native app', exact: true }).click()
    await session.getByText('Release is uncertain. Keep this session closed in the native app and retry release.', { exact: true }).waitFor()
    await expect.poll(() => session.getByRole('button', { name: 'Release to native app', exact: true }).isEnabled()).toBe(true)
    expect((await world.scaffold.ctx.codingSessions.detail(mirror.id)).handoff?.phase).toBe('blocked-uncertain')
    expect(await session.getByRole('button', { name: 'Continue native conversation', exact: true }).isEnabled()).toBe(false)
    expect(await session.getByRole('button', { name: 'Claim for Y', exact: true }).count()).toBe(0)
    await session.getByRole('button', { name: 'Release to native app', exact: true }).scrollIntoViewIfNeeded()
    await capturePalettes(world, 'sequential-release-uncertain')
    const durable = await readFile(join(world.scaffold.workspaceCwd, '.dsh-storages', 'coding_session_handoffs.json'), 'utf8')
    expect(durable).toContain('blocked-uncertain')
    expect(durable).toContain(fixture.source.nativeSessionId)
    // A browser remount proves controller recovery only; the Host restart case is owned by service fixtures.
    await world.page.reload({ waitUntil: 'load' })
    await world.page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await openSettings(world.page, 'en')
    const settings = world.page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Coding sessions', exact: true }).click()
    await settings.getByRole('button', { name: new RegExp(`^${fixture.title}`) }).click()
    const restored = settings.getByRole('region', { name: 'Session history', exact: true })
    await restored.getByText('Release is uncertain. Keep this session closed in the native app and retry release.', { exact: true }).waitFor()
    await restored.getByText(retained.events[0]!.text, { exact: true }).waitFor()
    expect(await restored.getByRole('button', { name: 'Continue native conversation', exact: true }).isEnabled()).toBe(false)
    expect(fixture.dispatches).toEqual([])
    assertRemote(world, 'claimSequential')
    assertRemote(world, 'continueSequential')
    assertRemote(world, 'releaseSequential')
    await changeLanguage(world.page, 'zh', true)
    const chinese = world.page.getByRole('dialog', { name: '设置', exact: true })
    await chinese.getByRole('button', { name: '编程会话', exact: true }).click()
    await chinese.getByRole('button', { name: '交还原生应用', exact: true }).scrollIntoViewIfNeeded()
    await world.page.screenshot({ path: join(world.shots, 'remaining-sequential-release-uncertain-zh-dark.png'), animations: 'disabled' })
    // Owned cleanup restores the external double before awaiting this intentionally blocked source disposal.
  }, { enableSequentialHandoff: true })
})
