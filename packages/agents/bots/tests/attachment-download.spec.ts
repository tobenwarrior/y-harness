import { describe, expect, it, vi } from 'vitest'
import { handleBotAttachmentDownload } from '../src/attachment-download.ts'

const downloadUrl = 'http://example.test/download?groupId=bot-group-one&messageId=bot-group-message-one&attachmentId=opaque'

describe('Bot attachment download route', () => {
  it('accepts only GET requests', async () => {
    const open = vi.fn()
    const response = await handleBotAttachmentDownload(new Request(downloadUrl, { method: 'POST' }), open)
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
    expect(open).not.toHaveBeenCalled()
  })

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
    const response = await handleBotAttachmentDownload(new Request(downloadUrl), open)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.text()).toBe('hello')
    expect(open).toHaveBeenCalledOnce()
  })

  it('does not report a storage failure as a missing attachment', async () => {
    const response = await handleBotAttachmentDownload(new Request(downloadUrl), async () => {
      throw new Error('storage is unavailable')
    })
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('storage is unavailable')
  })

  it.each([
    [{ isDSHRemoteError: true, code: 'gateway/forbidden' }, 404],
    [{ code: 'not-found' }, 404],
    [{ code: 17 }, 500],
  ] as const)('returns a safe response for attachment open failure %j', async (failure, status) => {
    const open = vi.fn().mockRejectedValue(failure)
    const response = await handleBotAttachmentDownload(new Request(downloadUrl), open)
    expect(response.status).toBe(status)
    expect(await response.text()).toBe('Attachment unavailable')
  })

  it('reports a failure while reading the authorized attachment stream', async () => {
    const response = await handleBotAttachmentDownload(new Request(downloadUrl), async () => ({
      name: 'notes.txt',
      data: (async function* () {
        yield Uint8Array.of(1)
        throw new Error('attachment stream failed')
      })(),
    }))
    await expect(response.arrayBuffer()).rejects.toThrow('attachment stream failed')
  })

  it('releases the attachment iterator when the consumer cancels', async () => {
    const chunk = Uint8Array.of(1)
    const release = vi.fn(async () => ({ done: true, value: undefined } as const))
    const response = await handleBotAttachmentDownload(new Request(downloadUrl), async () => ({
      name: 'notes.txt',
      data: {
        [Symbol.asyncIterator]() {
          return {
            next: async () => ({ done: false, value: chunk } as const),
            return: release,
          }
        },
      },
    }))
    if (response.body === null) throw new Error('Expected an attachment stream')
    const reader = response.body.getReader()
    await expect(reader.read()).resolves.toEqual({ done: false, value: chunk })
    expect(release).not.toHaveBeenCalled()
    await reader.cancel()
    expect(release).toHaveBeenCalledOnce()
  })
})
