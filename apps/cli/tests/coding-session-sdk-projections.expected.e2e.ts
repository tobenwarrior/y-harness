/** Public SDK projection of authored imported history beside log-only native task records. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearedProxyEnv } from '@deepseek-ai/dsh-http-proxy'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { DeepSeekHarness, type HarnessNotification, type RunResult } from '@deepseek-ai/dsh-sdk-client'
import { SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertPersistedSessionVersion,
  latestPersistedSessionPaths,
  normalizeSessionFormatMetadata,
  normalizeSessionLog,
  normalizeSessionSnapshot,
  normalizeStdout,
  scrubModelRequestBulk,
  writerSnapshotName,
  type NormalizeContext,
} from '@deepseek-ai/dsh-session-snapshot'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it } from 'vitest'

const dshBin = fileURLToPath(new URL('../lib/bin.js', import.meta.url))
const fixture = fileURLToPath(new URL('../../../scripts/fixtures/python-sdk-native-item.mjs', import.meta.url))
const expectedDir = fileURLToPath(new URL('./expected/coding-session-sdk-projections/', import.meta.url))
const recording = process.env.DSH_SNAPSHOT === 'record'
const sessionId = 'coding-session-projection'
const firstPrompt = 'Complete the native item projection scenario.'
const secondPrompt = 'Continue the coding session projection scenario.'
const response = 'NATIVE_ITEM_PROJECTION_OK'
const importText = 'coding-import-public-history-only: quoted historical native observation; private native context Unknown.'
const importSource = {
  kind: 'coding-session-import', provider: 'codex', profileId: 'coding-import-profile',
  nativeSessionId: 'coding-import-session', mirrorId: 'coding-import-mirror',
  linkId: 'coding-import-link', generation: 1, disposition: 'active',
}
const nativeItems = [
  {
    provider: 'codex', connectionId: 'native-projection-codex-connection',
    sessionId: 'native-projection-codex-session', turnId: 'native-projection-codex-turn',
    itemId: 'native-projection-codex-item', kind: 'read', name: 'read', phase: 'settled',
    outcome: 'reported-success', procedure: { kind: 'read', path: 'native-projection-codex-only.txt' },
  },
  {
    provider: 'claude-code', connectionId: 'native-projection-claude-connection',
    sessionId: 'native-projection-claude-session', sendId: 'native-projection-claude-send',
    itemId: 'native-projection-claude-tool-use', sourceMessageId: 'native-projection-claude-assistant',
    resultMessageId: 'native-projection-claude-result', kind: 'read', name: 'Read', phase: 'settled',
    outcome: 'reported-success', procedure: { kind: 'read', path: 'native-projection-claude-only.txt' },
  },
]
const protocolRecords = [
  {
    provider: 'claude-code', connectionId: 'native-projection-claude-connection',
    sessionId: 'native-projection-claude-session', sendId: 'native-projection-claude-send',
    profile: { home: '/fixture/native-projection-home', configDirectory: '/fixture/native-projection-config' },
    phase: 'request', system: 'native-projection-protocol-system-only',
    message: {
      type: 'user', uuid: 'native-projection-claude-send', session_id: 'native-projection-claude-session',
      parent_tool_use_id: null, message: { role: 'user', content: 'native-projection-protocol-request-only' },
    },
  },
  {
    provider: 'claude-code', connectionId: 'native-projection-claude-connection',
    sessionId: 'native-projection-claude-session', sendId: 'native-projection-claude-send',
    profile: { home: '/fixture/native-projection-home', configDirectory: '/fixture/native-projection-config' },
    phase: 'frame', message: {
      type: 'user', uuid: 'native-projection-claude-result', session_id: 'native-projection-claude-session',
      parent_tool_use_id: null, message: { role: 'user', content: [{
        type: 'tool_result', tool_use_id: 'native-projection-claude-tool-use',
        is_error: false, content: 'native-projection-private-tool-output-only',
      }] },
    },
  },
]
const taskId = 'native-projection-sequential-task'
const sequentialRecords = [
  { type: 'skill/sequential-task-start', data: {
    taskId, source: { provider: 'codex', profileId: 'native-projection-codex-connection',
      nativeSessionId: 'native-projection-codex-session', toolMode: 'project-files' },
    task: 'native-projection-sequential-task-only',
  } },
  { type: 'skill/sequential-task-native-turn', data: { taskId, nativeTurnId: 'native-projection-codex-turn' } },
  { type: 'skill/sequential-native-item', data: { taskId, item: {
    provider: 'codex', connectionId: 'native-projection-codex-connection',
    sessionId: 'native-projection-codex-session', turnId: 'native-projection-codex-turn',
    itemId: 'native-projection-codex-item', kind: 'read', name: 'read', phase: 'started',
    procedure: { kind: 'read', path: 'native-projection-codex-only.txt' },
  } } },
  { type: 'skill/sequential-native-item', data: { taskId, item: nativeItems[0] } },
  { type: 'skill/sequential-task-end', data: {
    taskId, nativeTurnId: 'native-projection-codex-turn', outcome: 'completed', learning: 'unavailable',
  } },
]

// Authored compatibility metadata exercises projection only; this is no actual import receipt.
const initializationReceipt = {
  type: 'coding-session/import-initialization',
  data: {
    source: { provider: 'codex', profileId: 'fixture-profile', nativeSessionId: 'fixture-native-session' },
    mirrorId: 'fixture-mirror', linkId: 'fixture-link', systemMessageId: 'fixture-initializer-system',
  },
}

function jsonl(values: readonly unknown[]): string {
  return values.map(value => JSON.stringify(value)).join('\n') + '\n'
}

function records(value: string): Record<string, unknown>[] {
  return value.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

function isMetadata(type: string): boolean {
  return type === 'skill/native-item' || type === 'claude-code/root-protocol'
    || type.startsWith('skill/sequential-') || type === 'coding-session/import-initialization'
}

function normalizeEvents(events: readonly SessionEvent[], ctx: NormalizeContext): string {
  return scrubModelRequestBulk(normalizeSessionLog(normalizeSessionFormatMetadata(jsonl(events)), ctx))
}

/** Embedded SDK event envelopes use the same normalization as durable Session rows. */
function normalizeNotifications(notifications: readonly HarnessNotification[], ctx: NormalizeContext): string {
  const embedded = notifications.filter(notification => notification.method === 'session.event')
    .map(notification => notification.params.event)
  const normalizedEvents = records(scrubModelRequestBulk(normalizeSessionLog(
    normalizeSessionFormatMetadata(jsonl(embedded)), ctx,
  )))
  let index = 0
  return normalizeStdout(jsonl(notifications.map(notification => ({
    method: notification.method,
    params: notification.method === 'session.event'
      ? { ...notification.params, event: normalizedEvents[index++] }
      : notification.params,
  }))), ctx)
}

/** Bound the complete owned run interval; SDK request deadlines alone do not bound idle waits. */
async function runWithDeadline(harness: DeepSeekHarness, prompt: string): Promise<RunResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      harness.run(prompt, { sessionId }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`SDK projection run did not reach idle: ${prompt}`)) }, 45_000)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

describe('coding Session SDK projections', () => {
  it('retains actual prior turns and quoted import context while native lifecycle records remain log-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-coding-session-sdk-projections-'))
    try {
      const server = await startMockLlmServer({ port: 0, sequence: ['success', 'success'], successText: response })
      try {
        const home = join(root, 'home')
        const sessionsRoot = join(home, 'sessions')
        const patch = join(root, 'coding-session-sdk-projections.patch.yml')
        await writeFile(patch, JSON.stringify([
          { id: 'sessions', config: { root: sessionsRoot, compression: 'none' } },
          { id: 'session-log-deepseek', disabled: true },
          { id: 'plugin-package-inventory-deepseek', disabled: true },
          { id: 'persistent-bash', disabled: true },
          { id: 'persistent-pwsh', disabled: true },
          { insert: [{ id: 'coding-session-sdk-projection-fixture', name: fixture, config: { projectionHistory: true } }] },
        ], null, 2))
        const harness = new DeepSeekHarness({
          dshBin, profile: 'sdk-minimal', patches: [patch], dshHome: home,
          cwd: root, processCwd: root, provider: 'deepseek-official', model: 'smoke-model',
          env: {
            ...scrubbedParentEnv(), ...clearedProxyEnv(), NODE_USE_ENV_PROXY: undefined,
            DSH_AGENTS_HOME: join(root, '.agents'), DSH_TELEMETRY_DISABLED: '1',
            DEEPSEEK_API_KEY: 'sk-keyless-smoke', DEEPSEEK_BASE_URL: server.baseURL,
          },
          initializeTimeoutMs: 30_000, requestTimeoutMs: 45_000, shutdownTimeoutMs: 15_000,
        })
        let runs: [RunResult, RunResult]
        try {
          runs = [await runWithDeadline(harness, firstPrompt), await runWithDeadline(harness, secondPrompt)]
        } finally {
          await harness.close()
        }
        const [first, second] = runs
        for (const run of runs) {
          expect(run.sessionId).toBe(sessionId)
          expect(run.finalResponse).toBe(response)
        }
        const events = runs.flatMap(run => run.events)
        const notifications = runs.flatMap(run => run.notifications)
        expect(events.filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1, 2])
        expect(events.filter(event => event.type === 'turn/end').map(event => event.data)).toEqual([
          { turn: 1, reason: { kind: 'completed' } }, { turn: 2, reason: { kind: 'completed' } },
        ])
        expect(server.requests).toHaveLength(2)
        expect(server.requests.map(request => ({ script: request.scriptBehavior, outcome: request.outcome }))).toEqual([
          { script: 'success', outcome: 'completed' }, { script: 'success', outcome: 'completed' },
        ])
        const modelRequests = server.requests.map((request) => {
          if (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)) {
            throw new Error('Mock server received a non-object model request')
          }
          const body = request.body as Record<string, unknown>
          expect(Array.isArray(body.messages)).toBe(true)
          const serialized = JSON.stringify(body)
          for (const marker of [
            'native-projection-', 'skill/native-item', 'claude-code/root-protocol', 'skill/sequential-',
            'coding-session/import-initialization', 'fixture-profile', 'fixture-native-session',
            'fixture-mirror', 'fixture-link', 'fixture-initializer-system',
          ]) {
            expect(serialized).not.toContain(marker)
          }
          return { system: body.system, messages: body.messages }
        })
        const userWire = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
        const firstWire = [{ role: 'user', content: [
          { type: 'text', text: importText }, { type: 'text', text: firstPrompt },
        ] }]
        expect(modelRequests[0]?.messages).toEqual(firstWire)
        expect(modelRequests[1]?.messages).toEqual([
          ...firstWire, { role: 'assistant', content: [{ type: 'text', text: response }] }, userWire(secondPrompt),
        ])
        expect(modelRequests[1]?.system).toEqual(modelRequests[0]?.system)

        const logPaths = latestPersistedSessionPaths(await readdir(sessionsRoot, { recursive: true }))
        expect(logPaths).toHaveLength(1)
        const logPath = join(sessionsRoot, logPaths[0]!)
        const rawLog = await readFile(logPath, 'utf8')
        expect(assertPersistedSessionVersion(basename(logPath), rawLog)).toBe(SESSION_FORMAT_VERSION)
        const persisted = records(rawLog)
        expect(persisted[0]?.id).toBe(sessionId)
        const durableEvents = persisted.slice(1)
        expect(durableEvents.map(event => event.seq)).toEqual(durableEvents.map((_event, index) => index))
        expect(durableEvents.every(event => typeof event.time === 'number' && Number.isFinite(event.time))).toBe(true)
        const metadata = first.events.filter(event => isMetadata(event.type))
        expect(metadata.map(event => ({ type: event.type, data: event.data }))).toEqual([
          ...nativeItems.map(data => ({ type: 'skill/native-item', data })),
          ...protocolRecords.map(data => ({ type: 'claude-code/root-protocol', data })),
          ...sequentialRecords, initializationReceipt,
        ])
        for (const event of metadata) {
          expect(Object.keys(event).sort()).toEqual(['type', 'seq', 'time', 'data', 'ignorable'].sort())
          expect(event.ignorable).toBe(true)
          expect(Number.isSafeInteger(event.seq)).toBe(true)
          expect(Number.isFinite(event.time)).toBe(true)
        }
        const seqs = metadata.map(event => event.seq)
        expect(seqs).toEqual([...new Set(seqs)].sort((left, right) => left - right))
        expect(second.events.filter(event => isMetadata(event.type))).toEqual([])
        expect(durableEvents.filter(event => typeof event.type === 'string' && isMetadata(event.type))).toEqual(metadata)
        const deliveredMetadata = notifications.filter(notification => notification.method === 'session.event'
          && typeof (notification.params.event as SessionEvent).type === 'string'
          && isMetadata((notification.params.event as SessionEvent).type))
        for (const notification of deliveredMetadata) {
          expect(Object.keys(notification.params).sort()).toEqual(['event', 'sessionId'])
          expect(notification.params.sessionId).toBe(sessionId)
        }
        expect(deliveredMetadata.map(notification => notification.params.event)).toEqual(metadata)

        const surface = events.filter(event => event.type === 'user/message' || event.type === 'assistant/message')
        expect(durableEvents.filter(event => event.type === 'user/message' || event.type === 'assistant/message')).toEqual(surface)
        const deliveredSurface = notifications.filter(notification => notification.method === 'session.event'
          && ['user/message', 'assistant/message'].includes((notification.params.event as SessionEvent).type))
        expect(deliveredSurface.map(notification => notification.params.event)).toEqual(surface)
        for (const notification of deliveredSurface) {
          expect(Object.keys(notification.params).sort()).toEqual(['event', 'sessionId'])
          expect(notification.params.sessionId).toBe(sessionId)
        }
        const users = events.filter(event => event.type === 'user/message')
        expect(users.map(event => event.data.source.kind)).toEqual(['coding-session-import', 'user', 'user'])
        const imported = users[0]!
        expect(Object.keys(imported).sort()).toEqual(['type', 'seq', 'time', 'data', 'surfaceOp'].sort())
        expect(imported.surfaceOp).toBe('append')
        expect(imported.data).toMatchObject({ role: 'user', source: importSource, content: userWire(importText).content })
        expect(imported.data.source).toEqual(importSource)
        expect(users.slice(1).map(event => event.data.content)).toEqual([
          userWire(firstPrompt).content, userWire(secondPrompt).content,
        ])
        const assistants = events.filter(event => event.type === 'assistant/message')
        expect(assistants).toHaveLength(2)
        for (const event of assistants) {
          expect(event.surfaceOp).toBe('append')
          expect(event.data.message).toMatchObject({
            role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: response }],
          })
        }
        const ctx: NormalizeContext = { cwd: root, sessionIds: [sessionId] }
        const files: Record<string, string> = {
          [writerSnapshotName(0)]: scrubModelRequestBulk(normalizeSessionSnapshot(rawLog, ctx)),
          'events.expected.jsonl': normalizeEvents(events, ctx),
          'notifications.expected.jsonl': normalizeNotifications(notifications, ctx),
          'model-visible.expected.jsonl': normalizeStdout(jsonl(modelRequests), ctx),
          'runs.expected.jsonl': normalizeStdout(jsonl(runs.map(run => ({
            sessionId: run.sessionId, finalResponse: run.finalResponse,
            events: records(normalizeEvents(run.events, ctx)),
            notifications: records(normalizeNotifications(run.notifications, ctx)),
          }))), ctx),
        }
        if (recording) {
          await mkdir(expectedDir, { recursive: true })
          for (const [name, actual] of Object.entries(files)) await writeFile(join(expectedDir, name), actual)
        }
        for (const [name, actual] of Object.entries(files)) {
          expect(actual, name).toBe(await readFile(join(expectedDir, name), 'utf8'))
        }
      } finally {
        await server.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
