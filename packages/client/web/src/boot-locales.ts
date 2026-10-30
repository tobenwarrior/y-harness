/** Kernel-owned text remains available while locale plugins are replacing. */
export interface BootMessages {
  /** Status while the client roster is activating. */
  readonly loading: string
  /** Heading for an activation failure report. */
  readonly failed: string
  /** Label for the page-local recovery action. */
  readonly retry: string
}

const en: BootMessages = {
  loading: 'Loading plugins…',
  failed: 'Failed to load plugins',
  retry: 'Retry',
}

/**
 * Resolve kernel boot text while locale plugins are unavailable.
 *
 * The document argument remains part of this helper's contract so existing
 * callers can continue to pass the persisted document locale. The kernel has
 * one built-in fallback; locale plugins still own the fully loaded UI.
 * @param document - owning document.
 * @returns English kernel text.
 */
export function bootMessages(document: Document): BootMessages {
  void document
  return en
}
