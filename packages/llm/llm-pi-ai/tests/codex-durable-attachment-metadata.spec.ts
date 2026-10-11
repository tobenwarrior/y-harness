/** Durable attachment and model composition are real; the native peer is synthetic. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Sandbox from '@deepseek-ai/dsh-sandbox-policy'
import Approval from '@deepseek-ai/dsh-user-approval'
import LocalAttachmentStore from '../../../attachment/attachment-local/src/index.ts'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { CodexBackendConnection } from '../src/codex-backend-connection.ts'
import { projectCodexHistory } from '../src/codex-backend.ts'
import type { CodexPeer } from '../src/codex-backend.ts'

const native = vi.hoisted(() => ({ start: vi.fn<typeof import('../src/codex-backend-process.ts').startCodexProcess>() }))
vi.mock('../src/codex-backend-process.ts', async original => ({
  ...await original<typeof import('../src/codex-backend-process.ts')>(), startCodexProcess: native.start,
}))
afterEach(() => { native.start.mockReset() })

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'codex-durable-admission-')); const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  const model = { id: 'fixture-model', name: 'Fixture', description: '', efforts: [{ id: 'low', description: 'Low' }],
    inputModalities: ['text', 'image'], serviceTiers: [] }
  await writeFile(join(home, 'harness-backend.json'), JSON.stringify({ enabled: true, models: [model], tiers: {} }))
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: {
    DSH_CODEX_HOME: home, DSH_CODEX_BINARY: join(home, 'never-executed.js'), DSH_CODEX_CWD: home,
    DSH_CODEX_SHELL_HOME: join(home, 'shell'), DSH_CODEX_NODE: process.execPath,
  } }]))
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Sandbox, { mode: 'read-only', workspaceRoot: home }); await ctx.plugin(Approval, { policy: 'never' })
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  const calls: Array<{ method: string; params: object }> = []
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>()
  const peer: CodexPeer = { request: async (method, params) => {
    calls.push({ method, params })
    if (method === 'initialize') return {}
    if (method === 'account/read') return { account: { type: 'chatgpt' } }
    if (method === 'model/list') return { data: [{ model: model.id, displayName: model.name, inputModalities: ['text', 'image'],
      supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }] }] }
    if (method === 'thread/start') return { thread: { id: 'fixture-thread' } }
    if (method === 'turn/start') {
      queueMicrotask(() => {
        for (const callback of listeners) callback('turn/completed', {
          threadId: 'fixture-thread', turnId: 'fixture-turn', turn: { id: 'fixture-turn', status: 'completed' },
        })
      })
      return { turn: { id: 'fixture-turn' } }
    }
    throw new Error(`Unexpected native request: ${method}`)
  }, notify() {}, subscribe: (callback) => { listeners.add(callback); return () => { listeners.delete(callback) } },
  close: () => { listeners.clear() } }
  native.start.mockReturnValue(peer)
  await ctx.plugin(CodexBackendConnection); await ctx.codexBackendConnection.refresh()
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('durable-attachment-admission'), {}, { cwd: home })
  return { ctx, agent, calls }
}

describe('Codex durable attachment and admitted model metadata', () => {
  it('keeps supported efforts without inventing a default in the real LLM catalog', async () => {
    const f = await fixture()
    const info = await f.ctx.llm.resolveModelInfo('codex-backend', 'fixture-model')
    expect(info.reasoning).toEqual({ efforts: [{ id: 'low', name: 'low', description: 'Low' }] })
    expect(info.reasoning).not.toHaveProperty('defaultEffort')
    expect(info.serviceTiers).toEqual({ tiers: [{ id: 'default', name: 'Standard' }], defaultTier: 'default' })
    expect(f.calls.map(call => call.method)).toEqual(['initialize', 'account/read', 'model/list'])
  })

  it('uses the real connection attachment resolver and exact durable image bytes', async () => {
    const f = await fixture()
    const attachment = await f.ctx.attachments.saveImage({ data: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'), mediaType: 'image/png' })
    const stored = await f.ctx.attachments.readImage(attachment)
    const chunks = await f.ctx.agents.withInitiator(f.agent, async () => {
      const collected = []
      for await (const chunk of f.ctx.llm.stream({ provider: 'codex-backend', model: 'fixture-model',
        sessionId: f.agent.session.id, messages: [createUserMessage({ source: { kind: 'user' },
          content: [{ type: 'text', text: 'Inspect the owned image.' }, { type: 'image', attachment }] })] })) collected.push(chunk)
      return collected
    })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(f.calls.find(call => call.method === 'turn/start')?.params).toMatchObject({
      input: [{ type: 'text', text: 'Inspect the owned image.\n[image attachment]', text_elements: [] },
        { type: 'image', url: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}` }],
      approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: true },
    })
    expect(await f.ctx.attachments.readImage(attachment)).toEqual(stored)
  })

  it('refuses an unprojected typed durable file before any native thread or turn', async () => {
    const f = await fixture()
    const attachment = await f.ctx.attachments.saveFile({ name: 'owned.txt', data: Uint8Array.of(65, 66, 67) })
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'file', attachment }] })
    expect(() => projectCodexHistory([message])).toThrow('text and image content only')
    expect(f.calls.map(call => call.method)).toEqual(['initialize', 'account/read', 'model/list'])
    const contents = []
    for await (const chunk of f.ctx.attachments.readFileStream(attachment)) contents.push(chunk)
    expect(Buffer.concat(contents)).toEqual(Buffer.from('ABC'))
  })
})
