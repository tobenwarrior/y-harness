// @vitest-environment jsdom

import type { ComponentProps } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionBinding, SessionListState, SessionReference } from '@yharness/api-session-controller/client'
import { BotId, type BotView } from '@yharness/bots/client'
import type { GlobalStandardProps } from '@yharness/client-ui-slots'
import type { WorkspaceSnapshot } from '@yharness/api-workspace-controller/client'
import { makeTranslate } from '@yharness/client-test-runtime'
import { SessionId } from '@yharness/session/types'
import { en } from '../src/client/locales.ts'
import {
  BotReplyAvatar, BotsConversation, BotsPanel,
  type BotsConversationProps, type BotsPanelProps,
} from '../src/client/panel.tsx'
import type { BotWorkspaceState } from '../src/client/controller.ts'
import type { ComputerClient, ComputerIdentity } from '../src/client/computer-client.ts'

afterEach(cleanup)

const t = makeTranslate(en)

function bot(id = 'reply', name = 'Research partner'): BotView {
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
    useSession: unused('useSession') as BotsConversationProps['useSession'],
    sessionId: undefined,
    useProjection: unused('useProjection') as BotsConversationProps['useProjection'],
    useConversation: unused('useConversation') as BotsConversationProps['useConversation'],
    useInput: unused('useInput') as BotsConversationProps['useInput'],
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
      return <span data-testid="conversation-slot">{selected.name}</span>
    }
    const props = panelProps(state, reference, renderSlot)
    render(<BotsPanel {...props} />)

    expect(screen.getByTestId('conversation-slot').textContent).toBe(selected.name)
    expect(calls).toEqual([{ key: 'bots.conversation', props: { bot: { name: selected.name } } }])
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

    expect(screen.getByText('VPS Bot computer')).toBeTruthy()
  })
})

function panelProps(
  state: BotWorkspaceState,
  reference: SessionReference | undefined,
  renderSlot: BotsPanelProps['renderSlot'],
  options: {
    readonly availability?: 'checking' | 'available' | 'mac' | 'unavailable'
    readonly identity?: ComputerIdentity
    readonly target?: string
  } = {},
): BotsPanelProps {
  const useWorkspace: BotsPanelProps['useWorkspace'] = selector => selector(state)
  const useComputerAvailability: BotsPanelProps['useComputerAvailability'] = selector => selector(options.availability ?? 'unavailable')
  const useComputerIdentity: BotsPanelProps['useComputerIdentity'] = selector => selector(options.identity)
  const useComputerTarget: BotsPanelProps['useComputerTarget'] = selector => selector(options.target ?? null)
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
    reference: () => reference,
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
    setComputerTarget: () => {},
    computer: computerClient(),
    renderSlot,
    SessionProvider,
    t,
  }
}
