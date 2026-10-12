/** Durable suggestions with explicit evidence and review decisions. */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Checkbox, DiffBlock, IconChevronDownOutlineRegular, IconLoadingOutlineRegular, IconSkillOutlineRegular, Menu, MenuItemButton, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillLearningEvidence, SkillLearningEvidenceId, SkillLearningProposal, SkillLearningProposalId, SkillLibraryId, SkillLibraryList } from '@deepseek-ai/dsh-skill-library/types'
import type { SkillLibraryPageProps } from './SkillLibraryPage.tsx'
import type { SkillLearningUiState } from './controller.ts'
import css from './SkillLibraryPage.module.css'

/** Typed metadata, navigation and deliberate review callbacks. */
export type SkillReviewsProps = Pick<SkillLibraryPageProps, 't' | 'loadReview' | 'validateReview' | 'approveReview' | 'rejectReview' | 'proposeLearning' | 'refreshLearning'> & {
  readonly state: SkillLearningUiState
  readonly inventory: SkillLibraryList | null
  readonly selectedId: SkillLearningProposalId | null
  readonly selectReview: (id: SkillLearningProposalId) => void
  readonly openSkill: (id: SkillLibraryId) => void
  readonly project: string
  readonly query: string
  readonly busy: boolean
}
type Translate = SkillReviewsProps['t']
const stateKey = { review: 'reviewPending', validated: 'validated', applying: 'applying', applied: 'applied', blocked: 'proposalBlocked', rejected: 'rejected' } as const
const kindKey = { create: 'changeCreate', update: 'changeUpdate', compress: 'changeCompress', archive: 'changeArchive' } as const

function Choice<Value extends string>({ label, value, options, onChange, disabled = false }: {
  readonly label: string
  readonly value: Value
  readonly options: readonly { readonly value: Value; readonly label: string }[]
  readonly onChange: (value: Value) => void
  readonly disabled?: boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  return <Menu open={open} onClose={() => { setOpen(false) }} portal autoFocus anchor={<Button variant="outline" size="sm" aria-label={label} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => { setOpen(value => !value) }}>{options.find(option => option.value === value)?.label ?? label}<IconChevronDownOutlineRegular size={12} /></Button>}>
    {options.map(option => <MenuItemButton key={option.value} onSelect={() => { setOpen(false); onChange(option.value) }}>
      {option.label}
    </MenuItemButton>)}
  </Menu>
}

function EvidenceCard({ evidence, t }: { readonly evidence: SkillLearningEvidence; readonly t: Translate }): ReactNode {
  return <section className={css.evidenceCard}>
    <div className={css.sectionHeading}><h4>{evidence.task}</h4><Tag tone={evidence.checks.length === 0 ? 'warning' : 'quiet'}>{evidence.checks.length === 0 ? t('unverified') : t('checksRecorded', { count: evidence.checks.length })}</Tag></div>
    <dl className={css.metadata}><dt>{t('evidenceSession')}</dt><dd className={css.path}>{evidence.sessionId}</dd><dt>{t('completedWork')}</dt><dd>{t(evidence.completed ? 'taskCompleted' : 'taskIncomplete')}</dd></dl>
    <h5>{t('observations')}</h5><ul className={css.references}>{evidence.observations.map((observation, index) => <li key={index}>{observation}</li>)}</ul>
    <h5>{t('sourceChecks')}</h5>{evidence.checks.length === 0 ? <p className={css.secondary}>{t('noChecks')}</p> : evidence.checks.map((check, index) => <div key={index} className={css.sourceCheck}>
      <Tag tone={check.result === 'passed' ? 'success' : check.result === 'failed' ? 'warning' : 'quiet'}>{t(check.result === 'passed' ? 'checkPassed' : check.result === 'failed' ? 'checkFailed' : 'checkUnknown')}</Tag>
      <span>{check.summary}</span><span className={css.path}>{check.eventRef}</span>
    </div>)}
    <details className={css.evidenceReferences}><summary>{t('eventReferences')}</summary><ul className={css.references}>{evidence.eventRefs.map((reference, index) => <li key={index} className={css.path}>{reference}</li>)}</ul></details>
  </section>
}

function canApply(proposal: SkillLearningProposal, inventory: SkillLibraryList | null): boolean {
  if (inventory === null || proposal.changes.length === 0) return false
  return proposal.changes.every((change) => {
    if (change.kind === 'create') return inventory.projects.some(project => project.id === proposal.projectId)
    const item = inventory.items.find(item => item.id === change.id)
    if (item === undefined || item.ownership !== 'y-managed' || item.pinned || item.shadowed || item.capabilities.native || item.status !== 'active' || item.contentHash !== change.expectedHash) return false
    if (change.kind === 'archive' && change.survivorId !== undefined) {
      const survivor = inventory.items.find(item => item.id === change.survivorId)
      return survivor !== undefined && survivor.status === 'active' && survivor.contentHash === change.survivorHash
    }
    return true
  })
}

function ReviewDetail({ proposal, props }: { readonly proposal: SkillLearningProposal; readonly props: SkillReviewsProps }): ReactNode {
  const { t, busy, inventory, approveReview, rejectReview, validateReview, state, openSkill } = props
  const reviewable = proposal.state === 'review' || proposal.state === 'validated'
  const sourcesAllowed = canApply(proposal, inventory)
  const validation = proposal.validation
  const labels = { codeLabel: t('diff'), wrapLabel: t('wrap'), unwrapLabel: t('unwrap'), copy: t('copy'), copied: t('copied'), collapseAria: t('collapse'), collapse: t('collapse'), expandAria: (count: number) => t('expand', { count }), expand: (count: number) => t('expand', { count }) }
  const checks = ['constraintsPreserved', 'resourcesPreserved', 'referenceImpactChecked', 'survivorEquivalent'] as const
  return <aside className={clsx(css.detail, css.reviewDetail)} aria-label={t('review')}>
    <div className={css.sectionHeading}><h2 className={css.reviewTitle}>{t(proposal.operation)}</h2><Tag tone={proposal.state === 'applied' ? 'success' : 'quiet'}>{t(stateKey[proposal.state])}</Tag></div>
    <dl className={css.metadata}><dt>{t('project')}</dt><dd>{inventory?.projects.find(project => project.id === proposal.projectId)?.title ?? proposal.projectId}</dd><dt>{t('generator')}</dt><dd>{proposal.generator}</dd><dt>{t('proposalIdentity')}</dt><dd className={css.path}>{proposal.id}</dd><dt>{t('proposalDigest')}</dt><dd className={css.path}>{proposal.digest}</dd></dl>
    {reviewable && <><div className={css.actionRow}><Button variant="primary" size="sm" disabled={busy || !sourcesAllowed} onClick={() => { approveReview(proposal.id) }}>{t('approveReview')}</Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => { rejectReview(proposal.id) }}>{t('rejectReview')}</Button>
      <Button size="sm" disabled={busy || (state.providers?.validators.length ?? 0) === 0} onClick={() => { validateReview(proposal.id) }}>{t('validateReview')}</Button></div><p className={css.secondary}>{t('reviewApprovalHint')}</p>
    {!sourcesAllowed && <p className={css.note}>{t('reviewSourceBlocked')}</p>}</>}
    {proposal.state === 'applying' && <><Button variant="primary" size="sm" disabled={busy} onClick={() => { approveReview(proposal.id) }}>{t('resumeApplication')}</Button><p className={css.secondary}>{t('resumeApplicationHint')}</p></>}
    {proposal.state === 'blocked' && <Button size="sm" disabled={busy} onClick={() => { rejectReview(proposal.id) }}>{t('rejectReview')}</Button>}
    {(proposal.uncertainty.length > 0 || proposal.findings.length > 0) && <section className={css.detailSection}>
      {proposal.uncertainty.length > 0 && <><h3>{t('uncertainty')}</h3><ul className={css.references}>{proposal.uncertainty.map((value, index) => <li key={index}>{value}</li>)}</ul></>}
      {proposal.findings.length > 0 && <><h3>{t('findings')}</h3><ul className={css.references}>{proposal.findings.map((value, index) => <li key={index}>{value}</li>)}</ul></>}
    </section>}
    <section className={css.detailSection}><h3>{t('validation')}</h3>{validation === undefined ? <><Tag tone="warning">{t('unverified')}</Tag><p className={css.secondary}>{t('validationUnknown')}</p></> : <>
      <div className={css.badges}><Tag tone={validation.trusted ? 'info' : 'quiet'}>{t(validation.trusted ? 'validatorTrusted' : 'validatorUntrusted')}</Tag><Tag tone={validation.independent ? 'info' : 'warning'}>{t(validation.independent ? 'independent' : 'notIndependent')}</Tag></div>
      <p>{validation.validatorId} · <time dateTime={validation.checkedAt}>{validation.checkedAt}</time></p>
      <dl className={css.metadata}>{checks.map(key => <div className={css.validationRow} key={key}><dt>{t(key)}</dt><dd>{t(validation[key] ? 'checkPassed' : 'checkFailed')}</dd></div>)}</dl>
      {validation.findings.length > 0 && <ul className={css.references}>
        {validation.findings.map((value, index) => <li key={index}>{value}</li>)}
      </ul>}
      {validation.digest !== proposal.digest && <p className={css.note}>{t('validationDigestMismatch')}</p>}
      {validation.receipt === undefined ? <p className={css.secondary}>{t('validationReceiptMissing')}</p> : <details className={css.evidenceReferences}><summary>{t('validationReceipt')}</summary><p className={css.path}>{validation.receipt.digest}</p>
        <dl className={css.metadata}><dt>{t('sourceVersion')}</dt><dd className={css.path}>{validation.receipt.sourceHashes.join('\n')}</dd><dt>{t('resources')}</dt><dd className={css.path}>{validation.receipt.resourceHashes.join('\n')}</dd><dt>{t('reviewEvidence')}</dt><dd className={css.path}>{validation.receipt.evidenceIds.join('\n')}</dd></dl>
        <ul className={css.references}>
          {validation.receipt.eventRefs.map((value, index) => <li key={index} className={css.path}>{value}</li>)}
        </ul></details>}
    </>}</section>
    <section className={css.detailSection}><h3>{t('reviewEvidence')}</h3>{proposal.evidence.map(evidence => <EvidenceCard key={evidence.id} evidence={evidence} t={t} />)}</section>
    {proposal.changes.map((change, index) => <section key={`${change.path}:${index}`} className={css.detailSection}>
      <div className={css.sectionHeading}><h3>{change.name}</h3><Tag tone="quiet">{t(kindKey[change.kind])}</Tag></div><p>{change.description}</p>
      <p className={css.path}>{change.path}</p>{change.kind !== 'create' && <p className={css.path}>{t('sourceVersion')} · {change.expectedHash}</p>}
      {change.kind === 'archive' && <><p className={css.note}>{t('archiveProposalHint')}</p>{change.survivorId !== undefined && <p className={css.path}>{t('survivor')} · {change.survivorId}</p>}</>}
      <DiffBlock diffs={[{ path: change.path, oldText: change.before, newText: change.after }]} labels={labels} maxLines={24} />
      {change.constraints.length > 0 && <><h4>{t('constraints')}</h4><ul className={css.references}>{change.constraints.map((value, index) => <li key={index}>{value}</li>)}</ul></>}
      {change.resources.length > 0 && <><h4>{t('resources')}</h4><ul className={css.references}>{change.resources.map(resource => <li key={resource.path}><span>{resource.path}</span> · <span className={css.path}>{resource.hash}</span> · {t('bytes', { count: resource.bytes })}</li>)}</ul></>}
      {change.references.length > 0 && <><h4>{t('references')}</h4><ul className={css.references}>{change.references.map((value, index) => <li key={index}>{value}</li>)}</ul></>}
      {change.kind === 'archive' && change.survivorId !== undefined && <section role="region" aria-label={t('survivorSnapshot')} className={css.detailSection}>
        <h4>{t('survivorSnapshot')}</h4><p className={css.secondary}>{t('survivorSnapshotHint')}</p>
        <dl className={css.metadata}><dt>{t('survivor')}</dt><dd className={css.path}>{change.survivorId}</dd><dt>{t('sourceVersion')}</dt><dd className={css.path}>{change.survivorHash ?? t('checkUnknown')}</dd><dt>{t('resourceBundleHash')}</dt><dd className={css.path}>{change.survivorResourceHash ?? t('checkUnknown')}</dd></dl>
        {change.survivorContent === undefined ? <p className={css.note}>{t('survivorSnapshotUnavailable')}</p> : <pre className={css.instructions}>{change.survivorContent}</pre>}
        <h4>{t('resources')}</h4>{change.survivorResources === undefined ? <p className={css.secondary}>{t('survivorSnapshotUnavailable')}</p> : change.survivorResources.length === 0 ? <p className={css.secondary}>{t('noResources')}</p> : <ul className={css.references}>{change.survivorResources.map(resource => <li key={resource.path}><span>{resource.path}</span> · <span className={css.path}>{resource.hash}</span> · {t('bytes', { count: resource.bytes })}</li>)}</ul>}
        <h4>{t('references')}</h4>{change.survivorReferences === undefined ? <p className={css.secondary}>{t('survivorSnapshotUnavailable')}</p> : change.survivorReferences.length === 0 ? <p className={css.secondary}>{t('noReferences')}</p> : <ul className={css.references}>{change.survivorReferences.map((reference, index) => <li key={index}>{reference}</li>)}</ul>}
      </section>}
    </section>)}
    {(proposal.state === 'applied' || proposal.appliedIds.length > 0) && <section className={css.detailSection}><h3>{t('history')}</h3><p className={css.note}>{t('reviewHistoryHint')}</p><div className={css.actionRow}>{proposal.appliedIds.map(id => <Button key={id} variant="outline" size="sm" onClick={() => { openSkill(id) }}>{t('openSkill', { name: inventory?.items.find(item => item.id === id)?.name ?? id })}</Button>)}</div></section>}
  </aside>
}

function ProposeDialog({ props, open, close }: {
  readonly props: SkillReviewsProps
  readonly open: boolean
  readonly close: () => void
}): ReactNode {
  const { t, inventory, state, busy, proposeLearning } = props
  const projects = inventory?.projects ?? []
  const [project, setProject] = useState('')
  const [operation, setOperation] = useState<SkillLearningProposal['operation']>('learn')
  const [selectedEvidence, setEvidence] = useState<readonly SkillLearningEvidenceId[]>([])
  const [targets, setTargets] = useState<readonly SkillLibraryId[]>([])
  useEffect(() => { if (open) { setProject(projects.some(project => project.id === props.project) ? props.project : projects[0]?.id ?? ''); setEvidence([]); setTargets([]); setOperation('learn') } }, [open])
  const evidence = state.evidence.filter(evidence => evidence.projectId === project && evidence.completed && evidence.substantial)
  const candidates = inventory?.items.filter(item => item.status === 'active' && !item.shadowed && !item.capabilities.native && item.contentHash !== '' && (operation === 'deduplicate' || item.ownership === 'y-managed' && !item.pinned) && (item.scope === 'shared' || item.projectIds.includes(project))) ?? []
  const unavailable = state.providers?.availability.find(route => route.projectId === project)?.state === 'unavailable'
  const generate = (): void => {
    proposeLearning({ projectId: project, operation, evidenceIds: selectedEvidence, targetIds: targets })
    close()
  }
  return <Modal open={open} title={t('proposeTitle')} description={t('proposeDescription')} closeLabel={t('close')} onClose={close} className={clsx(css.cleanupDialog)} footer={<><Button disabled={busy} onClick={close}>{t('cancel')}</Button><Button variant="primary" disabled={busy || project === '' || selectedEvidence.length === 0 || unavailable || (state.providers?.generators.length ?? 0) === 0 || operation === 'compress' && targets.length === 0 || operation === 'deduplicate' && targets.length < 2} onClick={generate}>{t('generateProposal')}</Button></>}>
    <div className={css.actionRow}><Choice label={t('project')} value={project} options={projects.map(project => ({ value: project.id, label: project.title }))} onChange={(value) => { setProject(value); setEvidence([]); setTargets([]) }} />
      <Choice<SkillLearningProposal['operation']> label={t('proposalOperation')} value={operation} options={(['learn', 'compress', 'deduplicate'] as const).map(value => ({ value, label: t(value) }))} onChange={(value) => { setOperation(value); setTargets([]) }} /></div>
    {unavailable && <p className={css.note}>{t('learningUnavailable')}</p>}
    <section className={css.detailSection}><h3>{t('completedWork')}</h3>{evidence.length === 0 ? <p className={css.secondary}>{t('noEvidence')}</p> : evidence.map(item => <div key={item.id} className={css.evidenceChoice}>
      <Checkbox label={item.task} checked={selectedEvidence.includes(item.id)} onChange={(enabled) => {
        setEvidence(values => enabled ? [...values, item.id] : values.filter(id => id !== item.id))
      }} />
      <p className={css.secondary}>{item.observations[0]}</p><Tag tone={item.checks.length === 0 ? 'warning' : 'quiet'}>{item.checks.length === 0 ? t('unverified') : t('checksRecorded', { count: item.checks.length })}</Tag>
    </div>)}</section>
    <section className={css.detailSection}><h3>{t('proposalTargets')}</h3><p className={css.secondary}>{t(operation === 'learn' ? 'optionalTargets' : operation === 'deduplicate' ? 'deduplicateTargets' : 'compressionTargets')}</p>
      {candidates.map(item => <div key={item.id} className={css.evidenceChoice}>
        <Checkbox label={item.name} checked={targets.includes(item.id)} onChange={(enabled) => {
          setTargets(values => enabled ? [...values, item.id] : values.filter(id => id !== item.id))
        }} />
        {operation === 'deduplicate' && (item.ownership !== 'y-managed' || item.pinned) && <Tag tone="quiet">{t('survivorOnly')}</Tag>}</div>)}
    </section>
  </Modal>
}

/**
 * Render durable suggestions and deliberate evidence-backed review actions.
 * @param props - authoritative review data and explicit callbacks.
 * @returns a metadata list with lazy proposal review and evidence selection.
 */
export function SkillReviews(props: SkillReviewsProps): ReactNode {
  const { t, state, inventory, project, query, selectedId, selectReview, loadReview, refreshLearning, busy } = props
  const [proposeOpen, setProposeOpen] = useState(false)
  const [filter, setFilter] = useState<'all' | 'pending' | 'history'>('all')
  const reviews = useMemo(() => state.reviews.filter((review) => {
    if (project !== 'all' && review.projectId !== project) return false
    const pending = review.state === 'review' || review.state === 'validated' || review.state === 'blocked' || review.state === 'applying'
    if (filter === 'pending' && !pending || filter === 'history' && pending) return false
    const title = inventory?.projects.find(project => project.id === review.projectId)?.title ?? review.projectId
    return [review.id, title, review.generator, t(review.operation), t(stateKey[review.state])].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  }), [state.reviews, inventory, project, query, filter, t])
  const detail = state.detail?.id === selectedId ? state.detail : null
  return <>
    <div id="skill-library-view-review-panel" role="tabpanel" aria-labelledby="skill-library-view-review" aria-busy={busy} className={css.content}>
      <section className={css.inventory}><div className={css.reviewToolbar}><p className={css.secondary}>{t('reviewIntro')}</p><Button variant="outline" size="sm" disabled={busy || (state.providers?.generators.length ?? 0) === 0 || state.evidence.filter(evidence => evidence.completed && evidence.substantial).length === 0} onClick={() => { setProposeOpen(true) }}>{t('proposeLearning')}</Button></div>
        {(state.providers?.generators.length ?? 0) === 0 && state.status === 'ready' && <p className={css.note}>{t('generatorUnavailable')}</p>}
        <Choice<'all' | 'pending' | 'history'> label={t('status')} value={filter} options={[{ value: 'all', label: t('allStatuses') }, { value: 'pending', label: t('reviewPending') }, { value: 'history', label: t('history') }]} onChange={setFilter} />
        {state.error && <div className={css.queryNotice}><span>{t('loadError')}</span><Button size="sm" onClick={refreshLearning}>{t('retry')}</Button></div>}
        {state.status === 'loading' ? <span className={css.spinner} role="status" aria-label={t('loading')}><IconLoadingOutlineRegular size={18} /></span> : reviews.length === 0 ? <div className={css.empty}><IconSkillOutlineRegular size={28} /><p>{t('noReviews')}</p></div> : <div className={css.reviewList}>{reviews.map(review => <button key={review.id} type="button" className={clsx(css.skillRow, selectedId === review.id && css.selectedRow)} aria-label={t('openProposal', { id: review.id })} aria-pressed={selectedId === review.id} onClick={() => { selectReview(review.id); loadReview(review.id) }}>
          <span className={css.rowBody}><span className={css.rowTitle}>{t(review.operation)} · {inventory?.projects.find(project => project.id === review.projectId)?.title ?? review.projectId}</span><span className={css.badges}><Tag tone={review.state === 'applied' ? 'success' : 'quiet'}>{t(stateKey[review.state])}</Tag><Tag tone="quiet">{t('changesCount', { count: review.changeCount })}</Tag></span><span className={css.rowUsage}>{review.generator} · {review.createdAt}</span><span className={css.rowUsage}>{t('byteChange', { before: review.beforeBytes, after: review.afterBytes })}</span>{review.uncertainty.length > 0 && <span className={css.rowDescription}>{review.uncertainty[0]}</span>}</span>
        </button>)}</div>}
      </section>
      {state.detailStatus === 'loading' && selectedId !== null ? <aside className={css.detail}><span className={css.spinner} role="status" aria-label={t('loading')}><IconLoadingOutlineRegular size={18} /></span></aside>
        : state.detailStatus === 'error' && selectedId !== null ? <aside className={css.detail}><p className={css.note}>{t('detailError')}</p><Button size="sm" onClick={() => { loadReview(selectedId) }}>{t('retry')}</Button></aside>
          : detail !== null ? <ReviewDetail proposal={detail} props={props} /> : <aside className={css.detailEmpty}><IconSkillOutlineRegular size={30} /><h2>{t('selectReview')}</h2><p>{t('selectReviewHint')}</p></aside>}
    </div>
    <ProposeDialog props={props} open={proposeOpen} close={() => { setProposeOpen(false) }} />
  </>
}
