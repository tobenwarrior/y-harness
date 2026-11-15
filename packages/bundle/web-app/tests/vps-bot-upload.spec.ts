/** Exercise upload byte, lifetime, and collision behavior through the real worker. */

import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { computerFileUploadRoute } from '../src/computer-api.ts'
import { resolveVpsFileUploadLimits, uploadComputerFile } from '../src/vps-bot-upload.ts'
import { VpsRuntime } from '../src/vps-runtime.ts'

const OWNER = 'bot-session-784d3dc2-74aa-4456-9262-07d312084bad'
const limits = resolveVpsFileUploadLimits({ maxBytes: 1024, reserveBytes: 0 })
const requestSignal = (): AbortSignal => new AbortController().signal

async function withWorkspace<T>(run: (runtime: VpsRuntime, workspace: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'yh-computer-upload-'))
  try {
    const runtime = new VpsRuntime(root, 'localhost/yharness-test')
    const workspace = runtime.workspace(OWNER)
    await mkdir(workspace)
    vi.spyOn(runtime, 'ensure').mockResolvedValue(undefined)
    vi.spyOn(runtime, 'execArgv').mockImplementation((_sessionId, argv) => ['python3', ...argv.slice(1)])
    return await run(runtime, workspace)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('private Computer upload', () => {
  it('copies the original binary bytes into the chosen directory and refuses duplicate names', async () => {
    await withWorkspace(async (runtime, workspace) => {
      await mkdir(join(workspace, 'reports'))
      const bytes = Uint8Array.of(0, 1, 193, 255)
      const send = () => uploadComputerFile(runtime, OWNER, {
        directory: 'reports', name: 'Résumé #1.bin', bytes: bytes.length, body: new Response(bytes).body,
      }, limits, requestSignal())
      const results = await Promise.all([send(), send()])
      expect(results.sort()).toEqual(['exists', 'stored'])
      expect(await readFile(join(workspace, 'reports', 'Résumé #1.bin'))).toEqual(Buffer.from(bytes))
      expect(await readdir(join(workspace, 'reports'))).toEqual(['Résumé #1.bin'])
      await expect(uploadComputerFile(runtime, OWNER, {
        directory: '.', name: 'empty.txt', bytes: 0, body: null,
      }, limits, requestSignal())).resolves.toBe('stored')
      expect(await readFile(join(workspace, 'empty.txt'))).toHaveLength(0)
    })
  })

  it('leaves an unfinished transfer, a linked directory, and a low-space volume untouched', async () => {
    await withWorkspace(async (runtime, workspace) => {
      await mkdir(join(workspace, 'actual'))
      await writeFile(join(workspace, 'actual', 'original.txt'), 'original')
      await symlink(join(workspace, 'actual'), join(workspace, 'linked'))
      const send = (directory: string, name: string, bytes: number, data: string, options = limits) =>
        uploadComputerFile(runtime, OWNER, { directory, name, bytes, body: new Response(data).body }, options, requestSignal())
      await expect(send('linked', 'new.txt', 3, 'new')).resolves.toBe('folder-unavailable')
      await expect(send('actual', 'partial.txt', 9, 'new')).resolves.toBe('incomplete')
      await expect(send('actual', 'excess.txt', 2, 'new')).resolves.toBe('incomplete')
      await expect(send('actual', 'full.txt', 3, 'new',
        resolveVpsFileUploadLimits({ reserveBytes: 1_000_000_000_000_000 }))).resolves.toBe('no-space')
      expect(await readdir(join(workspace, 'actual'))).toEqual(['original.txt'])
    })
  })

  it('closes a stalled body and releases the temporary file on request cancellation', async () => {
    await withWorkspace(async (runtime, workspace) => {
      const selected = new AbortController()
      const reading = Promise.withResolvers<boolean>()
      const cancelled = vi.fn()
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(Uint8Array.of(7)) },
        pull() { reading.resolve(true) },
        cancel: cancelled,
      }, { highWaterMark: 0 })
      const upload = uploadComputerFile(runtime, OWNER, { directory: '.', name: 'partial.bin', bytes: 9, body },
        limits, selected.signal)
      const assertion = expect(upload).rejects.toMatchObject({ name: 'AbortError' })
      await reading.promise
      selected.abort()
      await assertion
      expect(cancelled).toHaveBeenCalledOnce()
      expect(await readdir(workspace)).toEqual([])
    })
  })

  it('validates request media, size and path before opening a bot workspace', async () => {
    const writer = vi.fn().mockResolvedValue('stored')
    const route = computerFileUploadRoute(writer, 20)
    const call = (directory: string, name = 'source.bin', bytes = '3', media = 'application/octet-stream') => {
      const query = new URLSearchParams({ sessionId: OWNER, directory, name, bytes })
      return route.fetch(new Request('http://localhost/api/computer/files/upload?' + query, {
        method: 'POST', body: Uint8Array.of(7, 8, 9), headers: { 'content-type': media },
      }))
    }
    expect((await call('reports', 'source.bin', '3', 'text/plain')).status).toBe(415)
    expect((await call('reports', 'source.bin', '68')).status).toBe(413)
    expect((await call('reports', 'part/source.bin')).status).toBe(400)
    expect((await call('/reports')).status).toBe(400)
    expect((await call('reports/..')).status).toBe(400)
    expect(writer).not.toHaveBeenCalled()
    expect((await call('reports')).status).toBe(201)
    expect(writer).toHaveBeenCalledExactlyOnceWith(OWNER, expect.objectContaining({ directory: 'reports', name: 'source.bin', bytes: 3 }),
      expect.any(AbortSignal))
  })
})
