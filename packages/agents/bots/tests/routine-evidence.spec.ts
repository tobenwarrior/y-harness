import { createToolResultMessage, createUserMessage, MessageId, ToolCallId, type ContextFormed } from '@yharness/llm'
import { brandString } from '@yharness/brand'
import { Session, SessionId, type SessionEvent, type TurnEndReason } from '@yharness/session'
import type { SkillClaudeSendId, SkillClaudeSessionId, SkillClaudeToolUseId, SkillCodexItemId, SkillCodexSessionId, SkillCodexTurnId, SkillLearningNativeItem, SkillNativeConnectionId } from '@yharness/skill-library/types'
import { describe, expect, it } from 'vitest'
import type { BotDynamicToolEvent } from '../src/collaboration.ts'
import { routineExecutionEvidenceForMessages, unavailableRoutineExecutionEvidence } from '../src/routine-evidence.ts'

declare module '@yharness/llm' {
  interface MessageSourceMap {
    'runtime-context': { kind: 'runtime-context' } & ContextFormed
    'test-context': { kind: 'test-context' } & ContextFormed
  }
}

declare module '@yharness/session' {
  interface TurnEndReasonMap {
    'test/custom': { kind: 'test/custom' }
  }
}

function routineExecutionEvidence(events: readonly SessionEvent[], id: MessageId) {
  const evidence = routineExecutionEvidenceForMessages(events, [id]).get(String(id))
  if (evidence === undefined) throw new Error('Requested delivery evidence is missing')
  return evidence
}

function session(): Session {
  return Session.create(SessionId('routine-evidence-test'))
}

function scheduledMessage(sessionValue: Session) {
  const message = createUserMessage({
    content: [{ type: 'text', text: 'run the scheduled check' }],
    source: { kind: 'schedule' },
  })
  sessionValue.append('user/message', message, { surfaceOp: 'append' })
  return message
}

function scheduled(sessionValue: Session) {
  return scheduledMessage(sessionValue).id
}

function start(sessionValue: Session, turn = 1): void {
  sessionValue.append('turn/start', { turn })
}

function end(sessionValue: Session, reason: TurnEndReason = { kind: 'completed' }, turn = 1): void {
  sessionValue.append('turn/end', { turn, reason })
}

function native(sessionValue: Session, success: boolean | undefined, callId: string): void {
  const started: BotDynamicToolEvent = {
    phase: 'started', name: 'read_recovery_log', callId, threadId: 'thread-1', turnId: 'turn-1',
    sessionId: sessionValue.id, arguments: {},
  }
  const settled: BotDynamicToolEvent = {
    ...started,
    phase: 'settled',
    ...(success === undefined ? {} : {
      result: { success, contentItems: [{ type: 'inputText', text: success ? 'ok' : 'failed' }] },
    }),
  }
  sessionValue.append('bot/dynamic-tool', started)
  sessionValue.append('bot/dynamic-tool', settled)
}

function nativeSkillItem(sessionValue: Session, outcome: 'reported-success' | 'reported-error' | 'unknown'): void {
  const identity = {
    provider: 'codex' as const,
    connectionId: brandString<SkillNativeConnectionId>('native-connection'),
    sessionId: brandString<SkillCodexSessionId>('native-thread-1'),
    turnId: brandString<SkillCodexTurnId>('native-turn'),
    itemId: brandString<SkillCodexItemId>(`native-item-${outcome}`),
    kind: 'command' as const,
    name: 'native-mcp',
    procedure: { kind: 'check' as const, command: 'echo ok' },
  }
  const started: SkillLearningNativeItem = { ...identity, phase: 'started' }
  const settled: SkillLearningNativeItem = { ...identity, phase: 'settled', outcome }
  sessionValue.append('skill/native-item', started, { ignorable: true })
  sessionValue.append('skill/native-item', settled, { ignorable: true })
}

describe('routine execution evidence', () => {
  it('distinguishes a persisted delivery from a completed turn without tool use', () => {
    const first = session()
    const missing = routineExecutionEvidence(first.snapshotEvents(), MessageId('scheduled-message'))
    expect(missing.status).toBe('delivery-only')

    const completed = session()
    start(completed)
    const messageId = scheduled(completed)
    end(completed)
    expect(routineExecutionEvidence(completed.snapshotEvents(), messageId)).toMatchObject({
      messageId,
      status: 'completed-no-tool-use',
      turn: 1,
      turnStatus: 'completed',
      nativeActions: { settled: 0, succeeded: 0, failed: 0 },
      ordinaryTools: { calls: 0, succeeded: 0, failed: 0 },
    })
  })

  it('counts native settlements and ordinary tool outcomes without exposing their payloads', () => {
    const nativeSession = session()
    start(nativeSession)
    const nativeMessageId = scheduled(nativeSession)
    native(nativeSession, true, 'native-success')
    native(nativeSession, false, 'native-failure')
    native(nativeSession, undefined, 'native-unknown')
    nativeSkillItem(nativeSession, 'reported-success')
    nativeSkillItem(nativeSession, 'reported-error')
    nativeSkillItem(nativeSession, 'unknown')
    end(nativeSession)
    expect(routineExecutionEvidence(nativeSession.snapshotEvents(), nativeMessageId)).toMatchObject({
      status: 'completed-with-tool-use',
      nativeActions: { settled: 6, succeeded: 2, failed: 2 },
      ordinaryTools: { calls: 0, succeeded: 0, failed: 0 },
    })

    const ordinary = session()
    start(ordinary)
    const ordinaryMessageId = scheduled(ordinary)
    ordinary.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('ordinary-1'), name: 'inspect', arguments: '{}' })
    ordinary.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: ToolCallId('ordinary-1'), content: [{ type: 'text', text: 'ok' }], isError: false }),
    }, { surfaceOp: 'append' })
    ordinary.append('tool/call', { turn: 1, step: 2, callId: ToolCallId('ordinary-2'), name: 'inspect', arguments: '{}' })
    ordinary.append('tool/result', {
      turn: 1,
      step: 2,
      message: createToolResultMessage({ callId: ToolCallId('ordinary-2'), content: [{ type: 'text', text: 'denied' }], isError: true }),
    }, { surfaceOp: 'append' })
    end(ordinary)
    expect(routineExecutionEvidence(ordinary.snapshotEvents(), ordinaryMessageId)).toMatchObject({
      status: 'completed-with-tool-use',
      nativeActions: { settled: 0, succeeded: 0, failed: 0 },
      ordinaryTools: { calls: 2, succeeded: 1, failed: 1 },
    })

    const overlap = session()
    start(overlap)
    const overlapMessageId = scheduled(overlap)
    const sharedKey = {
      sessionId: overlap.id,
      turnId: 'shared-turn',
      callId: 'shared-item',
    }
    overlap.append('skill/native-item', {
      provider: 'codex',
      connectionId: brandString<SkillNativeConnectionId>('shared-connection'),
      sessionId: brandString<SkillCodexSessionId>('native-thread-shared'),
      turnId: brandString<SkillCodexTurnId>(sharedKey.turnId),
      itemId: brandString<SkillCodexItemId>(sharedKey.callId),
      kind: 'mcp',
      name: 'native-mcp',
      phase: 'settled',
      outcome: 'unknown',
    }, { ignorable: true })
    overlap.append('bot/dynamic-tool', {
      phase: 'settled',
      ...sharedKey,
      threadId: 'native-thread-shared',
      name: 'send_bot_message',
      arguments: {},
      result: { success: true, contentItems: [{ type: 'inputText', text: 'ok' }] },
    })
    const settledNativeItem = overlap.snapshotEvents().find(event => event.type === 'skill/native-item')
    if (settledNativeItem?.type !== 'skill/native-item') throw new Error('Expected native fixture observation')
    overlap.append('skill/native-item', { ...settledNativeItem.data, outcome: 'unknown' }, { ignorable: true })
    overlap.append('skill/native-item', { ...settledNativeItem.data, outcome: 'reported-success' }, { ignorable: true })
    expect(routineExecutionEvidence(overlap.snapshotEvents(), overlapMessageId)).toMatchObject({
      nativeActions: { settled: 1, succeeded: 1, failed: 0 },
    })
    overlap.append('skill/native-item', { ...settledNativeItem.data, outcome: 'reported-error' }, { ignorable: true })
    end(overlap)
    expect(routineExecutionEvidence(overlap.snapshotEvents(), overlapMessageId)).toMatchObject({
      nativeActions: { settled: 1, succeeded: 0, failed: 0 },
    })
  })

  it('reports an open turn and refuses mixed unrelated work', () => {
    const open = session()
    start(open)
    const openMessageId = scheduled(open)
    expect(routineExecutionEvidence(open.snapshotEvents(), openMessageId)).toMatchObject({ status: 'started', turn: 1 })

    const mixed = session()
    start(mixed)
    const mixedMessageId = scheduled(mixed)
    mixed.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'ambient context' }], source: { kind: 'runtime-context' },
    }), { surfaceOp: 'append' })
    mixed.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'unrelated owner input' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    end(mixed)
    expect(routineExecutionEvidence(mixed.snapshotEvents(), mixedMessageId)).toMatchObject({
      status: 'ambiguous',
      turn: 1,
    })

    const contextForms = session()
    start(contextForms)
    const contextMessageId = scheduled(contextForms)
    const contextSources = [
      { kind: 'test-context' as const, form: 'instructions' as const },
      { kind: 'test-context' as const, form: 'catalog' as const },
      { kind: 'test-context' as const, form: 'snapshot' as const, sections: [{ name: 'fixture', text: 'state' }] },
      { kind: 'test-context' as const, form: 'recall' as const },
    ]
    for (const source of contextSources) {
      contextForms.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'context' }], source,
      }), { surfaceOp: 'append' })
    }
    end(contextForms)
    expect(routineExecutionEvidence(contextForms.snapshotEvents(), contextMessageId)).toMatchObject({
      status: 'completed-no-tool-use',
      nativeActions: { settled: 0, succeeded: 0, failed: 0 },
      ordinaryTools: { calls: 0, succeeded: 0, failed: 0 },
    })
  })

  it('does not attribute work from before the scheduled message entered the turn', () => {
    const current = session()
    start(current)
    current.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('earlier'), name: 'inspect', arguments: '{}' })
    const messageId = scheduled(current)
    end(current)

    expect(routineExecutionEvidence(current.snapshotEvents(), messageId)).toMatchObject({
      status: 'ambiguous',
      ordinaryTools: { calls: 0, succeeded: 0, failed: 0 },
    })
  })

  it('marks incomplete native observations as unverified and does not count earlier calls', () => {
    const current = session()
    start(current)
    native(current, true, 'earlier-native')
    const messageId = scheduled(current)
    const claudeCommand = {
      provider: 'claude-code' as const,
      connectionId: brandString<SkillNativeConnectionId>('claude-connection'),
      sessionId: brandString<SkillClaudeSessionId>('claude-session'),
      sendId: brandString<SkillClaudeSendId>('claude-send'),
      itemId: brandString<SkillClaudeToolUseId>('claude-command'),
      kind: 'command' as const,
      name: 'Bash',
    }
    current.append('skill/native-item', { ...claudeCommand, phase: 'settled', outcome: 'reported-success' }, { ignorable: true })
    end(current)
    expect(routineExecutionEvidence(current.snapshotEvents(), messageId)).toMatchObject({
      status: 'ambiguous', nativeActions: { settled: 1, succeeded: 1, failed: 0 },
    })

    const incomplete = session()
    start(incomplete)
    const incompleteId = scheduled(incomplete)
    incomplete.append('skill/native-item', { ...claudeCommand, phase: 'invalidated' }, { ignorable: true })
    end(incomplete)
    expect(routineExecutionEvidence(incomplete.snapshotEvents(), incompleteId)).toMatchObject({
      status: 'ambiguous', nativeActions: { settled: 0, succeeded: 0, failed: 0 },
    })
  })

  it('maps every persisted turn status and stays conservative around malformed boundaries', () => {
    const reasons: readonly [TurnEndReason, string][] = [
      [{ kind: 'completed' }, 'completed'],
      [{ kind: 'error', error: { message: 'fixture', code: 'FIXTURE' } }, 'error'],
      [{ kind: 'aborted', reason: { kind: 'user' } }, 'aborted'],
      [{ kind: 'blocked' }, 'blocked'],
      [{ kind: 'max-tokens' }, 'max-tokens'],
      [{ kind: 'interrupted' }, 'interrupted'],
      [{ kind: 'forked' }, 'forked'],
      [{ kind: 'test/custom' }, 'other'],
    ]
    for (const [reason, expected] of reasons) {
      const current = session()
      start(current)
      const messageId = scheduled(current)
      end(current, reason)
      const evidence = routineExecutionEvidence(current.snapshotEvents(), messageId)
      expect(evidence.turnStatus).toBe(expected)
      if (expected !== 'completed') expect(evidence.status).toBe('ambiguous')
    }

    const page = session()
    start(page, 1)
    const first = scheduled(page)
    end(page, { kind: 'completed' }, 1)
    start(page, 2)
    const second = scheduled(page)
    end(page, { kind: 'completed' }, 2)
    expect(routineExecutionEvidenceForMessages(page.snapshotEvents(), []).size).toBe(0)
    const pageEvidence = routineExecutionEvidenceForMessages(page.snapshotEvents(), [first, second, MessageId('not-delivered')])
    expect(pageEvidence.get(String(first))).toMatchObject({ messageId: first, status: 'completed-no-tool-use', turn: 1 })
    expect(pageEvidence.get(String(second))).toMatchObject({ messageId: second, status: 'completed-no-tool-use', turn: 2 })
    expect(pageEvidence.get('not-delivered')).toMatchObject({ status: 'delivery-only' })

    const nested = session()
    start(nested)
    nested.append('turn/start', { turn: 2 })
    const nestedMessageId = scheduled(nested)
    nested.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    nested.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(routineExecutionEvidence(nested.snapshotEvents(), nestedMessageId).status).toBe('completed-no-tool-use')

    const outside = session()
    outside.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('outside'), name: 'inspect', arguments: '{}' })
    outside.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'unrelated before schedule' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const outsideMessage = scheduledMessage(outside)
    expect(routineExecutionEvidence(outside.snapshotEvents(), outsideMessage.id).status).toBe('unavailable')

    const ignored = session()
    start(ignored)
    const ignoredMessageId = scheduled(ignored)
    ignored.append('step/start', { turn: 1, step: 1 })
    ignored.append('tool/call', { turn: 2, step: 1, callId: ToolCallId('unrelated-turn'), name: 'inspect', arguments: '{}' })
    end(ignored)
    expect(routineExecutionEvidence(ignored.snapshotEvents(), ignoredMessageId).status).toBe('completed-no-tool-use')

    const duplicate = session()
    const duplicateMessage = scheduledMessage(duplicate)
    start(duplicate)
    duplicate.append('user/message', duplicateMessage, { surfaceOp: 'append' })
    end(duplicate)
    expect(routineExecutionEvidence(duplicate.snapshotEvents(), duplicateMessage.id).status).toBe('ambiguous')

    const repeatedInTwoTurns = session()
    start(repeatedInTwoTurns, 1)
    const repeated = scheduledMessage(repeatedInTwoTurns)
    end(repeatedInTwoTurns, { kind: 'completed' }, 1)
    start(repeatedInTwoTurns, 2)
    repeatedInTwoTurns.append('user/message', repeated, { surfaceOp: 'append' })
    end(repeatedInTwoTurns, { kind: 'completed' }, 2)
    expect(routineExecutionEvidence(repeatedInTwoTurns.snapshotEvents(), repeated.id)).toMatchObject({ status: 'ambiguous', turn: 1 })

    expect(unavailableRoutineExecutionEvidence(MessageId('unavailable')).status).toBe('unavailable')
  })
})
