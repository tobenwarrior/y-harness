/** Private IPC between the Desktop Host and the Electron main process. */

interface MacFrame {
  readonly jpeg: string
  readonly width: number
  readonly height: number
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
}

const REQUEST_TIMEOUT_MS = 6_000

/** Bridge model calls to the desktop process that owns the current sharing grant. */
export class MacComputerBridge {
  private nextId = 0
  private readonly pending = new Map<number, PendingRequest>()
  private disposed = false

  constructor() {
    process.on('message', this.receive)
  }

  private receive = (message: unknown): void => {
    if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'mac-computer-response'
      || !('id' in message) || typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (pending === undefined) return
    if ('error' in message && typeof message.error === 'string') pending.reject(new Error(message.error))
    else pending.resolve('value' in message ? message.value : undefined)
  }

  /**
   * Run one Bot action through the native authorization check.
   * @param sessionId - the invoking Agent's Session ID.
   * @param action - decoded tool arguments with a kind discriminant.
   * @param signal - upstream cancellation.
   * @returns the native operation's reply, if any.
   */
  request(sessionId: string, action: object, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    if (this.disposed || !process.connected || process.send === undefined) throw new Error('Mac Computer is unavailable.')
    const send = process.send.bind(process)
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const settle = (): boolean => {
        if (!this.pending.delete(id)) return false
        signal.removeEventListener('abort', abort)
        clearTimeout(timeout)
        return true
      }
      const abort = (): void => {
        if (settle()) reject(signal.reason)
      }
      const timeout = setTimeout(() => {
        if (settle()) reject(new Error('Mac Computer did not respond.'))
      }, REQUEST_TIMEOUT_MS)
      timeout.unref()
      this.pending.set(id, {
        resolve: (value) => { if (settle()) resolve(value) },
        reject: (error) => { if (settle()) reject(error) },
      })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) {
        abort()
        return
      }
      try {
        send({ type: 'mac-computer-request', id, request: { sessionId, action } }, (error) => {
          if (error !== null && settle()) reject(new Error('Mac Computer is unavailable.'))
        })
      } catch (error: unknown) {
        if (settle()) reject(error)
      }
    })
  }

  /**
   * Read one frame through the native authorization check.
   * @param sessionId - the invoking Agent's Session ID.
   * @param signal - upstream cancellation.
   * @returns the JPEG and the display's input dimensions.
   */
  async observe(sessionId: string, signal: AbortSignal): Promise<MacFrame> {
    const value = await this.request(sessionId, { kind: 'observe' }, signal)
    if (typeof value !== 'object' || value === null || !('jpeg' in value) || typeof value.jpeg !== 'string'
      || value.jpeg.length > 8_000_000 || !('width' in value) || !Number.isSafeInteger(value.width)
      || !('height' in value) || !Number.isSafeInteger(value.height)
      || typeof value.width !== 'number' || value.width < 1 || typeof value.height !== 'number' || value.height < 1) {
      throw new Error('Mac Computer returned an invalid screenshot.')
    }
    return { jpeg: value.jpeg, width: value.width, height: value.height }
  }

  /** Remove the native reply listener and reject outstanding requests. */
  dispose(): void {
    this.disposed = true
    process.off('message', this.receive)
    for (const pending of this.pending.values()) pending.reject(new Error('Mac Computer is unavailable.'))
  }
}
