// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { BotId, type BotView } from '@yharness/bots/client'
import type { SessionId } from '@yharness/session/types'
import { createSnapshotStore } from '@yharness/client-store'
import type { BotWorkspaceState } from '../src/client/controller.ts'
import type { BotGroupSummary, BotSummary } from '../src/client/types.ts'
import { createBotGroupReferenceSource } from '../src/client/bot-group-reference-source.ts'

afterEach(cleanup)

const currentSession = 'session-current' as SessionId

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

function member(id: string, name: string): BotSummary {
  return { id, name, identity: 'agent', accent: 'violet' }
}

function group(id: string, name: string, members: readonly BotSummary[]): BotGroupSummary {
  return { id, name, bots: members }
}

function workspace(selectedBot: BotView | undefined, groups: readonly BotGroupSummary[]) {
  return createSnapshotStore<BotWorkspaceState>({
    phase: 'ready',
    bots: selectedBot === undefined ? [] : [selectedBot],
    selectedBotId: selectedBot?.id ?? null,
    groups,
    selectedGroupId: null,
    routineRevision: 0,
    selectedGroup: null,
    groupPhase: 'idle',
    groupError: null,
    templates: { phase: 'idle', templates: [], code: '', preview: null, error: null, busy: false },
    error: null,
  })
}

function request(query: string, options: { readonly quoted?: boolean; readonly drilled?: boolean; readonly signal?: AbortSignal } = {}) {
  return {
    query,
    quoted: options.quoted ?? false,
    position: 'inline' as const,
    drilled: options.drilled ?? false,
    signal: options.signal ?? new AbortController().signal,
  }
}

function pick(candidate: Parameters<NonNullable<ReturnType<typeof createBotGroupReferenceSource>['onPick']>>[0]['candidate'], action: 'pick' | 'drill' = 'pick') {
  return {
    candidate,
    session: { sessionId: currentSession },
    position: 'inline' as const,
    via: 'menu' as const,
    action,
    span: { start: 0, end: 9, draftRev: 1 },
  }
}

describe('Bot group reference source', () => {
  it('offers member groups in the direct Bot composer and inserts a stable group reference', async () => {
    const current = bot('bot-current', currentSession, 'Chief of staff')
    const currentMember = member('bot-current', current.name)
    const store = workspace(current, [
      group('bot-group-trading', 'Trading desk', [currentMember, member('bot-gammagod', 'Gammagod')]),
      group('bot-group-other', 'Other desk', [member('bot-vegaveil', 'Vegaveil')]),
    ])
    const source = createBotGroupReferenceSource({
      workspace: store,
      section: () => 'Groups',
      groupLabel: () => 'Group',
      ready: Promise.resolve(),
    })

    const candidates = await source.candidates({ sessionId: currentSession }, request('trading'))
    await expect(source.candidates({ sessionId: currentSession }, request('trading', { quoted: true }))).resolves.toEqual([])
    await expect(source.candidates({ sessionId: currentSession }, request('trading', { drilled: true }))).resolves.toEqual([])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ name: 'Trading desk', description: 'Group', section: 'Groups' })
    const GroupIcon = candidates[0]?.icon
    if (typeof GroupIcon !== 'function') throw new Error('Group candidates need an icon component')
    expect(render(createElement(GroupIcon, { size: 16 })).container.querySelector('svg')).not.toBeNull()

    expect(source.onPick(pick(candidates[0]!))).toEqual({
      insert: {
        source: 'bot-group',
        ref: '@[Trading desk](dsh-bot-group:bot-group-trading)',
        label: 'Trading desk',
        appearance: 'bot-group',
        clipboardText: '@[Trading desk](dsh-bot-group:bot-group-trading)',
      },
    })
    await expect(source.codec?.serialize('@[Trading desk](dsh-bot-group:bot-group-trading)', new AbortController().signal))
      .resolves.toBe('@[Trading desk](dsh-bot-group:bot-group-trading)')
    expect(source.codec?.clipboardText(candidates[0]!.value!)).toBe(candidates[0]!.value)
  })

  it('matches current member names but never exposes another Bot’s group', async () => {
    const current = bot('bot-current', currentSession, 'Chief of staff')
    const store = workspace(current, [
      group('bot-group-authorized', 'Research room', [member('bot-current', current.name), member('bot-scout', 'Scout')]),
      group('bot-group-hidden', 'Gammagod room', [member('bot-gammagod', 'Gammagod')]),
    ])
    const source = createBotGroupReferenceSource({
      workspace: store,
      section: () => 'Groups',
      groupLabel: () => 'Group',
    })

    await expect(source.candidates({ sessionId: currentSession }, request('scout'))).resolves.toHaveLength(1)
    await expect(source.candidates({ sessionId: currentSession }, request('gammagod'))).resolves.toEqual([])
    await expect(source.candidates({ sessionId: 'ordinary-session' as SessionId }, request(''))).resolves.toEqual([])
  })

  it('rechecks membership at selection time and refuses stale or drilled picks', async () => {
    const current = bot('bot-current', currentSession, 'Chief of staff')
    const store = workspace(current, [group('bot-group-trading', 'Trading desk', [member('bot-current', current.name)])])
    const source = createBotGroupReferenceSource({
      workspace: store,
      section: () => 'Groups',
      groupLabel: () => 'Group',
    })
    const [candidate] = await source.candidates({ sessionId: currentSession }, request('trading'))
    expect(source.onPick(pick(candidate!, 'drill'))).toBeUndefined()
    expect(source.onPick(pick({ name: 'missing' }))).toBeUndefined()
    expect(source.onPick(pick({ ...candidate!, value: 'not a group reference' }))).toBeUndefined()
    expect(source.onPick({ ...pick(candidate!), session: { sessionId: 'other-session' as SessionId } })).toBeUndefined()
    store.set({ ...store.getSnapshot(), groups: [] })
    expect(source.onPick(pick(candidate!))).toBeUndefined()
  })

  it('returns no candidates for an unselected Bot or an aborted readiness wait', async () => {
    const current = bot('bot-current', currentSession, 'Chief of staff')
    const groups = [group('bot-group-trading', 'Trading desk', [member('bot-current', current.name)])]
    const source = createBotGroupReferenceSource({
      workspace: workspace(undefined, groups),
      section: () => 'Groups',
      groupLabel: () => 'Group',
    })
    await expect(source.candidates({ sessionId: currentSession }, request(''))).resolves.toEqual([])

    let resolveReady: (() => void) | undefined
    const ready = new Promise<void>((resolve) => { resolveReady = resolve })
    const readySource = createBotGroupReferenceSource({
      workspace: workspace(current, groups),
      section: () => 'Groups',
      groupLabel: () => 'Group',
      ready,
    })
    const controller = new AbortController()
    const pending = readySource.candidates({ sessionId: currentSession }, request('', { signal: controller.signal }))
    controller.abort()
    resolveReady?.()
    await expect(pending).resolves.toEqual([])
  })
})
