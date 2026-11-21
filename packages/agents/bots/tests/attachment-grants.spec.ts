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
  BotAttachmentGrantError,
  BotAttachmentGrantStore,
  BotPrivateMessageId,
  attachmentContentBlocks,
  attachmentMetadata,
  attachmentView,
  botAttachmentGrantSchema,
  botAttachmentDomain,
  normalizeScope,
  sameAttachmentRefs,
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

const namedImage: ImageAttachmentRef = {
  ...image,
  name: 'fixture.png',
  originalDimensions: { width: 2, height: 3 },
}

function localScope(targetBotIds: readonly BotId[] = [BotId('bot-beta')]): Extract<BotAttachmentScope, { kind: 'local-group' }> {
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
  it('projects validated attachment metadata and model content without provider ids', () => {
    expect(botAttachmentGrantSchema.safeParse({
      id: BotAttachmentGrantId('bot-attachment-grant-schema'),
      scope: localScope(),
      attachments: [{ type: 'image', attachment: namedImage }],
      state: 'consumed',
      createdAt: 1,
      consumedAt: 2,
    }).success).toBe(true)
    expect(botAttachmentGrantSchema.safeParse({
      id: BotAttachmentGrantId('bot-attachment-grant-missing-consumed-at'),
      scope: localScope(),
      attachments: [{ type: 'file', attachment: file }],
      state: 'consumed',
      createdAt: 1,
    }).success).toBe(false)
    expect(botAttachmentGrantSchema.safeParse({
      id: BotAttachmentGrantId('bot-attachment-grant-extra-consumed-at'),
      scope: localScope(),
      attachments: [{ type: 'file', attachment: file }],
      state: 'reserved',
      createdAt: 1,
      consumedAt: 2,
    }).success).toBe(false)

    expect(attachmentMetadata({ type: 'image', attachment: namedImage })).toEqual({
      type: 'image', mediaType: 'image/png', bytes: 4, width: 1, height: 1, name: 'fixture.png',
    })
    expect(attachmentMetadata({ type: 'file', attachment: file })).toEqual({ type: 'file', name: 'notes.txt', bytes: 5 })
    expect(attachmentView({ type: 'image', attachment: namedImage })).toMatchObject({
      type: 'image', name: 'fixture.png', attachmentId: String(namedImage.attachmentId),
    })
    expect(sameAttachmentRefs([{ type: 'file', attachment: file }], [{ type: 'file', attachment: file }])).toBe(true)
    expect(sameAttachmentRefs([{ type: 'file', attachment: file }], [{ type: 'image', attachment: image }])).toBe(false)
    expect(attachmentContentBlocks([
      { type: 'image', attachment: image },
      { type: 'file', attachment: file },
    ])).toEqual([
      { type: 'image', attachment: image },
      { type: 'file', attachment: file },
    ])

    const normalized = normalizeScope({ ...localScope([BotId('bot-zeta'), BotId('bot-alpha')]) })
    expect(normalized.kind).toBe('local-group')
    if (normalized.kind === 'local-group') {
      expect(normalized.targetBotIds).toEqual([BotId('bot-alpha'), BotId('bot-zeta')])
    }
    expect(() => normalizeScope({ ...localScope(), targetBotIds: [] })).toThrow(BotAttachmentGrantError)
  })

  it('handles empty projections, ordered message reads, and shared recipient fencing', async () => {
    const opened = await fixture()
    try {
      const store = new BotAttachmentGrantStore(opened.domain)
      expect(await store.consume(localScope(), [], 1)).toEqual({ status: 'none', attachments: [] })
      store.validate(localScope(), [])
      expect(store.preview(localScope(), [])).toEqual([])
      expect(store.attachmentsForMessage(localScope())).toEqual([])

      const first = await store.admit(localScope(), [{ type: 'image', attachment: image }], 10)
      const second = await store.admit(localScope(), [{ type: 'file', attachment: file }], 10)
      await expect(store.consume(localScope(), [first.grantId, second.grantId], 11)).resolves.toMatchObject({ status: 'accepted' })
      expect(store.attachmentsForMessage(localScope())).toHaveLength(2)
      expect(store.attachmentsForMessage({ ...localScope(), ownerId: 'another-owner' })).toEqual([])

      const privateScope: Extract<BotAttachmentScope, { kind: 'shared-private' }> = {
        kind: 'shared-private',
        botId: BotId('bot-private'),
        principalId: BotPrincipalId('principal-private'),
        messageId: BotPrivateMessageId('bot-private-message-projection'),
        authorizationRevision: 1,
      }
      const privateGrant = await store.admit(privateScope, [{ type: 'file', attachment: file }], 12)
      await store.consume(privateScope, [privateGrant.grantId], 13)
      expect(store.attachmentsForMessage(privateScope)).toHaveLength(1)
      expect(store.attachmentsForMessage({ ...privateScope, principalId: BotPrincipalId('principal-other') })).toEqual([])
      expect(store.attachmentsForMessage({ ...privateScope, botId: BotId('bot-other') })).toEqual([])
      expect(store.attachmentsForMessage({ ...privateScope, messageId: BotPrivateMessageId('bot-private-message-other') })).toEqual([])

      const sharedScope: Extract<BotAttachmentScope, { kind: 'shared-group' }> = {
        kind: 'shared-group',
        principalId: BotPrincipalId('principal-projection'),
        groupId: BotGroupId('bot-group-projection'),
        messageId: BotGroupMessageId('bot-group-message-projection'),
        targetBotIds: [BotId('bot-zeta'), BotId('bot-alpha')],
        authorizationRevision: 1,
      }
      const sharedGrant = await store.admit(sharedScope, [{ type: 'file', attachment: file }], 14)
      const sharedImageGrant = await store.admit(sharedScope, [{ type: 'image', attachment: image }], 14)
      await store.consume(sharedScope, [sharedGrant.grantId, sharedImageGrant.grantId], 15)
      expect(store.attachmentsForMessage(sharedScope)).toHaveLength(2)
      expect(store.attachmentsForMessage({ ...sharedScope, principalId: BotPrincipalId('principal-other') })).toEqual([])
      expect(store.attachmentsForMessage({ ...sharedScope, groupId: BotGroupId('bot-group-other') })).toEqual([])
      expect(store.attachmentsForMessage({ ...sharedScope, messageId: BotGroupMessageId('bot-group-message-other') })).toEqual([])
      expect(store.attachmentsForMessage({ ...sharedScope, targetBotIds: [BotId('bot-other')] })).toEqual([])
      expect(store.attachmentsForSharedGroupMessage({
        principalId: sharedScope.principalId,
        groupId: sharedScope.groupId,
        messageId: sharedScope.messageId,
        targetBotIds: [BotId('bot-alpha'), BotId('bot-zeta')],
        authorizationRevision: 99,
      })).toHaveLength(2)
      expect(store.attachmentsForSharedGroupMessage({
        principalId: BotPrincipalId('principal-other'),
        groupId: sharedScope.groupId,
        messageId: sharedScope.messageId,
        targetBotIds: [BotId('bot-alpha'), BotId('bot-zeta')],
        authorizationRevision: 99,
      })).toEqual([])
      expect(() => store.attachmentsForSharedGroupMessage({
        principalId: sharedScope.principalId,
        groupId: sharedScope.groupId,
        messageId: sharedScope.messageId,
        targetBotIds: [],
        authorizationRevision: 1,
      })).toThrow(BotAttachmentGrantError)
    } finally {
      await opened.ctx.fiber.dispose()
    }
  })

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

  it('rejects invalid attachment input, grant ids, timestamps, and revoked records', async () => {
    const opened = await fixture()
    try {
      const store = new BotAttachmentGrantStore(opened.domain)
      await expect(store.admit(localScope(), [], 1)).rejects.toMatchObject({ code: 'invalid' })
      await expect(store.admit(localScope(), new Array(9).fill({ type: 'file', attachment: file }), 1))
        .rejects.toMatchObject({ code: 'invalid' })
      await expect(store.admit(localScope(), [{ type: 'file', attachment: { ...file, attachmentId: AttachmentId('') } }], 1))
        .rejects.toMatchObject({ code: 'invalid' })
      await expect(store.admit({ ...localScope(), targetBotIds: [BotId('bot-beta'), BotId('bot-beta')] }, [{ type: 'file', attachment: file }], 1))
        .rejects.toMatchObject({ code: 'invalid' })
      await expect(store.admit(localScope(), [{ type: 'file', attachment: file }], -1)).rejects.toMatchObject({ code: 'invalid' })

      const grant = await store.admit(localScope(), [{ type: 'file', attachment: file }], 1)
      store.validate(localScope(), [grant.grantId])
      expect(() => { store.validate(localScope(), [grant.grantId, grant.grantId]) }).toThrow(/unique/)
      const manyIds = Array.from({ length: 9 }, (_, index) => BotAttachmentGrantId(`bot-attachment-grant-missing-${index}`))
      expect(() => { store.validate(localScope(), manyIds) }).toThrow(/unique and contain at most eight/)
      expect(() => { store.validate(localScope(), [BotAttachmentGrantId('bot-attachment-grant-missing')]) }).toThrow(/not found/)

      const stored = opened.domain.table('grants').get(grant.grantId)
      if (stored === undefined) throw new Error('grant fixture disappeared')
      await opened.domain.table('grants').put(grant.grantId, { ...stored, state: 'revoked' })
      expect(() => { store.validate(localScope(), [grant.grantId]) }).toThrow(/revoked/)
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

  it('validates private lease inputs and releases only the current pending token', async () => {
    const opened = await fixture()
    try {
      const store = new BotAttachmentGrantStore(opened.domain)
      const scope: Extract<BotAttachmentScope, { kind: 'shared-private' }> = {
        kind: 'shared-private',
        botId: BotId('bot-lease-validation'),
        principalId: BotPrincipalId('principal-lease-validation'),
        messageId: BotPrivateMessageId('bot-private-message-lease-validation'),
        authorizationRevision: 1,
      }
      await expect(Reflect.apply(store.reservePrivateDelivery.bind(store), store, [localScope(), 'invalid-scope', 1, 10]))
        .rejects.toMatchObject({ code: 'invalid' })
      await expect(store.reservePrivateDelivery(scope, '', 1, 10)).rejects.toMatchObject({ code: 'invalid' })
      await expect(store.reservePrivateDelivery(scope, 'x'.repeat(257), 1, 10)).rejects.toMatchObject({ code: 'invalid' })
      await expect(store.reservePrivateDelivery(scope, 'valid', 1, 0)).rejects.toMatchObject({ code: 'invalid' })
      await expect(store.reservePrivateDelivery(scope, 'valid', 1, 300_001)).rejects.toMatchObject({ code: 'invalid' })
      await expect(store.reservePrivateDelivery(scope, 'valid', 1, 1.5)).rejects.toMatchObject({ code: 'invalid' })
      await expect(store.reservePrivateDelivery(scope, 'valid', -1, 10)).rejects.toMatchObject({ code: 'invalid' })
      await expect(store.renewPrivateDelivery(scope, '', 2, 10)).rejects.toMatchObject({ code: 'invalid' })
      await expect(store.renewPrivateDelivery(scope, 'valid', 2, 0)).rejects.toMatchObject({ code: 'invalid' })
      await expect(store.reservePrivateDelivery(scope, 'valid', 1, 10)).resolves.toBe('reserved')
      await expect(store.renewPrivateDelivery(scope, 'valid', -1, 10)).rejects.toMatchObject({ code: 'invalid' })
      await expect(store.renewPrivateDelivery(scope, 'valid', 2, 10)).resolves.toBe(true)
      await expect(store.releasePrivateDelivery(scope, 'valid')).resolves.toBeUndefined()
      await expect(store.renewPrivateDelivery(scope, 'valid', 2, 10)).resolves.toBe(false)
      await expect(store.reservePrivateDelivery(scope, 'settle-owner', 10, 20)).resolves.toBe('reserved')
      await expect(store.settlePrivateDelivery(scope, 'settle-owner', 'accepted', -1)).rejects.toMatchObject({ code: 'invalid' })
      await expect(store.releasePrivateDelivery(scope, 'settle-owner')).resolves.toBeUndefined()
      await expect(store.settlePrivateDelivery(scope, 'valid', 'accepted', 2)).resolves.toBe(false)
      await expect(store.releasePrivateDelivery(scope, 'missing')).resolves.toBeUndefined()

      await expect(store.reservePrivateDelivery(scope, 'owner', 10, 20)).resolves.toBe('reserved')
      await expect(store.releasePrivateDelivery(scope, 'wrong')).resolves.toBeUndefined()
      expect(store.readPrivateDelivery(scope)).toMatchObject({ token: 'owner', state: 'pending' })
      await expect(store.releasePrivateDelivery(scope, 'owner')).resolves.toBeUndefined()
      expect(store.readPrivateDelivery(scope)).toBeUndefined()
      await expect(store.settlePrivateDelivery(scope, 'owner', 'accepted', 22)).resolves.toBe(false)
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
