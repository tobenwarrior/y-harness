/** Cold historical restoration mounts the shipped PTC preset and publishes only the current successor. */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId } from '@yharness/session'
import { generationLogPath } from '../../../packages/session/session-persistence-jsonl/src/format.ts'
import { scanZstdFrames } from '../../../packages/session/session-persistence-jsonl/src/zstd.ts'
import type {} from '@yharness/agent-preset-registry'
import type {} from '@yharness/api-session-controller'
import { normalizeSessionSnapshots } from '@yharness/session-snapshot'
import { launchWebScaffold, webSnapshotMode } from './scaffold.ts'

interface MigrationCase {
  readonly label: string
  readonly sourceVersion: 2 | 5
  readonly fixturePath: string
  readonly childFixturePath: string
  readonly sourcePreset: 'code' | 'ptc'
  readonly childLabel: string
  readonly withSelections: boolean
}

const migrationCases: readonly MigrationCase[] = ([2, 5] as const).flatMap(sourceVersion => [false, true].map(withSelections => ({
  label: sourceVersion === 2 ? 'V2 code restoration' : 'V5 PTC restoration',
  sourceVersion,
  fixturePath: fileURLToPath(new URL(`../../../snapshots/web/preset-migration/session.v${String(sourceVersion)}.jsonl`, import.meta.url)),
  childFixturePath: fileURLToPath(new URL(`../../../snapshots/web/preset-migration/session.1.v${String(sourceVersion)}.jsonl`, import.meta.url)),
  sourcePreset: sourceVersion === 2 ? 'code' : 'ptc',
  childLabel: sourceVersion === 2 ? 'historical child' : 'Check direct child',
  withSelections,
})))

describe.skipIf(webSnapshotMode() === 'record')('historical preset restoration through the Web Host', () => {
  it.each(migrationCases)('$label (selection events=$withSelections)', async ({
    fixturePath,
    childFixturePath,
    sourceVersion,
    sourcePreset,
    childLabel,
    withSelections,
  }) => {
    const scaffold = await launchWebScaffold()
    try {
      const id = SessionId('preset-migration')
      const fixture = await readFile(fixturePath, 'utf8')
      const [fixtureHeader, ...fixtureEvents] = fixture.trimEnd().split('\n')
        .map((line): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>)
      expect(fixtureHeader?.['version']).toBe(sourceVersion)
      expect(fixtureHeader?.['agentPreset']).toBe(sourcePreset)
      const events = withSelections ? fixtureEvents : fixtureEvents.filter(event => event['type'] !== 'agent-preset/selected')
      const header = { ...fixtureHeader, id, cwd: scaffold.workspaceCwd }
      const childId = SessionId('preset-migration-child')
      const brokenId = SessionId('preset-migration-broken-child')
      const childFixture = (await readFile(childFixturePath, 'utf8')).trimEnd().split('\n')
        .map((line): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>)
      expect(childFixture[0]?.['version']).toBe(sourceVersion)
      const childCreatedAt = childFixture[0]?.['createdAt']
      const catalog = [
        { type: 'subagent/catalog', data: { version: 1, childId: brokenId, childCreatedAt, mode: 'unknown' } },
        { type: 'subagent/catalog', data: { version: 0, childId, childCreatedAt, mode: 'one-shot', label: childLabel } },
      ]
      // V5 already stores the parent catalog. Older logs recover it from child files.
      const storedEvents = sourceVersion === 5 ? [...events, ...catalog] : events
      const rows = storedEvents.map((event, seq): Record<string, unknown> => ({ ...event, seq, time: seq + 2 }))
      const source = Buffer.concat([header, ...rows].map(row => zstdCompressSync(Buffer.from(JSON.stringify(row) + '\n'))))
      const predecessor = generationLogPath(scaffold.persistenceRoot, scaffold.workspaceCwd, id, sourceVersion, 'zstd')
      const successor = generationLogPath(scaffold.persistenceRoot, scaffold.workspaceCwd, id, SESSION_FORMAT_VERSION, 'zstd')
      await mkdir(dirname(predecessor), { recursive: true })
      await writeFile(predecessor, source)

      const childRows: Record<string, unknown>[] = childFixture.slice(1).map((row, seq) => ({ ...row, seq, time: seq + 3 }))
      const childHeader = { ...childFixture[0], id: childId, parentSession: id, cwd: scaffold.workspaceCwd }
      const childSource = Buffer.concat([childHeader, ...childRows].map(row => zstdCompressSync(Buffer.from(JSON.stringify(row) + '\n'))))
      const childPath = generationLogPath(scaffold.persistenceRoot, scaffold.workspaceCwd, childId, sourceVersion, 'zstd')
      const brokenPath = generationLogPath(scaffold.persistenceRoot, scaffold.workspaceCwd, brokenId, sourceVersion, 'zstd')
      await mkdir(dirname(childPath), { recursive: true })
      await mkdir(dirname(brokenPath), { recursive: true })
      await writeFile(childPath, childSource)
      await writeFile(brokenPath, Buffer.concat([
        zstdCompressSync(Buffer.from(JSON.stringify({ ...childHeader, id: brokenId }) + '\n')),
        zstdCompressSync(Buffer.from('{broken\n' + JSON.stringify({ type: 'turn/end', seq: 1, time: 2,
          data: { turn: 1, reason: { kind: 'completed' } } }) + '\n')),
      ]))
      const brokenSource = await readFile(brokenPath)
      const corruptHeaderId = SessionId('preset-migration-corrupt-header')
      const corruptHeaderPath = generationLogPath(scaffold.persistenceRoot, scaffold.workspaceCwd, corruptHeaderId, sourceVersion, 'zstd')
      const corruptHeaderSource = Buffer.from('invalid Zstandard header frame')
      await mkdir(dirname(corruptHeaderPath), { recursive: true })
      await writeFile(corruptHeaderPath, corruptHeaderSource)
      const listed = await scaffold.ctx.sessionController.list({}, new AbortController().signal)
      expect(listed.items.map(item => item.sessionId)).toEqual(expect.arrayContaining([id, childId, brokenId]))
      expect(listed.items.map(item => item.sessionId)).not.toContain(corruptHeaderId)

      const reader = await scaffold.ctx.sessionPersistence.open(id, 'read')
      try {
        expect(reader.header.agentPreset).toBe('ptc')
        await reader.read()
      } finally {
        await reader.close()
      }
      await expect(readFile(successor)).rejects.toMatchObject({ code: 'ENOENT' })

      const resolved = await scaffold.ctx.sessionController.resolveAgent(id)
      if ('error' in resolved) throw resolved.error
      expect(scaffold.ctx.agentPresets.composedPreset(resolved.agent.ctx)).toBe('ptc')
      expect(resolved.agent.session.header.agentPreset).toBe('ptc')
      expect(resolved.agent.session.snapshotEvents()
        .filter(event => event.type === 'agent-preset/selected')
        .map(event => event.data.agentPreset)).toEqual(withSelections ? ['ptc', 'standard', 'ptc'] : [])
      expect(await scaffold.ctx.subagents.listChildren(id)).toEqual([
        { id: brokenId, createdAt: childFixture[0]?.['createdAt'], mode: 'unknown' },
        { id: childId, createdAt: childFixture[0]?.['createdAt'], mode: 'one-shot', label: childLabel },
      ])

      const childSuccessor = generationLogPath(scaffold.persistenceRoot, scaffold.workspaceCwd, childId, SESSION_FORMAT_VERSION, 'zstd')
      await expect(readFile(childSuccessor)).rejects.toMatchObject({ code: 'ENOENT' })
      const signal = new AbortController().signal
      const address = { kind: 'subagent', parentSessionId: id, childSessionId: childId, mode: 'one-shot' } as const
      const childPage = await scaffold.ctx.sessionController.page({ address, throughSeq: childRows.length - 1 }, signal)
      expect(childPage.records.map(record => record.event.type)).toEqual(childRows.map(row => row['type']))
      await expect(scaffold.ctx.sessionController.page({ address: { ...address, childSessionId: brokenId, mode: 'unknown' }, throughSeq: 1 }, signal))
        .rejects.toThrow()
      await expect(scaffold.ctx.sessionController.page({ address: { kind: 'session', sessionId: id }, throughSeq: rows.length - 1 }, signal))
        .resolves.toMatchObject({ hasMore: false })
      const childWriter = await scaffold.ctx.sessionPersistence.open(childId, 'write')
      await childWriter.close()
      const childPublished = await readFile(childSuccessor)
      const childText = Buffer.concat(scanZstdFrames(childPublished).frames
        .map(({ start, end }) => zstdDecompressSync(childPublished.subarray(start, end)))).toString('utf8')
      expect(childText.trimEnd().split('\n').map((line): unknown => JSON.parse(line))).toEqual([
        { ...childHeader, version: SESSION_FORMAT_VERSION, ...(sourceVersion === 2 ? { agentPreset: 'ptc' } : {}) },
        ...childRows,
      ])
      expect(await readFile(childPath)).toEqual(childSource)
      expect(await readFile(brokenPath)).toEqual(brokenSource)
      await expect(readFile(generationLogPath(scaffold.persistenceRoot, scaffold.workspaceCwd, brokenId, SESSION_FORMAT_VERSION, 'zstd')))
        .rejects.toMatchObject({ code: 'ENOENT' })

      await scaffold.ctx.sessions.flush(resolved.agent.session)
      const publishedBytes = await readFile(successor)
      const published = Buffer.concat(scanZstdFrames(publishedBytes).frames
        .map(({ start, end }) => zstdDecompressSync(publishedBytes.subarray(start, end)))).toString('utf8')
      const migratedRows = rows.map(row => row['type'] === 'agent-preset/selected'
          && (row['data'] as { agentPreset: string }).agentPreset === 'code'
        ? { ...row, data: { agentPreset: 'ptc' } }
        : row)
      if (sourceVersion === 2) migratedRows.push(...catalog.map((event, index) => ({
        ...event, seq: rows.length + index, time: rows.at(-1)?.['time'],
      })))
      const seq = migratedRows.length
      const expected = [
        { ...header, version: SESSION_FORMAT_VERSION, agentPreset: 'ptc' },
        ...migratedRows,
        // Agent activation closes its restored prefix with a fresh seed marker.
        { type: 'session/end-seed', seq, time: 0, data: {} },
        ...(sourceVersion === 2 ? [
          { type: 'permission/preset', seq: seq + 1, time: 0, data: { preset: 'workspace-write' } },
          { type: 'sandbox/mode', seq: seq + 2, time: 0, data: { mode: 'workspace-write' } },
          { type: 'approval/policy', seq: seq + 3, time: 0, data: { policy: 'ask' } },
        ] : []),
      ].map(row => JSON.stringify(row)).join('\n') + '\n'
      const context = { sessionIds: [id], cwd: scaffold.workspaceCwd }
      expect(normalizeSessionSnapshots([published], context)).toEqual(normalizeSessionSnapshots([expected], context))
      expect(JSON.parse(published.split('\n')[0] as string) as Record<string, unknown>).toMatchObject({
        id,
        version: SESSION_FORMAT_VERSION,
        agentPreset: 'ptc',
      })
      expect(await readFile(predecessor)).toEqual(source)
      await expect(scaffold.ctx.sessionPersistence.open(corruptHeaderId, 'read')).rejects.toThrow(/invalid frame magic/)
      expect(await readFile(corruptHeaderPath)).toEqual(corruptHeaderSource)
      expect((await readdir(dirname(predecessor))).filter(name => name.endsWith('.jsonl.zstd')).sort())
        .toEqual([`session.v${String(sourceVersion)}.jsonl.zstd`, `session.v${SESSION_FORMAT_VERSION}.jsonl.zstd`])
    } finally {
      await scaffold.close()
    }
  })
})
