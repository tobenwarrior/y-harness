// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@yharness/attachment'
import { BotId } from '@yharness/bots'
import { ScheduleId } from '@yharness/schedule'
import { SessionId } from '@yharness/session'
import { makeTranslate } from '@yharness/client-test-runtime'
import type { ClientConnectionRpc } from '@yharness/client-connection/client'
import type { ReactNode } from 'react'
import { BotAvatar } from '../src/client/BotAvatar.tsx'
import { BotSkillsManager } from '../src/client/BotSkillsManager.tsx'
import { BotDetail, BotGroupDetail, BotRoster } from '../src/client/BotWorkspace.tsx'
import { BotRoutineManager } from '../src/client/BotRoutineManager.tsx'
import { BotTemplatesPanel } from '../src/client/BotTemplatesPanel.tsx'
import { en } from '../src/client/locales.ts'
import { MessageId } from '@yharness/llm/brand'
import { createSharedBotsClient, type SharedBotsClient } from '../src/client/shared-client.ts'
import type {
  BotGroupDetailData, BotGroupSummary, BotMemoryManagerActions, BotMemorySummary, BotRoutineHistory, BotSummary,
  BotSkillManagerActions, BotSkillPolicy, BotTemplateActions, BotTemplateState, BotWorkspaceProps,
} from '../src/client/types.ts'
import { BotSkillPolicyConflictError } from '../src/client/types.ts'

afterEach(cleanup)

const t = makeTranslate(en)

const bots: readonly BotSummary[] = [
  {
    id: 'research',
    updatedAt: 1,
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
    { id: 'message-2', sender: { kind: 'bot', botId: BotId('research'), name: 'Research partner' }, text: 'I found three useful sources.', createdAt: 2 },
  ],
}

const templateState: BotTemplateState = {
  phase: 'ready',
  templates: [{
    id: 'template-release', shareCode: 'bot-template-release', name: 'Release partner', description: 'Keeps releases moving.',
    identity: 'goal', accent: 'amber', createdAt: 1,
  }],
  code: 'bot-template-release',
  preview: null,
  error: null,
  busy: false,
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

function openConnectedAppsMenu(bot: BotSummary = bots[0]!): void {
  fireEvent.click(screen.getByRole('button', { name: `Bot actions for ${bot.name}` }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'App access' }))
}

function ownerCapabilityClient(getOwnerCapability: NonNullable<SharedBotsClient['getOwnerCapability']>): SharedBotsClient {
  return {
    retryScope: undefined,
    enroll: vi.fn<SharedBotsClient['enroll']>().mockRejectedValue(new Error('unused test operation')),
    enrollOwner: vi.fn<NonNullable<SharedBotsClient['enrollOwner']>>().mockRejectedValue(new Error('unused test operation')),
    getOwnerCapability,
    restoreRetryScope: vi.fn<SharedBotsClient['restoreRetryScope']>().mockRejectedValue(new Error('unused test operation')),
    list: vi.fn<SharedBotsClient['list']>().mockResolvedValue({ ok: true, value: { bots: [] } }),
    readProfile: vi.fn<SharedBotsClient['readProfile']>().mockRejectedValue(new Error('unused test operation')),
    readPrivateChat: vi.fn<SharedBotsClient['readPrivateChat']>().mockRejectedValue(new Error('unused test operation')),
    readMemory: vi.fn<SharedBotsClient['readMemory']>().mockRejectedValue(new Error('unused test operation')),
    chat: vi.fn<SharedBotsClient['chat']>().mockRejectedValue(new Error('unused test operation')),
    writeMemory: vi.fn<SharedBotsClient['writeMemory']>().mockRejectedValue(new Error('unused test operation')),
    createInvite: vi.fn<SharedBotsClient['createInvite']>().mockRejectedValue(new Error('unused test operation')),
    revokeMember: vi.fn<SharedBotsClient['revokeMember']>().mockRejectedValue(new Error('unused test operation')),
  }
}

describe('Bot roster and detail', () => {
  it('submits the complete profile from the create dialog', async () => {
    const create = vi.fn(async () => {})
    render(<BotRoster
      bots={[]}
      selectedBotId={null}
      onSelectBot={vi.fn()}
      onCreateBot={create}
      t={t}
    />)

    fireEvent.click(screen.getAllByRole('button', { name: 'New bot' })[1]!)
    fireEvent.change(screen.getByRole('textbox', { name: 'Bot name' }), { target: { value: 'Release partner' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'What it does' }), { target: { value: 'Keeps releases moving.' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Instructions' }), { target: { value: 'Prefer concise evidence.' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Specialties' }), { target: { value: 'chat, release-review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create bot' }))

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith({
        name: 'Release partner', identity: 'agent', accent: 'violet',
        description: 'Keeps releases moving.',
        persona: 'Prefer concise evidence.',
        capabilities: ['chat', 'release-review'],
      })
    })
  })

  it('keeps profile fields available when creation fails', async () => {
    const create = vi.fn(async () => { throw new Error('offline') })
    render(<BotRoster
      bots={[]}
      selectedBotId={null}
      onSelectBot={vi.fn()}
      onCreateBot={create}
      t={t}
    />)

    fireEvent.click(screen.getAllByRole('button', { name: 'New bot' })[1]!)
    fireEvent.change(screen.getByRole('textbox', { name: 'Bot name' }), { target: { value: 'Retry partner' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Instructions' }), { target: { value: 'Keep trying.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create bot' }))

    await waitFor(() => { expect(create).toHaveBeenCalledOnce() })
    expect(screen.getByRole('dialog', { name: 'Create a bot' })).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Bot name' })).toHaveProperty('value', 'Retry partner')
    expect(screen.getByRole('textbox', { name: 'Instructions' })).toHaveProperty('value', 'Keep trying.')
  })

  it('edits profile fields without replacing the selected session surface', async () => {
    const updateProfile = vi.fn(async () => {})
    const botWithProfile = {
      ...bots[0]!,
      persona: 'Compare sources first.',
      capabilities: ['chat', 'research'] as const,
    }
    render(<BotDetail
      bot={botWithProfile}
      loading={false}
      loadAvatar={undefined}
      t={t}
      onUpdateProfile={updateProfile}
    ><span>Persistent session surface</span></BotDetail>)

    fireEvent.click(screen.getByRole('button', { name: 'Edit bot profile' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'What it does' }), { target: { value: 'Source scout updated' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Instructions' }), { target: { value: 'Lead with evidence.' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Specialties' }), { target: { value: 'chat, research, release-review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))

    await waitFor(() => {
      expect(updateProfile).toHaveBeenCalledWith('research', {
        expectedUpdatedAt: bots[0]!.updatedAt,
        name: 'Research partner', description: 'Source scout updated',
        persona: 'Lead with evidence.', capabilities: ['chat', 'research', 'release-review'],
      })
    })
    expect(screen.getByText('Persistent session surface')).toBeTruthy()
  })

  it('keeps the profile dialog open when saving fails', async () => {
    const updateProfile = vi.fn(async () => { throw new Error('offline') })
    render(<BotDetail
      bot={bots[0]}
      loading={false}
      loadAvatar={undefined}
      t={t}
      onUpdateProfile={updateProfile}
    ><span /></BotDetail>)

    fireEvent.click(screen.getByRole('button', { name: 'Edit bot profile' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Instructions' }), { target: { value: 'Keep the draft.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))

    expect((await screen.findByRole('alert')).textContent).toContain('The bot profile could not be saved')
    expect(screen.getByRole('textbox', { name: 'Instructions' })).toHaveProperty('value', 'Keep the draft.')
  })

  it('explains a stale profile conflict without discarding the draft', async () => {
    const updateProfile = vi.fn(async () => {
      const error = new Error('stale profile')
      error.name = 'BotProfileConflictError'
      throw error
    })
    render(<BotDetail
      bot={bots[0]}
      loading={false}
      loadAvatar={undefined}
      t={t}
      onUpdateProfile={updateProfile}
    ><span /></BotDetail>)

    fireEvent.click(screen.getByRole('button', { name: 'Edit bot profile' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Instructions' }), { target: { value: 'Keep my newer draft.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))

    expect((await screen.findByRole('alert')).textContent).toContain('changed elsewhere')
    expect(screen.getByRole('textbox', { name: 'Instructions' })).toHaveProperty('value', 'Keep my newer draft.')
    expect(screen.getByRole('dialog', { name: 'Edit bot profile' })).toBeTruthy()
  })

  it('does not let an earlier profile save close a newly selected Bot editor', async () => {
    const save = Promise.withResolvers<undefined>()
    const updateProfile = vi.fn().mockReturnValue(save.promise)
    const view = render(<BotDetail
      bot={bots[0]}
      loading={false}
      loadAvatar={undefined}
      t={t}
      onUpdateProfile={updateProfile}
    ><span /></BotDetail>)

    fireEvent.click(screen.getByRole('button', { name: 'Edit bot profile' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    await waitFor(() => { expect(updateProfile).toHaveBeenCalledOnce() })

    view.rerender(<BotDetail
      bot={bots[1]}
      loading={false}
      loadAvatar={undefined}
      t={t}
      onUpdateProfile={updateProfile}
    ><span /></BotDetail>)
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Edit bot profile' })).toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: 'Edit bot profile' }))
    expect(screen.getByRole('button', { name: /Save profile|Saving/ })).not.toHaveProperty('disabled', true)

    save.resolve(undefined)
    await waitFor(() => { expect(screen.getByRole('dialog', { name: 'Edit bot profile' })).toBeTruthy() })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not let an earlier profile failure mark a newly selected Bot editor', async () => {
    const save = Promise.withResolvers<undefined>()
    const updateProfile = vi.fn().mockReturnValue(save.promise)
    const view = render(<BotDetail
      bot={bots[0]}
      loading={false}
      loadAvatar={undefined}
      t={t}
      onUpdateProfile={updateProfile}
    ><span /></BotDetail>)

    fireEvent.click(screen.getByRole('button', { name: 'Edit bot profile' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    await waitFor(() => { expect(updateProfile).toHaveBeenCalledOnce() })

    view.rerender(<BotDetail
      bot={bots[1]}
      loading={false}
      loadAvatar={undefined}
      t={t}
      onUpdateProfile={updateProfile}
    ><span /></BotDetail>)
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Edit bot profile' })).toBeNull() })
    fireEvent.click(screen.getByRole('button', { name: 'Edit bot profile' }))
    save.reject(new Error('offline'))

    await waitFor(() => { expect(screen.getByRole('dialog', { name: 'Edit bot profile' })).toBeTruthy() })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: /Save profile|Saving/ })).not.toHaveProperty('disabled', true)
  })
  it('manages timed and event routines with a delete confirmation and history', async () => {
    const timed = {
      kind: 'schedule' as const,
      scheduleKind: 'every' as const,
      id: ScheduleId('schedule-release'),
      title: 'Release check',
      prompt: 'Check release status',
      everySeconds: 3600,
      scheduledAt: '2026-11-04T03:00:00.000Z',
      state: 'scheduled' as const,
      deliveryMode: 'host' as const,
      status: 'active' as const,
      botId: BotId('research'),
      sessionId: SessionId('session-research'),
    }
    const event = {
      kind: 'event' as const,
      id: 'event-review',
      title: 'Review messages',
      prompt: 'Review incoming messages',
      trigger: { type: 'message' as const, source: 'user' as const },
      status: 'paused' as const,
      createdAt: 1,
      updatedAt: 1,
      state: 'waiting' as const,
      deliveryMode: 'host' as const,
      botId: BotId('research'),
      sessionId: SessionId('session-research'),
    }
    const actions = {
      list: vi.fn(async () => [timed, event]),
      pause: vi.fn(async () => ({ ...timed, status: 'paused' as const })),
      resume: vi.fn(async () => ({ ...timed, status: 'active' as const })),
      remove: vi.fn(async () => {}),
      history: vi.fn(async () => ({ kind: 'schedule' as const, id: timed.id, records: [], earlierRecordsUnavailable: false, earlierRecordsPruned: false, retention: { days: 30, records: 200 } })),
    }
    render(<BotRoutineManager bot={bots[0]!} actions={actions} open onClose={vi.fn()} t={t} />)

    expect(await screen.findByRole('dialog', { name: 'Bot routines' })).toBeTruthy()
    expect(screen.getAllByText('Release check').length).toBeGreaterThan(0)
    expect(screen.getByText('Review messages')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Pause Release check' }))
    await waitFor(() => { expect(actions.pause).toHaveBeenCalledWith('research', 'schedule-release') })
    fireEvent.click(screen.getByRole('button', { name: 'View results for Release check' }))
    await waitFor(() => { expect(actions.history).toHaveBeenCalledWith('research', 'schedule-release') })
    fireEvent.click(screen.getByRole('button', { name: 'Delete Release check' }))
    expect(screen.getByRole('dialog', { name: 'Delete routine?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete routine' }))
    await waitFor(() => { expect(actions.remove).toHaveBeenCalledWith('research', 'schedule-release') })
  })

  it('opens routine management from the selected Bot header', async () => {
    const actions = {
      list: vi.fn(async () => []),
      pause: vi.fn(async () => { throw new Error('not used') }),
      resume: vi.fn(async () => { throw new Error('not used') }),
      remove: vi.fn(async () => {}),
      history: vi.fn(async () => ({ kind: 'event' as const, id: 'event-review', deliveries: [], results: [] })),
    }
    render(<BotDetail bot={bots[0]} loading={false} loadAvatar={undefined} t={t} routineManager={actions}><span /></BotDetail>)
    fireEvent.click(screen.getByRole('button', { name: 'Manage routines' }))
    expect(await screen.findByRole('dialog', { name: 'Bot routines' })).toBeTruthy()
  })

  it('shows a retryable routine loading failure', async () => {
    const list = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([])
    const actions = {
      list,
      pause: vi.fn(async () => { throw new Error('not used') }),
      resume: vi.fn(async () => { throw new Error('not used') }),
      remove: vi.fn(async () => {}),
      history: vi.fn(async () => ({ kind: 'event' as const, id: 'event-review', deliveries: [], results: [] })),
    }
    render(<BotRoutineManager bot={bots[0]!} actions={actions} open onClose={vi.fn()} t={t} />)
    expect(await screen.findByText('The bot’s routines could not be loaded. Try again.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(2) })
    expect(await screen.findByText('No routines yet')).toBeTruthy()
  })

  it('keeps history from an older selection out of the current routine', async () => {
    const first = Promise.withResolvers<BotRoutineHistory>()
    const second = Promise.withResolvers<BotRoutineHistory>()
    const routineA = {
      kind: 'event' as const,
      id: 'event-a',
      title: 'Routine A',
      prompt: 'Prompt A',
      trigger: { type: 'message' as const, source: 'user' as const },
      status: 'active' as const,
      createdAt: 1,
      updatedAt: 1,
      state: 'waiting' as const,
      deliveryMode: 'host' as const,
      botId: BotId('research'),
      sessionId: SessionId('session-research'),
    }
    const routineB = { ...routineA, id: 'event-b', title: 'Routine B', prompt: 'Prompt B' }
    const actions = {
      list: vi.fn(async () => [routineA, routineB]),
      pause: vi.fn(async () => routineA),
      resume: vi.fn(async () => routineA),
      remove: vi.fn(async () => {}),
      history: vi.fn((_: string, id: string) => id === 'event-a' ? first.promise : second.promise),
    }
    render(<BotRoutineManager bot={bots[0]!} actions={actions} open onClose={vi.fn()} t={t} />)
    await screen.findByRole('button', { name: 'View results for Routine A' })

    fireEvent.click(screen.getByRole('button', { name: 'View results for Routine A' }))
    fireEvent.click(screen.getByRole('button', { name: 'View results for Routine B' }))
    second.resolve({ kind: 'event', id: 'event-b', deliveries: [], results: [{ messageId: MessageId('result-b'), status: 'completed', completedAt: '2026-11-04T00:00:00.000Z', output: 'B result' }] })
    expect(await screen.findByText('B result')).toBeTruthy()
    first.resolve({ kind: 'event', id: 'event-a', deliveries: [], results: [{ messageId: MessageId('result-a'), status: 'completed', completedAt: '2026-11-04T00:00:00.000Z', output: 'A result' }] })
    await waitFor(() => { expect(screen.queryByText('A result')).toBeNull() })
  })

  it('reloads history when a routine revision interrupts the selected history request', async () => {
    const first = Promise.withResolvers<BotRoutineHistory>()
    const refreshed = Promise.withResolvers<BotRoutineHistory>()
    let historyCalls = 0
    const routine = {
      kind: 'event' as const,
      id: 'event-revision-history',
      title: 'Revision history routine',
      prompt: 'Revision history prompt',
      trigger: { type: 'message' as const, source: 'user' as const },
      status: 'active' as const,
      createdAt: 1,
      updatedAt: 1,
      state: 'waiting' as const,
      deliveryMode: 'host' as const,
      botId: BotId('research'),
      sessionId: SessionId('session-research'),
    }
    const actions = {
      list: vi.fn(async () => [routine]),
      pause: vi.fn(async () => routine),
      resume: vi.fn(async () => routine),
      remove: vi.fn(async () => {}),
      history: vi.fn(() => {
        historyCalls++
        return historyCalls === 1 ? first.promise : refreshed.promise
      }),
    }
    const view = render(<BotRoutineManager bot={bots[0]!} actions={actions} open onClose={vi.fn()} t={t} revision={0} />)
    await screen.findByRole('button', { name: 'View results for Revision history routine' })
    fireEvent.click(screen.getByRole('button', { name: 'View results for Revision history routine' }))
    expect(await screen.findByText('Loading routine history…')).toBeTruthy()

    view.rerender(<BotRoutineManager bot={bots[0]!} actions={actions} open onClose={vi.fn()} t={t} revision={1} />)
    await waitFor(() => { expect(actions.history).toHaveBeenCalledTimes(2) })
    first.resolve({ kind: 'event', id: routine.id, deliveries: [], results: [{ messageId: MessageId('stale-result'), status: 'completed', completedAt: '2026-11-04T00:00:00.000Z', output: 'Stale result' }] })
    refreshed.resolve({ kind: 'event', id: routine.id, deliveries: [], results: [{ messageId: MessageId('refreshed-result'), status: 'completed', completedAt: '2026-11-04T00:00:00.000Z', output: 'Refreshed result' }] })

    expect(await screen.findByText('Refreshed result')).toBeTruthy()
    expect(screen.queryByText('Stale result')).toBeNull()
  })

  it.each(['pause', 'resume', 'delete'] as const)('keeps a newer catalog after a stale %s completion', async (action) => {
    const initialStatus = action === 'resume' ? 'paused' as const : 'active' as const
    const initial = {
      kind: 'event' as const,
      id: `event-stale-${action}`,
      title: `Stale ${action} routine`,
      prompt: 'The old catalog must not win.',
      trigger: { type: 'message' as const, source: 'user' as const },
      status: initialStatus,
      createdAt: 1,
      updatedAt: 1,
      state: 'waiting' as const,
      deliveryMode: 'host' as const,
      botId: BotId('research'),
      sessionId: SessionId('session-research'),
    }
    const fresh = { ...initial, title: `Fresh ${action} catalog`, status: 'active' as const, updatedAt: 2 }
    const lifecycle = Promise.withResolvers<typeof initial>()
    const removal = Promise.withResolvers<undefined>()
    const list = vi.fn()
      .mockResolvedValueOnce([initial])
      .mockResolvedValue([fresh])
    const actions = {
      list,
      pause: vi.fn(() => action === 'pause' ? lifecycle.promise : Promise.resolve(fresh)),
      resume: vi.fn(() => action === 'resume' ? lifecycle.promise : Promise.resolve(fresh)),
      remove: vi.fn(() => action === 'delete' ? removal.promise : Promise.resolve()),
      history: vi.fn(async () => ({ kind: 'event' as const, id: initial.id, deliveries: [], results: [] })),
    }
    const view = render(<BotRoutineManager bot={bots[0]!} actions={actions} open onClose={vi.fn()} t={t} revision={0} />)
    await screen.findByRole('button', { name: `View results for ${initial.title}` })

    if (action === 'pause') {
      fireEvent.click(screen.getByRole('button', { name: `Pause ${initial.title}` }))
      await waitFor(() => { expect(actions.pause).toHaveBeenCalledWith('research', initial.id) })
    } else if (action === 'resume') {
      fireEvent.click(screen.getByRole('button', { name: `Resume ${initial.title}` }))
      await waitFor(() => { expect(actions.resume).toHaveBeenCalledWith('research', initial.id) })
    } else {
      fireEvent.click(screen.getByRole('button', { name: `Delete ${initial.title}` }))
      fireEvent.click(screen.getByRole('button', { name: 'Delete routine' }))
      await waitFor(() => { expect(actions.remove).toHaveBeenCalledWith('research', initial.id) })
    }

    view.rerender(<BotRoutineManager bot={bots[0]!} actions={actions} open onClose={vi.fn()} t={t} revision={1} />)
    expect(await screen.findAllByText(fresh.title)).not.toHaveLength(0)
    if (action === 'delete') removal.resolve(undefined)
    else lifecycle.resolve({ ...initial, status: action === 'pause' ? 'paused' : 'active' })
    await waitFor(() => { expect(screen.getAllByText(fresh.title)).not.toHaveLength(0) })
    expect(screen.queryAllByText(initial.title)).toHaveLength(0)
  })

  it('moves the detail selection into the active filter', async () => {
    const active = {
      kind: 'event' as const,
      id: 'event-active',
      title: 'Active routine',
      prompt: 'Active prompt',
      trigger: { type: 'message' as const, source: 'user' as const },
      status: 'active' as const,
      createdAt: 1,
      updatedAt: 1,
      state: 'waiting' as const,
      deliveryMode: 'host' as const,
      botId: BotId('research'),
      sessionId: SessionId('session-research'),
    }
    const paused = { ...active, id: 'event-paused', title: 'Paused routine', prompt: 'Paused prompt', status: 'paused' as const }
    const actions = {
      list: vi.fn(async () => [active, paused]),
      pause: vi.fn(async () => paused),
      resume: vi.fn(async () => active),
      remove: vi.fn(async () => {}),
      history: vi.fn(async () => ({ kind: 'event' as const, id: paused.id, deliveries: [], results: [] })),
    }
    render(<BotRoutineManager bot={bots[0]!} actions={actions} open onClose={vi.fn()} t={t} />)
    await screen.findByRole('button', { name: 'View results for Active routine' })
    fireEvent.click(screen.getByRole('tab', { name: 'Paused' }))
    const detail = screen.getByRole('region', { name: 'Routine details' })
    expect(within(detail).getByText('Paused prompt')).toBeTruthy()
  })

  it('clears a selected routine when a status change removes it from the filter', async () => {
    const active = {
      kind: 'event' as const,
      id: 'event-filter-active',
      title: 'Filter active routine',
      prompt: 'Filter active prompt',
      trigger: { type: 'message' as const, source: 'user' as const },
      status: 'active' as const,
      createdAt: 1,
      updatedAt: 1,
      state: 'waiting' as const,
      deliveryMode: 'host' as const,
      botId: BotId('research'),
      sessionId: SessionId('session-research'),
    }
    const actions = {
      list: vi.fn(async () => [active]),
      pause: vi.fn(async () => ({ ...active, status: 'paused' as const })),
      resume: vi.fn(async () => active),
      remove: vi.fn(async () => {}),
      history: vi.fn(async () => ({ kind: 'event' as const, id: active.id, deliveries: [], results: [] })),
    }
    render(<BotRoutineManager bot={bots[0]!} actions={actions} open onClose={vi.fn()} t={t} />)
    await screen.findByRole('button', { name: 'View results for Filter active routine' })
    fireEvent.click(screen.getByRole('tab', { name: 'Enabled' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause Filter active routine' }))
    await waitFor(() => { expect(actions.pause).toHaveBeenCalledWith('research', active.id) })
    expect(await screen.findByText('No routines match this filter')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Routine details' })).toBeNull()
  })

  it('shows weekly weekdays in the routine rule', async () => {
    const weekly = {
      kind: 'schedule' as const,
      scheduleKind: 'weekly' as const,
      id: ScheduleId('schedule-weekly'),
      title: 'Weekly review',
      prompt: 'Review the week',
      time: '09:00:00',
      timeZone: 'UTC',
      weekdays: [1, 3],
      scheduledAt: '2026-11-04T01:00:00.000Z',
      state: 'scheduled' as const,
      deliveryMode: 'host' as const,
      status: 'active' as const,
      botId: BotId('research'),
      sessionId: SessionId('session-research'),
    }
    const actions = {
      list: vi.fn(async () => [weekly]),
      pause: vi.fn(async () => ({ ...weekly, status: 'paused' as const })),
      resume: vi.fn(async () => weekly),
      remove: vi.fn(async () => {}),
      history: vi.fn(async () => ({ kind: 'schedule' as const, id: weekly.id, records: [], earlierRecordsUnavailable: false, earlierRecordsPruned: false, retention: { days: 30, records: 200 } })),
    }
    render(<BotRoutineManager bot={bots[0]!} actions={actions} open onClose={vi.fn()} t={t} />)
    await screen.findByRole('button', { name: 'View results for Weekly review' })
    expect(screen.getByText('Runs weekly on Monday, Wednesday at 09:00:00 (UTC)')).toBeTruthy()
  })

  it('renders every routine timing family and status', async () => {
    const schedule = (scheduleKind: string, title: string, patch: {
      readonly afterSeconds?: number
      readonly everySeconds?: number
      readonly time?: string
      readonly timeZone?: string
      readonly weekdays?: readonly number[]
      readonly expression?: string
      readonly status?: 'active' | 'paused' | 'inactive'
    } = {}) => ({
      kind: 'schedule' as const,
      scheduleKind: scheduleKind as never,
      id: ScheduleId(`schedule-${title}`),
      title,
      prompt: `${title} prompt`,
      ...patch,
      scheduledAt: '2026-11-04T03:00:00.000Z',
      state: 'scheduled' as const,
      deliveryMode: 'host' as const,
      status: patch.status ?? 'active',
      botId: BotId('research'),
      sessionId: SessionId('session-research'),
    })
    const routines = [
      schedule('after', 'After rule', { afterSeconds: 15 }),
      schedule('at', 'At rule'),
      schedule('every', 'Every rule', { everySeconds: 60 }),
      schedule('daily', 'Daily rule', { time: '08:00:00', timeZone: 'UTC' }),
      schedule('weekly', 'Weekly rule', { time: '09:00:00', timeZone: 'UTC', weekdays: [1, 2, 3, 4, 5, 6, 7, 8] }),
      schedule('cron', 'Cron rule', { expression: '0 9 * * *', timeZone: 'UTC' }),
      schedule('other', 'Unknown rule'),
      schedule('every', 'Ended rule', { status: 'inactive' as const }),
      {
        kind: 'event' as const,
        id: 'event-bot-source',
        title: 'Bot source rule',
        prompt: 'Bot source prompt',
        trigger: { type: 'message' as const, source: 'bot' as const },
        status: 'paused' as const,
        createdAt: 1,
        updatedAt: 1,
        state: 'waiting' as const,
        deliveryMode: 'host' as const,
        botId: BotId('research'),
        sessionId: SessionId('session-research'),
      },
    ]
    const actions = {
      list: vi.fn(async () => routines),
      pause: vi.fn(async (_botId: string, routineId: string) => routines.find(routine => String(routine.id) === routineId)!),
      resume: vi.fn(async (_botId: string, routineId: string) => routines.find(routine => String(routine.id) === routineId)!),
      remove: vi.fn(async () => {}),
      history: vi.fn(async () => ({ kind: 'event' as const, id: 'event-bot-source', deliveries: [], results: [] })),
    }
    render(<BotRoutineManager bot={bots[0]!} actions={actions} open onClose={vi.fn()} t={t} />)
    await screen.findByRole('button', { name: 'View results for After rule' })
    const detail = () => screen.getByRole('region', { name: 'Routine details' })
    expect(within(detail()).getByText('Runs once in 15 seconds')).toBeTruthy()

    const expectedRules = [
      ['At rule', /^Runs at /],
      ['Every rule', 'Repeats every minute'],
      ['Daily rule', 'Runs daily at 08:00:00 (UTC)'],
      ['Weekly rule', 'Runs weekly on Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday, 8 at 09:00:00 (UTC)'],
      ['Cron rule', 'Cron 0 9 * * * (UTC)'],
      ['Unknown rule', 'Timed routine'],
      ['Ended rule', 'Repeats every 0 seconds'],
      ['Bot source rule', 'Runs when a message arrives from another bot'],
    ] as const
    for (const [title, rule] of expectedRules) {
      const list = screen.getByRole('list', { name: 'Bot routines' })
      fireEvent.click(within(list).getByText(title).closest('button')!)
      expect(within(detail()).getByText(rule)).toBeTruthy()
    }
    expect(screen.getByRole('button', { name: 'Delete Ended rule' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pause Ended rule' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Resume Ended rule' })).toBeNull()
  })

  it('formats routine intervals in readable units without losing precision', async () => {
    const routine = (scheduleKind: 'after' | 'every', title: string, seconds: number) => ({
      kind: 'schedule' as const,
      scheduleKind,
      id: ScheduleId(`schedule-${title}`),
      title,
      prompt: `${title} prompt`,
      ...(scheduleKind === 'after' ? { afterSeconds: seconds } : { everySeconds: seconds }),
      scheduledAt: '2026-11-04T03:00:00.000Z',
      state: 'scheduled' as const,
      deliveryMode: 'host' as const,
      status: 'active' as const,
      botId: BotId('research'),
      sessionId: SessionId('session-research'),
    })
    const routines = [
      routine('every', 'Daily cadence', 86_400),
      routine('every', 'Hourly cadence', 3_600),
      routine('every', 'Ninety second cadence', 90),
      routine('after', 'Half second delay', 0.5),
    ]
    const actions = {
      list: vi.fn(async () => routines),
      pause: vi.fn(async (_botId: string, routineId: string) => routines.find(candidate => String(candidate.id) === routineId)!),
      resume: vi.fn(async (_botId: string, routineId: string) => routines.find(candidate => String(candidate.id) === routineId)!),
      remove: vi.fn(async () => {}),
      history: vi.fn(async () => ({ kind: 'event' as const, id: 'event-routine', deliveries: [], results: [] })),
    }
    render(<BotRoutineManager bot={bots[0]!} actions={actions} open onClose={vi.fn()} t={t} />)

    await screen.findByRole('button', { name: 'View results for Daily cadence' })
    const detail = () => screen.getByRole('region', { name: 'Routine details' })
    expect(within(detail()).getByText('Repeats every day')).toBeTruthy()

    const list = screen.getByRole('list', { name: 'Bot routines' })
    fireEvent.click(within(list).getByText('Hourly cadence').closest('button')!)
    expect(within(detail()).getByText('Repeats every hour')).toBeTruthy()
    fireEvent.click(within(list).getByText('Ninety second cadence').closest('button')!)
    expect(within(detail()).getByText('Repeats every 1 minute 30 seconds')).toBeTruthy()
    fireEvent.click(within(list).getByText('Half second delay').closest('button')!)
    expect(within(detail()).getByText('Runs once in 0.5 seconds')).toBeTruthy()
  })

  it('renders event deliveries and controls older schedule history', async () => {
    const event = {
      kind: 'event' as const,
      id: 'event-delivery',
      title: 'Incoming review',
      prompt: 'Review incoming messages',
      trigger: { type: 'message' as const, source: 'user' as const },
      status: 'active' as const,
      createdAt: 1,
      updatedAt: 1,
      state: 'waiting' as const,
      deliveryMode: 'host' as const,
      botId: BotId('research'),
      sessionId: SessionId('session-research'),
    }
    const schedule = {
      kind: 'schedule' as const,
      scheduleKind: 'every' as const,
      id: ScheduleId('schedule-history'),
      title: 'History check',
      prompt: 'Check history',
      everySeconds: 600,
      scheduledAt: '2026-11-04T03:00:00.000Z',
      state: 'scheduled' as const,
      deliveryMode: 'host' as const,
      status: 'active' as const,
      botId: BotId('research'),
      sessionId: SessionId('session-research'),
    }
    const olderCursor = MessageId('older-cursor')
    const firstPage = {
      kind: 'schedule' as const,
      id: schedule.id,
      records: [
        { messageId: MessageId('record-new'), scheduledAt: '2026-11-04T00:59:00.000Z', deliveredAt: '2026-11-04T01:00:00.000Z', prompt: 'New run' },
        { messageId: MessageId('record-legacy'), scheduledAt: '2026-11-03T00:59:00.000Z', deliveredAt: 'not-a-date' },
      ],
      earlierRecordsUnavailable: true,
      earlierRecordsPruned: true,
      retention: { days: 30, records: 200 },
      nextBefore: olderCursor,
    }
    const { nextBefore: unusedCursor, ...firstPageWithoutCursor } = firstPage
    void unusedCursor
    const olderPage = {
      ...firstPageWithoutCursor,
      records: [
        { messageId: MessageId('record-new'), scheduledAt: '2026-11-04T00:59:00.000Z', deliveredAt: '2026-11-04T01:00:00.000Z', prompt: 'New run' },
        { messageId: MessageId('record-old'), scheduledAt: '2026-11-03T00:59:00.000Z', deliveredAt: '2026-11-03T01:00:00.000Z', prompt: 'Old run' },
      ],
      earlierRecordsPruned: false,
    }
    const olderFailure = Promise.withResolvers<typeof olderPage>()
    const olderSuccess = Promise.withResolvers<typeof olderPage>()
    let olderCalls = 0
    const history = vi.fn(async (_botId: string, routineId: string, before?: MessageId) => {
      if (routineId === event.id) return {
        kind: 'event' as const,
        id: event.id,
        deliveries: [
          { triggerEventSeq: 1, messageId: MessageId('delivery-1'), status: 'pending' as const, createdAt: '2026-11-04T00:00:00.000Z' },
          { triggerEventSeq: 2, messageId: MessageId('delivery-2'), status: 'delivered' as const, createdAt: 'not-a-date' },
        ],
        results: [
          { messageId: MessageId('result-error'), status: 'error' as const, completedAt: 'not-a-date', error: 'The run failed.' },
          { messageId: MessageId('result-empty'), status: 'blocked' as const, completedAt: '2026-11-04T00:00:00.000Z' },
        ],
      }
      if (before === undefined) return firstPage
      olderCalls++
      return olderCalls === 1 ? olderFailure.promise : olderSuccess.promise
    })
    const actions = {
      list: vi.fn(async () => [event, schedule]),
      pause: vi.fn(async () => event),
      resume: vi.fn(async () => event),
      remove: vi.fn(async () => {}),
      history,
    }
    render(<BotRoutineManager bot={bots[0]!} actions={actions} open onClose={vi.fn()} t={t} />)
    await screen.findByRole('button', { name: 'View results for Incoming review' })
    fireEvent.click(screen.getByRole('button', { name: 'View results for Incoming review' }))
    expect(await screen.findByText('Waiting for delivery')).toBeTruthy()
    expect(screen.getByText('Delivered')).toBeTruthy()
    expect(screen.getByText('The run failed.')).toBeTruthy()
    expect(screen.getByText('No visible output.')).toBeTruthy()
    expect(screen.getByText('Failed')).toBeTruthy()
    expect(screen.getByText('Blocked')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View results for History check' }))
    expect(await screen.findByText('New run')).toBeTruthy()
    expect(screen.getByText('Delivery recorded before prompt history was retained.')).toBeTruthy()
    expect(screen.getByText('Some older runs are unavailable.')).toBeTruthy()
    expect(screen.getByText('Older runs were pruned by retention.')).toBeTruthy()
    expect(screen.getByText('History kept for 30 days or 200 runs.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Load older runs' }))
    olderFailure.reject(new Error('history page unavailable'))
    expect(await screen.findByText('Routine history could not be loaded. Try again.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Load older runs' }))
    expect(screen.getByRole('button', { name: 'Loading older runs…' })).toHaveProperty('disabled', true)
    await waitFor(() => { expect(history).toHaveBeenLastCalledWith('research', 'schedule-history', olderCursor) })
    olderSuccess.resolve(olderPage)
    expect(await screen.findByText('Old run')).toBeTruthy()
    expect(screen.getAllByText('New run')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Load older runs' })).toBeNull()
  })

  it('keeps routine state visible when lifecycle and history operations fail', async () => {
    const active = {
      kind: 'event' as const,
      id: 'event-failure',
      title: 'Failure routine',
      prompt: 'Failure prompt',
      trigger: { type: 'message' as const, source: 'user' as const },
      status: 'active' as const,
      createdAt: 1,
      updatedAt: 1,
      state: 'waiting' as const,
      deliveryMode: 'host' as const,
      botId: BotId('research'),
      sessionId: SessionId('session-research'),
    }
    const paused = { ...active, id: 'event-paused-failure', title: 'Paused failure', status: 'paused' as const }
    const history = vi.fn()
      .mockRejectedValueOnce(new Error('history unavailable'))
      .mockResolvedValue({ kind: 'event' as const, id: active.id, deliveries: [], results: [] })
    const actions = {
      list: vi.fn(async () => [active, paused]),
      pause: vi.fn(async () => { throw new Error('pause unavailable') }),
      resume: vi.fn(async () => { throw new Error('resume unavailable') }),
      remove: vi.fn(async () => { throw new Error('delete unavailable') }),
      history,
    }
    render(<BotRoutineManager bot={bots[0]!} actions={actions} open onClose={vi.fn()} t={t} />)
    await screen.findByRole('button', { name: 'View results for Failure routine' })
    fireEvent.click(screen.getByRole('button', { name: 'Pause Failure routine' }))
    expect((await screen.findByRole('alert')).textContent).toContain('That routine change could not be saved')
    fireEvent.click(screen.getByRole('button', { name: 'Resume Paused failure' }))
    expect((await screen.findByRole('alert')).textContent).toContain('That routine change could not be saved')
    fireEvent.click(screen.getByRole('button', { name: 'View results for Failure routine' }))
    expect(await screen.findByText('Routine history could not be loaded. Try again.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('No deliveries recorded yet.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Failure routine' }))
    const confirmation = screen.getByRole('dialog', { name: 'Delete routine?' })
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Delete routine' }))
    expect(await within(confirmation).findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Failure routine')).toBeTruthy()
  })

  it('ignores a routine list that settles after the manager unmounts', async () => {
    const list = Promise.withResolvers<readonly []>()
    const actions = {
      list: vi.fn(() => list.promise),
      pause: vi.fn(async () => { throw new Error('not used') }),
      resume: vi.fn(async () => { throw new Error('not used') }),
      remove: vi.fn(async () => {}),
      history: vi.fn(async () => ({ kind: 'event' as const, id: 'event-review', deliveries: [], results: [] })),
    }
    const view = render(<BotRoutineManager bot={bots[0]!} actions={actions} open onClose={vi.fn()} t={t} />)
    view.unmount()
    list.resolve([])
    await list.promise
  })

  it('cancels a pending history request when the manager closes', async () => {
    const history = Promise.withResolvers<BotRoutineHistory>()
    const onClose = vi.fn()
    const routine = {
      kind: 'event' as const,
      id: 'event-close',
      title: 'Close routine',
      prompt: 'Close prompt',
      trigger: { type: 'message' as const, source: 'user' as const },
      status: 'active' as const,
      createdAt: 1,
      updatedAt: 1,
      state: 'waiting' as const,
      deliveryMode: 'host' as const,
      botId: BotId('research'),
      sessionId: SessionId('session-research'),
    }
    const actions = {
      list: vi.fn(async () => [routine]),
      pause: vi.fn(async () => routine),
      resume: vi.fn(async () => routine),
      remove: vi.fn(async () => {}),
      history: vi.fn(() => history.promise),
    }
    render(<BotRoutineManager bot={bots[0]!} actions={actions} open onClose={onClose} t={t} />)
    await screen.findByRole('button', { name: 'View results for Close routine' })
    fireEvent.click(screen.getByRole('button', { name: 'View results for Close routine' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
    expect(onClose).toHaveBeenCalledOnce()
    history.resolve({ kind: 'event', id: routine.id, deliveries: [], results: [{ messageId: MessageId('late-result'), status: 'completed', completedAt: '2026-11-04T00:00:00.000Z', output: 'Late result' }] })
    await history.promise
    expect(screen.queryByText('Late result')).toBeNull()
  })

  it('drops a removed selection after a catalog revision', async () => {
    const active = {
      kind: 'event' as const,
      id: 'event-revision-active',
      title: 'Revision active',
      prompt: 'Revision active prompt',
      trigger: { type: 'message' as const, source: 'user' as const },
      status: 'active' as const,
      createdAt: 1,
      updatedAt: 1,
      state: 'waiting' as const,
      deliveryMode: 'host' as const,
      botId: BotId('research'),
      sessionId: SessionId('session-research'),
    }
    const paused = { ...active, id: 'event-revision-paused', title: 'Revision paused', prompt: 'Revision paused prompt', status: 'paused' as const }
    const list = vi.fn()
      .mockResolvedValueOnce([active])
      .mockResolvedValueOnce([paused])
    const actions = {
      list,
      pause: vi.fn(async () => active),
      resume: vi.fn(async () => paused),
      remove: vi.fn(async () => {}),
      history: vi.fn(async () => ({ kind: 'event' as const, id: paused.id, deliveries: [], results: [] })),
    }
    const view = render(<BotRoutineManager bot={bots[0]!} actions={actions} open onClose={vi.fn()} t={t} revision={0} />)
    await screen.findByRole('button', { name: 'View results for Revision active' })
    fireEvent.click(screen.getByRole('button', { name: 'View results for Revision active' }))
    expect(await screen.findByText('No deliveries recorded yet.')).toBeTruthy()
    view.rerender(<BotRoutineManager bot={bots[0]!} actions={actions} open onClose={vi.fn()} t={t} revision={1} />)
    expect(await screen.findByRole('button', { name: 'View results for Revision paused' })).toBeTruthy()
    const detail = screen.getByRole('region', { name: 'Routine details' })
    expect(within(detail).getByText('Revision paused prompt')).toBeTruthy()
    expect(within(detail).getByRole('tab', { name: 'Rule' }).getAttribute('aria-selected')).toBe('true')
  })

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

  it('hides shared-group controls when the group Remote surface is unavailable', () => {
    render(<BotRoster
      bots={bots}
      groups={[sharedGroup]}
      selectedBotId="research"
      selectedGroupId={null}
      onSelectBot={vi.fn()}
      onCreateBot={vi.fn()}
      t={t}
    />)

    expect(screen.queryByRole('heading', { name: 'Bot groups' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New bot group' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Release room' })).toBeNull()
  })

  it('opens the template share surface from the existing Bot sidebar', async () => {
    const actions: BotTemplateActions = {
      setTemplateCode: vi.fn(),
      publishTemplate: vi.fn(async () => {}),
      revokeTemplate: vi.fn(async () => {}),
      previewTemplate: vi.fn(async () => {}),
      importTemplate: vi.fn(async () => {}),
    }
    render(<BotRoster
      bots={bots}
      selectedBotId="research"
      onSelectBot={vi.fn()}
      onCreateBot={vi.fn()}
      templates={templateState}
      templateActions={actions}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'Bot templates' }))
    expect(screen.getByRole('dialog', { name: 'Bot templates' })).toBeTruthy()
    expect(screen.getByText('Release partner')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Share' })[0]!)
    await waitFor(() => { expect(actions.publishTemplate).toHaveBeenCalledWith({ botId: BotId('research') }) })

    const code = screen.getByRole('textbox', { name: 'Template share code' })
    expect(code.getAttribute('placeholder')).toBe('Paste a yhbot-template-v2.… code')
    fireEvent.change(code, { target: { value: 'bot-template-release-2' } })
    expect(actions.setTemplateCode).toHaveBeenCalledWith('bot-template-release-2')
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await waitFor(() => { expect(actions.previewTemplate).toHaveBeenCalledOnce() })
  })

  it('does not preview a template from Enter while another template action is busy', () => {
    const actions: BotTemplateActions = {
      setTemplateCode: vi.fn(),
      publishTemplate: vi.fn(async () => {}),
      revokeTemplate: vi.fn(async () => {}),
      previewTemplate: vi.fn(async () => {}),
      importTemplate: vi.fn(async () => {}),
    }
    render(<BotRoster
      bots={bots}
      selectedBotId="research"
      onSelectBot={vi.fn()}
      onCreateBot={vi.fn()}
      templates={{ ...templateState, busy: true }}
      templateActions={actions}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'Bot templates' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Template share code' }), { key: 'Enter' })

    expect(actions.previewTemplate).not.toHaveBeenCalled()
  })

  it('shows signed issuer and configuration details before approval', async () => {
    const preview = {
      ...templateState.templates[0]!,
      issuerFingerprint: 'issuer-fingerprint-123',
      fingerprint: 'artifact-fingerprint-456',
      persona: 'Summarize evidence before recommending action.',
      capabilities: ['chat', 'collaboration'],
      agentPreset: 'research-preset',
      avatar: { mediaType: 'image/png' as const, data: 'AQID', bytes: 3, width: 1, height: 1 },
      localPermissions: { status: 'resolved' as const, preset: 'research-preset', tools: ['chat', 'read_file'] },
    }
    const actions: BotTemplateActions = {
      setTemplateCode: vi.fn(),
      publishTemplate: vi.fn(async () => {}),
      revokeTemplate: vi.fn(async () => {}),
      previewTemplate: vi.fn(async () => {}),
      importTemplate: vi.fn(async () => {}),
    }
    render(<BotRoster
      bots={bots}
      selectedBotId="research"
      onSelectBot={vi.fn()}
      onCreateBot={vi.fn()}
      templates={{ ...templateState, preview }}
      templateActions={actions}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'Bot templates' }))
    expect(screen.getByText('issuer-fingerprint-123')).toBeTruthy()
    expect(screen.getByText('artifact-fingerprint-456')).toBeTruthy()
    expect(screen.getByText('Summarize evidence before recommending action.')).toBeTruthy()
    expect(screen.getByText('chat, collaboration')).toBeTruthy()
    expect(screen.getAllByText('research-preset')).toHaveLength(2)
    expect(screen.getByRole('img', { name: 'Portable template avatar' }).getAttribute('src')).toBe('data:image/png;base64,AQID')
    expect(screen.getByText('chat, read_file')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve and create Bot' })).toBeTruthy()
  })

  it('does not offer approval when local permissions are unavailable', async () => {
    const preview = {
      ...templateState.templates[0]!,
      issuerFingerprint: 'issuer-fingerprint-unavailable',
      fingerprint: 'artifact-fingerprint-unavailable',
      localPermissions: { status: 'unavailable' as const, preset: 'research-preset', tools: [] },
    }
    const actions: BotTemplateActions = {
      setTemplateCode: vi.fn(),
      publishTemplate: vi.fn(async () => {}),
      revokeTemplate: vi.fn(async () => {}),
      previewTemplate: vi.fn(async () => {}),
      importTemplate: vi.fn(async () => {}),
    }
    render(<BotRoster
      bots={bots}
      selectedBotId="research"
      onSelectBot={vi.fn()}
      onCreateBot={vi.fn()}
      templates={{ ...templateState, preview }}
      templateActions={actions}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'Bot templates' }))
    const importButton = screen.getByRole('button', { name: 'Approve and create Bot' })
    expect(importButton).toHaveProperty('disabled', true)
    expect(screen.getByText('Unavailable on this Host')).toBeTruthy()
  })

  it('keeps a newer replacement-name draft when an older import resolves', async () => {
    const importResult = Promise.withResolvers<undefined>()
    const actions: BotTemplateActions = {
      setTemplateCode: vi.fn(),
      publishTemplate: vi.fn(async () => {}),
      revokeTemplate: vi.fn(async () => {}),
      previewTemplate: vi.fn(async () => {}),
      importTemplate: vi.fn(async () => { await importResult.promise }),
    }
    const preview = {
      ...templateState.templates[0]!,
      issuerFingerprint: 'issuer-fingerprint-name-race',
      fingerprint: 'artifact-fingerprint-name-race',
      localPermissions: { status: 'resolved' as const, preset: 'research-preset', tools: ['read_file'] },
    }
    render(<BotTemplatesPanel
      bots={bots}
      state={{ ...templateState, preview }}
      actions={actions}
      t={t}
      open
      onClose={vi.fn()}
    />)

    const name = screen.getByRole('textbox', { name: 'Imported Bot name' })
    fireEvent.change(name, { target: { value: 'Older draft name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Approve and create Bot' }))
    fireEvent.change(name, { target: { value: 'Newer draft name' } })
    importResult.resolve(undefined)

    await waitFor(() => { expect(name).toHaveProperty('value', 'Newer draft name') })
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

  it('keeps the shared-Bot join action reachable in the collapsed rail', async () => {
    const sharedClient: SharedBotsClient = {
      retryScope: undefined,
      enroll: vi.fn<SharedBotsClient['enroll']>().mockRejectedValue(new Error('unused test operation')),
      restoreRetryScope: vi.fn<SharedBotsClient['restoreRetryScope']>().mockRejectedValue(new Error('unused test operation')),
      list: vi.fn<SharedBotsClient['list']>().mockResolvedValue({ ok: true, value: { bots: [] } }),
      readProfile: vi.fn<SharedBotsClient['readProfile']>().mockRejectedValue(new Error('unused test operation')),
      readPrivateChat: vi.fn<SharedBotsClient['readPrivateChat']>().mockRejectedValue(new Error('unused test operation')),
      readMemory: vi.fn<SharedBotsClient['readMemory']>().mockRejectedValue(new Error('unused test operation')),
      chat: vi.fn<SharedBotsClient['chat']>().mockRejectedValue(new Error('unused test operation')),
      writeMemory: vi.fn<SharedBotsClient['writeMemory']>().mockRejectedValue(new Error('unused test operation')),
      createInvite: vi.fn<SharedBotsClient['createInvite']>().mockRejectedValue(new Error('unused test operation')),
      revokeMember: vi.fn<SharedBotsClient['revokeMember']>().mockRejectedValue(new Error('unused test operation')),
    }
    const expandSidebar = vi.fn()
    render(<BotRoster
      bots={bots}
      selectedBotId="research"
      onSelectBot={vi.fn()}
      onCreateBot={vi.fn()}
      sharedClient={sharedClient}
      expandSidebar={expandSidebar}
      wide={false}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'Join a shared bot' }))

    expect(expandSidebar).toHaveBeenCalledOnce()
    expect(await screen.findByRole('dialog', { name: 'Shared with you' })).toBeTruthy()
  })

  it('disables owner setup when the server does not advertise this connection', async () => {
    const getOwnerCapability = vi.fn<NonNullable<SharedBotsClient['getOwnerCapability']>>()
      .mockResolvedValueOnce({ ownerBootstrap: false })
      .mockResolvedValueOnce({ ownerBootstrap: true })
    const sharedClient = ownerCapabilityClient(getOwnerCapability)
    render(<BotRoster
      bots={bots}
      selectedBotId="research"
      onSelectBot={vi.fn()}
      onCreateBot={vi.fn()}
      sharedClient={sharedClient}
      t={t}
    />)

    await waitFor(() => { expect(getOwnerCapability).toHaveBeenCalledOnce() })
    const ownerButton = screen.getByRole('button', { name: 'Create a shared group' }) as HTMLButtonElement
    expect(ownerButton.disabled).toBe(true)
    expect(ownerButton.getAttribute('title')).toBe('Shared owner setup is unavailable in this connection.')

    window.dispatchEvent(new Event('focus'))
    await waitFor(() => { expect(getOwnerCapability).toHaveBeenCalledTimes(2) })
    expect((screen.getByRole('button', { name: 'Create a shared group' }) as HTMLButtonElement).disabled).toBe(false)
    window.dispatchEvent(new Event('focus'))
    expect(getOwnerCapability).toHaveBeenCalledTimes(2)
  })

  it('bounds repeated owner capability retries while the connection remains unavailable', async () => {
    const getOwnerCapability = vi.fn<NonNullable<SharedBotsClient['getOwnerCapability']>>().mockResolvedValue({ ownerBootstrap: false })
    render(<BotRoster
      bots={bots}
      selectedBotId="research"
      onSelectBot={vi.fn()}
      onCreateBot={vi.fn()}
      sharedClient={ownerCapabilityClient(getOwnerCapability)}
      t={t}
    />)

    await waitFor(() => { expect(getOwnerCapability).toHaveBeenCalledOnce() })
    for (let index = 0; index < 6; index += 1) window.dispatchEvent(new Event('focus'))
    await waitFor(() => { expect(getOwnerCapability).toHaveBeenCalledTimes(4) })
    window.dispatchEvent(new Event('focus'))
    expect(getOwnerCapability).toHaveBeenCalledTimes(4)
  })

  it('rechecks owner capability when Connection readiness changes while the roster stays mounted', async () => {
    let onGeneration: (() => void) | undefined
    let capabilityCalls = 0
    const rpc: ClientConnectionRpc = {
      call: vi.fn(async (_channel, endpoint, payload) => {
        expect(endpoint).toBe('bots/share/enroll')
        expect(payload).toEqual({ capability: true })
        capabilityCalls += 1
        return { ok: true as const, value: { ownerBootstrap: capabilityCalls > 1 } }
      }),
    }
    const client = createSharedBotsClient(rpc, {
      subscribeConnectionGeneration: (listener) => {
        onGeneration = listener
        return () => { onGeneration = undefined }
      },
    })
    const view = render(<BotRoster
      bots={bots}
      selectedBotId="research"
      onSelectBot={vi.fn()}
      onCreateBot={vi.fn()}
      sharedClient={client}
      t={t}
    />)

    await waitFor(() => { expect(capabilityCalls).toBe(1) })
    expect((screen.getByRole('button', { name: 'Create a shared group' }) as HTMLButtonElement).disabled).toBe(true)
    if (onGeneration === undefined) throw new Error('Connection generation listener was not registered')
    await act(async () => { onGeneration?.() })
    await waitFor(() => {
      expect(capabilityCalls).toBe(2)
      expect((screen.getByRole('button', { name: 'Create a shared group' }) as HTMLButtonElement).disabled).toBe(false)
    })
    view.unmount()
    client.dispose?.()
    expect(onGeneration).toBeUndefined()
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

  it('closes the selected bot memory manager from the footer action', async () => {
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
    const dialog = await screen.findByRole('dialog', { name: 'Bot memory' })
    fireEvent.click(within(dialog).getAllByRole('button', { name: /^Close$/ }).at(-1)!)

    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Bot memory' })).toBeNull() })
  })

  it('does not apply a pending edit from the previous Bot after selection changes', async () => {
    let resolveUpdate!: (memory: BotMemorySummary) => void
    const pendingUpdate = new Promise<BotMemorySummary>((resolve) => { resolveUpdate = resolve })
    const actions: BotMemoryManagerActions = {
      list: vi.fn(async (botId: string) => botId === 'research'
        ? [{ id: 'memory-shared', text: 'Research note', createdAt: 1 }]
        : [{ id: 'memory-shared', text: 'Release note', createdAt: 2 }]),
      update: vi.fn(async () => pendingUpdate),
      remove: vi.fn(async () => {}),
    }
    const view = render(<BotDetail
      bot={bots[0]}
      loading={false}
      loadAvatar={undefined}
      memoryManager={actions}
      t={t}
    >
      <p>Persistent session surface</p>
    </BotDetail>)

    fireEvent.click(screen.getByRole('button', { name: 'Manage memories' }))
    const researchRow = await screen.findByRole('listitem', { name: 'memory-shared' })
    fireEvent.click(within(researchRow).getByRole('button', { name: 'Edit memory memory-shared' }))
    fireEvent.change(within(researchRow).getByRole('textbox', { name: 'Memory text' }), { target: { value: 'Updated research note' } })
    fireEvent.click(within(researchRow).getByRole('button', { name: 'Save memory' }))
    await waitFor(() => { expect(actions.update).toHaveBeenCalledWith('research', 'memory-shared', 'Updated research note') })

    view.rerender(<BotDetail
      bot={bots[1]}
      loading={false}
      loadAvatar={undefined}
      memoryManager={actions}
      t={t}
    >
      <p>Persistent session surface</p>
    </BotDetail>)
    expect(await screen.findByText('Release note')).toBeTruthy()

    resolveUpdate({ id: 'memory-shared', text: 'Updated research note', createdAt: 3 })
    await waitFor(() => { expect(screen.getByText('Release note')).toBeTruthy() })
    expect(screen.queryByText('Updated research note')).toBeNull()
  })

  it('edits the selected Bot skill policy from its detail header', async () => {
    const initialPolicy: BotSkillPolicy = { mode: 'all', enabled: [], disabled: [] }
    const actions: BotSkillManagerActions = {
      list: vi.fn(async () => ({
        policy: initialPolicy,
        revision: 0,
        skills: [
          { name: 'code-review', description: 'Review code', enabled: true, available: true },
          { name: 'release-notes', description: 'Write release notes', enabled: true, available: true },
        ],
      })),
      update: vi.fn(async (_botId: string, policy: BotSkillPolicy) => ({
        policy,
        skills: [
          { name: 'code-review', description: 'Review code', enabled: policy.enabled.includes('code-review'), available: true },
          { name: 'release-notes', description: 'Write release notes', enabled: false, available: true },
        ],
      })),
    }
    render(<BotDetail
      bot={bots[0]}
      loading={false}
      loadAvatar={undefined}
      skillManager={actions}
      t={t}
    >
      <p>Persistent session surface</p>
    </BotDetail>)

    fireEvent.click(screen.getByRole('button', { name: 'Manage skills' }))
    const dialog = await screen.findByRole('dialog', { name: 'Bot skills' })
    expect(actions.list).toHaveBeenCalledWith('research')
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Only selected skills' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Allow code-review' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save skills' }))
    await waitFor(() => {
      expect(actions.update).toHaveBeenCalledWith('research', { mode: 'selected', enabled: ['code-review'], disabled: [] }, 0)
    })
    expect(screen.queryByRole('dialog', { name: 'Bot skills' })).toBeNull()
  })

  it('shows selected-mode denied skills as disabled and clears the deny when granted', async () => {
    const policy: BotSkillPolicy = { mode: 'selected', enabled: ['release-notes'], disabled: ['code-review'] }
    const update = vi.fn(async (_botId: string, next: BotSkillPolicy) => ({ policy: next }))
    const actions: BotSkillManagerActions = {
      list: vi.fn(async () => ({
        policy,
        skills: [
          { name: 'code-review', description: 'Review code', enabled: false, available: true },
          { name: 'release-notes', description: 'Write release notes', enabled: true, available: true },
        ],
        revision: 1,
      })),
      update,
    }
    render(<BotDetail
      bot={bots[0]}
      loading={false}
      loadAvatar={undefined}
      skillManager={actions}
      t={t}
    >
      <p>Persistent session surface</p>
    </BotDetail>)

    fireEvent.click(screen.getByRole('button', { name: 'Manage skills' }))
    const dialog = await screen.findByRole('dialog', { name: 'Bot skills' })
    const denied = within(dialog).getByRole('checkbox', { name: 'Allow code-review' }) as HTMLInputElement
    expect(denied.checked).toBe(false)
    fireEvent.click(denied)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save skills' }))
    await waitFor(() => {
      expect(update).toHaveBeenCalledWith('research', {
        mode: 'selected', enabled: ['code-review', 'release-notes'], disabled: [],
      }, 1)
    })
  })

  it('requires a reload after a concurrent skill policy conflict', async () => {
    const initialPolicy: BotSkillPolicy = { mode: 'all', enabled: [], disabled: [] }
    const latestPolicy: BotSkillPolicy = { mode: 'selected', enabled: ['code-review'], disabled: [] }
    const list = vi.fn<BotSkillManagerActions['list']>()
      .mockResolvedValueOnce({
        policy: initialPolicy,
        revision: 0,
        skills: [{ name: 'code-review', description: 'Review code', enabled: true, available: true }],
      })
      .mockResolvedValueOnce({
        policy: latestPolicy,
        revision: 1,
        skills: [{ name: 'code-review', description: 'Review code', enabled: true, available: true }],
      })
    const update = vi.fn<BotSkillManagerActions['update']>().mockRejectedValue(
      new BotSkillPolicyConflictError('Skill policy changed elsewhere'),
    )
    render(<BotDetail
      bot={bots[0]}
      loading={false}
      loadAvatar={undefined}
      skillManager={{ list, update }}
      t={t}
    >
      <p>Persistent session surface</p>
    </BotDetail>)

    fireEvent.click(screen.getByRole('button', { name: 'Manage skills' }))
    const dialog = await screen.findByRole('dialog', { name: 'Bot skills' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save skills' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('changed elsewhere') })
    expect(within(dialog).getByRole('button', { name: 'Save skills' })).toHaveProperty('disabled', true)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload skills' }))
    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(2)
      expect(within(dialog).getByRole('button', { name: 'Save skills' })).toHaveProperty('disabled', false)
    })
  })

  it('closes the skill manager when selection changes', async () => {
    const actions: BotSkillManagerActions = {
      list: vi.fn(async () => ({
        policy: { mode: 'all' as const, enabled: [], disabled: [] },
        revision: 0,
        skills: [{ name: 'code-review', description: 'Review code', enabled: true, available: true }],
      })),
      update: vi.fn(async (_botId: string, policy: BotSkillPolicy) => ({ policy })),
    }
    const view = render(<BotDetail
      bot={bots[0]}
      loading={false}
      loadAvatar={undefined}
      skillManager={actions}
      t={t}
    >
      <p>Persistent session surface</p>
    </BotDetail>)

    fireEvent.click(screen.getByRole('button', { name: 'Manage skills' }))
    expect(await screen.findByRole('dialog', { name: 'Bot skills' })).toBeTruthy()
    view.rerender(<BotDetail
      bot={bots[1]}
      loading={false}
      loadAvatar={undefined}
      skillManager={actions}
      t={t}
    >
      <p>Persistent session surface</p>
    </BotDetail>)

    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Bot skills' })).toBeNull() })
    expect(actions.update).not.toHaveBeenCalled()
  })

  it('does not apply a late skill save to a newly selected Bot', async () => {
    const update = Promise.withResolvers<{ readonly policy: BotSkillPolicy }>()
    const onClose = vi.fn()
    const actions: BotSkillManagerActions = {
      list: vi.fn(async () => ({
        policy: { mode: 'all' as const, enabled: [], disabled: [] },
        revision: 0,
        skills: [{ name: 'code-review', description: 'Review code', enabled: true, available: true }],
      })),
      update: vi.fn(async () => update.promise),
    }
    const view = render(<BotSkillsManager
      bot={bots[0]!}
      actions={actions}
      loadAvatar={undefined}
      open
      onClose={onClose}
      t={t}
    />)

    const dialog = await screen.findByRole('dialog', { name: 'Bot skills' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save skills' }))
    await waitFor(() => { expect(actions.update).toHaveBeenCalledWith('research', { mode: 'all', enabled: [], disabled: [] }, 0) })
    view.rerender(<BotSkillsManager
      bot={bots[1]!}
      actions={actions}
      loadAvatar={undefined}
      open
      onClose={onClose}
      t={t}
    />)
    await waitFor(() => { expect(onClose).toHaveBeenCalledTimes(1) })

    await act(async () => {
      update.resolve({ policy: { mode: 'all', enabled: [], disabled: [] } })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
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

  it('collapses a folder without closing its chat and reveals matches during search', () => {
    renderSplitWorkspace()

    const folder = screen.getByRole('button', { name: 'Research' })
    const search = screen.getByRole('textbox', { name: 'Search bots' })
    expect(folder.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(folder)
    expect(folder.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: /Research partner, Working/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Release captain, Idle/ })).toBeTruthy()
    expect(screen.getByText('Persistent session surface')).toBeTruthy()

    fireEvent.change(search, { target: { value: 'Research partner' } })
    expect(folder.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: /Research partner, Working/ })).toBeTruthy()
    fireEvent.change(search, { target: { value: '' } })
    expect(folder.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: /Research partner, Working/ })).toBeNull()

    fireEvent.click(folder)
    expect(folder.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: /Research partner, Working/ }).getAttribute('aria-current')).toBe('page')
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
    const hidden = screen.getByRole('button', { name: 'Hidden bots' })
    expect(hidden.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(hidden)
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
    const hidden = screen.getByRole('button', { name: 'Hidden bots' })
    expect(hidden.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(hidden)
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
    expect(screen.getByRole('heading', { name: 'Bot groups' })).toBeTruthy()
    const row = screen.getByRole('button', { name: /Release room/ })
    expect(row.getAttribute('aria-current')).toBe('page')
    fireEvent.click(row)
    expect(onSelectGroup).toHaveBeenCalledWith(sharedGroup.id)
    expect(screen.queryByRole('complementary', { name: /Group/ })).toBeNull()
  })

  it('creates a local Bot group from two existing Bots', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'New bot group' }))
    const dialog = screen.getByRole('dialog', { name: 'Create a bot group' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Group name' }), { target: { value: 'Launch room' } })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Research partner' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Release captain' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create group' }))

    await waitFor(() => { expect(onCreateGroup).toHaveBeenCalledWith({ name: 'Launch room', botIds: ['research', 'release'] }) })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Create a bot group' })).toBeNull() })
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
    expect(screen.getAllByText('Plan the release together.').length).toBeGreaterThan(0)
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

  it('keeps reply context in the composer and exposes reaction counts with viewer state', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    const onReact = vi.fn().mockResolvedValue(undefined)
    const initial = {
      ...groupDetail,
      messages: [
        ...groupDetail.messages,
        {
          id: 'message-3', sender: { kind: 'bot' as const, botId: BotId('release'), name: 'Release captain' },
          text: 'I will package the notes.', createdAt: 3,
          replyToMessageId: 'message-1',
          reactions: [{ emoji: '👍' as const, count: 1, viewerReacted: true }],
        },
      ],
    }
    render(<BotGroupDetail
      group={initial}
      bots={bots}
      loading={false}
      error={null}
      onRetry={vi.fn()}
      onSend={onSend}
      onReact={onReact}
      loadAvatar={undefined}
      t={t}
    />)

    expect(screen.getAllByText('Plan the release together.').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Reply to You' }))
    expect(screen.getByRole('status').textContent).toContain('Replying to You')
    const composer = screen.getByRole('textbox', { name: 'Message Release room' })
    fireEvent.change(composer, { target: { value: 'The package is ready.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => { expect(onSend).toHaveBeenCalledWith('The package is ready.', undefined, undefined, 'message-1') })

    expect(screen.getByRole('button', { name: '👍, 1 reactions' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'React to Release captain’s message' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'React with 😂' }))
    await waitFor(() => { expect(onReact).toHaveBeenCalledWith('message-3', '😂', 'add') })
    fireEvent.click(screen.getByRole('button', { name: '👍, 1 reactions' }))
    await waitFor(() => { expect(onReact).toHaveBeenCalledWith('message-3', '👍', 'remove') })
  })

  it('keeps a picked attachment visible when the current local transport is text-only', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<BotGroupDetail
      group={groupDetail}
      loading={false}
      error={null}
      onRetry={vi.fn()}
      onSend={onSend}
      loadAvatar={undefined}
      t={t}
    />)

    const file = new File(['release notes'], 'release-notes.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByLabelText('Choose files'), { target: { files: [file] } })
    expect(screen.getByText('release-notes.txt')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('Attachments are not available') })
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByText('release-notes.txt')).toBeTruthy()
  })

  it('retries an attachment with the same message id and clears it only after success', async () => {
    const sendWithAttachments = vi.fn()
      .mockRejectedValueOnce(new Error('attachment upload failed'))
      .mockResolvedValueOnce(undefined)
    render(<BotGroupDetail
      group={groupDetail}
      loading={false}
      error={null}
      onRetry={vi.fn()}
      onSend={vi.fn()}
      onSendWithAttachments={sendWithAttachments}
      loadAvatar={undefined}
      t={t}
    />)

    const file = new File(['release notes'], 'release-notes.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByLabelText('Choose files'), { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => {
      expect(sendWithAttachments).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('alert').textContent).toContain('attachment upload failed')
    })
    expect(sendWithAttachments.mock.calls[0]?.[0]).toBe('File')

    const firstMessageId = sendWithAttachments.mock.calls[0]?.[2]
    expect(firstMessageId).toMatch(/^bot-group-message-/)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => { expect(sendWithAttachments).toHaveBeenCalledTimes(2) })
    expect(sendWithAttachments.mock.calls[1]?.[2]).toBe(firstMessageId)
    expect(screen.queryByText('release-notes.txt')).toBeNull()
  })

  it('shows persisted per-Bot turn failures and retries only the failed user message', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<BotGroupDetail
      group={{
        ...groupDetail,
        deliveries: [
          { messageId: 'message-1', botId: BotId('research'), status: 'responded' },
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
    const dialog = screen.getByRole('dialog', { name: 'Edit bot group' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Group name' }), { target: { value: 'Launch command room' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith({
        groupId: 'group-release', name: 'Launch command room', botIds: ['research', 'release'],
      })
    })
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Edit bot group' })).toBeNull() })
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

  it('keeps app access contextual to each bot menu', () => {
    const onConnectApps = vi.fn()
    renderSplitWorkspace({ onConnectApps })

    expect(screen.queryByRole('button', { name: 'App access' })).toBeNull()
    openConnectedAppsMenu()

    expect(onConnectApps).toHaveBeenCalledOnce()
  })

  it('loads connected apps for the Bot whose menu opened access', async () => {
    const onLoadConnectedApps = vi.fn().mockResolvedValue([
      { id: 'github', name: 'GitHub', description: 'Tools from GitHub', allowed: false },
    ])
    const onSetConnectedAppAccess = vi.fn().mockResolvedValue(undefined)
    renderSplitWorkspace({ onLoadConnectedApps, onSetConnectedAppAccess })

    openConnectedAppsMenu(bots[1]!)
    const dialog = await screen.findByRole('dialog', { name: 'Connected apps' })
    await waitFor(() => { expect(onLoadConnectedApps).toHaveBeenCalledWith('release') })
    expect(dialog.querySelector('[data-app-id="github"]')).not.toBeNull()
    expect(within(dialog).getByText('Access not allowed')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant access to GitHub' }))
    await waitFor(() => { expect(onSetConnectedAppAccess).toHaveBeenCalledWith('release', 'github', true) })
    expect(within(dialog).getByText('Access allowed')).toBeTruthy()
  })

  it('centers an explicit empty state when a Bot has no connected apps', async () => {
    const onLoadConnectedApps = vi.fn().mockResolvedValue([])
    renderSplitWorkspace({
      onLoadConnectedApps,
      onSetConnectedAppAccess: vi.fn().mockResolvedValue(undefined),
    })

    openConnectedAppsMenu()
    const dialog = await screen.findByRole('dialog', { name: 'Connected apps' })
    await waitFor(() => { expect(within(dialog).getByText('No connected apps yet')).toBeTruthy() })
    expect(within(dialog).getByText('Connect an app to make it available to this bot.')).toBeTruthy()
    expect(within(dialog).queryByRole('list')).toBeNull()
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

    openConnectedAppsMenu()
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

    openConnectedAppsMenu()
    const dialog = await screen.findByRole('dialog', { name: 'Connected apps' })
    await waitFor(() => { expect(dialog.querySelector('[data-app-id="github"]')).not.toBeNull() })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Connected apps' })).toBeNull() })
    openConnectedAppsMenu()
    const reloadedDialog = await screen.findByRole('dialog', { name: 'Connected apps' })

    await waitFor(() => { expect(onLoadConnectedApps).toHaveBeenCalledTimes(2) })
    expect((await within(reloadedDialog).findByRole('alert')).textContent).toContain('catalog unavailable')
    expect(reloadedDialog.querySelector('[data-app-id="github"]')).toBeNull()
  })

  it('keeps a pending toggle tied to the Bot that opened app access', async () => {
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

    openConnectedAppsMenu()
    const dialog = await screen.findByRole('dialog', { name: 'Connected apps' })
    await waitFor(() => { expect(dialog.querySelector('[data-app-id="github"]')).not.toBeNull() })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant access to GitHub' }))
    await waitFor(() => { expect(onSetConnectedAppAccess).toHaveBeenCalledWith('research', 'github', true) })

    view.rerender(<BotRoster {...props} selectedBotId="release" t={t} />)
    expect(onLoadConnectedApps).toHaveBeenCalledTimes(1)

    save.resolve(undefined)
    await waitFor(() => { expect(within(dialog).getByRole('button', { name: 'Done' }).hasAttribute('disabled')).toBe(false) })
    await waitFor(() => { expect(within(dialog).getByRole('button', { name: 'Revoke access to GitHub' })).toBeTruthy() })
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
