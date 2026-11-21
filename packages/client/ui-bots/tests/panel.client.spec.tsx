// @vitest-environment jsdom

import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionBinding, SessionListState, SessionReference } from '@yharness/api-session-controller/client'
import { BotId, BotPrincipalId, type BotView } from '@yharness/bots/client'
import { AttachmentId } from '@yharness/attachment'
import type { GlobalStandardProps } from '@yharness/client-ui-slots'
import type { WorkspaceSnapshot } from '@yharness/api-workspace-controller/client'
import { makeTranslate } from '@yharness/client-test-runtime'
import { SessionId } from '@yharness/session/types'
import { en } from '../src/client/locales.ts'
import { BotsPanelIcon } from '../src/client/BotsPanelIcon.tsx'
import {
  BotReplyAvatar, BotsConversation, BotsPanel, BotsRoster,
  type BotsConversationProps, type BotsPanelProps, type BotsRosterProps, type ComputerSignInTarget,
} from '../src/client/panel.tsx'
import { createSharedBotsClient } from '../src/client/shared-client.ts'
import type { BotWorkspaceState } from '../src/client/controller.ts'
import type { ComputerClient, ComputerIdentity } from '../src/client/computer-client.ts'
import type { SessionPendingInteractionBase, SessionStatusSnapshot } from '@yharness/client-ui-session/client'

afterEach(cleanup)

const t = makeTranslate(en)

function bot(id = 'reply', name = 'Research partner', patch: Partial<BotView> = {}): BotView {
  return {
    id: BotId(id),
    sessionId: SessionId(`${id}-session`),
    name,
    identity: 'browse',
    accent: 'teal',
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

function workspaceState(bots: readonly BotView[], selectedBotId: BotId | null): BotWorkspaceState {
  return {
    phase: 'ready',
    bots,
    selectedBotId,
    groups: [],
    selectedGroupId: null,
    routineRevision: 0,
    selectedGroup: null,
    groupPhase: 'idle',
    groupError: null,
    templates: {
      phase: 'idle',
      templates: [],
      code: '',
      preview: null,
      error: null,
      busy: false,
    },
    error: null,
  }
}

const emptySessionList: SessionListState = {
  ids: [],
  byId: {},
  phase: 'ready',
  projectionsBySession: {},
}

const emptyWorkspace: WorkspaceSnapshot = {
  items: [],
  archivedSessionIds: [],
  pinnedSessionIds: [],
  state: 'idle',
  phase: 'ready',
  error: null,
}

const useSessions: GlobalStandardProps['useSessions'] = selector => selector(emptySessionList)
const useSessionStatus: GlobalStandardProps['useSessionStatus'] = selector => selector(new Map<never, never>())
const useSessionRetainInfo: GlobalStandardProps['useSessionRetainInfo'] = () => undefined
const useWorkspaces: GlobalStandardProps['useWorkspaces'] = selector => selector(emptyWorkspace)
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined })) as GlobalStandardProps['useResource']

function sessionReference(sessionId: SessionId): SessionReference {
  const release = vi.fn()
  return {
    sessionId,
    binding: {} as SessionBinding,
    ready: Promise.resolve({} as SessionBinding),
    release,
    [Symbol.dispose]: release,
  }
}

function computerClient(): ComputerClient {
  return {
    status: async () => ({ available: false }),
    frame: async () => ({ jpeg: '', width: 1, height: 1, mode: 'watching', botActive: false }),
    takeControl: async () => ({ mode: 'watching' }),
    releaseControl: async () => ({ mode: 'watching' }),
    input: async () => ({ mode: 'watching' }),
  }
}

type ReplyAvatarProps = ComponentProps<typeof BotReplyAvatar>

function replyAvatarProps(state: BotWorkspaceState, sessionId: SessionId): ReplyAvatarProps {
  const useWorkspace: ReplyAvatarProps['useWorkspace'] = selector => selector(state)
  const useSession: ReplyAvatarProps['useSession'] = () => { throw new Error('unused in BotReplyAvatar test') }
  const useProjection: ReplyAvatarProps['useProjection'] = () => { throw new Error('unused in BotReplyAvatar test') }
  const useConversation: ReplyAvatarProps['useConversation'] = () => { throw new Error('unused in BotReplyAvatar test') }
  const useInput: ReplyAvatarProps['useInput'] = () => { throw new Error('unused in BotReplyAvatar test') }
  const useChat: ReplyAvatarProps['useChat'] = () => { throw new Error('unused in BotReplyAvatar test') }
  const useTrajectory: ReplyAvatarProps['useTrajectory'] = () => { throw new Error('unused in BotReplyAvatar test') }
  return {
    sessionId,
    useWorkspace,
    useSessions,
    useSessionStatus,
    useSessionRetainInfo,
    usePanelInfo,
    useResource,
    useWorkspaces,
    useSession,
    useProjection,
    useConversation,
    useInput,
    inputActions: {} as never,
    useChat,
    useTrajectory,
    loadAvatar: vi.fn(async () => ''),
  }
}

function conversationProps(
  bot: { name: string },
  renderFactorySlot: BotsConversationProps['renderFactorySlot'],
): BotsConversationProps {
  const unused = (name: string) => () => { throw new Error(`${name} is unused in this BotsConversation test`) }
  return {
    bot,
    renderFactorySlot,
    useSession: unused('useSession'),
    sessionId: undefined,
    useProjection: unused('useProjection'),
    useConversation: unused('useConversation'),
    useInput: unused('useInput'),
    inputActions: {} as never,
    useSessions,
    useSessionStatus,
    useSessionRetainInfo,
    usePanelInfo,
    useResource,
    useWorkspaces,
  }
}

describe('Bots conversation slot wiring', () => {
  it('renders the decorative Bots glyph at the sidebar size', () => {
    const { container } = render(<BotsPanelIcon
      size={18}
      active={false}
      {...{ usePanelInfo, useSessions, useSessionStatus, useSessionRetainInfo, useResource, useWorkspaces }}
    />)
    const glyph = container.querySelector('svg')
    expect(glyph?.getAttribute('width')).toBe('18')
    expect(glyph?.getAttribute('height')).toBe('18')
    expect(glyph?.getAttribute('aria-hidden')).toBe('true')
  })

  it('renders the roster avatar for the matching Session and omits an unknown Session', () => {
    const matching = bot()
    const state = workspaceState([matching], matching.id)
    render(<BotReplyAvatar {...replyAvatarProps(state, matching.sessionId)} />)
    expect(screen.getByRole('img', { name: matching.name })).toBeTruthy()

    cleanup()
    render(<BotReplyAvatar {...replyAvatarProps(state, SessionId('missing-session'))} />)
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('forwards the selected Bot display identity to the embedded Conversation factory', () => {
    const calls: Array<{ key: string; props: object }> = []
    const renderFactorySlot: BotsConversationProps['renderFactorySlot'] = (key, props) => {
      calls.push({ key, props })
      return <span data-testid="conversation-content">Conversation</span>
    }
    render(<BotsConversation {...conversationProps({ name: 'Research partner' }, renderFactorySlot)} />)

    expect(screen.getByTestId('conversation-content')).toBeTruthy()
    expect(calls).toEqual([{
      key: 'conversation.content',
      props: { variant: 'embedded', phase: 'active', hero: false, bot: { name: 'Research partner' } },
    }])
  })

  it('keeps the selected Bot visible without rendering a Conversation until its Session is retained', () => {
    const selected = bot()
    const state = workspaceState([selected], selected.id)
    const calls: Array<{ key: string; props: object }> = []
    const renderSlot: BotsPanelProps['renderSlot'] = (key, props) => {
      calls.push({ key, props })
      return <span data-testid="conversation-slot">Conversation</span>
    }
    const props = panelProps(state, undefined, renderSlot)
    render(<BotsPanel {...props} />)

    expect(screen.getByRole('region', { name: selected.name })).toBeTruthy()
    expect(screen.getByRole('status')).toBeTruthy()
    expect(calls).toEqual([])
  })

  it('binds the retained Session before rendering the selected Bot Conversation', () => {
    const selected = bot()
    const state = workspaceState([selected], selected.id)
    const reference = sessionReference(selected.sessionId)
    const calls: Array<{ key: string; props: object }> = []
    const renderSlot: BotsPanelProps['renderSlot'] = (key, props) => {
      calls.push({ key, props })
      return key === 'bots.conversation' ? <span data-testid="conversation-slot">{selected.name}</span> : null
    }
    const props = panelProps(state, reference, renderSlot)
    render(<BotsPanel {...props} />)

    expect(screen.getByTestId('conversation-slot').textContent).toBe(selected.name)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({ key: 'bots.conversation', props: { bot: { name: selected.name } } })
    const agents = calls[1]!
    expect(agents.key).toBe('conversation.session.header.agents')
    expect('beforeOpen' in agents.props && typeof agents.props.beforeOpen).toBe('function')
  })

  it('shows the VPS Bot scope beside the Computer affordance before opening it', () => {
    const selected = bot()
    const state = workspaceState([selected], selected.id)
    const reference = sessionReference(selected.sessionId)
    const renderSlot: BotsPanelProps['renderSlot'] = () => <span data-testid="conversation-slot">Conversation</span>
    const props = panelProps(state, reference, renderSlot, {
      availability: 'available',
      identity: { id: selected.sessionId, location: 'vps', permissionScope: 'bot' },
      target: selected.sessionId,
    })
    render(<BotsPanel {...props} />)

    expect(screen.getByText('Dedicated VPS desktop')).toBeTruthy()
  })

  it('offers private and shared workspace choices from the Files action', () => {
    const selected = bot()
    const state = workspaceState([selected], selected.id)
    const reference = sessionReference(selected.sessionId)
    const openWorkspaceTab = vi.fn<BotsPanelProps['openWorkspaceTab']>()
    const renderSlot: BotsPanelProps['renderSlot'] = () => <span data-testid="conversation-slot">Conversation</span>
    const props = panelProps(state, reference, renderSlot, {
      availability: 'available',
      identity: { id: selected.sessionId, location: 'vps', permissionScope: 'bot', files: true, sharedFiles: true },
      target: selected.sessionId,
      filesAvailable: true,
      sharedFilesAvailable: true,
      openWorkspaceTab,
    })
    render(<BotsPanel {...props} />)

    fireEvent.click(screen.getByRole('button', { name: en.botMenu }))
    expect(screen.getByRole('menuitem', { name: en.filesPrivateWorkspace })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: en.filesSharedWorkspace }))
    expect(openWorkspaceTab).toHaveBeenCalledWith('computer-shared-files')

    fireEvent.click(screen.getByRole('button', { name: en.botMenu }))
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: en.botMenu }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.filesPrivateWorkspace }))
    expect(openWorkspaceTab).toHaveBeenCalledWith('computer-files')
  })

  it('offers only private files without shared workspace access', () => {
    const selected = bot()
    const state = workspaceState([selected], selected.id)
    const reference = sessionReference(selected.sessionId)
    const openWorkspaceTab = vi.fn<BotsPanelProps['openWorkspaceTab']>()
    const renderSlot: BotsPanelProps['renderSlot'] = () => <span data-testid="conversation-slot">Conversation</span>
    render(<BotsPanel {...panelProps(state, reference, renderSlot, {
      availability: 'available',
      identity: { id: selected.sessionId, location: 'vps', permissionScope: 'bot', files: true },
      target: selected.sessionId,
      filesAvailable: true,
      openWorkspaceTab,
    })} />)

    fireEvent.click(screen.getByRole('button', { name: en.botMenu }))
    expect(screen.queryByRole('menuitem', { name: en.filesSharedWorkspace })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: en.filesLabel }))
    expect(openWorkspaceTab).toHaveBeenCalledWith('computer-files')
  })

  it('renders Computer and terminal controls for the selected Bot and closes the Computer panel', () => {
    const selected = bot()
    const state = workspaceState([selected], selected.id)
    const reference = sessionReference(selected.sessionId)
    const setComputerTarget = vi.fn<BotsPanelProps['setComputerTarget']>()
    const openWorkspaceTab = vi.fn<BotsPanelProps['openWorkspaceTab']>()
    const renderSlot: BotsPanelProps['renderSlot'] = () => <span data-testid="conversation-slot">Conversation</span>
    render(<BotsPanel {...panelProps(state, reference, renderSlot, {
      availability: 'available',
      identity: { id: selected.sessionId, location: 'vps', permissionScope: 'bot', terminal: true, terminalInternet: true },
      target: null,
      terminalAvailable: true,
      setComputerTarget,
      openWorkspaceTab,
    })} />)

    fireEvent.click(screen.getByRole('button', { name: en.computerOpen }))
    expect(setComputerTarget).toHaveBeenCalledWith(selected.sessionId)
    fireEvent.click(screen.getByRole('button', { name: en.botMenu }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.terminalLabel }))
    expect(openWorkspaceTab).toHaveBeenCalledWith('terminal')

    cleanup()
    render(<BotsPanel {...panelProps(state, reference, renderSlot, {
      availability: 'available',
      identity: { id: selected.sessionId, location: 'vps', permissionScope: 'bot' },
      target: selected.sessionId,
      setComputerTarget,
    })} />)
    const closeButtons = screen.getAllByRole('button', { name: en.computerClose })
    fireEvent.click(closeButtons[0]!)
    expect(setComputerTarget).toHaveBeenCalledWith(null)
    fireEvent.click(closeButtons.at(-1)!)
    expect(setComputerTarget).toHaveBeenLastCalledWith(null)
    expect(setComputerTarget.mock.calls.filter(([target]) => target === null)).toHaveLength(2)
  })

  it('renders the selected group through the group detail entrypoint', () => {
    const first = bot('group-first', 'First bot')
    const second = bot('group-second', 'Second bot')
    const group = {
      id: 'group-panel', name: 'Release room', bots: [
        { id: first.id, name: first.name, identity: first.identity, accent: first.accent },
        { id: second.id, name: second.name, identity: second.identity, accent: second.accent },
      ],
      messages: [],
    }
    const state = {
      ...workspaceState([first, second], first.id),
      groups: [group], selectedGroupId: group.id, selectedGroup: group, groupPhase: 'ready' as const,
    }
    const reference = sessionReference(first.sessionId)
    const renderSlot: BotsPanelProps['renderSlot'] = () => null
    render(<BotsPanel {...panelProps(state, reference, renderSlot, { groupsAvailable: true })}
      reactGroupMessage={vi.fn(async () => {})} />)

    expect(screen.getByRole('region', { name: group.name })).toBeTruthy()
    expect(screen.getByText(en.groupEmptyDescription)).toBeTruthy()
  })

  it('projects workspace state and live Session status into the shared Bot roster', () => {
    const working = { ...bot('roster-working', 'Working bot'), description: 'Ships changes', persona: 'Precise', capabilities: ['release'], group: 'Build' }
    const preparing = { ...bot('roster-preparing', 'Preparing bot'), state: 'provisioning' as const }
    const idle = bot('roster-idle', 'Idle bot')
    const unknown = bot('roster-unknown', 'Unknown bot')
    const needs = bot('roster-needs', 'Needs bot')
    const approval: SessionPendingInteractionBase = {
      key: 'roster-approval', kind: 'approval', sessionId: needs.sessionId,
    }
    const state = workspaceState([working, preparing, idle, unknown, needs], working.id)
    const statuses: SessionStatusSnapshot = new Map([
      [working.sessionId, { running: true, pendingInteraction: undefined, completionUnread: false }],
      [idle.sessionId, { running: false, pendingInteraction: undefined, completionUnread: false }],
      [needs.sessionId, { running: false, pendingInteraction: approval, completionUnread: false }],
    ])
    const select = vi.fn()
    const selectGroup = vi.fn()
    const useWorkspace: BotsRosterProps['useWorkspace'] = selector => selector(state)
    const useSessionStatus: BotsRosterProps['useSessionStatus'] = selector => selector(statuses)
    const props: BotsRosterProps = {
      wide: true,
      expandSidebar: () => {},
      usePanelInfo,
      useSessions,
      useSessionRetainInfo,
      useWorkspaces,
      useResource,
      useWorkspace,
      useSessionStatus,
      reference: () => undefined,
      select,
      selectGroup,
      create: async () => {},
      groupsAvailable: true,
      rename: async () => {},
      createGroup: async () => {},
      updateGroup: async () => {},
      sendGroupMessage: async () => {},
      sendGroupMessageWithAttachments: async () => {},
      retryGroup: () => {},
      loadAvatar: async () => '',
      retry: () => {},
      t,
    }
    render(<BotsRoster {...props} />)

    expect(screen.getByRole('button', { name: 'Working bot, Working' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Preparing bot, Preparing' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Idle bot' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Idle bot, Idle' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Needs bot, Needs you' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Unknown bot' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Idle bot' }))
    expect(select).toHaveBeenCalledWith(idle.id)

  })

  it('keeps a populated roster out of its loading skeleton and projects an avatar', () => {
    const avatarBot = bot('roster-avatar', 'Avatar bot', {
      avatar: { attachmentId: AttachmentId('roster-avatar'), mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
    })
    const state = { ...workspaceState([avatarBot], avatarBot.id), phase: 'loading' as const }
    const props: BotsRosterProps = {
      wide: true,
      expandSidebar: () => {},
      usePanelInfo,
      useSessions,
      useSessionRetainInfo,
      useWorkspaces,
      useResource,
      useWorkspace: selector => selector(state),
      useSessionStatus,
      reference: () => undefined,
      select: () => {},
      selectGroup: () => {},
      create: async () => {},
      groupsAvailable: false,
      rename: async () => {},
      createGroup: async () => {},
      updateGroup: async () => {},
      sendGroupMessage: async () => {},
      sendGroupMessageWithAttachments: async () => {},
      retryGroup: () => {},
      loadAvatar: async () => '',
      retry: () => {},
      t,
    }
    render(<BotsRoster {...props} />)

    expect(screen.queryByRole('status', { name: en.loading })).toBeNull()
    expect(screen.getByRole('button', { name: 'Avatar bot' })).toBeTruthy()
  })

  it('renders a loading group detail without optional reaction controls', () => {
    const first = bot('group-loading-first', 'Loading first')
    const second = bot('group-loading-second', 'Loading second')
    const state = {
      ...workspaceState([first, second], null),
      groups: [{ id: 'group-loading', name: 'Loading room', bots: [] }],
      selectedGroupId: 'group-loading',
      selectedGroup: null,
      groupPhase: 'loading' as const,
    }
    render(<BotsPanel {...panelProps(state, undefined, () => null, { groupsAvailable: true })} />)

    expect(screen.getByRole('heading', { name: en.groupLoadingTitle })).toBeTruthy()
  })

  it('renders Computer without a selected Bot and labels a terminal with disabled Internet', () => {
    const selected = bot('terminal-disabled', 'Terminal disabled')
    const reference = sessionReference(selected.sessionId)
    const setComputerTarget = vi.fn<BotsPanelProps['setComputerTarget']>()
    const openWorkspaceTab = vi.fn<BotsPanelProps['openWorkspaceTab']>()
    const state = workspaceState([selected], selected.id)
    render(<BotsPanel {...panelProps(state, reference, () => null, {
      availability: 'available',
      identity: { id: reference.sessionId, location: 'vps', permissionScope: 'bot', terminal: true, terminalInternet: false },
      target: reference.sessionId,
      terminalAvailable: true,
      setComputerTarget,
      openWorkspaceTab,
    })} />)

    fireEvent.click(screen.getByRole('button', { name: en.botMenu }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.terminalLabel }))
    expect(openWorkspaceTab).toHaveBeenCalledWith('terminal')

    cleanup()
    render(<BotsPanel {...panelProps(workspaceState([], null), reference, () => null, {
      availability: 'available',
      identity: { id: reference.sessionId, location: 'vps', permissionScope: 'bot' },
      target: reference.sessionId,
    })} />)
    expect(screen.getByRole('region', { name: en.computerTitle })).toBeTruthy()
  })

  it('passes sharing and collaborator clients through the roster face', () => {
    const selected = bot('roster-shared', 'Shared Bot')
    const state = workspaceState([selected], selected.id)
    const sharedClient = createSharedBotsClient({ call: async () => ({ ok: true, value: undefined }) })
    const share: NonNullable<BotsRosterProps['share']> = {
      listMembers: async () => ({ botId: selected.id, members: [] }),
      createInvite: async () => ({ code: 'invite', expiresAt: 1 }),
      revokeMember: async () => ({ botId: selected.id, principalId: BotPrincipalId('principal'), revoked: true }),
    }
    const props: BotsRosterProps = {
      wide: false,
      expandSidebar: () => {},
      usePanelInfo,
      useSessions,
      useSessionRetainInfo,
      useWorkspaces,
      useResource,
      useWorkspace: selector => selector(state),
      useSessionStatus,
      reference: () => undefined,
      select: () => {},
      selectGroup: () => {},
      create: async () => {},
      groupsAvailable: false,
      rename: async () => {},
      createGroup: async () => {},
      updateGroup: async () => {},
      sendGroupMessage: async () => {},
      sendGroupMessageWithAttachments: async () => {},
      retryGroup: () => {},
      loadAvatar: async () => '',
      retry: () => {},
      share,
      sharedClient,
      t,
    }
    render(<BotsRoster {...props} />)
    expect(screen.getByRole('button', { name: 'Shared Bot' })).toBeTruthy()
    sharedClient.dispose?.()
  })

  it('renders optional detail controls for loading, Grok history, sign-in, and macOS Computer', () => {
    const selected = bot('panel-options', 'Options Bot')
    const loadingState = { ...workspaceState([], null), phase: 'loading' as const }
    render(<BotsPanel {...panelProps(loadingState, undefined, () => null)} />)
    expect(screen.getByRole('heading', { name: en.loadingTitle })).toBeTruthy()

    cleanup()
    const reference = sessionReference(selected.sessionId)
    const share: NonNullable<BotsPanelProps['share']> = {
      listMembers: async () => ({ botId: selected.id, members: [] }),
      createInvite: async () => ({ code: 'invite', expiresAt: 1 }),
      revokeMember: async () => ({ botId: selected.id, principalId: BotPrincipalId('principal'), revoked: true }),
    }
    const refreshComputerAvailability = vi.fn<NonNullable<BotsPanelProps['refreshComputerAvailability']>>()
    const signIn: ComputerSignInTarget = {
      sessionId: selected.sessionId, requestId: 'sign-in-request', attempt: 1,
      targetSessionId: 'browser-session', origin: 'https://example.test',
    }
    const state = workspaceState([selected], selected.id)
    const props = panelProps(state, reference, () => null, {
      availability: 'available',
      identity: { id: selected.sessionId, location: 'vps', permissionScope: 'bot', terminal: true, files: true },
      target: selected.sessionId,
      terminalAvailable: true,
      filesAvailable: true,
      openWorkspaceTab: vi.fn(),
      signIn,
      refreshComputerAvailability,
    })
    render(<BotsPanel {...props}
      readGrokHistory={vi.fn(async () => null)}
      share={share} />)
    expect(screen.getByRole('region', { name: selected.name })).toBeTruthy()
    expect(refreshComputerAvailability).not.toHaveBeenCalled()

    cleanup()
    render(<BotsPanel {...panelProps(state, reference, () => null, {
      availability: 'mac',
      target: selected.sessionId,
    })} />)
    expect(screen.getByRole('region', { name: selected.name })).toBeTruthy()
  })
})

function panelProps(
  state: BotWorkspaceState,
  reference: SessionReference | undefined,
  renderSlot: BotsPanelProps['renderSlot'],
  options: {
    readonly availability?: 'checking' | 'available' | 'mac' | 'unavailable'
    readonly identity?: ComputerIdentity
    readonly target?: string | null
    readonly filesAvailable?: boolean
    readonly sharedFilesAvailable?: boolean
    readonly terminalAvailable?: boolean
    readonly groupsAvailable?: boolean
    readonly setComputerTarget?: BotsPanelProps['setComputerTarget']
    readonly openWorkspaceTab?: BotsPanelProps['openWorkspaceTab']
    readonly signIn?: ComputerSignInTarget
    readonly refreshComputerAvailability?: BotsPanelProps['refreshComputerAvailability']
  } = {},
): BotsPanelProps {
  const useWorkspace: BotsPanelProps['useWorkspace'] = selector => selector(state)
  const useComputerAvailability: BotsPanelProps['useComputerAvailability'] = selector => selector(options.availability ?? 'unavailable')
  const useComputerIdentity: BotsPanelProps['useComputerIdentity'] = selector => selector(options.identity)
  const useComputerTarget: BotsPanelProps['useComputerTarget'] = selector => selector(options.target === undefined ? null : options.target)
  const SessionProvider: BotsPanelProps['SessionProvider'] = ({ children }) => <>{children}</>
  return {
    usePanelInfo,
    useSessions,
    useSessionStatus,
    useSessionRetainInfo,
    useResource,
    useWorkspaces,
    useWorkspace,
    useComputerAvailability,
    useComputerIdentity,
    useComputerTarget,
    useComputerSignIn: selector => selector(options.signIn),
    useTerminalAvailable: selector => selector(options.terminalAvailable ?? false),
    useFilesAvailable: selector => selector(options.filesAvailable ?? false),
    useSharedFilesAvailable: selector => selector(options.sharedFilesAvailable ?? false),
    openWorkspaceTab: options.openWorkspaceTab ?? (() => {}),
    ...(options.refreshComputerAvailability === undefined ? {} : { refreshComputerAvailability: options.refreshComputerAvailability }),
    reference: () => reference,
    select: () => {},
    selectGroup: () => {},
    create: async () => {},
    groupsAvailable: options.groupsAvailable ?? false,
    rename: async () => {},
    createGroup: async () => {},
    updateGroup: async () => {},
    sendGroupMessage: async () => {},
    sendGroupMessageWithAttachments: async () => {},
    retryGroup: () => {},
    loadAvatar: async () => '',
    retry: () => {},
    setComputerTarget: options.setComputerTarget ?? (() => {}),
    computer: computerClient(),
    renderSlot,
    SessionProvider,
    t,
  }
}
