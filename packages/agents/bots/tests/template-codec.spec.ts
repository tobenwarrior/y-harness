import { describe, expect, it } from 'vitest'
import {
  BOT_TEMPLATE_CODE_PREFIX,
  createBotTemplateSigningKeys,
  decodeBotTemplateCode,
  encodeBotTemplateCode,
} from '../src/template-codec.ts'

describe('portable Bot template codes', () => {
  it('round-trips a signed configuration without local runtime identities', () => {
    const keys = createBotTemplateSigningKeys()
    const code = encodeBotTemplateCode({
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
      },
    }, keys.privateKey)

    const decoded = decodeBotTemplateCode(code)
    expect(decoded.payload).toMatchObject({
      profile: { name: 'Research partner', identity: 'cloud', accent: 'teal' },
      persona: 'You summarize evidence before recommending an action.',
      capabilities: ['chat', 'collaboration'],
      agentPreset: 'research',
      issuedAt: 100,
      avatar: { mediaType: 'image/png', data: 'AQID', bytes: 3 },
    })
    expect(decoded.issuerFingerprint).toMatch(/^[0-9a-f]{64}$/u)
    expect(decoded.fingerprint).toMatch(/^[0-9a-f]{64}$/u)
    expect(code).toMatch(/^yhbot-template-v2\./)
    expect(code).not.toContain('bot-session-')
    expect(code).not.toContain('attachmentId')
  })

  it('rejects tampered or structurally invalid codes', () => {
    const keys = createBotTemplateSigningKeys()
    const code = encodeBotTemplateCode({
      profile: { name: 'Safe', identity: 'agent', accent: 'violet' },
      capabilities: ['chat'],
      issuedAt: 100,
    }, keys.privateKey)
    interface MutableEnvelope {
      payload: { profile: { name: string } }
    }
    const envelope = JSON.parse(Buffer.from(code.slice(BOT_TEMPLATE_CODE_PREFIX.length), 'base64url').toString('utf8')) as MutableEnvelope
    envelope.payload.profile.name = 'Tampered'
    const tampered = `${BOT_TEMPLATE_CODE_PREFIX}${Buffer.from(JSON.stringify(envelope)).toString('base64url')}`

    expect(() => decodeBotTemplateCode(tampered)).toThrow(/signature/i)
    expect(() => decodeBotTemplateCode('yhbot-template-v2.not-base64')).toThrow(/invalid/i)
  })

  it('rejects capability labels outside the portable declaration grammar', () => {
    const keys = createBotTemplateSigningKeys()
    expect(() => encodeBotTemplateCode({
      profile: { name: 'Unsafe', identity: 'agent', accent: 'violet' },
      capabilities: ['Admin access'],
      issuedAt: 100,
    }, keys.privateKey)).toThrow()
  })

  it('rejects empty optional text instead of signing an ambiguous payload', () => {
    const keys = createBotTemplateSigningKeys()
    expect(() => encodeBotTemplateCode({
      profile: { name: 'Empty', description: '', identity: 'agent', accent: 'violet' },
      persona: '',
      capabilities: [],
      issuedAt: 100,
    }, keys.privateKey)).toThrow()
  })
})
