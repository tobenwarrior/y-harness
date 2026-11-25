import { Context } from '@yharness/cordis'
import type { Agent } from '@yharness/agent'
import { ToolCallId } from '@yharness/llm'
import { createScope } from '@yharness/scope'
import { Session, SessionId } from '@yharness/session'
import SystemPrompt from '@yharness/system-prompt'
import ToolRuntime, { defineTool, type ToolExecutionToken } from '@yharness/tools'
import ApprovalService from '@yharness/user-approval'
import { describe, expect, it, vi } from 'vitest'
import {
  BotMessageId,
  type BotCollaborationClient,
} from '../src/collaboration.ts'
import { BotMemoryId } from '../src/memory.ts'
import type { BotMemoryClient } from '../src/memory.ts'
import { BotGroupId, BotGroupMessageId } from '../src/group-chat.ts'
import type {
  BotConnectedAppToolHost,
  BotGrokHistoryToolHost,
  BotGroupToolHost,
} from '../src/scoped-tools.ts'
import type { BotNativeToolHost } from '../src/native-tools.ts'
import { BotId } from '../src/types.ts'
import { installBotCollaborationTools } from '../src/scoped-tools.ts'
import type { BotGrokHistoryPage } from '../src/grok-history.ts'
import type { BotGroupInspectValue, BotGroupMemberView } from '../src/group-chat.ts'

function client(withMemory = true): BotCollaborationClient {
  const memory: BotMemoryClient = {
    list: vi.fn<BotMemoryClient['list']>(async () => []),
    remember: vi.fn<BotMemoryClient['remember']>(async request => ({
      id: request.memoryId ?? BotMemoryId('memory-created'), text: request.text, createdAt: 1,
    })),
    forget: vi.fn<BotMemoryClient['forget']>(async () => {}),
  }
  return {
    sender: { id: BotId('bot-alpha'), name: 'Alpha', availability: 'idle', state: 'active' },
    list: vi.fn<BotCollaborationClient['list']>(async () => [{ id: BotId('bot-beta'), name: 'Beta', availability: 'idle', state: 'active' }]),
    inspect: vi.fn<BotCollaborationClient['inspect']>(async botId => ({
      bot: { id: botId, name: 'Beta', availability: 'idle', state: 'active' }, recent: [],
    })),
    send: vi.fn<BotCollaborationClient['send']>(async request => ({
      messageId: request.messageId ?? BotMessageId('generated'), status: 'accepted' as const,
      sender: { id: BotId('bot-alpha'), name: 'Alpha', availability: 'idle', state: 'active' },
      target: { id: request.targetBotId, name: 'Beta', availability: 'idle', state: 'active' },
    })),
    ...(withMemory ? { memory } : {}),
  }
}

interface HarnessOptions {
  readonly withManagement?: boolean
  readonly withApproval?: boolean
  readonly withGroups?: boolean
  readonly withHistory?: boolean
  readonly withMemory?: boolean
  readonly connectedApps?: BotConnectedAppToolHost
  readonly gitHubAuth?: 'github-app' | 'unrelated-connector'
  readonly withRegistrationConflict?: boolean
}

async function harness({
  withManagement = false,
  withApproval = false,
  withGroups = false,
  withHistory = false,
  withMemory = true,
  connectedApps,
  gitHubAuth,
  withRegistrationConflict = false,
}: HarnessOptions = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const gitHubStatus = vi.fn<() => Promise<'connected' | 'needs-auth'>>()
    .mockResolvedValue('needs-auth')
  const removeGitHubAuth = gitHubAuth === undefined
    ? undefined
    : ctx.provide('githubAppAuth', { status: gitHubStatus } as never)
  if (gitHubAuth !== undefined) {
    ctx.on('mcp/actions/catalog', (accept) => {
      accept({
        serverName: 'github', entryId: 'test:github', connected: false, actions: [],
        ...(gitHubAuth === 'github-app' ? { authKind: gitHubAuth } : {}),
      })
    })
  }
  if (withApproval) {
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    ctx.on('approval/request', () => Promise.resolve('allowed-once' as const))
  }
  const session = Session.create(SessionId('bot-session-alpha'))
  session.append('turn/start', { turn: 1 })
  const agent = { id: session.id, session } as Agent
  let scope!: ReturnType<typeof createScope>
  await ctx.plugin(Object.assign((inner: Context) => {
    scope = createScope(inner, agent)
    Object.defineProperty(agent, 'ctx', { value: scope.ctx })
  }, { inject: ['tools', 'systemPrompt'] }))
  const bound = client(withMemory)
  const manage = vi.fn<NonNullable<BotNativeToolHost['manage']>>(async () => ({ id: 'bot-created' }))
  const groupTools: BotGroupToolHost = {
    list: vi.fn<BotGroupToolHost['list']>(async () => ({ groups: [] })),
    inspect: vi.fn<BotGroupToolHost['inspect']>(async request => ({ group: { id: request.groupId, name: 'Room', botIds: [], bots: [], createdAt: 1, updatedAt: 1 }, messages: [] })),
    create: vi.fn<BotGroupToolHost['create']>(async request => ({ group: { id: request.id ?? BotGroupId('bot-group-created'), name: request.name, botIds: request.botIds, bots: [], createdAt: 1, updatedAt: 1 } })),
    update: vi.fn<BotGroupToolHost['update']>(async request => ({ group: {
      id: request.groupId, name: request.name, botIds: request.botIds, bots: [], createdAt: 1, updatedAt: 1,
    } })),
    send: vi.fn<BotGroupToolHost['send']>(async request => ({ messageId: request.messageId ?? BotGroupMessageId('bot-group-message-created'), status: 'accepted' as const, deliveries: [] })),
  }
  const history: BotGrokHistoryPage = {
    source: 'grok-bot', version: 1, firstCachedSequence: 4, totalMessages: 2, nextBefore: 8,
    messages: [{ sourceSequence: 8, role: 'assistant', text: 'A'.repeat(2_000), timestampMs: 2_000 }],
  }
  const historyRead = vi.fn<BotGrokHistoryToolHost['read']>(async () => history)
  if (withRegistrationConflict) {
    agent.ctx.effect(() => agent.ctx.tools.register(defineTool({
      name: 'inspect_bot',
      description: 'Fixture registration that forces a later scoped registration to fail.',
      parameters: {},
      output: { schema: { type: 'string' } as const, render: (_args, value) => [{ type: 'text' as const, text: value }] },
      async execute() { return 'fixture' },
    })))
  }
  let installationError: unknown
  let dispose: () => void = () => {}
  try {
    dispose = installBotCollaborationTools(
      agent.ctx,
      async () => bound,
      withManagement ? manage : undefined,
      withGroups ? async () => groupTools : undefined,
      connectedApps,
      withHistory ? { read: historyRead } : undefined,
    )
  } catch (error: unknown) {
    if (!withRegistrationConflict) throw error
    installationError = error
  }
  return { ctx, agent, bound, dispose, manage, groupTools, historyRead, installationError, gitHubStatus, removeGitHubAuth }
}

async function execute(ctx: Context, agent: Agent, name: string, arguments_: unknown, callId = `bot-call-${name}`) {
  return ctx.tools.execute({
    callId: ToolCallId(callId), name, arguments: arguments_,
    signal: new AbortController().signal, agent,
  })
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

function groupMember(id: BotId, name: string, description?: string): BotGroupMemberView {
  return {
    id,
    name,
    identity: 'agent',
    accent: 'blue',
    availability: 'idle',
    state: 'active',
    ...(description === undefined ? {} : { description }),
  }
}

function richGroupInspection(): BotGroupInspectValue {
  const groupId = BotGroupId('bot-group-room')
  const firstMessageId = BotGroupMessageId('bot-group-message-first')
  return {
    group: {
      id: groupId,
      name: 'Room',
      botIds: [BotId('bot-alpha'), BotId('bot-beta')],
      bots: [groupMember(BotId('bot-alpha'), 'Alpha'), groupMember(BotId('bot-beta'), 'Beta', 'Research')],
      createdAt: 1,
      updatedAt: 2,
    },
    messages: [
      {
        id: firstMessageId,
        groupId,
        sender: { kind: 'user' },
        text: 'A user note',
        targetBotIds: [BotId('bot-beta')],
        createdAt: 3,
      },
      {
        id: BotGroupMessageId('bot-group-message-response'),
        groupId,
        sender: { kind: 'bot', botId: BotId('bot-beta'), name: 'Beta' },
        text: 'A Bot response',
        createdAt: 4,
      },
    ],
    deliveries: [
      { messageId: firstMessageId, botId: BotId('bot-beta'), status: 'failed', error: 'offline' },
      { messageId: firstMessageId, botId: BotId('bot-alpha'), status: 'accepted' },
    ],
  }
}

function connectedAppHost(): BotConnectedAppToolHost {
  return {
    list: vi.fn<BotConnectedAppToolHost['list']>(async () => [
      { id: 'github', name: 'GitHub', description: 'Issues', allowed: true },
      { id: 'calendar', name: 'Calendar', allowed: false },
    ]),
    check: vi.fn<BotConnectedAppToolHost['check']>(() => ({ kind: 'allow' })),
    guard: vi.fn<BotConnectedAppToolHost['guard']>(() => undefined),
    beforeDispatch: vi.fn<BotConnectedAppToolHost['beforeDispatch']>(() => ({ kind: 'allow' })),
  }
}

describe('scoped Bot collaboration tools', () => {
  it('reads only the owned Grok archive as a paginated untrusted excerpt', async () => {
    const h = await harness({ withHistory: true })
    try {
      expect(h.ctx.tools.schemas(h.agent).map(tool => tool.name)).toContain('read_own_grok_history')
      const result = await execute(h.ctx, h.agent, 'read_own_grok_history', { limit: 1 })
      expect(result.isError).toBe(false)
      const value = JSON.parse(text(result)) as BotGrokHistoryPage
      expect(value).toMatchObject({
        firstCachedSequence: 4, totalMessages: 2, nextBefore: 8,
        messages: [{ sourceSequence: 8, role: 'assistant', timestampMs: 2_000 }],
      })
      expect(value.messages[0]?.text).toContain('[Untrusted Bot transcript;')
      expect(value.messages[0]?.text.length).toBeLessThan(1_300)
      expect(h.historyRead).toHaveBeenCalledWith({ limit: 1 }, expect.any(AbortSignal))

      const selected = await execute(h.ctx, h.agent, 'read_own_grok_history', { limit: 1, source: 'full-export' }, 'bot-history-full')
      expect(selected.isError).toBe(false)
      expect(h.historyRead).toHaveBeenLastCalledWith({ limit: 1, source: 'full-export' }, expect.any(AbortSignal))

      const defaulted = await execute(h.ctx, h.agent, 'read_own_grok_history', {}, 'bot-history-default')
      expect(defaulted.isError).toBe(false)
      expect(h.historyRead).toHaveBeenLastCalledWith({ limit: 5 }, expect.any(AbortSignal))

      h.historyRead.mockResolvedValueOnce(null)
      const older = await execute(h.ctx, h.agent, 'read_own_grok_history', { limit: 2, before: 7 }, 'bot-history-older')
      expect(older.isError).toBe(false)
      expect(text(older)).toBe('null')
      expect(h.historyRead).toHaveBeenLastCalledWith({ limit: 2, before: 7 }, expect.any(AbortSignal))
    } finally {
      h.dispose()
      await h.ctx.fiber.dispose()
    }
  })

  it('exposes management tools and denies changes without approval', async () => {
    const h = await harness({ withManagement: true })
    try {
      expect(h.ctx.tools.schemas(h.agent).map(tool => tool.name)).toEqual(expect.arrayContaining(['create_bot', 'edit_bot_profile']))
      expect((await execute(h.ctx, h.agent, 'create_bot', { name: 'Research' })).isError).toBe(true)
      expect(h.manage).not.toHaveBeenCalled()
    } finally {
      h.dispose()
      await h.ctx.fiber.dispose()
    }
  })

  it('rolls back earlier scoped registrations when a later tool name conflicts', async () => {
    const h = await harness({ withRegistrationConflict: true })
    try {
      if (!(h.installationError instanceof Error)) throw new Error('registration conflict did not fail')
      expect(h.installationError.message).toContain('already registered')
      const names = h.ctx.tools.schemas(h.agent).map(tool => tool.name)
      expect(names).toEqual(['inspect_bot'])
      expect(names).not.toContain('list_bots')
    } finally {
      h.dispose()
      await h.ctx.fiber.dispose()
    }
  })

  it('runs approved Bot creation and profile edits with typed result projections', async () => {
    const h = await harness({ withManagement: true, withApproval: true })
    try {
      h.manage
        .mockResolvedValueOnce({ id: 'bot-created', name: 'Research', state: 'active', pictureError: 'not-generated' })
        .mockResolvedValueOnce({ id: 'bot-alpha' })
        .mockResolvedValueOnce({ name: 'invalid result' })
      const created = await execute(h.ctx, h.agent, 'create_bot', {
        name: 'Research', identity: 'agent', accent: 'blue', pictureDescription: 'A blue star',
      }, 'create-approved')
      expect(created.isError).toBe(false)
      expect(JSON.parse(text(created))).toEqual({
        id: 'bot-created', name: 'Research', state: 'active', pictureError: 'not-generated',
      })
      const managementContext = h.manage.mock.calls[0]?.[2]
      if (managementContext === undefined) throw new Error('management context was not supplied')
      await expect(managementContext.requestApproval('fixture approval')).resolves.toBe(true)
      const edited = await execute(h.ctx, h.agent, 'edit_bot_profile', {
        botId: 'bot-alpha', name: 'Alpha Prime',
      }, 'edit-approved')
      expect(edited.isError).toBe(false)
      expect(JSON.parse(text(edited))).toEqual({ id: 'bot-alpha' })
      const invalid = await execute(h.ctx, h.agent, 'create_bot', { name: 'Invalid response' }, 'create-invalid-result')
      expect(invalid.isError).toBe(true)
      expect(h.manage).toHaveBeenNthCalledWith(1, 'create', expect.objectContaining({ name: 'Research' }), expect.objectContaining({
        sessionId: h.agent.id,
        approvalPolicy: 'on-request',
      }))
      expect(h.manage).toHaveBeenNthCalledWith(2, 'edit', expect.objectContaining({ botId: 'bot-alpha' }), expect.objectContaining({
        sessionId: h.agent.id,
      }))
    } finally {
      h.dispose()
      await h.ctx.fiber.dispose()
    }
  })

  it('rejects a Bot management call without a live Agent', async () => {
    const h = await harness({ withManagement: true })
    try {
      const definition = h.ctx.tools.get('create_bot', h.agent)
      if (definition === undefined) throw new Error('create_bot was not registered')
      const callId = ToolCallId('orphan-management-call')
      const args = { name: 'Research' }
      await expect(definition.execute(args, {
        name: 'create_bot', arguments: args, callId, rootCallId: callId,
        token: Symbol('orphan-management-call') as ToolExecutionToken,
        signal: new AbortController().signal, concludeTurn: vi.fn(), deferContext: vi.fn(),
      })).rejects.toThrow('Bot management requires a live Bot.')
      expect(h.manage).not.toHaveBeenCalled()
    } finally {
      h.dispose()
      await h.ctx.fiber.dispose()
    }
  })

  it('runs approved memory list, remember, and forget through the bound Bot identity', async () => {
    const h = await harness({ withApproval: true })
    try {
      const memory = h.bound.memory
      if (memory === undefined) throw new Error('memory fixture was not bound')
      vi.mocked(memory.list).mockResolvedValueOnce([{ id: BotMemoryId('memory-existing'), text: 'private', createdAt: 7 }])
      const listed = await execute(h.ctx, h.agent, 'list_bot_memory', {})
      expect(listed.isError).toBe(false)
      expect(JSON.parse(text(listed))).toEqual([{ id: 'memory-existing', createdAt: 7 }])

      const remembered = await execute(h.ctx, h.agent, 'remember_bot_memory', {
        text: 'Remember this fact.', memoryId: 'memory-explicit',
      }, 'remember-explicit')
      expect(remembered.isError).toBe(false)
      expect(JSON.parse(text(remembered))).toEqual({ id: 'memory-explicit', createdAt: 1 })
      const rememberRequest = vi.mocked(memory.remember).mock.calls[0]?.[0]
      if (rememberRequest === undefined) throw new Error('memory remember request was not sent')
      expect(rememberRequest.memoryId).toBe(BotMemoryId('memory-explicit'))
      expect(rememberRequest.text).toBe('Remember this fact.')
      expect(rememberRequest.signal).toBeInstanceOf(AbortSignal)

      const forgotten = await execute(h.ctx, h.agent, 'forget_bot_memory', { memoryId: 'memory-explicit' }, 'forget-explicit')
      expect(forgotten.isError).toBe(false)
      expect(JSON.parse(text(forgotten))).toEqual({ forgotten: true })
      const forgetRequest = vi.mocked(memory.forget).mock.calls[0]?.[0]
      if (forgetRequest === undefined) throw new Error('memory forget request was not sent')
      expect(forgetRequest.memoryId).toBe(BotMemoryId('memory-explicit'))
      expect(forgetRequest.signal).toBeInstanceOf(AbortSignal)
    } finally {
      h.dispose()
      await h.ctx.fiber.dispose()
    }
  })

  it('fails memory tools cleanly when the Host does not expose Bot memory', async () => {
    const h = await harness({ withApproval: true, withMemory: false })
    try {
      await expect(execute(h.ctx, h.agent, 'list_bot_memory', {})).resolves.toMatchObject({ isError: true })
      await expect(execute(h.ctx, h.agent, 'remember_bot_memory', { text: 'No memory' }, 'remember-unavailable')).resolves.toMatchObject({ isError: true })
      await expect(execute(h.ctx, h.agent, 'forget_bot_memory', { memoryId: 'memory-missing' }, 'forget-unavailable')).resolves.toMatchObject({ isError: true })
    } finally {
      h.dispose()
      await h.ctx.fiber.dispose()
    }
  })

  it('lists connected apps and rejects a revoked app call before its Bot body', async () => {
    const apps = connectedAppHost()
    const h = await harness({ connectedApps: apps })
    try {
      expect(h.ctx.tools.schemas(h.agent).map(tool => tool.name)).toContain('list_connected_apps')
      const listed = await execute(h.ctx, h.agent, 'list_connected_apps', {})
      expect(listed.isError).toBe(false)
      expect(JSON.parse(text(listed))).toEqual([
        { id: 'github', name: 'GitHub', description: 'Issues', allowed: true },
        { id: 'calendar', name: 'Calendar', allowed: false },
      ])
      vi.mocked(apps.check).mockReturnValueOnce({ kind: 'deny', reason: 'GitHub access was revoked.' })
      const denied = await execute(h.ctx, h.agent, 'list_bots', {}, 'revoked-connected-app')
      expect(denied.isError).toBe(true)
      expect(h.bound.list).not.toHaveBeenCalled()
      expect(apps.guard).toHaveBeenCalled()
      expect(apps.beforeDispatch).toHaveBeenCalled()
    } finally {
      h.dispose()
      await h.ctx.fiber.dispose()
    }
  })

  it('checks owner-only app connection state without starting authorization', async () => {
    const h = await harness({ connectedApps: connectedAppHost(), gitHubAuth: 'github-app' })
    try {
      expect(h.ctx.tools.schemas(h.agent).map(tool => tool.name)).toContain('request_app_connection')
      const request = (id: string) => execute(h.ctx, h.agent, 'request_app_connection', { appId: 'github' }, id)
      const result = await request('github-connect-pending')
      expect(result.isError).toBe(false)
      const pending = { appId: 'github', status: 'sign-in-required' }
      expect(JSON.parse(text(result))).toEqual(pending)
      expect(result.meta).toEqual(pending)
      expect(h.gitHubStatus).toHaveBeenCalledTimes(1)

      h.gitHubStatus.mockResolvedValueOnce('connected')
      const connected = await request('github-connect-ready')
      expect(JSON.parse(text(connected))).toEqual({ appId: 'github', status: 'connected' })
      expect(connected.meta).toBeNull()

      h.gitHubStatus.mockRejectedValueOnce(new Error('private credential-store error'))
      const unavailable = { appId: 'github', status: 'unavailable' }
      expect(JSON.parse(text(await request('github-connect-read-failed')))).toEqual(unavailable)
      h.removeGitHubAuth?.()
      expect(JSON.parse(text(await request('github-connect-provider-removed')))).toEqual(unavailable)
      expect(h.gitHubStatus).toHaveBeenCalledTimes(3)
    } finally {
      h.dispose()
      await h.ctx.fiber.dispose()
    }
  })

  it('does not ask the owner to sign in for an unrelated connector', async () => {
    const h = await harness({ connectedApps: connectedAppHost(), gitHubAuth: 'unrelated-connector' })
    try {
      const result = await execute(h.ctx, h.agent, 'request_app_connection', { appId: 'github' })
      expect(JSON.parse(text(result))).toEqual({ appId: 'github', status: 'unavailable' })
      expect(h.gitHubStatus).not.toHaveBeenCalled()
    } finally {
      h.dispose()
      await h.ctx.fiber.dispose()
    }
  })

  it('keeps the connection prompt absent when its owner-only Host capability is not mounted', async () => {
    const h = await harness({ connectedApps: connectedAppHost() })
    try {
      expect(h.ctx.tools.schemas(h.agent).map(tool => tool.name)).not.toContain('request_app_connection')
    } finally {
      h.dispose()
      await h.ctx.fiber.dispose()
    }
  })

  it('registers roster tools in one Bot scope and keeps messaging approval-gated', async () => {
    const h = await harness()
    try {
      const schemas = h.ctx.tools.schemas(h.agent)
      expect(schemas.map(tool => tool.name)).toEqual([
        'list_bots', 'inspect_bot', 'send_bot_message',
        'list_bot_memory', 'remember_bot_memory', 'forget_bot_memory',
      ])
      expect(schemas.find(tool => tool.name === 'inspect_bot')?.description).toContain('dsh-bot:<bot-id>')
      expect(schemas.find(tool => tool.name === 'send_bot_message')?.description).toContain('never sends a message')
      await expect(execute(h.ctx, h.agent, 'list_bots', {})).resolves.toMatchObject({ isError: false })
      expect(JSON.parse(text(await execute(h.ctx, h.agent, 'list_bots', {})))).toEqual([
        { id: 'bot-beta', name: 'Beta', availability: 'idle', state: 'active' },
      ])
      const inspected = await execute(h.ctx, h.agent, 'inspect_bot', { botId: 'bot-beta' })
      expect(JSON.parse(text(inspected))).toMatchObject({ bot: { id: 'bot-beta', name: 'Beta' }, recent: [] })
      const memories = await execute(h.ctx, h.agent, 'list_bot_memory', {})
      expect(JSON.parse(text(memories))).toEqual([])
      const denied = await execute(h.ctx, h.agent, 'send_bot_message', {
        targetBotId: 'bot-beta', text: 'hello', messageId: 'retry-1',
      })
      expect(denied.isError).toBe(true)
      expect(h.bound.send).not.toHaveBeenCalled()
    } finally {
      h.dispose()
      await h.ctx.fiber.dispose()
    }
  })

  it('delivers an explicitly approved Bot message with the sender-bound identity', async () => {
    const h = await harness({ withApproval: true })
    try {
      const sent = await execute(h.ctx, h.agent, 'send_bot_message', {
        targetBotId: 'bot-beta', text: 'approved hello', messageId: 'message-explicit',
      }, 'send-approved')
      expect(sent.isError).toBe(false)
      expect(JSON.parse(text(sent))).toMatchObject({
        messageId: 'message-explicit', status: 'accepted', sender: { id: 'bot-alpha' }, target: { id: 'bot-beta' },
      })
      const sendRequest = vi.mocked(h.bound.send).mock.calls[0]?.[0]
      if (sendRequest === undefined) throw new Error('Bot send request was not sent')
      expect(sendRequest.targetBotId).toBe(BotId('bot-beta'))
      expect(sendRequest.text).toBe('approved hello')
      expect(sendRequest.messageId).toBe(BotMessageId('message-explicit'))
      expect(sendRequest.signal).toBeInstanceOf(AbortSignal)
      const implicit = await execute(h.ctx, h.agent, 'send_bot_message', {
        targetBotId: 'bot-beta', text: 'implicit message id',
      }, 'send-approved-implicit-id')
      expect(implicit.isError).toBe(false)
      expect(vi.mocked(h.bound.send).mock.calls[1]?.[0]).not.toHaveProperty('messageId')
    } finally {
      h.dispose()
      await h.ctx.fiber.dispose()
    }
  })

  it('unregisters all scoped tools when the Bot scope is disposed', async () => {
    const h = await harness()
    h.dispose()
    expect(h.ctx.tools.schemas(h.agent)).toEqual([])
    await h.ctx.fiber.dispose()
  })

  it('reuses one stable memory id when a scoped remember retry follows an uncertain result', async () => {
    const h = await harness({ withApproval: true })
    try {
      const remember = vi.mocked(h.bound.memory!.remember)
      remember.mockImplementationOnce(async () => { throw new Error('flush result was uncertain') })
      const first = await execute(h.ctx, h.agent, 'remember_bot_memory', { text: 'Keep the handoff short.' }, 'remember-call-1')
      expect(first.isError).toBe(true)
      const second = await execute(h.ctx, h.agent, 'remember_bot_memory', { text: 'Keep the handoff short.' }, 'remember-call-2')
      expect(second.isError).toBe(false)
      const requests = remember.mock.calls.map(call => call[0])
      expect(requests).toHaveLength(2)
      expect(requests[0]?.memoryId).toBeDefined()
      expect(requests[1]?.memoryId).toBe(requests[0]?.memoryId)
    } finally {
      h.dispose()
      await h.ctx.fiber.dispose()
    }
  })

  it('exposes group inspection, creation, and sender-bound delivery tools', async () => {
    const h = await harness({ withGroups: true })
    try {
      expect(h.ctx.tools.schemas(h.agent).map(tool => tool.name)).toEqual(expect.arrayContaining([
        'list_bot_groups', 'inspect_bot_group', 'create_bot_group', 'send_bot_group_message',
      ]))
      await expect(execute(h.ctx, h.agent, 'list_bot_groups', {})).resolves.toMatchObject({ isError: false })
      const denied = await execute(h.ctx, h.agent, 'send_bot_group_message', { groupId: 'bot-group-room', text: 'hello' })
      expect(denied.isError).toBe(true)
      expect(h.groupTools.send).not.toHaveBeenCalled()
      h.ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' as const }), { prepend: true })
      const created = await execute(h.ctx, h.agent, 'create_bot_group', { name: 'Room', botIds: ['bot-beta'] }, 'create-first')
      expect(created.isError).toBe(false)
      expect(vi.mocked(h.groupTools.create).mock.calls[0]?.[0].id).toMatch(/^bot-group-tool-/)
      const createdRetry = await execute(h.ctx, h.agent, 'create_bot_group', { name: 'Room', botIds: ['bot-beta'] }, 'create-after-lost-response')
      expect(createdRetry.isError).toBe(false)
      expect(vi.mocked(h.groupTools.create).mock.calls[1]?.[0].id).toBe(vi.mocked(h.groupTools.create).mock.calls[0]?.[0].id)
      await execute(h.ctx, h.agent, 'create_bot_group', {
        name: 'Canonical room', botIds: [' bot-zeta ', 'bot-beta'],
      }, 'create-canonical-first')
      await execute(h.ctx, h.agent, 'create_bot_group', {
        name: 'Canonical room', botIds: ['bot-beta', ' bot-zeta '],
      }, 'create-canonical-second')
      expect(vi.mocked(h.groupTools.create).mock.calls[3]?.[0].id).toBe(vi.mocked(h.groupTools.create).mock.calls[2]?.[0].id)
      await execute(h.ctx, h.agent, 'create_bot_group', {
        name: 'Self canonical room', botIds: ['bot-beta'],
      }, 'create-self-omitted')
      await execute(h.ctx, h.agent, 'create_bot_group', {
        name: 'Self canonical room', botIds: ['bot-alpha', 'bot-beta'],
      }, 'create-self-included')
      expect(vi.mocked(h.groupTools.create).mock.calls[5]?.[0].id).toBe(vi.mocked(h.groupTools.create).mock.calls[4]?.[0].id)
      const updated = await execute(h.ctx, h.agent, 'update_bot_group', {
        groupId: 'bot-group-room', name: 'Renamed room', botIds: ['bot-alpha', 'bot-beta'],
      }, 'update-room')
      expect(updated.isError).toBe(false)
      expect(vi.mocked(h.groupTools.update).mock.calls[0]?.[0]).toMatchObject({
        groupId: BotGroupId('bot-group-room'), name: 'Renamed room', botIds: [BotId('bot-alpha'), BotId('bot-beta')],
      })
      const sent = await execute(h.ctx, h.agent, 'send_bot_group_message', { groupId: 'bot-group-room', text: 'hello' }, 'send-first')
      expect(sent.isError).toBe(false)
      expect(vi.mocked(h.groupTools.send).mock.calls[0]?.[0].messageId).toMatch(/^bot-group-message-tool-/)
      const sentRetry = await execute(h.ctx, h.agent, 'send_bot_group_message', { groupId: 'bot-group-room', text: 'hello' }, 'send-after-lost-response')
      expect(sentRetry.isError).toBe(false)
      expect(vi.mocked(h.groupTools.send).mock.calls[1]?.[0].messageId).toBe(vi.mocked(h.groupTools.send).mock.calls[0]?.[0].messageId)
      await execute(h.ctx, h.agent, 'send_bot_group_message', {
        groupId: 'bot-group-room', text: 'hello Beta', targetBotIds: ['bot-beta'],
      }, 'send-mentioned')
      expect(vi.mocked(h.groupTools.send).mock.calls[2]?.[0].targetBotIds).toEqual([BotId('bot-beta')])
      await execute(h.ctx, h.agent, 'create_bot_group', {
        name: 'Explicit room', botIds: ['bot-beta'], groupId: 'bot-group-explicit',
      }, 'create-explicit')
      await execute(h.ctx, h.agent, 'send_bot_group_message', {
        groupId: ' bot-group-room ', text: ' hello ', messageId: 'bot-group-message-explicit',
      }, 'send-explicit')
      expect(vi.mocked(h.groupTools.create).mock.calls[6]?.[0].id).toBe('bot-group-explicit')
      expect(vi.mocked(h.groupTools.send).mock.calls[3]?.[0].messageId).toBe('bot-group-message-explicit')
    } finally {
      h.dispose()
      await h.ctx.fiber.dispose()
    }
  })

  it('projects group members, transcript senders, deliveries, and lifecycle results', async () => {
    const h = await harness({ withApproval: true, withGroups: true })
    try {
      const inspection = richGroupInspection()
      vi.mocked(h.groupTools.list).mockResolvedValueOnce({ groups: [inspection.group] })
      const listed = await execute(h.ctx, h.agent, 'list_bot_groups', {})
      expect(listed.isError).toBe(false)
      expect(JSON.parse(text(listed))).toEqual([{
        id: 'bot-group-room',
        name: 'Room',
        bots: [
          { id: 'bot-alpha', name: 'Alpha', availability: 'idle', state: 'active' },
          { id: 'bot-beta', name: 'Beta', description: 'Research', availability: 'idle', state: 'active' },
        ],
      }])

      vi.mocked(h.groupTools.inspect).mockResolvedValueOnce(inspection)
      const inspected = await execute(h.ctx, h.agent, 'inspect_bot_group', { groupId: 'bot-group-room' })
      expect(inspected.isError).toBe(false)
      const inspectedValue = JSON.parse(text(inspected)) as {
        readonly messages: readonly { readonly sender: { readonly kind: string }; readonly text: string }[]
        readonly deliveries: readonly { readonly error?: string }[]
      }
      expect(inspectedValue.messages[0]?.sender.kind).toBe('user')
      expect(inspectedValue.messages[0]?.text).toContain('[Untrusted Bot transcript;')
      expect(inspectedValue.messages[1]?.sender).toEqual({ kind: 'bot', botId: 'bot-beta', name: 'Beta' })
      expect(inspectedValue.deliveries).toEqual([{ messageId: 'bot-group-message-first', botId: 'bot-beta', status: 'failed', error: 'offline' }, {
        messageId: 'bot-group-message-first', botId: 'bot-alpha', status: 'accepted',
      }])

      vi.mocked(h.groupTools.inspect).mockResolvedValueOnce({ group: inspection.group, messages: [] })
      const noDeliveries = await execute(h.ctx, h.agent, 'inspect_bot_group', { groupId: 'bot-group-room' }, 'inspect-no-deliveries')
      expect(noDeliveries.isError).toBe(false)
      const noDeliveriesValue = JSON.parse(text(noDeliveries)) as {
        readonly group: { readonly id: string }
        readonly messages: readonly { readonly id?: string }[]
      }
      expect(noDeliveriesValue.group.id).toBe('bot-group-room')
      expect(noDeliveriesValue.messages).toEqual([])

      vi.mocked(h.groupTools.create).mockResolvedValueOnce({ group: inspection.group })
      const created = await execute(h.ctx, h.agent, 'create_bot_group', {
        name: 'Room', botIds: ['bot-beta'],
      }, 'create-rich-group')
      expect(created.isError).toBe(false)
      expect(JSON.parse(text(created))).toMatchObject({ group: { bots: [{ id: 'bot-alpha' }, { id: 'bot-beta', description: 'Research' }] } })

      vi.mocked(h.groupTools.update).mockResolvedValueOnce({ group: inspection.group })
      const updated = await execute(h.ctx, h.agent, 'update_bot_group', {
        groupId: 'bot-group-room', name: 'Room', botIds: ['bot-alpha', 'bot-beta'],
      }, 'update-rich-group')
      expect(updated.isError).toBe(false)
      expect(JSON.parse(text(updated))).toMatchObject({ group: { bots: [{ id: 'bot-alpha' }, { id: 'bot-beta', description: 'Research' }] } })

      vi.mocked(h.groupTools.send).mockResolvedValueOnce({
        messageId: BotGroupMessageId('bot-group-message-delivery'),
        status: 'partial',
        deliveries: [
          { botId: BotId('bot-beta'), status: 'failed', error: 'offline' },
          { botId: BotId('bot-alpha'), status: 'accepted' },
        ],
      })
      const sent = await execute(h.ctx, h.agent, 'send_bot_group_message', {
        groupId: 'bot-group-room', text: 'hello',
      }, 'send-rich-group')
      expect(sent.isError).toBe(false)
      expect(JSON.parse(text(sent))).toEqual({
        messageId: 'bot-group-message-delivery',
        status: 'partial',
        deliveries: [
          { botId: 'bot-beta', status: 'failed', error: 'offline' },
          { botId: 'bot-alpha', status: 'accepted' },
        ],
      })
    } finally {
      h.dispose()
      await h.ctx.fiber.dispose()
    }
  })
})
