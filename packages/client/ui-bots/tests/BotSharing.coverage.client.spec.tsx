// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { brandString } from '@yharness/brand'
import { BotId } from '@yharness/bots/client'
import type { BotGroupId, BotGroupView, BotSharedGroupDeliveryFenceView } from '@yharness/bots/client'
import { makeTranslate } from '@yharness/client-test-runtime'
import { BotShareDialog, SharedBotsDialog } from '../src/client/BotSharing.tsx'
import { en } from '../src/client/locales.ts'
import type { BotShareActions } from '../src/client/controller.ts'
import type { BotSummary } from '../src/client/types.ts'
import type { SharedBotsClient } from '../src/client/shared-client.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const originalLocksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks')
const lockRequest = <T,>(_name: string, callback: () => Promise<T>): Promise<T> => callback()

beforeAll(() => {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: lockRequest },
  })
})
afterAll(() => {
  if (originalLocksDescriptor === undefined) Reflect.deleteProperty(navigator, 'locks')
  else Object.defineProperty(navigator, 'locks', originalLocksDescriptor)
})

const t = makeTranslate(en)
const bot: BotSummary = {
  id: 'bot-chief',
  name: 'Chief of staff',
  description: 'Coordinates the work',
  identity: 'agent',
  accent: 'amber',
}
const analystBot: BotSummary = {
  ...bot,
  id: 'bot-analyst',
  name: 'Analyst',
  description: 'Studies the evidence',
  accent: 'teal',
}

function groupFixture(id: string, name: string): BotGroupView {
  return {
    id: brandString<BotGroupId>(id),
    name,
    botIds: [BotId(bot.id), BotId(analystBot.id)],
    bots: [
      { id: BotId(bot.id), name: bot.name, identity: bot.identity ?? 'agent', accent: bot.accent ?? 'amber', state: 'active', availability: 'idle' },
      { id: BotId(analystBot.id), name: analystBot.name, identity: analystBot.identity ?? 'agent', accent: analystBot.accent ?? 'teal', state: 'active', availability: 'idle' },
    ],
    createdAt: 1,
    updatedAt: 1,
  }
}

function ownerActions(overrides: Partial<BotShareActions> = {}): BotShareActions {
  return {
    listMembers: vi.fn().mockResolvedValue({ members: [] }),
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
    readPrivateChat: vi.fn().mockResolvedValue({ ok: true, value: { botId: bot.id, recent: [] } }),
    readMemory: vi.fn().mockResolvedValue({ ok: true, value: { botId: BotId(bot.id), enabled: false, updatedAt: 1, entries: [] } }),
    chat: vi.fn().mockResolvedValue({ ok: true, value: { bot, sessionId: 'session', accepted: true } }),
    writeMemory: vi.fn().mockResolvedValue({ ok: true, value: { entry: { id: 'entry', principalId: 'principal-member', text: 'note', createdAt: 1 } } }),
    createInvite: vi.fn().mockResolvedValue({ ok: true, value: { code: 'invite', expiresAt: 2_000, role: 'collaborator' } }),
    revokeMember: vi.fn().mockResolvedValue({ ok: true, value: { revoked: true, principalId: 'principal-member' } }),
    ...overrides,
  }
}

describe('BotSharing defensive UI paths', () => {
  it('renders every approval decision and argument disclosure variant', async () => {
    const decideApproval = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { resolved: true, accepted: false } })
      .mockResolvedValueOnce({ ok: false, error: { code: 'gateway/failed', message: 'decision failed' } })
      .mockRejectedValueOnce(new Error('decision unavailable'))
    const revokeApprovalGrant = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'gateway/failed', message: 'revoke failed' } })
      .mockRejectedValueOnce(new Error('revoke unavailable'))
    const client = sharedClient({
      listApprovals: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          approvals: [
            { id: 'approval-both', botId: bot.id, appId: '', toolName: 'tool.both', action: 'Both flags', arguments: 'raw text', argumentsRedacted: true, argumentsTruncated: true },
            { id: 'approval-both-empty', botId: bot.id, appId: 'GitHub', toolName: 'tool.empty', action: 'Both flags without arguments', argumentsRedacted: true, argumentsTruncated: true },
          ],
          grants: [{ id: 'grant-one', botId: bot.id, appId: '', toolName: 'tool.grant', createdAt: 1 }],
        },
      }),
      decideApproval,
      revokeApprovalGrant,
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    expect(await screen.findByText('The argument preview is shortened and some values are hidden for safety. Review the action carefully before allowing it.')).toBeTruthy()
    expect(screen.getByText('The argument preview was shortened and sensitive values were hidden; no argument details are available.')).toBeTruthy()
    expect(screen.getAllByText(/Connected app/)).not.toHaveLength(0)
    const approve = await screen.findByRole('button', { name: 'Approve GitHub tool.empty' })
    fireEvent.click(approve)
    await waitFor(() => { expect(decideApproval).toHaveBeenCalledWith('approval-both-empty', 'allow') })
    expect(await screen.findByRole('alert')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Deny GitHub tool.empty' }))
    await waitFor(() => { expect(decideApproval).toHaveBeenCalledWith('approval-both-empty', 'reject') })
    fireEvent.click(screen.getByRole('button', { name: 'Always allow GitHub tool.empty' }))
    await waitFor(() => { expect(decideApproval).toHaveBeenCalledWith('approval-both-empty', 'always-allow') })

    const revoke = screen.getByRole('button', { name: 'Revoke remembered approval for tool.grant' })
    fireEvent.click(revoke)
    await waitFor(() => { expect(revokeApprovalGrant).toHaveBeenCalledWith('grant-one') })
    fireEvent.click(revoke)
    await waitFor(() => { expect(revokeApprovalGrant).toHaveBeenCalledTimes(2) })
  })

  it('reports shared-app catalog mismatches and retries after a failed load', async () => {
    const listSharedAppAccess: NonNullable<BotShareActions['listSharedAppAccess']> = vi.fn()
      .mockRejectedValueOnce(new Error('apps unavailable'))
      .mockResolvedValueOnce({ botId: bot.id, revision: 4, apps: [{ id: 'calendar', name: '', description: undefined, allowed: false }] })
    const setSharedAppAccess: NonNullable<BotShareActions['setSharedAppAccess']> = vi.fn().mockResolvedValue({ botId: 'other-bot', revision: 5, apps: [] })
    render(<BotShareDialog bot={bot} actions={ownerActions({ listSharedAppAccess, setSharedAppAccess })} open onClose={vi.fn()} t={t} />)

    expect(await screen.findByText('Could not load shared app access. Try again.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    const allow = await screen.findByRole('button', { name: 'Allow Connected app calendar in shared sessions' })
    fireEvent.click(allow)
    await waitFor(() => { expect(setSharedAppAccess).toHaveBeenCalledWith(bot.id, 'calendar', true, 4) })
    expect(await screen.findByText('Could not update shared app access. Try again.')).toBeTruthy()
  })

  it('keeps owner membership controls usable across load, invite, revoke, and policy failures', async () => {
    const listMembers: BotShareActions['listMembers'] = vi.fn().mockRejectedValueOnce('members unavailable').mockResolvedValue({ members: [] })
    const createInvite: BotShareActions['createInvite'] = vi.fn().mockRejectedValueOnce('invite unavailable').mockResolvedValue({ code: 'retry-invite', expiresAt: 2_000 })
    const setMemoryPolicy: NonNullable<BotShareActions['setMemoryPolicy']> = vi.fn().mockRejectedValueOnce('policy unavailable').mockResolvedValue({ botId: BotId(bot.id), enabled: true, updatedAt: 2 })
    const actions = ownerActions({ listMembers, createInvite, setMemoryPolicy })
    const view = render(<BotShareDialog bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Sharing could not be completed. Try again.')
    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }))
    await waitFor(() => { expect(createInvite).toHaveBeenCalledOnce() })
    expect(screen.getByRole('alert').textContent).toContain('Sharing could not be completed. Try again.')
    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }))
    await screen.findByLabelText('Invite code')

    view.rerender(<BotShareDialog bot={bot} actions={ownerActions({ setMemoryPolicy })} open onClose={vi.fn()} t={t} />)
    await waitFor(() => { expect(screen.getByRole('switch', { name: 'Enable shared context' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable shared context' }))
    const confirmation = screen.getByRole('dialog', { name: 'Enable shared context?' })
    fireEvent.click(within(confirmation).getByRole('checkbox', { name: /visible to every member/i }))
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Enable context' }))
    await waitFor(() => { expect(setMemoryPolicy).toHaveBeenCalledWith(bot.id, true) })
    expect(screen.getByRole('alert').textContent).toContain('Sharing could not be completed. Try again.')
  })

  it('recovers pending approvals after a transient load failure', async () => {
    const listApprovals: NonNullable<SharedBotsClient['listApprovals']> = vi.fn()
      .mockRejectedValueOnce(new Error('approval service unavailable'))
      .mockResolvedValue({
        ok: true,
        value: {
          approvals: [{ id: 'approval-retry', botId: bot.id, appId: 'Calendar', toolName: 'events.list', action: 'List events' }],
          grants: [],
        },
      })
    const client = sharedClient({ listApprovals, decideApproval: vi.fn() })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    expect(await screen.findByText('Pending approvals could not be loaded. Try again.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh approvals' }))
    expect(await screen.findByRole('button', { name: 'Approve Calendar events.list' })).toBeTruthy()
    expect(listApprovals).toHaveBeenCalledTimes(2)
  })

  it('reports a roster recovery refresh failure without hiding the held fence', async () => {
    const inspectRosterFence: NonNullable<BotShareActions['inspectRosterFence']> = vi.fn()
      .mockResolvedValueOnce({ status: 'held' as const, token: 'roster-error-token' })
      .mockRejectedValueOnce(new Error('roster refresh unavailable'))
    const recoverRosterFence: NonNullable<BotShareActions['recoverRosterFence']> = vi.fn().mockResolvedValue({ status: 'busy' as const })
    const actions = ownerActions({ inspectRosterFence, recoverRosterFence })
    render(<BotShareDialog bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('roster-error-token')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Recover shared roster' }))
    const confirmation = screen.getByRole('dialog', { name: 'Recover shared roster?' })
    fireEvent.click(within(confirmation).getByRole('checkbox', { name: /stopped every Host/i }))
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Recover roster' }))

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'roster refresh unavailable')
    expect(screen.getByText('roster-error-token')).toBeTruthy()
  })

  it('reports a delivery recovery refresh failure and clears stale recovery state', async () => {
    const fence: BotSharedGroupDeliveryFenceView = {
      groupId: brandString<BotGroupId>('group-delivery-refresh-error'),
      botId: BotId(bot.id),
      sessionId: 'session-delivery-refresh-error',
      messageId: brandString('message-delivery-refresh-error'),
    }
    const inspectDeliveryFences: NonNullable<BotShareActions['inspectDeliveryFences']> = vi.fn()
      .mockResolvedValueOnce({ fences: [fence] })
      .mockRejectedValueOnce(new Error('delivery refresh unavailable'))
    const recoverDeliveryFence: NonNullable<BotShareActions['recoverDeliveryFence']> = vi.fn().mockResolvedValue({
      botId: fence.botId,
      messageId: fence.messageId,
      status: 'busy' as const,
    })
    const actions = ownerActions({ inspectDeliveryFences, recoverDeliveryFence })
    render(<BotShareDialog bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText(/group-delivery-refresh-error · message-delivery-refresh-error/)).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Recover delivery' }))
    const confirmation = screen.getByRole('dialog', { name: 'Recover shared-group delivery?' })
    fireEvent.click(within(confirmation).getByRole('checkbox', { name: /stopped every Host/i }))
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Recover delivery' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveProperty('textContent', 'Recipient delivery status is unavailable.')
    })
    expect(screen.queryByLabelText('Shared-group delivery identity')).toBeNull()
  })

  it('ignores an owner policy completion from a previous Bot view', async () => {
    const stalePolicy = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotShareActions['getMemoryPolicy']>>>>()
    const getMemoryPolicy: NonNullable<BotShareActions['getMemoryPolicy']> = vi.fn((botId: string) => botId === bot.id
      ? stalePolicy.promise
      : Promise.resolve({ botId: BotId(analystBot.id), enabled: false, updatedAt: 2 }))
    const actions = ownerActions({ getMemoryPolicy })
    const view = render(<BotShareDialog bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(getMemoryPolicy).toHaveBeenCalledWith(bot.id) })
    view.rerender(<BotShareDialog bot={analystBot} actions={actions} open onClose={vi.fn()} t={t} />)
    await waitFor(() => { expect(getMemoryPolicy).toHaveBeenCalledWith(analystBot.id) })

    await act(async () => {
      stalePolicy.resolve({ botId: BotId(bot.id), enabled: true, updatedAt: 3 })
      await Promise.resolve()
    })
    expect(screen.getByRole('switch', { name: 'Enable shared context' }).getAttribute('aria-checked')).toBe('false')
  })

  it('ignores an owner delivery inspection completion from a previous Bot view', async () => {
    const staleDelivery = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotShareActions['inspectDeliveryFences']>>>>()
    const inspectDeliveryFences: NonNullable<BotShareActions['inspectDeliveryFences']> = vi.fn((botId: string) => botId === bot.id
      ? staleDelivery.promise
      : Promise.resolve({ fences: [] }))
    const actions = ownerActions({ inspectDeliveryFences })
    const view = render(<BotShareDialog bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(inspectDeliveryFences).toHaveBeenCalledWith(bot.id) })
    view.rerender(<BotShareDialog bot={analystBot} actions={actions} open onClose={vi.fn()} t={t} />)
    await waitFor(() => { expect(inspectDeliveryFences).toHaveBeenCalledWith(analystBot.id) })
    await act(async () => {
      staleDelivery.resolve({ fences: [] })
      await Promise.resolve()
    })
    expect(screen.queryByLabelText('Shared-group delivery identity')).toBeNull()
  })

  it('does not apply a completed owner invite to a newer Bot view', async () => {
    const pendingInvite = Promise.withResolvers<Awaited<ReturnType<BotShareActions['createInvite']>>>()
    const createInvite: BotShareActions['createInvite'] = vi.fn().mockReturnValue(pendingInvite.promise)
    const actions = ownerActions({ createInvite })
    const view = render(<BotShareDialog bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByRole('button', { name: 'Create invite' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }))
    await waitFor(() => { expect(createInvite).toHaveBeenCalledWith(bot.id, 'collaborator') })
    view.rerender(<BotShareDialog bot={analystBot} actions={actions} open onClose={vi.fn()} t={t} />)
    await act(async () => {
      pendingInvite.resolve({ code: 'stale-invite', expiresAt: 2_000 })
      await Promise.resolve()
    })
    expect(screen.queryByText('stale-invite')).toBeNull()
  })

  it('ignores a completed owner memory update after switching Bots', async () => {
    const pendingPolicy = Promise.withResolvers<Awaited<ReturnType<NonNullable<BotShareActions['setMemoryPolicy']>>>>()
    const setMemoryPolicy: NonNullable<BotShareActions['setMemoryPolicy']> = vi.fn().mockReturnValue(pendingPolicy.promise)
    const getMemoryPolicy: NonNullable<BotShareActions['getMemoryPolicy']> = vi.fn((botId: string) => Promise.resolve({
      botId: BotId(botId), enabled: false, updatedAt: 1,
    }))
    const actions = ownerActions({ getMemoryPolicy, setMemoryPolicy })
    const view = render(<BotShareDialog bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByRole('switch', { name: 'Enable shared context' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable shared context' }))
    const confirmation = screen.getByRole('dialog', { name: 'Enable shared context?' })
    fireEvent.click(within(confirmation).getByRole('checkbox', { name: /visible to every member/i }))
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Enable context' }))
    await waitFor(() => { expect(setMemoryPolicy).toHaveBeenCalledWith(bot.id, true) })

    view.rerender(<BotShareDialog bot={analystBot} actions={actions} open onClose={vi.fn()} t={t} />)
    await act(async () => {
      pendingPolicy.resolve({ botId: BotId(bot.id), enabled: true, updatedAt: 2 })
      await Promise.resolve()
    })
    expect(screen.getByRole('switch', { name: 'Enable shared context' }).getAttribute('aria-checked')).toBe('false')
  })

  it('keeps private and shared-context read failures visible and reports chat failures', async () => {
    const readPrivateChat: SharedBotsClient['readPrivateChat'] = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'gateway/unavailable', message: 'private transcript unavailable', details: {} },
    })
    const readMemory: SharedBotsClient['readMemory'] = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'gateway/unavailable', message: 'shared context unavailable', details: {} },
    })
    const chat: SharedBotsClient['chat'] = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'gateway/unavailable', message: 'chat unavailable', details: {} } })
      .mockRejectedValueOnce('chat transport unavailable')
    const client = sharedClient({ readPrivateChat, readMemory, chat })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'shared context unavailable')
    const input = screen.getByRole('textbox', { name: 'Message this shared bot' })
    fireEvent.change(input, { target: { value: 'Check the shared state' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => { expect(chat).toHaveBeenCalledWith(bot.id, 'Check the shared state') })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'chat unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'The message could not be sent.')
  })

  it('reports a failed shared-context publish through its confirmation dialog', async () => {
    const readMemory: SharedBotsClient['readMemory'] = vi.fn().mockResolvedValue({
      ok: true,
      value: { botId: BotId(bot.id), enabled: true, updatedAt: 1, entries: [] },
    })
    const writeMemory: SharedBotsClient['writeMemory'] = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'gateway/unavailable', message: 'shared note unavailable', details: {} },
    })
    const client = sharedClient({ readMemory, writeMemory })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    const input = await screen.findByRole('textbox', { name: 'Add a note for the shared context' })
    fireEvent.change(input, { target: { value: 'A note for everyone' } })
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    const confirmation = screen.getByRole('dialog', { name: 'Publish to shared context?' })
    fireEvent.click(within(confirmation).getByRole('checkbox', { name: /shared with every member/i }))
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Publish' }))

    await waitFor(() => { expect(writeMemory).toHaveBeenCalledWith(bot.id, 'A note for everyone') })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'shared note unavailable')
  })

  it('reports group settings load and rename failures, including Enter submission', async () => {
    const group = groupFixture('group-settings-errors', 'Settings errors')
    const readGroupSettings: NonNullable<SharedBotsClient['readGroupSettings']> = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'gateway/unavailable', message: 'settings unavailable', details: {} } })
      .mockRejectedValueOnce('settings transport unavailable')
    const client = sharedClient({
      retryScope: 'principal-owner',
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [group] } }),
      inspectGroup: vi.fn().mockResolvedValue({ ok: true, value: { group, messages: [] } }),
      readGroupSettings,
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByTestId('shared-group-settings-open')).toBeTruthy() })
    fireEvent.click(screen.getByTestId('shared-group-settings-open'))
    let dialog = await screen.findByRole('dialog', { name: 'Group settings' })
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'settings unavailable')
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Cancel' }).at(-1)!)
    fireEvent.click(screen.getByTestId('shared-group-settings-open'))
    dialog = await screen.findByRole('dialog', { name: 'Group settings' })
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'The group settings could not be loaded. Try again.')

    const settings = { groupId: String(group.id), name: group.name, updatedAt: 1, canManage: true, members: [] }
    const renameGroup: NonNullable<SharedBotsClient['renameGroup']> = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'gateway/unavailable', message: 'rename unavailable', details: {} } })
      .mockRejectedValueOnce('rename transport unavailable')
      .mockResolvedValue({ ok: true, value: { ...settings, name: 'Final rename', updatedAt: 2 } })
    const editableClient = sharedClient({
      retryScope: 'principal-owner',
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [group] } }),
      inspectGroup: vi.fn().mockResolvedValue({ ok: true, value: { group, messages: [] } }),
      readGroupSettings: vi.fn().mockResolvedValue({ ok: true, value: settings }),
      renameGroup,
    })
    cleanup()
    render(<SharedBotsDialog client={editableClient} open onClose={vi.fn()} t={t} />)
    await waitFor(() => { expect(screen.getByTestId('shared-group-settings-open')).toBeTruthy() })
    fireEvent.click(screen.getByTestId('shared-group-settings-open'))
    dialog = await screen.findByRole('dialog', { name: 'Group settings' })
    const nameInput = within(dialog).getByRole('textbox', { name: 'Group name' })
    fireEvent.change(nameInput, { target: { value: 'First rename' } })
    fireEvent.keyDown(nameInput, { key: 'Enter' })
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'rename unavailable')
    fireEvent.change(nameInput, { target: { value: 'Second rename' } })
    fireEvent.keyDown(nameInput, { key: 'Enter' })
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'The group name could not be saved. Try again.')
    fireEvent.change(nameInput, { target: { value: 'Final rename' } })
    fireEvent.keyDown(nameInput, { key: 'Enter' })
    await waitFor(() => { expect(renameGroup).toHaveBeenCalledTimes(3) })
    expect(nameInput).toHaveProperty('value', 'Final rename')
  })

  it('reports failed shared-group invites, messages, and reactions', async () => {
    const group = groupFixture('group-operation-errors', 'Operation errors')
    const messageId = brandString('message-operation-errors')
    const inspectGroup: NonNullable<SharedBotsClient['inspectGroup']> = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        group,
        messages: [{
          id: messageId,
          groupId: group.id,
          sender: { kind: 'user', principalId: 'principal-other' },
          text: 'Existing group message',
          createdAt: 1,
          reactions: [{ emoji: '👍', count: 1, viewerReacted: true }],
        }],
      },
    })
    const createGroupInvite: NonNullable<SharedBotsClient['createGroupInvite']> = vi.fn().mockRejectedValue('invite transport unavailable')
    const sendGroupMessage: NonNullable<SharedBotsClient['sendGroupMessage']> = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'gateway/unavailable', message: 'message unavailable', details: {} } })
      .mockRejectedValueOnce('message transport unavailable')
    const reactGroupMessage: NonNullable<SharedBotsClient['reactGroupMessage']> = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'gateway/unavailable', message: 'reaction unavailable', details: {} } })
      .mockRejectedValueOnce('reaction transport unavailable')
    const client = sharedClient({
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [group] } }),
      inspectGroup,
      createGroupInvite,
      sendGroupMessage,
      reactGroupMessage,
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByRole('button', { name: 'Invite people' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Invite people' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'The group invite could not be created. Only the group owner can invite people.')

    const input = screen.getByPlaceholderText('Message Operation errors')
    fireEvent.change(screen.getByLabelText('Choose files'), { target: { files: [new File(['notes'], 'operation-notes.txt', { type: 'text/plain' })] } })
    expect(screen.getByText('operation-notes.txt')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove operation-notes.txt' }))
    expect(screen.queryByText('operation-notes.txt')).toBeNull()
    fireEvent.change(input, { target: { value: '@A' } })
    await screen.findByRole('option', { name: /Analyst/ })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.change(input, { target: { value: 'Try this message' } })
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Send to group' })).toHaveProperty('disabled', false) })
    fireEvent.click(screen.getByRole('button', { name: 'Send to group' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'message unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Send to group' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'The group message could not be sent. Try again.')

    fireEvent.click(screen.getByRole('button', { name: '👍, 1 reactions' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'reaction unavailable')
    fireEvent.click(screen.getByRole('button', { name: '👍, 1 reactions' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'That reaction could not be saved. Try again.')
  })

  it('reports owner recovery exceptions and refreshes a busy delivery fence', async () => {
    const fence: BotSharedGroupDeliveryFenceView = {
      groupId: brandString<BotGroupId>('group-recovery-errors'),
      botId: BotId(bot.id),
      sessionId: 'session-recovery-errors',
      messageId: brandString('message-recovery-errors'),
    }
    const inspectRosterFence: NonNullable<BotShareActions['inspectRosterFence']> = vi.fn().mockResolvedValue({
      status: 'held' as const, token: 'recovery-error-token',
    })
    const recoverRosterFence: NonNullable<BotShareActions['recoverRosterFence']> = vi.fn().mockRejectedValue(new Error('roster recovery unavailable'))
    const inspectDeliveryFences: NonNullable<BotShareActions['inspectDeliveryFences']> = vi.fn()
      .mockResolvedValueOnce({ fences: [fence] })
      .mockResolvedValueOnce({ fences: [fence] })
    const recoverDeliveryFence: NonNullable<BotShareActions['recoverDeliveryFence']> = vi.fn()
      .mockRejectedValueOnce(new Error('delivery recovery unavailable'))
      .mockResolvedValueOnce({ botId: fence.botId, messageId: fence.messageId, status: 'busy' as const })
    const actions = ownerActions({ inspectRosterFence, recoverRosterFence, inspectDeliveryFences, recoverDeliveryFence })
    render(<BotShareDialog bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('recovery-error-token')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Recover shared roster' }))
    const rosterConfirmation = screen.getByRole('dialog', { name: 'Recover shared roster?' })
    fireEvent.click(within(rosterConfirmation).getByRole('checkbox', { name: /stopped every Host/i }))
    fireEvent.click(within(rosterConfirmation).getByRole('button', { name: 'Recover roster' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'roster recovery unavailable')

    fireEvent.click(screen.getByRole('button', { name: 'Recover delivery' }))
    let deliveryConfirmation = screen.getByRole('dialog', { name: 'Recover shared-group delivery?' })
    fireEvent.click(within(deliveryConfirmation).getByRole('checkbox', { name: /stopped every Host/i }))
    fireEvent.click(within(deliveryConfirmation).getByRole('button', { name: 'Recover delivery' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'delivery recovery unavailable')
    deliveryConfirmation = screen.getByRole('dialog', { name: 'Recover shared-group delivery?' })
    fireEvent.click(within(deliveryConfirmation).getByRole('checkbox', { name: /stopped every Host/i }))
    fireEvent.click(within(deliveryConfirmation).getByRole('button', { name: 'Recover delivery' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'This delivery is still active or changed. Stop every Host and review the current delivery list.')
    expect(screen.getByText(/group-recovery-errors · message-recovery-errors/)).toBeTruthy()
  })

  it('copies a successful shared-group invite through the rendered control', async () => {
    const group = groupFixture('group-invite-copy', 'Invite copy')
    const createGroupInvite: NonNullable<SharedBotsClient['createGroupInvite']> = vi.fn().mockResolvedValue({
      ok: true, value: { code: 'copyable-group-invite', expiresAt: 2_000 },
    })
    const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      const client = sharedClient({
        listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [group] } }),
        inspectGroup: vi.fn().mockResolvedValue({ ok: true, value: { group, messages: [] } }),
        createGroupInvite,
      })
      render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)
      await waitFor(() => { expect(screen.getByRole('button', { name: 'Invite people' })).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: 'Invite people' }))
      expect(await screen.findByLabelText('Group invite code')).toHaveProperty('textContent', 'copyable-group-invite')
      fireEvent.click(screen.getByRole('button', { name: 'Copy group invite' }))
      await waitFor(() => { expect(writeText).toHaveBeenCalledWith('copyable-group-invite') })
      expect(screen.getByRole('button', { name: 'Group invite copied' })).toBeTruthy()
    } finally {
      if (originalClipboardDescriptor === undefined) Reflect.deleteProperty(navigator, 'clipboard')
      else Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor)
    }
  })

  it('covers owner member recovery and cancels each protected operation', async () => {
    const fence: BotSharedGroupDeliveryFenceView = {
      groupId: brandString<BotGroupId>('group-owner-controls'),
      botId: BotId(bot.id),
      sessionId: 'session-owner-controls',
      messageId: brandString('message-owner-controls'),
    }
    const revokeMember: NonNullable<BotShareActions['revokeMember']> = vi.fn()
      .mockRejectedValueOnce(new Error('member revoke unavailable'))
      .mockResolvedValueOnce({ botId: BotId(bot.id), principalId: 'principal-member', revoked: true })
    const actions = ownerActions({
      listMembers: vi.fn().mockResolvedValue({ members: [
        { botId: BotId(bot.id), principalId: 'principal-owner', role: 'owner', grantedBy: 'principal-owner', createdAt: 1, updatedAt: 1 },
        { botId: BotId(bot.id), principalId: 'principal-member', role: 'collaborator', grantedBy: 'principal-owner', createdAt: 1, updatedAt: 1 },
      ] }),
      revokeMember,
      inspectRosterFence: vi.fn().mockResolvedValue({ status: 'held' as const, token: 'owner-controls-token' }),
      recoverRosterFence: vi.fn().mockResolvedValue({ status: 'released' as const }),
      inspectDeliveryFences: vi.fn().mockResolvedValue({ fences: [fence] }),
      recoverDeliveryFence: vi.fn().mockResolvedValue({ botId: fence.botId, messageId: fence.messageId, status: 'released' as const }),
    })
    render(<BotShareDialog bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)

    const revoke = await screen.findByRole('button', { name: 'Revoke access: principal-member' })
    fireEvent.click(revoke)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'member revoke unavailable')
    fireEvent.click(revoke)
    await waitFor(() => { expect(screen.queryByText('principal-member')).toBeNull() })

    fireEvent.click(screen.getByRole('switch', { name: 'Enable shared context' }))
    const memoryConfirmation = screen.getByRole('dialog', { name: 'Enable shared context?' })
    fireEvent.click(within(memoryConfirmation).getAllByRole('button', { name: 'Cancel' }).at(-1)!)
    expect(screen.queryByRole('dialog', { name: 'Enable shared context?' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Recover shared roster' }))
    const rosterConfirmation = screen.getByRole('dialog', { name: 'Recover shared roster?' })
    fireEvent.click(within(rosterConfirmation).getAllByRole('button', { name: 'Cancel' }).at(-1)!)
    expect(screen.queryByRole('dialog', { name: 'Recover shared roster?' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Recover delivery' }))
    const deliveryConfirmation = screen.getByRole('dialog', { name: 'Recover shared-group delivery?' })
    fireEvent.click(within(deliveryConfirmation).getAllByRole('button', { name: 'Cancel' }).at(-1)!)
    expect(screen.queryByRole('dialog', { name: 'Recover shared-group delivery?' })).toBeNull()
  })

  it('reports shared-group read and membership failures without losing the selected room', async () => {
    const group = groupFixture('group-membership-errors', 'Membership errors')
    const inspectGroup: NonNullable<SharedBotsClient['inspectGroup']> = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'gateway/unavailable', message: 'group unavailable', details: {} } })
      .mockRejectedValueOnce('group transport unavailable')
      .mockResolvedValue({ ok: true, value: { group, messages: [] } })
    const readGroupSettings: NonNullable<SharedBotsClient['readGroupSettings']> = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        groupId: String(group.id), name: group.name, updatedAt: 1, canManage: true,
        members: [{ principalId: 'principal-owner', role: 'owner' as const }, { principalId: 'principal-member', role: 'member' as const }],
      },
    })
    const revokeGroupMember: NonNullable<SharedBotsClient['revokeGroupMember']> = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'gateway/unavailable', message: 'member removal unavailable', details: {} } })
      .mockRejectedValueOnce('member removal transport unavailable')
    const client = sharedClient({
      retryScope: 'principal-owner',
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [group] } }),
      inspectGroup,
      readGroupSettings,
      revokeGroupMember,
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByRole('alert')).toHaveProperty('textContent', 'group unavailable') })
    const groupButton = screen.getByRole('button', { name: /Membership errors/ })
    fireEvent.click(groupButton)
    await waitFor(() => { expect(screen.getByRole('alert')).toHaveProperty('textContent', 'Shared groups could not be loaded. Try again.') })
    fireEvent.click(groupButton)
    await waitFor(() => { expect(inspectGroup).toHaveBeenCalledTimes(3) })

    fireEvent.click(screen.getByTestId('shared-group-settings-open'))
    const settingsDialog = await screen.findByRole('dialog', { name: 'Group settings' })
    fireEvent.click(within(settingsDialog).getByRole('button', { name: 'Remove principal-member from this group' }))
    const removeConfirmation = await screen.findByRole('dialog', { name: 'Remove this person?' })
    fireEvent.click(within(removeConfirmation).getByRole('checkbox'))
    fireEvent.click(within(removeConfirmation).getByRole('button', { name: 'Remove from group' }))
    expect(await within(settingsDialog).findByRole('alert')).toHaveProperty('textContent', 'member removal unavailable')
    fireEvent.click(within(removeConfirmation).getByRole('button', { name: 'Remove from group' }))
    expect(await within(settingsDialog).findByRole('alert')).toHaveProperty('textContent', 'The person could not be removed from this group. Try again.')
  })

  it('keeps a failed shared-group creation retryable after selection changes', async () => {
    const createGroup: NonNullable<SharedBotsClient['createGroup']> = vi.fn().mockRejectedValue(new Error('group creation unavailable'))
    const client = sharedClient({
      list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [
        { ...bot, role: 'owner' as const },
        { ...analystBot, role: 'owner' as const },
      ] } }),
      listGroups: vi.fn().mockResolvedValue({ ok: true, value: { groups: [] } }),
      createGroup,
    })
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByRole('button', { name: 'Create shared group' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Create shared group' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a shared group' })
    const name = within(dialog).getByRole('textbox', { name: 'Group name' })
    fireEvent.change(name, { target: { value: 'Retryable room' } })
    const chief = within(dialog).getByRole('checkbox', { name: bot.name })
    const analyst = within(dialog).getByRole('checkbox', { name: analystBot.name })
    fireEvent.click(chief)
    fireEvent.click(analyst)
    fireEvent.click(analyst)
    expect(within(dialog).getByRole('button', { name: 'Create shared group' })).toHaveProperty('disabled', true)
    fireEvent.click(analyst)
    fireEvent.keyDown(name, { key: 'Enter' })

    await waitFor(() => { expect(createGroup).toHaveBeenCalledWith(expect.objectContaining({ name: 'Retryable room' })) })
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'group creation unavailable')
    expect(within(dialog).getByRole('checkbox', { name: bot.name })).toHaveProperty('checked', true)
    expect(within(dialog).getByRole('checkbox', { name: analystBot.name })).toHaveProperty('checked', true)
  })

  it('reports unavailable owner setup and failed owner enrollment', async () => {
    const unavailableClient = sharedClient()
    Reflect.deleteProperty(unavailableClient, 'enrollOwner')
    Reflect.deleteProperty(unavailableClient, 'getOwnerCapability')
    render(<SharedBotsDialog client={unavailableClient} ownerMode open onClose={vi.fn()} t={t} />)
    expect(await screen.findByText('Shared owner setup is unavailable in this connection.')).toBeTruthy()

    cleanup()
    const enrollOwner: NonNullable<SharedBotsClient['enrollOwner']> = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'gateway/forbidden', message: 'owner enrollment rejected', details: {} },
    })
    const failedClient = sharedClient({ enrollOwner, getOwnerCapability: vi.fn().mockResolvedValue({ ownerBootstrap: true }) })
    render(<SharedBotsDialog client={failedClient} ownerMode open onClose={vi.fn()} t={t} />)
    expect(await screen.findByText('owner enrollment rejected')).toBeTruthy()
  })
})
