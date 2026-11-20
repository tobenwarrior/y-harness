/** Publish exact owner-Bot assignments for the installed isolated browser and Vault. */

import { randomUUID } from 'node:crypto'
import { lstat, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BotId } from '@yharness/bots'
import type { SessionId } from '@yharness/session/types'

const BOT = /^bot-[a-zA-Z0-9][a-zA-Z0-9-]{0,245}$/u
const SESSION = /^bot-session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_BOTS = 64
const PUBLISHER_MODE = 0o2750
const ROSTER_MODE = 0o640

/** Only identity fields needed for validating Browser and Vault access. */
export interface VpsBrowserRosterEntry {
  readonly bot: BotId
  readonly session: SessionId
}

async function writeRoster(path: string, body: string): Promise<void> {
  const directory = dirname(path)
  const metadata = await lstat(directory)
  if (!metadata.isDirectory() || metadata.uid !== process.geteuid?.() || (metadata.mode & 0o7777) !== PUBLISHER_MODE) {
    throw new Error('The isolated browser roster directory is unavailable.')
  }
  const temporary = join(directory, '.yharness-roster-' + randomUUID())
  const file = await open(temporary, 'wx', 0o600)
  try {
    try {
      await file.writeFile(body, 'ascii')
      await file.chmod(ROSTER_MODE)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** Serialize roster updates so a refresh never replaces a newer active selection. */
export class VpsBrowserRoster {
  private revision = 0
  private writtenRevision = -1
  private body: string | undefined
  private syncing: Promise<void> | undefined
  private closed = false

  /** @param path - Installer-prepared Cloud-owned destination.
   * @param read - Read the active, eligible owner Bot pairs from Cloud.
   */
  constructor(
    private readonly path: string,
    private readonly read: () => Promise<readonly VpsBrowserRosterEntry[]>,
  ) {}

  /** Mark the cached roster stale after a durable Bot change. */
  invalidate(): void {
    this.revision++
  }

  /** Publish all known changes before admitting an isolated browser operation.
   * @returns When the latest roster is available to the worker.
   * @throws When the roster closes before synchronization completes.
   */
  async sync(): Promise<void> {
    while (!this.closed && this.writtenRevision !== this.revision) {
      this.syncing ??= this.publish().finally(() => { this.syncing = undefined })
      await this.syncing
    }
    if (this.closed) throw new Error('The isolated browser roster is unavailable.')
  }

  /** Quiesce the writer while leaving the published assignments on disk.
   * @returns When any in-flight write has settled.
   */
  async close(): Promise<void> {
    this.closed = true
    await this.syncing?.catch((error: unknown) => { void error })
  }

  private async publish(): Promise<void> {
    while (!this.closed && this.writtenRevision !== this.revision) {
      const revision = this.revision
      const pairs = await this.read()
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- The roster can close while the read is pending.
      if (this.closed) return
      if (revision !== this.revision) continue
      if (pairs.length > MAX_BOTS || new Set(pairs.map(pair => pair.bot)).size !== pairs.length
        || new Set(pairs.map(pair => pair.session)).size !== pairs.length
        || pairs.some(pair => !BOT.test(pair.bot) || !SESSION.test(pair.session))) {
        throw new Error('The isolated browser roster contains an invalid Bot assignment.')
      }
      const body = JSON.stringify(Array.from(pairs).sort((a, b) => a.bot.localeCompare(b.bot))) + '\n'
      if (body !== this.body) {
        await writeRoster(this.path, body)
        this.body = body
      }
      this.writtenRevision = revision
    }
  }
}
