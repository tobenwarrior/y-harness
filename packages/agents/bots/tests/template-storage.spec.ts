import { describe, expect, it } from 'vitest'
import { BOT_TEMPLATE_CODE_MAX_LENGTH } from '../src/template-codec.ts'
import { BotTemplateId, BotTemplateShareCode } from '../src/template-types.ts'
import {
  BOT_TEMPLATE_APPROVAL_LIMIT,
  BOT_TEMPLATE_IMPORT_BINDING_LIMIT,
  botTemplateDomain,
  botTemplateRecordSchema,
  normalizeBotTemplateId,
  normalizeBotTemplateShareCode,
} from '../src/template-storage.ts'

const fingerprint = 'a'.repeat(64)
const globalSchema = botTemplateDomain.global.schema
const minimal = {
  id: 'bot-template-test',
  shareCode: 'yhbot-template-v2.test',
  name: 'Research Bot',
  identity: 'agent',
  accent: 'teal',
  createdAt: 100,
}

describe('durable Bot templates', () => {
  it('reads earlier rows and retains the optional signed profile fields', () => {
    expect(botTemplateRecordSchema.parse(minimal)).toEqual({ ...minimal, ownerId: 'local-owner' })
    const complete = {
      ...minimal,
      ownerId: 'other-owner',
      description: 'Research support',
      persona: 'Use source links.',
      capabilities: ['chat', 'research'],
      profile: { name: 'Research Bot', identity: 'agent', accent: 'teal' },
      avatar: { mediaType: 'image/png', data: 'AQID', bytes: 3, width: 1, height: 1 },
      agentPreset: 'research',
      fingerprint,
      portableVersion: 2,
      revokedAt: 101,
    }
    expect(botTemplateRecordSchema.parse(complete)).toEqual(complete)
    expect(botTemplateRecordSchema.safeParse({ ...complete, revokedAt: 99 }).success).toBe(false)
    expect(botTemplateRecordSchema.safeParse({ ...complete, capabilities: ['chat', 'chat'] }).success).toBe(false)
  })

  it('checks stored text without silently changing the signing input', () => {
    expect(botTemplateRecordSchema.safeParse({ ...minimal, shareCode: ' padded ' }).success).toBe(false)
    expect(botTemplateRecordSchema.safeParse({ ...minimal, ownerId: ' padded ' }).success).toBe(false)
    expect(botTemplateRecordSchema.safeParse({ ...minimal, name: ' padded ' }).success).toBe(false)
    expect(botTemplateRecordSchema.safeParse({ ...minimal, description: ' padded ' }).success).toBe(false)
    expect(botTemplateRecordSchema.safeParse({ ...minimal, persona: ' padded ' }).success).toBe(false)
  })

  it('keeps legacy approval timestamps and sorts the current effective tool view', () => {
    expect(globalSchema.parse({ approvals: { [fingerprint]: 10 } })).toEqual({
      approvals: { [fingerprint]: { approvedAt: 10 } },
    })
    const approval = { approvedAt: 11, permissions: { preset: 'research', tools: ['search', 'read'] } }
    expect(globalSchema.parse({ approvals: { [fingerprint]: approval } })).toEqual({
      approvals: { [fingerprint]: { ...approval, permissions: { preset: 'research', tools: ['read', 'search'] } } },
    })
    expect(globalSchema.safeParse({
      approvals: { [fingerprint]: { ...approval, permissions: { preset: 'research', tools: ['read', 'read'] } } },
    }).success).toBe(false)
    expect(globalSchema.parse({ imports: { [fingerprint]: { fingerprint, botId: 'bot-research', name: 'Research Bot' } } }))
      .toEqual({ imports: { [fingerprint]: { fingerprint, botId: 'bot-research', name: 'Research Bot' } } })
  })

  it('bounds durable approvals and retry identities at their configured limits', () => {
    const approvals = Object.fromEntries(Array.from({ length: BOT_TEMPLATE_APPROVAL_LIMIT }, (_, index) => [
      index.toString(16).padStart(64, '0'), { approvedAt: 0 },
    ]))
    expect(globalSchema.safeParse({ approvals }).success).toBe(true)
    expect(globalSchema.safeParse({ approvals: { ...approvals, [fingerprint]: { approvedAt: 0 } } }).success).toBe(false)
    const imports = Object.fromEntries(Array.from({ length: BOT_TEMPLATE_IMPORT_BINDING_LIMIT }, (_, index) => [
      index.toString(16).padStart(64, '0'), { fingerprint, botId: 'bot-research' },
    ]))
    expect(globalSchema.safeParse({ imports }).success).toBe(true)
    expect(globalSchema.safeParse({ imports: { ...imports, [fingerprint]: { fingerprint, botId: 'bot-research' } } }).success)
      .toBe(false)
  })

  it('normalizes bounded identifiers and rejects malformed durable values', () => {
    expect(normalizeBotTemplateId(BotTemplateId('bot-template-test'))).toBe('bot-template-test')
    expect(() => normalizeBotTemplateId(BotTemplateId('template-test'))).toThrow(/bot-template-/)
    expect(() => { Reflect.apply(normalizeBotTemplateId, undefined, [null]) }).toThrow(/bot-template-/)
    expect(normalizeBotTemplateShareCode(BotTemplateShareCode('portable-code'))).toBe('portable-code')
    for (const value of ['', ' padded ', 'x'.repeat(BOT_TEMPLATE_CODE_MAX_LENGTH + 1)]) {
      expect(() => normalizeBotTemplateShareCode(BotTemplateShareCode(value))).toThrow(/bounded/)
    }
    expect(() => { Reflect.apply(normalizeBotTemplateShareCode, undefined, [null]) }).toThrow(/bounded/)
  })
})
