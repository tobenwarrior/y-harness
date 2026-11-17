// @vitest-environment jsdom
/** Computer preview copy picker: synthetic recipient and transfer outcomes. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@yharness/client-test-runtime'
import { ComputerFileCopy } from '../src/client/ComputerFileCopy.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)
const recipients = [
  { id: 'bot-alpha', name: 'Alpha Bot' },
  { id: 'bot-beta', name: 'Beta Bot' },
]
type ReactClickProps = { readonly onClick?: (event: MouseEvent) => unknown }

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function mount(lifetime = new AbortController()): ReturnType<typeof render> {
  return render(<ComputerFileCopy sessionId="owner/session" path="/reports/notes.txt" version="v1"
    lifetime={lifetime.signal} t={t} />)
}

async function openAndSelect(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: en['copy.label'] }))
  await screen.findByRole('radio', { name: 'Alpha Bot' })
  fireEvent.click(screen.getByRole('radio', { name: 'Alpha Bot' }))
  fireEvent.click(screen.getByRole('button', { name: en['copy.confirm'] }))
  await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2) })
}

function reactClickOf(element: HTMLElement): () => void {
  const key = Object.keys(element).find(name => name.startsWith('__reactProps$'))
  if (key === undefined) throw new Error('expected React click props')
  const props = Reflect.get(element, key) as ReactClickProps
  if (props.onClick === undefined) throw new Error('expected React click handler')
  return () => { props.onClick?.(new MouseEvent('click', { bubbles: true })) }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ComputerFileCopy', () => {
  it('loads recipients, filters and selects one, copies the file, and closes the result', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ recipients }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    mount()

    fireEvent.click(screen.getByRole('button', { name: en['copy.label'] }))
    await screen.findByRole('radio', { name: 'Alpha Bot' })
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'missing' } })
    expect(screen.getByText(en['copy.noMatch'])).toBeTruthy()
    fireEvent.change(search, { target: { value: 'beta' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Beta Bot' }))
    fireEvent.click(screen.getByRole('button', { name: en['copy.confirm'] }))
    await screen.findByRole('status')

    expect(fetchMock.mock.calls[0]?.[0]).toBe('api/computer/files/recipients?sessionId=owner%2Fsession')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: 'same-origin' })
    expect(fetchMock.mock.calls[1]?.[0]).toBe('api/computer/files/copy')
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    })
    const body = fetchMock.mock.calls[1]?.[1]?.body
    if (typeof body !== 'string') throw new Error('expected a JSON copy request body')
    expect(JSON.parse(body)).toEqual({
      sessionId: 'owner/session', path: '/reports/notes.txt', version: 'v1', targetBotId: 'bot-beta',
    })
    expect(screen.getByText(t('copy.success', { name: 'Beta Bot' }))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['copy.done'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows an empty-recipient result and closes through the modal control', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ recipients: [] }))
    vi.stubGlobal('fetch', fetchMock)
    mount()

    fireEvent.click(screen.getByRole('button', { name: en['copy.label'] }))
    expect(await screen.findByText(en['copy.noRecipients'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['copy.close'] }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports a roster failure and retries with a valid response', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('synthetic roster failure'))
      .mockResolvedValueOnce(jsonResponse({ recipients }))
    vi.stubGlobal('fetch', fetchMock)
    mount()

    fireEvent.click(screen.getByRole('button', { name: en['copy.label'] }))
    expect((await screen.findByRole('alert')).textContent).toContain(en['copy.rosterUnavailable'])
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(await screen.findByRole('radio', { name: 'Alpha Bot' })).toBeTruthy()
  })

  it.each([
    ['a non-OK response', new Response(JSON.stringify({ recipients: [] }), { status: 503 })],
    ['a null payload', jsonResponse(null)],
    ['a non-array recipient field', jsonResponse({ recipients: {} })],
    ['a recipient without an object record', jsonResponse({ recipients: [null] })],
    ['a recipient without a string id', jsonResponse({ recipients: [{ id: 1, name: 'Bot' }] })],
    ['a recipient without a string name', jsonResponse({ recipients: [{ id: 'bot', name: 1 }] })],
  ])('rejects %s', async (_description, response) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchMock)
    mount()

    fireEvent.click(screen.getByRole('button', { name: en['copy.label'] }))
    expect((await screen.findByRole('alert')).textContent).toContain(en['copy.rosterUnavailable'])
  })

  it.each([
    ['source-unavailable', 'copy.sourceUnavailable'],
    ['source-changed', 'copy.sourceChanged'],
    ['target-unavailable', 'copy.targetUnavailable'],
    ['exists', 'copy.exists'],
    ['too-large', 'copy.tooLarge'],
    ['no-space', 'copy.noSpace'],
  ] as const)('shows the copy error returned by the broker: %s', async (status, key) => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ recipients }))
      .mockResolvedValueOnce(jsonResponse({ status }, 409))
    vi.stubGlobal('fetch', fetchMock)
    mount()

    await openAndSelect(fetchMock)
    expect((await screen.findByRole('alert')).textContent).toContain(t(key))
  })

  it.each([
    ['an unknown status', jsonResponse({ status: 'unknown' }, 500)],
    ['a non-record error body', jsonResponse(null, 500)],
    ['a fetch failure', new Error('synthetic copy failure')],
    ['an invalid JSON error body', new Response('{', { status: 500 })],
  ] as const)('uses the unavailable copy message for %s', async (_description, result) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ recipients }))
    if (result instanceof Error) fetchMock.mockRejectedValueOnce(result)
    else fetchMock.mockResolvedValueOnce(result)
    vi.stubGlobal('fetch', fetchMock)
    mount()

    await openAndSelect(fetchMock)
    expect((await screen.findByRole('alert')).textContent).toContain(t('copy.unavailable'))
  })

  it('does not publish a copy result after the modal cancels the request', async () => {
    const response = Promise.withResolvers<Response>()
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ recipients }))
      .mockReturnValueOnce(response.promise)
    vi.stubGlobal('fetch', fetchMock)
    mount()
    await openAndSelect(fetchMock)

    fireEvent.click(screen.getByRole('button', { name: en['copy.close'] }))
    response.resolve(new Response(null, { status: 201 }))
    await act(async () => { await response.promise })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('ignores a second confirm while a copy is still in flight', async () => {
    const response = Promise.withResolvers<Response>()
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ recipients }))
      .mockReturnValueOnce(response.promise)
    vi.stubGlobal('fetch', fetchMock)
    mount()
    fireEvent.click(screen.getByRole('button', { name: en['copy.label'] }))
    await screen.findByRole('radio', { name: 'Alpha Bot' })
    fireEvent.click(screen.getByRole('radio', { name: 'Alpha Bot' }))
    const confirm = screen.getByRole('button', { name: en['copy.confirm'] })
    fireEvent.click(confirm)
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2) })
    const copying = screen.getByRole('button', { name: en['copy.copying'] })
    copying.disabled = false
    fireEvent.click(copying)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: en['copy.close'] }))
    response.resolve(new Response(null, { status: 201 }))
    await act(async () => { await response.promise })
  })

  it('does not publish an error after cancellation while decoding the copy response', async () => {
    const json = Promise.withResolvers<unknown>()
    const result = { status: 409, json: () => json.promise } as Response
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ recipients }))
      .mockResolvedValueOnce(result)
    vi.stubGlobal('fetch', fetchMock)
    mount()
    await openAndSelect(fetchMock)

    fireEvent.click(screen.getByRole('button', { name: en['copy.close'] }))
    json.resolve({ status: 'exists' })
    await act(async () => { await json.promise })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not copy when the selected recipient disappeared before confirmation', async () => {
    const roster = [...recipients]
    const rosterResponse = { ok: true, json: () => Promise.resolve({ recipients: roster }) } as Response
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(rosterResponse)
    vi.stubGlobal('fetch', fetchMock)
    mount()
    fireEvent.click(screen.getByRole('button', { name: en['copy.label'] }))
    await screen.findByRole('radio', { name: 'Alpha Bot' })
    fireEvent.click(screen.getByRole('radio', { name: 'Alpha Bot' }))
    roster.length = 0
    fireEvent.click(screen.getByRole('button', { name: en['copy.confirm'] }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale confirmation after the modal closes', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ recipients }))
    vi.stubGlobal('fetch', fetchMock)
    mount()
    fireEvent.click(screen.getByRole('button', { name: en['copy.label'] }))
    await screen.findByRole('radio', { name: 'Alpha Bot' })
    const confirm = screen.getByRole('button', { name: en['copy.confirm'] })
    const staleClick = reactClickOf(confirm)
    fireEvent.click(screen.getByRole('button', { name: en['copy.close'] }))
    staleClick()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not publish a copy failure after cancellation rejects the request', async () => {
    const response = Promise.withResolvers<Response>()
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ recipients }))
      .mockReturnValueOnce(response.promise)
    vi.stubGlobal('fetch', fetchMock)
    mount()
    await openAndSelect(fetchMock)

    fireEvent.click(screen.getByRole('button', { name: en['copy.close'] }))
    response.reject(new DOMException('Aborted', 'AbortError'))
    await expect(response.promise).rejects.toThrow('Aborted')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('abandons a pending roster read when the preview lifetime closes', async () => {
    const response = Promise.withResolvers<Response>()
    const lifetime = new AbortController()
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(response.promise)
    vi.stubGlobal('fetch', fetchMock)
    mount(lifetime)

    fireEvent.click(screen.getByRole('button', { name: en['copy.label'] }))
    expect((await screen.findByRole('status')).textContent).toContain(en['copy.loading'])
    lifetime.abort()
    response.resolve(jsonResponse({ recipients }))
    await act(async () => { await response.promise })
    expect(screen.queryByRole('radio')).toBeNull()
  })

  it('ignores a roster rejection after the preview lifetime closes', async () => {
    const response = Promise.withResolvers<Response>()
    const lifetime = new AbortController()
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(response.promise)
    vi.stubGlobal('fetch', fetchMock)
    mount(lifetime)

    fireEvent.click(screen.getByRole('button', { name: en['copy.label'] }))
    await screen.findByRole('status')
    lifetime.abort()
    response.reject(new DOMException('Aborted', 'AbortError'))
    await expect(response.promise).rejects.toThrow('Aborted')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
