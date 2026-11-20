import { Readable } from 'node:stream'
import { ServerResponse } from 'node:http'
import type { IncomingMessage, OutgoingHttpHeader, OutgoingHttpHeaders } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { BotAttachmentGrantError, BotAttachmentGrantId } from '../src/attachment-grants.ts'
import { BotGroupError } from '../src/group-chat.ts'
import {
  BOT_ATTACHMENT_MAX_BYTES,
  BOT_ATTACHMENT_UPLOAD_TIMEOUT_MS,
  bridgeBotAttachmentRequest,
  botAttachmentUploadSignal,
  boundedBotAttachmentStream,
  handleBotAttachmentUpload,
} from '../src/attachment-routes.ts'
import { RemoteError } from '@yharness/typert-protocol'

class FixtureResponse extends ServerResponse {
  status: number | undefined
  headers: Record<string, string> | undefined
  readonly chunks: Uint8Array[] = []
  destroyedWith: Error | undefined
  writeResult = true
  writeFailure: unknown

  constructor() {
    super(bridgeRequest(undefined, undefined, []))
  }

  override writeHead(
    statusCode: number,
    statusMessageOrHeaders?: string | OutgoingHttpHeaders | OutgoingHttpHeader[],
    maybeHeaders?: OutgoingHttpHeaders | OutgoingHttpHeader[],
  ): this {
    this.status = statusCode
    const responseHeaders = typeof statusMessageOrHeaders === 'string' ? maybeHeaders : statusMessageOrHeaders
    if (responseHeaders === undefined || Array.isArray(responseHeaders)) {
      this.headers = undefined
    } else {
      this.headers = Object.fromEntries(Object.entries(responseHeaders).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.join(', ') : String(value),
      ]))
    }
    return this
  }

  override write(chunk: Uint8Array): boolean {
    if (this.writeFailure !== undefined) throw this.writeFailure
    this.chunks.push(chunk)
    return this.writeResult
  }

  override end(): this {
    const status = this.status
    const headers = this.headers
    if (!this.writableEnded) super.end()
    this.status = status
    this.headers = headers
    return this
  }

  override destroy(error?: Error): this {
    this.destroyedWith = error
    return this
  }

  markEnded(): void {
    if (!this.writableEnded) super.end()
  }
}

function bridgeRequest(
  method: string | undefined,
  url: string | undefined,
  chunks: readonly Uint8Array[] = [Uint8Array.of(1, 2, 3)],
): IncomingMessage {
  const request = Readable.from(chunks) as IncomingMessage
  request.method = method
  request.url = url
  request.headers = { 'content-type': 'application/octet-stream', 'x-fixture': ['ignored', 'also-ignored'] }
  return request
}

function uploadRequest(
  url: string,
  options: { readonly method?: string; readonly contentType?: string; readonly body?: BodyInit } = {},
): Request {
  const method = options.method ?? 'POST'
  return new Request(`http://dsh.internal${url}`, {
    method,
    ...(options.contentType === undefined ? {} : { headers: { 'content-type': options.contentType } }),
    ...(options.body === undefined ? {} : { body: options.body }),
  })
}

function fixtureUrlFailure(): never {
  throw 'fixture non-error URL failure'
}

describe('Bot attachment upload route', () => {
  it('accepts a complete bounded stream and rejects invalid limits or chunks', async () => {
    const received: number[] = []
    for await (const chunk of boundedBotAttachmentStream((async function* () {
      yield Uint8Array.of(1, 2)
      yield Uint8Array.of(3)
    })(), 3)) received.push(...chunk)
    expect(received).toEqual([1, 2, 3])
    await expect((async () => {
      for await (const _chunk of boundedBotAttachmentStream((async function* () {
        yield 'not-bytes' as never
      })())) { /* consume */ }
    })()).rejects.toMatchObject({ code: 'invalid' })
    await expect((async () => {
      for await (const _chunk of boundedBotAttachmentStream((async function* () {
        yield Uint8Array.of(1)
      })(), 0)) { /* consume */ }
    })()).rejects.toMatchObject({ code: 'invalid' })
    await expect((async () => {
      for await (const _chunk of boundedBotAttachmentStream((async function* () {
        yield Uint8Array.of(1)
      })(), Number.NaN)) { /* consume */ }
    })()).rejects.toMatchObject({ code: 'invalid' })

    let index = 0
    const explicitResults: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<Uint8Array>> => index++ === 0
          ? { done: false, value: Uint8Array.of(6) }
          : { done: true, value: undefined },
      }),
    }
    const explicit: number[] = []
    for await (const chunk of boundedBotAttachmentStream(explicitResults, 2)) explicit.push(...chunk)
    expect(explicit).toEqual([6])
  })

  it('bounds streamed bytes before the provider can persist an oversized upload', async () => {
    const consume = async (): Promise<void> => {
      for await (const _chunk of boundedBotAttachmentStream((async function* () {
        yield Uint8Array.of(1, 2)
        yield Uint8Array.of(3, 4)
      })(), 3)) { /* consume */ }
    }
    await expect(consume()).rejects.toMatchObject({ code: 'invalid' })
  })

  it('admits 20 MiB of a normal Bot upload and rejects the next byte', async () => {
    const mebibyte = new Uint8Array(1024 * 1024)
    let received = 0
    const consume = async (): Promise<void> => {
      for await (const chunk of boundedBotAttachmentStream((async function* () {
        for (let index = 0; index < 20; index++) yield mebibyte
        yield Uint8Array.of(1)
      })())) received += chunk.byteLength
    }
    await expect(consume()).rejects.toMatchObject({ code: 'invalid' })
    expect(received).toBe(20 * mebibyte.byteLength)
  })

  it('stops waiting for a stalled source when the upload is cancelled', async () => {
    let returned = false
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
        return: async () => {
          returned = true
          return { done: true, value: undefined }
        },
      }),
    }
    const controller = new AbortController()
    const next = boundedBotAttachmentStream(source, 3, controller.signal)[Symbol.asyncIterator]().next()
    controller.abort()
    await expect(next).rejects.toMatchObject({ name: 'AbortError' })
    expect(returned).toBe(true)
  })

  it('closes a cancelled source even when iterator cleanup rejects', async () => {
    const controller = new AbortController()
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
        return: async (): Promise<IteratorResult<Uint8Array>> => { throw new Error('fixture cleanup failed') },
      }),
    }
    const pending = boundedBotAttachmentStream(source, 3, controller.signal)[Symbol.asyncIterator]().next()
    controller.abort('fixture string cancellation')
    await expect(pending).rejects.toThrow('Bot attachment upload was aborted')
    await Promise.resolve()
  })

  it('handles signal-aware source success, pre-cancellation, and non-error iterator failures', async () => {
    const controller = new AbortController()
    await expect((async () => {
      const chunks: number[] = []
      for await (const chunk of boundedBotAttachmentStream((async function* () {
        yield Uint8Array.of(4, 5)
      })(), 4, controller.signal)) chunks.push(...chunk)
      return chunks
    })()).resolves.toEqual([4, 5])

    const preCancelled = new AbortController()
    preCancelled.abort(new Error('fixture pre-cancelled'))
    await expect((async () => {
      for await (const _chunk of boundedBotAttachmentStream((async function* () {
        yield Uint8Array.of(1)
      })(), 4, preCancelled.signal)) { /* consume */ }
    })()).rejects.toThrow('fixture pre-cancelled')

    await expect((async () => {
      const source: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<Uint8Array>> => { throw 'fixture source failure' },
        }),
      }
      for await (const _chunk of boundedBotAttachmentStream(source, 4, new AbortController().signal)) { /* consume */ }
    })()).rejects.toThrow('Bot attachment stream read failed')
    await expect((async () => {
      const source: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<Uint8Array>> => { throw new Error('fixture Error source failure') },
        }),
      }
      for await (const _chunk of boundedBotAttachmentStream(source, 4, new AbortController().signal)) { /* consume */ }
    })()).rejects.toThrow('fixture Error source failure')
  })

  it('combines request cancellation with a bounded upload deadline', () => {
    const controller = new AbortController()
    const signal = botAttachmentUploadSignal(controller.signal, 1)
    expect(signal.aborted).toBe(false)
    controller.abort()
    expect(signal.aborted).toBe(true)
    expect(BOT_ATTACHMENT_UPLOAD_TIMEOUT_MS).toBeGreaterThan(0)
    expect(BOT_ATTACHMENT_MAX_BYTES).toBeGreaterThan(0)
    expect(() => botAttachmentUploadSignal(new AbortController().signal, 0)).toThrow(BotAttachmentGrantError)
    expect(() => botAttachmentUploadSignal(new AbortController().signal, Number.NaN)).toThrow(BotAttachmentGrantError)
  })

  it('rejects non-streaming or malformed scopes before the provider is called', async () => {
    const admit = async (): Promise<never> => { throw new Error('provider must not run') }
    await expect(handleBotAttachmentUpload(uploadRequest('/upload?scope=group&groupId=bot-group-one&messageId=bot-group-message-one', {
      contentType: 'application/json', body: '{}',
    }), admit)).resolves.toMatchObject({ status: 415 })
    await expect(handleBotAttachmentUpload(uploadRequest('/upload?scope=group&groupId=bot-group-one&messageId=bot-group-message-one', {
      method: 'GET', contentType: 'application/octet-stream',
    }), admit)).resolves.toMatchObject({ status: 405 })
    await expect(handleBotAttachmentUpload(uploadRequest('/upload?scope=group&groupId=bot-group-one&messageId=bot-group-message-one', {
      body: 'x',
    }), admit)).resolves.toMatchObject({ status: 415 })
    for (const query of [
      'scope=group&groupId=bot-group-one',
      'scope=group&groupId=bot-group-one&messageId=bot-group-message-one&targetBotId=bot-one&targetBotId=bot-one',
      'scope=group&groupId=bot-group-one&messageId=bot-group-message-one&targetBotId=bad',
      'scope=group&messageId=bot-group-message-one',
      'scope=group&groupId=bad&messageId=bot-group-message-one',
      'scope=group&groupId=bot-group-one&messageId=bad',
      'scope=private&messageId=bot-private-message-one',
      'scope=private&botId=bad&messageId=bot-private-message-one',
      'scope=private&botId=bot-one&messageId=bad',
      'scope=private&botId=bot-one&messageId=bot-private-message-one&targetBotId=bot-two',
      'scope=unknown&messageId=bot-group-message-one',
    ]) {
      await expect(handleBotAttachmentUpload(uploadRequest(`/upload?${query}`, {
        contentType: 'application/octet-stream', body: 'x',
      }), admit)).resolves.toMatchObject({ status: 400 })
    }
    const tooManyTargets = Array.from({ length: 7 }, (_, index) => `targetBotId=bot-${index}`).join('&')
    await expect(handleBotAttachmentUpload(uploadRequest(`/upload?scope=group&groupId=bot-group-one&messageId=bot-group-message-one&${tooManyTargets}`, {
      contentType: 'application/octet-stream', body: 'x',
    }), admit)).resolves.toMatchObject({ status: 400 })

    const nonErrorUrlFailure = uploadRequest('/upload?scope=group&groupId=bot-group-one&messageId=bot-group-message-one', {
      contentType: 'application/octet-stream', body: 'x',
    })
    vi.stubGlobal('URL', fixtureUrlFailure)
    try {
      const response = await handleBotAttachmentUpload(nonErrorUrlFailure, admit)
      expect(response.status).toBe(400)
      await expect(response.text()).resolves.toBe('fixture non-error URL failure')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('passes bounded stream bytes and returns only the opaque grant value', async () => {
    const seen: number[] = []
    const response = await handleBotAttachmentUpload(new Request(
      'http://dsh.internal/bots/group/uploadAttachment?scope=group&groupId=bot-group-one&messageId=bot-group-message-one&targetBotId=bot-two&name=brief.txt',
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array([1, 2, 3]) },
    ), async (target, data, name) => {
      for await (const chunk of data) seen.push(...chunk)
      expect(target).toMatchObject({ kind: 'group', groupId: 'bot-group-one', messageId: 'bot-group-message-one', targetBotIds: ['bot-two'] })
      expect(name).toBe('brief.txt')
      return { grantId: BotAttachmentGrantId('bot-attachment-grant-test'), attachments: [{ type: 'file' as const, name: 'brief.txt', bytes: 3 }] }
    })
    expect(seen).toEqual([1, 2, 3])
    await expect(response.json()).resolves.toEqual({
      ok: true,
      value: { grantId: 'bot-attachment-grant-test', attachments: [{ type: 'file', name: 'brief.txt', bytes: 3 }] },
    })
  })

  it('parses private targets and omits absent names from admission', async () => {
    const seen: number[] = []
    const response = await handleBotAttachmentUpload(uploadRequest(
      '/upload?scope=private&botId=bot-private&messageId=bot-private-message-one',
      { contentType: 'application/octet-stream', body: Uint8Array.of(7, 8) },
    ), async (target, data, name) => {
      for await (const chunk of data) seen.push(...chunk)
      expect(target).toEqual({ kind: 'private', botId: 'bot-private', messageId: 'bot-private-message-one' })
      expect(name).toBeUndefined()
      return { grantId: BotAttachmentGrantId('bot-attachment-grant-private'), attachments: [] }
    })
    expect(seen).toEqual([7, 8])
    await expect(response.json()).resolves.toMatchObject({ ok: true, value: { grantId: 'bot-attachment-grant-private' } })
  })

  it('accepts an empty body and cancels a reader through the request signal', async () => {
    const empty = await handleBotAttachmentUpload(uploadRequest(
      '/upload?scope=private&botId=bot-private&messageId=bot-private-message-empty',
      { contentType: 'application/octet-stream' },
    ), async (_target, data) => {
      const chunks: Uint8Array[] = []
      for await (const chunk of data) chunks.push(chunk)
      expect(chunks).toEqual([])
      return { grantId: BotAttachmentGrantId('bot-attachment-grant-empty'), attachments: [] }
    })
    await expect(empty.json()).resolves.toMatchObject({ ok: true, value: { grantId: 'bot-attachment-grant-empty' } })

    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      start: (streamController) => { streamController.enqueue(Uint8Array.of(1)) },
      cancel: () => { throw new Error('fixture reader cancellation') },
    })
    const request = new Request('http://dsh.internal/upload?scope=private&botId=bot-private&messageId=bot-private-message-cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body,
      signal: controller.signal,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })
    const cancelled = await handleBotAttachmentUpload(request, async (_target, data) => {
      const consume = (async () => {
        for await (const chunk of data) {
          expect([...chunk]).toEqual([1])
          controller.abort('fixture request cancellation')
        }
      })()
      await expect(consume).rejects.toThrow()
      return { grantId: BotAttachmentGrantId('bot-attachment-grant-cancel'), attachments: [] }
    })
    await expect(cancelled.json()).resolves.toMatchObject({ ok: true, value: { grantId: 'bot-attachment-grant-cancel' } })
  })

  it('maps grant scope failures without exposing provider internals', async () => {
    const response = await handleBotAttachmentUpload(new Request(
      'http://dsh.internal/bots/group/uploadAttachment?scope=group&groupId=bot-group-one&messageId=bot-group-message-one',
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array([1]) },
    ), async () => { throw new BotAttachmentGrantError('forbidden', 'grant scope is no longer authorized') })
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: 'gateway/forbidden' } })
  })

  it('maps owner-group admission failures to safe gateway categories', async () => {
    const response = await handleBotAttachmentUpload(new Request(
      'http://dsh.internal/bots/group/uploadAttachment?scope=group&groupId=bot-group-missing&messageId=bot-group-message-one',
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array([1]) },
    ), async () => { throw new BotGroupError('not-found', 'group is missing') })
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: 'gateway/not-found' } })
  })

  it('maps every provider failure category without exposing unsafe diagnostics', async () => {
    const failures: Array<{ readonly thrown: unknown; readonly code: string }> = [
      { thrown: new BotAttachmentGrantError('invalid', 'invalid fixture'), code: 'gateway/bad-request' },
      { thrown: new BotAttachmentGrantError('not-found', 'missing fixture'), code: 'gateway/not-found' },
      { thrown: new BotAttachmentGrantError('conflict', 'conflicting fixture'), code: 'gateway/conflict' },
      { thrown: new BotGroupError('invalid', 'invalid group fixture'), code: 'gateway/bad-request' },
      { thrown: new BotGroupError('member-not-found', 'missing member fixture'), code: 'gateway/not-found' },
      { thrown: new BotGroupError('delivery-failed', 'delivery fixture'), code: 'gateway/unavailable' },
      { thrown: new RemoteError('gateway/internal', 'remote fixture', {}), code: 'gateway/internal' },
      { thrown: { code: 'gateway/conflict', message: 'plain fixture' }, code: 'gateway/conflict' },
      { thrown: { code: 'not-a-gateway-code', message: 'unsafe fixture' }, code: 'gateway/internal' },
      { thrown: null, code: 'gateway/internal' },
      { thrown: 'unsafe fixture', code: 'gateway/internal' },
    ]
    for (const { thrown, code } of failures) {
      const response = await handleBotAttachmentUpload(uploadRequest(
        '/upload?scope=group&groupId=bot-group-one&messageId=bot-group-message-one',
        { contentType: 'application/octet-stream', body: Uint8Array.of(1) },
      ), async () => { throw thrown })
      await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code } })
    }
  })

  it('bridges node requests to fetch responses, including empty and disconnected bodies', async () => {
    const request = bridgeRequest('POST', '/fixture/upload', [Uint8Array.of(9)])
    const response = new FixtureResponse()
    let seen: Request | undefined
    await bridgeBotAttachmentRequest(request, response, async (incoming) => {
      seen = incoming
      return new Response(Uint8Array.of(4, 5), { status: 201, headers: { 'x-fixture': 'yes' } })
    })
    expect(seen?.method).toBe('POST')
    expect(seen?.url).toBe('http://dsh.internal/fixture/upload')
    expect(response.status).toBe(201)
    expect(response.headers).toEqual({ 'x-fixture': 'yes' })
    expect([...response.chunks.flatMap(chunk => [...chunk])]).toEqual([4, 5])
    expect(response.writableEnded).toBe(true)

    const emptyResponse = new FixtureResponse()
    await bridgeBotAttachmentRequest(bridgeRequest(undefined, undefined), emptyResponse, async (incoming) => {
      expect(incoming.method).toBe('GET')
      expect(incoming.url).toBe('http://dsh.internal/')
      return new Response(null, { status: 204 })
    })
    expect(emptyResponse.status).toBe(204)
    expect(emptyResponse.writableEnded).toBe(true)

    const closedResponse = new FixtureResponse()
    await bridgeBotAttachmentRequest(bridgeRequest('GET', '/fixture/closed'), closedResponse, async () => {
      closedResponse.emit('close')
      return new Response(Uint8Array.of(8))
    })
    expect(closedResponse.chunks).toEqual([])
    expect(closedResponse.writableEnded).toBe(true)

    const alreadyEndedResponse = new FixtureResponse()
    await bridgeBotAttachmentRequest(bridgeRequest('GET', '/fixture/already-ended'), alreadyEndedResponse, async () => {
      alreadyEndedResponse.markEnded()
      alreadyEndedResponse.emit('close')
      return new Response(Uint8Array.of(8))
    })
    expect(alreadyEndedResponse.chunks).toHaveLength(1)
  })

  it('destroys the node response when writing a provider body fails', async () => {
    const errorResponse = new FixtureResponse()
    errorResponse.writeFailure = new Error('fixture write failure')
    await bridgeBotAttachmentRequest(bridgeRequest('GET', '/fixture/error'), errorResponse, async () => new Response('error'))
    expect(errorResponse.destroyedWith).toMatchObject({ message: 'fixture write failure' })

    const valueResponse = new FixtureResponse()
    valueResponse.writeFailure = 'non-error fixture write failure'
    await bridgeBotAttachmentRequest(bridgeRequest('GET', '/fixture/non-error'), valueResponse, async () => new Response('error'))
    expect(valueResponse.destroyedWith).toMatchObject({ message: 'Attachment stream failed' })
  })
})
