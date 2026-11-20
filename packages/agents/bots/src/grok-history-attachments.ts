/** Verify owner-staged files against attachment records in a Bot's private Grok archive. */

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { BotAttachmentDownload, BotGrokHistoryAttachmentDownloadTarget } from './attachment-download.ts'
import { BotId, type BotGrokHistoryArchive, type BotGrokHistoryAttachmentPosition } from './types.ts'

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_GROK_HISTORY_ATTACHMENT_BYTES = 24 * 1024 * 1024
const manifestSchema = z.object({
  version: z.literal(1),
  entries: z.array(z.object({
    botId: z.string().regex(/^bot-[A-Za-z0-9][A-Za-z0-9-]*$/).transform(BotId),
    sourceId: z.string().max(128).regex(/^\S(?:.*\S)?$/u).refine(value => value.trim() === value),
    sourceSequence: z.number().int().nonnegative(),
    filename: z.string().min(1).max(255).refine(name => name.isWellFormed() && !/[\\/\u0000-\u001f\u007f]/u.test(name)),
    timestampMs: z.number().int().min(0).max(8_640_000_000_000_000).nullable(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }).strict()),
}).strict()

type Entry = z.infer<typeof manifestSchema>['entries'][number]

function positionKey({ sourceId, sourceSequence }: BotGrokHistoryAttachmentPosition): string {
  return JSON.stringify([sourceId, sourceSequence])
}

function matches(archive: BotGrokHistoryArchive, entry: Entry): boolean {
  if (archive.version !== 2) return false
  const messages = entry.sourceId === 'primary'
    ? archive.messages
    : archive.sources?.find(source => source.id === entry.sourceId)?.messages
  const message = messages?.find(candidate => candidate.sourceSequence === entry.sourceSequence)
  return message?.role === 'attachment' && message.text === entry.filename && message.timestampMs === entry.timestampMs
}

async function openRegularFile(path: string): Promise<FileHandle | undefined> {
  const leaf = await lstat(path)
  if (!leaf.isFile()) return undefined
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let sameFile = false
  try {
    const opened = await file.stat()
    sameFile = opened.isFile() && opened.dev === leaf.dev && opened.ino === leaf.ino
    return sameFile ? file : undefined
  } finally {
    if (!sameFile) await file.close()
  }
}

async function loadManifest(root: string): Promise<z.infer<typeof manifestSchema>> {
  const file = await openRegularFile(join(root, 'manifest.json'))
  if (file === undefined) throw new Error('Manifest must be a regular file')
  try {
    const chunks: Buffer[] = []
    for await (const chunk of file.createReadStream({ autoClose: false, start: 0, end: MAX_MANIFEST_BYTES })) {
      chunks.push(chunk as Buffer)
    }
    const document = Buffer.concat(chunks)
    if (document.length > MAX_MANIFEST_BYTES) throw new Error('Manifest exceeds the size limit')
    return manifestSchema.parse(JSON.parse(document.toString('utf8')))
  } finally {
    await file.close()
  }
}

async function verifiedFile(
  root: string,
  entry: Entry,
  signal?: AbortSignal,
): Promise<{ readonly file: FileHandle; readonly size: number } | undefined> {
  let file: FileHandle | undefined
  let verified = false
  try {
    signal?.throwIfAborted()
    file = await openRegularFile(join(root, entry.sha256))
    if (file === undefined) return undefined
    const initial = await file.stat()
    if (initial.size > MAX_GROK_HISTORY_ATTACHMENT_BYTES) return undefined
    const hash = createHash('sha256')
    const end = Math.max(0, initial.size - 1)
    for await (const chunk of file.createReadStream({ autoClose: false, start: 0, end, signal })) {
      hash.update(chunk as Buffer)
    }
    const current = await file.stat()
    signal?.throwIfAborted()
    verified = current.size === initial.size && current.mtimeMs === initial.mtimeMs
      && current.ctimeMs === initial.ctimeMs && hash.digest('hex') === entry.sha256
    return verified ? { file, size: initial.size } : undefined
  } catch {
    // An unreadable vault object is unavailable. Cancellation still stops the whole request.
    signal?.throwIfAborted()
    return undefined
  } finally {
    if (!verified) await file?.close()
  }
}

/** Private, read-only index of hash-addressed files attested by the Host operator. */
export class GrokHistoryAttachmentVault {
  private constructor(
    private readonly root: string,
    private readonly byBot: ReadonlyMap<BotId, ReadonlyMap<string, Entry>>,
  ) {}

  /**
   * Load the manifest when the Bot service starts.
   * @param root - Absolute path to the operator-controlled vault directory.
   * @returns The validated index. An unreadable or invalid manifest prevents activation.
   */
  static async load(root: string): Promise<GrokHistoryAttachmentVault> {
    if (!isAbsolute(root)) throw new Error('Grok history attachment vault requires an absolute directory path')
    const byBot = new Map<BotId, Map<string, Entry>>()
    try {
      for (const entry of (await loadManifest(root)).entries) {
        const entries = byBot.get(entry.botId) ?? new Map<string, Entry>()
        const key = positionKey(entry)
        if (entries.has(key)) throw new Error('Duplicate attachment position')
        entries.set(key, entry)
        byBot.set(entry.botId, entries)
      }
    } catch {
      // The manifest may contain private Bot identities and filenames.
      throw new Error('Invalid Grok history attachment vault manifest')
    }
    return new GrokHistoryAttachmentVault(root, byBot)
  }

  /**
   * Check the files indexed for one authorized archive.
   * @param botId - Exact owner-authorized Bot.
   * @param archive - The current archive for that Bot.
   * @param signal - Cancellation for the owner request.
   * @returns Only the positions that match the archive and have verified bytes.
   */
  async available(
    botId: BotId,
    archive: BotGrokHistoryArchive,
    signal?: AbortSignal,
  ): Promise<BotGrokHistoryAttachmentPosition[]> {
    const available: BotGrokHistoryAttachmentPosition[] = []
    for (const entry of this.byBot.get(botId)?.values() ?? []) {
      if (!matches(archive, entry)) continue
      const verified = await verifiedFile(this.root, entry, signal)
      if (verified === undefined) continue
      await verified.file.close()
      available.push({ sourceId: entry.sourceId, sourceSequence: entry.sourceSequence })
    }
    return available
  }

  /**
   * Verify one attachment and transfer its open file to the download stream.
   * @param archive - The current archive for the owner-authorized Bot.
   * @param target - Exact authorized Bot and archive position.
   * @param signal - Cancellation for verification and download.
   * @returns A stream of the verified file, or undefined if the record or bytes are unavailable.
   */
  async open(
    archive: BotGrokHistoryArchive,
    target: BotGrokHistoryAttachmentDownloadTarget,
    signal?: AbortSignal,
  ): Promise<BotAttachmentDownload | undefined> {
    const entry = this.byBot.get(target.botId)?.get(positionKey(target))
    if (entry === undefined || !matches(archive, entry)) return undefined
    const verified = await verifiedFile(this.root, entry, signal)
    if (verified === undefined) return undefined
    const { file, size } = verified
    const data = file.createReadStream({ start: 0, end: Math.max(0, size - 1), signal })
    return { name: entry.filename, data }
  }
}
