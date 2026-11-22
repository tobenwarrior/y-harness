/** Account Remote values contain no credential payloads. */
import type { Branded } from '@yharness/brand'

export type { AccountBonusBatch, AccountBonusNotification, AccountBonusOrderId, AccountClientMetadata, AccountDetails, AccountProfile, AccountUserId, AccountView, SignInAttemptId } from '@yharness/deepseek-account/types'

/** Opaque identity of one GitHub App device authorization attempt. */
export type GitHubAppSignInAttemptId = Branded<'GitHubAppSignInAttemptId'>

/** Host-owned view of a GitHub App device authorization attempt. */
export type GitHubAppSignInAttempt =
  | { readonly id: GitHubAppSignInAttemptId; readonly phase: 'starting' }
  | { readonly id: GitHubAppSignInAttemptId; readonly phase: 'waiting'; readonly url: string; readonly code: string }
  | { readonly id: GitHubAppSignInAttemptId; readonly phase: 'succeeded' }
  | { readonly id: GitHubAppSignInAttemptId; readonly phase: 'cancelled' }
  | { readonly id: GitHubAppSignInAttemptId; readonly phase: 'failed' }

/** Redacted GitHub App sign-in state exposed to the owner UI. */
export interface GitHubAppSignInView {
  /** Whether the optional GitHub App capability is installed and authenticated. */
  readonly status: 'unavailable' | 'needs-auth' | 'connected'
  /** The latest local device-flow attempt, without credential material. */
  readonly attempt: GitHubAppSignInAttempt | null
}
