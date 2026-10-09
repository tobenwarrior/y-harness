/** Explicit semantic policy approval and per-version consent controls. */
import { useState, type ReactNode } from 'react'
import { Button, Checkbox, IconChevronDownOutlineRegular, Menu, MenuItemButton, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkillLibraryId, SkillLibraryItem, SkillLearningPolicyId, SkillLearningPolicyRequest } from '@deepseek-ai/dsh-skill-library/types'
import type { SkillLearningUiState } from './controller.ts'
import type { SkillLibraryPageProps } from './SkillLibraryPage.tsx'
import css from './SkillLibraryPage.module.css'

/** Deliberate policy and consent callbacks with observed metadata and provider state. */
export type SkillLearningPolicyControlsProps = Pick<SkillLibraryPageProps, 't' | 'approvePolicy' | 'setLearningAutomatic'> & {
  readonly item: SkillLibraryItem
  readonly state: SkillLearningUiState
  readonly busy: boolean
}

type Operation = SkillLearningPolicyRequest['operations'][number]
const operations: readonly Operation[] = ['update', 'compress', 'archive']
const operationKeys = { update: 'changeUpdate', compress: 'changeCompress', archive: 'changeArchive' } as const

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
 * Show policy approval separately from enabling maintenance for a skill version.
 * @param props - current metadata, learning registrations, and user-operation callbacks.
 * @returns explicit consent controls or the applicable protection hint.
 */
export function SkillLearningPolicyControls({
  item, state, busy, t, approvePolicy, setLearningAutomatic,
}: SkillLearningPolicyControlsProps): ReactNode {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [validatorId, setValidatorId] = useState<string | null>(null)
  const [allowed, setAllowed] = useState<readonly Operation[]>([])
  const [selection, setSelection] = useState<{ readonly itemId: SkillLibraryId; readonly policyId: SkillLearningPolicyId } | null>(null)
  const validators = state.providers?.validators.filter(validator => validator.trusted) ?? []
  const policies = state.providers?.policies.filter(policy => validators.some(validator => validator.id === policy.validatorId)) ?? []
  const optIn = state.providers?.optIns.find(consent => consent.id === item.id)
  const eligible = item.ownership === 'y-managed' && item.status === 'active' && !item.pinned && !item.shadowed && !item.capabilities.native && item.contentHash !== ''
  const stale = optIn?.enabled === true && optIn.contentHash !== item.contentHash
  const consentPolicy = policies.find(policy => policy.id === optIn?.policyId)
  const checked = eligible && optIn?.enabled === true && !stale && consentPolicy !== undefined
  const selectedId = selection?.itemId === item.id ? selection.policyId : optIn?.policyId
  const selectedPolicy = checked ? consentPolicy : policies.find(policy => policy.id === selectedId)
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
      {optIn?.enabled === true && !checked && <Button size="sm" variant="outline" disabled={busy} onClick={revoke}>{t('disableLearning')}</Button>}
    </div>
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
