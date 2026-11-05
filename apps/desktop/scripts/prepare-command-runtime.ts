/** Stage the native dependencies used by the standalone command manager. */

import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Copy the command manager's dependencies from the prepared, signed runtime.
 * @param modules - Materialized Desktop runtime node_modules directory.
 * @param destination - Directory containing the standalone command manager.
 * @param target - Packaged operating system and architecture.
 */
export function prepareCommandRuntime(
  modules: string,
  destination: string,
  target: { readonly platform: 'darwin' | 'win32'; readonly arch: 'arm64' | 'x64' },
): void {
  const native = target.platform === 'darwin'
    ? `@yharness/node-addon-system-darwin-${target.arch}`
    : `@koromix/koffi-win32-${target.arch}`
  for (const name of ['@yharness/node-addon-system', 'koffi', native]) {
    const output = join(destination, 'node_modules', name)
    mkdirSync(dirname(output), { recursive: true })
    cpSync(join(modules, name), output, { recursive: true, dereference: true })
  }
}
