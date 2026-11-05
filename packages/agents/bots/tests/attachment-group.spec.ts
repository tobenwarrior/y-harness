import { AttachmentId, type FileAttachmentRef, type ImageAttachmentRef } from '@yharness/attachment'
import { Context } from '@yharness/cordis'
import { SessionId } from '@yharness/session'
import Storage from '@yharness/storage'
import type { StorageBackend } from '@yharness/storage'
import { DomainFacility } from '@yharness/storage-domain'
import type { Domain } from '@yharness/storage-domain'
import { describe, expect, it, vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { BotAttachmentGrantStore, botAttachmentDomain } from '../src/attachment-grants.ts'
import {
  BotGroupId,
  BotGroupMessageId,
  BotGroupService,
  botGroupDomain,
} from '../src/group-chat.ts'
import { BotId } from '../src/types.ts'
import type { BotView } from '../src/types.ts'

interface Fixture {
  readonly ctx: Context
  readonly group: Domain<typeof botGroupDomain>
  readonly attachments: Domain<typeof botAttachmentDomain>
}

async function fixture(): Promise<Fixture> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend: StorageBackend = new MemoryStorageBackend(new MemoryMediaPool())
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  return {
    ctx,
    group: await facility.open(botGroupDomain),
    attachments: await facility.open(botAttachmentDomain),
  }
}

function bot(id: BotId): BotView {
  return {
    id,
    sessionId: SessionId(`bot-session-${String(id).slice(4)}`),
    name: String(id),
    identity: 'agent',
    accent: 'blue',
    cwd: '/tmp',
    state: 'active',
    availability: 'idle',
    pinned: false,
    hidden: false,
    createdAt: 1,
    updatedAt: 1,
  }
}

const image: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'3'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 4,
  width: 1,
  height: 1,
}
const file: FileAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'4'.repeat(64)}`),
  name: 'brief.txt',
  bytes: 5,
}

describe('owner-local Bot group attachments', () => {
  it('rejects a new message when an earlier failed write left a consumed grant', async () => {
    const opened = await fixture()
    const alpha = bot(BotId('bot-alpha'))
    const beta = bot(BotId('bot-beta'))
    const deliver = vi.fn(async () => 'accepted' as const)
    try {
      const store = new BotAttachmentGrantStore(opened.attachments)
      const service = new BotGroupService(opened.group, { listBots: async () => [alpha, beta], deliverToBot: deliver }, store)
      const created = await service.create({ name: 'Uncertain send', botIds: [alpha.id, beta.id] })
      const messageId = BotGroupMessageId('bot-group-message-orphan-grant')
      const grant = await service.admitAttachment({
        groupId: created.group.id, messageId, targetBotIds: [beta.id], attachments: [{ type: 'file', attachment: file }],
      })
      const group = opened.group.table('groups').get(created.group.id)
      if (group === undefined) throw new Error('group was not persisted')
      await store.consume({
        kind: 'local-group', ownerId: 'local-owner', groupId: created.group.id, messageId,
        targetBotIds: [beta.id], authorizationRevision: group.updatedAt,
      }, [grant.grantId])
      await expect(service.send({ groupId: created.group.id, messageId, text: 'Different message', targetBotIds: [beta.id] }))
        .rejects.toMatchObject({ code: 'invalid' })
      expect(deliver).not.toHaveBeenCalled()
    } finally {
      await opened.ctx.fiber.dispose()
    }
  })
  it('binds admitted image/file grants to the exact message and delivers model blocks once', async () => {
    const opened = await fixture()
    const alpha = bot(BotId('bot-alpha'))
    const beta = bot(BotId('bot-beta'))
    const delivered: unknown[] = []
    try {
      const service = new BotGroupService(opened.group, {
        listBots: async () => [alpha, beta],
        deliverToBot: async (request) => { delivered.push(request); return 'accepted' },
      }, new BotAttachmentGrantStore(opened.attachments))
      const created = await service.create({
        id: BotGroupId('bot-group-attachments'), name: 'Attachments', botIds: [alpha.id, beta.id],
      })
      const messageId = BotGroupMessageId('bot-group-message-attachments')
      const grant = await service.admitAttachment({
        groupId: created.group.id,
        messageId,
        targetBotIds: [beta.id],
        attachments: [{ type: 'image', attachment: image }, { type: 'file', attachment: file }],
      })
      const sent = await service.send({
        groupId: created.group.id,
        messageId,
        text: 'Review these files',
        targetBotIds: [beta.id],
        attachmentGrants: [grant.grantId],
      })
      expect(sent.status).toBe('accepted')
      expect(delivered).toHaveLength(1)
      expect(delivered[0]).toMatchObject({
        attachments: [{ type: 'image', attachment: image }, { type: 'file', attachment: file }],
      })
      await expect(service.send({
        groupId: created.group.id,
        messageId,
        text: 'Review these files',
        targetBotIds: [beta.id],
        attachmentGrants: [grant.grantId],
      })).resolves.toMatchObject({ status: 'duplicate' })
      expect(delivered).toHaveLength(1)
      await expect(service.inspect({ groupId: created.group.id })).resolves.toMatchObject({
        messages: [{ attachments: [
          { type: 'image', attachmentId: String(image.attachmentId) },
          { type: 'file', attachmentId: String(file.attachmentId) },
        ] }],
      })
    } finally {
      await opened.ctx.fiber.dispose()
    }
  })

  it('rejects a grant after the group authorization revision changes', async () => {
    const opened = await fixture()
    const alpha = bot(BotId('bot-alpha'))
    const beta = bot(BotId('bot-beta'))
    try {
      const service = new BotGroupService(opened.group, {
        listBots: async () => [alpha, beta],
        deliverToBot: async () => 'accepted',
      }, new BotAttachmentGrantStore(opened.attachments))
      const created = await service.create({
        id: BotGroupId('bot-group-revision'), name: 'Revision', botIds: [alpha.id, beta.id],
      })
      const messageId = BotGroupMessageId('bot-group-message-revision')
      const grant = await service.admitAttachment({ groupId: created.group.id, messageId, attachments: [{ type: 'file', attachment: file }] })
      await service.update({ groupId: created.group.id, name: 'Revision changed', botIds: [alpha.id, beta.id] })
      const changed = opened.group.table('groups').get(created.group.id)
      if (changed === undefined) throw new Error('group fixture disappeared')
      await opened.group.table('groups').put(created.group.id, { ...changed, updatedAt: changed.updatedAt + 1 })
      await expect(service.send({
        groupId: created.group.id, messageId, text: 'stale', attachmentGrants: [grant.grantId],
      })).rejects.toMatchObject({ code: 'forbidden' })
    } finally {
      await opened.ctx.fiber.dispose()
    }
  })

  it('does not consume a second grant when an idempotent retry has different text', async () => {
    const opened = await fixture()
    const alpha = bot(BotId('bot-alpha'))
    const beta = bot(BotId('bot-beta'))
    try {
      const store = new BotAttachmentGrantStore(opened.attachments)
      const service = new BotGroupService(opened.group, {
        listBots: async () => [alpha, beta],
        deliverToBot: async () => 'accepted',
      }, store)
      const created = await service.create({
        id: BotGroupId('bot-group-retry-validation'), name: 'Retry validation', botIds: [alpha.id, beta.id],
      })
      const messageId = BotGroupMessageId('bot-group-message-retry-validation')
      const first = await service.admitAttachment({
        groupId: created.group.id, messageId, targetBotIds: [beta.id],
        attachments: [{ type: 'image', attachment: image }],
      })
      await service.send({
        groupId: created.group.id, messageId, text: 'Original', targetBotIds: [beta.id],
        attachmentGrants: [first.grantId],
      })
      const currentGroup = opened.group.table('groups').get(created.group.id)
      if (currentGroup === undefined) throw new Error('retry validation group disappeared')
      const second = await store.admit({
        kind: 'local-group', ownerId: 'local-owner', groupId: created.group.id, messageId,
        targetBotIds: [beta.id], authorizationRevision: currentGroup.updatedAt,
      }, [{ type: 'file', attachment: file }])
      await expect(service.send({
        groupId: created.group.id, messageId, text: 'Changed', targetBotIds: [beta.id],
        attachmentGrants: [second.grantId],
      })).rejects.toMatchObject({ code: 'invalid' })
      const scope = {
        kind: 'local-group' as const,
        ownerId: 'local-owner',
        groupId: created.group.id,
        messageId,
        targetBotIds: [beta.id],
        authorizationRevision: currentGroup.updatedAt,
      }
      await expect(store.consume(scope, [second.grantId])).resolves.toMatchObject({ status: 'accepted' })
    } finally {
      await opened.ctx.fiber.dispose()
    }
  })
})
