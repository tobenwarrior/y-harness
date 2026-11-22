// @vitest-environment jsdom
/**
 * Bot-only presentation of a successful request_app_connection result.
 * The technical tool row remains hidden by Chat; the Turn tail keeps the
 * owner-facing connection action available in the same conversation.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@yharness/client-test-runtime'
import type {
  ConversationLocationDataSource, ConversationLocationDataStore, ConversationMatch, ConversationTurnDataMap, TurnLocation,
} from '@yharness/client-ui-conversation/client'
import type { SessionEvent } from '@yharness/session/types'
import { createToolResultMessage, ToolCallId } from '@yharness/llm'
import type { BotView } from '@yharness/bots/client'
import { BotId } from '@yharness/bots/client'
import { SessionId } from '@yharness/session/types'
import type { BotWorkspaceState } from '../src/client/controller.ts'
import { BotAppConnectionCard, type BotAppConnectionCardProps } from '../src/client/BotAppConnectionCard.tsx'
import {
  appConnectionRequestsForClosing, botAppConnectionTurnDefinition, BOT_APP_CONNECTION_TURN_KEY,
  REQUEST_APP_CONNECTION_TOOL, selectBotAppConnectionRequests,
} from '../src/client/bot-app-connection.ts'
import { en } from '../src/client/locales.ts'
import type { GitHubAppSignInActions, GitHubAppSignInView } from '../src/client/types.ts'

afterEach(cleanup)

class TestTurnDataStore implements ConversationLocationDataStore<ConversationTurnDataMap> {
  get<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
  ): Readonly<ConversationTurnDataMap[Key]> | undefined {
    return this.values.get(key) as Readonly<ConversationTurnDataMap[Key]> | undefined
  }

  private readonly values = new Map<string, unknown>()
  private readonly sources = new Map<string, ConversationLocationDataSource<unknown>>()

  source<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
  ): ConversationLocationDataSource<Readonly<ConversationTurnDataMap[Key]> | undefined> {
    let source = this.sources.get(key)
    if (source === undefined) {
      source = { getSnapshot: () => this.get(key), subscribe: () => () => {} }
      this.sources.set(key, source)
    }
    return source as ConversationLocationDataSource<Readonly<ConversationTurnDataMap[Key]> | undefined>
  }

  set<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
    value: ConversationTurnDataMap[Key],
  ): void {
    this.values.set(key, value)
  }
}

function turnLocation(
  data: ConversationTurnDataMap[typeof BOT_APP_CONNECTION_TURN_KEY],
  endSeq?: number,
): TurnLocation {
  const store = new TestTurnDataStore()
  store.set(BOT_APP_CONNECTION_TURN_KEY, data)
  return {
    turn: 1,
    start: undefined,
    status: 'closed',
    steps: [],
    data: store,
    end: endSeq === undefined ? undefined : event(endSeq, 'turn/end', { turn: 1 }),
  } as TurnLocation
}

function event(seq: number, type: string, data: unknown, surfaceOp?: 'append' | 'replace'): SessionEvent {
  return {
    seq,
    time: seq * 1_000,
    type,
    data,
    ...(surfaceOp === undefined ? {} : { surfaceOp }),
  } as SessionEvent
}

function appCall(seq = 2): SessionEvent {
  return event(seq, 'tool/call', {
    turn: 1,
    step: 1,
    callId: 'github-request',
    name: REQUEST_APP_CONNECTION_TOOL,
    arguments: '{}',
  })
}

function appResult(seq = 3, isError = false, surfaceOp: 'append' | 'replace' = 'append'): SessionEvent {
  return event(seq, 'tool/result', {
    turn: 1,
    step: 1,
    meta: { appId: 'github', status: 'sign-in-required' },
    message: createToolResultMessage({
      callId: ToolCallId('github-request'),
      content: [{ type: 'text', text: 'Connect GitHub to continue.' }],
      isError,
    }),
  }, surfaceOp)
}

function match(eventValue: SessionEvent, role: ConversationMatch['role'] = 'update'): ConversationMatch {
  return { event: eventValue, role, location: { kind: 'session' } }
}

function matchingData() {
  const started = botAppConnectionTurnDefinition.start(
    {} as never,
    match(event(1, 'turn/start', { turn: 1 }), 'start') as never,
    {} as never,
  )
  const called = botAppConnectionTurnDefinition.update({ state: started } as never, match(appCall()))
  return botAppConnectionTurnDefinition.update({ state: called } as never, match(appResult()))
}

function startedState() {
  return botAppConnectionTurnDefinition.start(
    {} as never,
    match(event(1, 'turn/start', { turn: 1 }), 'start') as never,
    {} as never,
  )
}

function githubActions(
  start?: GitHubAppSignInActions['startGitHubAppSignIn'],
): GitHubAppSignInActions {
  const view: GitHubAppSignInView = { status: 'needs-auth', attempt: null }
  return {
    getGitHubAppSignIn: vi.fn(async () => view),
    startGitHubAppSignIn: start ?? vi.fn(async () => view),
    cancelGitHubAppSignIn: vi.fn(async () => view),
    disconnectGitHubApp: vi.fn(async () => view),
  }
}

function cardProps(
  data: ConversationTurnDataMap[typeof BOT_APP_CONNECTION_TURN_KEY],
  actions: GitHubAppSignInActions | undefined,
  isBot = true,
): BotAppConnectionCardProps {
  const botSession = SessionId('bot-session')
  const bots: readonly BotView[] = isBot ? [{
    id: BotId('bot-app-connection'),
    sessionId: botSession,
    name: 'Connection bot',
    identity: 'agent',
    accent: 'teal',
    cwd: '/workspace',
    state: 'active',
    createdAt: 0,
    updatedAt: 0,
    availability: 'idle',
    pinned: false,
    hidden: false,
  }] : []
  const workspace: BotWorkspaceState = {
    phase: 'ready',
    bots,
    selectedBotId: null,
    groups: [],
    selectedGroupId: null,
    routineRevision: 0,
    selectedGroup: null,
    groupPhase: 'idle',
    groupError: null,
    templates: { phase: 'idle', templates: [], code: '', preview: null, error: null, busy: false },
    error: null,
  }
  return {
    turn: turnLocation(data, 4),
    seq: 3,
    sessionId: botSession,
    ...(actions === undefined ? {} : { githubAppSignIn: actions }),
    useWorkspace: <Selected,>(select: (state: BotWorkspaceState) => Selected) => select(workspace),
    t: makeTranslate(en),
  } as BotAppConnectionCardProps
}

describe('bot app-connection Turn data', () => {
  it('matches only the successful GitHub request result and preserves the sequence fence', () => {
    expect(botAppConnectionTurnDefinition.match(event(1, 'turn/start', { turn: 1 })))
      .toEqual({ id: '1', role: 'start' })
    expect(botAppConnectionTurnDefinition.match(appCall())).toEqual({ id: '1', role: 'update' })
    expect(botAppConnectionTurnDefinition.match(appResult())).toEqual({ id: '1', role: 'update' })
    expect(botAppConnectionTurnDefinition.match(appResult(4, false, 'replace'))).toBeNull()
    expect(botAppConnectionTurnDefinition.match(event(5, 'assistant/message', { turn: 1 }))).toBeNull()

    const data = matchingData()
    expect(data.requests).toEqual([{
      appId: 'github', status: 'sign-in-required', callId: 'github-request', seq: 3,
    }])
    expect(appConnectionRequestsForClosing({ requests: data.requests }, 2)).toEqual([])
    expect(appConnectionRequestsForClosing({ requests: data.requests }, 3)).toEqual(data.requests)
    expect(appConnectionRequestsForClosing(undefined)).toEqual([])
  })

  it('ignores failed, unrelated, and unpaired results', () => {
    const started = startedState()
    const called = botAppConnectionTurnDefinition.update({ state: started } as never, match(appCall()))
    expect(botAppConnectionTurnDefinition.update({ state: called } as never, match(event(3, 'assistant/message', { turn: 1 })))).toBe(called)
    expect(botAppConnectionTurnDefinition.update({ state: called } as never, match(appResult(3, true))).requests).toEqual([])
    expect(botAppConnectionTurnDefinition.update({ state: called } as never, match(event(4, 'tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('unknown'),
        content: [{ type: 'text', text: 'no pair' }],
        isError: false,
      }),
      meta: { appId: 'github', status: 'sign-in-required' },
    }, 'append'))).requests).toEqual([])

    const badCalls = [
      { appId: 'github', status: 'wrong' },
      { appId: 'other', status: 'sign-in-required' },
      null,
      [],
      'not-an-object',
    ]
    for (const meta of badCalls) {
      const badCall = botAppConnectionTurnDefinition.update({ state: startedState() } as never, match(event(2, 'tool/call', {
        turn: 1, step: 1, callId: 'bad-call', name: REQUEST_APP_CONNECTION_TOOL, arguments: '{}',
      })))
      const badResult = event(3, 'tool/result', {
        turn: 1,
        step: 1,
        meta,
        message: createToolResultMessage({
          callId: ToolCallId('bad-call'),
          content: [{ type: 'text', text: 'not eligible' }],
          isError: false,
        }),
      }, 'append')
      expect(botAppConnectionTurnDefinition.update({ state: badCall } as never, match(badResult)).requests).toEqual([])
    }

    const unrelatedCall = botAppConnectionTurnDefinition.update({ state: started } as never, match(event(2, 'tool/call', {
      turn: 1, step: 1, callId: 'unrelated', name: 'search', arguments: '{}',
    })))
    expect(botAppConnectionTurnDefinition.update({ state: unrelatedCall } as never, match(appResult(3))).requests).toEqual([])
    expect(botAppConnectionTurnDefinition.update({ state: called } as never, match(appResult(4, false, 'replace')))).toBe(called)
    expect(() => botAppConnectionTurnDefinition.start(
      {} as never,
      match(appCall(), 'start') as never,
      {} as never,
    )).toThrow('bot-app-connection start requires turn/start')
  })

  it('publishes turn data only when requests exist and reuses an unchanged predecessor', () => {
    const empty = startedState()
    const build = (state: unknown, scope: 'step' | 'turn', previous: unknown) =>
      botAppConnectionTurnDefinition.buildLocationData!({ state } as never, scope, previous as never)
    expect(build(empty, 'step', null)).toBeNull()
    expect(build(undefined, 'turn', null)).toBeNull()
    expect(build(empty, 'turn', null)).toBeNull()

    const data = matchingData()
    const built = build(data, 'turn', null)
    expect(built).toEqual({
      kind: 'turn', turn: 1, key: BOT_APP_CONNECTION_TURN_KEY, value: { requests: data.requests },
    })
    expect(build(data, 'turn', built)).toBe(built)
    expect(build(data, 'turn', {
      kind: 'step', turn: 1, key: BOT_APP_CONNECTION_TURN_KEY, value: { requests: data.requests },
    })).not.toBe(built)
    expect(build(data, 'turn', {
      kind: 'turn', turn: 2, key: BOT_APP_CONNECTION_TURN_KEY, value: { requests: data.requests },
    })).not.toBe(built)
    expect(build(data, 'turn', {
      kind: 'turn', turn: 1, key: 'other-key', value: { requests: data.requests },
    })).not.toBe(built)

    const changed = { ...data, requests: [...data.requests] }
    expect(build(changed, 'turn', built)).not.toBe(built)
    const location = turnLocation(data, 3)
    expect(appConnectionRequestsForClosing(location.data.get(BOT_APP_CONNECTION_TURN_KEY), 3)).toEqual(data.requests)
    expect(selectBotAppConnectionRequests({ turn: turnLocation(data), seq: 3 })).toEqual(data.requests)
  })
})

describe('BotAppConnectionCard', () => {
  it('renders the owner action with an accessible card and reuses GitHub sign-in', async () => {
    const actions = githubActions()
    render(<BotAppConnectionCard {...cardProps(matchingData(), actions)} />)

    expect(screen.getByRole('region', { name: en.appConnectionRequestTitle })).toBeDefined()
    const connect = screen.getByRole('button', { name: en.appConnectionRequestConnect })
    fireEvent.click(connect)
    await act(async () => {})

    expect(actions.startGitHubAppSignIn).toHaveBeenCalledOnce()
    expect(screen.getByRole('region', { name: en.githubAccountLabel })).toBeDefined()
  })

  it('does not present the card in Code Chat or without the owner action', () => {
    const actions = githubActions()
    const noBot = render(<BotAppConnectionCard {...cardProps(matchingData(), actions, false)} />)
    expect(noBot.container.querySelector('[data-bot-app-connection-card]')).toBeNull()
    noBot.unmount()
    render(<BotAppConnectionCard {...cardProps(matchingData(), undefined)} />)
    expect(screen.queryByRole('region', { name: en.appConnectionRequestTitle })).toBeNull()
  })

  it('confirms GitHub sign-in inside the Bot chat', async () => {
    const connected = vi.fn(async (): Promise<GitHubAppSignInView> => ({ status: 'connected', attempt: null }))
    const actions = { ...githubActions(connected), getGitHubAppSignIn: connected }
    render(<BotAppConnectionCard {...cardProps(matchingData(), actions)} />)
    fireEvent.click(screen.getByRole('button', { name: en.appConnectionRequestConnect }))
    expect((await screen.findByText(en.githubAccountConnected, { exact: true })).getAttribute('role')).toBe('status')
    expect(screen.queryByRole('button', { name: en.githubAccountDisconnect })).toBeNull()
  })

  it('shows a recoverable error when GitHub cannot be started', async () => {
    const unavailable = githubActions(vi.fn(async (): Promise<GitHubAppSignInView> => ({ status: 'unavailable', attempt: null })))
    render(<BotAppConnectionCard {...cardProps(matchingData(), unavailable)} />)
    fireEvent.click(screen.getByRole('button', { name: en.appConnectionRequestConnect }))
    await act(async () => {})
    expect(screen.getByRole('alert').textContent).toContain(en.githubAccountError)

    const failed = githubActions(vi.fn(async () => { throw new Error('offline') }))
    cleanup()
    render(<BotAppConnectionCard {...cardProps(matchingData(), failed)} />)
    fireEvent.click(screen.getByRole('button', { name: en.appConnectionRequestConnect }))
    await act(async () => {})
    expect(screen.getByRole('alert').textContent).toContain(en.githubAccountError)
  })

  it('shows the pending state while the owner action is in flight', async () => {
    let resolve: ((view: GitHubAppSignInView) => void) | undefined
    const actions = githubActions(vi.fn(() => new Promise<GitHubAppSignInView>((next) => { resolve = next })))
    render(<BotAppConnectionCard {...cardProps(matchingData(), actions)} />)
    const button = screen.getByRole('button', { name: en.appConnectionRequestConnect })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(screen.getByRole('status').textContent).toContain(en.appConnectionRequestStarting)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.appConnectionRequestStarting }).disabled).toBe(true)
    resolve?.({ status: 'needs-auth', attempt: null })
    await act(async () => {})
  })

  it('renders no card when the completed Turn has no matching request', () => {
    const actions = githubActions()
    render(<BotAppConnectionCard {...cardProps({ requests: [] }, actions)} />)
    expect(screen.queryByRole('region', { name: en.appConnectionRequestTitle })).toBeNull()
  })
})
