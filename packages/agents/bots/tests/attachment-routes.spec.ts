import { describe, expect, it } from 'vitest'
import { BotAttachmentGrantError, BotAttachmentGrantId } from '../src/attachment-grants.ts'
import { BotGroupError } from '../src/group-chat.ts'
import { handleBotAttachmentUpload } from '../src/attachment-routes.ts'

describe('Bot attachment upload route', () => {
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
