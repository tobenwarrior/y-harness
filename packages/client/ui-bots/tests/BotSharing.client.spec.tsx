// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@yharness/brand'
import { BotId, BotPrincipalId, BotShareMemoryId } from '@yharness/bots/client'
import type { BotGroupId, BotGroupMessageId, BotGroupMessageView, BotGroupView } from '@yharness/bots/client'
import { makeTranslate } from '@yharness/client-test-runtime'
import { BotShareDialog, SharedBotsDialog } from '../src/client/BotSharing.tsx'
import { en } from '../src/client/locales.ts'
import type { BotShareActions } from '../src/client/controller.ts'
import type { SharedBotsClient } from '../src/client/shared-client.ts'
import type { BotSummary } from '../src/client/types.ts'

afterEach(cleanup)

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
    enroll: vi.fn().mockResolvedValue({ ok: true, value: { principalId: 'principal-member', expiresAt: 2_000 } }),
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
    expect(within(dialog).getByText('Create or request a Bot invite for each selected Bot, redeem those invites above, then choose two to six Bots. A group invite only grants room access.')).toBeTruthy()
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

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create shared group' }))
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
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Group name' }), { target: { value: 'Persisted room' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: bot.name }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: analystBot.name }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create shared group' }))

    await waitFor(() => {
      expect(createGroup).toHaveBeenCalledOnce()
      expect(listGroups.mock.calls.length).toBeGreaterThan(1)
      expect(screen.getByRole('button', { name: /Persisted room/ })).toBeTruthy()
    })
    expect(localStorage.getItem('yharness.client-ui-bots.pending-shared-group-operations')).toBe('{"creations":{},"messages":{}}')
    localStorage.clear()
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
    const sendGroupMessage = vi.fn().mockRejectedValueOnce(new Error('connection closed after commit'))
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
      sender: { kind: 'user' as const },
      text: 'Persist this update',
      createdAt: 2,
    }
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)
    await waitFor(() => { expect(screen.getByPlaceholderText('Message Persisted message room')).toBeTruthy() })
    fireEvent.change(screen.getByPlaceholderText('Message Persisted message room'), { target: { value: 'Persist this update' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to group' }))
    await waitFor(() => { expect(screen.getByText('Persist this update')).toBeTruthy() })
    expect(sendGroupMessage).toHaveBeenCalledOnce()
    expect(localStorage.getItem('yharness.client-ui-bots.pending-shared-group-operations')).toBe('{"creations":{},"messages":{}}')
    localStorage.clear()
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

    expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => { expect(client.chat).toHaveBeenCalledWith(analystBot.id, 'Analyst follow up') })
  })

  it('does not let a stale chat completion clear a reopened Bot operation', async () => {
    const staleChat = Promise.withResolvers<Awaited<ReturnType<SharedBotsClient['chat']>>>()
    const client = sharedClient({
      chat: vi.fn().mockReturnValue(staleChat.promise),
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
    expect(client.chat).toHaveBeenCalledTimes(1)

    await act(async () => {
      staleChat.resolve({ ok: true, value: { bot: { ...bot, id: BotId(bot.id), identity: bot.identity ?? 'agent', accent: bot.accent ?? 'amber', state: 'active', availability: 'idle' }, sessionId: 'stale-session', accepted: true } })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByRole('textbox', { name: 'Message this shared bot' })).toHaveProperty('value', 'Second request')
    expect(screen.getByRole('button', { name: 'Send message' })).toHaveProperty('disabled', false)
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
