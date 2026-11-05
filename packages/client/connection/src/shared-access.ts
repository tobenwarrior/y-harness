/** Self-hosted collaborator enrollment and the shared-Bot Peer capability. */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Context } from '@yharness/cordis'
import { brandString, type Branded } from '@yharness/brand'
import { credentialKey, type CredentialProvider, type CredentialRecord } from '@yharness/credentials'
import { createScope, type Scope } from '@yharness/scope'
import type { PeerId, PeerScope } from '@yharness/typert-protocol'
import { assertTrustedAuthority, isTrustedApiRequest } from './api-request-trust.ts'
import type { ConnectionTrustRequest, SharedAccessAuthenticator, SharedConnectionSocket, SharedPeerAdmission } from './rpc.ts'

/** Stable identifier for one self-hosted collaborator. */
export type SharedPrincipalId = Branded<'SharedPrincipalId'>

/**
 * Apply the collaborator-id brand to a generated or validated id.
 * @param value - validated collaborator id.
 * @returns the branded collaborator id.
 */
export function SharedPrincipalId(value: string): SharedPrincipalId {
  return brandString<SharedPrincipalId>(value)
}

/** One-time enrollment code issued by the local Bot owner. */
export type SharedInviteCode = Branded<'SharedInviteCode'>

/**
 * Apply the invite-code brand to a generated enrollment code.
 * @param value - opaque enrollment code.
 * @returns the branded enrollment code.
 */
export function SharedInviteCode(value: string): SharedInviteCode {
  return brandString<SharedInviteCode>(value)
}

/** The access audience carried by every collaborator Peer. */
export const SHARED_ACCESS_AUDIENCE = 'shared-bots' as const

/** Cookie name reserved for collaborator sessions; it is distinct from operator authentication. */
export const SHARED_ACCESS_COOKIE_NAME = 'dsh-shared-bot'

/** Credential record holding the signing key and self-hosted access state. */
const SHARED_ACCESS_RECORD_KEY = credentialKey('client-connection', 'shared-access')
const SHARED_ACCESS_RECORD_VERSION = 1
const SHARED_ACCESS_SECRET_BYTES = 32
const SHARED_ACCESS_CODE_BYTES = 32
const SHARED_ACCESS_COOKIE_VERSION = 'v1'
const PRINCIPAL_PATTERN = /^principal-[A-Za-z0-9-]+$/u
const SHARED_OWNER_EXTENSION_KEY = 'client-connection/shared-owner'
const SHARED_OWNER_EXTENSION_VERSION = 1 as const

/** Maximum interval before a separate authority observes a durable revocation. */
const SHARED_ACCESS_PEER_SWEEP_INTERVAL_MS = 1_000

/** Configuration for one local collaborator authority. Durations are milliseconds. */
export interface SharedAccessOptions {
  /** Maximum lifetime of a collaborator session. */
  readonly sessionMaxAgeMs: number
  /** Maximum lifetime of an unused enrollment code. */
  readonly inviteMaxAgeMs: number
  /** Mark collaborator cookies Secure when the deployment is HTTPS. @default false for loopback HTTP. */
  readonly secureCookie?: boolean
  /** Non-loopback authorities accepted by direct collaborator admission. */
  readonly trustedHosts?: readonly string[]
  /** Clock used for expiry checks; defaults to Date.now. */
  readonly now?: () => number
  /** Random-byte source; defaults to node:crypto. */
  readonly randomBytes?: (size: number) => Buffer
  /** UUID source; defaults to node:crypto. */
  readonly randomUUID?: () => string
}

interface ResolvedOptions {
  readonly sessionMaxAgeMs: number
  readonly inviteMaxAgeMs: number
  readonly secureCookie: boolean
  readonly trustedHosts: readonly string[]
  readonly now: () => number
  readonly randomBytes: (size: number) => Buffer
  readonly randomUUID: () => string
}

interface StoredInvite {
  digest: string
  expiresAt: number
  metadata?: Readonly<Record<string, string>>
}

interface StoredPrincipal {
  id: SharedPrincipalId
  createdAt: number
  revokedAt?: number
}

interface StoredSession {
  id: string
  principalId: SharedPrincipalId
  issuedAt: number
  expiresAt: number
  revokedAt?: number
}

interface StoredOwner {
  readonly version: typeof SHARED_OWNER_EXTENSION_VERSION
  readonly principalId: SharedPrincipalId
}

interface MutableState {
  readonly secret: Buffer
  readonly invites: StoredInvite[]
  readonly principals: StoredPrincipal[]
  readonly sessions: StoredSession[]
  readonly extensions: Record<string, unknown>
}

interface StoredStatePayload {
  readonly version: typeof SHARED_ACCESS_RECORD_VERSION
  readonly secret: string
  readonly invites: readonly StoredInvite[]
  readonly principals: readonly StoredPrincipal[]
  readonly sessions: readonly StoredSession[]
  readonly extensions?: Readonly<Record<string, unknown>>
}

/** Bounded non-secret association persisted with an invite by its owner. */
export type SharedAccessInviteMetadata = Readonly<Record<string, string>>

const MAX_INVITE_METADATA_FIELDS = 8
const MAX_INVITE_METADATA_KEY_LENGTH = 64
const MAX_INVITE_METADATA_VALUE_LENGTH = 256

/** Durable authority state exposed to one extension mutation. */
export interface SharedAccessStateSnapshot {
  readonly principals: readonly {
    readonly id: SharedPrincipalId
    readonly revokedAt?: number
  }[]
  /** Pending invite digests used by durable mirror consumers; the code is never exposed. */
  readonly invites?: readonly {
    readonly digest: string
    readonly expiresAt: number
    readonly metadata?: SharedAccessInviteMetadata
  }[]
}

/** Result of one atomic authority-extension mutation. */
export interface SharedAccessExtensionMutation<T> {
  readonly value: T
  readonly next: unknown
}

type SharedAccessExtensionMutationResult<T> =
  | SharedAccessExtensionMutation<T>
  | Promise<SharedAccessExtensionMutation<T>>

/** Result of one atomic mutation over selected authority extensions. */
export interface SharedAccessExtensionsMutation<T> {
  readonly value: T
  /** Next values for selected keys; an omitted or `undefined` value deletes that key. */
  readonly next: Readonly<Record<string, unknown>>
}

type SharedAccessExtensionsMutationResult<T> =
  | SharedAccessExtensionsMutation<T>
  | Promise<SharedAccessExtensionsMutation<T>>

/** Authorities sharing one credential provider observe revocations together. */
const authorityInstances = new WeakMap<CredentialProvider, Set<SharedAccessAuthority>>()

/** A collaborator Peer whose scope is never admitted to the ordinary `/api` route. */
export interface SharedAccessPeer extends PeerScope {
  readonly audience: typeof SHARED_ACCESS_AUDIENCE
  readonly principalId: SharedPrincipalId
  /** Absolute expiry of the authenticated session represented by this Peer. */
  readonly expiresAt: number
  /** Aborts requests and turns that still run when this identity is revoked. */
  readonly revocationSignal: AbortSignal
}

/** Result returned after an invite is redeemed by a collaborator. */
export interface SharedAccessEnrollment {
  /** Newly minted collaborator identity. */
  readonly principalId: SharedPrincipalId
  /** Set-Cookie header value for the collaborator response. */
  readonly setCookie: string
  /** Absolute session expiry. */
  readonly expiresAt: number
}

/**
 * Return the stable digest used to associate an invite with a Bot share.
 * @param code Invite code to digest.
 * @returns Stable digest for storage association.
 */
export function sharedInviteDigest(code: SharedInviteCode | string): string {
  return digest(String(code))
}

/** Result returned when an owner creates a one-time enrollment invitation. */
export interface SharedAccessInvite {
  /** Opaque code that may be redeemed exactly once. */
  readonly code: SharedInviteCode
  /** Absolute invitation expiry. */
  readonly expiresAt: number
}

/**
 * Authenticate self-hosted collaborators with one-time owner-issued invites.
 * The authority stores only hashed invite codes and opaque session ids; the
 * session signing key and access state live in the owner credential store.
 * Authorities created from the same credential provider refresh one another's
 * admitted scopes after a mutation, so revocation closes local sockets and
 * aborts local work even when another authority instance issued the mutation.
 */
export class SharedAccessAuthority implements SharedAccessAuthenticator {
  private readonly peers = new Map<string, SharedAccessPeerImpl>()
  private readonly peerExpirations = new Map<string, ReturnType<typeof setTimeout>>()
  private peerSweepTimer: ReturnType<typeof setInterval> | undefined
  private peerSweepPending: Promise<void> | undefined
  private disposed = false

  private constructor(
    private readonly owner: Context,
    private readonly credentials: CredentialProvider,
    private state: MutableState,
    private readonly options: ResolvedOptions,
  ) {
  }

  /**
   * Load or initialize the durable authority record.
   * @param owner - Host Context under which collaborator Peer scopes live.
   * @param credentials - owner-scoped durable credential provider.
   * @param options - session and invitation lifetimes.
   * @returns a ready authority whose admission refreshes durable state before checking a cookie.
   */
  static async create(
    owner: Context,
    credentials: CredentialProvider,
    options: SharedAccessOptions,
  ): Promise<SharedAccessAuthority> {
    const resolved = resolveOptions(options)
    const initial = createInitialState(resolved)
    const record = await credentials.modifyRecord(SHARED_ACCESS_RECORD_KEY, (current: CredentialRecord | undefined) => {
      if (current !== undefined) {
        parseStoredState(current)
        return Promise.resolve(undefined)
      }
      return Promise.resolve({ kind: 'grant', payload: serializeState(initial) })
    })
    const state = parseStoredState(record)
    if (state === undefined) {
      throw new Error('client-connection: shared-access credential record was not created')
    }
    const authority = new SharedAccessAuthority(owner, credentials, state, resolved)
    registerAuthority(credentials, authority)
    return authority
  }

  /**
   * Issue one single-use enrollment code. The caller must expose it only to
   * the intended person; the code itself is not a long-term collaborator id.
   * @returns opaque invite code and its expiry.
   */
  async createInvite(): Promise<SharedAccessInvite> {
    return this.createInviteIf(() => {})
  }

  /**
   * Issue one invite only when an authority-side guard accepts the current
   * principals and extensions in the same durable mutation that records the
   * invite. A guard rejection leaves no invite behind.
   * @param authorize - synchronous or asynchronous authority-side guard. The
   *   second argument is private extension data observed in the same mutation.
   * @param persist - optional mirror write performed before the authority
   *   records the invite. A rejected mirror leaves the invite unpublished.
   * @param metadata - optional bounded non-secret association retained in the
   *   authority state for consumers that must refresh stale mirrors.
   * @returns opaque invite code and its expiry.
   */
  async createInviteIf(
    authorize: (
      state: SharedAccessStateSnapshot,
      extensions: Readonly<Record<string, unknown>>,
    ) => void | Promise<void>,
    persist?: (invite: SharedAccessInvite) => void | Promise<void>,
    metadata?: SharedAccessInviteMetadata,
  ): Promise<SharedAccessInvite> {
    const expiresAt = expiry(this.options.now(), this.options.inviteMaxAgeMs)
    const code = encodeBase64Url(this.options.randomBytes(SHARED_ACCESS_CODE_BYTES))
    const normalizedMetadata = metadata === undefined ? undefined : parseInviteMetadata(metadata)
    await this.mutate(async (state) => {
      await authorize(snapshotState(state), { ...state.extensions })
      await persist?.({ code: SharedInviteCode(code), expiresAt })
      state.invites.push({
        digest: sharedInviteDigest(code),
        expiresAt,
        ...(normalizedMetadata === undefined ? {} : { metadata: normalizedMetadata }),
      })
    })
    return { code: SharedInviteCode(code), expiresAt }
  }

  /**
   * Enroll the authenticated local operator as the one durable shared owner.
   *
   * This operation is only callable by a Host after its ordinary browser
   * authentication has passed. The owner mapping and principal are recorded
   * in the authority transaction; later Hosts issue another session for that
   * same principal instead of minting a browser-controlled identity. An
   * existing owner principal may be supplied by a trusted durable membership
   * migration so older shared-Bot memberships keep their identity.
   * @param request - trusted request that receives the shared HttpOnly cookie.
   * @param existingPrincipalId - optional owner principal recovered from durable memberships.
   * @returns the owner principal and its new or existing shared session cookie.
   * @throws Error when the request is not trusted or the durable owner mapping is invalid/revoked.
   */
  async enrollOwner(
    request: ConnectionTrustRequest,
    existingPrincipalId?: SharedPrincipalId,
  ): Promise<SharedAccessEnrollment> {
    const authority = trustedRequestAuthority(request, this.options.trustedHosts)
    if (authority === undefined) throw new Error('shared access: owner enrollment request is not trusted')
    const now = this.options.now()
    const enrolled = await this.mutate((state) => {
      const stored = parseStoredOwner(state.extensions[SHARED_OWNER_EXTENSION_KEY])
      const candidateId = stored?.principalId ?? existingPrincipalId
      let principal = candidateId === undefined
        ? undefined
        : state.principals.find(value => value.id === candidateId)
      if (candidateId !== undefined && principal === undefined) {
        throw new Error('shared access: durable owner principal is missing')
      }
      if (principal?.revokedAt !== undefined) {
        throw new Error('shared access: durable owner principal is revoked')
      }
      if (principal === undefined) {
        const principalId = SharedPrincipalId(`principal-${this.options.randomUUID()}`)
        principal = { id: principalId, createdAt: now }
        state.principals.push(principal)
      }
      if (stored === undefined) {
        state.extensions[SHARED_OWNER_EXTENSION_KEY] = {
          version: SHARED_OWNER_EXTENSION_VERSION,
          principalId: principal.id,
        }
      } else if (stored.principalId !== principal.id) {
        throw new Error('shared access: durable owner principal changed during enrollment')
      }
      const token = cookieValue(header(request.headers, 'cookie') ?? '', SHARED_ACCESS_COOKIE_NAME)
      const existingSessionId = token === undefined ? undefined : this.verifyCookie(token, state.secret, authority)
      const existingSession = existingSessionId === undefined ? undefined : state.sessions.find(session =>
        session.id === existingSessionId && session.principalId === principal.id
          && session.revokedAt === undefined && now < session.expiresAt)
      const sessionId = existingSession?.id ?? this.options.randomUUID()
      const expiresAt = existingSession?.expiresAt ?? expiry(now, this.options.sessionMaxAgeMs)
      if (existingSession === undefined) {
        state.sessions.push({ id: sessionId, principalId: principal.id, issuedAt: now, expiresAt })
      }
      return { principalId: principal.id, sessionId, expiresAt }
    })
    return {
      principalId: enrolled.principalId,
      setCookie: this.sessionCookie(enrolled.sessionId, enrolled.expiresAt, authority),
      expiresAt: enrolled.expiresAt,
    }
  }

  /**
   * Consume one invite and mint a principal-bound HttpOnly session cookie.
   * When the trusted request already carries an active collaborator cookie,
   * redeeming another invite extends that authenticated principal to the new
   * capability instead of creating a second identity.
   * @param code - raw code received through the enrollment flow.
   * @param request - trusted request authority that receives the cookie.
   * @returns the principal and Set-Cookie header to send to that collaborator.
   * @throws Error when the code is malformed, expired, or already consumed.
   */
  async redeemInvite(code: SharedInviteCode, request: ConnectionTrustRequest): Promise<SharedAccessEnrollment> {
    const authority = trustedRequestAuthority(request, this.options.trustedHosts)
    if (authority === undefined) throw new Error('shared access: enrollment request is not trusted')
    const raw = typeof code === 'string' ? code : ''
    const now = this.options.now()
    const created = await this.mutate((state) => {
      const index = state.invites.findIndex(invite => invite.digest === sharedInviteDigest(raw))
      const invite = index === -1 ? undefined : state.invites[index]
      if (invite === undefined || now >= invite.expiresAt) {
        if (index !== -1) state.invites.splice(index, 1)
        return undefined
      }
      state.invites.splice(index, 1)
      const token = cookieValue(header(request.headers, 'cookie') ?? '', SHARED_ACCESS_COOKIE_NAME)
      const existingSessionId = token === undefined ? undefined : this.verifyCookie(token, state.secret, authority)
      const existingSession = existingSessionId === undefined ? undefined : state.sessions.find(session =>
        session.id === existingSessionId && session.revokedAt === undefined && now < session.expiresAt)
      const existingPrincipal = existingSession === undefined ? undefined : state.principals.find(principal =>
        principal.id === existingSession.principalId && principal.revokedAt === undefined)
      const principalId = existingPrincipal?.id ?? SharedPrincipalId(`principal-${this.options.randomUUID()}`)
      const sessionId = existingSession?.id ?? this.options.randomUUID()
      const expiresAt = existingSession?.expiresAt ?? expiry(now, this.options.sessionMaxAgeMs)
      if (existingPrincipal === undefined) {
        state.principals.push({ id: principalId, createdAt: now })
        state.sessions.push({ id: sessionId, principalId, issuedAt: now, expiresAt })
      }
      return { principalId, sessionId, expiresAt }
    })
    if (created === undefined) throw new Error('shared access: invite is invalid or expired')
    return {
      principalId: created.principalId,
      setCookie: this.sessionCookie(created.sessionId, created.expiresAt, authority),
      expiresAt: created.expiresAt,
    }
  }

  /**
   * Cancel one unused enrollment code after an owner-side association fails.
   * @param code Invite code to cancel.
   */
  async cancelInvite(code: SharedInviteCode): Promise<void> {
    await this.mutate((state) => {
      const index = state.invites.findIndex(invite => invite.digest === sharedInviteDigest(code))
      if (index !== -1) state.invites.splice(index, 1)
      return undefined
    })
  }

  /**
   * Read one extension value together with the authority principals used to
   * authorize a related atomic mutation.
   * @param key - private extension key owned by the capability consumer.
   * @returns the current extension value and principal revocation state.
   */
  async readExtension(key: string): Promise<{ readonly value: unknown; readonly state: SharedAccessStateSnapshot }> {
    const state = await this.currentState(true)
    return { value: state.extensions[key], state: snapshotState(state) }
  }

  /**
   * Mutate one extension in the same durable record as authority revocation.
   * The callback observes the record while its credential write is exclusive;
   * an extension can therefore reject an actor revoked by a concurrent
   * authority before its own mutation commits. An asynchronous callback keeps
   * that exclusion while it commits one dependent durable operation.
   * @param key - private extension key owned by the capability consumer.
   * @param mutation - read-modify-write callback for the extension value.
   * @returns the callback result after the authority record commits.
   */
  async mutateExtension<T>(
    key: string,
    mutation: (current: unknown, state: SharedAccessStateSnapshot) => SharedAccessExtensionMutationResult<T>,
  ): Promise<T> {
    return this.mutate(async (state) => {
      const next = await mutation(state.extensions[key], snapshotState(state))
      state.extensions[key] = next.next
      return next.value
    })
  }

  /**
   * Read and mutate selected extensions in one exclusive authority record
   * transaction. The callback sees only the requested extension keys and the
   * current principal snapshot; another authority cannot commit a revocation
   * or extension update until the callback and this transaction finish.
   * @param keys - Distinct durable extension keys read and replaced atomically.
   * @param mutation - Read-modify-write callback; omit or set a selected next value to `undefined` to delete it.
   * @returns the callback result after the authority record commits.
   */
  async mutateExtensions<T>(
    keys: readonly string[],
    mutation: (
      current: Readonly<Record<string, unknown>>,
      state: SharedAccessStateSnapshot,
    ) => SharedAccessExtensionsMutationResult<T>,
  ): Promise<T> {
    const selectedKeys = validateExtensionKeys(keys)
    const selected = new Set(selectedKeys)
    return this.mutate(async (state) => {
      const current: Record<string, unknown> = {}
      for (const key of selectedKeys) {
        if (Object.prototype.hasOwnProperty.call(state.extensions, key)) {
          current[key] = state.extensions[key]
        }
      }
      const next = await mutation(current, snapshotState(state))
      for (const key of Object.keys(next.next)) {
        if (!selected.has(key)) throw new Error('client-connection: extension mutation returned an unselected key')
      }
      for (const key of selectedKeys) {
        const value = next.next[key]
        if (value === undefined) {
          if (!Reflect.deleteProperty(state.extensions, key)) throw new Error('client-connection: extension removal failed')
        }
        else state.extensions[key] = value
      }
      return next.value
    })
  }

  /** Authenticate a request by its trusted collaborator cookie. */
  async admit(request: ConnectionTrustRequest): Promise<SharedPeerAdmission> {
    if (this.disposed) return { rejection: 401 }
    if (!isTrustedApiRequest(request, this.options.trustedHosts)) return { rejection: 403 }
    try {
      const state = await this.currentState(true)
      if (this.isDisposed()) return { rejection: 401 }
      const authority = trustedRequestAuthority(request, this.options.trustedHosts)
      if (authority === undefined) return { rejection: 403 }
      const rawCookie = header(request.headers, 'cookie')
      const token = rawCookie === undefined ? undefined : cookieValue(rawCookie, SHARED_ACCESS_COOKIE_NAME)
      const sessionId = token === undefined ? undefined : this.verifyCookie(token, state.secret, authority)
      if (sessionId === undefined) return { rejection: 401 }
      const session = state.sessions.find(candidate => candidate.id === sessionId)
      if (session === undefined || this.options.now() >= session.expiresAt) return { rejection: 401 }
      const principal = state.principals.find(candidate => candidate.id === session.principalId)
      if (principal === undefined || principal.revokedAt !== undefined) return { rejection: 401 }
      let peer = this.peers.get(session.id)
      if (peer === undefined) {
        peer = new SharedAccessPeerImpl(this.owner, principal.id, session.expiresAt)
        this.peers.set(session.id, peer)
        this.schedulePeerExpiry(session.id, session.expiresAt)
        this.ensurePeerSweep()
      }
      return { peer }
    } catch (error) {
      // Persistent access-state failures deny collaborator access instead of exposing storage details.
      void error
      return { rejection: 401 }
    }
  }

  /**
   * Revoke one session and close any WebSocket scope using it.
   * @param sessionId - opaque session id to revoke.
   */
  async revokeSession(sessionId: string): Promise<void> {
    await this.mutate((state) => {
      const session = state.sessions.find(candidate => candidate.id === sessionId)
      if (session === undefined || session.revokedAt !== undefined) return undefined
      session.revokedAt = this.options.now()
      return undefined
    })
  }

  /**
   * Revoke every session for one principal and close its active scopes.
   * @param principalId - collaborator identity to revoke.
   */
  async revokePrincipal(principalId: SharedPrincipalId): Promise<void> {
    await this.mutate((state) => {
      const principal = state.principals.find(candidate => candidate.id === principalId)
      if (principal === undefined || principal.revokedAt !== undefined) return undefined
      principal.revokedAt = this.options.now()
      for (const session of state.sessions) {
        if (session.principalId === principalId) session.revokedAt = principal.revokedAt
      }
      return undefined
    })
  }

  /** Close all collaborator scopes and refuse future admission. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    unregisterAuthority(this.credentials, this)
    for (const timer of this.peerExpirations.values()) clearTimeout(timer)
    this.peerExpirations.clear()
    if (this.peerSweepTimer !== undefined) clearInterval(this.peerSweepTimer)
    this.peerSweepTimer = undefined
    await Promise.all([...this.peers.values()].map(peer => peer.dispose()))
    this.peers.clear()
  }

  private verifyCookie(token: string, secret: Buffer, authority: string): string | undefined {
    const [version, sessionId, encodedSignature] = token.split('.')
    if (version !== SHARED_ACCESS_COOKIE_VERSION || sessionId === undefined || encodedSignature === undefined) {
      return undefined
    }
    const actual = decodeBase64Url(encodedSignature)
    if (actual === undefined) return undefined
    const expected = signature(secret, `${sessionId}\n${authority}`)
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return undefined
    return sessionId
  }

  private sessionCookie(sessionId: string, expiresAt: number, authority: string): string {
    const maxAge = Math.max(1, Math.ceil((expiresAt - this.options.now()) / 1000))
    const secure = this.options.secureCookie ? '; Secure' : ''
    const token = `${SHARED_ACCESS_COOKIE_VERSION}.${sessionId}.${encodeBase64Url(signature(this.state.secret, `${sessionId}\n${authority}`))}`
    return `${SHARED_ACCESS_COOKIE_NAME}=${token}; Max-Age=${String(maxAge)}; Path=/shared-bots; HttpOnly; SameSite=Strict${secure}`
  }

  private async mutate<T>(mutation: (state: MutableState) => T | Promise<T>): Promise<T> {
    this.assertActive()
    let result: { readonly value: T } | undefined
    const record = await this.credentials.modifyRecord(SHARED_ACCESS_RECORD_KEY, (current) => {
      const state = stateFromRecord(current)
      return Promise.resolve(mutation(state)).then((value) => {
        result = { value }
        return { kind: 'grant', payload: serializeState(state) }
      })
    })
    this.state = stateFromRecord(record)
    await this.sweepPeers(this.state)
    await this.refreshPeerInstances()
    if (result === undefined) throw new Error('client-connection: shared-access mutation produced no result')
    return result.value
  }

  private async currentState(pruneExpired: boolean): Promise<MutableState> {
    let changed = false
    const record = await this.credentials.modifyRecord(SHARED_ACCESS_RECORD_KEY, (current) => {
      const state = stateFromRecord(current)
      if (pruneExpired) {
        const now = this.options.now()
        const invites = state.invites.length
        const sessions = state.sessions.length
        state.invites.splice(0, state.invites.length, ...state.invites.filter(invite => now < invite.expiresAt))
        state.sessions.splice(0, state.sessions.length, ...state.sessions.filter(session =>
          session.revokedAt === undefined && now < session.expiresAt))
        changed = invites !== state.invites.length || sessions !== state.sessions.length
      }
      return Promise.resolve(changed ? { kind: 'grant', payload: serializeState(state) } : undefined)
    })
    this.state = stateFromRecord(record)
    await this.sweepPeers(this.state)
    return this.state
  }

  private async refreshPeerInstances(): Promise<void> {
    const authorities = authorityInstances.get(this.credentials)
    if (authorities === undefined) return
    await Promise.all([...authorities]
      .filter(authority => authority !== this)
      .map(authority => authority.refreshPeersFromStore()))
  }

  private async refreshPeersFromStore(): Promise<void> {
    if (this.disposed) return
    if (this.peerSweepPending !== undefined) return this.peerSweepPending
    const pending = (async (): Promise<void> => {
      try {
        const record = await this.credentials.modifyRecord(SHARED_ACCESS_RECORD_KEY, () => Promise.resolve(undefined))
        this.state = stateFromRecord(record)
        await this.sweepPeers(this.state)
      } catch (error) {
        // A sibling authority cannot confirm state, so close its active scopes.
        void error
        await Promise.all([...this.peers].map(([sessionId, peer]) => this.disposePeer(sessionId, peer)))
      }
    })()
    this.peerSweepPending = pending
    try {
      await pending
    } finally {
      if (this.peerSweepPending === pending) this.peerSweepPending = undefined
    }
  }

  private ensurePeerSweep(): void {
    if (this.peerSweepTimer !== undefined || this.disposed) return
    this.peerSweepTimer = setInterval(() => {
      void this.refreshPeersFromStore()
    }, SHARED_ACCESS_PEER_SWEEP_INTERVAL_MS)
  }

  private async sweepPeers(state: MutableState): Promise<void> {
    const now = this.options.now()
    const sessions = new Set(state.sessions
      .filter(session => session.revokedAt === undefined && now < session.expiresAt)
      .map(session => session.id))
    for (const [sessionId, peer] of this.peers) {
      if (sessions.has(sessionId)) continue
      await this.disposePeer(sessionId, peer)
    }
  }

  private schedulePeerExpiry(sessionId: string, expiresAt: number): void {
    const prior = this.peerExpirations.get(sessionId)
    if (prior !== undefined) clearTimeout(prior)
    const delay = Math.max(0, Math.min(expiresAt - this.options.now(), 2_147_483_647))
    const timer = setTimeout(() => {
      this.peerExpirations.delete(sessionId)
      void this.expirePeer(sessionId)
    }, delay)
    this.peerExpirations.set(sessionId, timer)
  }

  private async expirePeer(sessionId: string): Promise<void> {
    if (this.disposed || !this.peers.has(sessionId)) return
    try {
      const state = await this.currentState(true)
      const session = state.sessions.find(candidate => candidate.id === sessionId)
      if (session !== undefined) this.schedulePeerExpiry(sessionId, session.expiresAt)
    } catch (error) {
      // An expiring scope cannot be trusted without a fresh durable record.
      void error
      const peer = this.peers.get(sessionId)
      if (peer !== undefined) await this.disposePeer(sessionId, peer)
    }
  }

  private async disposePeer(sessionId: string, peer: SharedAccessPeerImpl): Promise<void> {
    const timer = this.peerExpirations.get(sessionId)
    if (timer !== undefined) clearTimeout(timer)
    this.peerExpirations.delete(sessionId)
    await peer.dispose()
    this.peers.delete(sessionId)
    if (this.peers.size === 0 && this.peerSweepTimer !== undefined) {
      clearInterval(this.peerSweepTimer)
      this.peerSweepTimer = undefined
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('shared access: authority is disposed')
  }

  private isDisposed(): boolean {
    return this.disposed
  }
}

/**
 * Return the collaborator identity only for a Peer minted by this authority.
 * @param peer - admitted Peer to inspect.
 * @returns its collaborator identity, or `undefined` for an operator or other Peer.
 */
export function sharedPrincipalOf(peer: PeerScope): SharedPrincipalId | undefined {
  return peer instanceof SharedAccessPeerImpl ? peer.principalId : undefined
}

/**
 * Return the absolute expiry of a Peer minted by this authority.
 * @param peer - admitted Peer to inspect.
 * @returns its session expiry, or `undefined` for an operator or other Peer.
 */
export function sharedSessionExpiresAt(peer: PeerScope): number | undefined {
  return peer instanceof SharedAccessPeerImpl ? peer.expiresAt : undefined
}

/**
 * Return the signal aborted when a shared identity is revoked or expires.
 * @param peer - admitted Peer to inspect.
 * @returns the revocation signal, or `undefined` for an operator Peer.
 */
export function sharedRevocationSignal(peer: PeerScope): AbortSignal | undefined {
  return peer instanceof SharedAccessPeerImpl ? peer.revocationSignal : undefined
}

class SharedAccessPeerImpl implements SharedAccessPeer {
  readonly id: PeerId = randomUUID() as PeerId
  readonly audience = SHARED_ACCESS_AUDIENCE
  readonly ctx: Context
  private readonly revocation = new AbortController()
  private readonly scope: Scope
  private readonly sockets = new Set<SharedConnectionSocket>()

  constructor(owner: Context, readonly principalId: SharedPrincipalId, readonly expiresAt: number) {
    this.scope = createScope(owner, this)
    this.ctx = this.scope.ctx
  }

  dispose(): Promise<void> {
    if (!this.revocation.signal.aborted) this.revocation.abort()
    for (const socket of this.sockets) {
      if (!socket.destroyed) socket.destroy()
    }
    this.sockets.clear()
    return this.scope.dispose()
  }

  get revocationSignal(): AbortSignal {
    return this.revocation.signal
  }

  bindSocket(socket: SharedConnectionSocket): () => void {
    this.sockets.add(socket)
    const release = (): void => { this.sockets.delete(socket) }
    socket.once('close', release)
    return release
  }
}

/**
 * Bind a protocol socket to a shared Peer so revocation closes it.
 * @param peer Shared peer that owns the socket.
 * @param socket Protocol socket to close when the peer is revoked.
 * @returns Function that removes the socket binding.
 */
export function bindSharedAccessSocket(peer: PeerScope, socket: SharedConnectionSocket): () => void {
  return peer instanceof SharedAccessPeerImpl ? peer.bindSocket(socket) : () => {}
}

function resolveOptions(options: SharedAccessOptions): ResolvedOptions {
  if (!Number.isSafeInteger(options.sessionMaxAgeMs) || options.sessionMaxAgeMs <= 0) {
    throw new RangeError('shared access: sessionMaxAgeMs must be a positive safe integer')
  }
  if (!Number.isSafeInteger(options.inviteMaxAgeMs) || options.inviteMaxAgeMs <= 0) {
    throw new RangeError('shared access: inviteMaxAgeMs must be a positive safe integer')
  }
  return {
    sessionMaxAgeMs: options.sessionMaxAgeMs,
    inviteMaxAgeMs: options.inviteMaxAgeMs,
    secureCookie: options.secureCookie ?? false,
    trustedHosts: resolveTrustedHosts(options.trustedHosts, options.secureCookie ?? false),
    now: options.now ?? Date.now,
    randomBytes: options.randomBytes ?? randomBytes,
    randomUUID: options.randomUUID ?? randomUUID,
  }
}

function resolveTrustedHosts(values: readonly string[] | undefined, secureCookie: boolean): readonly string[] {
  const trustedHosts = values ?? []
  for (const host of trustedHosts) assertTrustedAuthority(host)
  if (trustedHosts.length > 0 && !secureCookie) {
    throw new RangeError('shared access: secureCookie must be true when trustedHosts includes a network authority')
  }
  return [...trustedHosts]
}

function createInitialState(options: ResolvedOptions): MutableState {
  return {
    secret: options.randomBytes(SHARED_ACCESS_SECRET_BYTES),
    invites: [],
    principals: [],
    sessions: [],
    extensions: {},
  }
}

function serializeState(state: MutableState): StoredStatePayload {
  return {
    version: SHARED_ACCESS_RECORD_VERSION,
    secret: encodeBase64Url(state.secret),
    invites: state.invites,
    principals: state.principals,
    sessions: state.sessions,
    ...(Object.keys(state.extensions).length === 0 ? {} : { extensions: state.extensions }),
  }
}

function parseStoredState(record: CredentialRecord | undefined): MutableState | undefined {
  if (record === undefined) return undefined
  if (record.kind !== 'grant' || !isRecord(record.payload)) {
    throw new Error('client-connection: shared-access credential record has an unsupported format')
  }
  const payload = record.payload
  if (payload.version !== SHARED_ACCESS_RECORD_VERSION
    || typeof payload.secret !== 'string'
    || !Array.isArray(payload.invites)
    || !Array.isArray(payload.principals)
    || !Array.isArray(payload.sessions)) {
    throw new Error('client-connection: shared-access credential record has an invalid format')
  }
  const secret = decodeBase64Url(payload.secret)
  if (secret === undefined || secret.byteLength !== SHARED_ACCESS_SECRET_BYTES) {
    throw new Error('client-connection: shared-access credential record has an invalid signing secret')
  }
  return {
    secret,
    invites: payload.invites.map(parseInvite),
    principals: payload.principals.map(parsePrincipal),
    sessions: payload.sessions.map(parseSession),
    extensions: payload.extensions === undefined ? {} : parseExtensions(payload.extensions),
  }
}

function snapshotState(state: MutableState): SharedAccessStateSnapshot {
  return {
    principals: state.principals.map(principal => ({
      id: principal.id,
      ...(principal.revokedAt === undefined ? {} : { revokedAt: principal.revokedAt }),
    })),
    invites: state.invites.map(invite => ({
      digest: invite.digest,
      expiresAt: invite.expiresAt,
      ...(invite.metadata === undefined ? {} : { metadata: { ...invite.metadata } }),
    })),
  }
}

function parseExtensions(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('client-connection: shared-access credential record has invalid extensions')
  const extensions: Record<string, unknown> = {}
  for (const [key, extension] of Object.entries(value)) {
    if (key.length === 0 || key.length > 128 || !isJsonValue(extension)) {
      throw new Error('client-connection: shared-access credential record has invalid extensions')
    }
    extensions[key] = extension
  }
  return extensions
}

function validateExtensionKeys(keys: readonly string[]): readonly string[] {
  const selected = [...keys]
  if (new Set(selected).size !== selected.length || selected.some(key => key.length === 0 || key.length > 128)) {
    throw new RangeError('client-connection: extension keys must be distinct and bounded')
  }
  return selected
}

function stateFromRecord(record: CredentialRecord | undefined): MutableState {
  const state = parseStoredState(record)
  if (state === undefined) throw new Error('client-connection: shared-access credential record is missing')
  return state
}

function parseInvite(value: unknown): StoredInvite {
  if (!isRecord(value) || typeof value.digest !== 'string' || !safeInteger(value.expiresAt)) {
    throw new Error('client-connection: shared-access credential record has an invalid invite')
  }
  const metadata = parseInviteMetadata(value.metadata)
  return {
    digest: value.digest,
    expiresAt: value.expiresAt,
    ...(metadata === undefined ? {} : { metadata }),
  }
}

function parseInviteMetadata(value: unknown): SharedAccessInviteMetadata | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('client-connection: shared-access credential record has invalid invite metadata')
  const entries = Object.entries(value)
  if (entries.length > MAX_INVITE_METADATA_FIELDS) {
    throw new Error('client-connection: shared-access invite metadata has too many fields')
  }
  const metadata: Record<string, string> = {}
  for (const [key, entry] of entries) {
    if (key.length === 0 || key.length > MAX_INVITE_METADATA_KEY_LENGTH
      || typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_INVITE_METADATA_VALUE_LENGTH) {
      throw new Error('client-connection: shared-access invite metadata is invalid')
    }
    metadata[key] = entry
  }
  return metadata
}

function parsePrincipal(value: unknown): StoredPrincipal {
  if (!isRecord(value) || typeof value.id !== 'string' || !PRINCIPAL_PATTERN.test(value.id)
    || !safeInteger(value.createdAt)
    || (value.revokedAt !== undefined && !safeInteger(value.revokedAt))) {
    throw new Error('client-connection: shared-access credential record has an invalid principal')
  }
  return {
    id: SharedPrincipalId(value.id),
    createdAt: value.createdAt,
    ...(value.revokedAt === undefined ? {} : { revokedAt: value.revokedAt }),
  }
}

function parseStoredOwner(value: unknown): StoredOwner | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || value.version !== SHARED_OWNER_EXTENSION_VERSION
    || typeof value.principalId !== 'string' || !PRINCIPAL_PATTERN.test(value.principalId)) {
    throw new Error('client-connection: shared-access credential record has an invalid durable owner')
  }
  return { version: SHARED_OWNER_EXTENSION_VERSION, principalId: SharedPrincipalId(value.principalId) }
}

function parseSession(value: unknown): StoredSession {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.principalId !== 'string'
    || !PRINCIPAL_PATTERN.test(value.principalId)
    || !safeInteger(value.issuedAt) || !safeInteger(value.expiresAt)
    || (value.revokedAt !== undefined && !safeInteger(value.revokedAt))) {
    throw new Error('client-connection: shared-access credential record has an invalid session')
  }
  return {
    id: value.id,
    principalId: SharedPrincipalId(value.principalId),
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    ...(value.revokedAt === undefined ? {} : { revokedAt: value.revokedAt }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!isRecord(value)) return false
  return Object.entries(value).every(([key, entry]) => key.length > 0 && isJsonValue(entry))
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function expiry(now: number, duration: number): number {
  const result = now + duration
  if (!Number.isSafeInteger(result)) throw new RangeError('shared access: expiry exceeds the safe timestamp range')
  return result
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url')
}

function trustedRequestAuthority(request: ConnectionTrustRequest, trustedHosts: readonly string[]): string | undefined {
  if (!isTrustedApiRequest(request, trustedHosts)) return undefined
  const value = header(request.headers, 'host')
  if (value === undefined) return undefined
  try {
    return new URL(`http://${value}`).host
  } catch {
    return undefined
  }
}

function signature(secret: Buffer, value: string): Buffer {
  return createHmac('sha256', secret).update(value).digest()
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined
  const decoded = Buffer.from(value, 'base64url')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

function header(
  headers: ConnectionTrustRequest['headers'],
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function cookieValue(value: string, name: string): string | undefined {
  for (const segment of value.split(';')) {
    const at = segment.indexOf('=')
    if (at !== -1 && segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim()
  }
  return undefined
}

function registerAuthority(credentials: CredentialProvider, authority: SharedAccessAuthority): void {
  const authorities = authorityInstances.get(credentials) ?? new Set<SharedAccessAuthority>()
  authorities.add(authority)
  authorityInstances.set(credentials, authorities)
}

function unregisterAuthority(credentials: CredentialProvider, authority: SharedAccessAuthority): void {
  const authorities = authorityInstances.get(credentials)
  if (authorities === undefined) return
  authorities.delete(authority)
  if (authorities.size === 0) authorityInstances.delete(credentials)
}
