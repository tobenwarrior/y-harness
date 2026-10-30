/**
 * Resource-result projection keeps binary payloads out of model history.
 *
 * @module @yharness/mcp-resources
 */

import type { ContentBlock } from '@yharness/llm'
import type { JsonValue } from '@yharness/util-values'

/**
 * Render resource JSON while retaining raw binary data only for programmatic callers.
 * @param server - configured server attribution.
 * @param value - canonical resource result.
 * @returns attributed text with binary payload descriptions.
 */
export function renderResourceResult(server: string, value: JsonValue): ContentBlock[] {
  const rendered = JSON.stringify(value, (key, item: unknown) => {
    if (key === 'blob' && typeof item === 'string') {
      return `[binary resource: ${item.length} base64 characters; available to programmatic callers]`
    }
    return item
  })
  return [{ type: 'text', text: `MCP server: ${server}\n${rendered}` }]
}
