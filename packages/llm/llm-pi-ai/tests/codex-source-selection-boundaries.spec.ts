import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CodingSessionNativeId } from '@deepseek-ai/dsh-coding-session/types'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { createConfiguredCodexSessionProvider, verifyCodexSessionSource } from '../src/coding-session-source.ts'
import type { CodexSessionSourceConfig } from '../src/coding-session-source.ts'

async function selection(): Promise<CodexSessionSourceConfig> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-selection-boundaries-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'bin'))
  const bytes = Buffer.from('synthetic package wrapper; never executed')
  const binary = join(dir, 'bin/codex.js'); await writeFile(binary, bytes)
  const packageManifest = join(dir, 'package.json')
  await writeFile(packageManifest, JSON.stringify({ name: '@openai/codex', version: '0.160.0', bin: { codex: 'bin/codex.js' } }))
  return { id: 'fixture', label: 'Fixture source', home: join(dir, 'home'), binary, packageManifest,
    binarySha256: createHash('sha256').update(bytes).digest('hex'), version: '0.160.0',
    nodePath: process.execPath, shellHome: join(dir, 'shell-home'), cwd: dir, graceMs: 100 }
}

describe('original Codex selected package admission', () => {
  it.each(['home', 'binary', 'packageManifest', 'nodePath', 'shellHome', 'cwd'] as const)('refuses relative %s before starting any reader', async (field) => {
    const config = await selection()
    const spawn = vi.fn<Parameters<typeof createConfiguredCodexSessionProvider>[1]>()
    const provider = createConfiguredCodexSessionProvider({ ...config, [field]: 'relative-selection' }, spawn)
    await expect(provider.discover({ signal: new AbortController().signal, limit: 1, maxEvents: 10, maxBytes: 1000 })).rejects.toThrow('explicit absolute paths')
    expect(spawn).not.toHaveBeenCalled(); await provider.close()
  })

  it.each(['', 'not-a-digest', 'A'.repeat(64), '0'.repeat(63)])('refuses a noncanonical wrapper digest before package verification: %j', async (binarySha256) => {
    await expect(verifyCodexSessionSource({ ...await selection(), binarySha256 })).rejects.toThrow('exact SHA-256 wrapper hash')
  })

  it.each(['{invalid-json', JSON.stringify({ name: 'untrusted-package', version: '0.160.0', bin: { codex: 'bin/codex.js' } })])('sanitizes malformed or foreign package metadata', async (metadata) => {
    const config = await selection(); await writeFile(config.packageManifest, metadata)
    await expect(verifyCodexSessionSource(config)).rejects.toThrow('could not verify the selected package and wrapper')
  })

  it('refuses a package version differing from the pinned supported selection', async () => {
    const config = await selection()
    await writeFile(config.packageManifest, JSON.stringify({ name: '@openai/codex', version: '0.159.0', bin: { codex: 'bin/codex.js' } }))
    await expect(verifyCodexSessionSource(config)).rejects.toThrow('package version differs')
  })

  it('refuses another existing wrapper even when its bytes and selected digest agree', async () => {
    const config = await selection()
    const other = join(config.cwd, 'bin/other.js'); await writeFile(other, 'synthetic package wrapper; never executed')
    await expect(verifyCodexSessionSource({ ...config, binary: other })).rejects.toThrow('not the selected package wrapper')
  })

  it('keeps sequential startup unavailable when the factual managed-feature declaration is absent', async () => {
    const config = await selection(); const spawn = vi.fn<Parameters<typeof createConfiguredCodexSessionProvider>[1]>()
    const provider = createConfiguredCodexSessionProvider({ ...config, enableSequentialProjectFiles: true }, spawn)
    expect(provider).not.toHaveProperty('sequentialWriter')
    expect(spawn).not.toHaveBeenCalled(); await provider.close()
  })

  it('requires a live policy resolver even for an explicitly declared synthetic sequential profile', async () => {
    const config = await selection(); const spawn = vi.fn<Parameters<typeof createConfiguredCodexSessionProvider>[1]>()
    expect(() => createConfiguredCodexSessionProvider({ ...config, enableSequentialProjectFiles: true,
      knownNoManagedFeatureOverrides: true }, spawn)).toThrow('exact live Harness policy authority')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reads the exact selected native identity and waits for its private managed reader to drain', async () => {
    const config = await selection(); const calls: string[] = []
    const spawn = vi.fn<Parameters<typeof createConfiguredCodexSessionProvider>[1]>(() => {
      const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough()
      const completion = Promise.withResolvers<Awaited<SubprocessHandle['done']>>()
      let pending = ''
      stdin.on('data', (bytes: Buffer) => {
        pending += bytes.toString('utf8')
        for (;;) {
          const end = pending.indexOf('\n'); if (end < 0) return
          const frame = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string() })
            .parse(JSON.parse(pending.slice(0, end)))
          pending = pending.slice(end + 1); calls.push(frame.method)
          if (frame.id === undefined) continue
          const result = frame.method === 'initialize'
            ? { codexHome: config.home, userAgent: 'y-coding-session-reader/0.160.0 (fixture)' }
            : { thread: { id: 'fixture-native-original', cwd: config.cwd, preview: 'Fixture source', updatedAt: 1, historyMode: 'legacy',
              status: { type: 'notLoaded' }, turns: [] } }
          queueMicrotask(() => { stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\n') })
        }
      })
      const finish = (): void => { completion.resolve({ exitCode: 0, signal: null }); stdout.end(); stderr.end() }
      stdin.on('finish', finish)
      return { stdin, stdout, stderr, control: undefined, collected: {}, done: completion.promise,
        terminate: () => { stdin.end() }, waitForExit: async () => { await completion.promise; return true } }
    })
    const provider = createConfiguredCodexSessionProvider(config, spawn)
    const snapshot = await provider.read(brandString<CodingSessionNativeId>('fixture-native-original'), {
      signal: new AbortController().signal, limit: 1, maxEvents: 10, maxBytes: 10000,
    })
    expect(snapshot.source.nativeSessionId).toBe('fixture-native-original'); expect(snapshot.events).toEqual([])
    expect(calls).toEqual(['initialize', 'initialized', 'thread/read', 'thread/read', 'thread/read'])
    expect(spawn).toHaveBeenCalledOnce(); await provider.close()
  })
})
