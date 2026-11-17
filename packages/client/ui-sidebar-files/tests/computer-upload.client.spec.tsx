// @vitest-environment jsdom
/** Computer file picker hook: synthetic uploads, failures, cancellation, and cleanup. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useComputerFilePicker } from '../src/client/computer-upload.ts'

interface ProbeProps {
  readonly lifetime: AbortSignal
  readonly root?: string
  readonly refresh: () => void
}

const emptySelection: FileList = Object.assign([], { item: () => null })

function Probe({ lifetime, root = '.', refresh }: ProbeProps) {
  const picker = useComputerFilePicker('owner/session', lifetime, root, refresh)
  return (
    <>
      <input ref={picker.input} type="file" multiple data-testid="data-picker" onChange={(event) => {
        const files = event.currentTarget.files
        if (files !== null) void picker.submit(files)
        event.currentTarget.value = ''
      }} />
      <button type="button" onClick={() => { picker.pick('./relative') }}>Pick relative</button>
      <button type="button" onClick={() => { picker.pick('/absolute') }}>Pick absolute</button>
      <button type="button" onClick={() => { void picker.submit(emptySelection) }}>Submit empty</button>
      <button type="button" onClick={picker.cancel}>Cancel</button>
      <output data-testid="uploading" data-uploading>{picker.uploading ?? ''}</output>
      <output data-testid="failures" data-failures>{JSON.stringify(picker.failures)}</output>
    </>
  )
}

function file(name: string): File {
  return new File([`${name} contents`], name, { type: 'text/plain' })
}

function failureOutput(): readonly { name: string; key: string }[] {
  const text = screen.getByTestId('failures').textContent
  return JSON.parse(text ?? '[]') as readonly { name: string; key: string }[]
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useComputerFilePicker', () => {
  it('normalizes a relative folder and reports every synthetic broker status', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(null, { status: 413 }))
      .mockResolvedValueOnce(new Response(null, { status: 507 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    const refresh = vi.fn()
    render(<Probe lifetime={new AbortController().signal} refresh={refresh} />)
    const click = vi.spyOn(HTMLInputElement.prototype, 'click')
    fireEvent.click(screen.getByRole('button', { name: 'Pick relative' }))
    expect(click).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Pick absolute' }))
    expect(click).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Submit empty' }))
    expect(fetchMock).not.toHaveBeenCalled()

    const files = ['saved.txt', 'invalid.txt', 'folder.txt', 'exists.txt', 'large.txt', 'space.txt', 'unknown.txt'].map(file)
    fireEvent.change(screen.getByTestId('data-picker'), { target: { files } })
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(files.length) })

    const failures = failureOutput()
    expect(failures).toEqual([
      { name: 'invalid.txt', key: 'upload.error.invalid' },
      { name: 'folder.txt', key: 'upload.error.folder' },
      { name: 'exists.txt', key: 'upload.error.exists' },
      { name: 'large.txt', key: 'upload.error.large' },
      { name: 'space.txt', key: 'upload.error.space' },
      { name: 'unknown.txt', key: 'upload.error.unavailable' },
    ])
    expect(refresh).toHaveBeenCalledTimes(1)
    const [input, init] = fetchMock.mock.calls[0] ?? []
    if (typeof input !== 'string') throw new Error('expected a string upload URL')
    expect(input).toContain('directory=%2Fabsolute')
    expect(input).toContain('name=saved.txt')
    expect(input).toContain('bytes=18')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: files[0] })
  })

  it('records a non-abort transport failure as unavailable', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('synthetic transport failure'))
    vi.stubGlobal('fetch', fetchMock)
    const refresh = vi.fn()
    render(<Probe lifetime={new AbortController().signal} refresh={refresh} />)

    fireEvent.change(screen.getByTestId('data-picker'), { target: { files: [file('network.txt')] } })
    await waitFor(() => { expect(failureOutput()).toEqual([{ name: 'network.txt', key: 'upload.error.unavailable' }]) })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('cancels the active upload without recording a failure or refreshing', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const refresh = vi.fn()
    render(<Probe lifetime={new AbortController().signal} refresh={refresh} />)

    fireEvent.change(screen.getByTestId('data-picker'), { target: { files: [file('cancel.txt')] } })
    await waitFor(() => { expect(screen.getByTestId('uploading').textContent).toBe('cancel.txt') })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => { expect(screen.getByTestId('uploading').textContent).toBe('') })
    expect(failureOutput()).toEqual([])
    expect(refresh).not.toHaveBeenCalled()
  })

  it('does not start another operation while active and suppresses state after lifetime abort', async () => {
    const pending = Promise.withResolvers<Response>()
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(pending.promise)
    vi.stubGlobal('fetch', fetchMock)
    const lifetime = new AbortController()
    const refresh = vi.fn()
    const view = render(<Probe lifetime={lifetime.signal} refresh={refresh} />)

    fireEvent.change(screen.getByTestId('data-picker'), { target: { files: [file('first.txt'), file('second.txt')] } })
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1) })
    fireEvent.change(screen.getByTestId('data-picker'), { target: { files: [file('second.txt')] } })
    fireEvent.click(screen.getByRole('button', { name: 'Pick relative' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    lifetime.abort()
    const signal = fetchMock.mock.calls[0]?.[1]?.signal
    expect(signal?.aborted).toBe(true)
    pending.resolve(new Response(null, { status: 201 }))
    await pending.promise
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1) })
    expect(refresh).not.toHaveBeenCalled()
    view.unmount()
  })

  it('aborts an active request when the picker unmounts before its response settles', async () => {
    const pending = Promise.withResolvers<Response>()
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(pending.promise)
    vi.stubGlobal('fetch', fetchMock)
    const lifetime = new AbortController()
    const refresh = vi.fn()
    const view = render(<Probe lifetime={lifetime.signal} refresh={refresh} />)

    fireEvent.change(screen.getByTestId('data-picker'), { target: { files: [file('unmounted.txt')] } })
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1) })
    lifetime.abort()
    view.unmount()
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    pending.resolve(new Response(null, { status: 201 }))
    await pending.promise
    expect(refresh).not.toHaveBeenCalled()
  })
})
