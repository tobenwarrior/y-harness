import { describe, expect, it, vi } from 'vitest'
import type {
  SessionBinding, SessionReference, ISessions, SessionListState, SessionSummary,
} from '@yharness/api-session-controller/client'
import type { SessionId } from '@yharness/session/types'
import { BotId, type BotView } from '@yharness/bots/client'
import { BotWorkspaceController, type BotAvatarGenerationRemote, type BotWorkspaceRemote } from '../src/client/controller.ts'

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

function remoteFixture(rows: readonly BotView[]): BotWorkspaceRemote & {
  readonly list: ReturnType<typeof vi.fn>
  readonly create: ReturnType<typeof vi.fn>
} {
  const create = vi.fn<BotWorkspaceRemote['create']>()
  return {
    list: vi.fn(async () => ({ ok: true as const, value: { bots: rows } })),
    create,
    rename: vi.fn(),
  }
}

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
})
