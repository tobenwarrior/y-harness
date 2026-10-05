/** Optional native loop controls; mounting reads cached metadata only. */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CodexBackendModelView, CodexBackendView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelsOperations } from './operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'
export function CodexBackendCard({ operations, readOnly = false, onSaved, t }: {
  operations: ModelsOperations; readOnly?: boolean; onSaved(): void; t(key: keyof typeof en): string
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
    let stale = false
    void Promise.all([backend.getState(), backend.models()]).then(([state, catalog]) => {
      if (!stale) { setView(state); setModels(catalog); setModelId(catalog[0]?.id ?? '') }
    }).catch(() => { if (!stale) setMessage(t('chatGPTFailed')) })
    return () => { stale = true }
  }, [backend, t])
  useEffect(() => {
    if (backend === undefined || login === undefined) return
    let stale = false; let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const next = await backend.getState()
        if (stale) return
        setView(next)
        if (next.busy) timer = setTimeout(() => { void poll() }, 1000)
        else {
          setLogin(undefined)
          if (next.error !== undefined) setMessage(next.error)
          else { const state = await backend.refresh(); const catalog = await backend.models(); if (!stale) { setView(state); setModels(catalog); setModelId(catalog[0]?.id ?? ''); onSaved() } }
        }
      } catch { if (!stale) { setLogin(undefined); setMessage(t('chatGPTFailed')) } }
    }
    void poll()
    return () => { stale = true; if (timer !== undefined) clearTimeout(timer) }
  }, [backend, login, onSaved, t])
  useEffect(() => { setTier(view.tiers[modelId] ?? 'default') }, [view.tiers, modelId])
  if (backend === undefined) return null
  const model = models.find(model => model.id === modelId)
  const locked = readOnly || busy || view.busy || view.running > 0
  const run = async (action: () => Promise<void>): Promise<void> => { setBusy(true); setMessage(''); try { await action() } catch (error) { setMessage(error instanceof Error ? error.message : t('chatGPTFailed')) } finally { setBusy(false) } }
  const refresh = async (): Promise<void> => { setView(await backend.refresh()); const catalog = await backend.models(); setModels(catalog); setModelId(current => catalog.some(model => model.id === current) ? current : catalog[0]?.id ?? ''); onSaved() }
  return <div className={styles['editor']}>
    <div className={styles['editorHeader']}><span className={styles['editorTitle']}>{t('codexTitle')}</span></div>
    <p className={styles['intro']}>{t('codexHint')}</p>
    <p className={styles['advancedHint']}>{t('codexPolicy')}</p>
    <p className={styles['advancedHint']}>{view.label ?? t('codexSignedOut')}</p>
    <label className={styles['advancedHint']}><input type="checkbox" checked={consent} disabled={locked} onChange={event => { setConsent(event.target.checked) }} /> {t('codexStorage')}</label>
    <div className={styles['editorHeader']}>
      <Button disabled={locked || !consent} onClick={() => { void run(async () => { setLogin(await backend.start(consent)); setView(await backend.getState()) }) }}>{t('codexContinue')}</Button>
      <Button disabled={locked} onClick={() => { void run(refresh) }}>{t('codexRefresh')}</Button>
      <Button disabled={locked || (!view.enabled && (!view.connected || models.length === 0))} onClick={() => { void run(async () => { const next = await backend.configure(!view.enabled, undefined, undefined); setView(next); setMessage(t(next.enabled ? 'codexReady' : 'codexDisabled')); onSaved() }) }}>{t(view.enabled ? 'codexDisable' : 'codexEnable')}</Button>
      {view.connected ? <Button disabled={locked} onClick={() => { void run(async () => { setView(await backend.disconnect()); onSaved() }) }}>{t('codexDisconnect')}</Button> : null}
      {view.busy ? <Button disabled={readOnly} onClick={() => { void run(async () => { await backend.cancel(); setLogin(undefined); setView(await backend.getState()) }) }}>{t('cancel')}</Button> : null}
    </div>
    {login === undefined ? null : <p><a href={login.verificationUrl} target="_blank" rel="noreferrer">{t('codexOpen')}</a><br />{t('codexCode')}: <strong>{login.userCode}</strong></p>}
    {message ? <p role="status" className={styles['advancedHint']}>{message}</p> : null}
    {models.length === 0 ? null : <>
      <p className={styles['advancedHint']}>{t('codexCatalog')}</p>
      <label className={styles['field']}><span className={styles['fieldLabel']}>{t('chatGPTProcessingModel')}</span><select className={styles['selectInput']} disabled={locked} value={modelId} onChange={event => { setModelId(event.target.value) }}>{models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
      {model === undefined ? null : <>
        <p className={styles['advancedHint']}>{t('chatGPTEfforts')}: <span>{model.efforts.map(effort => effort.id).join(' · ')}</span></p>
        <label className={styles['field']}><span className={styles['fieldLabel']}>{t('chatGPTProcessing')}</span><select className={styles['selectInput']} disabled={locked} value={tier} onChange={event => { setTier(event.target.value) }}><option value="default">{t('chatGPTStandard')}</option>{model.serviceTiers.map(tier => <option key={tier.id} value={tier.id}>{tier.name}</option>)}</select></label>
        {tier === 'default' ? null : <p className={styles['advancedHint']}>{model.serviceTiers.find(choice => choice.id === tier)?.description} {t('chatGPTFastUsage')}</p>}
        <Button disabled={locked || tier === (view.tiers[model.id] ?? 'default')} onClick={() => { void run(async () => { setView(await backend.configure(view.enabled, model.id, tier)); setMessage(t('chatGPTProcessingSaved')) }) }}>{t('chatGPTApplyProcessing')}</Button>
      </>}
    </>}
  </div>
}
