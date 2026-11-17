import { describe, expect, it } from 'vitest'
import { BotAttachmentGrantError, BotAttachmentGrantId } from '../src/attachment-grants.ts'
import { BotGroupError } from '../src/group-chat.ts'
import {
  botAttachmentUploadSignal,
  boundedBotAttachmentStream,
  handleBotAttachmentUpload,
} from '../src/attachment-routes.ts'

describe('Bot attachment upload route', () => {
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

  it('combines request cancellation with a bounded upload deadline', () => {
    const controller = new AbortController()
    const signal = botAttachmentUploadSignal(controller.signal, 1)
    expect(signal.aborted).toBe(false)
    controller.abort()
    expect(signal.aborted).toBe(true)
  })

  it('rejects non-streaming or malformed scopes before the provider is called', async () => {
    const admit = async (): Promise<never> => { throw new Error('provider must not run') }
    await expect(handleBotAttachmentUpload(new Request(
      'http://dsh.internal/bots/group/uploadAttachment?scope=group&groupId=bot-group-one&messageId=bot-group-message-one',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    ), admit)).resolves.toMatchObject({ status: 415 })
    await expect(handleBotAttachmentUpload(new Request(
      'http://dsh.internal/bots/group/uploadAttachment?scope=group&groupId=bot-group-one&messageId=bad',
      { method: 'POST', headers: { 'content-type': 'application/octet-stream', body: 'x' } },
    ), admit)).resolves.toMatchObject({ status: 400 })
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
})
