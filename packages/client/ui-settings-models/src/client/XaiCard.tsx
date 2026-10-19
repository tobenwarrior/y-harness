/** xAI subscription device sign-in and Grok model publication. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsNamespaceView, XaiConnectionView, XaiDeviceVerification, XaiModelView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ModelsOperations } from './operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

function jsonObject(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function savedXaiModels(namespace: SettingsNamespaceView): string[] {
  const profile = jsonObject(jsonObject(jsonObject(namespace.value)?.providers)?.xai)
  return Array.isArray(profile?.models) ? profile.models.flatMap((model) => {
    const id = jsonObject(model)?.id
    return typeof id === 'string' ? [id] : []
  }) : []
}

function modelSettings(model: XaiModelView): JsonValue {
  const efforts = { ...(model.reasoningEfforts ?? {}) }
  delete efforts.off
  const reasoningEfforts = model.reasoning && Object.keys(efforts).length > 0 ? { ...efforts } : false
  return { id: model.id, name: model.name,
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    ...(model.inputModalities === undefined ? {} : { input: [...model.inputModalities] }),
    reasoningEfforts,
  }
}

/**
 * The stored profile that publishes exactly these catalog models. Subscription
 * OAuth owns authentication and the endpoint, so an inherited credential or
 * endpoint override is dropped rather than carried into the new selection.
 */
function xaiProfile(
  catalog: readonly XaiModelView[],
  ids: readonly string[],
  previous: Record<string, JsonValue> | undefined,
): Record<string, JsonValue> {
  const {
    apiKeyEnv: _apiKeyEnv, apiKey: _apiKey, baseURL: _baseURL, modelOverrides: _modelOverrides, ...profileOptions
  } = previous ?? {}
  return { ...profileOptions, displayName: 'xAI',
    models: catalog.filter(model => ids.includes(model.id)).map(modelSettings) }
}

/** The small default published on first connect: Grok 4.7 when present, else the catalog lead. */
function starterXaiModels(catalog: readonly XaiModelView[]): string[] {
  const preferred = catalog.find(model => model.id === 'grok-4.7')
  if (preferred !== undefined) return [preferred.id]
  const lead = catalog[0]
  return lead === undefined ? [] : [lead.id]
}

/**
 * Controls receive display-safe remote callbacks; device and access tokens stay on the Host.
 * @param props - connection callbacks, current settings revision, write policy, reload callback, and localized copy.
 * @returns the xAI card, or null when the service or settings namespace is absent.
 */
export function XaiCard(props: {
  operations: ModelsOperations
  namespace: SettingsNamespaceView | undefined
  readOnly?: boolean
  onSaved: () => void
  t: (key: keyof typeof en) => string
  open?: boolean
}): ReactNode {
  const { operations, namespace, readOnly = false, onSaved, t, open = true } = props
  const connection = operations.xai
  const [view, setView] = useState<XaiConnectionView>({ configured: true, connected: false, busy: false })
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [verification, setVerification] = useState<XaiDeviceVerification | undefined>()
  const [catalog, setCatalog] = useState<XaiModelView[]>([])
  const [message, setMessage] = useState('')
  const action = useRef<{ controller: AbortController; signingIn: boolean } | undefined>()
  const autoSaved = useRef(false)
  useEffect(() => {
    if (connection === undefined) return
    let stale = false
    void connection.getState().then((next) => { if (!stale) { setView(next); setMessage(next.error ?? '') } }).catch(() => { if (!stale) setMessage(t('xaiFailed')) })
    return () => {
      stale = true
      const pending = action.current
      pending?.controller.abort()
      if (pending?.signingIn) void connection.cancel().catch((_error: unknown) => {
        /* Host disposal also owns the active authorization attempt. */
      })
    }
  }, [connection, t])
  const connected = view.connected
  useEffect(() => {
    if (connection === undefined || namespace === undefined || !connected || view.busy) return
    let stale = false; const isStale = (): boolean => stale
    void connection.models().then(async (models) => {
      if (isStale()) return
      setCatalog(models)
      const saved = savedXaiModels(namespace)
      if (models.length === 0) { setMessage(t('xaiNoModels')); return }
      if (saved.length > 0 || autoSaved.current) return
      autoSaved.current = true
      const ids = starterXaiModels(models)
      if (ids.length === 0) return
      const previous = jsonObject(jsonObject(jsonObject(namespace.value)?.providers)?.xai)
      const outcome = await operations.writeSettings('llm-pi-ai',
        [{ op: 'set', path: ['providers', 'xai'], value: xaiProfile(models, ids, previous) }], namespace.revision)
      if (isStale()) return
      if (outcome.kind === 'written') setMessage(t('xaiAdded'))
      else setMessage(outcome.message)
    }).catch((error: unknown) => {
      if (!isStale()) setMessage(error instanceof Error ? error.message : t('xaiFailed'))
    })
    return () => { stale = true }
  }, [connection, namespace, connected, view.busy, operations, t])
  if (connection === undefined || namespace === undefined) return null

  const run = async <T,>(callback: (signal: AbortSignal) => Promise<T>, signingIn = false): Promise<T | undefined> => {
    const pending = { controller: new AbortController(), signingIn }
    action.current = pending
    setBusy(true); setMessage('')
    try { return await callback(pending.controller.signal) }
    catch (error) {
      if (!pending.controller.signal.aborted) setMessage(error instanceof Error ? error.message : t('xaiFailed'))
      return undefined
    }
    finally {
      if (action.current === pending) action.current = undefined
      if (!pending.controller.signal.aborted) { setBusy(false); setVerification(undefined) }
    }
  }
  const refreshModels = async (signal: AbortSignal): Promise<void> => {
    const models = await connection.models()
    signal.throwIfAborted()
    setCatalog(models)
    if (models.length === 0) setMessage(t('xaiNoModels'))
    else {
      const saved = savedXaiModels(namespace)
      const ids = saved.length > 0 ? saved : starterXaiModels(models)
      const previous = jsonObject(jsonObject(jsonObject(namespace.value)?.providers)?.xai)
      const outcome = await operations.writeSettings('llm-pi-ai',
        [{ op: 'set', path: ['providers', 'xai'], value: xaiProfile(models, ids, previous) }], namespace.revision)
      signal.throwIfAborted()
      if (outcome.kind !== 'written') setMessage(outcome.message)
      else setMessage(t('xaiReady'))
      onSaved()
    }
  }
  const signIn = async (signal: AbortSignal): Promise<void> => {
    const instructions = await connection.start(consent)
    if (signal.aborted) { await connection.cancel(); signal.throwIfAborted() }
    setVerification(instructions)
    const next = await connection.finish(signal)
    signal.throwIfAborted()
    setView(next)
    if (next.error !== undefined) throw new Error(next.error)
    if (!next.connected) throw new Error(t('xaiFailed'))
  }
  const disconnect = async (signal: AbortSignal): Promise<void> => {
    await connection.disconnect()
    const next = await connection.getState()
    signal.throwIfAborted()
    setView(next); setCatalog([])
    const profile = jsonObject(jsonObject(jsonObject(namespace.value)?.providers)?.xai)
    const ownsProfile = profile !== undefined && (profile['apiKeyEnv'] === undefined || profile['apiKeyEnv'] === null)
    if (ownsProfile && savedXaiModels(namespace).length > 0) {
      const outcome = await operations.writeSettings('llm-pi-ai', [{ op: 'unset', path: ['providers', 'xai'] }], namespace.revision)
      signal.throwIfAborted()
      if (outcome.kind !== 'written') throw new Error(outcome.message)
    }
    setMessage(t('xaiDisconnected')); onSaved()
  }
  const cancel = async (): Promise<void> => {
    const pending = action.current
    try {
      await connection.cancel()
      const next = await connection.getState()
      if (pending?.controller.signal.aborted) return
      setView(next)
      if (next.error !== undefined) setMessage(next.error)
    } catch { setMessage(t('xaiFailed')) }
  }
  const locked = busy || view.busy || readOnly
  const savedCount = savedXaiModels(namespace).length
  if (!open) {
    return <div className={styles['rowCard']}>
      <div className={styles['rowHead']}>
        <span className={styles['rowIdentity']}>
          <span className={styles['rowName']}>{t('xaiTitle')}</span>
          <Tag tone={connected ? 'success' : 'outline'}>{t(connected ? 'statusConnected' : 'statusSignedOut')}</Tag>
        </span>
      </div>
    </div>
  }
  return <div className={styles['editor']}>
    <div className={styles['editorHeader']}>
      <span className={styles['editorTitle']}>{t('xaiTitle')}</span>
      <Tag tone={connected ? 'success' : 'outline'}>{t(connected ? 'statusConnected' : 'statusSignedOut')}</Tag>
    </div>
    <p className={styles['intro']}>{t('xaiHint')}</p>
    <label className={styles['advancedHint']}>
      <input type="checkbox" checked={consent} disabled={locked} onChange={(event) => { setConsent(event.target.checked) }} /> {t('xaiStorage')}
    </label>
    <div className={styles['editorHeader']}>
      <Button variant="primary" disabled={locked || !consent} onClick={() => { void run(signIn, true) }}>{t('xaiContinue')}</Button>
      {connected ? <Button disabled={locked} onClick={() => { void run(refreshModels) }}>{t('xaiRefreshModels')}</Button> : null}
      {connected || savedCount > 0
        ? <Button disabled={locked} onClick={() => { void run(disconnect) }}>{t('xaiDisconnect')}</Button> : null}
      {view.busy || action.current?.signingIn ? <Button disabled={readOnly} onClick={() => { void cancel() }}>{t('cancel')}</Button> : null}
    </div>
    {verification === undefined ? null : <div>
      <p><a href={verification.url} target="_blank" rel="noreferrer">{t('xaiOpenBrowser')}</a></p>
      <p className={styles['advancedHint']}>{t('xaiCode')}: <code>{verification.code}</code></p>
      <p className={styles['advancedHint']}>{t('xaiCodeExpires')}: {new Date(verification.expiresAt).toLocaleTimeString()}</p>
    </div>}
    {connected && catalog.length > 0
      ? <div className={styles['modelSummary']}>
        <span className={styles['modelCatalogMeta']}>{t('xaiModels')}: {catalog.filter(model => savedXaiModels(namespace).includes(model.id)).map(model => model.name).join(', ') || catalog.map(model => model.name).join(', ')}</span>
      </div>
      : null}
    <p className={styles['advancedHint']}>{t('xaiModelsHint')}</p>
    {message === '' ? null : <p role="status" className={styles['advancedHint']}>{message}</p>}
  </div>
}
