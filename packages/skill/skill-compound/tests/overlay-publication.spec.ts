/** Verify rejected staged paths leave the active Compound revision in place. */

import { createHash } from 'node:crypto'
import { readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { activeOverlay, updateOverlay } from '../src/overlay.ts'
import { privateOverlayRoot } from './private-overlay-root.ts'

const { onWrite } = vi.hoisted(() => ({ onWrite: vi.fn<(path: string) => Promise<void>>() }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      await fs.writeFile(...args)
      if (typeof args[0] === 'string') await onWrite(args[0])
    },
  }
})

afterEach(() => {
  onWrite.mockReset()
  vi.unstubAllGlobals()
})

function serveRevision(commit: string, version: string): void {
  const files = new Map(['compound', 'map', 'setup', 'setup-global', 'status-global'].map(name => [
    `skills/${name}/SKILL.md`,
    `---\nname: ${name}\ndescription: fixture\n---\ncontent\n`,
  ]))
  const tree = [...files].map(([path, file]) => {
    const size = Buffer.byteLength(file)
    const sha = createHash('sha1').update(`blob ${size}\0`).update(file).digest('hex')
    return { mode: '100644', type: 'blob', path, size, sha }
  })
  vi.stubGlobal('fetch', (url: string) => {
    if (url.includes('/commits/')) return Promise.resolve(Response.json({ sha: commit }))
    if (url.includes('/git/trees/')) return Promise.resolve(Response.json({ truncated: false, tree }))
    if (url.endsWith('/plugin.json')) return Promise.resolve(Response.json({ version }))
    const path = [...files.keys()].find(key => url.endsWith(key))
    return Promise.resolve(path === undefined ? new Response(null, { status: 404 }) : new Response(files.get(path)))
  })
}

async function expectPreservedOverlay(root: string, pointer: Buffer, commit: string): Promise<void> {
  expect(await readFile(join(root, 'current.json'))).toEqual(pointer)
  expect(activeOverlay(root)?.commit).toBe(commit)
  expect((await readdir(root)).sort()).toEqual(['current.json', 'revisions'])
  expect((await readdir(join(root, 'revisions'))).some(name => name.startsWith('.stage-'))).toBe(false)
}

it.each([
  { name: 'staged skill file', pointer: false, extra: false, error: 'unsafe overlay file' },
  { name: 'unexpected staged resource', pointer: false, extra: true, error: 'unsafe overlay resource' },
  { name: 'temporary pointer', pointer: true, extra: false, error: 'unsafe overlay file' },
])('preserves the active overlay when the $name fails privacy validation', async ({ pointer, extra, error }) => {
  const root = await privateOverlayRoot('compound-publish-test-')
  const previous = 'a'.repeat(40)
  const current = join(root, 'current.json')
  try {
    serveRevision(previous, '1.0.0')
    await updateOverlay(root)
    const before = await readFile(current)
    const previousSkill = join(root, 'revisions', previous, 'skills', 'compound', 'SKILL.md')

    serveRevision('b'.repeat(40), '2.0.0')
    onWrite.mockImplementation(async (path) => {
      const matches = pointer ? basename(path).startsWith('.current-') : path.endsWith(join('compound', 'SKILL.md'))
      if (matches) {
        if (!extra) await unlink(path)
        await symlink(previousSkill, extra ? join(dirname(path), 'extra.py') : path, 'file')
      }
    })

    await expect(updateOverlay(root)).rejects.toThrow(error)
    await expectPreservedOverlay(root, before, previous)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('preserves the active overlay when a reused revision contains an unsafe extra resource', async () => {
  const root = await privateOverlayRoot('compound-publish-test-')
  const previous = 'a'.repeat(40)
  const next = 'b'.repeat(40)
  const current = join(root, 'current.json')
  try {
    serveRevision(previous, '1.0.0')
    await updateOverlay(root)
    const before = await readFile(current)

    serveRevision(next, '2.0.0')
    await updateOverlay(root)
    await writeFile(current, before)
    const destination = join(root, 'revisions', next, 'skills', 'compound')
    await symlink(join(destination, 'SKILL.md'), join(destination, 'extra.py'), 'file')

    await expect(updateOverlay(root)).rejects.toThrow('unsafe overlay resource')
    await expectPreservedOverlay(root, before, previous)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
