/**
 * Canonical publication manifest for the documentation website.
 *
 * Markdown stays in its owning repository tier. This manifest maps each
 * canonical source into matching route trees for both site locales; when a
 * translation is absent, both routes intentionally project the available
 * source instead of copying Markdown.
 */

/** Locale key used by the VitePress site. */
export type DocsLocale = 'root' | 'en'

/** Sidebar collection rendered for one locale and top-level module. */
export type DocsSidebar =
  | 'zh-guide'
  | 'zh-develop'
  | 'zh-reference'
  | 'en-guide'
  | 'en-develop'
  | 'en-reference'

/** A page projected into the VitePress source tree. */
export interface DocsPage {
  /** VitePress locale whose route tree owns this projection. */
  locale: DocsLocale
  /** Language of the canonical source currently projected at this route. */
  contentLocale: 'zh-CN' | 'en-US'
  /** Repository-relative canonical Markdown source. */
  source: string
  /** VitePress route, including the `.md` suffix. */
  route: string
  /** Navigation label shown in the sidebar. */
  label: string
  /** Sidebar collection that owns the page, or null for a locale home page. */
  sidebar: DocsSidebar | null
  /** Section label within the sidebar. */
  section: string
  /** Stable order within the section. */
  order: number
  /** Heading levels included in this page's VitePress outline. */
  outline?: number | readonly [number, number] | 'deep' | false
  /** Additional repository paths that resolve to this page. */
  sourceAliases?: string[]
}

interface MirroredPage {
  source: string | Record<DocsLocale, string>
  route: string
  contentLocale: DocsPage['contentLocale'] | Record<DocsLocale, DocsPage['contentLocale']>
  label: Record<DocsLocale, string>
  sidebar: Record<DocsLocale, DocsSidebar | null>
  section: Record<DocsLocale, string>
  order: number
  outline?: DocsPage['outline']
  sourceAliases?: string[] | Partial<Record<DocsLocale, string[]>>
}

type PairedPage = Omit<MirroredPage, 'source' | 'contentLocale' | 'sourceAliases'> & {
  /** English side of a sibling `foo.md` / `foo.zh.md` pair. */
  source: string
  /** Language-neutral repository aliases, such as the directory of an index page. */
  sourceAliases?: string[]
}

function localized<T>(value: T | Record<DocsLocale, T>, locale: DocsLocale): T {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<DocsLocale, T>)[locale]
    : value
}

/** Publish each declared page once, in English, at the site root. */
function mirroredPages(pages: MirroredPage[]): DocsPage[] {
  return pages.map((page) => {
    const aliases = page.sourceAliases === undefined
      ? undefined
      : Array.isArray(page.sourceAliases) ? page.sourceAliases : page.sourceAliases.en
    return {
      locale: 'root',
      contentLocale: 'en-US',
      source: localized(page.source, 'en'),
      route: page.route,
      label: page.label.en,
      sidebar: page.sidebar.en,
      section: page.section.en,
      order: page.order,
      ...(page.outline === undefined ? {} : { outline: page.outline }),
      ...(aliases === undefined ? {} : { sourceAliases: aliases }),
    }
  })
}

/** Publish the English source of a former pair; this checkout carries no translation. */
function pairedPages(pages: PairedPage[]): DocsPage[] {
  return mirroredPages(pages.map(page => ({
    ...page,
    source: { root: page.source, en: page.source },
    contentLocale: { root: 'en-US', en: 'en-US' },
    sourceAliases: { root: page.sourceAliases ?? [], en: page.sourceAliases ?? [] },
  })))
}

const homeAndGuide = pairedPages([
  {
    source: 'docs/user/index.md',
    route: 'index.md',
    label: { root: 'Y Harness', en: 'Y Harness' },
    sidebar: { root: null, en: null },
    section: { root: 'Home', en: 'Home' },
    order: 0,
  },
  {
    source: 'docs/user/guide/index.md',
    route: 'guide/quickstart.md',
    label: { root: 'Use the Web UI', en: 'Use the Web UI' },
    sidebar: { root: 'zh-guide', en: 'en-guide' },
    section: { root: 'Guide', en: 'Guide' },
    order: 1,
    sourceAliases: ['docs/user/guide'],
  },
  {
    source: 'docs/user/guide/providers.md',
    route: 'guide/providers.md',
    label: { root: 'Configure models', en: 'Configure models' },
    sidebar: { root: 'zh-guide', en: 'en-guide' },
    section: { root: 'Guide', en: 'Guide' },
    order: 2,
  },
  {
    source: 'docs/user/guide/network-proxy.md',
    route: 'guide/network-proxy.md',
    label: { root: 'Network proxy', en: 'Network proxy' },
    sidebar: { root: 'zh-guide', en: 'en-guide' },
    section: { root: 'Guide', en: 'Guide' },
    order: 3,
  },
  {
    source: 'docs/user/guide/public-deployments.md',
    route: 'guide/public-deployments.md',
    label: { root: 'Public deployments', en: 'Public deployments' },
    sidebar: { root: 'zh-guide', en: 'en-guide' },
    section: { root: 'Guide', en: 'Guide' },
    order: 4,
  },
  {
    source: 'docs/user/guide/python-sdk.md',
    route: 'guide/python-sdk.md',
    label: { root: 'Python', en: 'Python' },
    sidebar: { root: 'zh-guide', en: 'en-guide' },
    section: { root: 'SDK', en: 'SDK' },
    order: 1,
  },
  {
    source: 'docs/user/guide/github-review.md',
    route: 'guide/github-review.md',
    label: { root: 'GitHub review sessions', en: 'GitHub review sessions' },
    sidebar: { root: 'zh-guide', en: 'en-guide' },
    section: { root: 'Automation', en: 'Automation' },
    order: 1,
  },
  {
    source: 'docs/user/guide/schedule.md',
    route: 'guide/schedule.md',
    label: { root: 'Session reminders', en: 'Session reminders' },
    sidebar: { root: 'zh-guide', en: 'en-guide' },
    section: { root: 'Automation', en: 'Automation' },
    order: 2,
  },
  {
    source: 'docs/user/guide/mcp-memory.md',
    route: 'guide/mcp-memory.md',
    label: { root: 'Memory MCP', en: 'Memory MCP' },
    sidebar: { root: 'zh-guide', en: 'en-guide' },
    section: { root: 'Integrations', en: 'Integrations' },
    order: 1,
  },
])

const develop = pairedPages([
  {
    source: 'docs/user/develop/basic/index.md',
    route: 'develop/basic/index.md',
    label: { root: 'Your first Harness plugin', en: 'Your first Harness plugin' },
    sidebar: { root: 'zh-develop', en: 'en-develop' },
    section: { root: 'Basics', en: 'Basics' },
    order: 1,
    sourceAliases: ['docs/user/develop/basic'],
  },
  {
    source: 'docs/user/develop/basic/tool.md',
    route: 'develop/basic/tool.md',
    label: { root: 'Build a tool', en: 'Build a tool' },
    sidebar: { root: 'zh-develop', en: 'en-develop' },
    section: { root: 'Basics', en: 'Basics' },
    order: 2,
  },
  {
    source: 'docs/user/develop/basic/config.md',
    route: 'develop/basic/config.md',
    label: { root: 'Plugin configuration', en: 'Plugin configuration' },
    sidebar: { root: 'zh-develop', en: 'en-develop' },
    section: { root: 'Basics', en: 'Basics' },
    order: 3,
  },
  {
    source: 'docs/user/develop/basic/publish.md',
    route: 'develop/basic/publish.md',
    label: { root: 'Package and install', en: 'Package and install' },
    sidebar: { root: 'zh-develop', en: 'en-develop' },
    section: { root: 'Basics', en: 'Basics' },
    order: 4,
  },
  {
    source: 'docs/user/develop/framework/index.md',
    route: 'develop/framework/index.md',
    label: { root: 'Plugin lifecycle', en: 'Plugin lifecycle' },
    sidebar: { root: 'zh-develop', en: 'en-develop' },
    section: { root: 'Framework', en: 'Framework' },
    order: 1,
    sourceAliases: ['docs/user/develop/framework'],
  },
  {
    source: 'docs/user/develop/framework/service.md',
    route: 'develop/framework/service.md',
    label: { root: 'Services and dependencies', en: 'Services and dependencies' },
    sidebar: { root: 'zh-develop', en: 'en-develop' },
    section: { root: 'Framework', en: 'Framework' },
    order: 2,
  },
  {
    source: 'docs/user/develop/framework/events.md',
    route: 'develop/framework/events.md',
    label: { root: 'Event system', en: 'Event system' },
    sidebar: { root: 'zh-develop', en: 'en-develop' },
    section: { root: 'Framework', en: 'Framework' },
    order: 3,
  },
  {
    source: 'docs/user/develop/practice/index.md',
    route: 'develop/practice/index.md',
    label: { root: 'Capability layering', en: 'Capability layering' },
    sidebar: { root: 'zh-develop', en: 'en-develop' },
    section: { root: 'Practice', en: 'Practice' },
    order: 1,
    sourceAliases: ['docs/user/develop/practice'],
  },
  {
    source: 'docs/user/develop/practice/llm-adapter.md',
    route: 'develop/practice/llm-adapter.md',
    label: { root: 'LLM adapter', en: 'LLM adapter' },
    sidebar: { root: 'zh-develop', en: 'en-develop' },
    section: { root: 'Practice', en: 'Practice' },
    order: 2,
  },
  {
    source: 'docs/user/develop/practice/dynamic-cordis.md',
    route: 'develop/practice/dynamic-cordis.md',
    label: { root: 'Persistent Harness plugins', en: 'Persistent Harness plugins' },
    sidebar: { root: 'zh-develop', en: 'en-develop' },
    section: { root: 'Practice', en: 'Practice' },
    order: 3,
  },
])

const cordisTutorial = pairedPages(([
  ['index.md', 'Overview', 'Overview'],
  ['01-first-plugin.md', '1. Your first plugin', '1. Your first plugin'],
  ['02-lifecycle-and-effects.md', '2. Lifecycle and effects', '2. Lifecycle and effects'],
  ['03-services.md', '3. Services', '3. Services'],
  ['04-events.md', '4. Events', '4. Events'],
  ['05-config.md', '5. Configuration', '5. Configuration'],
  ['06-composition-and-hmr.md', '6. Composition and HMR', '6. Composition and HMR'],
  ['07-into-the-harness.md', '7. Into the harness', '7. Into the harness'],
] as const).map(([file, rootLabel, enLabel], order): PairedPage => ({
  source: `docs/cordis-tutorial/${file}`,
  route: `develop/cordis-tutorial/${file}`,
  label: { root: rootLabel, en: enLabel },
  sidebar: { root: 'zh-develop', en: 'en-develop' },
  section: { root: 'Cordis framework tutorial', en: 'Cordis framework tutorial' },
  order,
  ...(file === 'index.md' ? { sourceAliases: ['docs/cordis-tutorial'] } : {}),
})))

const cordisPrimerReference = pairedPages([
  {
    source: 'docs/cordis-primer.md',
    route: 'reference/cordis-primer.md',
    label: { root: 'Cordis primer', en: 'Cordis primer' },
    sidebar: { root: 'zh-reference', en: 'en-reference' },
    section: { root: 'Concepts', en: 'Concepts' },
    order: 1,
  },
])

/**
 * Subsystem pages grouped by the concern they document, as `[section label,
 * English section, pages]`. One flat list of every subsystem pushed the rest of
 * the reference sidebar below the fold.
 */
const subsystemGroups = [
  ['Overview', 'Overview', [
    ['README.md', 'Subsystems', 'Subsystems'],
  ]],
  ['Core and scopes', 'Core and scopes', [
    ['core.md', 'Core', 'Core'],
    ['scope.md', 'Scopes', 'Scopes'],
  ]],
  ['Sessions and persistence', 'Sessions and persistence', [
    ['session.md', 'Sessions', 'Sessions'],
    ['session-query.md', 'Session query', 'Session query'],
    ['session-reference.md', 'Session references', 'Session references'],
    ['session-title.md', 'Session titles', 'Session titles'],
    ['session-projection.md', 'Session projections', 'Session projections'],
    ['persistence.md', 'Session persistence', 'Session persistence'],
    ['spill.md', 'Spill storage', 'Spill storage'],
    ['session-telemetry.md', 'SessionTelemetryBackend', 'SessionTelemetryBackend'],
  ]],
  ['Model and context', 'Model and context', [
    ['llm-streaming.md', 'LLM streaming', 'LLM streaming'],
    ['token-meter.md', 'Token metering', 'Token metering'],
    ['system-prompt.md', 'System prompts', 'System prompts'],
    ['compaction.md', 'Compaction', 'Compaction'],
  ]],
  ['Execution and tools', 'Execution and tools', [
    ['tools.md', 'Tools', 'Tools'],
    ['shell.md', 'Bash execution', 'Bash execution'],
    ['subprocess.md', 'Subprocesses', 'Subprocesses'],
    ['terminal.md', 'PTY sessions', 'PTY sessions'],
    ['jobs.md', 'Background jobs', 'Background jobs'],
    ['filesystem.md', 'Filesystem', 'Filesystem'],
    ['lsp.md', 'LSP navigation', 'LSP navigation'],
    ['ptc-runtime.md', 'PTC runtime', 'PTC runtime'],
    ['web.md', 'Web access', 'Web access'],
    ['skills.md', 'Skills', 'Skills'],
    ['workflow.md', 'Workflows', 'Workflows'],
    ['subagent.md', 'Subagents', 'Subagents'],
  ]],
  ['Policy and interaction', 'Policy and interaction', [
    ['approval.md', 'Approvals', 'Approvals'],
    ['permission-presets.md', 'Permission presets', 'Permission presets'],
    ['sandbox.md', 'Sandboxing', 'Sandboxing'],
    ['plan.md', 'Plan mode', 'Plan mode'],
    ['user-questions.md', 'User interaction', 'User interaction'],
    ['commands.md', 'Human commands', 'Human commands'],
    ['goal.md', 'Goals', 'Goals'],
    ['schedule.md', 'Scheduled reminders', 'Scheduled reminders'],
  ]],
  ['Platform and access', 'Platform and access', [
    ['web-server.md', 'HTTP server', 'HTTP server'],
    ['web-client.md', 'Web Client architecture', 'Web Client architecture'],
    ['client-modules.md', 'Client modules', 'Client modules'],
    ['slots.md', 'Client slots', 'Client slots'],
    ['client-resources.md', 'Client resources', 'Client resources'],
    ['sidebar-right.md', 'Right Sidebar', 'Right Sidebar'],
    ['conversation.md', 'Conversation assembly', 'Conversation assembly'],
    ['typert.md', 'Typert', 'Typert'],
    ['storage.md', 'Storage', 'Storage'],
    ['workspace.md', 'Workspaces', 'Workspaces'],
    ['settings.md', 'User settings', 'User settings'],
    ['credentials.md', 'User credentials', 'User credentials'],
  ]],
] as const

const subsystemsReference = subsystemGroups.flatMap(([rootSection, enSection, files]) => pairedPages(
  files.map(([file, rootLabel, enLabel], order): PairedPage => ({
    source: `docs/subsystems/${file}`,
    route: file === 'README.md' ? 'reference/subsystems/index.md' : `reference/subsystems/${file}`,
    label: { root: rootLabel, en: enLabel },
    sidebar: { root: 'zh-reference', en: 'en-reference' },
    section: { root: rootSection, en: enSection },
    order,
    // Subsystem pages carry long third-level sections a two-level outline reaches.
    outline: [2, 3],
    ...(file === 'README.md' ? { sourceAliases: ['docs/subsystems'] } : {}),
  })),
))

const reference = [
  // `docs/deepseek-llm-api-wire-extensions.md` is a repository-only provider protocol reference.
  // Projected links intentionally resolve to its GitHub source instead of a public site route.
  ...pairedPages(([
    ['docs/architecture.md', 'reference/index.md', 'Architecture', 'Architecture', 0],
  ] as const).map(([source, route, rootLabel, enLabel, order]): PairedPage => ({
    source,
    route,
    label: { root: rootLabel, en: enLabel },
    sidebar: { root: 'zh-reference', en: 'en-reference' },
    section: { root: 'Concepts', en: 'Concepts' },
    order,
  }))),
  ...pairedPages(([
    ['docs/capability-seams.md', 'reference/capability-seams.md', 'Capability services', 'Capability services', 2],
    ['docs/agent-lifecycle.md', 'reference/agent-lifecycle.md', 'Agent lifecycle', 'Agent lifecycle', 3],
    ['docs/tool-execution-pipeline.md', 'reference/tool-execution-pipeline.md', 'Tool execution', 'Tool execution', 4],
    ['docs/api-gateway.md', 'reference/api-gateway.md', 'API Gateway', 'API Gateway', 5],
  ] as const).map(([source, route, rootLabel, enLabel, order]): PairedPage => ({
    source,
    route,
    label: { root: rootLabel, en: enLabel },
    sidebar: { root: 'zh-reference', en: 'en-reference' },
    section: { root: 'Concepts', en: 'Concepts' },
    order,
  }))),
  ...pairedPages(([
    ['docs/config-catalog.md', 'reference/config-catalog.md', 'Plugin configuration', 'Plugin configuration'],
    ['docs/tool-catalog.md', 'reference/tool-catalog.md', 'Tool Schema', 'Tool schemas'],
    ['docs/persistence-catalog.md', 'reference/persistence-catalog.md', 'Persistence events', 'Persistence events', 'deep'],
  ] as const).map(([source, route, rootLabel, enLabel, outline], order): PairedPage => ({
    source,
    route,
    label: { root: rootLabel, en: enLabel },
    sidebar: { root: 'zh-reference', en: 'en-reference' },
    section: { root: 'Generated reference', en: 'Generated reference' },
    order,
    ...(outline === undefined ? {} : { outline }),
  }))),
  ...pairedPages(([
    ['context.md', 'Context', 'Context'],
    ['events.md', 'Events', 'Events'],
    ['fiber.md', 'Fiber', 'Fiber'],
    ['registry.md', 'Plugin Registry', 'Plugin Registry'],
    ['service.md', 'Service', 'Service'],
  ] as const).map(([file, rootLabel, enLabel], order): PairedPage => ({
    source: `docs/cordis-api/${file}`,
    route: `reference/cordis-api/${file}`,
    label: { root: rootLabel, en: enLabel },
    sidebar: { root: 'zh-reference', en: 'en-reference' },
    section: { root: 'Cordis API', en: 'Cordis Core API' },
    order,
  }))),
  ...mirroredPages(([
    ['inherited.md', 'Inherited surface', 'Inherited surface'],
  ] as const).map(([file, rootLabel, enLabel], order): MirroredPage => ({
    source: `docs/cordis-api/${file}`,
    route: `reference/cordis-api/${file}`,
    contentLocale: 'en-US',
    label: { root: rootLabel, en: enLabel },
    sidebar: { root: 'zh-reference', en: 'en-reference' },
    section: { root: 'Cordis API', en: 'Cordis Core API' },
    order: order + 5,
  }))),
  ...pairedPages(([
    ['adding-a-package.md', 'Adding a package', 'Adding a package'],
    ['adding-a-tool.md', 'Adding a tool', 'Adding a tool'],
    ['adding-an-llm-adapter.md', 'Adding an LLM adapter', 'Adding an LLM adapter'],
    ['adding-a-settings-card.md', 'Adding a settings page', 'Adding a settings page'],
    ['extension-cookbook.md', 'Extension patterns', 'Extension patterns'],
  ] as const).map(([file, rootLabel, enLabel], order): PairedPage => ({
    source: `docs/cookbook/${file}`,
    route: `reference/cookbook/${file}`,
    label: { root: rootLabel, en: enLabel },
    sidebar: { root: 'zh-reference', en: 'en-reference' },
    section: { root: 'Cookbook', en: 'Cookbook' },
    order,
  }))),
]

/**
 * Sidebar collections of each locale, in the order the site's navigation
 * presents them. The navigation bar and the llms.txt index both read this
 * sequence, so a new collection lands in both surfaces together.
 */
export const localeCollections = {
  root: ['en-guide', 'en-develop', 'en-reference'],
  en: ['en-guide', 'en-develop', 'en-reference'],
} as const satisfies Record<DocsLocale, readonly DocsSidebar[]>

/** A sidebar group, matched to pages by `label`. */
export interface DocsSection {
  /** Group heading, equal to the `section` field of every page it holds. */
  label: string
  /** Render the group collapsed until it holds the page being read. */
  collapsed?: boolean
}

/**
 * Every sidebar group, in the order its locale renders it.
 *
 * The subsystem groups collapse because together they outnumber the rest of the
 * reference sidebar; expanded, they push every other group below the fold.
 */
const sections: Record<DocsLocale, readonly DocsSection[]> = {
  root: [
    { label: 'Guide' }, { label: 'SDK' }, { label: 'Automation' }, { label: 'Integrations' },
    { label: 'Basics' }, { label: 'Framework' }, { label: 'Practice' }, { label: 'Cordis framework tutorial' },
    { label: 'Concepts' }, { label: 'Generated reference' }, { label: 'Cordis Core API' }, { label: 'Cookbook' },
    { label: 'Overview' },
    { label: 'Core and scopes', collapsed: true },
    { label: 'Sessions and persistence', collapsed: true },
    { label: 'Model and context', collapsed: true },
    { label: 'Execution and tools', collapsed: true },
    { label: 'Policy and interaction', collapsed: true },
    { label: 'Platform and access', collapsed: true },
  ],
  en: [
    { label: 'Guide' }, { label: 'SDK' }, { label: 'Automation' }, { label: 'Integrations' },
    { label: 'Basics' }, { label: 'Framework' }, { label: 'Practice' }, { label: 'Cordis framework tutorial' },
    { label: 'Concepts' }, { label: 'Generated reference' }, { label: 'Cordis Core API' }, { label: 'Cookbook' },
    { label: 'Overview' },
    { label: 'Core and scopes', collapsed: true },
    { label: 'Sessions and persistence', collapsed: true },
    { label: 'Model and context', collapsed: true },
    { label: 'Execution and tools', collapsed: true },
    { label: 'Policy and interaction', collapsed: true },
    { label: 'Platform and access', collapsed: true },
  ],
}

/**
 * Placement and collapse behavior of one sidebar group.
 *
 * @param locale - Route tree whose sidebar is being built.
 * @param label - Section label carried by the pages in the group.
 * @returns The declared group, plus its zero-based position in the locale.
 * @throws When the locale declares no placement for the label. Ranking by list
 *   membership alone would sort an undeclared group silently ahead of every
 *   declared one.
 */
export function sectionSpec(locale: DocsLocale, label: string): DocsSection & { index: number } {
  const declared = sections[locale]
  const section = declared.find(candidate => candidate.label === label)
  if (section === undefined) throw new Error(`Sidebar section "${label}" has no placement in the ${locale} locale.`)
  return { ...section, index: declared.indexOf(section) }
}

/** Every canonical page published by the documentation website. */
export const docsPages: DocsPage[] = [
  ...homeAndGuide,
  ...develop,
  ...cordisTutorial,
  ...cordisPrimerReference,
  ...subsystemsReference,
  ...reference,
]

/**
 * Pages of one sidebar collection, in the order the sidebar lists them.
 *
 * @param locale - Route tree whose sidebar is being built.
 * @param collection - Sidebar collection to read.
 * @returns The collection's pages, ordered by section placement then by `order`.
 */
export function orderedPages(locale: DocsLocale, collection: DocsSidebar): DocsPage[] {
  return docsPages
    .filter(page => page.locale === locale && page.sidebar === collection)
    .sort((left, right) => (
      sectionSpec(locale, left.section).index - sectionSpec(locale, right.section).index
      || left.order - right.order
    ))
}

/**
 * Site-relative link for a published route.
 *
 * @param route - Manifest route, including its `.md` suffix.
 * @returns The link VitePress serves the route at.
 */
export function routeLink(route: string): string {
  return `/${route.replace(/(?:index)?\.md$/, '')}`
}

/**
 * Where a top-level navigation item lands.
 *
 * The target is derived rather than written down: a collection whose first page
 * is renamed or reordered would otherwise leave the navigation bar pointing at
 * a route the manifest no longer publishes.
 *
 * @param locale - Route tree the navigation item belongs to.
 * @param collection - Sidebar collection the item opens.
 * @returns Site-relative link of the collection's first page.
 * @throws When the collection publishes no page.
 */
export function landingLink(locale: DocsLocale, collection: DocsSidebar): string {
  const first = orderedPages(locale, collection)[0]
  if (first === undefined) throw new Error(`Sidebar collection "${collection}" publishes no page.`)
  return routeLink(first.route)
}
