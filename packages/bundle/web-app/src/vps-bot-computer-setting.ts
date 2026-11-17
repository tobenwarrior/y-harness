/** Durable owner choices for a private VPS Bot Computer. */

import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

const SESSION_ID = /^bot-session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const CONTROL = /[\u0000-\u001f\u007f]/u
const POLICY_DIRECTORIES = { network: '.network-access', 'shared-workspace': '.shared-workspace-access' } as const
const POLICY_VERSION = 1
const POLICY_MAX_BYTES = 128
const POLICY_ERROR = 'VPS Bot computer setting is invalid.'
const NOFOLLOW = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
const pending = new Map<string, Promise<void>>()

/**
 * Persisted owner override for one exact Bot Session.
 *
 * The constructor does not touch the filesystem. Missing policy files are
 * represented by `undefined`; an existing damaged or unsafe policy rejects.
 */
export class VpsBotComputerSetting {
  private readonly root: string
  private readonly directory: string
  private readonly queueKey: string

  /**
   * @param root - Existing owner-controlled private root for Bot state.
   * @param setting - Selects a host-only record directory for this setting.
   */
  constructor(root: string, setting: keyof typeof POLICY_DIRECTORIES) {
    if (typeof root !== 'string' || root.length === 0 || !isAbsolute(root) || CONTROL.test(root)) throw invalidPolicy()
    this.root = resolve(root)
    this.directory = join(this.root, POLICY_DIRECTORIES[setting])
    this.queueKey = this.directory
  }

  /**
   * Read one durable owner override.
   * @param sessionId - Canonical Bot Session UUIDv4 used as the exact filename.
   * @returns The stored decision, or `undefined` when no override is present.
   */
  async get(sessionId: string): Promise<boolean | undefined> {
    validateSession(sessionId)
    return await serialize(this.queueKey, async () => {
      if (!await this.ensureDirectory(false)) return undefined
      return await this.readEntry(sessionId)
    })
  }

  /**
   * Store one owner-selected override with an atomic, durable replacement.
   * @param sessionId - Canonical Bot Session UUIDv4 used as the exact filename.
   * @param enabled - Whether the owner enabled this setting.
   * @returns A promise settled after the file and containing directory are synced.
   */
  async set(sessionId: string, enabled: boolean): Promise<void> {
    validateSession(sessionId)
    if (typeof enabled !== 'boolean') throw invalidPolicy()
    await serialize(this.queueKey, async () => {
      await this.ensureDirectory(true)
      const current = await this.readEntry(sessionId)
      if (current === enabled) return
      await this.writeEntry(sessionId, enabled)
    })
  }

  private async ensureDirectory(create: boolean): Promise<boolean> {
    if (!await hasValidRoot(this.root)) {
      if (create) throw invalidPolicy()
      return false
    }
    let info = await optionalLstat(this.directory)
    if (info === undefined && create) {
      try {
        await mkdir(this.directory, { mode: 0o700 })
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw invalidPolicy()
      }
      info = await optionalLstat(this.directory)
    }
    if (info === undefined) return false
    if (!info.isDirectory() || info.isSymbolicLink() || !safeOwner(info) || !exactMode(info, 0o700)) throw invalidPolicy()
    return true
  }

  private async readEntry(sessionId: string): Promise<boolean | undefined> {
    const target = join(this.directory, sessionId)
    const linkInfo = await optionalLstat(target)
    if (linkInfo === undefined) return undefined
    if (!safeFile(linkInfo)) throw invalidPolicy()

    let handle: FileHandle | undefined
    try {
      handle = await open(target, constants.O_RDONLY | NOFOLLOW)
      const info = await handle.stat()
      if (!safeFile(info) || info.size > POLICY_MAX_BYTES) throw invalidPolicy()
      const text = await handle.readFile({ encoding: 'utf8' })
      const value = parsePolicy(text)
      await handle.close()
      handle = undefined
      return value
    } catch (error) {
      if (handle !== undefined) {
        try {
          await handle.close()
        } catch (closeError) {
          void closeError
        }
      }
      if (isPolicyError(error)) throw error
      throw invalidPolicy()
    }
  }

  private async writeEntry(sessionId: string, enabled: boolean): Promise<void> {
    const target = join(this.directory, sessionId)
    const existing = await optionalLstat(target)
    if (existing !== undefined && !safeFile(existing)) throw invalidPolicy()

    const temporary = join(this.directory, `.${sessionId}.${randomUUID()}.tmp`)
    let handle: FileHandle | undefined
    let created = false
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
      created = true
      await handle.chmod(0o600)
      await handle.writeFile(JSON.stringify({ version: POLICY_VERSION, enabled }) + '\n', 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined

      const current = await optionalLstat(target)
      if (current !== undefined && !safeFile(current)) throw invalidPolicy()
      await rename(temporary, target)
      await syncDirectory(this.directory)
    } catch (error) {
      if (handle !== undefined) {
        try {
          await handle.close()
        } catch (closeError) {
          void closeError
        }
      }
      if (created) {
        try {
          await unlink(temporary)
        } catch (cleanupError) {
          if (errorCode(cleanupError) !== 'ENOENT') void cleanupError
        }
      }
      if (isPolicyError(error)) throw error
      throw invalidPolicy()
    }
  }
}

async function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = pending.get(key) ?? Promise.resolve()
  const result = previous.then(task)
  const completion = result.then(() => undefined, () => undefined)
  pending.set(key, completion)
  void completion.then(() => {
    if (pending.get(key) === completion) pending.delete(key)
  })
  return await result
}

async function hasValidRoot(root: string): Promise<boolean> {
  const info = await optionalLstat(root)
  if (info === undefined) return false
  if (!info.isDirectory() || info.isSymbolicLink() || !safeOwner(info)
    || (process.platform !== 'win32' && (modeBits(info) & 0o077) !== 0)) throw invalidPolicy()
  return true
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined
  try {
    handle = await open(directory, constants.O_RDONLY | NOFOLLOW)
    const info = await handle.stat()
    if (!info.isDirectory() || info.isSymbolicLink() || !safeOwner(info) || !exactMode(info, 0o700)) throw invalidPolicy()
    await handle.sync()
    await handle.close()
    handle = undefined
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch (closeError) {
        void closeError
      }
    }
    if (isPolicyError(error)) throw error
    throw invalidPolicy()
  }
}

async function optionalLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw invalidPolicy()
  }
}

function parsePolicy(text: string): boolean {
  if (Buffer.byteLength(text, 'utf8') > POLICY_MAX_BYTES) throw invalidPolicy()
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch (error) {
    void error
    throw invalidPolicy()
  }
  if (!isRecord(value) || Object.keys(value).length !== 2 || value.version !== POLICY_VERSION
    || typeof value.enabled !== 'boolean' || JSON.stringify(value) !== body) throw invalidPolicy()
  return value.enabled
}

function validateSession(sessionId: string): void {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw invalidPolicy()
}

function safeOwner(info: Awaited<ReturnType<typeof lstat>>): boolean {
  const uid = process.getuid?.()
  return uid === undefined || info.uid === uid
}

function exactMode(info: Awaited<ReturnType<typeof lstat>>, mode: number): boolean {
  return process.platform === 'win32' || (modeBits(info) & 0o7777) === mode
}

function modeBits(info: Awaited<ReturnType<typeof lstat>>): number {
  return typeof info.mode === 'number' ? info.mode : Number(info.mode)
}

function safeFile(info: Awaited<ReturnType<typeof lstat>>): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && safeOwner(info) && exactMode(info, 0o600)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = error.code
  return typeof code === 'string' ? code : undefined
}

function isPolicyError(error: unknown): boolean {
  return error instanceof Error && error.message === POLICY_ERROR
}

function invalidPolicy(): Error {
  return new Error(POLICY_ERROR)
}
