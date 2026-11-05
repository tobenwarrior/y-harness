import { describe, expect, it, vi } from 'vitest'
import { handleBotAttachmentDownload } from '../src/attachment-download.ts'

describe('Bot attachment download route', () => {
  it('requires a message-scoped request before reading bytes', async () => {
    const open = vi.fn()
    const response = await handleBotAttachmentDownload(
      new Request('http://example.test/download?groupId=bot-group-one&attachmentId=opaque'), open,
    )
    expect(response.status).toBe(400)
    expect(open).not.toHaveBeenCalled()
  })

  it('returns only the bytes authorized for the requested message', async () => {
    const open = vi.fn(async () => ({
      name: 'notes.txt',
      data: (async function* () { yield new TextEncoder().encode('hello') })(),
    }))
    const response = await handleBotAttachmentDownload(new Request(
      'http://example.test/download?groupId=bot-group-one&messageId=bot-group-message-one&attachmentId=opaque',
    ), open)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.text()).toBe('hello')
    expect(open).toHaveBeenCalledOnce()
  })

  it('does not report a storage failure as a missing attachment', async () => {
    const response = await handleBotAttachmentDownload(new Request(
      'http://example.test/download?groupId=bot-group-one&messageId=bot-group-message-one&attachmentId=opaque',
    ), async () => { throw new Error('storage is unavailable') })
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('storage is unavailable')
  })
})
