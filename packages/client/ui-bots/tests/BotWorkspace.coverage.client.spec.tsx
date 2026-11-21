// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@yharness/client-test-runtime'
import { en } from '../src/client/locales.ts'
import { BotDetail, BotGroupDetail, BotRoster } from '../src/client/BotWorkspace.tsx'
import type { SharedBotsClient } from '../src/client/shared-client.ts'
import type { BotShareActions } from '../src/client/controller.ts'
import type {
  BotConnectedAppAccess, BotGroupDetailData, BotGroupSummary, BotSummary, BotTemplateActions, BotTemplateState,
} from '../src/client/types.ts'

const t = makeTranslate(en)

function chooseBotOption(name: string, menu: string = en.botMenu): void {
  fireEvent.click(screen.getByRole('button', { name: menu }))
  fireEvent.click(screen.getByRole('menuitem', { name }))
}

const botA: BotSummary = {
  id: 'research', name: 'Research partner', description: 'Source scout', group: 'Research',
  identity: 'browse', accent: 'teal', status: 'working', preview: 'Comparing sources',
}
const botB: BotSummary = {
  id: 'release', name: 'Release captain', description: 'Shipping companion', group: 'Build',
  identity: 'goal', accent: 'amber', status: 'idle',
}
const botC: BotSummary = {
  id: 'design', name: 'Design guide', group: 'Research', identity: 'sparkle', accent: 'violet',
}
const botD: BotSummary = { id: 'ops', name: 'Operations', identity: 'agent', accent: 'rose' }
const botE: BotSummary = { id: 'qa', name: 'Quality analyst', identity: 'skill', accent: 'lime' }
const botF: BotSummary = { id: 'docs', name: 'Docs writer', identity: 'workspace', accent: 'blue' }
const botG: BotSummary = { id: 'legal', name: 'Legal reviewer', identity: 'agent', accent: 'amber' }
const plainBot: BotSummary = { id: 'plain', name: 'Plain bot', identity: 'agent' }
const allBots = [botA, botB, botC, botD, botE, botF, botG] as const

const group: BotGroupDetailData = {
  id: 'group-release', name: 'Release room', bots: [botA, botB], messages: [
    { id: 'message-1', sender: { kind: 'user' }, text: 'Plan the release together.', createdAt: 1 },
    {
      id: 'message-2', sender: { kind: 'bot', botId: botA.id, name: botA.name }, text: 'I found three useful sources.', createdAt: 2,
      replyToMessageId: 'message-1', attachments: [{ type: 'file', attachmentId: 'attachment-1', name: 'notes.txt', bytes: 12 }],
    },
  ],
}

const templateState: BotTemplateState = {
  phase: 'ready',
  templates: [{
    id: 'template-release', shareCode: 'bot-template-release', name: 'Release partner', description: 'Keeps releases moving.',
    identity: 'goal', accent: 'amber', createdAt: 1,
  }],
  code: 'bot-template-release', preview: null, error: null, busy: false,
}

function sharedRailClient(getOwnerCapability: NonNullable<SharedBotsClient['getOwnerCapability']>): SharedBotsClient {
  const rejected = <T,>() => vi.fn<() => Promise<T>>().mockRejectedValue(new Error('unused'))
  return {
    retryScope: undefined,
    enroll: rejected(), enrollOwner: rejected(), getOwnerCapability,
    restoreRetryScope: rejected(), list: vi.fn().mockResolvedValue({ ok: true, value: { bots: [] } }),
    readProfile: rejected(), readPrivateChat: rejected(), readMemory: rejected(), chat: rejected(),
    writeMemory: rejected(), createInvite: rejected(), revokeMember: rejected(),
  }
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('BotWorkspace supported lifecycle coverage', () => {
  it('restores folder state, groups repeated sections, and handles organization actions', async () => {
    localStorage.setItem('dsh.client-ui-bots.folder-state.v1', JSON.stringify({ invalid: true }))
    const organize = vi.fn().mockResolvedValue(undefined)
    render(<BotRoster
      bots={[botA, botC, plainBot, { ...botB, hidden: true }]}
      selectedBotId={botA.id}
      onSelectBot={vi.fn()}
      onCreateBot={vi.fn()}
      onOrganizeBot={organize}
      t={t}
    />)

    expect(screen.getByRole('heading', { name: 'Research' })).toBeTruthy()
    const hidden = screen.getByRole('button', { name: 'Hidden bots' })
    expect(hidden.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(hidden)

    fireEvent.click(screen.getByRole('button', { name: 'Bot actions for Research partner' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide bot' }))
    await waitFor(() => { expect(organize).toHaveBeenCalledWith(botA.id, { hidden: true }) })

    fireEvent.click(screen.getByRole('button', { name: 'Bot actions for Research partner' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'No section' }))
    await waitFor(() => { expect(organize).toHaveBeenCalledWith(botA.id, { group: null }) })

    fireEvent.click(screen.getByRole('button', { name: 'Bot actions for Research partner' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set section…' }))
    const section = screen.getByRole('dialog', { name: 'Organize bot' })
    fireEvent.change(within(section).getByRole('textbox', { name: 'Section name' }), { target: { value: '' } })
    fireEvent.keyDown(within(section).getByRole('textbox', { name: 'Section name' }), { key: 'ArrowDown' })
    fireEvent.keyDown(within(section).getByRole('textbox', { name: 'Section name' }), { key: 'Enter' })
    await waitFor(() => { expect(organize).toHaveBeenCalledWith(botA.id, { group: null }) })

    organize.mockRejectedValueOnce(new Error('organization unavailable'))
    fireEvent.click(screen.getByRole('button', { name: 'Bot actions for Research partner' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide bot' }))
    await waitFor(() => { expect(organize).toHaveBeenCalledWith(botA.id, { hidden: true }) })

    fireEvent.click(screen.getByRole('button', { name: 'Bot actions for Research partner' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Research' }))
    expect(localStorage.getItem('dsh.client-ui-bots.folder-state.v1')).toContain('folder:Research')
    expect(screen.getByRole('button', { name: 'Plain bot' }).getAttribute('data-accent')).toBe('violet')
  })

  it('keeps roster interaction available when browser storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('private mode') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
    render(<BotRoster bots={[botA, botB]} selectedBotId={botA.id} onSelectBot={vi.fn()} onCreateBot={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Research' }))
    expect(screen.queryByRole('button', { name: /Research partner, Working/ })).toBeNull()
  })

  it('creates a group through keyboard entry and enforces the six-member limit', async () => {
    const create = vi.fn().mockResolvedValue(undefined)
    render(<BotRoster
      bots={allBots}
      selectedBotId={botA.id}
      onSelectBot={vi.fn()}
      onCreateBot={vi.fn()}
      onCreateGroup={create}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'New bot group' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a bot group' })
    const name = within(dialog).getByRole('textbox', { name: 'Group name' })
    fireEvent.keyDown(name, { key: 'ArrowDown' })
    fireEvent.keyDown(name, { key: 'Enter' })
    for (const bot of allBots.slice(0, 6)) fireEvent.click(within(dialog).getByRole('checkbox', { name: bot.name }))
    expect(within(dialog).getByRole('checkbox', { name: botG.name })).toHaveProperty('disabled', true)
    fireEvent.click(within(dialog).getByRole('checkbox', { name: botF.name }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: botG.name }))
    fireEvent.change(name, { target: { value: '  Launch room  ' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    await waitFor(() => {
      expect(create).toHaveBeenCalledWith({ name: 'Launch room', botIds: ['research', 'release', 'design', 'ops', 'qa', 'legal'] })
    })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Create a bot group' })).toBeNull() })
  })

  it('retains a new-group dialog after the owner rejects creation and renders no-bot guidance', async () => {
    const create = vi.fn().mockRejectedValue(new Error('group unavailable'))
    render(<BotRoster
      bots={[botA, botB]} selectedBotId={botA.id} onSelectBot={vi.fn()} onCreateBot={vi.fn()} onCreateGroup={create} t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'New bot group' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a bot group' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Group name' }), { target: { value: 'Retry room' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: botA.name }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: botB.name }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create group' }))
    await waitFor(() => { expect(create).toHaveBeenCalledOnce() })
    expect(screen.getByRole('dialog', { name: 'Create a bot group' })).toBeTruthy()

    cleanup()
    render(<BotRoster bots={[]} selectedBotId={null} onSelectBot={vi.fn()} onCreateBot={vi.fn()} onCreateGroup={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'New bot group' }))
    expect(screen.getByText('Create at least two Bots before making a group.')).toBeTruthy()
  })

  it('edits group members from the dialog and keeps choices after a failed update', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    const editable = { ...group, bots: [botA, botB, botC] }
    render(<BotGroupDetail
      group={editable} bots={allBots} loading={false} error={null} onRetry={vi.fn()} onUpdate={update}
      onSend={vi.fn()} loadAvatar={undefined} t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit group' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit bot group' })
    const groupName = within(dialog).getByRole('textbox', { name: 'Group name' })
    fireEvent.change(groupName, { target: { value: '' } })
    fireEvent.keyDown(groupName, { key: 'ArrowDown' })
    fireEvent.keyDown(groupName, { key: 'Enter' })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: botC.name }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: botC.name }))
    fireEvent.change(groupName, { target: { value: 'Launch room' } })
    fireEvent.keyDown(groupName, { key: 'Enter' })
    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({ groupId: editable.id, name: 'Launch room', botIds: ['research', 'release', 'design'] })
    })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Edit bot group' })).toBeNull() })

    const failed = vi.fn().mockRejectedValue(new Error('update unavailable'))
    cleanup()
    render(<BotGroupDetail
      group={editable} bots={allBots} loading={false} error={null} onRetry={vi.fn()} onUpdate={failed}
      onSend={vi.fn()} loadAvatar={undefined} t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit group' }))
    const failedDialog = screen.getByRole('dialog', { name: 'Edit bot group' })
    fireEvent.click(within(failedDialog).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => { expect(failed).toHaveBeenCalledOnce() })
    expect(screen.getByRole('dialog', { name: 'Edit bot group' })).toBeTruthy()

    cleanup()
    render(<BotGroupDetail
      group={group} bots={allBots} loading={false} error={null} onRetry={vi.fn()} onUpdate={vi.fn().mockResolvedValue(undefined)}
      onSend={vi.fn()} loadAvatar={undefined} t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit group' }))
    const minimumDialog = screen.getByRole('dialog', { name: 'Edit bot group' })
    fireEvent.click(within(minimumDialog).getByRole('checkbox', { name: botB.name }))
    expect(screen.getByText('Choose at least two Bots.')).toBeTruthy()
    fireEvent.click(within(minimumDialog).getByRole('checkbox', { name: botB.name }))
  })

  it('renders group loading and empty/error states with retry actions', () => {
    const retry = vi.fn()
    render(<BotGroupDetail
      group={undefined} loading error="Group unavailable" onRetry={retry} onSend={vi.fn()}
      loadAvatar={undefined} t={t}
    />)
    expect(screen.getByRole('heading', { name: 'Loading group' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledOnce()

    cleanup()
    render(<BotGroupDetail group={undefined} loading={false} error={null} onRetry={retry} onSend={vi.fn()} loadAvatar={undefined} t={t} />)
    expect(screen.getByRole('heading', { name: 'Choose a Bot or group' })).toBeTruthy()

    cleanup()
    render(<BotGroupDetail
      group={{ ...group, messages: [] }} loading={false} error="Transcript unavailable" onRetry={retry}
      onSend={vi.fn()} loadAvatar={undefined} t={t}
    />)
    expect(screen.getByText('Send the first message to bring the members into the room.')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Transcript unavailable')
  })

  it('covers group reply targeting, mention keyboard navigation, reactions, delivery retry, and saved attachments', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    const onReact = vi.fn().mockResolvedValue(undefined)
    const onSendWithAttachments = vi.fn().mockResolvedValue(undefined)
    const detailed: BotGroupDetailData = {
      ...group,
      deliveries: [
        { messageId: 'message-1', botId: botA.id, status: 'pending' },
        { messageId: 'message-1', botId: botB.id, status: 'accepted' },
        { messageId: 'message-1', botId: 'unknown', status: 'responded' },
        { messageId: 'message-1', botId: 'failed', status: 'failed', error: 'Provider unavailable' },
        { messageId: 'message-3', botId: botB.id, status: 'failed', error: 'Still unavailable' },
        { messageId: 'message-3', botId: 'no-error', status: 'failed' },
      ],
      messages: [
        {
          ...group.messages[0]!,
          reactions: [{ emoji: '👍', count: 1, viewerReacted: true }, { emoji: '🎉', count: 2, viewerReacted: false }],
        },
        group.messages[1]!,
        { id: 'message-3', sender: { kind: 'user' }, text: 'Follow up on that source.', createdAt: 3, replyToMessageId: 'message-2' },
      ],
    }
    render(<BotGroupDetail
      group={detailed} bots={[botA, botB]} loading={false} error={null} onRetry={vi.fn()} onSend={onSend}
      onReact={onReact} onSendWithAttachments={onSendWithAttachments} loadAvatar={undefined} t={t}
    />)

    expect(screen.getByText('Sending to Research partner…')).toBeTruthy()
    expect(screen.getByText('Waiting for Release captain to reply…')).toBeTruthy()
    expect(screen.getByText('unknown replied')).toBeTruthy()
    expect(screen.getByText('failed could not reply: Provider unavailable')).toBeTruthy()
    expect(screen.getByText('no-error could not reply: Some Bots could not receive this message. Try again.')).toBeTruthy()
    const parent = document.getElementById('yharness-group-message-message-1')!
    const scroll = vi.fn()
    parent.scrollIntoView = scroll
    fireEvent.click(screen.getByRole('button', { name: 'Jump to You’s message' }))
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
    expect(screen.getByRole('link', { name: 'Download notes.txt' }).getAttribute('href')).toContain('attachment-1')

    fireEvent.click(screen.getByRole('button', { name: 'Reply to Research partner' }))
    expect(screen.getByText('Replying to Research partner')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear reply' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Reply to You' })[0]!)
    fireEvent.click(screen.getByRole('button', { name: 'Clear reply' }))
    const composer = screen.getByRole('textbox', { name: 'Message Release room' }) as HTMLTextAreaElement
    fireEvent.keyDown(composer, { key: 'Enter' })
    fireEvent.change(composer, { target: { value: '@', selectionStart: 1 } })
    fireEvent.keyDown(composer, { key: 'ArrowDown' })
    fireEvent.keyDown(composer, { key: 'ArrowUp' })
    fireEvent.keyDown(composer, { key: 'Escape' })
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true })
    fireEvent.change(composer, { target: { value: '@Res hello', selectionStart: 4 } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    fireEvent.change(composer, { target: { value: '@Res', selectionStart: 4 } })
    expect(screen.getByRole('option', { name: /Research partner/ })).toBeTruthy()
    fireEvent.change(composer, { target: { value: 'plain text', selectionStart: 10 } })
    expect(screen.queryByRole('listbox', { name: 'Mention a Bot' })).toBeNull()
    fireEvent.change(composer, { target: { value: '@Res', selectionStart: 4 } })
    const clickedMention = screen.getByRole('option', { name: /Research partner/ })
    if (clickedMention === null) throw new Error('Expected a visible mention option')
    fireEvent.mouseDown(clickedMention)
    fireEvent.click(clickedMention)
    fireEvent.change(composer, { target: { value: '@Res', selectionStart: 4 } })
    fireEvent.blur(composer, { relatedTarget: composer })
    const composerContainer = composer.parentElement
    if (composerContainer === null) throw new Error('Expected the composer to have a container')
    fireEvent.blur(composerContainer, { relatedTarget: document.body })
    expect(screen.queryByRole('listbox', { name: 'Mention a Bot' })).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Reply to You' })[0]!)
    fireEvent.change(composer, { target: { value: '@Res hello', selectionStart: 4 } })
    fireEvent.keyDown(composer, { key: 'Tab' })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => { expect(onSend).toHaveBeenCalledWith('@Research partner  hello', undefined, ['research'], 'message-1') })

    const reactionButton = screen.getAllByRole('button', { name: 'React to You’s message' })[0]!
    fireEvent.click(reactionButton)
    fireEvent.click(reactionButton)
    fireEvent.click(reactionButton)
    fireEvent.click(screen.getByRole('menuitem', { name: 'React with 😂' }))
    await waitFor(() => { expect(onReact).toHaveBeenCalledWith('message-1', '😂', 'add') })
    fireEvent.click(reactionButton)
    fireEvent.click(screen.getByRole('menuitem', { name: 'React with 👍' }))
    await waitFor(() => { expect(onReact).toHaveBeenCalledWith('message-1', '👍', 'remove') })
    fireEvent.click(screen.getByRole('button', { name: '👍, 1 reactions' }))
    await waitFor(() => { expect(onReact).toHaveBeenCalledWith('message-1', '👍', 'remove') })
    fireEvent.click(screen.getByRole('button', { name: '🎉, 2 reactions' }))
    await waitFor(() => { expect(onReact).toHaveBeenCalledWith('message-1', '🎉', 'add') })

    fireEvent.click(screen.getByRole('button', { name: 'Retry: failed' }))
    await waitFor(() => { expect(onSend).toHaveBeenCalledWith('Plan the release together.', 'message-1', undefined) })

    fireEvent.click(screen.getByRole('button', { name: 'Retry: Release captain' }))
    await waitFor(() => { expect(onSend).toHaveBeenCalledWith('Follow up on that source.', 'message-3', undefined, 'message-2') })

    fireEvent.click(screen.getAllByRole('button', { name: 'Reply to You' })[0]!)
    fireEvent.change(composer, { target: { value: '@Rel attachment', selectionStart: 4 } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByLabelText('Choose files'), { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => {
      expect(onSendWithAttachments).toHaveBeenCalledWith(
        '@Release captain  attachment', expect.anything(), expect.stringMatching(/^bot-group-message-/), ['release'], 'message-1',
      )
    })

    fireEvent.change(composer, { target: { value: '@Rel no reply', selectionStart: 4 } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    fireEvent.change(screen.getByLabelText('Choose files'), { target: { files: [new File(['more'], 'more.txt', { type: 'text/plain' })] } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => {
      expect(onSendWithAttachments).toHaveBeenCalledWith(
        '@Release captain  no reply', expect.anything(), expect.stringMatching(/^bot-group-message-/), ['release'],
      )
    })
  })

  it('previews and releases browser-owned image drafts when a group changes', async () => {
    const createObjectUrl = vi.fn().mockReturnValue('blob:bot-preview')
    const revokeObjectUrl = vi.fn()
    const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl })
    try {
      const view = render(<BotGroupDetail
        group={group} loading={false} error={null} onRetry={vi.fn()} onSend={vi.fn()}
        loadAvatar={undefined} t={t}
      />)
      fireEvent.change(screen.getByLabelText('Choose files'), {
        target: { files: [new File(['png'], 'preview.png', { type: 'image/png' })] },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Preview preview.png' }))
      expect(await screen.findByRole('dialog', { name: 'Image preview' })).toBeTruthy()
      view.rerender(<BotGroupDetail
        group={{ ...group, id: 'group-next' }} loading={false} error={null} onRetry={vi.fn()}
        onSend={vi.fn()} loadAvatar={undefined} t={t}
      />)
      expect(revokeObjectUrl).toHaveBeenCalledWith('blob:bot-preview')
    } finally {
      if (createObjectUrlDescriptor === undefined) Reflect.deleteProperty(URL, 'createObjectURL')
      else Object.defineProperty(URL, 'createObjectURL', createObjectUrlDescriptor)
      if (revokeObjectUrlDescriptor === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL')
      else Object.defineProperty(URL, 'revokeObjectURL', revokeObjectUrlDescriptor)
    }
  })

  it('keeps reaction chips inert when the optional reaction callback is absent', () => {
    const reactionGroup: BotGroupDetailData = {
      ...group,
      messages: [{
        ...group.messages[0]!,
        reactions: [{ emoji: '👍', count: 1, viewerReacted: false }],
      }],
    }
    render(<BotGroupDetail
      group={reactionGroup} bots={[botA, botB]} loading={false} error={null} onRetry={vi.fn()} onSend={vi.fn()}
      loadAvatar={undefined} t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: '👍, 1 reactions' }))
  })

  it('submits the new-Bot dialog from Enter after ignoring an empty submission', async () => {
    const create = vi.fn().mockResolvedValue(undefined)
    render(<BotRoster bots={[botA]} selectedBotId={botA.id} onSelectBot={vi.fn()} onCreateBot={create} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'New bot' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a bot' })
    const name = within(dialog).getByRole('textbox', { name: 'Bot name' })
    fireEvent.keyDown(name, { key: 'ArrowDown' })
    fireEvent.keyDown(name, { key: 'Enter' })
    expect(create).not.toHaveBeenCalled()
    fireEvent.change(name, { target: { value: 'Release helper' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    await waitFor(() => { expect(create).toHaveBeenCalledWith({ name: 'Release helper', identity: 'agent', accent: 'violet' }) })
  })

  it('keeps attachment drafts editable after a failed send and resets stale reply targets', async () => {
    const sendWithAttachments = vi.fn()
      .mockRejectedValueOnce('upload failed')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce({ code: 'upload-offline' })
    const { rerender } = render(<BotGroupDetail
      group={group} loading={false} error={null} onRetry={vi.fn()} onSend={vi.fn()}
      onSendWithAttachments={sendWithAttachments} loadAvatar={undefined} t={t}
    />)
    const composer = screen.getByRole('textbox', { name: 'Message Release room' })
    fireEvent.click(screen.getByRole('button', { name: 'Reply to You' }))
    fireEvent.change(composer, { target: { value: 'first draft' } })
    fireEvent.change(screen.getByLabelText('Choose files'), {
      target: { files: [new File(['one'], 'one.txt', { type: 'text/plain' }), new File(['two'], 'two.txt', { type: 'text/plain' })] },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Remove one.txt' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('Some Bots could not receive this message. Try again.') })
    fireEvent.change(composer, { target: { value: 'second draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => { expect(sendWithAttachments).toHaveBeenCalledTimes(2) })

    fireEvent.change(composer, { target: { value: 'object rejection' } })
    fireEvent.change(screen.getByLabelText('Choose files'), {
      target: { files: [new File(['three'], 'three.txt', { type: 'text/plain' })] },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('Some Bots could not receive this message. Try again.') })

    fireEvent.click(screen.getByRole('button', { name: 'Reply to You' }))
    rerender(<BotGroupDetail
      group={{ ...group, messages: [group.messages[1]!] }} loading={false} error={null} onRetry={vi.fn()}
      onSend={vi.fn()} loadAvatar={undefined} t={t}
    />)
    const staleComposer = screen.getByRole('textbox', { name: 'Message Release room' })
    fireEvent.change(staleComposer, { target: { value: 'stale reply' } })
    fireEvent.keyDown(staleComposer, { key: 'Enter' })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('no longer in this room') })
  })

  it('saves Bot profile fields and reports conflict, failure, cancellation, and replacement races', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    render(<BotDetail
      bot={{ ...botA, persona: 'Be precise', capabilities: ['chat', 'research'], updatedAt: 4 }} loading={false}
      loadAvatar={undefined} onUpdateProfile={save} t={t}
    ><span /></BotDetail>)
    chooseBotOption('Edit bot profile')
    let dialog = screen.getByRole('dialog', { name: 'Edit bot profile' })
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Cancel' })[0]!)
    chooseBotOption('Edit bot profile')
    dialog = screen.getByRole('dialog', { name: 'Edit bot profile' })
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Cancel' })[1]!)
    chooseBotOption('Edit bot profile')
    dialog = screen.getByRole('dialog', { name: 'Edit bot profile' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Bot name' }), { target: { value: 'Research lead' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'What it does' }), { target: { value: '  Plans releases  ' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Instructions' }), { target: { value: '  Verify each source  ' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Specialties' }), {
      target: { value: 'chat, research, chat, release-review' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save profile' }))
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith('research', {
        expectedUpdatedAt: 4, name: 'Research lead', description: 'Plans releases', persona: 'Verify each source',
        capabilities: ['chat', 'research', 'release-review'],
      })
    })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Edit bot profile' })).toBeNull() })

    const conflict = vi.fn().mockRejectedValue(Object.assign(new Error('conflict'), { name: 'BotProfileConflictError' }))
    cleanup()
    render(<BotDetail bot={botA} loading={false} loadAvatar={undefined} onUpdateProfile={conflict} t={t}><span /></BotDetail>)
    chooseBotOption('Edit bot profile')
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    expect((await screen.findByRole('alert')).textContent).toContain('changed elsewhere')

    const failed = vi.fn().mockRejectedValue(new Error('profile offline'))
    cleanup()
    render(<BotDetail bot={botA} loading={false} loadAvatar={undefined} onUpdateProfile={failed} t={t}><span /></BotDetail>)
    chooseBotOption('Edit bot profile')
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    expect((await screen.findByRole('alert')).textContent).toContain('could not be saved')

    const pending = Promise.withResolvers<undefined>()
    const pendingSave = vi.fn().mockReturnValue(pending.promise)
    cleanup()
    render(<BotDetail bot={botA} loading={false} loadAvatar={undefined} onUpdateProfile={pendingSave} t={t}><span /></BotDetail>)
    chooseBotOption('Edit bot profile')
    const pendingDialog = screen.getByRole('dialog', { name: 'Edit bot profile' })
    fireEvent.click(within(pendingDialog).getAllByRole('button', { name: 'Cancel' })[1]!)
    chooseBotOption('Edit bot profile')
    const savingDialog = screen.getByRole('dialog', { name: 'Edit bot profile' })
    fireEvent.click(within(savingDialog).getByRole('button', { name: 'Save profile' }))
    fireEvent.click(savingDialog.parentElement?.querySelector('[aria-hidden="true"]') as HTMLElement)
    expect(screen.getByRole('dialog', { name: 'Edit bot profile' })).toBeTruthy()
    pending.resolve(undefined)
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Edit bot profile' })).toBeNull() })

    const race = Promise.withResolvers<undefined>()
    const raceSave = vi.fn().mockReturnValue(race.promise)
    cleanup()
    const raceView = render(<BotDetail
      bot={botA} loading={false} loadAvatar={undefined} onUpdateProfile={raceSave} t={t}
    ><span /></BotDetail>)
    chooseBotOption('Edit bot profile')
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    raceView.rerender(<BotDetail bot={botB} loading={false} loadAvatar={undefined} onUpdateProfile={raceSave} t={t}><span /></BotDetail>)
    race.resolve(undefined)
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('dialog', { name: 'Edit bot profile' })).toBeNull()

    cleanup()
    render(<BotDetail bot={botC} loading={false} loadAvatar={undefined} onUpdateProfile={vi.fn()} t={t}><span /></BotDetail>)
    chooseBotOption('Edit bot profile')
    const sparseDialog = screen.getByRole('dialog', { name: 'Edit bot profile' })
    expect(within(sparseDialog).getByRole('textbox', { name: 'What it does' })).toHaveProperty('value', '')
    expect(within(sparseDialog).getByRole('textbox', { name: 'Instructions' })).toHaveProperty('value', '')
    expect(within(sparseDialog).getByRole('textbox', { name: 'Specialties' })).toHaveProperty('value', '')
    fireEvent.click(within(sparseDialog).getAllByRole('button', { name: 'Cancel' })[1]!)

  })

  it('shows section save failures and connected-app access failures', async () => {
    const sectionSave = Promise.withResolvers<undefined>()
    const organize = vi.fn().mockReturnValueOnce(sectionSave.promise).mockRejectedValueOnce(new Error('section unavailable'))
    const load = vi.fn<(botId: string) => Promise<readonly BotConnectedAppAccess[]>>().mockResolvedValue([
      { id: 'acme', name: 'Acme Tools', allowed: false },
      { id: 'single', name: 'A', allowed: false },
    ])
    const set = vi.fn()
      .mockRejectedValueOnce({ code: 'access-unavailable' })
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('access unavailable'))
    render(<BotRoster
      bots={[botA]} selectedBotId={botA.id} onSelectBot={vi.fn()} onCreateBot={vi.fn()} onOrganizeBot={organize}
      onLoadConnectedApps={load} onSetConnectedAppAccess={set} t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Bot actions for Research partner' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set section…' }))
    const section = screen.getByRole('dialog', { name: 'Organize bot' })
    fireEvent.change(within(section).getByRole('textbox', { name: 'Section name' }), { target: { value: 'Planning' } })
    fireEvent.keyDown(within(section).getByRole('textbox', { name: 'Section name' }), { key: 'ArrowDown' })
    fireEvent.keyDown(within(section).getByRole('textbox', { name: 'Section name' }), { key: 'Enter' })
    fireEvent.keyDown(within(section).getByRole('textbox', { name: 'Section name' }), { key: 'Enter' })
    sectionSave.reject({ code: 'section-unavailable' })
    expect((await screen.findByRole('alert')).textContent).toContain('The bot organization could not be saved. Try again.')
    fireEvent.click(within(section).getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toContain('section unavailable')

    fireEvent.click(within(section).getAllByRole('button', { name: 'Cancel' })[1]!)
    fireEvent.click(screen.getByRole('button', { name: 'Bot actions for Research partner' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'App access' }))
    const apps = await screen.findByRole('dialog', { name: 'Connected apps' })
    await waitFor(() => { expect(within(apps).getAllByText('Acme Tools')).toHaveLength(2) })
    expect(apps.querySelector('[data-app-id="acme"]')?.textContent).toContain('AT')
    expect(apps.querySelector('[data-app-id="single"]')?.textContent).toContain('A')
    fireEvent.click(within(apps).getByRole('button', { name: 'Grant access to Acme Tools' }))
    expect((await within(apps).findByRole('alert')).textContent).toContain('That access change could not be saved. Try again.')
    fireEvent.click(within(apps).getByRole('button', { name: 'Grant access to A' }))
    await waitFor(() => { expect(set).toHaveBeenCalledTimes(2) })
    expect(within(apps).getByRole('button', { name: 'Revoke access to A' })).toBeTruthy()
    fireEvent.click(within(apps).getByRole('button', { name: 'Revoke access to A' }))
    expect((await within(apps).findByRole('alert')).textContent).toContain('access unavailable')
  })

  it('cancels stale connected-app loads when its dialog closes', async () => {
    const load = Promise.withResolvers<readonly BotConnectedAppAccess[]>()
    const loadApps = vi.fn().mockReturnValue(load.promise)
    render(<BotRoster
      bots={[botA]} selectedBotId={botA.id} onSelectBot={vi.fn()} onCreateBot={vi.fn()}
      onLoadConnectedApps={loadApps} onSetConnectedAppAccess={vi.fn()} t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Bot actions for Research partner' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'App access' }))
    const apps = await screen.findByRole('dialog', { name: 'Connected apps' })
    fireEvent.click(within(apps).getByRole('button', { name: 'Done' }))
    load.reject(new Error('dialog closed'))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.queryByRole('dialog', { name: 'Connected apps' })).toBeNull()

    cleanup()
    const secondLoad = Promise.withResolvers<readonly BotConnectedAppAccess[]>()
    const loadAgain = vi.fn().mockReturnValue(secondLoad.promise)
    render(<BotRoster
      bots={[botA]} selectedBotId={botA.id} onSelectBot={vi.fn()} onCreateBot={vi.fn()}
      onLoadConnectedApps={loadAgain} onSetConnectedAppAccess={vi.fn()} t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Bot actions for Research partner' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'App access' }))
    const secondApps = await screen.findByRole('dialog', { name: 'Connected apps' })
    fireEvent.click(within(secondApps).getByRole('button', { name: 'Done' }))
    secondLoad.resolve([])
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.queryByRole('dialog', { name: 'Connected apps' })).toBeNull()

    cleanup()
    const unavailable = vi.fn().mockRejectedValue('load unavailable')
    render(<BotRoster
      bots={[botA]} selectedBotId={botA.id} onSelectBot={vi.fn()} onCreateBot={vi.fn()}
      onLoadConnectedApps={unavailable} onSetConnectedAppAccess={vi.fn()} t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Bot actions for Research partner' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'App access' }))
    const unavailableApps = await screen.findByRole('dialog', { name: 'Connected apps' })
    expect((await within(unavailableApps).findByRole('alert')).textContent).toContain('Connected apps could not be loaded. Try again.')
  })

  it('ignores connected-app saves that finish after the dialog is reopened', async () => {
    const firstSave = Promise.withResolvers<undefined>()
    const secondSave = Promise.withResolvers<undefined>()
    const loadApps = vi.fn()
      .mockResolvedValue([{ id: 'acme', name: 'Acme Tools', allowed: false }])
    const setAccess = vi.fn()
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise)
    const view = render(<BotRoster
      bots={[botA]} selectedBotId={botA.id} onSelectBot={vi.fn()} onCreateBot={vi.fn()}
      onLoadConnectedApps={loadApps} onSetConnectedAppAccess={setAccess} t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'Bot actions for Research partner' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'App access' }))
    const apps = await screen.findByRole('dialog', { name: 'Connected apps' })
    await waitFor(() => { expect(within(apps).getByRole('button', { name: 'Grant access to Acme Tools' })).toBeTruthy() })
    fireEvent.click(within(apps).getByRole('button', { name: 'Grant access to Acme Tools' }))
    expect(setAccess).toHaveBeenCalledWith(botA.id, 'acme', true)

    view.rerender(<BotRoster
      bots={[]} selectedBotId={null} onSelectBot={vi.fn()} onCreateBot={vi.fn()}
      onLoadConnectedApps={loadApps} onSetConnectedAppAccess={setAccess} t={t}
    />)
    view.rerender(<BotRoster
      bots={[botA]} selectedBotId={botA.id} onSelectBot={vi.fn()} onCreateBot={vi.fn()}
      onLoadConnectedApps={loadApps} onSetConnectedAppAccess={setAccess} t={t}
    />)
    const reopened = await screen.findByRole('dialog', { name: 'Connected apps' })
    await waitFor(() => { expect(within(reopened).getByRole('button', { name: 'Grant access to Acme Tools' })).toBeTruthy() })
    firstSave.resolve(undefined)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(within(reopened).queryByRole('alert')).toBeNull()

    fireEvent.click(within(reopened).getByRole('button', { name: 'Grant access to Acme Tools' }))
    view.rerender(<BotRoster
      bots={[]} selectedBotId={null} onSelectBot={vi.fn()} onCreateBot={vi.fn()}
      onLoadConnectedApps={loadApps} onSetConnectedAppAccess={setAccess} t={t}
    />)
    view.rerender(<BotRoster
      bots={[botA]} selectedBotId={botA.id} onSelectBot={vi.fn()} onCreateBot={vi.fn()}
      onLoadConnectedApps={loadApps} onSetConnectedAppAccess={setAccess} t={t}
    />)
    const reopenedAfterFailure = await screen.findByRole('dialog', { name: 'Connected apps' })
    await waitFor(() => { expect(within(reopenedAfterFailure).getByRole('button', { name: 'Grant access to Acme Tools' })).toBeTruthy() })
    secondSave.reject(new Error('stale save'))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(within(reopenedAfterFailure).queryByRole('alert')).toBeNull()
  })

  it('covers direct detail controls and closes routine management from the header', async () => {
    const rename = vi.fn().mockResolvedValue(undefined)
    const editAvatar = vi.fn()
    const routineActions = {
      list: vi.fn().mockResolvedValue([]),
      pause: vi.fn().mockRejectedValue(new Error('unused')),
      resume: vi.fn().mockRejectedValue(new Error('unused')),
      remove: vi.fn().mockResolvedValue(undefined),
      history: vi.fn().mockResolvedValue({ kind: 'event' as const, id: 'unused', deliveries: [], results: [] }),
    }
    const activityBot: BotSummary = {
      id: 'activity', name: 'Activity bot', identity: 'agent', accent: 'teal', status: 'working', activity: 'Working now',
    }
    render(<BotDetail
      bot={activityBot} loading={false} loadAvatar={undefined} onRename={rename} onEditAvatar={editAvatar}
      routineManager={routineActions} t={t}
    ><span /></BotDetail>)
    expect(screen.getByRole('status').textContent).toContain('Working now')
    chooseBotOption('Edit avatar')
    expect(editAvatar).toHaveBeenCalledOnce()
    chooseBotOption('Rename bot')
    const renameDialog = screen.getByRole('dialog', { name: 'Rename bot' })
    fireEvent.click(within(renameDialog).getAllByRole('button', { name: 'Cancel' })[0]!)
    chooseBotOption('Rename bot')
    const reopenedRenameDialog = screen.getByRole('dialog', { name: 'Rename bot' })
    fireEvent.click(within(reopenedRenameDialog).getAllByRole('button', { name: 'Cancel' })[1]!)
    chooseBotOption('Rename bot')
    fireEvent.change(screen.getByRole('textbox', { name: 'Bot name' }), { target: { value: 'Activity lead' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    await waitFor(() => { expect(rename).toHaveBeenCalledWith('activity', 'Activity lead') })
    chooseBotOption('Manage routines')
    const routines = await screen.findByRole('dialog', { name: 'Bot routines' })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Bot routines' })).toBeNull() })
    expect(routines).toBeTruthy()

    cleanup()
    const pendingRename = Promise.withResolvers<undefined>()
    const renameWhileSaving = vi.fn().mockReturnValue(pendingRename.promise)
    render(<BotDetail bot={activityBot} loading={false} loadAvatar={undefined} onRename={renameWhileSaving} t={t}><span /></BotDetail>)
    chooseBotOption('Rename bot')
    const savingRenameDialog = screen.getByRole('dialog', { name: 'Rename bot' })
    fireEvent.click(within(savingRenameDialog).getByRole('button', { name: 'Save name' }))
    fireEvent.click(within(savingRenameDialog).getAllByRole('button', { name: 'Cancel' })[0]!)
    expect(screen.getByRole('dialog', { name: 'Rename bot' })).toBeTruthy()
    pendingRename.resolve(undefined)
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Rename bot' })).toBeNull() })
  })

  it('keeps collapsed-rail actions wired for groups, shared owner setup, and templates', async () => {
    const expand = vi.fn()
    const getOwnerCapability = vi.fn<NonNullable<SharedBotsClient['getOwnerCapability']>>().mockResolvedValue({ ownerBootstrap: true })
    const sharedClient = sharedRailClient(getOwnerCapability)
    const actions: BotTemplateActions = {
      setTemplateCode: vi.fn(), publishTemplate: vi.fn().mockResolvedValue(undefined), revokeTemplate: vi.fn().mockResolvedValue(undefined),
      previewTemplate: vi.fn().mockResolvedValue(undefined), importTemplate: vi.fn().mockResolvedValue(undefined),
    }
    const localGroup: BotGroupSummary = { id: 'local-group', name: 'Local room', bots: [botA, botB, botC, botD] }
    const selectGroup = vi.fn()
    render(<BotRoster
      bots={[botA, botC, plainBot]} groups={[localGroup]} selectedBotId={botA.id} selectedGroupId="local-group"
      onSelectBot={vi.fn()} onSelectGroup={selectGroup} onCreateBot={vi.fn()} onCreateGroup={vi.fn()}
      sharedClient={sharedClient} templates={templateState} templateActions={actions} expandSidebar={expand} wide={false} t={t}
    />)
    await waitFor(() => { expect(getOwnerCapability).toHaveBeenCalledOnce() })
    chooseBotOption('Create a shared group', en.rosterMenu)
    expect(expand).toHaveBeenCalled()
    expect(await screen.findByRole('dialog', { name: 'Shared with you' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'New bot group' }))
    expect(screen.getByRole('dialog', { name: 'Create a bot group' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    chooseBotOption('Bot templates', en.rosterMenu)
    expect(screen.getByRole('dialog', { name: 'Bot templates' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Local room' }))
    expect(selectGroup).toHaveBeenCalledWith('local-group')
    expect(screen.getByRole('button', { name: 'Plain bot' }).querySelector('[data-accent="violet"]')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Design guide' })).toBeTruthy()

    cleanup()
    render(<BotRoster
      bots={[botA]} groups={[localGroup]} selectedBotId={botA.id} selectedGroupId={null}
      onSelectBot={vi.fn()} onSelectGroup={selectGroup} onCreateBot={vi.fn()} onCreateGroup={vi.fn()}
      wide={false} t={t}
    />)
    expect(screen.getByRole('button', { name: 'Local room' }).getAttribute('aria-current')).toBeNull()

    cleanup()
    const wideCapability = vi.fn<NonNullable<SharedBotsClient['getOwnerCapability']>>().mockResolvedValue({ ownerBootstrap: true })
    render(<BotRoster
      bots={[botA]} selectedBotId={botA.id} onSelectBot={vi.fn()} onCreateBot={vi.fn()}
      sharedClient={sharedRailClient(wideCapability)} t={t}
    />)
    await waitFor(() => { expect(wideCapability).toHaveBeenCalledOnce() })
    chooseBotOption('Join a shared bot', en.rosterMenu)
    expect(await screen.findByRole('dialog', { name: 'Shared with you' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    chooseBotOption('Create a shared group', en.rosterMenu)
    expect(await screen.findByRole('dialog', { name: 'Shared with you' })).toBeTruthy()
  })

  it('ignores stale owner capability results and callbacks after unmount', async () => {
    const first = Promise.withResolvers<{ ownerBootstrap: boolean }>()
    const second = Promise.withResolvers<{ ownerBootstrap: boolean }>()
    let invalidate: (() => void) | undefined
    const getOwnerCapability = vi.fn<NonNullable<SharedBotsClient['getOwnerCapability']>>()
      .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const sharedClient = {
      ...sharedRailClient(getOwnerCapability),
      subscribeOwnerCapability: (listener: () => void) => { invalidate = listener; return () => {} },
    }
    const view = render(<BotRoster
      bots={[botA]} selectedBotId={botA.id} onSelectBot={vi.fn()} onCreateBot={vi.fn()}
      sharedClient={sharedClient} t={t}
    />)
    await waitFor(() => { expect(getOwnerCapability).toHaveBeenCalledOnce() })
    invalidate?.()
    first.resolve({ ownerBootstrap: true })
    second.resolve({ ownerBootstrap: false })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    view.unmount()
    invalidate?.()

    const rejected = Promise.withResolvers<{ ownerBootstrap: boolean }>()
    const failing = vi.fn<NonNullable<SharedBotsClient['getOwnerCapability']>>().mockReturnValue(rejected.promise)
    const unmounted = render(<BotRoster
      bots={[botA]} selectedBotId={botA.id} onSelectBot={vi.fn()} onCreateBot={vi.fn()}
      sharedClient={sharedRailClient(failing)} t={t}
    />)
    await waitFor(() => { expect(failing).toHaveBeenCalledOnce() })
    unmounted.unmount()
    rejected.reject(new Error('connection closed'))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    const currentFailure = vi.fn<NonNullable<SharedBotsClient['getOwnerCapability']>>().mockRejectedValue(new Error('probe failed'))
    render(<BotRoster
      bots={[botA]} selectedBotId={botA.id} onSelectBot={vi.fn()} onCreateBot={vi.fn()}
      sharedClient={sharedRailClient(currentFailure)} t={t}
    />)
    await waitFor(() => { expect(currentFailure).toHaveBeenCalledOnce() })
    fireEvent.click(screen.getByRole('button', { name: en.rosterMenu }))
    await waitFor(() => { expect(screen.getByRole('menuitem', { name: 'Create a shared group' })).toHaveProperty('disabled', true) })

    cleanup()
    const collapsedFailure = vi.fn<NonNullable<SharedBotsClient['getOwnerCapability']>>()
      .mockRejectedValue(new Error('collapsed probe failed'))
    render(<BotRoster
      bots={[botA]} selectedBotId={botA.id} onSelectBot={vi.fn()} onCreateBot={vi.fn()}
      sharedClient={sharedRailClient(collapsedFailure)} wide={false} t={t}
    />)
    await waitFor(() => { expect(collapsedFailure).toHaveBeenCalledOnce() })
    fireEvent.click(screen.getByRole('button', { name: en.rosterMenu }))
    expect(screen.getByRole('menuitem', { name: 'Create a shared group' })).toHaveProperty('disabled', true)
  })

  it('filters local groups and exposes selected-group load failures', () => {
    const retry = vi.fn()
    const localGroup: BotGroupSummary = { id: 'local-group', name: 'Local room', bots: [botA, botB] }
    render(<BotRoster
      bots={[botA]} groups={[localGroup]} selectedBotId={botA.id} selectedGroupId={null}
      onSelectBot={vi.fn()} onCreateBot={vi.fn()} onCreateGroup={vi.fn()} groupError="Group load failed" onRetry={retry} t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledOnce()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search bots' }), { target: { value: 'missing group' } })
    expect(screen.getAllByText('No bots match that search')[0]).toBeTruthy()

    cleanup()
    render(<BotRoster
      bots={[botA]} groups={[]} selectedBotId={botA.id} onSelectBot={vi.fn()} onCreateBot={vi.fn()}
      onCreateGroup={vi.fn()} groupError="" t={t}
    />)
    expect(screen.getByRole('alert').textContent).toContain('This group could not be loaded.')
  })

  it('opens the Bot share button from the selected Bot detail', async () => {
    const share: BotShareActions = {
      listMembers: vi.fn().mockResolvedValue({ botId: botA.id, members: [] }),
      createInvite: vi.fn(),
      revokeMember: vi.fn(),
    }
    render(<BotDetail bot={botA} loading={false} loadAvatar={undefined} share={share} t={t}><span /></BotDetail>)
    chooseBotOption('Share bot')
    expect(await screen.findByRole('dialog', { name: 'Share this bot' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Share this bot' })).toBeNull()
  })
})
