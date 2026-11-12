/** Read Compound's release manifest at an already resolved upstream commit. */
import { UPSTREAM_REPOSITORY } from './upstream-head.ts'

/** Current and legacy locations of Compound's release manifest. */
export const UPSTREAM_MANIFEST_PATHS = ['.codex-plugin/plugin.json', 'plugin.json'] as const

const REQUEST_TIMEOUT_MS = 30_000

/**
 * Read the manifest response, falling back to the legacy path on HTTP 404.
 * @param commit - verified upstream commit id.
 * @param signal - optional request cancellation.
 * @returns the successful manifest response at that commit.
 */
export async function requestUpstreamManifest(commit: string, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const options: RequestInit = {
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    headers: { accept: 'application/json' },
    redirect: 'error',
  }
  const [current, legacy] = UPSTREAM_MANIFEST_PATHS
  const base = `https://raw.githubusercontent.com/${UPSTREAM_REPOSITORY}/${commit}`
  let path: (typeof UPSTREAM_MANIFEST_PATHS)[number] = current
  let response = await fetch(`${base}/${path}`, options)
  if (response.status === 404) {
    await response.body?.cancel()
    path = legacy
    response = await fetch(`${base}/${path}`, options)
  }
  if (!response.ok) throw new Error(`upstream ${path} answered HTTP ${response.status}`)
  return response
}

/**
 * Extract the release label from an untrusted manifest.
 * @param manifest - decoded manifest content.
 * @returns the version string, when declared.
 */
export function upstreamManifestVersion(manifest: unknown): string | undefined {
  if (typeof manifest !== 'object' || manifest === null || !('version' in manifest)) return undefined
  return typeof manifest.version === 'string' ? manifest.version : undefined
}
