// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BotId } from '@yharness/bots/client'
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

const t = makeTranslate(en)
const bot: BotSummary = {
  id: 'bot-chief',
  name: 'Chief of staff',
  description: 'Coordinates the work',
  identity: 'agent',
  accent: 'amber',
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
})
