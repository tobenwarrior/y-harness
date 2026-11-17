import { brandString } from '@yharness/brand'
import type { BotAttachmentGrantId } from '@yharness/bots/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { admitBotGroupAttachments } from '../src/client/attachment-client.ts'
import type { BotGroupAttachmentDraft } from '../src/client/types.ts'

function draft(name: string, type: string, bytes = [1, 2, 3]): BotGroupAttachmentDraft {
  return {
    id: `draft-${name}`,
    file: new File([new Uint8Array(bytes)], name, { type }),
    state: 'ready',
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Bot group attachment admission', () => {
  it('uses the owner or shared image admission callback for supported images', async () => {
    const admitImage = vi.fn<Parameters<typeof admitBotGroupAttachments>[2]>(async () => ({
      grantId: brandString<BotAttachmentGrantId>('bot-attachment-grant-image'),
      attachments: [{ type: 'image' as const, mediaType: 'image/png' as const, bytes: 3, width: 1, height: 1 }],
    }))
    const fetcher = vi.fn<typeof fetch>()

    await expect(admitBotGroupAttachments(
      { groupId: 'bot-group-one', messageId: 'bot-group-message-one', targetBotIds: ['bot-two'] },
      [draft('image.png', 'image/png')],
      admitImage,
      fetcher,
      '/api/bots/group/uploadAttachment',
    )).resolves.toEqual(['bot-attachment-grant-image'])

    expect(admitImage).toHaveBeenCalledOnce()
    expect(admitImage.mock.calls[0]?.[0]).toMatchObject({
      groupId: 'bot-group-one', messageId: 'bot-group-message-one', targetBotIds: ['bot-two'],
      image: { mediaType: 'image/png', name: 'image.png', data: 'AQID' },
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('streams files with the exact message scope and parses the opaque grant', async () => {
    const admitImage = vi.fn()
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      ok: true,
      value: {
        grantId: 'bot-attachment-grant-file',
        attachments: [{ type: 'file', name: 'brief.txt', bytes: 3 }],
      },
    }), { headers: { 'content-type': 'application/json' } }))

    await expect(admitBotGroupAttachments(
      { groupId: 'bot-group-one', messageId: 'bot-group-message-one', targetBotIds: ['bot-two'] },
      [draft('brief.txt', 'text/plain')],
      admitImage,
      fetcher,
      '/shared-bots/bots/share/uploadAttachment',
    )).resolves.toEqual(['bot-attachment-grant-file'])

    const [url, init] = fetcher.mock.calls[0] ?? []
    if (!(url instanceof URL)) throw new Error('Expected a structured upload URL')
    expect(url.pathname).toBe('/shared-bots/bots/share/uploadAttachment')
    expect(url.searchParams.get('scope')).toBe('group')
    expect(url.searchParams.get('groupId')).toBe('bot-group-one')
    expect(url.searchParams.get('messageId')).toBe('bot-group-message-one')
    expect(url.searchParams.getAll('targetBotId')).toEqual(['bot-two'])
    expect(url.searchParams.get('name')).toBe('brief.txt')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('content-type')).toBe('application/octet-stream')
    await expect(new Response(init?.body).arrayBuffer()).resolves.toEqual(new Uint8Array([1, 2, 3]).buffer)
  })

  it('rejects malformed upload responses instead of forwarding an unknown grant', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true, value: { grantId: 'not-a-grant' } }), {
      headers: { 'content-type': 'application/json' },
    }))

    await expect(admitBotGroupAttachments(
      { groupId: 'bot-group-one', messageId: 'bot-group-message-one' },
      [draft('brief.txt', 'text/plain')],
      vi.fn(),
      fetcher,
      '/api/bots/group/uploadAttachment',
    )).rejects.toThrow('invalid attachment grant response')
  })
})
