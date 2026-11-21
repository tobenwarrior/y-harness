// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { AttachmentId } from '@yharness/attachment'
import { BotId, type BotView } from '@yharness/bots/client'
import type { SessionId } from '@yharness/session/types'
import { createSnapshotStore } from '@yharness/client-store'
import type { BotWorkspaceState } from '../src/client/controller.ts'
import { createBotReferenceIcon } from '../src/client/bot-reference-icon.tsx'
import { createBotReferenceSource } from '../src/client/bot-reference-source.ts'

afterEach(cleanup)

const currentSession = 'session-viewer' as SessionId

function bot(id: string, sessionId: string, name: string, patch: Partial<BotView> = {}): BotView {
  return {
    id: BotId(id),
    sessionId: sessionId as SessionId,
    name,
    identity: 'agent',
    accent: 'violet',
    cwd: '/workspace',
    state: 'active',
    createdAt: 1,
    updatedAt: 1,
    availability: 'idle',
    pinned: false,
    hidden: false,
    ...patch,
  }
}

function workspace(bots: readonly BotView[]) {
  return createSnapshotStore<BotWorkspaceState>({
    phase: 'ready',
    bots,
    selectedBotId: null,
    groups: [],
    selectedGroupId: null,
    routineRevision: 0,
    selectedGroup: null,
    groupPhase: 'idle',
    groupError: null,
    templates: { phase: 'idle', templates: [], code: '', preview: null, error: null, busy: false },
    error: null,
  })
}

function request(query: string, quoted = false) {
  return {
    query,
    quoted,
    position: 'inline' as const,
    drilled: false,
    signal: new AbortController().signal,
  }
}

describe('Bot reference source', () => {
  it('finds authorized Bots by name and inserts a stable Bot mention without sending', async () => {
    const atlas = bot('bot-atlas', 'session-atlas', 'Atlas', { description: 'Market notes' })
    const source = createBotReferenceSource({
      workspace: workspace([
        atlas,
        bot('bot-orbit', currentSession, 'Orbit'),
        bot('bot-hidden', 'session-hidden', 'Hidden', { hidden: true }),
        bot('bot-provisioning', 'session-provisioning', 'Preparing', { state: 'provisioning' }),
      ]),
      loadAvatar: vi.fn(async () => 'data:image/png;base64,avatar'),
      section: () => 'Bots',
      botLabel: () => 'Bot',
      ready: Promise.resolve(),
    })

    const candidates = await source.candidates({ sessionId: currentSession }, request('atlas'))
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      name: 'Atlas', description: 'Bot', section: 'Bots',
    })
    expect(typeof candidates[0]?.icon).toBe('function')
    const outcome = source.onPick({
      candidate: candidates[0]!, session: { sessionId: currentSession }, position: 'inline', via: 'menu', action: 'pick',
      span: { start: 0, end: 9, draftRev: 1 },
    })
    expect(outcome).toEqual({
      insert: {
        source: 'bot',
        ref: '@[Atlas](dsh-bot:bot-atlas)',
        label: 'Atlas',
        appearance: 'bot',
        clipboardText: '@[Atlas](dsh-bot:bot-atlas)',
      },
    })
    expect(source).not.toHaveProperty('matchEnter')
    expect(source).not.toHaveProperty('matchSpace')
    await expect(source.codec?.serialize('@[Atlas](dsh-bot:bot-atlas)', new AbortController().signal))
      .resolves.toBe('@[Atlas](dsh-bot:bot-atlas)')
  })

  it('renders preset and generated avatars through reference and candidate wiring', async () => {
    const generatedAvatar = {
      attachmentId: AttachmentId(`sha256:${'e'.repeat(64)}`),
      mediaType: 'image/png' as const,
      bytes: 3,
      width: 1,
      height: 1,
    }
    const generated = bot('bot-generated', 'session-generated', 'Generated', { avatar: generatedAvatar })
    const preset = bot('bot-preset', 'session-preset', 'Preset')
    const store = workspace([generated, preset])
    const loadAvatar = vi.fn(async () => 'data:image/png;base64,avatar')
    const source = createBotReferenceSource({
      workspace: store,
      loadAvatar,
      section: () => 'Bots',
      botLabel: () => 'Bot',
    })
    const candidates = await source.candidates({ sessionId: currentSession }, request(''))
    const generatedCandidate = candidates.find(candidate => candidate.name === 'Generated')
    const presetCandidate = candidates.find(candidate => candidate.name === 'Preset')
    const GeneratedIcon = generatedCandidate?.icon
    const PresetIcon = presetCandidate?.icon
    if (GeneratedIcon === undefined || PresetIcon === undefined) throw new Error('Bot candidates need icons')

    const candidatesView = render(createElement('div', null,
      createElement(GeneratedIcon, { size: 16 }), createElement(PresetIcon, { size: 16 }),
    ))
    await waitFor(() => { expect(screen.getByRole('img', { name: 'Generated' }).querySelector('img')).not.toBeNull() })
    expect(screen.getByRole('img', { name: 'Preset' }).querySelector('[data-character]')).not.toBeNull()
    expect(loadAvatar).toHaveBeenCalledWith(String(generated.id), generatedAvatar)

    candidatesView.unmount()
    const ReferenceIcon = createBotReferenceIcon(store, loadAvatar)
    const reference = render(createElement(ReferenceIcon, { reference: '@not-a-bot-reference', label: 'Missing' }))
    expect(reference.container.querySelector('svg')).not.toBeNull()
    reference.rerender(createElement(ReferenceIcon, { reference: generatedCandidate!.value!, label: 'Generated' }))
    await waitFor(() => { expect(screen.getByRole('img', { name: 'Generated' }).querySelector('img')).not.toBeNull() })
    reference.rerender(createElement(ReferenceIcon, { reference: presetCandidate!.value!, label: 'Preset' }))
    expect(screen.getByRole('img', { name: 'Preset' }).querySelector('[data-character]')).not.toBeNull()
  })

  it('updates from the live roster and keeps path references out of Bot rows', async () => {
    const store = workspace([])
    let section = 'Bots'
    let botLabel = 'Bot'
    const source = createBotReferenceSource({
      workspace: store,
      loadAvatar: vi.fn(async () => 'avatar'),
      section: () => section,
      botLabel: () => botLabel,
      ready: Promise.resolve(),
    })
    await expect(source.candidates({ sessionId: currentSession }, request(''))).resolves.toEqual([])

    store.set({ ...store.getSnapshot(), bots: [bot('bot-new', 'session-new', 'New bot')] })
    const [candidate] = await source.candidates({ sessionId: currentSession }, request('new'))
    expect(candidate?.name).toBe('New bot')
    section = '机器人'
    botLabel = '机器人'
    const [localized] = await source.candidates({ sessionId: currentSession }, request('new'))
    expect(localized).toMatchObject({ section: '机器人', description: '机器人' })
    await expect(source.candidates({ sessionId: currentSession }, request('', true))).resolves.toEqual([])
  })

  it('returns no rows when roster readiness settles after the request is cancelled', async () => {
    let resolveReady: (() => void) | undefined
    const ready = new Promise<void>((resolve) => { resolveReady = resolve })
    const section = vi.fn(() => 'Bots')
    const botLabel = vi.fn(() => 'Bot')
    const store = workspace([bot('bot-atlas', 'session-atlas', 'Atlas')])
    const source = createBotReferenceSource({
      workspace: store,
      loadAvatar: vi.fn(async () => 'avatar'),
      section,
      botLabel,
      ready,
    })
    const controller = new AbortController()
    const pending = source.candidates({ sessionId: currentSession }, {
      ...request('atlas'), signal: controller.signal,
    })

    controller.abort()
    resolveReady?.()

    await expect(pending).resolves.toEqual([])
    expect(section).not.toHaveBeenCalled()
    expect(botLabel).not.toHaveBeenCalled()
  })

  it('re-evaluates the Session scope and parses visible mentions through pick completion', async () => {
    const store = workspace([bot('bot-scout', 'session-scout', 'Scout @Home')])
    const source = createBotReferenceSource({
      workspace: store,
      loadAvatar: vi.fn(async () => 'avatar'),
      section: () => 'Bots',
      botLabel: () => 'Bot',
    })

    await expect(source.candidates({ sessionId: 'session-scout' as SessionId }, request('scout'))).resolves.toEqual([])
    const [candidate] = await source.candidates({ sessionId: currentSession }, request('scout'))
    expect(candidate?.value).toBe('@[Scout \\@Home](dsh-bot:bot-scout)')
    expect(source.onPick({
      candidate: candidate!, session: { sessionId: currentSession }, position: 'inline', via: 'menu', action: 'pick',
      span: { start: 0, end: 9, draftRev: 1 },
    })).toEqual({
      insert: {
        source: 'bot', ref: '@[Scout \\@Home](dsh-bot:bot-scout)', label: 'Scout @Home', appearance: 'bot',
        clipboardText: '@[Scout \\@Home](dsh-bot:bot-scout)',
      },
    })
    expect(source.codec?.clipboardText(candidate!.value!)).toBe(candidate!.value)
  })

  it('rejects drill, missing, and malformed references at the completion entry point', async () => {
    const source = createBotReferenceSource({
      workspace: workspace([bot('bot-atlas', 'session-atlas', 'Atlas')]),
      loadAvatar: vi.fn(async () => 'avatar'),
      section: () => 'Bots',
      botLabel: () => 'Bot',
    })
    const [candidate] = await source.candidates({ sessionId: currentSession }, request('atlas'))
    const pick = (value: typeof candidate, action: 'pick' | 'drill' = 'pick') => source.onPick({
      candidate: value!, session: { sessionId: currentSession }, position: 'inline', via: 'menu', action,
      span: { start: 0, end: 9, draftRev: 1 },
    })

    expect(pick(candidate, 'drill')).toBeUndefined()
    expect(pick({ name: candidate!.name })).toBeUndefined()
    expect(pick({ ...candidate!, value: '@not a Bot reference' })).toBeUndefined()
  })

  it('refuses a candidate that loses roster access before selection', async () => {
    const store = workspace([bot('bot-stale', 'session-stale', 'Stale Bot')])
    const source = createBotReferenceSource({
      workspace: store,
      loadAvatar: vi.fn(async () => 'avatar'),
      section: () => 'Bots',
      botLabel: () => 'Bot',
      ready: Promise.resolve(),
    })
    const [candidate] = await source.candidates({ sessionId: currentSession }, request('stale'))
    store.set({ ...store.getSnapshot(), bots: [] })
    expect(source.onPick({
      candidate: candidate!, session: { sessionId: currentSession }, position: 'inline', via: 'menu', action: 'pick',
      span: { start: 0, end: 5, draftRev: 1 },
    })).toBeUndefined()
  })
})
