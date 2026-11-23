/** Desktop transport admission for workspace links. */

const DESKTOP_LINK_PROTOCOL = 'dsh:'
/** Host and path reserved for Desktop workspace links. */
export const DESKTOP_BOT_PROMPT_ROUTE = 'dsh://bots/prompt'
/** Maximum encoded query size admitted before the renderer validates its fields. */
export const DESKTOP_BOT_PROMPT_QUERY_LIMIT = 16_384

/**
 * Find a supported URI among the OS launch arguments.
 * @param argv - arguments supplied to the new desktop process.
 * @returns the first supported native URL, if present.
 */
export function desktopOpenUrlFromArgs(argv: readonly string[]): string | undefined {
  return argv.find(url => url.startsWith('dsh://') && (url === 'dsh://open' || url === 'dsh://open/'
    || routeDesktopWorkspaceLink(url) !== undefined))
}

/**
 * Convert one external workspace link into the private application URL consumed by the renderer.
 *
 * The shell admits the transport route and renderer-owned query keys. The
 * renderer resolves the Bot or official plugin under the active account.
 *
 * @param value - External URL supplied by the operating system.
 * @returns A private `dsh-app` URL, or `undefined` when the transport is invalid.
 */
export function routeDesktopWorkspaceLink(value: string): string | undefined {
  let source: URL
  try {
    source = new URL(value)
  } catch (error: unknown) {
    void error
    return undefined
  }
  const bot = source.hostname === 'bots' && (source.pathname === '/prompt' || source.pathname === '/open')
  const plugin = source.hostname === 'plugins' && source.pathname === '/add'
  if (source.protocol !== DESKTOP_LINK_PROTOCOL || (!bot && !plugin)
    || source.port !== ''
    || source.username !== '' || source.password !== '' || source.hash !== '') return undefined
  if (source.search.length > DESKTOP_BOT_PROMPT_QUERY_LIMIT) return undefined

  const keys = new Set<string>()
  const prompt = source.pathname === '/prompt'
  for (const [key, value] of source.searchParams) {
    if (key !== 'id' && !(prompt && key === 'text')) return undefined
    if (keys.has(key)) return undefined
    keys.add(key)
    if (key === (prompt ? 'text' : 'id') && value.length === 0) return undefined
  }
  if (!keys.has(prompt ? 'text' : 'id')) return undefined

  const target = new URL('dsh-app://app/')
  // Fragments stay out of Host requests and access logs; the renderer consumes
  // this route once it has booted and removes it from the visible URL.
  target.hash = `/${source.hostname}${source.pathname}${source.search}`
  return target.href
}
