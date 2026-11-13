// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BotId, type BotView } from '@yharness/bots/client'
import type { SessionReference } from '@yharness/api-session-controller/client'
import { SessionId } from '@yharness/session'
import { makeTranslate } from '@yharness/client-test-runtime'
import { BotsPanel, type BotsPanelProps } from '../src/client/panel.tsx'
import type { BotWorkspaceState } from '../src/client/controller.ts'
import type { ComputerClient, ComputerIdentity } from '../src/client/computer-client.ts'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)

const bot: BotView = {
  id: BotId('research'),
  sessionId: SessionId('session-research'),
  name: 'Research partner',
  identity: 'agent',
  accent: 'violet',
  cwd: '/workspace',
  state: 'active',
  createdAt: 1,
  updatedAt: 1,
  availability: 'idle',
  pinned: false,
  hidden: false,
}

const state: BotWorkspaceState = {
  phase: 'ready',
  bots: [bot],
  selectedBotId: bot.id,
  groups: [],
  selectedGroupId: null,
  routineRevision: 0,
  selectedGroup: null,
  groupPhase: 'idle',
  groupError: null,
  templates: { phase: 'idle', templates: [], code: '', preview: null, error: null, busy: false },
  error: null,
}

function reference(): SessionReference {
  const release = vi.fn()
  return {
    sessionId: bot.sessionId,
    binding: {} as never,
    ready: Promise.resolve({} as never),
    release,
    [Symbol.dispose]: release,
  }
}

function computer(): ComputerClient {
  return {
    status: vi.fn().mockResolvedValue({
      available: true,
      kind: 'vps',
      computer: { id: 'shared-vps', location: 'vps', permissionScope: 'workspace' },
    }),
    frame: vi.fn().mockResolvedValue({ jpeg: 'screen', width: 100, height: 50, mode: 'watching', botActive: false }),
    takeControl: vi.fn().mockResolvedValue({ mode: 'controlling' }),
    releaseControl: vi.fn().mockResolvedValue({ mode: 'watching' }),
    input: vi.fn().mockResolvedValue({ mode: 'controlling' }),
  }
}

function panelProps(identity: ComputerIdentity | undefined): BotsPanelProps {
  const selectedReference = reference()
  return {
    useWorkspace: <T,>(selector: (value: BotWorkspaceState) => T): T => selector(state),
    useSessionStatus: <T,>(selector: (value: ReadonlyMap<string, { readonly running: boolean }>) => T): T => selector(new Map()),
    reference: () => selectedReference,
    retryGroup: vi.fn(),
    updateGroup: vi.fn(async () => {}),
    sendGroupMessage: vi.fn(async () => {}),
    sendGroupMessageWithAttachments: vi.fn(async () => {}),
    reactGroupMessage: vi.fn(async () => {}),
    groupsAvailable: false,
    loadAvatar: vi.fn(async () => ''),
    rename: vi.fn(async () => {}),
    updateProfile: vi.fn(async () => {}),
    memoryManager: undefined,
    readGrokHistory: undefined,
    routineManager: undefined,
    skillManager: undefined,
    SessionProvider: ({ children }: { readonly children: ReactNode }) => children,
    renderSlot: () => <span data-testid="conversation">Conversation</span>,
    t,
    computer: computer(),
    useComputerAvailability: <T,>(selector: (value: 'available') => T): T => selector('available'),
    setComputerTarget: vi.fn(),
    useComputerTarget: <T,>(selector: (value: string | null) => T): T => selector(bot.sessionId),
    useComputerIdentity: <T,>(selector: (value: ComputerIdentity | undefined) => T): T => selector(identity),
  } as BotsPanelProps
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('BotsPanel Computer selection', () => {
  it('renders the selected Session Computer and handles an absent identity', async () => {
    const view = render(<BotsPanel {...panelProps({ id: 'shared-vps', location: 'vps', permissionScope: 'workspace' })} />)
    const action = (await screen.findAllByRole('button', { name: 'Close computer panel' }))
      .find(button => within(button).queryByText('Shared VPS desktop') !== null)
    if (action === undefined) throw new Error('Computer action button is missing')

    expect(within(action).getByText('Shared VPS desktop')).toBeTruthy()
    expect(screen.getByTestId('conversation')).toBeTruthy()
    expect(document.querySelector('[data-computer-panel]')).toBeTruthy()

    view.rerender(<BotsPanel {...panelProps(undefined)} />)
    expect(within(screen.getByRole('button', { name: 'Close computer panel', pressed: true })).queryByText('Shared VPS desktop')).toBeNull()
  })
})
