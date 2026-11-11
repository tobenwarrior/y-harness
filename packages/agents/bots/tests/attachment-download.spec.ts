import { RemoteError } from '@yharness/typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  BOT_GROK_HISTORY_ATTACHMENT_DOWNLOAD_PATH,
  handleBotAttachmentDownload,
  handleBotGrokHistoryAttachmentDownload,
} from '../src/attachment-download.ts'
import { BotId } from '../src/types.ts'

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
    expect(response.headers.get('cache-control')).toBe('no-store')
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

  it('authorizes a Grok history attachment by exact Bot, source, and sequence', async () => {
    const open = vi.fn(async (target) => {
      expect(target).toEqual({ botId: 'bot-history', sourceId: 'supplemental source', sourceSequence: 0 })
      return {
        name: "Owner's report (final).txt",
        data: (async function* () { yield new TextEncoder().encode('history attachment') })(),
      }
    })
    const response = await handleBotGrokHistoryAttachmentDownload(new Request(
      `http://example.test${BOT_GROK_HISTORY_ATTACHMENT_DOWNLOAD_PATH}?botId=bot-history&sourceId=supplemental+source&sourceSequence=0`,
    ), open)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store, no-transform')
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''Owner%27s%20report%20%28final%29.txt")
    expect(await response.text()).toBe('history attachment')
    expect(open).toHaveBeenCalledOnce()
  })

  it('rejects malformed or repeated Grok history identity fields before opening bytes', async () => {
    const open = vi.fn()
    const base = `http://example.test${BOT_GROK_HISTORY_ATTACHMENT_DOWNLOAD_PATH}`
    for (const query of [
      '?sourceId=primary&sourceSequence=0&unexpected=1',
      '?botId=bot-history&sourceSequence=0&unexpected=1',
      '?botId=bot-history&sourceId=primary&unexpected=1',
      '?botId=invalid&sourceId=primary&sourceSequence=0',
      '?botId=bot-history&sourceId=primary&sourceSequence=-1',
      '?botId=bot-history&sourceId=primary&sourceSequence=1.5',
      '?botId=bot-history&sourceId=primary&sourceSequence=9007199254740992',
      '?botId=bot-history&sourceId=primary&sourceSequence=0&sourceSequence=1',
      '?botId=bot-history&sourceId=primary&sourceSequence=0&unexpected=1',
      `?botId=bot-history&sourceId=${'x'.repeat(129)}&sourceSequence=0`,
      '?botId=bot-history&sourceId=%0Aprimary&sourceSequence=0',
    ]) {
      const response = await handleBotGrokHistoryAttachmentDownload(new Request(`${base}${query}`), open)
      expect(response.status).toBe(400)
    }
    expect(open).not.toHaveBeenCalled()
  })

  it('closes an opened Grok stream when the response is cancelled', async () => {
    let returned = false
    const open = vi.fn(async () => ({
      name: 'large.bin',
      data: {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ value: Uint8Array.of(1), done: false }),
          return: async () => {
            returned = true
            return { done: true as const, value: undefined }
          },
        }),
      },
    }))
    const response = await handleBotGrokHistoryAttachmentDownload(new Request(
      `http://example.test${BOT_GROK_HISTORY_ATTACHMENT_DOWNLOAD_PATH}?botId=bot-history&sourceId=primary&sourceSequence=1`,
    ), open)
    await response.body?.cancel()
    expect(returned).toBe(true)
  })

  it('keeps method and authorization errors generic and uncached', async () => {
    const url = `http://example.test${BOT_GROK_HISTORY_ATTACHMENT_DOWNLOAD_PATH}?botId=bot-history&sourceId=primary&sourceSequence=1`
    const open = vi.fn()
    const wrongMethod = await handleBotGrokHistoryAttachmentDownload(new Request(url, { method: 'POST' }), open)
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('GET')
    expect(open).not.toHaveBeenCalled()
    for (const error of [
      new RemoteError('bot/not-found', 'Private Bot identity', { botId: BotId('bot-history') }),
      { code: 'forbidden' },
      { code: 123 },
    ]) {
      const response = await handleBotGrokHistoryAttachmentDownload(new Request(url), async () => { throw error })
      expect(response.status).toBe(error.code === 123 ? 500 : 404)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.text()).toBe('Attachment unavailable')
    }
  })

  it('closes the underlying file once on disconnect or stream failure', async () => {
    const url = `http://example.test${BOT_GROK_HISTORY_ATTACHMENT_DOWNLOAD_PATH}?botId=bot-history&sourceId=primary&sourceSequence=1`
    for (const disconnect of [true, false]) {
      const abort = new AbortController()
      const close = vi.fn(async () => { throw new Error('already closed') })
      const next = async (): Promise<IteratorResult<Uint8Array>> => {
        if (!disconnect) throw new Error('file read failed')
        return { value: Uint8Array.of(1), done: false }
      }
      const response = await handleBotGrokHistoryAttachmentDownload(new Request(url, { signal: abort.signal }), async () => ({
        name: 'report.txt',
        data: { [Symbol.asyncIterator]: () => ({ next, return: close }) },
      }))
      if (disconnect) abort.abort()
      await expect(response.arrayBuffer()).rejects.toThrow(disconnect ? 'aborted' : 'file read failed')
      expect(close).toHaveBeenCalledOnce()
    }
  })
})
