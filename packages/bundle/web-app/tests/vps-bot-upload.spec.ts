/** Exercise upload byte, lifetime, and collision behavior through the real worker. */

import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { describe, expect, it, type MockInstance, vi } from 'vitest'
import { computerFileUploadRoute } from '../src/computer-api.ts'
import { resolveVpsFileUploadLimits, uploadComputerFile } from '../src/vps-bot-upload.ts'
import { VpsRuntime, type VpsRuntimeOptions } from '../src/vps-runtime.ts'

const OWNER = 'bot-session-784d3dc2-74aa-4456-9262-07d312084bad'
const limits = resolveVpsFileUploadLimits({ maxBytes: 1024, reserveBytes: 0 })
const requestSignal = (): AbortSignal => new AbortController().signal

interface UploadProcessMocks {
  readonly ensure: MockInstance<VpsRuntime['ensure']>
  readonly execArgv: MockInstance<VpsRuntime['execArgv']>
}

async function withWorkspace<T>(
  run: (runtime: VpsRuntime, workspace: string, mocks: UploadProcessMocks) => Promise<T>, options?: VpsRuntimeOptions,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'yh-computer-upload-'))
  try {
    const runtime = new VpsRuntime(root, 'localhost/yharness-test', {}, options)
    const workspace = runtime.workspace(OWNER)
    await mkdir(workspace)
    const ensure = vi.spyOn(runtime, 'ensure').mockResolvedValue(undefined)
    const execArgv = vi.spyOn(runtime, 'execArgv').mockImplementation((_sessionId, argv) => ['python3', ...argv.slice(1)])
    return await run(runtime, workspace, { ensure, execArgv })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('private Computer upload', () => {
  it('applies the default transfer limits when the VPS has no overrides', () => {
    expect(resolveVpsFileUploadLimits(undefined)).toEqual({
      maxBytes: 1_000_000_000, reserveBytes: 128 * 1024 * 1024, timeoutMs: 5 * 60_000,
    })
  })

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

  it('publishes at the shared project root and in a subfolder only when the Bot has access', async () => {
    await withWorkspace(async (runtime, workspace, { ensure, execArgv }) => {
      const project = join(workspace, '..', 'shared-project')
      await mkdir(join(project, 'reports'), { recursive: true })
      const projectRoot = await runtime.sharedWorkspaceFor(OWNER)
      expect(projectRoot).toBe('/workspace')
      vi.spyOn(runtime, 'sharedWorkspaceFor').mockResolvedValueOnce(undefined)
      execArgv.mockImplementation((_sessionId, argv) => {
        expect(argv[4]).toBe(projectRoot)
        return ['python3', ...argv.slice(1, 4), project, ...argv.slice(5)]
      })
      const send = (directory: string, name: string) => uploadComputerFile(runtime, OWNER, {
        directory, name, bytes: 3, body: new Response('new').body,
      }, limits, requestSignal())
      await expect(send('/workspace', 'denied.txt')).resolves.toBe('folder-unavailable')
      expect(ensure).not.toHaveBeenCalled()
      expect(execArgv).not.toHaveBeenCalled()
      await expect(send('/workspace', 'root.txt')).resolves.toBe('stored')
      await expect(send('/workspace/reports', 'nested.txt')).resolves.toBe('stored')
      expect(await readFile(join(project, 'root.txt'), 'utf8')).toBe('new')
      expect(await readdir(join(project, 'reports'))).toEqual(['nested.txt'])
      expect(await readdir(project)).toEqual(['reports', 'root.txt'])
      expect(await readdir(workspace)).toEqual([])
    }, { sharedWorkspace: true })
  })

  it('returns unavailable when the worker fails or reports an unrecognized result', async () => {
    await withWorkspace(async (runtime, workspace, { execArgv }) => {
      execArgv.mockReturnValueOnce([join(workspace, 'missing-python')])
      execArgv.mockReturnValueOnce([process.execPath, '-e', 'process.stdout.write("unexpected\\n")'])
      const send = () => uploadComputerFile(runtime, OWNER, {
        directory: '.', name: 'absent.txt', bytes: 0, body: null,
      }, limits, requestSignal())
      await expect(send()).resolves.toBe('unavailable')
      await expect(send()).resolves.toBe('unavailable')
      expect(await readdir(workspace)).toEqual([])
    })
  })

  it('holds the workspace until a worker without an input pipe has settled', async () => {
    const started = Promise.withResolvers<true>()
    const finished = Promise.withResolvers<{ stdout: string; stderr: string }>()
    const launch = vi.fn(() => {
      started.resolve(true)
      return Object.assign(finished.promise, { child: { stdin: null } })
    })
    vi.resetModules()
    vi.doMock('node:child_process', async loadActual => ({
      ...await loadActual<typeof import('node:child_process')>(),
      execFile: Object.assign(vi.fn(), { [promisify.custom]: launch }),
    }))
    try {
      const { uploadComputerFile: upload } = await import('../src/vps-bot-upload.ts')
      await withWorkspace(async (runtime, workspace) => {
        const release = vi.fn()
        vi.spyOn(runtime, 'beginUse').mockReturnValue(release)
        const result = upload(runtime, OWNER, {
          directory: '.', name: 'absent.txt', bytes: 0, body: null,
        }, limits, requestSignal())
        await Promise.race([started.promise, result.then(() => {
          throw new Error('The upload finished before the worker started.')
        })])
        const releasedEarly = release.mock.calls.length
        finished.reject(new Error('The worker input pipe could not be opened.'))
        await expect(result).resolves.toBe('unavailable')
        expect(releasedEarly).toBe(0)
        expect(release).toHaveBeenCalledOnce()
        expect(await readdir(workspace)).toEqual([])
      })
    } finally {
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  })

  it('releases a stalled transfer even if its body rejects cancellation', async () => {
    await withWorkspace(async (runtime, workspace) => {
      const selected = new AbortController()
      const reading = Promise.withResolvers<boolean>()
      const cancelled = vi.fn().mockRejectedValue(new Error('The source stream has already closed.'))
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
      return route.fetch(new Request('http://localhost/api/computer/files/upload?' + query.toString(), {
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
