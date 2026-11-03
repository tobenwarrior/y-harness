// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@yharness/client-test-runtime'
import type { AvatarGenerationStatus } from '@yharness/avatar-generation/types'
import { BotAvatarEditor } from '../src/client/BotAvatarEditor.tsx'
import { en } from '../src/client/locales.ts'
import type { BotAvatarEditorActions, BotSummary } from '../src/client/types.ts'

afterEach(cleanup)

const t = makeTranslate(en)

const bot: BotSummary = {
  id: 'bot-1',
  name: 'Release captain',
  identity: 'agent',
  accent: 'violet',
}

function renderEditor(actions: BotAvatarEditorActions, onClose = vi.fn()) {
  return render(<BotAvatarEditor bot={bot} actions={actions} open onClose={onClose} t={t} />)
}

describe('BotAvatarEditor appearance controls', () => {
  it('uploads a selected image without requiring an image generation provider', async () => {
    const bitmap = { width: 400, height: 300, close: vi.fn() }
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
    const context: CanvasRenderingContext2D = Object.create(null)
    context.drawImage = vi.fn()
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AQID')
    const upload = vi.fn().mockResolvedValue(undefined)
    try {
      renderEditor({ upload, updateAppearance: vi.fn() })
      fireEvent.click(screen.getByRole('tab', { name: 'Upload' }))
      const file = new File(['image'], 'portrait.jpg', { type: 'image/jpeg' })
      fireEvent.change(screen.getByLabelText('Choose an image'), { target: { files: [file] } })
      await screen.findByAltText('Uploaded avatar preview')
      expect(context.drawImage).toHaveBeenLastCalledWith(bitmap, 50, 0, 300, 300, 0, 0, 512, 512)
      fireEvent.change(screen.getByRole('slider', { name: 'Horizontal position' }), { target: { value: '0' } })
      await waitFor(() => { expect(context.drawImage).toHaveBeenLastCalledWith(bitmap, 0, 0, 300, 300, 0, 0, 512, 512) })
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
  })

  it('keeps the latest crop when image decoding completes out of order', async () => {
    let finishFirst!: (value: { width: number; height: number; close: () => void }) => void
    const first = { width: 400, height: 300, close: vi.fn() }
    const second = { width: 400, height: 300, close: vi.fn() }
    const decode = vi.fn().mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve })).mockResolvedValueOnce(second)
    vi.stubGlobal('createImageBitmap', decode)
    const context: CanvasRenderingContext2D = Object.create(null)
    context.drawImage = vi.fn()
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
      expect(context.drawImage).toHaveBeenCalledOnce()
      expect(context.drawImage).toHaveBeenCalledWith(second, 0, 0, 300, 300, 0, 0, 512, 512)
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
})
