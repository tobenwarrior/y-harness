/** Source-labelled native discovery, readable mirrors, and explicit continuation capability states. */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Checkbox, IconLoadingOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { CodingSessionSequentialToolMode } from '@deepseek-ai/dsh-coding-session/types'
import type { CodingSessionsKey } from './locales.ts'
import type { CodingSessionsFace } from './controller.ts'
import css from './CodingSessionsSection.module.css'
function assertNever(_value: never): never { throw new Error('Unsupported native sequential tool mode.') }
function toolModeKey(mode: CodingSessionSequentialToolMode | undefined): CodingSessionsKey {
  switch (mode) {
    case 'conversation': return 'conversationMode'
    case 'project-files': return 'projectFilesMode'
    case 'project-tools': return 'projectToolsMode'
    case undefined: return 'toolModeUnknown'
    default: return assertNever(mode)
  }
}
/** Component input is derived entirely from the owning controller and locale. */
export type CodingSessionsSectionProps = InjectFace<CodingSessionsFace> & PropsLocale<'codingSessions'>
/** @param props - source query store, user actions, and localized copy. @returns a readable native session Settings page. */
export function CodingSessionsSection({
  useSessions, ensure, refreshState, discover, importSession, select, refreshMirror, continueSession,
  claimSequential, continueSequential, releaseSequential, recoverSequential, createImportDestination, reviewImportDestination,
  selectLink, importIntoSession, rollbackImport, recoverImport, abandonImport, cancelPending, t,
}: CodingSessionsSectionProps): ReactNode {
  const state = useSessions(value => value)
  const [prompt, setPrompt] = useState('')
  const [closedWriter, setClosedWriter] = useState(false)
  const [unchangedProfile, setUnchangedProfile] = useState(false)
  const [executionId, setExecutionId] = useState('')
  const [destinationId, setDestinationId] = useState('')
  const [acceptCompensation, setAcceptCompensation] = useState(false)
  const [acceptAbandon, setAcceptAbandon] = useState(false)
  const [recoveryClosedWriter, setRecoveryClosedWriter] = useState(false)
  const [recoveryStableProfile, setRecoveryStableProfile] = useState(false)
  const [acceptUnresolvedTurns, setAcceptUnresolvedTurns] = useState(false)
  useEffect(ensure, [ensure])
  const selected = state.selected
  useEffect(() => { setPrompt(''); setClosedWriter(false); setUnchangedProfile(false); setExecutionId('') }, [selected?.id, selected?.revision, selected?.handoff?.ownerToken, selected?.handoff?.phase])
  const executionSessions = state.inventory?.executionSessions?.filter(session => session.project === selected?.cwd) ?? []
  const execution = executionSessions.find(session => session.id === executionId)
  const selectedLink = state.selectedLink
  const review = state.reviewedDestination
  useEffect(() => {
    setDestinationId(selectedLink?.destinationSessionId ?? review?.destinationSessionId ?? '')
    setAcceptCompensation(false); setAcceptAbandon(false)
  }, [selected?.id, selected?.revision, selectedLink?.id, selectedLink?.revision, review?.destinationSessionId, review?.revision.digest])
  useEffect(() => {
    setRecoveryClosedWriter(false); setRecoveryStableProfile(false); setAcceptUnresolvedTurns(false)
  }, [selected?.id, selected?.revision, selected?.handoff?.ownerToken, selected?.handoff?.phase])
  const destinations = state.inventory?.importDestinations?.filter(session => !session.live && session.project === selected?.cwd) ?? []
  const destination = destinations.find(session => session.id === destinationId)
  const destinationReviewed = selected !== null && destination !== undefined && review !== null
    && review.destinationSessionId === destination.id
    && review.mirrorId === selected.id && review.mirrorRevision === selected.revision
    && review.linkId === selectedLink?.id && review.linkRevision === selectedLink?.revision
  const linkedImports = state.inventory?.linkedImportsAvailable === true && selected?.cwd !== undefined
  const links = state.inventory?.links?.filter(link => link.mirrorId === selected?.id && link.project === selected.cwd) ?? []
  const phase = selected?.handoff?.phase
  const sequentialOwned = phase === 'y-owned'
  const unresolved = phase !== undefined && phase !== 'external-ready' && phase !== 'recovered-acknowledged'
  const canClaim = selected?.sequentialAvailable === true && !unresolved
  const canRecover = state.recoverySupported && phase === 'blocked-uncertain'
    && selected?.sequentialReleaseAvailable === false && selected.handoff?.interruptedPhase !== undefined && selected.cwd !== undefined
  const unresolvedTurns = selected?.handoff === undefined ? 0
    : Math.max(0, selected.handoff.dispatchedTurnCount - new Set(selected.handoff.nativeTurnIds).size)
  const toolMode = selected?.handoff?.toolMode ?? selected?.sequentialToolMode
  return <section className={css.section}>
    <div className={css.header}><h2>{t('title')}</h2><button type="button" disabled={state.busy} onClick={refreshState}>{t('reload')}</button></div>
    <p className={css.intro}>{t('intro')}</p>
    {state.busy && <div className={css.loading}><span className={css.spinner} role="status" aria-label={t('loading')}><IconLoadingOutlineRegular size={18} /></span><button type="button" onClick={cancelPending}>{t('cancel')}</button></div>}
    {state.queryError && <div role="alert" className={css.notice}>{t('queryError')} <button type="button" disabled={state.busy} onClick={refreshState}>{t('retry')}</button></div>}
    <h3>{t('sources')}</h3>
    {(state.inventory?.sources.length ?? 0) === 0 && state.status !== 'loading' && <p>{t('emptySources')}</p>}
    {state.inventory?.sources.map(source => <div key={JSON.stringify([source.provider, source.profileId])} className={css.row}>
      <div className={css.identity}><span>{source.label}</span><span className={css.meta}>{t(source.provider)} · {t(source.connected ? 'connected' : 'disconnected')}</span></div>
      <button type="button" disabled={state.busy || !source.connected || !source.capabilities.discover} onClick={() => { discover(source) }}>{t('discover')}</button>
    </div>)}
    {state.profile !== null && <div className={css.group}>
      {state.discovered.length === 0 && <p>{t('emptyDiscovery')}</p>}
      {state.discovered.map(item => <div key={JSON.stringify(item.source)} className={css.row}>
        <div className={css.identity}>
          <span>{item.title}</span><span className={css.meta}>{t(item.source.provider)} · {t(item.writerState)}</span>
          <code>{item.source.nativeSessionId}</code>
        </div>
        <button type="button" disabled={state.busy || item.writerState === 'active'} onClick={() => { importSession(item.source) }}>{t('import')}</button>
      </div>)}
      {state.cursor !== null && <button type="button" disabled={state.busy} onClick={() => { if (state.profile !== null) discover(state.profile, true) }}>{t('more')}</button>}
    </div>}
    <h3>{t('importedSessions')}</h3>
    {(state.inventory?.mirrors.length ?? 0) === 0 && <p>{t('emptyMirrors')}</p>}
    {state.inventory?.mirrors.map(mirror => <button type="button" key={mirror.id} className={css.mirror} aria-pressed={selected?.id === mirror.id} disabled={state.busy} onClick={() => { select(mirror.id) }}>
      <span>{mirror.title}</span><span className={css.meta}>{t(mirror.source.provider)} · {t(mirror.handoff?.phase ?? (mirror.sequentialAvailable === true ? 'sequentialReady' : mirror.capabilities.continue ? 'continuable' : 'readOnly'))}</span><code>{mirror.source.nativeSessionId}</code>
    </button>)}
    {selected !== null && <section className={css.detail} aria-label={t('detail')}>
      <div className={css.header}><h3>{selected.title}</h3><button type="button" disabled={state.busy || !selected.capabilities.refresh || (unresolved && !sequentialOwned)} onClick={() => { refreshMirror(selected.id) }}>{t('refresh')}</button></div>
      <dl className={css.facts}><dt>{t('source')}</dt><dd>{t(selected.source.provider)}</dd><dt>{t('profile')}</dt><dd><code>{selected.source.profileId}</code></dd><dt>{t('project')}</dt><dd><code>{selected.cwd ?? t('projectUnknown')}</code></dd><dt>{t('nativeId')}</dt><dd><code>{selected.source.nativeSessionId}</code></dd><dt>{t('refreshedAt')}</dt><dd>{selected.refreshedAt}</dd></dl>
      {selected.status === 'conflict' && <p role="status" className={css.notice}>{t('conflict')}</p>}
      <div className={css.history}>{selected.events.map(event => <article key={event.id} className={css.event}>
        <span className={css.meta}>{t(event.role)}</span><p>{event.text}</p>
      </article>)}</div>
      {linkedImports && <div className={css.handoff}>
        <h3>{t('linkedImports')}</h3>
        <p>{t('quotedContext')}</p>
        {links.map(link => <button type="button" key={link.id} disabled={state.busy} aria-pressed={selectedLink?.id === link.id} onClick={() => { selectLink(link.id) }}>
          {t('reviewLink')} {link.destinationSessionId}
        </button>)}
        <label className={css.prompt}>{t('importDestination')}<select value={destinationId} disabled={state.busy || selectedLink !== null} onChange={(event) => { setDestinationId(event.currentTarget.value) }}>
          <option value="">{t('chooseImportDestination')}</option>
          {destinations.map(session => <option key={session.id} value={session.id}>{session.id}</option>)}
        </select></label>
        {destinations.length === 0 && <p>{t('noImportDestination')}</p>}
        {selectedLink === null && <button type="button" disabled={state.busy || selected.status !== 'ready'} onClick={() => { createImportDestination(selected.id) }}>{t('createImportDestination')}</button>}
        <button type="button" disabled={state.busy || destination === undefined} onClick={() => { if (destination !== undefined) reviewImportDestination(destination.id) }}>{t('reviewDestination')}</button>
        {destinationReviewed && <dl className={css.facts}>
          <dt>{t('destinationEventCount')}</dt><dd>{review.revision.eventCount}</dd>
          <dt>{t('destinationDigest')}</dt><dd><code>{review.revision.digest}</code></dd>
          <dt>{t('mirrorRevision')}</dt><dd>{review.mirrorRevision}</dd>
          {review.linkRevision !== undefined && <><dt>{t('linkRevision')}</dt><dd>{review.linkRevision}</dd></>}
        </dl>}
        {selectedLink !== null && <dl className={css.facts}>
          <dt>{t('linkStatus')}</dt><dd>{t(selectedLink.status === 'conflict' ? 'linkedConflict' : selectedLink.status === 'active' ? 'linkedActive' : 'linkedRolledBack')}</dd>
          <dt>{t('linkRevision')}</dt><dd>{selectedLink.revision}</dd>
          <dt>{t('importGenerationCount')}</dt><dd>{selectedLink.generations.length}</dd>
        </dl>}
        {selectedLink?.pending === undefined && <button type="button" disabled={state.busy || !destinationReviewed || selected.status !== 'ready' || selectedLink?.status === 'conflict'} onClick={() => {
          if (destination !== undefined && review !== null && destinationReviewed) importIntoSession(selected.id, {
            destinationSessionId: destination.id, expectedDestinationRevision: review.revision,
            expectedMirrorRevision: selected.revision, ...(selectedLink === null ? {} : { expectedLinkRevision: selectedLink.revision }),
          })
        }}>{t(selectedLink === null ? 'importIntoY' : 'refreshLinkedImport')}</button>}
        {selectedLink !== null && selectedLink.pending === undefined && selectedLink.generations.some(generation => generation.status === 'active') && <>
          <p>{t('compensationExplanation')}</p>
          <Checkbox checked={acceptCompensation} onChange={setAcceptCompensation} disabled={state.busy} label={t('acceptCompensation')} />
          <button type="button" disabled={state.busy || !destinationReviewed || !acceptCompensation} onClick={() => {
            if (review !== null && destinationReviewed) rollbackImport(selectedLink.id, {
              expectedLinkRevision: selectedLink.revision, expectedDestinationRevision: review.revision,
            })
          }}>{t('rollbackImport')}</button>
        </>}
        {selectedLink?.pending !== undefined && <>
          <p className={css.notice}>{t('preparedImport')}</p>
          <button type="button" disabled={state.busy} onClick={() => { recoverImport(selectedLink.id) }}>{t('recoverImport')}</button>
          <Checkbox checked={acceptAbandon} onChange={setAcceptAbandon} disabled={state.busy} label={t('acceptAbandon')} />
          <button type="button" disabled={state.busy || !destinationReviewed || !acceptAbandon} onClick={() => {
            if (review !== null && destinationReviewed) abandonImport(selectedLink.id, {
              expectedLinkRevision: selectedLink.revision, expectedDestinationRevision: review.revision,
            })
          }}>{t('abandonImport')}</button>
        </>}
      </div>}
      {!selected.capabilities.continue && selected.sequentialAvailable !== true && selected.handoff === undefined && selected.status === 'ready' && <p className={css.notice}>{t(selected.capabilities.reason === 'source-disconnected' ? 'sourceUnavailable' : 'continuationUnavailable')}</p>}
      {selected.handoff !== undefined && <div className={css.handoff} role="status">
        <span>{t(selected.handoff.phase)}</span><code>{selected.handoff.executionSessionId}</code>
        {selected.handoff.phase === 'blocked-uncertain' && <p>{t(selected.sequentialReleaseAvailable === true ? 'releaseUncertain' : 'restartUncertain')}</p>}
      </div>}
      {(selected.handoff?.recoveryHistory?.length ?? 0) > 0 && <div className={css.handoff} role="status">
        <p className={css.notice}>{t('priorOwnerUncertainty')}</p>
        {selected.handoff?.recoveryHistory?.map((checkpoint, index) =>
          <dl key={JSON.stringify([checkpoint.ownerToken, checkpoint.recoveredAt, index])} className={css.facts}>
            <dt>{t('recoveredAt')}</dt><dd>{checkpoint.recoveredAt}</dd>
            <dt>{t('previousOwner')}</dt><dd><code>{checkpoint.ownerToken}</code></dd>
            <dt>{t('interruptedPhase')}</dt><dd>{t(checkpoint.previousPhase)}</dd>
            <dt>{t('dispatchedTurnCount')}</dt><dd>{checkpoint.dispatchedTurnCount}</dd>
            <dt>{t('nativeTurnIds')}</dt><dd>{checkpoint.nativeTurnIds.length === 0 ? t('noNativeTurnReceipts') : checkpoint.nativeTurnIds.map(id => <code key={id}>{id}</code>)}</dd>
            <dt>{t('unresolvedDispatches')}</dt><dd>{checkpoint.unresolvedDispatchCount}</dd>
            <dt>{t('sourceRevision')}</dt><dd>{checkpoint.sourceRevision}</dd>
          </dl>)}
      </div>}
      {canRecover && selected.handoff !== undefined && <div className={css.handoff}>
        <p>{t('restartRecoveryExplanation')}</p>
        <dl className={css.facts}><dt>{t('previousOwner')}</dt><dd><code>{selected.handoff.ownerToken}</code></dd><dt>{t('mirrorRevision')}</dt><dd>{selected.revision}</dd><dt>{t('interruptedPhase')}</dt><dd>{t(selected.handoff.interruptedPhase ?? 'blocked-uncertain')}</dd><dt>{t('dispatchedTurnCount')}</dt><dd>{selected.handoff.dispatchedTurnCount}</dd><dt>{t('nativeTurnIds')}</dt><dd>{selected.handoff.nativeTurnIds.length === 0 ? t('noNativeTurnReceipts') : selected.handoff.nativeTurnIds.map(id => <code key={id}>{id}</code>)}</dd><dt>{t('unresolvedDispatches')}</dt><dd>{unresolvedTurns}</dd></dl>
        <Checkbox checked={recoveryClosedWriter} onChange={setRecoveryClosedWriter} disabled={state.busy} label={t('recoveryClosedWriter')} />
        <Checkbox checked={recoveryStableProfile} onChange={setRecoveryStableProfile} disabled={state.busy} label={t('recoveryStableProfile')} />
        {unresolvedTurns > 0 && <Checkbox checked={acceptUnresolvedTurns} onChange={setAcceptUnresolvedTurns} disabled={state.busy} label={t('acceptUnresolvedTurns')} />}
        <button type="button" disabled={state.busy || !recoveryClosedWriter || !recoveryStableProfile || (unresolvedTurns > 0 && !acceptUnresolvedTurns)} onClick={() => {
          if (selected.cwd !== undefined && selected.handoff !== undefined) recoverSequential(selected.id, {
            source: selected.source, project: selected.cwd, expectedRevision: selected.revision,
            expectedOwnerToken: selected.handoff.ownerToken,
            externalWritersClosed: recoveryClosedWriter, nativeProfileUnchanged: recoveryStableProfile, acceptUnresolvedTurns,
          })
        }}>{t('recoverSequential')}</button>
      </div>}
      {(selected.sequentialAvailable === true || selected.handoff !== undefined)
        && <p className={css.notice}>{t(toolModeKey(toolMode))}</p>}
      {canClaim && <div className={css.handoff}>
        <label className={css.prompt}>{t('executionSession')}<select value={executionId} disabled={state.busy} onChange={(event) => { setExecutionId(event.currentTarget.value) }}>
          <option value="">{t('chooseExecutionSession')}</option>
          {executionSessions.map(session => <option key={session.id} value={session.id}>{session.id}</option>)}
        </select></label>
        {executionSessions.length === 0 && <p>{t('noExecutionSession')}</p>}
        <Checkbox checked={closedWriter} onChange={setClosedWriter} disabled={state.busy} label={t('closedWriter')} />
        <Checkbox checked={unchangedProfile} onChange={setUnchangedProfile} disabled={state.busy} label={t('unchangedProfile')} />
        <p>{t('sequentialPrecondition')}</p>
        <button type="button" disabled={state.busy || !closedWriter || !unchangedProfile || execution === undefined || selected.cwd === undefined} onClick={() => {
          if (execution !== undefined && selected.cwd !== undefined) claimSequential(selected.id, {
            source: selected.source, project: selected.cwd, expectedRevision: selected.revision,
            executionSessionId: execution.id, externalWritersClosed: closedWriter, nativeProfileUnchanged: unchangedProfile,
          })
        }}>{t('claim')}</button>
      </div>}
      {(selected.capabilities.continue || sequentialOwned) && <label className={css.prompt}>{t('prompt')}<textarea value={prompt} disabled={state.busy} onChange={(event) => { setPrompt(event.currentTarget.value) }} /></label>}
      {selected.sequentialAvailable !== true && selected.handoff === undefined && <button type="button" disabled={state.busy || !selected.capabilities.continue || selected.status !== 'ready' || prompt.trim().length === 0} onClick={() => { continueSession(selected.id, prompt, selected.revision) }}>{t('continue')}</button>}
      {(selected.sequentialAvailable === true || selected.handoff !== undefined) && <button type="button" disabled={state.busy || !sequentialOwned || selected.status !== 'ready' || prompt.trim().length === 0} onClick={() => { continueSequential(selected.id, prompt, selected.revision) }}>{t('continueSequential')}</button>}
      {unresolved && <button type="button" disabled={state.busy || selected.sequentialReleaseAvailable !== true} onClick={() => { releaseSequential(selected.id) }}>{t('release')}</button>}
    </section>}
  </section>
}
