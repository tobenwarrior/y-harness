/** The encoded snapshot oracle retains exact output and rejects changed complete worlds. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureExpectedWorkspaceSnapshot, captureWorkspaceSnapshot } from '@deepseek-ai/dsh-session-snapshot'
import { readExpectedWorld } from '../../../../snapshots/session/managed-markdown-skill-load/expected-world.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function ownedRoot() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-managed-world-probe-'))
  roots.push(root)
  return root
}

describe('managed Markdown encoded complete-world oracle', () => {
  it('captures all eight exact files and removes the temporary expected tree', async () => {
    let temporary = ''
    const expected = await readExpectedWorld(async (root) => {
      temporary = root
      return captureExpectedWorkspaceSnapshot(root)
    })
    expect(expected).toHaveLength(8)
    const entry = expected.find(file => file.path === 'skills/managed-demo/SKILL.md')
    if (entry?.kind !== 'text') throw new Error('Expected generated entry is absent')
    expect(entry.content.endsWith('\n\n')).toBe(true)
    const receipts = expected.filter(file => /\/source\/\d{4}\.txt$/.test(file.path))
    expect(receipts).toHaveLength(3)
    const reconstructed = receipts.map((file) => {
      if (file.kind !== 'text') throw new Error('Expected source fragment is not text')
      return file.content
    }).join('')
    const input = await readFile(new URL('../../../../snapshots/session/managed-markdown-skill-load/workspace/skills/managed-demo/SKILL.md', import.meta.url), 'utf8')
    expect(reconstructed).toBe(input)
    await expect(stat(temporary)).rejects.toThrow(/ENOENT/)
  })

  it.each(['changed-byte', 'missing-file', 'extra-file'] as const)('rejects %s through the unchanged complete-world comparison', async (kind) => {
    const expected = await readExpectedWorld(captureExpectedWorkspaceSnapshot)
    const actualRoot = await ownedRoot()
    for (const file of expected) {
      if (file.kind !== 'text') throw new Error('Expected world contains a non-text file')
      const destination = join(actualRoot, file.path)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, file.content)
    }
    const entry = join(actualRoot, 'skills/managed-demo/SKILL.md')
    if (kind === 'changed-byte') await writeFile(entry, (await readFile(entry, 'utf8')).replace('managed-demo', 'managed-dema'))
    else if (kind === 'missing-file') await unlink(entry)
    else await writeFile(join(actualRoot, 'unexpected.txt'), 'An extra file is not ignored.\n')
    const actual = await captureWorkspaceSnapshot(actualRoot)
    expect(() => { assert.deepEqual(actual, expected) }).toThrow()
  })

  it('rejects a changed encoded byte before invoking the expected-world reader', async () => {
    const original = await readFile(new URL('../../../../snapshots/session/managed-markdown-skill-load/workspace.expected/world.json', import.meta.url), 'utf8')
    const changed = original.replace('DETAIL_CANARY', 'DETAXL_CANARY')
    expect(changed).not.toBe(original)
    expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original))
    const path = join(await ownedRoot(), 'world.json')
    await writeFile(path, changed)
    const capture = vi.fn(captureExpectedWorkspaceSnapshot)
    await expect(readExpectedWorld(capture, path)).rejects.toThrow(/SHA256/)
    expect(capture).not.toHaveBeenCalled()
  })

  it('removes the expected tree when the complete-world reader fails', async () => {
    let temporary = ''
    await expect(readExpectedWorld(async (root) => {
      temporary = root
      throw new Error('Owned reader failure')
    })).rejects.toThrow('Owned reader failure')
    expect(temporary).not.toBe('')
    await expect(stat(temporary)).rejects.toThrow(/ENOENT/)
  })
})
