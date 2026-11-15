/** Write-only VPS Vault management over the owner's existing SSH login. */
import { execFile, type ChildProcess, type ExecFileOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { isCloudTarget } from './cloud-connection.ts'

const SSH = '/usr/bin/ssh'
const COMMAND = '/usr/local/sbin/yharness-vault desktop-client'
const UNIT = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,220}\.service$/u
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u
const BOT = /^bot-[A-Za-z0-9][A-Za-z0-9-]{0,245}$/u
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
const MAX_ROSTER_BYTES = 4 * 1024 * 1024
const MAX_ACCESS_MODE_BYTES = 128
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u

declare const VAULT_REQUEST_ID: unique symbol
declare const VAULT_LOGIN_USE_REQUEST_ID: unique symbol
declare const VAULT_LOGIN_ID: unique symbol
declare const VAULT_LOGIN_GENERATION: unique symbol
declare const VAULT_BOT_ID: unique symbol

/** Opaque request identifier issued by the connected Cloud workspace. */
export type VaultRequestId = string & { readonly [VAULT_REQUEST_ID]: true }

/** Opaque owner-approval request identifier issued by the connected Cloud workspace. */
export type VaultLoginUseRequestId = string & { readonly [VAULT_LOGIN_USE_REQUEST_ID]: true }

/** Opaque website-login identifier issued by the VPS Vault. */
export type VaultLoginId = string & { readonly [VAULT_LOGIN_ID]: true }

/** Revision identifier bound to one saved website-login record. */
export type VaultLoginGeneration = string & { readonly [VAULT_LOGIN_GENERATION]: true }

/** Exact Bot identity from the connected Cloud roster. */
export type VaultBotId = string & { readonly [VAULT_BOT_ID]: true }

/** Request from the dedicated Vault window. No operation reads a saved value. */
export type VaultRequest = { readonly action: 'list' | 'list-grants' } | ({
  readonly action: 'add-grant' | 'remove-grant'
} & VaultBotGrant) | {
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
  readonly form?: 'entry'
} | {
  readonly action: 'approve-login-use'
  readonly id: VaultLoginUseRequestId
  readonly loginId: VaultLoginId
  readonly generation: VaultLoginGeneration
} | {
  readonly action: 'enter-login-use'
  readonly id: VaultLoginUseRequestId
  readonly origin: string
  readonly destination: string
  readonly username: string
  readonly password: string
  readonly saveLabel?: string
} | {
  readonly action: 'decline-login-use'
  readonly id: VaultLoginUseRequestId
}

/** Names for a single administrator-enabled Linux service. */
export interface VaultService {
  readonly unit: string
  readonly names: readonly string[]
}

/** One Bot and service key whose use the owner can approve from chat. */
export interface VaultBotGrant {
  readonly bot: VaultBotId
  readonly unit: string
  readonly name: string
}

/** Service choices and current Bot permissions returned by the VPS Vault. */
export interface VaultBotAccess {
  readonly services: readonly string[]
  readonly grants: readonly VaultBotGrant[]
}

/** Bot identity and name presented to the owner in the grant form. */
export interface VaultBotChoice {
  readonly id: VaultBotId
  readonly name: string
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
  readonly acceptsCredentials?: true
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
  readonly ok: true
  readonly access: VaultBotAccess
  readonly bots?: readonly VaultBotChoice[]
} | {
  readonly request: VaultRequestMetadata | VaultLoginUseRequestMetadata
} | {
  readonly state: 'saved' | 'cancelled' | 'needs-owner' | 'unavailable'
} | {
  readonly state: 'submitted'
  readonly saved?: boolean
} | {
  readonly ok: false
  readonly reason: 'invalid' | 'unavailable' | 'external' | 'disabled'
}

/** Authenticated connection to the Cloud view that opened the Vault. */
export interface VaultCloudWorkspace {
  readonly origin: string
  readonly fetch: (url: string, options: RequestInit) => Promise<Response>
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

function botId(value: unknown): value is VaultBotId {
  return typeof value === 'string' && value === value.trim() && BOT.test(value)
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
  if ((action === 'list' || action === 'list-grants') && fields === 1) return { action }
  if ((action === 'add-grant' || action === 'remove-grant') && fields === 4
    && botId(value.bot) && unitName(unit) && keyName(name)) return { action, bot: value.bot, unit, name }
  if (action === 'inspect-request' && fields === 2 && isVaultRequestId(value.id)) return { action, id: value.id }
  if (action === 'dismiss-request' && fields === 2 && isVaultRequestId(value.id)) return { action, id: value.id }
  if (action === 'inspect-login-use' && isVaultLoginUseRequestId(value.id)) {
    if (fields === 2) return { action, id: value.id }
    if (fields === 3 && value.form === 'entry') return { action, id: value.id, form: value.form }
    return undefined
  }
  if (action === 'decline-login-use' && fields === 2 && isVaultLoginUseRequestId(value.id)) {
    return { action, id: value.id }
  }
  if (action === 'approve-login-use' && fields === 4 && isVaultLoginUseRequestId(value.id)
    && isVaultLoginId(value.loginId) && isVaultLoginGeneration(value.generation)) {
    return { action, id: value.id, loginId: value.loginId, generation: value.generation }
  }
  if (action === 'enter-login-use' && isVaultLoginUseRequestId(value.id)) {
    const origin = loginOrigin(value.origin, true)
    const destination = origin === undefined ? undefined : loginDestination(value.destination, origin)
    const username = boundedLoginText(value.username, LOGIN_USERNAME_LIMIT, false)
    const password = boundedLoginText(value.password, LOGIN_PASSWORD_LIMIT, false)
    if (origin === undefined || destination === undefined || username === undefined || password === undefined) return undefined
    const entry = { action, id: value.id, origin, destination, username, password } as const
    if (fields === 6) return entry
    const saveLabel = boundedLoginText(value.saveLabel, LOGIN_LABEL_LIMIT, true)
    return fields === 7 && saveLabel !== undefined ? { ...entry, saveLabel } : undefined
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
  if (!record(value) || !isVaultLoginUseRequestId(value.id) || value.id !== expectedId) return undefined
  const fields = Object.keys(value).length
  const acceptsCredentials = value.acceptsCredentials === true
  if (fields !== (acceptsCredentials ? 5 : 4)) return undefined
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
  return { id: value.id, origin, destination, logins, ...(acceptsCredentials ? { acceptsCredentials: true } : {}) }
}

function botAccess(value: unknown): VaultBotAccess | undefined {
  if (!record(value) || Object.keys(value).length !== 2 || !Array.isArray(value.services) || value.services.length > 16
    || !value.services.every(unitName) || new Set(value.services).size !== value.services.length
    || !Array.isArray(value.grants) || value.grants.length > 64) return undefined
  const grants: VaultBotGrant[] = []
  const identities = new Set<string>()
  for (const item of value.grants) {
    if (!record(item) || Object.keys(item).length !== 3 || !botId(item.bot) || !unitName(item.unit) || !keyName(item.name)) return undefined
    const key = JSON.stringify([item.bot, item.unit, item.name])
    if (identities.has(key)) return undefined
    identities.add(key)
    grants.push({ bot: item.bot, unit: item.unit, name: item.name })
  }
  return { services: value.services, grants }
}

function replyBody(
  action: VaultRequest['action'], stdout: string,
  expectedId?: VaultRequestId | VaultLoginUseRequestId,
): VaultReply | undefined {
  const value: unknown = JSON.parse(stdout)
  if (!record(value)) return undefined
  const fields = Object.keys(value).length
  if (action === 'enter-login-use' && fields === 2 && value.state === 'submitted' && typeof value.saved === 'boolean') {
    return { state: value.state, saved: value.saved }
  }
  if (fields !== 1) return undefined
  if (action === 'list-grants') {
    const access = botAccess(value.access)
    return access === undefined ? undefined : { ok: true, access }
  }
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
  if (action === 'approve-login-use' || action === 'enter-login-use') {
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
export function vaultRequestAllowed(value: unknown, scope: VaultRequestMode | VaultRequestId | undefined): value is VaultRequest {
  const request = requestBody(value)
  if (request === undefined) return false
  if (request.action === 'inspect-request' || request.action === 'save-request' || request.action === 'dismiss-request') {
    return typeof scope === 'string' ? request.id === scope : scope?.kind === 'request' && request.id === scope.id
  }
  if (request.action === 'inspect-login-use' || request.action === 'approve-login-use'
    || request.action === 'enter-login-use' || request.action === 'decline-login-use') {
    return typeof scope !== 'string' && scope?.kind === 'login-use' && request.id === scope.id
  }
  return scope === undefined || (typeof scope !== 'string' && scope.kind === 'manage')
}

async function readCloudReply(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.ok || response.body === null) return undefined
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let remaining = maxBytes
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) return JSON.parse(Buffer.concat(chunks).toString('utf8'))
      remaining -= next.value.byteLength
      if (remaining < 0) {
        await reader.cancel()
        return undefined
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
}

async function readCloudVaultMode(
  workspace: VaultCloudWorkspace, signal: AbortSignal,
): Promise<'managed' | 'external' | 'disabled' | undefined> {
  const { origin } = workspace
  if (signal.aborted || !LOOPBACK_ORIGIN.test(origin)) return undefined
  try {
    const response = await workspace.fetch(`${origin}/api/bot-vault-access`, {
      method: 'GET', redirect: 'error', credentials: 'include', cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    })
    const reply = await readCloudReply(response, MAX_ACCESS_MODE_BYTES)
    if (signal.aborted || !record(reply) || Object.keys(reply).length !== 1) return undefined
    const { mode } = reply
    return mode === 'managed' || mode === 'external' || mode === 'disabled' ? mode : undefined
  } catch (_error) {
    return undefined
  }
}

/**
 * Fetch only the owner-visible Bot choices for Vault from the private workspace.
 * @param origin - Origin of the connected loopback SSH forward.
 * @param fetcher - Fetch function scoped to the authenticated Cloud session partition.
 * @param signal - Cancel when the owner closes Vault or disconnects Cloud.
 * @returns Names and opaque IDs, or undefined when the app cannot confirm the roster.
 */
export async function readCloudVaultBots(
  origin: string, fetcher: (url: string, options: RequestInit) => Promise<Response>, signal: AbortSignal,
): Promise<readonly VaultBotChoice[] | undefined> {
  if (signal.aborted || !LOOPBACK_ORIGIN.test(origin)) return undefined
  const rpcId = randomUUID()
  try {
    const response = await fetcher(`${origin}/api/bots/list`, {
      method: 'POST', redirect: 'error', credentials: 'include', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'bots/list', payload: { args: { request: { includeHidden: true } } } }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    })
    const reply = await readCloudReply(response, MAX_ROSTER_BYTES)
    if (signal.aborted || !record(reply) || reply.type !== 'server-response' || reply.rpcId !== rpcId
      || !record(reply.result) || reply.result.ok !== true || !record(reply.result.value)
      || !Array.isArray(reply.result.value.bots)) return undefined
    const bots: VaultBotChoice[] = []
    const ids = new Set<VaultBotId>()
    for (const row of reply.result.value.bots) {
      if (!record(row) || row.state !== 'active') continue
      if (!botId(row.id) || ids.has(row.id) || typeof row.name !== 'string' || row.name.trim() !== row.name
        || row.name.length === 0 || row.name.length > 255 || CONTROL.test(row.name)) return undefined
      ids.add(row.id)
      bots.push({ id: row.id, name: row.name })
    }
    return bots
  } catch (_error) {
    // Cloud network errors and response bodies stay outside the Vault window.
    return undefined
  }
}

/**
 * Send one bounded request over SSH and return only validated metadata or a fixed failure.
 * @param target - Main-owned, previously connected Cloud SSH destination.
 * @param value - Untrusted IPC input from the Vault window.
 * @param signal - Cancel the SSH child when its window closes.
 * @param execute - Subprocess injection for tests.
 * @param workspace - Authenticated Cloud connection required for Bot grant operations.
 * @returns A safe response for the Vault window.
 */
export async function cloudVaultRequest(
  target: string, value: unknown, signal: AbortSignal, execute: VaultExec = execFile, workspace?: VaultCloudWorkspace,
): Promise<VaultReply> {
  const request = requestBody(value)
  if (!isCloudTarget(target) || request === undefined) return { ok: false, reason: 'invalid' }
  let bots: readonly VaultBotChoice[] | undefined
  if (request.action === 'list-grants' || request.action === 'add-grant' || request.action === 'remove-grant') {
    if (workspace === undefined) return unavailable
    const mode = await readCloudVaultMode(workspace, signal)
    if (mode !== 'managed') return { ok: false, reason: mode ?? 'unavailable' }
    if (request.action !== 'remove-grant') bots = await readCloudVaultBots(workspace.origin, workspace.fetch, signal)
    if (request.action === 'add-grant' && !bots?.some(bot => bot.id === request.bot)) return unavailable
  }
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
          const reply = replyBody(request.action, stdout, expectedId) ?? unavailable
          resolve(request.action === 'list-grants' && 'access' in reply && bots !== undefined ? { ...reply, bots } : reply)
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
