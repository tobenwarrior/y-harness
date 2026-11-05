/** Message-scoped streaming downloads for Bot group attachments. */

import { BotGroupId, BotGroupMessageId } from './group-chat.ts'
import { remoteErrorOf } from '@yharness/typert-protocol'

/** Exact message and opaque provider identity requested by a download. */
export interface BotAttachmentDownloadTarget {
  readonly groupId: ReturnType<typeof BotGroupId>
  readonly messageId: ReturnType<typeof BotGroupMessageId>
  readonly attachmentId: string
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
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const query = new URL(request.url).searchParams
  const groupId = query.get('groupId')
  const messageId = query.get('messageId')
  const attachmentId = query.get('attachmentId')
  if (query.getAll('groupId').length !== 1 || query.getAll('messageId').length !== 1
    || query.getAll('attachmentId').length !== 1
    || groupId === null || !/^bot-group-[A-Za-z0-9][A-Za-z0-9-]*$/.test(groupId)
    || messageId === null || !/^bot-group-message-[A-Za-z0-9][A-Za-z0-9-]*$/.test(messageId)
    || attachmentId === null || attachmentId.length < 1 || attachmentId.length > 512
    || attachmentId.trim() !== attachmentId || /[\u0000-\u001f\u007f]/.test(attachmentId)) {
    return new Response('Invalid attachment request', { status: 400 })
  }
  let file: BotAttachmentDownload
  try {
    file = await open({ groupId: BotGroupId(groupId), messageId: BotGroupMessageId(messageId), attachmentId }, request.signal)
  } catch (error: unknown) {
    const code = remoteErrorOf(error)?.code
      ?? (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined)
    const missing = code === 'gateway/forbidden' || code === 'gateway/not-found'
    return new Response('Attachment unavailable', { status: missing ? 404 : 500 })
  }
  const iterator = file.data[Symbol.asyncIterator]()
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        request.signal.throwIfAborted()
        const next = await iterator.next()
        if (next.done) controller.close()
        else controller.enqueue(next.value)
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel() { await iterator.return?.() },
  })
  const safeName = encodeURIComponent(file.name.replace(/[\u0000-\u001f\u007f]/g, '_'))
  return new Response(stream, { headers: {
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="download"; filename*=UTF-8''${safeName}`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  } })
}
