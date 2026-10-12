/** Read-only native history facade over a synthetic managed child and explicit fixture paths. */
import { PassThrough } from 'node:stream'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { CodexSessionSourceConfig } from '../src/coding-session-source.ts'
import { CodexSessionSourceReleaseError, openCodexSessionReadPeer } from '../src/codex-session-source-process.ts'

const config: CodexSessionSourceConfig = { id: 'read-fixture', label: 'Read fixture', home: '/fixture/native', cwd: '/fixture/project',
  shellHome: '/fixture/shell', nodePath: '/fixture/node', binary: '/fixture/codex.js', packageManifest: '/fixture/package.json',
  binarySha256: '0'.repeat(64), version: '0.160.0', graceMs: 1000 }
const read = () => ({ signal: new AbortController().signal, limit: 10, maxEvents: 10, maxBytes: 4096 })

function fixture(options: { missingStreams?: boolean; processFailure?: boolean; range?: boolean | Error } = {}) {
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough()
  const completion = Promise.withResolvers<Awaited<SubprocessHandle['done']>>()
  let pending = ''
  stdin.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8')
    for (;;) {
      const end = pending.indexOf('\n'); if (end < 0) return
      const frame = JSON.parse(pending.slice(0, end)) as Record<string, unknown>; pending = pending.slice(end + 1)
      if (frame.id === undefined) continue
      queueMicrotask(() => {
        if (!stdout.destroyed) stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: frame.method === 'initialize'
          ? { codexHome: config.home, userAgent: `y-coding-session-reader/${config.version} (fixture)` } : { thread: {} } }) + '\n')
      })
    }
  })
  const terminate = vi.fn(() => {
    if (options.processFailure === true) completion.reject(new Error('Private fixture process failure'))
    else completion.resolve({ exitCode: 0, signal: null })
    stdin.end(); stdout.destroy(); stderr.destroy()
  })
  const waitForExit = vi.fn(async () => {
    if (options.range instanceof Error) throw options.range
    return options.range ?? true
  })
  const child: SubprocessHandle = { stdin: options.missingStreams === true ? undefined : stdin, stdout, stderr,
    control: undefined, collected: {}, done: completion.promise, terminate, waitForExit }
  const spawn = vi.fn((_spec: SubprocessSpawnSpec) => child)
  onTestFinished(async () => { terminate(); await Promise.allSettled([completion.promise]) })
  return { spawn, terminate, waitForExit,
    open: async () => {
      const peer = await openCodexSessionReadPeer(config, read(), spawn)
      onTestFinished(async () => { await Promise.allSettled([peer.close()]) })
      return peer
    } }
}

describe('Codex history-only process release failures', () => {
  it('rejects absent private streams after waiting for managed process cleanup', async () => {
    const f = fixture({ missingStreams: true })
    await expect(f.open()).rejects.toThrow(/private protocol streams/)
    expect(f.terminate).toHaveBeenCalledOnce(); expect(f.waitForExit).toHaveBeenCalledOnce()
  })

  it.each([false, new Error('Private fixture range failure')])('surfaces unconfirmed range ownership during startup cleanup', async (range) => {
    const f = fixture({ missingStreams: true, range })
    await expect(f.open()).rejects.toBeInstanceOf(CodexSessionSourceReleaseError)
    expect(f.waitForExit).toHaveBeenCalledOnce()
  })

  it('reports failed owned process settlement, awaits its range, and invalidates history access', async () => {
    const f = fixture({ processFailure: true }); const peer = await f.open()
    await expect(peer.close()).rejects.toThrow('Original Codex source process did not complete.')
    expect(f.waitForExit).toHaveBeenCalledOnce(); expect(peer.reader.connected()).toBe(false)
    await expect(peer.reader.request('thread/read', { threadId: 'fixture-original' })).rejects.toThrow(/closed|did not complete/)
  })

  it('keeps the stronger range ownership failure when process settlement also fails', async () => {
    const f = fixture({ processFailure: true, range: false }); const peer = await f.open()
    await expect(peer.close()).rejects.toBeInstanceOf(CodexSessionSourceReleaseError)
    expect(f.waitForExit).toHaveBeenCalledOnce(); expect(peer.reader.connected()).toBe(false)
  })

  it('refuses pre-cancelled read acquisition without a native process', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort(new Error('Fixture cancelled'))
    await expect(openCodexSessionReadPeer(config, { ...read(), signal: controller.signal }, f.spawn)).rejects.toThrow('Fixture cancelled')
    expect(f.spawn).not.toHaveBeenCalled()
  })
})
