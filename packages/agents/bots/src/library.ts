/** Bounded owner-facing projection of Bot-created presented files. */

import type { SessionId } from '@yharness/session'
import type { BotId, BotLibraryCursor, BotLibraryItem, BotLibraryValue } from './types.ts'

/** Default number of newest Library items returned by one request. */
export const BOT_LIBRARY_DEFAULT_LIMIT = 20
/** Largest page a Library request may ask the Host to project. */
export const BOT_LIBRARY_MAX_LIMIT = 50
/** Maximum number of Session events read per bounded storage request. */
export const BOT_LIBRARY_READ_CHUNK = 64
/** Maximum event range inspected before a page returns an older continuation. */
export const BOT_LIBRARY_MAX_SCAN_EVENTS = BOT_LIBRARY_READ_CHUNK * 4

const PRESENTED_EVENT_TYPE: string = 'deliverables/presented'
const MAX_LABEL_LENGTH = 160
const IMAGE_EXTENSIONS = new Set(['avif', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'])
const AUDIO_EXTENSIONS = new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav', 'weba'])
const VIDEO_EXTENSIONS = new Set(['avi', 'mkv', 'mov', 'mp4', 'mpeg', 'webm'])

/** The bounded event reader needed by the Library projector. */
export interface BotLibraryEventReader {
  /** Number of events currently visible in the Session log. */
  readonly eventCount: number
  /** Read one half-open event range without materializing the rest of the log. */
  read(offset: number, length: number, signal?: AbortSignal): Promise<readonly BotLibraryEvent[]>
}

/** Minimal event fields needed to inspect a presented-file declaration. */
export interface BotLibraryEvent {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data: unknown
}

interface PresentedLibraryFile {
  /** Original position in the durable event's files array. */
  readonly index: number
  readonly path: string
  readonly description?: string
}

/** Return whether an unknown value is a non-array record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Return whether an unknown value is a read-only array of unknown entries. */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

/** Read the durable presented-file payload without trusting its filesystem path. */
function presentedFilesOf(event: BotLibraryEvent): readonly PresentedLibraryFile[] {
  if (event.type !== PRESENTED_EVENT_TYPE || !isRecord(event.data) || !isUnknownArray(event.data.files)) return []
  const rawFiles = event.data.files
  const files: PresentedLibraryFile[] = []
  for (let index = 0; index < rawFiles.length; index += 1) {
    const candidate = rawFiles[index]
    if (!isRecord(candidate) || typeof candidate.path !== 'string' || candidate.path.trim().length === 0) continue
    if (candidate.description !== undefined && typeof candidate.description !== 'string') continue
    files.push(candidate.description === undefined
      ? { index, path: candidate.path }
      : { index, path: candidate.path, description: candidate.description })
  }
  return files
}

/** Return a short label that never exposes the original path field. */
function libraryLabel(file: PresentedLibraryFile): string {
  const description = file.description?.replace(/[\\/]/g, ' ').replace(/\s+/g, ' ').trim()
  if (description !== undefined && description.length > 0) {
    return description.length <= MAX_LABEL_LENGTH
      ? description
      : `${description.slice(0, MAX_LABEL_LENGTH - 1)}…`
  }
  const base = file.path.replaceAll('\\', '/').replace(/^.*\//, '').trim()
  if (base.length === 0 || base === '.' || base === '..') return 'Presented file'
  return base.length <= MAX_LABEL_LENGTH ? base : `${base.slice(0, MAX_LABEL_LENGTH - 1)}…`
}

/** Classify a presented filename for the Library badge without resolving its path. */
function libraryCategory(file: PresentedLibraryFile): BotLibraryItem['category'] {
  const base = file.path.replaceAll('\\', '/').replace(/^.*\//, '')
  const extension = base.slice(base.lastIndexOf('.') + 1).toLowerCase()
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  return 'file'
}

/** Compare two stable event/file positions in newest-first order. */
function isOlder(position: BotLibraryCursor, before: BotLibraryCursor): boolean {
  return position.eventSeq < before.eventSeq
    || (position.eventSeq === before.eventSeq && position.fileIndex < before.fileIndex)
}

/**
 * Read a newest-first page of Bot-presented files from a bounded event reader.
 *
 * The cursor is exclusive and includes the file index because one presented event
 * can declare more than one file. The projector intentionally returns only safe
 * labels and coordinates; the original path remains private to the existing
 * authenticated open/download handlers.
 *
 * @param botId - owner-scoped Bot identity to place on each result.
 * @param sessionId - Session identity used by the existing download routes.
 * @param reader - bounded live or persisted Session event reader.
 * @param limit - validated page size.
 * @param before - optional exclusive cursor for older items.
 * @param signal - optional cancellation for storage reads.
 * @returns the newest page and an exclusive cursor when older items remain.
 */
export async function readBotLibraryPage(
  botId: BotId,
  sessionId: SessionId,
  reader: BotLibraryEventReader,
  limit: number,
  before?: BotLibraryCursor,
  signal?: AbortSignal,
): Promise<BotLibraryValue> {
  const eventCount = Math.max(0, Math.floor(reader.eventCount))
  let endExclusive = before === undefined
    ? eventCount
    : Math.min(eventCount, before.eventSeq + (before.fileIndex === 0 ? 0 : 1))
  const items: BotLibraryItem[] = []
  let hasOlder = false
  let continuationEndExclusive: number | undefined
  let scannedEvents = 0

  while (endExclusive > 0 && scannedEvents < BOT_LIBRARY_MAX_SCAN_EVENTS) {
    signal?.throwIfAborted()
    const start = Math.max(0, endExclusive - BOT_LIBRARY_READ_CHUNK)
    const readLength = Math.min(endExclusive - start, BOT_LIBRARY_MAX_SCAN_EVENTS - scannedEvents)
    const events = await reader.read(start, readLength, signal)
    if (events.length === 0) break
    scannedEvents += readLength
    continuationEndExclusive = start
    for (const event of Array.from(events).reverse()) {
      if (hasOlder) break
      const eventSeq = event.seq
      const files = presentedFilesOf(event)
      for (const file of Array.from(files).reverse()) {
        const position = { eventSeq, fileIndex: file.index }
        if (before !== undefined && !isOlder(position, before)) continue
        if (items.length >= limit) {
          hasOlder = true
          break
        }
        items.push({
          botId,
          sessionId,
          eventSeq,
          fileIndex: file.index,
          label: libraryLabel(file),
          category: libraryCategory(file),
          createdAt: event.time,
        })
      }
    }
    if (hasOlder || start === 0) break
    endExclusive = start
    if (scannedEvents >= BOT_LIBRARY_MAX_SCAN_EVENTS) break
  }

  const last = items.at(-1)
  if (hasOlder && last !== undefined) {
    return {
      botId,
      items,
      nextBefore: { eventSeq: last.eventSeq, fileIndex: last.fileIndex },
    }
  }
  if (continuationEndExclusive !== undefined && continuationEndExclusive > 0) {
    return { botId, items, nextBefore: { eventSeq: continuationEndExclusive, fileIndex: 0 } }
  }
  return { botId, items }
}
