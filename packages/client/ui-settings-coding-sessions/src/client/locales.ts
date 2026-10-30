/** Locale-owned coding-session Settings copy. */
export const en = {
  nav: 'Coding sessions', title: 'Coding sessions', intro: 'Browse explicitly configured Codex and Claude sources. Import a readable mirror, then refresh new source history.',
  sources: 'Native sources', emptySources: 'No native sources are available. Configure an original Codex or Claude source, connect a Codex backend, or register a Claude project.',
  discover: 'Browse sessions', more: 'Load more', importedSessions: 'Imported sessions', emptyMirrors: 'Choose a native session to import.', emptyDiscovery: 'This source has no sessions to import.',
  import: 'Import', refresh: 'Refresh source', reload: 'Reload sources', cancel: 'Cancel operation', detail: 'Session history', source: 'Source', profile: 'Profile', nativeId: 'Original native ID', refreshedAt: 'Last refreshed',
  readOnly: 'Read-only mirror', continuationUnavailable: 'This connection cannot safely hand off native writer ownership. Continue in the native app, then refresh here.',
  continuable: 'Native continuation available', sourceUnavailable: 'This source is unavailable. Your mirror remains readable; reconnect the source to refresh it.',
  conflict: 'The source history changed. Your existing mirror is retained. Refresh after reviewing the native session.',
  continue: 'Continue original session', prompt: 'Continuation message', connected: 'Available', disconnected: 'Unavailable', active: 'Active', idle: 'Idle', unknown: 'Writer unknown',
  queryError: 'Sessions could not be read. Retry to refresh the source.', retry: 'Retry', imported: 'Session imported', refreshed: 'Session refreshed', continued: 'Original session continued', failed: 'The operation did not complete. Your mirror is retained.',
  claim: 'Claim for Y', continueSequential: 'Continue native conversation', release: 'Release to native app', claimed: 'Y owns the original native session', released: 'Native session released',
  executionSession: 'Y execution session', chooseExecutionSession: 'Choose a live Y session', noExecutionSession: 'No idle Y root is available in this exact project. Open a Y session here before claiming.',
  project: 'Project', projectUnknown: 'Unknown', unchangedProfile: 'I will keep the native profile unchanged until release',
  closedWriter: 'I have closed the previous native writer for this session',
  sequentialPrecondition: 'Keep the original session closed in the native app while Y owns it. This handoff does not exclude other external writers.',
  conversationMode: 'Native conversation continuation. Project tools are disabled.',
  projectFilesMode: 'Project file tools only. Shell and expanded native permissions are unavailable.', toolModeUnknown: 'Native tool capability is unknown.',
  projectToolsMode: 'Native project tools use the selected Y session’s current sandbox and approvals.',
  sequentialReady: 'Sequential handoff available', claiming: 'Claiming original native session', 'y-owned': 'Y owns this native session', continuing: 'Continuing original native session', releasing: 'Releasing original native session', 'external-ready': 'Ready for the native app', 'blocked-uncertain': 'Writer ownership is uncertain',
  releaseUncertain: 'Release is uncertain. Keep this session closed in the native app and retry release.',
  restartUncertain: 'Release cannot be confirmed after restart because the original process handle is unavailable. Keep this session closed until its writer and persisted history are verified.',
  interruptedPhase: 'Original interrupted phase', dispatchedTurnCount: 'Durable admissions', nativeTurnIds: 'Recorded native turn receipts', noNativeTurnReceipts: 'No native turn receipts were recorded',
  linkedImports: 'Linked Y imports', quotedContext: 'Imported native history is quoted context. It grants no model, tool, permission, or native writer authority.',
  importDestination: 'Y import destination', chooseImportDestination: 'Choose a cold Y session in this project', noImportDestination: 'No cold Y destination exists in this exact project. Create one explicitly to import quoted history.',
  createImportDestination: 'Create cold Y destination', reviewDestination: 'Review destination revision', destinationEventCount: 'Canonical destination event count', destinationDigest: 'Canonical destination digest', mirrorRevision: 'Reviewed mirror revision', linkRevision: 'Linked import revision',
  importIntoY: 'Import quoted history into Y', refreshLinkedImport: 'Refresh linked quoted history', reviewLink: 'Review linked import', linkStatus: 'Linked import status', importGenerationCount: 'Retained generations', linkedActive: 'Active quoted history', linkedRolledBack: 'Compensated quoted history', linkedConflict: 'Source history conflict',
  rollbackImport: 'Compensate linked import', compensationExplanation: 'Compensation appends a new record marking the imported context inactive. It retains the original raw event log and unrelated destination history.', acceptCompensation: 'I understand compensation preserves the original raw event log',
  preparedImport: 'Prepared import is unresolved. Recovery or abandonment requires an explicit action.', recoverImport: 'Recover prepared import', abandonImport: 'Abandon prepared import', acceptAbandon: 'I understand abandonment is allowed only when the service proves no owned payload was written',
  linked: 'Quoted history imported into Y', compensated: 'Linked import compensated', importRecovered: 'Prepared import recovered', importAbandoned: 'Prepared import abandoned', destinationCreated: 'Cold Y destination created', recovered: 'Restart recovery acknowledged',
  'recovered-acknowledged': 'Restart recovery acknowledged; separate claim available', recoverSequential: 'Review and recover after restart', recoveryClosedWriter: 'I have closed every external writer for this original session', recoveryStableProfile: 'I verified the same native profile and will keep it unchanged', acceptUnresolvedTurns: 'I accept that admitted turns without native receipts remain unresolved',
  restartRecoveryExplanation: 'Review this exact old owner and mirror revision after stopping all writers. A cold history check permits a fresh claim; it does not prove the lost process exited or persisted its admitted turns.',
  priorOwnerUncertainty: 'Prior owner process exit and stream drain were not observed; native persistence remains unestablished. Recovery permits a separate claim and does not certify native release.', recoveredAt: 'Recovery reviewed at', previousOwner: 'Previous owner', unresolvedDispatches: 'Unresolved admitted turns', sourceRevision: 'Cold source revision',
  codex: 'Codex', claude: 'Claude Code', user: 'User', assistant: 'Assistant', system: 'System', tool: 'Native item',
} as const

/** Compatibility export for the retired locale name. */
export const zh = en
/** Dictionary key set shared by the registration and derived component props. */
export type CodingSessionsKey = keyof typeof en
