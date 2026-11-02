import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watchManagedGithubStatus } from '../src/update-checkout.ts'

describe('managed GitHub status watcher', () => {
  it('notifies when the status file is replaced after the desktop starts', () => {
    const onChange = vi.fn()
    let closeCount = 0
    const watcher = watchManagedGithubStatus('/tmp/y-harness/update-status.json', onChange,
      (_statusPath, onEvent, _onError) => {
        onEvent('rename', 'unrelated.json')
        onEvent('rename', 'update-status.json')
        return { close: () => { closeCount += 1 } }
      })

    expect(onChange).toHaveBeenCalledOnce()
    watcher?.close()
    expect(closeCount).toBe(1)
  })

  it('rechecks when the platform cannot provide the changed filename', () => {
    const onChange = vi.fn()
    watchManagedGithubStatus('/tmp/y-harness/update-status.json', onChange,
      (_statusPath, onEvent, _onError) => {
        onEvent('change', null)
        return { close: vi.fn() }
      })

    expect(onChange).toHaveBeenCalledOnce()
  })

  it('reports watcher errors while leaving periodic polling as the fallback', () => {
    const onChange = vi.fn()
    const onError = vi.fn<(error: Error) => void>()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      watchManagedGithubStatus('/tmp/y-harness/update-status.json', onChange,
        (_statusPath, _onEvent, reportError) => {
          onError.mockImplementation(reportError)
          return { close: vi.fn() }
        })

      const error = new Error('watch failed')
      onError(error)
      expect(warning).toHaveBeenCalledWith(
        'desktop update: managed status watcher stopped; polling fallback and periodic checks remain active', error,
      )
      expect(onChange).not.toHaveBeenCalled()
    } finally {
      warning.mockRestore()
    }
  })

  it('notifies for an atomic same-directory status replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'y-harness-status-watch-'))
    const statusPath = join(directory, 'update-status.json')
    const temporaryPath = join(directory, 'update-status.next')
    let resolveChange: (() => void) | undefined
    let renamed = false
    let cancelTimeout = (): void => {}
    const changed = new Promise<void>((resolve) => {
      resolveChange = () => {
        if (renamed) resolve()
      }
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const watcher = watchManagedGithubStatus(statusPath, () => { resolveChange?.() })
    try {
      if (watcher === undefined) throw new Error('managed status watcher was not created')
      const completed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { reject(new Error('managed status watcher timed out')) }, 3_000)
        cancelTimeout = () => { clearTimeout(timeout) }
        changed.then(() => { clearTimeout(timeout); resolve() }, reject)
      })
      await writeFile(temporaryPath, '{"phase":"ready"}\n', { flag: 'wx' })
      await rename(temporaryPath, statusPath)
      renamed = true
      await writeFile(temporaryPath, '{"phase":"ready","revision":2}\n', { flag: 'wx' })
      await rename(temporaryPath, statusPath)
      await completed
    } finally {
      cancelTimeout()
      watcher?.close()
      await rm(directory, { recursive: true, force: true })
      warning.mockRestore()
    }
  })

  it('does not watch an invalid status path', () => {
    const watchDirectory = vi.fn((_statusPath: string, _onEvent: (eventType: 'rename' | 'change', filename: string | null) => void,
      _onError: (error: Error) => void) => ({ close: vi.fn() }))
    expect(watchManagedGithubStatus('relative/update-status.json', vi.fn(), watchDirectory)).toBeUndefined()
    expect(watchDirectory).not.toHaveBeenCalled()
  })
})
