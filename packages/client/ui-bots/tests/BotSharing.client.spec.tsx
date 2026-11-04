// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@yharness/brand'
import { BotId, BotPrincipalId, BotShareMemoryId } from '@yharness/bots/client'
import type { BotGroupId, BotGroupMessageId, BotGroupMessageView, BotGroupView } from '@yharness/bots/client'
import { makeTranslate } from '@yharness/client-test-runtime'
import { BotShareDialog, SharedBotsDialog } from '../src/client/BotSharing.tsx'
import { en } from '../src/client/locales.ts'
import { createSharedGroupPendingQueue } from '../src/client/pending-group-queue.ts'
import type { BotShareActions } from '../src/client/controller.ts'
import { createSharedBotsClient } from '../src/client/shared-client.ts'
import type { SharedBotAuthChange, SharedBotsClient } from '../src/client/shared-client.ts'
import type { BotSummary } from '../src/client/types.ts'

afterEach(cleanup)

const originalLocksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks')
const lockRequest = <T,>(_name: string, callback: () => Promise<T>): Promise<T> => callback()

beforeAll(() => {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: lockRequest },
  })
})
beforeEach(() => {
  for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
    const key = window.localStorage.key(index)
    if (key?.startsWith('yharness.client-ui-bots.shared-group-pending')) window.localStorage.removeItem(key)
  }
})
afterAll(() => {
  if (originalLocksDescriptor === undefined) Reflect.deleteProperty(navigator, 'locks')
  else Object.defineProperty(navigator, 'locks', originalLocksDescriptor)
})

const t = makeTranslate(en)
type CompleteBotSummary = BotSummary & Required<Pick<BotSummary, 'identity' | 'accent'>>

const bot: CompleteBotSummary = {
  id: 'bot-chief',
  name: 'Chief of staff',
  description: 'Coordinates the work',
  group: 'General',
  status: 'idle',
  identity: 'agent',
  accent: 'amber',
}
const analystBot: CompleteBotSummary = {
  ...bot,
  id: 'bot-analyst',
  name: 'Analyst',
  description: 'Studies the evidence',
  accent: 'teal',
}

function ownerActions(overrides: Partial<BotShareActions> = {}): BotShareActions {
  return {
    listMembers: vi.fn().mockResolvedValue({ members: [{
      botId: BotId(bot.id),
      principalId: 'principal-owner',
      role: 'owner',
      grantedBy: 'principal-owner',
      createdAt: 1,
      updatedAt: 1,
    }] }),
    createInvite: vi.fn().mockResolvedValue({ code: 'invite', expiresAt: 2_000 }),
    revokeMember: vi.fn().mockResolvedValue({ botId: BotId(bot.id), principalId: 'principal-member', revoked: true }),
    getMemoryPolicy: vi.fn().mockResolvedValue({ botId: BotId(bot.id), enabled: false, updatedAt: 1 }),
    setMemoryPolicy: vi.fn().mockResolvedValue({ botId: BotId(bot.id), enabled: true, updatedAt: 2 }),
    ...overrides,
  }
}

function sharedClient(overrides: Partial<SharedBotsClient> = {}): SharedBotsClient {
  return {
    retryScope: 'principal-member',
    enroll: vi.fn().mockResolvedValue({ ok: true, value: { principalId: 'principal-member', expiresAt: 2_000 } }),
    restoreRetryScope: vi.fn().mockResolvedValue({ ok: true, value: { principalId: 'principal-member', expiresAt: 2_000 } }),
    list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'collaborator' }] } }),
    readProfile: vi.fn().mockResolvedValue({ ok: true, value: { bot } }),
    readPrivateChat: vi.fn().mockResolvedValue({ ok: true, value: { botId: bot.id, recent: [{ role: 'assistant', text: 'Private answer' }] } }),
    readMemory: vi.fn().mockResolvedValue({ ok: true, value: { botId: BotId(bot.id), enabled: true, updatedAt: 1, entries: [{ id: 'memory-one', principalId: 'principal-owner', text: 'Shared decision', createdAt: 1 }] } }),
    chat: vi.fn().mockResolvedValue({ ok: true, value: { bot, sessionId: 'shared-session-one', accepted: true } }),
    writeMemory: vi.fn().mockResolvedValue({ ok: true, value: { entry: { id: 'memory-two', principalId: 'principal-member', text: 'New shared note', createdAt: 2 } } }),
    createInvite: vi.fn().mockResolvedValue({ ok: true, value: { code: 'invite', expiresAt: 2_000, role: 'collaborator' } }),
    revokeMember: vi.fn().mockResolvedValue({ ok: true, value: { revoked: true, principalId: 'principal-member' } }),
    ...overrides,
  }
}

describe('shared Bot collaboration surfaces', () => {
  it('keeps the invite role fixed while an invite is being created', async () => {
    const createInvite = Promise.withResolvers<Awaited<ReturnType<BotShareActions['createInvite']>>>()
    const actions = ownerActions({ createInvite: vi.fn().mockReturnValue(createInvite.promise) })
    render(<BotShareDialog bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByRole('tab', { name: 'Collaborator' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }))
    await waitFor(() => { expect(actions.createInvite).toHaveBeenCalledWith(bot.id, 'collaborator') })

    const manager = screen.getByRole('tab', { name: 'Manager' }) as HTMLButtonElement
    expect(manager.disabled).toBe(true)
    expect(screen.getByRole('tab', { name: 'Collaborator' }).getAttribute('aria-selected')).toBe('true')

    await act(async () => {
      createInvite.resolve({ code: 'invite', expiresAt: 2_000 })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByLabelText('Invite code').textContent).toContain('invite')
  })

  it('ignores owner share data from the previous Bot after switching', async () => {
    const staleMembers = Promise.withResolvers<Awaited<ReturnType<BotShareActions['listMembers']>>>()
    const stalePolicy = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotShareActions['getMemoryPolicy']>>>>()
    const currentMembers = Promise.withResolvers<Awaited<ReturnType<BotShareActions['listMembers']>>>()
    const currentPolicy = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotShareActions['getMemoryPolicy']>>>>()
    const actions = ownerActions({
      listMembers: vi.fn().mockImplementation((botId: string) => botId === bot.id ? staleMembers.promise : currentMembers.promise),
      getMemoryPolicy: vi.fn().mockImplementation((botId: string) => botId === bot.id
        ? stalePolicy.promise
        : currentPolicy.promise),
    })
    const view = render(<BotShareDialog bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(actions.listMembers).toHaveBeenCalledWith(bot.id) })
    view.rerender(<BotShareDialog bot={analystBot} actions={actions} open onClose={vi.fn()} t={t} />)
    await waitFor(() => { expect(actions.listMembers).toHaveBeenCalledWith(analystBot.id) })

    await act(async () => {
      currentMembers.resolve({ botId: BotId(analystBot.id), members: [{
        botId: BotId(analystBot.id),
        principalId: BotPrincipalId('principal-analyst'),
        role: 'collaborator',
        grantedBy: BotPrincipalId('principal-owner'),
        createdAt: 2,
        updatedAt: 2,
      }] })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole('status')).toBeTruthy()

    await act(async () => {
      staleMembers.resolve({ botId: BotId(bot.id), members: [{
        botId: BotId(bot.id),
        principalId: BotPrincipalId('principal-chief'),
        role: 'collaborator',
        grantedBy: BotPrincipalId('principal-owner'),
        createdAt: 1,
        updatedAt: 1,
      }] })
      stalePolicy.resolve({ botId: BotId(bot.id), enabled: false, updatedAt: 1 })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('principal-chief')).toBeNull()

    await act(async () => {
      currentPolicy.resolve({ botId: BotId(analystBot.id), enabled: true, updatedAt: 2 })
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => { expect(screen.getByText('principal-analyst')).toBeTruthy() })
    expect(screen.getByRole('switch', { name: 'Enable shared context' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByText('principal-chief')).toBeNull()
  })

  it('clears copied feedback when a subsequent copy fails', async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('clipboard unavailable'))
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const actions = ownerActions({ createInvite: vi.fn().mockResolvedValue({ code: 'invite-code', expiresAt: 2_000 }) })
    render(<BotShareDialog bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)
    try {
      await waitFor(() => { expect(screen.getByRole('switch', { name: 'Enable shared context' })).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: 'Create invite' }))
      await screen.findByLabelText('Invite code')
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
      await screen.findByRole('button', { name: 'Copied' })
      fireEvent.click(screen.getByRole('button', { name: 'Copied' }))
      await waitFor(() => { expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy() })
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(navigator, 'clipboard')
      else Object.defineProperty(navigator, 'clipboard', descriptor)
    }
  })

  it('does not apply stale invite-copy feedback to a newer Bot invite', async () => {
    const copy = Promise.withResolvers<undefined>()
    const writeText = vi.fn().mockReturnValue(copy.promise)
    const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const actions = ownerActions({
      createInvite: vi.fn().mockImplementation((botId: string) => Promise.resolve({
        code: botId === bot.id ? 'chief-invite' : 'analyst-invite',
        expiresAt: 2_000,
      })),
    })
    const view = render(<BotShareDialog bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)

    try {
      await waitFor(() => { expect(screen.getByRole('switch', { name: 'Enable shared context' })).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: 'Create invite' }))
      await waitFor(() => { expect(screen.getByLabelText('Invite code').textContent).toContain('chief-invite') })
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
      expect(writeText).toHaveBeenCalledWith('chief-invite')

      view.rerender(<BotShareDialog bot={analystBot} actions={actions} open onClose={vi.fn()} t={t} />)
      await waitFor(() => { expect(screen.getByRole('switch', { name: 'Enable shared context' })).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: 'Create invite' }))
      await waitFor(() => { expect(screen.getByLabelText('Invite code').textContent).toContain('analyst-invite') })

      await act(async () => {
        copy.resolve(undefined)
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy()
    } finally {
      if (originalClipboardDescriptor === undefined) Reflect.deleteProperty(navigator, 'clipboard')
      else Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor)
    }
  })

  it('invalidates invite-copy feedback when a newer invite starts', async () => {
    const copy = Promise.withResolvers<undefined>()
    const writeText = vi.fn().mockReturnValue(copy.promise)
    const secondInvite = Promise.withResolvers<Awaited<ReturnType<BotShareActions['createInvite']>>>()
    const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const actions = ownerActions({
      createInvite: vi.fn()
        .mockResolvedValueOnce({ code: 'first-invite', expiresAt: 2_000 })
        .mockReturnValueOnce(secondInvite.promise),
    })
    render(<BotShareDialog bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)

    try {
      await waitFor(() => { expect(screen.getByRole('switch', { name: 'Enable shared context' })).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: 'Create invite' }))
      await waitFor(() => { expect(screen.getByLabelText('Invite code').textContent).toContain('first-invite') })
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))

      fireEvent.click(screen.getByRole('button', { name: 'Create invite' }))
      await waitFor(() => { expect(actions.createInvite).toHaveBeenCalledTimes(2) })
      expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy()

      await act(async () => {
        copy.resolve(undefined)
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy()

      await act(async () => {
        secondInvite.resolve({ code: 'second-invite', expiresAt: 3_000 })
        await Promise.resolve()
        await Promise.resolve()
      })
      await waitFor(() => { expect(screen.getByLabelText('Invite code').textContent).toContain('second-invite') })
    } finally {
      if (originalClipboardDescriptor === undefined) Reflect.deleteProperty(navigator, 'clipboard')
      else Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor)
    }
  })

  it('broadcasts a membership invalidation again after revoke commits', async () => {
    const posts: unknown[] = []
    class FakeBroadcastChannel {
      constructor(readonly name: string) {}
      addEventListener(): void {}
      removeEventListener(): void {}
      postMessage(data: unknown): void { posts.push(data) }
      close(): void {}
    }
    const actions = ownerActions({
      listMembers: vi.fn().mockResolvedValue({ members: [
        { botId: BotId(bot.id), principalId: BotPrincipalId('principal-owner'), role: 'owner', grantedBy: BotPrincipalId('principal-owner'), createdAt: 1, updatedAt: 1 },
        { botId: BotId(bot.id), principalId: BotPrincipalId('principal-member'), role: 'collaborator', grantedBy: BotPrincipalId('principal-owner'), createdAt: 1, updatedAt: 1 },
      ] }),
    })
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
    try {
      render(<BotShareDialog bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)
      await waitFor(() => { expect(screen.getByRole('button', { name: 'Revoke access: principal-member' })).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: 'Revoke access: principal-member' }))
      await waitFor(() => { expect(actions.revokeMember).toHaveBeenCalledWith(bot.id, 'principal-member') })
      await waitFor(() => { expect(posts).toHaveLength(2) })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('gates owner shared-context policy changes behind explicit acknowledgement', async () => {
    const actions = ownerActions()
    render(<BotShareDialog bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByRole('switch', { name: 'Enable shared context' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable shared context' }))

    const confirmation = screen.getByRole('dialog', { name: 'Enable shared context?' })
    const confirm = within(confirmation).getByRole('button', { name: 'Enable context' })
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(confirmation).getByRole('checkbox', { name: /visible to every member/i }))
    expect((confirm as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(confirm)

    await waitFor(() => { expect(actions.setMemoryPolicy).toHaveBeenCalledWith(bot.id, true) })
  })

  it('blocks membership operations while a shared-context policy update is pending', async () => {
    const policyWrite = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotShareActions['setMemoryPolicy']>>>>()
    const actions = ownerActions({
      listMembers: vi.fn().mockResolvedValue({ members: [
        {
          botId: BotId(bot.id), principalId: BotPrincipalId('principal-owner'), role: 'owner',
          grantedBy: BotPrincipalId('principal-owner'), createdAt: 1, updatedAt: 1,
        },
        {
          botId: BotId(bot.id), principalId: BotPrincipalId('principal-member'), role: 'collaborator',
          grantedBy: BotPrincipalId('principal-owner'), createdAt: 1, updatedAt: 1,
        },
      ] }),
      setMemoryPolicy: vi.fn().mockReturnValue(policyWrite.promise),
    })
    render(<BotShareDialog bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByRole('switch', { name: 'Enable shared context' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable shared context' }))
    const confirmation = screen.getByRole('dialog', { name: 'Enable shared context?' })
    fireEvent.click(within(confirmation).getByRole('checkbox', { name: /visible to every member/i }))
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Enable context' }))

    await waitFor(() => { expect(actions.setMemoryPolicy).toHaveBeenCalledWith(bot.id, true) })
    expect((screen.getByRole('button', { name: 'Create invite' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Revoke access: principal-member' }) as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      policyWrite.resolve({ botId: BotId(bot.id), enabled: true, updatedAt: 2 })
      await Promise.resolve()
      await Promise.resolve()
    })
  })

  it('localizes owner membership role labels', async () => {
    const actions = ownerActions({
      listMembers: vi.fn().mockResolvedValue({ members: [
        {
          botId: BotId(bot.id), principalId: BotPrincipalId('principal-owner'), role: 'owner',
          grantedBy: BotPrincipalId('principal-owner'), createdAt: 1, updatedAt: 1,
        },
        {
          botId: BotId(bot.id), principalId: BotPrincipalId('principal-member'), role: 'collaborator',
          grantedBy: BotPrincipalId('principal-owner'), createdAt: 1, updatedAt: 1,
        },
      ] }),
    })
    render(<BotShareDialog bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('principal-member')).toBeTruthy() })
    const memberPrincipal = screen.getByText('principal-member')
    const memberRow = memberPrincipal.parentElement?.parentElement
    if (memberRow === null || memberRow === undefined) throw new Error('member row is missing')
    expect(within(memberRow).getByText('Collaborator')).toBeTruthy()
    expect(within(memberRow).queryByText('collaborator')).toBeNull()
  })

  it('closes the owner policy confirmation when the share dialog closes', async () => {
    const actions = ownerActions()
    const view = render(<BotShareDialog bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByRole('switch', { name: 'Enable shared context' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable shared context' }))
    const confirmation = screen.getByRole('dialog', { name: 'Enable shared context?' })
    fireEvent.click(within(confirmation).getByRole('checkbox', { name: /visible to every member/i }))

    view.rerender(<BotShareDialog bot={bot} actions={actions} open={false} onClose={vi.fn()} t={t} />)

    expect(screen.queryByRole('dialog', { name: 'Enable shared context?' })).toBeNull()
  })

  it('keeps a collaborator private transcript visually separate from shared context', async () => {
    const client = sharedClient()
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Private session')).toBeTruthy() })
    expect(screen.getByText('Private answer')).toBeTruthy()
    expect(screen.getByText('Shared decision')).toBeTruthy()
    expect(screen.getByText('Visible to members')).toBeTruthy()
    expect(screen.getByText('Redeem a Bot invite for every Bot first; a group invite only grants room access.')).toBeTruthy()
    expect(client.readPrivateChat).toHaveBeenCalledWith(bot.id)
    expect(client.readMemory).toHaveBeenCalledWith(bot.id)
  })

  it('clears private data when the shared dialog closes', async () => {
    const client = sharedClient()
    const view = render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)
    await waitFor(() => { expect(screen.getByText('Private answer')).toBeTruthy() })
    view.rerender(<SharedBotsDialog client={client} open={false} onClose={vi.fn()} t={t} />)
    await waitFor(() => { expect(screen.queryByText('Private answer')).toBeNull() })
  })

  it('clears and revalidates private data after an ACL denial', async () => {
    const client = sharedClient({
      chat: vi.fn().mockResolvedValue({ ok: false, error: { code: 'gateway/forbidden', message: 'membership revoked', details: {} } }),
      readPrivateChat: vi.fn()
        .mockResolvedValueOnce({ ok: true, value: { botId: bot.id, recent: [{ role: 'assistant', text: 'Private answer' }] } })
        .mockResolvedValue({ ok: true, value: { botId: bot.id, recent: [] } }),
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)
    await waitFor(() => { expect(screen.getByText('Private answer')).toBeTruthy() })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message this shared bot' }), { target: { value: 'check access' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => { expect(client.chat).toHaveBeenCalledWith(bot.id, 'check access') })
    await waitFor(() => { expect(client.restoreRetryScope).toHaveBeenCalledTimes(2) })
    expect(screen.queryByText('Private answer')).toBeNull()
  })

  it('bounds repeated forbidden roster refreshes instead of looping forever', async () => {
    const list = vi.fn().mockResolvedValue({
      ok: false as const,
      error: { code: 'gateway/forbidden', message: 'membership revoked', details: {} },
    })
    const client = sharedClient({ list })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(list).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('alert').textContent).toContain('membership revoked')
  })

  it('refreshes after enrollment with a real shared client without self-invalidating the request', async () => {
    let listCalls = 0
    const wireBot = (summary: CompleteBotSummary) => ({
      id: summary.id,
      name: summary.name,
      description: summary.description,
      identity: summary.identity,
      accent: summary.accent,
      state: 'active' as const,
      availability: 'idle' as const,
    })
    const rpc: ClientConnectionRpc = {
      call: vi.fn(async (_channel, endpoint) => {
        if (endpoint === 'bots/share/session' || endpoint === 'bots/share/enroll') {
          return { ok: true as const, value: { principalId: 'principal-member', expiresAt: 3_000 } }
        }
        if (endpoint === 'bots/share/list') {
          listCalls += 1
          return { ok: true as const, value: { bots: listCalls === 1 ? [{ ...wireBot(bot), role: 'collaborator' }] : [{ ...wireBot(analystBot), role: 'collaborator' }] } }
        }
        if (endpoint === 'bots/share/read-private-chat') {
          return { ok: true as const, value: { botId: listCalls === 1 ? bot.id : analystBot.id, recent: [{ role: 'assistant', text: listCalls === 1 ? 'Private answer' : 'Post-enrollment answer' }] } }
        }
        if (endpoint === 'bots/share/read-memory') {
          return { ok: true as const, value: { botId: listCalls === 1 ? bot.id : analystBot.id, enabled: true, updatedAt: 1, entries: [] } }
        }
        if (endpoint === 'bots/share/list-groups') {
          return { ok: true as const, value: { groups: [] } }
        }
        return { ok: true as const, value: {} }
      }),
    }
    vi.stubGlobal('BroadcastChannel', undefined)
    try {
      const client = createSharedBotsClient(rpc)
      render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)
      await waitFor(() => { expect(screen.getByText('Private answer')).toBeTruthy() })
      fireEvent.change(screen.getByRole('textbox', { name: 'Invite code' }), { target: { value: 'invite' } })
      fireEvent.click(screen.getByRole('button', { name: 'Join bot' }))
      await waitFor(() => { expect(screen.getByText('Post-enrollment answer')).toBeTruthy() })
      expect(listCalls).toBe(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('defers focus refreshes until enrollment settles', async () => {
    const enroll = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['enroll']>>>()
    const restoreRetryScope = vi.fn().mockResolvedValue({ ok: true, value: { principalId: 'principal-member', expiresAt: 2_000 } })
    const list = vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'collaborator' }] } })
    const client = sharedClient({ enroll: vi.fn().mockReturnValue(enroll.promise), restoreRetryScope, list })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Private answer')).toBeTruthy() })
    const initialRestoreCalls = restoreRetryScope.mock.calls.length
    fireEvent.change(screen.getByRole('textbox', { name: 'Invite code' }), { target: { value: 'invite' } })
    fireEvent.click(screen.getByRole('button', { name: 'Join bot' }))
    await waitFor(() => { expect(client.enroll).toHaveBeenCalledWith('invite') })

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })
    expect(restoreRetryScope).toHaveBeenCalledTimes(initialRestoreCalls)

    await act(async () => {
      enroll.resolve({ ok: true, value: { principalId: 'principal-member', expiresAt: 2_000 } })
      await Promise.resolve()
    })
    await waitFor(() => { expect(list.mock.calls.length).toBeGreaterThan(initialRestoreCalls) })
  })

  it('keeps a newly typed invite code across the real client auth generation change', async () => {
    const enrollment = Promise.withResolvers<{
      readonly ok: true
      readonly value: { readonly principalId: string; readonly expiresAt: number }
    }>()
    const enrollmentStarted = Promise.withResolvers<true>()
    const wireBot = {
      id: bot.id,
      name: bot.name,
      description: bot.description,
      identity: bot.identity,
      accent: bot.accent,
      state: 'active' as const,
      availability: 'idle' as const,
      role: 'collaborator' as const,
    }
    const rpc: ClientConnectionRpc = {
      call: vi.fn(async (_channel, endpoint) => {
        if (endpoint === 'bots/share/enroll') {
          enrollmentStarted.resolve(true)
          return enrollment.promise
        }
        if (endpoint === 'bots/share/session') return { ok: true as const, value: { principalId: 'principal-member', expiresAt: 3_000 } }
        if (endpoint === 'bots/share/list') return { ok: true as const, value: { bots: [wireBot] } }
        if (endpoint === 'bots/share/read-private-chat') return { ok: true as const, value: { botId: bot.id, recent: [{ role: 'assistant', text: 'Private answer' }] } }
        if (endpoint === 'bots/share/read-memory') return { ok: true as const, value: { botId: bot.id, enabled: true, updatedAt: 1, entries: [] } }
        if (endpoint === 'bots/share/list-groups') return { ok: true as const, value: { groups: [] } }
        return { ok: true as const, value: {} }
      }),
    }
    vi.stubGlobal('BroadcastChannel', undefined)
    try {
      const client = createSharedBotsClient(rpc)
      render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)
      await waitFor(() => { expect(screen.getByText('Private answer')).toBeTruthy() })
      fireEvent.change(screen.getByRole('textbox', { name: 'Invite code' }), { target: { value: 'first-code' } })
      fireEvent.click(screen.getByRole('button', { name: 'Join bot' }))
      await enrollmentStarted.promise
      fireEvent.change(screen.getByRole('textbox', { name: 'Invite code' }), { target: { value: 'second-code' } })

      await act(async () => {
        enrollment.resolve({ ok: true, value: { principalId: 'principal-member', expiresAt: 3_000 } })
        await Promise.resolve()
      })
      await waitFor(() => { expect(screen.getByText('Private answer')).toBeTruthy() })
      expect(screen.getByRole('textbox', { name: 'Invite code' })).toHaveProperty('value', 'second-code')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps a newly typed invite code when the submitted enrollment fails', async () => {
    const enrollment = Promise.withResolvers<{
      readonly ok: false
      readonly error: { readonly code: 'gateway/unauthorized'; readonly message: string; readonly details: Record<string, never> }
    }>()
    const enrollmentStarted = Promise.withResolvers<true>()
    const wireBot = {
      id: bot.id,
      name: bot.name,
      description: bot.description,
      identity: bot.identity,
      accent: bot.accent,
      state: 'active' as const,
      availability: 'idle' as const,
      role: 'collaborator' as const,
    }
    const rpc: ClientConnectionRpc = {
      call: vi.fn(async (_channel, endpoint) => {
        if (endpoint === 'bots/share/enroll') {
          enrollmentStarted.resolve(true)
          return enrollment.promise
        }
        if (endpoint === 'bots/share/session') return { ok: true as const, value: { principalId: 'principal-member', expiresAt: 3_000 } }
        if (endpoint === 'bots/share/list') return { ok: true as const, value: { bots: [wireBot] } }
        if (endpoint === 'bots/share/read-private-chat') return { ok: true as const, value: { botId: bot.id, recent: [{ role: 'assistant', text: 'Private answer' }] } }
        if (endpoint === 'bots/share/read-memory') return { ok: true as const, value: { botId: bot.id, enabled: true, updatedAt: 1, entries: [] } }
        if (endpoint === 'bots/share/list-groups') return { ok: true as const, value: { groups: [] } }
        return { ok: true as const, value: {} }
      }),
    }
    vi.stubGlobal('BroadcastChannel', undefined)
    try {
      const client = createSharedBotsClient(rpc)
      render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)
      await waitFor(() => { expect(screen.getByText('Private answer')).toBeTruthy() })
      const input = screen.getByRole('textbox', { name: 'Invite code' })
      fireEvent.change(input, { target: { value: 'first-code' } })
      fireEvent.click(screen.getByRole('button', { name: 'Join bot' }))
      await enrollmentStarted.promise
      fireEvent.change(input, { target: { value: 'second-code' } })

      await act(async () => {
        enrollment.resolve({ ok: false, error: { code: 'gateway/unauthorized', message: 'expired', details: {} } })
        await Promise.resolve()
      })
      await waitFor(() => { expect(screen.getByRole('button', { name: 'Join bot' })).toBeTruthy() })
      expect(input).toHaveProperty('value', 'second-code')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('localizes the collaborator role in the shared roster', async () => {
    const client = sharedClient()
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Collaborator')).toBeTruthy() })
    expect(screen.queryByText('collaborator')).toBeNull()
  })

  it('creates a shared group through the shared route and lets its owner make an invite', async () => {
    const group = {
      id: brandString<BotGroupId>('bot-group-launch'),
      name: 'Launch room',
      botIds: [BotId(bot.id), BotId(analystBot.id)],
      bots: [
        { id: BotId(bot.id), name: bot.name, identity: bot.identity, accent: bot.accent, state: 'active' as const, availability: 'idle' as const },
        { id: BotId(analystBot.id), name: analystBot.name, identity: analystBot.identity, accent: analystBot.accent, state: 'active' as const, availability: 'idle' as const },
      ],
      createdAt: 1,
      updatedAt: 1,
    } satisfies BotGroupView
    const createGroup = vi.fn().mockResolvedValue({ ok: true, value: { group } })
    const createGroupInvite = vi.fn().mockResolvedValue({ ok: true, value: { code: 'group-invite', expiresAt: 2_000 } })
    const client = sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'collaborator' }, { ...analystBot, role: 'owner' }] } }),
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [] } }),
      createGroup,
      createGroupInvite,
      inspectGroup: vi.fn().mockResolvedValue({ ok: true, value: { group, messages: [] } }),
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByRole('button', { name: 'Create shared group' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Create shared group' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a shared group' })
    expect(within(dialog).getByText('Create or request a Bot invite for each selected Bot, redeem every invite above, then choose two to six Bots. The group owner must be a member of every selected Bot; a group invite only grants room access.')).toBeTruthy()
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Group name' }), { target: { value: 'Launch room' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: bot.name }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: analystBot.name }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create shared group' }))

    await waitFor(() => {
      expect(createGroup).toHaveBeenCalledWith(expect.objectContaining({ name: 'Launch room', botIds: [BotId(bot.id), BotId(analystBot.id)] }))
      expect(screen.getByRole('button', { name: 'Invite people' })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Invite people' }))
    await waitFor(() => {
      expect(createGroupInvite).toHaveBeenCalledWith(group.id)
      expect(screen.getByLabelText('Group invite code').textContent).toContain('group-invite')
    })
  })

  it('explains the owner-only group invite after a collaborator is refused', async () => {
    const group = {
      id: brandString<BotGroupId>('bot-group-collaborator'),
      name: 'Collaborator room',
      botIds: [BotId(bot.id), BotId(analystBot.id)],
      bots: [
        { id: BotId(bot.id), name: bot.name, identity: bot.identity, accent: bot.accent, state: 'active' as const, availability: 'idle' as const },
        { id: BotId(analystBot.id), name: analystBot.name, identity: analystBot.identity, accent: analystBot.accent, state: 'active' as const, availability: 'idle' as const },
      ],
      createdAt: 1,
      updatedAt: 1,
    } satisfies BotGroupView
    const createGroupInvite = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'gateway/forbidden', message: 'only the shared group owner may invite members', details: {} },
    })
    const client = sharedClient({
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [group] } }),
      inspectGroup: vi.fn().mockResolvedValue({ ok: true, value: { group, messages: [] } }),
      createGroupInvite,
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByRole('button', { name: 'Invite people' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Invite people' }))
    await waitFor(() => { expect(createGroupInvite).toHaveBeenCalledWith(group.id) })
    expect(screen.getByText('Only the group owner can create an invite. Ask the owner to share one.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Invite people' })).toBeNull()
  })

  it('reuses the shared group id after an uncertain create response', async () => {
    const group = {
      id: brandString<BotGroupId>('bot-group-retry'),
      name: 'Retry room',
      botIds: [BotId(bot.id), BotId(analystBot.id)],
      bots: [
        { id: BotId(bot.id), name: bot.name, identity: bot.identity, accent: bot.accent, state: 'active' as const, availability: 'idle' as const },
        { id: BotId(analystBot.id), name: analystBot.name, identity: analystBot.identity, accent: analystBot.accent, state: 'active' as const, availability: 'idle' as const },
      ],
      createdAt: 1,
      updatedAt: 1,
    } satisfies BotGroupView
    const createGroup = vi.fn()
      .mockRejectedValueOnce(new Error('connection closed after commit'))
      .mockResolvedValueOnce({ ok: true, value: { group } })
    const client = sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'collaborator' }, { ...analystBot, role: 'owner' }] } }),
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [] } }),
      createGroup,
      inspectGroup: vi.fn().mockResolvedValue({ ok: true, value: { group, messages: [] } }),
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByRole('button', { name: 'Create shared group' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Create shared group' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a shared group' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Group name' }), { target: { value: 'Retry room' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: bot.name }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: analystBot.name }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create shared group' }))

    await waitFor(() => { expect(createGroup).toHaveBeenCalledTimes(1) })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('connection closed after commit') })
    const firstRequest = createGroup.mock.calls[0]?.[0] as { readonly id?: string }
    expect(firstRequest.id).toMatch(/^bot-group-/)

    await waitFor(() => { expect(within(dialog).getByRole('button', { name: 'Recover' })).toBeTruthy() })
    fireEvent.click(within(dialog).getByRole('button', { name: /Recover/ }))
    await waitFor(() => {
      expect(createGroup).toHaveBeenCalledTimes(2)
      expect(createGroup.mock.calls[1]?.[0].id).toBe(firstRequest.id)
    })
  })

  it('reuses the shared message id after an uncertain send response', async () => {
    const group = {
      id: brandString<BotGroupId>('bot-group-message-retry'),
      name: 'Retry room',
      botIds: [BotId(bot.id), BotId(analystBot.id)],
      bots: [
        { id: BotId(bot.id), name: bot.name, identity: bot.identity, accent: bot.accent, state: 'active' as const, availability: 'idle' as const },
        { id: BotId(analystBot.id), name: analystBot.name, identity: analystBot.identity, accent: analystBot.accent, state: 'active' as const, availability: 'idle' as const },
      ],
      createdAt: 1,
      updatedAt: 1,
    } satisfies BotGroupView
    const sendGroupMessage = vi.fn()
      .mockRejectedValueOnce(new Error('connection closed after commit'))
      .mockResolvedValueOnce({ ok: true, value: { messageId: brandString<BotGroupMessageId>('bot-group-message-retry'), status: 'accepted', deliveries: [] } })
    const client = sharedClient({
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [group] } }),
      inspectGroup: vi.fn().mockResolvedValue({ ok: true, value: { group, messages: [] } }),
      sendGroupMessage,
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByPlaceholderText('Message Retry room')).toBeTruthy() })
    fireEvent.change(screen.getByPlaceholderText('Message Retry room'), { target: { value: 'Retry this update' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to group' }))
    await waitFor(() => { expect(sendGroupMessage).toHaveBeenCalledTimes(1) })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('connection closed after commit') })
    const firstRequest = sendGroupMessage.mock.calls[0]?.[0] as { readonly messageId?: string }
    expect(firstRequest.messageId).toMatch(/^bot-group-message-/)

    fireEvent.click(screen.getByRole('button', { name: 'Send to group' }))
    await waitFor(() => {
      expect(sendGroupMessage).toHaveBeenCalledTimes(2)
      expect(sendGroupMessage.mock.calls[1]?.[0].messageId).toBe(firstRequest.messageId)
    })
  })

  it('resends the same shared message id after a partial delivery', async () => {
    const group = {
      id: brandString<BotGroupId>('bot-group-message-partial'),
      name: 'Partial message room',
      botIds: [BotId(bot.id), BotId(analystBot.id)],
      bots: [
        { id: BotId(bot.id), name: bot.name, identity: bot.identity, accent: bot.accent, state: 'active' as const, availability: 'idle' as const },
        { id: BotId(analystBot.id), name: analystBot.name, identity: analystBot.identity, accent: analystBot.accent, state: 'active' as const, availability: 'idle' as const },
      ],
      createdAt: 1,
      updatedAt: 1,
    } satisfies BotGroupView
    const existingMessage: { current: BotGroupMessageView | undefined } = { current: undefined }
    const sendGroupMessage = vi.fn()
      .mockImplementationOnce(async (request) => {
        existingMessage.current = {
          id: request.messageId!,
          groupId: group.id,
          sender: { kind: 'user' as const, principalId: BotPrincipalId('principal-member') },
          text: request.text,
          createdAt: 2,
        }
        return { ok: true as const, value: { messageId: request.messageId!, status: 'partial' as const, deliveries: [] } }
      })
      .mockResolvedValueOnce({ ok: true, value: { messageId: brandString<BotGroupMessageId>('bot-group-message-partial'), status: 'accepted', deliveries: [] } })
    const client = sharedClient({
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [group] } }),
      inspectGroup: vi.fn().mockImplementation(async () => ({
        ok: true as const,
        value: { group, messages: existingMessage.current === undefined ? [] : [existingMessage.current] },
      })),
      sendGroupMessage,
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByPlaceholderText('Message Partial message room')).toBeTruthy() })
    fireEvent.change(screen.getByPlaceholderText('Message Partial message room'), { target: { value: 'Retry the partial update' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to group' }))
    await waitFor(() => { expect(sendGroupMessage).toHaveBeenCalledOnce() })
    const firstMessageId = sendGroupMessage.mock.calls[0]?.[0].messageId
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('The group message could not be sent. Try again.') })

    fireEvent.click(screen.getByRole('button', { name: 'Send to group' }))
    await waitFor(() => { expect(sendGroupMessage).toHaveBeenCalledTimes(2) })
    expect(sendGroupMessage.mock.calls[1]?.[0].messageId).toBe(firstMessageId)
  })

  it('does not leave a group invite busy after switching groups', async () => {
    const member = { id: BotId(bot.id), name: bot.name, identity: bot.identity, accent: bot.accent, state: 'active' as const, availability: 'idle' as const }
    const groupA = {
      id: brandString<BotGroupId>('bot-group-invite-alpha'),
      name: 'Alpha room',
      botIds: [BotId(bot.id), BotId(analystBot.id)],
      bots: [member, { ...member, id: BotId(analystBot.id), name: analystBot.name }],
      createdAt: 1,
      updatedAt: 1,
    } satisfies BotGroupView
    const groupB = { ...groupA, id: brandString<BotGroupId>('bot-group-invite-beta'), name: 'Beta room' } satisfies BotGroupView
    const firstInvite = Promise.withResolvers<Awaited<ReturnType<NonNullable<SharedBotsClient['createGroupInvite']>>>>()
    const secondInvite = Promise.withResolvers<Awaited<ReturnType<NonNullable<SharedBotsClient['createGroupInvite']>>>>()
    const createGroupInvite = vi.fn()
      .mockReturnValueOnce(firstInvite.promise)
      .mockReturnValueOnce(secondInvite.promise)
    const client = sharedClient({
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [groupA, groupB] } }),
      inspectGroup: vi.fn().mockImplementation(async (groupId: string) => ({
        ok: true,
        value: { group: groupId === groupA.id ? groupA : groupB, messages: [] },
      })),
      createGroupInvite,
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByRole('button', { name: 'Invite people' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Invite people' }))
    await waitFor(() => { expect(createGroupInvite).toHaveBeenCalledWith(groupA.id) })
    fireEvent.click(screen.getByRole('button', { name: /Beta room/ }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Invite people' })).toHaveProperty('disabled', false) })

    fireEvent.click(screen.getByRole('button', { name: 'Invite people' }))
    await waitFor(() => { expect(createGroupInvite).toHaveBeenCalledWith(groupB.id) })
    await act(async () => {
      secondInvite.resolve({ ok: true, value: { code: 'beta-invite', expiresAt: 2_000 } })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByLabelText('Group invite code').textContent).toContain('beta-invite')
    await act(async () => {
      firstInvite.resolve({ ok: true, value: { code: 'alpha-invite', expiresAt: 2_000 } })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByLabelText('Group invite code').textContent).toContain('beta-invite')
  })

  it('clears shared-group invite work when the principal is unauthorized', async () => {
    const group = {
      id: brandString<BotGroupId>('bot-group-invite-auth-race'),
      name: 'Invite auth room',
      botIds: [BotId(bot.id), BotId(analystBot.id)],
      bots: [
        { id: BotId(bot.id), name: bot.name, identity: bot.identity, accent: bot.accent, state: 'active' as const, availability: 'idle' as const },
        { id: BotId(analystBot.id), name: analystBot.name, identity: analystBot.identity, accent: analystBot.accent, state: 'active' as const, availability: 'idle' as const },
      ],
      createdAt: 1,
      updatedAt: 1,
    } satisfies BotGroupView
    let scope: string | undefined = 'principal-member'
    const createGroupInvite = vi.fn().mockImplementation(async () => {
      scope = undefined
      return { ok: false as const, error: { code: 'gateway/unauthorized', message: 'session expired', details: {} } }
    })
    const client = sharedClient({
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [group] } }),
      inspectGroup: vi.fn().mockResolvedValue({ ok: true, value: { group, messages: [] } }),
      createGroupInvite,
    })
    Object.defineProperty(client, 'retryScope', { configurable: true, get: () => scope })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByRole('button', { name: 'Invite people' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Invite people' }))
    await waitFor(() => { expect(createGroupInvite).toHaveBeenCalledOnce() })
    await waitFor(() => { expect(screen.queryByText('Creating invite…')).toBeNull() })
  })

  it('does not apply a shared-group create after the owner cancels it', async () => {
    const existingGroup = {
      id: brandString<BotGroupId>('bot-group-existing'),
      name: 'Existing room',
      botIds: [BotId(bot.id), BotId(analystBot.id)],
      bots: [
        { id: BotId(bot.id), name: bot.name, identity: bot.identity, accent: bot.accent, state: 'active' as const, availability: 'idle' as const },
        { id: BotId(analystBot.id), name: analystBot.name, identity: analystBot.identity, accent: analystBot.accent, state: 'active' as const, availability: 'idle' as const },
      ],
      createdAt: 1,
      updatedAt: 1,
    } satisfies BotGroupView
    const createdGroup = { ...existingGroup, id: brandString<BotGroupId>('bot-group-created'), name: 'Created after cancel' } satisfies BotGroupView
    const createGroup = Promise.withResolvers<Awaited<ReturnType<NonNullable<SharedBotsClient['createGroup']>>>>()
    const client = sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'owner' }, { ...analystBot, role: 'owner' }] } }),
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [existingGroup] } }),
      inspectGroup: vi.fn().mockResolvedValue({ ok: true, value: { group: existingGroup, messages: [] } }),
      createGroup: vi.fn().mockReturnValue(createGroup.promise),
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByRole('button', { name: 'Create shared group' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Create shared group' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a shared group' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Group name' }), { target: { value: 'Created after cancel' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: bot.name }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: analystBot.name }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create shared group' }))
    await waitFor(() => { expect(client.createGroup).toHaveBeenCalledOnce() })
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Cancel' }).at(-1)!)
    expect(screen.queryByRole('dialog', { name: 'Create a shared group' })).toBeNull()

    await act(async () => {
      createGroup.resolve({ ok: true, value: { group: createdGroup } })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.queryByRole('button', { name: /Created after cancel/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Existing room/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Create shared group' }))
    const reopenedDialog = screen.getByRole('dialog', { name: 'Create a shared group' })
    await waitFor(() => { expect(within(reopenedDialog).getByRole('button', { name: 'Recover' })).toBeTruthy() })
    expect(within(reopenedDialog).getByText(/Created after cancel/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Created after cancel/ })).toBeNull()
    fireEvent.click(within(reopenedDialog).getByRole('button', { name: 'Discard' }))
    const discardDialog = screen.getByRole('dialog', { name: 'Discard this retry record?' })
    fireEvent.click(within(discardDialog).getByRole('checkbox'))
    fireEvent.click(within(discardDialog).getByRole('button', { name: 'Discard retry record' }))
    await waitFor(() => { expect(within(reopenedDialog).queryByText(/Created after cancel/)).toBeNull() })
  })

  it('clears shared-group create work when the principal is unauthorized', async () => {
    let scope: string | undefined = 'principal-member'
    const createGroup = vi.fn().mockImplementation(async () => {
      scope = undefined
      return { ok: false as const, error: { code: 'gateway/unauthorized', message: 'session expired', details: {} } }
    })
    const client = sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'owner' }, { ...analystBot, role: 'owner' }] } }),
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [] } }),
      createGroup,
    })
    Object.defineProperty(client, 'retryScope', { configurable: true, get: () => scope })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByRole('button', { name: 'Create shared group' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Create shared group' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a shared group' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Group name' }), { target: { value: 'Expired room' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: bot.name }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: analystBot.name }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create shared group' }))

    await waitFor(() => { expect(createGroup).toHaveBeenCalledOnce() })
    await waitFor(() => { expect(screen.queryByText('Creating shared group…')).toBeNull() })
  })

  it('does not let a cancelled create close a newly reopened dialog', async () => {
    const createdGroup = {
      id: brandString<BotGroupId>('bot-group-reopened-create'),
      name: 'Reopened room',
      botIds: [BotId(bot.id), BotId(analystBot.id)],
      bots: [
        { id: BotId(bot.id), name: bot.name, identity: bot.identity, accent: bot.accent, state: 'active' as const, availability: 'idle' as const },
        { id: BotId(analystBot.id), name: analystBot.name, identity: analystBot.identity, accent: analystBot.accent, state: 'active' as const, availability: 'idle' as const },
      ],
      createdAt: 1,
      updatedAt: 1,
    } satisfies BotGroupView
    const createGroup = Promise.withResolvers<Awaited<ReturnType<NonNullable<SharedBotsClient['createGroup']>>>>()
    const client = sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'owner' }, { ...analystBot, role: 'owner' }] } }),
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [] } }),
      inspectGroup: vi.fn().mockResolvedValue({ ok: true, value: { group: createdGroup, messages: [] } }),
      createGroup: vi.fn().mockReturnValue(createGroup.promise),
    })
    const view = render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByRole('button', { name: 'Create shared group' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Create shared group' }))
    const firstDialog = screen.getByRole('dialog', { name: 'Create a shared group' })
    fireEvent.change(within(firstDialog).getByRole('textbox', { name: 'Group name' }), { target: { value: 'Reopened room' } })
    fireEvent.click(within(firstDialog).getByRole('checkbox', { name: bot.name }))
    fireEvent.click(within(firstDialog).getByRole('checkbox', { name: analystBot.name }))
    fireEvent.click(within(firstDialog).getByRole('button', { name: 'Create shared group' }))
    await waitFor(() => { expect(client.createGroup).toHaveBeenCalledOnce() })
    fireEvent.click(within(firstDialog).getAllByRole('button', { name: 'Cancel' }).at(-1)!)

    fireEvent.click(screen.getByRole('button', { name: 'Create shared group' }))
    expect(screen.getByRole('dialog', { name: 'Create a shared group' })).toBeTruthy()
    await act(async () => {
      createGroup.resolve({ ok: true, value: { group: createdGroup } })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole('dialog', { name: 'Create a shared group' })).toBeTruthy()
    view.unmount()
  })

  it('does not overlap a recovery while the previous recovery is still settling', async () => {
    const queue = createSharedGroupPendingQueue('principal-member')
    await queue.reserveCreation('recovery-overlap', 'Recovery room', [bot.id, analystBot.id])
    const createGroup = Promise.withResolvers<Awaited<ReturnType<NonNullable<SharedBotsClient['createGroup']>>>>()
    const client = sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'owner' }, { ...analystBot, role: 'owner' }] } }),
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [] } }),
      createGroup: vi.fn().mockReturnValue(createGroup.promise),
    })
    const view = render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByRole('button', { name: 'Create shared group' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Create shared group' }))
    let dialog = screen.getByRole('dialog', { name: 'Create a shared group' })
    await waitFor(() => { expect(within(dialog).getByRole('button', { name: 'Recover' })).toBeTruthy() })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Recover' }))
    await waitFor(() => { expect(client.createGroup).toHaveBeenCalledOnce() })

    await act(async () => {
      view.rerender(<SharedBotsDialog client={client} open={false} onClose={vi.fn()} t={t} />)
      await Promise.resolve()
    })
    view.rerender(<SharedBotsDialog client={client} open t={t} onClose={vi.fn()} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Create shared group' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Create shared group' }))
    dialog = screen.getByRole('dialog', { name: 'Create a shared group' })
    await waitFor(() => {
      const recover = within(dialog).getByRole('button', { name: /Recover/ })
      expect(recover).toBeTruthy()
      expect((recover as HTMLButtonElement).disabled).toBe(true)
      expect((within(dialog).getByRole('button', { name: 'Create shared group' }) as HTMLButtonElement).disabled).toBe(true)
    })
    fireEvent.click(within(dialog).getByRole('button', { name: /Recover/ }))
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(client.createGroup).toHaveBeenCalledOnce()

    createGroup.resolve({ ok: false, error: { code: 'gateway/transport', message: 'settled', details: {} } })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await waitFor(() => {
      expect((within(dialog).getByRole('button', { name: 'Recover' }) as HTMLButtonElement).disabled).toBe(false)
    })
  })

  it('reconciles a persisted shared-group create after reopening', async () => {
    localStorage.clear()
    const createdGroup = {
      id: brandString<BotGroupId>('bot-group-persisted-create'),
      name: 'Persisted room',
      botIds: [BotId(bot.id), BotId(analystBot.id)],
      bots: [
        { id: BotId(bot.id), name: bot.name, identity: bot.identity, accent: bot.accent, state: 'active' as const, availability: 'idle' as const },
        { id: BotId(analystBot.id), name: analystBot.name, identity: analystBot.identity, accent: analystBot.accent, state: 'active' as const, availability: 'idle' as const },
      ],
      createdAt: 1,
      updatedAt: 1,
    } satisfies BotGroupView
    let groups: readonly BotGroupView[] = []
    const createGroup = vi.fn().mockRejectedValueOnce(new Error('connection closed after commit'))
    const listGroups = vi.fn().mockImplementation(async () => ({ ok: true as const, value: { groups } }))
    const client = sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'owner' }, { ...analystBot, role: 'owner' }] } }),
      listGroups,
      inspectGroup: vi.fn().mockResolvedValue({ ok: true, value: { group: createdGroup, messages: [] } }),
      createGroup,
    })
    const firstView = render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Create shared group' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Create shared group' }))
    let dialog = screen.getByRole('dialog', { name: 'Create a shared group' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Group name' }), { target: { value: 'Persisted room' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: bot.name }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: analystBot.name }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create shared group' }))
    await waitFor(() => { expect(createGroup).toHaveBeenCalledOnce() })
    const firstId = createGroup.mock.calls[0]?.[0].id
    expect(firstId).toMatch(/^bot-group-/)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('connection closed after commit') })
    firstView.unmount()

    groups = [{ ...createdGroup, id: brandString<BotGroupId>(String(firstId)) }]
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Create shared group' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Create shared group' }))
    dialog = screen.getByRole('dialog', { name: 'Create a shared group' })
    await waitFor(() => { expect(within(dialog).getByRole('button', { name: 'Recover' })).toBeTruthy() })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Recover' }))

    await waitFor(() => {
      expect(createGroup).toHaveBeenCalledOnce()
      expect(listGroups.mock.calls.length).toBeGreaterThan(1)
      expect(screen.getByRole('button', { name: /Persisted room/ })).toBeTruthy()
    })
    expect(screen.queryByText('Interrupted group creation')).toBeNull()
  })

  it('reconciles a persisted shared-group message after reopening', async () => {
    localStorage.clear()
    const group = {
      id: brandString<BotGroupId>('bot-group-persisted-message'),
      name: 'Persisted message room',
      botIds: [BotId(bot.id), BotId(analystBot.id)],
      bots: [
        { id: BotId(bot.id), name: bot.name, identity: bot.identity, accent: bot.accent, state: 'active' as const, availability: 'idle' as const },
        { id: BotId(analystBot.id), name: analystBot.name, identity: analystBot.identity, accent: analystBot.accent, state: 'active' as const, availability: 'idle' as const },
      ],
      createdAt: 1,
      updatedAt: 1,
    } satisfies BotGroupView
    const existingMessage: { current: BotGroupMessageView | undefined } = { current: undefined }
    const sendGroupMessage = vi.fn()
      .mockRejectedValueOnce(new Error('connection closed after commit'))
      .mockResolvedValue({ ok: true, value: { messageId: brandString<BotGroupMessageId>('bot-group-message-persisted-message'), status: 'accepted', deliveries: [] } })
    const inspectGroup = vi.fn().mockImplementation(async () => ({
      ok: true as const,
      value: { group, messages: existingMessage.current === undefined ? [] : [existingMessage.current] },
    }))
    const client = sharedClient({
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [group] } }),
      inspectGroup,
      sendGroupMessage,
    })
    const firstView = render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)
    await waitFor(() => { expect(screen.getByPlaceholderText('Message Persisted message room')).toBeTruthy() })
    fireEvent.change(screen.getByPlaceholderText('Message Persisted message room'), { target: { value: 'Persist this update' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to group' }))
    await waitFor(() => { expect(sendGroupMessage).toHaveBeenCalledOnce() })
    const firstId = sendGroupMessage.mock.calls[0]?.[0].messageId
    expect(firstId).toMatch(/^bot-group-message-/)
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('connection closed after commit') })
    firstView.unmount()

    existingMessage.current = {
      id: firstId,
      groupId: group.id,
      sender: { kind: 'user' as const, principalId: BotPrincipalId('principal-member') },
      text: 'Persist this update',
      createdAt: 2,
    }
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)
    await waitFor(() => { expect(screen.getByPlaceholderText('Message Persisted message room')).toBeTruthy() })
    await waitFor(() => { expect(screen.getByText('Pending group messages')).toBeTruthy() })
    expect(screen.getByText('Persist this update')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Recover' }))
    await waitFor(() => { expect(sendGroupMessage).toHaveBeenCalledTimes(2) })
    expect(sendGroupMessage.mock.calls[1]?.[0].messageId).toBe(firstId)
  })

  it('shows and sends a collaborator group without mixing private transcript data', async () => {
    const group = {
      id: brandString<BotGroupId>('bot-group-release'),
      name: 'Release room',
      botIds: [BotId(bot.id), BotId(analystBot.id)],
      bots: [
        { id: BotId(bot.id), name: bot.name, identity: bot.identity, accent: bot.accent, state: 'active' as const, availability: 'idle' as const },
        { id: BotId(analystBot.id), name: analystBot.name, identity: analystBot.identity, accent: analystBot.accent, state: 'active' as const, availability: 'idle' as const },
      ],
      createdAt: 1,
      updatedAt: 1,
    } satisfies BotGroupView
    const inspectGroup = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        group,
        messages: [{
          id: brandString<BotGroupMessageId>('bot-group-message-existing'),
          groupId: group.id,
          sender: { kind: 'bot', botId: BotId(analystBot.id), name: analystBot.name },
          text: 'Group-only status',
          createdAt: 2,
        }],
      },
    })
    const sendGroupMessage = vi.fn().mockResolvedValue({
      ok: true,
      value: { messageId: brandString<BotGroupMessageId>('bot-group-message-new'), status: 'accepted', deliveries: [] },
    })
    const client = sharedClient({
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [group] } }),
      inspectGroup,
      sendGroupMessage,
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getAllByText('Release room').length).toBeGreaterThan(0) })
    expect(screen.getByText('Group-only status')).toBeTruthy()
    expect(screen.queryByText('Private answer')).toBeNull()
    const input = screen.getByPlaceholderText('Message Release room')
    fireEvent.change(input, { target: { value: 'Coordinate launch' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to group' }))
    await waitFor(() => {
      expect(sendGroupMessage).toHaveBeenCalledWith(expect.objectContaining({ groupId: group.id, text: 'Coordinate launch' }))
    })
  })

  it('assigns a fresh delivery id when the same group text is sent again', async () => {
    const member = { id: BotId(bot.id), name: bot.name, identity: bot.identity, accent: bot.accent, state: 'active' as const, availability: 'idle' as const }
    const group = {
      id: brandString<BotGroupId>('bot-group-repeat-message'),
      name: 'Repeat room',
      botIds: [BotId(bot.id), BotId(analystBot.id)],
      bots: [member, { ...member, id: BotId(analystBot.id), name: analystBot.name }],
      createdAt: 1,
      updatedAt: 1,
    } satisfies BotGroupView
    const sendGroupMessage = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: { messageId: brandString<BotGroupMessageId>('bot-group-message-repeat-one'), status: 'accepted' as const, deliveries: [] } })
      .mockResolvedValueOnce({ ok: true as const, value: { messageId: brandString<BotGroupMessageId>('bot-group-message-repeat-two'), status: 'accepted' as const, deliveries: [] } })
    const client = sharedClient({
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [group] } }),
      inspectGroup: vi.fn().mockResolvedValue({ ok: true, value: { group, messages: [] } }),
      sendGroupMessage,
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByPlaceholderText('Message Repeat room')).toBeTruthy() })
    const input = screen.getByPlaceholderText('Message Repeat room')
    fireEvent.change(input, { target: { value: 'Repeat this note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to group' }))
    await waitFor(() => { expect(sendGroupMessage).toHaveBeenCalledOnce() })
    await waitFor(() => { expect((input as HTMLInputElement).value).toBe('') })

    fireEvent.change(input, { target: { value: 'Repeat this note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to group' }))
    await waitFor(() => { expect(sendGroupMessage).toHaveBeenCalledTimes(2) })
    expect(sendGroupMessage.mock.calls[0]?.[0].messageId).not.toBe(sendGroupMessage.mock.calls[1]?.[0].messageId)
  })

  it('assigns a fresh group id when the same create request is submitted again', async () => {
    const member = { id: BotId(bot.id), name: bot.name, identity: bot.identity, accent: bot.accent, state: 'active' as const, availability: 'idle' as const }
    const groupA = {
      id: brandString<BotGroupId>('bot-group-repeat-create-one'),
      name: 'Repeat create room',
      botIds: [BotId(bot.id), BotId(analystBot.id)],
      bots: [member, { ...member, id: BotId(analystBot.id), name: analystBot.name }],
      createdAt: 1,
      updatedAt: 1,
    } satisfies BotGroupView
    const groupB = { ...groupA, id: brandString<BotGroupId>('bot-group-repeat-create-two') }
    const createGroup = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: { group: groupA } })
      .mockResolvedValueOnce({ ok: true as const, value: { group: groupB } })
    const client = sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'owner' }, { ...analystBot, role: 'owner' }] } }),
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [] } }),
      inspectGroup: vi.fn().mockResolvedValue({ ok: true, value: { group: groupA, messages: [] } }),
      createGroup,
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    const submitCreate = async (): Promise<void> => {
      fireEvent.click(screen.getByRole('button', { name: 'Create shared group' }))
      const dialog = screen.getByRole('dialog', { name: 'Create a shared group' })
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Group name' }), { target: { value: 'Repeat create room' } })
      fireEvent.click(within(dialog).getByRole('checkbox', { name: bot.name }))
      fireEvent.click(within(dialog).getByRole('checkbox', { name: analystBot.name }))
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create shared group' }))
      await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Create a shared group' })).toBeNull() })
    }

    await waitFor(() => { expect(screen.getByRole('button', { name: 'Create shared group' })).toBeTruthy() })
    await submitCreate()
    await submitCreate()
    const firstRequest = createGroup.mock.calls[0]?.[0] as { readonly id?: string }
    const secondRequest = createGroup.mock.calls[1]?.[0] as { readonly id?: string }
    expect(firstRequest.id).not.toBe(secondRequest.id)
  })

  it('gates group actions until the pending catalog has loaded', async () => {
    const member = { id: BotId(bot.id), name: bot.name, identity: bot.identity, accent: bot.accent, state: 'active' as const, availability: 'idle' as const }
    const group = {
      id: brandString<BotGroupId>('bot-group-catalog-gate'),
      name: 'Catalog gate room',
      botIds: [BotId(bot.id), BotId(analystBot.id)],
      bots: [member, { ...member, id: BotId(analystBot.id), name: analystBot.name }],
      createdAt: 1,
      updatedAt: 1,
    } satisfies BotGroupView
    const catalogStarted = Promise.withResolvers<true>()
    const catalogRelease = Promise.withResolvers<undefined>()
    const originalRequest = navigator.locks.request.bind(navigator.locks)
    vi.spyOn(navigator.locks, 'request').mockImplementation((name, callback) => {
      if (name.endsWith('.catalog')) {
        catalogStarted.resolve(true)
        return catalogRelease.promise.then(callback)
      }
      return originalRequest(name, callback)
    })
    const client = sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'owner' }, { ...analystBot, role: 'owner' }] } }),
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [group] } }),
      inspectGroup: vi.fn().mockResolvedValue({ ok: true, value: { group, messages: [] } }),
      sendGroupMessage: vi.fn(),
      createGroup: vi.fn(),
    })
    try {
      render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)
      await catalogStarted.promise
      expect(screen.queryByPlaceholderText('Message Catalog gate room')).toBeNull()

      catalogRelease.resolve(undefined)
      await waitFor(() => { expect(screen.getByPlaceholderText('Message Catalog gate room')).toBeTruthy() })
      const input = screen.getByPlaceholderText('Message Catalog gate room')
      fireEvent.change(input, { target: { value: 'Catalog loaded' } })
      expect((screen.getByRole('button', { name: 'Send to group' }) as HTMLButtonElement).disabled).toBe(false)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('refuses to resend a recovered message owned by another principal', async () => {
    const group = {
      id: brandString<BotGroupId>('bot-group-message-owner-check'),
      name: 'Owner check room',
      botIds: [BotId(bot.id), BotId(analystBot.id)],
      bots: [
        { id: BotId(bot.id), name: bot.name, identity: bot.identity, accent: bot.accent, state: 'active' as const, availability: 'idle' as const },
        { id: BotId(analystBot.id), name: analystBot.name, identity: analystBot.identity, accent: analystBot.accent, state: 'active' as const, availability: 'idle' as const },
      ],
      createdAt: 1,
      updatedAt: 1,
    } satisfies BotGroupView
    const pendingText = 'Do not replay this message'
    const queue = createSharedGroupPendingQueue('principal-member')
    const pending = await queue.reserveMessage(`${group.id}\u0000${pendingText}`, String(group.id), pendingText)
    const sendGroupMessage = vi.fn()
    const client = sharedClient({
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [group] } }),
      inspectGroup: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          group,
          messages: [{
            id: brandString<BotGroupMessageId>(pending.id),
            groupId: group.id,
            sender: { kind: 'user' as const, principalId: BotPrincipalId('principal-other') },
            text: pendingText,
            createdAt: 2,
          }],
        },
      }),
      sendGroupMessage,
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Pending group messages')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Recover' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('does not match the current room details') })
    expect(sendGroupMessage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    const discardDialog = screen.getByRole('dialog', { name: 'Discard this retry record?' })
    fireEvent.click(within(discardDialog).getByRole('checkbox'))
    fireEvent.click(within(discardDialog).getByRole('button', { name: 'Discard retry record' }))
    await waitFor(() => { expect(screen.queryByText('Pending group messages')).toBeNull() })
    await expect(queue.listMessages()).resolves.toEqual([])
  })

  it('releases pending-message recovery when the collaborator switches groups', async () => {
    const member = { id: BotId(bot.id), name: bot.name, identity: bot.identity, accent: bot.accent, state: 'active' as const, availability: 'idle' as const }
    const groupA = {
      id: brandString<BotGroupId>('bot-group-recovery-alpha'),
      name: 'Recovery alpha',
      botIds: [BotId(bot.id), BotId(analystBot.id)],
      bots: [member, { ...member, id: BotId(analystBot.id), name: analystBot.name }],
      createdAt: 1,
      updatedAt: 1,
    } satisfies BotGroupView
    const groupB = { ...groupA, id: brandString<BotGroupId>('bot-group-recovery-beta'), name: 'Recovery beta' }
    const pendingText = 'Recover after switching'
    const queue = createSharedGroupPendingQueue('principal-member')
    await queue.reserveMessage(`${groupA.id}\u0000${pendingText}`, String(groupA.id), pendingText)
    const send = Promise.withResolvers<Awaited<ReturnType<NonNullable<SharedBotsClient['sendGroupMessage']>>>>()
    const sendGroupMessage = vi.fn().mockReturnValue(send.promise)
    const client = sharedClient({
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [groupA, groupB] } }),
      inspectGroup: vi.fn().mockImplementation(async (groupId: string) => ({
        ok: true,
        value: { group: groupId === groupA.id ? groupA : groupB, messages: [] },
      })),
      sendGroupMessage,
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Pending group messages')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Recover' }))
    await waitFor(() => { expect(sendGroupMessage).toHaveBeenCalledOnce() })
    fireEvent.click(screen.getByRole('button', { name: /Recovery beta/ }))
    await waitFor(() => { expect(screen.getByPlaceholderText('Message Recovery beta')).toBeTruthy() })
    expect(screen.getByRole('button', { name: 'Sending…' })).toHaveProperty('disabled', true)

    await act(async () => {
      send.resolve({ ok: true, value: { messageId: brandString<BotGroupMessageId>('bot-group-message-recovery'), status: 'accepted', deliveries: [] } })
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Recover' })).toHaveProperty('disabled', false) })
  })

  it('keeps a newer group send busy when an older group send resolves', async () => {
    const member = { id: BotId(bot.id), name: bot.name, identity: bot.identity, accent: bot.accent, state: 'active' as const, availability: 'idle' as const }
    const groupA = {
      id: brandString<BotGroupId>('bot-group-alpha'),
      name: 'Alpha room',
      botIds: [BotId(bot.id), BotId(analystBot.id)],
      bots: [member, { ...member, id: BotId(analystBot.id), name: analystBot.name }],
      createdAt: 1,
      updatedAt: 1,
    } satisfies BotGroupView
    const groupB = { ...groupA, id: brandString<BotGroupId>('bot-group-beta'), name: 'Beta room' } satisfies BotGroupView
    const firstSend = Promise.withResolvers<Awaited<ReturnType<NonNullable<SharedBotsClient['sendGroupMessage']>>>>()
    const secondSend = Promise.withResolvers<Awaited<ReturnType<NonNullable<SharedBotsClient['sendGroupMessage']>>>>()
    const sendGroupMessage = vi.fn()
      .mockReturnValueOnce(firstSend.promise)
      .mockReturnValueOnce(secondSend.promise)
    const client = sharedClient({
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [groupA, groupB] } }),
      inspectGroup: vi.fn().mockImplementation(async (groupId: string) => ({
        ok: true,
        value: { group: groupId === groupA.id ? groupA : groupB, messages: [] },
      })),
      sendGroupMessage,
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByPlaceholderText('Message Alpha room')).toBeTruthy() })
    fireEvent.change(screen.getByPlaceholderText('Message Alpha room'), { target: { value: 'Alpha update' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to group' }))
    await waitFor(() => { expect(sendGroupMessage).toHaveBeenCalledTimes(1) })

    fireEvent.click(screen.getByRole('button', { name: /Beta room/ }))
    await waitFor(() => { expect(screen.getByPlaceholderText('Message Beta room')).toBeTruthy() })
    fireEvent.change(screen.getByPlaceholderText('Message Beta room'), { target: { value: 'Beta update' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to group' }))
    await waitFor(() => { expect(sendGroupMessage).toHaveBeenCalledTimes(2) })

    await act(async () => {
      firstSend.resolve({ ok: true, value: { messageId: brandString<BotGroupMessageId>('bot-group-message-alpha'), status: 'accepted', deliveries: [] } })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect((screen.getByRole('button', { name: 'Sending…' }) as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      secondSend.resolve({ ok: true, value: { messageId: brandString<BotGroupMessageId>('bot-group-message-beta'), status: 'accepted', deliveries: [] } })
      await Promise.resolve()
      await Promise.resolve()
    })
  })

  it('does not refresh an old group send after switching away and back', async () => {
    const member = { id: BotId(bot.id), name: bot.name, identity: bot.identity, accent: bot.accent, state: 'active' as const, availability: 'idle' as const }
    const groupA = {
      id: brandString<BotGroupId>('bot-group-send-alpha'),
      name: 'Alpha room',
      botIds: [BotId(bot.id), BotId(analystBot.id)],
      bots: [member, { ...member, id: BotId(analystBot.id), name: analystBot.name }],
      createdAt: 1,
      updatedAt: 1,
    } satisfies BotGroupView
    const groupB = { ...groupA, id: brandString<BotGroupId>('bot-group-send-beta'), name: 'Beta room' } satisfies BotGroupView
    const send = Promise.withResolvers<Awaited<ReturnType<NonNullable<SharedBotsClient['sendGroupMessage']>>>>()
    let alphaReads = 0
    const inspectGroup = vi.fn().mockImplementation(async (groupId: string) => {
      if (groupId === groupA.id) {
        alphaReads += 1
        return {
          ok: true,
          value: {
            group: groupA,
            messages: [{
              id: brandString<BotGroupMessageId>(`bot-group-message-alpha-${alphaReads}`),
              groupId: groupA.id,
              sender: { kind: 'user' as const },
              text: alphaReads === 1 ? 'Alpha initial' : alphaReads === 2 ? 'Alpha current' : 'Alpha stale completion',
              createdAt: alphaReads,
            }],
          },
        }
      }
      return { ok: true, value: { group: groupB, messages: [] } }
    })
    const client = sharedClient({
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [groupA, groupB] } }),
      inspectGroup,
      sendGroupMessage: vi.fn().mockReturnValue(send.promise),
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Alpha initial')).toBeTruthy() })
    fireEvent.change(screen.getByPlaceholderText('Message Alpha room'), { target: { value: 'Alpha update' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to group' }))
    await waitFor(() => { expect(client.sendGroupMessage).toHaveBeenCalledOnce() })
    fireEvent.click(screen.getByRole('button', { name: /Beta room/ }))
    await waitFor(() => { expect(screen.getByPlaceholderText('Message Beta room')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: /Alpha room/ }))
    await waitFor(() => { expect(screen.getByText('Alpha current')).toBeTruthy() })

    await act(async () => {
      send.resolve({ ok: true, value: { messageId: brandString<BotGroupMessageId>('bot-group-message-alpha-send'), status: 'accepted', deliveries: [] } })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByText('Alpha current')).toBeTruthy()
    expect(screen.queryByText('Alpha stale completion')).toBeNull()
  })

  it('does not surface a stale group-send failure after switching away and back', async () => {
    const member = { id: BotId(bot.id), name: bot.name, identity: bot.identity, accent: bot.accent, state: 'active' as const, availability: 'idle' as const }
    const groupA = {
      id: brandString<BotGroupId>('bot-group-error-alpha'),
      name: 'Alpha room',
      botIds: [BotId(bot.id), BotId(analystBot.id)],
      bots: [member, { ...member, id: BotId(analystBot.id), name: analystBot.name }],
      createdAt: 1,
      updatedAt: 1,
    } satisfies BotGroupView
    const groupB = { ...groupA, id: brandString<BotGroupId>('bot-group-error-beta'), name: 'Beta room' } satisfies BotGroupView
    const send = Promise.withResolvers<Awaited<ReturnType<NonNullable<SharedBotsClient['sendGroupMessage']>>>>()
    const client = sharedClient({
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [groupA, groupB] } }),
      inspectGroup: vi.fn().mockImplementation(async (groupId: string) => ({
        ok: true,
        value: { group: groupId === groupA.id ? groupA : groupB, messages: [] },
      })),
      sendGroupMessage: vi.fn().mockReturnValue(send.promise),
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByPlaceholderText('Message Alpha room')).toBeTruthy() })
    fireEvent.change(screen.getByPlaceholderText('Message Alpha room'), { target: { value: 'Alpha update' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to group' }))
    await waitFor(() => { expect(client.sendGroupMessage).toHaveBeenCalledOnce() })
    fireEvent.click(screen.getByRole('button', { name: /Beta room/ }))
    await waitFor(() => { expect(screen.getByPlaceholderText('Message Beta room')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: /Alpha room/ }))
    await waitFor(() => { expect(screen.getByPlaceholderText('Message Alpha room')).toBeTruthy() })

    await act(async () => {
      send.resolve({ ok: false, error: { code: 'gateway/unavailable', message: 'stale failure', details: {} } })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.queryByText('stale failure')).toBeNull()
  })

  it('closes the collaborator shared-note confirmation when the dialog closes', async () => {
    const client = sharedClient()
    const view = render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByPlaceholderText('Add a note for the shared context')).toBeTruthy() })
    fireEvent.change(screen.getByPlaceholderText('Add a note for the shared context'), { target: { value: 'Keep private' } })
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    const confirmation = screen.getByRole('dialog', { name: 'Publish to shared context?' })
    fireEvent.click(within(confirmation).getByRole('checkbox', { name: /shared with every member/i }))

    view.rerender(<SharedBotsDialog client={client} open={false} onClose={vi.fn()} t={t} />)

    expect(screen.queryByRole('dialog', { name: 'Publish to shared context?' })).toBeNull()
  })

  it('ignores a pending read from a Bot after selecting another Bot', async () => {
    const latePrivate = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['readPrivateChat']>>>()
    const lateMemory = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['readMemory']>>>()
    const client = sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...analystBot, role: 'collaborator' }, { ...bot, role: 'collaborator' }] } }),
      readPrivateChat: vi.fn().mockImplementation((botId: string) => botId === bot.id
        ? latePrivate.promise
        : Promise.resolve({ ok: true, value: { botId, recent: [{ role: 'assistant', text: 'Analyst answer' }] } })),
      readMemory: vi.fn().mockImplementation((botId: string) => botId === bot.id
        ? lateMemory.promise
        : Promise.resolve({ ok: true, value: { botId: BotId(botId), enabled: true, updatedAt: 1, entries: [{ id: 'analyst-memory', principalId: 'principal-owner', text: 'Analyst decision', createdAt: 1 }] } })),
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Analyst answer')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(bot.name) }))
    await waitFor(() => { expect(client.readPrivateChat).toHaveBeenCalledWith(bot.id) })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(analystBot.name) }))
    await waitFor(() => { expect(screen.getByText('Analyst answer')).toBeTruthy() })

    await act(async () => {
      latePrivate.resolve({ ok: true, value: { botId: bot.id, recent: [{ role: 'assistant', text: 'Late Chief answer' }] } })
      lateMemory.resolve({ ok: true, value: { botId: BotId(bot.id), enabled: true, updatedAt: 2, entries: [{ id: BotShareMemoryId('late-chief-memory'), principalId: BotPrincipalId('principal-owner'), text: 'Late Chief decision', createdAt: 2 }] } })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.queryByText('Late Chief answer')).toBeNull()
    expect(screen.queryByText('Late Chief decision')).toBeNull()
    expect(screen.getByText('Analyst answer')).toBeTruthy()
    expect(screen.getByText('Analyst decision')).toBeTruthy()
  })

  it('ignores an old chat completion after switching away and back', async () => {
    const chat = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['chat']>>>()
    let chiefReads = 0
    const client = sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'collaborator' }, { ...analystBot, role: 'collaborator' }] } }),
      readPrivateChat: vi.fn().mockImplementation((botId: string) => {
        if (botId !== bot.id) return Promise.resolve({ ok: true, value: { botId, recent: [{ role: 'assistant', text: 'Analyst answer' }] } })
        chiefReads += 1
        return Promise.resolve({ ok: true, value: { botId, recent: [{ role: 'assistant', text: chiefReads === 1 ? 'Initial Chief answer' : chiefReads === 2 ? 'Current Chief answer' : 'Late old Chief answer' }] } })
      }),
      readMemory: vi.fn().mockImplementation((botId: string) => Promise.resolve({
        ok: true,
        value: { botId: BotId(botId), enabled: true, updatedAt: chiefReads, entries: [] },
      })),
      chat: vi.fn().mockReturnValue(chat.promise),
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Initial Chief answer')).toBeTruthy() })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message this shared bot' }), { target: { value: 'Follow up' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => { expect(client.chat).toHaveBeenCalledWith(bot.id, 'Follow up') })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(analystBot.name) }))
    await waitFor(() => { expect(screen.getByText('Analyst answer')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(bot.name) }))
    await waitFor(() => { expect(screen.getByText('Current Chief answer')).toBeTruthy() })

    await act(async () => {
      chat.resolve({ ok: true, value: { bot: { ...bot, id: BotId(bot.id), identity: bot.identity ?? 'agent', accent: bot.accent ?? 'amber', state: 'active', availability: 'idle' }, sessionId: 'shared-session-one', accepted: true } })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.queryByText('Late old Chief answer')).toBeNull()
    expect(screen.getByText('Current Chief answer')).toBeTruthy()
    expect(client.readPrivateChat).toHaveBeenCalledTimes(3)
  })

  it('ignores an old shared-note completion after switching away and back', async () => {
    const writeMemory = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['writeMemory']>>>()
    let chiefReads = 0
    const client = sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'collaborator' }, { ...analystBot, role: 'collaborator' }] } }),
      readPrivateChat: vi.fn().mockImplementation((botId: string) => Promise.resolve({ ok: true, value: { botId, recent: [{ role: 'assistant', text: botId === bot.id ? 'Chief answer' : 'Analyst answer' }] } })),
      readMemory: vi.fn().mockImplementation((botId: string) => {
        if (botId === bot.id) {
          chiefReads += 1
          return Promise.resolve({ ok: true, value: { botId: BotId(botId), enabled: true, updatedAt: chiefReads, entries: [{ id: `${chiefReads}`, principalId: BotPrincipalId('principal-owner'), text: chiefReads === 1 ? 'Initial Chief decision' : chiefReads === 2 ? 'Current Chief decision' : 'Late old Chief decision', createdAt: chiefReads }] } })
        }
        return Promise.resolve({ ok: true, value: { botId: BotId(botId), enabled: true, updatedAt: 1, entries: [{ id: 'analyst-memory', principalId: BotPrincipalId('principal-owner'), text: 'Analyst decision', createdAt: 1 }] } })
      }),
      writeMemory: vi.fn().mockReturnValue(writeMemory.promise),
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Initial Chief decision')).toBeTruthy() })
    fireEvent.change(screen.getByPlaceholderText('Add a note for the shared context'), { target: { value: 'Follow up note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    const confirmation = screen.getByRole('dialog', { name: 'Publish to shared context?' })
    fireEvent.click(within(confirmation).getByRole('checkbox', { name: /shared with every member/i }))
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Publish' }))
    await waitFor(() => { expect(client.writeMemory).toHaveBeenCalledWith(bot.id, 'Follow up note') })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(analystBot.name) }))
    await waitFor(() => { expect(screen.getByText('Analyst decision')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(bot.name) }))
    await waitFor(() => { expect(screen.getByText('Current Chief decision')).toBeTruthy() })

    await act(async () => {
      writeMemory.resolve({ ok: true, value: { entry: { id: BotShareMemoryId('memory-two'), principalId: BotPrincipalId('principal-member'), text: 'Follow up note', createdAt: 2 } } })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.queryByText('Late old Chief decision')).toBeNull()
    expect(screen.getByText('Current Chief decision')).toBeTruthy()
    expect(client.readMemory).toHaveBeenCalledTimes(3)
  })

  it('keeps another Bot chat usable while the first Bot chat is pending', async () => {
    const chiefChat = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['chat']>>>()
    const client = sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'collaborator' }, { ...analystBot, role: 'collaborator' }] } }),
      readPrivateChat: vi.fn().mockImplementation((botId: string) => Promise.resolve({
        ok: true,
        value: { botId, recent: [{ role: 'assistant', text: botId === bot.id ? 'Chief answer' : 'Analyst answer' }] },
      })),
      readMemory: vi.fn().mockImplementation((botId: string) => Promise.resolve({
        ok: true,
        value: { botId: BotId(botId), enabled: true, updatedAt: 1, entries: [] },
      })),
      chat: vi.fn().mockImplementation((botId: string) => botId === bot.id
        ? chiefChat.promise
        : Promise.resolve({ ok: true, value: { bot: analystBot, sessionId: 'analyst-session', accepted: true } })),
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Chief answer')).toBeTruthy() })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message this shared bot' }), { target: { value: 'Chief follow up' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => { expect(client.chat).toHaveBeenCalledWith(bot.id, 'Chief follow up') })

    fireEvent.click(screen.getByRole('button', { name: new RegExp(analystBot.name) }))
    await waitFor(() => { expect(screen.getByText('Analyst answer')).toBeTruthy() })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message this shared bot' }), { target: { value: 'Analyst follow up' } })

    await waitFor(() => { expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', false) })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => { expect(client.chat).toHaveBeenCalledWith(analystBot.id, 'Analyst follow up') })
  })

  it('does not let a stale chat completion clear a reopened Bot operation', async () => {
    const staleChat = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['chat']>>>()
    const currentChat = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['chat']>>>()
    const client = sharedClient({
      chat: vi.fn().mockReturnValueOnce(staleChat.promise).mockReturnValueOnce(currentChat.promise),
    })
    const view = render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Private answer')).toBeTruthy() })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message this shared bot' }), { target: { value: 'First request' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => { expect(client.chat).toHaveBeenCalledTimes(1) })

    view.rerender(<SharedBotsDialog client={client} open={false} onClose={vi.fn()} t={t} />)
    view.rerender(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)
    await waitFor(() => { expect(screen.getByText('Private answer')).toBeTruthy() })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message this shared bot' }), { target: { value: 'Second request' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => { expect(client.chat).toHaveBeenCalledTimes(2) })

    await act(async () => {
      staleChat.resolve({ ok: true, value: { bot: { ...bot, id: BotId(bot.id), identity: bot.identity ?? 'agent', accent: bot.accent ?? 'amber', state: 'active', availability: 'idle' }, sessionId: 'stale-session', accepted: true } })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByRole('textbox', { name: 'Message this shared bot' })).toHaveProperty('value', 'Second request')
    expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', true)

    await act(async () => {
      currentChat.resolve({ ok: true, value: { bot: { ...bot, id: BotId(bot.id), identity: bot.identity ?? 'agent', accent: bot.accent ?? 'amber', state: 'active', availability: 'idle' }, sessionId: 'current-session', accepted: true } })
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Message this shared bot' })).toHaveProperty('value', '')
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message this shared bot' }), { target: { value: 'After completion' } })
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', false) })
  })

  it('keeps another Bot shared-note publishing usable while the first Bot write is pending', async () => {
    const chiefWrite = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['writeMemory']>>>()
    const client = sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'collaborator' }, { ...analystBot, role: 'collaborator' }] } }),
      readPrivateChat: vi.fn().mockImplementation((botId: string) => Promise.resolve({
        ok: true,
        value: { botId, recent: [{ role: 'assistant', text: botId === bot.id ? 'Chief answer' : 'Analyst answer' }] },
      })),
      readMemory: vi.fn().mockImplementation((botId: string) => Promise.resolve({
        ok: true,
        value: { botId: BotId(botId), enabled: true, updatedAt: 1, entries: [] },
      })),
      writeMemory: vi.fn().mockImplementation((botId: string) => botId === bot.id
        ? chiefWrite.promise
        : Promise.resolve({ ok: true, value: { entry: { id: BotShareMemoryId('analyst-note'), principalId: BotPrincipalId('principal-member'), text: 'Analyst note', createdAt: 2 } } })),
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Chief answer')).toBeTruthy() })
    fireEvent.change(screen.getByPlaceholderText('Add a note for the shared context'), { target: { value: 'Chief note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    const chiefConfirmation = screen.getByRole('dialog', { name: 'Publish to shared context?' })
    fireEvent.click(within(chiefConfirmation).getByRole('checkbox', { name: /shared with every member/i }))
    fireEvent.click(within(chiefConfirmation).getByRole('button', { name: 'Publish' }))
    await waitFor(() => { expect(client.writeMemory).toHaveBeenCalledWith(bot.id, 'Chief note') })

    fireEvent.click(screen.getByRole('button', { name: new RegExp(analystBot.name) }))
    await waitFor(() => { expect(screen.getByText('Analyst answer')).toBeTruthy() })
    fireEvent.change(screen.getByPlaceholderText('Add a note for the shared context'), { target: { value: 'Analyst note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    const analystConfirmation = screen.getByRole('dialog', { name: 'Publish to shared context?' })
    fireEvent.click(within(analystConfirmation).getByRole('checkbox', { name: /shared with every member/i }))

    expect(within(analystConfirmation).getByRole('button', { name: 'Publish' })).toHaveProperty('disabled', false)
    fireEvent.click(within(analystConfirmation).getByRole('button', { name: 'Publish' }))
    await waitFor(() => { expect(client.writeMemory).toHaveBeenCalledWith(analystBot.id, 'Analyst note') })
  })

  it('keeps chat and shared-note drafts scoped to their selected Bot', async () => {
    const client = sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'collaborator' }, { ...analystBot, role: 'collaborator' }] } }),
      readPrivateChat: vi.fn().mockImplementation((botId: string) => Promise.resolve({
        ok: true,
        value: { botId, recent: [{ role: 'assistant', text: botId === bot.id ? 'Chief answer' : 'Analyst answer' }] },
      })),
      readMemory: vi.fn().mockImplementation((botId: string) => Promise.resolve({
        ok: true,
        value: { botId: BotId(botId), enabled: true, updatedAt: 1, entries: [] },
      })),
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Chief answer')).toBeTruthy() })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message this shared bot' }), { target: { value: 'Chief message' } })
    fireEvent.change(screen.getByPlaceholderText('Add a note for the shared context'), { target: { value: 'Chief note' } })

    fireEvent.click(screen.getByRole('button', { name: new RegExp(analystBot.name) }))
    await waitFor(() => { expect(screen.getByText('Analyst answer')).toBeTruthy() })
    expect(screen.getByRole('textbox', { name: 'Message this shared bot' })).toHaveProperty('value', '')
    expect(screen.getByPlaceholderText('Add a note for the shared context')).toHaveProperty('value', '')

    fireEvent.change(screen.getByRole('textbox', { name: 'Message this shared bot' }), { target: { value: 'Analyst message' } })
    fireEvent.change(screen.getByPlaceholderText('Add a note for the shared context'), { target: { value: 'Analyst note' } })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(bot.name) }))
    await waitFor(() => { expect(screen.getByText('Chief answer')).toBeTruthy() })
    expect(screen.getByRole('textbox', { name: 'Message this shared bot' })).toHaveProperty('value', 'Chief message')
    expect(screen.getByPlaceholderText('Add a note for the shared context')).toHaveProperty('value', 'Chief note')
  })

  it('does not refresh a sent Bot response after switching to another Bot', async () => {
    const chat = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['chat']>>>()
    const latePrivate = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['readPrivateChat']>>>()
    const lateMemory = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['readMemory']>>>()
    let chiefPrivateReads = 0
    let chiefMemoryReads = 0
    const client = sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'collaborator' }, { ...analystBot, role: 'collaborator' }] } }),
      readPrivateChat: vi.fn().mockImplementation((botId: string) => {
        if (botId === bot.id) {
          chiefPrivateReads++
          return chiefPrivateReads === 1
            ? Promise.resolve({ ok: true, value: { botId, recent: [{ role: 'assistant', text: 'Initial Chief answer' }] } })
            : latePrivate.promise
        }
        return Promise.resolve({ ok: true, value: { botId, recent: [{ role: 'assistant', text: 'Analyst answer' }] } })
      }),
      readMemory: vi.fn().mockImplementation((botId: string) => {
        if (botId === bot.id) {
          chiefMemoryReads++
          return chiefMemoryReads === 1
            ? Promise.resolve({ ok: true, value: { botId: BotId(botId), enabled: true, updatedAt: 1, entries: [{ id: BotShareMemoryId('initial-chief-memory'), principalId: 'principal-owner', text: 'Initial Chief decision', createdAt: 1 }] } })
            : lateMemory.promise
        }
        return Promise.resolve({ ok: true, value: { botId: BotId(botId), enabled: true, updatedAt: 1, entries: [{ id: BotShareMemoryId('analyst-memory'), principalId: 'principal-owner', text: 'Analyst decision', createdAt: 1 }] } })
      }),
      chat: vi.fn().mockReturnValue(chat.promise),
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Initial Chief answer')).toBeTruthy() })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message this shared bot' }), { target: { value: 'Follow up' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => { expect(client.chat).toHaveBeenCalledWith(bot.id, 'Follow up') })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(analystBot.name) }))
    await waitFor(() => { expect(screen.getByText('Analyst answer')).toBeTruthy() })

    await act(async () => {
      chat.resolve({ ok: true, value: { bot: { ...bot, id: BotId(bot.id), identity: bot.identity ?? 'agent', accent: bot.accent ?? 'amber', state: 'active', availability: 'idle' }, sessionId: 'shared-session-one', accepted: true } })
      await Promise.resolve()
      latePrivate.resolve({ ok: true, value: { botId: bot.id, recent: [{ role: 'assistant', text: 'Late sent Chief answer' }] } })
      lateMemory.resolve({ ok: true, value: { botId: BotId(bot.id), enabled: true, updatedAt: 2, entries: [{ id: BotShareMemoryId('late-sent-chief-memory'), principalId: BotPrincipalId('principal-owner'), text: 'Late sent Chief decision', createdAt: 2 }] } })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.queryByText('Late sent Chief answer')).toBeNull()
    expect(screen.queryByText('Late sent Chief decision')).toBeNull()
    expect(screen.getByText('Analyst answer')).toBeTruthy()
    expect(screen.getByText('Analyst decision')).toBeTruthy()
  })

  it('clears a sent Bot chat draft after completion while another Bot is selected', async () => {
    const chat = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['chat']>>>()
    const client = sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'collaborator' }, { ...analystBot, role: 'collaborator' }] } }),
      readPrivateChat: vi.fn().mockImplementation((botId: string) => Promise.resolve({
        ok: true,
        value: { botId, recent: [{ role: 'assistant', text: botId === bot.id ? 'Chief answer' : 'Analyst answer' }] },
      })),
      readMemory: vi.fn().mockImplementation((botId: string) => Promise.resolve({
        ok: true,
        value: { botId: BotId(botId), enabled: true, updatedAt: 1, entries: [] },
      })),
      chat: vi.fn().mockReturnValue(chat.promise),
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Chief answer')).toBeTruthy() })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message this shared bot' }), { target: { value: 'Chief follow up' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => { expect(client.chat).toHaveBeenCalledWith(bot.id, 'Chief follow up') })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(analystBot.name) }))
    await waitFor(() => { expect(screen.getByText('Analyst answer')).toBeTruthy() })

    await act(async () => {
      chat.resolve({ ok: true, value: { bot: { ...bot, id: BotId(bot.id), identity: bot.identity ?? 'agent', accent: bot.accent ?? 'amber', state: 'active', availability: 'idle' }, sessionId: 'shared-session-one', accepted: true } })
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: new RegExp(bot.name) }))
    await waitFor(() => { expect(screen.getByText('Chief answer')).toBeTruthy() })
    expect(screen.getByRole('textbox', { name: 'Message this shared bot' })).toHaveProperty('value', '')
  })

  it('preserves a newer Bot draft while a sent chat completes off selection', async () => {
    const chat = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['chat']>>>()
    const client = sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'collaborator' }, { ...analystBot, role: 'collaborator' }] } }),
      readPrivateChat: vi.fn().mockImplementation((botId: string) => Promise.resolve({
        ok: true,
        value: { botId, recent: [{ role: 'assistant', text: botId === bot.id ? 'Chief answer' : 'Analyst answer' }] },
      })),
      readMemory: vi.fn().mockImplementation((botId: string) => Promise.resolve({
        ok: true,
        value: { botId: BotId(botId), enabled: true, updatedAt: 1, entries: [] },
      })),
      chat: vi.fn().mockReturnValue(chat.promise),
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Chief answer')).toBeTruthy() })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message this shared bot' }), { target: { value: 'Chief follow up' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => { expect(client.chat).toHaveBeenCalledWith(bot.id, 'Chief follow up') })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(analystBot.name) }))
    await waitFor(() => { expect(screen.getByText('Analyst answer')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(bot.name) }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Message this shared bot' }), { target: { value: 'New Chief draft' } })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(analystBot.name) }))
    await waitFor(() => { expect(screen.getByText('Analyst answer')).toBeTruthy() })

    await act(async () => {
      chat.resolve({ ok: true, value: { bot: { ...bot, id: BotId(bot.id), identity: bot.identity ?? 'agent', accent: bot.accent ?? 'amber', state: 'active', availability: 'idle' }, sessionId: 'shared-session-one', accepted: true } })
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: new RegExp(bot.name) }))
    await waitFor(() => { expect(screen.getByText('Chief answer')).toBeTruthy() })
    expect(screen.getByRole('textbox', { name: 'Message this shared bot' })).toHaveProperty('value', 'New Chief draft')
  })

  it('clears a sent Bot note draft after completion while another Bot is selected', async () => {
    const writeMemory = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['writeMemory']>>>()
    const client = sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'collaborator' }, { ...analystBot, role: 'collaborator' }] } }),
      readPrivateChat: vi.fn().mockImplementation((botId: string) => Promise.resolve({
        ok: true,
        value: { botId, recent: [{ role: 'assistant', text: botId === bot.id ? 'Chief answer' : 'Analyst answer' }] },
      })),
      readMemory: vi.fn().mockImplementation((botId: string) => Promise.resolve({
        ok: true,
        value: { botId: BotId(botId), enabled: true, updatedAt: 1, entries: [{ id: BotShareMemoryId(`${botId}-memory`), principalId: BotPrincipalId('principal-owner'), text: botId === bot.id ? 'Chief decision' : 'Analyst decision', createdAt: 1 }] },
      })),
      writeMemory: vi.fn().mockReturnValue(writeMemory.promise),
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Chief decision')).toBeTruthy() })
    fireEvent.change(screen.getByPlaceholderText('Add a note for the shared context'), { target: { value: 'Chief note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    const confirmation = screen.getByRole('dialog', { name: 'Publish to shared context?' })
    fireEvent.click(within(confirmation).getByRole('checkbox', { name: /shared with every member/i }))
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Publish' }))
    await waitFor(() => { expect(client.writeMemory).toHaveBeenCalledWith(bot.id, 'Chief note') })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(analystBot.name) }))
    await waitFor(() => { expect(screen.getByText('Analyst decision')).toBeTruthy() })

    await act(async () => {
      writeMemory.resolve({ ok: true, value: { entry: { id: BotShareMemoryId('memory-two'), principalId: BotPrincipalId('principal-member'), text: 'Chief note', createdAt: 2 } } })
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: new RegExp(bot.name) }))
    await waitFor(() => { expect(screen.getByText('Chief decision')).toBeTruthy() })
    expect(screen.getByPlaceholderText('Add a note for the shared context')).toHaveProperty('value', '')
  })

  it('preserves a newer Bot draft while a shared note completes off selection', async () => {
    const writeMemory = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['writeMemory']>>>()
    const client = sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'collaborator' }, { ...analystBot, role: 'collaborator' }] } }),
      readPrivateChat: vi.fn().mockImplementation((botId: string) => Promise.resolve({
        ok: true,
        value: { botId, recent: [{ role: 'assistant', text: botId === bot.id ? 'Chief answer' : 'Analyst answer' }] },
      })),
      readMemory: vi.fn().mockImplementation((botId: string) => Promise.resolve({
        ok: true,
        value: { botId: BotId(botId), enabled: true, updatedAt: 1, entries: [{ id: BotShareMemoryId(`${botId}-memory`), principalId: BotPrincipalId('principal-owner'), text: botId === bot.id ? 'Chief decision' : 'Analyst decision', createdAt: 1 }] },
      })),
      writeMemory: vi.fn().mockReturnValue(writeMemory.promise),
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Chief decision')).toBeTruthy() })
    fireEvent.change(screen.getByPlaceholderText('Add a note for the shared context'), { target: { value: 'Chief note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    const confirmation = screen.getByRole('dialog', { name: 'Publish to shared context?' })
    fireEvent.click(within(confirmation).getByRole('checkbox', { name: /shared with every member/i }))
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Publish' }))
    await waitFor(() => { expect(client.writeMemory).toHaveBeenCalledWith(bot.id, 'Chief note') })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(analystBot.name) }))
    await waitFor(() => { expect(screen.getByText('Analyst decision')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(bot.name) }))
    await waitFor(() => { expect(screen.getByText('Chief decision')).toBeTruthy() })
    fireEvent.change(screen.getByPlaceholderText('Add a note for the shared context'), { target: { value: 'New Chief note' } })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(analystBot.name) }))
    await waitFor(() => { expect(screen.getByText('Analyst decision')).toBeTruthy() })

    await act(async () => {
      writeMemory.resolve({ ok: true, value: { entry: { id: BotShareMemoryId('memory-two'), principalId: BotPrincipalId('principal-member'), text: 'Chief note', createdAt: 2 } } })
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: new RegExp(bot.name) }))
    await waitFor(() => { expect(screen.getByText('Chief decision')).toBeTruthy() })
    expect(screen.getByPlaceholderText('Add a note for the shared context')).toHaveProperty('value', 'New Chief note')
  })

  it('preserves a newer Bot selection when enrollment refresh returns late', async () => {
    const enroll = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['enroll']>>>()
    const delayedRefresh = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['list']>>>()
    let listCalls = 0
    const client = sharedClient({
      list: vi.fn().mockImplementation(() => {
        listCalls++
        return listCalls === 1
          ? Promise.resolve({ ok: true, value: { bots: [{ ...bot, role: 'collaborator' }, { ...analystBot, role: 'collaborator' }] } })
          : delayedRefresh.promise
      }),
      enroll: vi.fn().mockReturnValue(enroll.promise),
      readPrivateChat: vi.fn().mockImplementation((botId: string) => Promise.resolve({
        ok: true,
        value: { botId, recent: [{ role: 'assistant', text: botId === bot.id ? 'Chief answer' : 'Analyst answer' }] },
      })),
      readMemory: vi.fn().mockImplementation((botId: string) => Promise.resolve({
        ok: true,
        value: {
          botId: BotId(botId),
          enabled: true,
          updatedAt: 1,
          entries: [{ id: BotShareMemoryId(`${botId}-memory`), principalId: BotPrincipalId('principal-owner'), text: botId === bot.id ? 'Chief decision' : 'Analyst decision', createdAt: 1 }],
        },
      })),
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Chief answer')).toBeTruthy() })
    fireEvent.change(screen.getByRole('textbox', { name: 'Invite code' }), { target: { value: 'invite' } })
    fireEvent.click(screen.getByRole('button', { name: 'Join bot' }))
    await waitFor(() => { expect(client.enroll).toHaveBeenCalledWith('invite') })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(analystBot.name) }))
    await waitFor(() => { expect(screen.getByText('Analyst answer')).toBeTruthy() })

    await act(async () => {
      enroll.resolve({ ok: true, value: { principalId: 'principal-member', expiresAt: 2_000 } })
      await Promise.resolve()
    })
    await waitFor(() => { expect(client.list).toHaveBeenCalledTimes(2) })
    await act(async () => {
      delayedRefresh.resolve({ ok: true, value: { bots: [
        { ...bot, id: BotId(bot.id), identity: bot.identity ?? 'agent', accent: bot.accent ?? 'amber', state: 'active', availability: 'idle', role: 'collaborator' },
        { ...analystBot, id: BotId(analystBot.id), identity: analystBot.identity ?? 'agent', accent: analystBot.accent ?? 'amber', state: 'active', availability: 'idle', role: 'collaborator' },
      ] } })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByRole('region', { name: analystBot.name })).toBeTruthy()
    expect(screen.getByText('Analyst answer')).toBeTruthy()
    expect(screen.queryByText('Chief answer')).toBeNull()
    expect(screen.getByText('Analyst decision')).toBeTruthy()
    expect(screen.queryByText('Chief decision')).toBeNull()
  })

  it('ignores a private response from a replaced shared client', async () => {
    const stalePrivate = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['readPrivateChat']>>>()
    const staleMemory = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['readMemory']>>>()
    const firstClient = sharedClient({
      readPrivateChat: vi.fn().mockReturnValue(stalePrivate.promise),
      readMemory: vi.fn().mockReturnValue(staleMemory.promise),
    })
    const secondClient = sharedClient({ retryScope: 'principal-other' })
    const view = render(<SharedBotsDialog client={firstClient} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(firstClient.readPrivateChat).toHaveBeenCalledWith(bot.id) })
    view.rerender(<SharedBotsDialog client={secondClient} open onClose={vi.fn()} t={t} />)

    await act(async () => {
      stalePrivate.resolve({ ok: true, value: { botId: bot.id, recent: [{ role: 'assistant', text: 'Old principal answer' }] } })
      staleMemory.resolve({ ok: true, value: { botId: BotId(bot.id), enabled: true, updatedAt: 1, entries: [] } })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.queryByText('Old principal answer')).toBeNull()
  })

  it('does not complete a chat after the authenticated principal rotates', async () => {
    let scope = 'principal-member'
    const chat = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['chat']>>>()
    const client = sharedClient({ chat: vi.fn().mockReturnValue(chat.promise) })
    Object.defineProperty(client, 'retryScope', { configurable: true, get: () => scope })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Private answer')).toBeTruthy() })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message this shared bot' }), { target: { value: 'old principal message' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => { expect(client.chat).toHaveBeenCalledWith(bot.id, 'old principal message') })
    scope = 'principal-other'

    await act(async () => {
      chat.resolve({ ok: true, value: { bot: { ...bot, id: BotId(bot.id), identity: bot.identity ?? 'agent', accent: bot.accent ?? 'amber', state: 'active', availability: 'idle' }, sessionId: 'old-session', accepted: true } })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.queryByRole('textbox', { name: 'Message this shared bot' })).toBeNull()
    expect(client.readPrivateChat).toHaveBeenCalledTimes(1)
  })

  it('ignores a chat response from a replaced shared client', async () => {
    const staleChat = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['chat']>>>()
    const firstClient = sharedClient({ chat: vi.fn().mockReturnValue(staleChat.promise) })
    const secondClient = sharedClient({ retryScope: 'principal-other' })
    const view = render(<SharedBotsDialog client={firstClient} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Private answer')).toBeTruthy() })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message this shared bot' }), { target: { value: 'Old client message' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => { expect(firstClient.chat).toHaveBeenCalledWith(bot.id, 'Old client message') })
    view.rerender(<SharedBotsDialog client={secondClient} open onClose={vi.fn()} t={t} />)

    await act(async () => {
      staleChat.resolve({ ok: true, value: { bot: { ...bot, id: BotId(bot.id), identity: bot.identity ?? 'agent', accent: bot.accent ?? 'amber', state: 'active', availability: 'idle' }, sessionId: 'old-client-session', accepted: true } })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(secondClient.readPrivateChat).toHaveBeenCalled()
    expect(firstClient.readPrivateChat).toHaveBeenCalledOnce()
  })

  it('clears private data when the shared client reports an account change', async () => {
    let notify: (() => void) | undefined
    let scope = 'principal-member'
    const client = Object.assign(sharedClient(), {
      subscribeAuth: (listener: () => void) => {
        notify = listener
        return () => { notify = undefined }
      },
    })
    Object.defineProperty(client, 'retryScope', { configurable: true, get: () => scope })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Private answer')).toBeTruthy() })
    scope = 'principal-other'
    expect(notify).toBeDefined()
    await act(async () => {
      notify?.()
      await Promise.resolve()
    })

    expect(screen.queryByText('Private answer')).toBeNull()
    expect(screen.queryByRole('region', { name: bot.name })).toBeNull()
  })

  it('clears stale data and enrollment work when an account change rejects enrollment', async () => {
    let notify: (() => void) | undefined
    let scope: string | undefined = 'principal-member'
    const enroll = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['enroll']>>>()
    const client = Object.assign(sharedClient({ enroll: vi.fn().mockReturnValue(enroll.promise) }), {
      subscribeAuth: (listener: () => void) => {
        notify = listener
        return () => { notify = undefined }
      },
    })
    Object.defineProperty(client, 'retryScope', { configurable: true, get: () => scope })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Private answer')).toBeTruthy() })
    fireEvent.change(screen.getByRole('textbox', { name: 'Invite code' }), { target: { value: 'expired-code' } })
    fireEvent.click(screen.getByRole('button', { name: 'Join bot' }))
    await waitFor(() => { expect(client.enroll).toHaveBeenCalledWith('expired-code') })

    scope = undefined
    await act(async () => {
      notify?.()
      await Promise.resolve()
    })
    expect(screen.queryByText('Private answer')).toBeNull()
    expect(screen.queryByText('Joining…')).toBeNull()

    await act(async () => {
      enroll.resolve({ ok: false, error: { code: 'gateway/unauthorized', message: 'session expired', details: {} } })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.queryByText('Private answer')).toBeNull()
    expect(screen.queryByText('Joining…')).toBeNull()
  })

  it('does not allow a second enrollment while the first request is still settling', async () => {
    let notify: (() => void) | undefined
    let scope: string | undefined = 'principal-member'
    const firstEnroll = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['enroll']>>>()
    const client = Object.assign(sharedClient({ enroll: vi.fn().mockReturnValue(firstEnroll.promise) }), {
      subscribeAuth: (listener: () => void) => {
        notify = listener
        return () => { notify = undefined }
      },
    })
    Object.defineProperty(client, 'retryScope', { configurable: true, get: () => scope })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Private answer')).toBeTruthy() })
    fireEvent.change(screen.getByRole('textbox', { name: 'Invite code' }), { target: { value: 'first-code' } })
    fireEvent.click(screen.getByRole('button', { name: 'Join bot' }))
    await waitFor(() => { expect(client.enroll).toHaveBeenCalledWith('first-code') })

    scope = undefined
    await act(async () => {
      notify?.()
      await Promise.resolve()
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Invite code' }), { target: { value: 'second-code' } })
    fireEvent.click(screen.getByRole('button', { name: 'Join bot' }))
    expect(client.enroll).toHaveBeenCalledOnce()

    await act(async () => {
      firstEnroll.resolve({ ok: false, error: { code: 'gateway/unauthorized', message: 'expired', details: {} } })
      await Promise.resolve()
      await Promise.resolve()
    })
  })

  it('closes the shared-group create dialog when the authenticated principal changes', async () => {
    let notify: (() => void) | undefined
    let scope: string | undefined = 'principal-member'
    const client = Object.assign(sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'owner' }, { ...analystBot, role: 'owner' }] } }),
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [] } }),
      createGroup: vi.fn(),
    }), {
      subscribeAuth: (listener: () => void) => {
        notify = listener
        return () => { notify = undefined }
      },
    })
    Object.defineProperty(client, 'retryScope', { configurable: true, get: () => scope })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByRole('button', { name: 'Create shared group' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Create shared group' }))
    expect(screen.getByRole('dialog', { name: 'Create a shared group' })).toBeTruthy()
    scope = undefined
    await act(async () => {
      notify?.()
      await Promise.resolve()
    })
    expect(screen.queryByRole('dialog', { name: 'Create a shared group' })).toBeNull()
  })

  it('revalidates shared content when the browser tab regains focus', async () => {
    let listCalls = 0
    const client = sharedClient({
      list: vi.fn().mockImplementation(async () => {
        listCalls += 1
        return listCalls === 1
          ? { ok: true as const, value: { bots: [{ ...bot, role: 'collaborator' }] } }
          : { ok: true as const, value: { bots: [] } }
      }),
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Private answer')).toBeTruthy() })
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => { expect(client.restoreRetryScope).toHaveBeenCalledTimes(2) })
    await waitFor(() => { expect(client.list).toHaveBeenCalledTimes(2) })
    expect(screen.queryByText('Private answer')).toBeNull()
  })

  it('refreshes shared content after a remote auth invalidation', async () => {
    let notify: ((change: SharedBotAuthChange) => void) | undefined
    let scope: string | undefined = 'principal-member'
    let listCalls = 0
    const client = sharedClient({
      list: vi.fn().mockImplementation(async () => {
        listCalls += 1
        return listCalls === 1
          ? { ok: true as const, value: { bots: [{ ...bot, role: 'collaborator' }] } }
          : { ok: true as const, value: { bots: [] } }
      }),
      restoreRetryScope: vi.fn().mockImplementation(async () => {
        scope = 'principal-member'
        return { ok: true as const, value: { principalId: 'principal-member', expiresAt: 2_000 } }
      }),
    })
    Object.defineProperty(client, 'subscribeAuth', {
      configurable: true,
      value: (listener: (change?: SharedBotAuthChange) => void) => {
        notify = listener
        return () => { notify = undefined }
      },
    })
    Object.defineProperty(client, 'retryScope', { configurable: true, get: () => scope })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Private answer')).toBeTruthy() })
    scope = undefined
    await act(async () => {
      notify?.({ source: 'remote', reason: 'invalidated' })
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => { expect(client.restoreRetryScope).toHaveBeenCalledTimes(2) })
    await waitFor(() => { expect(client.list).toHaveBeenCalledTimes(2) })
    expect(screen.queryByText('Private answer')).toBeNull()
  })

  it('bounds two-page revalidation when session restoration is unauthorized', async () => {
    type Listener = (event: { readonly data: unknown }) => void
    class TwoPageBroadcastChannel {
      static readonly peers = new Set<TwoPageBroadcastChannel>()
      readonly listeners = new Set<Listener>()

      constructor(readonly name: string) {
        TwoPageBroadcastChannel.peers.add(this)
      }

      addEventListener(_type: 'message', listener: Listener): void {
        this.listeners.add(listener)
      }

      removeEventListener(_type: 'message', listener: Listener): void {
        this.listeners.delete(listener)
      }

      postMessage(data: unknown): void {
        for (const peer of [...TwoPageBroadcastChannel.peers]) {
          if (peer === this || peer.name !== this.name) continue
          queueMicrotask(() => {
            for (const listener of [...peer.listeners]) listener({ data })
          })
        }
      }

      close(): void {
        TwoPageBroadcastChannel.peers.delete(this)
        this.listeners.clear()
      }
    }
    let firstSessionCalls = 0
    let secondSessionCalls = 0
    const makeRpc = (which: 'first' | 'second'): ClientConnectionRpc => ({
      call: vi.fn(async (_channel, endpoint) => {
        if (endpoint === 'bots/share/session') {
          const calls = which === 'first' ? ++firstSessionCalls : ++secondSessionCalls
          return calls <= 2
            ? { ok: false as const, error: { code: 'gateway/unauthorized', message: 'session expired', details: {} } }
            : { ok: true as const, value: { principalId: `principal-${which}`, expiresAt: 3_000 } }
        }
        if (endpoint === 'bots/share/list') return { ok: true as const, value: { bots: [] } }
        if (endpoint === 'bots/share/list-groups') return { ok: true as const, value: { groups: [] } }
        return { ok: true as const, value: {} }
      }),
    })
    vi.stubGlobal('BroadcastChannel', TwoPageBroadcastChannel)
    try {
      const firstClient = createSharedBotsClient(makeRpc('first'))
      const secondClient = createSharedBotsClient(makeRpc('second'))
      render(
        <>
          <SharedBotsDialog client={firstClient} open onClose={vi.fn()} t={t} />
          <SharedBotsDialog client={secondClient} open onClose={vi.fn()} t={t} />
        </>,
      )
      await waitFor(() => {
        expect(firstSessionCalls).toBeGreaterThan(0)
        expect(secondSessionCalls).toBeGreaterThan(0)
      })
      await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
      expect(firstSessionCalls).toBe(1)
      expect(secondSessionCalls).toBe(1)
    } finally {
      vi.unstubAllGlobals()
      TwoPageBroadcastChannel.peers.clear()
    }
  })

  it('does not apply a group send after the authenticated principal rotates', async () => {
    const member = { id: BotId(bot.id), name: bot.name, identity: bot.identity, accent: bot.accent, state: 'active' as const, availability: 'idle' as const }
    const group = {
      id: brandString<BotGroupId>('bot-group-auth-race'),
      name: 'Auth race room',
      botIds: [BotId(bot.id), BotId(analystBot.id)],
      bots: [member, { ...member, id: BotId(analystBot.id), name: analystBot.name }],
      createdAt: 1,
      updatedAt: 1,
    } satisfies BotGroupView
    const send = Promise.withResolvers<Awaited<ReturnType<NonNullable<SharedBotsClient['sendGroupMessage']>>>>()
    const inspectGroup = vi.fn().mockResolvedValue({ ok: true, value: { group, messages: [] } })
    let scope = 'principal-member'
    const client = sharedClient({
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [group] } }),
      inspectGroup,
      sendGroupMessage: vi.fn().mockReturnValue(send.promise),
    })
    Object.defineProperty(client, 'retryScope', { configurable: true, get: () => scope })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByPlaceholderText('Message Auth race room')).toBeTruthy() })
    fireEvent.change(screen.getByPlaceholderText('Message Auth race room'), { target: { value: 'old principal group message' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to group' }))
    await waitFor(() => { expect(client.sendGroupMessage).toHaveBeenCalledOnce() })
    scope = 'principal-other'

    await act(async () => {
      send.resolve({ ok: true, value: { messageId: brandString<BotGroupMessageId>('bot-group-message-auth-race'), status: 'accepted', deliveries: [] } })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(inspectGroup).toHaveBeenCalledOnce()
    expect(screen.queryByText('old principal group message')).toBeNull()
  })

  it('restores the server-issued retry scope before refreshing a reloaded roster', async () => {
    const restoreRetryScope = vi.fn().mockResolvedValue({ ok: true, value: { principalId: 'principal-restored', expiresAt: 2_000 } })
    const list = vi.fn().mockResolvedValue({ ok: true, value: { bots: [] } })
    const client = sharedClient({ retryScope: undefined, restoreRetryScope, list })
    let scope: string | undefined
    restoreRetryScope.mockImplementation(async () => {
      scope = 'principal-restored'
      return { ok: true as const, value: { principalId: scope, expiresAt: 2_000 } }
    })
    Object.defineProperty(client, 'retryScope', { configurable: true, get: () => scope })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(restoreRetryScope).toHaveBeenCalledOnce() })
    await waitFor(() => { expect(list).toHaveBeenCalledOnce() })
    expect(restoreRetryScope.mock.invocationCallOrder[0]).toBeLessThan(list.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY)
  })

  it('revalidates the retry scope on every refresh before showing pending records', async () => {
    let scope = 'principal-old'
    const queue = createSharedGroupPendingQueue(scope)
    await queue.reserveCreation('old-operation', 'Old principal room', [bot.id, analystBot.id])
    const restoreRetryScope = vi.fn().mockImplementation(async () => {
      scope = 'principal-new'
      return { ok: true as const, value: { principalId: scope, expiresAt: 3_000 } }
    })
    const client = sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'owner' }, { ...analystBot, role: 'owner' }] } }),
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [] } }),
      createGroup: vi.fn(),
      restoreRetryScope,
    })
    Object.defineProperty(client, 'retryScope', { configurable: true, get: () => scope })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(restoreRetryScope).toHaveBeenCalledOnce() })
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Create shared group' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Create shared group' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a shared group' })
    await waitFor(() => { expect(within(dialog).queryByText(/Old principal room/)).toBeNull() })
  })

  it('ignores a stale refresh after closing and reopening the dialog', async () => {
    const staleList = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['list']>>>()
    const currentList = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['list']>>>()
    let listCalls = 0
    const client = sharedClient({
      list: vi.fn().mockImplementation(() => {
        listCalls++
        return listCalls === 1 ? staleList.promise : currentList.promise
      }),
      readPrivateChat: vi.fn().mockImplementation((botId: string) => Promise.resolve({
        ok: true,
        value: { botId, recent: [{ role: 'assistant', text: botId === bot.id ? 'Stale Chief answer' : 'Current Analyst answer' }] },
      })),
      readMemory: vi.fn().mockImplementation((botId: string) => Promise.resolve({
        ok: true,
        value: {
          botId: BotId(botId),
          enabled: true,
          updatedAt: 1,
          entries: [{ id: BotShareMemoryId(`${botId}-memory`), principalId: BotPrincipalId('principal-owner'), text: botId === bot.id ? 'Stale Chief decision' : 'Current Analyst decision', createdAt: 1 }],
        },
      })),
    })
    const view = render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(client.list).toHaveBeenCalledTimes(1) })
    view.rerender(<SharedBotsDialog client={client} open={false} onClose={vi.fn()} t={t} />)
    view.rerender(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)
    await waitFor(() => { expect(client.list).toHaveBeenCalledTimes(2) })

    await act(async () => {
      staleList.resolve({ ok: true, value: { bots: [{ ...bot, id: BotId(bot.id), identity: bot.identity ?? 'agent', accent: bot.accent ?? 'amber', state: 'active', availability: 'idle', role: 'collaborator' }] } })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.queryByText('Stale Chief answer')).toBeNull()
    expect(screen.queryByText('Stale Chief decision')).toBeNull()

    await act(async () => {
      currentList.resolve({ ok: true, value: { bots: [{ ...analystBot, id: BotId(analystBot.id), identity: analystBot.identity ?? 'agent', accent: analystBot.accent ?? 'amber', state: 'active', availability: 'idle', role: 'collaborator' }] } })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByRole('region', { name: analystBot.name })).toBeTruthy()
    expect(screen.getByText('Current Analyst answer')).toBeTruthy()
    expect(screen.getByText('Current Analyst decision')).toBeTruthy()
    expect(screen.queryByText('Stale Chief answer')).toBeNull()
  })

  it('does not let a late restore failure clear a newer refresh', async () => {
    const firstRestore = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['restoreRetryScope']>>>()
    const secondRestore = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['restoreRetryScope']>>>()
    let restoreCalls = 0
    let scope: string | undefined
    const restoreRetryScope = vi.fn().mockImplementation(() => {
      restoreCalls += 1
      return restoreCalls === 1 ? firstRestore.promise : secondRestore.promise
    })
    const client = sharedClient({
      retryScope: undefined,
      restoreRetryScope,
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [] } }),
    })
    Object.defineProperty(client, 'retryScope', { configurable: true, get: () => scope })
    const view = render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(restoreRetryScope).toHaveBeenCalledOnce() })
    view.rerender(<SharedBotsDialog client={client} open={false} onClose={vi.fn()} t={t} />)
    view.rerender(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)
    await waitFor(() => { expect(restoreRetryScope).toHaveBeenCalledTimes(2) })

    await act(async () => {
      firstRestore.resolve({ ok: false, error: { code: 'gateway/transport', message: 'stale restore', details: {} } })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.queryByText('stale restore')).toBeNull()

    await act(async () => {
      scope = 'principal-new'
      secondRestore.resolve({ ok: true, value: { principalId: scope, expiresAt: 3_000 } })
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitFor(() => { expect(client.list).toHaveBeenCalledOnce() })
  })

  it('does not apply a stale roster failure after an account changes', async () => {
    const staleList = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['list']>>>()
    let notify: (() => void) | undefined
    let scope: string | undefined = 'principal-member'
    const client = Object.assign(sharedClient({ list: vi.fn().mockReturnValue(staleList.promise) }), {
      subscribeAuth: (listener: () => void) => {
        notify = listener
        return () => { notify = undefined }
      },
    })
    Object.defineProperty(client, 'retryScope', { configurable: true, get: () => scope })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(client.list).toHaveBeenCalledOnce() })
    scope = 'principal-other'
    await act(async () => {
      notify?.()
      await Promise.resolve()
    })
    await act(async () => {
      staleList.reject(new Error('stale roster'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.queryByText('stale roster')).toBeNull()
  })

  it('shows a refresh rejection without leaving the roster stuck loading', async () => {
    const client = sharedClient({ list: vi.fn().mockRejectedValue(new Error('Roster unavailable')) })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('Roster unavailable') })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows a read rejection without leaving an unhandled promise', async () => {
    const client = sharedClient({ readPrivateChat: vi.fn().mockRejectedValue(new Error('Private transcript unavailable')) })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('Private transcript unavailable') })
  })

  it('clears a previous Bot read error after selecting a healthy Bot', async () => {
    const client = sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [{ ...bot, role: 'collaborator' }, { ...analystBot, role: 'collaborator' }] } }),
      readPrivateChat: vi.fn().mockImplementation((botId: string) => botId === bot.id
        ? Promise.reject(new Error('Private transcript unavailable'))
        : Promise.resolve({ ok: true, value: { botId, recent: [{ role: 'assistant', text: 'Analyst answer' }] } })),
      readMemory: vi.fn().mockResolvedValue({ ok: true, value: { botId: BotId(bot.id), enabled: true, updatedAt: 1, entries: [] } }),
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('Private transcript unavailable') })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(analystBot.name) }))
    await waitFor(() => { expect(screen.getByText('Analyst answer')).toBeTruthy() })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('requires acknowledgement before publishing a shared note', async () => {
    const client = sharedClient()
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByPlaceholderText('Add a note for the shared context')).toBeTruthy() })
    fireEvent.change(screen.getByPlaceholderText('Add a note for the shared context'), { target: { value: 'New shared note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))

    const confirmation = screen.getByRole('dialog', { name: 'Publish to shared context?' })
    const publish = within(confirmation).getByRole('button', { name: 'Publish' })
    expect((publish as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(confirmation).getByRole('checkbox', { name: /shared with every member/i }))
    fireEvent.click(publish)

    await waitFor(() => { expect(client.writeMemory).toHaveBeenCalledWith(bot.id, 'New shared note') })
  })

  it('preserves a new invite code typed while enrollment is pending', async () => {
    const enroll = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['enroll']>>>()
    const client = sharedClient({ enroll: vi.fn().mockReturnValue(enroll.promise) })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Private answer')).toBeTruthy() })
    fireEvent.change(screen.getByRole('textbox', { name: 'Invite code' }), { target: { value: 'first-code' } })
    fireEvent.click(screen.getByRole('button', { name: 'Join bot' }))
    await waitFor(() => { expect(client.enroll).toHaveBeenCalledWith('first-code') })
    fireEvent.change(screen.getByRole('textbox', { name: 'Invite code' }), { target: { value: 'second-code' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Invite code' }), { target: { value: 'first-code' } })

    await act(async () => {
      enroll.resolve({ ok: true, value: { principalId: 'principal-member', expiresAt: 2_000 } })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByRole('textbox', { name: 'Invite code' })).toHaveProperty('value', 'first-code')
  })

  it('preserves a new chat message typed while sending is pending', async () => {
    const chat = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['chat']>>>()
    const client = sharedClient({ chat: vi.fn().mockReturnValue(chat.promise) })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Private answer')).toBeTruthy() })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message this shared bot' }), { target: { value: 'first message' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => { expect(client.chat).toHaveBeenCalledWith(bot.id, 'first message') })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message this shared bot' }), { target: { value: 'second message' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message this shared bot' }), { target: { value: 'first message' } })

    await act(async () => {
      chat.resolve({ ok: true, value: { bot: { ...bot, id: BotId(bot.id), identity: bot.identity ?? 'agent', accent: bot.accent ?? 'amber', state: 'active', availability: 'idle' }, sessionId: 'shared-session-one', accepted: true } })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByRole('textbox', { name: 'Message this shared bot' })).toHaveProperty('value', 'first message')
  })

  it('keeps a pending chat reconciled across closing and reopening', async () => {
    const chat = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['chat']>>>()
    const client = sharedClient({ chat: vi.fn().mockReturnValue(chat.promise) })
    const view = render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Private answer')).toBeTruthy() })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message this shared bot' }), { target: { value: 'pending message' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => { expect(client.chat).toHaveBeenCalledWith(bot.id, 'pending message') })

    view.rerender(<SharedBotsDialog client={client} open={false} onClose={vi.fn()} t={t} />)
    view.rerender(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)
    await waitFor(() => { expect(screen.getByText('Private answer')).toBeTruthy() })
    expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(client.chat).toHaveBeenCalledTimes(1)

    await act(async () => {
      chat.resolve({ ok: true, value: { bot: { ...bot, id: BotId(bot.id), identity: bot.identity ?? 'agent', accent: bot.accent ?? 'amber', state: 'active', availability: 'idle' }, sessionId: 'shared-session-one', accepted: true } })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByRole('textbox', { name: 'Message this shared bot' })).toHaveProperty('value', '')
    expect(client.chat).toHaveBeenCalledTimes(1)
  })

  it('preserves a new shared note typed while publishing is pending', async () => {
    const writeMemory = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['writeMemory']>>>()
    const client = sharedClient({ writeMemory: vi.fn().mockReturnValue(writeMemory.promise) })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByPlaceholderText('Add a note for the shared context')).toBeTruthy() })
    const input = screen.getByPlaceholderText('Add a note for the shared context')
    fireEvent.change(input, { target: { value: 'first note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    const confirmation = screen.getByRole('dialog', { name: 'Publish to shared context?' })
    fireEvent.click(within(confirmation).getByRole('checkbox', { name: /shared with every member/i }))
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Publish' }))
    await waitFor(() => { expect(client.writeMemory).toHaveBeenCalledWith(bot.id, 'first note') })
    fireEvent.change(input, { target: { value: 'second note' } })
    fireEvent.change(input, { target: { value: 'first note' } })

    await act(async () => {
      writeMemory.resolve({ ok: true, value: { entry: { id: BotShareMemoryId('memory-two'), principalId: BotPrincipalId('principal-member'), text: 'first note', createdAt: 2 } } })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByPlaceholderText('Add a note for the shared context')).toHaveProperty('value', 'first note')
  })

  it('keeps a pending shared-note publish reconciled across closing and reopening', async () => {
    const writeMemory = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['writeMemory']>>>()
    const client = sharedClient({ writeMemory: vi.fn().mockReturnValue(writeMemory.promise) })
    const view = render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByPlaceholderText('Add a note for the shared context')).toBeTruthy() })
    fireEvent.change(screen.getByPlaceholderText('Add a note for the shared context'), { target: { value: 'pending note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    const confirmation = screen.getByRole('dialog', { name: 'Publish to shared context?' })
    fireEvent.click(within(confirmation).getByRole('checkbox', { name: /shared with every member/i }))
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Publish' }))
    await waitFor(() => { expect(client.writeMemory).toHaveBeenCalledWith(bot.id, 'pending note') })

    view.rerender(<SharedBotsDialog client={client} open={false} onClose={vi.fn()} t={t} />)
    view.rerender(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)
    await waitFor(() => { expect(screen.getByPlaceholderText('Add a note for the shared context')).toBeTruthy() })
    expect(screen.getByRole('button', { name: 'Publish' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    expect(client.writeMemory).toHaveBeenCalledTimes(1)

    await act(async () => {
      writeMemory.resolve({ ok: true, value: { entry: { id: BotShareMemoryId('memory-two'), principalId: BotPrincipalId('principal-member'), text: 'pending note', createdAt: 2 } } })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByPlaceholderText('Add a note for the shared context')).toHaveProperty('value', '')
    expect(client.writeMemory).toHaveBeenCalledTimes(1)
  })

  it('does not allow a pending chat to overlap shared-note publishing', async () => {
    const chat = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['chat']>>>()
    const client = sharedClient({ chat: vi.fn().mockReturnValue(chat.promise) })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Private answer')).toBeTruthy() })
    fireEvent.change(screen.getByRole('textbox', { name: 'Message this shared bot' }), { target: { value: 'pending message' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => { expect(client.chat).toHaveBeenCalledWith(bot.id, 'pending message') })

    fireEvent.change(screen.getByPlaceholderText('Add a note for the shared context'), { target: { value: 'pending note' } })
    const publish = screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement
    expect(publish.disabled).toBe(true)
    fireEvent.click(publish)
    expect(screen.queryByRole('dialog', { name: 'Publish to shared context?' })).toBeNull()

    await act(async () => {
      chat.resolve({ ok: true, value: { bot: { ...bot, id: BotId(bot.id), identity: bot.identity ?? 'agent', accent: bot.accent ?? 'amber', state: 'active', availability: 'idle' }, sessionId: 'shared-session-one', accepted: true } })
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.change(screen.getByRole('textbox', { name: 'Message this shared bot' }), { target: { value: 'next message' } })
    expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', false)
  })

  it('does not allow a pending shared-note publish to overlap chat', async () => {
    const writeMemory = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['writeMemory']>>>()
    const client = sharedClient({ writeMemory: vi.fn().mockReturnValue(writeMemory.promise) })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByPlaceholderText('Add a note for the shared context')).toBeTruthy() })
    fireEvent.change(screen.getByPlaceholderText('Add a note for the shared context'), { target: { value: 'pending note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    const confirmation = screen.getByRole('dialog', { name: 'Publish to shared context?' })
    fireEvent.click(within(confirmation).getByRole('checkbox', { name: /shared with every member/i }))
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Publish' }))
    await waitFor(() => { expect(client.writeMemory).toHaveBeenCalledWith(bot.id, 'pending note') })

    fireEvent.change(screen.getByRole('textbox', { name: 'Message this shared bot' }), { target: { value: 'pending message' } })
    const send = screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.click(send)
    expect(client.chat).not.toHaveBeenCalled()

    await act(async () => {
      writeMemory.resolve({ ok: true, value: { entry: { id: BotShareMemoryId('memory-two'), principalId: BotPrincipalId('principal-member'), text: 'pending note', createdAt: 2 } } })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', false)
  })
})
