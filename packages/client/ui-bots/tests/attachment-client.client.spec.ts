import { brandString } from '@yharness/brand'
import type { BotAttachmentGrantId, BotInputAttachmentView } from '@yharness/bots/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  admitBotGroupAttachments,
  groupAttachmentsMatchDrafts,
  parseBotAttachmentGrantValue,
} from '../src/client/attachment-client.ts'
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
  vi.unstubAllGlobals()
})

const groupScope = { groupId: 'bot-group-one', messageId: 'bot-group-message-one' }
const uploadPath = '/api/bots/group/uploadAttachment'
const grantId = brandString<BotAttachmentGrantId>('bot-attachment-grant-fixture')
const fileMetadata = { type: 'file', name: 'brief.txt', bytes: 3 } as const
const imageMetadata = { type: 'image', mediaType: 'image/png', width: 1, height: 1, bytes: 3, name: 'chart.png' } as const

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

  it.each([
    ['an invalid group', { ...groupScope, groupId: 'wrong' }],
    ['an invalid message', { ...groupScope, messageId: 'wrong' }],
    ['too many recipients', { ...groupScope, targetBotIds: Array.from({ length: 7 }, (_, index) => `bot-${index}`) }],
    ['duplicate recipients', { ...groupScope, targetBotIds: ['bot-two', 'bot-two'] }],
    ['an invalid recipient', { ...groupScope, targetBotIds: ['wrong'] }],
  ] as const)('rejects %s before uploading any data', async (_label, scope) => {
    const admitImage = vi.fn()
    const fetcher = vi.fn<typeof fetch>()
    await expect(admitBotGroupAttachments(scope, [draft('brief.txt', 'text/plain')], admitImage, fetcher, uploadPath))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(admitImage).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    [new Error('offline'), 'offline'],
    ['disconnected', 'Bot attachment upload failed'],
  ] as const)('reports an upload transport failure %s', async (error, message) => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(error)
    await expect(admitBotGroupAttachments(groupScope, [draft('brief.txt', 'text/plain')], vi.fn(), fetcher, uploadPath))
      .rejects.toMatchObject({ code: 'gateway/transport', message })
  })

  it.each([
    ['malformed JSON', () => new Response('{'), 'gateway/invalid-response', 'Bot attachment upload returned invalid JSON'],
    ['a non-object payload', () => Response.json([]), 'gateway/invalid-response', 'Bot attachment upload returned an invalid response'],
    ['an HTTP error without details', () => Response.json({ ok: false }, { status: 403 }), 'gateway/http-403', 'Bot attachment upload failed'],
    ['an invalid error code', () => Response.json({ ok: false, error: { code: 1, message: 'wrong' } }, { status: 403 }), 'gateway/http-403', 'Bot attachment upload failed'],
    ['an invalid error message', () => Response.json({ ok: false, error: { code: 'gateway/forbidden', message: 1 } }, { status: 403 }), 'gateway/http-403', 'Bot attachment upload failed'],
    ['a structured error', () => Response.json({ ok: false, error: { code: 'gateway/forbidden', message: 'Sharing ended' } }, { status: 403 }), 'gateway/forbidden', 'Sharing ended'],
  ] as const)('reports %s without forwarding a grant', async (_label, response, code, message) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response())
    await expect(admitBotGroupAttachments(groupScope, [draft('brief.txt', 'text/plain')], vi.fn(), fetcher, uploadPath))
      .rejects.toMatchObject({ code, message })
  })

  it.each([
    [{ origin: 'https://workspace.example.test' }, 'https://workspace.example.test'],
    [{ origin: '' }, 'http://dsh.internal'],
    [undefined, 'http://dsh.internal'],
  ] as const)('omits an empty filename and resolves the authenticated upload origin from %s', async (location, origin) => {
    vi.stubGlobal('location', location)
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, value: { grantId, attachments: [fileMetadata] } }))
    await expect(admitBotGroupAttachments(groupScope, [draft('', 'text/plain')], vi.fn(), fetcher, uploadPath)).resolves.toEqual([grantId])
    const url = fetcher.mock.calls[0]?.[0]
    if (!(url instanceof URL)) throw new Error('Expected a structured upload URL')
    expect(url.origin).toBe(origin)
    expect(url.searchParams.has('name')).toBe(false)
    expect(url.searchParams.getAll('targetBotId')).toEqual([])
  })

  it('omits an empty name on the image route and rejects an invalid image grant', async () => {
    const admitImage = vi.fn<Parameters<typeof admitBotGroupAttachments>[2]>()
      .mockResolvedValue({ grantId: brandString<BotAttachmentGrantId>('invalid'), attachments: [imageMetadata] })
    const fetcher = vi.fn<typeof fetch>()
    await expect(admitBotGroupAttachments(groupScope, [draft('', 'image/png')], admitImage, fetcher, uploadPath))
      .rejects.toMatchObject({ code: 'gateway/invalid-response' })
    expect(admitImage.mock.calls[0]?.[0].image).toEqual({ mediaType: 'image/png', data: 'AQID' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('attachment grant validation', () => {
  it('keeps opaque ids and admitted image metadata', () => {
    expect(parseBotAttachmentGrantValue({ grantId, attachments: [imageMetadata] })).toEqual({ grantId, attachments: [imageMetadata] })
  })

  it.each([
    ['a non-object response', 'response'],
    ['a grant without an id', { attachments: [fileMetadata] }],
    ['a grant with a path', { grantId: 'relative/file', attachments: [fileMetadata] }],
    ['non-array attachments', { grantId, attachments: fileMetadata }],
    ['no attachments', { grantId, attachments: [] }],
    ['too many attachments', { grantId, attachments: Array.from({ length: 9 }, () => fileMetadata) }],
  ] as const)('rejects %s', (_label, input) => {
    expect(parseBotAttachmentGrantValue(input)).toBeUndefined()
  })

  it.each([
    ['a non-object entry', null],
    ['a missing media category', { bytes: 3 }],
    ['a non-number byte count', { ...fileMetadata, bytes: '3' }],
    ['a fractional byte count', { ...fileMetadata, bytes: 1.5 }],
    ['a negative byte count', { ...fileMetadata, bytes: -1 }],
    ['an invalid filename type', { ...fileMetadata, name: false }],
    ['an empty filename', { ...fileMetadata, name: '' }],
    ['an oversized filename', { ...fileMetadata, name: 'a'.repeat(256) }],
    ['an unknown media category', { ...imageMetadata, type: 'svg' }],
    ['an invalid media type', { ...imageMetadata, mediaType: 1 }],
    ['an unsupported image type', { ...imageMetadata, mediaType: 'image/svg+xml' }],
    ['an invalid width', { ...imageMetadata, width: '1' }],
    ['a fractional width', { ...imageMetadata, width: 0.5 }],
    ['a zero width', { ...imageMetadata, width: 0 }],
    ['an invalid height', { ...imageMetadata, height: '1' }],
    ['a fractional height', { ...imageMetadata, height: 0.5 }],
    ['a zero height', { ...imageMetadata, height: 0 }],
    ['an invalid image name type', { ...imageMetadata, name: false }],
    ['an empty image name', { ...imageMetadata, name: '' }],
    ['an oversized image name', { ...imageMetadata, name: 'a'.repeat(256) }],
  ] as const)('rejects a grant with %s', (_label, metadata) => {
    expect(parseBotAttachmentGrantValue({ grantId, attachments: [metadata] })).toBeUndefined()
  })
})

describe('retrying a group send with attachments', () => {
  const admittedFile = { ...fileMetadata, attachmentId: 'fixture-file' }
  const admittedImage = { ...imageMetadata, attachmentId: 'fixture-image' }

  it('requires the same uploaded file metadata and accepts an unnamed local draft', () => {
    const files = [draft('brief.txt', 'text/plain')]
    expect(groupAttachmentsMatchDrafts(undefined, files)).toBe(false)
    expect(groupAttachmentsMatchDrafts([], [])).toBe(false)
    expect(groupAttachmentsMatchDrafts([admittedFile, admittedFile], files)).toBe(false)
    const missing = new Array<BotInputAttachmentView>(1)
    expect(groupAttachmentsMatchDrafts(missing, files)).toBe(false)
    expect(groupAttachmentsMatchDrafts([{ ...admittedFile, bytes: 2 }], files)).toBe(false)
    expect(groupAttachmentsMatchDrafts([{ ...admittedFile, name: 'other.txt' }], files)).toBe(false)
    expect(groupAttachmentsMatchDrafts([admittedFile], files)).toBe(true)
    expect(groupAttachmentsMatchDrafts([admittedFile], [draft('', 'text/plain')])).toBe(true)
  })

  it('requires matching image type and accepts legacy image metadata without a name', () => {
    const images = [draft('chart.png', 'image/png')]
    expect(groupAttachmentsMatchDrafts([admittedImage], [draft('chart.png', 'text/plain')])).toBe(false)
    expect(groupAttachmentsMatchDrafts([admittedImage], [draft('chart.png', 'image/jpeg')])).toBe(false)
    expect(groupAttachmentsMatchDrafts([admittedImage], [draft('other.png', 'image/png')])).toBe(false)
    expect(groupAttachmentsMatchDrafts([admittedImage], images)).toBe(true)
    expect(groupAttachmentsMatchDrafts([admittedImage], [draft('', 'image/png')])).toBe(true)
    const { name, ...withoutName } = admittedImage
    expect(groupAttachmentsMatchDrafts([withoutName], [draft(name, 'image/png')])).toBe(true)
  })
})
