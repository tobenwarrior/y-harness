/** A release admitted before dispatch fences the turn and contains one uncertain disposal. */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CodingSessionOwnerToken, CodingSessionReadRequest, CodingSessionSource } from '@deepseek-ai/dsh-coding-session/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createCodexSequentialOwner } from '../src/codex-sequential.ts'
import type { CodexSequentialAccess } from '../src/codex-sequential.ts'
import type { CodexSequentialPeerFactory } from '../src/codex-sequential-process.ts'
import type { CodexSessionSourceConfig } from '../src/coding-session-source.ts'
import { restrictedConfig } from '../src/codex-sequential-guards.ts'

const read = (): CodingSessionReadRequest => ({ signal: new AbortController().signal,
  limit: 10, maxEvents: 20, maxBytes: 64 * 1024 })

it('does not dispatch after concurrent release and retains disposal failure until the owner drains', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-final-release-race-'))
  const home = join(directory, 'native'); const cwd = join(directory, 'project')
  await Promise.all([mkdir(home), mkdir(cwd)])
  const config: CodexSessionSourceConfig = { id: 'release-race', label: 'Owned release race', home, cwd,
    shellHome: join(directory, 'shell'), nodePath: process.execPath, binary: join(directory, 'never-executed.js'),
    packageManifest: join(directory, 'package.json'), binarySha256: '0'.repeat(64), version: '0.160.0', graceMs: 100,
    knownNoManagedFeatureOverrides: true }
  const source: CodingSessionSource = { provider: 'codex', profileId: brandString<CodingSessionSource['profileId']>('owned-profile'),
    nativeSessionId: brandString<CodingSessionSource['nativeSessionId']>('owned-history') }
  const access: CodexSequentialAccess = { authority: {}, cwd, sandbox: 'read-only', writableRoots: [],
    approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: true }, request: async () => ({ decision: 'decline' }) }
  const calls: string[] = []; const active = new Set<number>(); let opened = 0; let disposalAttempts = 0
  const factory = vi.fn<CodexSequentialPeerFactory>(async (_selected, _request, servers) => {
    const number = ++opened; let resumed = false; active.add(number)
    const thread = () => ({ id: source.nativeSessionId, preview: 'Owned history', cwd, updatedAt: 1,
      status: { type: resumed ? 'idle' : 'notLoaded' }, turns: [] })
    return { connected: () => active.has(number), observedFailure: () => false, onRequest() {}, subscribe: () => () => {},
      request: async (method, _params, signal) => {
        signal.throwIfAborted(); calls.push(method)
        if (method === 'configRequirements/read') return { requirements: null }
        if (method === 'config/read') return { config: restrictedConfig({}, servers) }
        if (method === 'thread/read') return { thread: thread() }
        if (method === 'mcpServerStatus/list') return { data: [] }
        if (method === 'thread/resume') { resumed = true; return { thread: thread(), cwd,
          approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: access.sandboxPolicy } }
        throw new Error(`No native dispatch is allowed in this fixture: ${method}`)
      },
      close: async () => { active.delete(number) },
      dispose: async () => {
        if (number === 2 && ++disposalAttempts === 1) throw new Error('Owned range was not yet confirmed')
        active.delete(number)
      },
    }
  })
  const owner = createCodexSequentialOwner(config, 'owned-profile', source.profileId, () => access, factory, async () => {})
  onTestFinished(async () => { try { await owner.close(); expect(active.size).toBe(0) }
  finally { await rm(directory, { recursive: true, force: true }) } })
  const lease = await owner.writer.acquire(source, { ...read(), nativeProfileUnchanged: true,
    ownerToken: brandString<CodingSessionOwnerToken>('owned-race-token') })
  const entered = Promise.withResolvers<undefined>(); const admit = Promise.withResolvers<undefined>()
  const turn = lease.resumeOriginal({ source, text: 'Owned fixture continuation', signal: read().signal,
    beforeDispatch: async () => { entered.resolve(undefined); await admit.promise } })
  const rejectedTurn = expect(turn).rejects.toThrow('ownership closed before native dispatch')
  await entered.promise
  const release = lease.release(read())
  const rejectedRelease = expect(release).rejects.toThrow('unresolved native turn or process evidence')
  admit.resolve(undefined)
  await rejectedTurn; await rejectedRelease
  expect(calls).not.toContain('turn/start')
  expect(disposalAttempts).toBe(2)
  expect(active.size).toBe(0)
  await expect(lease.read(read())).rejects.toThrow('not available')
})
