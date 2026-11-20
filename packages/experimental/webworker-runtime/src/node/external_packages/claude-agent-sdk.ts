/** The browser preview can load native Claude plugins, whose operations require a Node host. */
import { notImplementedFail } from '../notImplementedFail.ts'

const MODULE = '@anthropic-ai/claude-agent-sdk'

/** Launch a native Claude query (requires a Node host). */
export const query = notImplementedFail(MODULE, 'query')

/** Enumerate local Claude sessions (requires a Node host). */
export const listSessions = notImplementedFail(MODULE, 'listSessions')

/** Read metadata for a local Claude session (requires a Node host). */
export const getSessionInfo = notImplementedFail(MODULE, 'getSessionInfo')

/** Read messages for a local Claude session (requires a Node host). */
export const getSessionMessages = notImplementedFail(MODULE, 'getSessionMessages')

/** Preserve named imports when the packed worker lowers SDK imports. */
export const __esModule = true

/** Claude SDK operations available to the worker module loader. */
export default { query, listSessions, getSessionInfo, getSessionMessages }
