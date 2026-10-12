/**
 * Searchable selection of a connected Nous account's models. The catalog can
 * hold hundreds of entries, so the dialog — not the settings card — owns the
 * long list: a search box, an enabled-only filter, and one collapsible-by-scroll
 * section per vendor. Saving commits the whole selection in one settings write.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Checkbox, Input, Modal, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { NousModelView } from '@deepseek-ai/dsh-api-remotes/client'
import { countCopy, groupModels, modelLabel } from './nous-models.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/**
 * Render the account-catalog picker.
 * @param props.models - the connected account's advertised models.
 * @param props.selected - model ids currently enabled for this account.
 * @param props.onSave - commits the selection; false keeps the dialog open on the card's diagnostic.
 * @param props.onClose - dismisses the dialog without saving.
 * @param props.t - the section's localized copy.
 * @returns the picker dialog.
 */
export function NousModelPicker({ models, selected, onSave, onClose, t }: {
  models: readonly NousModelView[]
  selected: readonly string[]
  onSave: (ids: string[]) => Promise<boolean>
  onClose: () => void
  t: (key: keyof typeof en) => string
}): ReactNode {
  const [draft, setDraft] = useState<string[]>(() => [...selected])
  const [query, setQuery] = useState('')
  const [enabledOnly, setEnabledOnly] = useState(false)
  const [saving, setSaving] = useState(false)
  const needle = query.trim().toLowerCase()
  const visible = models.filter(model => (!enabledOnly || draft.includes(model.id))
    && (needle === '' || model.name.toLowerCase().includes(needle)))
  const groups = groupModels(visible)
  const setMembers = (ids: readonly string[], enabled: boolean): void => {
    setDraft(current => enabled
      ? [...new Set([...current, ...ids])]
      : current.filter(id => !ids.includes(id)))
  }
  // A refused write keeps the dialog and its draft so the choice can be retried.
  const submit = async (): Promise<void> => {
    setSaving(true)
    try { if (await onSave(draft)) onClose() }
    finally { setSaving(false) }
  }
  return <Modal open onClose={onClose} title={t('nousModels')} closeLabel={t('close')}
    description={t('nousModelsHint')} contentClassName={`${styles['pickerBody']}`}
    footer={<>
      <span className={styles['modelCatalogMeta']}>{countCopy(t('nousModelsCount'), { count: draft.length })}</span>
      <Button variant="ghost" disabled={saving} onClick={onClose}>{t('cancel')}</Button>
      <Button variant="primary" disabled={saving} onClick={() => { void submit() }}>{t('apply')}</Button>
    </>}>
    <div className={styles['pickerFilters']}>
      <Input className={`${styles['pickerSearch']}`} type="search" value={query} aria-label={t('nousModelsSearch')}
        placeholder={t('nousModelsSearch')} onChange={(event) => { setQuery(event.target.value) }} />
      <div className={styles['pickerPills']}>
        <Pill active={!enabledOnly} onClick={() => { setEnabledOnly(false) }}>
          {`${t('nousModelsAll')} ${models.length}`}
        </Pill>
        <Pill active={enabledOnly} onClick={() => { setEnabledOnly(true) }}>
          {`${t('nousModelsSelected')} ${draft.length}`}
        </Pill>
      </div>
    </div>
    <div className={styles['pickerList']}>
      {groups.length === 0 ? <p className={styles['modelEmpty']}>{t('nousModelsNone')}</p> : groups.map((group) => {
        const ids = group.models.map(model => model.id)
        const allEnabled = ids.every(id => draft.includes(id))
        return <section key={group.vendor === '' ? '\u0000' : group.vendor} className={styles['pickerGroup']}>
          <div className={styles['pickerGroupHead']}>
            <span className={styles['modelCatalogTitle']}>
              {group.vendor === '' ? t('nousOtherVendor') : group.vendor}
            </span>
            <button type="button" className={styles['linkButton']} onClick={() => { setMembers(ids, !allEnabled) }}>
              {t(allEnabled ? 'nousModelsClear' : 'nousModelsSelectAll')}
            </button>
          </div>
          <div className={styles['modelList']}>
            {group.models.map(model => <Checkbox key={model.id} checked={draft.includes(model.id)}
              label={modelLabel(model.name)} onChange={(next) => { setMembers([model.id], next) }} />)}
          </div>
        </section>
      })}
    </div>
  </Modal>
}
