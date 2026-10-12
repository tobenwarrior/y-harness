/** Public-config exclusions and saved-history checks for an acknowledged stable native profile. */
import { createHash } from 'node:crypto'
import type { CodingSessionSnapshot } from '@deepseek-ai/dsh-coding-session/types'
import { z } from 'zod'

type Obj = Record<string, unknown>
/** Literal native server names with an explicit disabled startup/resume setting. */
export type CodexDisabledServers = Record<string, { enabled: false }>
const object = z.record(z.string(), z.unknown())
// STOCK 0.160.0 app-server extensions register Apps and Plugins MCP contributors.
// Other native capabilities and autonomous/side-effect families are excluded too.
const excludedFeatures = ['connectors', 'web_search', 'imagegenext', 'collab', 'memory_tool', 'telepathy', 'codex_hooks',
  'request_permissions', 'exec_permission_approvals', 'apps', 'plugins', 'hooks', 'plugin_hooks', 'remote_plugin', 'plugin_sharing',
  'shell_tool', 'shell_snapshot', 'shell_snapshot_v2', 'shell_zsh_fork', 'unified_exec_zsh_fork',
  'js_repl', 'js_repl_tools_only', 'code_mode', 'code_mode_host', 'code_mode_only', 'code_mode_prewarm',
  'browser_use', 'browser_use_full_cdp_access', 'browser_use_external', 'computer_use', 'in_app_browser',
  'image_generation', 'artifact', 'multi_agent', 'multi_agent_v2', 'multi_agent_mode', 'enable_fanout',
  'agent_message_board', 'memories', 'external_agent_memory_import', 'chronicle', 'worktrees',
  'skill_mcp_dependency_install', 'skill_env_var_dependency_prompt', 'recommended_plugins', 'tool_suggest',
  'request_permissions_tool', 'request_rule', 'web_search_request', 'web_search_cached', 'standalone_web_search',
  'search_tool', 'token_budget', 'context_management', 'rollout_budget',
  'realtime_conversation', 'send_async_message', 'send_message_to_user_async', 'goals'] as const

/**
 * Refuse managed forced-on features; this confined subset accepts absent or false feature requirements only.
 * @param value - public configRequirements/read response using camelCase featureRequirements.
 * @param maximum - configured entry count bound.
 * @param bytes - configured response byte bound.
 * @returns complete observed requirements for later source-change comparison.
 */
export function verifyManagedRequirements(value: unknown, maximum: number, bytes: number): Obj | null {
  const response = z.object({ requirements: object.nullish() }).parse(value)
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > bytes) throw new Error('Original Codex managed requirements exceeded the byte limit.')
  const requirements = response.requirements ?? null
  if (requirements === null) return null
  if (Object.hasOwn(requirements, 'feature_requirements')) throw new Error('Original Codex managed feature requirements used an unsupported field.')
  const features = requirements.featureRequirements == null ? {} : z.record(z.string(), z.boolean()).parse(requirements.featureRequirements)
  if (Object.keys(features).length > maximum) throw new Error('Original Codex managed feature requirements exceeded the entry limit.')
  if (Object.values(features).some(enabled => enabled)) throw new Error('Original Codex managed forced-on features cannot provide confined file tools.')
  return requirements
}
/**
 * Validate observed MCP names and construct an explicit disable entry for each one.
 * @param value - merged public config/read configuration containing the normal MCP server map.
 * @param maximum - maximum number of observed server entries; excess or malformed entries throw.
 * @returns literal names mapped to enabled=false, without transport or credential values.
 */
export function disabledServerMap(value: Obj, maximum: number): CodexDisabledServers {
  const servers = value.mcp_servers === undefined ? {} : object.parse(value.mcp_servers)
  const entries = Object.entries(servers)
  if (entries.length > maximum) throw new Error('Original Codex server configuration exceeded the configured limit.')
  for (const [name, server] of entries) {
    if (name.length === 0 || name.length > 1024 || /[\x00-\x1f\x7f]/u.test(name)) throw new Error('Original Codex server configuration has an unsupported name.')
    object.parse(server)
  }
  return Object.fromEntries(entries.map(([name]) => [name, { enabled: false as const }]))
}
/**
 * Construct supported feature, notification, web-search and observed MCP exclusions for native resume.
 * @param servers - bounded literal server names established by the no-thread config preflight.
 * @returns JSON config overrides; they do not override managed policy or certify effective native capabilities.
 */
export function nativeRestrictions(servers: CodexDisabledServers): Obj {
  return { features: Object.fromEntries(excludedFeatures.map(name => [name, false])), agents: { enabled: false }, notify: [], web_search: 'disabled', mcp_servers: servers }
}
/**
 * Serialize startup exclusions as argument entries with quoted literal MCP names.
 * @param servers - bounded literal-name disable map from the selected original configuration.
 * @returns separate -c arguments and TOML values, without shell interpolation or dotted-name splitting.
 */
export function restrictionArguments(servers: CodexDisabledServers): string[] {
  const table = `{${Object.keys(servers).map(name => `${JSON.stringify(name)}={enabled=false}`).join(',')}}`
  return [...excludedFeatures.flatMap(name => ['-c', `features.${name}=false`]), '-c', 'agents.enabled=false', '-c', 'notify=[]', '-c', 'web_search="disabled"', '-c', `mcp_servers=${table}`]
}
function merge(base: Obj, overlay: Obj): Obj {
  const out: Obj = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    const before = out[key]
    out[key] = value !== null && typeof value === 'object' && !Array.isArray(value)
      && before !== null && typeof before === 'object' && !Array.isArray(before)
      ? merge(object.parse(before), object.parse(value)) : value
  }
  return out
}
/**
 * Derive the expected merged source configuration after applying the native exclusions.
 * @param base - observed merged original configuration; this function does not mutate it.
 * @param servers - bounded observed literal server names to disable while preserving transport fields.
 * @returns configuration merged recursively with nativeRestrictions, for later source-change comparison.
 */
export function restrictedConfig(base: Obj, servers: CodexDisabledServers): Obj { return merge(base, nativeRestrictions(servers)) }
/**
 * Hash JSON with object keys sorted recursively and array order retained.
 * @param value - JSON-serializable public configuration, policy or projected history values.
 * @returns lowercase SHA-256 for exact comparison; callers own input size limits.
 */
export function sequentialDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest('hex')
}
/**
 * Refuse changed observed source configuration by comparing normalized JSON digests.
 * @param expected - original merged configuration or requirements with the expected exclusions.
 * @param actual - fresh complete configuration or requirements from the same selected source.
 * @returns after equality; a mismatch throws and equality does not certify thread-local execution policy.
 */
export function verifyRestrictedConfig(expected: Obj, actual: Obj): void {
  if (sequentialDigest(expected) !== sequentialDigest(actual)) throw new Error('Original Codex profile configuration changed during the sequential handoff.')
}
/**
 * Require the same native source and cwd plus every ordered projected event in the saved prefix.
 * @param expected - previously checked complete public snapshot whose events must remain unchanged.
 * @param actual - fresh complete public snapshot; additional events after the prefix are permitted.
 * @returns after source, cwd and prefix equality; missing or changed events throw without certifying private native context.
 */
export function assertSavedPrefix(expected: CodingSessionSnapshot, actual: CodingSessionSnapshot): void {
  if (sequentialDigest(expected.source) !== sequentialDigest(actual.source) || expected.cwd !== actual.cwd) throw new Error('Original Codex readback returned a different source or project.')
  if (actual.events.length < expected.events.length
    || expected.events.some((event, index) => sequentialDigest(event) !== sequentialDigest(actual.events[index]))) {
    throw new Error('Original Codex saved public-history prefix was not preserved.')
  }
}
