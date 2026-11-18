// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as primitives from '@yharness/client-ui-primitives'
import { makeTranslate } from '@yharness/client-test-runtime'
import { BotTemplatesPanel } from '../src/client/BotTemplatesPanel.tsx'
import { en } from '../src/client/locales.ts'
import type { BotSummary, BotTemplateActions, BotTemplateState, BotTemplateSummary } from '../src/client/types.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const t = makeTranslate(en)
const bot: BotSummary = {
  id: 'bot-release',
  name: 'Release partner',
  description: 'Keeps releases moving.',
  identity: 'goal',
  accent: 'amber',
}
const activeTemplate: BotTemplateSummary = {
  id: 'template-active',
  shareCode: 'yhbot-template-v2.active',
  name: 'Release template',
  description: 'A safe release helper.',
  identity: 'goal',
  accent: 'teal',
  createdAt: 1,
}

function state(overrides: Partial<BotTemplateState> = {}): BotTemplateState {
  return {
    phase: 'ready',
    templates: [activeTemplate],
    code: activeTemplate.shareCode,
    preview: null,
    error: null,
    busy: false,
    ...overrides,
  }
}

function actions(overrides: Partial<BotTemplateActions> = {}): BotTemplateActions {
  return {
    setTemplateCode: vi.fn(),
    publishTemplate: vi.fn(async () => {}),
    revokeTemplate: vi.fn(async () => {}),
    previewTemplate: vi.fn(async () => {}),
    importTemplate: vi.fn(async () => {}),
    ...overrides,
  }
}

type ReactClickProps = { readonly onClick?: (event: MouseEvent) => unknown }

function invokeClick(element: HTMLElement): void {
  const key = Object.keys(element).find(name => name.startsWith('__reactProps$'))
  if (key === undefined) throw new Error('Expected React click props')
  const props = Reflect.get(element, key) as ReactClickProps
  if (props.onClick === undefined) throw new Error('Expected React click handler')
  props.onClick(new MouseEvent('click', { bubbles: true }))
}

function renderPanel(panelState = state(), panelActions = actions(), bots: readonly BotSummary[] = [bot], open = true) {
  return render(<BotTemplatesPanel bots={bots} state={panelState} actions={panelActions} t={t} open={open} onClose={vi.fn()} />)
}

describe('BotTemplatesPanel', () => {
  it('renders empty catalog states and resets drafts when closed', async () => {
    const panelActions = actions()
    const view = renderPanel(state({ phase: 'loading', templates: [] }), panelActions, [], false)
    view.rerender(<BotTemplatesPanel bots={[]} state={state({ phase: 'loading', templates: [] })} actions={panelActions} t={t} open onClose={vi.fn()} />)
    expect(await screen.findByText('Create a Bot before sharing a template.')).toBeTruthy()
    expect(screen.getByText('Loading shared templates…')).toBeTruthy()

    view.rerender(<BotTemplatesPanel bots={[]} state={state({ phase: 'ready', templates: [], code: '' })} actions={panelActions} t={t} open onClose={vi.fn()} />)
    expect(screen.getByText('No shared templates yet.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveProperty('disabled', true)
  })

  it('publishes a Bot, keeps duplicate work out, and tolerates a publish failure', async () => {
    const publish = Promise.withResolvers<undefined>()
    const publishTemplate = vi.fn().mockReturnValue(publish.promise)
    const panelActions = actions({ publishTemplate })
    renderPanel(state(), panelActions)

    const share = screen.getByRole('button', { name: 'Share' })
    fireEvent.click(share)
    expect(screen.getByRole('button', { name: 'Sharing…' })).toBeTruthy()
    invokeClick(share)
    expect(publishTemplate).toHaveBeenCalledOnce()
    publish.resolve(undefined)
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Share' })).toBeTruthy() })
    cleanup()

    const failed = vi.fn().mockRejectedValue(new Error('publish failed'))
    const failedView = renderPanel(state(), actions({ publishTemplate: failed }))
    fireEvent.click(failedView.getByRole('button', { name: 'Share' }))
    await waitFor(() => { expect(failed).toHaveBeenCalledOnce() })
    await waitFor(() => { expect(failedView.getByRole('button', { name: 'Share' })).toBeTruthy() })
  })

  it('previews from the button and Enter key, preserving failures for retry', async () => {
    const previewTemplate = vi.fn().mockRejectedValueOnce(new Error('preview failed')).mockResolvedValueOnce(undefined)
    const panelActions = actions({ previewTemplate })
    renderPanel(state({ code: '  yhbot-template-v2.preview  ' }), panelActions)
    const code = screen.getByRole('textbox', { name: 'Template share code' })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await waitFor(() => { expect(previewTemplate).toHaveBeenCalledOnce() })
    fireEvent.keyDown(code, { key: 'Enter' })
    await waitFor(() => { expect(previewTemplate).toHaveBeenCalledTimes(2) })
    fireEvent.keyDown(code, { key: 'Escape' })
    expect(panelActions.setTemplateCode).not.toHaveBeenCalled()

    const emptyActions = actions({ previewTemplate: vi.fn() })
    renderPanel(state({ code: '   ' }), emptyActions)
    fireEvent.keyDown(screen.getAllByRole('textbox', { name: 'Template share code' }).at(-1)!, { key: 'Enter' })
    expect(emptyActions.previewTemplate).not.toHaveBeenCalled()
  })

  it('imports a resolved preview, clears only the unchanged name, and keeps failed imports visible', async () => {
    const preview: BotTemplateSummary = {
      ...activeTemplate,
      avatar: { data: 'ab-_', mediaType: 'image/png', bytes: 3, width: 1, height: 1 },
      issuerFingerprint: 'issuer',
      fingerprint: 'artifact',
      persona: 'Keep evidence concise.',
      capabilities: ['chat', 'read_file'],
      agentPreset: 'research',
      localPermissions: { status: 'resolved', preset: 'research', tools: ['chat', 'read_file'] },
    }
    const importTemplate = vi.fn().mockResolvedValue(undefined)
    const panelActions = actions({ importTemplate })
    renderPanel(state({ preview }), panelActions)
    expect(screen.getByRole('img', { name: 'Portable template avatar' }).getAttribute('src')).toBe('data:image/png;base64,ab+/')
    expect(screen.getByText('issuer')).toBeTruthy()
    expect(screen.getByText('artifact')).toBeTruthy()
    expect(screen.getAllByText('chat, read_file')).toHaveLength(2)
    const name = screen.getByRole('textbox', { name: 'Imported Bot name' })
    fireEvent.change(name, { target: { value: 'Imported release helper' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve and create Bot' }))
    await waitFor(() => { expect(importTemplate).toHaveBeenCalledWith('Imported release helper') })
    await waitFor(() => { expect(name).toHaveProperty('value', '') })
    cleanup()

    const pending = Promise.withResolvers<undefined>()
    const pendingImport = vi.fn().mockReturnValue(pending.promise)
    const pendingView = renderPanel(state({ preview }), actions({ importTemplate: pendingImport }))
    const pendingName = pendingView.getByRole('textbox', { name: 'Imported Bot name' })
    fireEvent.change(pendingName, { target: { value: 'Keep this draft' } })
    fireEvent.click(pendingView.getByRole('button', { name: 'Approve and create Bot' }))
    pending.resolve(undefined)
    await waitFor(() => { expect(pendingName).toHaveProperty('value', '') })
    cleanup()

    const failed = vi.fn().mockRejectedValue(new Error('import failed'))
    const failedView = renderPanel(state({ preview }), actions({ importTemplate: failed }))
    const failedName = failedView.getByRole('textbox', { name: 'Imported Bot name' })
    fireEvent.change(failedName, { target: { value: 'Retry name' } })
    fireEvent.click(failedView.getByRole('button', { name: 'Approve and create Bot' }))
    await waitFor(() => { expect(failed).toHaveBeenCalledWith('Retry name') })
    expect(failedName).toHaveProperty('value', 'Retry name')
  })

  it('shows permission fallbacks, copies active codes, and revokes templates', async () => {
    const write = vi.spyOn(primitives, 'writeClipboard')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const revokeTemplate = vi.fn().mockRejectedValue(new Error('revoke failed'))
    const revoked: BotTemplateSummary = { ...activeTemplate, id: 'template-revoked', shareCode: 'revoked-code', revokedAt: 4 }
    const preview: BotTemplateSummary = {
      id: activeTemplate.id,
      shareCode: activeTemplate.shareCode,
      name: activeTemplate.name,
      identity: activeTemplate.identity,
      accent: activeTemplate.accent,
      createdAt: activeTemplate.createdAt,
      capabilities: [],
      localPermissions: { status: 'unavailable', tools: [] },
    }
    const view = renderPanel(state({ templates: [activeTemplate, revoked], preview }), actions({ revokeTemplate }))
    expect(screen.getAllByText('Unavailable on this Host')).toHaveLength(2)
    expect(screen.getAllByText('Not included').length).toBeGreaterThanOrEqual(5)
    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.getByText('Revoked')).toBeTruthy()

    const copyButtons = screen.getAllByRole('button', { name: 'Copy share code' })
    fireEvent.click(copyButtons[0]!)
    await waitFor(() => { expect(write).toHaveBeenCalledWith(activeTemplate.shareCode) })
    fireEvent.click(copyButtons[0]!)
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Share code copied' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Revoke share code' }))
    await waitFor(() => { expect(revokeTemplate).toHaveBeenCalledWith(activeTemplate.id) })
    view.unmount()
  })

  it('shows controller errors and busy labels for a resolved host with no tools', () => {
    const preview: BotTemplateSummary = {
      ...activeTemplate,
      localPermissions: { status: 'resolved', tools: [] },
    }
    renderPanel(state({ error: 'Template could not be checked.', preview, busy: true }))
    expect(screen.getByRole('alert').textContent).toContain('Template could not be checked.')
    expect(screen.getByText('No model-facing tools')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approving and creating…' })).toHaveProperty('disabled', true)
  })
})
