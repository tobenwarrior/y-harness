/** Client-safe xAI connection and model metadata. OAuth grants remain on the Host. */
export interface XaiConnectionView {
  /** Whether the bundled xAI device flow is available. Always true; kept for symmetry with sibling cards. */
  configured: boolean
  /** Whether a stored xAI OAuth grant is present. */
  connected: boolean
  /** Whether a sign-in attempt is running. */
  busy: boolean
  /** Last sanitized failure, when one exists. */
  error?: string
  /** Grant expiry, when a grant is stored. */
  expiresAt?: number
}

/** The device instructions the user opens and enters in the browser. */
export interface XaiDeviceVerification {
  /** Browser URL the user opens to approve sign-in. */
  url: string
  /** Code the user enters on the verification page. */
  code: string
  /** When the device code expires, as epoch milliseconds. */
  expiresAt: number
}

/** One catalog model the xAI route serves, with only advertised capabilities. */
export interface XaiModelView {
  /** Model id sent to the provider. */
  id: string
  /** Display name for selectors. */
  name: string
  /** Maximum combined request and response context in tokens. */
  contextWindow?: number
  /** Maximum output tokens. */
  maxTokens?: number
  /** Request modalities the model accepts. */
  inputModalities?: Array<'text' | 'image'>
  /** Whether the model reasons. */
  reasoning: boolean
  /** Selectable reasoning efforts and their wire spellings. */
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
