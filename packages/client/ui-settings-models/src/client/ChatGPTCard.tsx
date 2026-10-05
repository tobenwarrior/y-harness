/** User-driven subscription connection controls within the existing Models settings page. */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ChatGPTModelView, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelsOperations, ChatGPTView } from './operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

function jsonObject(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

/** Read only the catalog's saved processing choice; never any credential fields. */
function savedTier(namespace: SettingsNamespaceView | undefined, modelId: string): string | undefined {
  const profile = jsonObject(jsonObject(jsonObject(namespace?.value)?.providers)?.chatgpt)
  const models = profile?.models
  if (!Array.isArray(models)) return undefined
  const model = models.map(jsonObject).find(entry => entry?.id === modelId)
  return typeof model?.serviceTier === 'string' ? model.serviceTier : undefined
}

export function ChatGPTCard({ operations, namespace, readOnly = false, onSaved, t }: {
  operations: ModelsOperations
  namespace: SettingsNamespaceView | undefined
  readOnly?: boolean
  onSaved: () => void
  t: (key: keyof typeof en) => string
}): ReactNode {
  const [view, setView] = useState<ChatGPTView>({ accounts: [], busy: false })
  const [selected, setSelected] = useState('')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [url, setUrl] = useState<string | undefined>()
  const [message, setMessage] = useState('')
  const [welcome, setWelcome] = useState(false)
  const [catalog, setCatalog] = useState<ChatGPTModelView[]>([])
  const [processingModelId, setProcessingModelId] = useState('')
  const [processingTier, setProcessingTier] = useState('default')
  const connection = operations.chatGPT
  useEffect(() => {
    if (connection === undefined) return
    let stale = false
    void connection.getState().then((next) => { if (!stale) { setView(next); setSelected(next.activeId ?? '') } }).catch(() => { if (!stale) setMessage(t('chatGPTFailed')) })
    return () => { stale = true }
  }, [connection, t])
  useEffect(() => {
    if (connection === undefined || view.activeId === undefined || view.busy) { setCatalog([]); return }
    let stale = false
    void connection.models().then((models) => {
      if (stale || !Array.isArray(models)) return
      setCatalog(models)
      setProcessingModelId(current => models.some(model => model.id === current) ? current : models[0]?.id ?? '')
    }).catch(() => { if (!stale) setMessage(t('chatGPTCatalogFailed')) })
    return () => { stale = true }
  }, [connection, view.activeId, view.busy, t])
  useEffect(() => { setProcessingTier(savedTier(namespace, processingModelId) ?? 'default') }, [namespace?.revision, processingModelId])
  if (connection === undefined || namespace === undefined) return null
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setMessage('')
    try { await action() } catch (error) { setMessage(error instanceof Error ? error.message : t('chatGPTFailed')) }
    finally { setBusy(false) }
  }
  const saveModels = async (): Promise<void> => {
    const models = await connection.models()
    if (models.length === 0) throw new Error(t('chatGPTNoModels'))
    const preserved = models.map((model) => {
      const selectedTier = savedTier(namespace, model.id)
      if (selectedTier === undefined) return model
      if (selectedTier !== 'default' && !model.serviceTiers?.some(tier => tier.id === selectedTier)) throw new Error(t('chatGPTTierUnavailable'))
      return { ...model, serviceTier: selectedTier }
    })
    const previousProfile = jsonObject(jsonObject(jsonObject(namespace.value)?.providers)?.chatgpt)
    const result = await operations.writeSettings('llm-pi-ai', [{ op: 'set', path: ['providers', 'chatgpt'], value: {
      ...previousProfile, displayName: 'ChatGPT', api: 'openai-responses', baseURL: 'https://api.openai.com/v1', models: JSON.parse(JSON.stringify(preserved)) as JsonValue,
    } }], namespace.revision)
    if (result.kind !== 'written') throw new Error(result.message)
    setCatalog(models); setMessage(t('chatGPTReady')); onSaved()
  }
  const signIn = async (): Promise<void> => {
    const authUrl = await connection.start(selected || undefined, consent)
    setUrl(authUrl)
    const next = await connection.finish()
    setUrl(undefined); setView(next); setSelected(next.activeId ?? '')
    if (next.activeId !== undefined && view.accounts.length === 0) setWelcome(true)
    if (next.error !== undefined) throw new Error(next.error)
    if (next.activeId !== undefined) await saveModels()
  }
  const locked = busy || view.busy || readOnly
  const selectedConnected = view.accounts.some(account => account.id === selected && account.connected)
  const disconnect = async (): Promise<void> => {
    const revoked = await connection.disconnect(selected)
    setView(await connection.getState())
    setMessage(t(revoked ? 'chatGPTDisconnected' : 'chatGPTDisconnectedManual'))
  }
  const processingModel = catalog.find(model => model.id === processingModelId)
  const applyProcessing = async (): Promise<void> => {
    if (processingModel === undefined) throw new Error(t('chatGPTTierUnavailable'))
    if (processingTier !== 'default' && !processingModel.serviceTiers?.some(tier => tier.id === processingTier)) throw new Error(t('chatGPTTierUnavailable'))
    const profile = jsonObject(jsonObject(jsonObject(namespace.value)?.providers)?.chatgpt)
    const models = profile?.models
    if (!Array.isArray(models)) throw new Error(t('chatGPTRefreshFirst'))
    const index = models.findIndex(model => jsonObject(model)?.id === processingModel.id)
    if (index < 0) throw new Error(t('chatGPTRefreshFirst'))
    const outcome = await operations.writeSettings('llm-pi-ai', [{ op: 'set', path: ['providers', 'chatgpt', 'models', String(index), 'serviceTier'], value: processingTier }], namespace.revision)
    if (outcome.kind !== 'written') throw new Error(outcome.message)
    setMessage(t('chatGPTProcessingSaved')); onSaved()
  }
  return <div className={styles['editor']}>
    <div className={styles['editorHeader']}><span className={styles['editorTitle']}>{t('chatGPTTitle')}</span></div>
    <p className={styles['intro']}>{t('chatGPTHint')}</p>
    <label className={styles['field']}>
      <span className={styles['fieldLabel']}>{t('chatGPTAccount')}</span>
      <select className={styles['selectInput']} value={selected} disabled={locked} onChange={(event) => { setSelected(event.target.value) }}>
        <option value="">{t('chatGPTNewAccount')}</option>
        {view.accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}
      </select>
    </label>
    <label className={styles['advancedHint']}>
      <input type="checkbox" checked={consent} disabled={locked} onChange={(event) => { setConsent(event.target.checked) }} /> {t('chatGPTStorage')}
    </label>
    <div className={styles['editorHeader']}>
      <Button disabled={locked || !consent} onClick={() => { void run(signIn) }}>{t('chatGPTContinue')}</Button>
      {selected !== '' && selectedConnected
        ? <Button disabled={locked} onClick={() => { void run(async () => { setView(await connection.select(selected)); await saveModels() }) }}>{t('chatGPTUseSaved')}</Button> : null}
      {view.activeId !== undefined ? <Button disabled={locked} onClick={() => { void run(saveModels) }}>{t('chatGPTRefreshModels')}</Button> : null}
      {selectedConnected ? <Button disabled={locked} onClick={() => { void run(disconnect) }}>{t('chatGPTDisconnect')}</Button> : null}
      {busy || view.busy ? <Button onClick={() => { void connection.cancel() }}>{t('cancel')}</Button> : null}
    </div>
    {url === undefined ? null : <p><a href={url} target="_blank" rel="noreferrer">{t('chatGPTOpenBrowser')}</a></p>}
    {message === '' ? null : <p role="status" className={styles['advancedHint']}>{message}</p>}
    {view.activeId === undefined ? null : <p className={styles['advancedHint']}>{t('chatGPTPlanActive')}</p>}
    {catalog.length === 0 ? null : <>
      {catalog.some(model => model.id === 'gpt-6.1-sol') ? null : <p role="status" className={styles['advancedHint']}>{t('chatGPTSolUnavailable')}</p>}
      <label className={styles['field']}><span className={styles['fieldLabel']}>{t('chatGPTProcessingModel')}</span>
        <select className={styles['selectInput']} value={processingModelId} disabled={locked} onChange={(event) => { setProcessingModelId(event.target.value) }}>
          {catalog.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      </label>
      {processingModel === undefined ? null : <>
        <p className={styles['advancedHint']}>{t('chatGPTEfforts')}: {Object.keys(processingModel.reasoningEfforts ?? {}).join(' · ') || t('chatGPTProviderDefault')}</p>
        {processingModel.unavailableReasoningEfforts?.includes('ultra') ? <p className={styles['advancedHint']}>{t('chatGPTUltraUnavailable')}</p> : null}
        <label className={styles['field']}><span className={styles['fieldLabel']}>{t('chatGPTProcessing')}</span>
          <select className={styles['selectInput']} value={processingTier} disabled={locked} onChange={(event) => { setProcessingTier(event.target.value) }}>
            <option value="default">{t('chatGPTStandard')}</option>
            {processingModel.serviceTiers?.map(tier => <option key={tier.id} value={tier.id}>{tier.name}</option>)}
          </select>
        </label>
        {processingTier === 'default' ? null : <p className={styles['advancedHint']}>{processingModel.serviceTiers?.find(tier => tier.id === processingTier)?.description} {t('chatGPTFastUsage')}</p>}
        {(processingModel.serviceTiers?.length ?? 0) === 0 ? <p className={styles['advancedHint']}>{t('chatGPTFastUnavailable')}</p> : null}
        <Button disabled={locked || processingTier === (savedTier(namespace, processingModel.id) ?? 'default')} onClick={() => { void run(applyProcessing) }}>{t('chatGPTApplyProcessing')}</Button>
      </>}
    </>}
    <Modal open={welcome} onClose={() => { setWelcome(false) }} title={t('chatGPTWelcomeTitle')} closeLabel={t('close')} description={t('chatGPTWelcome')} footer={<Button onClick={() => { setWelcome(false) }}>{t('close')}</Button>} />
    <p className={styles['advancedHint']}><a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">{t('chatGPTUsage')}</a></p>
  </div>
}
