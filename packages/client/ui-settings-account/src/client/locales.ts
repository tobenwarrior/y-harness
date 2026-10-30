/** Account settings copy, owned by the account feature. */
import { withProductDisplayName } from '@yharness/client-ui-slots'
import { onboardingEnglishCopy } from './locales/onboarding.ts'

/** English account dictionary. */
export const en = {
  modelSignInRequired: 'DeepSeek account model unavailable. Sign in or choose another model.',
  sessionExpired: 'DeepSeek session expired. Sign in again to use account models.',
  ...onboardingEnglishCopy,
  close: 'Close', addApiKey: 'Add API Key', retry: 'Sign in again',
  loginTitle: 'Sign in to DeepSeek', loginDescription: 'Sign in to use DeepSeek account models, or add an API Key in Models. Your projects and files are stored locally.',
  browserTitle: 'Waiting for sign in', browserPrompt: 'Page did not open automatically? ', copyLink: 'Copy sign-in link', copiedLink: 'Link copied', copyFailed: 'Copy failed',
  browserDescription: ', then open it in your browser to finish signing in.',
  timeoutTitle: 'Sign in timed out', timeoutDescription: 'Sign in again to continue.',
  failureTitle: 'Could not sign in',
  platformFailed: 'Could not complete the operation. Try again.', platformRetry: 'Retry',
  loading: 'Loading…', backToHarness: withProductDisplayName('Back to Y Harness'),
  settings: 'Settings', contactUs: 'Feedback', menu: 'Account menu',
  nav: 'Account', signedIn: 'Signed in to DeepSeek', signedOut: 'Not signed in',
  modelsAccountTitle: 'DeepSeek account', modelsAccountDescription: 'Optional: sign in to use DeepSeek account models.',
  signIn: 'Sign in', signOut: 'Sign out',
  signOutUnknownDescription: 'Could not check running tasks. Signing out may interrupt tasks using this account. Sign out now?',
  signOutDescription: 'Signing out will not delete any data. You can sign in to this account again.',
  signOutRunningDescription: 'Tasks are currently running. Signing out will interrupt them. Sign out now?', cancel: 'Cancel', open: 'Open browser',
  initializing: 'Starting sign in…', waiting: 'Continue in your browser',
  completing: 'Completing sign in…', expired: 'Sign in expired. Try again.',
  failed: 'Could not complete the operation. Try again.',
  noResponse: 'Something went wrong. Please check your network connection and try again.',
  settingsSignedOutTitle: 'Not signed in to DeepSeek',
  settingsSignedOutDescription: 'Sign in to use DeepSeek account models.',
  signInDescription: 'Sign in to use DeepSeek account models.',
  profileUnavailable: 'Account details are not available yet.',
  balance: 'Topped-up balance', bonusBalance: 'Granted balance', balanceUnavailable: 'View on Platform', balanceSignedOut: 'Sign in to view',
  accountInfo: 'More account information', more: 'More', usage: 'View usage', topUp: 'Top up',
  quotaTitle: 'No balance available',
  quotaDescription: withProductDisplayName('Y Harness cannot start a new task with this account when no balance is available. Would you like to top up? You can also top up later in Settings → Account.'),
  quotaTopUp: 'Top up',
  bonusNoticeTitle: 'Bonus credited',
} as const

/** Compatibility export for the retired locale name. */
export const zh = en
/** Account locale keys. */
export type AccountKey = keyof typeof en
