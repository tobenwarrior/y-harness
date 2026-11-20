/** Selected-Session polling for Bot approval metadata. */

/** Selection and cleanup controls for one approval card. */
export interface BotRequestPoller {
  readonly select: (sessionId: string | undefined, running: boolean) => void
  readonly dispose: () => void
}

/**
 * Read the current Session immediately and repeat while requested. Selection
 * changes and disposal cancel the active read and discard stale results.
 * @param fetcher - metadata reader with cancellation.
 * @param onResult - callback for results from the current selection.
 * @param intervalMs - time between a completed read and the next poll.
 * @returns selection and disposal controls.
 */
export function createBotRequestPoller<Request>(
  fetcher: (sessionId: string, signal: AbortSignal) => Promise<Request | null>,
  onResult: (sessionId: string, request: Request | null) => void,
  intervalMs = 2_000,
): BotRequestPoller {
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let requestController: AbortController | undefined
  let disposed = false

  const cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    requestController?.abort()
    requestController = undefined
  }

  const select = (sessionId: string | undefined, running: boolean): void => {
    cancel()
    const currentGeneration = ++generation
    if (disposed || sessionId === undefined) return

    const read = async (): Promise<void> => {
      const controller = new AbortController()
      requestController = controller
      try {
        const request = await fetcher(sessionId, controller.signal)
        if (currentGeneration !== generation) return
        onResult(sessionId, request)
      } catch {
        // A failed read leaves the last validated request visible.
        return
      } finally {
        if (requestController === controller) requestController = undefined
        if (currentGeneration === generation && running) {
          timer = setTimeout(() => { void read() }, intervalMs)
        }
      }
    }
    void read()
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    ++generation
    cancel()
  }

  return { select, dispose }
}
