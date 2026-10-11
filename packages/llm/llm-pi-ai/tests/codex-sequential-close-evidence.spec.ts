/** Close-only typed native producers; generated profiles, no native process or turn request. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CodingSessionOwnerToken, CodingSessionReadRequest, CodingSessionSource } from '@deepseek-ai/dsh-coding-session/types'
import { createCodexSequentialOwner } from '../src/codex-sequential.ts'
import type { CodexSequentialAccess } from '../src/codex-sequential.ts'
import { CodexSequentialProcessReleaseError } from '../src/codex-sequential-process.ts'
import type { CodexSequentialPeer, CodexSequentialPeerFactory } from '../src/codex-sequential-process.ts'
import type { CodexSessionSourceConfig } from '../src/coding-session-source.ts'
import { restrictedConfig } from '../src/codex-sequential-guards.ts'

const read = (): CodingSessionReadRequest => ({ signal: new AbortController().signal,
  limit: 10, maxEvents: 100, maxBytes: 128 * 1024 })

async function fixture(mode: 'late-failure' | 'unknown-range') {
  const directory = await mkdtemp(join(tmpdir(), 'codex-close-only-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  const home = join(directory, 'native'); const cwd = join(directory, 'project')
  await Promise.all([mkdir(home), mkdir(cwd)])
  const binary = join(directory, 'wrapper.js'); const bytes = Buffer.from('Owned fixture wrapper; never executed.')
  await writeFile(binary, bytes)
  const config: CodexSessionSourceConfig = { id: 'close-fixture', label: 'Close fixture', home, cwd,
    binary, packageManifest: join(directory, 'package.json'), nodePath: process.execPath,
    shellHome: join(directory, 'shell'), binarySha256: createHash('sha256').update(bytes).digest('hex'),
    version: '0.160.0', graceMs: 100, knownNoManagedFeatureOverrides: true }
  const profileId = brandString<CodingSessionSource['profileId']>('close-fixture')
  const source: CodingSessionSource = { provider: 'codex', profileId,
    nativeSessionId: brandString<CodingSessionSource['nativeSessionId']>('owned-history') }
  const access: CodexSequentialAccess = { authority: {}, cwd, sandbox: 'workspace-write', writableRoots: [cwd],
    approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: true,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true }, request: async () => ({ decision: 'decline' }) }
  const unknownRange = new CodexSequentialProcessReleaseError('Owned writer range was not confirmed')
  const active = new Set<number>(); const listeners = new Map<number, Set<(method: string, params: Record<string, unknown>) => void>>()
  const calls: string[] = []; const disposals: number[] = []; let opened = 0
  const factory = vi.fn<CodexSequentialPeerFactory>(async (_selected, _request, servers) => {
    const number = ++opened; let connected = true; let observedFailure = false
    const callbacks = new Set<(method: string, params: Record<string, unknown>) => void>()
    active.add(number); listeners.set(number, callbacks)
    const thread = (idle: boolean) => ({ id: source.nativeSessionId, name: 'Owned fixture', preview: 'Owned fixture',
      cwd, updatedAt: 100, historyMode: 'legacy', status: { type: idle ? 'idle' : 'notLoaded' },
      turns: [{ id: 'prior', status: 'completed', itemsView: 'full',
        items: [{ id: 'answer', type: 'agentMessage', text: 'Owned saved fixture' }] }] })
    const peer: CodexSequentialPeer = {
      connected: () => connected, observedFailure: () => observedFailure, onRequest() {},
      subscribe: (callback) => { callbacks.add(callback); return () => { callbacks.delete(callback) } },
      request: async (method, _params, signal) => {
        signal.throwIfAborted(); calls.push(method)
        if (method === 'configRequirements/read') return { requirements: { featureRequirements: null } }
        if (method === 'config/read') return { config: restrictedConfig({}, servers) }
        if (method === 'thread/read') return { thread: thread(number === 2) }
        if (method === 'mcpServerStatus/list') return { data: [] }
        if (method === 'thread/resume') return { thread: thread(true), cwd, approvalPolicy: access.approvalPolicy,
          approvalsReviewer: 'user', sandbox: access.sandboxPolicy }
        throw new Error(`No native turn or other method is admitted: ${method}`)
      },
      close: async () => {
        if (number === 2 && mode === 'unknown-range') throw unknownRange
        connected = false; active.delete(number)
        if (number === 2) {
          observedFailure = true
          for (const callback of callbacks) callback('error', { threadId: source.nativeSessionId })
        }
      },
      dispose: async () => {
        disposals.push(number)
        if (number === 2 && mode === 'unknown-range' && disposals.filter(value => value === 2).length === 1) {
          throw new Error('Owned disposal could not confirm the same range')
        }
        connected = false; active.delete(number)
      },
    }
    return peer
  })
  // The source verifier checks only this generated fixture wrapper; no original profile is selected.
  const owner = createCodexSequentialOwner(config, 'close-fixture', profileId, () => access, factory, async () => {
    expect(createHash('sha256').update(await readFile(binary)).digest('hex')).toBe(config.binarySha256)
  })
  onTestFinished(async () => {
    const failures: unknown[] = []
    try { await owner.close() }
    catch (error) {
      if (mode === 'unknown-range' && error === unknownRange) {
        // The body may have retained this exact release failure after its owner drained.
      } else if (mode === 'unknown-range' && error instanceof Error
        && error.message === 'Owned disposal could not confirm the same range'
        && active.has(2) && disposals.filter(value => value === 2).length === 1) {
        // An early body assertion can make cleanup consume the fixture's one owned disposal failure.
        try { await owner.close() }
        catch (retryError) { if (retryError !== unknownRange) failures.push(error, retryError) }
      } else failures.push(error)
    }
    try { expect(active.size).toBe(0) } catch (error) { failures.push(error) }
    try { expect([...listeners.values()].every(callbacks => callbacks.size === 0)).toBe(true) }
    catch (error) { failures.push(error) }
    if (failures.length > 0) throw new AggregateError(failures, 'Owned close fixture cleanup did not drain.')
  })
  const acquire = () => owner.writer.acquire(source, { ...read(), nativeProfileUnchanged: true,
    ownerToken: brandString<CodingSessionOwnerToken>('owned-close-test') })
  return { owner, acquire, factory, calls, disposals, active, listeners, unknownRange }
}

describe('Codex close-only retained producer uncertainty', () => {
  it('refuses clean release after normal close observes a late native error', async () => {
    const f = await fixture('late-failure'); const lease = await f.acquire()
    await expect(lease.release(read())).rejects.toThrow('normal closure observed a native failure')
    expect(f.factory).toHaveBeenCalledTimes(2)
    expect(f.disposals).toEqual([2])
    await expect(lease.read(read())).rejects.toThrow('not available for a retained-history read')
    await expect(f.acquire()).rejects.toThrow('unresolved sequential owner')
    await f.owner.close()
    expect(f.active.size).toBe(0)
    expect([...f.listeners.values()].every(callbacks => callbacks.size === 0)).toBe(true)
    expect(f.calls).not.toContain('turn/start')
  })

  it('retains an unconfirmed close error when force disposal also fails, then drains its owner', async () => {
    const f = await fixture('unknown-range'); const lease = await f.acquire()
    await expect(lease.release(read())).rejects.toBe(f.unknownRange)
    expect(f.active).toEqual(new Set([2]))
    expect(f.disposals).toEqual([2])
    await expect(lease.release(read())).rejects.toBe(f.unknownRange)
    await expect(f.acquire()).rejects.toBe(f.unknownRange)
    expect(f.factory).toHaveBeenCalledTimes(2)
    await expect(f.owner.close()).rejects.toBe(f.unknownRange)
    expect(f.disposals).toEqual([2, 2])
    expect(f.active.size).toBe(0)
    expect([...f.listeners.values()].every(callbacks => callbacks.size === 0)).toBe(true)
    expect(f.calls).not.toContain('turn/start')
  })
})
