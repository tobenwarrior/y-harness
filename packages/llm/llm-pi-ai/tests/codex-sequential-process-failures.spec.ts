/** Synthetic managed-process boundaries; no child, original profile or model is opened. */
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { CodingSessionReadRequest } from '@deepseek-ai/dsh-coding-session/types'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { CodexSessionSourceConfig } from '../src/coding-session-source.ts'
import { CodexSequentialProcessReleaseError, openCodexSequentialPeer } from '../src/codex-sequential-process.ts'

const config: CodexSessionSourceConfig = { id: 'bounded-fixture', label: 'Bounded fixture', home: '/fixture/native', cwd: '/fixture/project',
  shellHome: '/fixture/shell', nodePath: '/fixture/node', binary: '/fixture/codex.js', packageManifest: '/fixture/package.json',
  binarySha256: '0'.repeat(64), version: '0.160.0', graceMs: 1000 }
const read = (): CodingSessionReadRequest => ({ signal: new AbortController().signal, limit: 10, maxEvents: 10, maxBytes: 4096 })
afterEach(() => { vi.useRealTimers() })

function fixture(options: {
  streams?: boolean
  range?: boolean | Error
  outcome?: { exitCode: number | null; signal: NodeJS.Signals | null } | Error
  initialization?: 'home' | 'version'
} = {}) {
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough()
  const completion = Promise.withResolvers<Awaited<SubprocessHandle['done']>>()
  const frames: Array<Record<string, unknown>> = []
  let pending = ''
  const finish = (): void => {
    if (options.outcome instanceof Error) completion.reject(options.outcome)
    else completion.resolve(options.outcome ?? { exitCode: 0, signal: null })
  }
  stdin.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8')
    for (;;) {
      const end = pending.indexOf('\n'); if (end < 0) return
      const line = pending.slice(0, end); pending = pending.slice(end + 1)
      const frame = JSON.parse(line) as Record<string, unknown>; frames.push(frame)
      if (frame.method === undefined || frame.id === undefined) continue
      queueMicrotask(() => {
        if (stdout.destroyed) return
        const name = frame.method === 'initialize' ? Reflect.get(frame.params as object, 'clientInfo') as { name: string } : undefined
        const result = frame.method === 'initialize'
          ? { codexHome: options.initialization === 'home' ? '/fixture/other-home' : config.home,
            userAgent: `${name?.name}/${options.initialization === 'version' ? '9.0.0' : config.version} (fixture)` }
          : frame.method === 'remoteControl/status/read' ? { status: 'disabled' } : { fixture: true }
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\n')
      })
    }
  })
  stdin.on('finish', () => { finish(); stdout.end(); stderr.end() })
  const terminate = vi.fn(() => { finish(); stdin.end(); stdout.destroy(); stderr.destroy() })
  const waitForExit = vi.fn(async () => {
    if (options.range instanceof Error) throw options.range
    return options.range ?? true
  })
  const child: SubprocessHandle = { stdin: options.streams === false ? undefined : stdin, stdout, stderr,
    control: undefined, collected: {}, done: completion.promise, terminate, waitForExit }
  const spawn = vi.fn((_spec: SubprocessSpawnSpec) => child)
  onTestFinished(async () => { stdin.end(); stdout.destroy(); stderr.destroy(); finish(); await Promise.allSettled([completion.promise]) })
  return { spawn, terminate, waitForExit, stdin, stdout, stderr, frames, completion,
    open: async (request = read()) => {
      const peer = await openCodexSequentialPeer(config, request, {}, spawn)
      onTestFinished(async () => { await Promise.allSettled([peer.dispose()]) })
      return peer
    },
    notification: (method: string, params: object = {}) => {
      stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    },
    callback: (id: string) => {
      stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'fixture/callback', params: { fixture: true } }) + '\n')
    },
  }
}

describe('Codex bounded managed-process failure and release paths', () => {
  it('refuses cancelled acquisition before it spawns any process', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort(new Error('Fixture cancelled'))
    await expect(f.open({ ...read(), signal: controller.signal })).rejects.toThrow('Fixture cancelled')
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it.each(['home', 'version'] as const)('refuses mismatched initialized %s and waits for owned cleanup', async (initialization) => {
    const f = fixture({ initialization })
    await expect(f.open()).rejects.toThrow(/home or pinned version/)
    expect(f.terminate).toHaveBeenCalledOnce(); expect(f.waitForExit).toHaveBeenCalledOnce()
  })

  it('refuses a missing private stream only after its owned range settles', async () => {
    const f = fixture({ streams: false })
    await expect(f.open()).rejects.toThrow(/private streams/)
    expect(f.terminate).toHaveBeenCalledOnce(); expect(f.waitForExit).toHaveBeenCalledOnce()
  })

  it('reports the stronger quiescence failure when a missing-stream process range cannot drain', async () => {
    const f = fixture({ streams: false, range: false })
    await expect(f.open()).rejects.toBeInstanceOf(CodexSequentialProcessReleaseError)
    expect(f.waitForExit).toHaveBeenCalledOnce()
  })

  it.each(['[1]\n', 'null\n', '{broken}\n', 'x'.repeat(4097), 'x'.repeat(4097) + '\n'])('closes a peer after an invalid or over-budget frame', async (frame) => {
    const f = fixture(); const peer = await f.open(); const notices: string[] = []
    peer.subscribe((method) => { notices.push(method) })
    f.stdout.write(frame)
    await vi.waitFor(() => { expect(peer.connected()).toBe(false) })
    await peer.dispose()
    expect(peer.observedFailure()).toBe(true); expect(f.terminate).toHaveBeenCalledOnce()
    expect(notices).toEqual(['__closed'])
  })

  it('withholds a receipt when EOF leaves a partial frame', async () => {
    const f = fixture(); const peer = await f.open(); f.stdout.write('{"jsonrpc":')
    await expect(peer.close(read())).rejects.toThrow(/release/)
    await peer.dispose(); expect(peer.observedFailure()).toBe(true)
  })

  it('ignores complete blank protocol lines and preserves the next bounded response', async () => {
    const f = fixture(); const peer = await f.open(); f.stdout.write(' \n\t\n')
    expect(await peer.request('fixture/after-whitespace', {}, read().signal)).toEqual({ fixture: true })
    await peer.close(read()); expect(peer.observedFailure()).toBe(false)
  })

  it('rejects an oversized outgoing request without returning a release receipt', async () => {
    const f = fixture(); const peer = await f.open()
    await expect(peer.request('fixture/large', { text: 'x'.repeat(4097) }, read().signal)).rejects.toThrow(/did not complete/)
    await peer.dispose(); expect(peer.observedFailure()).toBe(true)
    expect(f.frames.some(frame => frame.method === 'fixture/large')).toBe(false)
  })

  it('bounds diagnostics even when their text contains no failure keyword', async () => {
    const f = fixture(); const peer = await f.open(); f.stderr.write('x'.repeat(4097))
    await peer.dispose(); expect(peer.observedFailure()).toBe(true); expect(f.terminate).toHaveBeenCalledOnce()
  })

  it('contains a remote-control activation and does not forward that unsafe change', async () => {
    const f = fixture(); const peer = await f.open(); const notices: string[] = []
    peer.subscribe((method) => { notices.push(method) })
    f.notification('remoteControl/status/changed', { status: 'connected' })
    await peer.dispose(); expect(notices).toEqual(['__closed']); expect(peer.observedFailure()).toBe(true)
  })

  it('allows a disabled remote-control notice, then marks a native error notice as failed', async () => {
    const f = fixture(); const peer = await f.open(); const notices: string[] = []
    const remove = peer.subscribe((method) => { notices.push(method) })
    f.notification('remoteControl/status/changed', { status: 'disabled' }); f.notification('error')
    expect(notices).toEqual(['remoteControl/status/changed', 'error']); remove()
    await expect(peer.close(read())).rejects.toThrow(/release/)
    expect(peer.observedFailure()).toBe(true)
  })

  it('declines native callbacks until an admitted handler is installed', async () => {
    const f = fixture(); const peer = await f.open(); f.callback('before-admission')
    await vi.waitFor(() => {
      expect(f.frames.find(frame => frame.id === 'before-admission')?.error).toBeDefined()
    })
    peer.onRequest(async (method, params) => ({ method, params })); f.callback('admitted')
    await vi.waitFor(() => {
      expect(f.frames).toContainEqual({ jsonrpc: '2.0', id: 'admitted', result: { method: 'fixture/callback', params: { fixture: true } } })
    })
    await peer.close(read()); expect(peer.observedFailure()).toBe(false)
  })

  it('waits for an admitted callback before flushing and closing its private stdin', async () => {
    const f = fixture(); const peer = await f.open(); const response = Promise.withResolvers<object>()
    peer.onRequest(() => response.promise); f.callback('held')
    let settled = false; const closing = peer.close(read()).then(() => { settled = true })
    await Promise.resolve(); expect(f.stdin.writableEnded).toBe(false); expect(settled).toBe(false)
    f.callback('during-release')
    await vi.waitFor(() => {
      expect(f.frames.find(frame => frame.id === 'during-release')?.error).toBeDefined()
    })
    response.resolve({ admitted: true }); await closing
    expect(f.frames).toContainEqual({ jsonrpc: '2.0', id: 'held', result: { admitted: true } })
    await expect(peer.request('fixture/closed', {}, read().signal)).rejects.toThrow(/unavailable/)
  })

  it('forces cleanup when outstanding callbacks exceed the bounded admission count', async () => {
    const f = fixture(); const peer = await f.open({ ...read(), maxEvents: 1 }); const response = Promise.withResolvers<object>()
    peer.onRequest(() => response.promise); f.callback('first'); f.callback('second')
    await vi.waitFor(() => { expect(f.terminate).toHaveBeenCalledOnce() })
    response.resolve({ admitted: true }); await peer.dispose(); expect(peer.observedFailure()).toBe(true)
  })

  it('forces a bounded release after its background deadline while awaiting admitted callback settlement', async () => {
    vi.useFakeTimers()
    const f = fixture(); const peer = await f.open(); const response = Promise.withResolvers<object>()
    peer.onRequest(() => response.promise); f.callback('held-past-deadline')
    const closing = peer.close(read()); const rejected = expect(closing).rejects.toThrow(/release/)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.terminate).toHaveBeenCalledOnce()
    response.resolve({ admitted: true }); await rejected; await peer.dispose()
    expect(peer.observedFailure()).toBe(true)
  })

  it.each([
    { exitCode: 2, signal: null }, { exitCode: null, signal: 'SIGTERM' as const },
  ])('rejects non-normal managed process completion: %j', async (outcome) => {
    const f = fixture({ outcome }); const peer = await f.open()
    await expect(peer.close(read())).rejects.toThrow(/release/); await peer.dispose()
    expect(f.waitForExit).toHaveBeenCalledOnce()
  })

  it.each([false, new Error('Fixture range owner unavailable')])('never treats an unconfirmed managed range as disposed quiescence', async (range) => {
    const f = fixture({ range }); const peer = await f.open()
    await expect(peer.close(read())).rejects.toThrow(/release/)
    await expect(peer.dispose()).rejects.toBeInstanceOf(CodexSequentialProcessReleaseError)
  })

  it('reports failed process settlement without a receipt', async () => {
    const f = fixture({ outcome: new Error('Fixture process owner failed') }); const peer = await f.open()
    await expect(peer.close(read())).rejects.toThrow(/release/)
    await expect(peer.dispose()).rejects.toBeInstanceOf(CodexSequentialProcessReleaseError)
    expect(peer.observedFailure()).toBe(true)
  })

  it('marks an unexpected owned-process exit as unavailable', async () => {
    const f = fixture(); const peer = await f.open()
    f.completion.resolve({ exitCode: 0, signal: null })
    await vi.waitFor(() => { expect(peer.connected()).toBe(false) })
    await peer.dispose(); expect(f.terminate).toHaveBeenCalledOnce(); expect(peer.observedFailure()).toBe(true)
  })

  it('cancels an individual request before sending it and keeps the owned peer usable', async () => {
    const f = fixture(); const peer = await f.open(); const controller = new AbortController()
    controller.abort(new Error('Fixture request cancelled'))
    await expect(peer.request('fixture/cancelled', {}, controller.signal)).rejects.toThrow('Fixture request cancelled')
    expect(f.frames.some(frame => frame.method === 'fixture/cancelled')).toBe(false)
    expect(await peer.request('fixture/usable', {}, read().signal)).toEqual({ fixture: true })
    await peer.close(read())
  })
})
