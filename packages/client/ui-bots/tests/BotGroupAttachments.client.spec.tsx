// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BotGroupAttachments } from '../src/client/BotGroupAttachments.tsx'
import type { BotGroupAttachmentDraft } from '../src/client/types.ts'

afterEach(cleanup)

const labels = {
  picker: 'Attach files',
  input: 'Choose files',
  attachments: 'Selected attachments',
  file: 'File',
  preview: (name: string) => `Preview ${name}`,
  remove: (name: string) => `Remove ${name}`,
  retry: (name: string) => `Retry ${name}`,
  failed: 'Attachment failed',
  uploading: 'Preparing attachment',
  lightbox: { dialog: 'Image preview', close: 'Close preview' },
} as const

function draft(id: string, name: string, state: BotGroupAttachmentDraft['state'] = 'ready'): BotGroupAttachmentDraft {
  return {
    id,
    file: new File([Uint8Array.of(1, 2)], name, { type: name.endsWith('.png') ? 'image/png' : 'text/plain' }),
    ...(name.endsWith('.png') ? { previewUrl: `blob:${id}` } : {}),
    state,
  }
}

describe('BotGroupAttachments', () => {
  it('picks files, renders an image preview, and removes a draft without exposing a path', () => {
    const onAddFiles = vi.fn()
    const onRemove = vi.fn()
    const image = draft('image-1', 'plan.png')
    const view = render(<BotGroupAttachments
      attachments={[image]}
      disabled={false}
      labels={labels}
      onAddFiles={onAddFiles}
      onRemove={onRemove}
    />)

    expect(view.getByRole('group', { name: 'Selected attachments' })).toBeTruthy()
    expect(view.getByRole('button', { name: 'Preview plan.png' })).toBeTruthy()
    expect(view.queryByText('/Users/lucas/plan.png')).toBeNull()

    fireEvent.click(view.getByRole('button', { name: 'Preview plan.png' }))
    expect(view.getByRole('dialog', { name: 'Image preview' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Close preview' }))

    const picked = new File([Uint8Array.of(3)], 'notes.txt', { type: 'text/plain' })
    fireEvent.change(view.getByLabelText('Choose files'), { target: { files: [picked] } })
    expect(onAddFiles).toHaveBeenCalledWith([picked])

    fireEvent.click(view.getByRole('button', { name: 'Remove plan.png' }))
    expect(onRemove).toHaveBeenCalledWith('image-1')
  })

  it('exposes a retry action for a failed draft and keeps picking disabled while sending', () => {
    const onAddFiles = vi.fn()
    const onRetry = vi.fn()
    const failed = draft('failed-1', 'brief.txt', 'error')
    const view = render(<BotGroupAttachments
      attachments={[failed]}
      disabled={false}
      labels={labels}
      onAddFiles={onAddFiles}
      onRemove={vi.fn()}
      onRetry={onRetry}
    />)

    expect(view.getByText('Attachment failed')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Retry brief.txt' }))
    expect(onRetry).toHaveBeenCalledWith('failed-1')

    view.rerender(<BotGroupAttachments
      attachments={[failed]}
      disabled
      labels={labels}
      onAddFiles={onAddFiles}
      onRemove={vi.fn()}
      onRetry={onRetry}
    />)
    expect((view.getByLabelText('Choose files') as HTMLInputElement).disabled).toBe(true)
    expect((view.getByRole('button', { name: 'Attach files' }) as HTMLButtonElement).disabled).toBe(true)
    expect(onAddFiles).not.toHaveBeenCalled()
  })
})
