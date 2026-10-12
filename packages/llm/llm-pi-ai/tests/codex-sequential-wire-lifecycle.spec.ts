/** Synthetic original-profile peers; no native process, credential or model request. */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CodingSessionOwnerToken, CodingSessionReadRequest, CodingSessionSource } from '@deepseek-ai/dsh-coding-session/types'
import type { CodexSessionSourceConfig } from '../src/coding-session-source.ts'
import type { CodexSequentialAccess } from '../src/codex-sequential.ts'
import { createCodexSequentialOwner } from '../src/codex-sequential.ts'
import type { CodexSequentialPeer } from '../src/codex-sequential-process.ts'
import { disabledServerMap, restrictedConfig } from '../src/codex-sequential-guards.ts'

type Obj = Record<string, unknown>
type WireCall = { process: number; method: string; params: object | undefined; turnRound: number; statusRound: number }
type Hook = (call: WireCall) => unknown
const read = (signal = new AbortController().signal): CodingSessionReadRequest => ({
  signal, limit: 2, maxEvents: 20, maxBytes: 1024 * 1024,
})
const get = (params: object | undefined, name: string): unknown => params === undefined ? undefined : Reflect.get(params, name)

async function fixture(options: { paginated?: boolean; noServers?: boolean; manualTurn?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-sequential-wire-'))
  const home = join(directory, 'native'); const cwd = join(directory, 'project')
  await Promise.all([mkdir(home), mkdir(cwd)])
  const profileId = brandString<CodingSessionSource['profileId']>('wire-fixture-profile')
  const source: CodingSessionSource = { provider: 'codex', profileId,
    nativeSessionId: brandString<CodingSessionSource['nativeSessionId']>('wire-fixture-original') }
  const config: CodexSessionSourceConfig = { id: 'wire-fixture', label: 'Wire fixture', home, cwd,
    shellHome: join(directory, 'shell'), nodePath: join(directory, 'node'), binary: join(directory, 'codex.js'),
    packageManifest: join(directory, 'package.json'), binarySha256: '0'.repeat(64), version: '0.160.0',
    graceMs: 1000, knownNoManagedFeatureOverrides: true }
  const answers: Obj[] = []
  const access: CodexSequentialAccess = { authority: {}, cwd, sandbox: 'workspace-write', writableRoots: [cwd],
    approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: true,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    request: async (_method, params) => { answers.push(params); return { answers: { choice: { answers: ['fixture'] } } } } }
  let currentAccess = access; let hook: Hook | undefined; let verify = async (): Promise<void> => {}
  let opened = 0; let dispatched = 0
  const calls: WireCall[] = []; const closed: number[] = []; const disposed: number[] = []
  const controls = new Map<number, {
    emit(method: string, params: Obj): void
    ask(method: string, params: Obj): Promise<unknown>
    disconnect(): void
    failure(): void
  }>()
  const turns = () => [
    { id: 'prior-turn', status: 'completed', items: [], itemsView: 'full' },
    ...(dispatched === 0 ? [] : [{ id: 'own-turn', status: 'completed', itemsView: 'full',
      items: [{ id: 'own-user', type: 'userMessage', content: [{ type: 'text', text: 'Continue fixture' }] }] }]),
  ]
  const server = { name: 'fixture.server', runtimeStatus: 'disabled', tools: {}, resources: [], resourceTemplates: [] }
  const factory = async (_config: CodexSessionSourceConfig, _request: CodingSessionReadRequest,
    servers: Record<string, { enabled: false }>): Promise<CodexSequentialPeer> => {
    const number = ++opened; let resumed = false; let connected = true; let failed = false
    let turnRound = 0; let statusRound = 0
    const listeners = new Set<(method: string, params: Obj) => void>()
    let handler: ((method: string, params: Obj) => Promise<unknown>) | undefined
    const emit = (method: string, params: Obj): void => { for (const listener of listeners) listener(method, params) }
    controls.set(number, { emit, ask: async (method, params) => {
      if (handler === undefined) throw new Error('Fixture has no native request handler')
      return await handler(method, params)
    }, disconnect: () => { connected = false }, failure: () => { failed = true } })
    const nativeThread = () => ({ id: source.nativeSessionId, name: 'Wire fixture', preview: 'Wire fixture', cwd,
      updatedAt: dispatched, historyMode: options.paginated === true ? 'paginated' : 'legacy',
      status: { type: resumed ? 'idle' : 'notLoaded' }, turns: options.paginated === true ? [] : turns() })
    return { connected: () => connected, observedFailure: () => failed,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      onRequest: (callback) => { handler = callback },
      request: async (method, params, signal) => {
        signal.throwIfAborted()
        if (method === 'thread/turns/list' && get(params, 'cursor') === undefined) turnRound++
        if (method === 'mcpServerStatus/list' && get(params, 'cursor') === undefined) statusRound++
        const call = { process: number, method, params, turnRound, statusRound }; calls.push(call)
        const override = await hook?.(call)
        signal.throwIfAborted()
        if (override !== undefined) return override
        if (method === 'configRequirements/read') return { requirements: null }
        if (method === 'config/read') return { config: restrictedConfig(
          options.noServers === true ? {} : { mcp_servers: { 'fixture.server': { command: 'fixture-only' } } }, servers) }
        if (method === 'thread/read') return { thread: nativeThread() }
        if (method === 'thread/turns/list') return { data: turns(), nextCursor: null }
        if (method === 'thread/items/list') return { data: turns().find(turn => turn.id === get(params, 'turnId'))?.items
          .map(item => ({ turnId: get(params, 'turnId'), item })) ?? [], nextCursor: null }
        if (method === 'thread/resume') { resumed = true; return { thread: nativeThread(), cwd,
          approvalPolicy: access.approvalPolicy, approvalsReviewer: 'user', sandbox: access.sandboxPolicy } }
        if (method === 'mcpServerStatus/list') return { data: options.noServers === true ? [] : [server], nextCursor: null }
        if (method === 'turn/start') {
          dispatched++
          if (options.manualTurn !== true) queueMicrotask(() =>{  emit('turn/completed', {
            threadId: source.nativeSessionId, turn: { id: 'own-turn', status: 'completed' },
          }) })
          return { turn: { id: 'own-turn', status: 'inProgress' } }
        }
        if (method === 'turn/interrupt') return {}
        throw new Error(`Unexpected fixture request ${method}`)
      },
      close: async () => { connected = false; closed.push(number); emit('__closed', {}) },
      dispose: async () => { connected = false; disposed.push(number) },
    }
  }
  const owner = createCodexSequentialOwner(config, 'wire-fixture-profile', profileId, () => currentAccess, factory, () => verify())
  onTestFinished(async () => { try { await owner.close() } finally { await rm(directory, { recursive: true, force: true }) } })
  const acquire = (request = read()) => owner.writer.acquire(source, { ...request,
    ownerToken: brandString<CodingSessionOwnerToken>('wire-fixture-owner'), nativeProfileUnchanged: true })
  const control = (number = 2) => {
    const value = controls.get(number)
    if (value === undefined) throw new Error('Fixture peer was not opened')
    return value
  }
  return { owner, source, config, access, calls, answers, closed, disposed, acquire, control,
    setHook: (value: Hook) => { hook = value }, setAccess: (value: CodexSequentialAccess) => { currentAccess = value },
    setVerify: (value: () => Promise<void>) => { verify = value } }
}

describe('sequential bounded native readback', () => {
  it('accepts an omitted MCP server map as an empty observed inventory', () => {
    expect(disabledServerMap({}, 2)).toEqual({})
  })

  it('uses public ascending paginated turn history through acquire, dispatch and cold release', async () => {
    const f = await fixture({ paginated: true, noServers: true }); const lease = await f.acquire()
    expect((await lease.read(read())).events).toEqual([])
    const result = await lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal: read().signal, beforeDispatch: async () => {} })
    expect(result.nativeTurnId).toBe('own-turn')
    const receipt = await lease.release(read())
    expect(receipt).toMatchObject({ completedTurnPersisted: true, nativeTurnIds: ['own-turn'], processExited: true, streamsDrained: true })
    expect(receipt.snapshot.events.map(event => [event.role, event.text])).toEqual([['user', 'Continue fixture']])
    expect(f.calls.filter(call => call.method === 'thread/turns/list').every(call => get(call.params, 'sortDirection') === 'asc')).toBe(true)
    expect(f.calls.filter(call => call.method === 'thread/read').some(call => get(call.params, 'includeTurns') === true)).toBe(false)
    expect(f.closed).toEqual([1, 2, 3])
  })

  it.each([
    ['repeated cursor', { data: [], nextCursor: 'repeat' }, /repeated a cursor/],
    ['page overflow', { data: Array.from({ length: 3 }, (_, i) => ({ id: `turn-${i}`, status: 'completed' })), nextCursor: null }, /configured limits/],
    ['duplicate turn', { data: [{ id: 'same', status: 'completed' }, { id: 'same', status: 'completed' }], nextCursor: null }, /incomplete, repeated/],
    ['running turn', { data: [{ id: 'running', status: 'inProgress' }], nextCursor: null }, /incomplete, repeated/],
  ] as const)('refuses %s from the saved-status pagination without opening a writer', async (_name, page, message) => {
    const f = await fixture({ paginated: true })
    f.setHook(call => call.process === 1 && call.method === 'thread/turns/list' && call.turnRound >= 3 ? page : undefined)
    await expect(f.acquire()).rejects.toThrow(message)
    expect(f.calls.filter(call => call.method === 'thread/resume' || call.method === 'turn/start')).toEqual([])
    expect(f.disposed).toEqual([1])
  })

  it('limits empty status pages before the next request can exceed the page budget', async () => {
    const f = await fixture({ paginated: true }); let pages = 0
    f.setHook(call => call.process === 1 && call.method === 'thread/turns/list' && call.turnRound >= 3
      ? { data: [], nextCursor: `empty-${++pages}` } : undefined)
    await expect(f.acquire({ ...read(), maxEvents: 2 })).rejects.toThrow(/page limit/)
    expect(pages).toBe(2); expect(f.disposed).toEqual([1])
  })

  it('bounds configuration bytes before reading or resuming native history', async () => {
    const f = await fixture()
    f.setHook(call => call.method === 'config/read' ? { config: { notes: 'x'.repeat(2000) } } : undefined)
    await expect(f.acquire({ ...read(), maxBytes: 1000 })).rejects.toThrow(/configuration exceeded/)
    expect(f.calls.some(call => call.method === 'thread/read')).toBe(false)
  })

  it.each([
    ['different identity', { id: 'another-session' }],
    ['different project', { cwd: '/fixture/another-project' }],
    ['runtime error', { status: { type: 'systemError' } }],
  ] as const)('refuses saved-status headers reporting a %s', async (_name, change) => {
    const f = await fixture(); let heads = 0
    f.setHook((call) => {
      if (call.process === 1 && call.method === 'thread/read' && get(call.params, 'includeTurns') === false && ++heads === 2) {
        return { thread: { id: f.source.nativeSessionId, name: 'Wire fixture', preview: 'Wire fixture', cwd: f.access.cwd,
          updatedAt: 0, historyMode: 'legacy', status: { type: 'notLoaded' }, turns: [], ...change } }
      }
    })
    await expect(f.acquire()).rejects.toThrow(/saved turn identities are unavailable/)
    expect(f.calls.some(call => call.method === 'thread/resume')).toBe(false); expect(f.disposed).toEqual([1])
  })

  it.each([
    ['unobserved name', { name: 'other', runtimeStatus: 'disabled', tools: {}, resources: [], resourceTemplates: [] }],
    ['running server', { name: 'fixture.server', runtimeStatus: 'ready', tools: {}, resources: [], resourceTemplates: [] }],
    ['tool capability', { name: 'fixture.server', runtimeStatus: 'disabled', tools: { tool: {} }, resources: [], resourceTemplates: [] }],
    ['resource capability', { name: 'fixture.server', runtimeStatus: 'disabled', tools: {}, resources: [{}], resourceTemplates: [] }],
    ['template capability', { name: 'fixture.server', runtimeStatus: 'disabled', tools: {}, resources: [], resourceTemplates: [{}] }],
  ] as const)('rejects %s in the resumed server inventory', async (_name, server) => {
    const f = await fixture(); f.setHook(call => call.method === 'mcpServerStatus/list' ? { data: [server] } : undefined)
    await expect(f.acquire()).rejects.toThrow(/native server capability/)
    expect(f.disposed).toEqual([2]); expect(f.calls.some(call => call.method === 'turn/start')).toBe(false)
  })

  it('requires every configured server to appear as disabled in the public inventory', async () => {
    const f = await fixture(); f.setHook(call => call.method === 'mcpServerStatus/list' ? { data: [] } : undefined)
    await expect(f.acquire()).rejects.toThrow(/every observed native server/)
    expect(f.disposed).toEqual([2])
  })

  it('rejects a repeated disabled-server cursor before granting a lease', async () => {
    const f = await fixture(); f.setHook(call => call.method === 'mcpServerStatus/list' ? { data: [], nextCursor: 'repeat' } : undefined)
    await expect(f.acquire()).rejects.toThrow(/repeated a cursor/); expect(f.disposed).toEqual([2])
  })

  it('bounds empty disabled-server pages independently of the advertised server count', async () => {
    const f = await fixture(); let pages = 0
    f.setHook(call => call.method === 'mcpServerStatus/list' ? { data: [], nextCursor: `empty-${++pages}` } : undefined)
    await expect(f.acquire({ ...read(), maxEvents: 2 })).rejects.toThrow(/inventory exceeded its page limit/)
    expect(pages).toBe(2); expect(f.disposed).toEqual([2])
  })

  it('rejects a server page exceeding the selected per-page bound', async () => {
    const f = await fixture()
    f.setHook(call => call.method === 'mcpServerStatus/list' ? { data: Array.from({ length: 3 }, () => ({
      name: 'fixture.server', runtimeStatus: 'disabled', tools: {}, resources: [], resourceTemplates: [],
    })) } : undefined)
    await expect(f.acquire()).rejects.toThrow(/inventory exceeded its bounds/); expect(f.disposed).toEqual([2])
  })
})

describe('sequential authority and lifetime', () => {
  it('refuses a profile lacking its explicit managed-feature acknowledgement before launch', async () => {
    const f = await fixture(); const selected = { ...f.config, knownNoManagedFeatureOverrides: false }
    expect(() => createCodexSequentialOwner(selected, 'wire-fixture-profile', f.source.profileId,
      () => f.access, async () => { throw new Error('No fixture launch allowed') }, async () => {})).toThrow(/trusted/)
    expect(f.calls).toEqual([])
  })

  it('refuses a mismatched native source before any peer starts', async () => {
    const f = await fixture()
    await expect(f.owner.writer.acquire({ ...f.source, provider: 'claude' }, { ...read(),
      ownerToken: brandString<CodingSessionOwnerToken>('fixture-owner'), nativeProfileUnchanged: true })).rejects.toThrow(/did not match/)
    expect(f.calls).toEqual([])
  })

  it('rechecks authority after the preflight process has closed', async () => {
    const f = await fixture()
    f.setHook((call) => { if (call.process === 1 && call.method === 'thread/read') f.setAccess({ ...f.access, authority: {} }) })
    await expect(f.acquire()).rejects.toThrow(/authority changed during/)
    expect(f.closed).toEqual([1]); expect(f.calls.some(call => call.method === 'thread/resume')).toBe(false)
  })

  it('rechecks authority after native resume before exposing a lease', async () => {
    const f = await fixture()
    f.setHook((call) => { if (call.method === 'mcpServerStatus/list') f.setAccess({ ...f.access, authority: {} }) })
    await expect(f.acquire()).rejects.toThrow(/authority changed after/); expect(f.disposed).toEqual([2])
  })

  it('refuses an original session whose existing directory differs from the selected Harness project', async () => {
    const f = await fixture()
    f.setHook(call => call.method === 'thread/read' ? { thread: {
      id: f.source.nativeSessionId, name: 'Wire fixture', preview: 'Wire fixture', cwd: f.config.home, updatedAt: 0,
      historyMode: 'legacy', status: { type: 'notLoaded' }, turns: [{ id: 'prior-turn', status: 'completed', items: [] }],
    } } : undefined)
    await expect(f.acquire()).rejects.toThrow(/selected live Harness project differ/)
    expect(f.calls.some(call => call.method === 'thread/resume')).toBe(false)
  })

  it('keeps an in-flight acquisition exclusive and disposal awaits its verification barrier', async () => {
    const f = await fixture(); const entered = Promise.withResolvers<undefined>(); const finish = Promise.withResolvers<undefined>()
    f.setVerify(async () => { entered.resolve(undefined); await finish.promise })
    const pending = f.acquire(); const failure = expect(pending).rejects.toThrow(/disposed/)
    await entered.promise
    await expect(f.acquire()).rejects.toThrow(/unresolved sequential owner/)
    let closed = false; const disposal = f.owner.close().then(() => { closed = true })
    await Promise.resolve(); expect(closed).toBe(false); finish.resolve(undefined)
    await failure; await disposal; expect(f.calls).toEqual([])
  })

  it('rejects a disconnected held peer before reading retained history', async () => {
    const f = await fixture(); const lease = await f.acquire(); f.control().disconnect()
    await expect(lease.read(read())).rejects.toThrow(/disconnected/)
  })

  it('rejects observed native failure before a held read or dispatch', async () => {
    const f = await fixture(); const lease = await f.acquire(); f.control().failure()
    await expect(lease.read(read())).rejects.toThrow(/observed native failure/)
    await expect(lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal: read().signal,
      beforeDispatch: async () => {} })).rejects.toThrow(/observed native failure/)
    expect(f.calls.some(call => call.method === 'turn/start')).toBe(false)
  })

  it('does not retain a lease when the acquisition checkpoint reports an unloaded runtime', async () => {
    const f = await fixture()
    f.setHook(call => call.process === 2 && call.method === 'thread/read' ? { thread: {
      id: f.source.nativeSessionId, name: 'Wire fixture', preview: 'Wire fixture', cwd: f.access.cwd, updatedAt: 0,
      historyMode: 'legacy', status: { type: 'notLoaded' }, turns: [{ id: 'prior-turn', status: 'completed', items: [] }],
    } } : undefined)
    await expect(f.acquire()).rejects.toThrow(/idle native runtime/); expect(f.disposed).toEqual([2])
  })

  it('refuses read and continuation after a successful persisted release', async () => {
    const f = await fixture(); const lease = await f.acquire(); await lease.release(read())
    await expect(lease.read(read())).rejects.toThrow(/not available/)
    await expect(lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal: read().signal,
      beforeDispatch: async () => {} })).rejects.toThrow(/held exact source/)
  })

  it('detects metadata changes while a retained lease is held', async () => {
    const f = await fixture(); const lease = await f.acquire()
    f.setHook(call => call.process === 2 && call.method === 'thread/read' ? { thread: {
      id: f.source.nativeSessionId, name: 'Wire fixture', preview: 'Wire fixture', cwd: f.access.cwd, updatedAt: 100,
      historyMode: 'legacy', status: { type: 'idle' }, turns: [{ id: 'prior-turn', status: 'completed', items: [] }],
    } } : undefined)
    await expect(lease.read(read())).rejects.toThrow(/history changed while/)
  })

  it('detects changed public metadata before durable admission', async () => {
    const f = await fixture(); const lease = await f.acquire(); let admitted = false
    f.setHook(call => call.process === 2 && call.method === 'thread/read' ? { thread: {
      id: f.source.nativeSessionId, name: 'Wire fixture', preview: 'Wire fixture', cwd: f.access.cwd, updatedAt: 100,
      historyMode: 'legacy', status: { type: 'idle' }, turns: [{ id: 'prior-turn', status: 'completed', items: [] }],
    } } : undefined)
    await expect(lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal: read().signal,
      beforeDispatch: async () => { admitted = true } })).rejects.toThrow(/history changed before/)
    expect(admitted).toBe(false); expect(f.calls.some(call => call.method === 'turn/start')).toBe(false)
  })
})

describe('sequential correlated interactions', () => {
  const complete = (f: Awaited<ReturnType<typeof fixture>>): void =>{  f.control().emit('turn/completed', {
    threadId: f.source.nativeSessionId, turn: { id: 'own-turn', status: 'completed' },
  }) }
  async function running(f: Awaited<ReturnType<typeof fixture>>, signal = read().signal) {
    const lease = await f.acquire(); const started = Promise.withResolvers<undefined>()
    const pending = lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal,
      beforeDispatch: async () => {}, onNativeTurn: async () => { started.resolve(undefined) } })
    await started.promise
    return { lease, pending }
  }

  it('declines questions outside the admitted turn without opening a Harness interaction', async () => {
    const f = await fixture(); await f.acquire()
    expect(await f.control().ask('item/tool/requestUserInput', { threadId: f.source.nativeSessionId, turnId: 'prior-turn', questions: [] })).toEqual({ answers: {} })
    expect(f.answers).toEqual([])
  })

  it('forwards only a correlated current-turn user question and returns its answer', async () => {
    const f = await fixture({ manualTurn: true }); const { lease, pending } = await running(f)
    const question = { threadId: f.source.nativeSessionId, turnId: 'own-turn', questions: [{ id: 'choice', question: 'Fixture choice' }] }
    expect(await f.control().ask('item/tool/requestUserInput', question)).toEqual({ answers: { choice: { answers: ['fixture'] } } })
    expect(f.answers).toEqual([question]); complete(f); await pending
    expect(await lease.release(read())).toMatchObject({ completedTurnPersisted: true })
  })

  it('declines native command approval even for the exact active turn', async () => {
    const f = await fixture({ manualTurn: true }); const { pending } = await running(f)
    expect(await f.control().ask('item/commandExecution/requestApproval', { threadId: f.source.nativeSessionId, turnId: 'own-turn' })).toEqual({ decision: 'decline' })
    expect(f.answers).toEqual([]); complete(f); await pending
  })

  it('waits for start acknowledgement before forwarding an early correlated question', async () => {
    const f = await fixture({ manualTurn: true }); let answer: Promise<unknown> | undefined
    f.setHook((call) => {
      if (call.method === 'turn/start') answer = f.control().ask('item/tool/requestUserInput', {
        threadId: f.source.nativeSessionId, turnId: 'own-turn', questions: [],
      })
    })
    const { pending } = await running(f)
    await vi.waitFor(() => { expect(f.answers).toHaveLength(1) })
    expect(await answer).toEqual({ answers: { choice: { answers: ['fixture'] } } }); complete(f); await pending
  })

  it('declines an early question when the acknowledged turn differs from its request', async () => {
    const f = await fixture({ manualTurn: true }); let answer: Promise<unknown> | undefined
    f.setHook((call) => {
      if (call.method === 'turn/start') answer = f.control().ask('item/tool/requestUserInput', {
        threadId: f.source.nativeSessionId, turnId: 'prior-turn', questions: [],
      })
    })
    const { pending } = await running(f)
    expect(await answer).toEqual({ answers: {} }); expect(f.answers).toEqual([]); complete(f); await pending
  })

  it('discards a human answer whose admitted native turn settled while the answer was pending', async () => {
    const f = await fixture({ manualTurn: true }); const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<Obj>()
    f.setAccess({ ...f.access, request: async () => {
      entered.resolve(undefined); return await answer.promise
    } })
    const { pending } = await running(f)
    const question = f.control().ask('item/tool/requestUserInput', { threadId: f.source.nativeSessionId, turnId: 'own-turn', questions: [] })
    const refused = expect(question).rejects.toThrow(/admitted turn settled/)
    await entered.promise; complete(f); await pending
    answer.resolve({ answers: { choice: { answers: ['late'] } } })
    await refused
  })

  it('declines a pending human answer after release begins while letting the owned turn finish', async () => {
    const f = await fixture({ manualTurn: true }); const entered = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<Obj>()
    f.setAccess({ ...f.access, request: async () => { entered.resolve(undefined); return await answer.promise } })
    const { lease, pending } = await running(f)
    const question = f.control().ask('item/tool/requestUserInput', { threadId: f.source.nativeSessionId, turnId: 'own-turn', questions: [] })
    await entered.promise; const release = lease.release(read())
    answer.resolve({ answers: { choice: { answers: ['late'] } } }); expect(await question).toEqual({ answers: {} })
    complete(f); await pending
    expect(await release).toMatchObject({ completedTurnPersisted: true, nativeTurnIds: ['own-turn'] })
  })

  it('interrupts the exact active native turn when its initiating request is cancelled', async () => {
    const f = await fixture({ manualTurn: true }); const controller = new AbortController()
    const { lease, pending } = await running(f, controller.signal)
    const failure = expect(pending).rejects.toThrow(/clean terminal receipt/)
    controller.abort(new Error('Fixture request cancelled')); await failure
    expect(f.calls.filter(call => call.method === 'turn/interrupt').map(call => call.params)).toEqual([
      { threadId: f.source.nativeSessionId, turnId: 'own-turn' },
    ])
    await expect(lease.release(read())).rejects.toThrow(/unresolved native turn/)
  })

  it('contains a rejected interrupt RPC during cancellation without accepting a terminal receipt', async () => {
    const f = await fixture({ manualTurn: true }); const controller = new AbortController()
    f.setHook((call) => { if (call.method === 'turn/interrupt') throw new Error('Fixture interrupt transport rejected') })
    const { pending } = await running(f, controller.signal)
    const failure = expect(pending).rejects.toThrow(/clean terminal receipt/)
    controller.abort(new Error('Fixture request cancelled')); await failure
    expect(f.calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(1)
  })

  it('cancels an in-flight turn-start request before a native identity becomes available', async () => {
    const f = await fixture({ manualTurn: true }); const controller = new AbortController()
    const entered = Promise.withResolvers<undefined>(); const finish = Promise.withResolvers<undefined>()
    f.setHook(async (call) => {
      if (call.method === 'turn/start') { entered.resolve(undefined); await finish.promise }
    })
    const lease = await f.acquire()
    const pending = lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal: controller.signal, beforeDispatch: async () => {} })
    const failure = expect(pending).rejects.toThrow(/start cancelled/)
    await entered.promise; controller.abort(new Error('Fixture start cancelled')); finish.resolve(undefined); await failure
    expect(f.calls.some(call => call.method === 'turn/interrupt')).toBe(false); expect(f.disposed).toContain(2)
  })

  it('cancels unfinished turn work when its release request is already aborted', async () => {
    const f = await fixture({ manualTurn: true }); const { lease, pending } = await running(f)
    const controller = new AbortController(); controller.abort(new Error('Fixture release cancelled'))
    const turnFailure = expect(pending).rejects.toThrow(/clean terminal receipt/)
    await expect(lease.release(read(controller.signal))).rejects.toThrow(/unresolved native turn/)
    await turnFailure; expect(f.calls.filter(call => call.method === 'turn/interrupt')).toHaveLength(1)
  })

  it('provider disposal drains the unfinished admitted work before returning', async () => {
    const f = await fixture({ manualTurn: true }); const { pending } = await running(f)
    const failure = expect(pending).rejects.toThrow(/clean terminal receipt/)
    await f.owner.close(); await failure; expect(f.disposed).toContain(2)
  })

  it.each(['error', '__closed'])('fails an admitted turn when its native peer reports %s', async (method) => {
    const f = await fixture({ manualTurn: true }); const { pending } = await running(f)
    const failure = expect(pending).rejects.toThrow(/clean terminal receipt/)
    f.control().emit(method, {}); await failure
    expect(f.disposed).toContain(2)
  })

  it('fails an admitted turn after a notification from another native session', async () => {
    const f = await fixture({ manualTurn: true }); const { pending } = await running(f)
    const failure = expect(pending).rejects.toThrow(/clean terminal receipt/)
    f.control().emit('item/completed', { threadId: 'another-session', turnId: 'own-turn', item: {} }); await failure
  })

  it.each([
    ['in-progress terminal', { id: 'own-turn', status: 'inProgress' }],
    ['wrong terminal identity', { id: 'prior-turn', status: 'completed' }],
    ['missing terminal identity', { status: 'completed' }],
  ] as const)('refuses a %s notification', async (_name, turn) => {
    const f = await fixture({ manualTurn: true }); const { pending } = await running(f)
    const failure = expect(pending).rejects.toThrow(/clean terminal receipt/)
    f.control().emit('turn/completed', { threadId: f.source.nativeSessionId, turn }); await failure
  })

  it('refuses duplicate terminal notifications before reporting native completion', async () => {
    const f = await fixture({ manualTurn: true }); const { pending } = await running(f)
    const failure = expect(pending).rejects.toThrow(/clean terminal receipt/)
    complete(f); complete(f); await failure
  })

  it.each([undefined, '', 'prior-turn'])('rejects an item notification with unconfirmed turn identity (%s)', async (turnId) => {
    const f = await fixture({ manualTurn: true }); const { pending } = await running(f)
    const failure = expect(pending).rejects.toThrow(/clean terminal receipt/)
    f.control().emit('item/completed', { threadId: f.source.nativeSessionId, turnId, item: { id: 'read', type: 'commandExecution' } })
    await failure
  })

  it('ignores unsupported current-turn item kinds without creating observation evidence', async () => {
    const f = await fixture({ manualTurn: true }); const { pending } = await running(f)
    f.control().emit('item/completed', { threadId: f.source.nativeSessionId, turnId: 'own-turn', item: {
      id: 'reasoning', type: 'reasoning', summary: ['fixture-private-reasoning'],
    } })
    complete(f); expect((await pending).nativeTurnId).toBe('own-turn')
  })

  it('refuses a terminal notice buffered before startup whose native turn is different', async () => {
    const f = await fixture({ manualTurn: true })
    f.setHook((call) => { if (call.method === 'turn/start') f.control().emit('turn/completed', {
      threadId: f.source.nativeSessionId, turn: { id: 'prior-turn', status: 'completed' },
    }) })
    const lease = await f.acquire()
    await expect(lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal: read().signal,
      beforeDispatch: async () => {} })).rejects.toThrow(/clean terminal receipt/)
  })

  it('awaits persisted live native observations before returning the completed turn', async () => {
    const f = await fixture({ manualTurn: true }); const lease = await f.acquire()
    const started = Promise.withResolvers<undefined>(); const observed = Promise.withResolvers<undefined>()
    const saved = Promise.withResolvers<undefined>()
    const items: unknown[] = []; let finished = false
    const pending = lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal: read().signal,
      beforeDispatch: async () => {}, onNativeTurn: async () => { started.resolve(undefined) },
      onNativeItem: async (item) => { items.push(item); observed.resolve(undefined); await saved.promise },
    }).then((result) => { finished = true; return result })
    await started.promise; await Promise.resolve()
    f.control().emit('item/completed', { threadId: f.source.nativeSessionId, turnId: 'own-turn', item: {
      id: 'live-read', type: 'commandExecution', source: 'agent', command: 'cat src/live.ts', cwd: f.access.cwd,
      commandActions: [{ type: 'read', command: 'cat src/live.ts', path: join(f.access.cwd, 'src/live.ts') }],
      status: 'completed', exitCode: 0, aggregatedOutput: 'fixture-private-output',
    } })
    await observed.promise; complete(f); await Promise.resolve(); expect(finished).toBe(false)
    saved.resolve(undefined); await pending
    expect(items).toMatchObject([{ phase: 'settled', procedure: { kind: 'read', path: 'src/live.ts' } }])
    expect(JSON.stringify(items)).not.toContain('fixture-private-output')
  })

  it('bounds buffered native observations before returning a completed turn', async () => {
    const f = await fixture()
    f.setHook((call) => {
      if (call.method === 'turn/start') for (let i = 0; i < 3; i++) f.control().emit('item/completed', {
        threadId: f.source.nativeSessionId, turnId: 'own-turn', item: {
          id: `read-${i}`, type: 'commandExecution', source: 'agent', command: 'cat src/a.ts', cwd: f.access.cwd,
          commandActions: [{ type: 'read', command: 'cat src/a.ts', path: join(f.access.cwd, 'src/a.ts') }], status: 'completed', exitCode: 0,
        },
      })
    })
    const lease = await f.acquire({ ...read(), maxEvents: 2 })
    await expect(lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal: read().signal,
      beforeDispatch: async () => {} })).rejects.toThrow(/observed native failure/)
  })

  it('rejects observations queued before a concurrent release changed the admitted phase', async () => {
    const f = await fixture({ manualTurn: true }); const { lease, pending } = await running(f)
    await Promise.resolve(); const turnFailure = expect(pending).rejects.toThrow(/clean terminal receipt/)
    f.control().emit('item/completed', { threadId: f.source.nativeSessionId, turnId: 'own-turn', item: {
      id: 'release-race-read', type: 'commandExecution', source: 'agent', command: 'cat src/a.ts', cwd: f.access.cwd,
      commandActions: [{ type: 'read', command: 'cat src/a.ts', path: join(f.access.cwd, 'src/a.ts') }], status: 'completed', exitCode: 0,
    } })
    await expect(lease.release(read())).rejects.toThrow(/unresolved native turn/); await turnFailure
  })

  it('does not expose a history read after a concurrent turn changed its lease phase', async () => {
    const f = await fixture({ manualTurn: true }); const lease = await f.acquire()
    const entered = Promise.withResolvers<undefined>(); const finish = Promise.withResolvers<undefined>(); let held = false
    f.setHook(async (call) => {
      if (!held && call.process === 2 && call.method === 'thread/read') {
        held = true; entered.resolve(undefined); await finish.promise
      }
    })
    const pendingRead = lease.read(read()); const readFailure = expect(pendingRead).rejects.toThrow(/ownership changed while reading/)
    await entered.promise
    const started = Promise.withResolvers<undefined>()
    const pendingTurn = lease.resumeOriginal({ source: f.source, text: 'Continue fixture', signal: read().signal,
      beforeDispatch: async () => {}, onNativeTurn: async () => { started.resolve(undefined) } })
    await started.promise; finish.resolve(undefined); await readFailure; complete(f); await pendingTurn
  })
})
