// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { AvatarGenerationStatus } from '@deepseek-ai/dsh-avatar-generation/types'
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
    fireEvent.click(within(characters).getByRole('radio', { name: 'Spark' }))
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
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Spark' }))
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
