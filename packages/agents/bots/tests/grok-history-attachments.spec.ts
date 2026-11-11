import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, open, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GrokHistoryAttachmentVault } from '../src/grok-history-attachments.ts'
import { BotId, type BotGrokHistoryArchive } from '../src/types.ts'

const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

const botId = BotId('bot-test')
const file = Buffer.from('synthetic bytes')
const sha256 = createHash('sha256').update(file).digest('hex')
const message = { role: 'attachment', text: 'Report 📄.txt', timestampMs: 123, sourceSequence: 0 }
const target = { botId, sourceId: 'primary', sourceSequence: 0 }
const entry = { ...target, filename: message.text, timestampMs: message.timestampMs, sha256 }
const archive: BotGrokHistoryArchive = {
  version: 2, source: 'grok-bot', firstCachedSequence: 0, messages: [message],
  sources: [{ id: 'supplement', label: 'Supplement', firstCachedSequence: 0, messages: [message] }],
}

let root: string

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'grok-attachment-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function manifest(entries: readonly unknown[]): Promise<void> {
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ version: 1, entries }))
}

describe('Grok history attachment vault', () => {
  it('offers and streams only an exact verified record', async () => {
    await manifest([entry, { ...entry, sourceId: 'missing' }])
    await writeFile(join(root, sha256), file)
    const vault = await GrokHistoryAttachmentVault.load(root)
    expect(await vault.available(botId, archive)).toEqual([{ sourceId: 'primary', sourceSequence: 0 }])
    const download = await vault.open(archive, target)
    expect(download?.name).toBe(message.text)
    const chunks: Uint8Array[] = []
    for await (const chunk of download!.data) chunks.push(chunk)
    expect(Buffer.concat(chunks)).toEqual(file)
    for (const mismatch of [
      { ...target, botId: BotId('bot-different') },
      { ...target, sourceId: 'supplement' },
      { ...target, sourceId: 'missing' },
      { ...target, sourceSequence: 1 },
    ]) {
      expect(await vault.open(archive, mismatch)).toBeUndefined()
    }
    for (const differentMessage of [
      { ...message, role: 'assistant' },
      { ...message, text: 'Different.txt' },
      { ...message, timestampMs: 124 },
    ]) {
      expect(await vault.open({ ...archive, messages: [differentMessage] }, target)).toBeUndefined()
    }
    expect(await vault.available(botId, { ...archive, version: 1 })).toEqual([])
    expect(await vault.available(BotId('bot-different'), archive)).toEqual([])
  })

  it('treats missing, altered, linked and non-file objects as unavailable and retries restored bytes', async () => {
    await manifest([{ ...entry, sourceId: 'supplement' }])
    const supplemental = { ...target, sourceId: 'supplement' }
    const vault = await GrokHistoryAttachmentVault.load(root)
    const blob = join(root, sha256)
    expect(await vault.available(botId, archive)).toEqual([])
    expect(await vault.open(archive, supplemental)).toBeUndefined()
    await writeFile(blob, Buffer.alloc(file.length))
    expect(await vault.open(archive, supplemental)).toBeUndefined()
    await rm(blob)
    await mkdir(blob)
    expect(await vault.open(archive, supplemental)).toBeUndefined()
    await rm(blob, { recursive: true })
    await writeFile(join(root, 'other'), file)
    await symlink('other', blob)
    expect(await vault.open(archive, supplemental)).toBeUndefined()
    await rm(blob)
    await writeFile(blob, file)
    const reopened = await GrokHistoryAttachmentVault.load(root)
    expect(await reopened.available(botId, archive)).toEqual([{ sourceId: 'supplement', sourceSequence: 0 }])
    const abort = new AbortController()
    const download = await reopened.open(archive, supplemental, abort.signal)
    abort.abort()
    await expect(download!.data[Symbol.asyncIterator]().next()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects oversized files and a file replaced between stat and open', async () => {
    await manifest([entry])
    const vault = await GrokHistoryAttachmentVault.load(root)
    const path = join(root, sha256)
    await writeFile(path, file)
    await truncate(path, 20 * 1024 * 1024 + 1)
    expect(await vault.open(archive, target)).toBeUndefined()
    await writeFile(path, file)
    const replacement = join(root, 'replacement')
    await writeFile(replacement, file)
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      await rename(replacement, path)
      return realFs.open(...args)
    })
    expect(await vault.open(archive, target)).toBeUndefined()
    expect(await vault.available(botId, archive)).toEqual([{ sourceId: 'primary', sourceSequence: 0 }])
  })

  it('rejects missing, malformed, and duplicate manifest entries without disclosing the vault path', async () => {
    const invalid = 'Invalid Grok history attachment vault manifest'
    await expect(GrokHistoryAttachmentVault.load('relative')).rejects.toThrow('absolute directory path')
    await expect(GrokHistoryAttachmentVault.load(root)).rejects.toThrow(invalid)
    const path = join(root, 'manifest.json')
    await mkdir(path)
    await expect(GrokHistoryAttachmentVault.load(root)).rejects.toThrow(invalid)
    await rm(path, { recursive: true })
    await writeFile(path, '{')
    await truncate(path, 2 * 1024 * 1024 + 1)
    await expect(GrokHistoryAttachmentVault.load(root)).rejects.toThrow(invalid)
    await writeFile(path, '{')
    await expect(GrokHistoryAttachmentVault.load(root)).rejects.toThrow(invalid)
    for (const entries of [[entry, entry], [{ ...entry, sha256: '../other' }], [{ ...entry, filename: '../other' }]]) {
      await manifest(entries)
      await expect(GrokHistoryAttachmentVault.load(root)).rejects.toThrow(invalid)
    }
  })
})
