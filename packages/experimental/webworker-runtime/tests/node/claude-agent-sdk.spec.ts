/** Browser workers expose explicit refusals for host-native Claude capabilities. */
import { describe, expect, it, vi } from 'vitest'
import { MODULE_PROXIES } from '../../src/module-proxies.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { createNodeBuiltins } from '../../src/node/builtins.ts'
import { REPLACED_EXTERNAL_PACKAGES } from '../../src/node/external_packages/replaced-externals.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'

const SDK = '@anthropic-ai/claude-agent-sdk'
function sdk(): Record<string, unknown> {
  const vfs = new MemoryVfs()
  vfs.seedDirectory('/dsh')
  const loader = new WorkerModuleLoader({ vfs, root: '/dsh', staticModules: createNodeBuiltins() })
  return loader.createRequire('/dsh/')(SDK) as Record<string, unknown>
}

describe('browser Claude SDK replacement', () => {
  it('resolves the SDK from the worker bundle without including the native package', () => {
    expect(MODULE_PROXIES[SDK]).toBe('./node/external_packages/claude-agent-sdk.ts')
    expect(REPLACED_EXTERNAL_PACKAGES).toContain(SDK)
    const namespace = sdk()
    expect(namespace.__esModule).toBe(true)
    expect(typeof namespace.query).toBe('function')
  })

  it.each(['query', 'listSessions', 'getSessionInfo', 'getSessionMessages', 'resolveSettings'])('refuses %s without claiming host access', (member) => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const value = sdk()[member]
    expect(typeof value).toBe('function')
    const message = `web-preview: ${SDK}.${member} is not available in the worker host`
    expect(() => (value as () => unknown)()).toThrow(message)
    expect(reported).toHaveBeenCalledWith(message)
  })
})
