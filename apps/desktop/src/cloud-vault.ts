/** Write-only VPS Vault management over the owner's existing SSH login. */
import { execFile, type ChildProcess, type ExecFileOptions } from 'node:child_process'
import { isIP } from 'node:net'
import { isCloudTarget } from './cloud-connection.ts'

const SSH = '/usr/bin/ssh'
const COMMAND = '/usr/local/sbin/yharness-vault desktop-client'
const UNIT = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,220}\.service$/u
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u
const REQUEST_ID = /^[a-f0-9]{32}$/u
const LOGIN_ID = /^[a-f0-9]{32}$/u
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u
const REQUEST_STATES = new Set(['pending', 'saved', 'cancelled'])
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u
const VALUE_LIMIT = 8192
const LOGIN_LABEL_LIMIT = 80
const LOGIN_USERNAME_LIMIT = 512
const LOGIN_PASSWORD_LIMIT = 8192
const MAX_LOGINS = 64
const MAX_OUTPUT = 160 * 1024

declare const VAULT_REQUEST_ID: unique symbol
declare const VAULT_LOGIN_USE_REQUEST_ID: unique symbol
declare const VAULT_LOGIN_ID: unique symbol
declare const VAULT_LOGIN_GENERATION: unique symbol

/** Opaque request identifier issued by the connected Cloud workspace. */
export type VaultRequestId = string & { readonly [VAULT_REQUEST_ID]: true }

/** Opaque owner-approval request identifier issued by the connected Cloud workspace. */
export type VaultLoginUseRequestId = string & { readonly [VAULT_LOGIN_USE_REQUEST_ID]: true }

/** Opaque website-login identifier issued by the VPS Vault. */
export type VaultLoginId = string & { readonly [VAULT_LOGIN_ID]: true }

/** Revision identifier bound to one saved website-login record. */
export type VaultLoginGeneration = string & { readonly [VAULT_LOGIN_GENERATION]: true }

/** Request from the dedicated Vault window. No operation reads a saved value. */
export type VaultRequest = { readonly action: 'list' } | {
  readonly action: 'revoke'
  readonly unit: string
  readonly name: string
} | {
  readonly action: 'add' | 'replace'
  readonly unit: string
  readonly name: string
  readonly value: string
} | {
  readonly action: 'list-logins'
} | {
  readonly action: 'add-login'
  readonly origin: string
  readonly label: string
  readonly username: string
  readonly password: string
} | {
  readonly action: 'replace-login'
  readonly id: VaultLoginId
  readonly label: string
  readonly username: string
  readonly password: string
} | {
  readonly action: 'remove-login'
  readonly id: VaultLoginId
} | {
  readonly action: 'inspect-request'
  readonly id: VaultRequestId
} | {
  readonly action: 'save-request'
  readonly id: VaultRequestId
  readonly value: string
} | {
  readonly action: 'dismiss-request'
  readonly id: VaultRequestId
} | {
  readonly action: 'inspect-login-use'
  readonly id: VaultLoginUseRequestId
} | {
  readonly action: 'approve-login-use'
  readonly id: VaultLoginUseRequestId
  readonly loginId: VaultLoginId
  readonly generation: VaultLoginGeneration
} | {
  readonly action: 'decline-login-use'
  readonly id: VaultLoginUseRequestId
}

/** Names for a single administrator-enabled Linux service. */
export interface VaultService {
  readonly unit: string
  readonly names: readonly string[]
}

/** Metadata for one Cloud-to-Vault key request; no secret value is returned. */
export interface VaultRequestMetadata {
  readonly id: VaultRequestId
  readonly unit: string
  readonly name: string
  readonly state: 'pending' | 'saved' | 'cancelled'
}

/** Non-secret metadata for one saved website login. */
export interface VaultLogin {
  readonly id: VaultLoginId
  readonly origin: string
  readonly label: string
}

/** Metadata for one paused browser sign-in request; no credential value is returned. */
export interface VaultLoginUseRequestMetadata {
  readonly id: VaultLoginUseRequestId
  readonly origin: string
  readonly destination: string
  readonly logins: readonly VaultLoginUseChoice[]
}

/** Non-secret saved-login choice bound to its current record revision. */
export interface VaultLoginUseChoice {
  readonly id: VaultLoginId
  readonly label: string
  readonly generation: VaultLoginGeneration
}

/** Presentation selected by the owner-approved Vault window. */
export type VaultRequestMode = { readonly kind: 'manage' } | {
  readonly kind: 'request'
  readonly id: VaultRequestId
} | {
  readonly kind: 'login-use'
  readonly id: VaultLoginUseRequestId
}

/** Metadata, acknowledgment, or a fixed diagnostic. */
export type VaultReply = {
  readonly ok: true
  readonly services?: readonly VaultService[]
  readonly logins?: readonly VaultLogin[]
} | {
  readonly request: VaultRequestMetadata | VaultLoginUseRequestMetadata
} | {
  readonly state: 'saved' | 'cancelled' | 'submitted' | 'needs-owner' | 'unavailable'
} | {
  readonly ok: false
  readonly reason: 'invalid' | 'unavailable'
}

/** SSH execution seam used by tests with a real local subprocess. */
export type VaultExec = (
  file: string, args: readonly string[], options: ExecFileOptions & { encoding: 'utf8' },
  complete: (error: Error | null, stdout: string) => void,
) => ChildProcess

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unitName(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && UNIT.test(value) && !value.endsWith('@.service')
}

function keyName(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && NAME.test(value)
}

function requestState(value: unknown): value is VaultRequestMetadata['state'] {
  return typeof value === 'string' && REQUEST_STATES.has(value)
}

/**
 * Validate an opaque request identifier before it crosses into SSH transport.
 * @param value - untrusted IPC or navigation input.
 * @returns whether the value is a lowercase 32-character hexadecimal request id.
 */
export function isVaultRequestId(value: unknown): value is VaultRequestId {
  return typeof value === 'string' && REQUEST_ID.test(value)
}

/**
 * Validate an opaque website-login approval request identifier before SSH transport.
 * @param value - untrusted IPC or navigation input.
 * @returns whether the value is a lowercase 32-character hexadecimal request id.
 */
export function isVaultLoginUseRequestId(value: unknown): value is VaultLoginUseRequestId {
  return typeof value === 'string' && REQUEST_ID.test(value)
}

/**
 * Validate an opaque website-login identifier before it crosses into SSH transport.
 * @param value - untrusted IPC or remote reply input.
 * @returns whether the value is a lowercase 32-character hexadecimal login id.
 */
export function isVaultLoginId(value: unknown): value is VaultLoginId {
  return typeof value === 'string' && LOGIN_ID.test(value)
}

/**
 * Validate a saved-login revision before approving a browser request.
 * @param value - untrusted IPC or remote reply input.
 * @returns whether the value is a lowercase 64-character hexadecimal generation.
 */
export function isVaultLoginGeneration(value: unknown): value is VaultLoginGeneration {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function boundedLoginText(value: unknown, limit: number, trim: boolean): string | undefined {
  if (typeof value !== 'string' || !value.isWellFormed() || CONTROL.test(value)) return undefined
  const normalized = trim ? value.trim() : value
  if (normalized.length === 0 || Buffer.byteLength(normalized, 'utf8') > limit) return undefined
  return normalized
}

function loginOrigin(value: unknown, requireCanonical = false): string | undefined {
  if (typeof value !== 'string' || !value.isWellFormed() || value !== value.trim() || CONTROL.test(value)) return undefined
  const separator = value.indexOf('://')
  if (separator < 0) return undefined
  const authorityAndPath = value.slice(separator + 3)
  const suffixIndex = authorityAndPath.search(/[/?#]/u)
  const suffix = suffixIndex < 0 ? '' : authorityAndPath.slice(suffixIndex)
  if (suffix !== '' && suffix !== '/') return undefined
  let url: URL
  try { url = new URL(value) }
  catch { return undefined }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined
  if (isIP(url.hostname) !== 0) return undefined
  const hostname = url.hostname
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'local'
    || hostname.endsWith('.local') || hostname === 'localdomain' || hostname.endsWith('.localdomain')) return undefined
  const labels = hostname.split('.')
  if (labels.length < 2 || hostname.length > 253 || !labels.every(label => DNS_LABEL.test(label))
    || /^\d+$/u.test(labels.at(-1) ?? '')) return undefined
  const authority = suffixIndex < 0 ? authorityAndPath : authorityAndPath.slice(0, suffixIndex)
  const port = /:(\d+)$/u.exec(authority)?.[1]
  if (port !== undefined && Number(port) === 443 && requireCanonical) return undefined
  if (authority.endsWith(':')) return undefined
  const origin = url.origin
  return requireCanonical && value !== origin ? undefined : origin
}

function requestBody(value: unknown): VaultRequest | undefined {
  if (!record(value)) return undefined
  const { action, unit, name } = value
  const fields = Object.keys(value).length
  if (action === 'list' && fields === 1) return { action }
  if (action === 'inspect-request' && fields === 2 && isVaultRequestId(value.id)) return { action, id: value.id }
  if (action === 'dismiss-request' && fields === 2 && isVaultRequestId(value.id)) return { action, id: value.id }
  if (action === 'inspect-login-use' && fields === 2 && isVaultLoginUseRequestId(value.id)) {
    return { action, id: value.id }
  }
  if (action === 'decline-login-use' && fields === 2 && isVaultLoginUseRequestId(value.id)) {
    return { action, id: value.id }
  }
  if (action === 'approve-login-use' && fields === 4 && isVaultLoginUseRequestId(value.id)
    && isVaultLoginId(value.loginId) && isVaultLoginGeneration(value.generation)) {
    return { action, id: value.id, loginId: value.loginId, generation: value.generation }
  }
  if (action === 'save-request' && fields === 3 && isVaultRequestId(value.id)
    && typeof value.value === 'string' && value.value.length > 0 && !value.value.includes('\0')
    && value.value.isWellFormed() && Buffer.byteLength(value.value, 'utf8') <= VALUE_LIMIT) {
    return { action, id: value.id, value: value.value }
  }
  if (action === 'list-logins' && fields === 1) return { action }
  if (action === 'remove-login' && fields === 2 && isVaultLoginId(value.id)) {
    return { action, id: value.id }
  }
  if (action === 'replace-login' && fields === 5 && isVaultLoginId(value.id)) {
    const label = boundedLoginText(value.label, LOGIN_LABEL_LIMIT, true)
    const username = boundedLoginText(value.username, LOGIN_USERNAME_LIMIT, false)
    const password = boundedLoginText(value.password, LOGIN_PASSWORD_LIMIT, false)
    if (label !== undefined && username !== undefined && password !== undefined) {
      return { action, id: value.id, label, username, password }
    }
    return undefined
  }
  if (action === 'add-login' && fields === 5) {
    const origin = loginOrigin(value.origin)
    const label = boundedLoginText(value.label, LOGIN_LABEL_LIMIT, true)
    const username = boundedLoginText(value.username, LOGIN_USERNAME_LIMIT, false)
    const password = boundedLoginText(value.password, LOGIN_PASSWORD_LIMIT, false)
    if (origin !== undefined && label !== undefined && username !== undefined && password !== undefined) {
      return { action, origin, label, username, password }
    }
    return undefined
  }
  if (!unitName(unit) || !keyName(name)) return undefined
  if (action === 'revoke' && fields === 3) return { action, unit, name }
  const secret = value.value
  if ((action === 'add' || action === 'replace') && fields === 4 && typeof secret === 'string'
    && secret.length > 0 && !secret.includes('\0') && secret.isWellFormed()
    && Buffer.byteLength(secret, 'utf8') <= VALUE_LIMIT) {
    return { action, unit, name, value: secret }
  }
}

function loginMetadata(value: unknown): VaultLogin | undefined {
  if (!record(value) || Object.keys(value).length !== 3 || !isVaultLoginId(value.id)) return undefined
  const origin = loginOrigin(value.origin, true)
  const label = boundedLoginText(value.label, LOGIN_LABEL_LIMIT, true)
  if (origin === undefined || label === undefined) return undefined
  return { id: value.id, origin, label }
}

function loginUseChoice(value: unknown): VaultLoginUseChoice | undefined {
  if (!record(value) || Object.keys(value).length !== 3 || !isVaultLoginId(value.id)
    || !isVaultLoginGeneration(value.generation)) return undefined
  const label = boundedLoginText(value.label, LOGIN_LABEL_LIMIT, true)
  return label === undefined ? undefined : { id: value.id, label, generation: value.generation }
}

function loginDestination(value: unknown, origin: string): string | undefined {
  if (typeof value !== 'string' || !value.isWellFormed() || value !== value.trim()
    || CONTROL.test(value) || Buffer.byteLength(value, 'utf8') > 4096
    || !/^[\x21-\x7e]+$/u.test(value) || /[?#\\]/u.test(value) || !value.startsWith(`${origin}/`)) return undefined
  let url: URL
  try { url = new URL(value) }
  catch { return undefined }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || url.origin !== origin || url.search !== '' || url.hash !== '' || value !== url.href) return undefined
  return value
}

function loginUseMetadata(value: unknown, expectedId?: VaultLoginUseRequestId): VaultLoginUseRequestMetadata | undefined {
  if (!record(value) || Object.keys(value).length !== 4 || !isVaultLoginUseRequestId(value.id)
    || value.id !== expectedId) return undefined
  const origin = loginOrigin(value.origin, true)
  const destination = origin === undefined ? undefined : loginDestination(value.destination, origin)
  if (origin === undefined || destination === undefined || !Array.isArray(value.logins)
    || value.logins.length > MAX_LOGINS) return undefined
  const ids = new Set<string>()
  const logins: VaultLoginUseChoice[] = []
  for (const login of value.logins) {
    const metadata = loginUseChoice(login)
    if (metadata === undefined || ids.has(metadata.id)) return undefined
    ids.add(metadata.id)
    logins.push(metadata)
  }
  return { id: value.id, origin, destination, logins }
}

function replyBody(
  action: VaultRequest['action'], stdout: string,
  expectedId?: VaultRequestId | VaultLoginUseRequestId,
): VaultReply | undefined {
  const value: unknown = JSON.parse(stdout)
  if (!record(value) || Object.keys(value).length !== 1) return undefined
  if (action === 'inspect-request') {
    const request = value.request
    if (!record(request) || Object.keys(request).length !== 4 || !isVaultRequestId(request.id)
      || request.id !== expectedId || !unitName(request.unit) || !keyName(request.name)
      || !requestState(request.state)) return undefined
    return { request: {
      id: request.id, unit: request.unit, name: request.name,
      state: request.state,
    } }
  }
  if (action === 'inspect-login-use') {
    const request = loginUseMetadata(value.request, expectedId as VaultLoginUseRequestId | undefined)
    return request === undefined ? undefined : { request }
  }
  if (action === 'approve-login-use') {
    return value.state === 'submitted' || value.state === 'needs-owner' || value.state === 'unavailable'
      ? { state: value.state } : undefined
  }
  if (action === 'decline-login-use') {
    return value.state === 'unavailable' ? { state: value.state } : undefined
  }
  if (action === 'dismiss-request') {
    return value.state === 'saved' || value.state === 'cancelled' ? { state: value.state } : undefined
  }
  if (action === 'list-logins') {
    if (!Array.isArray(value.logins) || value.logins.length > MAX_LOGINS) return undefined
    const logins: VaultLogin[] = []
    const ids = new Set<string>()
    for (const login of value.logins) {
      const metadata = loginMetadata(login)
      if (metadata === undefined || ids.has(metadata.id)) return undefined
      ids.add(metadata.id)
      logins.push(metadata)
    }
    return { ok: true, logins }
  }
  if (action !== 'list') return value.ok === true ? { ok: true } : undefined
  if (!Array.isArray(value.services) || value.services.length > 16) return undefined
  const services: VaultService[] = []
  const units = new Set<string>()
  for (const service of value.services) {
    if (!record(service) || Object.keys(service).length !== 2 || !unitName(service.unit)
      || units.has(service.unit) || !Array.isArray(service.names) || service.names.length > 100
      || !service.names.every(keyName) || new Set(service.names).size !== service.names.length) return undefined
    units.add(service.unit)
    services.push({ unit: service.unit, names: service.names })
  }
  return { ok: true, services }
}

const unavailable: VaultReply = { ok: false, reason: 'unavailable' }

/**
 * Limit the isolated form to the request displayed in that window.
 * @param value - Untrusted operation from the Vault renderer.
 * @param scope - Owner-selected presentation, legacy request id, or undefined for Vault management.
 * @returns Whether the operation belongs to the window's current mode.
 */
export function vaultRequestAllowed(value: unknown, scope: VaultRequestMode | VaultRequestId | undefined): boolean {
  const request = requestBody(value)
  if (request === undefined) return false
  if (request.action === 'inspect-request' || request.action === 'save-request' || request.action === 'dismiss-request') {
    return typeof scope === 'string' ? request.id === scope : scope?.kind === 'request' && request.id === scope.id
  }
  if (request.action === 'inspect-login-use' || request.action === 'approve-login-use' || request.action === 'decline-login-use') {
    return typeof scope !== 'string' && scope?.kind === 'login-use' && request.id === scope.id
  }
  return scope === undefined || (typeof scope !== 'string' && scope.kind === 'manage')
}

/**
 * Send one bounded request over SSH and return only validated metadata or a fixed failure.
 * @param target - Main-owned, previously connected Cloud SSH destination.
 * @param value - Untrusted IPC input from the Vault window.
 * @param signal - Cancel the SSH child when its window closes.
 * @param execute - Subprocess injection for tests.
 * @returns A safe response for the Vault window.
 */
export async function cloudVaultRequest(
  target: string, value: unknown, signal: AbortSignal, execute: VaultExec = execFile,
): Promise<VaultReply> {
  const request = requestBody(value)
  if (!isCloudTarget(target) || request === undefined) return { ok: false, reason: 'invalid' }
  if (signal.aborted) return unavailable
  return new Promise((resolve) => {
    try {
      const child = execute(SSH, [
        '-a', '-x', '-T',
        '-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes',
        '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
        '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no',
        '-o', 'PermitLocalCommand=no', '-o', 'RequestTTY=no',
        '-o', 'StrictHostKeyChecking=yes', '--', target, COMMAND,
      ], {
        signal, encoding: 'utf8', timeout: 25_000, maxBuffer: MAX_OUTPUT,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(key))),
      }, (error, stdout) => {
        if (error !== null || signal.aborted) { resolve(unavailable); return }
        try {
          const expectedId = request.action === 'inspect-request' || request.action === 'inspect-login-use'
            ? request.id : undefined
          resolve(replyBody(request.action, stdout, expectedId) ?? unavailable)
        }
        catch { resolve(unavailable) }
      })
      // OpenSSH can exit before reading stdin, for example if the owner lost access.
      child.stdin?.on('error', () => { resolve(unavailable) })
      child.stdin?.end(JSON.stringify(request), 'utf8')
    } catch {
      resolve(unavailable)
    }
  })
}
