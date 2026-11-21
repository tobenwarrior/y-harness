/** Read a bounded reply from a private VPS worker over its Unix socket. */

import type { Socket } from 'node:net'

interface VpsSocketReplyOptions {
  readonly path: string
  readonly maxBytes: number
  readonly timeoutMs: number
  readonly request?: Buffer
  readonly connect: (options: { readonly path: string }) => Socket
  readonly errors: {
    readonly aborted: string
    readonly timedOut: string
    readonly unavailable: string
    readonly invalid: string
  }
  readonly safeFailure: (error: unknown) => Error
}

/**
 * Read one reply through EOF, destroying the connection on completion or failure.
 * @param options - Trusted socket, response bounds, and public error messages. Omit request for a read-only worker.
 * @param signal - Cancellation from the admitted caller.
 * @returns The nonempty response chunks within the limit.
 */
export async function readVpsSocketReply(options: VpsSocketReplyOptions, signal: AbortSignal): Promise<readonly Buffer[]> {
  const { errors } = options
  if (signal.aborted) throw new Error(errors.aborted)
  return await new Promise<readonly Buffer[]>((resolve, reject) => {
    let socket: Socket | undefined
    let settled = false
    let bytes = 0
    const chunks: Buffer[] = []
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      signal.removeEventListener('abort', onAbort)
      socket?.destroy()
      if (error === undefined) resolve(chunks)
      else reject(error)
    }
    const onAbort = (): void => { finish(new Error(errors.aborted)) }
    const onClose = (): void => { finish(new Error(errors.unavailable)) }
    const deadline = setTimeout(() => { finish(new Error(errors.timedOut)) }, options.timeoutMs)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const connection = options.connect({ path: options.path })
      socket = connection
      const request = options.request
      if (request !== undefined) connection.once('connect', () => { connection.end(request) })
      connection.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength
        if (bytes > options.maxBytes) finish(new Error(errors.invalid))
        else chunks.push(chunk)
      })
      connection.once('end', () => {
        if (bytes === 0) onClose()
        else finish()
      })
      connection.once('close', onClose)
      connection.once('error', (error) => { finish(options.safeFailure(error)) })
    } catch (error) {
      finish(options.safeFailure(error))
    }
  })
}
