import { describe, expect, it, vi } from 'vitest'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { parseCodexModels, declineCodexRequest, projectCodexHistory, CodexBackendAdapter, CodexBackendRuntime } from '../src/codex-backend.ts'
import { ReasoningEffortId, ServiceTierId } from '@deepseek-ai/dsh-llm'
import type { SkillLearningNativeItem } from '@deepseek-ai/dsh-skill-library/types'
import { codexNativeItem } from '../src/codex-native-evidence.ts'

const catalog = { data: [{ id: 'sol-id', model: 'gpt-6.1-sol', displayName: 'Sol', description: 'Native', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'max', description: 'Max' }, { reasoningEffort: 'ultra', description: 'Delegation' }], defaultReasoningEffort: 'max', serviceTiers: [{ id: 'priority', name: 'Fast', description: 'More usage' }] }, { id: 'hidden', model: 'hidden', hidden: true }] }
function fixture(models: unknown = catalog, resolveAttachments?: () => AttachmentStore | undefined, observeNativeItem?: (options: import('@deepseek-ai/dsh-llm').GenerateOptions, item: SkillLearningNativeItem) => void, nativeEvidenceMaxItems?: number, observationScope: { cwd?: string; projectRoot?: string | null } = {}) {
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>()
  const request = vi.fn(async (method: string, _params: object): Promise<unknown> => {
    if (method === 'initialize') return { userAgent: 'codex' }
    if (method === 'model/list') return models
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'person@example.test', planType: 'pro' } }
    if (method === 'account/login/start') return { type: 'chatgptDeviceCode', loginId: 'login', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'CODE' }
    if (method === 'thread/start') return { thread: { id: 'thread1' } }
    if (method === 'turn/start') { queueMicrotask(() => { for (const cb of listeners) { cb('item/agentMessage/delta', { threadId: 'thread1', turnId: 'turn1', itemId: 'i1', delta: 'hello' }); cb('turn/completed', { threadId: 'thread1', turn: { id: 'turn1', status: 'completed', error: null } }) } }); return { turn: { id: 'turn1' } } }
    return {}
  })
  const peer = { request, notify: vi.fn(),
    subscribe: (cb: (method: string, params: Record<string, unknown>) => void) => {
      listeners.add(cb); return () => { listeners.delete(cb) }
    },
    close: vi.fn(),
  }
  const runtime = new CodexBackendRuntime({ connect: async () => peer,
    resolveAccess: () => ({ cwd: observationScope.cwd ?? '/session/project', sandbox: 'workspace-write', writableRoots: ['/session/project', '/tmp'], approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/session/project', '/tmp'], networkAccess: true }, request: declineCodexRequest }), persist: async () => {}, preferences: { enabled: false, models: [], tiers: {} },
    ...resolveAttachments === undefined ? {} : { resolveAttachments },
    resolveObservationProjectRoot: () => observationScope.projectRoot === null ? undefined : observationScope.projectRoot ?? '/session/project',
    connectionId: 'fixture-profile', ...observeNativeItem === undefined ? {} : { observeNativeItem },
    ...nativeEvidenceMaxItems === undefined ? {} : { nativeEvidenceMaxItems } })
  return { runtime, request, peer,
    emit: (method: string, params: Record<string, unknown>) => { for (const cb of listeners) cb(method, params) },
  }
}
describe('Codex native backend', () => {
  it('excludes native user-shell and background interaction sources from learning', () => {
    for (const source of ['userShell', 'unifiedExecStartup', 'unifiedExecInteraction', 'unrecognized']) {
      expect(codexNativeItem('profile', 'thread', 'turn', 'started', { id: 'item', type: 'commandExecution', source })).toBeUndefined()
    }
    expect(codexNativeItem('profile', 'thread', 'turn', 'started', { id: 'item', type: 'commandExecution', source: 'agent' })).toMatchObject({ kind: 'command' })
  })
  it('retains only concrete allowlisted project procedure facts', () => {
    const parse = (command: string, path?: string, cwd = '/project') => codexNativeItem('profile', 'thread', 'turn', 'started', {
      id: 'item', type: 'commandExecution', source: 'agent', command, cwd,
      commandActions: path === undefined ? [] : [{ type: 'read', path }],
    }, '/project')
    expect(parse('cat src/source.ts', '/project/src/source.ts')?.procedure).toEqual({ kind: 'read', path: 'src/source.ts' })
    expect(parse('pnpm  run test')?.procedure).toEqual({ kind: 'check', command: 'pnpm run test' })
    for (const [command, path] of [['cat .env', '/project/.env'], ['cat src/secrets.ts', '/project/src/secrets.ts'], ['cat ../other.ts', '/other.ts'], ['cat src/source.ts; printenv', '/project/src/source.ts'], ['cat src/source.ts', '/project/src/other.ts'], ['pnpm run deploy', undefined], ['TOKEN=private pnpm run test', undefined], ['pnpm run test --token private', undefined]]) {
      expect(parse(command!, path)?.procedure).toBeUndefined()
    }
    expect(parse('pnpm run test', undefined, '/elsewhere')?.procedure).toBeUndefined()
    expect(codexNativeItem('profile', 'thread', 'turn', 'started', { id: 'unknown-source', type: 'commandExecution', command: 'pnpm run test', cwd: '/project' }, '/project')?.procedure).toBeUndefined()
  })
  it('recognizes only the pinned simple POSIX shell wrapper grammar', () => {
    const parse = (command: string) => codexNativeItem('profile', 'thread', 'turn', 'started', {
      id: 'wrapped', type: 'commandExecution', source: 'agent', command, cwd: '/project',
      commandActions: command.includes('cat ') ? [{ type: 'read', command: 'cat src/source.ts', name: 'source.ts', path: '/project/src/source.ts' }] : [{ type: 'unknown', command: 'pnpm run test' }],
    }, '/project')
    // 0.160 Shell::derive_exec_args + CommandExecutionPresentation::from_raw/shlex1.3 try_join.
    for (const shell of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
      for (const flag of ['-lc', '-c']) {
        expect(parse(`${shell} ${flag} 'cat src/source.ts'`)?.procedure).toEqual({ kind: 'read', path: 'src/source.ts' })
        expect(parse(`${shell} ${flag} 'pnpm run test'`)?.procedure).toEqual({ kind: 'check', command: 'pnpm run test' })
      }
    }
    for (const command of ["/bin/zsh -lc 'cat $TOKEN'", "/bin/zsh -lc 'cat src/source.ts; printenv'", "/bin/zsh -lc 'TOKEN=x pnpm run test'", "/bin/zsh -lc 'cat $(printenv)'", "/bin/zsh -lc 'pnpm run test' extra", "/bin/zsh -lc \"cat 'src/source.ts'\"", "/bin/zsh -ilc 'pnpm run test'", "/custom/zsh -lc 'pnpm run test'"]) {
      expect(parse(command)?.procedure).toBeUndefined()
    }
  })
  it('requires the observed command cwd to equal an actual registered project root', async () => {
    for (const scope of [
      { cwd: '/session/project', projectRoot: '/session/project', expected: true },
      { cwd: '/session/project/subdir', projectRoot: '/session/project', expected: false },
      { cwd: '/session/project', projectRoot: null, expected: false },
    ]) {
      const observed: SkillLearningNativeItem[] = []
      const f = fixture(catalog, undefined, (_options, item) => { observed.push(item) }, undefined, scope)
      await f.runtime.refresh(); await f.runtime.configure(true)
      const original = f.request.getMockImplementation()!
      f.request.mockImplementation(async (method, params) => {
        if (method !== 'turn/start') return original(method, params)
        queueMicrotask(() => {
          const item = { id: 'check', type: 'commandExecution', source: 'agent', command: "/bin/zsh -lc 'pnpm run test'", cwd: scope.cwd, status: 'completed', exitCode: 0 }
          f.emit('item/started', { threadId: 'thread1', turnId: 'turn1', item })
          f.emit('item/completed', { threadId: 'thread1', turnId: 'turn1', item })
          f.emit('turn/completed', { threadId: 'thread1', turn: { id: 'turn1', status: 'completed' } })
        })
        return { turn: { id: 'turn1' } }
      })
      try {
        for await (const _chunk of f.runtime.stream({ provider: 'codex-backend', model: 'gpt-6.1-sol', messages: [] })) { /* settle */ }
        expect(observed).toHaveLength(2)
        expect(observed.every(item => item.procedure !== undefined)).toBe(scope.expected)
      } finally { f.runtime.close() }
    }
  })
  it('invalidates bounded native observation without disrupting the native answer', async () => {
    const observed: SkillLearningNativeItem[] = []
    const f = fixture(catalog, undefined, (_options, item) => { observed.push(item) }, 1)
    await f.runtime.refresh(); await f.runtime.configure(true)
    const original = f.request.getMockImplementation()!
    f.request.mockImplementation(async (method, params) => {
      if (method !== 'turn/start') return original(method, params)
      queueMicrotask(() => {
        for (const itemId of ['one', 'two', 'three']) {
          const item = { id: itemId, type: 'fileChange', status: 'completed' }
          f.emit('item/started', { threadId: 'thread1', turnId: 'turn1', item })
          f.emit('item/completed', { threadId: 'thread1', turnId: 'turn1', item })
        }
        f.emit('turn/completed', { threadId: 'thread1', turn: { id: 'turn1', status: 'completed' } })
      })
      return { turn: { id: 'turn1' } }
    })
    const chunks = []
    for await (const chunk of f.runtime.stream({ provider: 'codex-backend', model: 'gpt-6.1-sol', messages: [] })) chunks.push(chunk)
    expect(observed.map(item => item.phase)).toEqual(['started', 'settled', 'invalidated'])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    f.runtime.close()
  })
  it('invalidates changed start and settle metadata and ignores other native threads', async () => {
    const observed: SkillLearningNativeItem[] = []
    const f = fixture(catalog, undefined, (_options, item) => { observed.push(item) })
    await f.runtime.refresh(); await f.runtime.configure(true)
    const original = f.request.getMockImplementation()!
    f.request.mockImplementation(async (method, params) => {
      if (method !== 'turn/start') return original(method, params)
      queueMicrotask(() => {
        const identity = { threadId: 'thread1', turnId: 'turn1' }
        const item = { id: 'read', type: 'commandExecution', source: 'agent', cwd: '/session/project', command: 'cat src/one.ts', commandActions: [{ type: 'read', path: '/session/project/src/one.ts' }] }
        f.emit('item/started', { ...identity, threadId: 'background-thread', item })
        f.emit('item/started', { ...identity, item })
        f.emit('item/completed', { ...identity, item: { ...item, command: 'cat src/two.ts', commandActions: [{ type: 'read', path: '/session/project/src/two.ts' }], status: 'completed', exitCode: 0 } })
        f.emit('turn/completed', { ...identity, turn: { id: 'turn1', status: 'completed' } })
      })
      return { turn: { id: 'turn1' } }
    })
    for await (const _chunk of f.runtime.stream({ provider: 'codex-backend', model: 'gpt-6.1-sol', messages: [] })) { /* settle */ }
    expect(observed.map(item => item.phase)).toEqual(['started', 'invalidated'])
    f.runtime.close()
  })
  it('publishes only matching live native tool metadata without commands or result bodies', async () => {
    const observed: SkillLearningNativeItem[] = []
    const f = fixture(catalog, undefined, (_options, item) => { observed.push(item) })
    await f.runtime.refresh(); await f.runtime.configure(true)
    const original = f.request.getMockImplementation()!
    f.request.mockImplementation(async (method, params) => {
      if (method !== 'turn/start') return original(method, params)
      queueMicrotask(() => {
        const identity = { threadId: 'thread1', turnId: 'turn1' }
        const read = { id: 'read', type: 'commandExecution', command: 'cat /project/SKILL.md; api_key=private', commandActions: [{ type: 'read', path: '/project/.dsh/skills/inspect/SKILL.md' }] }
        f.emit('item/started', { ...identity, item: read })
        f.emit('item/completed', { ...identity, item: { ...read, status: 'completed', exitCode: 0, aggregatedOutput: 'must not retain stdout' } })
        f.emit('item/started', { ...identity, turnId: 'old-turn', item: { id: 'old', type: 'fileChange' } })
        f.emit('item/completed', { ...identity, item: { id: 'orphan', type: 'fileChange', status: 'completed' } })
        f.emit('item/started', { ...identity, item: { id: 'change', type: 'fileChange', changes: [{ diff: '+private contents' }] } })
        f.emit('item/completed', { ...identity, item: { id: 'change', type: 'fileChange', status: 'completed' } })
        f.emit('item/completed', { ...identity, item: { id: 'change', type: 'fileChange', status: 'completed' } })
        f.emit('turn/completed', { ...identity, turn: { id: 'turn1', status: 'completed' } })
      })
      return { turn: { id: 'turn1' } }
    })
    for await (const _chunk of f.runtime.stream({ provider: 'codex-backend', model: 'gpt-6.1-sol', messages: [] })) { /* consume the native turn */ }
    expect(observed).toHaveLength(4)
    expect(observed[0]).toMatchObject({ provider: 'codex', connectionId: 'fixture-profile', sessionId: 'thread1', turnId: 'turn1', itemId: 'read', kind: 'read', phase: 'started' })
    expect(observed[1]).toMatchObject({ outcome: 'reported-success', skillReadPath: '/project/.dsh/skills/inspect/SKILL.md' })
    expect(JSON.stringify(observed)).not.toMatch(/api_key|stdout|private contents|old|orphan/)
    f.runtime.close()
  })
  it('preserves real model IDs, Ultra and native Fast; filters hidden entries', () => {
    expect(parseCodexModels(catalog)).toEqual([{ id: 'gpt-6.1-sol', name: 'Sol', description: 'Native', efforts: [{ id: 'max', description: 'Max' }, { id: 'ultra', description: 'Delegation' }], defaultEffort: 'max', serviceTiers: [{ id: 'priority', name: 'Fast', description: 'More usage' }], inputModalities: ['text', 'image'] }])
  })
  it('republishes only seam modalities and keeps a native standard-tier default', () => {
    const rows = { data: [{ id: 'm', model: 'm', displayName: 'M', description: '', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }], defaultReasoningEffort: 'low', serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }], defaultServiceTier: 'priority', inputModalities: ['text', 'audio'] }] }
    expect(parseCodexModels(rows)).toEqual([{ id: 'm', name: 'M', description: '', efforts: [{ id: 'low', description: '' }], defaultEffort: 'low', serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }], defaultServiceTier: 'priority', inputModalities: ['text'] }])
  })
  it('offers Standard beside native Fast and republishes catalog modalities', async () => {
    const { runtime } = fixture(); await runtime.refresh()
    const adapter = new CodexBackendAdapter(runtime)
    const info = await adapter.resolveModel('codex-backend', 'gpt-6.1-sol')
    expect(info.inputModalities).toEqual(['text', 'image'])
    expect(info.serviceTiers).toEqual({ tiers: [{ id: 'default', name: 'Standard' }, { id: 'priority', name: 'Fast', description: 'More usage' }], defaultTier: 'default' })
    await runtime.configure(true, 'gpt-6.1-sol', 'priority')
    expect((await adapter.resolveModel('codex-backend', 'gpt-6.1-sol')).serviceTiers?.defaultTier).toBe('priority')
  })
  it('declines command and patch approvals and grants no permission extensions', async () => {
    expect(await declineCodexRequest('item/commandExecution/requestApproval', {})).toEqual({ decision: 'decline' })
    expect(await declineCodexRequest('item/fileChange/requestApproval', {})).toEqual({ decision: 'decline' })
    expect(await declineCodexRequest('item/permissions/requestApproval', {})).toEqual({ permissions: {}, scope: 'turn' })
    await expect(declineCodexRequest('account/chatgptAuthTokens/refresh', {})).rejects.toThrow()
  })
  it('does not start a subprocess on state/catalog reads', async () => { const { runtime, request } = fixture(); expect(runtime.view().enabled).toBe(false); expect(runtime.models()).toEqual([]); expect(request).not.toHaveBeenCalled() })
  it('requires consent before device flow and reports only display-safe account metadata', async () => {
    const { runtime, request } = fixture(); await expect(runtime.login(false)).rejects.toThrow('consent'); expect(request).not.toHaveBeenCalled()
    const login = await runtime.login(true); expect(login.userCode).toBe('CODE'); expect(runtime.view().busy).toBe(true)
    await runtime.cancel(); expect(request).toHaveBeenCalledWith('account/login/cancel', { loginId: 'login' }); expect(runtime.view().busy).toBe(false)
  })
  it('initializes under its own client name and never sends a turn during refresh', async () => {
    const { runtime, request, peer } = fixture(); await runtime.refresh(); expect(peer.notify).toHaveBeenCalledWith('initialized'); expect(request.mock.calls[0]?.[1]).toMatchObject({ clientInfo: { name: 'deepseek-harness-local', title: 'Y Harness' } }); expect(runtime.view().connected).toBe(true); expect(JSON.stringify(runtime.view())).not.toContain('accessToken'); expect(request.mock.calls.map(x => x[0])).not.toContain('turn/start')
  })
  it('projects turn images as placeholders and offloaded occurrences as text', () => {
    const ref = { attachmentId: 'image-1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
    expect(projectCodexHistory([{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: ref }] } as never]))
      .toEqual([{ role: 'user', text: 'look\n[image attachment]', images: [ref] }])
    expect(projectCodexHistory([{ role: 'user', content: [{ type: 'image', attachment: ref, offloaded: true }] } as never])[0]?.images).toEqual([])
  })
  it('forwards a turn image as an inline native image input', async () => {
    const ref = { attachmentId: 'image-1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
    const readImage = vi.fn(async () => ({ ref, data: new Uint8Array([1, 2, 3]) }))
    const { runtime, request } = fixture(catalog, () => ({ readImage }) as never)
    await runtime.refresh(); await runtime.configure(true)
    for await (const _chunk of runtime.stream({ provider: 'codex-backend', model: 'gpt-6.1-sol',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: ref }] } as never] })) { /* consume */ }
    const turn = request.mock.calls.find(x => x[0] === 'turn/start')?.[1] as { input: unknown[] }
    expect(turn.input).toEqual([{ type: 'text', text: 'look\n[image attachment]', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,AQID' }])
    expect(readImage).toHaveBeenCalledOnce()
  })
  it('refuses an image when no durable attachment service is mounted', async () => {
    const ref = { attachmentId: 'image-1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
    const { runtime } = fixture(); await runtime.refresh(); await runtime.configure(true)
    await expect(runtime.stream({ provider: 'codex-backend', model: 'gpt-6.1-sol',
      messages: [{ role: 'user', content: [{ type: 'image', attachment: ref }] } as never] }).next()).rejects.toThrow('attachment service')
  })
  it('lets an explicit conversation tier override the stored per-model preference', async () => {
    const { runtime, request } = fixture(); await runtime.refresh(); await runtime.configure(true, 'gpt-6.1-sol', 'priority')
    for await (const _chunk of runtime.stream({ provider: 'codex-backend', model: 'gpt-6.1-sol', serviceTier: ServiceTierId('default'),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'p' }] }] })) { /* consume */ }
    expect(request.mock.calls.find(x => x[0] === 'turn/start')?.[1]).toMatchObject({ serviceTier: 'default' })
  })
  it('streams native answer and sends exact Ultra with session policy, no Harness tools', async () => {
    const { runtime, request } = fixture(); await runtime.refresh(); await runtime.configure(true, 'gpt-6.1-sol', 'priority')
    const chunks = []; for await (const chunk of runtime.stream({ provider: 'codex-backend', model: 'gpt-6.1-sol', reasoningEffort: ReasoningEffortId('ultra'), system: 'system', messages: [{ role: 'user', content: [{ type: 'text', text: 'prompt' }] }], tools: [{ name: 'shell', description: 'Harness shell', parameters: {} }] })) chunks.push(chunk)
    const turn = request.mock.calls.find(x => x[0] === 'turn/start')?.[1]
    expect(turn).toMatchObject({ effort: 'ultra', serviceTier: 'fast', approvalPolicy: 'on-request', cwd: '/session/project', sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/session/project', '/tmp'], networkAccess: true } }); expect(turn).not.toHaveProperty('tools'); expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'hello' }); expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })
  it('rejects missing or unadvertised efforts instead of converting Ultra to Max', async () => {
    const { runtime } = fixture(); await runtime.refresh(); await runtime.configure(true); const call = runtime.stream({ provider: 'codex-backend', model: 'gpt-6.1-sol', reasoningEffort: ReasoningEffortId('invented'), messages: [] }); await expect(call.next()).rejects.toThrow('effort')
  })
})

it('publishes a connected account once and then yields to an explicit user choice', async () => {
  const { runtime } = fixture()
  // Nothing is known to be connected before the native read.
  expect((await runtime.publish()).enabled).toBe(false)
  await runtime.refresh()
  expect(runtime.view().connected).toBe(true)
  expect((await runtime.publish()).enabled).toBe(true)
  // Already published: a repeat is a no-op rather than another write.
  expect((await runtime.publish()).enabled).toBe(true)
  await runtime.configure(false)
  expect((await runtime.publish()).enabled).toBe(false)
})

it('never publishes a connected account that advertises no models', async () => {
  const { runtime } = fixture({ data: [] })
  await runtime.refresh()
  expect(runtime.view().connected).toBe(true)
  expect((await runtime.publish()).enabled).toBe(false)
})

it('does not republish after the user disconnects the native profile', async () => {
  const { runtime } = fixture()
  await runtime.refresh()
  expect((await runtime.publish()).enabled).toBe(true)
  await runtime.logout()
  expect(runtime.view().connected).toBe(false)
  expect((await runtime.publish()).enabled).toBe(false)
})

it('interrupts a cancelled native turn and releases the active-operation guard', async () => {
  const { runtime, request } = fixture(); await runtime.refresh(); await runtime.configure(true)
  const started = Promise.withResolvers<undefined>()
  const original = request.getMockImplementation()!
  request.mockImplementation(async (method, params) => {
    if (method === 'turn/start') { started.resolve(undefined); return { turn: { id: 'turn1' } } }
    return original(method, params)
  })
  const controller = new AbortController()
  const stream = runtime.stream({ provider: 'codex-backend', model: 'gpt-6.1-sol', messages: [{ role: 'user', content: [{ type: 'text', text: 'prompt' }] }], signal: controller.signal })
  const next = stream.next(); await started.promise; controller.abort()
  await expect(next).rejects.toThrow(); expect(request).toHaveBeenCalledWith('turn/interrupt', { threadId: 'thread1', turnId: 'turn1' }); expect(runtime.view().running).toBe(0)
})
it('seeds a new native thread after history changes and reuses only a matching replay marker', async () => {
  const { runtime, request } = fixture(); await runtime.refresh(); await runtime.configure(true)
  const user = { role: 'user', content: [{ type: 'text', text: 'one' }] } as const
  const collect = async (messages: unknown[]) => { const chunks = []; for await (const chunk of runtime.stream({ provider: 'codex-backend', model: 'gpt-6.1-sol', sessionId: 'session' as never, messages: messages as never })) chunks.push(chunk); return chunks }
  const chunks = await collect([user]); const finish = chunks.at(-1) as { replayState: unknown }
  const assistant = { role: 'assistant', content: [{ type: 'text', text: 'hello' }], source: { kind: 'model', provider: 'codex-backend', model: 'gpt-6.1-sol', replayState: finish.replayState } }
  await collect([user, assistant, { role: 'user', content: [{ type: 'text', text: 'two' }] }])
  expect(request.mock.calls.filter(x => x[0] === 'thread/start')).toHaveLength(1)
  const inputs = request.mock.calls.filter(x => x[0] === 'turn/start').map(x => (x[1] as { input: { text: string }[] }).input[0]?.text)
  expect(inputs).toEqual(['one', 'two'])
  await collect([{ ...user, content: [{ type: 'text', text: 'edited' }] }, assistant, { role: 'user', content: [{ type: 'text', text: 'branch' }] }])
  expect(request.mock.calls.filter(x => x[0] === 'thread/start')).toHaveLength(2)
})

it('rejects a saved processing tier removed by a refreshed native catalog', async () => {
  const { runtime, request } = fixture()
  await runtime.refresh()
  await runtime.configure(true, 'gpt-6.1-sol', 'priority')
  const original = request.getMockImplementation()!
  request.mockImplementation((method, params) => method === 'model/list'
    ? Promise.resolve({ data: catalog.data.map(model => ({ ...model, serviceTiers: [] })) })
    : original(method, params))
  await runtime.refresh()
  await expect(runtime.stream({ provider: 'codex-backend', model: 'gpt-6.1-sol', messages: [] }).next()).rejects.toThrow('processing tier')
  expect(request.mock.calls.some(([method]) => method === 'thread/start' || method === 'turn/start')).toBe(false)
})
