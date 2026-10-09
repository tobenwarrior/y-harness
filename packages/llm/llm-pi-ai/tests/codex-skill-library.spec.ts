/** Native skill observations never start a process or claim implicit usage. */
import { describe, expect, it } from 'vitest'
import { CodexBackendRuntime, declineCodexRequest, type CodexPeer } from '../src/codex-backend.ts'
import { createCodexSkillLibraryProvider } from '../src/codex-skill-library.ts'

const projects = [
  { id: 'alpha', title: 'Alpha', path: '/projects/alpha' },
  { id: 'beta', title: 'Beta', path: '/projects/beta' },
]

function fixture(response: unknown, failure?: unknown) {
  let connections = 0
  const requests: Array<{ method: string; params: object }> = []
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>()
  const peer: CodexPeer = {
    async request(method, params) {
      requests.push({ method, params })
      if (method === 'account/read') return { account: { type: 'chatgpt' } }
      if (method === 'model/list') return { data: [] }
      if (method === 'skills/list') {
        if (failure !== undefined) throw failure
        return response
      }
      return {}
    },
    notify() {},
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    close() { for (const listener of listeners) listener('__closed', {}) },
  }
  const runtime = new CodexBackendRuntime({
    connect: async () => { connections++; return peer },
    preferences: { enabled: false, models: [], tiers: {} }, persist: async () => {},
    resolveAccess: () => ({ cwd: '/projects/alpha', sandbox: 'read-only', writableRoots: [],
      approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' }, request: declineCodexRequest }),
  })
  return { runtime, requests, connections: () => connections, peer }
}

const nativeSkills = { data: [
  { cwd: '/projects/alpha', errors: [], skills: [
    { name: 'release', description: 'Alpha release', path: '/projects/alpha/.agents/skills/release/SKILL.md', scope: 'repo', enabled: true, pluginId: null },
    { name: 'shared', description: 'Shared workflow', path: '/native/skills/shared/SKILL.md', scope: 'user', enabled: false, pluginId: null, content: 'Do not expose instruction bodies.' },
    { name: 'vendor', description: 'Vendor workflow', path: '/native/plugin/vendor/SKILL.md', scope: 'system', enabled: true, pluginId: 'official/vendor' },
  ] },
  { cwd: '/projects/beta', errors: [], skills: [
    { name: 'release', description: 'Beta release', path: '/projects/beta/.agents/skills/release/SKILL.md', scope: 'repo', enabled: true, pluginId: null },
    { name: 'shared', description: 'Shared workflow', path: '/native/skills/shared/SKILL.md', scope: 'user', enabled: false, pluginId: null },
  ] },
] }

describe('connected-only native skill inventory', () => {
  it('refreshes through the registered provider without starting a disconnected runtime', async () => {
    const { runtime, requests, connections } = fixture(nativeSkills)
    const provider = createCodexSkillLibraryProvider(() => runtime)
    expect(await provider.list(projects)).toMatchObject({ entries: [], status: { state: 'disconnected' } })
    expect(connections()).toBe(0)
    await runtime.refresh()
    expect((await provider.list(projects)).entries).toHaveLength(4)
    expect(requests.at(-1)).toEqual({ method: 'skills/list', params: { cwds: ['/projects/alpha', '/projects/beta'], forceReload: false } })
    await provider.list(projects, { forceReload: true })
    expect(requests.at(-1)).toEqual({ method: 'skills/list', params: { cwds: ['/projects/alpha', '/projects/beta'], forceReload: true } })
    const pending = createCodexSkillLibraryProvider(() => undefined)
    expect(await pending.list(projects)).toMatchObject({ entries: [], status: { state: 'disconnected' } })
    expect(connections()).toBe(1)
  })

  it('reports disconnected without launching or reading the native peer', async () => {
    const { runtime, requests, connections } = fixture(nativeSkills)
    expect(await runtime.listSkills(projects)).toMatchObject({ entries: [], status: { provider: 'codex-backend', state: 'disconnected' } })
    expect(connections()).toBe(0)
    expect(requests).toEqual([])
  })

  it('uses pinned scoped parameters and keeps disabled and distinct project skills', async () => {
    const { runtime, requests, connections } = fixture(nativeSkills)
    await runtime.refresh()
    const observation = await runtime.listSkills(projects, true)
    expect(observation.status.state).toBe('connected')
    expect(observation.entries).toEqual([
      { name: 'release', description: 'Alpha release', path: '/projects/alpha/.agents/skills/release/SKILL.md', source: 'codex:repo', projectIds: ['alpha'], enabled: true },
      { name: 'shared', description: 'Shared workflow', path: '/native/skills/shared/SKILL.md', source: 'codex:user', projectIds: [], enabled: false },
      { name: 'vendor', description: 'Vendor workflow', path: '/native/plugin/vendor/SKILL.md', source: 'codex:system:official/vendor', projectIds: [], enabled: true },
      { name: 'release', description: 'Beta release', path: '/projects/beta/.agents/skills/release/SKILL.md', source: 'codex:repo', projectIds: ['beta'], enabled: true },
    ])
    expect(requests.at(-1)).toEqual({ method: 'skills/list', params: { cwds: ['/projects/alpha', '/projects/beta'], forceReload: true } })
    expect(connections()).toBe(1)
    expect(JSON.stringify(observation)).not.toContain('instruction bodies')
  })

  it('does not fall back to the native default directory when no projects are registered', async () => {
    const { runtime, requests } = fixture(nativeSkills)
    await runtime.refresh()
    const before = requests.length
    expect(await runtime.listSkills([])).toMatchObject({ entries: [], status: { state: 'connected' } })
    expect(requests).toHaveLength(before)
  })

  it('treats missing requested directory rows as incomplete inventory', async () => {
    const { runtime } = fixture({ data: [] })
    await runtime.refresh()
    expect(await runtime.listSkills(projects)).toMatchObject({ entries: [], status: { state: 'unavailable' } })
  })

  it('rejects inventory from an unrequested directory or relative native skill path', async () => {
    for (const response of [
      { data: [{ cwd: '/other-project', errors: [], skills: [] }] },
      { data: [{ cwd: '/projects/alpha', errors: [], skills: [{ name: 'bad', description: '', path: 'SKILL.md', scope: 'repo', enabled: true, pluginId: null }] }] },
    ]) {
      const { runtime } = fixture(response)
      await runtime.refresh()
      expect(await runtime.listSkills(projects)).toMatchObject({ entries: [], status: { state: 'unavailable' } })
    }
  })

  it('distinguishes unsupported methods from unavailable results without exposing wire diagnostics', async () => {
    for (const [failure, state] of [
      [Object.assign(new Error('sensitive server diagnostic'), { code: -32601 }), 'unsupported'],
      [new Error('sensitive transport diagnostic'), 'unavailable'],
    ] as const) {
      const { runtime } = fixture(nativeSkills, failure)
      await runtime.refresh()
      const observation = await runtime.listSkills(projects)
      expect(observation).toMatchObject({ entries: [], status: { state } })
      expect(JSON.stringify(observation)).not.toContain('sensitive')
    }
    const { runtime } = fixture({ data: [{ cwd: '/projects/alpha', errors: [{ path: '/private', message: 'sensitive parser diagnostic' }], skills: [] }] })
    await runtime.refresh()
    const observation = await runtime.listSkills(projects)
    expect(observation.status.state).toBe('unavailable')
    expect(JSON.stringify(observation)).not.toContain('sensitive')
  })

  it('reports disconnected after the native peer closes', async () => {
    const { runtime, peer, connections } = fixture(nativeSkills)
    await runtime.refresh()
    peer.close()
    expect(await runtime.listSkills(projects)).toMatchObject({ entries: [], status: { state: 'disconnected' } })
    expect(connections()).toBe(1)
  })
})
