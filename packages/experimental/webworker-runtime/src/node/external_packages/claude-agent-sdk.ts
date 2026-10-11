/** Claude host-profile reads and native CLI execution are unavailable in browser workers. */
import { notImplementedFail } from '../notImplementedFail.ts'

const MODULE = '@anthropic-ai/claude-agent-sdk'

/** Native Claude query startup (unavailable). */
export const query = notImplementedFail(MODULE, 'query')

/** Host Claude session discovery (unavailable). */
export const listSessions = notImplementedFail(MODULE, 'listSessions')

/** Host Claude session metadata (unavailable). */
export const getSessionInfo = notImplementedFail(MODULE, 'getSessionInfo')

/** Host Claude session history (unavailable). */
export const getSessionMessages = notImplementedFail(MODULE, 'getSessionMessages')

/** Host Claude settings discovery (unavailable). */
export const resolveSettings = notImplementedFail(MODULE, 'resolveSettings')

/** CommonJS interop marker consumed by the Worker module loader. */
export const __esModule = true

/** CommonJS-compatible namespace for default imports. */
export default { query, listSessions, getSessionInfo, getSessionMessages, resolveSettings }
