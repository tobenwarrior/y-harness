// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ReactNode } from 'react'
import { BotAvatar } from '../src/client/BotAvatar.tsx'
import { BotDetail, BotRoster } from '../src/client/BotWorkspace.tsx'
import { en } from '../src/client/locales.ts'
import type { BotSummary, BotWorkspaceProps } from '../src/client/types.ts'

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
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Blink' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create bot' }))

    expect(onCreateBot).toHaveBeenCalledWith({ name: 'Docs guide', identity: 'browse', accent: 'teal' })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Create a bot' })).toBeNull() })
  })

  it('offers every local identity and accent without a remote image dependency', () => {
    renderSplitWorkspace()
    fireEvent.click(screen.getByRole('button', { name: 'New bot' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a bot' })

    for (const label of ['Bean', 'Spark', 'Orbit', 'Blink', 'Sprout', 'Buddy']) {
      fireEvent.click(within(dialog).getByRole('radio', { name: label }))
    }
    for (const label of ['Blue', 'Teal', 'Amber', 'Violet', 'Rose', 'Lime']) {
      fireEvent.click(within(dialog).getByRole('radio', { name: label }))
    }

    expect(within(dialog).getByRole('radio', { name: 'Buddy' }).getAttribute('aria-checked')).toBe('true')
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

    fireEvent.click(screen.getByRole('button', { name: 'Connect apps' }))

    expect(onConnectApps).toHaveBeenCalledOnce()
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
