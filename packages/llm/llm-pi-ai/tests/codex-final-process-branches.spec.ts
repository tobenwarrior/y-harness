/** Owned child and stream failures exercise release without a native executable. */
import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { startCodexProcess } from '../src/codex-backend-process.ts'
import { openCodexSequentialPeer } from '../src/codex-sequential-process.ts'
import type { CodexSessionSourceConfig } from '../src/coding-session-source.ts'

const processBoundary = vi.hoisted(() => ({ spawn: vi.fn<typeof import('node:child_process').spawn>() }))
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(), spawn: processBoundary.spawn,
}))
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); processBoundary.spawn.mockReset() })
const config: CodexSessionSourceConfig = { id: 'final-process', label: 'Owned process', home: '/fixture/native',
  cwd: '/fixture/project', shellHome: '/fixture/shell', nodePath: '/fixture/node', binary: '/fixture/codex.js',
  packageManifest: '/fixture/package.json', binarySha256: '0'.repeat(64), version: '0.160.0', graceMs: 100 }
const read = () => ({ signal: new AbortController().signal, limit: 10, maxEvents: 10, maxBytes: 4096 })

async function sequential() {
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough()
  const completion = Promise.withResolvers<Awaited<SubprocessHandle['done']>>()
  stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').trim().split('\n')) {
      if (!line) continue
      const frame: unknown = JSON.parse(line)
      if (frame === null || typeof frame !== 'object') throw new Error('Owned frame must be an object')
      const id: unknown = Reflect.get(frame, 'id'); const method: unknown = Reflect.get(frame, 'method')
      if (id === undefined) continue
      const params: unknown = Reflect.get(frame, 'params')
      const info: unknown = params !== null && typeof params === 'object' ? Reflect.get(params, 'clientInfo') : undefined
      const name: unknown = info !== null && typeof info === 'object' ? Reflect.get(info, 'name') : undefined
      const result = method === 'initialize' ? { codexHome: config.home, userAgent: `${String(name)}/${config.version} (fixture)` }
        : { status: 'disabled' }
      queueMicrotask(() => { stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n') })
    }
  })
  const finish = (): void => {
    stdin.end(); stdout.end(); stderr.end(); completion.resolve({ exitCode: 0, signal: null })
  }
  stdin.on('finish', () => { stdout.end(); stderr.end(); completion.resolve({ exitCode: 0, signal: null }) })
  const terminate = vi.fn(finish)
  const spawn = vi.fn((_spec: SubprocessSpawnSpec): SubprocessHandle => ({ stdin, stdout, stderr,
    control: undefined, collected: {}, done: completion.promise, terminate, waitForExit: async () => true }))
  const peer = await openCodexSequentialPeer(config, read(), {}, spawn)
  onTestFinished(async () => { await Promise.allSettled([peer.dispose()]); stdin.destroy(); stdout.destroy(); stderr.destroy() })
  return { stdin, peer, terminate }
}

describe('Codex owned process release exceptions', () => {
  it('does not force-kill a child whose natural exit already invoked close', async () => {
    vi.useFakeTimers()
    const child = new ChildProcess()
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    const kill = vi.spyOn(child, 'kill').mockReturnValue(true)
    processBoundary.spawn.mockReturnValue(child)
    const peer = startCodexProcess(config, async () => ({}))
    Object.defineProperty(child, 'exitCode', { value: 0, configurable: true })
    child.emit('exit', 0, null)
    await vi.advanceTimersByTimeAsync(2000)
    expect(kill.mock.calls).toEqual([['SIGTERM']])
    await expect(peer.request('model/list', {})).rejects.toThrow('closed')
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
  })

  it('withholds a clean release after a native output flush callback fails', async () => {
    const f = await sequential()
    const write = f.stdin._write.bind(f.stdin)
    vi.spyOn(f.stdin, '_write').mockImplementation((chunk: Buffer, encoding, callback) => {
      if (chunk.byteLength === 0) callback(new Error('Owned flush callback failure'))
      else write(chunk, encoding, callback)
    })
    await expect(f.peer.close(read())).rejects.toThrow('release could not establish')
    expect(f.peer.observedFailure()).toBe(true)
    expect(f.terminate).toHaveBeenCalledOnce()
  })

  it('drains the owned range when ending private stdin throws', async () => {
    const f = await sequential()
    vi.spyOn(f.stdin, 'end').mockImplementationOnce(() => { throw new Error('Owned stdin end failure') })
    await expect(f.peer.close(read())).rejects.toThrow('release could not establish')
    expect(f.peer.observedFailure()).toBe(true)
    expect(f.terminate).toHaveBeenCalledOnce()
  })
})
