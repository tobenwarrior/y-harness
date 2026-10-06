/**
 * What the Models page writes for OpenCode Go is a profile naming only its
 * credential reference, so the route must publish the whole installed catalog.
 * A narrowed list here would silently hide Go models the account can reach.
 */
import { describe, expect, it } from 'vitest'
import { PiAiAdapter } from '../src/adapter.ts'
import { catalogModels } from '../src/catalog.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

describe('OpenCode Go catalog exposure', () => {
  it('lists every installed model for a profile that names only its credential', async () => {
    const adapter = new PiAiAdapter({
      // The saved shape: no `models`, so the route inherits the catalog.
      profiles: () => resolveProfiles({ 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } }),
      resolveApiKey: async () => 'mock-go-key',
      auth: memoryAuth(),
    })
    const listed = await adapter.listModels('opencode-go')
    const catalog = [...catalogModels('opencode-go').keys()]
    expect(catalog.length).toBeGreaterThan(1)
    expect(listed.map(model => model.id).sort()).toEqual(catalog.sort())
  })
})
