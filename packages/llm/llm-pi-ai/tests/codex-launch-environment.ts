/**
 * Launch-environment isolation for the pi-ai specs. The adapter mounts the
 * Codex backend connection from `DSH_CODEX_BINARY` in the launch environment,
 * which falls back to `process.env` in a composition the product CLI did not
 * boot. A developer machine that supplies the Codex paths — and a signed-in
 * Codex home — would otherwise publish a `codex-backend` route into specs that
 * compose a dormant adapter, so those specs clear the variables first.
 */
import { vi } from 'vitest'

/** Codex launch variables the adapter and its connection read from the environment. */
const CODEX_LAUNCH_VARIABLES = [
  'DSH_CODEX_BINARY',
  'DSH_CODEX_NODE',
  'DSH_CODEX_HOME',
  'DSH_CODEX_SHELL_HOME',
  'DSH_CODEX_CWD',
] as const

/**
 * Clear every Codex launch variable for the current test.
 * Call from `beforeEach`; `vi.unstubAllEnvs()` in `afterEach` restores them.
 */
export function clearCodexLaunchEnvironment(): void {
  for (const name of CODEX_LAUNCH_VARIABLES) vi.stubEnv(name, '')
}
