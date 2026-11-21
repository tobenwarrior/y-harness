import { afterEach, describe, expect, it, type Mock, vi } from 'vitest'
import type {
  SessionBinding, SessionReference, ISessions, SessionListState, SessionSummary,
} from '@yharness/api-session-controller/client'
import type { SessionId } from '@yharness/session/types'
import { RemoteError } from '@yharness/typert-protocol'
import {
  BotId,
  BotPrincipalId,
  BotShareLearningId,
  type BotAttachmentGrantId,
  type BotGroupId,
  type BotGroupInspectValue,
  type BotGroupMessageId,
  type BotGroupView,
  type BotTemplateId,
  type BotTemplatePreviewValue,
  type BotTemplateShareCode,
  type BotTemplateView,
  type BotSkillPolicy,
  type BotView,
} from '@yharness/bots/client'
import { AttachmentId } from '@yharness/attachment'
import { brandString } from '@yharness/brand'
import { MessageId } from '@yharness/llm/brand'
import type { RemoteResult } from '@yharness/api-remotes/client'
import { BotWorkspaceController, createPendingGroupStore, type BotAvatarGenerationRemote, type BotGroupPendingState, type BotGroupPendingStore, type BotWorkspaceRemote } from '../src/client/controller.ts'
import type { BotAttachmentFetch } from '../src/client/attachment-client.ts'

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

function reference(sessionId: SessionId, ready: Promise<SessionBinding> = Promise.resolve({} as SessionBinding)) {
  const release = vi.fn<SessionReference['release']>()
  return {
    sessionId,
    binding: {} as SessionBinding,
    ready,
    release,
    [Symbol.dispose]: release,
  } satisfies SessionReference
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

function sessionsWithList(
  fixture: ReturnType<typeof sessionsFixture>,
  list: ISessions['list'],
): ISessions {
  return { retain: fixture.retain, refresh: fixture.refresh, list } as Pick<ISessions, 'retain' | 'refresh' | 'list'> as ISessions
}

function pendingStoreFixture(initial: BotGroupPendingState = { creations: {}, messages: {} }): BotGroupPendingStore {
  let state = initial
  return {
    durable: true,
    read: () => state,
    write: (next) => { state = next; return true },
  }
}

function wireFixture<T>(value: object | T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type BotRemoteMocks = {
  [Name in keyof BotWorkspaceRemote]: Mock<NonNullable<BotWorkspaceRemote[Name]>>
}

function remoteFixture(rows: readonly BotView[]): BotRemoteMocks & Required<Pick<BotRemoteMocks, 'createGroup' | 'sendGroupMessage'>> {
  const create = vi.fn<BotWorkspaceRemote['create']>()
  const createGroup = vi.fn<NonNullable<BotWorkspaceRemote['createGroup']>>()
  const sendGroupMessage = vi.fn<NonNullable<BotWorkspaceRemote['sendGroupMessage']>>()
  return {
    list: vi.fn<BotWorkspaceRemote['list']>(async () => ({ ok: true, value: { bots: rows } })),
    create,
    createGroup,
    sendGroupMessage,
    rename: vi.fn<BotWorkspaceRemote['rename']>(),
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
  it('routes shared app grants through the owner remote with the current revision', async () => {
    const existing = bot('bot-shared-apps', 'session-shared-apps')
    const access = { botId: existing.id, revision: 3, apps: [{ id: 'github', name: 'GitHub', allowed: false }] }
    const listSharedAppAccess = vi.fn().mockResolvedValue({ ok: true, value: access })
    const setSharedAppAccess = vi.fn().mockResolvedValue({ ok: true, value: { ...access, revision: 4 } })
    const remote = {
      ...remoteFixture([existing]),
      listShareMembers: vi.fn(), createShareInvite: vi.fn(), revokeShareMember: vi.fn(),
      listSharedAppAccess, setSharedAppAccess,
    }
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    const share = controller.face().share
    if (share?.listSharedAppAccess === undefined || share.setSharedAppAccess === undefined) throw new Error('shared app actions are unavailable')
    await expect(share.listSharedAppAccess(existing.id)).resolves.toEqual(access)
    await share.setSharedAppAccess(existing.id, 'github', true, 3)
    expect(listSharedAppAccess).toHaveBeenCalledWith({ botId: existing.id })
    expect(setSharedAppAccess).toHaveBeenCalledWith({ botId: existing.id, appId: 'github', allowed: true, expectedRevision: 3 })
    setSharedAppAccess.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/conflict', 'changed', { botId: existing.id }) })
    await expect(share.setSharedAppAccess(existing.id, 'github', true, 3)).rejects.toMatchObject({ name: 'SharedBotAppsConflictError' })
    setSharedAppAccess.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'sharing unavailable', {}) })
    await expect(share.setSharedAppAccess(existing.id, 'github', true, 3)).rejects.toThrow('sharing unavailable')
    listSharedAppAccess.mockResolvedValueOnce({ ok: true, value: { ...access, botId: BotId('another-bot') } })
    await expect(share.listSharedAppAccess(existing.id)).rejects.toThrow('unexpected response')
    controller.dispose()
  })
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
    remote.rename.mockResolvedValue({ ok: true, value: { bot: updated } })
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
      description: updated.description,
      persona: updated.persona,
      capabilities: updated.capabilities,
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

  it('normalizes empty profile fields and preserves distinct profile error names', async () => {
    const original = bot('bot-profile-errors', 'session-profile-errors')
    const remote = remoteFixture([original])
    const updateProfile = vi.fn<NonNullable<BotWorkspaceRemote['updateProfile']>>()
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/conflict', 'profile changed', { botId: original.id }) })
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'profile rejected', {}) })
      .mockResolvedValueOnce({ ok: true, value: { bot: { ...original, id: BotId('different-profile-bot') } } })
    remote.updateProfile = updateProfile
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    const update = controller.face().updateProfile
    if (update === undefined) throw new Error('profile action is not mounted')

    await expect(update(original.id, { name: 'Profile', description: '', persona: '', capabilities: [] }))
      .rejects.toMatchObject({ name: 'BotProfileConflictError' })
    await expect(update(original.id, { name: 'Profile', description: '', persona: '', capabilities: [] }))
      .rejects.toMatchObject({ name: 'BotProfileSaveError' })
    await expect(update(original.id, { name: 'Profile', description: 'Description', persona: 'Persona', capabilities: [] }))
      .rejects.toThrow('unexpected response')
    expect(updateProfile.mock.calls[0]?.[0]).toEqual({
      botId: original.id, name: 'Profile', description: null, persona: null, capabilities: [],
    })
    controller.dispose()
  })

  it('retains all profile fields in an ambiguous create retry', async () => {
    const remote = remoteFixture([])
    remote.create
      .mockRejectedValueOnce(new Error('connection closed after commit'))
      .mockImplementationOnce(async (request) => {
        if (request.id === undefined) throw new Error('expected a Bot id for the retry')
        return { ok: true, value: { bot: bot(request.id, 'session-profile-retry', { description: request.description }) } }
      })
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
    listConnectedApps.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'apps unavailable', {}) })
    await expect(face.loadConnectedApps?.(original.id)).rejects.toThrow('apps unavailable')
    listConnectedApps.mockResolvedValueOnce({ ok: true, value: { bot: bot('different-apps-bot', 'Different apps'), apps: [] } })
    await expect(face.loadConnectedApps?.(original.id)).rejects.toThrow('unexpected response')
    setConnectedAppAccess.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'app update rejected', {}) })
    await expect(face.setConnectedAppAccess?.(original.id, 'github', false)).rejects.toThrow('app update rejected')
    setConnectedAppAccess.mockResolvedValueOnce({ ok: true, value: { bot: bot('different-apps-bot', 'Different apps'), updatedAt: 2, app: { id: 'github', name: 'GitHub', allowed: false } } })
    await expect(face.setConnectedAppAccess?.(original.id, 'github', false)).rejects.toThrow('unexpected response')
    expect(controller.face().reference()?.sessionId).toBe(original.sessionId)
    controller.dispose()
  })
  it('exposes Bot-scoped skill metadata and persists policy updates', async () => {
    const original = bot('bot-one', 'session-one')
    const remote = remoteFixture([original])
    const policy: BotSkillPolicy = { mode: 'all', enabled: [], disabled: [] }
    const listSkills = vi.fn(async () => ({
      ok: true as const,
      value: { bot: original, policy, revision: 0, skills: [{ name: 'code-review', description: 'Review code', enabled: true, available: true }] },
    }))
    const updateSkills = vi.fn(async () => ({
      ok: true as const,
      value: {
        bot: { ...original, skillPolicy: { mode: 'selected' as const, enabled: ['code-review'], disabled: [] }, updatedAt: 2 },
        policy: { mode: 'selected' as const, enabled: ['code-review'], disabled: [] },
        revision: 1,
        skills: [{ name: 'code-review', description: 'Review code', enabled: true, available: true }],
      },
    }))
    remote.listSkills = listSkills
    remote.updateSkills = updateSkills
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()

    const manager = controller.face().skillManager
    expect(manager).toBeDefined()
    expect(controller.face().skillManager).toBe(manager)
    await expect(manager?.list(original.id)).resolves.toMatchObject({ policy })
    await manager?.update(original.id, { mode: 'selected' as const, enabled: ['code-review'], disabled: [] }, 0)
    expect(listSkills).toHaveBeenCalledWith({ botId: original.id })
    expect(updateSkills).toHaveBeenCalledWith({
      botId: original.id, expectedRevision: 0, mode: 'selected' as const, enabled: ['code-review'], disabled: [],
    })
    expect(controller.source.getSnapshot().bots[0]?.skillPolicy).toEqual({
      mode: 'selected' as const, enabled: ['code-review'], disabled: [],
    })
    controller.dispose()
  })
  it('hides the skill manager when the Host mounts only one skill Remote method', async () => {
    const remote = remoteFixture([bot('bot-without-skill-update', 'session-without-skill-update')])
    remote.listSkills = vi.fn()
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()

    expect(controller.face().skillManager).toBeUndefined()
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
      shareCode: 'bot-template-code-1', name: 'Imported research',
    }))
    expect(remote.importTemplate.mock.lastCall?.[0].importId).toMatch(/^ui-/)
    expect(remote.approveTemplate).toHaveBeenCalledWith({
      shareCode: 'bot-template-code-1', fingerprint: template.fingerprint,
      expectedPermissions: localPermissions, approvalToken: 'preview-token',
    })
    expect(controller.source.getSnapshot().templates).toMatchObject({ code: '', preview: null, busy: false })
    controller.dispose()
  })

  it('previews a template when local permissions are unavailable', async () => {
    const source = bot('bot-template-unavailable', 'session-template-unavailable')
    const template = templateView('bot-template-unavailable', 'bot-template-code-unavailable')
    const unavailable = { status: 'unavailable' as const, tools: [] }
    const remote = remoteFixture([source])
    remote.listTemplates = vi.fn(async () => ({ ok: true as const, value: { templates: [] } }))
    remote.previewTemplate = vi.fn(async () => ({ ok: true as const, value: { template, localPermissions: unavailable } }))
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()
    const actions = controller.face().templateActions
    if (actions === undefined) throw new Error('template actions are not mounted')
    actions.setTemplateCode(String(template.shareCode))
    await actions.previewTemplate()

    expect(controller.source.getSnapshot().templates.preview?.localPermissions).toEqual(unavailable)
    expect(controller.source.getSnapshot().templates.preview?.approvalToken).toBeUndefined()
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

  it('projects every optional template catalog field for the panel', async () => {
    const source = bot('bot-template-catalog-options', 'session-template-catalog-options')
    const template = templateView('bot-template-catalog-options', 'bot-template-code-options', {
      profile: { name: 'Catalog profile', description: 'Profile description', identity: 'browse', accent: 'teal' },
      avatar: { mediaType: 'image/png', data: 'AQID', bytes: 3, width: 1, height: 1, name: 'catalog.png' },
      portableVersion: 1,
      approved: false,
      revokedAt: 2,
    })
    const sparse: BotTemplateView = {
      id: brandString<BotTemplateId>('bot-template-catalog-sparse'),
      shareCode: brandString<BotTemplateShareCode>('bot-template-code-sparse'),
      name: 'Sparse template', identity: 'agent', accent: 'violet', createdAt: 1,
    }
    const remote = remoteFixture([source])
    remote.listTemplates = vi.fn(async () => ({ ok: true as const, value: { templates: [template, sparse] } }))
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()

    expect(controller.source.getSnapshot().templates.templates[0]).toMatchObject({
      id: template.id,
      shareCode: template.shareCode,
      profile: template.profile,
      avatar: template.avatar,
      portableVersion: 1,
      approved: false,
      revokedAt: 2,
    })
    expect(controller.source.getSnapshot().templates.templates[1]).toEqual({
      id: sparse.id, shareCode: sparse.shareCode, name: sparse.name,
      identity: sparse.identity, accent: sparse.accent, createdAt: sparse.createdAt,
    })
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

  it('rejects stale optional response identities and reports missing avatar readers', async () => {
    const original = bot('bot-optional-identities', 'session-optional-identities', {
      avatar: { attachmentId: AttachmentId('optional-identities-avatar'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
    })
    const remote = remoteFixture([original])
    const generation: BotAvatarGenerationRemote = {
      status: vi.fn(async () => ({ ok: true as const, value: { available: true as const, provider: 'openai' as const, model: 'image' } })),
      generate: vi.fn(async () => ({ ok: true as const, value: { data: 'AQID', mediaType: 'image/png' as const } })),
      commit: vi.fn(async () => ({ ok: true as const, value: { attachment: original.avatar! } })),
    }
    const controllerWithoutReader = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response', generation)
    await expect(controllerWithoutReader.face().loadAvatar(original.id, original.avatar!)).rejects.toThrow()
    controllerWithoutReader.dispose()

    remote.readAvatar = vi.fn<NonNullable<BotWorkspaceRemote['readAvatar']>>(async () => ({
      ok: true,
      value: { avatar: { ...original.avatar!, attachmentId: AttachmentId('different-avatar') }, data: 'AQID' },
    }))
    remote.updateAvatar = vi.fn<NonNullable<BotWorkspaceRemote['updateAvatar']>>(async () => ({
      ok: true, value: { bot: { ...original, id: BotId('different-bot'), updatedAt: 2 } },
    }))
    remote.uploadAvatar = vi.fn<NonNullable<BotWorkspaceRemote['uploadAvatar']>>(async () => ({
      ok: true, value: { bot: { ...original, id: BotId('different-bot'), updatedAt: 2 } },
    }))
    remote.updateAppearance = vi.fn<NonNullable<BotWorkspaceRemote['updateAppearance']>>(async () => ({
      ok: true, value: { bot: { ...original, id: BotId('new-appearance-bot'), updatedAt: 2 } },
    }))
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response', generation)
    await expect(controller.face().loadAvatar(original.id, original.avatar!)).rejects.toThrow()
    const editor = controller.face().avatarEditor
    if (editor?.update === undefined || editor.upload === undefined || editor.updateAppearance === undefined) {
      throw new Error('avatar actions are not mounted')
    }
    await expect(editor.update(original.id, original.avatar!)).rejects.toThrow('unexpected response')
    await expect(editor.upload(original.id, { data: 'AQID', mediaType: 'image/png' })).rejects.toThrow('unexpected response')
    await editor.updateAppearance('new-appearance-bot', { identity: 'agent', accent: 'violet', clearAvatar: false })
    expect(controller.source.getSnapshot().bots).toEqual([expect.objectContaining({ id: 'new-appearance-bot' })])
    controller.dispose()
  })

  it('keeps roster state observable across list, Session, group, and template failures', async () => {
    const listFailure = new RemoteError('gateway/internal', 'roster rejected', {})
    const rejectedList = remoteFixture([])
    rejectedList.list.mockResolvedValueOnce({ ok: false, error: listFailure })
    const rejectedListController = new BotWorkspaceController(rejectedList, sessionsFixture().sessions, () => 'unexpected response')
    await rejectedListController.load()
    expect(rejectedListController.source.getSnapshot()).toMatchObject({ phase: 'error', error: 'roster rejected' })
    rejectedListController.dispose()

    const thrownList = remoteFixture([])
    thrownList.list.mockRejectedValueOnce(new Error('roster unavailable'))
    const thrownListController = new BotWorkspaceController(thrownList, sessionsFixture().sessions, () => 'unexpected response')
    await thrownListController.load()
    expect(thrownListController.source.getSnapshot()).toMatchObject({ phase: 'error', error: 'roster unavailable' })
    thrownListController.dispose()

    const sessionFailure = remoteFixture([])
    const sessions = sessionsFixture()
    sessions.refresh.mockRejectedValueOnce(new Error('Session catalog unavailable'))
    const sessionController = new BotWorkspaceController(sessionFailure, sessions.sessions, () => 'unexpected response')
    await sessionController.load()
    expect(sessionController.source.getSnapshot()).toMatchObject({ phase: 'error', error: 'Session catalog unavailable' })
    sessionController.dispose()

    const groupFailure = remoteFixture([])
    groupFailure.listGroups = vi.fn(async () => { throw new Error('group catalog unavailable') })
    const groupController = new BotWorkspaceController(groupFailure, sessionsFixture().sessions, () => 'unexpected response')
    await groupController.load()
    expect(groupController.source.getSnapshot()).toMatchObject({ phase: 'ready', groupError: 'group catalog unavailable' })
    groupController.dispose()

    const rejectedGroups = remoteFixture([])
    rejectedGroups.listGroups = vi.fn(async () => ({ ok: false as const, error: new RemoteError('gateway/internal', 'groups rejected', {}) }))
    const rejectedGroupsController = new BotWorkspaceController(rejectedGroups, sessionsFixture().sessions, () => 'unexpected response')
    await rejectedGroupsController.load()
    expect(rejectedGroupsController.source.getSnapshot()).toMatchObject({ phase: 'ready', groupError: 'groups rejected' })
    rejectedGroupsController.dispose()

    const rejectedTemplates = remoteFixture([])
    rejectedTemplates.listTemplates = vi.fn(async () => ({ ok: false as const, error: new RemoteError('gateway/internal', 'templates rejected', {}) }))
    const rejectedTemplatesController = new BotWorkspaceController(rejectedTemplates, sessionsFixture().sessions, () => 'unexpected response')
    await rejectedTemplatesController.load()
    expect(rejectedTemplatesController.source.getSnapshot().templates).toMatchObject({ phase: 'error', error: 'templates rejected' })
    rejectedTemplatesController.dispose()

    const thrownTemplates = remoteFixture([])
    thrownTemplates.listTemplates = vi.fn(async () => { throw new Error('template catalog unavailable') })
    const thrownTemplatesController = new BotWorkspaceController(thrownTemplates, sessionsFixture().sessions, () => 'unexpected response')
    await thrownTemplatesController.load()
    expect(thrownTemplatesController.source.getSnapshot().templates).toMatchObject({ phase: 'error', error: 'template catalog unavailable' })
    thrownTemplatesController.dispose()
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

  it('reports organization failures and accepts a newly returned roster row', async () => {
    const remote = remoteFixture([])
    const updated = bot('bot-organize-new', 'session-organize-new', { pinned: true })
    const updateOrganization = vi.fn<NonNullable<BotWorkspaceRemote['updateOrganization']>>()
      .mockRejectedValueOnce(new Error('organization unavailable'))
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'organization rejected', {}) })
      .mockResolvedValueOnce({ ok: true, value: { bot: { ...updated, id: BotId('different-organization-bot') } } })
      .mockResolvedValueOnce({ ok: true, value: { bot: updated } })
    remote.updateOrganization = updateOrganization
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    const organize = controller.face().organize
    if (organize === undefined) throw new Error('organization action is not mounted')

    await expect(organize(updated.id, { pinned: true })).rejects.toThrow('organization unavailable')
    await expect(organize(updated.id, { pinned: true })).rejects.toThrow('organization rejected')
    await expect(organize(updated.id, { pinned: true })).rejects.toThrow('unexpected response')
    await organize(updated.id, { pinned: true })
    expect(controller.source.getSnapshot().bots).toEqual([updated])
    controller.dispose()
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

  it('does not commit optional action results after the controller is disposed', async () => {
    const original = bot('bot-disposal-actions', 'session-disposal-actions')

    const renameRemote = remoteFixture([original])
    const renameResult = Promise.withResolvers<Awaited<ReturnType<BotWorkspaceRemote['rename']>>>()
    renameRemote.rename.mockImplementationOnce(() => renameResult.promise)
    const renameController = new BotWorkspaceController(renameRemote, sessionsFixture().sessions, () => 'unexpected response')
    const renaming = renameController.face().rename(original.id, 'Renamed')
    await vi.waitFor(() => { expect(renameRemote.rename).toHaveBeenCalledOnce() })
    renameController.dispose()
    renameResult.resolve({ ok: true, value: { bot: { ...original, name: 'Renamed', updatedAt: 2 } } })
    await expect(renaming).resolves.toBeUndefined()

    const uploadRemote = remoteFixture([original])
    const uploadResult = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['uploadAvatar']>>>>()
    uploadRemote.uploadAvatar = vi.fn(() => uploadResult.promise)
    const uploadController = new BotWorkspaceController(uploadRemote, sessionsFixture().sessions, () => 'unexpected response')
    const upload = uploadController.face().avatarEditor?.upload
    if (upload === undefined) throw new Error('upload action is not mounted')
    const uploading = upload(original.id, { data: 'AQID', mediaType: 'image/png' })
    await vi.waitFor(() => { expect(uploadRemote.uploadAvatar).toHaveBeenCalledOnce() })
    uploadController.dispose()
    uploadResult.resolve({ ok: true, value: { bot: { ...original, updatedAt: 2 } } })
    await expect(uploading).resolves.toBeUndefined()

    const organizeRemote = remoteFixture([original])
    const organizeResult = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['updateOrganization']>>>>()
    organizeRemote.updateOrganization = vi.fn(() => organizeResult.promise)
    const organizeController = new BotWorkspaceController(organizeRemote, sessionsFixture().sessions, () => 'unexpected response')
    const organize = organizeController.face().organize
    if (organize === undefined) throw new Error('organization action is not mounted')
    const organizing = organize(original.id, { pinned: true })
    await vi.waitFor(() => { expect(organizeRemote.updateOrganization).toHaveBeenCalledOnce() })
    organizeController.dispose()
    organizeResult.resolve({ ok: true, value: { bot: { ...original, pinned: true, updatedAt: 2 } } })
    await expect(organizing).resolves.toBeUndefined()

    const appRemote = remoteFixture([original])
    const appResult = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['setConnectedAppAccess']>>>>()
    appRemote.setConnectedAppAccess = vi.fn(() => appResult.promise)
    const appController = new BotWorkspaceController(appRemote, sessionsFixture().sessions, () => 'unexpected response')
    const setApp = appController.face().setConnectedAppAccess
    if (setApp === undefined) throw new Error('connected-app action is not mounted')
    const settingApp = setApp(original.id, 'github', true)
    await vi.waitFor(() => { expect(appRemote.setConnectedAppAccess).toHaveBeenCalledOnce() })
    appController.dispose()
    appResult.resolve({ ok: true, value: { bot: { ...original, updatedAt: 2 }, app: { id: 'github', name: 'GitHub', allowed: true } } })
    await expect(settingApp).resolves.toBeUndefined()

    const profileRemote = remoteFixture([original])
    const profileResult = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['updateProfile']>>>>()
    profileRemote.updateProfile = vi.fn(() => profileResult.promise)
    const profileController = new BotWorkspaceController(profileRemote, sessionsFixture().sessions, () => 'unexpected response')
    const updateProfile = profileController.face().updateProfile
    if (updateProfile === undefined) throw new Error('profile action is not mounted')
    const updatingProfile = updateProfile(original.id, { name: original.name, description: '', persona: '', capabilities: [] })
    await vi.waitFor(() => { expect(profileRemote.updateProfile).toHaveBeenCalledOnce() })
    profileController.dispose()
    profileResult.resolve({ ok: true, value: { bot: { ...original, updatedAt: 2 } } })
    await expect(updatingProfile).resolves.toBeUndefined()

    const createRemote = remoteFixture([])
    const createResult = Promise.withResolvers<Awaited<ReturnType<BotWorkspaceRemote['create']>>>()
    createRemote.create.mockImplementationOnce(() => createResult.promise)
    const createController = new BotWorkspaceController(createRemote, sessionsFixture().sessions, () => 'unexpected response')
    const creating = createController.face().create({ name: 'Disposed create', identity: 'agent', accent: 'violet' })
    await vi.waitFor(() => { expect(createRemote.create).toHaveBeenCalledOnce() })
    createController.dispose()
    createResult.resolve({ ok: true, value: { bot: bot('bot-disposed-create', 'session-disposed-create') } })
    await expect(creating).resolves.toBeUndefined()
  })

  it('keeps an ambiguous create retry on one Bot id', async () => {
    const remote = remoteFixture([])
    const firstFailure = new Error('connection closed after commit')
    remote.create
      .mockRejectedValueOnce(firstFailure)
      .mockImplementationOnce(async (request) => {
        if (request.id === undefined) throw new Error('expected a Bot id for the retry')
        return { ok: true, value: { bot: bot(request.id, 'session-retry') } }
      })
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
    remote.create.mockImplementationOnce(async (request) => {
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
    const retained = retain.mock.results[0]
    if (retained?.type !== 'return') throw new Error('expected the direct Bot Session to be retained')
    expect(controller.face().reference()).toBe(retained.value)
    controller.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(controller.source.getSnapshot().selectedGroup?.name).toBe('Release room') })

    expect(controller.source.getSnapshot().selectedBotId).toBeNull()
    expect(controller.source.getSnapshot().selectedGroup?.deliveries).toEqual([{
      messageId: 'bot-group-message-1', botId: 'bot-second-group', status: 'failed', error: 'Provider credentials are missing.',
    }])
    expect(controller.face().reference()).toBeUndefined()
    expect(retained.value.release).toHaveBeenCalledOnce()
    expect(remote.inspectGroup).toHaveBeenCalledWith({ groupId: group.id })

    await controller.face().sendGroupMessage('Add owners.')
    expect(remote.sendGroupMessage).toHaveBeenCalledWith(expect.objectContaining({ groupId: group.id, text: 'Add owners.' }))
    expect(remote.sendGroupMessage.mock.calls[0]?.[0].messageId).toMatch(/^bot-group-message-/)
    expect(retain).toHaveBeenCalledOnce()
  })

  it('admits an owner-local image before sending its scoped grant', async () => {
    const first = bot('bot-attachment-local-first', 'session-attachment-local-first')
    const second = bot('bot-attachment-local-second', 'session-attachment-local-second')
    const group = groupView('bot-group-attachment-local', 'Attachment room', [first, second])
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group, messages: [] } }))
    const admitGroupImage = vi.fn<NonNullable<BotWorkspaceRemote['admitGroupImage']>>(async ({ image }) => ({
      ok: true,
      value: {
        grantId: brandString<BotAttachmentGrantId>('bot-attachment-grant-local-image'),
        attachments: [{
          type: 'image',
          mediaType: image.mediaType,
          bytes: 3,
          width: 1,
          height: 1,
          ...(image.name === undefined ? {} : { name: image.name }),
        }],
      },
    }))
    remote.admitGroupImage = admitGroupImage
    remote.sendGroupMessage = vi.fn(async request => ({
      ok: true as const,
      value: { messageId: request.messageId!, status: 'accepted' as const, deliveries: [] },
    }))
    const fetcher = vi.fn<typeof fetch>()
    const controller = new BotWorkspaceController(
      remote,
      sessionsFixture().sessions,
      () => 'unexpected response',
      undefined,
      undefined,
      pendingStoreFixture(),
      undefined,
      undefined,
      fetcher,
    )
    await controller.load()
    controller.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(controller.source.getSnapshot().selectedGroup).not.toBeNull() })

    await controller.face().sendGroupMessageWithAttachments(
      'Review this image',
      [{ id: 'draft-local-image', file: new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' }), state: 'ready' }],
      'bot-group-message-local-image',
      [String(first.id)],
      'bot-group-message-parent-image',
    )

    expect(remote.admitGroupImage).toHaveBeenCalledWith(expect.objectContaining({
      groupId: group.id, messageId: 'bot-group-message-local-image', targetBotIds: [String(first.id)],
    }))
    expect(admitGroupImage.mock.lastCall?.[0].image).toMatchObject({ data: 'AQID', name: 'image.png' })
    expect(remote.sendGroupMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'bot-group-message-local-image', attachmentGrants: ['bot-attachment-grant-local-image'],
    }))
    expect(fetcher).not.toHaveBeenCalled()
    controller.dispose()
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

  it('reports the non-durable retry store when browser storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined)
    const store = createPendingGroupStore('ui-bots-no-storage')
    expect(store.durable).toBe(false)
    expect(store.read()).toEqual({ creations: {}, messages: {} })
    expect(store.write({ creations: {}, messages: {} })).toBe(false)
  })

  it('rejects malformed persisted retry records and recovers after storage errors', () => {
    const backing = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => { backing.set(key, value) },
    })
    const invalidRecords: readonly unknown[] = [
      { creations: { '': 'bot-group-invalid' }, messages: {} },
      { creations: { retry: '' }, messages: {} },
      { creations: {}, messages: { retry: { text: '', messageId: 'bot-group-message-invalid' } } },
      { creations: {}, messages: { retry: { text: 'Retry', messageId: 'bot-group-message-invalid', targetBotIds: [] } } },
      { creations: {}, messages: { retry: { text: 'Retry', messageId: 'bot-group-message-invalid', targetBotIds: [' '] } } },
      { creations: {}, messages: { retry: { text: 'Retry', messageId: 'bot-group-message-invalid', replyToMessageId: 'invalid-parent' } } },
      { creations: {}, messages: { retry: { text: 'Retry', messageId: 'bot-group-message-invalid', replyToMessageId: 'bot-group-message-invalid' } } },
    ]
    for (const [index, record] of invalidRecords.entries()) {
      backing.set(`invalid-${index}`, JSON.stringify(record))
      const store = createPendingGroupStore(`invalid-${index}`)
      expect(store.read()).toEqual({ creations: {}, messages: {} })
      expect(store.durable).toBe(false)
      expect(store.read()).toEqual({ creations: {}, messages: {} })
      expect(store.write({ creations: {}, messages: {} })).toBe(false)
    }

    const valid = createPendingGroupStore('valid-pending')
    expect(valid.write({
      creations: { retry: 'bot-group-valid' },
      messages: {
        retry: {
          text: 'Retry', messageId: 'bot-group-message-valid',
          targetBotIds: ['bot-a'], replyToMessageId: 'bot-group-message-parent',
        },
      },
    })).toBe(true)
    expect(valid.read()).toEqual({
      creations: { retry: 'bot-group-valid' },
      messages: {
        retry: {
          text: 'Retry', messageId: 'bot-group-message-valid',
          targetBotIds: ['bot-a'], replyToMessageId: 'bot-group-message-parent',
        },
      },
    })

    let writeAttempts = 0
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { writeAttempts++; throw new Error('storage write failed') },
    })
    const writeThrowing = createPendingGroupStore('storage-write-throws')
    expect(writeThrowing.durable).toBe(true)
    expect(writeThrowing.write({ creations: {}, messages: {} })).toBe(false)
    expect(writeAttempts).toBe(1)
    expect(writeThrowing.durable).toBe(false)
    expect(writeThrowing.write({ creations: {}, messages: {} })).toBe(false)

    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('storage read failed') },
      setItem: () => { throw new Error('storage write failed') },
    })
    const throwing = createPendingGroupStore('storage-throws')
    expect(throwing.durable).toBe(false)
    expect(throwing.read()).toEqual({ creations: {}, messages: {} })
    expect(throwing.write({ creations: {}, messages: {} })).toBe(false)
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

  it('fails safely on rejected or mismatched pending group reconciliation', async () => {
    const first = bot('bot-reconcile-first', 'session-reconcile-first')
    const second = bot('bot-reconcile-second', 'session-reconcile-second')
    const group = groupView('bot-group-reconcile', 'Reconcile room', [first, second])
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, error: new RemoteError('gateway/internal', 'catalog rejected', {}) })
      .mockResolvedValueOnce({ ok: true as const, value: { groups: [groupView('bot-group-reconcile', 'Wrong room', [first])] } })
      .mockResolvedValueOnce({ ok: true as const, value: { groups: [group] } })
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group, messages: [] } }))
    const pendingKey = `Reconcile room\u0000${[String(first.id), String(second.id)].sort().join('\u0000')}`
    const controller = new BotWorkspaceController(
      remote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined,
      pendingStoreFixture({ creations: { [pendingKey]: String(group.id) }, messages: {} }),
    )
    const creation = { name: group.name, botIds: [String(first.id), String(second.id)] }
    await expect(controller.face().createGroup(creation)).rejects.toThrow('catalog rejected')
    await expect(controller.face().createGroup(creation)).rejects.toThrow('different metadata')
    await expect(controller.face().createGroup(creation)).resolves.toBeUndefined()
    expect(remote.createGroup).not.toHaveBeenCalled()
    expect(controller.source.getSnapshot().selectedGroupId).toBe(String(group.id))
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

  it('rejects pending message retries when the transcript is rejected or differs', async () => {
    const first = bot('bot-message-reconcile-first', 'session-message-reconcile-first')
    const second = bot('bot-message-reconcile-second', 'session-message-reconcile-second')
    const group = groupView('bot-group-message-reconcile', 'Message reconcile room', [first, second])
    const messageId = brandString<BotGroupMessageId>('bot-group-message-reconcile')
    const existing = {
      id: messageId, groupId: group.id, sender: { kind: 'user' as const }, text: 'Retry me', createdAt: 1,
    }
    const mismatch = { ...existing, text: 'Different text' }
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    remote.inspectGroup = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: { group, messages: [] } })
      .mockResolvedValueOnce({ ok: false as const, error: new RemoteError('gateway/internal', 'transcript rejected', {}) })
      .mockResolvedValueOnce({ ok: true as const, value: { group, messages: [mismatch] } })
      .mockResolvedValue({ ok: true as const, value: { group, messages: [existing] } })
    remote.sendGroupMessage = vi.fn(async request => ({ ok: true as const, value: {
      messageId: request.messageId!, status: 'accepted' as const, deliveries: [],
    } }))
    const pendingKey = `${group.id}\u0000Retry me\u0000`
    const controller = new BotWorkspaceController(
      remote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined,
      pendingStoreFixture({ creations: {}, messages: {
        [pendingKey]: { text: 'Retry me', messageId: String(messageId) },
      } }),
    )
    await controller.load()
    controller.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(controller.source.getSnapshot().selectedGroup).not.toBeNull() })
    await expect(controller.face().sendGroupMessage('Retry me')).rejects.toThrow('transcript rejected')
    await expect(controller.face().sendGroupMessage('Retry me')).rejects.toThrow('content differs')
    await expect(controller.face().sendGroupMessage('Retry me')).resolves.toBeUndefined()
    expect(remote.sendGroupMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId }))
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
    expect(controller.face().memoryManager).toBe(manager)
    await expect(manager.list(String(persisted.id))).resolves.toEqual([{ id: 'memory-one', text: 'Keep the handoff short.', createdAt: 1 }])
    await expect(manager.update(String(persisted.id), 'memory-one', 'Keep the review short.')).resolves.toEqual({
      id: 'memory-one', text: 'Keep the review short.', createdAt: 2,
    })
    await expect(manager.remove(String(persisted.id), 'memory-one')).resolves.toBeUndefined()

    expect(listMemory).toHaveBeenCalledWith({ botId: persisted.id })
    expect(updateMemory).toHaveBeenCalledWith({ botId: persisted.id, memoryId: 'memory-one', text: 'Keep the review short.' })
    expect(forgetMemory).toHaveBeenCalledWith({ botId: persisted.id, memoryId: 'memory-one' })
  })

  it('mounts owner-scoped routine callbacks and preserves routine ids', async () => {
    const persisted = bot('bot-routine-owner', 'bot-session-routine-owner')
    const routine = {
      kind: 'event' as const,
      id: 'routine-one',
      title: 'Review messages',
      prompt: 'Review incoming messages.',
      trigger: { type: 'message' as const, source: 'user' as const },
      status: 'active' as const,
      createdAt: 1,
      updatedAt: 1,
      state: 'waiting' as const,
      deliveryMode: 'host' as const,
      botId: persisted.id,
      sessionId: persisted.sessionId,
    }
    const remote = remoteFixture([persisted])
    const listRoutines = vi.fn(async () => ({ ok: true as const, value: { routines: [routine] } }))
    const pauseRoutine = vi.fn(async () => ({ ok: true as const, value: { routine: { ...routine, status: 'paused' as const }, paused: true as const } }))
    const resumeRoutine = vi.fn(async () => ({ ok: true as const, value: { routine, resumed: true as const } }))
    const deleteRoutine = vi.fn(async () => ({ ok: true as const, value: { id: 'routine-one', deleted: true as const } }))
    const routineHistory = vi.fn(async () => ({ ok: true as const, value: { kind: 'event' as const, id: 'routine-one', deliveries: [], results: [] } }))
    remote.listRoutines = listRoutines
    remote.pauseRoutine = pauseRoutine
    remote.resumeRoutine = resumeRoutine
    remote.deleteRoutine = deleteRoutine
    remote.routineHistory = routineHistory
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')

    const manager = controller.face().routineManager
    if (manager === undefined) throw new Error('routine manager was not mounted')
    await expect(manager.list(String(persisted.id))).resolves.toEqual([routine])
    await expect(manager.pause(String(persisted.id), 'routine-one')).resolves.toMatchObject({ id: 'routine-one', status: 'paused' })
    await expect(manager.resume(String(persisted.id), 'routine-one')).resolves.toEqual(routine)
    await expect(manager.history(String(persisted.id), 'routine-one')).resolves.toMatchObject({ kind: 'event', id: 'routine-one' })
    await expect(manager.history(String(persisted.id), 'routine-one', MessageId('older-routine-result'))).resolves.toMatchObject({ kind: 'event', id: 'routine-one' })
    await expect(manager.remove(String(persisted.id), 'routine-one')).resolves.toBeUndefined()

    expect(listRoutines).toHaveBeenCalledWith({ botId: persisted.id })
    expect(pauseRoutine).toHaveBeenCalledWith({ botId: persisted.id, routineId: 'routine-one' })
    expect(resumeRoutine).toHaveBeenCalledWith({ botId: persisted.id, routineId: 'routine-one' })
    expect(routineHistory).toHaveBeenCalledWith({ botId: persisted.id, routineId: 'routine-one', limit: 50 })
    expect(routineHistory).toHaveBeenCalledWith({ botId: persisted.id, routineId: 'routine-one', limit: 50, before: MessageId('older-routine-result') })
    expect(deleteRoutine).toHaveBeenCalledWith({ botId: persisted.id, routineId: 'routine-one' })
  })

  it('forwards optional Bot actions with their owner and lifecycle arguments', async () => {
    const original = bot('bot-optional-actions', 'session-optional-actions')
    const generated = bot('bot-generated-avatar', 'session-generated-avatar')
    const avatar = { attachmentId: AttachmentId('optional-avatar'), mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1 }
    const preview = { data: 'AQID', mediaType: 'image/png' as const }
    const updated = { ...original, avatar, updatedAt: 2 }
    const principal = BotPrincipalId('principal-optional')
    const member = {
      botId: original.id, principalId: principal, role: 'collaborator' as const, grantedBy: principal,
      createdAt: 1, updatedAt: 2,
    }
    const fence = {
      groupId: brandString<BotGroupId>('group-fence'), botId: original.id,
      sessionId: original.sessionId, messageId: brandString<BotGroupMessageId>('message-fence'),
    }
    const policy: BotSkillPolicy = { mode: 'all', enabled: [], disabled: [] }
    const routine = {
      kind: 'event' as const,
      id: 'routine-optional',
      title: 'Review messages',
      prompt: 'Review incoming messages.',
      trigger: { type: 'message' as const, source: 'user' as const },
      status: 'active' as const,
      createdAt: 1,
      updatedAt: 1,
      state: 'waiting' as const,
      deliveryMode: 'host' as const,
      botId: original.id,
      sessionId: original.sessionId,
    }
    const remote = remoteFixture([original])
    const readGrokHistory = vi.fn<NonNullable<BotWorkspaceRemote['readGrokHistory']>>(async () => ({
      ok: true, value: null,
    }))
    const updateAvatar = vi.fn<NonNullable<BotWorkspaceRemote['updateAvatar']>>(async ({ botId }) => ({
      ok: true, value: { bot: botId === original.id ? updated : generated },
    }))
    const uploadAvatar = vi.fn<NonNullable<BotWorkspaceRemote['uploadAvatar']>>(async () => ({
      ok: true, value: { bot: { ...updated, updatedAt: 3 } },
    }))
    const updateAppearance = vi.fn<NonNullable<BotWorkspaceRemote['updateAppearance']>>(async () => ({
      ok: true, value: { bot: { ...updated, updatedAt: 4 } },
    }))
    remote.readGrokHistory = readGrokHistory
    remote.updateAvatar = updateAvatar
    remote.uploadAvatar = uploadAvatar
    remote.updateAppearance = updateAppearance
    remote.listShareMembers = vi.fn<NonNullable<BotWorkspaceRemote['listShareMembers']>>(async ({ botId }) => ({
      ok: true, value: { botId, members: [member] },
    }))
    remote.createShareInvite = vi.fn<NonNullable<BotWorkspaceRemote['createShareInvite']>>(async () => ({
      ok: true, value: { code: 'invite-code', expiresAt: 10 },
    }))
    remote.revokeShareMember = vi.fn<NonNullable<BotWorkspaceRemote['revokeShareMember']>>(async ({ botId, principalId }) => ({
      ok: true, value: { botId, principalId, revoked: true },
    }))
    remote.getShareMemoryPolicy = vi.fn<NonNullable<BotWorkspaceRemote['getShareMemoryPolicy']>>(async ({ botId }) => ({
      ok: true, value: { botId, enabled: false, updatedAt: 1 },
    }))
    remote.setShareMemoryPolicy = vi.fn<NonNullable<BotWorkspaceRemote['setShareMemoryPolicy']>>(async ({ botId, enabled }) => ({
      ok: true, value: { botId, enabled, updatedAt: 2 },
    }))
    remote.listShareLearning = vi.fn<NonNullable<BotWorkspaceRemote['listShareLearning']>>(async ({ botId }) => ({
      ok: true, value: { botId, pending: [], recentlyLearned: [] },
    }))
    remote.decideShareLearning = vi.fn<NonNullable<BotWorkspaceRemote['decideShareLearning']>>(async ({ botId, suggestionId }) => ({
      ok: true, value: { botId, suggestionId, decision: 'rejected', resolved: true },
    }))
    remote.inspectSharedRosterFence = vi.fn<NonNullable<BotWorkspaceRemote['inspectSharedRosterFence']>>(async () => ({
      ok: true, value: { status: 'held', token: 'roster-fence-token' },
    }))
    remote.recoverSharedRosterFence = vi.fn<NonNullable<BotWorkspaceRemote['recoverSharedRosterFence']>>(async () => ({
      ok: true, value: { status: 'released' },
    }))
    remote.inspectSharedGroupDeliveryFences = vi.fn<NonNullable<BotWorkspaceRemote['inspectSharedGroupDeliveryFences']>>(async () => ({
      ok: true, value: { fences: [fence] },
    }))
    remote.recoverSharedGroupDelivery = vi.fn<NonNullable<BotWorkspaceRemote['recoverSharedGroupDelivery']>>(async ({ botId, messageId }) => ({
      ok: true, value: { botId, messageId, status: 'released' },
    }))
    remote.listMemory = vi.fn<NonNullable<BotWorkspaceRemote['listMemory']>>(async () => ({
      ok: true, value: { memories: [] },
    }))
    remote.updateMemory = vi.fn<NonNullable<BotWorkspaceRemote['updateMemory']>>(async () => ({
      ok: true, value: { memory: { id: 'memory-optional', text: 'Remember this.', createdAt: 2 } },
    }))
    remote.forgetMemory = vi.fn<NonNullable<BotWorkspaceRemote['forgetMemory']>>(async () => ({
      ok: true, value: { removed: true },
    }))
    remote.listSkills = vi.fn<NonNullable<BotWorkspaceRemote['listSkills']>>(async ({ botId }) => ({
      ok: true, value: { bot: botId === original.id ? original : generated, policy, revision: 1, skills: [] },
    }))
    remote.updateSkills = vi.fn<NonNullable<BotWorkspaceRemote['updateSkills']>>(async ({ botId }) => ({
      ok: true, value: { bot: botId === original.id ? { ...original, updatedAt: 3 } : generated, policy, revision: 2 },
    }))
    remote.listRoutines = vi.fn<NonNullable<BotWorkspaceRemote['listRoutines']>>(async () => ({
      ok: true, value: { routines: [routine] },
    }))
    remote.pauseRoutine = vi.fn<NonNullable<BotWorkspaceRemote['pauseRoutine']>>(async () => ({
      ok: true, value: { routine: { ...routine, status: 'paused' as const }, paused: true },
    }))
    remote.resumeRoutine = vi.fn<NonNullable<BotWorkspaceRemote['resumeRoutine']>>(async () => ({
      ok: true, value: { routine, resumed: true },
    }))
    remote.deleteRoutine = vi.fn<NonNullable<BotWorkspaceRemote['deleteRoutine']>>(async () => ({
      ok: true, value: { id: routine.id, deleted: true },
    }))
    remote.routineHistory = vi.fn<NonNullable<BotWorkspaceRemote['routineHistory']>>(async () => ({
      ok: true, value: { kind: 'event' as const, id: routine.id, deliveries: [], results: [] },
    }))
    const generation: BotAvatarGenerationRemote = {
      status: vi.fn(async () => ({ ok: true as const, value: { available: true as const, provider: 'openai' as const, model: 'gpt-image-1' } })),
      generate: vi.fn(async (request, signal) => {
        expect(request).toEqual({ description: 'A calm research partner.' })
        expect(signal).toBeInstanceOf(AbortSignal)
        return { ok: true as const, value: preview }
      }),
      commit: vi.fn(async (value) => {
        expect(value).toEqual(preview)
        return { ok: true as const, value: { attachment: avatar } }
      }),
    }
    const controller = new BotWorkspaceController(
      remote,
      sessionsFixture().sessions,
      () => 'unexpected response',
      generation,
    )
    await controller.load()
    const face = controller.face()
    await expect(face.readGrokHistory?.(original.id)).resolves.toBeNull()
    const editor = face.avatarEditor
    if (editor?.status === undefined || editor.generate === undefined || editor.commit === undefined || editor.update === undefined
      || editor.upload === undefined || editor.updateAppearance === undefined) throw new Error('avatar actions are not mounted')
    await expect(editor.status()).resolves.toMatchObject({ available: true, model: 'gpt-image-1' })
    await expect(editor.generate({ description: 'A calm research partner.' }, new AbortController().signal)).resolves.toEqual(preview)
    await expect(editor.commit(preview)).resolves.toEqual({ attachment: avatar })
    await editor.update(original.id, avatar)
    await editor.update(String(generated.id), avatar)
    await editor.upload(original.id, preview)
    await editor.updateAppearance(original.id, { identity: 'sparkle', accent: 'amber', clearAvatar: false })
    expect(controller.source.getSnapshot().bots.map(row => row.id)).toEqual([original.id, generated.id])

    const share = face.share
    if (share === undefined || share.getMemoryPolicy === undefined || share.setMemoryPolicy === undefined
      || share.inspectRosterFence === undefined || share.recoverRosterFence === undefined
      || share.inspectDeliveryFences === undefined || share.recoverDeliveryFence === undefined) {
      throw new Error('share actions are not mounted')
    }
    await expect(share.listMembers(original.id)).resolves.toEqual({ botId: original.id, members: [member] })
    await expect(share.createInvite(original.id, 'collaborator')).resolves.toEqual({ code: 'invite-code', expiresAt: 10 })
    await expect(share.revokeMember(original.id, String(principal))).resolves.toEqual({
      botId: original.id, principalId: principal, revoked: true,
    })
    await expect(share.getMemoryPolicy(original.id)).resolves.toMatchObject({ botId: original.id, enabled: false })
    await expect(share.setMemoryPolicy(original.id, true)).resolves.toMatchObject({ botId: original.id, enabled: true })
    await expect(share.listLearning?.({ botId: original.id })).resolves.toMatchObject({ ok: true, value: { botId: original.id } })
    const suggestionId = BotShareLearningId('learning-provider')
    await expect(share.decideLearning?.({ botId: original.id, suggestionId, decision: 'reject' })).resolves.toMatchObject({
      ok: true, value: { botId: original.id, suggestionId, decision: 'rejected' },
    })
    Reflect.deleteProperty(remote, 'decideShareLearning')
    expect(controller.face().share?.listLearning).toBeUndefined()
    await expect(share.inspectRosterFence()).resolves.toEqual({ status: 'held', token: 'roster-fence-token' })
    await expect(share.recoverRosterFence('roster-fence-token')).resolves.toEqual({ status: 'released' })
    await expect(share.inspectDeliveryFences(original.id)).resolves.toEqual({ fences: [fence] })
    await expect(share.recoverDeliveryFence(fence)).resolves.toMatchObject({ botId: original.id, messageId: fence.messageId, status: 'released' })
    expect(remote.recoverSharedRosterFence).toHaveBeenCalledWith({ token: 'roster-fence-token', confirmQuiescent: true, acceptRaceRisk: true })
    expect(remote.recoverSharedGroupDelivery).toHaveBeenCalledWith({
      groupId: fence.groupId, botId: fence.botId, sessionId: fence.sessionId, messageId: fence.messageId, confirmQuiescent: true,
    })

    const memory = face.memoryManager
    if (memory === undefined) throw new Error('memory manager is not mounted')
    await memory.list(original.id)
    await memory.update(original.id, 'memory-optional', 'Remember this.')
    await memory.remove(original.id, 'memory-optional')
    const skills = face.skillManager
    if (skills === undefined) throw new Error('skill manager is not mounted')
    await skills.list(original.id)
    await skills.update(original.id, policy, 1)
    const routines = face.routineManager
    if (routines === undefined) throw new Error('routine manager is not mounted')
    await routines.list(original.id)
    await routines.pause(original.id, routine.id)
    await routines.resume(original.id, routine.id)
    await routines.history(original.id, routine.id)
    await routines.remove(original.id, routine.id)
    controller.bumpRoutineRevision()
    expect(controller.source.getSnapshot().routineRevision).toBe(1)
    face.retry()
    await vi.waitFor(() => { expect(remote.list).toHaveBeenCalledTimes(2) })
    expect(readGrokHistory).toHaveBeenCalledWith({ botId: original.id })
    controller.dispose()
  })

  it('projects targeted group messages and routes reactions through the selected group', async () => {
    const first = bot('bot-group-target-first', 'session-group-target-first')
    const second = bot('bot-group-target-second', 'session-group-target-second')
    const group = groupView('group-targeted-actions', 'Targeted actions', [first, second])
    const parentId = brandString<BotGroupMessageId>('bot-group-message-parent')
    const messageId = brandString<BotGroupMessageId>('bot-group-message-targeted')
    const detail: BotGroupInspectValue = {
      group,
      messages: [
        {
          id: parentId,
          groupId: group.id,
          sender: { kind: 'bot', botId: first.id, name: first.name },
          text: 'Parent message',
          createdAt: 1,
        },
        {
          id: messageId,
          groupId: group.id,
          sender: { kind: 'user' },
          text: 'Targeted',
          targetBotIds: [first.id, second.id],
          replyToMessageId: parentId,
          reactions: [
            { emoji: '👍', count: 1, viewerReacted: true },
            { emoji: '👀', count: 0 },
          ],
          createdAt: 2,
        },
      ],
      deliveries: [{ messageId, botId: second.id, status: 'failed', error: 'offline' }],
    }
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: detail }))
    remote.sendGroupMessage = vi.fn(async request => ({
      ok: true as const,
      value: { messageId: request.messageId!, status: 'accepted' as const, deliveries: [] },
    }))
    remote.reactGroupMessage = vi.fn<NonNullable<BotWorkspaceRemote['reactGroupMessage']>>(async ({ messageId: id }) => ({
      ok: true, value: { messageId: id, reactions: [{ emoji: '👍', count: 1, viewerReacted: true }] },
    }))
    const sortedIds = [String(first.id), String(second.id)].sort()
    const pendingKey = `${group.id}\u0000Targeted\u0000${sortedIds.join('\u0000')}\u0000${parentId}`
    const pendingStore = pendingStoreFixture({
      creations: {},
      messages: {
        [pendingKey]: {
          text: 'Targeted', messageId: String(messageId), targetBotIds: [String(first.id), String(second.id)], replyToMessageId: String(parentId),
        },
      },
    })
    const controller = new BotWorkspaceController(
      remote,
      sessionsFixture().sessions,
      () => 'unexpected response',
      undefined,
      undefined,
      pendingStore,
    )
    await controller.load()
    controller.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(controller.source.getSnapshot().selectedGroup?.messages).toHaveLength(2) })
    const selected = controller.source.getSnapshot().selectedGroup
    expect(selected?.messages[1]).toMatchObject({
      sender: { kind: 'user' }, targetBotIds: [first.id, second.id], replyToMessageId: parentId,
      reactions: [{ emoji: '👍', count: 1, viewerReacted: true }, { emoji: '👀', count: 0 }],
    })
    expect(selected?.deliveries).toEqual([{ messageId, botId: second.id, status: 'failed', error: 'offline' }])

    await controller.face().sendGroupMessage(' Targeted ', undefined, [second.id, first.id].map(String), String(parentId))
    const inspectGroup = remote.inspectGroup
    if (inspectGroup === undefined) throw new Error('group inspection is not mounted')
    expect(inspectGroup).toHaveBeenCalledWith({ groupId: group.id })
    expect(remote.sendGroupMessage).toHaveBeenCalledWith({
      groupId: group.id, text: 'Targeted', messageId,
      targetBotIds: [second.id, first.id], replyToMessageId: parentId,
    })
    await controller.face().reactGroupMessage?.(String(messageId), '👍', 'remove')
    expect(remote.reactGroupMessage).toHaveBeenCalledWith({
      groupId: group.id, messageId, emoji: '👍', action: 'remove',
    })
    controller.face().retryGroup()
    await vi.waitFor(() => { expect(inspectGroup.mock.calls.length).toBeGreaterThanOrEqual(4) })
    controller.dispose()
  })

  it('projects optional group member metadata and availability statuses', async () => {
    const first = bot('bot-group-rich-first', 'Rich preparing', { state: 'provisioning', availability: 'running' })
    const second = bot('bot-group-rich-second', 'Rich working', { availability: 'running' })
    const base = groupView('bot-group-rich', 'Rich metadata', [first, second])
    const richGroup: BotGroupView = {
      ...base,
      bots: [
        { ...base.bots[0]!, description: 'Preparing description', avatar: {
          attachmentId: AttachmentId('group-rich-avatar'), mediaType: 'image/png', bytes: 1, width: 1, height: 1,
        }, state: 'provisioning' },
        { ...base.bots[1]!, availability: 'running' },
      ],
    }
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [richGroup] } }))
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group: richGroup, messages: [] } }))
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()
    controller.face().selectGroup(String(richGroup.id))
    await vi.waitFor(() => { expect(controller.source.getSnapshot().selectedGroup).not.toBeNull() })

    expect(controller.source.getSnapshot().selectedGroup?.bots).toEqual([
      expect.objectContaining({ id: first.id, description: 'Preparing description', status: 'preparing', avatar: richGroup.bots[0]?.avatar }),
      expect.objectContaining({ id: second.id, status: 'working' }),
    ])
    controller.dispose()
  })

  it('restores valid targeted group state and retries a provisioning Bot with its durable fields', async () => {
    const backing = new Map<string, string>()
    const pendingKey = 'group-restored\u0000Restored\u0000bot-a\u0000bot-b'
    backing.set('pending-groups', JSON.stringify({
      creations: {},
      messages: {
        [pendingKey]: { text: 'Restored', messageId: 'restored-message', targetBotIds: ['bot-a', 'bot-b'] },
      },
    }))
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => { backing.set(key, value) },
    })
    const restored = createPendingGroupStore('pending-groups')
    expect(restored.durable).toBe(true)
    expect(restored.read().messages[pendingKey]?.targetBotIds).toEqual(['bot-a', 'bot-b'])

    const provisioning = bot('bot-provisioning', 'session-provisioning', {
      state: 'provisioning',
      description: 'Recover this Bot.',
      persona: 'Keep retrying.',
      capabilities: ['chat', 'retry'],
      agentPreset: 'research-preset',
      skillPolicy: { mode: 'selected', enabled: ['chat'], disabled: [] },
    })
    const active = { ...provisioning, state: 'active' as const, updatedAt: 2 }
    const remote = remoteFixture([provisioning])
    remote.create.mockResolvedValue({ ok: true, value: { bot: active } })
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()
    controller.face().retry()
    await vi.waitFor(() => { expect(remote.create).toHaveBeenCalledOnce() })
    expect(remote.create).toHaveBeenCalledWith({
      id: provisioning.id,
      name: provisioning.name,
      description: provisioning.description,
      identity: provisioning.identity,
      accent: provisioning.accent,
      cwd: provisioning.cwd,
      persona: provisioning.persona,
      capabilities: provisioning.capabilities,
      agentPreset: provisioning.agentPreset,
      skillPolicy: provisioning.skillPolicy,
    })
    controller.dispose()
  })

  it('refreshes the Session catalog after a selected Bot retain failure', async () => {
    const first = bot('bot-catalog-first', 'session-catalog-first')
    const second = bot('bot-catalog-second', 'session-catalog-second')
    const remote = remoteFixture([first, second])
    const refresh = vi.fn<ISessions['refresh']>(async () => {})
    let retainCalls = 0
    const retain = vi.fn<ISessions['retain']>((sessionId) => {
      retainCalls++
      if (retainCalls === 2) throw new Error('Session catalog is stale')
      return reference(typeof sessionId === 'string' ? sessionId : sessionId.childSessionId)
    })
    const sessions = { retain, refresh, list: sessionList(second.sessionId, () => false) } as Pick<ISessions, 'retain' | 'refresh' | 'list'> as ISessions
    const controller = new BotWorkspaceController(remote, sessions, () => 'unexpected response')
    await controller.load()
    controller.face().select(String(second.id))
    await vi.waitFor(() => {
      expect(controller.source.getSnapshot().selectedBotId).toBe(second.id)
      expect(controller.source.getSnapshot().error).toBeNull()
    })
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(controller.face().reference()?.sessionId).toBe(second.sessionId)
    controller.dispose()
  })

  it('propagates optional Remote failures through each mounted manager', async () => {
    const original = bot('bot-optional-failures', 'session-optional-failures')
    const failure = () => new RemoteError('gateway/internal', 'optional action failed', {})
    const remote = remoteFixture([original])
    remote.readGrokHistory = vi.fn<NonNullable<BotWorkspaceRemote['readGrokHistory']>>(async () => ({ ok: false, error: failure() }))
    remote.updateAvatar = vi.fn<NonNullable<BotWorkspaceRemote['updateAvatar']>>(async () => ({ ok: false, error: failure() }))
    remote.uploadAvatar = vi.fn<NonNullable<BotWorkspaceRemote['uploadAvatar']>>(async () => ({ ok: false, error: failure() }))
    remote.updateAppearance = vi.fn<NonNullable<BotWorkspaceRemote['updateAppearance']>>(async () => ({ ok: false, error: failure() }))
    remote.listShareMembers = vi.fn<NonNullable<BotWorkspaceRemote['listShareMembers']>>(async () => ({ ok: false, error: failure() }))
    remote.createShareInvite = vi.fn<NonNullable<BotWorkspaceRemote['createShareInvite']>>(async () => ({ ok: false, error: failure() }))
    remote.revokeShareMember = vi.fn<NonNullable<BotWorkspaceRemote['revokeShareMember']>>(async () => ({ ok: false, error: failure() }))
    remote.getShareMemoryPolicy = vi.fn<NonNullable<BotWorkspaceRemote['getShareMemoryPolicy']>>(async () => ({ ok: false, error: failure() }))
    remote.setShareMemoryPolicy = vi.fn<NonNullable<BotWorkspaceRemote['setShareMemoryPolicy']>>(async () => ({ ok: false, error: failure() }))
    remote.inspectSharedRosterFence = vi.fn<NonNullable<BotWorkspaceRemote['inspectSharedRosterFence']>>(async () => ({ ok: false, error: failure() }))
    remote.recoverSharedRosterFence = vi.fn<NonNullable<BotWorkspaceRemote['recoverSharedRosterFence']>>(async () => ({ ok: false, error: failure() }))
    remote.inspectSharedGroupDeliveryFences = vi.fn<NonNullable<BotWorkspaceRemote['inspectSharedGroupDeliveryFences']>>(async () => ({ ok: false, error: failure() }))
    remote.recoverSharedGroupDelivery = vi.fn<NonNullable<BotWorkspaceRemote['recoverSharedGroupDelivery']>>(async () => ({ ok: false, error: failure() }))
    remote.listMemory = vi.fn<NonNullable<BotWorkspaceRemote['listMemory']>>(async () => ({ ok: false, error: failure() }))
    remote.updateMemory = vi.fn<NonNullable<BotWorkspaceRemote['updateMemory']>>(async () => ({ ok: false, error: failure() }))
    remote.forgetMemory = vi.fn<NonNullable<BotWorkspaceRemote['forgetMemory']>>(async () => ({ ok: false, error: failure() }))
    remote.listSkills = vi.fn<NonNullable<BotWorkspaceRemote['listSkills']>>(async () => ({ ok: false, error: failure() }))
    remote.updateSkills = vi.fn<NonNullable<BotWorkspaceRemote['updateSkills']>>(async () => ({ ok: false, error: new RemoteError(
      'bot/skill-policy-conflict', 'policy changed', { botId: original.id, expectedRevision: 1, actualRevision: 2 },
    ) }))
    const routineFailure = { id: 'routine-failure', paused: false as const, code: 'routine_not_found' as const }
    remote.listRoutines = vi.fn<NonNullable<BotWorkspaceRemote['listRoutines']>>(async () => ({ ok: false, error: failure() }))
    remote.pauseRoutine = vi.fn<NonNullable<BotWorkspaceRemote['pauseRoutine']>>(async () => ({ ok: true, value: routineFailure }))
    remote.resumeRoutine = vi.fn<NonNullable<BotWorkspaceRemote['resumeRoutine']>>(async () => ({ ok: true, value: { id: 'routine-failure', resumed: false as const, code: 'routine_ended' as const } }))
    remote.deleteRoutine = vi.fn<NonNullable<BotWorkspaceRemote['deleteRoutine']>>(async () => ({ ok: true, value: { id: 'routine-failure', deleted: false as const, code: 'routine_not_found' as const } }))
    remote.routineHistory = vi.fn<NonNullable<BotWorkspaceRemote['routineHistory']>>(async () => ({ ok: true, value: { id: 'routine-failure', code: 'delivery_cursor_not_found' as const } }))
    const generation: BotAvatarGenerationRemote = {
      status: vi.fn(async () => ({ ok: false as const, error: failure() })),
      generate: vi.fn(async () => ({ ok: false as const, error: failure() })),
      commit: vi.fn(async () => ({ ok: false as const, error: failure() })),
    }
    const controller = new BotWorkspaceController(
      remote, sessionsFixture().sessions, () => 'unexpected response', generation,
    )
    const face = controller.face()
    await expect(face.readGrokHistory?.(original.id)).rejects.toThrow('optional action failed')
    const editor = face.avatarEditor
    if (editor?.status === undefined || editor.generate === undefined || editor.commit === undefined || editor.update === undefined
      || editor.upload === undefined || editor.updateAppearance === undefined) throw new Error('avatar actions are not mounted')
    await expect(editor.status()).rejects.toThrow('optional action failed')
    await expect(editor.generate({ description: 'Failure path.' })).rejects.toThrow('optional action failed')
    await expect(editor.commit({ data: 'AQID', mediaType: 'image/png' })).rejects.toThrow('optional action failed')
    await expect(editor.update(original.id, null)).rejects.toThrow('optional action failed')
    await expect(editor.upload(original.id, { data: 'AQID', mediaType: 'image/png' })).rejects.toThrow('optional action failed')
    await expect(editor.updateAppearance(original.id, { identity: 'agent', accent: 'violet', clearAvatar: true }))
      .rejects.toThrow('optional action failed')

    const principal = BotPrincipalId('principal-failure')
    const fence = {
      groupId: brandString<BotGroupId>('group-failure'), botId: original.id,
      sessionId: original.sessionId, messageId: brandString<BotGroupMessageId>('bot-group-message-failure'),
    }
    const share = face.share
    if (share === undefined || share.getMemoryPolicy === undefined || share.setMemoryPolicy === undefined
      || share.inspectRosterFence === undefined || share.recoverRosterFence === undefined
      || share.inspectDeliveryFences === undefined || share.recoverDeliveryFence === undefined) throw new Error('share actions are not mounted')
    await expect(share.listMembers(original.id)).rejects.toThrow('optional action failed')
    await expect(share.createInvite(original.id, 'manager')).rejects.toThrow('optional action failed')
    await expect(share.revokeMember(original.id, String(principal))).rejects.toThrow('optional action failed')
    await expect(share.getMemoryPolicy(original.id)).rejects.toThrow('optional action failed')
    await expect(share.setMemoryPolicy(original.id, false)).rejects.toThrow('optional action failed')
    await expect(share.inspectRosterFence()).rejects.toThrow('optional action failed')
    await expect(share.recoverRosterFence('failure-token')).rejects.toThrow('optional action failed')
    await expect(share.inspectDeliveryFences(original.id)).rejects.toThrow('optional action failed')
    await expect(share.recoverDeliveryFence(fence)).rejects.toThrow('optional action failed')

    const memory = face.memoryManager
    if (memory === undefined) throw new Error('memory manager is not mounted')
    await expect(memory.list(original.id)).rejects.toThrow('optional action failed')
    await expect(memory.update(original.id, 'memory-failure', 'Failure')).rejects.toThrow('optional action failed')
    await expect(memory.remove(original.id, 'memory-failure')).rejects.toThrow('optional action failed')
    const skills = face.skillManager
    if (skills === undefined) throw new Error('skill manager is not mounted')
    await expect(skills.list(original.id)).rejects.toThrow('optional action failed')
    await expect(skills.update(original.id, { mode: 'all', enabled: [], disabled: [] }, 1)).rejects.toMatchObject({
      name: 'BotSkillPolicyConflictError', code: 'bot/skill-policy-conflict',
    })
    const routines = face.routineManager
    if (routines === undefined) throw new Error('routine manager is not mounted')
    await expect(routines.list(original.id)).rejects.toThrow('optional action failed')
    await expect(routines.pause(original.id, 'routine-failure')).rejects.toThrow('routine_not_found')
    await expect(routines.resume(original.id, 'routine-failure')).rejects.toThrow('routine_ended')
    await expect(routines.remove(original.id, 'routine-failure')).rejects.toThrow('routine_not_found')
    await expect(routines.history(original.id, 'routine-failure')).rejects.toThrow('delivery_cursor_not_found')
    controller.dispose()
  })

  it('keeps selected group state retryable across inspect and mutation failures', async () => {
    const first = bot('bot-group-failure-first', 'session-group-failure-first')
    const second = bot('bot-group-failure-second', 'session-group-failure-second')
    const group = groupView('group-failure-actions', 'Failure actions', [first, second])
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    remote.inspectGroup = vi.fn()
      .mockRejectedValueOnce(new Error('initial inspect failed'))
      .mockResolvedValueOnce({ ok: true as const, value: { group, messages: [] } })
      .mockRejectedValueOnce(new Error('retry inspect failed'))
    remote.updateGroup = vi.fn()
      .mockRejectedValueOnce(new Error('update transport failed'))
      .mockResolvedValueOnce({ ok: false as const, error: new RemoteError('gateway/internal', 'update rejected', {}) })
    remote.createGroup = vi.fn(async () => ({ ok: false as const, error: new RemoteError('gateway/internal', 'create rejected', {}) }))
    remote.reactGroupMessage = vi.fn(async () => ({ ok: false as const, error: new RemoteError('gateway/internal', 'reaction rejected', {}) }))
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined, pendingStoreFixture())
    await controller.load()
    controller.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(controller.source.getSnapshot().groupError).toBe('initial inspect failed') })
    controller.face().retryGroup()
    await vi.waitFor(() => { expect(controller.source.getSnapshot().selectedGroup?.id).toBe(String(group.id)) })
    controller.face().retryGroup()
    await vi.waitFor(() => { expect(controller.source.getSnapshot().groupError).toBe('retry inspect failed') })

    await expect(controller.face().updateGroup({
      groupId: String(group.id), name: 'Updated failure room', botIds: [String(first.id), String(second.id)],
    })).rejects.toThrow('update transport failed')
    await expect(controller.face().updateGroup({
      groupId: String(group.id), name: 'Updated failure room', botIds: [String(first.id), String(second.id)],
    })).rejects.toThrow('update rejected')
    await expect(controller.face().createGroup({ name: 'Rejected room', botIds: [String(first.id), String(second.id)] }))
      .rejects.toThrow('create rejected')
    await expect(controller.face().reactGroupMessage?.('bot-group-message-reaction-failure', '👍', 'add'))
      .rejects.toThrow('reaction rejected')
    controller.face().selectGroup('missing-group')
    controller.face().selectGroup(String(group.id))
    controller.dispose()
  })

  it('retains retry identities when group persistence fails during create and send cleanup', async () => {
    const first = bot('bot-group-storage-first', 'session-group-storage-first')
    const second = bot('bot-group-storage-second', 'session-group-storage-second')
    const group = groupView('group-storage-failures', 'Storage failures', [first, second])
    const createRemote = remoteFixture([first, second])
    createRemote.createGroup = vi.fn(async () => ({ ok: true as const, value: { group } }))
    let createWrites = 0
    const createStore: BotGroupPendingStore = {
      durable: true,
      read: () => ({ creations: {}, messages: {} }),
      write: () => { createWrites++; return createWrites === 1 },
    }
    const createController = new BotWorkspaceController(
      createRemote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined,
      createStore, key => `localized:${key}`,
    )
    await expect(createController.face().createGroup({ name: 'Storage create cleanup', botIds: [String(first.id), String(second.id)] }))
      .rejects.toThrow('localized:groupCreateRetryCleanupFailed')
    expect(createWrites).toBe(2)
    createController.dispose()

    const sendRemote = remoteFixture([first, second])
    sendRemote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    sendRemote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group, messages: [] } }))
    sendRemote.sendGroupMessage = vi.fn(async request => ({ ok: true as const, value: {
      messageId: request.messageId!, status: 'accepted' as const, deliveries: [],
    } }))
    let sendWrites = 0
    const sendStore: BotGroupPendingStore = {
      durable: true,
      read: () => ({ creations: {}, messages: {} }),
      write: () => { sendWrites++; return sendWrites === 1 },
    }
    const sendController = new BotWorkspaceController(
      sendRemote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined,
      sendStore, key => `localized:${key}`,
    )
    await sendController.load()
    sendController.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(sendController.source.getSnapshot().selectedGroup).not.toBeNull() })
    await expect(sendController.face().sendGroupMessage('Storage send cleanup')).rejects.toThrow('localized:groupSendRetryCleanupFailed')
    expect(sendWrites).toBe(2)
    sendController.dispose()

    const unavailableStore: BotGroupPendingStore = {
      durable: false,
      read: () => ({ creations: {}, messages: {} }),
      write: () => false,
    }
    const unavailableController = new BotWorkspaceController(
      sendRemote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined,
      unavailableStore, key => `localized:${key}`,
    )
    await unavailableController.load()
    unavailableController.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(unavailableController.source.getSnapshot().selectedGroup).not.toBeNull() })
    await expect(unavailableController.face().sendGroupMessage('No durable id')).rejects.toThrow('localized:groupRetryUnavailable')
    unavailableController.dispose()
  })

  it('reuses admitted attachments and reports attachment admission failures', async () => {
    const first = bot('bot-group-attachment-retry-first', 'session-group-attachment-retry-first')
    const second = bot('bot-group-attachment-retry-second', 'session-group-attachment-retry-second')
    const group = groupView('bot-group-attachment-retry', 'Attachment retry', [first, second])
    const messageId = brandString<BotGroupMessageId>('bot-group-message-attachment-retry')
    const replyId = brandString<BotGroupMessageId>('bot-group-message-attachment-parent')
    const detail: BotGroupInspectValue = {
      group,
      messages: [{
        id: messageId,
        groupId: group.id,
        sender: { kind: 'user' },
        text: 'Retry image',
        targetBotIds: [first.id],
        replyToMessageId: replyId,
        attachments: [{ type: 'image', attachmentId: 'attachment-retry', mediaType: 'image/png', bytes: 3, width: 1, height: 1, name: 'retry.png' }],
        createdAt: 1,
      }],
    }
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: detail }))
    remote.sendGroupMessage = vi.fn(async request => ({ ok: true as const, value: {
      messageId: request.messageId!, status: 'accepted' as const, deliveries: [],
    } }))
    const admitGroupImage = vi.fn<NonNullable<BotWorkspaceRemote['admitGroupImage']>>(async () => ({
      ok: false, error: new RemoteError('gateway/internal', 'image admission failed', {}),
    }))
    remote.admitGroupImage = admitGroupImage
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response', undefined, () => 'delivery failed', pendingStoreFixture())
    await controller.load()
    controller.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(controller.source.getSnapshot().selectedGroup).not.toBeNull() })
    const draft = { id: 'retry-image', file: new File([new Uint8Array([1, 2, 3])], 'retry.png', { type: 'image/png' }), state: 'ready' as const }
    await controller.face().sendGroupMessageWithAttachments('Retry image', [draft], String(messageId), [String(first.id)], String(replyId))
    expect(remote.sendGroupMessage).toHaveBeenCalledWith({
      groupId: group.id, text: 'Retry image', messageId, targetBotIds: [first.id], replyToMessageId: replyId,
    })
    await expect(controller.face().sendGroupMessageWithAttachments('Bad reply', [draft], undefined, [String(first.id)], 'invalid-parent'))
      .rejects.toThrow('delivery failed')
    await expect(controller.face().sendGroupMessageWithAttachments('Needs admission', [draft], 'bot-group-message-new-admission'))
      .rejects.toThrow('image admission failed')
    expect(admitGroupImage).toHaveBeenCalled()
    controller.dispose()
  })

  it('uploads a non-image attachment through the default browser fetch carrier', async () => {
    const first = bot('bot-attachment-file-first', 'session-attachment-file-first')
    const second = bot('bot-attachment-file-second', 'session-attachment-file-second')
    const group = groupView('bot-group-attachment-file', 'Attachment file room', [first, second])
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group, messages: [] } }))
    remote.sendGroupMessage = vi.fn(async request => ({
      ok: true as const,
      value: { messageId: request.messageId!, status: 'accepted' as const, deliveries: [] },
    }))
    const fetcher = vi.fn<BotAttachmentFetch>(async () => new Response(JSON.stringify({
      ok: true,
      value: { grantId: 'bot-attachment-grant-file', attachments: [{ type: 'file', name: 'notes.txt', bytes: 5 }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetcher)
    expect(globalThis.fetch).toBe(fetcher)
    const controller = new BotWorkspaceController(
      remote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined, pendingStoreFixture(),
    )
    await controller.load()
    controller.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(controller.source.getSnapshot().selectedGroup).not.toBeNull() })

    await controller.face().sendGroupMessageWithAttachments(
      'Review this file',
      [{ id: 'draft-file', file: new File(['hello'], 'notes.txt', { type: 'text/plain' }), state: 'ready' }],
      'bot-group-message-file',
    )

    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/api/bots/group/uploadAttachment')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
    expect(remote.sendGroupMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'bot-group-message-file', attachmentGrants: ['bot-attachment-grant-file'],
    }))
    controller.dispose()
  })

  it('covers omitted and rejected template actions at their remote boundary', async () => {
    const source = bot('bot-template-action-boundaries', 'session-template-action-boundaries')
    const template = templateView('bot-template-action-boundaries', 'bot-template-action-code')
    const remote = remoteFixture([source])
    remote.listTemplates = vi.fn(async () => ({ ok: true as const, value: { templates: [template] } }))
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()
    const actions = controller.face().templateActions
    if (actions === undefined) throw new Error('template actions are not mounted')

    await expect(actions.publishTemplate({ botId: source.id })).rejects.toThrow('unexpected response')
    remote.publishTemplate = vi.fn<NonNullable<BotWorkspaceRemote['publishTemplate']>>()
      .mockRejectedValueOnce('publish failed')
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'publish rejected', {}) })
    await expect(actions.publishTemplate({ botId: source.id })).rejects.toThrow('publish failed')
    await expect(actions.publishTemplate({ botId: source.id })).rejects.toThrow('publish rejected')

    await expect(actions.revokeTemplate(String(template.id))).rejects.toThrow('unexpected response')
    remote.revokeTemplate = vi.fn<NonNullable<BotWorkspaceRemote['revokeTemplate']>>()
      .mockRejectedValueOnce('revoke failed')
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'revoke rejected', {}) })
    await expect(actions.revokeTemplate(String(template.id))).rejects.toThrow('revoke failed')
    await expect(actions.revokeTemplate(String(template.id))).rejects.toThrow('revoke rejected')

    await expect(actions.previewTemplate('')).rejects.toThrow('unexpected response')
    await expect(actions.previewTemplate('bot-template-action-code')).rejects.toThrow('unexpected response')
    remote.previewTemplate = vi.fn<NonNullable<BotWorkspaceRemote['previewTemplate']>>()
      .mockRejectedValueOnce('preview failed')
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'preview rejected', {}) })
    await expect(actions.previewTemplate()).rejects.toThrow('preview failed')
    await expect(actions.previewTemplate()).rejects.toThrow('preview rejected')

    const malformedPermissions = wireFixture<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['previewTemplate']>>>>({
      ok: true,
      value: { template, localPermissions: { status: 'resolved', tools: ['chat', 'chat'] }, approvalToken: 'preview-token' },
    })
    remote.previewTemplate = vi.fn(async () => malformedPermissions)
    await expect(actions.previewTemplate()).rejects.toThrow('unexpected response')

    remote.previewTemplate = vi.fn(async () => ({
      ok: true as const, value: { template, localPermissions, approvalToken: 'invalid token' },
    }))
    await expect(actions.previewTemplate()).rejects.toThrow('unexpected response')
    remote.previewTemplate = vi.fn(async () => ({
      ok: true as const,
      value: { template: { ...template, shareCode: brandString<BotTemplateShareCode>('other-code') }, localPermissions, approvalToken: 'preview-token' },
    }))
    await expect(actions.previewTemplate()).rejects.toThrow('unexpected response')

    remote.previewTemplate = vi.fn(async () => ({ ok: true as const, value: { template, localPermissions, approvalToken: 'preview-token' } }))
    actions.setTemplateCode(String(template.shareCode))
    await actions.previewTemplate()
    await expect(actions.importTemplate()).rejects.toThrow('unexpected response')
    remote.importTemplate = vi.fn<NonNullable<BotWorkspaceRemote['importTemplate']>>()
      .mockResolvedValue({ ok: true, value: { bot: source, template } })

    actions.setTemplateCode('')
    await expect(actions.importTemplate()).rejects.toThrow('unexpected response')
    actions.setTemplateCode(String(template.shareCode))
    await actions.previewTemplate()
    await expect(actions.importTemplate()).rejects.toThrow('unexpected response')

    remote.approveTemplate = vi.fn<NonNullable<BotWorkspaceRemote['approveTemplate']>>()
      .mockRejectedValueOnce('approval failed')
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'approval rejected', {}) })
    await expect(actions.importTemplate()).rejects.toThrow('approval failed')
    await expect(actions.importTemplate()).rejects.toThrow('approval rejected')

    const malformedApproval = wireFixture<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['approveTemplate']>>>>({
      ok: true,
      value: { template: { ...template, approved: true }, localPermissions: { status: 'resolved', tools: ['chat', 'chat'] } },
    })
    remote.approveTemplate = vi.fn(async () => malformedApproval)
    await expect(actions.importTemplate()).rejects.toThrow('unexpected response')

    remote.approveTemplate = vi.fn(async () => ({
      ok: true as const, value: { template: { ...template, approved: true }, localPermissions },
    }))
    remote.importTemplate = vi.fn<NonNullable<BotWorkspaceRemote['importTemplate']>>()
      .mockRejectedValueOnce('import failed')
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'import rejected', {}) })
    await expect(actions.importTemplate()).rejects.toThrow('import failed')
    await expect(actions.importTemplate()).rejects.toThrow('import rejected')
    const approvalResult = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['approveTemplate']>>>>()
    remote.approveTemplate = vi.fn(async () => approvalResult.promise)
    remote.importTemplate = vi.fn(async () => ({ ok: true as const, value: { bot: source, template } }))
    actions.setTemplateCode(String(template.shareCode))
    await actions.previewTemplate()
    const importing = actions.importTemplate()
    await vi.waitFor(() => { expect(remote.approveTemplate).toHaveBeenCalledOnce() })
    actions.setTemplateCode('changed while approval is pending')
    approvalResult.resolve({ ok: true, value: { template: { ...template, approved: true }, localPermissions } })
    await expect(importing).rejects.toThrow('unexpected response')

    const revokeResult = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['revokeTemplate']>>>>()
    remote.revokeTemplate = vi.fn(async () => revokeResult.promise)
    const revoking = actions.revokeTemplate(String(template.id))
    await vi.waitFor(() => { expect(remote.revokeTemplate).toHaveBeenCalledOnce() })
    const beforeDisposedRevoke = controller.source.getSnapshot()
    const templateReadsBeforeRevoke = remote.listTemplates?.mock.calls.length ?? 0
    controller.dispose()
    revokeResult.resolve({ ok: true, value: { template } })
    await expect(revoking).resolves.toBeUndefined()
    expect(controller.source.getSnapshot()).toEqual(beforeDisposedRevoke)
    expect(remote.listTemplates?.mock.calls.length ?? 0).toBe(templateReadsBeforeRevoke)
  })

  it('guards disposed selections and group actions across remote lifecycle failures', async () => {
    const first = bot('bot-group-boundary-first', 'session-group-boundary-first')
    const second = bot('bot-group-boundary-second', 'session-group-boundary-second')
    const group = groupView('bot-group-boundary', 'Boundary room', [first, second])

    const renameRemote = remoteFixture([first])
    renameRemote.rename
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'rename rejected', {}) })
      .mockResolvedValueOnce({ ok: true, value: { bot: { ...first, updatedAt: 0, name: 'stale name' } } })
    const renameController = new BotWorkspaceController(renameRemote, sessionsFixture().sessions, () => 'unexpected response')
    await renameController.load()
    await expect(renameController.face().rename(first.id, 'Rejected')).rejects.toThrow('rename rejected')
    await renameController.face().rename(first.id, 'stale name')
    expect(renameController.source.getSnapshot().bots[0]?.name).toBe(first.name)
    renameController.dispose()

    const disposedRemote = remoteFixture([first])
    disposedRemote.listTemplates = vi.fn(async () => ({ ok: true as const, value: { templates: [] } }))
    const disposedController = new BotWorkspaceController(disposedRemote, sessionsFixture().sessions, () => 'unexpected response')
    const disposedFace = disposedController.face()
    disposedController.dispose()
    await disposedController.load()
    disposedFace.select(first.id)
    disposedFace.selectGroup(String(group.id))
    disposedFace.retry()
    disposedController.bumpRoutineRevision()
    disposedFace.templateActions?.setTemplateCode('ignored after disposal')
    await disposedFace.templateActions?.publishTemplate({ botId: first.id })
    await disposedFace.createGroup({ name: group.name, botIds: [first.id], groupId: 'disposed-group-create' })

    const missingRemote: BotRemoteMocks = remoteFixture([first, second])
    missingRemote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    missingRemote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group, messages: [] } }))
    delete missingRemote.createGroup
    delete missingRemote.updateGroup
    const missingController = new BotWorkspaceController(missingRemote, sessionsFixture().sessions, () => 'unexpected response')
    const missingFace = missingController.face()
    await missingController.load()
    missingFace.select('unknown-bot')
    missingFace.select(first.id)
    await expect(missingFace.createGroup({ name: group.name, botIds: [first.id], groupId: 'explicit-missing-create' }))
      .rejects.toThrow('unexpected response')
    await expect(missingFace.updateGroup({ groupId: String(group.id), name: group.name, botIds: [first.id] }))
      .rejects.toThrow('unexpected response')
    missingFace.selectGroup(String(group.id))
    await vi.waitFor(() => { expect(missingController.source.getSnapshot().selectedGroup).not.toBeNull() })
    await expect(missingFace.sendGroupMessage('Bad reply', undefined, undefined, 'invalid-parent'))
      .rejects.toThrow('unexpected response')
    const missingSend = missingFace.sendGroupMessage
    delete missingRemote.sendGroupMessage
    await expect(missingSend('No sender')).rejects.toThrow('unexpected response')
    missingController.dispose()

    const inspectMissingRemote = remoteFixture([first, second])
    inspectMissingRemote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    delete inspectMissingRemote.inspectGroup
    const inspectMissingController = new BotWorkspaceController(inspectMissingRemote, sessionsFixture().sessions, () => 'unexpected response')
    await inspectMissingController.load()
    inspectMissingController.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(inspectMissingController.source.getSnapshot().groupError).toBe('unexpected response') })
    inspectMissingController.dispose()

    const inspectRemote = remoteFixture([first, second])
    const otherGroup = groupView('bot-group-boundary-other', 'Other room', [first, second])
    const thirdGroup = groupView('bot-group-boundary-third', 'Third room', [first, second])
    inspectRemote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group, otherGroup, thirdGroup] } }))
    const firstInspect = Promise.withResolvers<RemoteResult<BotGroupInspectValue>>()
    inspectRemote.inspectGroup = vi.fn()
      .mockImplementationOnce(async () => firstInspect.promise)
      .mockRejectedValueOnce('inspect failed')
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'inspect rejected', {}) })
    const inspectController = new BotWorkspaceController(inspectRemote, sessionsFixture().sessions, () => 'unexpected response')
    await inspectController.load()
    const inspectFace = inspectController.face()
    inspectFace.selectGroup(String(group.id))
    inspectFace.selectGroup(String(otherGroup.id))
    firstInspect.resolve({ ok: true, value: { group, messages: [] } })
    await vi.waitFor(() => { expect(inspectController.source.getSnapshot().groupError).toBe('inspect failed') })
    inspectFace.selectGroup(String(thirdGroup.id))
    await vi.waitFor(() => { expect(inspectController.source.getSnapshot().groupError).toBe('inspect rejected') })
    inspectController.dispose()

    const createRemote = remoteFixture([first, second])
    const createResult = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['createGroup']>>>>()
    createRemote.createGroup
      .mockRejectedValueOnce('create failed')
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'create rejected', {}) })
      .mockImplementationOnce(async () => createResult.promise)
    const createController = new BotWorkspaceController(createRemote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined, pendingStoreFixture())
    const createFace = createController.face()
    const creation = (groupId: string) => ({ name: group.name, botIds: [first.id, second.id], groupId })
    await expect(createFace.createGroup(creation('explicit-create-error'))).rejects.toThrow('create failed')
    await expect(createFace.createGroup(creation('explicit-create-rejected'))).rejects.toThrow('create rejected')
    const creating = createFace.createGroup(creation('explicit-create-disposed'))
    await vi.waitFor(() => { expect(createRemote.createGroup).toHaveBeenCalledTimes(3) })
    const beforeDisposedCreate = createController.source.getSnapshot()
    createController.dispose()
    createResult.resolve({ ok: true, value: { group } })
    await expect(creating).resolves.toBeUndefined()
    expect(createController.source.getSnapshot()).toEqual(beforeDisposedCreate)
    expect(createRemote.list).not.toHaveBeenCalled()

    const updateRemote = remoteFixture([first, second])
    const updateResult = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['updateGroup']>>>>()
    updateRemote.updateGroup = vi.fn<NonNullable<BotWorkspaceRemote['updateGroup']>>()
      .mockRejectedValueOnce('update failed')
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'update rejected', {}) })
      .mockImplementationOnce(async () => updateResult.promise)
    const updateController = new BotWorkspaceController(updateRemote, sessionsFixture().sessions, () => 'unexpected response')
    const updateFace = updateController.face()
    const update = { groupId: String(group.id), name: group.name, botIds: [first.id, second.id] }
    await expect(updateFace.updateGroup(update)).rejects.toThrow('update failed')
    await expect(updateFace.updateGroup(update)).rejects.toThrow('update rejected')
    const updating = updateFace.updateGroup(update)
    await vi.waitFor(() => { expect(updateRemote.updateGroup).toHaveBeenCalledTimes(3) })
    const beforeDisposedUpdate = updateController.source.getSnapshot()
    updateController.dispose()
    updateResult.resolve({ ok: true, value: { group } })
    await expect(updating).resolves.toBeUndefined()
    expect(updateController.source.getSnapshot()).toEqual(beforeDisposedUpdate)
    expect(updateRemote.list).not.toHaveBeenCalled()

    const sendRemote = remoteFixture([first, second])
    sendRemote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    sendRemote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group, messages: [] } }))
    const sendResult = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['sendGroupMessage']>>>>()
    sendRemote.sendGroupMessage = vi.fn<NonNullable<BotWorkspaceRemote['sendGroupMessage']>>()
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'send rejected', {}) })
      .mockImplementationOnce(async () => sendResult.promise)
    sendRemote.reactGroupMessage = vi.fn<NonNullable<BotWorkspaceRemote['reactGroupMessage']>>()
      .mockResolvedValue({ ok: true, value: {
        messageId: brandString<BotGroupMessageId>('reaction-message'),
        reactions: [{ emoji: '👍', count: 1, viewerReacted: true }],
      } })
    const sendController = new BotWorkspaceController(sendRemote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined, pendingStoreFixture())
    await sendController.load()
    const sendFace = sendController.face()
    sendFace.selectGroup(String(group.id))
    await vi.waitFor(() => { expect(sendController.source.getSnapshot().selectedGroup).not.toBeNull() })
    await expect(sendFace.sendGroupMessage('Rejected send')).rejects.toThrow('send rejected')
    const react = sendFace.reactGroupMessage
    if (react === undefined) throw new Error('reaction action is not mounted')
    delete sendRemote.reactGroupMessage
    await expect(react('reaction-message', '👍', 'add')).rejects.toThrow('unexpected response')
    const sending = sendFace.sendGroupMessage('Disposed send', 'explicit-disposed-message')
    await vi.waitFor(() => { expect(sendRemote.sendGroupMessage).toHaveBeenCalledTimes(2) })
    const beforeDisposedSend = sendController.source.getSnapshot()
    const sendReadsBeforeDispose = {
      list: sendRemote.list.mock.calls.length,
      groups: sendRemote.listGroups?.mock.calls.length ?? 0,
      inspect: sendRemote.inspectGroup?.mock.calls.length ?? 0,
    }
    sendController.dispose()
    sendResult.resolve({ ok: true, value: { messageId: brandString<BotGroupMessageId>('explicit-disposed-message'), status: 'accepted', deliveries: [] } })
    await expect(sending).resolves.toBeUndefined()
    expect(sendController.source.getSnapshot()).toEqual(beforeDisposedSend)
    expect(sendRemote.list.mock.calls.length).toBe(sendReadsBeforeDispose.list)
    expect(sendRemote.listGroups?.mock.calls.length ?? 0).toBe(sendReadsBeforeDispose.groups)
    expect(sendRemote.inspectGroup?.mock.calls.length ?? 0).toBe(sendReadsBeforeDispose.inspect)
  })

  it('fails closed for attachment sends before admission, reconciliation, and delivery', async () => {
    const first = bot('bot-attachment-boundary-first', 'session-attachment-boundary-first')
    const second = bot('bot-attachment-boundary-second', 'session-attachment-boundary-second')
    const group = groupView('bot-group-attachment-boundary', 'Attachment boundary', [first, second])
    const fileDraft = { id: 'boundary-file', file: new File(['hello'], 'notes.txt', { type: 'text/plain' }), state: 'ready' as const }
    const imageDraft = { id: 'boundary-image', file: new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' }), state: 'ready' as const }

    const noSelectionRemote = remoteFixture([first, second])
    const noSelectionController = new BotWorkspaceController(noSelectionRemote, sessionsFixture().sessions, () => 'unexpected response')
    await expect(noSelectionController.face().sendGroupMessageWithAttachments('No group', [fileDraft]))
      .rejects.toThrow('unexpected response')
    noSelectionController.dispose()

    const remote: BotRemoteMocks = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group, messages: [] } }))
    remote.sendGroupMessage = vi.fn<NonNullable<BotWorkspaceRemote['sendGroupMessage']>>()
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'attachment send rejected', {}) })
      .mockResolvedValueOnce({ ok: true, value: {
        messageId: brandString<BotGroupMessageId>('bot-group-message-attachment-partial'), status: 'partial', deliveries: [],
      } })
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response', undefined, () => 'delivery failed')
    await controller.load()
    const face = controller.face()
    face.selectGroup(String(group.id))
    await vi.waitFor(() => { expect(controller.source.getSnapshot().selectedGroup).not.toBeNull() })
    await expect(face.sendGroupMessageWithAttachments('Empty', [])).rejects.toThrow('unexpected response')

    const send = face.sendGroupMessageWithAttachments
    delete remote.sendGroupMessage
    await expect(send('No sender', [fileDraft])).rejects.toThrow('unexpected response')
    remote.sendGroupMessage = vi.fn<NonNullable<BotWorkspaceRemote['sendGroupMessage']>>()
      .mockResolvedValueOnce({ ok: true, value: {
        messageId: brandString<BotGroupMessageId>('bot-group-message-admission'), status: 'accepted', deliveries: [],
      } })
    delete remote.admitGroupImage
    await expect(send('No image admission', [imageDraft])).rejects.toThrow('unexpected response')

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true, value: { grantId: 'bot-attachment-grant-boundary', attachments: [{ type: 'file', name: 'notes.txt', bytes: 5 }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    remote.sendGroupMessage = vi.fn<NonNullable<BotWorkspaceRemote['sendGroupMessage']>>()
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'attachment send rejected', {}) })
      .mockResolvedValueOnce({ ok: true, value: {
        messageId: brandString<BotGroupMessageId>('bot-group-message-attachment-partial'), status: 'partial', deliveries: [],
      } })

    remote.inspectGroup = vi.fn(async () => { throw 'transcript transport failed' })
    await expect(send('Transcript unavailable', [fileDraft])).rejects.toThrow('transcript transport failed')

    const existingId = brandString<BotGroupMessageId>('bot-group-message-attachment-mismatch')
    remote.inspectGroup = vi.fn<NonNullable<BotWorkspaceRemote['inspectGroup']>>(async () => ({ ok: true as const, value: {
      group,
      messages: [{
        id: existingId, groupId: group.id, sender: { kind: 'user' as const }, text: 'Existing file', createdAt: 1,
        targetBotIds: [first.id, second.id],
        attachments: [{ type: 'file' as const, attachmentId: 'attachment-other', name: 'other.txt', bytes: 5 }],
      }],
    } }))
    await expect(send('Existing file', [fileDraft], String(existingId))).rejects.toThrow('attachments differ')

    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group, messages: [] } }))
    await expect(send('Rejected attachment send', [fileDraft], 'bot-group-message-attachment-rejected'))
      .rejects.toThrow('attachment send rejected')
    await expect(send('Partial attachment send', [fileDraft], 'bot-group-message-attachment-partial'))
      .rejects.toThrow('delivery failed')

    const deferred = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['sendGroupMessage']>>>>()
    remote.sendGroupMessage = vi.fn<NonNullable<BotWorkspaceRemote['sendGroupMessage']>>()
      .mockImplementation(async () => deferred.promise)
    const sending = send('Disposed attachment send', [fileDraft], 'bot-group-message-attachment-disposed')
    await vi.waitFor(() => { expect(remote.sendGroupMessage).toHaveBeenCalledOnce() })
    const beforeDisposedAttachmentSend = controller.source.getSnapshot()
    const attachmentReadsBeforeDispose = remote.inspectGroup?.mock.calls.length ?? 0
    controller.dispose()
    deferred.resolve({ ok: true, value: {
      messageId: brandString<BotGroupMessageId>('bot-group-message-attachment-disposed'), status: 'accepted', deliveries: [],
    } })
    await expect(sending).resolves.toBeUndefined()
    expect(controller.source.getSnapshot()).toEqual(beforeDisposedAttachmentSend)
    expect(remote.inspectGroup?.mock.calls.length ?? 0).toBe(attachmentReadsBeforeDispose)
  })

  it('preserves callback ownership when group persistence and refreshes fail', async () => {
    const first = bot('bot-group-callback-first', 'session-group-callback-first')
    const second = bot('bot-group-callback-second', 'session-group-callback-second')
    const group = groupView('bot-group-callback', 'Callback room', [first, second])
    const failingStore: BotGroupPendingStore = {
      durable: true,
      read: () => ({ creations: {}, messages: {} }),
      write: () => false,
    }
    const sendRemote = remoteFixture([first, second])
    sendRemote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    sendRemote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group, messages: [] } }))
    sendRemote.sendGroupMessage = vi.fn(async request => ({ ok: true as const, value: {
      messageId: request.messageId!, status: 'accepted' as const, deliveries: [],
    } }))
    const sendController = new BotWorkspaceController(
      sendRemote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined,
      failingStore, key => `localized:${key}`,
    )
    await sendController.load()
    const sendFace = sendController.face()
    sendFace.selectGroup(String(group.id))
    await vi.waitFor(() => { expect(sendController.source.getSnapshot().selectedGroup).not.toBeNull() })
    await expect(sendFace.sendGroupMessage('Storage refuses')).rejects.toThrow('localized:groupSendRetryUnavailable')
    sendController.dispose()

    const mismatchRemote = remoteFixture([first, second])
    const mismatchMessageId = brandString<BotGroupMessageId>('bot-group-message-target-mismatch')
    mismatchRemote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    mismatchRemote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: {
      group,
      messages: [{
        id: mismatchMessageId, groupId: group.id, sender: { kind: 'user' as const }, text: 'Target mismatch',
        targetBotIds: [first.id], createdAt: 1,
      }],
    } }))
    mismatchRemote.sendGroupMessage = vi.fn(async request => ({ ok: true as const, value: {
      messageId: request.messageId!, status: 'accepted' as const, deliveries: [],
    } }))
    const mismatchKey = `${group.id}\u0000Target mismatch\u0000`
    const mismatchStore = pendingStoreFixture({ creations: {}, messages: {
      [mismatchKey]: { text: 'Target mismatch', messageId: String(mismatchMessageId) },
    } })
    const retryMismatchController = new BotWorkspaceController(mismatchRemote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined, mismatchStore)
    await retryMismatchController.load()
    const mismatchFace = retryMismatchController.face()
    mismatchFace.selectGroup(String(group.id))
    await vi.waitFor(() => { expect(retryMismatchController.source.getSnapshot().selectedGroup).not.toBeNull() })
    await expect(mismatchFace.sendGroupMessage('Target mismatch', String(mismatchMessageId))).rejects.toThrow('content differs')
    retryMismatchController.dispose()

    const reactionResult = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['reactGroupMessage']>>>>()
    const reactionRemote = remoteFixture([first, second])
    reactionRemote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    reactionRemote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group, messages: [] } }))
    reactionRemote.reactGroupMessage = vi.fn(async () => reactionResult.promise)
    const reactionController = new BotWorkspaceController(reactionRemote, sessionsFixture().sessions, () => 'unexpected response')
    await reactionController.load()
    const reactionFace = reactionController.face()
    reactionFace.selectGroup(String(group.id))
    await vi.waitFor(() => { expect(reactionController.source.getSnapshot().selectedGroup).not.toBeNull() })
    const reacting = reactionFace.reactGroupMessage?.('bot-group-message-callback', '👍', 'add')
    await vi.waitFor(() => { expect(reactionRemote.reactGroupMessage).toHaveBeenCalledOnce() })
    const beforeDisposedReaction = reactionController.source.getSnapshot()
    const reactionReadsBeforeDispose = reactionRemote.inspectGroup?.mock.calls.length ?? 0
    reactionController.dispose()
    reactionResult.resolve({ ok: true, value: {
      messageId: brandString<BotGroupMessageId>('bot-group-message-callback'),
      reactions: [{ emoji: '👍', count: 1, viewerReacted: true }],
    } })
    await expect(reacting).resolves.toBeUndefined()
    expect(reactionController.source.getSnapshot()).toEqual(beforeDisposedReaction)
    expect(reactionRemote.inspectGroup?.mock.calls.length ?? 0).toBe(reactionReadsBeforeDispose)

    const retryRemote = remoteFixture([])
    const retryController = new BotWorkspaceController(retryRemote, sessionsFixture().sessions, () => 'unexpected response')
    await retryController.load()
    retryController.face().retryGroup()
    await vi.waitFor(() => { expect(retryRemote.list).toHaveBeenCalledTimes(2) })
    retryController.dispose()

    const firstInspect = Promise.withResolvers<RemoteResult<BotGroupInspectValue>>()
    const staleRemote = remoteFixture([first, second])
    const secondGroup = groupView('bot-group-callback-second', 'Second callback room', [first, second])
    staleRemote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group, secondGroup] } }))
    staleRemote.inspectGroup = vi.fn()
      .mockImplementationOnce(async () => firstInspect.promise)
      .mockResolvedValue({ ok: true, value: { group: secondGroup, messages: [] } })
    const staleController = new BotWorkspaceController(staleRemote, sessionsFixture().sessions, () => 'unexpected response')
    await staleController.load()
    const staleFace = staleController.face()
    staleFace.selectGroup(String(group.id))
    staleFace.selectGroup(String(secondGroup.id))
    firstInspect.reject(new Error('stale group failed'))
    await vi.waitFor(() => { expect(staleController.source.getSnapshot().selectedGroup?.id).toBe(String(secondGroup.id)) })
    staleController.dispose()

    const disposedInspect = Promise.withResolvers<RemoteResult<BotGroupInspectValue>>()
    const disposedInspectRemote = remoteFixture([first, second])
    disposedInspectRemote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    disposedInspectRemote.inspectGroup = vi.fn(() => disposedInspect.promise)
    const disposedInspectController = new BotWorkspaceController(disposedInspectRemote, sessionsFixture().sessions, () => 'unexpected response')
    await disposedInspectController.load()
    disposedInspectController.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(disposedInspectRemote.inspectGroup).toHaveBeenCalledOnce() })
    const beforeDisposedInspect = disposedInspectController.source.getSnapshot()
    disposedInspectController.dispose()
    disposedInspect.reject(new Error('disposed group failed'))
    await expect(disposedInspect.promise).rejects.toThrow('disposed group failed')
    expect(disposedInspectController.source.getSnapshot()).toEqual(beforeDisposedInspect)
    expect(disposedInspectRemote.inspectGroup).toHaveBeenCalledOnce()
  })

  it('reconciles lost Bot creation responses and releases stale Session callbacks', async () => {
    const source = bot('bot-create-reconcile-source', 'session-create-reconcile-source')
    let requestId: BotView['id'] | undefined
    const reconciledRemote = remoteFixture([])
    reconciledRemote.create.mockImplementation(async (request) => {
      requestId = request.id
      return { ok: false, error: new RemoteError('gateway/internal', 'response lost', {}) }
    })
    reconciledRemote.list.mockImplementation(async () => ({
      ok: true as const,
      value: { bots: requestId === undefined ? [] : [bot(String(requestId), 'session-reconciled')] },
    }))
    const reconciledController = new BotWorkspaceController(reconciledRemote, sessionsFixture().sessions, () => 'unexpected response')
    await expect(reconciledController.face().create({ name: 'Reconciled', identity: 'agent', accent: 'violet' })).resolves.toBeUndefined()
    expect(reconciledController.source.getSnapshot().bots[0]?.id).toBe(requestId)
    reconciledController.dispose()

    const rejectedRemote = remoteFixture([])
    rejectedRemote.create.mockResolvedValue({ ok: false, error: new RemoteError('gateway/internal', 'create rejected', {}) })
    const rejectedController = new BotWorkspaceController(rejectedRemote, sessionsFixture().sessions, () => 'unexpected response')
    await expect(rejectedController.face().create({ name: 'Rejected', identity: 'agent', accent: 'violet' }))
      .rejects.toThrow('create rejected')
    rejectedController.dispose()

    const mismatchRemote = remoteFixture([])
    mismatchRemote.create.mockResolvedValue({ ok: true, value: { bot: source } })
    const mismatchController = new BotWorkspaceController(mismatchRemote, sessionsFixture().sessions, () => 'unexpected response')
    await expect(mismatchController.face().create({ name: 'Mismatch', identity: 'agent', accent: 'violet' }))
      .rejects.toThrow('unexpected response')
    mismatchController.dispose()

    const active = bot('bot-create-active', 'session-create-active')
    const retryRemote = remoteFixture([])
    retryRemote.create.mockImplementation(async request => ({
      ok: true as const, value: { bot: { ...active, id: request.id ?? active.id } },
    }))
    const retrySessions = sessionsFixture()
    const retrySessionService = sessionsWithList(retrySessions, sessionList(active.sessionId, () => false))
    retrySessions.refresh.mockRejectedValueOnce('session catalog unavailable')
    retrySessions.retain.mockImplementation(() => { throw 'session catalog unavailable' })
    const retryController = new BotWorkspaceController(retryRemote, retrySessionService, () => 'unexpected response')
    await retryController.face().create({ name: 'Active', identity: 'agent', accent: 'violet' })
    expect(retryController.source.getSnapshot().error).toBe('session catalog unavailable')
    retryController.dispose()

    const staleReady = Promise.withResolvers<SessionBinding>()
    const first = bot('bot-stale-reference-first', 'session-stale-reference-first')
    const second = bot('bot-stale-reference-second', 'session-stale-reference-second')
    const firstReference = reference(first.sessionId, staleReady.promise)
    const retainSessions = sessionsFixture()
    retainSessions.retain.mockImplementation(sessionId => sessionId === first.sessionId ? firstReference : reference(sessionId))
    const retainController = new BotWorkspaceController(remoteFixture([first, second]), retainSessions.sessions, () => 'unexpected response')
    await retainController.load()
    retainController.face().select(second.id)
    const beforeStaleReference = retainController.source.getSnapshot()
    staleReady.reject(new Error('stale reference failed'))
    await expect(staleReady.promise).rejects.toThrow('stale reference failed')
    expect(retainController.source.getSnapshot()).toEqual(beforeStaleReference)
    retainController.dispose()

    const disposedOrganization = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['updateOrganization']>>>>()
    const organizationRemote = remoteFixture([source])
    organizationRemote.updateOrganization = vi.fn(async () => disposedOrganization.promise)
    const organizationController = new BotWorkspaceController(organizationRemote, sessionsFixture().sessions, () => 'unexpected response')
    const organizing = organizationController.face().organize?.(source.id, { pinned: true })
    const beforeDisposedOrganization = organizationController.source.getSnapshot()
    organizationController.dispose()
    disposedOrganization.reject('organization transport failed')
    await expect(organizing).resolves.toBeUndefined()
    expect(organizationController.source.getSnapshot()).toEqual(beforeDisposedOrganization)
    expect(organizationRemote.list).not.toHaveBeenCalled()
  })

  it('covers optional action identity checks and omitted lifecycle remotes', async () => {
    const original = bot('bot-optional-boundary', 'session-optional-boundary')
    const other = bot('bot-optional-boundary-other', 'session-optional-boundary-other')
    const principal = BotPrincipalId('principal-optional-boundary')
    const fence = {
      groupId: brandString<BotGroupId>('bot-group-optional-boundary'), botId: original.id,
      sessionId: original.sessionId, messageId: brandString<BotGroupMessageId>('bot-group-message-optional-boundary'),
    }
    const routine = {
      kind: 'event' as const, id: 'routine-optional-boundary', title: 'Review', prompt: 'Review.',
      trigger: { type: 'message' as const, source: 'user' as const }, status: 'active' as const,
      createdAt: 1, updatedAt: 1, state: 'waiting' as const, deliveryMode: 'host' as const,
      botId: original.id, sessionId: original.sessionId,
    }
    const policy: BotSkillPolicy = { mode: 'all', enabled: [], disabled: [] }
    const remote = remoteFixture([original])
    remote.updateAppearance = vi.fn(async () => ({ ok: true as const, value: { bot: other } }))
    remote.updateOrganization = vi.fn(async () => ({ ok: true as const, value: { bot: original } }))
    remote.listShareMembers = vi.fn(async () => ({ ok: true as const, value: { botId: original.id, members: [] } }))
    remote.createShareInvite = vi.fn(async () => ({ ok: true as const, value: { code: 'invite', expiresAt: 1 } }))
    remote.revokeShareMember = vi.fn(async () => ({
      ok: true as const, value: { botId: original.id, principalId: principal, revoked: true },
    }))
    remote.listSharedAppAccess = vi.fn<NonNullable<BotWorkspaceRemote['listSharedAppAccess']>>()
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'shared app read failed', {}) })
      .mockResolvedValueOnce({ ok: true, value: { botId: BotId('wrong-shared-app-bot'), revision: 1, apps: [] } })
    remote.setSharedAppAccess = vi.fn(async () => ({ ok: true as const, value: { botId: original.id, revision: 2, apps: [] } }))
    remote.inspectSharedGroupDeliveryFences = vi.fn(async () => ({ ok: true as const, value: { fences: [fence] } }))
    remote.recoverSharedGroupDelivery = vi.fn(async () => ({ ok: true as const, value: { botId: other.id, messageId: fence.messageId, status: 'released' as const } }))
    remote.listConnectedApps = vi.fn(async () => ({ ok: true as const, value: { bot: original, apps: [] } }))
    remote.setConnectedAppAccess = vi.fn(async () => ({ ok: true as const, value: { bot: original, app: { id: 'github', name: 'GitHub', allowed: true } } }))
    remote.listMemory = vi.fn(async () => ({ ok: true as const, value: { memories: [] } }))
    remote.updateMemory = vi.fn(async () => ({ ok: true as const, value: { memory: { id: 'other-memory', text: 'Unexpected', createdAt: 1 } } }))
    remote.forgetMemory = vi.fn(async () => ({ ok: true as const, value: { removed: true as const } }))
    remote.listSkills = vi.fn(async () => ({ ok: true as const, value: { bot: other, policy, revision: 1, skills: [] } }))
    remote.updateSkills = vi.fn<NonNullable<BotWorkspaceRemote['updateSkills']>>()
      .mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'skill update failed', {}) })
      .mockResolvedValueOnce({ ok: true, value: { bot: original, policy, revision: 2 } })
      .mockResolvedValueOnce({ ok: true, value: { bot: other, policy, revision: 3 } })
      .mockResolvedValueOnce({ ok: true, value: { bot: original, policy, revision: 4 } })
    remote.listRoutines = vi.fn(async () => ({ ok: false as const, error: new RemoteError('gateway/internal', 'routine list failed', {}) }))
    remote.pauseRoutine = vi.fn(async () => ({ ok: false as const, error: new RemoteError('gateway/internal', 'routine pause failed', {}) }))
    remote.resumeRoutine = vi.fn(async () => ({ ok: false as const, error: new RemoteError('gateway/internal', 'routine resume failed', {}) }))
    remote.deleteRoutine = vi.fn(async () => ({ ok: false as const, error: new RemoteError('gateway/internal', 'routine delete failed', {}) }))
    remote.routineHistory = vi.fn(async () => ({ ok: false as const, error: new RemoteError('gateway/internal', 'routine history failed', {}) }))
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()
    const face = controller.face()
    await expect(face.avatarEditor?.updateAppearance?.(original.id, { identity: 'agent', accent: 'violet', clearAvatar: false }))
      .rejects.toThrow('unexpected response')
    const organize = face.organize
    if (organize === undefined) throw new Error('organization action is not mounted')
    delete remote.updateOrganization
    await expect(organize(original.id, { pinned: false })).resolves.toBeUndefined()

    const share = face.share
    if (share?.listSharedAppAccess === undefined || share.setSharedAppAccess === undefined
      || share.recoverDeliveryFence === undefined) throw new Error('shared app actions are not mounted')
    await expect(share.listSharedAppAccess(original.id)).rejects.toThrow('shared app read failed')
    await expect(share.listSharedAppAccess(original.id)).rejects.toThrow('unexpected response')
    await expect(share.recoverDeliveryFence(fence)).rejects.toThrow('unexpected response')

    const loadApps = face.loadConnectedApps
    const setApp = face.setConnectedAppAccess
    if (loadApps === undefined || setApp === undefined) throw new Error('connected app actions are not mounted')
    delete remote.listConnectedApps
    delete remote.setConnectedAppAccess
    await expect(loadApps(original.id)).resolves.toEqual([])
    await expect(setApp(original.id, 'github', false)).resolves.toBeUndefined()

    const memory = face.memoryManager
    if (memory === undefined) throw new Error('memory manager is not mounted')
    await expect(memory.update(original.id, 'memory-one', 'Unexpected')).rejects.toThrow('unexpected response')
    const skills = face.skillManager
    if (skills === undefined) throw new Error('skill manager is not mounted')
    await expect(skills.list(original.id)).rejects.toThrow('unexpected response')
    await expect(skills.update(original.id, policy, 1)).rejects.toThrow('skill update failed')
    await expect(skills.update(original.id, policy, 2)).resolves.toEqual({ policy })
    await expect(skills.update(original.id, policy, 3)).rejects.toThrow('unexpected response')
    const routines = face.routineManager
    if (routines === undefined) throw new Error('routine manager is not mounted')
    await expect(routines.list(original.id)).rejects.toThrow('routine list failed')
    await expect(routines.pause(original.id, routine.id)).rejects.toThrow('routine pause failed')
    await expect(routines.resume(original.id, routine.id)).rejects.toThrow('routine resume failed')
    await expect(routines.remove(original.id, routine.id)).rejects.toThrow('routine delete failed')
    await expect(routines.history(original.id, routine.id)).rejects.toThrow('routine history failed')
    controller.dispose()

    const disposedSkillRemote = remoteFixture([original])
    disposedSkillRemote.listSkills = vi.fn(async () => ({ ok: true as const, value: { bot: original, policy, revision: 1, skills: [] } }))
    const skillResult = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['updateSkills']>>>>()
    disposedSkillRemote.updateSkills = vi.fn(async () => skillResult.promise)
    const disposedSkillController = new BotWorkspaceController(disposedSkillRemote, sessionsFixture().sessions, () => 'unexpected response')
    const disposedSkills = disposedSkillController.face().skillManager
    if (disposedSkills === undefined) throw new Error('disposed skill manager is not mounted')
    const updatingSkill = disposedSkills.update(original.id, policy, 1)
    const beforeDisposedSkill = disposedSkillController.source.getSnapshot()
    disposedSkillController.dispose()
    skillResult.resolve({ ok: true, value: { bot: original, policy, revision: 2 } })
    await expect(updatingSkill).resolves.toEqual({ policy })
    expect(disposedSkillController.source.getSnapshot()).toEqual(beforeDisposedSkill)
    expect(disposedSkillRemote.listSkills?.mock.calls.length ?? 0).toBe(0)

    const profileRemote = remoteFixture([original])
    profileRemote.updateProfile = vi.fn(async () => ({ ok: true as const, value: { bot: original } }))
    const profileController = new BotWorkspaceController(profileRemote, sessionsFixture().sessions, () => 'unexpected response')
    const profileFace = profileController.face()
    const updateProfile = profileFace.updateProfile
    if (updateProfile === undefined) throw new Error('profile action is not mounted')
    delete profileRemote.updateProfile
    await expect(updateProfile(original.id, { name: original.name, description: '', persona: '', capabilities: [] }))
      .rejects.toThrow('not mounted')
    profileController.dispose()

    const createRemote = remoteFixture([])
    const createResult = Promise.withResolvers<Awaited<ReturnType<BotWorkspaceRemote['create']>>>()
    createRemote.create.mockImplementation(async () => createResult.promise)
    const createController = new BotWorkspaceController(createRemote, sessionsFixture().sessions, () => 'unexpected response')
    const createFace = createController.face()
    const createRequest = { name: 'Pending', identity: 'agent' as const, accent: 'violet' as const }
    const firstCreate = createFace.create(createRequest)
    await vi.waitFor(() => { expect(createRemote.create).toHaveBeenCalledOnce() })
    const secondCreate = createFace.create({ ...createRequest, name: 'Ignored while pending' })
    const beforeDisposedCreateRequest = createController.source.getSnapshot()
    createController.dispose()
    await createFace.create(createRequest)
    createFace.retry()
    createResult.resolve({ ok: true, value: { bot: original } })
    await expect(firstCreate).resolves.toBeUndefined()
    await expect(secondCreate).resolves.toBeUndefined()
    expect(createController.source.getSnapshot()).toEqual(beforeDisposedCreateRequest)
    expect(createRemote.list).not.toHaveBeenCalled()

    const retryRemote = remoteFixture([original])
    const retryController = new BotWorkspaceController(retryRemote, sessionsFixture().sessions, () => 'unexpected response')
    retryController.face().retry()
    expect(retryRemote.list).toHaveBeenCalledOnce()
    retryController.dispose()
  })

  it('surfaces non-Error failures from queued roster and retry callbacks', async () => {
    const first = bot('bot-retry-boundary', 'session-retry-boundary')
    const group = groupView('bot-group-retry-boundary', 'Retry boundary', [first])
    const groupRemote = remoteFixture([first])
    groupRemote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    groupRemote.inspectGroup = vi.fn<NonNullable<BotWorkspaceRemote['inspectGroup']>>()
      .mockResolvedValueOnce({ ok: true, value: { group, messages: [] } })
      .mockRejectedValueOnce('group retry transport failed')
    const groupController = new BotWorkspaceController(groupRemote, sessionsFixture().sessions, () => 'unexpected response')
    await groupController.load()
    const groupFace = groupController.face()
    groupFace.selectGroup(String(group.id))
    await vi.waitFor(() => { expect(groupController.source.getSnapshot().selectedGroup).not.toBeNull() })
    groupFace.retryGroup()
    await vi.waitFor(() => { expect(groupController.source.getSnapshot().groupError).toBe('group retry transport failed') })
    groupController.dispose()

    const provisioning = bot('bot-retry-create-boundary', 'session-retry-create-boundary', { state: 'provisioning' })
    const createRemote = remoteFixture([provisioning])
    createRemote.create.mockRejectedValueOnce('create retry transport failed')
    const createController = new BotWorkspaceController(createRemote, sessionsFixture().sessions, () => 'unexpected response')
    await createController.load()
    createController.face().retry()
    await vi.waitFor(() => { expect(createController.source.getSnapshot().error).toBe('create retry transport failed') })
    createController.dispose()

    const queuedList = Promise.withResolvers<Awaited<ReturnType<BotWorkspaceRemote['list']>>>()
    const queuedRemote = remoteFixture([first])
    queuedRemote.list
      .mockImplementationOnce(async () => queuedList.promise)
      .mockRejectedValueOnce('queued roster transport failed')
    const queuedController = new BotWorkspaceController(queuedRemote, sessionsFixture().sessions, () => 'unexpected response')
    const initialLoad = queuedController.load()
    await vi.waitFor(() => { expect(queuedRemote.list).toHaveBeenCalledOnce() })
    const queuedLoad = queuedController.load()
    queuedList.resolve({ ok: true, value: { bots: [first] } })
    await expect(initialLoad).resolves.toBeUndefined()
    await expect(queuedLoad).resolves.toBeUndefined()
    await vi.waitFor(() => { expect(queuedController.source.getSnapshot().error).toBe('queued roster transport failed') })
    queuedController.dispose()
  })

  it('does not commit stale roster reads after disposal or roster revisions', async () => {
    const first = bot('bot-stale-roster-first', 'session-stale-roster-first')

    const disposedRemote = remoteFixture([first])
    const disposedList = Promise.withResolvers<Awaited<ReturnType<BotWorkspaceRemote['list']>>>()
    disposedRemote.list.mockImplementationOnce(async () => disposedList.promise)
    const disposedController = new BotWorkspaceController(disposedRemote, sessionsFixture().sessions, () => 'unexpected response')
    const disposedLoad = disposedController.load()
    await vi.waitFor(() => { expect(disposedRemote.list).toHaveBeenCalledOnce() })
    const beforeDisposedRoster = disposedController.source.getSnapshot()
    disposedController.dispose()
    disposedList.resolve({ ok: true, value: { bots: [first] } })
    await expect(disposedLoad).resolves.toBeUndefined()
    expect(disposedController.source.getSnapshot()).toEqual(beforeDisposedRoster)
    expect(disposedRemote.list).toHaveBeenCalledOnce()

    const group = groupView('bot-group-stale-roster', 'Stale roster', [first])
    const removedRemote = remoteFixture([first])
    removedRemote.listGroups = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { groups: [group] } })
      .mockResolvedValueOnce({ ok: true, value: { groups: [] } })
    removedRemote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group, messages: [] } }))
    const removedController = new BotWorkspaceController(removedRemote, sessionsFixture().sessions, () => 'unexpected response')
    await removedController.load()
    removedController.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(removedController.source.getSnapshot().selectedGroup).not.toBeNull() })
    await removedController.load()
    expect(removedController.source.getSnapshot().selectedGroupId).toBeNull()
    removedController.dispose()

    const sessionDisposedRemote = remoteFixture([first])
    const sessionDisposed = sessionsFixture()
    const sessionRefresh = Promise.withResolvers<undefined>()
    sessionDisposed.refresh.mockImplementationOnce(async () => sessionRefresh.promise)
    const sessionDisposedController = new BotWorkspaceController(sessionDisposedRemote, sessionDisposed.sessions, () => 'unexpected response')
    const sessionLoading = sessionDisposedController.load()
    await vi.waitFor(() => { expect(sessionDisposed.refresh).toHaveBeenCalledOnce() })
    const beforeDisposedSessionRefresh = sessionDisposedController.source.getSnapshot()
    sessionDisposedController.dispose()
    sessionRefresh.resolve(undefined)
    await expect(sessionLoading).resolves.toBeUndefined()
    expect(sessionDisposedController.source.getSnapshot()).toEqual(beforeDisposedSessionRefresh)
    expect(sessionDisposedRemote.list).toHaveBeenCalledOnce()

    const revisionRemote = remoteFixture([first])
    const revisionSessions = sessionsFixture()
    const revisionInitialRefresh = Promise.withResolvers<undefined>()
    revisionSessions.refresh
      .mockImplementationOnce(async () => revisionInitialRefresh.promise)
      .mockResolvedValue(undefined)
    revisionRemote.updateOrganization = vi.fn(async () => ({ ok: true as const, value: { bot: { ...first, pinned: true } } }))
    const revisionController = new BotWorkspaceController(revisionRemote, revisionSessions.sessions, () => 'unexpected response')
    const revisionLoading = revisionController.load()
    await vi.waitFor(() => { expect(revisionSessions.refresh).toHaveBeenCalledOnce() })
    const organizing = revisionController.face().organize?.(first.id, { pinned: true })
    await expect(organizing).resolves.toBeUndefined()
    revisionInitialRefresh.resolve(undefined)
    await expect(revisionLoading).resolves.toBeUndefined()
    await vi.waitFor(() => { expect(revisionRemote.list).toHaveBeenCalledTimes(2) })
    revisionController.dispose()

    const retainRevisionRemote = remoteFixture([first])
    const retainRevisionSessions = sessionsFixture()
    const retainRevisionService = sessionsWithList(retainRevisionSessions, sessionList(first.sessionId, () => false))
    const retainRevisionRefresh = Promise.withResolvers<undefined>()
    let retains = 0
    retainRevisionSessions.retain.mockImplementation((sessionId) => {
      retains++
      if (retains === 1) throw new Error('session catalog stale')
      return reference(sessionId)
    })
    retainRevisionSessions.refresh
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => retainRevisionRefresh.promise)
    retainRevisionRemote.updateOrganization = vi.fn(async () => ({ ok: true as const, value: { bot: { ...first, pinned: true } } }))
    const retainRevisionController = new BotWorkspaceController(retainRevisionRemote, retainRevisionService, () => 'unexpected response')
    const retainRevisionLoading = retainRevisionController.load()
    await vi.waitFor(() => { expect(retainRevisionSessions.refresh).toHaveBeenCalledTimes(2) })
    const retainOrganizing = retainRevisionController.face().organize?.(first.id, { pinned: true })
    await expect(retainOrganizing).resolves.toBeUndefined()
    retainRevisionRefresh.resolve(undefined)
    await expect(retainRevisionLoading).resolves.toBeUndefined()
    await vi.waitFor(() => { expect(retainRevisionRemote.list).toHaveBeenCalledTimes(2) })
    retainRevisionController.dispose()
  })

  it('keeps disposed roster, selection, and group failures from committing stale state', async () => {
    const first = bot('bot-disposed-roster', 'session-disposed-roster')
    const listResult = Promise.withResolvers<Awaited<ReturnType<BotWorkspaceRemote['list']>>>()
    const rosterRemote = remoteFixture([first])
    rosterRemote.list.mockImplementation(async () => listResult.promise)
    const rosterController = new BotWorkspaceController(rosterRemote, sessionsFixture().sessions, () => 'unexpected response')
    const rosterLoading = rosterController.load()
    await vi.waitFor(() => { expect(rosterRemote.list).toHaveBeenCalledOnce() })
    rosterController.dispose()
    listResult.reject('disposed roster read')
    await expect(rosterLoading).resolves.toBeUndefined()

    const second = bot('bot-disposed-selection', 'session-disposed-selection')
    const refreshResult = Promise.withResolvers<undefined>()
    const selectionSessions = sessionsFixture()
    const selectionService = sessionsWithList(selectionSessions, sessionList(first.sessionId, () => true))
    selectionSessions.refresh
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => refreshResult.promise)
    selectionSessions.retain.mockImplementation((target) => {
      const sessionId = target
      if (sessionId === second.sessionId) throw new Error('selection catalog is stale')
      return reference(sessionId)
    })
    const selectionRemote = remoteFixture([first, second])
    const selectionController = new BotWorkspaceController(
      selectionRemote, selectionService, () => 'unexpected response',
    )
    await selectionController.load()
    selectionController.face().select(second.id)
    await vi.waitFor(() => { expect(selectionSessions.refresh).toHaveBeenCalledTimes(2) })
    const beforeDisposedSelection = selectionController.source.getSnapshot()
    selectionController.dispose()
    refreshResult.reject('disposed selection refresh')
    await expect(refreshResult.promise).rejects.toBe('disposed selection refresh')
    expect(selectionController.source.getSnapshot()).toEqual(beforeDisposedSelection)
    expect(selectionRemote.list).toHaveBeenCalledOnce()

    const staleRefresh = Promise.withResolvers<undefined>()
    const staleSessions = sessionsFixture()
    const staleService = sessionsWithList(staleSessions, sessionList(first.sessionId, () => true))
    staleSessions.refresh
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => staleRefresh.promise)
    staleSessions.retain.mockImplementation((target) => {
      const sessionId = target
      if (sessionId === second.sessionId) throw new Error('stale selection catalog')
      return reference(sessionId)
    })
    const staleController = new BotWorkspaceController(
      remoteFixture([first, second]), staleService, () => 'unexpected response',
    )
    await staleController.load()
    staleController.face().select(second.id)
    await vi.waitFor(() => { expect(staleSessions.refresh).toHaveBeenCalledTimes(2) })
    staleController.face().select(first.id)
    const beforeStaleSelectionRefresh = staleController.source.getSnapshot()
    staleRefresh.reject('stale selection refresh')
    await expect(staleRefresh.promise).rejects.toBe('stale selection refresh')
    expect(staleController.source.getSnapshot()).toEqual(beforeStaleSelectionRefresh)
    staleController.dispose()

    const group = groupView('bot-group-disposed-send', 'Disposed send', [first, second])
    const sendResult = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['sendGroupMessage']>>>>()
    const groupRemote = remoteFixture([first, second])
    groupRemote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    groupRemote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group, messages: [] } }))
    groupRemote.sendGroupMessage = vi.fn(async () => sendResult.promise)
    const groupController = new BotWorkspaceController(
      groupRemote, sessionsFixture().sessions, () => 'unexpected response', undefined, undefined, pendingStoreFixture(),
    )
    await groupController.load()
    const groupFace = groupController.face()
    groupFace.selectGroup(String(group.id))
    await vi.waitFor(() => { expect(groupController.source.getSnapshot().selectedGroup).not.toBeNull() })
    const sending = groupFace.sendGroupMessage('Disposed send', 'bot-group-message-disposed-error')
    await vi.waitFor(() => { expect(groupRemote.sendGroupMessage).toHaveBeenCalledOnce() })
    const beforeDisposedGroupSend = groupController.source.getSnapshot()
    const groupReadsBeforeDispose = groupRemote.inspectGroup?.mock.calls.length ?? 0
    groupController.dispose()
    sendResult.reject('send failed after disposal')
    await expect(sending).rejects.toThrow('send failed after disposal')
    expect(groupController.source.getSnapshot()).toEqual(beforeDisposedGroupSend)
    expect(groupRemote.inspectGroup?.mock.calls.length ?? 0).toBe(groupReadsBeforeDispose)
  })

  it('propagates non-Error image admission failures through the group send boundary', async () => {
    const first = bot('bot-image-admission-first', 'session-image-admission-first')
    const second = bot('bot-image-admission-second', 'session-image-admission-second')
    const group = groupView('bot-group-image-admission', 'Image admission', [first, second])
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group, messages: [] } }))
    remote.admitGroupImage = vi.fn<NonNullable<BotWorkspaceRemote['admitGroupImage']>>(async () => {
      throw 'image admission transport failed'
    })
    remote.sendGroupMessage = vi.fn<NonNullable<BotWorkspaceRemote['sendGroupMessage']>>()
      .mockResolvedValue({ ok: true, value: {
        messageId: brandString<BotGroupMessageId>('bot-group-message-image-admission'), status: 'accepted', deliveries: [],
      } })
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()
    const face = controller.face()
    face.selectGroup(String(group.id))
    await vi.waitFor(() => { expect(controller.source.getSnapshot().selectedGroup).not.toBeNull() })
    const image = {
      id: 'image-admission',
      file: new File([new Uint8Array([1, 2, 3])], 'admission.png', { type: 'image/png' }),
      state: 'ready' as const,
    }
    await expect(face.sendGroupMessageWithAttachments('Image admission', [image]))
      .rejects.toThrow('image admission transport failed')
    controller.dispose()
  })

  it('retries an active Bot creation after its Session enters the catalog', async () => {
    const created = bot('bot-create-catalog-retry', 'session-create-catalog-retry')
    let catalogReady = false
    const sessions = sessionsFixture()
    const sessionService = sessionsWithList(sessions, sessionList(created.sessionId, () => catalogReady))
    sessions.retain.mockImplementation((target) => {
      const sessionId = target
      if (!catalogReady) throw new Error('creation Session is not catalogued')
      return reference(sessionId)
    })
    sessions.refresh.mockImplementation(async () => { catalogReady = true })
    const remote = remoteFixture([])
    let requestId: BotId | undefined
    remote.create.mockImplementation(async (request) => {
      const id = request.id ?? created.id
      requestId = id
      return { ok: true as const, value: { bot: { ...created, id } } }
    })
    const controller = new BotWorkspaceController(remote, sessionService, () => 'unexpected response')
    await controller.face().create({ name: 'Catalog retry', identity: 'agent', accent: 'violet' })
    expect(sessions.refresh).toHaveBeenCalledOnce()
    expect(requestId).toBeDefined()
    expect(controller.source.getSnapshot().selectedBotId).toBe(requestId)
    expect(controller.source.getSnapshot().error).toBeNull()
    controller.dispose()
  })

  it('retries missing Session catalogs and reuses in-flight avatar reads safely', async () => {
    const first = bot('bot-selection-retry-first', 'session-selection-retry-first')
    const second = bot('bot-selection-retry-second', 'session-selection-retry-second')
    const refresh = vi.fn<ISessions['refresh']>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce('catalog retry failed')
    const retain = vi.fn<ISessions['retain']>((sessionId) => {
      const resolvedSessionId = typeof sessionId === 'string' ? sessionId : sessionId.childSessionId
      if (resolvedSessionId === second.sessionId) throw new Error('Session catalog is stale')
      return reference(resolvedSessionId)
    })
    const sessions = {
      retain, refresh, list: sessionList(second.sessionId, () => false),
    } as Pick<ISessions, 'retain' | 'refresh' | 'list'> as ISessions
    const controller = new BotWorkspaceController(remoteFixture([first, second]), sessions, () => 'unexpected response')
    await controller.load()
    controller.face().select(second.id)
    await vi.waitFor(() => { expect(controller.source.getSnapshot().error).toBe('catalog retry failed') })
    controller.dispose()

    const staleRefresh = Promise.withResolvers<undefined>()
    const staleRefreshRemote = remoteFixture([first, second])
    const staleRefreshSessions = sessionsFixture()
    const staleRefreshService = sessionsWithList(staleRefreshSessions, sessionList(second.sessionId, () => false))
    staleRefreshSessions.refresh
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => staleRefresh.promise)
    staleRefreshSessions.retain.mockImplementation((sessionId) => {
      if (sessionId === second.sessionId) throw new Error('Session catalog is stale')
      return reference(sessionId)
    })
    const staleController = new BotWorkspaceController(staleRefreshRemote, staleRefreshService, () => 'unexpected response')
    await staleController.load()
    staleController.face().select(second.id)
    await vi.waitFor(() => { expect(staleRefreshSessions.refresh).toHaveBeenCalledTimes(2) })
    staleController.face().select(first.id)
    staleRefresh.resolve(undefined)
    await vi.waitFor(() => { expect(staleController.source.getSnapshot().selectedBotId).toBe(first.id) })
    staleController.dispose()

    const disposedRefresh = Promise.withResolvers<undefined>()
    const disposedRefreshRemote = remoteFixture([first, second])
    const disposedRefreshSessions = sessionsFixture()
    const disposedRefreshService = sessionsWithList(disposedRefreshSessions, sessionList(second.sessionId, () => false))
    disposedRefreshSessions.refresh
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => disposedRefresh.promise)
    disposedRefreshSessions.retain.mockImplementation((sessionId) => {
      if (sessionId === second.sessionId) throw new Error('Session catalog is stale')
      return reference(sessionId)
    })
    const disposedRefreshController = new BotWorkspaceController(disposedRefreshRemote, disposedRefreshService, () => 'unexpected response')
    await disposedRefreshController.load()
    disposedRefreshController.face().select(second.id)
    await vi.waitFor(() => { expect(disposedRefreshSessions.refresh).toHaveBeenCalledTimes(2) })
    const beforeDisposedCatalogRefresh = disposedRefreshController.source.getSnapshot()
    disposedRefreshController.dispose()
    disposedRefresh.resolve(undefined)
    await expect(disposedRefresh.promise).resolves.toBeUndefined()
    expect(disposedRefreshController.source.getSnapshot()).toEqual(beforeDisposedCatalogRefresh)
    expect(disposedRefreshRemote.list).toHaveBeenCalledOnce()

    const avatar = { attachmentId: AttachmentId('avatar-cache'), mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1 }
    const otherAvatar = { attachmentId: AttachmentId('avatar-error'), mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1 }
    const avatarRemote = remoteFixture([first])
    const avatarResult = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['readAvatar']>>>>()
    avatarRemote.readAvatar = vi.fn(async () => avatarResult.promise)
    const avatarController = new BotWorkspaceController(avatarRemote, sessionsFixture().sessions, () => 'unexpected response')
    const pendingAvatar = avatarController.face().loadAvatar(first.id, avatar)
    expect(avatarController.face().loadAvatar(first.id, avatar)).toBe(pendingAvatar)
    avatarResult.resolve({ ok: true, value: { avatar, data: 'AQID' } })
    await expect(pendingAvatar).resolves.toBe('data:image/png;base64,AQID')
    avatarRemote.readAvatar = vi.fn(async () => ({ ok: false as const, error: new RemoteError('gateway/internal', 'avatar read failed', {}) }))
    await expect(avatarController.face().loadAvatar(first.id, otherAvatar)).rejects.toThrow('avatar read failed')
    avatarController.dispose()
  })

  it('rejects malformed template permissions and ignores stale catalog responses', async () => {
    const source = bot('bot-template-wire-boundary', 'session-template-wire-boundary')
    const template = templateView('bot-template-wire-boundary', 'bot-template-wire-code')
    const remote = remoteFixture([source])
    remote.listTemplates = vi.fn(async () => ({ ok: true as const, value: { templates: [template] } }))
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()
    const actions = controller.face().templateActions
    if (actions === undefined) throw new Error('template actions are not mounted')
    actions.setTemplateCode(String(template.shareCode))
    const malformed = (value: object) => wireFixture<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['previewTemplate']>>>>({
      ok: true, value: { template, localPermissions: value, approvalToken: 'preview-token' },
    })
    const invalidAvatarPreview = wireFixture<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['previewTemplate']>>>>({
      ok: true, value: { template: { ...template, avatar: [] }, localPermissions, approvalToken: 'preview-token' },
    })
    const invalidAvatarName = wireFixture<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['previewTemplate']>>>>({
      ok: true,
      value: {
        template: {
          ...template,
          avatar: { mediaType: 'image/png', data: 'AQID', bytes: 3, width: 1, height: 1, name: '' },
        },
        localPermissions,
        approvalToken: 'preview-token',
      },
    })
    remote.previewTemplate = vi.fn<NonNullable<BotWorkspaceRemote['previewTemplate']>>()
      .mockResolvedValueOnce(malformed({ status: 'unknown', tools: [] }))
      .mockResolvedValueOnce(malformed({ status: 'resolved', preset: ' research-preset', tools: [] }))
      .mockResolvedValueOnce(malformed({ status: 'resolved', preset: 'research-preset', tools: [1] }))
      .mockResolvedValueOnce(invalidAvatarPreview)
      .mockResolvedValueOnce(invalidAvatarName)
    await expect(actions.previewTemplate()).rejects.toThrow('unexpected response')
    await expect(actions.previewTemplate()).rejects.toThrow('unexpected response')
    await expect(actions.previewTemplate()).rejects.toThrow('unexpected response')
    await expect(actions.previewTemplate()).rejects.toThrow('unexpected response')
    await expect(actions.previewTemplate()).rejects.toThrow('unexpected response')

    remote.previewTemplate = vi.fn(async () => ({ ok: true as const, value: { template, localPermissions, approvalToken: 'preview-token' } }))
    await actions.previewTemplate()
    remote.approveTemplate = vi.fn(async () => ({ ok: true as const, value: {
      template: { ...template, approved: true },
      localPermissions: { status: 'resolved' as const, preset: 'research-preset', tools: ['chat'] },
    } }))
    remote.importTemplate = vi.fn(async () => ({ ok: true as const, value: { bot: source, template } }))
    await expect(actions.importTemplate()).rejects.toThrow('unexpected response')
    controller.dispose()

    const staleSource = bot('bot-template-stale-catalog-boundary', 'session-template-stale-catalog-boundary')
    const staleTemplate = templateView('bot-template-stale-catalog-boundary', 'bot-template-stale-catalog-code', {
      description: 'Old catalog entry',
    })
    const currentTemplate = templateView('bot-template-stale-catalog-boundary', 'bot-template-stale-catalog-code', {
      description: 'Current catalog entry',
    })
    const staleRemote = remoteFixture([staleSource])
    const staleCatalog = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['listTemplates']>>>>()
    const currentCatalog = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['listTemplates']>>>>()
    let catalogCalls = 0
    staleRemote.listTemplates = vi.fn(async () => {
      catalogCalls++
      if (catalogCalls === 1) return { ok: true as const, value: { templates: [staleTemplate] } }
      if (catalogCalls === 2) return staleCatalog.promise
      return currentCatalog.promise
    })
    staleRemote.publishTemplate = vi.fn(async () => ({ ok: true as const, value: { template: staleTemplate } }))
    const staleController = new BotWorkspaceController(staleRemote, sessionsFixture().sessions, () => 'unexpected response')
    await staleController.load()
    const staleActions = staleController.face().templateActions
    if (staleActions === undefined) throw new Error('stale template actions are not mounted')
    const loading = staleController.load()
    await vi.waitFor(() => { expect(staleRemote.listTemplates).toHaveBeenCalledTimes(2) })
    const publishing = staleActions.publishTemplate({ botId: staleSource.id })
    await vi.waitFor(() => { expect(staleRemote.listTemplates).toHaveBeenCalledTimes(3) })
    currentCatalog.resolve({ ok: true, value: { templates: [currentTemplate] } })
    await publishing
    staleCatalog.resolve({ ok: true, value: { templates: [staleTemplate] } })
    await loading
    expect(staleController.source.getSnapshot().templates.templates[0]?.description).toBe('Current catalog entry')
    expect(staleController.source.getSnapshot().templates.phase).toBe('ready')
    expect(staleController.source.getSnapshot().templates.busy).toBe(false)
    expect(staleController.source.getSnapshot().templates.error).toBeNull()
    staleController.dispose()

    const rejectedStaleRemote = remoteFixture([staleSource])
    const rejectedCatalog = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['listTemplates']>>>>()
    const rejectedCurrentCatalog = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['listTemplates']>>>>()
    const pendingPreview = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['previewTemplate']>>>>()
    let rejectedCalls = 0
    rejectedStaleRemote.listTemplates = vi.fn(async () => {
      rejectedCalls++
      if (rejectedCalls === 1) return { ok: true as const, value: { templates: [staleTemplate] } }
      if (rejectedCalls === 2) return rejectedCatalog.promise
      return rejectedCurrentCatalog.promise
    })
    rejectedStaleRemote.publishTemplate = vi.fn(async () => ({ ok: true as const, value: { template: staleTemplate } }))
    rejectedStaleRemote.previewTemplate = vi.fn(async () => pendingPreview.promise)
    const rejectedStaleController = new BotWorkspaceController(rejectedStaleRemote, sessionsFixture().sessions, () => 'unexpected response')
    await rejectedStaleController.load()
    const rejectedActions = rejectedStaleController.face().templateActions
    if (rejectedActions === undefined) throw new Error('rejected stale actions are not mounted')
    rejectedActions.setTemplateCode(String(staleTemplate.shareCode))
    const rejectedLoading = rejectedStaleController.load()
    await vi.waitFor(() => { expect(rejectedStaleRemote.listTemplates).toHaveBeenCalledTimes(2) })
    const rejectedPublishing = rejectedActions.publishTemplate({ botId: staleSource.id })
    await vi.waitFor(() => { expect(rejectedStaleRemote.listTemplates).toHaveBeenCalledTimes(3) })
    rejectedCurrentCatalog.resolve({ ok: true, value: { templates: [currentTemplate] } })
    await rejectedPublishing
    const previewing = rejectedActions.previewTemplate()
    await vi.waitFor(() => { expect(rejectedStaleRemote.previewTemplate).toHaveBeenCalledOnce() })
    rejectedCatalog.reject('old catalog failed')
    await rejectedLoading
    pendingPreview.resolve({ ok: true, value: { template: staleTemplate, localPermissions, approvalToken: 'preview-token' } })
    await previewing
    expect(rejectedStaleController.source.getSnapshot().templates.templates[0]?.description).toBe('Current catalog entry')
    expect(rejectedStaleController.source.getSnapshot().templates.preview?.description).toBe('Old catalog entry')
    expect(rejectedStaleController.source.getSnapshot().templates.phase).toBe('ready')
    expect(rejectedStaleController.source.getSnapshot().templates.busy).toBe(false)
    expect(rejectedStaleController.source.getSnapshot().templates.error).toBeNull()
    rejectedStaleController.dispose()

    const noCatalogRemote = remoteFixture([source])
    noCatalogRemote.publishTemplate = vi.fn(async () => ({ ok: true as const, value: { template } }))
    const noCatalogController = new BotWorkspaceController(noCatalogRemote, sessionsFixture().sessions, () => 'unexpected response')
    await noCatalogController.face().templateActions?.publishTemplate({ botId: source.id })
    noCatalogController.dispose()

    const disposedPublishRemote = remoteFixture([source])
    const publishResult = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotWorkspaceRemote['publishTemplate']>>>>()
    disposedPublishRemote.publishTemplate = vi.fn(async () => publishResult.promise)
    disposedPublishRemote.listTemplates = vi.fn(async () => ({ ok: true as const, value: { templates: [] } }))
    const disposedPublishController = new BotWorkspaceController(disposedPublishRemote, sessionsFixture().sessions, () => 'unexpected response')
    const disposedPublishing = disposedPublishController.face().templateActions?.publishTemplate({ botId: source.id })
    const beforeDisposedPublish = disposedPublishController.source.getSnapshot()
    const templateReadsBeforePublish = disposedPublishRemote.listTemplates?.mock.calls.length ?? 0
    disposedPublishController.dispose()
    publishResult.resolve({ ok: true, value: { template } })
    await expect(disposedPublishing).resolves.toBeUndefined()
    expect(disposedPublishController.source.getSnapshot()).toEqual(beforeDisposedPublish)
    expect(disposedPublishRemote.listTemplates?.mock.calls.length ?? 0).toBe(templateReadsBeforePublish)
  })
})
