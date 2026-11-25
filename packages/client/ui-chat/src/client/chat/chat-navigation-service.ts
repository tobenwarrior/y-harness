import type { SessionId, SessionSeq } from '@yharness/session/types'

/** One exact transcript location requested by an owner outside the Chat view. */
export interface ChatNavigationRequest {
  /** Session whose transcript owns the target. */
  readonly sessionId: SessionId
  /** Event sequence to reveal after loading the required history. */
  readonly seq: SessionSeq
}

type Listener = (seq: SessionSeq) => void

interface Registration {
  readonly listener: Listener
  active: boolean
}

interface QueuedDelivery {
  readonly registration: Registration
  seq: SessionSeq
}

/**
 * Delivers exact-session transcript targets across the Chat mount boundary.
 *
 * A request made before its Bot Chat mounts is retained once for that Session;
 * a mounted Chat receives it immediately. The Chat owns cancellation of the
 * actual viewport work when it is replaced or unmounted.
 */
export class ChatNavigationService {
  private readonly listeners = new Map<SessionId, Set<Registration>>()
  private readonly pending = new Map<SessionId, SessionSeq>()
  private readonly queued = new Map<SessionId, QueuedDelivery>()

  /**
   * Request an exact event in one Session's Chat.
   * @param request - Session identity and event sequence to reveal.
   */
  request(request: ChatNavigationRequest): void {
    const queued = this.queued.get(request.sessionId)
    if (queued !== undefined) {
      queued.seq = request.seq
      return
    }
    const listeners = this.listeners.get(request.sessionId)
    if (listeners === undefined || listeners.size === 0) {
      this.pending.set(request.sessionId, request.seq)
      return
    }
    for (const registration of [...listeners]) {
      if (registration.active) registration.listener(request.seq)
    }
  }

  /**
   * Cancel a target that was queued before its Chat mounted.
   * @param sessionId - Session whose pending target should be discarded.
   */
  cancel(sessionId: SessionId): void {
    this.pending.delete(sessionId)
    this.queued.delete(sessionId)
  }

  /**
   * Register the mounted Chat for one Session.
   * @param sessionId - Session addressed by the Chat view.
   * @param listener - exact-sequence navigation callback.
   * @returns disposer for the Chat's mount lifetime.
   */
  register(sessionId: SessionId, listener: Listener): () => void {
    const registration: Registration = { listener, active: true }
    let listeners = this.listeners.get(sessionId)
    if (listeners === undefined) {
      listeners = new Set()
      this.listeners.set(sessionId, listeners)
    }
    listeners.add(registration)
    const pending = this.pending.get(sessionId)
    if (pending !== undefined) {
      this.pending.delete(sessionId)
      const delivery: QueuedDelivery = { registration, seq: pending }
      this.queued.set(sessionId, delivery)
      queueMicrotask(() => {
        if (this.queued.get(sessionId) !== delivery) return
        this.queued.delete(sessionId)
        if (registration.active && this.listeners.get(sessionId)?.has(registration)) listener(delivery.seq)
      })
    }
    return () => {
      if (!registration.active) return
      registration.active = false
      const queued = this.queued.get(sessionId)
      if (queued?.registration === registration) {
        this.queued.delete(sessionId)
        this.pending.set(sessionId, queued.seq)
      }
      listeners.delete(registration)
      if (listeners.size === 0) this.listeners.delete(sessionId)
    }
  }

  /** Release queued targets and mounted listeners during plugin teardown. */
  dispose(): void {
    this.pending.clear()
    this.queued.clear()
    for (const listeners of this.listeners.values()) {
      for (const registration of listeners) registration.active = false
      listeners.clear()
    }
    this.listeners.clear()
  }
}
