/** Bounded CSV review and import owned by a single native Vault window. */
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import Papa from 'papaparse'
import type { CloudVaultTransport } from './cloud-connection.ts'
import { cloudVaultLoginImport, normalizeVaultLoginImport, type VaultWebsiteLoginInput } from './cloud-vault.ts'

const CSV_BYTES = 5_000_000
const REVIEW_TIMEOUT = 10 * 60 * 1000

/** A login described in the native review without its password. */
type LoginPreview = Omit<VaultWebsiteLoginInput, 'password'>

/** Responses for the isolated review document. */
export type VaultLoginImportReply = {
  readonly state: 'ready'
  readonly id: string
  readonly logins: readonly LoginPreview[]
  readonly duplicates: number
  readonly invalid: number
  readonly full: number
} | {
  readonly state: 'finished'
  readonly imported: number
  readonly duplicates: number
  readonly full: number
  readonly unconfirmed: number
} | {
  readonly state: 'cancelled' | 'invalid-file' | 'unavailable'
}

interface LoginColumns {
  readonly width: number
  readonly website: number
  readonly label: number
  readonly username: number
  readonly password: number
  readonly type: number
  readonly multipleSites: boolean
}

function loginColumns(header: readonly string[]): LoginColumns | undefined {
  const names = header.map(name => name.trim().toLowerCase())
  if (new Set(names).size !== names.length) return undefined
  const bitwarden = names.includes('login_uri')
  const website = bitwarden ? names.indexOf('login_uri') : names.findIndex(name => ['url', 'website', 'origin'].includes(name))
  const username = names.indexOf(bitwarden ? 'login_username' : 'username')
  const password = names.indexOf(bitwarden ? 'login_password' : 'password')
  if (website === -1 || username === -1 || password === -1) return undefined
  const label = names.findIndex(name => ['name', 'title', 'label'].includes(name))
  return { width: names.length, website, label, username, password, type: bitwarden ? names.indexOf('type') : -1, multipleSites: bitwarden }
}

function loginSites(value: string, multipleSites: boolean): readonly string[] {
  if (!multipleSites || (!value.includes(',') && !value.startsWith('"'))) return [value]
  // Bitwarden writes a second CSV row inside the login_uri cell.
  const { data, errors } = Papa.parse<string[]>(value, { delimiter: ',' })
  return errors.length === 0 && data.length === 1 ? data[0] ?? [''] : ['']
}

function reviewLogins(csv: string, salt: Buffer, fingerprints: readonly string[], remaining: number) {
  const seen = new Set(fingerprints)
  const logins: VaultWebsiteLoginInput[] = []
  let columns: LoginColumns | undefined
  let duplicates = 0
  let invalid = 0
  let full = 0
  const review = (entry: VaultWebsiteLoginInput | undefined): void => {
    if (entry === undefined) {
      invalid++
      return
    }
    const fingerprint = createHash('sha256').update(salt).update(entry.origin).update('\0').update(entry.username).digest('hex')
    if (seen.has(fingerprint)) {
      duplicates++
      return
    }
    seen.add(fingerprint)
    if (logins.length < remaining) logins.push(entry)
    else full++
  }
  Papa.parse<string[]>(csv, {
    delimiter: ',',
    skipEmptyLines: 'greedy',
    step({ data, errors }, parser) {
      if (columns === undefined) {
        columns = errors.length === 0 ? loginColumns(data) : undefined
        if (columns === undefined) parser.abort()
        return
      }
      const { website, label, username, password, type, width } = columns
      if (errors.length !== 0 || data.length !== width || (type !== -1 && data[type] !== 'login')) {
        review(undefined)
        return
      }
      for (const site of loginSites(data[website] ?? '', columns.multipleSites)) {
        review(normalizeVaultLoginImport(site, data[label] ?? '', data[username] ?? '', data[password] ?? ''))
      }
    },
  })
  return columns === undefined ? undefined : { logins, duplicates, invalid, full }
}

/**
 * Read one local file from the operating system picker into a bounded buffer.
 * @param path - Native file selection, never supplied by web content.
 * @returns File bytes, or undefined for a missing, non-regular, or oversized file.
 */
export async function readVaultLoginCsv(path: string): Promise<Buffer | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size === 0 || info.size >= CSV_BYTES) return undefined
      const bytes = Buffer.alloc(info.size + 1)
      let length = 0
      let successful = false
      try {
        while (length < bytes.length) {
          const { bytesRead } = await file.read(bytes, length, bytes.length - length, length)
          if (bytesRead === 0) break
          length += bytesRead
        }
        if (length !== info.size) return undefined
        successful = true
        return bytes.subarray(0, length)
      } finally {
        if (!successful) bytes.fill(0)
      }
    } finally {
      await file.close()
    }
  } catch {
    return undefined
  }
}

/** Holds only the eligible rows for one short-lived import review. */
export class CloudVaultLoginImport {
  private review: { readonly id: string; readonly logins: readonly VaultWebsiteLoginInput[]; readonly expiry: NodeJS.Timeout } | undefined

  /** @param send - Vault transport bound to the current authenticated Cloud workspace. */
  constructor(private readonly send: CloudVaultTransport) {}

  /**
   * Prepare native review with metadata from the owner-authenticated Vault.
   * @param bytes - Read-once local CSV buffer. Cleared after decoding.
   * @param signal - Cancellation for the current Vault window.
   * @returns Preview containing no passwords, or a fixed error.
   */
  async prepare(bytes: Buffer, signal: AbortSignal): Promise<VaultLoginImportReply> {
    this.clear()
    let csv: string
    try {
      if (bytes.length === 0 || bytes.length >= CSV_BYTES) return { state: 'invalid-file' }
      csv = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return { state: 'invalid-file' }
    } finally {
      bytes.fill(0)
    }
    const salt = randomBytes(32)
    const response = await cloudVaultLoginImport(this.send, { action: 'inspect-login-import', salt: salt.toString('hex') }, signal)
    if (!('importIndex' in response) || signal.aborted) return { state: 'unavailable' }
    const { fingerprints, remaining } = response.importIndex
    const draft = reviewLogins(csv, salt, fingerprints, remaining)
    if (draft === undefined) return { state: 'invalid-file' }
    const { logins, duplicates, invalid, full } = draft
    const id = randomBytes(16).toString('hex')
    if (logins.length > 0) {
      const expiry = setTimeout(() => { this.clear() }, REVIEW_TIMEOUT)
      expiry.unref()
      this.review = { id, logins, expiry }
    }
    return {
      state: 'ready', id, duplicates, invalid, full,
      logins: logins.map(({ origin, label, username }) => ({ origin, label, username })),
    }
  }

  /**
   * Consume the reviewed login list once. Each server write rechecks duplicate identity.
   * @param id - Review token returned to the current Vault window.
   * @param signal - Cancellation for the current Vault window.
   * @returns Counts confirmed by the remote broker and the number left unconfirmed.
   */
  async confirm(id: string, signal: AbortSignal): Promise<VaultLoginImportReply> {
    if (this.review?.id !== id || signal.aborted) return { state: 'unavailable' }
    const { logins } = this.review
    this.clear()
    let imported = 0
    let duplicates = 0
    let full = 0
    for (const login of logins) {
      const result = await cloudVaultLoginImport(this.send, { action: 'import-login', ...login }, signal)
      if (!('outcome' in result)) break
      switch (result.outcome) {
        case 'imported': imported++; break
        case 'duplicate': duplicates++; break
        case 'full': full++; break
      }
    }
    return { state: 'finished', imported, duplicates, full, unconfirmed: logins.length - imported - duplicates - full }
  }

  /** Discard the pending plaintext rows when the review is canceled or closed. */
  clear(): void {
    if (this.review !== undefined) clearTimeout(this.review.expiry)
    this.review = undefined
  }
}
