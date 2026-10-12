/** Optional metadata advice with explicit unavailable routes and scoped preview. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Input, Switch, Toast, IconWarningOutlineRegular, IconLoadingOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { DecisionRoute, DecisionStatus } from '@deepseek-ai/dsh-skill-library/types'
import type { DecisionFace, DecisionState } from './decision-controller.ts'
import css from './DecisionSettings.module.css'

/** All footer inputs are derived from declared slots, locale and injected facts. */
export type DecisionSettingsProps = PropsRuntime<'settings.models.footer'> & PropsLocale<'skillLibrary'> & InjectFace<DecisionFace>

function DecisionForm({ state, status, t, loadDecisionControls, saveDecision, previewDecision }: Pick<DecisionSettingsProps, 't' | 'loadDecisionControls' | 'saveDecision' | 'previewDecision'> & { state: DecisionState; status: DecisionStatus }): ReactNode {
  const saved = status.configuration
  const [enabled, setEnabled] = useState(saved.enabled)
  const [key, setKey] = useState(saved.route === undefined ? '' : JSON.stringify([saved.route.provider, saved.route.model]))
  const [effort, setEffort] = useState<string>(saved.route?.reasoningEffort ?? '')
  const [tier, setTier] = useState<string>(saved.route?.serviceTier ?? '')
  const [project, setProject] = useState('')
  const [query, setQuery] = useState('')
  const model = status.models.find(row => JSON.stringify([row.provider, row.model]) === key && row.available)
  const controls = state.controlsKey === key ? state.controls : null
  useEffect(() => { if (state.phase === 'ready' && model !== undefined) loadDecisionControls({ provider: model.provider, model: model.model }) }, [key, state.phase, state.capabilityEpoch, loadDecisionControls])
  const matchedEffort = controls?.reasoning?.efforts.find(row => row.id === effort)
  const matchedTier = controls?.serviceTiers?.tiers.find(row => row.id === tier)
  const route: DecisionRoute | undefined = model === undefined ? undefined : {
    provider: model.provider, model: model.model,
    ...(matchedEffort === undefined ? {} : { reasoningEffort: matchedEffort.id }),
    ...(matchedTier === undefined ? {} : { serviceTier: matchedTier.id }),
  }
  const valid = !enabled || route !== undefined && controls !== null && (controls.reasoning === undefined || effort !== '' && controls.reasoning.efforts.some(row => row.id === effort)) && (controls.serviceTiers === undefined || tier !== '' && controls.serviceTiers.tiers.some(row => row.id === tier))
  return <>
    <label className={css.row}><Switch checked={enabled} onChange={setEnabled} disabled={state.busy} label={t('decisionEnable')} /><span>{t('decisionEnable')}</span></label>
    <label className={css.field}><span>{t('decisionModel')}</span><select value={key} aria-label={t('decisionModel')} disabled={state.busy} onChange={(event) => { setKey(event.target.value); setEffort(''); setTier('') }}>
      <option value="">{t('decisionChoose')}</option>
      {status.models.map(row => <option key={JSON.stringify([row.provider, row.model])} value={JSON.stringify([row.provider, row.model])} disabled={!row.available}>{row.name} · {row.provider}{row.available ? '' : ` · ${t(row.reason === 'native-tools' ? 'decisionNative' : 'decisionUnavailable')}`}</option>)}
    </select></label>
    {controls?.reasoning !== undefined && <label className={css.field}><span>{t('decisionEffort')}</span><select value={effort} aria-label={t('decisionEffort')} disabled={state.busy} onChange={(event) => { setEffort(event.target.value) }}><option value="">{t('decisionChoose')}</option>{controls.reasoning.efforts.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}
    {controls?.serviceTiers !== undefined && <label className={css.field}><span>{t('decisionTier')}</span><select value={tier} aria-label={t('decisionTier')} disabled={state.busy} onChange={(event) => { setTier(event.target.value) }}><option value="">{t('decisionChoose')}</option>{controls.serviceTiers.tiers.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}
    <p className={css.hint}>{t('decisionLimits', { input: Math.min(status.maxInputBytes, status.maxInputTokens), output: status.maxOutputTokens, seconds: status.timeoutMs / 1000 })}</p>
    <div className={css.row}><Button variant="primary" size="sm" disabled={state.busy || !valid} onClick={() => { saveDecision(enabled, route) }}>{t('decisionSave')}</Button></div>
    <label className={css.field}><span>{t('project')}</span><select value={project} aria-label={t('decisionProject')} disabled={state.busy} onChange={(event) => { setProject(event.target.value) }}><option value="">{t('decisionChooseProject')}</option>{state.projects.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>
    <Input value={query} onChange={(event) => { setQuery(event.target.value) }} placeholder={t('decisionQuery')} aria-label={t('decisionQuery')} disabled={state.busy} />
    <div className={css.row}><Button size="sm" variant="outline" disabled={state.busy || project === '' || query.trim() === ''} onClick={() => { previewDecision(project, query) }}>{t('decisionPreview')}</Button></div>
    {state.preview !== null && <div aria-label={t('decisionPreviewResult')}><p className={css.hint}>{t('decisionPreviewHint')}</p>{state.preview.length === 0 ? <p>{t('noResults')}</p> : <ol>{state.preview.map(row => <li key={row.id}>{row.name}</li>)}</ol>}</div>}
  </>
}

/**
 * Render separate Decision selection below providers.
 * @param props - framework hooks and explicit callbacks.
 * @returns localized configuration and preview controls.
 */
export function DecisionSettings(props: DecisionSettingsProps): ReactNode {
  const state = props.useDecision(value => value)
  useEffect(() => { props.ensureDecision() }, [props.ensureDecision])
  if (state.status === null && (state.phase === 'idle' || state.phase === 'loading')) return <section className={css.loading} data-testid="decision-settings" role="status" aria-label={props.t('loading')}><IconLoadingOutlineRegular size={18} /></section>
  return <section className={css.card} aria-label={props.t('decisionTitle')} data-testid="decision-settings">
    <h3 className={css.title}>{props.t('decisionTitle')}</h3><p className={css.hint}>{props.t('decisionHint')}</p><p className={css.hint}>{props.t('decisionNativeHint')}</p>
    {state.error && <p className={css.error} role="alert">{props.t('decisionError')}</p>}
    {state.status !== null && <DecisionForm key={state.status.configuration.revision}
      state={state} status={state.status} t={props.t} loadDecisionControls={props.loadDecisionControls}
      saveDecision={props.saveDecision} previewDecision={props.previewDecision} />}
    <Button size="sm" variant="ghost" disabled={state.phase === 'loading' || state.busy} onClick={props.refreshDecision}>{props.t('refresh')}</Button>
  </section>
}

/**
 * Render configuration outcomes outside the footer lifetime.
 * @param props - framework-bound notice source and dismissal.
 * @returns settled shared toast.
 */
export function DecisionToast({ useDecision, dismissDecisionNotice, t }: InjectFace<Pick<DecisionFace, 'hooks' | 'dismissDecisionNotice'>> & PropsLocale<'skillLibrary'>): ReactNode {
  const notice = useDecision(value => value.notice)
  if (notice === null) return null
  return notice === 'saved' ? <Toast text={t('decisionSaved')} tone="success" onDone={dismissDecisionNotice} /> : <Toast text={t('decisionError')} icon={<IconWarningOutlineRegular />} onDone={dismissDecisionNotice} />
}
