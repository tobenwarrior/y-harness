import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  SessionBinding, SessionReference, ISessions, SessionListState, SessionSummary,
} from '@yharness/api-session-controller/client'
import type { SessionId } from '@yharness/session/types'
import { RemoteError } from '@yharness/typert-protocol'
import {
  BotId,
  type BotGroupId,
  type BotGroupInspectValue,
  type BotGroupMessageId,
  type BotGroupView,
  type BotTemplateId,
  type BotTemplatePreviewValue,
  type BotTemplateShareCode,
  type BotTemplateView,
  type BotView,
} from '@yharness/bots/client'
import { brandString } from '@yharness/brand'
import type { RemoteResult } from '@yharness/api-remotes/client'
import { BotWorkspaceController, type BotAvatarGenerationRemote, type BotGroupPendingState, type BotGroupPendingStore, type BotWorkspaceRemote } from '../src/client/controller.ts'

afterEach(() => { vi.unstubAllGlobals() })

function bot(id: string, sessionId: string, patch: Partial<BotView> = {}): BotView {
  return {
    id: BotId(id),
    sessionId: sessionId as SessionId,
    name: id,
    identity: 'agent',
    accent: 'violet',
    cwd: '/workspace',
    state: 'active',
    createdAt: 1,
    updatedAt: 1,
    availability: 'idle',
    pinned: false,
    hidden: false,
    ...patch,
  }
}

function reference(sessionId: SessionId, ready: Promise<SessionBinding> = Promise.resolve({} as SessionBinding)): SessionReference {
  const release = vi.fn()
  return {
    sessionId,
    binding: {} as SessionBinding,
    ready,
    release,
    [Symbol.dispose]: release,
  }
}

function sessionList(sessionId: SessionId, known: () => boolean): ISessions['list'] {
  return {
    getSnapshot: (): SessionListState => {
      const available = known()
      const summary: SessionSummary = {
        id: sessionId,
        displayTitle: String(sessionId),
        running: false,
        retainedBy: {},
        blank: true,
        updatedAt: 0,
      }
      const byId: Record<SessionId, SessionSummary> = available ? { [sessionId]: summary } : {}
      return {
        ids: available ? [sessionId] : [],
        byId,
        phase: available ? 'ready' : 'pending',
        projectionsBySession: {},
      }
    },
    subscribe: () => () => {},
  }
}

function sessionsFixture() {
  const retain = vi.fn((sessionId: SessionId) => reference(sessionId))
  const refresh = vi.fn(async () => {})
  const sessions = { retain, refresh } as Pick<ISessions, 'retain' | 'refresh'> as ISessions
  return { retain, refresh, sessions }
}

function pendingStoreFixture(initial: BotGroupPendingState = { creations: {}, messages: {} }): BotGroupPendingStore {
  let state = initial
  return {
    durable: true,
    read: () => state,
    write: (next) => { state = next; return true },
  }
}

function remoteFixture(rows: readonly BotView[]): BotWorkspaceRemote & {
  readonly list: ReturnType<typeof vi.fn>
  readonly create: ReturnType<typeof vi.fn>
  readonly createGroup: ReturnType<typeof vi.fn>
  readonly sendGroupMessage: ReturnType<typeof vi.fn>
} {
  const create = vi.fn<BotWorkspaceRemote['create']>()
  const createGroup = vi.fn<NonNullable<BotWorkspaceRemote['createGroup']>>()
  const sendGroupMessage = vi.fn<NonNullable<BotWorkspaceRemote['sendGroupMessage']>>()
  return {
    list: vi.fn(async () => ({ ok: true as const, value: { bots: rows } })),
    create,
    createGroup,
    sendGroupMessage,
    rename: vi.fn(),
  }
}

function groupView(id: string, name: string, bots: readonly BotView[]): BotGroupView {
  return {
    id: brandString<BotGroupId>(id), name, botIds: bots.map(bot => bot.id), createdAt: 1, updatedAt: 1,
    bots: bots.map(bot => ({
      id: bot.id, name: bot.name, identity: bot.identity, accent: bot.accent,
      availability: bot.availability, state: bot.state,
    })),
  }
}

function templateView(id: string, shareCode: string, patch: Partial<BotTemplateView> = {}): BotTemplateView {
  return {
    id: brandString<BotTemplateId>(id),
    shareCode: brandString<BotTemplateShareCode>(shareCode),
    name: 'Research template',
    description: 'A reusable research partner.',
    identity: 'browse',
    accent: 'teal',
    agentPreset: 'research-preset',
    persona: 'Summarize evidence before recommending action.',
    capabilities: ['chat', 'collaboration'],
    fingerprint: 'a'.repeat(64),
    issuerFingerprint: 'b'.repeat(64),
    createdAt: 1,
    ...patch,
  }
}

const localPermissions = { status: 'resolved' as const, preset: 'research-preset', tools: ['chat', 'read_file'] }

describe('BotWorkspaceController', () => {
  it('exposes avatar uploads without an image generation service', async () => {
    const original = bot('bot-one', 'session-one')
    const remote = remoteFixture([original])
    const uploadAvatar = vi.fn().mockResolvedValue({ ok: true, value: { bot: { ...original, updatedAt: 2 } } })
    const { sessions } = sessionsFixture()
    const controller = new BotWorkspaceController({ ...remote, uploadAvatar }, sessions, () => 'unexpected response')
    await controller.load()

    const upload = controller.face().avatarEditor?.upload
    expect(upload).toBeDefined()
    await upload!(original.id, { data: 'AQID', mediaType: 'image/png' })
    expect(uploadAvatar).toHaveBeenCalledWith({ botId: original.id, data: 'AQID', mediaType: 'image/png' })
    expect(controller.source.getSnapshot().bots[0]?.updatedAt).toBe(2)
  })
  it('renames a bot while keeping its existing session selected', async () => {
    const original = bot('bot-one', 'session-one', { name: 'Original' })
    const updated = { ...original, name: 'Market scout', updatedAt: 2 }
    const remote = remoteFixture([original])
    vi.mocked(remote.rename).mockResolvedValue({ ok: true, value: { bot: updated } })
    const { sessions } = sessionsFixture()
    const controller = new BotWorkspaceController(remote, sessions, () => 'unexpected response')
    await controller.load()
    const selected = controller.face().reference()

    await controller.face().rename(original.id, updated.name)

    expect(remote.rename).toHaveBeenCalledWith({ botId: original.id, name: updated.name })
    expect(controller.source.getSnapshot().bots[0]?.name).toBe(updated.name)
    expect(controller.face().reference()).toBe(selected)
  })

  it('forwards and persists profile fields without changing the selected Session', async () => {
    const original = bot('bot-profile', 'session-profile', {
      name: 'Research partner', description: 'Source scout',
      persona: 'Compare sources first.', capabilities: ['chat', 'research'],
    })
    const updated = {
      ...original,
      description: 'Source scout updated',
      persona: 'Lead with evidence.',
      capabilities: ['chat', 'research', 'release-review'],
      updatedAt: 2,
    }
    const remote = remoteFixture([original])
    const updateProfile = vi.fn(async () => ({ ok: true as const, value: { bot: updated } }))
    remote.updateProfile = updateProfile
    const { sessions } = sessionsFixture()
    const controller = new BotWorkspaceController(remote, sessions, () => 'unexpected response')
    await controller.load()
    const selected = controller.face().reference()

    await controller.face().updateProfile?.(original.id, {
      expectedUpdatedAt: original.updatedAt,
      name: original.name,
      description: updated.description!,
      persona: updated.persona!,
      capabilities: updated.capabilities!,
    })

    expect(updateProfile).toHaveBeenCalledWith({
      botId: original.id,
      expectedUpdatedAt: original.updatedAt,
      name: original.name,
      description: updated.description,
      persona: updated.persona,
      capabilities: updated.capabilities,
    })
    expect(controller.source.getSnapshot().bots[0]).toEqual(updated)
    expect(controller.face().reference()).toBe(selected)
  })

  it('retains all profile fields in an ambiguous create retry', async () => {
    const remote = remoteFixture([])
    remote.create
      .mockRejectedValueOnce(new Error('connection closed after commit'))
      .mockImplementationOnce(async (request: { readonly id: string; readonly description?: string }) => ({
        ok: true,
        value: { bot: bot(request.id, 'session-profile-retry', { description: request.description }) },
      }))
    const { sessions } = sessionsFixture()
    const controller = new BotWorkspaceController(remote, sessions, () => 'unexpected response')
    const creation = {
      name: 'Retry partner', identity: 'agent' as const, accent: 'violet' as const,
      description: 'Keeps trying.', persona: 'Stay concise.', capabilities: ['chat', 'retry'],
    }

    await expect(controller.face().create(creation)).rejects.toThrow('connection closed after commit')
    await controller.face().create({ ...creation, name: 'A different name must not allocate another id' })

    expect(remote.create).toHaveBeenCalledTimes(2)
    expect(remote.create.mock.calls[1]?.[0]).toEqual(remote.create.mock.calls[0]?.[0])
  })

  it('loads and updates connected-app access for the selected Bot without changing its Session', async () => {
    const original = bot('bot-one', 'session-one')
    const remote = remoteFixture([original])
    const listConnectedApps = vi.fn().mockResolvedValue({
      ok: true as const,
      value: { bot: original, apps: [{ id: 'github', name: 'GitHub', allowed: false }] },
    })
    const setConnectedAppAccess = vi.fn().mockResolvedValue({
      ok: true as const,
      value: { bot: { ...original, updatedAt: 2 }, app: { id: 'github', name: 'GitHub', allowed: true } },
    })
    remote.listConnectedApps = listConnectedApps
    remote.setConnectedAppAccess = setConnectedAppAccess
    const { sessions } = sessionsFixture()
    const controller = new BotWorkspaceController(remote, sessions, () => 'unexpected response')
    await controller.load()

    const face = controller.face()
    await expect(face.loadConnectedApps?.(original.id)).resolves.toEqual([{ id: 'github', name: 'GitHub', allowed: false }])
    await face.setConnectedAppAccess?.(original.id, 'github', true)

    expect(listConnectedApps).toHaveBeenCalledWith({ botId: original.id })
    expect(setConnectedAppAccess).toHaveBeenCalledWith({ botId: original.id, appId: 'github', allowed: true })
    expect(controller.face().reference()?.sessionId).toBe(original.sessionId)
    controller.dispose()
  })
  it('switches retained Sessions before publishing the new selection and keeps it across refresh', async () => {
    const first = bot('bot-one', 'session-one')
    const second = bot('bot-two', 'session-two')
    const remote = remoteFixture([first, second])
    const { retain, sessions } = sessionsFixture()
    const controller = new BotWorkspaceController(remote, sessions, () => 'unexpected response')
    const published: Array<SessionReference | undefined> = []
    controller.source.subscribe(() => { published.push(controller.face().reference()) })

    await controller.load()
    const firstReference = controller.face().reference()
    expect(firstReference?.sessionId).toBe(first.sessionId)

    controller.face().select(second.id)
    const secondReference = controller.face().reference()
    expect(secondReference?.sessionId).toBe(second.sessionId)
    expect(secondReference).not.toBe(firstReference)
    expect(published.at(-1)).toBe(secondReference)
    expect(retain).toHaveBeenCalledTimes(2)

    remote.list.mockResolvedValueOnce({
      ok: true,
      value: { bots: [{ ...first, updatedAt: 2 }, { ...second, updatedAt: 2 }] },
    })
    await controller.load()
    expect(controller.face().reference()).toBe(secondReference)
    expect(retain).toHaveBeenCalledTimes(2)
  })

  it('loads, previews, imports, and refreshes safe Bot templates', async () => {
    const source = bot('bot-template-source', 'session-template-source')
    const imported = bot('bot-template-imported', 'session-template-imported')
    const template = templateView('bot-template-1', 'bot-template-code-1')
    const remote = remoteFixture([source])
    remote.listTemplates = vi.fn(async () => ({ ok: true as const, value: { templates: [template] } }))
    remote.previewTemplate = vi.fn(async () => ({ ok: true as const, value: { template, localPermissions, approvalToken: 'preview-token' } }))
    remote.approveTemplate = vi.fn(async () => ({
      ok: true as const, value: { template: { ...template, approved: true }, localPermissions },
    }))
    remote.importTemplate = vi.fn(async () => ({ ok: true as const, value: { bot: imported, template } }))
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')

    await controller.load()

    expect(controller.source.getSnapshot().templates).toMatchObject({
      phase: 'ready', templates: [{ id: 'bot-template-1', shareCode: 'bot-template-code-1', name: 'Research template' }],
    })
    const actions = controller.face().templateActions
    expect(actions).toBeDefined()
    actions?.setTemplateCode(' bot-template-code-1 ')
    await actions?.previewTemplate()
    expect(remote.previewTemplate).toHaveBeenCalledWith({ shareCode: 'bot-template-code-1' })
    expect(controller.source.getSnapshot().templates.preview).toMatchObject({ id: 'bot-template-1', accent: 'teal' })

    await actions?.importTemplate(' Imported research ')
    expect(remote.importTemplate).toHaveBeenCalledWith(expect.objectContaining({
      shareCode: 'bot-template-code-1', name: 'Imported research', importId: expect.stringMatching(/^ui-/),
    }))
    expect(remote.approveTemplate).toHaveBeenCalledWith({
      shareCode: 'bot-template-code-1', fingerprint: template.fingerprint,
      expectedPermissions: localPermissions, approvalToken: 'preview-token',
    })
    expect(controller.source.getSnapshot().templates).toMatchObject({ code: '', preview: null, busy: false })
    controller.dispose()
  })

  it('publishes and revokes templates through the safe request fields', async () => {
    const source = bot('bot-template-publish', 'session-template-publish')
    const template = templateView('bot-template-published', 'bot-template-code-published')
    const remote = remoteFixture([source])
    remote.listTemplates = vi.fn(async () => ({ ok: true as const, value: { templates: [template] } }))
    remote.publishTemplate = vi.fn(async () => ({ ok: true as const, value: { template } }))
    remote.revokeTemplate = vi.fn(async () => ({ ok: true as const, value: { template: { ...template, revokedAt: 2 } } }))
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()

    const actions = controller.face().templateActions
    await actions?.publishTemplate({ botId: String(source.id), name: '  Shared research  ', description: '  Read-only preset  ' })
    expect(remote.publishTemplate).toHaveBeenCalledWith({
      botId: source.id, name: 'Shared research', description: 'Read-only preset',
    })
    await actions?.revokeTemplate(' bot-template-published ')
    expect(remote.revokeTemplate).toHaveBeenCalledWith({ templateId: 'bot-template-published' })
    expect(controller.source.getSnapshot().templates.busy).toBe(false)
    controller.dispose()
  })

  it('retains the pasted code and preview when template import fails', async () => {
    const source = bot('bot-template-failure', 'session-template-failure')
    const template = templateView('bot-template-failure-row', 'bot-template-code-failure')
    const remote = remoteFixture([source])
    remote.listTemplates = vi.fn(async () => ({ ok: true as const, value: { templates: [template] } }))
    remote.previewTemplate = vi.fn(async () => ({ ok: true as const, value: { template, localPermissions, approvalToken: 'preview-token' } }))
    remote.approveTemplate = vi.fn(async () => ({
      ok: true as const, value: { template: { ...template, approved: true }, localPermissions },
    }))
    remote.importTemplate = vi.fn(async () => ({ ok: false as const, error: new RemoteError('gateway/internal', 'template expired', {}) }))
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()
    const actions = controller.face().templateActions
    actions?.setTemplateCode('bot-template-code-failure')
    await actions?.previewTemplate()

    await expect(actions?.importTemplate()).rejects.toThrow('template expired')
    expect(controller.source.getSnapshot().templates).toMatchObject({
      code: 'bot-template-code-failure', preview: { id: 'bot-template-failure-row' }, error: 'template expired', busy: false,
    })
    controller.dispose()
  })

  it('fails closed when the Host cannot approve a signed template', async () => {
    const source = bot('bot-template-no-approval', 'session-template-no-approval')
    const template = templateView('bot-template-no-approval-row', 'bot-template-code-no-approval')
    const remote = remoteFixture([source])
    remote.listTemplates = vi.fn(async () => ({ ok: true as const, value: { templates: [template] } }))
    remote.previewTemplate = vi.fn(async () => ({ ok: true as const, value: { template, localPermissions, approvalToken: 'preview-token' } }))
    remote.importTemplate = vi.fn(async () => ({ ok: true as const, value: { bot: source, template } }))
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()
    const actions = controller.face().templateActions
    actions?.setTemplateCode('bot-template-code-no-approval')
    await actions?.previewTemplate()

    await expect(actions?.importTemplate()).rejects.toThrow('unexpected response')
    expect(remote.importTemplate).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('fails closed when the target preset permissions cannot be resolved', async () => {
    const source = bot('bot-template-no-permissions', 'session-template-no-permissions')
    const template = templateView('bot-template-no-permissions-row', 'bot-template-code-no-permissions')
    const remote = remoteFixture([source])
    remote.listTemplates = vi.fn(async () => ({ ok: true as const, value: { templates: [template] } }))
    remote.previewTemplate = vi.fn(async () => ({
      ok: true as const,
      value: { template, localPermissions: { status: 'unavailable' as const, preset: 'research-preset', tools: [] } },
    }))
    remote.approveTemplate = vi.fn(async () => ({
      ok: true as const, value: { template: { ...template, approved: true }, localPermissions },
    }))
    remote.importTemplate = vi.fn(async () => ({ ok: true as const, value: { bot: source, template } }))
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()
    const actions = controller.face().templateActions
    actions?.setTemplateCode('bot-template-code-no-permissions')
    await actions?.previewTemplate()

    await expect(actions?.importTemplate()).rejects.toThrow('unexpected response')
    expect(remote.approveTemplate).not.toHaveBeenCalled()
    expect(remote.importTemplate).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('ignores a preview response after the pasted code changes', async () => {
    const source = bot('bot-template-stale-preview', 'session-template-stale-preview')
    const template = templateView('bot-template-stale-row', 'bot-template-code-a')
    let resolvePreview: ((result: RemoteResult<BotTemplatePreviewValue>) => void) | undefined
    const previewResult = new Promise<RemoteResult<BotTemplatePreviewValue>>((resolve) => { resolvePreview = resolve })
    const remote = remoteFixture([source])
    remote.listTemplates = vi.fn(async () => ({ ok: true as const, value: { templates: [template] } }))
    remote.previewTemplate = vi.fn(async () => previewResult)
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()
    const actions = controller.face().templateActions
    actions?.setTemplateCode('bot-template-code-a')
    const pending = actions?.previewTemplate()
    actions?.setTemplateCode('bot-template-code-b')
    resolvePreview?.({ ok: true, value: { template, localPermissions, approvalToken: 'preview-token' } })
    await pending

    expect(controller.source.getSnapshot().templates.preview).toBeNull()
    expect(controller.source.getSnapshot().templates.code).toBe('bot-template-code-b')
    controller.dispose()
  })

  it('ignores a stale preview failure after the pasted code changes', async () => {
    const source = bot('bot-template-stale-preview-error', 'session-template-stale-preview-error')
    const template = templateView('bot-template-stale-error-row', 'bot-template-code-error-a')
    let rejectPreview: ((error: Error) => void) | undefined
    const previewResult = new Promise<RemoteResult<BotTemplatePreviewValue>>((_resolve, reject) => { rejectPreview = reject })
    const remote = remoteFixture([source])
    remote.listTemplates = vi.fn(async () => ({ ok: true as const, value: { templates: [template] } }))
    remote.previewTemplate = vi.fn(async () => previewResult)
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()
    const actions = controller.face().templateActions
    actions?.setTemplateCode('bot-template-code-error-a')
    const pending = actions?.previewTemplate()
    actions?.setTemplateCode('bot-template-code-error-b')
    rejectPreview?.(new Error('old preview failed'))
    await pending?.catch(() => {})

    expect(controller.source.getSnapshot().templates).toMatchObject({
      code: 'bot-template-code-error-b', preview: null, error: null, busy: false,
    })
    controller.dispose()
  })

  it('ignores an older preview after the user returns to the same code', async () => {
    const source = bot('bot-template-preview-generation', 'session-template-preview-generation')
    const template = templateView('bot-template-preview-generation-row', 'bot-template-code-a')
    const pending: Array<{
      readonly resolve: (result: RemoteResult<BotTemplatePreviewValue>) => void
      readonly promise: Promise<RemoteResult<BotTemplatePreviewValue>>
    }> = []
    const remote = remoteFixture([source])
    remote.listTemplates = vi.fn(async () => ({ ok: true as const, value: { templates: [template] } }))
    remote.previewTemplate = vi.fn(async () => {
      let resolve: (result: RemoteResult<BotTemplatePreviewValue>) => void = () => {}
      const promise = new Promise<RemoteResult<BotTemplatePreviewValue>>((next) => { resolve = next })
      pending.push({ resolve, promise })
      return promise
    })
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()
    const actions = controller.face().templateActions
    actions?.setTemplateCode('bot-template-code-a')
    const first = actions?.previewTemplate()
    actions?.setTemplateCode('bot-template-code-b')
    actions?.setTemplateCode('bot-template-code-a')
    const second = actions?.previewTemplate()
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    pending[0]?.resolve({ ok: true, value: { template, localPermissions, approvalToken: 'preview-token' } })
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(controller.source.getSnapshot().templates.preview).toBeNull()
    expect(controller.source.getSnapshot().templates.busy).toBe(true)
    pending[1]?.resolve({ ok: true, value: { template, localPermissions, approvalToken: 'preview-token' } })
    await Promise.all([first, second])

    expect(controller.source.getSnapshot().templates.preview?.shareCode).toBe('bot-template-code-a')
    controller.dispose()
  })

  it('retains a newer template draft when a load started earlier completes', async () => {
    const source = bot('bot-template-stale-load', 'session-template-stale-load')
    const template = templateView('bot-template-stale-load-row', 'bot-template-code-stale-load')
    const listTemplates = Promise.withResolvers<RemoteResult<{ readonly templates: readonly BotTemplateView[] }>>()
    const remote = remoteFixture([source])
    remote.listTemplates = vi.fn(async () => listTemplates.promise)
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    const loading = controller.load()
    await vi.waitFor(() => { expect(remote.listTemplates).toHaveBeenCalledOnce() })

    controller.face().templateActions?.setTemplateCode('newer-template-code')
    listTemplates.resolve({ ok: true, value: { templates: [template] } })
    await loading

    expect(controller.source.getSnapshot().templates).toMatchObject({
      code: 'newer-template-code', preview: null, error: null,
    })
    controller.dispose()
  })

  it('retains a newer template draft when a publish refresh completes late', async () => {
    const source = bot('bot-template-stale-refresh', 'session-template-stale-refresh')
    const template = templateView('bot-template-stale-refresh-row', 'bot-template-code-stale-refresh')
    const refreshResult = Promise.withResolvers<RemoteResult<{ readonly templates: readonly BotTemplateView[] }>>()
    let listCalls = 0
    const remote = remoteFixture([source])
    remote.listTemplates = vi.fn(async () => {
      listCalls++
      return listCalls === 1
        ? { ok: true as const, value: { templates: [template] } }
        : refreshResult.promise
    })
    remote.publishTemplate = vi.fn(async () => ({ ok: true as const, value: { template } }))
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()
    const actions = controller.face().templateActions
    actions?.setTemplateCode('draft-before-publish')
    const publishing = actions?.publishTemplate({ botId: String(source.id) })
    await vi.waitFor(() => { expect(remote.listTemplates).toHaveBeenCalledTimes(2) })

    actions?.setTemplateCode('newer-draft')
    refreshResult.resolve({ ok: true, value: { templates: [template] } })
    await publishing

    expect(controller.source.getSnapshot().templates.code).toBe('newer-draft')
    controller.dispose()
  })

  it('requires the current preview before importing the current code', async () => {
    const source = bot('bot-template-current-preview', 'session-template-current-preview')
    const template = templateView('bot-template-current-row', 'bot-template-code-a')
    const remote = remoteFixture([source])
    remote.listTemplates = vi.fn(async () => ({ ok: true as const, value: { templates: [template] } }))
    remote.previewTemplate = vi.fn(async () => ({ ok: true as const, value: { template, localPermissions, approvalToken: 'preview-token' } }))
    remote.approveTemplate = vi.fn(async () => ({
      ok: true as const, value: { template: { ...template, approved: true }, localPermissions },
    }))
    remote.importTemplate = vi.fn(async () => ({ ok: true as const, value: { bot: source, template } }))
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()
    const actions = controller.face().templateActions
    actions?.setTemplateCode('bot-template-code-a')
    await actions?.previewTemplate()
    actions?.setTemplateCode('bot-template-code-b')

    await expect(actions?.importTemplate()).rejects.toThrow('unexpected response')
    expect(remote.approveTemplate).not.toHaveBeenCalled()
    expect(remote.importTemplate).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('does not clear a newer template draft when an older import resolves', async () => {
    const source = bot('bot-template-stale-import', 'session-template-stale-import')
    const template = templateView('bot-template-stale-import-row', 'bot-template-code-stale-import')
    const importResult = Promise.withResolvers<RemoteResult<{ readonly bot: BotView; readonly template: BotTemplateView }>>()
    const remote = remoteFixture([source])
    remote.listTemplates = vi.fn(async () => ({ ok: true as const, value: { templates: [template] } }))
    remote.previewTemplate = vi.fn(async () => ({ ok: true as const, value: { template, localPermissions, approvalToken: 'preview-token' } }))
    remote.approveTemplate = vi.fn(async () => ({
      ok: true as const, value: { template: { ...template, approved: true }, localPermissions },
    }))
    remote.importTemplate = vi.fn(async () => importResult.promise)
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()
    const actions = controller.face().templateActions
    actions?.setTemplateCode('bot-template-code-stale-import')
    await actions?.previewTemplate()
    const importing = actions?.importTemplate('Older draft name')
    await vi.waitFor(() => { expect(remote.importTemplate).toHaveBeenCalledOnce() })

    actions?.setTemplateCode('newer-template-code')
    importResult.resolve({ ok: true, value: { bot: source, template } })
    await importing

    expect(controller.source.getSnapshot().templates.code).toBe('newer-template-code')
    expect(controller.source.getSnapshot().templates.preview).toBeNull()
    controller.dispose()
  })

  it('does not import when approval returns a different artifact fingerprint', async () => {
    const source = bot('bot-template-approval-response', 'session-template-approval-response')
    const template = templateView('bot-template-approval-row', 'bot-template-code-approval')
    const remote = remoteFixture([source])
    remote.listTemplates = vi.fn(async () => ({ ok: true as const, value: { templates: [template] } }))
    remote.previewTemplate = vi.fn(async () => ({ ok: true as const, value: { template, localPermissions, approvalToken: 'preview-token' } }))
    remote.approveTemplate = vi.fn(async () => ({
      ok: true as const,
      value: { template: { ...template, fingerprint: 'c'.repeat(64), approved: true }, localPermissions },
    }))
    remote.importTemplate = vi.fn(async () => ({ ok: true as const, value: { bot: source, template } }))
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()
    const actions = controller.face().templateActions
    actions?.setTemplateCode('bot-template-code-approval')
    await actions?.previewTemplate()

    await expect(actions?.importTemplate()).rejects.toThrow('unexpected response')
    expect(remote.importTemplate).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('does not import when approval returns a different portable avatar', async () => {
    const source = bot('bot-template-avatar-response', 'session-template-avatar-response')
    const template = templateView('bot-template-avatar-row', 'bot-template-code-avatar', {
      avatar: { mediaType: 'image/png', data: 'AQID', bytes: 3, width: 1, height: 1 },
    })
    const remote = remoteFixture([source])
    remote.listTemplates = vi.fn(async () => ({ ok: true as const, value: { templates: [template] } }))
    remote.previewTemplate = vi.fn(async () => ({ ok: true as const, value: { template, localPermissions, approvalToken: 'preview-token' } }))
    remote.approveTemplate = vi.fn(async () => ({
      ok: true as const,
      value: {
        template: { ...template, avatar: { mediaType: 'image/png' as const, data: 'BAUG', bytes: 3, width: 1, height: 1 }, approved: true },
        localPermissions,
      },
    }))
    remote.importTemplate = vi.fn(async () => ({ ok: true as const, value: { bot: source, template } }))
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()
    const actions = controller.face().templateActions
    actions?.setTemplateCode('bot-template-code-avatar')
    await actions?.previewTemplate()

    await expect(actions?.importTemplate()).rejects.toThrow('unexpected response')
    expect(remote.importTemplate).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('keeps older compositions working when templates are not mounted', async () => {
    const source = bot('bot-template-optional', 'session-template-optional')
    const controller = new BotWorkspaceController(remoteFixture([source]), sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()
    expect(controller.face().templateActions).toBeUndefined()
    expect(controller.source.getSnapshot().templates.phase).toBe('idle')
    controller.dispose()
  })

  it('waits for the Session catalog before restoring a persisted Bot', async () => {
    const persisted = bot('bot-persisted', 'bot-session-persisted')
    const remote = remoteFixture([persisted])
    let catalogued = false
    const refresh = vi.fn(async () => { catalogued = true })
    const retain = vi.fn((sessionId: SessionId) => {
      if (!catalogued) throw new Error(`sessions.retain: unknown session ${sessionId}`)
      return reference(sessionId)
    })
    const sessions = { retain, refresh, list: sessionList(persisted.sessionId, () => catalogued) } as Pick<ISessions, 'retain' | 'refresh' | 'list'> as ISessions
    const controller = new BotWorkspaceController(remote, sessions, () => 'unexpected response')

    await controller.load()

    expect(refresh).toHaveBeenCalledOnce()
    expect(controller.face().reference()?.sessionId).toBe(persisted.sessionId)
    expect(controller.source.getSnapshot().error).toBeNull()
  })

  it('retries a Bot whose Session arrives after the initial catalog refresh', async () => {
    const persisted = bot('bot-raced', 'bot-session-raced')
    const remote = remoteFixture([persisted])
    let refreshes = 0
    const refresh = vi.fn(async () => { refreshes++ })
    const retain = vi.fn((sessionId: SessionId) => {
      if (refreshes < 2) throw new Error(`sessions.retain: unknown session ${sessionId}`)
      return reference(sessionId)
    })
    const sessions = { retain, refresh, list: sessionList(persisted.sessionId, () => refreshes >= 2) } as Pick<ISessions, 'retain' | 'refresh' | 'list'> as ISessions
    const controller = new BotWorkspaceController(remote, sessions, () => 'unexpected response')

    await controller.load()

    expect(refresh).toHaveBeenCalledTimes(2)
    expect(retain).toHaveBeenCalledTimes(2)
    expect(controller.face().reference()?.sessionId).toBe(persisted.sessionId)
    expect(controller.source.getSnapshot().error).toBeNull()
  })

  it('does not let a delayed catalog retry replace a newer Bot selection', async () => {
    const first = bot('bot-first', 'bot-session-first')
    const second = bot('bot-second', 'bot-session-second')
    const nextFirst = { ...first, sessionId: 'bot-session-first-new' as SessionId }
    const remote = remoteFixture([first, second])
    let refreshes = 0
    let releaseRetry!: () => void
    let retryStarted!: () => void
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve })
    const retryStartedPromise = new Promise<void>((resolve) => { retryStarted = resolve })
    const refresh = vi.fn(async () => {
      refreshes++
      if (refreshes === 3) {
        retryStarted()
        await retryGate
      }
    })
    const firstReference = reference(first.sessionId)
    const secondReference = reference(second.sessionId)
    const retain = vi.fn((sessionId: SessionId) => {
      if (sessionId !== second.sessionId && refreshes >= 2) {
        throw new Error(`sessions.retain: unknown session ${sessionId}`)
      }
      return sessionId === first.sessionId ? firstReference : secondReference
    })
    const sessions = {
      retain,
      refresh,
      list: sessionList(nextFirst.sessionId, () => false),
    } as Pick<ISessions, 'retain' | 'refresh' | 'list'> as ISessions
    const controller = new BotWorkspaceController(remote, sessions, () => 'unexpected response')

    await controller.load()
    remote.list.mockResolvedValueOnce({ ok: true, value: { bots: [nextFirst, second] } })
    const loading = controller.load()
    await retryStartedPromise

    controller.face().select(second.id)
    expect(controller.face().reference()).toBe(secondReference)
    releaseRetry()
    await loading

    expect(controller.source.getSnapshot().selectedBotId).toBe(second.id)
    expect(controller.face().reference()).toBe(secondReference)
    expect(secondReference.release).not.toHaveBeenCalled()
  })

  it('does not retain a Bot after a delayed catalog retry is disposed', async () => {
    const persisted = bot('bot-disposed', 'bot-session-disposed')
    const nextPersisted = { ...persisted, sessionId: 'bot-session-disposed-new' as SessionId }
    const remote = remoteFixture([persisted])
    let refreshes = 0
    let releaseRetry!: () => void
    let retryStarted!: () => void
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve })
    const retryStartedPromise = new Promise<void>((resolve) => { retryStarted = resolve })
    const refresh = vi.fn(async () => {
      refreshes++
      if (refreshes === 3) {
        retryStarted()
        await retryGate
      }
    })
    const retain = vi.fn((sessionId: SessionId) => {
      if (refreshes >= 2) throw new Error(`sessions.retain: unknown session ${sessionId}`)
      return reference(sessionId)
    })
    const sessions = {
      retain,
      refresh,
      list: sessionList(nextPersisted.sessionId, () => false),
    } as Pick<ISessions, 'retain' | 'refresh' | 'list'> as ISessions
    const controller = new BotWorkspaceController(remote, sessions, () => 'unexpected response')

    await controller.load()
    remote.list.mockResolvedValueOnce({ ok: true, value: { bots: [nextPersisted] } })
    const loading = controller.load()
    await retryStartedPromise
    controller.dispose()
    releaseRetry()
    await loading

    expect(retain).toHaveBeenCalledTimes(2)
    expect(controller.face().reference()).toBeUndefined()
  })

  it('releases a failed Session reference so retry can restore the Bot', async () => {
    const persisted = bot('bot-failed-open', 'bot-session-failed-open')
    const remote = remoteFixture([persisted])
    const failed = reference(persisted.sessionId, Promise.reject(new Error('history unavailable')))
    let attempts = 0
    const retain = vi.fn((sessionId: SessionId) => ++attempts === 1 ? failed : reference(sessionId))
    const sessions = { retain, refresh: vi.fn(async () => {}) } as Pick<ISessions, 'retain' | 'refresh'> as ISessions
    const controller = new BotWorkspaceController(remote, sessions, () => 'unexpected response')

    await controller.load()
    await Promise.resolve()
    await Promise.resolve()
    expect(failed.release).toHaveBeenCalledOnce()
    expect(controller.face().reference()).toBeUndefined()
    expect(controller.source.getSnapshot().error).toBe('history unavailable')

    await controller.load()

    expect(retain).toHaveBeenCalledTimes(2)
    expect(controller.face().reference()?.sessionId).toBe(persisted.sessionId)
    expect(controller.source.getSnapshot().error).toBeNull()
  })

  it('evicts a failed avatar read so a later render can retry it', async () => {
    const persisted = bot('bot-avatar', 'bot-session-avatar', {
      avatar: {
        attachmentId: 'sha256:avatar' as never,
        mediaType: 'image/png',
        bytes: 1,
        width: 1,
        height: 1,
      },
    })
    const remote = remoteFixture([persisted])
    const readAvatar = vi.fn()
      .mockRejectedValueOnce(new Error('attachment unavailable'))
      .mockResolvedValueOnce({
        ok: true,
        value: { avatar: persisted.avatar!, data: 'aW1n' },
      })
    remote.readAvatar = readAvatar
    const { sessions } = sessionsFixture()
    const controller = new BotWorkspaceController(remote, sessions, () => 'unexpected response')

    await expect(controller.face().loadAvatar(persisted.id, persisted.avatar!)).rejects.toThrow('attachment unavailable')
    await expect(controller.face().loadAvatar(persisted.id, persisted.avatar!)).resolves.toBe('data:image/png;base64,aW1n')
    expect(readAvatar).toHaveBeenCalledTimes(2)
  })

  it('saves an existing bot character without changing its session', async () => {
    const original = bot('bot-one', 'session-one')
    const updated = { ...original, identity: 'sparkle' as const, accent: 'amber' as const }
    const remote = remoteFixture([original])
    const updateAppearance = vi.fn(async () => ({ ok: true as const, value: { bot: updated } }))
    remote.updateAppearance = updateAppearance
    remote.updateAvatar = vi.fn()
    const generation: BotAvatarGenerationRemote = {
      status: vi.fn(), generate: vi.fn(), commit: vi.fn(),
    }
    const { sessions } = sessionsFixture()
    const controller = new BotWorkspaceController(remote, sessions, () => 'unexpected response', generation)
    await controller.load()

    const editor = controller.face().avatarEditor
    expect(editor?.updateAppearance).toBeDefined()
    await editor?.updateAppearance?.(original.id, { identity: 'sparkle', accent: 'amber', clearAvatar: true })

    expect(updateAppearance).toHaveBeenCalledWith({
      botId: original.id, identity: 'sparkle', accent: 'amber', clearAvatar: true,
    })
    expect(controller.source.getSnapshot().bots[0]).toEqual(updated)
    expect(controller.face().reference()?.sessionId).toBe(original.sessionId)
  })

  it('exposes the character editor when appearance persistence is available without image generation', async () => {
    const original = bot('bot-appearance-only', 'session-appearance-only')
    const remote = remoteFixture([original])
    remote.updateAppearance = vi.fn()
    const { sessions } = sessionsFixture()
    const controller = new BotWorkspaceController(remote, sessions, () => 'unexpected response')

    await controller.load()

    const editor = controller.face().avatarEditor
    expect(editor).toBeDefined()
    expect(editor?.updateAppearance).toBeDefined()
    expect(editor?.status).toBeUndefined()
    expect(editor?.generate).toBeUndefined()
    expect(editor?.commit).toBeUndefined()
    expect(editor?.update).toBeUndefined()
  })

  it('persists roster placement while keeping the selected Session reference', async () => {
    const original = bot('bot-organize', 'session-organize')
    const updated = { ...original, pinned: true, hidden: true, group: 'Research' }
    const remote = remoteFixture([original])
    const updateOrganization = vi.fn(async () => ({ ok: true as const, value: { bot: updated } }))
    remote.updateOrganization = updateOrganization
    const { sessions } = sessionsFixture()
    const controller = new BotWorkspaceController(remote, sessions, () => 'unexpected response')
    await controller.load()
    const selectedReference = controller.face().reference()

    await controller.face().organize?.(original.id, { pinned: true, hidden: true, group: 'Research' })

    expect(updateOrganization).toHaveBeenCalledWith({
      botId: original.id, pinned: true, hidden: true, group: 'Research',
    })
    expect(controller.source.getSnapshot().bots[0]).toEqual(updated)
    expect(controller.face().reference()).toBe(selectedReference)
  })

  it('does not let an in-flight roster refresh overwrite an organization update', async () => {
    const original = bot('bot-race', 'session-race')
    const updated = { ...original, pinned: true, hidden: true, group: 'Research' }
    const remote = remoteFixture([original])
    const firstList = Promise.withResolvers<Awaited<ReturnType<BotWorkspaceRemote['list']>>>()
    remote.list.mockImplementationOnce(() => firstList.promise)
    remote.list.mockResolvedValue({ ok: true, value: { bots: [updated] } })
    remote.updateOrganization = vi.fn(async () => ({ ok: true as const, value: { bot: updated } }))
    const { sessions } = sessionsFixture()
    const controller = new BotWorkspaceController(remote, sessions, () => 'unexpected response')

    const loading = controller.load()
    await vi.waitFor(() => { expect(remote.list).toHaveBeenCalledOnce() })
    await controller.face().organize?.(original.id, { pinned: true, hidden: true, group: 'Research' })
    firstList.resolve({ ok: true, value: { bots: [original] } })
    await loading
    await vi.waitFor(() => { expect(remote.list).toHaveBeenCalledTimes(2) })

    expect(controller.source.getSnapshot().bots).toEqual([updated])
  })

  it('keeps an ambiguous create retry on one Bot id', async () => {
    const remote = remoteFixture([])
    const firstFailure = new Error('connection closed after commit')
    remote.create
      .mockRejectedValueOnce(firstFailure)
      .mockImplementationOnce(async (request: { readonly id: string }) => ({
        ok: true,
        value: { bot: bot(request.id, 'session-retry') },
      }))
    const { sessions } = sessionsFixture()
    const controller = new BotWorkspaceController(remote, sessions, () => 'unexpected response')

    await expect(controller.face().create({ name: 'Retry me', identity: 'agent', accent: 'violet' }))
      .rejects.toThrow('connection closed after commit')
    await controller.face().create({ name: 'A different name must not allocate another id', identity: 'goal', accent: 'amber' })

    expect(remote.create).toHaveBeenCalledTimes(2)
    const firstRequest = remote.create.mock.calls[0]?.[0]
    const secondRequest = remote.create.mock.calls[1]?.[0]
    expect(firstRequest).toMatchObject({ name: 'Retry me', identity: 'agent', accent: 'violet' })
    expect(secondRequest).toEqual(firstRequest)
  })

  it('treats an active same-id roster row as success after a lost response', async () => {
    const remote = remoteFixture([])
    remote.create.mockImplementationOnce(async (request: { readonly id?: string }) => {
      const committed = bot(request.id ?? 'bot-lost', 'session-lost')
      remote.list.mockResolvedValueOnce({ ok: true, value: { bots: [committed] } })
      throw new Error('connection closed after commit')
    })
    const { sessions } = sessionsFixture()
    const controller = new BotWorkspaceController(remote, sessions, () => 'unexpected response')

    await expect(controller.face().create({ name: 'Recovered bot', identity: 'agent', accent: 'violet' })).resolves.toBeUndefined()

    expect(remote.create).toHaveBeenCalledOnce()
    expect(controller.face().reference()?.sessionId).toBe('session-lost')
    expect(controller.source.getSnapshot().error).toBeNull()
  })
  it('switches from a direct Bot Session to a persistent shared group transcript', async () => {
    const first = bot('bot-first-group', 'session-first-group')
    const second = bot('bot-second-group', 'session-second-group')
    const group = groupView('bot-group-release', 'Release room', [first, second])
    const detail: BotGroupInspectValue = {
      group,

      messages: [{ id: brandString<BotGroupMessageId>('bot-group-message-1'), groupId: group.id, sender: { kind: 'user' }, text: 'Plan it.', createdAt: 1 }],
      deliveries: [{ messageId: brandString<BotGroupMessageId>('bot-group-message-1'), botId: second.id, status: 'failed', error: 'Provider credentials are missing.' }],

    }
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: detail }))
    remote.sendGroupMessage = vi.fn(async () => ({ ok: true as const, value: { messageId: brandString<BotGroupMessageId>('bot-group-message-1'), status: 'accepted' as const, deliveries: [] } }))
    const { retain, sessions } = sessionsFixture()
    const controller = new BotWorkspaceController(remote, sessions, () => 'unexpected response', undefined, undefined, pendingStoreFixture())

    await controller.load()
    const directReference = controller.face().reference()
    controller.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(controller.source.getSnapshot().selectedGroup?.name).toBe('Release room') })

    expect(controller.source.getSnapshot().selectedBotId).toBeNull()
    expect(controller.source.getSnapshot().selectedGroup?.deliveries).toEqual([{
      messageId: 'bot-group-message-1', botId: 'bot-second-group', status: 'failed', error: 'Provider credentials are missing.',
    }])
    expect(controller.face().reference()).toBeUndefined()
    expect(directReference?.release).toHaveBeenCalledOnce()
    expect(remote.inspectGroup).toHaveBeenCalledWith({ groupId: group.id })

    await controller.face().sendGroupMessage('Add owners.')
    expect(remote.sendGroupMessage).toHaveBeenCalledWith(expect.objectContaining({ groupId: group.id, text: 'Add owners.' }))
    expect(remote.sendGroupMessage.mock.calls[0]?.[0].messageId).toMatch(/^bot-group-message-/)
    expect(retain).toHaveBeenCalledOnce()
  })

  it('keeps a newer Bot selection when group creation completes later', async () => {
    const first = bot('bot-create-selection-first', 'session-create-selection-first')
    const second = bot('bot-create-selection-second', 'session-create-selection-second')
    const group = groupView('bot-group-create-selection', 'Create selection room', [first, second])
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [] } }))
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group, messages: [] } }))
    const create = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['createGroup']>>>>()
    remote.createGroup = vi.fn(() => create.promise)
    const controller = new BotWorkspaceController(
      remote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined, pendingStoreFixture(),
    )
    await controller.load()

    const creating = controller.face().createGroup({ name: group.name, botIds: [first.id, second.id].map(String) })
    await vi.waitFor(() => { expect(remote.createGroup).toHaveBeenCalledOnce() })
    controller.face().select(String(second.id))
    expect(controller.source.getSnapshot().selectedBotId).toBe(second.id)

    create.resolve({ ok: true, value: { group } })
    await creating

    expect(controller.source.getSnapshot().selectedBotId).toBe(second.id)
    expect(controller.source.getSnapshot().selectedGroupId).toBeNull()
    expect(controller.source.getSnapshot().groups).toEqual([expect.objectContaining({ id: group.id })])
    controller.dispose()
  })

  it('does not publish a stale group-creation error after navigating to another Bot', async () => {
    const first = bot('bot-create-error-first', 'session-create-error-first')
    const second = bot('bot-create-error-second', 'session-create-error-second')
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [] } }))
    const create = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['createGroup']>>>>()
    remote.createGroup = vi.fn(() => create.promise)
    const controller = new BotWorkspaceController(
      remote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined, pendingStoreFixture(),
    )
    await controller.load()

    const creating = controller.face().createGroup({ name: 'Stale error room', botIds: [first.id, second.id].map(String) })
    await vi.waitFor(() => { expect(remote.createGroup).toHaveBeenCalledOnce() })
    controller.face().select(String(second.id))
    create.reject(new Error('late create failure'))
    await expect(creating).rejects.toThrow('late create failure')

    expect(controller.source.getSnapshot().selectedBotId).toBe(second.id)
    expect(controller.source.getSnapshot().groupError).toBeNull()
    expect(controller.source.getSnapshot().groupPhase).toBe('idle')
    controller.dispose()
  })

  it('marks group actions unavailable when the complete group Remote surface is absent', () => {
    const original = bot('bot-without-groups', 'session-without-groups')
    const controller = new BotWorkspaceController(remoteFixture([original]), sessionsFixture().sessions, () => 'unexpected response')

    expect(controller.face().groupsAvailable).toBe(false)
    controller.dispose()
  })

  it('preserves a group selected while the session catalog is refreshing', async () => {
    const first = bot('bot-selection-a', 'session-selection-a')
    const second = bot('bot-selection-b', 'session-selection-b')
    const group = groupView('bot-group-selection', 'Selection room', [first, second])
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group, messages: [] } }))
    const { sessions, refresh } = sessionsFixture()
    const controller = new BotWorkspaceController(remote, sessions, () => 'unexpected response')
    await controller.load()
    const gate = Promise.withResolvers<undefined>()
    refresh.mockImplementationOnce(() => gate.promise)

    const loading = controller.load()
    await vi.waitFor(() => { expect(refresh).toHaveBeenCalledTimes(2) })
    controller.face().selectGroup(String(group.id))
    gate.resolve(undefined)
    await loading

    expect(controller.source.getSnapshot().selectedGroupId).toBe(group.id)
    expect(controller.face().reference()).toBeUndefined()
  })

  it('reuses a pending group id when members are reordered after a lost response', async () => {
    const first = bot('bot-order-a', 'session-order-a')
    const second = bot('bot-order-b', 'session-order-b')
    const group = groupView('bot-group-order', 'Order room', [first, second])
    const remote = remoteFixture([first, second])
    remote.createGroup.mockReset()
      .mockRejectedValueOnce(new Error('connection closed after commit'))
      .mockResolvedValueOnce({ ok: true as const, value: { group } })
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [] } }))
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group, messages: [] } }))
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined, pendingStoreFixture())

    await expect(controller.face().createGroup({ name: 'Order room', botIds: [first.id, second.id].map(String) })).rejects.toThrow()
    await controller.face().createGroup({ name: 'Order room', botIds: [second.id, first.id].map(String) })
    expect(remote.createGroup.mock.calls[1]?.[0].id).toBe(remote.createGroup.mock.calls[0]?.[0].id)
  })

  it('recovers an already-created group when members are reordered after a lost response', async () => {
    const first = bot('bot-committed-order-a', 'session-committed-order-a')
    const second = bot('bot-committed-order-b', 'session-committed-order-b')
    const remote = remoteFixture([first, second])
    let committed: BotGroupView | undefined
    remote.createGroup = vi.fn(async (request: Parameters<NonNullable<BotWorkspaceRemote['createGroup']>>[0]) => {
      committed = groupView(String(request.id), 'Committed room', [first, second])
      throw new Error('connection closed after commit')
    })
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: committed === undefined ? [] : [committed] } }))
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group: committed!, messages: [] } }))
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined, pendingStoreFixture())

    await expect(controller.face().createGroup({ name: 'Committed room', botIds: [first.id, second.id].map(String) })).rejects.toThrow()
    await controller.face().createGroup({ name: 'Committed room', botIds: [second.id, first.id].map(String) })
    expect(remote.createGroup).toHaveBeenCalledOnce()
    expect(controller.source.getSnapshot().selectedGroupId).toBe(committed?.id)
  })

  it('reuses one remote group id after a lost create response', async () => {
    const first = bot('bot-first-create-retry', 'session-first-create-retry')
    const second = bot('bot-second-create-retry', 'session-second-create-retry')
    const group = groupView('bot-group-create-retry', 'Retry room', [first, second])
    const remote = remoteFixture([first, second])
    remote.createGroup.mockReset()
      .mockRejectedValueOnce(new Error('connection closed after commit'))
      .mockResolvedValueOnce({ ok: true as const, value: { group } })
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [] } }))
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group, messages: [] } }))
    const controller = new BotWorkspaceController(
      remote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined, pendingStoreFixture(),
    )

    await expect(controller.face().createGroup({ name: 'Retry room', botIds: [first.id, second.id].map(String) }))
      .rejects.toThrow('connection closed after commit')
    await expect(controller.face().createGroup({ name: 'Retry room', botIds: [first.id, second.id].map(String) }))
      .resolves.toBeUndefined()
    expect(remote.createGroup).toHaveBeenCalledTimes(2)
    expect(remote.createGroup.mock.calls[1]?.[0].id).toBe(remote.createGroup.mock.calls[0]?.[0].id)
  })

  it('restores a pending group id after the workspace controller is recreated', async () => {
    const first = bot('bot-first-create-restart', 'session-first-create-restart')
    const second = bot('bot-second-create-restart', 'session-second-create-restart')
    const group = groupView('bot-group-create-restart', 'Restart room', [first, second])
    const remote = remoteFixture([first, second])
    remote.createGroup = vi.fn()
      .mockRejectedValueOnce(new Error('connection closed after commit'))
      .mockResolvedValueOnce({ ok: true as const, value: { group } })
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [] } }))
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group, messages: [] } }))
    const pendingStore = pendingStoreFixture()
    const firstController = new BotWorkspaceController(
      remote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined, pendingStore,
    )
    await expect(firstController.face().createGroup({ name: 'Restart room', botIds: [first.id, second.id].map(String) }))
      .rejects.toThrow('connection closed after commit')
    firstController.dispose()

    const secondController = new BotWorkspaceController(
      remote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined, pendingStore,
    )
    await expect(secondController.face().createGroup({ name: 'Restart room', botIds: [first.id, second.id].map(String) }))
      .resolves.toBeUndefined()
    expect(remote.createGroup).toHaveBeenCalledTimes(2)
    expect(remote.createGroup.mock.calls[1]?.[0].id).toBe(remote.createGroup.mock.calls[0]?.[0].id)
    secondController.dispose()
  })

  it('uses the default localStorage store to recover a group operation after restart', async () => {
    const backing = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => { backing.set(key, value) },
      removeItem: (key: string) => { backing.delete(key) },
    })
    const first = bot('bot-first-create-storage', 'session-first-create-storage')
    const second = bot('bot-second-create-storage', 'session-second-create-storage')
    const group = groupView('bot-group-create-storage', 'Storage room', [first, second])
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [] } }))
    remote.createGroup = vi.fn()
      .mockRejectedValueOnce(new Error('connection closed after commit'))
      .mockResolvedValueOnce({ ok: true as const, value: { group } })
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group, messages: [] } }))

    const firstController = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await expect(firstController.face().createGroup({ name: 'Storage room', botIds: [first.id, second.id].map(String) }))
      .rejects.toThrow('connection closed after commit')
    firstController.dispose()
    expect(backing.has('yharness.client-ui-bots.pending-group-operations')).toBe(true)

    const secondController = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await expect(secondController.face().createGroup({ name: 'Storage room', botIds: [first.id, second.id].map(String) }))
      .resolves.toBeUndefined()
    expect(remote.createGroup.mock.calls[1]?.[0].id).toBe(remote.createGroup.mock.calls[0]?.[0].id)
    secondController.dispose()
  })

  it('uses the default localStorage store to recover a group message after restart', async () => {
    const backing = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => { backing.set(key, value) },
      removeItem: (key: string) => { backing.delete(key) },
    })
    const first = bot('bot-first-message-storage', 'session-first-message-storage')
    const second = bot('bot-second-message-storage', 'session-second-message-storage')
    const group = groupView('bot-group-message-storage', 'Storage message room', [first, second])
    const detail: BotGroupInspectValue = { group, messages: [] }
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: detail }))
    remote.sendGroupMessage = vi.fn()
      .mockRejectedValueOnce(new Error('connection closed after commit'))
      .mockResolvedValueOnce({ ok: true as const, value: { messageId: brandString<BotGroupMessageId>('bot-group-message-storage'), status: 'accepted' as const, deliveries: [] } })

    const firstController = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await firstController.load()
    firstController.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(firstController.source.getSnapshot().selectedGroup).not.toBeNull() })
    await expect(firstController.face().sendGroupMessage('Storage message.')).rejects.toThrow('connection closed after commit')
    firstController.dispose()
    expect(backing.has('yharness.client-ui-bots.pending-group-operations')).toBe(true)

    const secondController = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await secondController.load()
    secondController.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(secondController.source.getSnapshot().selectedGroup).not.toBeNull() })
    await expect(secondController.face().sendGroupMessage('Storage message.')).resolves.toBeUndefined()
    expect(remote.sendGroupMessage.mock.calls[1]?.[0].messageId).toBe(remote.sendGroupMessage.mock.calls[0]?.[0].messageId)
    secondController.dispose()
  })

  it('does not reuse historical group metadata for intentional repeats and accepts explicit ids', async () => {
    const first = bot('bot-first-repeat', 'session-first-repeat')
    const second = bot('bot-second-repeat', 'session-second-repeat')
    const remote = remoteFixture([first, second])
    remote.createGroup = vi.fn(async (request) => {
      const created = groupView(String(request.id), request.name, [first, second])
      return { ok: true as const, value: { group: created } }
    })
    remote.inspectGroup = vi.fn(async (request) => {
      const group = groupView(String(request.groupId), 'Repeat room', [first, second])
      return { ok: true as const, value: { group, messages: [] } }
    })
    const controller = new BotWorkspaceController(
      remote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined, pendingStoreFixture(),
    )

    await controller.face().createGroup({ name: 'Repeat room', botIds: [first.id, second.id].map(String) })
    await controller.face().createGroup({ name: 'Repeat room', botIds: [first.id, second.id].map(String) })
    await controller.face().createGroup({ name: 'Repeat room', botIds: [first.id, second.id].map(String), groupId: 'bot-group-explicit-repeat' })
    await controller.face().createGroup({ name: 'Repeat room', botIds: [first.id, second.id].map(String), groupId: 'bot-group-explicit-repeat' })

    expect(remote.createGroup).toHaveBeenCalledTimes(4)
    expect(remote.createGroup.mock.calls[0]?.[0].id).not.toBe(remote.createGroup.mock.calls[1]?.[0].id)
    expect(remote.createGroup.mock.calls[2]?.[0].id).toBe('bot-group-explicit-repeat')
    expect(remote.createGroup.mock.calls[3]?.[0].id).toBe('bot-group-explicit-repeat')
    controller.dispose()
  })

  it('does not reuse historical group text for intentional repeats and accepts explicit message ids', async () => {
    const first = bot('bot-first-message-repeat', 'session-first-message-repeat')
    const second = bot('bot-second-message-repeat', 'session-second-message-repeat')
    const group = groupView('bot-group-message-repeat', 'Message repeat room', [first, second])
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group, messages: [] } }))
    remote.sendGroupMessage = vi.fn(async request => ({
      ok: true as const,
      value: { messageId: request.messageId!, status: 'accepted' as const, deliveries: [] },
    }))
    const controller = new BotWorkspaceController(
      remote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined, pendingStoreFixture(),
    )
    await controller.load()
    controller.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(controller.source.getSnapshot().selectedGroup).not.toBeNull() })

    await controller.face().sendGroupMessage('Repeat this.')
    await controller.face().sendGroupMessage('Repeat this.')
    await controller.face().sendGroupMessage('Repeat this.', 'bot-group-message-explicit-repeat')
    await controller.face().sendGroupMessage('Repeat this.', 'bot-group-message-explicit-repeat')

    expect(remote.sendGroupMessage).toHaveBeenCalledTimes(4)
    expect(remote.sendGroupMessage.mock.calls[0]?.[0].messageId).not.toBe(remote.sendGroupMessage.mock.calls[1]?.[0].messageId)
    expect(remote.sendGroupMessage.mock.calls[2]?.[0].messageId).toBe('bot-group-message-explicit-repeat')
    expect(remote.sendGroupMessage.mock.calls[3]?.[0].messageId).toBe('bot-group-message-explicit-repeat')
    controller.dispose()
  })

  it('persists an edited group roster through the Remote and refreshes the selected group', async () => {
    const first = bot('bot-first-update', 'session-first-update')
    const second = bot('bot-second-update', 'session-second-update')
    const third = bot('bot-third-update', 'session-third-update')
    const group = groupView('bot-group-update', 'Original room', [first, second])
    let currentGroup = group
    const remote = remoteFixture([first, second, third])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [currentGroup] } }))
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group: currentGroup, messages: [] } }))
    remote.updateGroup = vi.fn(async (request) => {
      currentGroup = groupView(String(request.groupId), request.name, [first, third])
      return { ok: true as const, value: { group: currentGroup } }
    })
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()
    controller.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(controller.source.getSnapshot().selectedGroup).not.toBeNull() })

    await controller.face().updateGroup({
      groupId: String(group.id), name: 'Updated room', botIds: [String(first.id), String(third.id)],
    })

    expect(remote.updateGroup).toHaveBeenCalledWith({
      groupId: group.id, name: 'Updated room', botIds: [first.id, third.id],
    })
    expect(controller.source.getSnapshot().selectedGroup).toMatchObject({
      id: String(group.id), name: 'Updated room', bots: [{ id: first.id }, { id: third.id }],
    })
    controller.dispose()
  })

  it('fails closed instead of allocating a group id when reconciliation is unavailable', async () => {
    const first = bot('bot-first-create-fail-closed', 'session-first-create-fail-closed')
    const second = bot('bot-second-create-fail-closed', 'session-second-create-fail-closed')
    const remote = remoteFixture([first, second])
    remote.createGroup = vi.fn().mockRejectedValueOnce(new Error('connection closed after commit'))
    const controller = new BotWorkspaceController(
      remote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined, pendingStoreFixture(),
    )

    await expect(controller.face().createGroup({ name: 'Fail closed', botIds: [first.id, second.id].map(String) }))
      .rejects.toThrow('connection closed after commit')
    await expect(controller.face().createGroup({ name: 'Fail closed', botIds: [first.id, second.id].map(String) }))
      .rejects.toThrow('group catalog is unavailable')
    expect(remote.createGroup).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('fails closed before a new group operation when persistence is unavailable', async () => {
    const first = bot('bot-first-create-no-store', 'session-first-create-no-store')
    const second = bot('bot-second-create-no-store', 'session-second-create-no-store')
    const remote = remoteFixture([first, second])
    remote.createGroup.mockReset()
    const controller = new BotWorkspaceController(
      remote,
      sessionsFixture().sessions,
      () => 'unexpected response',
      undefined,
      undefined,
      { durable: false, read: () => ({ creations: {}, messages: {} }), write: () => false },
      key => `localized:${key}`,
    )

    await expect(controller.face().createGroup({ name: 'No store', botIds: [first.id, second.id].map(String) }))
      .rejects.toThrow('localized:groupRetryUnavailable')
    expect(remote.createGroup).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('uses localized copy when a new group retry cannot be saved', async () => {
    const first = bot('bot-first-save-failed', 'session-first-save-failed')
    const second = bot('bot-second-save-failed', 'session-second-save-failed')
    const remote = remoteFixture([first, second])
    const controller = new BotWorkspaceController(
      remote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined,
      { durable: true, read: () => ({ creations: {}, messages: {} }), write: () => false },
      key => `localized:${key}`,
    )

    await expect(controller.face().createGroup({ name: 'No save', botIds: [first.id, second.id].map(String) }))
      .rejects.toThrow('localized:groupCreateRetryUnavailable')
    expect(remote.createGroup).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('fails closed when persisted retry state is corrupted', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => '{"creations":null,"messages":{}}',
      setItem: () => {},
      removeItem: () => {},
    })
    const first = bot('bot-first-create-corrupt-store', 'session-first-create-corrupt-store')
    const second = bot('bot-second-create-corrupt-store', 'session-second-create-corrupt-store')
    const remote = remoteFixture([first, second])
    remote.createGroup.mockReset()
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')

    await expect(controller.face().createGroup({ name: 'Corrupt store', botIds: [first.id, second.id].map(String) }))
      .rejects.toThrow('unexpected response')
    expect(remote.createGroup).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('reuses one remote group message id after a lost send response', async () => {
    const first = bot('bot-first-retry', 'session-first-retry')
    const second = bot('bot-second-retry', 'session-second-retry')
    const group = groupView('bot-group-retry', 'Retry room', [first, second])
    const detail: BotGroupInspectValue = { group, messages: [] }
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: detail }))
    remote.sendGroupMessage = vi.fn().mockRejectedValueOnce(new Error('connection closed after commit'))
      .mockResolvedValueOnce({ ok: true as const, value: { messageId: brandString<BotGroupMessageId>('bot-group-message-retry'), status: 'accepted' as const, deliveries: [] } })
    const controller = new BotWorkspaceController(
      remote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined, pendingStoreFixture(),
    )
    await controller.load()
    controller.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(controller.source.getSnapshot().selectedGroup).not.toBeNull() })

    await expect(controller.face().sendGroupMessage('Retry this.')).rejects.toThrow('connection closed after commit')
    await expect(controller.face().sendGroupMessage('Retry this.')).resolves.toBeUndefined()
    expect(remote.sendGroupMessage).toHaveBeenCalledTimes(2)
    expect(remote.sendGroupMessage.mock.calls[1]?.[0].messageId).toBe(remote.sendGroupMessage.mock.calls[0]?.[0].messageId)
  })

  it('restores a pending group message id after the workspace controller is recreated', async () => {
    const first = bot('bot-first-send-restart', 'session-first-send-restart')
    const second = bot('bot-second-send-restart', 'session-second-send-restart')
    const group = groupView('bot-group-send-restart', 'Restart send room', [first, second])
    const detail: BotGroupInspectValue = { group, messages: [] }
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: detail }))
    remote.sendGroupMessage = vi.fn().mockRejectedValueOnce(new Error('connection closed after commit'))
      .mockResolvedValueOnce({ ok: true as const, value: { messageId: brandString<BotGroupMessageId>('bot-group-message-restart'), status: 'accepted' as const, deliveries: [] } })
    const pendingStore = pendingStoreFixture()
    const firstController = new BotWorkspaceController(
      remote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined, pendingStore,
    )
    await firstController.load()
    firstController.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(firstController.source.getSnapshot().selectedGroup).not.toBeNull() })
    await expect(firstController.face().sendGroupMessage('Restart this.')).rejects.toThrow('connection closed after commit')
    firstController.dispose()

    const secondController = new BotWorkspaceController(
      remote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined, pendingStore,
    )
    await secondController.load()
    secondController.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(secondController.source.getSnapshot().selectedGroup).not.toBeNull() })
    await expect(secondController.face().sendGroupMessage('Restart this.')).resolves.toBeUndefined()
    expect(remote.sendGroupMessage).toHaveBeenCalledTimes(2)
    expect(remote.sendGroupMessage.mock.calls[1]?.[0].messageId).toBe(remote.sendGroupMessage.mock.calls[0]?.[0].messageId)
    secondController.dispose()
  })

  it('fails closed instead of fanning out a new message when reconciliation is unavailable', async () => {
    const first = bot('bot-first-send-fail-closed', 'session-first-send-fail-closed')
    const second = bot('bot-second-send-fail-closed', 'session-second-send-fail-closed')
    const group = groupView('bot-group-send-fail-closed', 'Fail closed room', [first, second])
    const detail: BotGroupInspectValue = { group, messages: [] }
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: detail }))
    remote.sendGroupMessage = vi.fn().mockRejectedValueOnce(new Error('connection closed after commit'))
    const controller = new BotWorkspaceController(
      remote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined, pendingStoreFixture(),
    )
    await controller.load()
    controller.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(controller.source.getSnapshot().selectedGroup).not.toBeNull() })

    await expect(controller.face().sendGroupMessage('Fail closed.')).rejects.toThrow('connection closed after commit')
    delete remote.inspectGroup
    await expect(controller.face().sendGroupMessage('Fail closed.')).rejects.toThrow('group transcript is unavailable')
    expect(remote.sendGroupMessage).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('keeps a group transcript visible when delivery is partial and exposes a retryable error', async () => {
    const first = bot('bot-first-partial', 'session-first-partial')
    const second = bot('bot-second-partial', 'session-second-partial')
    const group = groupView('bot-group-partial', 'Partial room', [first, second])
    const detail: BotGroupInspectValue = { group, messages: [] }
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: detail }))
    remote.sendGroupMessage = vi.fn(async () => ({ ok: true as const, value: {
      messageId: brandString<BotGroupMessageId>('bot-group-message-partial'), status: 'partial' as const,
      deliveries: [{ botId: first.id, status: 'accepted' as const }, { botId: second.id, status: 'failed' as const, error: 'offline' }],
    } }))
    const controller = new BotWorkspaceController(
      remote, sessionsFixture().sessions, () => 'unexpected response', undefined,
      () => 'Some Bots could not receive this message.', pendingStoreFixture(),
    )
    await controller.load()
    controller.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(controller.source.getSnapshot().selectedGroup).not.toBeNull() })

    await expect(controller.face().sendGroupMessage('Try everyone.')).rejects.toThrow('Some Bots could not receive this message.')
    await expect(controller.face().sendGroupMessage('Try everyone.')).rejects.toThrow('Some Bots could not receive this message.')
    expect(controller.source.getSnapshot().selectedGroup?.id).toBe(String(group.id))
    expect(controller.source.getSnapshot().groupError).toBe('Some Bots could not receive this message.')
    expect(remote.sendGroupMessage).toHaveBeenCalledTimes(2)
    expect(remote.sendGroupMessage.mock.calls[1]?.[0].messageId).toBe(remote.sendGroupMessage.mock.calls[0]?.[0].messageId)
  })

  it('refreshes per-Bot delivery status after a partial group send while retaining its retry id', async () => {
    const first = bot('bot-first-partial-status', 'session-first-partial-status')
    const second = bot('bot-second-partial-status', 'session-second-partial-status')
    const group = groupView('bot-group-partial-status', 'Partial status room', [first, second])
    const initial: BotGroupInspectValue = { group, messages: [] }
    const committed: BotGroupInspectValue = {
      group,
      messages: [{
        id: brandString<BotGroupMessageId>('bot-group-message-partial-status'),
        groupId: group.id,
        sender: { kind: 'user' },
        text: 'Show the outcomes.',
        createdAt: 1,
      }],
      deliveries: [
        { messageId: brandString<BotGroupMessageId>('bot-group-message-partial-status'), botId: first.id, status: 'accepted' },
        { messageId: brandString<BotGroupMessageId>('bot-group-message-partial-status'), botId: second.id, status: 'failed', error: 'offline' },
      ],
    }
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    const inspectGroup = vi.fn(async () => inspectGroup.mock.calls.length === 1
      ? { ok: true as const, value: initial }
      : { ok: true as const, value: committed })
    remote.inspectGroup = inspectGroup
    remote.sendGroupMessage = vi.fn(async request => ({ ok: true as const, value: {
      messageId: request.messageId!, status: 'partial' as const,
      deliveries: [{ botId: first.id, status: 'accepted' as const }, { botId: second.id, status: 'failed' as const, error: 'offline' }],
    } }))
    const controller = new BotWorkspaceController(
      remote, sessionsFixture().sessions, () => 'unexpected response', undefined,
      () => 'Some Bots could not receive this message.', pendingStoreFixture(),
    )
    await controller.load()
    controller.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(controller.source.getSnapshot().selectedGroup).not.toBeNull() })

    await expect(controller.face().sendGroupMessage('Show the outcomes.')).rejects.toThrow('Some Bots could not receive this message.')
    await vi.waitFor(() => {
      expect(controller.source.getSnapshot().selectedGroup?.deliveries).toEqual([
        { messageId: 'bot-group-message-partial-status', botId: first.id, status: 'accepted' },
        { messageId: 'bot-group-message-partial-status', botId: second.id, status: 'failed', error: 'offline' },
      ])
    })
    expect(remote.inspectGroup).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('re-reads a selected group when a change arrives during an in-flight refresh', async () => {
    const first = bot('bot-first-refresh-race', 'session-first-refresh-race')
    const second = bot('bot-second-refresh-race', 'session-second-refresh-race')
    const group = groupView('bot-group-refresh-race', 'Refresh race room', [first, second])
    const stale: BotGroupInspectValue = {
      group,
      messages: [{ id: brandString<BotGroupMessageId>('bot-group-message-stale'), groupId: group.id, sender: { kind: 'user' }, text: 'Before refresh.', createdAt: 1 }],
    }
    const fresh: BotGroupInspectValue = {
      group,
      messages: [
        ...stale.messages,
        { id: brandString<BotGroupMessageId>('bot-group-message-fresh'), groupId: group.id, sender: { kind: 'user' }, text: 'Arrived during refresh.', createdAt: 2 },
      ],
    }
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    let releaseFirst!: (value: { ok: true; value: BotGroupInspectValue }) => void
    let releaseSecond!: (value: { ok: true; value: BotGroupInspectValue }) => void
    const firstInspect = new Promise<{ ok: true; value: BotGroupInspectValue }>((resolve) => { releaseFirst = resolve })
    const secondInspect = new Promise<{ ok: true; value: BotGroupInspectValue }>((resolve) => { releaseSecond = resolve })
    const inspectGroup = vi.fn(async () => {
      if (inspectGroup.mock.calls.length === 1) return firstInspect
      if (inspectGroup.mock.calls.length === 2) return secondInspect
      return { ok: true as const, value: fresh }
    })
    remote.inspectGroup = inspectGroup
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')

    await controller.load()
    controller.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(inspectGroup).toHaveBeenCalledTimes(1) })
    const loading = controller.load()
    await vi.waitFor(() => { expect(inspectGroup).toHaveBeenCalledTimes(2) })
    void controller.load()
    releaseFirst({ ok: true, value: stale })
    releaseSecond({ ok: true, value: stale })
    await loading

    await vi.waitFor(() => { expect(inspectGroup).toHaveBeenCalledTimes(3) })
    await vi.waitFor(() => {
      expect(controller.source.getSnapshot().selectedGroup?.messages.at(-1)?.text).toBe('Arrived during refresh.')
    })
  })
  it('binds memory management to the requested Bot id and preserves stable memory ids', async () => {
    const persisted = bot('bot-memory-owner', 'bot-session-memory-owner')
    const remote = remoteFixture([persisted])
    const listMemory = vi.fn(async () => ({ ok: true as const, value: {
      memories: [{ id: 'memory-one', text: 'Keep the handoff short.', createdAt: 1 }],
    } }))
    const updateMemory = vi.fn(async () => ({ ok: true as const, value: {
      memory: { id: 'memory-one', text: 'Keep the review short.', createdAt: 2 },
    } }))
    const forgetMemory = vi.fn(async () => ({ ok: true as const, value: { removed: true as const } }))
    remote.listMemory = listMemory
    remote.updateMemory = updateMemory
    remote.forgetMemory = forgetMemory
    const { sessions } = sessionsFixture()
    const controller = new BotWorkspaceController(remote, sessions, () => 'unexpected response')

    const manager = controller.face().memoryManager
    if (manager === undefined) throw new Error('memory manager was not mounted')
    await expect(manager.list(String(persisted.id))).resolves.toEqual([{ id: 'memory-one', text: 'Keep the handoff short.', createdAt: 1 }])
    await expect(manager.update(String(persisted.id), 'memory-one', 'Keep the review short.')).resolves.toEqual({
      id: 'memory-one', text: 'Keep the review short.', createdAt: 2,
    })
    await expect(manager.remove(String(persisted.id), 'memory-one')).resolves.toBeUndefined()

    expect(listMemory).toHaveBeenCalledWith({ botId: persisted.id })
    expect(updateMemory).toHaveBeenCalledWith({ botId: persisted.id, memoryId: 'memory-one', text: 'Keep the review short.' })
    expect(forgetMemory).toHaveBeenCalledWith({ botId: persisted.id, memoryId: 'memory-one' })
  })
})
