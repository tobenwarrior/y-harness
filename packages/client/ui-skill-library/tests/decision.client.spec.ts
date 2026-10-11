/** Separate Decision controls refresh metadata and preview only after an explicit gesture. */
import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
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

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Value>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const makeApi = (patch: Partial<DecisionApi> = {}): DecisionApi => ({
  decisionStatus: async () => ({ ok: true, value: status }), decisionCapabilities: async () => ({ ok: true, value: {} }),
  configureDecision: async request => ({ ok: true, value: { enabled: request.enabled, revision: 3 } }),
  retrieve: async () => ({ ok: true, value: [] }), list: async () => ({ ok: true, value: { items: [], projects: [{ id: 'p', title: 'Project', path: '/project' }], providers: [], bodyBudgetBytes: 1000 } }), ...patch,
})
describe('Decision query and save lifetimes', () => {
  it('does not save before settings are loaded or repeat a write while busy', async () => {
    const saving = deferred<Awaited<ReturnType<DecisionApi['configureDecision']>>>()
    const configureDecision = vi.fn<DecisionApi['configureDecision']>(() => saving.promise)
    const controller = new DecisionController(makeApi({ configureDecision }))
    await controller.save(false); expect(configureDecision).not.toHaveBeenCalled()
    await controller.refresh(); const pending = controller.save(false); await controller.save(true, { provider: 'api', model: 'small' })
    expect(controller.source.getSnapshot().busy).toBe(true)
    expect(configureDecision.mock.calls).toEqual([[{ expectedRevision: 2, enabled: false }]])
    saving.resolve({ ok: true, value: { enabled: false, revision: 3 } }); await pending
    expect(controller.source.getSnapshot()).toMatchObject({ busy: false, notice: 'saved', preview: null })
    controller.dispose(); await controller.save(false); expect(configureDecision).toHaveBeenCalledTimes(1)
  })

  it('retains the displayed configuration after a revision conflict', async () => {
    const controller = new DecisionController(makeApi({ configureDecision: async () => ({ ok: false, error: new RemoteError('gateway/bad-request', 'Revision changed', {}) }) }))
    await controller.refresh(); await controller.save(true, { provider: 'api', model: 'small' })
    expect(controller.source.getSnapshot()).toMatchObject({ status, busy: false, error: true, notice: 'error' })
    controller.face().dismissDecisionNotice(); expect(controller.source.getSnapshot().notice).toBeNull(); controller.dispose()
  })

  it('retains previous settings after metadata failure and ignores stale read failures', async () => {
    const older = deferred<Awaited<ReturnType<DecisionApi['decisionStatus']>>>()
    const decisionStatus = vi.fn<DecisionApi['decisionStatus']>().mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce({ ok: true, value: status }).mockRejectedValueOnce(new Error('Offline'))
    const controller = new DecisionController(makeApi({ decisionStatus }))
    const pending = controller.refresh(); await controller.refresh(); older.reject(new Error('Old failure')); await pending
    expect(controller.source.getSnapshot()).toMatchObject({ phase: 'ready', status, capabilityEpoch: 1, error: false })
    await controller.refresh(); expect(controller.source.getSnapshot()).toMatchObject({ phase: 'error', status, error: true })
    controller.dispose()
  })

  it('ignores stale successful settings and controls while publishing the selected route', async () => {
    const older = deferred<Awaited<ReturnType<DecisionApi['decisionStatus']>>>()
    const controls = deferred<Awaited<ReturnType<DecisionApi['decisionCapabilities']>>>()
    const controller = new DecisionController(makeApi({
      decisionStatus: vi.fn<DecisionApi['decisionStatus']>().mockImplementationOnce(() => older.promise).mockResolvedValue({ ok: true, value: status }),
      decisionCapabilities: vi.fn<DecisionApi['decisionCapabilities']>().mockImplementationOnce(() => controls.promise).mockResolvedValue({ ok: true, value: {} }),
    }))
    const pending = controller.refresh(); await controller.refresh()
    older.resolve({ ok: true, value: { ...status, configuration: { enabled: true, revision: 100 } } })
    await pending
    const oldControls = controller.controls({ provider: 'api', model: 'old' }); await controller.controls({ provider: 'api', model: 'small' })
    controls.resolve({ ok: true, value: {} }); await oldControls
    expect(controller.source.getSnapshot()).toMatchObject({ status, controls: {}, controlsKey: JSON.stringify(['api', 'small']) })
    controller.dispose()
  })

  it('exposes current control failures while ignoring an older refusal', async () => {
    const older = deferred<Awaited<ReturnType<DecisionApi['decisionCapabilities']>>>()
    const controller = new DecisionController(makeApi({ decisionCapabilities: vi.fn<DecisionApi['decisionCapabilities']>().mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce({ ok: true, value: {} }).mockRejectedValueOnce(new Error('Controls unavailable')) }))
    const pending = controller.controls({ provider: 'api', model: 'old' }); await controller.controls({ provider: 'api', model: 'small' })
    older.reject(new Error('Old controls')); await pending
    expect(controller.source.getSnapshot().error).toBe(false)
    await controller.controls({ provider: 'api', model: 'small' }); expect(controller.source.getSnapshot()).toMatchObject({ controls: null, controlsKey: '', error: true })
    controller.dispose(); const snapshot = controller.source.getSnapshot(); await controller.controls({ provider: 'api', model: 'small' })
    expect(controller.source.getSnapshot()).toBe(snapshot)
  })

  it('admits only explicit nonblank project previews and publishes metadata without bodies', async () => {
    const retrieving = deferred<Awaited<ReturnType<DecisionApi['retrieve']>>>()
    const retrieve = vi.fn<DecisionApi['retrieve']>(() => retrieving.promise)
    const controller = new DecisionController(makeApi({ retrieve }))
    await controller.preview('', 'release'); await controller.preview('p', '   '); expect(retrieve).not.toHaveBeenCalled()
    const pending = controller.preview('p', 'release'); await controller.preview('p', 'again')
    expect(retrieve).toHaveBeenCalledTimes(1); expect(controller.source.getSnapshot().busy).toBe(true)
    const row = { id: 'metadata:release' as import('@deepseek-ai/dsh-skill-library/types').SkillLibraryId, name: 'Release', description: 'Metadata', provider: 'fixture', source: 'project', path: '/fixture/SKILL.md', scope: 'project' as const, projectIds: ['p'], ownership: 'protected' as const, status: 'active' as const, shadowed: false, pinned: false, automaticCleanup: false, invocation: { modelInvocable: true, userInvocable: true }, contentHash: 'hash', bodyBytes: 42, usage: { coverage: 'unknown' as const, loadCount: 0 }, references: [], capabilities: { adopt: true, archive: false, restore: false, cleanup: false, native: false } }
    retrieving.resolve({ ok: true, value: [row] }); await pending
    expect(controller.source.getSnapshot()).toMatchObject({ preview: [{ id: row.id, name: 'Release' }], busy: false, error: false })
    controller.dispose(); await controller.preview('p', 'release'); expect(retrieve).toHaveBeenCalledTimes(1)
  })

  it('reports retrieval refusals without overwriting the last successful preview', async () => {
    const controller = new DecisionController(makeApi({ retrieve: vi.fn<DecisionApi['retrieve']>().mockResolvedValueOnce({ ok: true, value: [] }).mockRejectedValueOnce(new Error('Unavailable')) }))
    await controller.preview('p', 'first'); await controller.preview('p', 'second')
    expect(controller.source.getSnapshot()).toMatchObject({ preview: [], error: true, notice: 'error', busy: false }); controller.dispose()
  })

  it.each(['refresh', 'controls', 'save', 'preview'] as const)('suppresses late %s success after disposal', async (operation) => {
    const pending = deferred<undefined>()
    const controller = new DecisionController(makeApi({
      decisionStatus: async () => { if (operation === 'refresh') await pending.promise; return { ok: true, value: status } },
      decisionCapabilities: async () => { await pending.promise; return { ok: true, value: {} } },
      configureDecision: async () => { await pending.promise; return { ok: true, value: { enabled: false, revision: 3 } } },
      retrieve: async () => { await pending.promise; return { ok: true, value: [] } },
    }))
    if (operation !== 'refresh') await controller.refresh()
    const work = operation === 'refresh' ? controller.refresh() : operation === 'controls' ? controller.controls({ provider: 'api', model: 'small' }) : operation === 'save' ? controller.save(false) : controller.preview('p', 'release')
    controller.dispose(); const snapshot = controller.source.getSnapshot(); pending.resolve(undefined); await work
    expect(controller.source.getSnapshot()).toBe(snapshot)
  })

  it.each(['refresh', 'controls', 'save', 'preview'] as const)('suppresses late %s failure after disposal', async (operation) => {
    const pending = deferred<undefined>()
    const controller = new DecisionController(makeApi({
      decisionStatus: async () => { if (operation === 'refresh') await pending.promise; return { ok: true, value: status } },
      decisionCapabilities: async () => { await pending.promise; return { ok: true, value: {} } },
      configureDecision: async () => { await pending.promise; return { ok: true, value: { enabled: false, revision: 3 } } },
      retrieve: async () => { await pending.promise; return { ok: true, value: [] } },
    }))
    if (operation !== 'refresh') await controller.refresh()
    const work = operation === 'refresh' ? controller.refresh() : operation === 'controls' ? controller.controls({ provider: 'api', model: 'small' }) : operation === 'save' ? controller.save(false) : controller.preview('p', 'release')
    controller.dispose(); const snapshot = controller.source.getSnapshot(); pending.reject(new Error('Late failure')); await work
    expect(controller.source.getSnapshot()).toBe(snapshot)
  })

  it('binds the footer callbacks without automatically generating a preview', async () => {
    const retrieve = vi.fn<DecisionApi['retrieve']>(async () => ({ ok: true, value: [] }))
    const decisionStatus = vi.fn<DecisionApi['decisionStatus']>(async () => ({ ok: true, value: status }))
    const controller = new DecisionController(makeApi({ retrieve, decisionStatus })); const face = controller.face()
    face.ensureDecision(); await vi.waitFor(() => { expect(controller.source.getSnapshot().phase).toBe('ready') })
    face.ensureDecision(); expect(decisionStatus).toHaveBeenCalledTimes(1); expect(retrieve).not.toHaveBeenCalled()
    face.refreshDecision(); await vi.waitFor(() => { expect(decisionStatus).toHaveBeenCalledTimes(2) })
    face.loadDecisionControls({ provider: 'api', model: 'small' }); await vi.waitFor(() => { expect(controller.source.getSnapshot().controls).toEqual({}) })
    face.saveDecision(false); await vi.waitFor(() => { expect(controller.source.getSnapshot().notice).toBe('saved') })
    face.dismissDecisionNotice(); expect(controller.source.getSnapshot().notice).toBeNull()
    face.previewDecision('p', 'release'); await vi.waitFor(() => { expect(controller.source.getSnapshot().preview).toEqual([]) }); controller.dispose()
  })
})
