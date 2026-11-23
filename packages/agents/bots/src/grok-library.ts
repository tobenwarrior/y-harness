/** Owner-facing projection of attachments and links recovered from a Grok archive. */

import type {
  BotGrokHistoryArchive,
  BotGrokHistoryAttachmentPosition,
  BotGrokHistoryMessage,
  BotGrokLibraryCursor,
  BotGrokLibraryItem,
  BotGrokLibraryValue,
  BotId,
} from './types.ts'
import { readLibraryLinks } from './library-links.ts'
import { classifyLibraryFilename } from './library.ts'

/** Maximum imported messages inspected by one page request. */
export const BOT_GROK_LIBRARY_MAX_SCAN_MESSAGES = 256

const PRIMARY_SOURCE_ID = 'primary'
const MAX_ATTACHMENT_LABEL_LENGTH = 160

interface ArchiveSource {
  readonly id: string
  readonly key: string
  readonly label?: string
  readonly messages: readonly BotGrokHistoryMessage[]
}

interface ArchiveMessage {
  readonly source: ArchiveSource
  readonly message: BotGrokHistoryMessage
}

function sourceKey(sourceId: string): string {
  return sourceId === PRIMARY_SOURCE_ID ? '' : sourceId
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareTimestampsNewest(left: number | null, right: number | null): number {
  if (left === right) return 0
  if (left === null) return 1
  if (right === null) return -1
  return left > right ? -1 : 1
}

function comparePositionNewest(
  left: { readonly createdAt: number | null; readonly sourceKey: string; readonly sourceSequence: number; readonly itemIndex: number },
  right: { readonly createdAt: number | null; readonly sourceKey: string; readonly sourceSequence: number; readonly itemIndex: number },
): number {
  const timestampOrder = compareTimestampsNewest(left.createdAt, right.createdAt)
  if (timestampOrder !== 0) return timestampOrder
  const sourceOrder = compareStrings(left.sourceKey, right.sourceKey)
  if (sourceOrder !== 0) return sourceOrder
  const sequenceOrder = right.sourceSequence - left.sourceSequence
  return sequenceOrder !== 0 ? sequenceOrder : right.itemIndex - left.itemIndex
}

function attachmentPositionKey(position: BotGrokHistoryAttachmentPosition): string {
  return JSON.stringify([position.sourceId, position.sourceSequence])
}

function safeAttachmentLabel(message: BotGrokHistoryMessage): string | undefined {
  if (message.text.length === 0 || message.text.length > 255 || !message.text.isWellFormed()) return undefined
  if (/[\\/\u0000-\u001f\u007f]/u.test(message.text)) return undefined
  return message.text.length <= MAX_ATTACHMENT_LABEL_LENGTH
    ? message.text
    : `${message.text.slice(0, MAX_ATTACHMENT_LABEL_LENGTH - 1)}…`
}

function sourcesOf(archive: BotGrokHistoryArchive): readonly ArchiveSource[] {
  const primary: ArchiveSource = {
    id: PRIMARY_SOURCE_ID,
    key: sourceKey(PRIMARY_SOURCE_ID),
    messages: archive.messages,
  }
  const sources = archive.version === 2
    ? (archive.sources ?? []).map(source => ({
      id: source.id,
      key: sourceKey(source.id),
      label: source.label,
      messages: source.messages,
    }))
    : []
  return [primary, ...sources].toSorted((left, right) => compareStrings(left.key, right.key))
}

function archiveMessagesOf(archive: BotGrokHistoryArchive): readonly ArchiveMessage[] {
  return sourcesOf(archive).flatMap(source => source.messages.map(message => ({ source, message }))).toSorted((left, right) => {
    const order = compareTimestampsNewest(left.message.timestampMs, right.message.timestampMs)
    if (order !== 0) return order
    const sourceOrder = compareStrings(left.source.key, right.source.key)
    if (sourceOrder !== 0) return sourceOrder
    return right.message.sourceSequence - left.message.sourceSequence
  })
}

/**
 * List attachment coordinates without opening or trusting any vault object.
 *
 * The Host uses these coordinates to identify page candidates; the attachment
 * vault remains the authority that decides whether a candidate is returned.
 *
 * @param archive - Validated archive whose attachment records are inspected.
 * @returns Attachment coordinates in stable source and transcript order.
 */
export function listBotGrokLibraryAttachmentPositions(
  archive: BotGrokHistoryArchive,
): readonly BotGrokHistoryAttachmentPosition[] {
  const positions: BotGrokHistoryAttachmentPosition[] = []
  for (const source of sourcesOf(archive)) {
    for (const message of source.messages) {
      if (message.role === 'attachment') positions.push({ sourceId: source.id, sourceSequence: message.sourceSequence })
    }
  }
  return positions
}

function itemFields(
  botId: BotId,
  source: ArchiveSource,
  message: BotGrokHistoryMessage,
  itemIndex: number,
): BotGrokLibraryCursor & Pick<BotGrokLibraryItem, 'botId' | 'origin' | 'sourceLabel' | 'createdAt'> {
  return {
    botId,
    origin: 'grok-history',
    sourceId: source.id,
    sourceSequence: message.sourceSequence,
    itemIndex,
    ...(source.label === undefined ? {} : { sourceLabel: source.label }),
    createdAt: message.timestampMs,
  }
}

function projectedMessage(
  botId: BotId,
  source: ArchiveSource,
  message: BotGrokHistoryMessage,
  availableAttachments: ReadonlySet<string>,
): readonly BotGrokLibraryItem[] {
  if (message.role === 'assistant') {
    return readLibraryLinks(message.text).map((link, itemIndex) => ({
      ...itemFields(botId, source, message, itemIndex),
      label: link.label,
      category: 'link' as const,
      url: link.url,
    }))
  }
  if (message.role !== 'attachment' || !availableAttachments.has(attachmentPositionKey({
    sourceId: source.id,
    sourceSequence: message.sourceSequence,
  }))) return []
  const label = safeAttachmentLabel(message)
  return label === undefined ? [] : [{
    ...itemFields(botId, source, message, 0),
    label,
    category: classifyLibraryFilename(message.text),
  }]
}

function messageOrderAgainstCursor(
  candidate: ArchiveMessage,
  before: BotGrokLibraryCursor,
): number {
  if (before.createdAt !== undefined) {
    return comparePositionNewest({
      createdAt: candidate.message.timestampMs,
      sourceKey: candidate.source.key,
      sourceSequence: candidate.message.sourceSequence,
      itemIndex: 0,
    }, {
      createdAt: before.createdAt,
      sourceKey: sourceKey(before.sourceId),
      sourceSequence: before.sourceSequence,
      itemIndex: 0,
    })
  }
  const sourceOrder = compareStrings(candidate.source.key, sourceKey(before.sourceId))
  if (sourceOrder !== 0) return sourceOrder
  return before.sourceSequence - candidate.message.sourceSequence
}

function itemIsOlder(item: BotGrokLibraryItem, before: BotGrokLibraryCursor): boolean {
  if (before.createdAt !== undefined) {
    return comparePositionNewest({
      createdAt: item.createdAt,
      sourceKey: sourceKey(item.sourceId),
      sourceSequence: item.sourceSequence,
      itemIndex: item.itemIndex,
    }, {
      createdAt: before.createdAt,
      sourceKey: sourceKey(before.sourceId),
      sourceSequence: before.sourceSequence,
      itemIndex: before.itemIndex,
    }) > 0
  }
  const sourceOrder = compareStrings(sourceKey(item.sourceId), sourceKey(before.sourceId))
  if (sourceOrder !== 0) return sourceOrder > 0
  return item.sourceSequence < before.sourceSequence
    || item.sourceSequence === before.sourceSequence && item.itemIndex < before.itemIndex
}

function cursorOf(item: BotGrokLibraryItem): BotGrokLibraryCursor {
  return {
    sourceId: item.sourceId,
    sourceSequence: item.sourceSequence,
    itemIndex: item.itemIndex,
    createdAt: item.createdAt,
  }
}

/**
 * Project an owner-authorized archive into a deterministic newest-first page.
 *
 * Imported messages are ordered by immutable timestamp when present, then by
 * source id, source sequence, and item index. The projector scans newest to
 * oldest and stops after the bounded scan budget or once it has found the
 * requested page plus one older position. Imported records never become
 * Session events.
 *
 * @param botId - Owner-authorized Bot identity placed on every result.
 * @param archive - Validated imported archive to inspect without mutation.
 * @param availableAttachments - Positions whose vault bytes were verified.
 * @param limit - Validated page size.
 * @param before - Optional exclusive source/item cursor.
 * @returns Newest imported links and verified attachments, with an older cursor when needed.
 */
export function readBotGrokLibraryPage(
  botId: BotId,
  archive: BotGrokHistoryArchive,
  availableAttachments: readonly BotGrokHistoryAttachmentPosition[],
  limit: number,
  before?: BotGrokLibraryCursor,
): BotGrokLibraryValue {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('limit must be a positive safe integer')
  const available = new Set(availableAttachments.map(attachmentPositionKey))
  const messages = archiveMessagesOf(archive)
  const items: BotGrokLibraryItem[] = []
  let scannedMessages = 0
  let scanTruncated = false
  let olderPositionExists = false
  let oldestScanned: BotGrokLibraryCursor | undefined

  outer: for (const candidate of messages) {
    if (before !== undefined && messageOrderAgainstCursor(candidate, before) < 0) continue
    if (scannedMessages >= BOT_GROK_LIBRARY_MAX_SCAN_MESSAGES) {
      scanTruncated = true
      olderPositionExists = true
      break
    }
    scannedMessages += 1
    oldestScanned = {
      sourceId: candidate.source.id,
      sourceSequence: candidate.message.sourceSequence,
      itemIndex: 0,
      createdAt: candidate.message.timestampMs,
    }
    const projected = projectedMessage(botId, candidate.source, candidate.message, available)
    for (const item of projected.toReversed()) {
      if (before !== undefined && !itemIsOlder(item, before)) continue
      if (items.length >= limit) {
        olderPositionExists = true
        break outer
      }
      items.push(item)
    }
  }

  const last = items.at(-1)
  if (last !== undefined && (olderPositionExists || scanTruncated)) {
    return { botId, items, nextBefore: cursorOf(last) }
  }
  if (scanTruncated && oldestScanned !== undefined) {
    return { botId, items, nextBefore: oldestScanned }
  }
  return { botId, items }
}
