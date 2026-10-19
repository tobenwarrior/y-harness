/**
 * Last-assistant-text reader for ghost prediction (structural typing on
 * purpose: the `chat` view target is registered by the ui-chat package, and
 * importing its contract here would cycle the package dependency back on
 * itself. Shapes mirror `ChatSnapshot`, `ChatNodeStore`,
 * `ChatLocationNodeIndex`, and `AssistantBlock` without naming them).
 */

const DEFAULT_MAX_CHARS = 2000

/** Minimal text-block shape (`{ kind: 'text', text }`). */
interface TextBlockLike {
  readonly kind: string
  readonly text?: unknown
}

/** Minimal node shape: anything carrying a blocks array. */
interface BlocksNodeLike {
  readonly kind: string
  readonly data?: {
    readonly blocks?: readonly unknown[]
  } | undefined
}

/** Minimal chat-snapshot shape needed for the reader. */
export interface ChatSnapshotLike {
  readonly locations: {
    getTurn(turn: number): readonly string[]
  }
  readonly nodes: {
    get(key: string): BlocksNodeLike | undefined
  }
}

/**
 * Read the latest assistant reply text for one turn: concatenate every
 * `text` block of every blocks-carrying node in the turn, in anchor order.
 * Tool/user rows carry no blocks array and are skipped naturally.
 * @param snapshot - the `chat` target snapshot, if the target is active.
 * @param turn - the closed turn number.
 * @param maxChars - cap on returned text (oldest text wins the cut).
 * @returns trimmed text, or '' when nothing readable is present.
 */
export function readLastAssistantText(
  snapshot: ChatSnapshotLike | null | undefined,
  turn: number,
  maxChars = DEFAULT_MAX_CHARS,
): string {
  if (snapshot === null || snapshot === undefined) return ''
  let keys: readonly string[]
  try {
    keys = snapshot.locations.getTurn(turn)
  } catch {
    return ''
  }
  const parts: string[] = []
  for (const key of keys) {
    let node: BlocksNodeLike | undefined
    try {
      node = snapshot.nodes.get(key)
    } catch {
      continue
    }
    const blocks = node?.data?.blocks
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (
        typeof block === 'object'
        && block !== null
        && (block as TextBlockLike).kind === 'text'
        && typeof (block as TextBlockLike).text === 'string'
      ) {
        parts.push((block as { text: string }).text)
      }
    }
  }
  return parts.join('\n').trim().slice(0, Math.max(0, maxChars))
}
