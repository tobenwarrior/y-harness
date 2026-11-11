// @vitest-environment jsdom
import { createElement } from 'react'
import { act, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BotId, type BotView } from '@yharness/bots/client'
import { AttachmentId } from '@yharness/attachment'
import type { SessionId } from '@yharness/session/types'
import { createSnapshotStore } from '@yharness/client-store'
import type { BotWorkspaceState } from '../src/client/controller.ts'
import { createBotCandidateIcon, createBotReferenceIcon } from '../src/client/bot-reference-icon.tsx'
import { createBotReferenceSource } from '../src/client/bot-reference-source.ts'

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
      name: 'Atlas', description: 'Bot', section: 'Bots', icon: expect.any(Function),
    })
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
    expect(source.matchEnter).toBeUndefined()
    expect(source.matchSpace).toBeUndefined()
    await expect(source.codec?.serialize('@[Atlas](dsh-bot:bot-atlas)', new AbortController().signal))
      .resolves.toBe('@[Atlas](dsh-bot:bot-atlas)')
    expect(source.codec?.clipboardText('@[Atlas](dsh-bot:bot-atlas)')).toBe('@[Atlas](dsh-bot:bot-atlas)')
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
    await expect(source.candidates({ sessionId: currentSession }, { ...request(''), drilled: true })).resolves.toEqual([])

    const aborted = new AbortController()
    aborted.abort()
    await expect(source.candidates({ sessionId: currentSession }, { ...request(''), signal: aborted.signal })).resolves.toEqual([])
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

    expect(source.onPick({
      candidate: candidate!, session: { sessionId: currentSession }, position: 'inline', via: 'menu', action: 'drill',
      span: { start: 0, end: 5, draftRev: 1 },
    })).toBeUndefined()
    expect(source.onPick({
      candidate: { name: 'Stale Bot' }, session: { sessionId: currentSession }, position: 'inline', via: 'menu', action: 'pick',
      span: { start: 0, end: 5, draftRev: 1 },
    })).toBeUndefined()
    expect(source.onPick({
      candidate: { ...candidate!, value: '@other' }, session: { sessionId: currentSession }, position: 'inline', via: 'menu', action: 'pick',
      span: { start: 0, end: 5, draftRev: 1 },
    })).toBeUndefined()
  })

  it('renders source-owned Bot avatars and the fallback glyph', async () => {
    const avatar = {
      attachmentId: AttachmentId('sha256:avatar'), mediaType: 'image/png' as const,
      bytes: 1, width: 1, height: 1,
    }
    const atlas = bot('bot-atlas', 'session-atlas', 'Atlas', { avatar })
    const plain = bot('bot-plain', 'session-plain', 'Plain')
    const store = workspace([atlas, plain])
    const loadAvatar = vi.fn(async () => 'data:image/png;base64,avatar')
    const referenceIcon = createBotReferenceIcon(store, loadAvatar)
    const candidateIcon = createBotCandidateIcon(atlas, loadAvatar)
    const valid = render(createElement(referenceIcon, { reference: '@[Atlas](dsh-bot:bot-atlas)', label: 'Atlas' }))
    expect(valid.container.querySelector('[data-identity="agent"]')).not.toBeNull()
    const candidate = render(createElement(candidateIcon, { size: 18 }))
    expect(candidate.container.querySelector('[data-identity="agent"]')).not.toBeNull()
    const plainCandidate = render(createElement(createBotCandidateIcon(plain, loadAvatar), { size: 18 }))
    expect(plainCandidate.container.querySelector('[data-identity="agent"]')).not.toBeNull()
    const noAvatar = render(createElement(referenceIcon, { reference: '@[Plain](dsh-bot:bot-plain)', label: 'Plain' }))
    expect(noAvatar.container.querySelector('[data-identity="agent"]')).not.toBeNull()
    const fallback = render(createElement(referenceIcon, { reference: '@[Missing](dsh-bot:bot-missing)', label: 'Missing' }))
    expect(fallback.container.querySelector('svg')).not.toBeNull()
    const invalid = render(createElement(referenceIcon, { reference: '@other', label: 'Other' }))
    expect(invalid.container.querySelector('svg')).not.toBeNull()
    await act(async () => {})
    expect(loadAvatar).toHaveBeenCalledWith('bot-atlas', avatar)
  })
})
