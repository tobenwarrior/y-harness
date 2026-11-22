/** Desktop transport admission for the Bot prompt deep link. */

/** Protocol route used by other applications to address a Bot prompt. */
export const DESKTOP_BOT_PROMPT_PROTOCOL = 'dsh:'
/** Host and path reserved for Bot prompt links. */
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
    || routeDesktopBotPrompt(url) !== undefined))
}

/**
 * Convert one external Bot prompt link into the private application URL consumed by the renderer.
 *
 * The desktop shell admits only the transport route and the two renderer-owned
 * query keys. The renderer remains the semantic authority for Bot ids, primary
 * selection, prompt length, and draft preservation. No link is submitted here.
 *
 * @param value - External URL supplied by the operating system.
 * @returns A private `dsh-app` URL, or `undefined` when the transport is invalid.
 */
export function routeDesktopBotPrompt(value: string): string | undefined {
  let source: URL
  try {
    source = new URL(value)
  } catch (error: unknown) {
    void error
    return undefined
  }
  if (source.protocol !== DESKTOP_BOT_PROMPT_PROTOCOL || source.hostname !== 'bots'
    || source.port !== '' || source.pathname !== '/prompt'
    || source.username !== '' || source.password !== '' || source.hash !== '') return undefined
  if (source.search.length > DESKTOP_BOT_PROMPT_QUERY_LIMIT) return undefined

  const keys = new Set<string>()
  let hasText = false
  for (const [key, value] of source.searchParams) {
    if (key !== 'id' && key !== 'text') return undefined
    if (keys.has(key)) return undefined
    keys.add(key)
    if (key === 'text') {
      if (value.length === 0) return undefined
      hasText = true
    }
  }
  if (!hasText) return undefined

  const target = new URL('dsh-app://app/')
  // Fragments stay out of Host requests and access logs; the renderer consumes
  // this route once it has booted and removes it from the visible URL.
  target.hash = `/bots/prompt${source.search}`
  return target.href
}
