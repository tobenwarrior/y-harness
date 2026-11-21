import { createHash, generateKeyPairSync, sign, verify, webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  BOT_TEMPLATE_AVATAR_MAX_BYTES,
  BOT_TEMPLATE_CODE_PREFIX,
  botTemplateAvatarSchema,
  createBotTemplateSigningKeys,
  decodeBotTemplateCode,
  encodeBotTemplateCode,
  restoreBotTemplateSigningKeys,
  serializeBotTemplatePrivateKey,
} from '../src/template-codec.ts'

describe('portable Bot template codes', () => {
  it('round-trips a signed configuration without local runtime identities', async () => {
    const keys = await createBotTemplateSigningKeys()
    const code = await encodeBotTemplateCode({
      profile: {
        name: 'Research partner',
        description: 'Keeps investigations moving.',
        identity: 'cloud',
        accent: 'teal',
      },
      persona: 'You summarize evidence before recommending an action.',
      capabilities: ['chat', 'collaboration'],
      agentPreset: 'research',
      issuedAt: 100,
      avatar: {
        mediaType: 'image/png',
        data: 'AQID',
        bytes: 3,
        width: 1,
        height: 1,
        name: 'badge.png',
      },
    }, keys)

    const decoded = await decodeBotTemplateCode(code)
    expect(decoded.payload).toMatchObject({
      profile: { name: 'Research partner', identity: 'cloud', accent: 'teal' },
      persona: 'You summarize evidence before recommending an action.',
      capabilities: ['chat', 'collaboration'],
      agentPreset: 'research',
      issuedAt: 100,
      avatar: { mediaType: 'image/png', data: 'AQID', bytes: 3, name: 'badge.png' },
    })
    expect(decoded.issuerFingerprint).toMatch(/^[0-9a-f]{64}$/u)
    expect(decoded.fingerprint).toMatch(/^[0-9a-f]{64}$/u)
    expect(code).toMatch(/^yhbot-template-v2\./)
    expect(code).not.toContain('bot-session-')
    expect(code).not.toContain('attachmentId')
  })

  it('rejects tampered or structurally invalid codes', async () => {
    const keys = await createBotTemplateSigningKeys()
    const code = await encodeBotTemplateCode({
      profile: { name: 'Safe', identity: 'agent', accent: 'violet' },
      capabilities: ['chat'],
      issuedAt: 100,
    }, keys)
    interface MutableEnvelope {
      publicKey: string
      payload: { profile: { name: string } }
    }
    const envelope = JSON.parse(Buffer.from(code.slice(BOT_TEMPLATE_CODE_PREFIX.length), 'base64url').toString('utf8')) as MutableEnvelope
    envelope.payload.profile.name = 'Tampered'
    const tampered = `${BOT_TEMPLATE_CODE_PREFIX}${Buffer.from(JSON.stringify(envelope)).toString('base64url')}`

    await expect(decodeBotTemplateCode(tampered)).rejects.toThrow(/signature/i)
    envelope.publicKey = 'AA'
    const malformedKey = BOT_TEMPLATE_CODE_PREFIX + Buffer.from(JSON.stringify(envelope)).toString('base64url')
    await expect(decodeBotTemplateCode(malformedKey)).rejects.toThrow(/signature/i)
    await expect(decodeBotTemplateCode(BOT_TEMPLATE_CODE_PREFIX + 'e30')).rejects.toThrow(/payload/i)
    await expect(decodeBotTemplateCode('')).rejects.toThrow(/empty/i)
    await expect(decodeBotTemplateCode('unsupported-template')).rejects.toThrow(/invalid/i)
    await expect(decodeBotTemplateCode('yhbot-template-v2.not-base64')).rejects.toThrow(/invalid/i)
  })

  it('keeps the stored signing identity and verifies codes in both v2 implementations', async () => {
    const previous = generateKeyPairSync('ed25519')
    const privateKey = previous.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url')
    const publicKeyBytes = previous.publicKey.export({ format: 'der', type: 'spki' })
    const publicKey = publicKeyBytes.toString('base64url')
    const payload = {
      profile: { name: 'Existing template', identity: 'agent', accent: 'teal' },
      capabilities: ['chat'],
      issuedAt: 100,
    } as const
    const unsigned = { version: 2, publicKey, payload }
    const canonical = JSON.stringify(unsigned)
    const signature = sign(null, Buffer.from(canonical), previous.privateKey).toString('base64url')
    const legacyCode = BOT_TEMPLATE_CODE_PREFIX + Buffer.from(JSON.stringify({ ...unsigned, signature })).toString('base64url')
    const decoded = await decodeBotTemplateCode(legacyCode)
    expect(decoded.payload).toEqual(payload)
    expect(decoded.fingerprint).toBe(createHash('sha256').update(canonical).digest('hex'))
    expect(decoded.issuerFingerprint).toBe(createHash('sha256').update(publicKeyBytes).digest('hex'))

    const keys = await restoreBotTemplateSigningKeys(privateKey)
    expect(keys.publicKey).toBe(publicKey)
    await expect(serializeBotTemplatePrivateKey(keys.privateKey)).resolves.toBe(privateKey)
    const code = await encodeBotTemplateCode(payload, keys)
    const envelope = JSON.parse(Buffer.from(code.slice(BOT_TEMPLATE_CODE_PREFIX.length), 'base64url').toString('utf8')) as {
      version: number
      publicKey: string
      payload: { nonce: string } & typeof payload
      signature: string
    }
    const { signature: newSignature, ...signed } = envelope
    expect(signed.publicKey).toBe(publicKey)
    expect(signed.payload.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/u)
    expect(verify(null, Buffer.from(JSON.stringify(signed)), previous.publicKey, Buffer.from(newSignature, 'base64url'))).toBe(true)
  })

  it('checks the avatar filename, byte count, and canonical encoding', () => {
    const avatar = { mediaType: 'image/png', data: 'AQID', bytes: 3, width: 1, height: 1 }
    expect(botTemplateAvatarSchema.safeParse({ ...avatar, name: '../badge.png' }).success).toBe(false)
    expect(botTemplateAvatarSchema.safeParse({ ...avatar, bytes: 4 }).success).toBe(false)
    expect(botTemplateAvatarSchema.safeParse({ ...avatar, data: 'AB', bytes: 1 }).success).toBe(false)
    expect(botTemplateAvatarSchema.safeParse({ ...avatar, data: 'A' }).success).toBe(false)
  })

  it('checks the entire encoded template size after including an avatar', async () => {
    const keys = await createBotTemplateSigningKeys()
    await expect(encodeBotTemplateCode({
      profile: { name: 'Large avatar', identity: 'agent', accent: 'violet' },
      capabilities: ['chat'],
      issuedAt: 100,
      avatar: {
        mediaType: 'image/png',
        data: Buffer.alloc(BOT_TEMPLATE_AVATAR_MAX_BYTES).toString('base64url'),
        bytes: BOT_TEMPLATE_AVATAR_MAX_BYTES,
        width: 256,
        height: 256,
      },
    }, keys)).rejects.toThrow(/too large/i)
  })

  it('requires Web Crypto when a browser lacks a secure context', async () => {
    const original = Object.getOwnPropertyDescriptor(webcrypto, 'subtle')
    try {
      Object.defineProperty(webcrypto, 'subtle', { configurable: true, value: undefined })
      await expect(createBotTemplateSigningKeys()).rejects.toThrow(/secure context/i)
    } finally {
      if (original === undefined) Reflect.deleteProperty(webcrypto, 'subtle')
      else Object.defineProperty(webcrypto, 'subtle', original)
    }
  })

  it('rejects capability labels outside the portable declaration grammar', async () => {
    const keys = await createBotTemplateSigningKeys()
    await expect(encodeBotTemplateCode({
      profile: { name: 'Unsafe', identity: 'agent', accent: 'violet' },
      capabilities: ['Admin access'],
      issuedAt: 100,
    }, keys)).rejects.toThrow()
  })

  it('rejects empty optional text instead of signing an ambiguous payload', async () => {
    const keys = await createBotTemplateSigningKeys()
    await expect(encodeBotTemplateCode({
      profile: { name: 'Empty', description: '', identity: 'agent', accent: 'violet' },
      persona: '',
      capabilities: [],
      issuedAt: 100,
    }, keys)).rejects.toThrow()
  })
})
