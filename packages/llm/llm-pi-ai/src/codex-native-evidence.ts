/** Sanitized native items and allowlisted procedure facts; no raw bodies or inferred verification. */
import { isAbsolute, relative, resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SkillLearningNativeItem, SkillNativeConnectionId, SkillCodexSessionId, SkillCodexTurnId, SkillCodexItemId } from '@deepseek-ai/dsh-skill-library/types'

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function id(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined
}

/** Only simple project-root invocations survive; commandActions alone grant no procedure. */
function procedure(item: Record<string, unknown>, projectCwd: string | undefined): SkillLearningNativeItem['procedure'] {
  if (item.source !== 'agent' || projectCwd === undefined || typeof item.cwd !== 'string' || resolve(item.cwd) !== resolve(projectCwd)
    || typeof item.command !== 'string' || item.command.length > 256 || /[\r\n]/.test(item.command)) return undefined
  // Fixed POSIX derive_exec_args envelope, serialized by the pinned shlex::try_join.
  // Only a single plain quoted body is unwrapped; expansions and nested quoting stay unknown.
  const wrapper = /^\/bin\/(?:zsh|bash|sh) -(?:lc|c) '([A-Za-z0-9_./ -]+)'$/.exec(item.command)
  const command = (wrapper?.[1] ?? item.command).trim().replace(/ +/g, ' ')
  if (/^(?:(?:pnpm|npm) run (?:test|lint|typecheck|build)|npm test|pnpm exec vitest run|(?:python -m )?pytest|cargo (?:test|check)|go test \.\/\.\.\.|git diff --check)$/.test(command)) return { kind: 'check', command }
  const match = /^cat ([A-Za-z0-9_./-]+)$/.exec(command)
  if (match === null) return undefined
  const actions = Array.isArray(item.commandActions) ? item.commandActions.map(object) : []
  const action = actions.length === 1 ? actions[0] : undefined
  const argument = match[1]
  if (argument === undefined) return undefined
  if (action?.type !== 'read' || typeof action.path !== 'string' || resolve(projectCwd, argument) !== resolve(projectCwd, action.path)) return undefined
  const path = relative(resolve(projectCwd), resolve(projectCwd, argument)).replace(/\\/g, '/')
  if (isAbsolute(path) || path.length > 256
    || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|yml|yaml|toml)$/.test(path)
    || path.split('/').some(part => part.startsWith('.') || /secret|credential|password|token|auth/i.test(part))) return undefined
  return { kind: 'read', path }
}

function projectPath(value: unknown, root: string): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\x00-\x1f\x7f]/u.test(value)) return undefined
  const path = relative(resolve(root), resolve(root, value)).replace(/\\/g, '/')
  if (isAbsolute(path) || path.length > 256
    || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|yml|yaml|toml)$/.test(path)
    || path.split('/').some(part => part.startsWith('.') || /secret|credential|password|token|auth/i.test(part))) return undefined
  return path
}
function patchProcedure(
  item: Record<string, unknown>, root: string | undefined, maximum: number,
): SkillLearningNativeItem['patchProcedure'] {
  if (root === undefined || !isAbsolute(root) || !Number.isSafeInteger(maximum) || maximum < 1
    || !Array.isArray(item.changes) || item.changes.length === 0 || item.changes.length > maximum) return undefined
  const changes: Array<{ operation: 'add' | 'delete' | 'update'; path: string; movePath?: string }> = []
  const targets = new Set<string>()
  for (const raw of item.changes) {
    const change = object(raw); const kind = object(change.kind); const operation = kind.type
    const path = projectPath(change.path, root)
    if (path === undefined || typeof change.diff !== 'string' || operation !== 'add' && operation !== 'delete' && operation !== 'update'
      || targets.has(path) || Object.hasOwn(kind, 'movePath')) return undefined
    targets.add(path)
    const movePath = kind.move_path == null ? undefined : projectPath(kind.move_path, root)
    if (kind.move_path != null && (operation !== 'update' || movePath === undefined || targets.has(movePath))) return undefined
    if (movePath !== undefined) targets.add(movePath)
    changes.push({ operation, path, ...movePath === undefined ? {} : { movePath } })
  }
  return { kind: 'patch', changes }
}

/**
 * Parse metadata from one live, current-turn native item notification.
 * @param connectionId - configured connection identity, distinct from the native thread.
 * @param sessionId - original native thread identity.
 * @param turnId - original active native turn identity.
 * @param phase - observed item lifecycle phase.
 * @param value - app-server item JSON; arguments and result bodies are discarded.
 * @param projectCwd - actual registered project root, used only for allowlisted procedure facts.
 * @param maxPatchChanges - explicit complete file-change count bound; absent disables concrete patch facts.
 * @returns bounded neutral metadata for a supported tool item, or no observation.
 */
export function codexNativeItem(connectionId: string, sessionId: string, turnId: string,
  phase: SkillLearningNativeItem['phase'], value: unknown, projectCwd?: string, maxPatchChanges = 0): SkillLearningNativeItem | undefined {
  const item = object(value); const itemId = id(item.id)
  if (itemId === undefined || id(connectionId) === undefined || id(sessionId) === undefined || id(turnId) === undefined) return undefined
  let kind: SkillLearningNativeItem['kind']
  let skillReadPath: string | undefined
  switch (item.type) {
    case 'commandExecution': {
      if (item.source !== undefined && item.source !== 'agent') return undefined
      const actions = Array.isArray(item.commandActions) ? item.commandActions.map(object) : []
      kind = actions.length > 0 && actions.every(action => action.type === 'read' || action.type === 'listFiles' || action.type === 'search') ? 'read' : 'command'
      const action = actions.length === 1 ? actions[0] : undefined
      if (action?.type === 'read' && typeof action.path === 'string' && action.path.length <= 1024
        && /(?:^|[/\\])SKILL\.md$/.test(action.path)) skillReadPath = action.path
      break
    }
    case 'fileChange': kind = 'file-change'; break
    case 'webSearch': kind = 'web'; break
    case 'mcpToolCall': case 'dynamicToolCall': kind = 'mcp'; break
    default: return undefined
  }
  const outcome: SkillLearningNativeItem['outcome'] = item.status === 'failed' || item.status === 'declined'
    || item.type === 'commandExecution' && typeof item.exitCode === 'number' && item.exitCode !== 0
    || item.type === 'mcpToolCall' && item.error != null || item.type === 'dynamicToolCall' && item.success === false
    ? 'reported-error'
    : item.type === 'commandExecution' && item.status === 'completed' && item.exitCode === 0
      || item.type === 'fileChange' && item.status === 'completed'
      || item.type === 'mcpToolCall' && item.status === 'completed' && item.error === null
      || item.type === 'dynamicToolCall' && item.success === true ? 'reported-success' : 'unknown'
  const fact = item.type === 'commandExecution' ? procedure(item, projectCwd)
    : item.type === 'fileChange' ? patchProcedure(item, projectCwd, maxPatchChanges) : undefined
  return { provider: 'codex', connectionId: brandString<SkillNativeConnectionId>(connectionId),
    sessionId: brandString<SkillCodexSessionId>(sessionId), turnId: brandString<SkillCodexTurnId>(turnId),
    itemId: brandString<SkillCodexItemId>(itemId), kind, name: `native-${kind}`, phase,
    ...phase === 'started' ? {} : { outcome }, ...skillReadPath === undefined ? {} : { skillReadPath },
    ...fact === undefined ? {} : fact.kind === 'patch' ? { patchProcedure: fact } : { procedure: fact } }
}
