import { Context } from '@yharness/cordis'
import { AttachmentId, type FileAttachmentRef, type ImageAttachmentRef } from '@yharness/attachment'
import Storage from '@yharness/storage'
import type { StorageBackend } from '@yharness/storage'
import { DomainFacility } from '@yharness/storage-domain'
import type { Domain } from '@yharness/storage-domain'
import { describe, expect, it } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import {
  BotAttachmentGrantId,
  BotAttachmentGrantStore,
  BotPrivateMessageId,
  botAttachmentDomain,
  type BotAttachmentScope,
} from '../src/attachment-grants.ts'
import { BotGroupId, BotGroupMessageId } from '../src/group-chat.ts'
import { BotId } from '../src/types.ts'
import { BotPrincipalId } from '../src/sharing.ts'

interface Fixture {
  readonly ctx: Context
  readonly facility: DomainFacility
  readonly domain: Domain<typeof botAttachmentDomain>
}

async function fixture(pool = new MemoryMediaPool()): Promise<Fixture> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend: StorageBackend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => {
      await facility.closeAll()
      unmount()
    }
  })
  return { ctx, facility, domain: await facility.open(botAttachmentDomain) }
}

const image: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'1'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 4,
  width: 1,
  height: 1,
}

const file: FileAttachmentRef = {
  attachmentId: AttachmentId('provider:file-1'),
  name: 'notes.txt',
  bytes: 5,
}

function localScope(targetBotIds: readonly BotId[] = [BotId('bot-beta')]): BotAttachmentScope {
  return {
    kind: 'local-group',
    ownerId: 'local-owner',
    groupId: BotGroupId('bot-group-alpha'),
    messageId: BotGroupMessageId('bot-group-message-alpha'),
    targetBotIds,
    authorizationRevision: 4,
  }
}

describe('BotAttachmentGrantStore', () => {
  it('admits only opaque, bounded grants and consumes an exact scope once', async () => {
    const opened = await fixture()
    try {
      const store = new BotAttachmentGrantStore(opened.domain)
      const granted = await store.admit(localScope(), [
        { type: 'image', attachment: image },
        { type: 'file', attachment: file },
      ], 10)
      expect(String(granted.grantId)).toMatch(/^bot-attachment-grant-/)
      expect(granted).not.toHaveProperty('attachmentId')
      expect(granted.attachments).toEqual([
        { type: 'image', mediaType: 'image/png', bytes: 4, width: 1, height: 1 },
        { type: 'file', name: 'notes.txt', bytes: 5 },
      ])

      await expect(store.consume(localScope(), [granted.grantId], 11)).resolves.toMatchObject({
        status: 'accepted',
        attachments: [{ type: 'image', attachment: image }, { type: 'file', attachment: file }],
      })
      await expect(store.consume(localScope(), [granted.grantId], 12)).resolves.toMatchObject({
        status: 'duplicate',
        attachments: [{ type: 'image', attachment: image }, { type: 'file', attachment: file }],
      })
      await expect(store.consume({ ...localScope(), authorizationRevision: 5 }, [granted.grantId], 13)).resolves.toMatchObject({
        status: 'duplicate',
        attachments: [{ type: 'image', attachment: image }, { type: 'file', attachment: file }],
      })
    } finally {
      await opened.ctx.fiber.dispose()
    }
  })

  it('rejects a grant reused by another Bot, group, target set, or revision', async () => {
    const opened = await fixture()
    try {
      const store = new BotAttachmentGrantStore(opened.domain)
      const granted = await store.admit(localScope(), [{ type: 'file', attachment: file }], 10)
      await expect(store.consume({ ...localScope(), targetBotIds: [BotId('bot-gamma')] }, [granted.grantId], 11))
        .rejects.toMatchObject({ code: 'forbidden' })
      await expect(store.consume({ ...localScope(), authorizationRevision: 5 }, [granted.grantId], 11))
        .rejects.toMatchObject({ code: 'forbidden' })
      await expect(store.consume({ ...localScope(), groupId: BotGroupId('bot-group-other') }, [granted.grantId], 11))
        .rejects.toMatchObject({ code: 'forbidden' })
      const sharedScope: BotAttachmentScope = {
        kind: 'shared-group',
        principalId: BotPrincipalId('principal-one'),
        groupId: BotGroupId('bot-group-shared'),
        messageId: BotGroupMessageId('bot-group-message-shared'),
        targetBotIds: [BotId('bot-beta')],
        authorizationRevision: 1,
      }
      const sharedGrant = await store.admit(sharedScope, [{ type: 'file', attachment: file }], 10)
      await expect(store.consume(sharedScope, [sharedGrant.grantId], 11)).resolves.toMatchObject({ status: 'accepted' })
      expect(store.attachmentsForSharedGroupMessage({
        principalId: BotPrincipalId('principal-one'),
        groupId: sharedScope.groupId,
        messageId: sharedScope.messageId,
        targetBotIds: sharedScope.targetBotIds,
        authorizationRevision: sharedScope.authorizationRevision,
      })).toHaveLength(1)
      expect(store.attachmentsForSharedGroupMessage({
        principalId: BotPrincipalId('principal-two'),
        groupId: sharedScope.groupId,
        messageId: sharedScope.messageId,
        targetBotIds: sharedScope.targetBotIds,
        authorizationRevision: sharedScope.authorizationRevision,
      })).toHaveLength(0)
      await expect(store.consume({ ...sharedScope, principalId: BotPrincipalId('principal-two') }, [sharedGrant.grantId], 12))
        .rejects.toMatchObject({ code: 'forbidden' })
    } finally {
      await opened.ctx.fiber.dispose()
    }
  })

  it('keeps shared-private delivery exclusive until a lease expires or settles', async () => {
    const opened = await fixture()
    try {
      const store = new BotAttachmentGrantStore(opened.domain)
      const scope: BotAttachmentScope = {
        kind: 'shared-private',
        botId: BotId('bot-alpha'),
        principalId: BotPrincipalId('principal-one'),
        messageId: BotPrivateMessageId('bot-private-message-alpha'),
        authorizationRevision: 3,
      }
      await expect(store.reservePrivateDelivery(scope, 'lease-one', 100, 20)).resolves.toBe('reserved')
      await expect(store.reservePrivateDelivery(scope, 'lease-two', 105, 20)).resolves.toBe('busy')
      await expect(store.reservePrivateDelivery(scope, 'lease-two', 121, 20)).resolves.toBe('reserved')
      await expect(store.settlePrivateDelivery(scope, 'lease-two', 'accepted', 122)).resolves.toBe(true)
      await expect(store.reservePrivateDelivery(scope, 'lease-three', 123, 20)).resolves.toBe('duplicate')
      await expect(store.reservePrivateDelivery({ ...scope, authorizationRevision: 4 }, 'lease-four', 124, 20)).resolves.toBe('duplicate')
    } finally {
      await opened.ctx.fiber.dispose()
    }
  })

  it('renews a live shared-private lease so another Host cannot take it over', async () => {
    const opened = await fixture()
    try {
      const store = new BotAttachmentGrantStore(opened.domain)
      const peerStore = new BotAttachmentGrantStore(opened.domain)
      const scope: BotAttachmentScope = {
        kind: 'shared-private',
        botId: BotId('bot-alpha'),
        principalId: BotPrincipalId('principal-one'),
        messageId: BotPrivateMessageId('bot-private-message-renewal'),
        authorizationRevision: 3,
      }
      await expect(store.reservePrivateDelivery(scope, 'live-lease', 100, 20)).resolves.toBe('reserved')
      await expect(store.renewPrivateDelivery(scope, 'live-lease', 115, 20)).resolves.toBe(true)
      await expect(peerStore.reservePrivateDelivery(scope, 'takeover', 125, 20)).resolves.toBe('busy')
      await expect(store.renewPrivateDelivery(scope, 'stale-lease', 126, 20)).resolves.toBe(false)
      await expect(store.settlePrivateDelivery(scope, 'live-lease', 'accepted', 127)).resolves.toBe(true)
      await expect(store.renewPrivateDelivery(scope, 'live-lease', 128, 20)).resolves.toBe(false)
    } finally {
      await opened.ctx.fiber.dispose()
    }
  })

  it('rejects a stale private lease settlement after another Host takes over', async () => {
    const pool = new MemoryMediaPool()
    const first = await fixture(pool)
    const second = await fixture(pool)
    try {
      const writer = new BotAttachmentGrantStore(first.domain)
      const peer = new BotAttachmentGrantStore(second.domain)
      const scope: BotAttachmentScope = {
        kind: 'shared-private',
        botId: BotId('bot-alpha'),
        principalId: BotPrincipalId('principal-one'),
        messageId: BotPrivateMessageId('bot-private-message-lease-fence'),
        authorizationRevision: 3,
      }
      await expect(writer.reservePrivateDelivery(scope, 'old-owner', 100, 20)).resolves.toBe('reserved')
      await peer.refresh()
      await expect(peer.reservePrivateDelivery(scope, 'new-owner', 121, 20)).resolves.toBe('reserved')
      await writer.refresh()
      await expect(writer.settlePrivateDelivery(scope, 'old-owner', 'accepted', 122)).resolves.toBe(false)
      expect(peer.readPrivateDelivery(scope)).toMatchObject({ token: 'new-owner', state: 'pending' })
    } finally {
      await Promise.all([first.ctx.fiber.dispose(), second.ctx.fiber.dispose()])
    }
  })

  it('refreshes a peer Host projection before reading grants and delivery leases', async () => {
    const pool = new MemoryMediaPool()
    const first = await fixture(pool)
    const second = await fixture(pool)
    try {
      const writer = new BotAttachmentGrantStore(first.domain)
      const peer = new BotAttachmentGrantStore(second.domain)
      const scope: BotAttachmentScope = {
        kind: 'shared-private',
        botId: BotId('bot-alpha'),
        principalId: BotPrincipalId('principal-one'),
        messageId: BotPrivateMessageId('bot-private-message-peer-refresh'),
        authorizationRevision: 3,
      }
      const grant = await writer.admit(scope, [{ type: 'file', attachment: file }], 100)
      expect(() => peer.preview(scope, [grant.grantId])).toThrow(/not found/)
      await peer.refresh()
      expect(peer.preview(scope, [grant.grantId])).toEqual([{ type: 'file', attachment: file }])
      await writer.reservePrivateDelivery(scope, 'peer-live-lease', 110, 20)
      expect(peer.readPrivateDelivery(scope)).toBeUndefined()
      await peer.refresh()
      expect(peer.readPrivateDelivery(scope)?.token).toBe('peer-live-lease')
      await expect(peer.reservePrivateDelivery(scope, 'peer-takeover', 115, 20)).resolves.toBe('busy')
    } finally {
      await Promise.all([first.ctx.fiber.dispose(), second.ctx.fiber.dispose()])
    }
  })

  it('rejects malformed durable grant records instead of silently accepting them', async () => {
    const opened = await fixture()
    try {
      await opened.domain.table('grants').put(BotAttachmentGrantId('bot-attachment-grant-bad'), {
        id: BotAttachmentGrantId('bot-attachment-grant-bad'),
        scope: localScope(),
        state: 'reserved',
        attachments: [{ type: 'file', attachment: { attachmentId: '', name: 'x', bytes: 1 } }],
        createdAt: 1,
      } as never)
      await opened.domain.close()
      await expect(opened.facility.open(botAttachmentDomain)).rejects.toThrow()
    } finally {
      await opened.ctx.fiber.dispose()
    }
  })
})
