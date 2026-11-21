/** Message-scoped streaming downloads for Bot attachments. */

import { BotGroupId, BotGroupMessageId } from './group-chat.ts'
import { BotId, type BotId as BotIdType } from './types.ts'
import { remoteErrorOf } from '@yharness/typert-protocol'

/** Authenticated shared-group attachment download endpoint. */
export const SHARED_BOT_ATTACHMENT_DOWNLOAD_PATH = '/shared-bots/bots/share/downloadAttachment' as const
/** Authenticated owner-local group attachment download endpoint. */
export const BOT_GROUP_ATTACHMENT_DOWNLOAD_PATH = '/api/bots/group/downloadAttachment' as const
/** Authenticated owner-local Grok history attachment download endpoint. */
export const BOT_GROK_HISTORY_ATTACHMENT_DOWNLOAD_PATH = '/api/bots/grokHistory/downloadAttachment' as const

/** Exact message and opaque provider identity requested by a download. */
export interface BotAttachmentDownloadTarget {
  readonly groupId: ReturnType<typeof BotGroupId>
  readonly messageId: ReturnType<typeof BotGroupMessageId>
  readonly attachmentId: string
}

/** Exact owner Bot, source, and source position requested by a history download. */
export interface BotGrokHistoryAttachmentDownloadTarget {
  readonly botId: BotIdType
  readonly sourceId: string
  readonly sourceSequence: number
}

/** File bytes obtained only after the caller authorizes the message. */
export interface BotAttachmentDownload {
  readonly name: string
  readonly data: AsyncIterable<Uint8Array>
}

/**
 * Serve one authenticated, message-scoped attachment.
 * @param request - Authenticated GET request.
 * @param open - Authorizes the exact message and opens its file.
 * @returns A streamed attachment response or a safe error.
 */
export async function handleBotAttachmentDownload(
  request: Request,
  open: (target: BotAttachmentDownloadTarget, signal: AbortSignal) => Promise<BotAttachmentDownload>,
): Promise<Response> {
  return handleAttachmentDownload(request, parseBotAttachmentDownloadTarget, open)
}

/**
 * Serve one owner-authenticated attachment from an imported Grok archive.
 * @param request - Authenticated GET request.
 * @param open - Authorizes the exact Bot, source, and source position, then opens its file.
 * @returns A streamed attachment response or a safe error.
 */
export async function handleBotGrokHistoryAttachmentDownload(
  request: Request,
  open: (target: BotGrokHistoryAttachmentDownloadTarget, signal: AbortSignal) => Promise<BotAttachmentDownload>,
): Promise<Response> {
  // Keep verified archive downloads out of the Web carrier's compression stream.
  return handleAttachmentDownload(request, parseBotGrokHistoryAttachmentDownloadTarget, open, 'no-store, no-transform')
}

function parseBotAttachmentDownloadTarget(query: URLSearchParams): BotAttachmentDownloadTarget | undefined {
  const groupId = query.get('groupId')
  const messageId = query.get('messageId')
  const attachmentId = query.get('attachmentId')
  if (query.getAll('groupId').length !== 1 || query.getAll('messageId').length !== 1
    || query.getAll('attachmentId').length !== 1
    || groupId === null || !/^bot-group-[A-Za-z0-9][A-Za-z0-9-]*$/.test(groupId)
    || messageId === null || !/^bot-group-message-[A-Za-z0-9][A-Za-z0-9-]*$/.test(messageId)
    || attachmentId === null || attachmentId.length < 1 || attachmentId.length > 512
    || attachmentId.trim() !== attachmentId || /[\u0000-\u001f\u007f]/.test(attachmentId)) return undefined
  return { groupId: BotGroupId(groupId), messageId: BotGroupMessageId(messageId), attachmentId }
}

function parseBotGrokHistoryAttachmentDownloadTarget(query: URLSearchParams): BotGrokHistoryAttachmentDownloadTarget | undefined {
  const botId = query.get('botId')
  const sourceId = query.get('sourceId')
  const sourceSequence = query.get('sourceSequence')
  if (query.size !== 3 || botId === null || !/^bot-[A-Za-z0-9][A-Za-z0-9-]*$/.test(botId)
    || sourceId === null || !isGrokHistorySourceId(sourceId)
    || sourceSequence === null || !/^(?:0|[1-9]\d*)$/.test(sourceSequence)) return undefined
  const sequence = Number(sourceSequence)
  if (!Number.isSafeInteger(sequence)) return undefined
  return { botId: BotId(botId), sourceId, sourceSequence: sequence }
}

function isGrokHistorySourceId(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && value.trim() === value
    && !/[\r\n\u2028\u2029]/u.test(value)
}

async function handleAttachmentDownload<Target>(
  request: Request,
  parse: (query: URLSearchParams) => Target | undefined,
  open: (target: Target, signal: AbortSignal) => Promise<BotAttachmentDownload>,
  successCacheControl = 'no-store',
): Promise<Response> {
  const noStore = { 'cache-control': 'no-store' }
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...noStore, allow: 'GET' } })
  const target = parse(new URL(request.url).searchParams)
  if (target === undefined) return new Response('Invalid attachment request', { status: 400, headers: noStore })
  let file: BotAttachmentDownload
  try {
    file = await open(target, request.signal)
  } catch (error: unknown) {
    const code = remoteErrorOf(error)?.code
      ?? (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined)
    const missing = code === 'gateway/forbidden' || code === 'gateway/not-found'
      || code === 'forbidden' || code === 'not-found' || code === 'bot/not-found'
    return new Response('Attachment unavailable', { status: missing ? 404 : 500, headers: noStore })
  }
  const iterator = file.data[Symbol.asyncIterator]()
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await iterator.return?.()
  }
  const onAbort = (): void => { void close().catch(() => undefined) }
  request.signal.addEventListener('abort', onAbort, { once: true })
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        request.signal.throwIfAborted()
        const next = await iterator.next()
        if (next.done) {
          request.signal.removeEventListener('abort', onAbort)
          controller.close()
        } else controller.enqueue(next.value)
      } catch (error) {
        await close().catch(() => undefined)
        request.signal.removeEventListener('abort', onAbort)
        controller.error(error)
      }
    },
    async cancel() {
      request.signal.removeEventListener('abort', onAbort)
      await close()
    },
  })
  const safeName = encodeURIComponent(file.name.toWellFormed().replace(/[\u0000-\u001f\u007f]/g, '_'))
    .replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16)}`)
  return new Response(stream, { headers: {
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="download"; filename*=UTF-8''${safeName}`,
    'x-content-type-options': 'nosniff',
    'cache-control': successCacheControl,
  } })
}
