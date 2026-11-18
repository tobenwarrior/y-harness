// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@yharness/attachment'
import { makeTranslate } from '@yharness/client-test-runtime'
import type { AvatarGenerationStatus } from '@yharness/avatar-generation/types'
import { BotAvatarEditor } from '../src/client/BotAvatarEditor.tsx'
import { en } from '../src/client/locales.ts'
import type { BotAvatarEditorActions, BotSummary } from '../src/client/types.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const t = makeTranslate(en)

const bot: BotSummary = {
  id: 'bot-1',
  name: 'Release captain',
  identity: 'agent',
  accent: 'violet',
}

function renderEditor(actions: BotAvatarEditorActions, onClose = vi.fn(), selectedBot = bot) {
  return render(<BotAvatarEditor bot={selectedBot} actions={actions} open onClose={onClose} t={t} />)
}

type ReactClickProps = { readonly onClick?: (event: MouseEvent) => unknown }

function invokeClick(element: HTMLElement): void {
  const key = Object.keys(element).find(name => name.startsWith('__reactProps$'))
  if (key === undefined) throw new Error('Expected React click props')
  const props = Reflect.get(element, key) as ReactClickProps
  if (props.onClick === undefined) throw new Error('Expected React click handler')
  props.onClick(new MouseEvent('click', { bubbles: true }))
}

describe('BotAvatarEditor appearance controls', () => {
  it('uploads a selected image without requiring an image generation provider', async () => {
    const bitmap = { width: 400, height: 300, close: vi.fn() }
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
    const drawImage = vi.fn()
    const context = Object.create(null) as CanvasRenderingContext2D
    context.drawImage = drawImage
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AQID')
    const upload = vi.fn().mockResolvedValue(undefined)
    try {
      renderEditor({ upload, updateAppearance: vi.fn() })
      fireEvent.click(screen.getByRole('tab', { name: 'Upload' }))
      const file = new File(['image'], 'portrait.jpg', { type: 'image/jpeg' })
      fireEvent.change(screen.getByLabelText('Choose an image'), { target: { files: [file] } })
      await screen.findByAltText('Uploaded avatar preview')
      expect(drawImage).toHaveBeenLastCalledWith(bitmap, 50, 0, 300, 300, 0, 0, 512, 512)
      fireEvent.change(screen.getByRole('slider', { name: 'Horizontal position' }), { target: { value: '0' } })
      await waitFor(() => { expect(drawImage).toHaveBeenLastCalledWith(bitmap, 0, 0, 300, 300, 0, 0, 512, 512) })
      fireEvent.change(screen.getByRole('slider', { name: 'Zoom' }), { target: { value: '2' } })
      await waitFor(() => { expect(drawImage).toHaveBeenLastCalledWith(bitmap, 0, 75, 150, 150, 0, 0, 512, 512) })
      fireEvent.change(screen.getByRole('slider', { name: 'Vertical position' }), { target: { value: '100' } })
      await waitFor(() => { expect(drawImage).toHaveBeenLastCalledWith(bitmap, 0, 150, 150, 150, 0, 0, 512, 512) })
      fireEvent.click(screen.getByRole('button', { name: 'Use this avatar' }))
      await waitFor(() => { expect(upload).toHaveBeenCalledWith('bot-1', { data: 'AQID', mediaType: 'image/png' }) })
    } finally {
      getContext.mockRestore()
      toDataURL.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('rejects unsupported images before saving', async () => {
    const upload = vi.fn()
    renderEditor({ upload, updateAppearance: vi.fn() })
    fireEvent.click(screen.getByRole('tab', { name: 'Upload' }))
    fireEvent.change(screen.getByLabelText('Choose an image'), {
      target: { files: [new File(['text'], 'notes.txt', { type: 'text/plain' })] },
    })
    expect((await screen.findByRole('alert')).textContent).toContain('could not be opened')
    expect(upload).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('Choose an image'))
    fireEvent.change(screen.getByLabelText('Choose an image'), { target: { files: [] } })
    const large = new File([new Uint8Array(25 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' })
    fireEvent.change(screen.getByLabelText('Choose an image'), { target: { files: [large] } })
    expect((await screen.findByRole('alert')).textContent).toContain('could not be opened')
  })

  it('keeps the latest crop when image decoding completes out of order', async () => {
    let finishFirst!: (value: { width: number; height: number; close: () => void }) => void
    const first = { width: 400, height: 300, close: vi.fn() }
    const second = { width: 400, height: 300, close: vi.fn() }
    const decode = vi.fn().mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve })).mockResolvedValueOnce(second)
    vi.stubGlobal('createImageBitmap', decode)
    const drawImage = vi.fn()
    const context = Object.create(null) as CanvasRenderingContext2D
    context.drawImage = drawImage
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AQID')
    try {
      renderEditor({ upload: vi.fn(), updateAppearance: vi.fn() })
      fireEvent.click(screen.getByRole('tab', { name: 'Upload' }))
      fireEvent.change(screen.getByLabelText('Choose an image'), {
        target: { files: [new File(['image'], 'portrait.jpg', { type: 'image/jpeg' })] },
      })
      fireEvent.change(screen.getByRole('slider', { name: 'Horizontal position' }), { target: { value: '0' } })
      await screen.findByAltText('Uploaded avatar preview')
      finishFirst(first)
      await waitFor(() => { expect(first.close).toHaveBeenCalledOnce() })
      expect(drawImage).toHaveBeenCalledOnce()
      expect(drawImage).toHaveBeenCalledWith(second, 0, 0, 300, 300, 0, 0, 512, 512)
    } finally {
      getContext.mockRestore()
      toDataURL.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('discards a decoded upload when the editor closes', async () => {
    let finish!: (value: { width: number; height: number; close: () => void }) => void
    const closeBitmap = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn().mockReturnValue(new Promise((resolve) => { finish = resolve })))
    const onClose = vi.fn()
    try {
      renderEditor({ upload: vi.fn(), updateAppearance: vi.fn() }, onClose)
      fireEvent.click(screen.getByRole('tab', { name: 'Upload' }))
      fireEvent.change(screen.getByLabelText('Choose an image'), {
        target: { files: [new File(['image'], 'portrait.jpg', { type: 'image/jpeg' })] },
      })
      fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!)
      finish({ width: 200, height: 200, close: closeBitmap })
      await waitFor(() => { expect(closeBitmap).toHaveBeenCalledOnce() })
      expect(onClose).toHaveBeenCalledOnce()
      expect(screen.queryByAltText('Uploaded avatar preview')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('defaults to the character tab and keeps generation content inside Generate', async () => {
    const status = vi.fn().mockResolvedValue({ available: false, provider: 'openai', model: 'gpt-image-2.5-flare', reason: 'openai-provider-not-configured' })
    const actions: BotAvatarEditorActions = {
      status,
      generate: vi.fn(),
      commit: vi.fn(),
      update: vi.fn(),
      updateAppearance: vi.fn().mockResolvedValue(undefined),
    }
    renderEditor(actions)

    const dialog = await screen.findByRole('dialog', { name: 'Customize avatar' })
    const tabs = within(dialog).getByRole('tablist', { name: 'Avatar mode' })
    expect(within(tabs).getByRole('tab', { name: 'Character' }).getAttribute('aria-selected')).toBe('true')
    expect(within(dialog).queryByRole('textbox', { name: 'Avatar description' })).toBeNull()
    expect(within(dialog).getByRole('radiogroup', { name: 'Character' })).toBeTruthy()
    expect(status).not.toHaveBeenCalled()

    fireEvent.click(within(tabs).getByRole('tab', { name: 'Generate' }))
    expect(within(dialog).getByRole('textbox', { name: 'Avatar description' })).toBeTruthy()
    await waitFor(() => { expect(status).toHaveBeenCalledOnce() })

    fireEvent.click(within(tabs).getByRole('tab', { name: 'Character' }))
    expect(within(dialog).queryByRole('textbox', { name: 'Avatar description' })).toBeNull()
  })

  it('uses Generate as the only tab when appearance persistence is unavailable', async () => {
    const status = vi.fn().mockResolvedValue({ available: true, provider: 'openai', model: 'gpt-image-2.5-flare' })
    const actions: BotAvatarEditorActions = {
      status,
      generate: vi.fn(),
      commit: vi.fn(),
      update: vi.fn(),
    }
    renderEditor(actions)

    const dialog = await screen.findByRole('dialog', { name: 'Customize avatar' })
    const tabs = within(dialog).getByRole('tablist', { name: 'Avatar mode' })
    expect(within(tabs).queryByRole('tab', { name: 'Character' })).toBeNull()
    expect(within(tabs).getByRole('tab', { name: 'Generate' }).getAttribute('aria-selected')).toBe('true')
    expect(within(dialog).queryByRole('radiogroup', { name: 'Character' })).toBeNull()
    expect(within(dialog).getByRole('textbox', { name: 'Avatar description' })).toBeTruthy()
    await waitFor(() => { expect(status).toHaveBeenCalledOnce() })
  })

  it('uses Character as the only tab when image generation is unavailable', async () => {
    const updateAppearance = vi.fn().mockResolvedValue(undefined)
    const actions: BotAvatarEditorActions = { updateAppearance }
    const onClose = vi.fn()
    renderEditor(actions, onClose)

    const dialog = await screen.findByRole('dialog', { name: 'Customize avatar' })
    const tabs = within(dialog).getByRole('tablist', { name: 'Avatar mode' })
    expect(within(tabs).getByRole('tab', { name: 'Character' }).getAttribute('aria-selected')).toBe('true')
    expect(within(tabs).queryByRole('tab', { name: 'Generate' })).toBeNull()
    expect(within(dialog).getByRole('radiogroup', { name: 'Character' })).toBeTruthy()
    expect(within(dialog).queryByRole('textbox', { name: 'Avatar description' })).toBeNull()

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Amber' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save character' }))
    await waitFor(() => {
      expect(updateAppearance).toHaveBeenCalledWith('bot-1', {
        identity: 'agent', accent: 'amber', clearAvatar: true,
      })
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('previews every character with the selected color and saves the character atomically', async () => {
    const updateAppearance = vi.fn().mockResolvedValue(undefined)
    const actions: BotAvatarEditorActions = {
      status: vi.fn().mockResolvedValue({ available: false, provider: 'openai', model: 'gpt-image-2.5-flare', reason: 'openai-provider-not-configured' }),
      generate: vi.fn(),
      commit: vi.fn(),
      update: vi.fn(),
      updateAppearance,
    }
    const onClose = vi.fn()
    renderEditor(actions, onClose)

    const dialog = await screen.findByRole('dialog', { name: 'Customize avatar' })
    const characters = within(dialog).getByRole('radiogroup', { name: 'Character' })
    const colors = within(dialog).getByRole('radiogroup', { name: 'Color' })

    fireEvent.click(within(colors).getByRole('radio', { name: 'Amber' }))
    for (const choice of within(characters).getAllByRole('radio')) {
      expect(choice.getAttribute('data-accent')).toBe('amber')
      expect(choice.querySelector('[data-character]')?.getAttribute('data-accent')).toBe('amber')
    }
    fireEvent.click(within(characters).getByRole('radio', { name: 'Star character' }))
    expect(within(dialog).queryByText('Star character')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save character' }))

    await waitFor(() => {
      expect(updateAppearance).toHaveBeenCalledWith('bot-1', {
        identity: 'sparkle',
        accent: 'amber',
        clearAvatar: true,
      })
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('lets character changes save while image-generation availability is still loading', async () => {
    let resolveStatus: ((value: AvatarGenerationStatus) => void) | undefined
    const status = vi.fn().mockReturnValue(new Promise<AvatarGenerationStatus>((resolve) => { resolveStatus = resolve }))
    const updateAppearance = vi.fn().mockResolvedValue(undefined)
    const actions: BotAvatarEditorActions = {
      status,
      generate: vi.fn(),
      commit: vi.fn(),
      update: vi.fn(),
      updateAppearance,
    }
    const onClose = vi.fn()
    renderEditor(actions, onClose)

    const dialog = await screen.findByRole('dialog', { name: 'Customize avatar' })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Lime' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save character' }))

    await waitFor(() => { expect(updateAppearance).toHaveBeenCalledWith('bot-1', { identity: 'agent', accent: 'lime', clearAvatar: true }) })
    expect(onClose).toHaveBeenCalledOnce()
    resolveStatus?.({ available: false, provider: 'openai', model: 'gpt-image-2.5-flare', reason: 'openai-provider-not-configured' })
  })

  it('keeps an appearance save in flight when the roster or action references refresh', async () => {
    let resolveUpdate: (() => void) | undefined
    const updateAppearance = vi.fn().mockReturnValue(new Promise<void>((resolve) => { resolveUpdate = resolve }))
    const actions: BotAvatarEditorActions = {
      status: vi.fn(),
      generate: vi.fn(),
      commit: vi.fn(),
      update: vi.fn(),
      updateAppearance,
    }
    const onClose = vi.fn()
    const view = renderEditor(actions, onClose)

    const dialog = await screen.findByRole('dialog', { name: 'Customize avatar' })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Star character' }))
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Amber' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save character' }))
    await waitFor(() => { expect(updateAppearance).toHaveBeenCalledOnce() })

    const refreshedActions: BotAvatarEditorActions = {
      ...actions,
      status: vi.fn(),
      updateAppearance: vi.fn().mockResolvedValue(undefined),
    }
    view.rerender(<BotAvatarEditor
      bot={{ ...bot, identity: 'goal', accent: 'blue' }}
      actions={refreshedActions}
      open
      onClose={onClose}
      t={t}
    />)
    const saveButton = within(dialog).getByRole('button', { name: 'Saving character…' })
    expect(saveButton.hasAttribute('disabled')).toBe(true)
    expect(onClose).not.toHaveBeenCalled()

    resolveUpdate?.()
    await waitFor(() => { expect(onClose).toHaveBeenCalledOnce() })
    expect(updateAppearance).toHaveBeenCalledWith('bot-1', { identity: 'sparkle', accent: 'amber', clearAvatar: true })
  })

  it('maps every unavailable generation reason to its localized recovery message', async () => {
    const cases = [
      ['openai-provider-not-configured', en.avatarUnavailableProvider],
      ['openai-credential-not-configured', en.avatarUnavailableCredential],
      ['credential-store-unavailable', en.avatarUnavailableCredentialStore],
      ['invalid-credential-reference', en.avatarUnavailableCredential],
      ['attachments-unavailable', en.avatarUnavailableStorage],
    ] as const
    for (const [reason, message] of cases) {
      const onOpenSettings = vi.fn()
      const status = vi.fn().mockResolvedValue({
        available: false, provider: 'openai', model: 'gpt-image-2.5-flare', reason,
      } satisfies AvatarGenerationStatus)
      const view = render(<BotAvatarEditor
        bot={bot}
        actions={{ status, generate: vi.fn(), commit: vi.fn(), update: vi.fn() }}
        open
        onClose={vi.fn()}
        onOpenSettings={onOpenSettings}
        t={t}
      />)
      expect((await screen.findByRole('alert')).textContent).toContain(message)
      fireEvent.click(screen.getByRole('button', { name: en.avatarOpenSettings }))
      expect(onOpenSettings).toHaveBeenCalledOnce()
      view.unmount()
      cleanup()
    }
    const futureStatus = {
      available: false,
      provider: 'openai',
      model: 'gpt-image-2.5-flare',
      reason: 'attachments-unavailable',
    } satisfies AvatarGenerationStatus
    Object.defineProperty(futureStatus, 'reason', { value: 'future-unavailable' })
    render(<BotAvatarEditor
      bot={bot}
      actions={{ status: vi.fn().mockResolvedValue(futureStatus), generate: vi.fn(), commit: vi.fn(), update: vi.fn() }}
      open
      onClose={vi.fn()}
      t={t}
    />)
    expect((await screen.findByRole('alert')).textContent).toContain(en.avatarUnavailableStorage)
  })

  it('reports status failures and retries the availability check', async () => {
    const status = vi.fn()
      .mockRejectedValueOnce(new Error('status unavailable'))
      .mockResolvedValueOnce({ available: true, provider: 'openai', model: 'gpt-image-2.5-flare' } satisfies AvatarGenerationStatus)
    renderEditor({ status, generate: vi.fn(), commit: vi.fn(), update: vi.fn() })

    expect((await screen.findByRole('alert')).textContent).toContain('Could not check avatar generation. Try again.')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => { expect(status).toHaveBeenCalledTimes(2) })
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  })

  it('ignores status results that settle after leaving the generation tab', async () => {
    let resolveStatus: ((value: AvatarGenerationStatus) => void) | undefined
    let rejectStatus: ((reason: unknown) => void) | undefined
    const status = vi.fn()
      .mockReturnValueOnce(new Promise<AvatarGenerationStatus>((resolve) => { resolveStatus = resolve }))
      .mockReturnValueOnce(new Promise<AvatarGenerationStatus>((_resolve, reject) => { rejectStatus = reject }))
    const actions: BotAvatarEditorActions = {
      status,
      generate: vi.fn(),
      commit: vi.fn(),
      update: vi.fn(),
      updateAppearance: vi.fn(),
    }
    const view = renderEditor(actions)
    const dialog = await screen.findByRole('dialog', { name: 'Customize avatar' })
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Generate' }))
    await waitFor(() => { expect(status).toHaveBeenCalledOnce() })
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Character' }))
    resolveStatus?.({ available: true, provider: 'openai', model: 'gpt-image-2.5-flare' })
    await Promise.resolve()

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Generate' }))
    await waitFor(() => { expect(status).toHaveBeenCalledTimes(2) })
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Character' }))
    rejectStatus?.(new Error('late status failure'))
    await Promise.resolve()
    expect(screen.queryByRole('alert')).toBeNull()
    view.unmount()
  })

  it('generates a preview, commits it once, and reuses the committed attachment', async () => {
    const preview = { data: 'AQID', mediaType: 'image/png' as const }
    const attachment = {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png' as const,
      bytes: 3,
      width: 1,
      height: 1,
    }
    const generate = vi.fn().mockResolvedValue(preview)
    const commit = vi.fn().mockResolvedValue({ attachment })
    const update = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    renderEditor({
      status: vi.fn().mockResolvedValue({ available: true, provider: 'openai', model: 'gpt-image-2.5-flare' }),
      generate,
      commit,
      update,
    }, onClose)

    await screen.findByRole('textbox', { name: 'Avatar description' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Avatar description' }), { target: { value: '  orbital garden  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate avatar' }))
    await screen.findByAltText('Generated avatar preview')
    expect(generate).toHaveBeenCalledWith({ description: 'orbital garden' }, expect.any(AbortSignal))

    fireEvent.click(screen.getByRole('button', { name: 'Use this avatar' }))
    await waitFor(() => { expect(onClose).toHaveBeenCalledOnce() })
    expect(commit).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledWith('bot-1', attachment)

    fireEvent.click(screen.getByRole('button', { name: 'Use this avatar' }))
    await waitFor(() => { expect(onClose).toHaveBeenCalledTimes(2) })
    expect(commit).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledTimes(2)
  })

  it('shows generation and commit failures without losing the editor', async () => {
    const preview = { data: 'AQID', mediaType: 'image/png' as const }
    const generate = vi.fn().mockRejectedValueOnce(new Error('generation failed')).mockResolvedValueOnce(preview)
    let rejectCommit: ((reason: unknown) => void) | undefined
    const commit = vi.fn().mockReturnValue(new Promise<never>((_resolve, reject) => { rejectCommit = reject }))
    renderEditor({
      status: vi.fn().mockResolvedValue({ available: true, provider: 'openai', model: 'gpt-image-2.5-flare' }),
      generate,
      commit,
      update: vi.fn(),
    })

    await screen.findByRole('textbox', { name: 'Avatar description' })
    const description = screen.getByRole('textbox', { name: 'Avatar description' })
    fireEvent.change(description, { target: { value: 'storm lantern' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate avatar' }))
    expect((await screen.findByRole('alert')).textContent).toContain('The avatar could not be generated. Try again.')
    fireEvent.click(screen.getByRole('button', { name: 'Generate avatar' }))
    await screen.findByAltText('Generated avatar preview')
    fireEvent.click(screen.getByRole('button', { name: 'Use this avatar' }))
    await waitFor(() => { expect(commit).toHaveBeenCalledOnce() })
    const saving = screen.getByRole('button', { name: en.avatarSaving })
    saving.removeAttribute('disabled')
    invokeClick(saving)
    expect(commit).toHaveBeenCalledOnce()
    rejectCommit?.(new Error('commit failed'))
    expect((await screen.findByRole('alert')).textContent).toContain(en.avatarSaveFailed)
  })

  it('supports the legacy clear-avatar action and reports appearance save failures', async () => {
    const avatar = {
      attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
      mediaType: 'image/png' as const,
      bytes: 3,
      width: 1,
      height: 1,
    }
    const update = vi.fn().mockRejectedValueOnce(new Error('clear failed')).mockResolvedValueOnce(undefined)
    const onClose = vi.fn()
    const legacyView = renderEditor({
      status: vi.fn().mockResolvedValue({ available: true, provider: 'openai', model: 'gpt-image-2.5-flare' }),
      generate: vi.fn(),
      commit: vi.fn(),
      update,
    }, onClose, { ...bot, avatar })

    const clearButton = await screen.findByRole('button', { name: 'Use character avatar' })
    fireEvent.click(clearButton)
    expect((await screen.findByRole('alert')).textContent).toContain(en.avatarSaveFailed)
    fireEvent.click(clearButton)
    await waitFor(() => { expect(onClose).toHaveBeenCalledOnce() })
    expect(update).toHaveBeenNthCalledWith(1, 'bot-1', null)
    legacyView.unmount()
    cleanup()

    const updateAppearance = vi.fn().mockRejectedValue(new Error('appearance failed'))
    const appearanceView = renderEditor({ updateAppearance }, vi.fn(), { ...bot, identity: undefined, accent: undefined })
    const appearanceDialog = await screen.findByRole('dialog', { name: 'Customize avatar' })
    fireEvent.click(within(appearanceDialog).getByRole('radio', { name: 'Amber' }))
    fireEvent.click(within(appearanceDialog).getByRole('button', { name: 'Save character' }))
    expect((await screen.findByRole('alert')).textContent).toContain(en.avatarAppearanceSaveFailed)
    appearanceView.unmount()
  })

  it('uses upload as the first tab when only upload is available and falls back to character otherwise', async () => {
    const uploadView = renderEditor({ upload: vi.fn() })
    expect((await screen.findByRole('tab', { name: 'Upload' })).getAttribute('aria-selected')).toBe('true')
    uploadView.unmount()
    cleanup()
    renderEditor({})
    expect((await screen.findByRole('tab', { name: 'Character' })).getAttribute('aria-selected')).toBe('true')
  })

  it('does not run setup work while the editor is closed', async () => {
    const status = vi.fn().mockResolvedValue({ available: true, provider: 'openai', model: 'gpt-image-2.5-flare' } satisfies AvatarGenerationStatus)
    const actions = { status, generate: vi.fn(), commit: vi.fn(), update: vi.fn() }
    const view = render(<BotAvatarEditor bot={bot} actions={actions} open={false} onClose={vi.fn()} t={t} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    view.rerender(<BotAvatarEditor bot={bot} actions={actions} open onClose={vi.fn()} t={t} />)
    await screen.findByRole('dialog', { name: 'Customize avatar' })
    expect(status).toHaveBeenCalledOnce()
  })

  it('ignores a generate click until the prompt and provider status are ready', async () => {
    const generate = vi.fn()
    renderEditor({
      status: vi.fn().mockResolvedValue({ available: true, provider: 'openai', model: 'gpt-image-2.5-flare' }),
      generate,
      commit: vi.fn(),
      update: vi.fn(),
    })
    const button = await screen.findByRole('button', { name: 'Generate avatar' })
    invokeClick(button)
    expect(generate).not.toHaveBeenCalled()
  })

  it('keeps an active generation while a refreshed availability check settles', async () => {
    let resolveStatus: ((value: AvatarGenerationStatus) => void) | undefined
    let rejectStatus: ((reason: unknown) => void) | undefined
    let resolveGenerate: ((value: { readonly data: string; readonly mediaType: 'image/png' }) => void) | undefined
    const status = vi.fn()
      .mockResolvedValueOnce({ available: true, provider: 'openai', model: 'gpt-image-2.5-flare' } satisfies AvatarGenerationStatus)
      .mockReturnValueOnce(new Promise<AvatarGenerationStatus>((resolve) => { resolveStatus = resolve }))
      .mockReturnValueOnce(new Promise<AvatarGenerationStatus>((_resolve, reject) => { rejectStatus = reject }))
    const generate = vi.fn().mockReturnValue(new Promise<{ readonly data: string; readonly mediaType: 'image/png' }>((resolve) => { resolveGenerate = resolve }))
    const actions: BotAvatarEditorActions = {
      status,
      generate,
      commit: vi.fn(),
      update: vi.fn(),
      updateAppearance: vi.fn(),
    }
    renderEditor(actions)
    const dialog = await screen.findByRole('dialog', { name: 'Customize avatar' })
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Generate' }))
    await waitFor(() => { expect(status).toHaveBeenCalledOnce() })
    const description = await screen.findByRole('textbox', { name: 'Avatar description' })
    fireEvent.change(description, { target: { value: 'active request' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate avatar' }))
    await waitFor(() => { expect(generate).toHaveBeenCalledOnce() })

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Character' }))
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Generate' }))
    await waitFor(() => { expect(status).toHaveBeenCalledTimes(2) })
    resolveStatus?.({ available: true, provider: 'openai', model: 'gpt-image-2.5-flare' })
    await waitFor(() => { expect(screen.queryByText(en.avatarChecking)).toBeNull() })
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Character' }))
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Generate' }))
    await waitFor(() => { expect(status).toHaveBeenCalledTimes(3) })
    rejectStatus?.(new Error('refresh failed'))
    resolveGenerate?.({ data: 'AQID', mediaType: 'image/png' })
    await screen.findByAltText('Generated avatar preview')
  })

  it('discards generated results and failures after the editor is closed', async () => {
    let resolveFirst: ((value: { readonly data: string; readonly mediaType: 'image/png' }) => void) | undefined
    let rejectSecond: ((reason: unknown) => void) | undefined
    const generate = vi.fn()
      .mockReturnValueOnce(new Promise<{ readonly data: string; readonly mediaType: 'image/png' }>((resolve) => { resolveFirst = resolve }))
      .mockReturnValueOnce(new Promise<{ readonly data: string; readonly mediaType: 'image/png' }>((_resolve, reject) => { rejectSecond = reject }))
    const actions: BotAvatarEditorActions = {
      status: vi.fn().mockResolvedValue({ available: true, provider: 'openai', model: 'gpt-image-2.5-flare' }),
      generate,
      commit: vi.fn(),
      update: vi.fn(),
    }
    const view = renderEditor(actions)
    const description = await screen.findByRole('textbox', { name: 'Avatar description' })
    fireEvent.change(description, { target: { value: 'late preview' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate avatar' }))
    await waitFor(() => { expect(generate).toHaveBeenCalledOnce() })
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!)
    resolveFirst?.({ data: 'AQID', mediaType: 'image/png' })
    await Promise.resolve()
    expect(screen.queryByAltText('Generated avatar preview')).toBeNull()
    view.unmount()
    cleanup()

    const secondView = renderEditor(actions)
    const secondDescription = await screen.findByRole('textbox', { name: 'Avatar description' })
    fireEvent.change(secondDescription, { target: { value: 'late failure' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate avatar' }))
    await waitFor(() => { expect(generate).toHaveBeenCalledTimes(2) })
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!)
    rejectSecond?.(new Error('late generation failure'))
    await Promise.resolve()
    expect(screen.queryByRole('alert')).toBeNull()
    secondView.unmount()
  })

  it('reports upload decode, canvas, encoding, and cancellation failures', async () => {
    const file = new File(['image'], 'portrait.jpg', { type: 'image/jpeg' })
    const upload = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode failed')))
    renderEditor({ upload, updateAppearance: vi.fn() })
    fireEvent.click(screen.getByRole('tab', { name: 'Upload' }))
    fireEvent.change(screen.getByLabelText('Choose an image'), { target: { files: [file] } })
    expect((await screen.findByRole('alert')).textContent).toContain(en.avatarUploadFailed)
    cleanup()
    vi.unstubAllGlobals()

    const bitmap = { width: 400, height: 300, close: vi.fn() }
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
    const nullContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    renderEditor({ upload: vi.fn(), updateAppearance: vi.fn() })
    fireEvent.click(screen.getByRole('tab', { name: 'Upload' }))
    fireEvent.change(screen.getByLabelText('Choose an image'), { target: { files: [file] } })
    expect((await screen.findByRole('alert')).textContent).toContain(en.avatarUploadFailed)
    expect(bitmap.close).toHaveBeenCalledOnce()
    nullContext.mockRestore()
    cleanup()

    const zeroBitmap = { width: 0, height: 300, close: vi.fn() }
    const context = Object.create(null) as CanvasRenderingContext2D
    context.drawImage = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(zeroBitmap))
    const zeroContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
    renderEditor({ upload: vi.fn(), updateAppearance: vi.fn() })
    fireEvent.click(screen.getByRole('tab', { name: 'Upload' }))
    fireEvent.change(screen.getByLabelText('Choose an image'), { target: { files: [file] } })
    expect((await screen.findByRole('alert')).textContent).toContain(en.avatarUploadFailed)
    zeroContext.mockRestore()
    cleanup()

    const goodBitmap = { width: 400, height: 300, close: vi.fn() }
    const goodContext = Object.create(null) as CanvasRenderingContext2D
    goodContext.drawImage = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(goodBitmap))
    const goodContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(goodContext)
    const invalidEncoding = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,nope')
    renderEditor({ upload: vi.fn(), updateAppearance: vi.fn() })
    fireEvent.click(screen.getByRole('tab', { name: 'Upload' }))
    fireEvent.change(screen.getByLabelText('Choose an image'), { target: { files: [file] } })
    expect((await screen.findByRole('alert')).textContent).toContain(en.avatarUploadFailed)
    goodContextSpy.mockRestore()
    invalidEncoding.mockRestore()
    cleanup()

    let rejectDecode: ((reason: unknown) => void) | undefined
    vi.stubGlobal('createImageBitmap', vi.fn().mockReturnValue(new Promise((_resolve, reject) => { rejectDecode = reject })))
    const cancelledView = renderEditor({ upload: vi.fn(), updateAppearance: vi.fn() })
    fireEvent.click(screen.getByRole('tab', { name: 'Upload' }))
    fireEvent.change(screen.getByLabelText('Choose an image'), { target: { files: [file] } })
    await waitFor(() => { expect(rejectDecode).toBeDefined() })
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!)
    rejectDecode?.(new Error('cancelled decode'))
    await Promise.resolve()
    expect(screen.queryByRole('alert')).toBeNull()
    cancelledView.unmount()
  })

  it('reports upload save failures and ignores duplicate save clicks', async () => {
    const bitmap = { width: 400, height: 300, close: vi.fn() }
    const context = Object.create(null) as CanvasRenderingContext2D
    context.drawImage = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AQID')
    let rejectUpload: ((reason: unknown) => void) | undefined
    const upload = vi.fn().mockReturnValue(new Promise<void>((_resolve, reject) => { rejectUpload = reject }))
    try {
      renderEditor({ upload, updateAppearance: vi.fn() })
      fireEvent.click(screen.getByRole('tab', { name: 'Upload' }))
      const input = screen.getByLabelText('Choose an image')
      fireEvent.click(input)
      fireEvent.change(input, { target: { files: [] } })
      fireEvent.change(input, { target: { files: [new File(['image'], 'portrait.jpg', { type: 'image/jpeg' })] } })
      await screen.findByAltText('Uploaded avatar preview')
      fireEvent.click(screen.getByRole('button', { name: 'Use this avatar' }))
      await waitFor(() => { expect(upload).toHaveBeenCalledOnce() })
      const saving = screen.getByRole('button', { name: en.avatarSaving })
      saving.removeAttribute('disabled')
      invokeClick(saving)
      expect(upload).toHaveBeenCalledOnce()
      rejectUpload?.(new Error('upload save failed'))
      expect((await screen.findByRole('alert')).textContent).toContain(en.avatarSaveFailed)
    } finally {
      getContext.mockRestore()
      toDataURL.mockRestore()
    }
  })

  it('does not replace an appearance save with an upload request', async () => {
    let resolveAppearance: (() => void) | undefined
    const updateAppearance = vi.fn().mockReturnValue(new Promise<void>((resolve) => { resolveAppearance = resolve }))
    const createBitmap = vi.fn()
    vi.stubGlobal('createImageBitmap', createBitmap)
    renderEditor({ upload: vi.fn(), updateAppearance })
    fireEvent.click(screen.getByRole('radio', { name: 'Amber' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save character' }))
    await waitFor(() => { expect(updateAppearance).toHaveBeenCalledOnce() })
    fireEvent.click(screen.getByRole('tab', { name: 'Upload' }))
    fireEvent.change(screen.getByLabelText('Choose an image'), {
      target: { files: [new File(['image'], 'portrait.jpg', { type: 'image/jpeg' })] },
    })
    expect(createBitmap).not.toHaveBeenCalled()
    resolveAppearance?.()
  })

  it('guards stale generate, clear, and appearance-save clicks', async () => {
    let resolveGenerate: ((value: { readonly data: string; readonly mediaType: 'image/png' }) => void) | undefined
    const generate = vi.fn().mockReturnValue(new Promise<{ readonly data: string; readonly mediaType: 'image/png' }>((resolve) => { resolveGenerate = resolve }))
    const update = vi.fn()
    const view = renderEditor({
      status: vi.fn().mockResolvedValue({ available: true, provider: 'openai', model: 'gpt-image-2.5-flare' }),
      generate,
      commit: vi.fn(),
      update,
    }, vi.fn(), { ...bot, avatar: {
      attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`), mediaType: 'image/png', bytes: 3, width: 1, height: 1,
    } })
    const description = await screen.findByRole('textbox', { name: 'Avatar description' })
    fireEvent.change(description, { target: { value: 'busy request' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate avatar' }))
    await waitFor(() => { expect(generate).toHaveBeenCalledOnce() })
    const clear = screen.getByRole('button', { name: en.avatarUseCharacter })
    clear.removeAttribute('disabled')
    Object.defineProperty(clear, 'disabled', { configurable: true, value: false })
    invokeClick(clear)
    expect(update).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!)
    resolveGenerate?.({ data: 'AQID', mediaType: 'image/png' })
    view.unmount()

    let resolveAppearance: (() => void) | undefined
    const updateAppearance = vi.fn().mockReturnValue(new Promise<void>((resolve) => { resolveAppearance = resolve }))
    const appearanceView = renderEditor({ updateAppearance })
    fireEvent.click(screen.getByRole('radio', { name: 'Amber' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save character' }))
    await waitFor(() => { expect(updateAppearance).toHaveBeenCalledOnce() })
    const savingCharacter = screen.getByRole('button', { name: en.avatarSavingCharacter })
    savingCharacter.removeAttribute('disabled')
    invokeClick(savingCharacter)
    expect(updateAppearance).toHaveBeenCalledOnce()
    resolveAppearance?.()
    appearanceView.unmount()
  })
})
