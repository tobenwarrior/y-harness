/** Native Nous device sign-in and selection of account-visible models. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, DisclosureRow, IconInfoOutlineRegular, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { NousConnectionView, NousDeviceVerification, NousModelView, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { NousModelPicker } from './NousModelPicker.tsx'
import { countCopy, starterModels } from './nous-models.ts'
import type { ModelsOperations } from './operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

function jsonObject(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function savedNousModels(namespace: SettingsNamespaceView): string[] {
  const profile = jsonObject(jsonObject(jsonObject(namespace.value)?.providers)?.nous)
  return Array.isArray(profile?.models) ? profile.models.flatMap((model) => {
    const id = jsonObject(model)?.id
    return typeof id === 'string' ? [id] : []
  }) : []
}

function modelSettings(model: NousModelView): JsonValue {
  const efforts = { ...model.reasoningEfforts }
  if (model.reasoningMandatory !== false) delete efforts.off
  // The composer offers only levels explicitly advertised by the account catalog.
  const reasoningEfforts = model.reasoning && Object.keys(efforts).some(level => level !== 'off')
    ? { ...efforts } : false
  return { id: model.id, name: model.name,
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    ...(model.inputModalities === undefined ? {} : { input: [...model.inputModalities] }),
    reasoningEfforts,
  }
}

/**
 * The stored profile that publishes exactly these account models. Native OAuth
 * owns authentication and the endpoint, so an inherited credential or endpoint
 * override is dropped rather than carried into the new selection.
 */
function nousProfile(
  catalog: readonly NousModelView[],
  ids: readonly string[],
  previous: Record<string, JsonValue> | undefined,
): Record<string, JsonValue> {
  const {
    apiKeyEnv: _apiKeyEnv, apiKey: _apiKey, baseURL: _baseURL, modelOverrides: _modelOverrides, ...profileOptions
  } = previous ?? {}
  return { ...profileOptions, displayName: 'Nous Portal', api: 'openai-completions',
    models: catalog.filter(model => ids.includes(model.id)).map(modelSettings) }
}

/**
 * Controls receive display-safe remote callbacks; device and access tokens stay on the Host.
 * @param props - connection callbacks, current settings revision, write policy, reload callback, and localized copy.
 * @returns the Nous card, or null when the native service or settings namespace is absent.
 */
export function NousCard(props: {
  operations: ModelsOperations
  namespace: SettingsNamespaceView | undefined
  readOnly?: boolean
  onSaved: () => void
  t: (key: keyof typeof en) => string
  open?: boolean
}): ReactNode {
  const { operations, namespace, readOnly = false, onSaved, t, open = true } = props
  const connection = operations.nous
  const [view, setView] = useState<NousConnectionView>({ configured: false, connected: false, busy: false })
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [verification, setVerification] = useState<NousDeviceVerification | undefined>()
  const [catalog, setCatalog] = useState<NousModelView[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const action = useRef<{ controller: AbortController; signingIn: boolean } | undefined>()
  const autoSaved = useRef(false)
  useEffect(() => {
    if (connection === undefined) return
    let stale = false
    void connection.getState().then((next) => { if (!stale) { setView(next); setMessage(next.error ?? '') } }).catch(() => { if (!stale) setMessage(t('nousFailed')) })
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
    // A connected account's catalog is what the card exists to offer, and a
    // remount would otherwise hide it behind the explicit Refresh action.
    if (connection === undefined || namespace === undefined || !connected || view.busy) return
    let stale = false; const isStale = (): boolean => stale
    void connection.models().then(async (models) => {
      if (isStale()) return
      setCatalog(models)
      const saved = savedNousModels(namespace)
      setSelected(saved.filter(id => models.some(model => model.id === id)))
      if (models.length === 0) { setMessage(t('nousNoModels')); return }
      // A fresh connection publishes a starter set; the rest of the catalog
      // stays in the picker, where the user chooses what the composer offers.
      if (saved.length > 0 || autoSaved.current) return
      autoSaved.current = true
      const ids = starterModels(models)
      const previous = jsonObject(jsonObject(jsonObject(namespace.value)?.providers)?.nous)
      const outcome = await operations.writeSettings('llm-pi-ai',
        [{ op: 'set', path: ['providers', 'nous'], value: nousProfile(models, ids, previous) }], namespace.revision)
      if (isStale()) return
      if (outcome.kind === 'written') { setSelected(ids); setMessage(t('nousAdded')) }
      else setMessage(outcome.message)
    }).catch((error: unknown) => {
      if (!isStale()) setMessage(error instanceof Error ? error.message : t('nousFailed'))
    })
    return () => { stale = true }
  }, [connection, namespace?.revision, connected, view.busy, t])
  if (connection === undefined || namespace === undefined) return null

  const run = async <T,>(callback: (signal: AbortSignal) => Promise<T>, signingIn = false): Promise<T | undefined> => {
    const pending = { controller: new AbortController(), signingIn }
    action.current = pending
    setBusy(true); setMessage('')
    try { return await callback(pending.controller.signal) }
    catch (error) {
      if (!pending.controller.signal.aborted) setMessage(error instanceof Error ? error.message : t('nousFailed'))
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
    setSelected(savedNousModels(namespace).filter(id => models.some(model => model.id === id)))
    if (models.length === 0) setMessage(t('nousNoModels'))
  }
  const signIn = async (signal: AbortSignal): Promise<void> => {
    const instructions = await connection.start(consent)
    if (signal.aborted) { await connection.cancel(); signal.throwIfAborted() }
    setVerification(instructions)
    const next = await connection.finish(signal)
    signal.throwIfAborted()
    setView(next)
    if (next.error !== undefined) throw new Error(next.error)
    if (!next.connected) throw new Error(t('nousFailed'))
  }
  /** Commit the picker's selection; false leaves the dialog open on the write's own diagnostic. */
  const saveSelection = async (ids: string[]): Promise<boolean> => {
    const previous = jsonObject(jsonObject(jsonObject(namespace.value)?.providers)?.nous)
    const outcome = await operations.writeSettings('llm-pi-ai',
      [{ op: 'set', path: ['providers', 'nous'], value: nousProfile(catalog, ids, previous) }], namespace.revision)
    if (outcome.kind !== 'written') { setMessage(outcome.message); return false }
    setSelected(ids); setMessage(t('nousReady')); onSaved()
    return true
  }
  const disconnect = async (signal: AbortSignal): Promise<void> => {
    await connection.disconnect()
    const next = await connection.getState()
    signal.throwIfAborted()
    setView(next); setCatalog([]); setSelected([])
    if (savedNousModels(namespace).length > 0) {
      const outcome = await operations.writeSettings('llm-pi-ai', [{ op: 'unset', path: ['providers', 'nous'] }], namespace.revision)
      signal.throwIfAborted()
      if (outcome.kind !== 'written') throw new Error(`${t('nousRemovalPending')} ${outcome.message}`)
    }
    setMessage(t('nousDisconnected')); onSaved()
  }
  const cancel = async (): Promise<void> => {
    const pending = action.current
    try {
      await connection.cancel()
      const next = await connection.getState()
      if (pending?.controller.signal.aborted) return
      setView(next)
      if (next.error !== undefined) setMessage(next.error)
    } catch { setMessage(t('nousFailed')) }
  }
  const locked = busy || view.busy || readOnly
  // The stored profile, not the loaded catalog, is what keeps a disconnect
  // reachable: a grant cleared locally still owns the models it published.
  const savedCount = savedNousModels(namespace).length
  if (!open) {
    return <div className={styles['rowCard']}>
      <div className={styles['rowHead']}>
        <span className={styles['rowIdentity']}>
          <span className={styles['rowName']}>{t('nousTitle')}</span>
          <Tag tone={connected ? 'success' : 'outline'}>{t(connected ? 'statusConnected' : 'statusSignedOut')}</Tag>
        </span>
      </div>
    </div>
  }
  return <div className={styles['editor']}>
    <div className={styles['editorHeader']}>
      <span className={styles['editorTitle']}>{t('nousTitle')}</span>
      <Tag tone={connected ? 'success' : 'outline'}>{t(connected ? 'statusConnected' : 'statusSignedOut')}</Tag>
    </div>
    <p className={styles['intro']}>{t('nousHint')}</p>
    <label className={styles['advancedHint']}>
      <input type="checkbox" checked={consent} disabled={locked} onChange={(event) => { setConsent(event.target.checked) }} /> {t('nousStorage')}
    </label>
    <div className={styles['editorHeader']}>
      <Button variant="primary" disabled={locked || !consent} onClick={() => { void run(signIn, true) }}>{t('nousContinue')}</Button>
      {connected ? <Button disabled={locked} onClick={() => { void run(refreshModels) }}>{t('nousRefreshModels')}</Button> : null}
      {connected || savedCount > 0
        ? <Button disabled={locked} onClick={() => { void run(disconnect) }}>{t('nousDisconnect')}</Button> : null}
      {view.busy || action.current?.signingIn ? <Button disabled={readOnly} onClick={() => { void cancel() }}>{t('cancel')}</Button> : null}
    </div>
    {verification === undefined ? null : <div>
      <p><a href={verification.url} target="_blank" rel="noreferrer">{t('nousOpenBrowser')}</a></p>
      <p className={styles['advancedHint']}>{t('nousCode')}: <code>{verification.code}</code></p>
      <p className={styles['advancedHint']}>{t('nousCodeExpires')}: {new Date(verification.expiresAt).toLocaleTimeString()}</p>
    </div>}
    {connected
      ? <div className={styles['modelSummary']}>
        <span className={styles['modelCatalogMeta']}>
          {countCopy(t('nousModelsSummary'), { enabled: selected.length, total: catalog.length })}
        </span>
        <Button disabled={locked || catalog.length === 0} onClick={() => { setPickerOpen(true) }}>{t('nousManageModels')}</Button>
      </div>
      : null}
    <DisclosureRow icon={<IconInfoOutlineRegular size={14} />} title={t('nousAbout')} open={aboutOpen}
      expandable expandOnRowClick onToggle={() => { setAboutOpen(current => !current) }}>
      <p className={styles['advancedHint']}>{t('nousHermesDisclosure')}</p>
    </DisclosureRow>
    {message === '' ? null : <p role="status" className={styles['advancedHint']}>{message}</p>}
    {pickerOpen
      ? <NousModelPicker models={catalog} selected={selected} t={t}
        onSave={async ids => (await run(async () => await saveSelection(ids))) === true}
        onClose={() => { setPickerOpen(false) }} />
      : null}
  </div>
}
