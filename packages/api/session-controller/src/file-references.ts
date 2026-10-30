/** Session Controller adapter for Agent-scoped file-reference discovery. */

import type { Context } from '@yharness/cordis'
import type { Agent } from '@yharness/agent'
import type {} from '@yharness/file-reference'
import type { FileReferenceCandidate } from '@yharness/file-reference/types'
import { Remote, TypertRemoteService } from '@yharness/typert-protocol'

declare module '@yharness/cordis' {
  interface Context {
    /** Host owner of the `fileReferences` Remote namespace. */
    sessionFileReferences: SessionFileReferences
  }
}

/** Host Remote adapter over the composed file-reference provider. */
export class SessionFileReferences extends TypertRemoteService {
  static inject = ['fileReferences', 'typert']

  /** @param ctx - Host context carrying the selected file-reference provider. */
  constructor(ctx: Context) {
    super(ctx, 'sessionFileReferences', { namespace: 'fileReferences' })
  }

  /**
   * List file and directory candidates for one Agent's working directory.
   * @param agent - target Agent resolved from the Session identity on the wire.
   * @param query - path text following `@` or `@"`.
   * @param signal - caller cancellation.
   * @returns deterministic path-only candidates from the composed provider.
   */
  @Remote
  list(
    agent: Agent,
    query: string,
    signal: AbortSignal,
  ): Promise<FileReferenceCandidate[]> {
    return this.ctx.fileReferences.list(agent, query, signal)
  }
}

export default SessionFileReferences
