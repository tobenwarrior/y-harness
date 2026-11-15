import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { vpsProjectWorker } from '../src/vps-project-worker.ts'

const run = promisify(execFile)

async function request(root: string, path: string, args: object): Promise<unknown> {
  const child = run('python3', ['-I', '-c', vpsProjectWorker, root], { timeout: 7000 })
  child.child.stdin?.end(JSON.stringify({ path, ...args }))
  return JSON.parse((await child).stdout) as unknown
}

describe.skipIf(process.platform === 'win32')('VPS project file worker', () => {
  it('reads a shared file and serializes two updates of the same version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yh-project-version-'))
    const path = join(root, 'research', 'notes.txt')
    try {
      const versioned = (outcome: unknown) => {
        if (typeof outcome !== 'object' || outcome === null || !('value' in outcome)) throw new Error('Missing project result.')
        const value = outcome.value
        if (typeof value !== 'object' || value === null || !('entry' in value)) throw new Error('Missing project metadata.')
        const entry = value.entry
        if (typeof entry !== 'object' || entry === null || !('version' in entry) || typeof entry.version !== 'string') {
          throw new Error('Missing project version.')
        }
        return entry.version
      }
      const first = versioned(await request(root, path, {
        operation: 'write', content: 'before', expected: { kind: 'createIfAbsent' },
      }))
      await expect(request(root, path, { operation: 'read', offset: 0, limit: 64, whole: true }))
        .resolves.toEqual({ value: Buffer.from('before').toString('base64') })
      const results = await Promise.all(['alpha', 'beta'].map(content => request(root, path, {
        operation: 'write', content, expected: { kind: 'replaceIfVersion', version: first },
      })))
      expect(results.filter(item => typeof item === 'object' && item !== null && 'value' in item)).toHaveLength(1)
      expect(results).toContainEqual({
        error: 'FS_STALE_VERSION', message: 'The project file changed. Read its current version before saving.',
      })
      expect(['alpha', 'beta']).toContain(await readFile(path, 'utf8'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps links out of resolved reads and writes', async () => {
    const base = await mkdtemp(join(tmpdir(), 'yh-project-links-'))
    const root = await mkdtemp(join(base, 'project-'))
    try {
      const outside = join(base, 'outside.txt')
      await writeFile(outside, 'another workspace')
      await symlink(outside, join(root, 'alias.txt'))
      await symlink(base, join(root, 'more'))
      await expect(request(root, join(root, 'alias.txt'), { operation: 'read', offset: 0, limit: 64, whole: true }))
        .resolves.toMatchObject({ error: 'FS_SANDBOX_DENIED' })
      await expect(request(root, join(root, 'more', 'outside.txt'), {
        operation: 'write', content: 'changed', expected: { kind: 'createIfAbsent' },
      })).resolves.toMatchObject({ error: 'FS_SANDBOX_DENIED' })
      await expect(request(root, outside, { operation: 'stat' })).resolves.toMatchObject({ error: 'FS_SANDBOX_DENIED' })
      expect(await readFile(outside, 'utf8')).toBe('another workspace')
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})
