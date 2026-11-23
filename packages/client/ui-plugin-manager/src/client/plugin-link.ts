/** Read-only navigation to an official plugin's details. */

/** Fragment used by linked plugin details. */
export const OFFICIAL_PLUGIN_FRAGMENT = '#/plugins/add?'

/**
 * Check a catalog item ID or a first-party bundle name.
 * @param id - identifier from the catalog or a link.
 * @returns whether this identifier can be represented in a plugin link.
 */
export function isOfficialPluginLinkId(id: string): boolean {
  return /^(?:@yharness\/)?[a-z0-9][a-z0-9-]{0,127}$/u.test(id)
}

/**
 * Read the target of an official plugin link owned by the current application.
 * @param url - URL to validate.
 * @param origin - exact origin serving this renderer.
 * @returns the requested catalog identifier before catalog membership is checked.
 */
export function parseOfficialPluginLink(url: URL, origin: string): string | undefined {
  const desktop = url.protocol === 'dsh-app:' && url.host === 'app' && url.pathname === '/'
  const trusted = desktop
    ? origin === 'dsh-app://app' || origin === url.origin
    : (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === origin
  if (!trusted || url.username !== '' || url.password !== '' || !url.hash.startsWith(OFFICIAL_PLUGIN_FRAGMENT)) return undefined
  const value = url.hash.slice(OFFICIAL_PLUGIN_FRAGMENT.length)
  if (value.length > 512 || value.includes('#')) return undefined
  const pairs = [...new URLSearchParams(value)]
  const field = pairs[0]
  return pairs.length === 1 && field?.[0] === 'id' && isOfficialPluginLinkId(field[1]) ? field[1] : undefined
}

/**
 * Copy a link to the plugin in this app without copying any sign-in parameters.
 * @param active - current application URL.
 * @param id - catalog item or official bundle identifier.
 * @param desktop - whether Desktop handles external links for this renderer.
 * @returns a private app-relative Web address or Desktop link.
 */
export function officialPluginLink(active: URL, id: string, desktop: boolean): string {
  const query = new URLSearchParams({ id }).toString()
  if (desktop) return `dsh://plugins/add?${query}`
  const link = new URL(active.origin)
  link.pathname = active.pathname
  link.hash = `${OFFICIAL_PLUGIN_FRAGMENT}${query}`
  return link.href
}
