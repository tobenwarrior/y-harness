import { describe, expect, it } from 'vitest'
import { SessionId } from '@yharness/session/types'
import { MessageId } from '@yharness/llm/brand'
import { routineFollowupId, sameRoutineTrigger } from '../src/event-routines.ts'
import { BotId } from '../src/types.ts'
import { closeRoutineHarness, invokeRoutine, rawBotRow, routineHarness } from './routine-test-harness.ts'
import {
  matchesSlackRoutine, projectSlackRoutineActivity, sameSlackRoutineTrigger,
  slackRoutineFollowup, slackRoutineMessageId, slackRoutineReceiptSchema, slackRoutineSource, slackRoutineTriggerSchema,
} from '../src/slack-routines.ts'

const source = slackRoutineSource({ source: 'team-slack', appId: 'AAPP123', workspaceId: 'TTEAM123' })
const receivedAt = 1_700_000_020_000
const messageTimestamp = '1700000015.123456'
const input = (event: object, replacement = {}) => ({
  type: 'event_callback',
  team_id: 'TTEAM123',
  api_app_id: 'AAPP123',
  event_id: 'Ev000123',
  event,
  ...replacement,
})
const message = {
  type: 'message',
  channel: 'CCHANNEL123',
  user: 'UUSER123',
  ts: messageTimestamp,
  event_ts: messageTimestamp,
  text: 'New Customer Escalation on ticket 42.',
}
const reaction = {
  type: 'reaction_added',
  user: 'UUSER123',
  event_ts: messageTimestamp,
  reaction: 'eyes',
  item: { type: 'message', channel: 'CCHANNEL123', ts: '1700000000.100000' },
}
const selector = (event: string, fields = {}) => slackRoutineTriggerSchema.parse({
  type: 'slack', source: 'team-slack', workspaceId: 'TTEAM123', event, ...fields,
})

describe('Slack activity in Bot routines', () => {
  it('selects new channel activity by text, sender, and channel', () => {
    const activity = projectSlackRoutineActivity(input(message), source, receivedAt)!
    const trigger = selector('message', { textIncludes: 'customer escalation', userId: 'UUSER123', channelId: 'CCHANNEL123' })
    const routine = { trigger, status: 'active' as const, createdAt: receivedAt - 10_000 }
    expect(matchesSlackRoutine(routine, activity)).toBe(true)
    expect(matchesSlackRoutine({ ...routine, status: 'paused' }, activity)).toBe(false)
    expect(matchesSlackRoutine({ ...routine, firstEligibleSlackAt: receivedAt - 100 }, activity)).toBe(false)
    expect(matchesSlackRoutine({ ...routine, createdAt: receivedAt }, activity)).toBe(false)
    for (const different of [
      selector('message', { textIncludes: 'unrelated' }),
      selector('message', { channelId: 'COTHER' }),
      selector('message', { userId: 'UOTHER' }),
      selector('message', { workspaceId: 'TOTHER' }),
      selector('message', { source: 'another-slack' }),
      selector('app_mention'),
    ]) {
      expect(matchesSlackRoutine({ ...routine, trigger: different }, activity)).toBe(false)
    }
  })

  it('keeps app mentions and reactions distinct and retains the reacted-to message identity', () => {
    const mentioned = projectSlackRoutineActivity(input({ ...message, type: 'app_mention' }), source, receivedAt)!
    const reacted = projectSlackRoutineActivity(input(reaction), source, receivedAt)!
    const rule = { status: 'active' as const, createdAt: receivedAt - 10_000 }
    expect(matchesSlackRoutine({ ...rule, trigger: selector('app_mention') }, mentioned)).toBe(true)
    expect(matchesSlackRoutine({ ...rule, trigger: selector('reaction_added', { reaction: 'eyes' }) }, reacted)).toBe(true)
    expect(matchesSlackRoutine({ ...rule, trigger: selector('reaction_added', { reaction: 'sparkles' }) }, reacted)).toBe(false)
    expect(reacted.receipt).toMatchObject({ event: 'reaction_added', reaction: 'eyes', messageTimestamp: reaction.item.ts })
    expect(reacted.receipt).not.toHaveProperty('text')
  })

  it('ignores other Slack installations, automated messages, edits, and unsupported activity', () => {
    expect(projectSlackRoutineActivity(input(message, { team_id: 'TOTHER' }), source, receivedAt)).toBeUndefined()
    expect(projectSlackRoutineActivity(input(message, { api_app_id: 'AOTHER' }), source, receivedAt)).toBeUndefined()
    expect(projectSlackRoutineActivity(input(message, { type: 'url_verification' }), source, receivedAt)).toBeUndefined()
    expect(projectSlackRoutineActivity(input(message, { event_id: 'bad id' }), source, receivedAt)).toBeUndefined()
    expect(projectSlackRoutineActivity(input({ ...message, bot_id: 'BBOT123' }), source, receivedAt)).toBeUndefined()
    expect(projectSlackRoutineActivity(input({ ...message, subtype: 'message_changed' }), source, receivedAt)).toBeUndefined()
    expect(projectSlackRoutineActivity(input({ ...message, event_ts: 'yesterday' }), source, receivedAt)).toBeUndefined()
    expect(projectSlackRoutineActivity(input({ ...reaction, item: { ...reaction.item, type: 'file' } }), source, receivedAt)).toBeUndefined()
  })

  it('bounds persisted text while matching against the full Slack message', () => {
    const long = projectSlackRoutineActivity(input({ ...message, text: 'x'.repeat(9000) + ' report' }), source, receivedAt)!
    expect(long.receipt).toMatchObject({ text: 'x'.repeat(8000), textTruncated: true })
    expect(matchesSlackRoutine({
      trigger: selector('message', { textIncludes: 'report' }),
      createdAt: receivedAt - 10_000,
      status: 'active',
    }, long)).toBe(true)
    const id = slackRoutineMessageId(SessionId('bot-session-example'), 'example', long.receipt)
    expect(id).toMatch(/^bot-slack-routine-[a-f0-9]{64}$/u)
    expect(slackRoutineMessageId(SessionId('bot-session-example'), 'example', long.receipt)).toBe(id)
    expect(slackRoutineMessageId(SessionId('bot-session-other'), 'example', long.receipt)).not.toBe(id)
    const followup = slackRoutineFollowup({ id: 'example', prompt: 'Summarize the report.' }, long.receipt)
    expect(followup.source).toMatchObject({ kind: 'webhook', provider: 'slack', deliveryId: 'Ev000123', form: 'notice' })
    expect(followup.content[0]).toMatchObject({ type: 'text', text: '[BOT EVENT ROUTINE]\nSummarize the report.' })
    const eventDetails = followup.content[1]
    if (eventDetails?.type !== 'text') throw new Error('Expected the Slack event text')
    expect(eventDetails.text).toContain('untrusted data')
    expect(eventDetails.text).toContain('"textTruncated":true')
    expect(routineFollowupId({ id, role: 'user', ...followup })).toBe('example')
    expect(routineFollowupId({ id: MessageId('unrelated'), role: 'user', ...followup })).toBeUndefined()
    expect(routineFollowupId({ id, role: 'user', content: [], source: { kind: 'user' } })).toBeUndefined()
    expect(routineFollowupId({
      id, role: 'user', content: [],
      source: { kind: 'bot-event-routine', form: 'notice', summary: 'Message from user', routineId: 'a-message-rule', triggerEventSeq: 10 },
    })).toBe('a-message-rule')
  })

  it('validates stored receipt fields for the specific Slack event', () => {
    const plainWithoutText = projectSlackRoutineActivity(input({ ...message, text: undefined }), source, receivedAt)!
    const receipt = plainWithoutText.receipt
    expect(slackRoutineReceiptSchema.parse(receipt)).toEqual(receipt)
    expect(slackRoutineReceiptSchema.safeParse({ ...receipt, text: 'short', textTruncated: true }).success).toBe(false)
    expect(slackRoutineReceiptSchema.safeParse({ ...receipt, reaction: 'eyes' }).success).toBe(false)
    const reacted = projectSlackRoutineActivity(input(reaction), source, receivedAt)!.receipt
    expect(slackRoutineReceiptSchema.parse(reacted)).toEqual(reacted)
    expect(slackRoutineReceiptSchema.safeParse({ ...reacted, reaction: undefined }).success).toBe(false)
    expect(slackRoutineReceiptSchema.safeParse({ ...reacted, text: 'text for a reaction' }).success).toBe(false)
    expect(slackRoutineReceiptSchema.safeParse({ ...reacted, textTruncated: true }).success).toBe(false)
    const truncated = projectSlackRoutineActivity(input({ ...message, text: 'x'.repeat(8001) }), source, receivedAt)!.receipt
    expect(slackRoutineReceiptSchema.parse(truncated)).toEqual(truncated)
  })

  it('checks that selector fields apply to the selected event', () => {
    expect(sameSlackRoutineTrigger(selector('message'), selector('message'))).toBe(true)
    expect(sameRoutineTrigger(selector('message'), selector('message', { textIncludes: 'alert' }))).toBe(false)
    expect(sameRoutineTrigger(selector('message'), selector('message'))).toBe(true)
    expect(sameRoutineTrigger(selector('message'), { type: 'webhook' })).toBe(false)
    expect(sameRoutineTrigger({ type: 'message', source: 'user' }, { type: 'message', source: 'bot' })).toBe(false)
    expect(sameSlackRoutineTrigger(selector('message', { textIncludes: 'Alert' }), selector('message', { textIncludes: 'alert' }))).toBe(true)
    expect(sameSlackRoutineTrigger(selector('message'), selector('message', { textIncludes: 'alert' }))).toBe(false)
    expect(sameSlackRoutineTrigger(selector('message'), selector('app_mention'))).toBe(false)
    expect(sameSlackRoutineTrigger(selector('reaction_added', { reaction: 'eyes' }), selector('reaction_added'))).toBe(false)
    expect(() => selector('reaction_added', { textIncludes: 'alert' })).toThrow()
    expect(() => selector('message', { reaction: 'eyes' })).toThrow()
    expect(() => selector('message', { channelId: '#general' })).toThrow()
    expect(() => selector('message', { textIncludes: '   ' })).toThrow()
  })
})

describe('durable Slack routine delivery', () => {
  it('rejects absent or mismatched installations and keeps old registrations retired', async () => {
    const host = await routineHarness()
    try {
      const { bot } = await host.service.create({ id: BotId('bot-slack-setup'), name: 'Desk', cwd: '/tmp' })
      const args = { title: 'Read Slack', prompt: 'Summarize messages.', event: selector('message') }
      await expect(invokeRoutine(host.service, 'create', args, bot.sessionId, 'without-source'))
        .rejects.toThrow('Slack source is unavailable')
      const old = host.service.registerSlackRoutineSource(source)
      expect(() => host.service.registerSlackRoutineSource(source)).toThrow('already registered')
      await expect(invokeRoutine(host.service, 'create', {
        ...args, event: selector('message', { workspaceId: 'TOTHER' }),
      }, bot.sessionId, 'wrong-workspace')).rejects.toThrow('Slack source is unavailable')
      old.dispose()
      const next = host.service.registerSlackRoutineSource(source)
      old.dispose()
      await expect(invokeRoutine(host.service, 'create', args, bot.sessionId, 'connected')).resolves.toBeDefined()
      await expect(old.accept(input(message), receivedAt)).rejects.toThrow('Slack routine source is unavailable')
      await next.accept(input(message), receivedAt)
      next.dispose()
    } finally {
      await closeRoutineHarness(host)
    }
  })

  it('reserves a new event once across writers and leaves paused activity unqueued', async () => {
    const writer = await routineHarness()
    const receiver = await routineHarness(writer.pool, writer.records)
    try {
      writer.ctx.provide('schedule', { catalog: async () => [] } as never)
      const botId = BotId('bot-slack-delivery')
      const { bot } = await writer.service.create({ id: botId, name: 'Slack Desk', cwd: '/tmp' })
      const intake = writer.service.registerSlackRoutineSource(source)
      const otherIntake = receiver.service.registerSlackRoutineSource(source)
      const args = { title: 'Handle escalations', prompt: 'Summarize the message.', event: selector('message', { textIncludes: 'escalation' }) }
      await invokeRoutine(writer.service, 'create', args, bot.sessionId, 'create')
      const entry = (await writer.service.listRoutines({ botId })).routines[0]
      if (entry?.kind !== 'event') throw new Error('Slack routine is missing')
      const query = { botId, routineId: entry.id }
      expect(entry).not.toHaveProperty('firstEligibleSlackAt')

      await writer.service.pauseRoutine(query)
      const oldTime = Date.now()
      const eventAt = (time: number, eventId: string) => {
        const eventTimestamp = (time / 1000).toFixed(6)
        return input({ ...message, event_ts: eventTimestamp, ts: eventTimestamp }, { event_id: eventId })
      }
      const paused = eventAt(oldTime, 'EvPAUSED')
      await intake.accept(paused, oldTime)
      await writer.service.resumeRoutine(query)
      await intake.accept(paused, Date.now() + 10)
      expect(await writer.service.routineHistory({ ...query, limit: 10 })).toMatchObject({ deliveries: [], results: [] })

      const newTime = Date.now() + 1_000
      const accepted = eventAt(newTime, 'EvACCEPTED')
      await intake.accept(input({ ...message, event_ts: (newTime / 1000).toFixed(6), text: 'Unrelated chatter' }), newTime)
      expect(await writer.service.routineHistory({ ...query, limit: 10 })).toMatchObject({ deliveries: [] })
      await intake.accept(accepted, newTime)
      await otherIntake.accept(accepted, newTime + 20)
      expect(rawBotRow(writer.pool, botId)?.eventRoutines?.[0]?.deliveries).toMatchObject([{
        status: 'pending', slack: { deliveryId: 'EvACCEPTED', text: message.text },
      }])
      const history = await writer.service.routineHistory({ ...query, limit: 10 })
      expect(history).toMatchObject({ deliveries: [{ slack: { deliveryId: 'EvACCEPTED', channelId: 'CCHANNEL123' } }] })
      expect(JSON.stringify(history)).not.toContain(message.text)
      expect(JSON.stringify(await invokeRoutine(writer.service, 'history', { id: entry.id }, bot.sessionId, 'history')))
        .not.toContain(message.text)
      otherIntake.dispose()
      intake.dispose()
    } finally {
      await closeRoutineHarness(receiver)
      await closeRoutineHarness(writer)
    }
  })
})
