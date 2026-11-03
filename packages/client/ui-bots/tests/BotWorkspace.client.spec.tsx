// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@yharness/attachment'
import { makeTranslate } from '@yharness/client-test-runtime'
import type { ReactNode } from 'react'
import { BotAvatar } from '../src/client/BotAvatar.tsx'
import { BotDetail, BotGroupDetail, BotRoster } from '../src/client/BotWorkspace.tsx'
import { en } from '../src/client/locales.ts'
import type { BotGroupDetailData, BotGroupSummary, BotMemoryManagerActions, BotSummary, BotWorkspaceProps } from '../src/client/types.ts'

afterEach(cleanup)

const t = makeTranslate(en)

const bots: readonly BotSummary[] = [
  {
    id: 'research',
    name: 'Research partner',
    description: 'Source scout',
    group: 'Research',
    preview: 'Comparing the latest sources',
    activity: '2 min ago',
    status: 'working',
    unread: 2,
    identity: 'browse',
    accent: 'teal',
  },
  {
    id: 'release',
    name: 'Release captain',
    description: 'Shipping companion',
    group: 'Build',
    status: 'idle',
    identity: 'goal',
    accent: 'amber',
  },
]

const sharedGroup: BotGroupSummary = {
  id: 'group-release',
  name: 'Release room',
  bots: [bots[0]!, bots[1]!],
}

const groupDetail: BotGroupDetailData = {
  ...sharedGroup,
  messages: [
    { id: 'message-1', sender: { kind: 'user' }, text: 'Plan the release together.', createdAt: 1 },
    { id: 'message-2', sender: { kind: 'bot', botId: 'research', name: 'Research partner' }, text: 'I found three useful sources.', createdAt: 2 },
  ],
}

function renderSplitWorkspace(overrides: Partial<BotWorkspaceProps> = {}, children: ReactNode = <p>Persistent session surface</p>) {
  const props: BotWorkspaceProps = {
    bots,
    selectedBotId: 'research',
    onSelectBot: vi.fn(),
    onCreateBot: vi.fn(),
    ...overrides,
  }
  const selectedBot = props.bots.find(bot => bot.id === props.selectedBotId)
  return render(<>
    <BotRoster {...props} t={t} />
    <BotDetail
      bot={selectedBot}
      children={children}
      t={t}
      loadAvatar={props.loadAvatar}
      loading={props.loading ?? false}
    />
  </>)
}

describe('Bot roster and detail', () => {
  it('renames the selected bot from its conversation header', async () => {
    const rename = vi.fn(async () => {})
    render(<BotDetail bot={bots[0]} loading={false} loadAvatar={undefined} t={t} onRename={rename}><span /></BotDetail>)
    fireEvent.click(screen.getByRole('button', { name: 'Rename bot' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Bot name' }), { target: { value: 'Market scout' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    await waitFor(() => { expect(rename).toHaveBeenCalledWith('research', 'Market scout') })
  })

  it('keeps the rename dialog open when saving fails', async () => {
    const rename = vi.fn(async () => { throw new Error('offline') })
    render(<BotDetail bot={bots[0]} loading={false} loadAvatar={undefined} t={t} onRename={rename}><span /></BotDetail>)
    fireEvent.click(screen.getByRole('button', { name: 'Rename bot' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Bot name' }), { target: { value: 'Market scout' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    expect((await screen.findByRole('alert')).textContent).toContain('The name could not be saved')
    expect(screen.getByRole('textbox', { name: 'Bot name' })).toHaveProperty('value', 'Market scout')
  })
  it('renders the roster as a standalone sidebar surface', () => {
    const onSelectBot = vi.fn()
    render(<BotRoster
      bots={bots}
      selectedBotId="research"
      onSelectBot={onSelectBot}
      onCreateBot={vi.fn()}
      t={t}
    />)

    expect(screen.getByRole('complementary', { name: 'Bot workspace' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Research partner, Working/ }).getAttribute('aria-current')).toBe('page')
    expect(screen.queryByText('Persistent session surface')).toBeNull()
  })

  it('keeps bot selection and creation usable in the collapsed sidebar rail', () => {
    const onSelectBot = vi.fn()
    const expandSidebar = vi.fn()
    render(<BotRoster
      bots={bots}
      selectedBotId="research"
      onSelectBot={onSelectBot}
      onCreateBot={vi.fn()}
      expandSidebar={expandSidebar}
      wide={false}
      t={t}
    />)

    expect(screen.queryByRole('textbox', { name: 'Search bots' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Release captain, Idle/ }))
    expect(onSelectBot).toHaveBeenCalledWith('release')
    fireEvent.click(screen.getByRole('button', { name: 'New bot' }))
    expect(expandSidebar).toHaveBeenCalledOnce()
    expect(screen.getByRole('dialog', { name: 'Create a bot' })).toBeTruthy()
  })

  it('renders the selected detail as a standalone main surface', () => {
    render(<BotDetail
      bot={bots[0]}
      loading={false}
      loadAvatar={undefined}
      t={t}
    >
      <p>Persistent session surface</p>
    </BotDetail>)

    expect(screen.getByRole('region', { name: 'Research partner' })).toBeTruthy()
    expect(screen.getByText('Persistent session surface')).toBeTruthy()
    expect(screen.queryByRole('complementary', { name: 'Bot workspace' })).toBeNull()
  })

  it('opens the selected bot memory manager from the detail header without adding a sidebar', async () => {
    const actions: BotMemoryManagerActions = {
      list: vi.fn(async () => []),
      update: vi.fn(),
      remove: vi.fn(),
    }
    render(<BotDetail
      bot={bots[0]}
      loading={false}
      loadAvatar={undefined}
      memoryManager={actions}
      t={t}
    >
      <p>Persistent session surface</p>
    </BotDetail>)

    fireEvent.click(screen.getByRole('button', { name: 'Manage memories' }))
    expect(await screen.findByRole('dialog', { name: 'Bot memory' })).toBeTruthy()
    expect(actions.list).toHaveBeenCalledWith('research')
    expect(screen.queryByRole('complementary', { name: 'Bot workspace' })).toBeNull()
  })

  it('renders each persisted identity as an original character silhouette with its chosen color', () => {
    render(<div>
      <BotAvatar name="Bean" identity="agent" accent="violet" />
      <BotAvatar name="Spark" identity="sparkle" accent="blue" />
      <BotAvatar name="Orbit" identity="goal" accent="amber" />
      <BotAvatar name="Blink" identity="browse" accent="teal" />
      <BotAvatar name="Sprout" identity="skill" accent="rose" />
      <BotAvatar name="Buddy" identity="workspace" accent="lime" />
    </div>)

    for (const [name, identity, accent] of [
      ['Bean', 'agent', 'violet'],
      ['Spark', 'sparkle', 'blue'],
      ['Orbit', 'goal', 'amber'],
      ['Blink', 'browse', 'teal'],
      ['Sprout', 'skill', 'rose'],
      ['Buddy', 'workspace', 'lime'],
    ] as const) {
      const avatar = screen.getByLabelText(name)
      expect(avatar.getAttribute('data-identity')).toBe(identity)
      expect(avatar.getAttribute('data-accent')).toBe(accent)
      expect(avatar.querySelector('[aria-hidden="true"]')).not.toBeNull()
    }
  })

  it('renders a persisted Bot image when the owner resolves its readAvatar bytes', async () => {
    const avatar = {
      attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
      mediaType: 'image/png' as const,
      bytes: 3,
      width: 1,
      height: 1,
    }
    const loadAvatar = vi.fn().mockResolvedValue('data:image/png;base64,aW1n')
    renderSplitWorkspace({
      bots: [{ ...bots[0]!, avatar }],
      loadAvatar,
    })

    await waitFor(() => { expect(document.querySelector('img[src="data:image/png;base64,aW1n"]')).not.toBe(null) })
    expect(loadAvatar).toHaveBeenCalledWith('research', avatar)
  })

  it('keeps the roster grouped while showing the selected bot session surface', () => {
    renderSplitWorkspace()

    expect(screen.getByText('Bots')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Research' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Build' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Research partner, Working/ }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByText('Persistent session surface')).toBeTruthy()
  })

  it('keeps pinned bots first and exposes a recoverable hidden section', async () => {
    const onOrganizeBot = vi.fn().mockResolvedValue(undefined)
    render(<BotRoster
      bots={[
        { ...bots[0]!, pinned: true },
        { ...bots[1]!, hidden: true },
      ]}
      selectedBotId="research"
      onSelectBot={vi.fn()}
      onCreateBot={vi.fn()}
      onOrganizeBot={onOrganizeBot}
      t={t}
    />)

    expect(screen.getByRole('heading', { name: 'Pinned' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Hidden bots' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Bot actions for Release captain' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restore bot' }))

    await waitFor(() => {
      expect(onOrganizeBot).toHaveBeenCalledWith('release', { hidden: false })
    })
  })

  it('does not replace an all-hidden roster with a search empty state', () => {
    render(<BotRoster
      bots={bots.map(bot => ({ ...bot, hidden: true }))}
      selectedBotId="research"
      onSelectBot={vi.fn()}
      onCreateBot={vi.fn()}
      t={t}
    />)

    expect(screen.getByRole('heading', { name: 'Hidden bots' })).toBeTruthy()
    expect(screen.queryByText('No bots match that search')).toBeNull()
    expect(screen.getByRole('button', { name: /Research partner, Working/ })).toBeTruthy()
  })

  it('keeps reserved-looking section names distinct from menu actions and headings', () => {
    const onOrganizeBot = vi.fn().mockResolvedValue(undefined)
    const reservedBots = [
      { ...bots[0]!, group: 'none' },
      { ...bots[1]!, group: 'custom' },
      { ...bots[0]!, id: 'pinned-label', name: 'Pinned label', group: 'Pinned' },
      { ...bots[1]!, id: 'pinned-row', name: 'Pinned row', group: 'none', pinned: true },
    ]
    render(<BotRoster
      bots={reservedBots}
      selectedBotId="research"
      onSelectBot={vi.fn()}
      onCreateBot={vi.fn()}
      onOrganizeBot={onOrganizeBot}
      t={t}
    />)

    expect(screen.getAllByRole('heading', { name: 'Pinned' })).toHaveLength(2)
    expect(screen.getAllByRole('heading', { name: 'none' })).toHaveLength(1)
    expect(screen.getAllByRole('heading', { name: 'custom' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Bot actions for Research partner' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'none' }))

    expect(onOrganizeBot).toHaveBeenCalledWith('research', { group: 'none' })
  })

  it('lets the roster menu pin a bot and assign a section', async () => {
    const onOrganizeBot = vi.fn().mockResolvedValue(undefined)
    render(<BotRoster
      bots={bots}
      selectedBotId="research"
      onSelectBot={vi.fn()}
      onCreateBot={vi.fn()}
      onOrganizeBot={onOrganizeBot}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'Bot actions for Research partner' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pin bot' }))
    await waitFor(() => { expect(onOrganizeBot).toHaveBeenCalledWith('research', { pinned: true }) })

    fireEvent.click(screen.getByRole('button', { name: 'Bot actions for Research partner' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set section…' }))
    const dialog = screen.getByRole('dialog', { name: 'Organize bot' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Section name' }), { target: { value: 'Planning' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(onOrganizeBot).toHaveBeenCalledWith('research', { group: 'Planning' }) })
  })

  it('filters the roster without changing the selected bot session', () => {
    renderSplitWorkspace()

    fireEvent.change(screen.getByRole('textbox', { name: 'Search bots' }), { target: { value: 'shipping' } })

    expect(screen.getByRole('button', { name: /Release captain, Idle/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Research partner, Working/ })).toBeNull()
    expect(screen.getByText('Persistent session surface')).toBeTruthy()

    fireEvent.change(screen.getByRole('textbox', { name: 'Search bots' }), { target: { value: 'does-not-exist' } })
    expect(screen.getByText('No bots match that search')).toBeTruthy()
  })

  it('reports roster selection to the owner', () => {
    const onSelectBot = vi.fn()
    renderSplitWorkspace({ onSelectBot })

    fireEvent.click(screen.getByRole('button', { name: /Release captain, Idle/ }))

    expect(onSelectBot).toHaveBeenCalledWith('release')
  })

  it('returns the chosen identity and accent when a named bot is created', async () => {
    const onCreateBot = vi.fn()
    renderSplitWorkspace({ onCreateBot })

    fireEvent.click(screen.getByRole('button', { name: 'New bot' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a bot' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Bot name' }), { target: { value: 'Docs guide' } })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Teal' }))
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Mug character' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create bot' }))

    expect(onCreateBot).toHaveBeenCalledWith({ name: 'Docs guide', identity: 'browse', accent: 'teal' })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Create a bot' })).toBeNull() })
  })

  it('applies the chosen color to every character without resetting it when choosing a shape', () => {
    renderSplitWorkspace()
    fireEvent.click(screen.getByRole('button', { name: 'New bot' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a bot' })
    const characters = within(dialog).getByRole('radiogroup', { name: 'Character' })

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Amber' }))
    for (const option of within(characters).getAllByRole('radio')) {
      expect(option.getAttribute('data-accent')).toBe('amber')
      expect(option.querySelector('[data-identity]')?.getAttribute('data-accent')).toBe('amber')
    }
    fireEvent.click(within(characters).getByRole('radio', { name: 'Mug character' }))
    expect(within(dialog).getByRole('radio', { name: 'Amber' }).getAttribute('aria-checked')).toBe('true')
  })

  it('offers every local identity and accent without a remote image dependency', () => {
    renderSplitWorkspace()
    fireEvent.click(screen.getByRole('button', { name: 'New bot' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a bot' })

    for (const label of ['Controller character', 'Star character', 'Barbell character', 'Mug character', 'Flower character', 'Folder character', 'Round character', 'Cloud character', 'Square character', 'Clover character', 'Heart character', 'Drop character', 'Oval character', 'Triangle character']) {
      fireEvent.click(within(dialog).getByRole('radio', { name: label }))
    }
    for (const label of ['Blue', 'Teal', 'Amber', 'Violet', 'Rose', 'Lime']) {
      fireEvent.click(within(dialog).getByRole('radio', { name: label }))
    }

    expect(within(dialog).getByRole('radio', { name: 'Triangle character' }).getAttribute('aria-checked')).toBe('true')
    expect(within(dialog).getByRole('radio', { name: 'Lime' }).getAttribute('aria-checked')).toBe('true')
  })

  it('renders only owner-supplied conversation content when a Session is unavailable', () => {
    renderSplitWorkspace({}, null)

    expect(screen.getByText('This bot is ready for its first message.')).toBeTruthy()
  })

  it('keeps a provisioning bot honest while its Session is being prepared', () => {
    renderSplitWorkspace({
      bots: [{ id: 'preparing', name: 'Preparing bot', status: 'preparing', identity: 'agent', accent: 'violet' }],
      selectedBotId: 'preparing',
    }, null)

    expect(screen.getByRole('button', { name: 'Preparing bot, Preparing' })).toBeTruthy()
    expect(screen.getByText('Preparing this bot for its first message.')).toBeTruthy()
    expect(screen.queryByText('This bot is ready for its first message.')).toBeNull()
  })

  it.each([
    ['idle', 'Idle'],
    ['working', 'Working'],
    ['preparing', 'Preparing'],
    ['offline', 'Offline'],
  ] as const)('uses the supplied %s state without inventing a fallback', (status, label) => {
    renderSplitWorkspace({
      bots: [{ id: 'state', name: 'State bot', status, identity: 'agent', accent: 'violet' }],
      selectedBotId: 'state',
    })

    expect(screen.getByRole('button', { name: `State bot, ${label}` })).toBeTruthy()
    expect(screen.getByRole('button', { name: `State bot, ${label}` }).textContent).toContain(label)
  })

  it('keeps shared groups in the existing Bots sidebar and selects one without a second rail', () => {
    const onSelectGroup = vi.fn()
    render(<BotRoster
      bots={bots}
      groups={[sharedGroup]}
      selectedBotId={null}
      selectedGroupId={sharedGroup.id}
      onSelectBot={vi.fn()}
      onSelectGroup={onSelectGroup}
      onCreateBot={vi.fn()}
      onCreateGroup={vi.fn()}
      t={t}
    />)

    expect(screen.getByRole('complementary', { name: 'Bot workspace' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Shared groups' })).toBeTruthy()
    const row = screen.getByRole('button', { name: /Release room/ })
    expect(row.getAttribute('aria-current')).toBe('page')
    fireEvent.click(row)
    expect(onSelectGroup).toHaveBeenCalledWith(sharedGroup.id)
    expect(screen.queryByRole('complementary', { name: /Group/ })).toBeNull()
  })

  it('creates a shared group from two existing Bots', async () => {
    const onCreateGroup = vi.fn().mockResolvedValue(undefined)
    render(<BotRoster
      bots={bots}
      groups={[]}
      selectedBotId={bots[0]!.id}
      selectedGroupId={null}
      onSelectBot={vi.fn()}
      onSelectGroup={vi.fn()}
      onCreateBot={vi.fn()}
      onCreateGroup={onCreateGroup}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'New group' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a shared group' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Group name' }), { target: { value: 'Launch room' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Research partner' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Release captain' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create group' }))

    await waitFor(() => { expect(onCreateGroup).toHaveBeenCalledWith({ name: 'Launch room', botIds: ['research', 'release'] }) })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Create a shared group' })).toBeNull() })
  })

  it('renders the persistent group transcript, sends with Enter, and keeps a failed draft', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    const { rerender } = render(<BotGroupDetail
      group={groupDetail}
      loading={false}
      error={null}
      onRetry={vi.fn()}
      onSend={onSend}
      loadAvatar={undefined}
      t={t}
    />)

    expect(screen.getByRole('region', { name: 'Release room' })).toBeTruthy()
    expect(screen.getByText('Plan the release together.')).toBeTruthy()
    expect(screen.getByText('I found three useful sources.')).toBeTruthy()
    const composer = screen.getByRole('textbox', { name: 'Message Release room' })
    fireEvent.change(composer, { target: { value: 'What is left?' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => { expect(onSend).toHaveBeenCalledWith('What is left?') })

    const failed = vi.fn().mockRejectedValue(new Error('delivery failed'))
    rerender(<BotGroupDetail
      group={groupDetail}
      loading={false}
      error="Some Bots could not receive this message."
      onRetry={vi.fn()}
      onSend={failed}
      loadAvatar={undefined}
      t={t}
    />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Message Release room' }), { target: { value: 'Retry this' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => { expect(failed).toHaveBeenCalledWith('Retry this') })
    expect((screen.getByRole('textbox', { name: 'Message Release room' }) as HTMLTextAreaElement).value).toBe('Retry this')
    expect(screen.getByRole('alert').textContent).toContain('Some Bots could not receive')
  })

  it('shows persisted per-Bot turn failures and retries only the failed user message', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<BotGroupDetail
      group={{
        ...groupDetail,
        deliveries: [
          { messageId: 'message-1', botId: 'research', status: 'responded' },
          { messageId: 'message-1', botId: 'release', status: 'failed', error: 'Provider credentials are missing.' },
        ],
      }}
      bots={bots}
      loading={false}
      error={null}
      onRetry={vi.fn()}
      onSend={onSend}
      loadAvatar={undefined}
      t={t}
    />)

    expect(screen.getByText('Release captain could not reply: Provider credentials are missing.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry: Release captain' }))
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('Plan the release together.', 'message-1', undefined)
    })
  })

  it('offers member mentions and sends only to the selected Bot ids', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<BotGroupDetail
      group={groupDetail}
      bots={bots}
      loading={false}
      error={null}
      onRetry={vi.fn()}
      onSend={onSend}
      loadAvatar={undefined}
      t={t}
    />)

    const composer = screen.getByRole('textbox', { name: 'Message Release room' }) as HTMLTextAreaElement
    fireEvent.change(composer, { target: { value: '@Res', selectionStart: 4 } })
    expect(screen.getByRole('listbox', { name: 'Mention a Bot' })).toBeTruthy()
    fireEvent.keyDown(composer, { key: 'Enter' })
    fireEvent.change(composer, { target: { value: '@Research partner please review', selectionStart: 31 } })
    fireEvent.keyDown(composer, { key: 'Enter' })

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('@Research partner please review', undefined, ['research'])
    })
  })

  it('renames a group from its header edit dialog', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined)
    render(<BotGroupDetail
      group={groupDetail}
      bots={bots}
      loading={false}
      error={null}
      onRetry={vi.fn()}
      onUpdate={onUpdate}
      onSend={vi.fn()}
      loadAvatar={undefined}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit group' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit shared group' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Group name' }), { target: { value: 'Launch command room' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith({
        groupId: 'group-release', name: 'Launch command room', botIds: ['research', 'release'],
      })
    })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Edit shared group' })).toBeNull() })
  })

  it('keeps loading and owner-provided failures explicit', () => {
    renderSplitWorkspace({ bots: [], selectedBotId: null, loading: true })
    expect(screen.getByRole('status', { name: 'Loading bots' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Loading your bots' })).toBeTruthy()
    expect(screen.queryByText('Choose a bot to get started')).toBeNull()
    expect(screen.queryByText('Your workspace is ready')).toBeNull()

    cleanup()
    const onRetry = vi.fn()
    renderSplitWorkspace({ error: 'Network unavailable', onRetry })
    expect(screen.getByRole('alert').textContent).toContain('Network unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('offers a create action for an empty roster', () => {
    renderSplitWorkspace({ bots: [], selectedBotId: null })

    expect(screen.getByText('Your workspace is ready')).toBeTruthy()
    const createButtons = screen.getAllByRole('button', { name: 'New bot' })
    fireEvent.click(createButtons[createButtons.length - 1]!)
    expect(screen.getByRole('dialog', { name: 'Create a bot' })).toBeTruthy()
  })

  it('shows connections only when the owner supplies that capability', () => {
    const onConnectApps = vi.fn()
    renderSplitWorkspace({ onConnectApps })

    fireEvent.click(screen.getByRole('button', { name: 'App access' }))

    expect(onConnectApps).toHaveBeenCalledOnce()
  })

  it('loads connected apps for the selected Bot and exposes grant/revoke feedback', async () => {
    const onLoadConnectedApps = vi.fn().mockResolvedValue([
      { id: 'github', name: 'GitHub', description: 'Tools from GitHub', allowed: false },
    ])
    const onSetConnectedAppAccess = vi.fn().mockResolvedValue(undefined)
    renderSplitWorkspace({ onLoadConnectedApps, onSetConnectedAppAccess })

    fireEvent.click(screen.getByRole('button', { name: 'App access' }))
    const dialog = await screen.findByRole('dialog', { name: 'Connected apps' })
    await waitFor(() => { expect(onLoadConnectedApps).toHaveBeenCalledWith('research') })
    expect(dialog.querySelector('[data-app-id="github"]')).not.toBeNull()
    expect(within(dialog).getByText('Access not allowed')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant access to GitHub' }))
    await waitFor(() => { expect(onSetConnectedAppAccess).toHaveBeenCalledWith('research', 'github', true) })
    expect(within(dialog).getByText('Access allowed')).toBeTruthy()
  })

  it('keeps nameless connected apps distinct and accessible', async () => {
    const onLoadConnectedApps = vi.fn().mockResolvedValue([
      { id: 'custom-alpha', name: '', allowed: false },
      { id: 'custom-beta', name: '-', allowed: false },
    ])
    renderSplitWorkspace({
      onLoadConnectedApps,
      onSetConnectedAppAccess: vi.fn().mockResolvedValue(undefined),
    })

    fireEvent.click(screen.getByRole('button', { name: 'App access' }))
    const dialog = await screen.findByRole('dialog', { name: 'Connected apps' })
    await waitFor(() => { expect(onLoadConnectedApps).toHaveBeenCalledWith('research') })

    expect(within(dialog).getByText('Connected app custom-alpha')).toBeTruthy()
    expect(within(dialog).getByText('Connected app custom-beta')).toBeTruthy()
    expect(within(dialog).getByText('MCP tools from Connected app custom-alpha')).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Grant access to Connected app custom-alpha' })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Grant access to Connected app custom-beta' })).toBeTruthy()
    expect(dialog.querySelector('[data-app-id="custom-alpha"]')?.textContent).not.toBe('')
    expect(dialog.querySelector('[data-app-id="custom-beta"]')?.textContent).not.toBe('')
  })

  it('clears the previous Bot catalog when a reload fails', async () => {
    const onLoadConnectedApps = vi.fn()
      .mockResolvedValueOnce([
        { id: 'github', name: 'GitHub', description: 'Tools from GitHub', allowed: false },
      ])
      .mockRejectedValueOnce(new Error('catalog unavailable'))
    renderSplitWorkspace({
      onLoadConnectedApps,
      onSetConnectedAppAccess: vi.fn().mockResolvedValue(undefined),
    })

    fireEvent.click(screen.getByRole('button', { name: 'App access' }))
    const dialog = await screen.findByRole('dialog', { name: 'Connected apps' })
    await waitFor(() => { expect(dialog.querySelector('[data-app-id="github"]')).not.toBeNull() })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Connected apps' })).toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: 'App access' }))
    const reloadedDialog = await screen.findByRole('dialog', { name: 'Connected apps' })

    await waitFor(() => { expect(onLoadConnectedApps).toHaveBeenCalledTimes(2) })
    expect((await within(reloadedDialog).findByRole('alert')).textContent).toContain('catalog unavailable')
    expect(reloadedDialog.querySelector('[data-app-id="github"]')).toBeNull()
  })

  it('does not apply a completed toggle from a previous Bot to the current catalog', async () => {
    const save = Promise.withResolvers<undefined>()
    const onLoadConnectedApps = vi.fn()
      .mockResolvedValueOnce([
        { id: 'github', name: 'GitHub', description: 'Research tools', allowed: false },
      ])
      .mockResolvedValueOnce([
        { id: 'github', name: 'GitHub', description: 'Release tools', allowed: false },
      ])
    const onSetConnectedAppAccess = vi.fn().mockReturnValue(save.promise)
    const props: BotWorkspaceProps = {
      bots,
      selectedBotId: 'research',
      onSelectBot: vi.fn(),
      onCreateBot: vi.fn(),
      onLoadConnectedApps,
      onSetConnectedAppAccess,
    }
    const view = render(<BotRoster {...props} t={t} />)

    fireEvent.click(screen.getByRole('button', { name: 'App access' }))
    const dialog = await screen.findByRole('dialog', { name: 'Connected apps' })
    await waitFor(() => { expect(dialog.querySelector('[data-app-id="github"]')).not.toBeNull() })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant access to GitHub' }))
    await waitFor(() => { expect(onSetConnectedAppAccess).toHaveBeenCalledWith('research', 'github', true) })

    view.rerender(<BotRoster {...props} selectedBotId="release" t={t} />)
    await waitFor(() => { expect(onLoadConnectedApps).toHaveBeenCalledWith('release') })
    await waitFor(() => { expect(within(dialog).getByRole('button', { name: 'Grant access to GitHub' })).toBeTruthy() })

    save.resolve(undefined)
    await waitFor(() => { expect(within(dialog).getByRole('button', { name: 'Done' }).hasAttribute('disabled')).toBe(false) })
    await waitFor(() => { expect(within(dialog).getByRole('button', { name: 'Grant access to GitHub' })).toBeTruthy() })
  })

  it('checks generation, previews the returned image, and commits the selected avatar', async () => {
    const generatedAvatar = {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png' as const,
      bytes: 3,
      width: 1,
      height: 1,
    }
    const status = vi.fn().mockResolvedValue({ available: true, provider: 'openai', model: 'gpt-image-2.5-flare' })
    const generatedPreview = { data: 'aW1n', mediaType: 'image/png' as const }
    const generate = vi.fn().mockResolvedValue(generatedPreview)
    const commit = vi.fn().mockResolvedValue({ attachment: generatedAvatar })
    const update = vi.fn().mockResolvedValue(undefined)
    renderSplitWorkspace({ avatarEditor: { status, generate, commit, update } })

    fireEvent.click(screen.getByRole('button', { name: 'Edit avatar' }))
    const dialog = screen.getByRole('dialog', { name: 'Customize avatar' })
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Generate' }))
    await waitFor(() => { expect(status).toHaveBeenCalledOnce() })

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Avatar description' }), {
      target: { value: 'A cheerful midnight-blue fox with tiny round glasses' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate avatar' }))
    await waitFor(() => { expect(generate).toHaveBeenCalledWith({ description: 'A cheerful midnight-blue fox with tiny round glasses' }, expect.any(AbortSignal)) })
    expect(within(dialog).getByRole('img', { name: 'Generated avatar preview' }).getAttribute('src')).toBe('data:image/png;base64,aW1n')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Use this avatar' }))
    await waitFor(() => { expect(commit).toHaveBeenCalledWith(generatedPreview) })
    await waitFor(() => { expect(update).toHaveBeenCalledWith('research', generatedAvatar) })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Customize avatar' })).toBeNull() })
  })

  it('keeps a generated preview local when the editor is cancelled', async () => {
    const status = vi.fn().mockResolvedValue({ available: true, provider: 'openai', model: 'gpt-image-2.5-flare' })
    const generatedPreview = { data: 'aW1n', mediaType: 'image/png' as const }
    const generate = vi.fn().mockResolvedValue(generatedPreview)
    const commit = vi.fn()
    const update = vi.fn()
    renderSplitWorkspace({ avatarEditor: { status, generate, commit, update } })

    fireEvent.click(screen.getByRole('button', { name: 'Edit avatar' }))
    const dialog = screen.getByRole('dialog', { name: 'Customize avatar' })
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Generate' }))
    await waitFor(() => { expect(status).toHaveBeenCalledOnce() })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Avatar description' }), { target: { value: 'A tiny moonlit fox' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate avatar' }))
    await waitFor(() => { expect(within(dialog).getByRole('img', { name: 'Generated avatar preview' })).toBeTruthy() })

    const cancelButtons = within(dialog).getAllByRole('button', { name: 'Cancel' })
    fireEvent.click(cancelButtons[cancelButtons.length - 1]!)
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Customize avatar' })).toBeNull() })
    expect(commit).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('keeps the preview available when committing it fails', async () => {
    const status = vi.fn().mockResolvedValue({ available: true, provider: 'openai', model: 'gpt-image-2.5-flare' })
    const generatedPreview = { data: 'aW1n', mediaType: 'image/png' as const }
    const generate = vi.fn().mockResolvedValue(generatedPreview)
    const commit = vi.fn().mockRejectedValue(new Error('attachment storage unavailable'))
    const update = vi.fn()
    renderSplitWorkspace({ avatarEditor: { status, generate, commit, update } })

    fireEvent.click(screen.getByRole('button', { name: 'Edit avatar' }))
    const dialog = screen.getByRole('dialog', { name: 'Customize avatar' })
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Generate' }))
    await waitFor(() => { expect(status).toHaveBeenCalledOnce() })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Avatar description' }), { target: { value: 'A tiny moonlit fox' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate avatar' }))
    await waitFor(() => { expect(within(dialog).getByRole('img', { name: 'Generated avatar preview' })).toBeTruthy() })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Use this avatar' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('could not be saved') })
    expect(screen.getByRole('dialog', { name: 'Customize avatar' })).toBeTruthy()
    expect(update).not.toHaveBeenCalled()
  })

  it('reuses a committed preview when the Bot update needs a retry', async () => {
    const generatedAvatar = {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png' as const,
      bytes: 3,
      width: 1,
      height: 1,
    }
    const status = vi.fn().mockResolvedValue({ available: true, provider: 'openai', model: 'gpt-image-2.5-flare' })
    const generatedPreview = { data: 'aW1n', mediaType: 'image/png' as const }
    const generate = vi.fn().mockResolvedValue(generatedPreview)
    const commit = vi.fn().mockResolvedValue({ attachment: generatedAvatar })
    const update = vi.fn().mockRejectedValueOnce(new Error('temporary update failure')).mockResolvedValueOnce(undefined)
    renderSplitWorkspace({ avatarEditor: { status, generate, commit, update } })

    fireEvent.click(screen.getByRole('button', { name: 'Edit avatar' }))
    const dialog = screen.getByRole('dialog', { name: 'Customize avatar' })
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Generate' }))
    await waitFor(() => { expect(status).toHaveBeenCalledOnce() })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Avatar description' }), { target: { value: 'A tiny moonlit fox' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate avatar' }))
    await waitFor(() => { expect(within(dialog).getByRole('img', { name: 'Generated avatar preview' })).toBeTruthy() })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Use this avatar' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('could not be saved') })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use this avatar' }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Customize avatar' })).toBeNull() })

    expect(commit).toHaveBeenCalledOnce()
    expect(update).toHaveBeenNthCalledWith(1, 'research', generatedAvatar)
    expect(update).toHaveBeenNthCalledWith(2, 'research', generatedAvatar)
  })

  it('explains when OpenAI avatar generation is not configured and keeps generation disabled', async () => {
    const status = vi.fn().mockResolvedValue({
      available: false,
      provider: 'openai',
      model: 'gpt-image-2.5-flare',
      reason: 'openai-credential-not-configured',
    })
    const generate = vi.fn()
    const update = vi.fn()
    const onOpenAvatarSettings = vi.fn()
    renderSplitWorkspace({ avatarEditor: { status, generate, commit: vi.fn(), update }, onOpenAvatarSettings })

    fireEvent.click(screen.getByRole('button', { name: 'Edit avatar' }))
    const dialog = screen.getByRole('dialog', { name: 'Customize avatar' })
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Generate' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('OpenAI') })
    expect(within(dialog).getByRole('button', { name: 'Generate avatar' }).hasAttribute('disabled')).toBe(true)
    expect(generate).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open Settings' }))
    expect(onOpenAvatarSettings).toHaveBeenCalledOnce()
  })

  it('keeps the editor open and explains a generation failure', async () => {
    const status = vi.fn().mockResolvedValue({ available: true, provider: 'openai', model: 'gpt-image-2.5-flare' })
    const generate = vi.fn().mockRejectedValue(new Error('provider unavailable'))
    renderSplitWorkspace({ avatarEditor: { status, generate, commit: vi.fn(), update: vi.fn() } })

    fireEvent.click(screen.getByRole('button', { name: 'Edit avatar' }))
    const dialog = screen.getByRole('dialog', { name: 'Customize avatar' })
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Generate' }))
    await waitFor(() => { expect(status).toHaveBeenCalledOnce() })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Avatar description' }), { target: { value: 'A tiny moonlit fox' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate avatar' }))

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('could not be generated') })
    expect(screen.getByRole('dialog', { name: 'Customize avatar' })).toBeTruthy()
    expect(generate).toHaveBeenCalledOnce()
  })

  it('uses the localized generic failure when the owner supplies no error text', () => {
    renderSplitWorkspace({ error: '' })

    expect(screen.getByRole('alert').textContent).toContain('Bots could not be loaded.')
  })
})
