// @vitest-environment jsdom

import { createSnapshotStore } from '@yharness/client-store'
import { createElement } from 'react'
import { Context } from '@yharness/cordis'
import type { ConnectionGeneration } from '@yharness/client-connection/client'
import { LocaleRuntime } from '@yharness/client-locale/client'
import type { ISessions, SessionBinding, SessionListState, SessionReference } from '@yharness/api-session-controller/client'
import type { BotGroupId, BotGroupInspectValue, BotGroupMessageId, BotGroupView, BotView } from '@yharness/bots/client'
import { BotId } from '@yharness/bots/client'
import { AttachmentId } from '@yharness/attachment'
import { brandString } from '@yharness/brand'
import { TestRemote } from '@yharness/client-test-runtime'
import type { PresentedFileDownloads } from '@yharness/client-ui-deliverables/client'
import type { InputTriggerPick, InputTriggerSource } from '@yharness/client-ui-input-trigger/client'
import { SessionId } from '@yharness/session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { apply as nodeApply } from '../src/index.ts'
import { apply, inject } from '../src/client/apply.ts'
import type { BotWorkspaceRemote } from '../src/client/controller.ts'
import type { ComputerStatus } from '../src/client/computer-client.ts'
import { en } from '../src/client/locales.ts'

type Registered = {
  readonly options: Record<string, unknown>
  readonly component: unknown
  readonly inject?: () => unknown
}

function bot(): BotView {
  return {
    id: BotId('bot-apply'),
    sessionId: SessionId('session-apply'),
    name: 'Apply Bot',
    identity: 'agent',
    accent: 'violet',
    cwd: '/workspace',
    state: 'active',
    createdAt: 1,
    updatedAt: 1,
    availability: 'idle',
    pinned: false,
    hidden: false,
    avatar: { attachmentId: AttachmentId('apply-avatar'), mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
  }
}

function sessionReference(sessionId: SessionId): { readonly reference: SessionReference; readonly release: ReturnType<typeof vi.fn> } {
  const release = vi.fn()
  return {
    reference: {
      sessionId,
      binding: {} as SessionBinding,
      ready: Promise.resolve({} as SessionBinding),
      release,
      [Symbol.dispose]: release,
    },
    release,
  }
}

function connectionFixture() {
  const generationListeners = new Set<() => void>()
  const generation = {
    getSnapshot: (): ConnectionGeneration | undefined => undefined,
    subscribe: (listener: () => void) => {
      generationListeners.add(listener)
      return () => { generationListeners.delete(listener) }
    },
  }
  let status: ComputerStatus = { available: false }
  const fetch = vi.fn(async () => new Response(JSON.stringify(status), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
  return {
    connection: {
      isLoopback: true,
      generation,
      state: { getSnapshot: () => undefined, subscribe: () => () => {} },
      rpc: {},
      fetch,
      reconnect: () => {},
      registerGenerationSource: () => () => {},
      start: () => ({ stop: () => {} }),
    },
    emitGeneration: () => { for (const listener of generationListeners) listener() },
    setStatus: (next: ComputerStatus) => { status = next },
    fetch,
  }
}

async function boot() {
  const ctx = new Context()
  const registered: Registered[] = []
  const slots = {
    inject: vi.fn((name: string, setup: () => (() => void) | undefined) => ctx.effect(() => setup() ?? (() => {}), `test slot: ${name}`)),
    register: vi.fn((options: Record<string, unknown>, component: unknown) => {
      const entry: Registered = { options, component, ...(options.inject === undefined ? {} : { inject: options.inject as () => unknown }) }
      registered.push(entry)
      return () => {
        const index = registered.indexOf(entry)
        if (index >= 0) registered.splice(index, 1)
      }
    }),
  }
  const locale = new LocaleRuntime(ctx)
  const currentBot = bot()
  const list = vi.fn<BotWorkspaceRemote['list']>(async () => ({ ok: true, value: { bots: [currentBot] } }))
  const remoteBots: BotWorkspaceRemote = {
    list,
    create: vi.fn(async () => ({ ok: true as const, value: { bot: currentBot } })),
    rename: vi.fn(async () => ({ ok: true as const, value: { bot: currentBot } })),
  }
  const remote = new TestRemote(ctx, { bots: remoteBots })
  const session = sessionReference(currentBot.sessionId)
  const reference = session.reference
  const sessionsList = createSnapshotStore<SessionListState>({
    ids: [currentBot.sessionId],
    byId: { [currentBot.sessionId]: {
      id: currentBot.sessionId, displayTitle: currentBot.name, running: false, retainedBy: {}, blank: true, updatedAt: 0,
    } },
    phase: 'ready',
    projectionsBySession: {},
  })
  const sessions = {
    list: sessionsList,
    refresh: vi.fn(async () => {}),
    retain: vi.fn(() => reference),
  } as Pick<ISessions, 'list' | 'refresh' | 'retain'> as ISessions
  const connection = connectionFixture()
  const mounted = createSnapshotStore<string | undefined>(undefined)
  let expanded = false
  let commandTarget: { readonly id: string } | undefined = { id: 'target' }
  let tabs: readonly { readonly id: string; readonly kind: string }[] = []
  let active: { readonly id: string; readonly kind: string } | undefined
  const availableTabs = new Set<string>(['terminal'])
  let sidebarTabsListener: (() => void) | undefined
  const sidebarRight = {
    mounted,
    isExpanded: vi.fn(() => expanded),
    toggleExpanded: vi.fn(() => { expanded = !expanded }),
    commandTarget: vi.fn(() => commandTarget),
    tabsIn: vi.fn(() => tabs),
    active: vi.fn(() => active),
    selectPanelSession: vi.fn(),
    openTabFromTarget: vi.fn(),
    focus: vi.fn(),
  }
  const sidebarRightTabs = {
    get: vi.fn<(kind: string) => object | undefined>(kind => availableTabs.has(kind) ? {} : undefined),
    subscribe: (listener: () => void) => {
      sidebarTabsListener = listener
      return () => { if (sidebarTabsListener === listener) sidebarTabsListener = undefined }
    },
  }
  const inputSources: InputTriggerSource[] = []
  const inputTriggers = {
    registerSource: vi.fn((source: InputTriggerSource) => {
      inputSources.push(source)
      return () => {
        const index = inputSources.indexOf(source)
        if (index >= 0) inputSources.splice(index, 1)
      }
    }),
  }
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale)
  ctx.provide('sessions', sessions)
  ctx.provide('connection', connection.connection as never)
  ctx.provide('sidebarRight', sidebarRight as never)
  ctx.provide('sidebarRightTabs', sidebarRightTabs as never)
  ctx.provide('inputTriggers', inputTriggers as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  await vi.waitFor(() => { expect(list).toHaveBeenCalledWith({ includeHidden: true }) })
  return {
    ctx, fiber, registered, inputSources, remote, remoteBots, sessions, connection, sidebarRight, sidebarRightTabs,
    currentBot, reference, release: session.release,
    setExpanded: (value: boolean) => { expanded = value },
    setCommandTarget: (value: { readonly id: string } | undefined) => { commandTarget = value },
    setTabs: (value: readonly { readonly id: string; readonly kind: string }[]) => { tabs = value },
    setActive: (value: { readonly id: string; readonly kind: string } | undefined) => { active = value },
    setAvailableTabs: (value: readonly string[]) => {
      availableTabs.clear()
      for (const kind of value) availableTabs.add(kind)
      sidebarTabsListener?.()
    },
  }
}

function pick(candidate: InputTriggerSource['candidates'] extends (...args: never[]) => Promise<readonly (infer C)[]> ? C : never, sessionId: SessionId): InputTriggerPick {
  return {
    candidate,
    session: { sessionId },
    position: 'inline',
    via: 'menu',
    action: 'pick',
    span: { start: 0, end: 1, draftRev: 1 },
  }
}

describe('ui-bots composition', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('keeps the node entry a loader-managed no-op', () => {
    expect(nodeApply).not.toThrow()
  })

  it('registers the roster, Conversation, request cards, mentions, and teardown effects', async () => {
    const fixture = await boot()
    const registeredNames = fixture.registered.map(entry => entry.options.name)
    expect(registeredNames).toEqual(expect.arrayContaining([
      'main', 'bots.conversation', 'conversation.composer.dock', 'conversation.bot.reply.avatar', 'sidebar.bots',
    ]))
    expect(fixture.inputSources.map(source => source.name)).toEqual(['bot', 'computer'])

    const botSource = fixture.inputSources.find(source => source.name === 'bot')!
    const candidates = await botSource.candidates(
      { sessionId: SessionId('other-session') },
      { query: 'apply', position: 'inline', drilled: false, signal: new AbortController().signal },
    )
    expect(candidates).toHaveLength(1)
    expect(botSource.onPick(pick(candidates[0]!, SessionId('other-session')))).toMatchObject({
      insert: { source: 'bot', ref: candidates[0]!.value },
    })
    fixture.remoteBots.readAvatar = vi.fn<NonNullable<BotWorkspaceRemote['readAvatar']>>(async () => ({
      ok: true as const,
      value: { avatar: fixture.currentBot.avatar!, data: 'AQID' },
    }))
    const CandidateIcon = candidates[0]!.icon
    if (CandidateIcon === undefined) throw new Error('bot candidate icon is not mounted')
    render(createElement(CandidateIcon, { size: 16 }))
    await vi.waitFor(() => { expect(screen.getByRole('img', { name: fixture.currentBot.name })).toBeTruthy() })
    expect(botSource.onPick({ ...pick(candidates[0]!, fixture.currentBot.sessionId), action: 'drill' })).toBeUndefined()

    const computer = fixture.inputSources.find(source => source.name === 'computer')!
    expect(await computer.candidates(
      { sessionId: fixture.currentBot.sessionId },
      { query: 'computer', position: 'inline', drilled: false, signal: new AbortController().signal },
    )).toEqual([])
    expect(await computer.candidates(
      { sessionId: fixture.currentBot.sessionId },
      { query: 'computer', quoted: true, position: 'inline', drilled: false, signal: new AbortController().signal },
    )).toEqual([])
    expect(computer.onPick({ ...pick({ name: 'Other' }, fixture.currentBot.sessionId), candidate: { name: 'Other' } })).toBeUndefined()
    expect(computer.openReference?.({ sessionId: fixture.currentBot.sessionId }, { ref: '@Computer' })).toBe(false)

    const main = fixture.registered.find(entry => entry.options.name === 'main')!
    const mainFace = main.inject?.() as {
      readonly hooks: {
        readonly computerTarget: { getSnapshot: () => string | null }
        readonly workspace: { getSnapshot: () => { readonly routineRevision: number } }
      }
      readonly setComputerTarget: (id: string | null) => void
      readonly loadAvatar: (botId: string, avatar: BotView['avatar']) => Promise<string>
      readonly sendGroupMessage: (text: string) => Promise<void>
    }
    expect(mainFace.hooks.computerTarget.getSnapshot()).toBeNull()
    mainFace.setComputerTarget(fixture.currentBot.sessionId)
    expect(mainFace.hooks.computerTarget.getSnapshot()).toBe(fixture.currentBot.sessionId)
    const avatar = { attachmentId: AttachmentId('apply-avatar'), mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 }
    await expect(mainFace.loadAvatar(String(fixture.currentBot.id), avatar)).resolves.toBe('data:image/png;base64,AQID')
    await expect(mainFace.sendGroupMessage('unsupported group')).rejects.toThrow(en.unexpectedResponse)

    fixture.remote.emit('bots/changed', [])
    fixture.remote.emit('schedule/changed', [])
    expect(mainFace.hooks.workspace.getSnapshot().routineRevision).toBe(2)
    const replyAvatar = fixture.registered.find(entry => entry.options.name === 'conversation.bot.reply.avatar')!
    expect(replyAvatar.inject?.()).toHaveProperty('loadAvatar')
    const sidebar = fixture.registered.find(entry => entry.options.name === 'sidebar.bots')!
    expect(sidebar.inject?.()).toHaveProperty('hooks')
    await fixture.fiber.dispose()
    expect(fixture.registered).toHaveLength(0)
    expect(fixture.inputSources).toHaveLength(0)
    expect(fixture.release).toHaveBeenCalled()
  })

  it('uses the attached download service with the exact delivery identity', async () => {
    const fixture = await boot()
    try {
      const main = fixture.registered.find(entry => entry.options.name === 'main')!
      expect(main.inject?.()).toHaveProperty('downloadLibraryFile', undefined)
      const download = vi.fn<PresentedFileDownloads['url']>().mockReturnValue('api/present.download?fixture')
      class DownloadService implements PresentedFileDownloads {
        url(sessionId: SessionId, eventSeq: number, fileIndex: number): string {
          expect(this).toBe(service)
          return download(sessionId, eventSeq, fileIndex)
        }
      }
      const service = new DownloadService()
      fixture.ctx.provide('presentedFileDownloads', service)
      const face = main.inject?.() as { readonly downloadLibraryFile: PresentedFileDownloads['url'] }
      expect(face.downloadLibraryFile(fixture.currentBot.sessionId, 7, 3)).toBe('api/present.download?fixture')
      expect(download.mock.calls).toEqual([[fixture.currentBot.sessionId, 7, 3]])
    } finally {
      await fixture.fiber.dispose()
    }
  })

  it('opens available workspace tabs and accepts Computer mentions only for the selected Bot', async () => {
    const fixture = await boot()
    const main = fixture.registered.find(entry => entry.options.name === 'main')!
    const mainFace = main.inject?.() as {
      readonly hooks: {
        readonly computerAvailability: { getSnapshot: () => string }
        readonly computerIdentity: { getSnapshot: () => object | undefined }
        readonly computerTarget: { getSnapshot: () => string | null }
        readonly computerSignIn: { getSnapshot: () => object | undefined }
      }
      readonly setComputerTarget: (id: string | null) => void
      readonly openWorkspaceTab: (kind: 'terminal' | 'computer-files' | 'computer-shared-files') => void
      readonly refreshComputerAvailability: (sessionId?: string) => void
    }

    mainFace.refreshComputerAvailability()
    mainFace.refreshComputerAvailability('')
    fixture.connection.setStatus({
      available: true,
      kind: 'vps',
      computer: {
        id: fixture.currentBot.id,
        location: 'vps',
        permissionScope: 'bot',
        terminal: true,
        files: true,
        sharedFiles: true,
      },
    })
    fixture.connection.emitGeneration()
    await vi.waitFor(() => { expect(mainFace.hooks.computerAvailability.getSnapshot()).toBe('available') })
    fixture.setAvailableTabs(['terminal', 'computer-files', 'computer-shared-files'])
    fixture.sidebarRight.mounted.set(fixture.currentBot.sessionId)
    await vi.waitFor(() => { expect(fixture.sidebarRight.selectPanelSession).toHaveBeenCalledWith('bots', fixture.currentBot.sessionId) })

    fixture.setExpanded(true)
    mainFace.setComputerTarget(fixture.currentBot.sessionId)
    expect(fixture.sidebarRight.toggleExpanded).toHaveBeenCalled()
    expect(mainFace.hooks.computerTarget.getSnapshot()).toBe(fixture.currentBot.sessionId)

    fixture.setExpanded(false)
    fixture.setTabs([])
    fixture.setActive(undefined)
    mainFace.openWorkspaceTab('terminal')
    mainFace.openWorkspaceTab('computer-files')
    mainFace.openWorkspaceTab('computer-shared-files')
    expect(fixture.sidebarRight.openTabFromTarget).toHaveBeenCalledWith('terminal', { id: 'target' })
    expect(fixture.sidebarRight.openTabFromTarget).toHaveBeenCalledWith('computer-files', { id: 'target' })
    expect(fixture.sidebarRight.openTabFromTarget).toHaveBeenCalledWith('computer-shared-files', { id: 'target' })

    fixture.setTabs([{ id: 'terminal-tab', kind: 'terminal' }])
    fixture.setActive(undefined)
    mainFace.openWorkspaceTab('terminal')
    expect(fixture.sidebarRight.focus).toHaveBeenCalledWith('terminal-tab')
    expect(fixture.sidebarRight.toggleExpanded).toHaveBeenCalled()
    fixture.setActive({ id: 'active-files', kind: 'computer-files' })
    mainFace.openWorkspaceTab('computer-files')
    expect(fixture.sidebarRight.focus).toHaveBeenCalledWith('active-files')

    fixture.setCommandTarget(undefined)
    mainFace.openWorkspaceTab('terminal')
    fixture.setCommandTarget({ id: 'target' })
    fixture.sidebarRight.mounted.set(undefined)
    mainFace.openWorkspaceTab('terminal')

    const computer = fixture.inputSources.find(source => source.name === 'computer')!
    const request = { position: 'inline' as const, drilled: false, quoted: false, signal: new AbortController().signal }
    const candidates = await computer.candidates({ sessionId: fixture.currentBot.sessionId }, { ...request, query: ' COMPUTER ' })
    expect(candidates).toHaveLength(1)
    expect(computer.onPick({ ...pick(candidates[0]!, fixture.currentBot.sessionId), candidate: candidates[0]! })).toMatchObject({
      insert: { ref: '@Computer', source: 'computer' },
    })
    expect(computer.openReference?.({ sessionId: fixture.currentBot.sessionId }, { ref: '@Computer' })).toBe(true)
    expect(computer.openReference?.({ sessionId: fixture.currentBot.sessionId }, { ref: '@Other' })).toBe(false)
    expect(computer.codec?.clipboardText('@Computer')).toBe('@Computer')
    await expect(computer.codec?.serialize('@Computer', new AbortController().signal)).resolves.toBe('@Computer')
    expect(await computer.candidates({ sessionId: fixture.currentBot.sessionId }, { ...request, query: 'x' })).toEqual([])
    expect(await computer.candidates({ sessionId: SessionId('other') }, { ...request, query: 'computer' })).toEqual([])

    const signIn = fixture.registered.find(entry => entry.options.id === 'bot-computer-sign-in')!
    const signInFace = signIn.inject?.() as {
      readonly openSignIn: (sessionId: string, requestId: string, targetSessionId?: string, origin?: string) => void
    }
    signInFace.openSignIn('other-session', 'ignored')
    expect(mainFace.hooks.computerSignIn.getSnapshot()).toBeUndefined()
    signInFace.openSignIn(fixture.currentBot.sessionId, 'request', '', '')
    expect(mainFace.hooks.computerSignIn.getSnapshot()).toMatchObject({
      sessionId: fixture.currentBot.sessionId, requestId: 'request', targetSessionId: '', origin: '', attempt: 1,
    })
    signInFace.openSignIn(fixture.currentBot.sessionId, 'request-without-optional-fields')
    expect(mainFace.hooks.computerSignIn.getSnapshot()).toMatchObject({
      sessionId: fixture.currentBot.sessionId, requestId: 'request-without-optional-fields', attempt: 2,
    })
    expect(mainFace.hooks.computerSignIn.getSnapshot()).not.toHaveProperty('targetSessionId')
    expect(mainFace.hooks.computerSignIn.getSnapshot()).not.toHaveProperty('origin')
    await fixture.fiber.dispose()
  })

  it('uses localized group failure and retry-storage messages from the registered controller', async () => {
    const fixture = await boot()
    const second = {
      ...fixture.currentBot,
      id: BotId('bot-apply-second'),
      sessionId: SessionId('session-apply-second'),
      name: 'Second Apply Bot',
    }
    const group: BotGroupView = {
      id: brandString<BotGroupId>('bot-group-apply'),
      name: 'Apply room',
      botIds: [fixture.currentBot.id, second.id],
      createdAt: 1,
      updatedAt: 1,
      bots: [fixture.currentBot, second].map(item => ({
        id: item.id, name: item.name, identity: item.identity, accent: item.accent,
        availability: item.availability, state: item.state,
      })),
    }
    fixture.remoteBots.list = vi.fn<BotWorkspaceRemote['list']>(async () => ({ ok: true, value: { bots: [fixture.currentBot, second] } }))
    fixture.remoteBots.listGroups = vi.fn(async () => ({ ok: true as const, value: { groups: [group] } }))
    fixture.remoteBots.inspectGroup = vi.fn(async () => ({ ok: true as const, value: {
      group, messages: [],
    } satisfies BotGroupInspectValue }))
    fixture.remoteBots.createGroup = vi.fn(async () => ({ ok: true as const, value: { group } }))
    fixture.remoteBots.updateGroup = vi.fn(async () => ({ ok: true as const, value: { group } }))
    fixture.remoteBots.sendGroupMessage = vi.fn<NonNullable<BotWorkspaceRemote['sendGroupMessage']>>(async request => ({ ok: true as const, value: {
      messageId: request.messageId as BotGroupMessageId, status: 'accepted' as const, deliveries: [],
    } }))
    fixture.remote.emit('bots/changed', [])
    await vi.waitFor(() => { expect(fixture.registered.find(entry => entry.options.name === 'main')?.inject?.()).toMatchObject({ groupsAvailable: true }) })
    const main = fixture.registered.find(entry => entry.options.name === 'main')!
    const mainFace = main.inject?.() as {
      readonly hooks: { readonly workspace: { getSnapshot: () => { readonly groups: readonly unknown[] } } }
      readonly selectGroup: (id: string) => void
      readonly sendGroupMessage: (
        text: string, messageId?: string, targetBotIds?: readonly string[], replyToMessageId?: string,
      ) => Promise<void>
      readonly createGroup: (creation: { readonly name: string; readonly botIds: readonly string[] }) => Promise<void>
    }
    await vi.waitFor(() => { expect(mainFace.hooks.workspace.getSnapshot().groups).toHaveLength(1) })
    mainFace.selectGroup(String(group.id))
    await vi.waitFor(() => { expect(fixture.remoteBots.inspectGroup).toHaveBeenCalled() })
    await expect(mainFace.sendGroupMessage('invalid reply', undefined, [String(second.id)], 'invalid-parent'))
      .rejects.toThrow(en.groupDeliveryFailure)

    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('storage unavailable') },
    })
    await expect(mainFace.createGroup({ name: 'Retry copy', botIds: [String(fixture.currentBot.id), String(second.id)] }))
      .rejects.toThrow(en.groupCreateRetryUnavailable)
    await fixture.fiber.dispose()
  })
})
