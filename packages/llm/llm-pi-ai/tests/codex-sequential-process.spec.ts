/** Owned-process fixture tests distinguish command exit, stream EOF and managed-range quiescence. */
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { CodexSessionSourceConfig } from '../src/coding-session-source.ts'
import { openCodexSequentialPeer } from '../src/codex-sequential-process.ts'

const config: CodexSessionSourceConfig = { id: 'fixture', label: 'Fixture', home: '/fixture/original', cwd: '/fixture/project', shellHome: '/fixture/shell',
  nodePath: '/fixture/node', binary: '/fixture/codex.js', packageManifest: '/fixture/package.json', binarySha256: '0'.repeat(64), version: '0.160.0', graceMs: 1000 }
const read = () => ({ signal: new AbortController().signal, limit: 10, maxEvents: 20, maxBytes: 10000 })
function fixture(status = 'disabled') {
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough()
  let finish!: (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
  const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => { finish = resolve })
  let releaseRange!: (value: boolean) => void
  const range = new Promise<boolean>((resolve) => { releaseRange = resolve })
  let input = ''
  const names: string[] = []; const frames: Array<Record<string, unknown>> = []
  stdin.on('data', (bytes: Buffer) => {
    input += bytes.toString('utf8')
    for (;;) {
      const end = input.indexOf('\n'); if (end < 0) break
      const line = input.slice(0, end); input = input.slice(end + 1)
      if (line.length === 0) continue
      const frame = JSON.parse(line) as { method?: string; id?: string; params?: { clientInfo: { name: string } } }; frames.push(frame)
      if (frame.method === 'initialize') {
        const name = frame.params!.clientInfo.name; names.push(name)
        queueMicrotask(() => {
          stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { codexHome: config.home, userAgent: `${name}/0.160.0 (fixture)` } }) + '\n')
        })
      }
      if (frame.method === 'remoteControl/status/read') queueMicrotask(() => {
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { status, serverName: 'Fixture', installationId: 'fixture-installation', environmentId: null } }) + '\n')
      })
    }
  })
  const terminated = vi.fn(() => { finish({ exitCode: null, signal: 'SIGTERM' }); stdout.destroy(); stderr.destroy(); stdin.end() })
  stdin.on('finish', () => { finish({ exitCode: 0, signal: null }) })
  const child: SubprocessHandle = { stdin, stdout, stderr, control: undefined, collected: {}, done, terminate: terminated,
    waitForExit: () => range }
  const spawn = vi.fn((_spec: SubprocessSpawnSpec) => child)
  return { spawn, terminated, stderr, names, frames, endStreams: () => { stdout.end(); stderr.end() }, releaseRange }
}
describe('Codex cold owned process release evidence', () => {
  it('waits for stdout/stderr EOF and the managed range after command exit', async () => {
    const f = fixture(); const peer = await openCodexSequentialPeer(config, read(), { 'literal.name': { enabled: false } }, f.spawn)
    const spec = f.spawn.mock.calls[0]?.[0]
    expect(spec?.argv).toContain('mcp_servers={"literal.name"={enabled=false}}')
    expect(spec?.argv).toContain('features.code_mode_host=false'); expect(spec?.argv).toContain('agents.enabled=false')
    expect(spec?.env).toMatchObject({ CODEX_HOME: config.home, HOME: config.shellHome })
    let settled = false
    const closing = peer.close(read()).then(() => { settled = true })
    await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false)
    f.endStreams(); await Promise.resolve(); expect(settled).toBe(false)
    f.releaseRange(true); await closing
    expect(f.terminated).not.toHaveBeenCalled(); expect(peer.observedFailure()).toBe(false)
  })
  it('cancellation still waits for actual managed-range settlement and rejects a receipt', async () => {
    const f = fixture(); const peer = await openCodexSequentialPeer(config, read(), {}, f.spawn)
    const controller = new AbortController(); controller.abort(new Error('Fixture cancelled release'))
    let settled = false
    const closing = peer.close({ ...read(), signal: controller.signal }).then(
      () => { settled = true }, (error: unknown) => { settled = true; throw error },
    )
    const rejected = expect(closing).rejects.toThrow(/release/)
    await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false)
    expect(f.terminated).toHaveBeenCalledTimes(1)
    f.releaseRange(true); await rejected
    await peer.dispose(); expect(peer.observedFailure()).toBe(true)
  })
  it('observed persistence diagnostics reject release even with normal exit, EOF and an empty managed range', async () => {
    const f = fixture(); const peer = await openCodexSequentialPeer(config, read(), {}, f.spawn)
    f.stderr.write('fixture persistence failed\n')
    const closing = expect(peer.close(read())).rejects.toThrow(/release/)
    f.endStreams(); f.releaseRange(true); await closing
    await peer.dispose(); expect(peer.observedFailure()).toBe(true)
  })
  it('uses a fresh public initialization name for each private process and omits native unit params', async () => {
    const names: string[] = []
    for (let index = 0; index < 3; index++) {
      const f = fixture(); const peer = await openCodexSequentialPeer(config, read(), {}, f.spawn)
      names.push(...f.names)
      expect(f.frames.find(frame => frame.method === 'remoteControl/status/read')).not.toHaveProperty('params')
      const closing = peer.close(read()); f.endStreams(); f.releaseRange(true); await closing
    }
    expect(new Set(names).size).toBe(3)
    expect(names.every(name => /^y-coding-session-sequential-[0-9a-f-]{36}$/u.test(name))).toBe(true)
  })
  it('refuses non-disabled remote status before exposing any thread-capable peer', async () => {
    const f = fixture('connected'); f.releaseRange(true)
    await expect(openCodexSequentialPeer(config, read(), {}, f.spawn)).rejects.toThrow(/disabled remote control/)
    expect(f.frames.some(frame => String(frame.method).startsWith('thread/'))).toBe(false)
    expect(f.terminated).toHaveBeenCalledTimes(1)
  })
})
