/** Ignorable native learning metadata and exact public SDK records for both SDK profile projections. */
import assert from 'node:assert/strict'

export const name = 'sdk-native-item-projection-fixture'
export const inject = ['agents', 'llm']

const nativeItems = [
  {
    provider: 'codex',
    connectionId: 'native-projection-codex-connection',
    sessionId: 'native-projection-codex-session',
    turnId: 'native-projection-codex-turn',
    itemId: 'native-projection-codex-item',
    kind: 'read',
    name: 'read',
    phase: 'settled',
    outcome: 'reported-success',
    procedure: { kind: 'read', path: 'native-projection-codex-only.txt' },
  },
  {
    provider: 'claude-code',
    connectionId: 'native-projection-claude-connection',
    sessionId: 'native-projection-claude-session',
    sendId: 'native-projection-claude-send',
    itemId: 'native-projection-claude-tool-use',
    sourceMessageId: 'native-projection-claude-assistant',
    resultMessageId: 'native-projection-claude-result',
    kind: 'read',
    name: 'Read',
    phase: 'settled',
    outcome: 'reported-success',
    procedure: { kind: 'read', path: 'native-projection-claude-only.txt' },
  },
]

const protocolRecords = [
  {
    provider: 'claude-code',
    connectionId: 'native-projection-claude-connection',
    sessionId: 'native-projection-claude-session',
    sendId: 'native-projection-claude-send',
    profile: { home: '/fixture/native-projection-home', configDirectory: '/fixture/native-projection-config' },
    phase: 'request',
    system: 'native-projection-protocol-system-only',
    message: {
      type: 'user',
      uuid: 'native-projection-claude-send',
      session_id: 'native-projection-claude-session',
      parent_tool_use_id: null,
      message: { role: 'user', content: 'native-projection-protocol-request-only' },
    },
  },
  {
    provider: 'claude-code',
    connectionId: 'native-projection-claude-connection',
    sessionId: 'native-projection-claude-session',
    sendId: 'native-projection-claude-send',
    profile: { home: '/fixture/native-projection-home', configDirectory: '/fixture/native-projection-config' },
    phase: 'frame',
    message: {
      type: 'user',
      uuid: 'native-projection-claude-result',
      session_id: 'native-projection-claude-session',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'native-projection-claude-tool-use', is_error: false, content: 'native-projection-private-tool-output-only' }],
      },
    },
  },
]

const { outcome: _startedOutcome, ...startedNativeItem } = nativeItems[0]
const sequentialTaskId = 'native-projection-sequential-task'
const sequentialRecords = [
  { type: 'skill/sequential-task-start', data: { taskId: sequentialTaskId, source: {
    provider: 'codex', profileId: 'native-projection-codex-connection', nativeSessionId: 'native-projection-codex-session', toolMode: 'project-files',
  }, task: 'native-projection-sequential-task-only' } },
  { type: 'skill/sequential-task-native-turn', data: { taskId: sequentialTaskId, nativeTurnId: 'native-projection-codex-turn' } },
  { type: 'skill/sequential-native-item', data: { taskId: sequentialTaskId, item: { ...startedNativeItem, phase: 'started' } } },
  { type: 'skill/sequential-native-item', data: { taskId: sequentialTaskId, item: nativeItems[0] } },
  { type: 'skill/sequential-task-end', data: { taskId: sequentialTaskId, nativeTurnId: 'native-projection-codex-turn', outcome: 'completed', learning: 'unavailable' } },
]

// Authored compatibility receipt; this fixture performs no import or native acceptance.
const initializationReceipt = {
  source: { provider: 'codex', profileId: 'fixture-profile', nativeSessionId: 'fixture-native-session' },
  mirrorId: 'fixture-mirror', linkId: 'fixture-link', systemMessageId: 'fixture-initializer-system',
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-owned runtime.
 * @param {{projectionHistory?: boolean}} config - Add authored import-source projection input and informational initialization receipt for the two-turn compatibility case.
 */
export function apply(ctx, config = {}) {
  const injected = new WeakSet()
  const requests = new WeakMap()
  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
    const session = agent.session
    if (session.header.parentSession !== undefined || injected.has(session)) return next()
    assert.equal(turn, 1)
    assert.equal(step, 1)
    let imported
    if (config.projectionHistory === true) {
      // Authored projection input; the loop admits it after reserving its system head.
      // Actual cold import and ordinary resume have a separate Loader scenario.
      imported = {
        id: 'coding-import-authored-user-message', role: 'user',
        source: { kind: 'coding-session-import', provider: 'codex', profileId: 'coding-import-profile', nativeSessionId: 'coding-import-session',
          mirrorId: 'coding-import-mirror', linkId: 'coding-import-link', generation: 1, disposition: 'active' },
        content: [{ type: 'text', text: 'coding-import-public-history-only: quoted historical native observation; private native context Unknown.' }],
      }
    }
    const before = {
      nodes: [...session.surface.nodes],
      generation: session.surface.contentGeneration,
      messages: session.deriveMessages(),
    }
    const events = [
      ...nativeItems.map(item => session.append('skill/native-item', item, { ignorable: true })),
      ...protocolRecords.map(record => session.append('claude-code/root-protocol', record, { ignorable: true })),
      ...sequentialRecords.map(record => session.append(record.type, record.data, { ignorable: true })),
      ...(config.projectionHistory === true
        ? [session.append('coding-session/import-initialization', initializationReceipt, { ignorable: true })]
        : []),
    ]
    injected.add(session)
    for (const event of events) {
      assert.equal(event.ignorable, true)
      assert.equal(Object.hasOwn(event, 'surfaceOp'), false)
      assert.equal(Object.hasOwn(event, 'sourceEventSeqs'), false)
      assert.equal(session.deriveEventMessage(event), null, 'Log-only fixture metadata has no conversation message')
    }
    assert.deepEqual(session.surface.nodes, before.nodes, 'Log-only fixture metadata does not add a surface node')
    assert.equal(session.surface.contentGeneration, before.generation)
    assert.deepEqual(session.deriveMessages(), before.messages, 'Log-only fixture metadata does not change derived history')
    const decision = await next()
    if (imported === undefined || decision.kind !== 'enter') return decision
    return { ...decision, messages: [imported, ...decision.messages] }
  })
  ctx.on('llm/stream', async function* (options, next) {
    const agent = options.sessionId === undefined ? undefined : ctx.agents.get(options.sessionId)
    if (options.purpose !== undefined || agent === undefined || !injected.has(agent.session)) {
      yield* next()
      return
    }
    requests.set(agent.session, (requests.get(agent.session) ?? 0) + 1)
    assert.deepEqual(options.messages, agent.session.deriveMessages(), 'The real model request uses derived history')
    assert.equal(JSON.stringify(options.messages).includes('native-projection-'), false, 'Native metadata never reaches model input')
    assert.equal(JSON.stringify(options.messages).includes('coding-session/import-initialization'), false, 'Initialization receipt type never reaches model input')
    assert.equal(JSON.stringify(options.messages).includes('fixture-initializer-system'), false, 'Initialization receipt identity never reaches model input')
    yield* next()
  })
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (!injected.has(agent.session)) return
    assert.equal(requests.get(agent.session), config.projectionHistory === true ? turn : 1, 'The native projection fixture checked every real request')
  })
}
