/** Native profile path metadata and writable-root separation, without credential-body reads. */
import * as path from 'node:path'
import { isAbsolute, join, dirname, basename } from 'node:path'
import { realpathSync, lstatSync } from 'node:fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { ClaudeRootProtocolRecord } from './root-types.ts'

/**
 * Compare paths using the selected execution-world separator conventions.
 * @param parent - root whose subtree is protected or writable.
 * @param child - candidate absolute path in the same execution world.
 * @param paths - path operations matching that world's separator and drive rules.
 * @returns whether the candidate is the root itself or a descendant.
 */
export function containsProfilePath(parent: string, child: string, paths: Pick<typeof path, 'relative' | 'isAbsolute'> = path): boolean {
  const relative = paths.relative(parent, child).replaceAll('\\', '/')
  return relative === '' || !paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith('../')
}

function nativeProfilePath(path: string): string {
  if (path.split(/[\\/]/u).some(part => part === '.' || part === '..')) throw new Error('Claude root native profile path must not traverse parent components.')
  const suffix: string[] = []; let cursor = path
  for (;;) {
    try { return join(realpathSync.native(cursor), ...suffix) } catch (_error: unknown) {
      // Only nonexistent suffixes may be resolved from an existing ancestor.
      try { lstatSync(cursor); throw new Error('Claude root native profile path cannot be canonicalized.') }
      catch (error: unknown) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error }
      const parent = dirname(cursor)
      if (parent === cursor) throw new Error('Claude root native profile path cannot be canonicalized.')
      suffix.unshift(basename(cursor)); cursor = parent
    }
  }
}
/**
 * Select the home variable used by the native Node execution world.
 * @param env - actual SDK-composed child environment, without reading authentication files.
 * @param platform - native process execution platform.
 * @returns declared native home, or undefined when that environment cannot identify it.
 */
export function nativeHome(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): string | undefined {
  return platform === 'win32' ? env.USERPROFILE : env.HOME
}

/**
 * Resolve launched profile paths and refuse writable overlap with native account state.
 * @param env - actual SDK-composed child environment.
 * @param policy - complete initiating file-effect policy; full access is unsupported.
 * @param writable - writable roots resolved by the enabled route's sandbox dependency.
 * @returns canonical native home and config directory metadata, without an account claim.
 * @throws for undeclared, unresolved or traversing paths and any writable profile overlap.
 */
export function nativeProfile(
  env: Record<string, string | undefined>, policy: SandboxExecutionPolicy, writable: readonly string[],
): ClaudeRootProtocolRecord['profile'] {
  const home = nativeHome(env); const configured = env.CLAUDE_CONFIG_DIR
  if (home === undefined || !isAbsolute(home) || configured !== undefined && !isAbsolute(configured)
    || policy.mode === 'danger-full-access') throw new Error('Claude root requires an absolute native profile and whole-process confinement.')
  const profile = { home: nativeProfilePath(home), configDirectory: nativeProfilePath(configured ?? join(home, '.claude')) }
  const protectedPaths = [profile.configDirectory, nativeProfilePath(join(home, '.claude')), nativeProfilePath(join(home, '.claude.json'))]
  if (writable.some(root => protectedPaths.some(path => containsProfilePath(root, path) || containsProfilePath(path, root)))) {
    throw new Error('Claude root writable policy overlaps native profile or authentication state.')
  }
  return profile
}
