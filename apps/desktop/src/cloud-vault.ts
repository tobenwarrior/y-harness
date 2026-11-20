/** Write-only VPS Vault management over the owner's existing SSH login. */
import { readBoundedJson } from './web-document.ts'
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import type { CloudVaultTransport } from './cloud-connection.ts'
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
const LOGIN_CODE_LIMIT = 64
const MAX_LOGINS = 64
const MAX_ROSTER_BYTES = 4 * 1024 * 1024
const MAX_ACCESS_MODE_BYTES = 128
const MAX_BROWSER_ACCESS_BYTES = 64 * 1024
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u
const BOT_SESSION = /^bot-session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

declare const VAULT_REQUEST_ID: unique symbol
declare const VAULT_LOGIN_USE_REQUEST_ID: unique symbol
declare const VAULT_LOGIN_ID: unique symbol
declare const VAULT_LOGIN_GENERATION: unique symbol
declare const VAULT_BOT_ID: unique symbol
declare const VAULT_BOT_SESSION_ID: unique symbol

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

type VaultBotSessionId = string & { readonly [VAULT_BOT_SESSION_ID]: true }

/** Exact audiences for a service key grant. */
export type VaultGrantScope = 'owner' | 'shared'

/** Request from the dedicated Vault window. No operation reads a saved value. */
export type VaultRequest = { readonly action: 'list' | 'list-grants' } | ({
  readonly action: 'add-grant'
  readonly scope?: 'shared'
} & VaultBotGrant) | ({
  readonly action: 'remove-grant'
} & VaultBotGrant) | ({
  readonly action: 'set-grant-scope'
  readonly scope: VaultGrantScope
} & VaultBotGrant) | {
  readonly action: 'list-browser-access'
} | {
  readonly action: 'set-browser-access'
  readonly bot: VaultBotId
  readonly enabled: boolean
} | {
  readonly action: 'revoke'
  readonly unit: string
  readonly name: string
} | {
  readonly action: 'add' | 'replace'
  readonly unit: string
  readonly name: string
  readonly value: string
} | {
  readonly action: 'list-logins' | 'list-bot-logins'
} | {
  readonly action: 'list-login-automation'
} | {
  readonly action: 'set-login-automatic'
  readonly id: VaultLoginId
  readonly bot: VaultBotId
  readonly enabled: boolean
} | {
  readonly action: 'add-login'
  readonly bot?: VaultBotId
  readonly origin: string
  readonly label: string
  readonly username: string
  readonly password: string
} | {
  readonly action: 'replace-login'
  readonly id: VaultLoginId
  readonly bot?: VaultBotId
  readonly label: string
  readonly username: string
  readonly password: string
} | {
  readonly action: 'remove-login'
  readonly id: VaultLoginId
  readonly bot?: VaultBotId
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
  readonly action: 'create-login-use'
  readonly id: VaultLoginUseRequestId
  readonly origin: string
  readonly destination: string
  readonly username: string
  readonly saveLabel: string
} | {
  readonly action: 'enter-verification-code'
  readonly id: VaultLoginUseRequestId
  readonly origin: string
  readonly destination: string
  readonly code: string
} | {
  readonly action: 'decline-login-use'
  readonly id: VaultLoginUseRequestId
}

/** Personal website login normalized for the existing Vault store. */
export interface VaultWebsiteLoginInput {
  readonly origin: string
  readonly label: string
  readonly username: string
  readonly password: string
}

/** Import operations reserved for the native file picker flow. */
export type VaultLoginImportRequest = { readonly action: 'inspect-login-import'; readonly salt: string }
  | ({ readonly action: 'import-login' } & VaultWebsiteLoginInput)

type VaultWireRequest = VaultLoginImportRequest | Exclude<VaultRequest, { readonly action: 'list-browser-access' | 'set-browser-access' }>
  | { readonly action: 'list-scoped-grants' } | {
    readonly action: 'set-browser-access'
    readonly bot: VaultBotId
    readonly session: VaultBotSessionId
    readonly enabled: boolean
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
  readonly grants: readonly (VaultBotGrant & { readonly scope?: VaultGrantScope })[]
  /** Current Cloud and the VPS broker support editing grant scopes. */
  readonly sharedScopes?: true
}

/** Bot identity and name presented to the owner in the grant form. */
export interface VaultBotChoice {
  readonly id: VaultBotId
  readonly name: string
}

/** Non-secret owner projection of one Bot's shared-browser capability. */
export interface VaultBrowserAccessBot {
  readonly id: VaultBotId
  readonly name: string
  readonly enabled: boolean
}

/** Shared-browser capability returned to the native Vault renderer. */
export interface VaultBrowserAccess {
  readonly mode: 'managed' | 'unavailable'
  readonly bots: readonly VaultBrowserAccessBot[]
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
  /** Assigned Bot for a dedicated account. Omitted for personal accounts. */
  readonly bot?: VaultBotId
}

/** Metadata for one paused browser sign-in request; no credential value is returned. */
export interface VaultLoginUseRequestMetadata {
  readonly id: VaultLoginUseRequestId
  readonly origin: string
  readonly destination: string
  readonly logins: readonly VaultLoginUseChoice[]
  readonly acceptsCredentials?: true
  readonly purpose?: 'signup' | 'verification'
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
  readonly botLogins: readonly VaultLogin[]
  readonly bots?: readonly VaultBotChoice[]
} | {
  readonly ok: true
  readonly loginAutomation: {
    readonly available: boolean
    readonly enabled: readonly VaultLoginId[]
  }
} | {
  readonly ok: true
  readonly access: VaultBotAccess
  readonly bots?: readonly VaultBotChoice[]
} | {
  readonly ok: true
  readonly browserAccess: VaultBrowserAccess
} | {
  readonly importIndex: { readonly fingerprints: readonly string[]; readonly remaining: number }
} | {
  readonly outcome: 'imported' | 'duplicate' | 'full'
} | {
  readonly request: VaultRequestMetadata | VaultLoginUseRequestMetadata
} | {
  readonly state: 'saved' | 'cancelled' | 'unavailable'
} | {
  readonly state: 'submitted' | 'needs-owner'
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

/** Owner-authenticated Cloud view and its connection-bound Vault commands. */
export interface CloudVaultSession extends VaultCloudWorkspace {
  /** Transport owned by the active native Cloud connection. */
  readonly sendVaultRequest: CloudVaultTransport
}

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

function botSessionId(value: unknown): value is VaultBotSessionId {
  return typeof value === 'string' && BOT_SESSION.test(value)
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

/**
 * Normalize a CSV login to an exact Vault origin. Password and username text are preserved.
 * @param site - HTTPS login URL from the export.
 * @param title - Optional entry label from the export.
 * @param user - Exact account name from the export.
 * @param secret - Exact password from the export.
 * @returns A valid website login or undefined when the row cannot be stored.
 */
export function normalizeVaultLoginImport(site: string, title: string, user: string, secret: string): VaultWebsiteLoginInput | undefined {
  const candidate = site.trim()
  if (!/^https:\/\//iu.test(candidate) || CONTROL.test(site) || candidate.includes('\\')) return undefined
  let url: URL
  try { url = new URL(candidate) }
  catch { return undefined }
  if (url.username !== '' || url.password !== '') return undefined
  const origin = loginOrigin(url.origin, true)
  const username = boundedLoginText(user, LOGIN_USERNAME_LIMIT, false)
  const password = boundedLoginText(secret, LOGIN_PASSWORD_LIMIT, false)
  if (origin === undefined || username === undefined || password === undefined) return undefined
  const label = boundedLoginText(title, LOGIN_LABEL_LIMIT, true) ?? url.hostname.slice(0, LOGIN_LABEL_LIMIT)
  return { origin, label, username, password }
}

function grantScope(value: unknown): value is VaultGrantScope {
  return value === 'owner' || value === 'shared'
}

function requestBody(value: unknown): VaultRequest | undefined {
  if (!record(value)) return undefined
  const { action, unit, name } = value
  const fields = Object.keys(value).length
  if ((action === 'list' || action === 'list-grants') && fields === 1) return { action }
  if (action === 'list-browser-access' && fields === 1) return { action }
  if (action === 'set-browser-access' && fields === 3 && botId(value.bot) && typeof value.enabled === 'boolean') {
    return { action, bot: value.bot, enabled: value.enabled }
  }
  if ((action === 'add-grant' || action === 'remove-grant' || action === 'set-grant-scope')
    && botId(value.bot) && unitName(unit) && keyName(name)) {
    const subject = { bot: value.bot, unit, name }
    if (action === 'set-grant-scope') {
      return fields === 5 && grantScope(value.scope) ? { action, ...subject, scope: value.scope } : undefined
    }
    if (fields === 4) return { action, ...subject }
    return action === 'add-grant' && fields === 5 && value.scope === 'shared' ? { action, ...subject, scope: value.scope } : undefined
  }
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
  if (action === 'create-login-use' && fields === 6 && isVaultLoginUseRequestId(value.id)) {
    const origin = loginOrigin(value.origin, true)
    const destination = origin === undefined ? undefined : loginDestination(value.destination, origin)
    const username = boundedLoginText(value.username, LOGIN_USERNAME_LIMIT, true)
    const saveLabel = boundedLoginText(value.saveLabel, LOGIN_LABEL_LIMIT, true)
    if (origin === undefined || destination === undefined || username === undefined || saveLabel === undefined) return undefined
    return { action, id: value.id, origin, destination, username, saveLabel }
  }
  if (action === 'enter-verification-code' && fields === 5 && isVaultLoginUseRequestId(value.id)) {
    const origin = loginOrigin(value.origin, true)
    const destination = origin === undefined ? undefined : loginDestination(value.destination, origin)
    const code = boundedLoginText(value.code, LOGIN_CODE_LIMIT, false)
    if (origin === undefined || destination === undefined || code === undefined) return undefined
    return { action, id: value.id, origin, destination, code }
  }
  if (action === 'save-request' && fields === 3 && isVaultRequestId(value.id)
    && typeof value.value === 'string' && value.value.length > 0 && !value.value.includes('\0')
    && value.value.isWellFormed() && Buffer.byteLength(value.value, 'utf8') <= VALUE_LIMIT) {
    return { action, id: value.id, value: value.value }
  }
  if ((action === 'list-logins' || action === 'list-bot-logins') && fields === 1) return { action }
  if (action === 'list-login-automation' && fields === 1) return { action }
  if (action === 'set-login-automatic' && fields === 4 && isVaultLoginId(value.id)
    && botId(value.bot) && typeof value.enabled === 'boolean') {
    return { action, id: value.id, bot: value.bot, enabled: value.enabled }
  }
  if (action === 'add-login' || action === 'replace-login' || action === 'remove-login') {
    const assigned = Object.hasOwn(value, 'bot')
    if (assigned && !botId(value.bot)) return undefined
    const scope = botId(value.bot) ? { bot: value.bot } : {}
    if (fields !== (action === 'remove-login' ? 2 : 5) + Number(assigned)) return undefined
    if (action === 'remove-login') return isVaultLoginId(value.id) ? { action, id: value.id, ...scope } : undefined
    const label = boundedLoginText(value.label, LOGIN_LABEL_LIMIT, true)
    const username = boundedLoginText(value.username, LOGIN_USERNAME_LIMIT, false)
    const password = boundedLoginText(value.password, LOGIN_PASSWORD_LIMIT, false)
    if (label === undefined || username === undefined || password === undefined) return undefined
    const credentials = { label, username, password, ...scope }
    if (action === 'replace-login') return isVaultLoginId(value.id) ? { action, id: value.id, ...credentials } : undefined
    const origin = loginOrigin(value.origin)
    return origin === undefined ? undefined : { action, origin, ...credentials }
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

function loginMetadata(value: unknown, scoped: boolean): VaultLogin | undefined {
  if (!record(value) || Object.keys(value).length !== (scoped ? 4 : 3) || !isVaultLoginId(value.id)
    || (scoped && !botId(value.bot))) return undefined
  const origin = loginOrigin(value.origin, true)
  const label = boundedLoginText(value.label, LOGIN_LABEL_LIMIT, true)
  if (origin === undefined || label === undefined) return undefined
  return { id: value.id, origin, label, ...(scoped && botId(value.bot) ? { bot: value.bot } : {}) }
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
  const { purpose } = value
  const special = purpose !== undefined
  if (fields !== (acceptsCredentials || special ? 5 : 4) || (acceptsCredentials && special)
    || (special && purpose !== 'signup' && purpose !== 'verification')
    || (value.acceptsCredentials !== undefined && !acceptsCredentials)) return undefined
  const origin = loginOrigin(value.origin, true)
  const destination = origin === undefined ? undefined : loginDestination(value.destination, origin)
  if (origin === undefined || destination === undefined || !Array.isArray(value.logins)
    || value.logins.length > MAX_LOGINS || (special && value.logins.length !== 0)) return undefined
  const ids = new Set<string>()
  const logins: VaultLoginUseChoice[] = []
  for (const login of value.logins) {
    const metadata = loginUseChoice(login)
    if (metadata === undefined || ids.has(metadata.id)) return undefined
    ids.add(metadata.id)
    logins.push(metadata)
  }
  return {
    id: value.id, origin, destination, logins,
    ...(acceptsCredentials ? { acceptsCredentials: true } : {}),
    ...(purpose === undefined ? {} : { purpose }),
  }
}

function botAccess(value: unknown, sharedScopes: boolean): VaultBotAccess | undefined {
  if (!record(value) || Object.keys(value).length !== 2 || !Array.isArray(value.services) || value.services.length > 16
    || !value.services.every(unitName) || new Set(value.services).size !== value.services.length
    || !Array.isArray(value.grants) || value.grants.length > 64) return undefined
  const grants: Array<VaultBotAccess['grants'][number]> = []
  const identities = new Set<string>()
  for (const item of value.grants) {
    if (!record(item) || Object.keys(item).length !== (sharedScopes ? 4 : 3)
      || !botId(item.bot) || !unitName(item.unit) || !keyName(item.name)) return undefined
    const scope = item.scope
    if (sharedScopes && !grantScope(scope)) return undefined
    const key = JSON.stringify([item.bot, item.unit, item.name])
    if (identities.has(key)) return undefined
    identities.add(key)
    grants.push({ bot: item.bot, unit: item.unit, name: item.name, ...(grantScope(scope) ? { scope } : {}) })
  }
  return { services: value.services, grants, ...(sharedScopes ? { sharedScopes: true } : {}) }
}

function replyBody(
  action: VaultWireRequest['action'], stdout: string,
  expectedId?: VaultRequestId | VaultLoginUseRequestId,
): VaultReply | undefined {
  const value: unknown = JSON.parse(stdout)
  if (!record(value)) return undefined
  const fields = Object.keys(value).length
  if (action === 'inspect-login-import') {
    const index = value.importIndex
    if (fields !== 1 || !record(index) || Object.keys(index).length !== 2
      || !Array.isArray(index.fingerprints) || !index.fingerprints.every(isVaultLoginGeneration)
      || new Set(index.fingerprints).size !== index.fingerprints.length
      || typeof index.remaining !== 'number' || !Number.isInteger(index.remaining) || index.remaining < 0
      || index.remaining + index.fingerprints.length > MAX_LOGINS) return undefined
    return { importIndex: { fingerprints: index.fingerprints, remaining: index.remaining } }
  }
  if (action === 'import-login') {
    const { outcome } = value
    return fields === 1 && (outcome === 'imported' || outcome === 'duplicate' || outcome === 'full') ? { outcome } : undefined
  }
  if (action === 'list-login-automation') {
    const automation = value.loginAutomation
    if (fields !== 1 || !record(automation) || Object.keys(automation).length !== 2
      || typeof automation.available !== 'boolean' || !Array.isArray(automation.enabled)
      || automation.enabled.length > MAX_LOGINS) return undefined
    const ids = new Set<VaultLoginId>()
    for (const id of automation.enabled) {
      if (!isVaultLoginId(id) || ids.has(id)) return undefined
      ids.add(id)
    }
    return { ok: true, loginAutomation: { available: automation.available, enabled: automation.enabled } }
  }
  if (action === 'create-login-use') {
    if (fields === 1 && value.state === 'unavailable') return { state: value.state }
    return fields === 2 && value.saved === true && (value.state === 'submitted' || value.state === 'needs-owner')
      ? { state: value.state, saved: true } : undefined
  }
  if (action === 'enter-login-use' && fields === 2 && value.state === 'submitted' && typeof value.saved === 'boolean') {
    return { state: value.state, saved: value.saved }
  }
  if (fields !== 1) return undefined
  if (action === 'list-grants' || action === 'list-scoped-grants') {
    const access = botAccess(value.access, action === 'list-scoped-grants')
    return access === undefined ? undefined : { ok: true, access }
  }
  if (action === 'set-browser-access') {
    return Object.keys(value).length === 1 && value.ok === true ? { ok: true } : undefined
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
  if (action === 'approve-login-use' || action === 'enter-login-use' || action === 'enter-verification-code') {
    const { state } = value
    return state === 'submitted' || state === 'needs-owner' || state === 'unavailable' ? { state } : undefined
  }
  if (action === 'decline-login-use') {
    return value.state === 'unavailable' ? { state: value.state } : undefined
  }
  if (action === 'dismiss-request') {
    return value.state === 'saved' || value.state === 'cancelled' ? { state: value.state } : undefined
  }
  if (action === 'list-logins' || action === 'list-bot-logins') {
    const scoped = action === 'list-bot-logins'
    const records = scoped ? value.botLogins : value.logins
    if (!Array.isArray(records) || records.length > MAX_LOGINS) return undefined
    const logins: VaultLogin[] = []
    const ids = new Set<string>()
    for (const login of records) {
      const metadata = loginMetadata(login, scoped)
      if (metadata === undefined || ids.has(metadata.id)) return undefined
      ids.add(metadata.id)
      logins.push(metadata)
    }
    return scoped ? { ok: true, botLogins: logins } : { ok: true, logins }
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
    || request.action === 'enter-login-use' || request.action === 'create-login-use'
    || request.action === 'enter-verification-code' || request.action === 'decline-login-use') {
    return typeof scope !== 'string' && scope?.kind === 'login-use' && request.id === scope.id
  }
  return scope === undefined || (typeof scope !== 'string' && scope.kind === 'manage')
}

interface VaultPolicy {
  readonly mode: 'managed' | 'external' | 'disabled'
  readonly sharedScopes: boolean
}

async function readCloudVaultPolicy(
  workspace: VaultCloudWorkspace, signal: AbortSignal,
): Promise<VaultPolicy | undefined> {
  const { origin } = workspace
  if (signal.aborted || !LOOPBACK_ORIGIN.test(origin)) return undefined
  try {
    const response = await workspace.fetch(`${origin}/api/bot-vault-access`, {
      method: 'GET', redirect: 'error', credentials: 'include', cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    })
    const reply = await readBoundedJson(response, MAX_ACCESS_MODE_BYTES)
    signal.throwIfAborted()
    if (!record(reply) || Object.keys(reply).length !== 1) return undefined
    const { mode } = reply
    if (mode !== 'managed' && mode !== 'external' && mode !== 'disabled') return undefined
    return { mode, sharedScopes: mode === 'managed' && response.headers.get('X-YH-Vault-Grant-Scopes') === '1' }
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
    const reply = await readBoundedJson(response, MAX_ROSTER_BYTES)
    signal.throwIfAborted()
    if (!record(reply) || reply.type !== 'server-response' || reply.rpcId !== rpcId
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

interface CloudBrowserAccessBot extends VaultBrowserAccessBot {
  readonly sessionId: VaultBotSessionId
}

interface CloudBrowserAccess {
  readonly mode: 'managed' | 'unavailable'
  readonly bots: readonly CloudBrowserAccessBot[]
}

function browserAccessBody(value: unknown): CloudBrowserAccess | undefined {
  if (!record(value) || Object.keys(value).length !== 2
    || (value.mode !== 'managed' && value.mode !== 'unavailable')
    || !Array.isArray(value.bots) || value.bots.length > 64) return undefined
  if (value.mode === 'unavailable' && value.bots.length !== 0) return undefined
  const bots: CloudBrowserAccessBot[] = []
  const ids = new Set<string>()
  const sessions = new Set<VaultBotSessionId>()
  for (const row of value.bots) {
    if (!record(row) || Object.keys(row).length !== 4 || !botId(row.id)
      || typeof row.name !== 'string' || !row.name.isWellFormed() || row.name.trim() !== row.name
      || row.name.length === 0 || row.name.length > 255 || CONTROL.test(row.name)
      || !botSessionId(row.sessionId)
      || typeof row.enabled !== 'boolean' || ids.has(row.id) || sessions.has(row.sessionId)) return undefined
    ids.add(row.id)
    sessions.add(row.sessionId)
    bots.push({ id: row.id, name: row.name, sessionId: row.sessionId, enabled: row.enabled })
  }
  return { mode: value.mode, bots }
}

async function readCloudBrowserAccess(
  workspace: VaultCloudWorkspace, signal: AbortSignal,
): Promise<CloudBrowserAccess | undefined> {
  const { origin } = workspace
  if (signal.aborted || !LOOPBACK_ORIGIN.test(origin)) return undefined
  try {
    const response = await workspace.fetch(origin + '/api/bot-browser-access', {
      method: 'GET', redirect: 'error', credentials: 'include', cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    })
    const reply = await readBoundedJson(response, MAX_BROWSER_ACCESS_BYTES)
    signal.throwIfAborted()
    return browserAccessBody(reply)
  } catch (_error) {
    return undefined
  }
}

function browserAccessReply(value: CloudBrowserAccess): VaultReply {
  return { ok: true, browserAccess: {
    mode: value.mode,
    bots: value.bots.map(({ id, name, enabled }) => ({ id, name, enabled })),
  } }
}

/**
 * Send one bounded request over SSH and return only validated metadata or a fixed failure.
 * @param send - Request transport owned by the current native Cloud connection.
 * @param value - Untrusted IPC input from the Vault window.
 * @param signal - Cancel the SSH child when its window closes.
 * @param workspace - Authenticated Cloud connection required for Bot grant operations.
 * @returns A safe response for the Vault window.
 */
export async function cloudVaultRequest(
  send: CloudVaultTransport, value: unknown, signal: AbortSignal, workspace?: VaultCloudWorkspace,
): Promise<VaultReply> {
  const request = requestBody(value)
  if (request === undefined) return { ok: false, reason: 'invalid' }
  if (request.action === 'list-browser-access' || request.action === 'set-browser-access') {
    if (workspace === undefined) return unavailable
    const current = await readCloudBrowserAccess(workspace, signal)
    if (current === undefined) return unavailable
    if (request.action === 'list-browser-access') return browserAccessReply(current)
    if (current.mode !== 'managed') return unavailable
    const selected = current.bots.find(bot => bot.id === request.bot)
    if (selected === undefined) return unavailable
    const changed = await executeVaultRequest(send, {
      action: 'set-browser-access', bot: request.bot, session: selected.sessionId, enabled: request.enabled,
    }, signal)
    if (!('ok' in changed) || !changed.ok) return changed
    const verified = await readCloudBrowserAccess(workspace, signal)
    if (verified?.mode !== 'managed') return unavailable
    const confirmed = verified.bots.find(bot => bot.id === request.bot)
    return confirmed?.sessionId === selected.sessionId && confirmed.enabled === request.enabled
      ? browserAccessReply(verified) : unavailable
  }
  let bots: readonly VaultBotChoice[] | undefined
  let sharedScopes = false
  const grantWrite = request.action === 'add-grant' || request.action === 'set-grant-scope'
  if (request.action === 'list-grants' || grantWrite || request.action === 'remove-grant') {
    if (workspace === undefined) return unavailable
    const policy = await readCloudVaultPolicy(workspace, signal)
    if (policy?.mode !== 'managed') return { ok: false, reason: policy?.mode ?? 'unavailable' }
    sharedScopes = policy.sharedScopes
    if (grantWrite && request.scope !== undefined && !sharedScopes) return unavailable
    if (request.action !== 'remove-grant') bots = await readCloudVaultBots(workspace.origin, workspace.fetch, signal)
    if (grantWrite && !bots?.some(bot => bot.id === request.bot)) return unavailable
  }
  const assignedLogin = request.action === 'add-login' ? request.bot : undefined
  if (request.action === 'list-bot-logins' || assignedLogin !== undefined) {
    if (workspace !== undefined) bots = await readCloudVaultBots(workspace.origin, workspace.fetch, signal)
    if (assignedLogin !== undefined && !bots?.some(bot => bot.id === assignedLogin)) return unavailable
  }
  if (request.action === 'set-login-automatic' && request.enabled) {
    // Enabling binds the grant to the current authenticated Cloud roster. Disabling
    // stays available for an exact Vault account after its Bot leaves that roster.
    if (workspace === undefined || (await readCloudVaultPolicy(workspace, signal))?.mode !== 'managed') return unavailable
    bots = await readCloudVaultBots(workspace.origin, workspace.fetch, signal)
    if (!bots?.some(bot => bot.id === request.bot)) return unavailable
  }
  const scoped = request.action === 'list-grants' && sharedScopes
    ? await executeVaultRequest(send, { action: 'list-scoped-grants' }, signal)
    : undefined
  const reply = scoped !== undefined && 'access' in scoped
    ? scoped
    : await executeVaultRequest(send, request, signal)
  if ('loginAutomation' in reply && reply.loginAutomation.available) {
    const policy = workspace === undefined ? undefined : await readCloudVaultPolicy(workspace, signal)
    return { ...reply, loginAutomation: { ...reply.loginAutomation, available: policy?.mode === 'managed' } }
  }
  return ('access' in reply || 'botLogins' in reply) && bots !== undefined ? { ...reply, bots } : reply
}

/**
 * Send an import operation through the native workspace's authenticated Vault connection.
 * @param send - The active connection's Vault transport.
 * @param request - Native import operation, unavailable through renderer requests.
 * @param signal - Cancellation for the current native import.
 * @returns Validated import metadata, outcome, or an unavailable result.
 */
export function cloudVaultLoginImport(
  send: CloudVaultTransport, request: VaultLoginImportRequest, signal: AbortSignal,
): Promise<VaultReply> {
  return executeVaultRequest(send, request, signal)
}

async function executeVaultRequest(
  send: CloudVaultTransport, request: VaultWireRequest, signal: AbortSignal,
): Promise<VaultReply> {
  if (signal.aborted) return unavailable
  try {
    const stdout = await send(JSON.stringify(request), signal)
    signal.throwIfAborted()
    if (stdout === undefined) return unavailable
    const expectedId = request.action === 'inspect-request' || request.action === 'inspect-login-use'
      ? request.id : undefined
    return replyBody(request.action, stdout, expectedId) ?? unavailable
  } catch {
    return unavailable
  }
}
