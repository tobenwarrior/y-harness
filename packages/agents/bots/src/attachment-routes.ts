/** Streaming Bot attachment upload adapters for operator and shared routes. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { BotGroupError, BotGroupId, BotGroupMessageId } from './group-chat.ts'
import { BotAttachmentGrantError, BotPrivateMessageId } from './attachment-grants.ts'
import type { BotAttachmentGrantValue } from './attachment-grants.ts'
import { BotId } from './types.ts'
import { remoteErrorOf } from '@yharness/typert-protocol'

/** Exact operator route for owner-local Bot group file uploads. */
export const BOT_GROUP_ATTACHMENT_UPLOAD_PATH = '/api/bots/group/uploadAttachment' as const

/** Exact collaborator route for shared private/group file uploads. */
export const SHARED_BOT_ATTACHMENT_UPLOAD_PATH = '/shared-bots/bots/share/uploadAttachment' as const

/** Maximum bytes admitted by one streamed Bot attachment upload. */
export const BOT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024
/** Wall-clock limit for one streamed Bot attachment upload. */
export const BOT_ATTACHMENT_UPLOAD_TIMEOUT_MS = 60_000

/** Bound one backpressured attachment stream before it reaches a provider. */
export async function* boundedBotAttachmentStream(
  data: AsyncIterable<Uint8Array>,
  maxBytes = BOT_ATTACHMENT_MAX_BYTES,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new BotAttachmentGrantError('invalid', 'attachment upload byte limit is invalid')
  }
  const iterator = data[Symbol.asyncIterator]()
  let bytes = 0
  let completed = false
  try {
    while (true) {
      const result = signal === undefined
        ? await iterator.next()
        : await nextAttachmentChunk(iterator, signal)
      if (result.done) {
        completed = true
        return
      }
      const chunk = result.value
      signal?.throwIfAborted()
      if (!(chunk instanceof Uint8Array)) {
        throw new BotAttachmentGrantError('invalid', 'attachment upload data is invalid')
      }
      bytes += chunk.byteLength
      if (bytes > maxBytes) {
        throw new BotAttachmentGrantError('invalid', 'attachment upload exceeds the byte limit')
      }
      yield chunk
    }
  } finally {
    if (!completed && iterator.return !== undefined) {
      void Promise.resolve(iterator.return()).catch(() => undefined)
    }
  }
}

/** Combine the authenticated request cancellation with the upload deadline. */
export function botAttachmentUploadSignal(signal: AbortSignal, timeoutMs = BOT_ATTACHMENT_UPLOAD_TIMEOUT_MS): AbortSignal {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new BotAttachmentGrantError('invalid', 'attachment upload timeout is invalid')
  }
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
}

/** Parsed file-upload target before the caller-specific ACL provider runs. */
export type BotAttachmentUploadTarget =
  | {
    readonly kind: 'group'
    readonly groupId: ReturnType<typeof BotGroupId>
    readonly messageId: ReturnType<typeof BotGroupMessageId>
    readonly targetBotIds: readonly BotId[] | undefined
  }
  | {
    readonly kind: 'private'
    readonly botId: BotId
    readonly messageId: ReturnType<typeof BotPrivateMessageId>
  }

/** Provider callback that admits one exact streamed file scope. */
export type BotAttachmentUploadAdmission = (
  target: BotAttachmentUploadTarget,
  data: AsyncIterable<Uint8Array>,
  name: string | undefined,
  signal: AbortSignal,
) => Promise<BotAttachmentGrantValue>

/**
 * Handle one fetch-shaped file upload after the route has authenticated its caller.
 * @param request - Authenticated streaming upload request.
 * @param admit - Scope-aware provider admission callback.
 * @returns An opaque grant response or a safe gateway error response.
 */
export async function handleBotAttachmentUpload(
  request: Request,
  admit: BotAttachmentUploadAdmission,
): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/octet-stream') {
    return new Response('content type must be application/octet-stream', { status: 415 })
  }
  let target: BotAttachmentUploadTarget
  try {
    target = parseUploadTarget(new URL(request.url))
  } catch (error: unknown) {
    return new Response(error instanceof Error ? error.message : String(error), { status: 400 })
  }
  const name = new URL(request.url).searchParams.get('name') ?? undefined
  try {
    const uploadSignal = botAttachmentUploadSignal(request.signal)
    const value = await admit(target, requestBodyChunks(request.body, uploadSignal), name, uploadSignal)
    return jsonResponse({ ok: true, value })
  } catch (error: unknown) {
    const failure = uploadFailure(error)
    return jsonResponse({
      ok: false,
      error: failure,
    })
  }
}

function uploadFailure(error: unknown): { readonly code: string; readonly message: string; readonly details: Record<string, never> } {
  const remote = remoteErrorOf(error)
  if (remote !== undefined) return { code: remote.code, message: remote.message, details: {} }
  if (error instanceof BotAttachmentGrantError) {
    const code = error.code === 'invalid' ? 'gateway/bad-request'
      : error.code === 'not-found' ? 'gateway/not-found'
        : error.code === 'forbidden' ? 'gateway/forbidden' : 'gateway/conflict'
    return { code, message: error.message, details: {} }
  }
  if (error instanceof BotGroupError) {
    const code = error.code === 'invalid' ? 'gateway/bad-request'
      : error.code === 'not-found' || error.code === 'member-not-found' ? 'gateway/not-found'
        : 'gateway/unavailable'
    return { code, message: error.message, details: {} }
  }
  if (error !== null && typeof error === 'object' && 'code' in error
    && typeof error.code === 'string'
    && ['gateway/bad-request', 'gateway/conflict', 'gateway/forbidden', 'gateway/not-found', 'gateway/unavailable'].includes(error.code)
    && 'message' in error && typeof error.message === 'string') {
    return { code: error.code, message: error.message, details: {} }
  }
  return { code: 'gateway/internal', message: 'Bot attachment upload failed', details: {} }
}

/**
 * Bridge one authenticated streaming Fetch route to the node:http WebServer.
 * @param req - Authenticated incoming upload request.
 * @param res - HTTP response to receive the Fetch result.
 * @param fetch - Fetch-shaped route handler.
 * @returns Completion after the response has been written.
 */
export async function bridgeBotAttachmentRequest(
  req: IncomingMessage,
  res: ServerResponse,
  fetch: (request: Request) => Promise<Response>,
): Promise<void> {
  const abort = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([, value]) => typeof value === 'string') as [string, string][],
  )
  const request = new Request(url, {
    method: req.method ?? 'GET',
    headers,
    body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
    signal: abort.signal,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
  const response = await fetch(request)
  const responseHeaders = Object.fromEntries(response.headers.entries())
  res.writeHead(response.status, responseHeaders)
  if (response.body === null) {
    res.end()
    return
  }
  for await (const chunk of response.body) {
    if (abort.signal.aborted) continue
    if (!res.write(chunk) && !res.destroyed) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          res.off('drain', done)
          res.off('close', done)
          resolve()
        }
        res.once('drain', done)
        res.once('close', done)
      })
    }
  }
  res.end()
}

function parseUploadTarget(url: URL): BotAttachmentUploadTarget {
  const scope = url.searchParams.get('scope')
  const messageId = url.searchParams.get('messageId')
  if (messageId === null) throw new Error('messageId is required')
  const targets = url.searchParams.getAll('targetBotId')
  if (targets.length > 6 || new Set(targets).size !== targets.length) throw new Error('targetBotId is invalid')
  const targetBotIds = targets.length === 0 ? undefined : targets.map((value) => {
    if (!/^bot-[A-Za-z0-9][A-Za-z0-9-]*$/.test(value)) throw new Error('targetBotId is invalid')
    return BotId(value)
  })
  if (scope === 'group') {
    const groupId = url.searchParams.get('groupId')
    if (groupId === null) throw new Error('groupId is required')
    if (!/^bot-group-[A-Za-z0-9][A-Za-z0-9-]*$/.test(groupId)) throw new Error('groupId is invalid')
    if (!/^bot-group-message-[A-Za-z0-9][A-Za-z0-9-]*$/.test(messageId)) throw new Error('messageId is invalid')
    return {
      kind: 'group', groupId: BotGroupId(groupId), messageId: BotGroupMessageId(messageId), targetBotIds,
    }
  }
  if (scope === 'private') {
    const botId = url.searchParams.get('botId')
    if (botId === null) throw new Error('botId is required')
    if (!/^bot-[A-Za-z0-9][A-Za-z0-9-]*$/.test(botId)) throw new Error('botId is invalid')
    if (!/^bot-private-message-[A-Za-z0-9][A-Za-z0-9-]*$/.test(messageId)) throw new Error('messageId is invalid')
    if (targetBotIds !== undefined) throw new Error('targetBotId is not valid for private uploads')
    return { kind: 'private', botId: BotId(botId), messageId: BotPrivateMessageId(messageId) }
  }
  throw new Error('scope must be group or private')
}

async function* requestBodyChunks(body: ReadableStream<Uint8Array> | null, signal?: AbortSignal): AsyncIterable<Uint8Array> {
  if (body === null) return
  const reader = body.getReader()
  const cancel = (): void => { void reader.cancel(signal?.reason).catch(() => undefined) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal?.throwIfAborted()
      const chunk = await reader.read()
      signal?.throwIfAborted()
      if (chunk.done) return
      yield chunk.value
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

/** Race one provider/body iterator read with request cancellation. */
function nextAttachmentChunk(
  iterator: AsyncIterator<Uint8Array>,
  signal: AbortSignal,
): Promise<IteratorResult<Uint8Array>> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
    const onAbort = (): void => {
      cleanup()
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void iterator.next().then(
      (result) => { cleanup(); resolve(result) },
      (error) => { cleanup(); reject(error) },
    )
  })
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
