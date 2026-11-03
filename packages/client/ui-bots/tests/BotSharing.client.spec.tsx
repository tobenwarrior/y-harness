// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BotId } from '@yharness/bots/client'
import { makeTranslate } from '@yharness/client-test-runtime'
import { BotShareDialog, SharedBotsDialog } from '../src/client/BotSharing.tsx'
import { en } from '../src/client/locales.ts'
import type { BotShareActions } from '../src/client/controller.ts'
import type { SharedBotsClient } from '../src/client/shared-client.ts'
import type { BotSummary } from '../src/client/types.ts'

afterEach(cleanup)

const t = makeTranslate(en)
const bot: BotSummary = {
  id: 'bot-chief',
  name: 'Chief of staff',
  description: 'Coordinates the work',
  group: 'General',
  status: 'idle',
  identity: 'agent',
  accent: 'amber',
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

  it('keeps a collaborator private transcript visually separate from shared context', async () => {
    const client = sharedClient()
    render(<SharedBotsDialog client={client} open onClose={vi.fn()} t={t} />)

    await waitFor(() => { expect(screen.getByText('Private session')).toBeTruthy() })
    expect(screen.getByText('Private answer')).toBeTruthy()
    expect(screen.getByText('Shared decision')).toBeTruthy()
    expect(screen.getByText('Visible to members')).toBeTruthy()
    expect(client.readPrivateChat).toHaveBeenCalledWith(bot.id)
    expect(client.readMemory).toHaveBeenCalledWith(bot.id)
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
})
