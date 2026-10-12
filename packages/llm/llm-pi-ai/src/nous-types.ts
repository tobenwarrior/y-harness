/** Client-safe Nous connection and model metadata. OAuth grants remain on the Host. */
export interface NousConnectionView {
  /** Whether the user has selected a public Nous device-flow client ID. */
  configured: boolean
  connected: boolean
  busy: boolean
  error?: string
  expiresAt?: number
}

/** The device instructions the user may open and enter in the browser. */
export interface NousDeviceVerification {
  url: string
  code: string
  expiresAt: number
}

/** An account-visible catalog entry, with only advertised capabilities. */
export interface NousModelView {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: Array<'text' | 'image'>
  reasoning: boolean
  reasoningMandatory?: boolean
  reasoningEfforts?: {
    off?: string
    minimal?: string
    low?: string
    medium?: string
    high?: string
    xhigh?: string
    max?: string
  }
}
