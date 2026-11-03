import { describe, expect, it, vi } from 'vitest'
import type {
  SessionBinding, SessionReference, ISessions, SessionListState, SessionSummary,
} from '@yharness/api-session-controller/client'
import type { SessionId } from '@yharness/session/types'
import { BotId, type BotGroupId, type BotGroupInspectValue, type BotGroupView, type BotView } from '@yharness/bots/client'
import { brandString } from '@yharness/brand'
import { createSnapshotStore } from '@yharness/client-store'
import { RemoteError } from '@yharness/client-test-runtime'
import { BotWorkspaceController, type BotAvatarGenerationRemote, type BotGroupPendingState, type BotWorkspaceRemote } from '../src/client/controller.ts'

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

function remoteFixture(rows: readonly BotView[]): BotWorkspaceRemote & {
  readonly list: ReturnType<typeof vi.fn>
  readonly create: ReturnType<typeof vi.fn>
} {
  const create = vi.fn<BotWorkspaceRemote['create']>()
  return {
    list: vi.fn(async () => ({ ok: true as const, value: { bots: rows } })),
    create,
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

describe('BotWorkspaceController', () => {
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
      messages: [{ id: brandString('bot-group-message-1'), groupId: group.id, sender: { kind: 'user' }, text: 'Plan it.', createdAt: 1 }],
    }
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: detail }))
    remote.sendGroupMessage = vi.fn(async () => ({ ok: true as const, value: { messageId: brandString('bot-group-message-1'), status: 'accepted' as const, deliveries: [] } }))
    const { retain, sessions } = sessionsFixture()
    const controller = new BotWorkspaceController(remote, sessions, () => 'unexpected response')

    await controller.load()
    const directReference = controller.face().reference()
    controller.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(controller.source.getSnapshot().selectedGroup?.name).toBe('Release room') })

    expect(controller.source.getSnapshot().selectedBotId).toBeNull()
    expect(controller.face().reference()).toBeUndefined()
    expect(directReference?.release).toHaveBeenCalledOnce()
    expect(remote.inspectGroup).toHaveBeenCalledWith({ groupId: group.id })

    await controller.face().sendGroupMessage('Add owners.')
    expect(remote.sendGroupMessage).toHaveBeenCalledWith(expect.objectContaining({ groupId: group.id, text: 'Add owners.' }))
    expect(remote.sendGroupMessage.mock.calls[0]?.[0].messageId).toMatch(/^bot-group-message-/)
    expect(retain).toHaveBeenCalledOnce()
  })

  it('reuses one remote group id after a lost create response', async () => {
    const first = bot('bot-first-create-retry', 'session-first-create-retry')
    const second = bot('bot-second-create-retry', 'session-second-create-retry')
    const group = groupView('bot-group-create-retry', 'Retry room', [first, second])
    const remote = remoteFixture([first, second])
    remote.createGroup = vi.fn()
      .mockRejectedValueOnce(new Error('connection closed after commit'))
      .mockResolvedValueOnce({ ok: true as const, value: { group } })
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group, messages: [] } }))
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')

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
    remote.inspectGroup = vi.fn(async () => ({ ok: true as const, value: { group, messages: [] } }))
    const pendingStore = createSnapshotStore<BotGroupPendingState>({ creations: {}, messages: {} })
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

  it('fails closed instead of allocating a group id when reconciliation is unavailable', async () => {
    const first = bot('bot-first-create-fail-closed', 'session-first-create-fail-closed')
    const second = bot('bot-second-create-fail-closed', 'session-second-create-fail-closed')
    const remote = remoteFixture([first, second])
    remote.listGroups = vi.fn(async () => ({
      ok: false as const, error: new RemoteError('gateway/internal', 'catalog unavailable', {}),
    }))
    remote.createGroup = vi.fn()
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')

    await expect(controller.face().createGroup({ name: 'Fail closed', botIds: [first.id, second.id].map(String) }))
      .rejects.toThrow('Could not verify existing Bot groups')
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
    remote.sendGroupMessage = vi.fn()
      .mockRejectedValueOnce(new Error('connection closed after commit'))
      .mockResolvedValueOnce({ ok: true as const, value: { messageId: brandString('bot-group-message-retry'), status: 'accepted' as const, deliveries: [] } })
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
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
    remote.sendGroupMessage = vi.fn()
      .mockRejectedValueOnce(new Error('connection closed after commit'))
      .mockResolvedValueOnce({ ok: true as const, value: { messageId: brandString('bot-group-message-restart'), status: 'accepted' as const, deliveries: [] } })
    const pendingStore = createSnapshotStore<BotGroupPendingState>({ creations: {}, messages: {} })
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
    remote.inspectGroup = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: detail })
      .mockResolvedValueOnce({ ok: false as const, error: new RemoteError('gateway/internal', 'transcript unavailable', {}) })
    remote.sendGroupMessage = vi.fn()
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response')
    await controller.load()
    controller.face().selectGroup(String(group.id))
    await vi.waitFor(() => { expect(controller.source.getSnapshot().selectedGroup).not.toBeNull() })

    await expect(controller.face().sendGroupMessage('Fail closed.')).rejects.toThrow('Could not verify existing Bot messages')
    expect(remote.sendGroupMessage).not.toHaveBeenCalled()
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
      messageId: brandString('bot-group-message-partial'), status: 'partial' as const,
      deliveries: [{ botId: first.id, status: 'accepted' as const }, { botId: second.id, status: 'failed' as const, error: 'offline' }],
    } }))
    const controller = new BotWorkspaceController(remote, sessionsFixture().sessions, () => 'unexpected response', undefined, () => 'Some Bots could not receive this message.')
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

  it('re-reads a selected group when a change arrives during an in-flight refresh', async () => {
    const first = bot('bot-first-refresh-race', 'session-first-refresh-race')
    const second = bot('bot-second-refresh-race', 'session-second-refresh-race')
    const group = groupView('bot-group-refresh-race', 'Refresh race room', [first, second])
    const stale: BotGroupInspectValue = {
      group,
      messages: [{ id: brandString('bot-group-message-stale'), groupId: group.id, sender: { kind: 'user' }, text: 'Before refresh.', createdAt: 1 }],
    }
    const fresh: BotGroupInspectValue = {
      group,
      messages: [
        ...stale.messages,
        { id: brandString('bot-group-message-fresh'), groupId: group.id, sender: { kind: 'user' }, text: 'Arrived during refresh.', createdAt: 2 },
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
})
