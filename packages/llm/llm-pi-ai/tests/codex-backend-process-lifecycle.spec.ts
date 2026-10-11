import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startCodexProcess } from '../src/codex-backend-process.ts'
import type { CodexProcessOptions } from '../src/codex-backend-process.ts'

const processBoundary = vi.hoisted(() => ({ spawn: vi.fn<typeof import('node:child_process').spawn>() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: processBoundary.spawn }))
afterEach(() => { processBoundary.spawn.mockReset(); vi.restoreAllMocks(); vi.useRealTimers() })
const options: CodexProcessOptions = { binary: '/fixture/codex.js', nodePath: '/fixture/node', home: '/fixture/original', shellHome: '/fixture/shell', cwd: '/fixture/project' }

function fixture(reply: (method: string) => Record<string, unknown> = () => ({ result: { fixture: true } })) {
  const child = new ChildProcess()
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough()
  child.stdin = stdin; child.stdout = stdout; child.stderr = stderr
  const frames: Array<Record<string, unknown>> = []
  let pending = ''
  stdin.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8')
    for (;;) {
      const end = pending.indexOf('\n'); if (end < 0) return
      const line = pending.slice(0, end); pending = pending.slice(end + 1)
      const frame = JSON.parse(line) as Record<string, unknown>; frames.push(frame)
      if (frame.id !== undefined) queueMicrotask(() => {
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, ...reply(String(frame.method)) }) + '\n')
      })
    }
  })
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true)
  processBoundary.spawn.mockReturnValue(child)
  const peer = startCodexProcess(options, async (method, params) => ({ method, params }))
  return { peer, child, stdout, stderr, stdin, kill, frames,
    exit: () => { Object.defineProperty(child, 'exitCode', { value: 0, configurable: true }); stdout.end(); stderr.end(); child.emit('exit', 0, null) },
  }
}

describe('Codex child process protocol lifetime', () => {
  it.each(['binary', 'nodePath', 'home', 'shellHome', 'cwd'] as const)('rejects relative %s before acquiring a process', (field) => {
    expect(() => startCodexProcess({ ...options, [field]: 'relative' }, async () => ({}))).toThrow(/absolute local Codex paths/)
    expect(processBoundary.spawn).not.toHaveBeenCalled()
  })

  it('uses a cleared environment and private stdio for a fixture-owned peer', async () => {
    const f = fixture()
    try {
      expect(await f.peer.request('initialize', {})).toEqual({ fixture: true })
      expect(processBoundary.spawn.mock.calls[0]?.[0]).toBe(options.nodePath)
      expect(processBoundary.spawn.mock.calls[0]?.[2]).toMatchObject({ cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: {
        PATH: '/fixture:/usr/bin:/bin', HOME: options.shellHome, CODEX_HOME: options.home,
        XDG_CONFIG_HOME: '/fixture/shell/.config', XDG_CACHE_HOME: '/fixture/shell/.cache',
        ZDOTDIR: options.shellHome, TMPDIR: '/fixture/shell/tmp', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      } })
      f.peer.notify('initialized')
      expect(f.frames).toContainEqual({ jsonrpc: '2.0', method: 'initialized' })
    } finally { f.peer.close(); f.exit() }
  })

  it('dispatches native requests and removes notification subscribers before close', async () => {
    const f = fixture()
    const notices: string[] = []
    const remove = f.peer.subscribe((method) => { notices.push(method) })
    f.stdout.write('{"jsonrpc":"2.0","method":"fixture/notice","params":{"value":1}}\n')
    await vi.waitFor(() => { expect(notices).toEqual(['fixture/notice']) })
    f.stdout.write('{"jsonrpc":"2.0","id":"native","method":"fixture/request","params":{"value":1}}\n')
    await vi.waitFor(() => { expect(f.frames).toContainEqual({ jsonrpc: '2.0', id: 'native', result: { method: 'fixture/request', params: { value: 1 } } }) })
    remove(); f.peer.close(); f.exit()
    expect(notices).toEqual(['fixture/notice'])
    expect(f.kill).toHaveBeenCalledOnce()
    f.peer.close()
    await expect(f.peer.request('thread/read', {})).rejects.toThrow(/closed/)
    expect(f.kill).toHaveBeenCalledOnce()
  })

  it('sanitizes native initialization failures and closes that peer', async () => {
    const f = fixture(() => ({ error: { code: -32000, message: 'Private diagnostic', data: { private: true } } }))
    await expect(f.peer.request('initialize', {})).rejects.toThrow('Codex initialize did not complete. Try refreshing the backend.')
    expect(f.kill).toHaveBeenCalledWith('SIGTERM')
    f.exit()
    await expect(f.peer.request('model/list', {})).rejects.toThrow(/closed/)
  })

  it('keeps a peer available after a method-not-found read and exposes no native error data', async () => {
    const f = fixture(method => method === 'skills/list' ? { error: { code: -32601, message: 'Private diagnostic', data: { private: true } } } : { result: {} })
    try {
      await expect(f.peer.request('skills/list', {})).rejects.toMatchObject({ code: -32601, data: undefined })
      expect(f.kill).not.toHaveBeenCalled()
      expect(await f.peer.request('model/list', {})).toEqual({})
    } finally { f.peer.close(); f.exit() }
  })

  it.each(['spawn', 'stdin', 'frame', 'exit'])('notifies close exactly once after %s failure', async (failure) => {
    const f = fixture()
    const notices: string[] = []
    f.peer.subscribe((method) => { notices.push(method) })
    if (failure === 'spawn') f.child.emit('error', new Error('Private fixture spawn diagnostic'))
    else if (failure === 'stdin') f.stdin.emit('error', new Error('Private fixture pipe diagnostic'))
    else if (failure === 'frame') f.stdout.write('x'.repeat(4 * 1024 * 1024 + 1))
    else f.exit()
    await vi.waitFor(() => { expect(notices).toEqual(['__closed']) })
    f.peer.close(); f.exit()
    expect(f.kill).toHaveBeenCalledOnce()
  })

  it('forces termination only when the owned process has not exited by the close deadline', async () => {
    vi.useFakeTimers()
    const f = fixture(); f.peer.close()
    expect(f.kill.mock.calls).toEqual([['SIGTERM']])
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    f.exit()
    const g = fixture(); g.peer.close(); g.exit()
    await vi.advanceTimersByTimeAsync(2000)
    expect(g.kill.mock.calls).toEqual([['SIGTERM']])
  })
})
