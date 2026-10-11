/** The declared object type also admits functions, which are not live root authority. */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CodingSessionOwnerToken, CodingSessionSource } from '@deepseek-ai/dsh-coding-session/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createCodexSequentialOwner } from '../src/codex-sequential.ts'
import type { CodexSequentialAccess } from '../src/codex-sequential.ts'
import type { CodexSequentialPeerFactory } from '../src/codex-sequential-process.ts'
import type { CodexSessionSourceConfig } from '../src/coding-session-source.ts'

it('rejects function-valued object authority before opening any native peer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-final-authority-'))
  const home = join(directory, 'native'); const cwd = join(directory, 'project')
  await Promise.all([mkdir(home), mkdir(cwd)])
  const config: CodexSessionSourceConfig = { id: 'authority-contract', label: 'Owned authority contract', home, cwd,
    shellHome: join(directory, 'shell'), nodePath: process.execPath, binary: join(directory, 'never-executed.js'),
    packageManifest: join(directory, 'package.json'), binarySha256: '0'.repeat(64), version: '0.160.0', graceMs: 100,
    knownNoManagedFeatureOverrides: true }
  const source: CodingSessionSource = { provider: 'codex', profileId: brandString<CodingSessionSource['profileId']>('owned-profile'),
    nativeSessionId: brandString<CodingSessionSource['nativeSessionId']>('owned-history') }
  const access: CodexSequentialAccess = { authority: () => {}, cwd, sandbox: 'read-only', writableRoots: [],
    approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: true }, request: async () => ({ decision: 'decline' }) }
  const verifySource = vi.fn(async () => {})
  const openPeer = vi.fn<CodexSequentialPeerFactory>(async () => { throw new Error('No native peer may open for function authority') })
  const owner = createCodexSequentialOwner(config, 'owned-profile', source.profileId, () => access, openPeer, verifySource)
  onTestFinished(async () => { try { await owner.close() } finally { await rm(directory, { recursive: true, force: true }) } })
  await expect(owner.writer.acquire(source, { signal: new AbortController().signal, limit: 10, maxEvents: 20,
    maxBytes: 64 * 1024, nativeProfileUnchanged: true,
    ownerToken: brandString<CodingSessionOwnerToken>('owned-authority-token') })).rejects.toThrow(
    'Original Codex sequential authority requires the exact live Harness root object.',
  )
  expect(verifySource).toHaveBeenCalledOnce()
  expect(openPeer).not.toHaveBeenCalled()
})
