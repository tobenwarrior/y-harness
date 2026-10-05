/** Client-safe account metadata; credentials never cross the Remote boundary. */
export interface ChatGPTConnectionView {
  accounts: Array<{ id: string; label: string; connected: boolean }>
  activeId?: string
  busy: boolean
  error?: string
}

/** Display-safe account catalog; wire efforts exclude product-only delegation modes. */
export interface ChatGPTModelView {
  id: string
  name: string
  contextWindow?: number
  reasoningEfforts?: { minimal?: string; low?: string; medium?: string; high?: string; xhigh?: string; max?: string }
  defaultReasoning?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  unavailableReasoningEfforts?: string[]
  serviceTiers?: Array<{ id: string; name: string; description: string }>
}

/** Native Codex display metadata; effort and tier IDs remain provider owned. */
export interface CodexBackendModelView {
  id: string
  name: string
  description: string
  efforts: Array<{ id: string; description: string }>
  defaultEffort?: string
  serviceTiers: Array<{ id: string; name: string; description: string }>
}
/** Separate project-local Codex profile, never tokens or login codes. */
export interface CodexBackendView {
  enabled: boolean
  connected: boolean
  busy: boolean
  running: number
  label?: string
  error?: string
  tiers: Record<string, string>
}
