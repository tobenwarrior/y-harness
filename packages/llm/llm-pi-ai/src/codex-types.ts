/** Native Codex display metadata; effort, tier, and modality IDs remain provider owned. */
export interface CodexBackendModelView {
  id: string
  name: string
  description: string
  efforts: Array<{ id: string; description: string }>
  defaultEffort?: string
  serviceTiers: Array<{ id: string; name: string; description: string }>
  defaultServiceTier?: string
  /** Modalities the native catalog advertises; audio is dropped because the LLM seam cannot express it. */
  inputModalities: Array<'text' | 'image'>
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
