// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { brandString } from '@yharness/brand'
import { makeTranslate } from '@yharness/client-test-runtime'
import { ComputerTeaching } from '../src/client/ComputerTeaching.tsx'
import type { ComputerTeachingClient, ComputerTeachingId, ComputerTeachingTrace } from '../src/client/computer-client.ts'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)
const id = brandString<ComputerTeachingId>('b023da7a-7004-4d17-b7a4-6f691d1d3fe0')
const goal = 'Review a sample quote.'
const evidence: ComputerTeachingTrace = { id, reviewable: true, truncated: true, actions: [
  { kind: 'navigate', origin: 'https://example.test' }, { kind: 'click', x: 12, y: 10, button: 1 },
  { kind: 'drag', x: 1, y: 2, toX: 3, toY: 4 }, { kind: 'scroll', x: 8, y: 7, delta: 1 },
] }

function setup() {
  const teaching = {
    start: vi.fn<ComputerTeachingClient['start']>().mockResolvedValue(id),
    stop: vi.fn<ComputerTeachingClient['stop']>().mockResolvedValue(evidence),
  }
  const sendForDraft = vi.fn<(text: string, id: ComputerTeachingId) => Promise<void>>().mockResolvedValue(undefined)
  const element = (hasControl: boolean) => <ComputerTeaching
    teaching={teaching} viewerId="fixture-viewer" sessionId="fixture-bot" hasControl={hasControl} sendForDraft={sendForDraft} t={t} />
  return { teaching, sendForDraft, element, view: render(element(true)) }
}

function openSetup(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: en.computerTeachTitle }))
  fireEvent.change(screen.getByRole('textbox', { name: en.computerTeachGoal }), { target: { value: goal } })
  return screen.getByRole('button', { name: en.computerTeachStart })
}

async function startRecording(): Promise<HTMLElement> {
  fireEvent.click(openSetup())
  return await screen.findByRole('button', { name: en.computerTeachStop })
}

afterEach(cleanup)

it('sends only explicitly reviewed, bounded actions to draft a skill', async () => {
  const harness = setup()
  fireEvent.click(await startRecording())
  const send = await screen.findByRole('button', { name: en.computerTeachDraftSkill })
  expect(harness.sendForDraft).not.toHaveBeenCalled()
  expect(screen.getByText(en.computerTeachLimit)).toBeTruthy()
  expect(screen.getAllByRole('listitem')).toHaveLength(4)
  fireEvent.change(screen.getByRole('textbox', { name: en.computerTeachGoal }), { target: { value: '' } })
  expect(send).toHaveProperty('disabled', true)
  fireEvent.change(screen.getByRole('textbox', { name: en.computerTeachGoal }), { target: { value: goal } })
  fireEvent.click(send)
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(harness.sendForDraft).toHaveBeenCalledOnce()
  expect(harness.sendForDraft.mock.calls[0]?.[0]).toContain('Show the skill draft here for review')
  expect(harness.sendForDraft.mock.calls[0]?.[0]).toContain(goal)
  expect(harness.sendForDraft.mock.calls[0]?.[0]).toContain('Opened https://example.test')
  expect(harness.sendForDraft.mock.calls[0]?.[1]).toBe(id)
})

it('preserves the review if submission fails and never sends it on dismissal', async () => {
  const harness = setup()
  harness.sendForDraft.mockRejectedValueOnce(new Error('network unavailable'))
  fireEvent.click(await startRecording())
  const send = await screen.findByRole('button', { name: en.computerTeachDraftSkill })
  fireEvent.click(send)
  await screen.findByText(en.computerTeachSendFailed)
  expect(screen.getByText('Opened https://example.test')).toBeTruthy()
  expect(screen.getByRole('textbox', { name: en.computerTeachGoal })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: en.cancel }))
  expect(harness.sendForDraft).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('keeps failed start and stop attempts visible and accepts a safe retry', async () => {
  const harness = setup()
  harness.teaching.start.mockRejectedValueOnce(new Error('control changed'))
  harness.teaching.stop.mockRejectedValueOnce(new Error('transport interrupted')).mockResolvedValueOnce({ ...evidence, truncated: false, actions: [] })
  const start = openSetup()
  fireEvent.click(start)
  await screen.findByText(en.computerTeachStartFailed)
  fireEvent.click(start)
  const stop = await screen.findByRole('button', { name: en.computerTeachStop })
  fireEvent.click(stop)
  await screen.findByText(en.computerTeachStopFailed)
  fireEvent.click(stop)
  await screen.findByText(en.computerTeachEmpty)
  expect(screen.getByRole('button', { name: en.computerTeachDraftSkill })).toHaveProperty('disabled', true)
  expect(harness.sendForDraft).not.toHaveBeenCalled()
})

it.each([
  { ...evidence, reviewable: false },
  { ...evidence, id: brandString<ComputerTeachingId>('other-recording') },
])('discards a different or interrupted recording', async (trace) => {
  const harness = setup()
  harness.teaching.stop.mockResolvedValueOnce(trace)
  fireEvent.click(await startRecording())
  await screen.findByText(en.computerTeachInterrupted)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(harness.sendForDraft).not.toHaveBeenCalled()
})

it('aborts a pending review when the Browser lease is lost', async () => {
  const harness = setup()
  const stopResponse = Promise.withResolvers<ComputerTeachingTrace>()
  harness.teaching.stop.mockReturnValueOnce(stopResponse.promise)
  fireEvent.click(await startRecording())
  harness.view.rerender(harness.element(false))
  await screen.findByText(en.computerTeachInterrupted)
  expect(harness.teaching.stop.mock.calls[0]?.[2].aborted).toBe(true)
  await act(async () => { stopResponse.resolve(evidence); await stopResponse.promise })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: en.computerTeachTitle })).toBeNull()
  expect(harness.sendForDraft).not.toHaveBeenCalled()
})

it('holds the setup through a pending start and ignores stale completion after unmount', async () => {
  const harness = setup()
  const pending = Promise.withResolvers<ComputerTeachingId>()
  harness.teaching.start.mockReturnValueOnce(pending.promise)
  const start = openSetup()
  act(() => { start.click(); start.click() })
  expect(harness.teaching.start).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(screen.getByRole('dialog', { name: en.computerTeachTitle })).toBeTruthy()
  harness.view.unmount()
  expect(harness.teaching.start.mock.calls[0]?.[2].aborted).toBe(true)
  await act(async () => { pending.resolve(id); await pending.promise })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('ignores a request rejection and a queued draft result after their owners unmount', async () => {
  const first = setup()
  const pending = Promise.withResolvers<ComputerTeachingId>()
  first.teaching.start.mockReturnValueOnce(pending.promise)
  fireEvent.click(openSetup())
  first.view.unmount()
  await act(async () => {
    pending.reject(new Error('request aborted'))
    await expect(pending.promise).rejects.toThrow('request aborted')
  })
  expect(screen.queryByRole('alert')).toBeNull()

  const second = setup()
  const send = Promise.withResolvers<undefined>()
  second.sendForDraft.mockReturnValueOnce(send.promise)
  fireEvent.click(await startRecording())
  fireEvent.click(await screen.findByRole('button', { name: en.computerTeachDraftSkill }))
  second.view.unmount()
  await act(async () => { send.resolve(undefined); await send.promise })
  expect(second.sendForDraft).toHaveBeenCalledOnce()
})
