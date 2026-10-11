/** Shared lexical admission for project-relative native procedure observations. */

/**
 * Admit only bounded source filenames without hidden or secret-like components.
 * @param path - project-relative path after the reader's lexical normalization.
 * @returns whether the path can be retained as a native procedure fact; no filesystem access or permission is granted.
 */
export function isNativeProcedurePath(path: string): boolean {
  return path.length <= 256
    && /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|py|rs|go|yml|yaml|toml)$/.test(path)
    && !path.split('/').some(part => part.startsWith('.') || /secret|credential|password|token|auth/i.test(part))
}
