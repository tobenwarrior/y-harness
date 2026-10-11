/** Shared layout and SDK paging normalization for the private original-source reader. */
import { fileURLToPath } from 'node:url'

/**
 * Resolve the reader worker from the actual importing module's source or emitted URL.
 * @param moduleUrl - the source owner's real import.meta.url.
 * @returns the source build worker or the adjacent emitted worker on the selected filesystem.
 */
export function resolveClaudeSourceWorker(moduleUrl: string): string {
  return fileURLToPath(new URL(moduleUrl.endsWith('/src/claude-source.ts')
    ? '../lib/types/claude-source-worker.js' : './claude-source-worker.js', moduleUrl))
}

/**
 * Preserve optional public SDK page inputs before the strict worker request schema validates them.
 * @param requestLimit - the bounded read's selected page limit.
 * @param options - optional or partial SDK paging inputs; invalid numeric values remain invalid.
 * @returns the same limit and offset defaults for discovery and raw history.
 */
export function normalizeClaudeSourcePage(requestLimit: number, options?: { limit?: number | undefined; offset?: number | undefined }): {
  limit: number
  offset: number
} {
  return { limit: options?.limit ?? requestLimit, offset: options?.offset ?? 0 }
}
