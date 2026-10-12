/** Optional native loop controls; mounting detects a stored sign-in and publishes the catalog. */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, DisclosureRow, IconChecklistOutlineRegular, IconInfoOutlineRegular, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodexBackendModelView, CodexBackendView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelsOperations } from './operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'
export function CodexBackendCard({ operations, readOnly = false, onSaved, t, open = true }: {
  operations: ModelsOperations
  readOnly?: boolean
  onSaved: () => void
  t: (key: keyof typeof en) => string
  open?: boolean
}): ReactNode {
  const backend = operations.codexBackend
  const [view, setView] = useState<CodexBackendView>({ connected: false, enabled: false, busy: false, running: 0, tiers: {} })
  const [models, setModels] = useState<CodexBackendModelView[]>([])
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [login, setLogin] = useState<{ verificationUrl: string; userCode: string } | undefined>()
  const [modelId, setModelId] = useState('')
  const [tier, setTier] = useState('default')
  useEffect(() => {
    if (backend === undefined) return
    let stale = false; const isStale = (): boolean => stale
    const sync = async (): Promise<void> => {
      const state = await backend.getState()
      if (isStale()) return
      // A stored sign-in is only observable after a native read, so detect it
      // here instead of telling an already signed-in user to sign in again.
      const observed = !readOnly && !state.connected ? await backend.refresh() : state
      if (isStale()) return
      // A connected account's catalog publishes itself while the user has not
      // made an explicit enable/disable choice.
      const next = readOnly ? observed : await backend.publish()
      const catalog = await backend.models()
      if (isStale()) return
      setView(next); setModels(catalog)
      setModelId(current => catalog.some(model => model.id === current) ? current : catalog[0]?.id ?? '')
    }
    void sync().catch(() => { if (!stale) setMessage(t('codexFailed')) })
    return () => { stale = true }
  }, [backend, readOnly, t])
  useEffect(() => {
    if (backend === undefined || login === undefined) return
    let stale = false; const isStale = (): boolean => stale
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const next = await backend.getState()
        if (stale) return
        setView(next)
        if (next.busy) timer = setTimeout(() => { void poll() }, 1000)
        else {
          if (next.error !== undefined) { setMessage(next.error); setLogin(undefined) }
          else {
            await backend.refresh()
            const state = await backend.publish()
            const catalog = await backend.models()
            if (!isStale()) { setView(state); setModels(catalog); setModelId(catalog[0]?.id ?? ''); setLogin(undefined); onSaved() }
          }
        }
      } catch { if (!stale) { setLogin(undefined); setMessage(t('codexFailed')) } }
    }
    void poll()
    return () => { stale = true; if (timer !== undefined) clearTimeout(timer) }
  }, [backend, login, onSaved, t])
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [processingOpen, setProcessingOpen] = useState(false)
  useEffect(() => { setTier(view.tiers[modelId] ?? 'default') }, [view.tiers, modelId])
  if (backend === undefined) return null
  const model = models.find(model => model.id === modelId)
  const locked = readOnly || busy || view.busy || view.running > 0
  const run = async (action: () => Promise<void>): Promise<void> => { setBusy(true); setMessage(''); try { await action() } catch (error) { setMessage(error instanceof Error ? error.message : t('codexFailed')) } finally { setBusy(false) } }
  const refresh = async (): Promise<void> => { setView(await backend.refresh()); const catalog = await backend.models(); setModels(catalog); setModelId(current => catalog.some(model => model.id === current) ? current : catalog[0]?.id ?? ''); onSaved() }
  if (!open) {
    return <div className={styles['rowCard']}>
      <div className={styles['rowHead']}>
        <span className={styles['rowIdentity']}>
          <span className={styles['rowName']}>{t('codexTitle')}</span>
          <Tag tone={view.connected ? 'success' : 'outline'}>{t(view.connected ? 'statusConnected' : 'statusSignedOut')}</Tag>
        </span>
      </div>
    </div>
  }
  return <div className={styles['editor']}>
    <div className={styles['editorHeader']}>
      <span className={styles['editorTitle']}>{t('codexTitle')}</span>
      <Tag tone={view.connected ? 'success' : 'outline'}>{t(view.connected ? 'statusConnected' : 'statusSignedOut')}</Tag>
    </div>
    <p className={styles['intro']}>{t('codexHint')}</p>
    <p className={styles['advancedHint']}>{view.label ?? t('codexSignedOut')}</p>
    <label className={styles['advancedHint']}><input type="checkbox" checked={consent} disabled={locked} onChange={(event) => { setConsent(event.target.checked) }} /> {t('codexStorage')}</label>
    <div className={styles['editorHeader']}>
      <Button variant="primary" disabled={locked || !consent} onClick={() => { void run(async () => { setLogin(await backend.start(consent)); setView(await backend.getState()) }) }}>{t('codexContinue')}</Button>
      <Button disabled={locked} onClick={() => { void run(refresh) }}>{t('codexRefresh')}</Button>
      <Button disabled={locked || (!view.enabled && (!view.connected || models.length === 0))} onClick={() => { void run(async () => { const next = await backend.configure(!view.enabled, undefined, undefined); setView(next); setMessage(t(next.enabled ? 'codexReady' : 'codexDisabled')); onSaved() }) }}>{t(view.enabled ? 'codexDisable' : 'codexEnable')}</Button>
      {view.connected ? <Button disabled={locked} onClick={() => { void run(async () => { setView(await backend.disconnect()); onSaved() }) }}>{t('codexDisconnect')}</Button> : null}
      {view.busy ? <Button disabled={readOnly} onClick={() => { void run(async () => { await backend.cancel(); setLogin(undefined); setView(await backend.getState()) }) }}>{t('cancel')}</Button> : null}
    </div>
    {login === undefined ? null : <p><a href={login.verificationUrl} target="_blank" rel="noreferrer">{t('codexOpen')}</a><br />{t('codexCode')}: <strong>{login.userCode}</strong></p>}
    {message ? <p role="status" className={styles['advancedHint']}>{message}</p> : null}
    <DisclosureRow icon={<IconInfoOutlineRegular size={14} />} title={t('codexDetails')} open={detailsOpen}
      expandable expandOnRowClick onToggle={() => { setDetailsOpen(current => !current) }}>
      <p className={styles['advancedHint']}>{t('codexPolicy')}</p>
    </DisclosureRow>
    {models.length === 0 ? null : <DisclosureRow icon={<IconChecklistOutlineRegular size={14} />} title={t('codexProcessingModel')}
      open={processingOpen} expandable expandOnRowClick onToggle={() => { setProcessingOpen(current => !current) }}>
      <p className={styles['advancedHint']}>{t('codexCatalog')}</p>
      <label className={styles['field']}><span className={styles['fieldLabel']}>{t('codexProcessingModel')}</span><select className={`${styles['input']} ${styles['selectInput']}`} disabled={locked} value={modelId} onChange={(event) => { setModelId(event.target.value) }}>{models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
      {model === undefined ? null : <>
        <p className={styles['advancedHint']}>{t('codexEfforts')}: <span>{model.efforts.map(effort => effort.id).join(' · ')}</span></p>
        <label className={styles['field']}><span className={styles['fieldLabel']}>{t('codexProcessing')}</span><select className={`${styles['input']} ${styles['selectInput']}`} disabled={locked} value={tier} onChange={(event) => { setTier(event.target.value) }}><option value="default">{t('codexStandard')}</option>{model.serviceTiers.map(tier => <option key={tier.id} value={tier.id}>{tier.name}</option>)}</select></label>
        {tier === 'default' ? null : <p className={styles['advancedHint']}>{model.serviceTiers.find(choice => choice.id === tier)?.description} {t('codexFastUsage')}</p>}
        <Button disabled={locked || tier === (view.tiers[model.id] ?? 'default')} onClick={() => { void run(async () => { setView(await backend.configure(view.enabled, model.id, tier)); setMessage(t('codexProcessingSaved')) }) }}>{t('codexApplyProcessing')}</Button>
      </>}
    </DisclosureRow>}
  </div>
}
