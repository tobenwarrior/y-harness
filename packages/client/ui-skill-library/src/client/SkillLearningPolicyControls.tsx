/** Explicit semantic policy approval and per-version consent controls. */
import { useState, type ReactNode } from 'react'
import { Button, Checkbox, IconChevronDownOutlineRegular, Menu, MenuItemButton, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillLibraryId, SkillLibraryItem, SkillLibraryProject, SkillLearningPolicyId,
  SkillLearningPolicyRequest } from '@deepseek-ai/dsh-skill-library/types'
import type { SkillLearningUiState } from './controller.ts'
import type { SkillLibraryPageProps } from './SkillLibraryPage.tsx'
import css from './SkillLibraryPage.module.css'

/** Deliberate policy and consent callbacks with observed metadata and provider state. */
export type SkillLearningPolicyControlsProps = Pick<SkillLibraryPageProps,
   't' | 'approvePolicy' | 'revokePolicy' | 'setLearningAutomatic' | 'cleanupSemantic'> & {
     readonly item: SkillLibraryItem
     readonly state: SkillLearningUiState
     readonly busy: boolean
   }

/** Project creation consent can be approved before any skill exists. */
export type SkillProjectLearningControlsProps = Pick<SkillLibraryPageProps, 't' | 'approvePolicy' | 'revokePolicy'> & {
  readonly projects: readonly SkillLibraryProject[]
  readonly selectedProjectId: string
  readonly state: SkillLearningUiState
  readonly busy: boolean
}

type Operation = SkillLearningPolicyRequest['operations'][number]
const operations: readonly Operation[] = ['update', 'compress', 'archive']
const operationKeys = { create: 'changeCreate', update: 'changeUpdate', compress: 'changeCompress', archive: 'changeArchive' } as const

function ChoiceMenu<Value extends string>({ label, selected, options, disabled, onSelect }: {
  readonly label: string
  readonly selected: string
  readonly options: readonly { readonly id: Value; readonly label: string }[]
  readonly disabled: boolean
  readonly onSelect: (value: Value) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  return <Menu open={open && !disabled} portal autoFocus onClose={() => { setOpen(false) }}
    anchor={<Button size="sm" variant="outline" disabled={disabled} aria-label={label} aria-haspopup="menu"
      aria-expanded={open && !disabled} onClick={() => { setOpen(value => !value) }}>
      {selected}<IconChevronDownOutlineRegular size={12} />
    </Button>}>
    {options.map(option => <MenuItemButton key={option.id} onSelect={() => { setOpen(false); onSelect(option.id) }}>
      {option.label}
    </MenuItemButton>)}
  </Menu>
}

/**
 * Request explicit project approval for unverified native work observations.
 * @param props - known projects, Host policy registrations, and approval callbacks.
 * @returns the project learning opener and a separately consented approval dialog.
 */
export function SkillProjectLearningControls({ projects, selectedProjectId, state, busy, t,
  approvePolicy, revokePolicy }: SkillProjectLearningControlsProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [selection, setSelection] = useState<{ readonly projectId: string; readonly allowed: boolean } | null>(null)
  const project = projects.find(candidate => candidate.id === selection?.projectId)
  const nativeAvailable = state.providers?.validators.some(
    validator => validator.id === 'native-observation-validator' && validator.trusted) === true
    && state.providers.generators.includes('native-observation')
  const nativePolicy = project === undefined ? undefined : state.providers?.policies.find(policy => policy.enabled !== false
    && policy.projectId === project.id && policy.generatorId === 'native-observation'
      && policy.validatorId === 'native-observation-validator'
    && policy.operations.includes('create') && policy.operations.includes('update'))
  const projectAllowed = nativePolicy !== undefined || selection?.allowed === true
  const canApprove = project !== undefined && nativeAvailable && projectAllowed && nativePolicy === undefined && !busy
  const openDialog = (): void => {
    setSelection({ projectId: projects.some(candidate => candidate.id === selectedProjectId) ? selectedProjectId : '', allowed: false })
    setOpen(true)
  }
  const approve = (): void => {
    if (!canApprove) return
    approvePolicy({ validatorId: 'native-observation-validator', generatorId: 'native-observation',
      projectId: project.id, operations: ['create', 'update'] })
    setOpen(false)
  }
  return <>
    <Button size="sm" variant="outline" disabled={busy || projects.length === 0} onClick={openDialog}>{t('projectLearning')}</Button>
    <Modal open={open} title={t('projectLearning')} description={t('nativeProjectApprovalHint')} closeLabel={t('close')}
      onClose={() => { setOpen(false) }} footer={<>
        <Button disabled={busy} onClick={() => { setOpen(false) }}>{t('cancel')}</Button>
        <Button variant="primary" disabled={!canApprove} onClick={approve}>{t('approveProjectLearning')}</Button>
      </>}>
      <ChoiceMenu label={t('learningProject')} selected={project?.title ?? t('chooseLearningProject')}
        options={projects.map(candidate => ({ id: candidate.id, label: candidate.title }))} disabled={busy || projects.length === 0}
        onSelect={(projectId) => { setSelection({ projectId, allowed: false }) }} />
      <div className={css.detailSection}>
        <Checkbox label={t('nativeProjectConsent')} checked={projectAllowed}
          disabled={busy || project === undefined || !nativeAvailable || nativePolicy !== undefined}
          onChange={(allowed) => { if (project !== undefined) setSelection({ projectId: project.id, allowed }) }} />
        {nativePolicy !== undefined && <Button size="sm" variant="outline" disabled={busy} onClick={
          () => { revokePolicy(nativePolicy.id) }}>{t('revokeProjectLearning')}</Button>}
      </div>
      {!nativeAvailable && <p className={css.secondary}>{t('nativeProjectUnavailable')}</p>}
    </Modal>
  </>
}

/**
 * Show policy approval separately from enabling maintenance for a skill version.
 * @param props - current metadata, learning registrations, and user-operation callbacks.
 * @returns explicit consent controls or the applicable protection hint.
 */
export function SkillLearningPolicyControls({
  item, state, busy, t, approvePolicy, revokePolicy, setLearningAutomatic, cleanupSemantic,
}: SkillLearningPolicyControlsProps): ReactNode {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [validatorId, setValidatorId] = useState<string | null>(null)
  const [allowed, setAllowed] = useState<readonly Operation[]>([])
  const [selection, setSelection] = useState<{ readonly itemId: SkillLibraryId; readonly policyId: SkillLearningPolicyId } | null>(null)
  const validators = state.providers?.validators.filter(validator => validator.trusted) ?? []
  const policies = state.providers?.policies.filter(policy => policy.enabled !== false
    && validators.some(validator => validator.id === policy.validatorId)) ?? []
  const optIn = state.providers?.optIns.find(consent => consent.id === item.id)
  const eligible = item.ownership === 'y-managed' && item.status === 'active' && !item.pinned
    && !item.shadowed && !item.capabilities.native && item.contentHash !== ''
  const stale = optIn?.enabled === true && optIn.contentHash !== item.contentHash
  const consentPolicy = policies.find(policy => policy.id === optIn?.policyId)
  const checked = eligible && optIn?.enabled === true && !stale && consentPolicy !== undefined
  const cleanupAuthorized = checked && consentPolicy.validatorId === 'instruction-redundancy-validator'
    && (consentPolicy.generatorId === undefined || consentPolicy.generatorId === 'instruction-redundancy')
    && (consentPolicy.projectId === undefined || item.scope === 'shared' || item.projectIds.includes(consentPolicy.projectId))
    && consentPolicy.operations.some(operation => operation === 'compress' || operation === 'archive')
  const canCleanup = cleanupAuthorized && !busy
  const selectedId = selection?.itemId === item.id ? selection.policyId : optIn?.policyId
  const selectedPolicy = checked ? consentPolicy : policies.find(policy => policy.id === selectedId)
  const revocablePolicy = state.providers?.policies.find(policy => policy.enabled !== false && policy.id === selectedId)
  const canApprove = eligible && validators.some(validator => validator.id === validatorId) && allowed.length > 0 && !busy
  const policyLabel = (policy: typeof policies[number]): string => t('policySummary', {
    validator: policy.validatorId, operations: policy.operations.map(operation => t(operationKeys[operation])).join(', '),
  })
  const revoke = (): void => {
    if (!busy && optIn?.enabled === true) setLearningAutomatic(item, optIn.policyId, false)
  }
  const openApproval = (): void => {
    setValidatorId(null); setAllowed([]); setDialogOpen(true)
  }
  const submit = (): void => {
    if (!canApprove || validatorId === null) return
    approvePolicy({ validatorId, operations: allowed })
    setDialogOpen(false)
  }
  const runCleanup = (force: boolean): void => {
    if (!canCleanup) return
    const projectId = item.projectIds[0]
    cleanupSemantic({ ...projectId === undefined ? {} : { projectId }, ids: [item.id], force })
  }
  return <section className={css.detailSection}>
    <div className={css.sectionHeading}>
      <h3>{t('semanticMaintenance')}</h3>
      {eligible && <Switch label={t('automaticLearning')} checked={checked} disabled={busy || !checked && selectedPolicy === undefined}
        onChange={(enabled) => {
          if (!enabled) revoke()
          else if (!busy && selectedPolicy !== undefined) setLearningAutomatic(item, selectedPolicy.id, true)
        }} />}
    </div>
    <p className={css.secondary}>{t('semanticExtensionStatus')}</p>
    <p className={css.secondary}>{t('semanticHint')}</p>
    {item.scope === 'shared' && <p className={css.secondary}>{t('sharedPolicyHint')}</p>}
    {!eligible && <p className={css.note}>{t(item.capabilities.native ? 'nativeLearningUnavailable' : 'semanticProtected')}</p>}
    {eligible && validators.length === 0 && <p className={css.note}>{t('validatorUnavailable')}</p>}
    {stale && <p className={css.note}>{t('consentStale')}</p>}
    <div className={css.actionRow}>
      {eligible && <>
        <ChoiceMenu label={t('policy')} selected={selectedPolicy === undefined ? t('noPolicy') : policyLabel(selectedPolicy)}
          options={policies.map(policy => ({ id: policy.id, label: policyLabel(policy) }))}
          disabled={busy || checked || policies.length === 0}
          onSelect={(policyId) => { setSelection({ itemId: item.id, policyId }) }} />
        <Button size="sm" variant="outline" disabled={busy || validators.length === 0} onClick={openApproval}>{t('approvePolicy')}</Button>
      </>}
      {revocablePolicy !== undefined && <Button size="sm" variant="outline" disabled={busy}
        onClick={() => { revokePolicy(revocablePolicy.id) }}>{t('revokePolicy')}</Button>}
      {optIn?.enabled === true && !checked && <Button size="sm" variant="outline" disabled={busy}
        onClick={revoke}>{t('disableLearning')}</Button>}
    </div>
    <div className={css.actionRow}>
      <Button size="sm" variant="outline" disabled={!canCleanup} onClick={() => { runCleanup(false) }}>{t('cleanupSelected')}</Button>
      <Button size="sm" variant="outline" disabled={!canCleanup} onClick={() => { runCleanup(true) }}>{t('forceCleanup')}</Button>
    </div>
    <p className={css.secondary}>{t(cleanupAuthorized ? 'forceCleanupHint' : 'semanticCleanupUnavailable')}</p>
    <Modal open={dialogOpen && eligible} title={t('policyTitle')} description={t('policyDescription')} closeLabel={t('close')}
      onClose={() => { setDialogOpen(false) }} footer={<>
        <Button onClick={() => { setDialogOpen(false) }}>{t('cancel')}</Button>
        <Button variant="primary" disabled={!canApprove} onClick={submit}>{t('createPolicy')}</Button>
      </>}>
      <ChoiceMenu label={t('validator')} selected={validatorId ?? t('validator')}
        options={validators.map(validator => ({ id: validator.id, label: validator.id }))}
        disabled={busy || validators.length === 0} onSelect={setValidatorId} />
      {validators.length === 0 && <p className={css.note}>{t('validatorUnavailable')}</p>}
      <section className={css.detailSection}>
        <h3>{t('operations')}</h3>
        <div className={css.actionRow}>{operations.map(operation => <Checkbox key={operation} label={t(operationKeys[operation])}
          checked={allowed.includes(operation)} disabled={busy} onChange={(enabled) => {
            setAllowed(current => operations.filter(candidate => candidate === operation ? enabled : current.includes(candidate)))
          }} />)}</div>
      </section>
    </Modal>
  </section>
}
