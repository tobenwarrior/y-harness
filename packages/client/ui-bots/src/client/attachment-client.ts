/** Browser-side admission and upload helpers for Bot-group attachments. */

import { brandString } from '@yharness/brand'
import type {
  BotAttachmentGrantId as BotAttachmentGrantIdType,
  BotAttachmentGrantValue,
  BotGroupImageAdmissionRequest,
  BotId as BotIdType,
  BotGroupId as BotGroupIdType,
  BotGroupMessageId as BotGroupMessageIdType,
} from '@yharness/bots/client'
import { bytesToBase64 } from '@yharness/util-crypto'
import type { BotGroupAttachmentDraft } from './types.ts'

/** Exact owner or shared file-upload route selected by the caller. */
export type BotGroupAttachmentUploadPath =
  | '/api/bots/group/uploadAttachment'
  | '/shared-bots/bots/share/uploadAttachment'

/** Fetch carrier used for streaming a browser-owned file to the Host. */
export type BotAttachmentFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

/** Scope shared by image admission and streamed file upload. */
export interface BotGroupAttachmentScope {
  /** Group receiving the message. */
  readonly groupId: string
  /** Stable message id selected before any upload. */
  readonly messageId: string
  /** Explicit recipients, or all other group members when omitted. */
  readonly targetBotIds?: readonly string[]
}

/** Safe failure raised when an upload response cannot be trusted. */
export class BotAttachmentClientError extends Error {
  /** @param code - Gateway-style failure category. @param message - Safe user-facing detail. */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'BotAttachmentClientError'
  }
}

const SUPPORTED_IMAGE_TYPES = new Set<BotGroupImageAdmissionRequest['image']['mediaType']>([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
])
const GRANT_ID_PATTERN = /^bot-attachment-grant-[A-Za-z0-9][A-Za-z0-9-]*$/
const BOT_ID_PATTERN = /^bot-[A-Za-z0-9][A-Za-z0-9-]*$/
const GROUP_ID_PATTERN = /^bot-group-[A-Za-z0-9][A-Za-z0-9-]*$/
const MESSAGE_ID_PATTERN = /^bot-group-message-[A-Za-z0-9][A-Za-z0-9-]*$/

/** Whether a browser file uses the bounded image-admission path. */
export function isBotGroupImageType(value: string): value is BotGroupImageAdmissionRequest['image']['mediaType'] {
  return SUPPORTED_IMAGE_TYPES.has(value as BotGroupImageAdmissionRequest['image']['mediaType'])
}

/**
 * Admit each browser draft and return only opaque grant ids for the message send.
 * Images use the caller's bounded JSON admission RPC; other files use the exact
 * streaming route. The function does not persist drafts or retry side effects.
 * @param scope - Stable group/message scope selected before upload.
 * @param drafts - Browser-owned files to admit in display order.
 * @param admitImage - Caller-owned image admission RPC.
 * @param fetcher - Browser or test fetch carrier for streamed files.
 * @param uploadPath - Authenticated owner or shared upload route.
 * @returns Opaque grant ids in the same order as drafts.
 */
export async function admitBotGroupAttachments(
  scope: BotGroupAttachmentScope,
  drafts: readonly BotGroupAttachmentDraft[],
  admitImage: (request: BotGroupImageAdmissionRequest) => Promise<BotAttachmentGrantValue>,
  fetcher: BotAttachmentFetch,
  uploadPath: BotGroupAttachmentUploadPath,
): Promise<readonly BotAttachmentGrantIdType[]> {
  validateScope(scope)
  return Promise.all(drafts.map(async (draft) => {
    const mediaType = imageMediaType(draft.file.type)
    if (mediaType !== undefined) {
      const data = bytesToBase64(new Uint8Array(await draft.file.arrayBuffer()))
      const result = await admitImage({
        groupId: brandString<BotGroupIdType>(scope.groupId),
        messageId: brandString<BotGroupMessageIdType>(scope.messageId),
        ...(scope.targetBotIds === undefined ? {} : {
          targetBotIds: scope.targetBotIds.map(id => brandString<BotIdType>(id)),
        }),
        image: {
          mediaType,
          data,
          ...(draft.file.name === '' ? {} : { name: draft.file.name }),
        },
      })
      validateGrantValue(result)
      return result.grantId
    }
    return uploadFile(scope, draft.file, fetcher, uploadPath)
  }))
}

/** Validate an image media type without treating arbitrary image MIME values as raster input. */
function imageMediaType(value: string): BotGroupImageAdmissionRequest['image']['mediaType'] | undefined {
  return isBotGroupImageType(value)
    ? value as BotGroupImageAdmissionRequest['image']['mediaType']
    : undefined
}

async function uploadFile(
  scope: BotGroupAttachmentScope,
  file: File,
  fetcher: BotAttachmentFetch,
  uploadPath: BotGroupAttachmentUploadPath,
): Promise<BotAttachmentGrantIdType> {
  const url = new URL(uploadPath, browserOrigin())
  url.searchParams.set('scope', 'group')
  url.searchParams.set('groupId', scope.groupId)
  url.searchParams.set('messageId', scope.messageId)
  for (const targetBotId of scope.targetBotIds ?? []) url.searchParams.append('targetBotId', targetBotId)
  if (file.name !== '') url.searchParams.set('name', file.name)
  let response: Response
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    })
  } catch (error: unknown) {
    throw new BotAttachmentClientError('gateway/transport', error instanceof Error ? error.message : 'Bot attachment upload failed')
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new BotAttachmentClientError('gateway/invalid-response', 'Bot attachment upload returned invalid JSON')
  }
  if (!isRecord(payload)) throw new BotAttachmentClientError('gateway/invalid-response', 'Bot attachment upload returned an invalid response')
  if (payload.ok !== true) {
    const error = parseError(payload.error)
    throw new BotAttachmentClientError(error?.code ?? `gateway/http-${String(response.status)}`, error?.message ?? 'Bot attachment upload failed')
  }
  const value = parseBotAttachmentGrantValue(payload.value)
  if (value === undefined) throw new BotAttachmentClientError('gateway/invalid-response', 'invalid attachment grant response')
  return value.grantId
}

function validateScope(scope: BotGroupAttachmentScope): void {
  if (!GROUP_ID_PATTERN.test(scope.groupId) || !MESSAGE_ID_PATTERN.test(scope.messageId)) {
    throw new BotAttachmentClientError('gateway/bad-request', 'Bot attachment message scope is invalid')
  }
  if (scope.targetBotIds !== undefined
    && (scope.targetBotIds.length > 6
      || new Set(scope.targetBotIds).size !== scope.targetBotIds.length
      || scope.targetBotIds.some(id => !BOT_ID_PATTERN.test(id)))) {
    throw new BotAttachmentClientError('gateway/bad-request', 'Bot attachment recipients are invalid')
  }
}

function validateGrantValue(value: BotAttachmentGrantValue): void {
  if (parseBotAttachmentGrantValue(value) === undefined) throw new BotAttachmentClientError('gateway/invalid-response', 'invalid attachment grant response')
}

/** Parse and validate a Host-issued opaque attachment grant response. */
export function parseBotAttachmentGrantValue(value: unknown): BotAttachmentGrantValue | undefined {
  if (!isRecord(value) || typeof value.grantId !== 'string' || !GRANT_ID_PATTERN.test(value.grantId)
    || !Array.isArray(value.attachments) || value.attachments.length < 1 || value.attachments.length > 8) return undefined
  const attachments = value.attachments.map(parseMetadata)
  if (attachments.some(attachment => attachment === undefined)) return undefined
  return {
    grantId: brandString<BotAttachmentGrantIdType>(value.grantId),
    attachments: attachments as BotAttachmentGrantValue['attachments'],
  }
}

function parseMetadata(value: unknown): BotAttachmentGrantValue['attachments'][number] | undefined {
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.bytes !== 'number'
    || !Number.isSafeInteger(value.bytes) || value.bytes < 0) return undefined
  if (value.type === 'file') {
    return typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 255
      ? { type: 'file', name: value.name, bytes: value.bytes }
      : undefined
  }
  if (value.type !== 'image' || typeof value.mediaType !== 'string'
    || !isBotGroupImageType(value.mediaType)
    || typeof value.width !== 'number' || !Number.isSafeInteger(value.width) || value.width < 1
    || typeof value.height !== 'number' || !Number.isSafeInteger(value.height) || value.height < 1
    || (value.name !== undefined && (typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 255))) return undefined
  return {
    type: 'image', mediaType: value.mediaType as BotGroupImageAdmissionRequest['image']['mediaType'], bytes: value.bytes,
    width: value.width, height: value.height, ...(value.name === undefined ? {} : { name: value.name }),
  }
}

function parseError(value: unknown): { readonly code: string; readonly message: string } | undefined {
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.message !== 'string') return undefined
  return { code: value.code, message: value.message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function browserOrigin(): string {
  const locationValue = globalThis.location
  return typeof locationValue?.origin === 'string' && locationValue.origin !== '' ? locationValue.origin : 'http://dsh.internal'
}
