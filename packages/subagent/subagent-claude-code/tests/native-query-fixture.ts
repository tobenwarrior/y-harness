/** Exact SDK query interface for synthetic external frame generators. */
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'

export function scriptedQuery(frames: AsyncGenerator<SDKMessage, void>, close: () => void): Query {
  const unsupported = async (): Promise<never> => { throw new Error('Unused fixture SDK control') }
  return Object.assign(frames, {
    interrupt: unsupported,
    setPermissionMode: unsupported,
    setMcpPermissionModeOverride: unsupported,
    setModel: unsupported,
    setMaxThinkingTokens: unsupported,
    applyFlagSettings: unsupported,
    updateSettings: unsupported,
    initializationResult: unsupported,
    reinitialize: unsupported,
    supportedCommands: unsupported,
    supportedModels: unsupported,
    supportedAgents: unsupported,
    mcpServerStatus: unsupported,
    getContextUsage: unsupported,
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: unsupported,
    readFile: unsupported,
    reloadPlugins: unsupported,
    reloadSkills: unsupported,
    reloadOutputStyles: unsupported,
    accountInfo: unsupported,
    rewindFiles: unsupported,
    seedReadState: unsupported,
    reconnectMcpServer: unsupported,
    toggleMcpServer: unsupported,
    setMcpServers: unsupported,
    streamInput: unsupported,
    stopTask: unsupported,
    backgroundTasks: unsupported,
    close,
  })
}
