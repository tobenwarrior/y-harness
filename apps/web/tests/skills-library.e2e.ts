/** Keyless composed Skills navigation, explicit sample-data relationships, and reversible isolated maintenance. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, openSettings, saveFailureShot } from './support.ts'

const SAMPLE_PROJECT_NAMES = {
  release: 'Sample data · Release', planning: 'Sample data · Planning',
  engineering: 'Sample data · Engineering', documentation: 'Sample data · Documentation', sandbox: 'Sample data · Sandbox',
} as const
const LONG_SAMPLE_SKILL = 'cross-project-compatibility-and-regression-review-checklist'

const SHOTS = process.env.DSH_SKILL_LIBRARY_ARTIFACT_DIR
  ?? fileURLToPath(new URL('../../../.artifacts/screenshots/skills-library/', import.meta.url))

/** Observe the actual SVG edge endpoints for an explicit, fixture-declared relationship. */
async function hasGraphEdge(graph: Locator, sourceLabel: string, targetLabel: string): Promise<boolean> {
  return graph.evaluate((element, labels) => {
    const point = (label: string): { x: number; y: number } | undefined => {
      const node = [...element.querySelectorAll<SVGGElement>('g[role="button"]')]
        .find(candidate => candidate.getAttribute('aria-label') === label)
      const translation = node?.getAttribute('transform')
      const coordinates = translation === undefined || translation === null ? null : /^translate\((\S+) (\S+)\)$/.exec(translation)
      return coordinates === null ? undefined : { x: Number(coordinates[1]), y: Number(coordinates[2]) }
    }
    const source = point(labels.source), target = point(labels.target)
    if (source === undefined || target === undefined) return false
    return [...element.querySelectorAll('line')].some((line) => {
      const x1 = Number(line.getAttribute('x1')), y1 = Number(line.getAttribute('y1'))
      const x2 = Number(line.getAttribute('x2')), y2 = Number(line.getAttribute('y2'))
      return x1 === source.x && y1 === source.y && x2 === target.x && y2 === target.y
        || x1 === target.x && y1 === target.y && x2 === source.x && y2 === source.y
    })
  }, { source: sourceLabel, target: targetLabel })
}

/** Operate the user-visible project filter rather than mutating panel state. */
async function chooseProject(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'Project', exact: true }).click()
  await page.getByRole('menuitem', { name: title, exact: true }).click()
}

it('explores every project and shared skill, with deliberate reversible cleanup and an explicit graph', async () => {
  const overlayRoot = await mkdtemp(join(tmpdir(), 'dsh-skills-library-e2e-'))
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  try {
    const overlay = join(overlayRoot, 'skills.patch.yml')
    await writeFile(overlay, '- id: skill-library\n  config:\n    automaticMaintenanceIntervalMs: 0\n')
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    const projectRoot = join(scaffold.workspaceCwd, 'workspace')
    const planningRoot = join(scaffold.workspaceCwd, 'planning')
    const engineeringRoot = join(scaffold.workspaceCwd, 'engineering')
    const documentationRoot = join(scaffold.workspaceCwd, 'documentation')
    const sandboxRoot = join(scaffold.workspaceCwd, 'sandbox')
    const releaseDir = join(projectRoot, '.dsh', 'skills', 'release-checklist')
    const planningDir = join(planningRoot, '.dsh', 'skills', 'planning-checklist')
    const sharedDir = join(scaffold.harnessHome, 'skills', 'shared-review')
    await Promise.all([
      mkdir(join(projectRoot, '.git'), { recursive: true }),
      ...[planningRoot, engineeringRoot, documentationRoot, sandboxRoot]
        .map(root => mkdir(join(root, '.git'), { recursive: true })),
      mkdir(releaseDir, { recursive: true }), mkdir(planningDir, { recursive: true }), mkdir(sharedDir, { recursive: true }),
    ])
    const sharedPath = join(sharedDir, 'SKILL.md')
    const sharedLink = relative(releaseDir, sharedPath).replaceAll('\\', '/')
    const header = '---\nname: release-checklist\ndescription: Review release changes and preserve approval rules\n---\n\n'
    const originalBody = [
      '# Release checklist', '', 'Inspect the reviewed patch.', '', '', '', '',
      `[Shared review](${sharedLink})`, '', '[Supporting checklist](reference.txt)', '',
      'Keep required approvals.', '', '', '', '', '```text', 'preserve this code block', '', '', 'verbatim', '```', '',
      'Finish review.',
    ].join('\n')
    const compactBody = [
      '# Release checklist', '', 'Inspect the reviewed patch.', '', '',
      `[Shared review](${sharedLink})`, '', '[Supporting checklist](reference.txt)', '',
      'Keep required approvals.', '', '', '```text', 'preserve this code block', '', '', 'verbatim', '```', '',
      'Finish review.',
    ].join('\n')
    const original = `${header}${originalBody}\n`
    const compact = `${header}${compactBody}\n`
    const shared = '---\nname: shared-review\ndescription: A review workflow shared across projects\n---\n\n# Shared review\n\nCheck the evidence before applying changes.\n'
    const planning = '---\nname: planning-checklist\ndescription: A separate project planning workflow\n---\n\n# Planning checklist\n\nRecord the agreed scope.\n'
    const releasePath = join(releaseDir, 'SKILL.md')
    const planningPath = join(planningDir, 'SKILL.md')
    const resourcePath = join(releaseDir, 'reference.txt')
    await Promise.all([
      writeFile(releasePath, original), writeFile(sharedPath, shared), writeFile(planningPath, planning),
      writeFile(resourcePath, 'Keep this supporting resource intact.\n'),
    ])

    const scopes = [
      { root: projectRoot, names: ['release-evidence', 'release-rollback', 'release-checks', 'release-notes', 'approval-checkpoint', 'release-migration', 'release-versioning', 'release-packaging', 'release-monitoring'], hub: 'release-evidence', shared: 'diff-review' },
      { root: planningRoot, names: ['scope-brief', 'acceptance-criteria', 'dependency-map', 'delivery-milestones', 'decision-record', 'project-risk-review', 'work-item-triage'], hub: 'scope-brief', shared: 'task-handoff' },
      { root: engineeringRoot, names: ['interface-contract', 'regression-triage', LONG_SAMPLE_SKILL, 'dependency-update', 'integration-review', 'performance-review', 'type-review', 'module-boundary-review', 'error-reporting'], hub: 'interface-contract', shared: 'test-evidence' },
      { root: documentationRoot, names: ['doc-navigation', 'api-doc-update', 'link-review', 'doc-release-notes', 'reference-maintenance', 'example-verification', 'translation-review', 'doc-versioning', 'search-quality'], hub: 'doc-navigation', shared: 'source-integrity' },
      { root: sandboxRoot, names: ['sample-lab-overview', 'prototype-checklist', 'experiment-notes', 'lab-results'], hub: 'sample-lab-overview', shared: undefined },
    ]
    const sampleSkills = scopes.flatMap(scope => scope.names.map(name => ({
      name, directory: join(scope.root, '.dsh', 'skills', name),
      references: name === scope.hub ? [] : [scope.hub, ...scope.shared === undefined ? [] : [scope.shared]],
    })))
    sampleSkills.push(...['test-evidence', 'approval-rules', 'source-integrity', 'diff-review', 'task-handoff', 'accessibility-check', 'dependency-audit']
      .map(name => ({ name, directory: join(scaffold!.harnessHome, 'skills', name), references: name === 'test-evidence' ? ['shared-review'] : ['shared-review', 'test-evidence'] })))
    const hubReferences: Readonly<Record<string, readonly string[]>> = {
      'release-evidence': ['shared-review', 'test-evidence', 'interface-contract'],
      'scope-brief': ['shared-review', 'task-handoff', 'release-evidence'],
      'interface-contract': ['test-evidence', 'dependency-audit', 'doc-navigation'],
      'doc-navigation': ['source-integrity', 'accessibility-check', 'scope-brief'],
    }
    const samplePaths = new Map([
      ['release-checklist', releasePath], ['planning-checklist', planningPath], ['shared-review', sharedPath],
      ...sampleSkills.map(skill => [skill.name, join(skill.directory, 'SKILL.md')] as const),
    ])
    const sampleReferences: { source: string; target: string }[] = [{ source: 'release-checklist', target: 'shared-review' }]
    const sampleFiles = await Promise.all(sampleSkills.map(async (skill) => {
      await mkdir(skill.directory, { recursive: true })
      const references = hubReferences[skill.name] ?? skill.references
      sampleReferences.push(...references.map(target => ({ source: skill.name, target })))
      const body = [
        `# ${skill.name}`, '', 'Sample data for the isolated Skills workspace.', '',
        'Review the relevant evidence, preserve required approvals, and record unresolved questions.', '',
        ...references.map(target => `- [${target}](${relative(skill.directory, samplePaths.get(target)!).replaceAll('\\', '/')})`), '',
      ].join('\n')
      const content = `---\nname: ${skill.name}\ndescription: Sample data — ${skill.name.replaceAll('-', ' ')}\n---\n\n${body}`
      const path = samplePaths.get(skill.name)!
      await writeFile(path, content)
      return { path, content }
    }))
    expect(samplePaths.size).toBe(48)
    const explicitRelationshipCount = new Set(sampleReferences.map(reference => [reference.source, reference.target].sort().join('\0'))).size
    expect(explicitRelationshipCount).toBe(89)

    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    const page = await newEnglishPage(browser)
    await page.emulateMedia({ colorScheme: 'dark' })
    const tripwire = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-skills-library'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const project = scaffold.ctx.workspaceRegistry.list().find(value => value.path === projectRoot)
    expect(project).toBeDefined()
    await project!.setTitle(SAMPLE_PROJECT_NAMES.release)
    const planningProject = await scaffold.ctx.workspaceRegistry.create(planningRoot)
    await planningProject.setTitle(SAMPLE_PROJECT_NAMES.planning)
    for (const [root, title] of [
      [engineeringRoot, SAMPLE_PROJECT_NAMES.engineering],
      [documentationRoot, SAMPLE_PROJECT_NAMES.documentation],
      [sandboxRoot, SAMPLE_PROJECT_NAMES.sandbox],
    ]) {
      const sampleProject = await scaffold.ctx.workspaceRegistry.create(root!)
      await sampleProject.setTitle(title!)
    }

    await page.getByRole('button', { name: 'Skills', exact: true }).click()
    await page.getByRole('heading', { name: 'Skills', exact: true }).waitFor()
    expect(await page.getByRole('tablist', { name: 'Skill view', exact: true })
      .evaluate(element => getComputedStyle(element).borderRadius)).toBe('0px')
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    await expect.poll(() => page.locator('[data-sidebar-collapsed="true"]').count()).toBe(1)
    const explorer = page.getByRole('complementary', { name: 'Skill explorer', exact: true })
    await explorer.waitFor()
    expect(await explorer.count()).toBe(1)
    for (const title of [...Object.values(SAMPLE_PROJECT_NAMES), 'Shared skills']) {
      await explorer.getByRole('heading', { name: title, exact: true }).waitFor()
    }
    expect(await explorer.getByRole('button', { name: /^Inspect / }).count()).toBe(48)
    const sampleInventory = await scaffold.ctx.skillLibrary.list({})
    expect(sampleInventory.items).toHaveLength(48)
    expect(sampleInventory.projects).toHaveLength(5)
    await page.getByRole('button', { name: 'Hide explorer', exact: true }).click()
    await explorer.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'Show explorer', exact: true }).click()
    await explorer.waitFor()
    expect(await explorer.getByRole('button', { name: /^Inspect / }).count()).toBe(48)
    await page.getByRole('button', { name: 'Inspect release-checklist', exact: true }).click()
    const detail = page.getByRole('complementary', { name: 'Details', exact: true })
    await expect.poll(async () => (await detail.locator('pre').textContent())?.trim()).toBe(originalBody)
    expect(await detail.getByText('Protected', { exact: true }).count()).toBe(1)
    expect(await detail.getByText('Usage unknown', { exact: true }).count()).toBe(1)
    expect(await detail.getByText('This source has no reliable usage record. Its usage is unknown.', { exact: true }).count()).toBe(1)
    expect(await detail.getByRole('button', { name: 'Review whitespace cleanup for this skill', exact: true }).count()).toBe(0)
    expect(await detail.getByRole('button', { name: 'Clean up this skill', exact: true }).isEnabled()).toBe(false)
    expect(await detail.getByRole('button', { name: 'Force cleanup', exact: true }).isEnabled()).toBe(false)

    await mkdir(SHOTS, { recursive: true })
    const libraryShot = join(SHOTS, 'skills-library.png')
    await page.screenshot({ path: libraryShot, animations: 'disabled' })
    console.log(`Skills library screenshot: ${libraryShot}`)
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(false)
    await page.screenshot({ path: join(SHOTS, 'skills-library-default-light.png'), animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(true)

    await page.getByRole('button', { name: 'Review whitespace cleanup', exact: true }).click()
    const preview = page.getByRole('dialog', { name: 'Review whitespace cleanup', exact: true })
    await preview.getByText('No cleanup edits to apply.', { exact: true }).waitFor()
    expect(await preview.getByRole('button', { name: 'Apply changes', exact: true }).isEnabled()).toBe(false)
    await preview.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await readFile(releasePath, 'utf8')).toBe(original)

    await detail.getByRole('button', { name: 'Manage with Y', exact: true }).click()
    const adoption = page.getByRole('dialog', { name: 'Manage this skill with Y', exact: true })
    await adoption.getByRole('button', { name: 'Manage with Y', exact: true }).click()
    await adoption.waitFor({ state: 'hidden' })
    await detail.getByText('Y managed', { exact: true }).waitFor()
    expect(await detail.getByRole('switch', { name: 'Automatic whitespace cleanup', exact: true }).isChecked()).toBe(false)
    expect(await readFile(releasePath, 'utf8')).toBe(original)

    await detail.getByRole('button', { name: 'Review whitespace cleanup for this skill', exact: true }).click()
    await preview.getByRole('heading', { name: 'release-checklist', exact: true }).waitFor()
    await expect.poll(() => preview.textContent()).toContain('1 changes ·')
    expect(await preview.textContent()).toContain('Keep required approvals.')
    expect(await readFile(releasePath, 'utf8')).toBe(original)
    await preview.getByRole('button', { name: 'Apply changes', exact: true }).click()
    await preview.waitFor({ state: 'hidden' })
    await expect.poll(() => readFile(releasePath, 'utf8')).toBe(compact)
    await detail.getByRole('button', { name: 'Restore content from before this revision', exact: true }).click()
    await expect.poll(() => readFile(releasePath, 'utf8')).toBe(original)
    await expect.poll(async () => (await detail.locator('pre').textContent())?.trim()).toBe(originalBody)

    await detail.getByRole('button', { name: 'Pin', exact: true }).click()
    await detail.getByRole('button', { name: 'Unpin', exact: true }).waitFor()
    await expect.poll(async () => {
      const cleanup = detail.getByRole('button', { name: 'Review whitespace cleanup for this skill', exact: true })
      return await cleanup.count() === 0 || !await cleanup.isEnabled()
    }).toBe(true)
    await page.getByRole('button', { name: 'Review whitespace cleanup', exact: true }).click()
    await preview.getByText('No cleanup edits to apply.', { exact: true }).waitFor()
    await preview.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await readFile(releasePath, 'utf8')).toBe(original)
    await detail.getByRole('button', { name: 'Unpin', exact: true }).click()
    await detail.getByRole('button', { name: 'Pin', exact: true }).waitFor()

    await detail.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByRole('dialog', { name: 'Delete skill', exact: true })
      .getByRole('button', { name: 'Delete', exact: true }).click()
    await expect.poll(() => existsSync(releaseDir)).toBe(false)
    await detail.getByText('Archived', { exact: true }).waitFor()
    await detail.getByRole('button', { name: 'Restore', exact: true }).click()
    await expect.poll(() => readFile(resourcePath, 'utf8')).toBe('Keep this supporting resource intact.\n')
    expect(await readFile(releasePath, 'utf8')).toBe(original)
    await detail.getByText('Active', { exact: true }).waitFor()

    await page.getByRole('tab', { name: 'Graph', exact: true }).click()
    const graph = page.getByRole('application', { name: 'Project and skill graph', exact: true })
    await graph.getByRole('button', { name: 'Open skill release-checklist', exact: true }).waitFor()
    await graph.getByRole('button', { name: 'Open skill planning-checklist', exact: true }).waitFor()
    await graph.getByRole('button', { name: 'Open skill shared-review', exact: true }).waitFor()
    expect(await hasGraphEdge(graph, `Filter project ${SAMPLE_PROJECT_NAMES.release}`, 'Open skill release-checklist')).toBe(true)
    expect(await hasGraphEdge(graph, `Filter project ${SAMPLE_PROJECT_NAMES.planning}`, 'Open skill planning-checklist')).toBe(true)
    expect(await hasGraphEdge(graph, 'Filter project Shared skills', 'Open skill shared-review')).toBe(true)
    expect(await hasGraphEdge(graph, 'Open skill release-checklist', 'Open skill shared-review')).toBe(true)
    expect(await hasGraphEdge(graph, 'Open skill release-checklist', 'Open skill planning-checklist')).toBe(false)

    expect(await explorer.count()).toBe(1)
    expect(await explorer.getByRole('button', { name: /^Inspect / }).count()).toBe(48)
    expect(await graph.getByRole('button').count()).toBe(54)
    expect(await graph.locator('[data-graph-layer="membership"] line').count()).toBe(48)
    expect(await graph.locator('[data-graph-layer="links"] line').count()).toBe(explicitRelationshipCount)
    for (const reference of sampleReferences) {
      expect(await hasGraphEdge(graph, `Open skill ${reference.source}`, `Open skill ${reference.target}`)).toBe(true)
    }
    expect(await hasGraphEdge(graph, 'Open skill prototype-checklist', 'Open skill shared-review')).toBe(false)
    expect(await hasGraphEdge(graph, 'Open skill interface-contract', 'Open skill doc-navigation')).toBe(true)
    const controls = page.getByRole('button', { name: 'Graph controls', exact: true })
    await controls.click()
    expect(await controls.getAttribute('aria-expanded')).toBe('true')
    await controls.click()
    expect(await controls.getAttribute('aria-expanded')).toBe('false')

    const drawing = graph.locator('[data-graph-transform]')
    const fitted = await drawing.getAttribute('transform')
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await expect.poll(() => drawing.getAttribute('transform')).not.toBe(fitted)
    await page.getByRole('button', { name: 'Fit graph', exact: true }).click()
    await expect.poll(() => drawing.getAttribute('transform')).toBe(fitted)
    await graph.focus()
    await graph.press('+')
    await expect.poll(() => drawing.getAttribute('transform')).not.toBe(fitted)
    await page.getByRole('button', { name: 'Fit graph', exact: true }).click()
    await graph.focus()
    await graph.press('ArrowRight')
    await expect.poll(() => drawing.getAttribute('transform')).not.toBe(fitted)
    await page.getByRole('button', { name: 'Fit graph', exact: true }).click()
    const visibleLabels = graph.locator('text[data-graph-label][data-label-visible="true"]')
    for (let index = 0; index < 4; index++) await page.getByRole('button', { name: 'Zoom out', exact: true }).click()
    const distantLabelCount = await visibleLabels.count()
    expect(distantLabelCount).toBeLessThan(54)
    expect(await graph.getByRole('button').count()).toBe(54)
    expect(await graph.locator('[data-graph-layer="links"] line').count()).toBe(explicitRelationshipCount)
    const longNode = graph.getByRole('button', { name: `Open skill ${LONG_SAMPLE_SKILL}`, exact: true })
    await longNode.focus()
    await expect.poll(() => longNode.locator('text[data-graph-label]').textContent()).toBe(LONG_SAMPLE_SKILL)
    expect(await longNode.locator('text[data-graph-label]').getAttribute('data-label-visible')).toBe('true')
    await page.getByRole('button', { name: 'Fit graph', exact: true }).click()
    for (let index = 0; index < 3; index++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await expect.poll(() => visibleLabels.count()).toBe(54)
    expect(await visibleLabels.count()).toBeGreaterThan(distantLabelCount)
    await page.getByRole('button', { name: 'Fit graph', exact: true }).click()
    await graph.focus()
    const search = page.getByRole('textbox', { name: 'Search skills, sources, or projects', exact: true })
    await search.fill('planning-checklist')
    await expect.poll(() => graph.getByRole('button', { name: 'Open skill release-checklist', exact: true }).count()).toBe(0)
    expect(await graph.getByRole('button', { name: 'Open skill planning-checklist', exact: true }).count()).toBe(1)
    await search.fill('')
    await graph.getByRole('button', { name: 'Open skill release-checklist', exact: true }).waitFor()
    await detail.getByRole('button', { name: 'Hide inspector', exact: true }).click()
    await detail.waitFor({ state: 'hidden' })
    const bounds = await graph.boundingBox()
    expect(bounds).not.toBeNull()
    const panStart = { x: bounds!.x + bounds!.width * 0.9, y: bounds!.y + bounds!.height * 0.9 }
    expect(await graph.evaluate((element, point) =>
      element.ownerDocument.elementFromPoint(point.x, point.y) === element, panStart)).toBe(true)
    await page.mouse.move(panStart.x, panStart.y)
    await page.mouse.down()
    await page.mouse.move(bounds!.x + bounds!.width * 0.9 - 45, bounds!.y + bounds!.height * 0.9 - 25, { steps: 3 })
    await page.mouse.up()
    await expect.poll(() => drawing.getAttribute('transform')).not.toBe(fitted)
    await page.getByRole('button', { name: 'Fit graph', exact: true }).click()
    await expect.poll(() => drawing.getAttribute('transform')).toBe(fitted)

    await graph.getByRole('button', { name: 'Open skill shared-review', exact: true }).press('Enter')
    await detail.getByRole('heading', { name: 'shared-review', exact: true }).waitFor()
    await expect.poll(() => detail.locator('pre').textContent()).toContain('Check the evidence before applying changes.')
    await detail.getByRole('button', { name: 'Hide inspector', exact: true }).click()
    await detail.waitFor({ state: 'hidden' })
    await graph.getByRole('button', { name: `Filter project ${SAMPLE_PROJECT_NAMES.release}`, exact: true })
      .locator('circle').click()
    await expect.poll(() => graph.getByRole('button', { name: 'Open skill planning-checklist', exact: true }).count()).toBe(0)
    expect(await graph.getByRole('button', { name: 'Open skill shared-review', exact: true }).count()).toBe(1)
    await chooseProject(page, 'All projects')
    await graph.getByRole('button', { name: 'Open skill planning-checklist', exact: true }).waitFor()
    await graph.getByRole('button', { name: 'Open skill release-checklist', exact: true }).locator('circle').click()
    await expect.poll(async () => (await detail.locator('pre').textContent())?.trim()).toBe(originalBody)
    const graphShot = join(SHOTS, 'skills-graph.png')
    await page.screenshot({ path: graphShot, animations: 'disabled' })
    console.log(`Skills graph screenshot: ${graphShot}`)
    await detail.getByRole('button', { name: 'Hide inspector', exact: true }).click()
    await detail.waitFor({ state: 'hidden' })
    expect(await graph.getByRole('button').count()).toBe(54)
    await page.screenshot({ path: join(SHOTS, 'skills-graph-expanded.png'), animations: 'disabled' })
    await page.getByRole('button', { name: 'Show inspector', exact: true }).click()
    await expect.poll(async () => (await detail.locator('pre').textContent())?.trim()).toBe(originalBody)
    await detail.getByRole('button', { name: 'Hide inspector', exact: true }).click()
    await detail.waitFor({ state: 'hidden' })
    await graph.getByRole('button', { name: 'Open skill release-checklist', exact: true }).locator('circle').click()
    await detail.getByRole('heading', { name: 'release-checklist', exact: true }).waitFor()
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(false)
    await page.screenshot({ path: join(SHOTS, 'skills-graph-default-light.png'), animations: 'disabled' })
    await openSettings(page, 'en')
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Appearance', exact: true }).click()
    await settings.getByRole('button', { name: 'Terminal', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.body.getAttribute('data-yh-style'))).toBe('terminal')
    await settings.getByRole('button', { name: 'Close', exact: true }).click()
    await settings.waitFor({ state: 'hidden' })
    await page.screenshot({ path: join(SHOTS, 'skills-graph-terminal-light.png'), animations: 'disabled' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(true)
    await page.screenshot({ path: join(SHOTS, 'skills-graph-terminal-dark.png'), animations: 'disabled' })
    await openSettings(page, 'en')
    await settings.getByRole('button', { name: 'Appearance', exact: true }).click()
    await settings.getByRole('button', { name: 'Default', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.body.getAttribute('data-yh-style'))).toBe('default')
    await settings.getByRole('button', { name: 'Close', exact: true }).click()
    await settings.waitFor({ state: 'hidden' })

    // This fixture generator is deterministic. It observes isolated evidence
    // and supplies uncertain bodies; the browser owns review approval.
    const library = scaffold.ctx.skillLibrary
    library.registerLearningGenerator({ id: 'browser-fixture-generator', generate: async input => ({
      drafts: input.operation === 'compress'
        ? input.sources.map(source => ({ kind: 'compress' as const, id: source.item.id, name: source.item.name, description: source.item.description, content: source.content.replace('Inspect the reviewed patch.', 'Inspect the patch.') }))
        : input.sources.length > 0
          ? input.sources.map(source => ({ kind: 'update' as const, id: source.item.id, name: source.item.name, description: source.item.description, content: source.content.replace('Finish review.', 'Finish review and record unresolved questions.') }))
          : [{ kind: 'create' as const, name: 'interface-triage', description: 'Diagnose focused interface regressions', content: '# Interface triage\n\nInspect the reported behavior. Reproduce it in the isolated fixture, then run the focused browser check.\n\nNever publish without approval.' }],
      uncertainty: ['Fixture observations are unverified. Review the procedure before applying it.'],
    }) })
    const evidence = await library.recordLearningEvidence({ projectId: project!.id, sessionId: 'browser-fixture', task: 'Diagnose the interface regression with a focused browser check', completed: true, substantial: true, eventRefs: ['browser-fixture:1', 'browser-fixture:2'], observations: ['The isolated browser fixture exercised the reported interface behavior.'], checks: [] })
    await chooseProject(page, SAMPLE_PROJECT_NAMES.release)
    await page.getByRole('tab', { name: 'Review', exact: true }).click()
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByRole('button', { name: 'Suggest from completed work', exact: true }).click()
    const suggest = page.getByRole('dialog', { name: 'Learn from completed work', exact: true })
    await suggest.getByRole('checkbox', { name: evidence.task, exact: true }).click()
    await suggest.getByRole('button', { name: 'Generate suggestion', exact: true }).click()
    await expect.poll(() => library.listProposals({ projectId: project!.id }).length).toBe(1)
    const createdProposal = library.listProposals({ projectId: project!.id })[0]!
    await page.getByRole('button', { name: `Inspect suggestion ${createdProposal.id}`, exact: true }).click()
    const review = page.getByRole('complementary', { name: 'Review', exact: true })
    await review.getByText('No source checks recorded. Task completion does not establish verification.', { exact: true }).waitFor()
    expect(await review.getByRole('button', { name: 'Validate independently', exact: true }).isEnabled()).toBe(true)
    expect(createdProposal.state).toBe('review')
    const createdPath = join(projectRoot, '.dsh', 'skills', 'interface-triage', 'SKILL.md')
    expect(existsSync(createdPath)).toBe(false)
    const learningShot = join(SHOTS, 'skills-learning-review.png')
    await page.screenshot({ path: learningShot, animations: 'disabled' })
    console.log(`Skills learning review screenshot: ${learningShot}`)
    await review.locator('[data-diff]').first().scrollIntoViewIfNeeded()
    await expect.poll(() => review.locator('[data-diff]').first().evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return rect.top >= 88 && rect.bottom <= window.innerHeight - 26
    })).toBe(true)
    await page.screenshot({ path: join(SHOTS, 'skills-learning-diff.png'), animations: 'disabled' })
    await review.getByRole('button', { name: 'Approve and apply', exact: true }).click()
    await expect.poll(async () => (await library.detailProposal({ proposalId: createdProposal.id })).state).toBe('applied')
    await expect.poll(() => readFile(createdPath, 'utf8')).toContain('Never publish without approval.')
    const createdItem = (await library.list({})).items.find(item => item.name === 'interface-triage')!
    expect(createdItem.ownership).toBe('y-managed')
    expect(createdItem.automaticCleanup).toBe(false)
    expect(library.learningStatus({}).optIns).toEqual([])

    const source = (await library.list({})).items.find(item => item.path === releasePath)!
    const compression = await library.proposeLearning({ projectId: project!.id, operation: 'compress', targetIds: [source.id], evidenceIds: [evidence.id] })
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByRole('button', { name: `Inspect suggestion ${compression.id}`, exact: true }).click()
    await review.getByRole('heading', { name: 'Compress', exact: true }).waitFor()
    expect(await readFile(releasePath, 'utf8')).toBe(original)
    const compressionShot = join(SHOTS, 'skills-compression-review.png')
    await page.screenshot({ path: compressionShot, animations: 'disabled' })
    console.log(`Skills compression review screenshot: ${compressionShot}`)
    await review.locator('[data-diff]').first().scrollIntoViewIfNeeded()
    await expect.poll(() => review.locator('[data-diff]').first().evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return rect.top >= 88 && rect.bottom <= window.innerHeight - 26
    })).toBe(true)
    await page.screenshot({ path: join(SHOTS, 'skills-compression-diff.png'), animations: 'disabled' })
    await review.getByRole('button', { name: 'Approve and apply', exact: true }).click()
    await expect.poll(async () => (await library.detailProposal({ proposalId: compression.id })).state).toBe('applied')
    await expect.poll(() => readFile(releasePath, 'utf8')).toBe(original.replace('Inspect the reviewed patch.', 'Inspect the patch.'))
    expect(await readFile(resourcePath, 'utf8')).toBe('Keep this supporting resource intact.\n')
    await page.getByRole('tab', { name: 'Library', exact: true }).click()
    await page.getByRole('button', { name: 'Inspect release-checklist', exact: true }).click()
    await detail.getByRole('button', { name: 'Restore content from before this revision', exact: true }).first().click()
    await expect.poll(() => readFile(releasePath, 'utf8')).toBe(original)

    const rejected = await library.proposeLearning({ projectId: project!.id, operation: 'learn', targetIds: [source.id], evidenceIds: [evidence.id] })
    await page.getByRole('tab', { name: 'Review', exact: true }).click()
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await page.getByRole('button', { name: `Inspect suggestion ${rejected.id}`, exact: true }).click()
    await review.getByRole('button', { name: 'Reject suggestion', exact: true }).click()
    await review.getByText('Rejected', { exact: true }).waitFor()
    expect((await library.detailProposal({ proposalId: rejected.id })).state).toBe('rejected')
    expect(await readFile(releasePath, 'utf8')).toBe(original)

    expect(await readFile(sharedPath, 'utf8')).toBe(shared)
    expect(await readFile(planningPath, 'utf8')).toBe(planning)
    for (const sampleFile of sampleFiles) expect(await readFile(sampleFile.path, 'utf8')).toBe(sampleFile.content)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  } finally {
    try { await browser?.close() }
    finally {
      try { await scaffold?.close() }
      finally { await rm(overlayRoot, { recursive: true, force: true }) }
    }
  }
}, 60_000)
