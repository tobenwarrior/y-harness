/** Signed, self-contained Bot template codes and their boundary validation. */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'
import { z } from 'zod'
import { BOT_ACCENTS, BOT_IDENTITIES } from './types.ts'
import { BotTemplateShareCode } from './template-types.ts'
import type {
  BotTemplateAvatar,
  BotTemplateCapability,
  BotTemplateProfile,
  BotTemplateShareCode as BotTemplateShareCodeType,
} from './template-types.ts'

/** Prefix identifying the current portable Bot template format. */
export const BOT_TEMPLATE_CODE_PREFIX = 'yhbot-template-v2.'
/** Maximum encoded code size accepted at the Remote boundary. */
export const BOT_TEMPLATE_CODE_MAX_LENGTH = 384_000
/** Maximum generated avatar bytes embedded in one portable code. */
export const BOT_TEMPLATE_AVATAR_MAX_BYTES = 262_144
/** Current signed template format version. */
export const BOT_TEMPLATE_FORMAT_VERSION = 2

/** Safe profile and capability payload signed into a portable code. */
export interface BotTemplateArtifactPayload {
  /** Random publication nonce that prevents duplicate codes for equal snapshots. */
  readonly nonce?: string
  /** Display profile. */
  readonly profile: BotTemplateProfile
  /** Optional user-authored persona text. */
  readonly persona?: string
  /** Capability labels that remain declarations on import. */
  readonly capabilities: readonly BotTemplateCapability[]
  /** Optional preset id resolved by the target Host. */
  readonly agentPreset?: string
  /** Optional generated avatar bytes. */
  readonly avatar?: BotTemplateAvatar
  /** Publication time supplied by the publishing Host. */
  readonly issuedAt: number
}

/** Decoded and signature-verified portable template. */
export interface DecodedBotTemplateCode {
  /** Validated payload. */
  readonly payload: BotTemplateArtifactPayload
  /** Public Ed25519 key encoded in the artifact. */
  readonly publicKey: string
  /** SHA-256 fingerprint of the signing public key. */
  readonly issuerFingerprint: string
  /** Stable content fingerprint for local retry and revocation bookkeeping. */
  readonly fingerprint: string
}

/** Ed25519 key material used only by the publishing Host. */
export interface BotTemplateSigningKeys {
  /** Private key kept in Host storage and never included in a code. */
  readonly privateKey: KeyObject
  /** Public verification key embedded in signed codes. */
  readonly publicKey: string
}

const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/)
const boundedText = (max: number) => z.string().min(1).max(max).refine(value => value.trim() === value)
const capability = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/)
const artifactNonce = base64Url.min(22).max(64)

/** Stored and wire-safe portable avatar payload. */
export const botTemplateAvatarSchema = z.object({
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  data: base64Url.max(Math.ceil(BOT_TEMPLATE_AVATAR_MAX_BYTES * 4 / 3) + 8),
  bytes: z.number().safe().int().positive().max(BOT_TEMPLATE_AVATAR_MAX_BYTES),
  width: z.number().safe().int().positive().max(8192),
  height: z.number().safe().int().positive().max(8192),
  name: z.string().min(1).max(255).refine(value => value.trim() === value && !/[\\/\0]/u.test(value)).optional(),
}).strict().superRefine((value, context) => {
  let decoded: Buffer
  try {
    decoded = decodeBase64Url(value.data, 'avatar data')
  } catch (error: unknown) {
    context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid avatar data', path: ['data'] })
    return
  }
  if (decoded.byteLength !== value.bytes) {
    context.addIssue({ code: 'custom', message: 'Avatar byte count does not match its data', path: ['bytes'] })
  }
})

/** Stored and wire-safe portable display profile. */
export const botTemplateProfileSchema = z.object({
  name: boundedText(80),
  description: z.string().min(1).max(240).refine(value => value.trim() === value).optional(),
  identity: z.enum(BOT_IDENTITIES),
  accent: z.enum(BOT_ACCENTS),
}).strict()

const payloadSchema = z.object({
  // Older v2 codes did not carry a publication nonce. Keep those codes
  // readable while every newly encoded publication receives one below.
  nonce: artifactNonce.optional(),
  profile: botTemplateProfileSchema,
  persona: z.string().min(1).max(4000).refine(value => value.trim() === value).optional(),
  capabilities: z.array(capability).max(32).refine(values => new Set(values).size === values.length),
  agentPreset: boundedText(160).optional(),
  avatar: botTemplateAvatarSchema.optional(),
  issuedAt: z.number().safe().int().nonnegative(),
}).strict()

const envelopeSchema = z.object({
  version: z.literal(BOT_TEMPLATE_FORMAT_VERSION),
  publicKey: base64Url.max(256),
  payload: payloadSchema,
  signature: base64Url.max(256),
}).strict()

/** Generate one Host-local signing key pair.
 * @returns An Ed25519 key pair whose private key stays in Host storage.
 */
export function createBotTemplateSigningKeys(): BotTemplateSigningKeys {
  const keys = generateKeyPairSync('ed25519')
  return { privateKey: keys.privateKey, publicKey: publicKeyBytes(keys.privateKey) }
}

/** Serialize the private signing key for durable Host-local storage.
 * @param privateKey - Host-local Ed25519 private key.
 * @returns Base64url PKCS#8 key bytes.
 */
export function serializeBotTemplatePrivateKey(privateKey: KeyObject): string {
  requireEd25519(privateKey, 'private key')
  return privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url')
}

/** Restore a Host-local signing key from its storage representation.
 * @param value - Base64url PKCS#8 key bytes.
 * @returns Restored Ed25519 private key.
 */
export function restoreBotTemplatePrivateKey(value: string): KeyObject {
  const encoded = base64Url.max(1024).parse(value)
  return requireEd25519(createPrivateKey({ key: decodeBase64Url(encoded, 'private key'), format: 'der', type: 'pkcs8' }), 'private key')
}

/** Sign one validated payload into a portable code.
 * @param payload - Safe profile and data to include in the code.
 * @param privateKey - Host-local Ed25519 private key.
 * @returns Signed self-contained template code.
 */
export function encodeBotTemplateCode(
  payload: BotTemplateArtifactPayload,
  privateKey: KeyObject,
): BotTemplateShareCodeType {
  requireEd25519(privateKey, 'private key')
  const valid = payloadSchema.parse({
    ...payload,
    nonce: payload.nonce ?? randomBytes(16).toString('base64url'),
  }) as BotTemplateArtifactPayload
  const publicKey = publicKeyBytes(privateKey)
  const unsigned = { version: BOT_TEMPLATE_FORMAT_VERSION, publicKey, payload: valid }
  const canonical = canonicalJson(unsigned)
  const signature = sign(null, Buffer.from(canonical), privateKey).toString('base64url')
  const envelope = { ...unsigned, signature }
  const encoded = `${BOT_TEMPLATE_CODE_PREFIX}${Buffer.from(canonicalJson(envelope)).toString('base64url')}`
  if (encoded.length > BOT_TEMPLATE_CODE_MAX_LENGTH) throw new Error('Bot template code is too large')
  return BotTemplateShareCode(encoded)
}

/** Decode, validate, and verify one portable code from an untrusted caller.
 * @param code - Candidate signed template code.
 * @returns Verified payload and its content fingerprint.
 */
export function decodeBotTemplateCode(code: string | BotTemplateShareCodeType): DecodedBotTemplateCode {
  if (typeof code !== 'string' || code.length === 0) throw new Error('Bot template code is empty')
  if (code.length > BOT_TEMPLATE_CODE_MAX_LENGTH || !code.startsWith(BOT_TEMPLATE_CODE_PREFIX)) {
    throw new Error('Bot template code is invalid')
  }
  const encoded = code.slice(BOT_TEMPLATE_CODE_PREFIX.length)
  let parsed: ReturnType<typeof JSON.parse>
  try {
    parsed = JSON.parse(decodeBase64Url(encoded, 'template code').toString('utf8'))
  } catch (error: unknown) {
    throw new Error('Bot template code is invalid', { cause: error })
  }
  let envelope: z.infer<typeof envelopeSchema>
  try {
    envelope = envelopeSchema.parse(parsed)
  } catch (error: unknown) {
    throw new Error('Bot template payload is invalid', { cause: error })
  }
  const unsigned = { version: envelope.version, publicKey: envelope.publicKey, payload: envelope.payload }
  const canonical = canonicalJson(unsigned)
  let valid = false
  try {
    const publicKeyBytes = decodeBase64Url(envelope.publicKey, 'public key')
    const publicKey = requireEd25519(
      createPublicKey({ key: publicKeyBytes, format: 'der', type: 'spki' }),
      'public key',
    )
    valid = verify(null, Buffer.from(canonical), publicKey, decodeBase64Url(envelope.signature, 'signature'))
  } catch (error: unknown) {
    throw new Error('Bot template signature is invalid', { cause: error })
  }
  if (!valid) throw new Error('Bot template signature is invalid')
  return {
    payload: envelope.payload as BotTemplateArtifactPayload,
    publicKey: envelope.publicKey,
    issuerFingerprint: createHash('sha256').update(decodeBase64Url(envelope.publicKey, 'public key')).digest('hex'),
    fingerprint: createHash('sha256').update(canonical).digest('hex'),
  }
}

function publicKeyBytes(privateKey: KeyObject): string {
  return createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64url')
}

function requireEd25519(key: KeyObject, subject: string): KeyObject {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`Invalid ${subject}`)
  return key
}

function canonicalJson(value: object): string {
  return JSON.stringify(value)
}

function decodeBase64Url(value: string, subject: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error(`Invalid ${subject}`)
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) throw new Error(`Invalid ${subject}`)
  return decoded
}
