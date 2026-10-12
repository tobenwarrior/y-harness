/** Separate Decision controls refresh metadata and preview only after an explicit gesture. */
import { describe, expect, it, vi } from 'vitest'
import { DecisionController } from '../src/client/decision-controller.ts'
import type { DecisionApi } from '../src/client/decision-controller.ts'
import type { DecisionCapabilities, DecisionStatus } from '@deepseek-ai/dsh-skill-library/types'

const status: DecisionStatus = { configuration: { enabled: false, revision: 2 }, models: [
  { provider: 'codex', model: '', name: 'Codex gpt-6-luna', available: false, reason: 'native-tools' },
  { provider: 'api', model: 'small', name: 'Small', available: true, reason: 'response-only' },
], maxInputBytes: 16000, maxInputTokens: 16000, maxOutputTokens: 512, timeoutMs: 10000, maxCalls: 1 }
const fixture = () => {
  const configureDecision = vi.fn<DecisionApi['configureDecision']>(async request => ({ ok: true, value: { enabled: request.enabled, ...(request.route === undefined ? {} : { route: request.route }), revision: 3 } }))
  const retrieve = vi.fn<DecisionApi['retrieve']>(async () => ({ ok: true, value: [] }))
  const controller = new DecisionController({ decisionStatus: async () => ({ ok: true, value: status }), decisionCapabilities: async () => ({ ok: true, value: {} }), configureDecision, retrieve, list: async () => ({ ok: true, value: { items: [], projects: [{ id: 'p', title: 'Project', path: '/project' }], providers: [], bodyBudgetBytes: 1000 } }) })
  return { controller, configureDecision, retrieve }
}
describe('Decision controller', () => {
  it('rejects a late controls result from before a capability refresh', async () => {
    let release: (value: DecisionCapabilities) => void = () => { }
    const old = new Promise<DecisionCapabilities>((resolve) => { release = resolve })
    const controller = new DecisionController({
      decisionStatus: async () => ({ ok: true, value: status }),
      decisionCapabilities: async () => ({ ok: true, value: await old }),
      configureDecision: vi.fn<DecisionApi['configureDecision']>(), retrieve: vi.fn<DecisionApi['retrieve']>(), list: async () => ({ ok: true, value: { items: [], projects: [], providers: [], bodyBudgetBytes: 1000 } }),
    })
    try {
      await controller.refresh(); const stale = controller.controls({ provider: 'api', model: 'small' })
      await controller.refresh(); release({}); await stale
      expect(controller.source.getSnapshot().controls).toBeNull()
      expect(controller.source.getSnapshot().controlsKey).toBe('')
    } finally { release({}); controller.dispose() }
  })
  it('reads metadata without advice and uses the observed revision for a separate save', async () => {
    const f = fixture(); await f.controller.refresh(); expect(f.retrieve).not.toHaveBeenCalled()
    await f.controller.save(true, { provider: 'api', model: 'small' })
    expect(f.configureDecision).toHaveBeenCalledWith({ expectedRevision: 2, enabled: true, route: { provider: 'api', model: 'small' } })
    expect(f.controller.source.getSnapshot().status?.configuration.revision).toBe(3); f.controller.dispose()
  })
  it('sends an explicit project-scoped preview and suppresses late state after disposal', async () => {
    const f = fixture(); await f.controller.refresh(); await f.controller.preview('p', 'release')
    expect(f.retrieve).toHaveBeenCalledWith({ projectId: 'p', query: 'release' })
    f.controller.dispose(); const snapshot = f.controller.source.getSnapshot(); await f.controller.refresh()
    expect(f.controller.source.getSnapshot()).toBe(snapshot)
  })
})
