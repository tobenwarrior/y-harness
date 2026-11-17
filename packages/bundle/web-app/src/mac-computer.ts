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

/** Message transport used by the Desktop Host to reach the Electron process. */
export interface MacComputerTransport {
  readonly connected: boolean
  readonly send?: (message: object, callback: (error: Error | null) => void) => void
  on(event: 'message', listener: (message: unknown) => void): void
  off(event: 'message', listener: (message: unknown) => void): void
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** Bridge model calls to the desktop process that owns the current sharing grant. */
export class MacComputerBridge {
  private nextId = 0
  private readonly pending = new Map<number, PendingRequest>()
  private disposed = false
  private readonly transport: MacComputerTransport

  constructor(transport: MacComputerTransport = process) {
    this.transport = transport
    this.transport.on('message', this.receive)
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
    if (this.disposed || !this.transport.connected || this.transport.send === undefined) throw new Error('Mac Computer is unavailable.')
    const send = this.transport.send.bind(this.transport)
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const settle = (): void => {
        this.pending.delete(id)
        signal.removeEventListener('abort', abort)
        clearTimeout(timeout)
      }
      const abort = (): void => {
        settle()
        reject(asError(signal.reason))
      }
      const timeout = setTimeout(() => {
        settle()
        reject(new Error('Mac Computer did not respond.'))
      }, REQUEST_TIMEOUT_MS)
      timeout.unref()
      this.pending.set(id, {
        resolve: (value) => { settle(); resolve(value) },
        reject: (error) => { settle(); reject(error) },
      })
      signal.addEventListener('abort', abort, { once: true })
      try {
        send({ type: 'mac-computer-request', id, request: { sessionId, action } }, (error) => {
          if (error !== null) {
            settle()
            reject(new Error('Mac Computer is unavailable.'))
          }
        })
      } catch (error: unknown) {
        settle()
        reject(asError(error))
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
      || value.jpeg.length > 8_000_000
      || !('width' in value) || typeof value.width !== 'number' || !Number.isSafeInteger(value.width) || value.width < 1
      || !('height' in value) || typeof value.height !== 'number' || !Number.isSafeInteger(value.height) || value.height < 1) {
      throw new Error('Mac Computer returned an invalid screenshot.')
    }
    return { jpeg: value.jpeg, width: value.width, height: value.height }
  }

  /** Remove the native reply listener and reject outstanding requests. */
  dispose(): void {
    this.disposed = true
    this.transport.off('message', this.receive)
    for (const pending of this.pending.values()) pending.reject(new Error('Mac Computer is unavailable.'))
  }
}
