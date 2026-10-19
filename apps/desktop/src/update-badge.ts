/**
 * Persistent update affordance for the top-right chrome (clean-room behavior
 * spec: ChatGPT desktop's dot-badged update indicator).
 *
 * The harness already owns the updater state machine
 * (`idle → checking → available → downloading → verifying → installing →
 * ready`, plus `unavailable`/`error`) and projects it through
 * `presentDesktopUpdate`. What it does NOT have is a standing surface: an
 * update is announced only by a modal and OS attention (dock bounce) once it
 * is already downloaded. Until then the user cannot tell that an update
 * exists, is downloading, or failed.
 *
 * The reference keeps a small dot-badged control in the chrome for exactly
 * this. This module derives that control from the EXISTING presentation, so no
 * second state machine exists and the badge can never disagree with the dialog.
 */
import type { DesktopUpdatePresentation } from './ipc.ts'

/** Visual weight of the chrome affordance. */
export type UpdateBadgeTone =
  /** Nothing to show; the control stays out of the chrome. */
  | 'none'
  /** Something waits on the user (an update is available or ready). */
  | 'attention'
  /** Work is underway; show progress. */
  | 'progress'
  /** A failure the user asked about, or one they can act on. */
  | 'problem'
  /** Updates do not apply to this build; explained rather than hidden. */
  | 'not-applicable'

/** What a click does; every action is owned by the main-process flow. */
export type UpdateBadgeAction =
  | 'none'
  /** Open the existing update dialog/confirmation. */
  | 'open-update'
  /** Re-run a failed check or download. */
  | 'retry'

/** The chrome affordance for one update state. */
export interface UpdateBadge {
  /** Whether the control occupies chrome space at all. */
  readonly visible: boolean
  readonly tone: UpdateBadgeTone
  /**
   * Whether the icon carries the reference's dot badge. The dot marks "state
   * changed, act when you're ready" and clears once the user engages, so it is
   * true only for states the user has not yet seen or acted on.
   */
  readonly dot: boolean
  /** Short label for tooltip and accessible name; never raw diagnostics. */
  readonly label: string
  readonly action: UpdateBadgeAction
  /** Download progress, when the updater reports it. */
  readonly percent?: number | undefined
  /** Target version, when known. */
  readonly version?: string | undefined
}

/**
 * How this build receives updates. A development build runs from the
 * workspace source, so there is nothing for an updater to install: updating it
 * means pulling and rebuilding, not downloading a release artifact.
 */
export type BuildFlavor =
  /** Bundled app with an update feed: the updater is meaningful. */
  | 'packaged'
  /** Development bundle: no update channel exists, by design. */
  | 'development'
  /** Could not be determined; behavior stays conservative (no false promises). */
  | 'unknown'

/** Inputs that identify the running build without guessing. */
export interface BuildFlavorEvidence {
  /** Electron's `app.isPackaged`. */
  readonly isPackaged: boolean
  /** Whether the bundle ships an update feed (`app-update.yml`). */
  readonly updateConfigPresent: boolean
  /** Bundle identifier; a `.dev.`/`.staging.` segment marks a non-release build. */
  readonly bundleId?: string | undefined
}

/**
 * Derive the build flavor from evidence rather than assumption.
 *
 * A bundle can be a real `.app` and still receive no updates: an Electron
 * development bundle has no update feed, and a `.dev.`/`.staging.` identifier
 * marks it as non-release. Requiring BOTH `isPackaged` and a present feed
 * prevents promising updates this build cannot perform.
 *
 * @param evidence - packaging, feed, and identifier facts.
 * @returns the flavor, or 'unknown' when the evidence is contradictory.
 */
export function deriveBuildFlavor(evidence: BuildFlavorEvidence): BuildFlavor {
  const identifier = evidence.bundleId ?? ''
  const nonReleaseId = /\.(?:dev|development|staging|test)\./u.test(identifier)
  if (nonReleaseId) return 'development'
  if (evidence.isPackaged && evidence.updateConfigPresent) return 'packaged'
  if (!evidence.isPackaged) return 'development'
  // Packaged but no feed: not a flavor we can describe as update-capable.
  return 'unknown'
}

/** Caller context the state alone does not carry. */
export interface UpdateBadgeContext {
  /**
   * How this build receives updates. Omitted means 'unknown' (no flavor
   * claims), which keeps the badge silent rather than promising an update.
   */
  readonly flavor?: BuildFlavor | undefined
  /**
   * Whether the user opened the update surface or the check ran silently in
   * the background. A background check that fails must not nag with a badge.
   */
  readonly userInitiated?: boolean | undefined
  /** Versions whose badge dot the user already dismissed this session. */
  readonly acknowledgedVersions?: readonly string[] | undefined
}

/**
 * Derive the chrome affordance for the current updater presentation.
 *
 * Phase coverage (mirrors the reference's discipline of never showing a
 * control that cannot act):
 * - `idle`, `unavailable` → hidden: no update channel or nothing known yet.
 * - `checking` → hidden: a silent background check is not user-facing news.
 * - `available`, `ready` → attention, dot, opens the update flow.
 * - `downloading`, `verifying`, `installing` → progress with percent when known.
 * - `error` → problem, but ONLY for a user-initiated attempt; otherwise hidden.
 *
 * Flavor overrides all of it: a development build reports that updates come
 * from the checkout, because silence would read as a defect.
 *
 * @param state - the existing updater presentation.
 * @param context - user-initiation and acknowledgement facts.
 * @returns the badge the chrome renders.
 */
export function presentUpdateBadge(
  state: DesktopUpdatePresentation,
  context: UpdateBadgeContext = {},
): UpdateBadge {
  const version = state.version

  // A build with no update channel must SAY so rather than render nothing:
  // an invisible affordance reads as a bug ("why is there no update button?").
  // The reference's discipline is to explain a surface it cannot offer.
  if (context.flavor === 'development') {
    return {
      visible: true,
      tone: 'not-applicable',
      dot: false,
      label: 'Development build — updates come from your checkout',
      action: 'none',
      ...version === undefined ? {} : { version },
    }
  }
  const acknowledged = version !== undefined
    && (context.acknowledgedVersions?.includes(version) ?? false)

  switch (state.phase) {
    case 'idle':
    case 'unavailable':
    case 'checking':
      return hidden()

    case 'available':
      return {
        visible: true,
        tone: 'attention',
        dot: !acknowledged,
        label: version === undefined ? 'Update available' : `Update available: ${version}`,
        action: 'open-update',
        ...version === undefined ? {} : { version },
      }

    case 'ready':
      return {
        visible: true,
        tone: 'attention',
        // A downloaded update is the strongest signal in the reference; the dot
        // persists until the user engages because installing is destructively
        // deferred (it can stop running tasks).
        dot: true,
        label: version === undefined ? 'Update ready to install' : `Restart to update to ${version}`,
        action: 'open-update',
        ...version === undefined ? {} : { version },
      }

    case 'downloading': {
      // Floor once, so the field and the label can never disagree.
      const percent = state.percent === undefined ? undefined : Math.floor(state.percent)
      return {
        visible: true,
        tone: 'progress',
        dot: false,
        label: percent === undefined ? 'Downloading update' : `Downloading update: ${String(percent)}%`,
        action: 'open-update',
        ...percent === undefined ? {} : { percent },
        ...version === undefined ? {} : { version },
      }
    }

    case 'verifying':
      return {
        visible: true,
        tone: 'progress',
        dot: false,
        label: 'Verifying update',
        action: 'open-update',
        ...version === undefined ? {} : { version },
      }

    case 'installing':
      return {
        visible: true,
        tone: 'progress',
        dot: false,
        label: 'Installing update',
        action: 'open-update',
        ...version === undefined ? {} : { version },
      }

    case 'error':
      // A silent background check that fails stays silent: the user never
      // asked, and a persistent problem badge would be noise they cannot act
      // on. A failure of something they started is theirs to resolve.
      if (context.userInitiated !== true) return hidden()
      return {
        visible: true,
        tone: 'problem',
        dot: false,
        // `failure` is the classified kind the main process projects; a check
        // failure retries the check, everything else reopens the download flow.
        label: isCheckFailure(state.failure) ? 'Update check failed' : 'Update failed',
        action: 'retry',
        ...version === undefined ? {} : { version },
      }
  }
}

/**
 * Whether a classified failure came from the update check (as opposed to a
 * download or install). The projected presentation carries the kind, not the
 * raw operation.
 */
function isCheckFailure(failure: DesktopUpdatePresentation['failure']): boolean {
  return failure === 'check' || failure === 'check-network'
}

/** The shared "nothing to render" value. */
function hidden(): UpdateBadge {
  return { visible: false, tone: 'none', dot: false, label: '', action: 'none' }
}

/**
 * Whether the badge should steal attention beyond its own chrome presence.
 * The reference keeps this rare: only a finished download justifies pulling the
 * user (which the existing OS attention already does). Everything else waits.
 * @param badge - the derived badge.
 */
export function updateBadgeDemandsAttention(badge: UpdateBadge): boolean {
  return badge.visible && badge.tone === 'attention' && badge.dot
}
